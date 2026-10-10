// FormSubmit's standard endpoint does not send CORS headers, so a fetch() submit
// must target the /ajax/ endpoint instead. The <form action> stays as the no-JS fallback.
const AJAX_ENDPOINT = "https://formsubmit.co/ajax/info@chinayytech.com";

const FIELDS = ["full_name", "phone_number", "target_office", "message"];

export function initContactForm() {
  const form = document.getElementById("inquiry-form");
  const success = document.getElementById("thank-you");
  if (!form || !success) return;

  const submitBtn = form.querySelector('button[type="submit"]');
  const errorEl = document.getElementById("form-error");

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

  // No-JS fallback path lands back here with ?sent=1 after FormSubmit's redirect.
  if (new URLSearchParams(window.location.search).has("sent")) showSuccess();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.hidden = true;
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const payload = {
      _subject: "New Inquiry from Chinayytech.com",
      _template: "table",
      _captcha: "false",
    };
    FIELDS.forEach((name) => {
      payload[name] = (data.get(name) || "").toString().trim();
    });

    const original = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }

    try {
      const res = await fetch(AJAX_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);

      // FormSubmit answers 200 even on failure, so trust the body, not the status.
      if (res.ok && json && String(json.success) === "true") {
        showSuccess();
        return;
      }

      const reason = (json && (json.message || json.error)) || `HTTP ${res.status}`;
      console.warn("Inquiry not delivered:", reason);
      showError("We couldn't send that just now. Please email info@chinayytech.com directly, or try again shortly.");
    } catch (err) {
      console.warn("Inquiry failed:", err.message);
      showError("Network error — please check your connection, or email info@chinayytech.com directly.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
    }
  });
}
