import { CinematicScene } from "./scene.js";

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".nav__toggle");
  const links = document.querySelector(".nav__links");
  if (toggle && links) {
    toggle.addEventListener("click", () => links.classList.toggle("is-open"));
    links.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => links.classList.remove("is-open")));
  }

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const banner = document.getElementById("form-sent");
  if (banner && new URLSearchParams(window.location.search).has("sent")) {
    banner.hidden = false;
    banner.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const canvas = document.getElementById("webgl");
  if (!canvas) return;

  let scene;
  try {
    scene = new CinematicScene(canvas);
  } catch (err) {
    console.error("WebGL scene unavailable, using static fallback.", err);
    document.body.classList.add("no-webgl");
    return;
  }

  const captions = Array.from(document.querySelectorAll(".storyboard__caption"));
  const hudPhases = Array.from(document.querySelectorAll(".hud-phase"));
  const stage = document.querySelector(".storyboard");
  const hint = document.querySelector(".storyboard__scroll-hint");

  function setActivePhase(progress) {
    const phase = Math.min(2, Math.floor(progress));
    captions.forEach((c, i) => c.classList.toggle("is-active", i === phase));
    hudPhases.forEach((el, i) => el.classList.toggle("is-active", i === phase));
    if (hint) hint.style.opacity = progress > 0.08 ? "0" : "0.7";
  }

  let queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      const progress = total > 0 ? Math.min(3, Math.max(0, (-rect.top / total) * 3)) : 0;
      scene.setProgress(progress);
      setActivePhase(progress);
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScroll();
});
