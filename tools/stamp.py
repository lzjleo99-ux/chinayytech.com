#!/usr/bin/env python3
"""Stamp a content hash into the asset URLs of every HTML page.

Why this is committed rather than done in CI: the repository has two Pages
pipelines (this project's workflow and GitHub's default branch deploy), and
whichever wins the race is what gets served. A CI-only stamp therefore shipped
unversioned URLs whenever the branch deploy won, which is exactly how a stale
bundle reaches browsers. Hashing here means the committed HTML is already
correct no matter which pipeline publishes it.

The hash covers the asset contents, so the URL changes when — and only when —
something actually changed.

Run before committing:  python3 tools/stamp.py
"""
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# main.js dynamically imports scene.js/form.js, so those URLs need the
# same treatment or the modules stay cached after the entry point changes.
PAGES = ["index.html", "contact.html", "privacy.html", "js/main.js"]
# Everything whose bytes can change what the browser must re-fetch.
ASSETS = [
    "css/style.css",
    "css/fonts.css",
    "js/main.js",
    "js/scene.js",
    "js/form.js",
    "js/consent.js",
]


VERSION_TOKEN = re.compile(rb"\?v=(?:__BUILD__|[0-9a-f]{6,40})")


def build_id() -> str:
    """Hash of the real asset content.

    The version tokens are stripped before hashing: main.js is both an input and
    a file this script rewrites, so hashing it verbatim would feed the previous
    stamp back in and the id would change on every run instead of only when
    something actually changed.
    """
    h = hashlib.sha256()
    for rel in ASSETS:
        p = ROOT / rel
        if not p.exists():
            sys.exit(f"stamp: missing asset {rel}")
        h.update(rel.encode())
        h.update(VERSION_TOKEN.sub(b"?v=", p.read_bytes()))
    return h.hexdigest()[:12]


def main() -> int:
    bid = build_id()
    # Matches both the unstamped placeholder and a previous hash.
    pattern = re.compile(r"\?v=(?:__BUILD__|[0-9a-f]{6,40})")
    changed = []
    for name in PAGES:
        p = ROOT / name
        if not p.exists():
            continue
        src = p.read_text()
        out, n = pattern.subn(f"?v={bid}", src)
        if n == 0:
            print(f"  {name}: no versioned asset URLs found", file=sys.stderr)
        if out != src:
            p.write_text(out)
            changed.append(f"{name} ({n})")
    print(f"build id {bid}")
    print("  updated: " + (", ".join(changed) if changed else "nothing (already current)"))

    stale = [n for n in PAGES if (ROOT / n).exists() and "__BUILD__" in (ROOT / n).read_text()]
    if stale:
        sys.exit(f"stamp: placeholder left in {stale}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
