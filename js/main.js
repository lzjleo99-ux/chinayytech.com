import { CinematicScene } from "./scene.js";

document.addEventListener("DOMContentLoaded", () => {
  // nav toggle (mobile)
  const toggle = document.querySelector(".nav__toggle");
  const links = document.querySelector(".nav__links");
  if (toggle && links) {
    toggle.addEventListener("click", () => links.classList.toggle("is-open"));
    links.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => links.classList.remove("is-open")));
  }

  // footer year
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const canvas = document.getElementById("webgl");
  if (!canvas || !window.WebGLRenderingContext) return;

  let scene;
  try {
    scene = new CinematicScene(canvas);
  } catch (err) {
    console.error("3D scene failed to initialize, falling back to static hero.", err);
    document.body.classList.add("no-webgl");
    return;
  }

  const captions = Array.from(document.querySelectorAll(".storyboard__caption"));
  const stage = document.querySelector(".storyboard");
  const hint = document.querySelector(".storyboard__scroll-hint");

  function setActiveCaption(progress) {
    const phase = Math.min(2, Math.floor(progress));
    captions.forEach((c, i) => c.classList.toggle("is-active", i === phase));
    if (hint) hint.style.opacity = progress > 0.08 ? "0" : "0.7";
  }

  function onScroll() {
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    const scrolled = -rect.top;
    const raw = total > 0 ? scrolled / total : 0;
    const progress = Math.min(3, Math.max(0, raw * 3));
    scene.setProgress(progress);
    setActiveCaption(progress);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});
