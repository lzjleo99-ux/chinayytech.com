// Analytics consent gate (UK/EU GDPR + ePrivacy).
//
// Nothing is requested from Google until the visitor opts in: the gtag loader is
// injected on consent rather than shipped in the page, so a visitor who declines
// (or never answers) makes no request to googletagmanager.com at all. Consent
// Mode defaults are additionally set to denied in the page head, which covers the
// window between the head parsing and this file running.
const MEASUREMENT_ID = "G-EFPZTMKESC";
const STORE_KEY = "cyyt.analytics-consent";

function readChoice() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null; // private mode / blocked storage: treat as undecided
  }
}

function writeChoice(value) {
  try {
    localStorage.setItem(STORE_KEY, value);
  } catch {
    /* storage unavailable; the choice applies to this page view only */
  }
}

function clearAnalyticsCookies() {
  const host = location.hostname;
  const parts = host.split(".");
  const scopes = [host, "." + host];
  if (parts.length > 2) scopes.push("." + parts.slice(-2).join("."));
  document.cookie.split(";").forEach((entry) => {
    const name = entry.split("=")[0].trim();
    if (name !== "_ga" && name !== "_gid" && !name.startsWith("_ga_")) return;
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    scopes.forEach((d) => {
      document.cookie = `${name}=; path=/; domain=${d}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    });
  });
}

let loaded = false;
function loadAnalytics() {
  if (loaded || !window.gtag) return;
  loaded = true;
  window.gtag("consent", "update", {
    analytics_storage: "granted",
  });
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID);

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(s);
}

function denyAnalytics() {
  if (window.gtag) window.gtag("consent", "update", { analytics_storage: "denied" });
  clearAnalyticsCookies();
}

document.addEventListener("DOMContentLoaded", () => {
  const banner = document.getElementById("cookie-banner");
  const accept = document.getElementById("cookie-accept");
  const reject = document.getElementById("cookie-reject");
  const reopen = document.querySelectorAll(".cookie-settings");

  const show = () => banner && (banner.hidden = false);
  const hide = () => banner && (banner.hidden = true);

  const choice = readChoice();
  if (choice === "granted") loadAnalytics();
  else if (choice !== "denied") show(); // undecided: ask, load nothing

  if (accept) {
    accept.addEventListener("click", () => {
      writeChoice("granted");
      hide();
      loadAnalytics();
    });
  }
  if (reject) {
    reject.addEventListener("click", () => {
      writeChoice("denied");
      hide();
      denyAnalytics();
    });
  }
  // Withdrawing has to be as easy as giving, so the footer link reopens this.
  reopen.forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      show();
    })
  );
});
