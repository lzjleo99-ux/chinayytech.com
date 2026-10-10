// FormSubmit's standard endpoint does not send CORS headers, so a fetch() submit
// must target the /ajax/ endpoint instead. The <form action> stays as the no-JS fallback.
const AJAX_ENDPOINT = "https://formsubmit.co/ajax/info@chinayytech.com";

const FIELDS = [
  ["full_name", "Full Name"],
  ["phone_number", "Phone (with country code)"],
  ["target_office", "Target Office"],
  ["message", "Inquiry Content"],
];

export function initContactForm() {
  const form = document.getElementById("inquiry-form");
  const success = document.getElementById("thank-you");
  if (!form || !success) return;

  const logEl = document.getElementById("debug-log");
  const toggleBtn = document.getElementById("debug-toggle");
  const clearBtn = document.getElementById("debug-clear");
  const copyBtn = document.getElementById("debug-copy");
  const submitBtn = form.querySelector('button[type="submit"]');
  const errorEl = document.getElementById("form-error");

  const stamp = () => new Date().toTimeString().slice(0, 8);

  function log(level, message) {
    if (!logEl) return;
    const line = document.createElement("div");
    line.className = `log-line log-${level}`;
    // textContent, not innerHTML: these lines echo user-typed input back to the page.
    line.textContent = `[${stamp()}] [${level.toUpperCase()}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (toggleBtn && logEl) {
    toggleBtn.addEventListener("click", () => {
      const open = !logEl.hidden;
      logEl.hidden = open;
      toggleBtn.setAttribute("aria-expanded", String(!open));
      toggleBtn.textContent = open ? "Show Logs" : "Hide Logs";
    });
  }
  if (clearBtn && logEl) {
    clearBtn.addEventListener("click", () => {
      logEl.textContent = "";
      log("info", "Console cleared.");
    });
  }
  if (copyBtn && logEl) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(logEl.textContent);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy Log"), 1500);
      } catch {
        log("warn", "Clipboard unavailable — select the log text manually.");
      }
    });
  }

  function showSuccess() {
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  log("info", "Debug console ready. Endpoint: " + AJAX_ENDPOINT);

  // No-JS fallback path lands back here with ?sent=1 after FormSubmit's redirect.
  if (new URLSearchParams(window.location.search).has("sent")) {
    showSuccess();
    log("ok", "Returned from non-AJAX submission (?sent=1).");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.hidden = true;

    log("debug", "Validating fields...");
    if (!form.reportValidity()) {
      log("warn", "Validation failed — required fields are empty or invalid. Submission aborted.");
      return;
    }

    const data = new FormData(form);
    const payload = {
      _subject: "New Inquiry from Chinayytech.com",
      _template: "table",
      _captcha: "false",
    };
    FIELDS.forEach(([name]) => {
      payload[name] = (data.get(name) || "").toString().trim();
    });

    log("debug", "Validation passed. Payload:");
    FIELDS.forEach(([name, label]) => {
      log("payload", `  ${label}: ${payload[name] || "(empty)"}`);
    });

    const original = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }
    log("debug", "Sending payload to FormSubmit...");

    try {
      const res = await fetch(AJAX_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      log(res.ok ? "ok" : "err", `Response: ${res.status} ${res.statusText || ""}`.trim());

      const json = await res.json().catch(() => null);
      if (json) log("debug", "Body: " + JSON.stringify(json));

      if (res.ok && json && String(json.success) === "true") {
        log("ok", "Success — inquiry accepted for delivery.");
        showSuccess();
        return;
      }

      const reason = (json && (json.message || json.error)) || `HTTP ${res.status}`;
      log("err", "Not delivered: " + reason);
      if (/activat/i.test(reason) || /confirm/i.test(reason)) {
        log("warn", "FormSubmit needs its one-time activation: open the activation email sent to info@chinayytech.com and click the link.");
      }
      showError("We couldn't send that just now. Please email info@chinayytech.com directly, or try again shortly.");
    } catch (err) {
      log("err", "Network/CORS failure: " + err.message);
      showError("Network error — please check your connection, or email info@chinayytech.com directly.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
    }
  });
}
