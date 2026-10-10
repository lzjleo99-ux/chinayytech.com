import * as THREE from "./vendor/three.module.min.js";
import { EffectComposer } from "./vendor/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/addons/postprocessing/OutputPass.js";

// Earth imagery: NASA Blue Marble (topo+bathy) and NASA-derived specular/normal/cloud
// maps. NASA imagery is public domain.
const TEX = "assets/textures/";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const LOW_POWER =
  window.matchMedia("(max-width: 820px)").matches ||
  (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4);

const OFFICES = [
  { name: "Serbia", lat: 44.8, lon: 20.5 },
  { name: "United Kingdom", lat: 51.5, lon: -0.12 },
  { name: "Nigeria", lat: 9.1, lon: 7.4 },
  { name: "United States", lat: 39.0, lon: -98.0 },
  { name: "Chile", lat: -33.4, lon: -70.6 },
];
const CHINA = { lat: 23.1, lon: 113.3 };
const GLOBE_R = 2.2;

const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;
const clamp = THREE.MathUtils.clamp;

function latLonToVec3(lat, lon, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function canvas2d(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d") };
}

// Sobel a height field into a tangent-space normal map.
function sobelNormal(srcCtx, w, h, strength) {
  const src = srcCtx.getImageData(0, 0, w, h).data;
  const { c, ctx } = canvas2d(w, h);
  const out = ctx.createImageData(w, h);
  const at = (x, y) => src[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) / 255;
      const dy = (at(x, y + 1) - at(x, y - 1)) / 255;
      const nx = -dx * strength;
      const ny = -dy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function glowTexture() {
  const { c, ctx } = canvas2d(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.7)");
  g.addColorStop(0.5, "rgba(255,255,255,0.2)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function smokeTexture() {
  const s = 256;
  const { c, ctx } = canvas2d(s, s);
  for (let i = 0; i < 26; i++) {
    const x = s / 2 + (Math.random() - 0.5) * s * 0.44;
    const y = s / 2 + (Math.random() - 0.5) * s * 0.44;
    const r = s * (0.12 + Math.random() * 0.26);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.1 + Math.random() * 0.12})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fade the rim so the sprite never shows a hard square edge.
  const mask = ctx.createRadialGradient(s / 2, s / 2, s * 0.16, s / 2, s / 2, s * 0.5);
  mask.addColorStop(0, "rgba(0,0,0,0)");
  mask.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, s, s);
  ctx.globalCompositeOperation = "source-over";
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Equirectangular studio lighting. Feeds PMREM so metal has something real to reflect.
function envCanvas() {
  const { c, ctx } = canvas2d(1024, 512);
  const sky = ctx.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, "#0a1830");
  sky.addColorStop(0.45, "#13304f");
  sky.addColorStop(0.58, "#1b4668");
  sky.addColorStop(0.72, "#10233a");
  sky.addColorStop(1, "#05080f");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1024, 512);
  const blob = (x, y, r, color, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  };
  blob(260, 120, 190, "rgba(255,248,232,1)", 0.95);
  blob(760, 150, 150, "rgba(214,236,255,1)", 0.7);
  blob(120, 300, 130, "rgba(6,182,212,1)", 0.45);
  blob(560, 400, 220, "rgba(245,158,11,1)", 0.5);
  return c;
}

function skyCanvas() {
  const { c, ctx } = canvas2d(16, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, "#01030a");
  g.addColorStop(0.4, "#050f22");
  g.addColorStop(0.62, "#0c2a49");
  g.addColorStop(0.8, "#061423");
  g.addColorStop(1, "#01030a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  return c;
}

function starfieldTexture(maxAnisotropy) {
  const w = LOW_POWER ? 2048 : 4096;
  const h = w / 2;
  const { c, ctx } = canvas2d(w, h);
  ctx.fillStyle = "#010206";
  ctx.fillRect(0, 0, w, h);

  // Faint galactic band across the sphere.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.38);
  for (let i = 0; i < 260; i++) {
    const x = (Math.random() - 0.5) * w * 1.3;
    const spread = 1 - Math.abs(x) / (w * 0.75);
    const y = (Math.random() - 0.5) * h * 0.2 * Math.max(spread, 0.15);
    const r = 40 + Math.random() * 190;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tint = Math.random() > 0.5 ? "150,170,220" : "190,170,200";
    g.addColorStop(0, `rgba(${tint},${0.035 + Math.random() * 0.05})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const starCount = LOW_POWER ? 2600 : 7000;
  for (let i = 0; i < starCount; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const mag = Math.pow(Math.random(), 3.4);
    const r = 0.4 + mag * 2.3;
    const a = 0.25 + mag * 0.75;
    const temp = Math.random();
    const col =
      temp > 0.92 ? "190,210,255" : temp > 0.78 ? "255,236,210" : temp > 0.68 ? "255,208,180" : "255,255,255";
    ctx.fillStyle = `rgba(${col},${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (mag > 0.88) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
      g.addColorStop(0, `rgba(${col},0.5)`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAnisotropy;
  return t;
}

function steelMaps(maxAnisotropy) {
  const size = 1024;
  const { c: hc, ctx: hctx } = canvas2d(size, size);
  hctx.fillStyle = "#808080";
  hctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) {
    const r = 1 + Math.random() * 9;
    const v = 108 + Math.random() * 96;
    hctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    hctx.beginPath();
    hctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    hctx.fill();
  }
  hctx.lineWidth = 1;
  for (let i = 0; i < 420; i++) {
    const v = 140 + Math.random() * 95;
    hctx.strokeStyle = `rgba(${v},${v},${v},0.32)`;
    const y = Math.random() * size;
    hctx.beginPath();
    hctx.moveTo(0, y);
    hctx.lineTo(size, y + (Math.random() - 0.5) * 18);
    hctx.stroke();
  }

  const normalMap = new THREE.CanvasTexture(sobelNormal(hctx, size, size, 2.6));
  const roughnessMap = new THREE.CanvasTexture(hc);
  [normalMap, roughnessMap].forEach((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.anisotropy = maxAnisotropy;
  });
  return { normalMap, roughnessMap };
}

const PLANKS = 5;
const OVERLAP = 0.14;

// A single continuous camera track. Each key's pose is shared by the segments on
// either side of it, so there is no discontinuity at a phase boundary.
const CAM_KEYS = [
  { p: 0.0, pos: [2.5, 2.7, 7.9], look: [0, 1.45, 0] },
  { p: 0.7, pos: [2.1, 2.4, 7.0], look: [0, 1.3, 0] },
  { p: 1.0, pos: [1.5, 1.6, 3.9], look: [0, 0.66, 0] },
  { p: 1.18, pos: [1.05, 1.28, 2.9], look: [0.08, 0.62, 0] },
  { p: 1.32, pos: [1.25, 1.35, 3.2], look: [0.05, 0.6, 0] },
  { p: 1.52, pos: [1.8, 1.55, 4.5], look: [0.25, 0.6, 0] },
  { p: 1.7, pos: [2.3, 1.7, 5.6], look: [0.95, 0.6, 0] },
  { p: 1.79, pos: [1.75, 2.35, 8.1], look: [0.2, 0.9, 0] },
  { p: 1.9, pos: [1.0, 3.3, 11.2], look: [-1.1, 1.15, 0] },
  { p: 2.0, pos: [0.4, 1.6, 10.4], look: [-0.6, 0.2, -0.5] },
  { p: 2.45, pos: [0.25, 0.9, 8.8], look: [0.2, 0, -1.35] },
  { p: 3.0, pos: [0, 0.5, 9.6], look: [0, 0, -2] },
];

const WOOD_TONES = [
  { base: "#a87a46", plankA: "#b58550", plankB: "#a0723f", batten: "#8e6435" },
  { base: "#9c7040", plankA: "#aa7c49", plankB: "#946a3a", batten: "#825a30" },
  { base: "#b58c58", plankA: "#c09662", plankB: "#ab8250", batten: "#997345" },
];

// Plank layout is identical on every crate, so the Sobel pass runs once and the
// resulting normal map is shared across all of them.
function plankNormal(maxAnisotropy) {
  const w = 1024, h = 512;
  const { ctx } = canvas2d(w, h);
  ctx.fillStyle = "#9a9a9a";
  ctx.fillRect(0, 0, w, h);

  const ph = h / PLANKS;
  for (let i = 0; i < PLANKS; i++) {
    const y = i * ph;
    const g = ctx.createLinearGradient(0, y, 0, y + ph);
    g.addColorStop(0, "#6e6e6e");
    g.addColorStop(0.12, "#c4c4c4");
    g.addColorStop(0.88, "#b4b4b4");
    g.addColorStop(1, "#5c5c5c");
    ctx.fillStyle = g;
    ctx.fillRect(0, y + 3, w, ph - 6);
    ctx.fillStyle = "#3a3a3a"; // groove between planks
    ctx.fillRect(0, y, w, 3);
  }
  // Grain ridges
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 420; i++) {
    const y = Math.random() * h;
    ctx.strokeStyle = Math.random() > 0.5 ? "#d2d2d2" : "#707070";
    ctx.lineWidth = 0.6 + Math.random() * 1.4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 64) ctx.lineTo(x, y + Math.sin(x * 0.012 + i) * 3.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Raised end battens
  [0, w - 74].forEach((x) => {
    const g = ctx.createLinearGradient(x, 0, x + 74, 0);
    g.addColorStop(0, "#5a5a5a");
    g.addColorStop(0.15, "#dcdcdc");
    g.addColorStop(0.85, "#cfcfcf");
    g.addColorStop(1, "#5a5a5a");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 74, h);
  });

  const t = new THREE.CanvasTexture(sobelNormal(ctx, w, h, 2.2));
  t.anisotropy = maxAnisotropy;
  return t;
}

// Corrugated container side. Rendered large so the branding stays razor sharp;
// text is drawn as vectors, so resolution costs nothing in download size.
// Corrugated steel shipping container. The rib pattern is the same on every
// container, so the Sobel pass runs once and the normal map is shared.
function corrugationNormal(maxAnisotropy) {
  const w = 1024, h = 512;
  const { ctx } = canvas2d(w, h);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 32) {
    const g = ctx.createLinearGradient(x, 0, x + 32, 0);
    g.addColorStop(0, "#2a2a2a");
    g.addColorStop(0.5, "#e2e2e2");
    g.addColorStop(1, "#2a2a2a");
    ctx.fillStyle = g;
    ctx.fillRect(x, 26, 32, h - 52);
  }
  ctx.fillStyle = "#9a9a9a";
  ctx.fillRect(0, 0, w, 26);
  ctx.fillRect(0, h - 26, w, 26);
  const t = new THREE.CanvasTexture(sobelNormal(ctx, w, h, 1.6));
  t.anisotropy = maxAnisotropy;
  return t;
}

function containerAlbedo(baseColor, brand, maxAnisotropy) {
  const w = 2048, h = 1024;
  const { c, ctx } = canvas2d(w, h);
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, w, h);

  for (let x = 0; x < w; x += 64) {
    const g = ctx.createLinearGradient(x, 0, x + 64, 0);
    g.addColorStop(0, "rgba(0,0,0,0.36)");
    g.addColorStop(0.34, "rgba(255,255,255,0.13)");
    g.addColorStop(0.66, "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(0,0,0,0.36)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 60, 64, h - 120);
  }
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(0, 0, w, 60);
  ctx.fillRect(0, h - 60, w, 60);
  ctx.fillStyle = "rgba(16,20,26,0.92)";
  [[0, 0], [w - 136, 0], [0, h - 88], [w - 136, h - 88]].forEach(([x, y]) => ctx.fillRect(x, y, 136, 88));

  for (let i = 0; i < 420; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, Math.random() * 170, Math.random() * 24);
  }
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgba(${90 + Math.random() * 60},${50 + Math.random() * 40},30,${Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.arc(Math.random() * w, Math.random() * h, 6 + Math.random() * 28, 0, Math.PI * 2);
    ctx.fill();
  }

  if (brand) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.font = "bold 168px Helvetica, Arial, sans-serif";
    ctx.fillText("CHINA YY TECH", w / 2, h * 0.43);
    ctx.fillStyle = "rgba(255,255,255,0.84)";
    ctx.font = "500 72px Helvetica, Arial, sans-serif";
    ctx.fillText("chinayytech.com", w / 2, h * 0.58);
    ctx.shadowBlur = 0;
  }

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  return map;
}

// Industrial export crate: sawn planks, grain, knots, steel corner braces and a
// stencilled mark. Drawn large so the stencil stays crisp — vector text costs
// nothing in download size.
function crateAlbedo(tone, brand, maxAnisotropy) {
  const w = 2048, h = 1024;
  const { c, ctx } = canvas2d(w, h);
  const ph = h / PLANKS;

  ctx.fillStyle = tone.base;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < PLANKS; i++) {
    const y = i * ph;
    ctx.fillStyle = i % 2 ? tone.plankA : tone.plankB;
    ctx.fillRect(0, y + 6, w, ph - 12);

    // Grain: long wavy fibres, denser and darker than the plank body.
    for (let k = 0; k < 90; k++) {
      const gy = y + 8 + Math.random() * (ph - 16);
      const dark = Math.random() > 0.45;
      ctx.strokeStyle = dark
        ? `rgba(60,36,16,${0.05 + Math.random() * 0.16})`
        : `rgba(226,190,140,${0.04 + Math.random() * 0.1})`;
      ctx.lineWidth = 0.8 + Math.random() * 2.6;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      const amp = 2 + Math.random() * 7;
      const freq = 0.004 + Math.random() * 0.012;
      const ph0 = Math.random() * 10;
      for (let x = 0; x <= w; x += 48) ctx.lineTo(x, gy + Math.sin(x * freq + ph0) * amp);
      ctx.stroke();
    }

    // Knots
    if (Math.random() > 0.45) {
      const kx = 180 + Math.random() * (w - 360);
      const ky = y + ph * 0.5;
      for (let r = 34; r > 0; r -= 4) {
        ctx.strokeStyle = `rgba(74,44,18,${0.1 + (1 - r / 34) * 0.4})`;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.ellipse(kx, ky, r, r * 0.52, 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.fillStyle = "rgba(38,22,10,0.62)"; // shadowed gap between planks
    ctx.fillRect(0, y, w, 6);
  }

  // Vertical end battens
  [0, w - 74].forEach((x) => {
    ctx.fillStyle = tone.batten;
    ctx.fillRect(x, 0, 74, h);
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = `rgba(60,36,16,${Math.random() * 0.14})`;
      ctx.fillRect(x, Math.random() * h, 74, 1 + Math.random() * 3);
    }
    ctx.fillStyle = "rgba(30,18,8,0.5)";
    ctx.fillRect(x === 0 ? 72 : x - 2, 0, 3, h);
  });

  if (brand) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(24,26,30,0.84)";
    ctx.font = "bold 150px Helvetica, Arial, sans-serif";
    ctx.fillText("CHINA YY TECH", w / 2, h * 0.4);
    ctx.fillStyle = "rgba(24,26,30,0.7)";
    ctx.font = "500 62px Helvetica, Arial, sans-serif";
    ctx.fillText("chinayytech.com", w / 2, h * 0.56);
    ctx.strokeStyle = "rgba(24,26,30,0.45)";
    ctx.lineWidth = 5;
    ctx.strokeRect(w * 0.26, h * 0.27, w * 0.48, h * 0.4);
    // Break the ink up so it reads as stencilled onto timber, not printed on.
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 420; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.1 + Math.random() * 0.5})`;
      ctx.fillRect(w * 0.24 + Math.random() * w * 0.52, h * 0.25 + Math.random() * h * 0.45, 2 + Math.random() * 14, 1 + Math.random() * 5);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // Steel corner braces with bolts
  const bw = 190, bh = 120;
  [[0, 0], [w - bw, 0], [0, h - bh], [w - bw, h - bh]].forEach(([bx, by]) => {
    const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
    g.addColorStop(0, "#4a515c");
    g.addColorStop(0.5, "#2b313a");
    g.addColorStop(1, "#1a1f26");
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw, 34);
    ctx.fillRect(bx, by, 34, bh);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(bx, by + (by === 0 ? 32 : 0), bw, 2);
    ctx.fillStyle = "#11151a";
    [[bx + 17, by + 17], [bx + bw - 24, by + 17], [bx + 17, by + bh - 24]].forEach(([px, py]) => {
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // Scuffs and dirt
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(42,26,12,${Math.random() * 0.1})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, Math.random() * 150, Math.random() * 18);
  }

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  return map;
}

// Toothed gear profile, extruded. One mesh per gear rather than a cylinder plus
// a ring of little boxes.
function gearGeometry(radius, teeth, thickness) {
  const shape = new THREE.Shape();
  const root = radius * 0.82;
  const step = (Math.PI * 2) / teeth;
  const at = (ang, r) => [Math.cos(ang) * r, Math.sin(ang) * r];
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    if (i === 0) shape.moveTo(...at(a, root));
    else shape.lineTo(...at(a, root));
    shape.lineTo(...at(a + step * 0.2, radius));
    shape.lineTo(...at(a + step * 0.3, radius));
    shape.lineTo(...at(a + step * 0.5, root));
    shape.lineTo(...at(a + step, root));
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius * 0.22, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelSize: thickness * 0.18,
    bevelThickness: thickness * 0.18,
    bevelSegments: 1,
    steps: 1,
  });
  geo.center();
  return geo;
}

function hullTexture(maxAnisotropy) {
  const w = 2048, h = 280;
  const { c, ctx } = canvas2d(w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#2b3744");
  g.addColorStop(0.55, "#1d2733");
  g.addColorStop(1, "#141c26");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 2;
  for (let x = 0; x < w; x += 170) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, Math.random() * 120, Math.random() * 10);
  }
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = `rgba(${110 + Math.random() * 50},${60 + Math.random() * 35},30,${Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.arc(Math.random() * w, h * (0.6 + Math.random() * 0.4), 5 + Math.random() * 22, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "bold 104px Helvetica, Arial, sans-serif";
  ctx.fillText("CHINA YY TECH", 150, h * 0.44);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "500 46px Helvetica, Arial, sans-serif";
  ctx.fillText("chinayytech.com", 152, h * 0.72);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAnisotropy;
  return t;
}

// Sparks are drawn as LineSegments, two vertices per spark: the head at the
// current ballistic position and the tail sampled slightly earlier on the same
// trajectory. That makes each one a streak aligned to its own velocity, which a
// point sprite can never do — round sprites read as bokeh, not sparks.
const SPARK_VERT = `
attribute vec3 aVel;
attribute float aSeed;
attribute float aTrail;
attribute float aTail;
uniform float uBurst;
varying float vFade;
varying float vTail;
void main() {
  float t = max(uBurst - aTail * aTrail, 0.0);
  vec3 p = position + aVel * t * 0.95;
  p.y -= 4.6 * t * t;
  p.x += sin(aSeed * 6.283 + t * 9.0) * 0.05 * t;
  p.z += cos(aSeed * 6.283 + t * 7.5) * 0.05 * t;
  vFade = clamp(1.0 - uBurst, 0.0, 1.0) * (0.35 + 0.65 * aSeed);
  vTail = aTail;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const SPARK_FRAG = `
uniform float uOpacity;
uniform vec3 uHot;
uniform vec3 uCool;
varying float vFade;
varying float vTail;
void main() {
  vec3 col = mix(uHot, uCool, vTail);
  float a = (1.0 - vTail * 0.72) * vFade * uOpacity;
  // Pushed above 1.0 so the bloom threshold catches the white-hot heads.
  gl_FragColor = vec4(col * (1.0 + vFade * 1.3), a);
}`;

const EMBER_VERT = `
attribute float aSize;
attribute float aSeed;
attribute float aSpeed;
uniform float uTime;
uniform float uPixelRatio;
varying float vFade;
void main() {
  float t = fract(uTime * aSpeed * 0.12 + aSeed);
  vec3 p = position;
  p.y = mix(-0.45, 3.4, t);
  p.x += sin(uTime * 0.7 + aSeed * 6.283) * 0.18 * t;
  p.z += cos(uTime * 0.6 + aSeed * 6.283) * 0.18 * t;
  vFade = sin(t * 3.14159) * (0.4 + 0.6 * aSeed);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uPixelRatio * (240.0 / max(-mv.z, 0.001));
  gl_Position = projectionMatrix * mv;
}`;

const EMBER_FRAG = `
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec3 uColor;
varying float vFade;
void main() {
  vec4 tex = texture2D(uTex, gl_PointCoord);
  gl_FragColor = vec4(uColor * (1.0 + vFade), tex.a * vFade * uOpacity);
}`;

const ARC_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ARC_FRAG = `
uniform float uReveal;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  if (vUv.x > uReveal) discard;
  float head = smoothstep(uReveal - 0.04, uReveal, vUv.x);
  float travel = fract(uTime * 0.22);
  float pulse = exp(-pow((travel - vUv.x) * 13.0, 2.0));
  vec3 col = mix(uColor, vec3(1.0), clamp(pulse + head, 0.0, 1.0));
  float a = (0.45 + 0.75 * pulse + 0.5 * head) * uOpacity;
  gl_FragColor = vec4(col * (1.0 + pulse * 1.4), a);
}`;

const ATMO_VERT = `
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const ATMO_FRAG = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float f = pow(1.0 - abs(dot(normalize(vNormalW), viewDir)), 3.2);
  gl_FragColor = vec4(uColor, clamp(f, 0.0, 1.0) * uIntensity);
}`;

export class CinematicScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.progress = 0;
    this.clock = new THREE.Clock();
    this._shake = 0;
    this._zBoost = 1;
    this._mouse = new THREE.Vector2();
    this._mouseTarget = new THREE.Vector2();
    this._camTarget = new THREE.Vector3();
    this._camBase = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camReady = false;
    this._targetProgress = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this._pixelRatio = Math.min(window.devicePixelRatio || 1, LOW_POWER ? 1.5 : 2);
    this.renderer.setPixelRatio(this._pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.34;
    this.renderer.setClearColor(0x000000, 0);
    if (!LOW_POWER) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this._maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this._maxTexture = this.renderer.capabilities.maxTextureSize;
    this.loader = new THREE.TextureLoader();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x03060f, 0.0075);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);

    this.glow = glowTexture();
    this.steel = steelMaps(this._maxAniso);

    this._initEnvironment();
    this._initLights();
    this._initPhaseA();
    this._initPhaseB();
    this._initPhaseC();
    this._initComposer();

    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener(
      "pointermove",
      (e) => {
        this._mouseTarget.set(
          (e.clientX / window.innerWidth) * 2 - 1,
          (e.clientY / window.innerHeight) * 2 - 1
        );
      },
      { passive: true }
    );

    this._tick();
  }

  _loadMap(file, apply, srgb) {
    this.loader.load(
      TEX + file,
      (t) => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this._maxAniso;
        apply(t);
      },
      undefined,
      () => console.warn("Texture failed to load:", file)
    );
  }

  _sprite(color, scale, opacity) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glow,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    s.scale.setScalar(scale);
    s.userData.skipFade = true;
    return s;
  }

  _initComposer() {
    if (LOW_POWER) return;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Threshold kept high so only the hot cores bloom and geometry stays crisp.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.78, 0.7, 0.62);
    this.composer.addPass(this.bloom);
    // Required with a composer chain: applies tone mapping + sRGB at the end.
    this.composer.addPass(new OutputPass());
  }

  _initEnvironment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const src = new THREE.CanvasTexture(envCanvas());
      src.mapping = THREE.EquirectangularReflectionMapping;
      src.colorSpace = THREE.SRGBColorSpace;
      this.scene.environment = pmrem.fromEquirectangular(src).texture;
      src.dispose();
      pmrem.dispose();
    } catch (err) {
      console.warn("Environment map unavailable; direct lighting only.", err);
    }

    const skyTex = new THREE.CanvasTexture(skyCanvas());
    skyTex.colorSpace = THREE.SRGBColorSpace;
    this.backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(140, 32, 16),
      new THREE.MeshBasicMaterial({
        map: skyTex,
        side: THREE.BackSide,
        depthWrite: false,
        transparent: true,
        fog: false,
      })
    );
    this.backdrop.userData.skipFade = true;
    this.scene.add(this.backdrop);

    this.starfield = new THREE.Mesh(
      new THREE.SphereGeometry(380, 48, 24),
      new THREE.MeshBasicMaterial({
        map: starfieldTexture(this._maxAniso),
        side: THREE.BackSide,
        depthWrite: false,
        transparent: true,
        opacity: 0,
        fog: false,
      })
    );
    this.starfield.userData.skipFade = true;
    this.scene.add(this.starfield);

    const COUNT = LOW_POWER ? 500 : 1300;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const r = 14 + Math.random() * 36;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) * 0.6;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: this.glow,
        color: 0x9fd8ff,
        size: 0.45,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    this.dust.userData.skipFade = true;
    this.scene.add(this.dust);

    const wash = this._sprite(0x1e5fa8, 28, 0.45);
    wash.position.set(-1.5, 0.5, -10);
    this.scene.add(wash);
  }

  _initLights() {
    const key = new THREE.DirectionalLight(0xfff4e2, 3.1);
    key.position.set(5, 7, 5);
    if (!LOW_POWER) {
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.near = 1;
      key.shadow.camera.far = 32;
      key.shadow.camera.left = -9;
      key.shadow.camera.right = 9;
      key.shadow.camera.top = 9;
      key.shadow.camera.bottom = -9;
      key.shadow.bias = -0.0006;
      key.shadow.normalBias = 0.02;
    }
    this.scene.add(key);
    this.sun = key;

    const rim = new THREE.DirectionalLight(0x3b82f6, 1.2);
    rim.position.set(-6, 2, -4);
    this.scene.add(rim);

    this.forge = new THREE.PointLight(0xff8a2b, 0, 9, 2);
    this.forge.position.set(0, 0.3, 0);
    this.scene.add(this.forge);

    this.scene.add(new THREE.AmbientLight(0x243047, 1.1));
  }

  // Wood is never metallic and always fairly rough; the plank normal map is shared
  // and the per-tone face materials are built once and reused across every crate.
  _crateMaterial(toneIndex) {
    if (!this._crateCache) {
      this._crateCache = new Map();
      this._plankNormal = plankNormal(this._maxAniso);
      const mk = (map, rough) => {
        const m = new THREE.MeshStandardMaterial({
          map,
          normalMap: this._plankNormal,
          metalness: 0.04,
          roughness: rough,
          transparent: true,
          envMapIntensity: 0.75,
        });
        m.normalScale.set(1.1, 1.1);
        return m;
      };
      this._crateTop = mk(crateAlbedo(WOOD_TONES[1], false, this._maxAniso), 0.88);
      this._crateEnd = mk(crateAlbedo(WOOD_TONES[2], false, this._maxAniso), 0.85);
      this._crateMk = mk;
    }
    if (this._crateCache.has(toneIndex)) return this._crateCache.get(toneIndex);
    const side = this._crateMk(crateAlbedo(WOOD_TONES[toneIndex], true, this._maxAniso), 0.82);
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
    const mats = [this._crateEnd, this._crateEnd, this._crateTop, this._crateTop, side, side];
    this._crateCache.set(toneIndex, mats);
    return mats;
  }

  _containerMaterial(hex, brand) {
    if (!this._containerCache) {
      this._containerCache = new Map();
      this._ribNormal = corrugationNormal(this._maxAniso);
    }
    const key = hex + (brand ? "|b" : "");
    if (this._containerCache.has(key)) return this._containerCache.get(key);
    const m = new THREE.MeshStandardMaterial({
      map: containerAlbedo(hex, brand, this._maxAniso),
      normalMap: this._ribNormal,
      metalness: 0.52,
      roughness: 0.5,
      transparent: true,
      envMapIntensity: 1.15,
    });
    m.normalScale.set(0.9, 0.9);
    this._containerCache.set(key, m);
    return m;
  }

  // Opacity on a subtree, handling multi-material meshes.
  _setOpacity(obj, value) {
    obj.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.opacity = value;
    });
  }

  _steelMaterial(color, metalness, roughness) {
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      normalMap: this.steel.normalMap,
      roughnessMap: this.steel.roughnessMap,
      transparent: true,
      envMapIntensity: 1.25,
    });
    mat.normalScale.set(0.75, 0.75);
    return mat;
  }

  _initPhaseA() {
    const g = new THREE.Group();

    // Classic anvil silhouette: splayed base, narrow waist, heavy body, conical
    // horn. A plain cylinder reads as an oil drum, not an anvil.
    const anvilMat = this._steelMaterial(0x9ba3ad, 1.0, 0.3);
    const darkMat = this._steelMaterial(0x14191f, 0.6, 0.72);

    const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.92, 0.5, 24), darkMat);
    stump.position.y = -1.12;
    g.add(stump);

    const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, 0.98), anvilMat);
    base.position.y = -0.76;
    const baseTaper = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.64, 0.3, 4), anvilMat);
    baseTaper.rotation.y = Math.PI / 4;
    baseTaper.position.y = -0.48;
    baseTaper.scale.set(1.5, 1, 1.05);
    const waist = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.36, 0.62), anvilMat);
    waist.position.y = -0.22;
    const bodyTaper = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.42, 0.26, 4), anvilMat);
    bodyTaper.rotation.y = Math.PI / 4;
    bodyTaper.position.y = 0.03;
    bodyTaper.scale.set(1.55, 1, 1.08);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.3, 0.84), anvilMat);
    body.position.y = 0.3;
    const face = new THREE.Mesh(new THREE.BoxGeometry(1.99, 0.07, 0.86), this._steelMaterial(0xc9d2dc, 1.0, 0.16));
    face.position.y = 0.48;
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.33, 1.0, 28), anvilMat);
    horn.rotation.z = -Math.PI / 2;
    horn.position.set(1.42, 0.3, 0);
    horn.scale.set(1, 1, 0.92);
    const heel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.8), anvilMat);
    heel.position.set(-1.1, 0.3, 0);

    [base, baseTaper, waist, bodyTaper, body, face, horn, heel].forEach((m) => {
      m.castShadow = m.receiveShadow = !LOW_POWER;
      g.add(m);
    });

    // Sledgehammer: heavy horizontal head, tapered haft raked back.
    const hammer = new THREE.Group();
    const headMat = this._steelMaterial(0x5a626e, 0.98, 0.28);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.38, 0.38), headMat);
    const faceL = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.19, 0.1, 24), this._steelMaterial(0x8d96a2, 1.0, 0.2));
    faceL.rotation.z = Math.PI / 2;
    faceL.position.x = -0.49;
    const faceR = faceL.clone();
    faceR.position.x = 0.49;
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.082, 2.05, 20),
      new THREE.MeshStandardMaterial({
        color: 0x7d5230,
        roughness: 0.78,
        metalness: 0.04,
        normalMap: this.steel.normalMap,
        transparent: true,
        envMapIntensity: 0.45,
      })
    );
    handle.position.set(0.52, 0.94, 0);
    handle.rotation.z = -0.48;
    hammer.add(head, faceL, faceR, handle);
    hammer.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    g.add(hammer);
    this.hammer = hammer;

    this.hearth = this._sprite(0xffb24a, 1.9, 0);
    this.hearth.position.set(0, 0.56, 0);
    g.add(this.hearth);

    this.smoke = [];
    const smokeTex = smokeTexture();
    for (let i = 0; i < (LOW_POWER ? 4 : 8); i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: smokeTex,
          color: 0x8fa3bd,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          fog: false,
        })
      );
      const a = (i / (LOW_POWER ? 4 : 8)) * Math.PI * 2;
      s.userData.dir = new THREE.Vector3(Math.cos(a) * 1.5, 0.45 + Math.random() * 0.5, Math.sin(a) * 1.5);
      s.userData.seed = Math.random();
      s.userData.skipFade = true;
      g.add(s);
      this.smoke.push(s);
    }

    const SPARKS = LOW_POWER ? 2500 : 7000;
    const sGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(SPARKS * 6);
    const sVel = new Float32Array(SPARKS * 6);
    const sSeed = new Float32Array(SPARKS * 2);
    const sTrail = new Float32Array(SPARKS * 2);
    const sTail = new Float32Array(SPARKS * 2);
    for (let i = 0; i < SPARKS; i++) {
      const ox = (Math.random() - 0.5) * 0.3;
      const oy = 0.52 + (Math.random() - 0.5) * 0.08;
      const oz = (Math.random() - 0.5) * 0.3;
      const theta = Math.random() * Math.PI * 2;
      // Shallow cone: a forge strike throws sparks sideways, not straight up.
      const phi = Math.acos(1 - Math.random() * 1.45);
      // Heavy tail on the speed curve so a few sparks fly far and streak long.
      const speed = 1.1 + Math.pow(Math.random(), 2.0) * 4.6;
      const vx = Math.sin(phi) * Math.cos(theta) * speed;
      const vy = Math.abs(Math.cos(phi)) * speed * 0.55 + 0.35;
      const vz = Math.sin(phi) * Math.sin(theta) * speed;
      const seed = Math.random();
      const trail = 0.022 + Math.min(speed / 5.7, 1) * 0.055;
      for (let v = 0; v < 2; v++) {
        const k = i * 2 + v;
        sPos[k * 3] = ox;
        sPos[k * 3 + 1] = oy;
        sPos[k * 3 + 2] = oz;
        sVel[k * 3] = vx;
        sVel[k * 3 + 1] = vy;
        sVel[k * 3 + 2] = vz;
        sSeed[k] = seed;
        sTrail[k] = trail;
        sTail[k] = v; // 0 = head, 1 = tail
      }
    }
    sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
    sGeo.setAttribute("aVel", new THREE.BufferAttribute(sVel, 3));
    sGeo.setAttribute("aSeed", new THREE.BufferAttribute(sSeed, 1));
    sGeo.setAttribute("aTrail", new THREE.BufferAttribute(sTrail, 1));
    sGeo.setAttribute("aTail", new THREE.BufferAttribute(sTail, 1));
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: {
        uBurst: { value: 0 },
        uOpacity: { value: 0 },
        uHot: { value: new THREE.Color(0xffd9a0) },
        uCool: { value: new THREE.Color(0xc43a0c) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sparks = new THREE.LineSegments(sGeo, this.sparkMat);
    sparks.frustumCulled = false;
    sparks.userData.skipFade = true;
    g.add(sparks);

    const EMBERS = LOW_POWER ? 120 : 320;
    const eGeo = new THREE.BufferGeometry();
    const ePos = new Float32Array(EMBERS * 3);
    const eSize = new Float32Array(EMBERS);
    const eSeed = new Float32Array(EMBERS);
    const eSpeed = new Float32Array(EMBERS);
    for (let i = 0; i < EMBERS; i++) {
      const r = Math.random() * 2.2;
      const a = Math.random() * Math.PI * 2;
      ePos[i * 3] = Math.cos(a) * r;
      ePos[i * 3 + 1] = 0;
      ePos[i * 3 + 2] = Math.sin(a) * r;
      // Small: these are drifting cinders. Oversized glow sprites read as bokeh.
      eSize[i] = 0.1 + Math.random() * 0.26;
      eSeed[i] = Math.random();
      eSpeed[i] = 0.6 + Math.random() * 1.6;
    }
    eGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
    eGeo.setAttribute("aSize", new THREE.BufferAttribute(eSize, 1));
    eGeo.setAttribute("aSeed", new THREE.BufferAttribute(eSeed, 1));
    eGeo.setAttribute("aSpeed", new THREE.BufferAttribute(eSpeed, 1));
    this.emberMat = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.85 },
        uPixelRatio: { value: this._pixelRatio },
        uTex: { value: this.glow },
        uColor: { value: new THREE.Color(0xffa63d) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const embers = new THREE.Points(eGeo, this.emberMat);
    embers.frustumCulled = false;
    embers.userData.skipFade = true;
    g.add(embers);

    this.scene.add(g);
    this.groupA = g;
  }

  _initPhaseB() {
    const g = new THREE.Group();

    // Everything is sized so it genuinely nests: machine fits the crate, crate
    // fits the container, container fits a deck slot. No scale cheats.
    // A steam engine rather than a featureless box: boiler, stack, flywheel,
    // meshing gear train and a reciprocating piston.
    const machine = new THREE.Group();
    const iron = this._steelMaterial(0x6d7682, 0.95, 0.34);
    const brass = this._steelMaterial(0xc89338, 0.92, 0.28);
    const dark = this._steelMaterial(0x2f3741, 0.85, 0.42);

    const bed = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.045, 0.42), dark);
    bed.position.y = -0.175;
    machine.add(bed);

    const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.46, 32), iron);
    boiler.rotation.z = Math.PI / 2;
    boiler.position.set(-0.14, -0.02, 0);
    machine.add(boiler);
    [-0.3, -0.14, 0.02].forEach((x) => {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.117, 0.117, 0.022, 24), brass);
      band.rotation.z = Math.PI / 2;
      band.position.set(x, -0.02, 0);
      machine.add(band);
    });

    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.04, 0.1, 20), dark);
    stack.position.set(-0.3, 0.13, 0);
    const stackLip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.038, 0.022, 20), brass);
    stackLip.position.set(-0.3, 0.185, 0);
    machine.add(stack, stackLip);
    this.stackTip = new THREE.Vector3(-0.3, 0.2, 0);

    this.gears = [];
    const addGear = (r, teeth, pos, mat, speed) => {
      const gear = new THREE.Mesh(gearGeometry(r, teeth, 0.035), mat);
      gear.position.copy(pos);
      machine.add(gear);
      this.gears.push({ gear, speed });
      return gear;
    };
    // Radii sum to the centre distance so the teeth actually mesh.
    this.flywheel = addGear(0.105, 18, new THREE.Vector3(0.28, -0.02, 0.14), iron, 1);
    addGear(0.055, 9, new THREE.Vector3(0.28, 0.14, 0.14), brass, -(0.105 / 0.055));

    const spokeHub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 16), brass);
    spokeHub.rotation.x = Math.PI / 2;
    spokeHub.position.set(0.28, -0.02, 0.14);
    machine.add(spokeHub);

    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.17, 24), iron);
    cyl.rotation.z = Math.PI / 2;
    cyl.position.set(0.1, 0.085, -0.12);
    machine.add(cyl);
    this.piston = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 14), brass);
    this.piston.rotation.z = Math.PI / 2;
    this.piston.position.set(0.26, 0.085, -0.12);
    machine.add(this.piston);

    machine.position.set(0, 0.62, 0);
    machine.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    this.machine = machine;
    g.add(machine);

    this.steam = [];
    const steamTex = smokeTexture();
    for (let i = 0; i < 5; i++) {
      const puff = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: steamTex,
          color: 0xdce6f2,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          fog: false,
        })
      );
      puff.userData.offset = i / 5;
      puff.userData.skipFade = true;
      machine.add(puff);
      this.steam.push(puff);
    }

    // Wooden export crate built as a real flat-pack: a base with four side panels
    // hinged along its edges. They start splayed flat and fold up to enclose the
    // machine, then the lid seats. Scaling a solid box just reads as a growing block.
    const CW = 1.04, CH = 0.54, CD = 0.62, CT = 0.05;
    const crate = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(CW, CT, CD), this._crateMaterial(0));
    base.position.y = -CH / 2;
    crate.add(base);

    // The four walls stand apart from the base, splayed outward, and close in on
    // it. Hinging them flat on the floor just read as a pallet with sides rising.
    this.cratePanels = [];
    const addPanel = (geo, hinge, outward, axis, sign) => {
      const pivot = new THREE.Group();
      pivot.position.copy(hinge);
      const panel = new THREE.Mesh(geo, this._crateMaterial(1));
      panel.position.set(0, CH / 2, 0);
      pivot.add(panel);
      crate.add(pivot);
      this.cratePanels.push({
        pivot,
        axis,
        sign,
        closed: hinge.clone(),
        open: hinge.clone().add(outward),
      });
    };
    const longGeo = new THREE.BoxGeometry(CW, CH, CT);
    const endGeo = new THREE.BoxGeometry(CT, CH, CD);
    const hy = -CH / 2 + CT / 2;
    addPanel(longGeo, new THREE.Vector3(0, hy, CD / 2), new THREE.Vector3(0, 0.1, 0.52), "x", 1);
    addPanel(longGeo, new THREE.Vector3(0, hy, -CD / 2), new THREE.Vector3(0, 0.1, -0.52), "x", -1);
    addPanel(endGeo, new THREE.Vector3(CW / 2, hy, 0), new THREE.Vector3(0.52, 0.1, 0), "z", -1);
    addPanel(endGeo, new THREE.Vector3(-CW / 2, hy, 0), new THREE.Vector3(-0.52, 0.1, 0), "z", 1);

    this.crateLid = new THREE.Mesh(new THREE.BoxGeometry(CW + 0.04, CT, CD + 0.04), this._crateMaterial(2));
    this.crateLid.position.y = CH / 2;
    crate.add(this.crateLid);

    crate.position.set(0, 0.62, 0);
    crate.renderOrder = 0;
    crate.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    this.crate = crate;
    this.crateTop = CH / 2;
    g.add(crate);

    // Hero shipping container with doors that actually swing.
    const cMat = this._containerMaterial("#b33b2e", true);
    const container = new THREE.Group();
    const shellBox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.68, 0.84), cMat);
    container.add(shellBox);
    this.containerDoors = [];
    [1, -1].forEach((side) => {
      const pivot = new THREE.Group();
      pivot.position.set(-0.7, 0, side * 0.42);
      const leaf = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.66, 0.42),
        this._steelMaterial(0x8d3326, 0.6, 0.5)
      );
      leaf.position.set(0, 0, -side * 0.21);
      pivot.add(leaf);
      container.add(pivot);
      this.containerDoors.push({ pivot, side });
    });
    container.position.set(1.55, 0.62, 0);
    // Draw after the crate so the steel always occludes the timber inside it,
    // regardless of how the transparent sort happens to order them.
    container.renderOrder = 2;
    container.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    this.heroContainer = container;
    g.add(container);

    // Crane: a cable that pays out and a hook block, for the lift onto the deck.
    const crane = new THREE.Group();
    this.craneCable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 1, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.9, roughness: 0.4, transparent: true })
    );
    this.craneHook = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.34), this._steelMaterial(0xf59e0b, 0.85, 0.4));
    crane.add(this.craneCable, this.craneHook);
    crane.visible = false;
    this.crane = crane;
    g.add(crane);

    const ship = new THREE.Group();
    const hullSide = new THREE.MeshStandardMaterial({
      map: hullTexture(this._maxAniso),
      metalness: 0.78,
      roughness: 0.42,
      normalMap: this.steel.normalMap,
      transparent: true,
      envMapIntensity: 1.2,
    });
    hullSide.normalScale.set(0.4, 0.4);
    const hullPlain = this._steelMaterial(0x1f2a36, 0.8, 0.45);
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(6.8, 0.92, 1.95),
      [hullPlain, hullPlain, hullPlain, hullPlain, hullSide, hullSide]
    );
    ship.add(hull);

    const boot = new THREE.Mesh(new THREE.BoxGeometry(6.86, 0.2, 2.0), this._steelMaterial(0x7c2d12, 0.4, 0.6));
    boot.position.y = -0.4;
    ship.add(boot);

    [-1, 1].forEach((side) => {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.92, 0.14), this._steelMaterial(0x1f2a36, 0.8, 0.45));
      plate.position.set(-3.8, 0, side * 0.5);
      plate.rotation.y = side * 0.62;
      ship.add(plate);
    });

    const house = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.0, 1.5), this._steelMaterial(0xe6ebf2, 0.6, 0.4));
    house.position.set(2.55, 0.96, 0);
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(1.18, 0.24, 1.54),
      new THREE.MeshStandardMaterial({
        color: 0x0b1a2a,
        metalness: 0.95,
        roughness: 0.08,
        transparent: true,
        envMapIntensity: 1.8,
      })
    );
    bridge.position.set(2.55, 1.24, 0);
    const funnel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.2, 0.56, 32),
      this._steelMaterial(0x2b3542, 0.7, 0.45)
    );
    funnel.position.set(2.98, 1.7, 0);
    const funnelBand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.21, 0.21, 0.15, 32),
      this._steelMaterial(0xf59e0b, 0.8, 0.35)
    );
    funnelBand.position.set(2.98, 1.78, 0);
    ship.add(house, bridge, funnel, funnelBand);

    // Deck stack. One slot is deliberately left empty for the hero container.
    const palette = ["#0e7490", "#b45309", "#3c6e4f", "#1f4f78"];
    const boxGeo = new THREE.BoxGeometry(1.4, 0.68, 0.84);
    this.deckSlot = new THREE.Vector3(0.7, 1.54, 0.5);
    let n = 0;
    for (let bay = 0; bay < 3; bay++) {
      for (let row = 0; row < 2; row++) {
        for (let tier = 0; tier < 2; tier++) {
          const x = -2.2 + bay * 1.45;
          const y = 0.84 + tier * 0.7;
          const z = row === 0 ? 0.5 : -0.5;
          if (Math.abs(x - this.deckSlot.x) < 0.01 && Math.abs(y - this.deckSlot.y) < 0.01 && z === this.deckSlot.z) {
            continue;
          }
          const box = new THREE.Mesh(boxGeo, this._containerMaterial(palette[n % palette.length], n % 2 === 0));
          box.position.set(x, y, z);
          ship.add(box);
          n++;
        }
      }
    }

    ship.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    const deckGlow = this._sprite(0x06b6d4, 5, 0.35);
    deckGlow.position.set(0, 1.0, 0);
    ship.add(deckGlow);
    ship.position.set(-12, -0.6, 0);
    this.ship = ship;
    g.add(ship);

    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x04151f,
      metalness: 0.82,
      roughness: 0.07,
      transparent: true,
      envMapIntensity: 2.0,
    });
    this._loadMap("water_normals.jpg", (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(10, 10);
      waterMat.normalMap = t;
      waterMat.normalScale.set(0.55, 0.55);
      waterMat.needsUpdate = true;
      this.waterNormal = t;
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(120, 120, 1, 1), waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -1.02;
    this.water.receiveShadow = !LOW_POWER;
    g.add(this.water);

    g.visible = false;
    this.scene.add(g);
    this.groupB = g;
  }

  _initPhaseC() {
    const g = new THREE.Group();

    const globeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.16,
      transparent: true,
      envMapIntensity: 0.5,
    });
    // Full-resolution NASA imagery on desktop; the 2K derivative where the GPU
    // or the device can't justify it.
    const colorFile =
      LOW_POWER || this._maxTexture < 8192 ? "earth_color_2048.jpg" : "earth_color_5400.jpg";
    this._loadMap(colorFile, (t) => {
      globeMat.map = t;
      globeMat.needsUpdate = true;
    }, true);
    this._loadMap("earth_normal_2048.jpg", (t) => {
      globeMat.normalMap = t;
      globeMat.normalScale.set(0.85, 0.85);
      globeMat.needsUpdate = true;
    });
    // The NASA specular map is white over water; roughness wants the inverse.
    this._loadMap("earth_specular_2048.jpg", (t) => {
      const img = t.image;
      const { c, ctx } = canvas2d(img.width, img.height);
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = 255 - d.data[i];
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
      }
      ctx.putImageData(d, 0, 0);
      const inv = new THREE.CanvasTexture(c);
      inv.anisotropy = this._maxAniso;
      globeMat.roughnessMap = inv;
      globeMat.needsUpdate = true;
      t.dispose();
    });

    this.globe = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 128, 128), globeMat);
    g.add(this.globe);

    if (!LOW_POWER) {
      const cloudMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        roughness: 0.95,
        metalness: 0,
      });
      // alphaMap reads the green channel, which works whether the source PNG
      // carries real transparency or is white-on-black.
      this._loadMap("earth_clouds_2048.png", (t) => {
        cloudMat.alphaMap = t;
        cloudMat.needsUpdate = true;
      });
      this.clouds = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.012, 96, 96), cloudMat);
      this.clouds.userData.skipFade = true;
      g.add(this.clouds);
    }

    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0x4aa8ff) },
        uIntensity: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.1, 64, 64), this.atmoMat);
    atmo.userData.skipFade = true;
    g.add(atmo);

    const halo = this._sprite(0x1e6fd0, GLOBE_R * 4.6, 0.4);
    g.add(halo);

    const origin = latLonToVec3(CHINA.lat, CHINA.lon, GLOBE_R);
    this.arcs = [];
    OFFICES.forEach((office) => {
      const target = latLonToVec3(office.lat, office.lon, GLOBE_R);
      const spread = origin.angleTo(target) / Math.PI;
      const mid = origin
        .clone()
        .add(target)
        .multiplyScalar(0.5)
        .normalize()
        .multiplyScalar(GLOBE_R * (1.2 + spread * 0.75));
      const curve = new THREE.QuadraticBezierCurve3(origin, mid, target);
      const mat = new THREE.ShaderMaterial({
        vertexShader: ARC_VERT,
        fragmentShader: ARC_FRAG,
        uniforms: {
          uReveal: { value: 0 },
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color(0xffc04d) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const arc = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.017, 10, false), mat);
      arc.userData.skipFade = true;
      arc.userData.marker = this._sprite(0xffc04d, 0.32, 0);
      arc.userData.marker.position.copy(target);
      g.add(arc, arc.userData.marker);
      this.arcs.push(arc);
    });

    this.originMarker = this._sprite(0xff8a3c, 0.48, 0.95);
    this.originMarker.position.copy(origin);
    g.add(this.originMarker);

    g.position.set(0, 0, -2);
    // Fixed orientation with China facing camera: Y brings its longitude round to
    // +Z, X tilts its latitude to centre. Default Euler order applies Y then X.
    g.rotation.set(THREE.MathUtils.degToRad(CHINA.lat), -Math.atan2(origin.x, origin.z), 0);
    g.visible = false;
    this.scene.add(g);
    this.groupC = g;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this._zBoost = aspect >= 1 ? 1 : clamp(1 / Math.max(aspect, 0.4), 1, 2.1);
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
  }

  setProgress(p) {
    this._targetProgress = clamp(p, 0, 3);
  }

  _fade(group, opacity) {
    group.traverse((o) => {
      if (!o.material || o.userData.skipFade) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.opacity = opacity;
    });
  }

  _updatePhaseA(t, time) {
    const fade = 1 - smoothstep(t, 1 - OVERLAP, 1 + OVERLAP);
    this._fade(this.groupA, fade);

    // Strictly scroll-driven: the strike and the burst are both functions of
    // scroll position, so nothing moves on its own.
    const fall = smoothstep(t, 0.12, 0.26);
    const burst = clamp((t - 0.26) / 0.5, 0, 1);

    this.hammer.position.y = lerp(2.25, 0.72, fall);
    this.hammer.position.x = lerp(-0.34, 0, fall);
    this.hammer.rotation.z = lerp(0.46, 0.06, fall);

    const impact = burst > 0 ? Math.pow(1 - burst, 2.2) : 0;
    const heat = 0.25 + impact * 0.95;
    this.hearth.scale.setScalar(1.6 + impact * 3.4);
    this.hearth.material.opacity = (0.25 + impact * 0.75) * fade;
    this.forge.intensity = (1.6 + impact * 26) * fade;

    this.sparkMat.uniforms.uBurst.value = burst;
    this.sparkMat.uniforms.uOpacity.value = burst > 0 ? fade : 0;
    this.emberMat.uniforms.uOpacity.value = (0.3 + impact * 0.5) * fade;

    this.smoke.forEach((s, i) => {
      const grow = burst;
      const d = s.userData.dir;
      s.position.set(d.x * grow * 1.15, 0.5 + d.y * grow * 1.5, d.z * grow * 1.15);
      s.scale.setScalar(1.1 + grow * 4.2 + s.userData.seed);
      s.material.opacity = burst > 0 ? Math.sin(Math.min(burst, 1) * Math.PI) * 0.26 * fade : 0;
      s.material.rotation = s.userData.seed * 6.28 + grow * (i % 2 ? 0.5 : -0.5);
    });

    this._shake = burst > 0 && burst < 0.35 ? (1 - burst / 0.35) * 0.2 : 0;
  }

  _updatePhaseB(raw, time, dt) {
    this._shake = 0;
    const fade = smoothstep(raw, -OVERLAP, OVERLAP) * (1 - smoothstep(raw, 1 - OVERLAP, 1 + OVERLAP));
    this._fade(this.groupB, fade);
    const t = clamp(raw, 0, 1);

    // One continuous shot. Every handover overlaps: nothing is switched on while
    // something else still occupies the same space at full opacity, which is what
    // made the machine and crate interpenetrate before.
    //
    //  .00-.16 machine assembles      .16-.32 crate closes around it
    //  .30-.44 container rolls in     .42-.52 doors open
    //  .50-.62 crate slides inside    .60-.68 doors close
    //  .46-.66 ship berths            .64-.82 crane lifts container to the deck
    //  .80-1.0 ship sails out

    // -- machine
    const machineIn = smoothstep(t, 0, 0.1);
    const machineGone = smoothstep(t, 0.36, 0.45);
    this.machine.visible = machineGone < 1;
    this.machine.scale.setScalar(lerp(0.35, 1, machineIn));
    this.machine.rotation.y = lerp(-1.2, 0, smoothstep(t, 0, 0.3));
    this._setOpacity(this.machine, fade * (1 - machineGone));

    // Running gear: spins up as the machine finishes assembling.
    const running = machineIn * (1 - machineGone);
    const drive = time * 2.4 * running;
    this.gears.forEach(({ gear, speed }) => {
      gear.rotation.z = drive * speed;
    });
    this.piston.position.x = 0.26 + Math.sin(drive) * 0.055;
    this.steam.forEach((puff, i) => {
      const u = (time * 0.42 + puff.userData.offset) % 1;
      puff.position.set(
        this.stackTip.x + Math.sin(u * 3.2 + i) * 0.07 * u,
        this.stackTip.y + u * 0.42,
        this.stackTip.z
      );
      puff.scale.setScalar(0.1 + u * 0.4);
      puff.material.opacity = Math.sin(u * Math.PI) * 0.4 * fade * running;
    });

    // -- crate: four hinged panels fold up from flat, then the lid seats
    const fold = smoothstep(t, 0.3, 0.44);
    const lidDown = smoothstep(t, 0.41, 0.5);
    const intoBox = smoothstep(t, 0.6, 0.69);
    const crateGone = smoothstep(t, 0.71, 0.76);
    this.crate.visible = t > 0.26 && crateGone < 1;
    this.cratePanels.forEach(({ pivot, axis, sign, closed, open }) => {
      pivot.position.lerpVectors(open, closed, fold);
      pivot.rotation[axis] = sign * 0.78 * (1 - fold);
    });
    this.crateLid.position.y = lerp(1.0, this.crateTop, lidDown);
    this.crateLid.visible = lidDown > 0.001;
    this.crate.position.x = lerp(0, 1.55, intoBox);
    this._setOpacity(this.crate, fade * (1 - crateGone));

    // -- container rolls in, opens, closes
    const boxIn = smoothstep(t, 0.48, 0.56);
    const doorsOpen = smoothstep(t, 0.55, 0.61) * (1 - smoothstep(t, 0.69, 0.74));
    this.heroContainer.visible = boxIn > 0;
    this.containerDoors.forEach(({ pivot, side }) => {
      pivot.rotation.y = side * 1.95 * doorsOpen;
    });

    // -- ship berths well before the lift, departs well after it lands
    const berth = smoothstep(t, 0.5, 0.68);
    // raw, not clamped t: the departure carries on through the crossfade to phase 3.
    const depart = smoothstep(raw, 0.95, 1.14);
    this.ship.visible = berth > 0;
    this.water.visible = t > 0.36;
    this._setOpacity(this.water, fade * smoothstep(t, 0.36, 0.5));
    this.ship.position.x = lerp(-12, -3.8, berth) + depart * 11;
    this.ship.position.y = -0.6 + (REDUCED_MOTION ? 0 : Math.sin(time * 1.1) * 0.05);
    this.ship.rotation.z = REDUCED_MOTION ? 0 : Math.sin(time * 0.9) * 0.02;

    // -- crane: one path, three strictly sequential legs (rise, traverse, lower).
    // Blending overlapping lerps on the same axis made the lift bump mid-move.
    const h = smoothstep(t, 0.74, 0.97);
    const slotX = this.ship.position.x + this.deckSlot.x;
    const slotY = this.ship.position.y + this.deckSlot.y;
    const slotZ = this.deckSlot.z;
    const cruiseY = 2.9;
    const across = smoothstep(h, 0.26, 0.66);
    const cx = lerp(1.55, slotX, across);
    const cz = lerp(0, slotZ, across);
    // Rise overlaps the traverse so the top corner rounds off; the descent starts
    // only after the traverse is done, giving a clean vertical set-down.
    const cy =
      lerp(0.62, cruiseY, smoothstep(h, 0, 0.34)) + (slotY - cruiseY) * smoothstep(h, 0.68, 1);
    this.heroContainer.position.set(boxIn > 0 && h <= 0 ? lerp(5.6, 1.55, boxIn) : cx, cy, cz);

    const hooked = smoothstep(t, 0.7, 0.76);
    this.crane.visible = hooked > 0 && h < 0.995;
    if (this.crane.visible) {
      const topY = 5.2;
      const hookY = cy + 0.52;
      this.craneHook.position.set(cx, hookY, cz);
      this.craneCable.position.set(cx, (topY + hookY) / 2, cz);
      this.craneCable.scale.y = Math.max(topY - hookY, 0.01);
      this._setOpacity(this.crane, fade * hooked * (1 - smoothstep(h, 0.9, 1)));
    }

    if (this.waterNormal) {
      this.waterNormal.offset.x += dt * 0.014;
      this.waterNormal.offset.y += dt * 0.022;
    }
  }

  _updatePhaseC(raw, time) {
    this._shake = 0;
    const t = clamp(raw, 0, 1);
    const fade = smoothstep(raw, -OVERLAP, OVERLAP);
    this.globe.material.opacity = fade;
    this.atmoMat.uniforms.uIntensity.value = fade * 0.95;
    if (this.clouds) this.clouds.material.opacity = fade * 0.42;
    this.groupC.scale.setScalar(lerp(0.55, 1, smoothstep(t, 0, 0.32)));

    this.arcs.forEach((arc, i) => {
      const reveal = clamp((t - (0.2 + i * 0.07)) / 0.26, 0, 1);
      arc.material.uniforms.uReveal.value = reveal;
      arc.material.uniforms.uOpacity.value = fade;
      arc.userData.marker.material.opacity = reveal > 0.9 ? fade : 0;
    });

    const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 3) * 0.18;
    this.originMarker.scale.setScalar(0.48 * pulse);
    this.originMarker.material.opacity = fade;
  }

  _updateCamera(p, time, dt) {
    // One continuous track across the whole storyboard. The old per-phase blocks
    // each defined their own start pose, so the camera teleported at p=1 and p=2.
    let i = 0;
    while (i < CAM_KEYS.length - 2 && p > CAM_KEYS[i + 1].p) i++;
    const a = CAM_KEYS[i];
    const b = CAM_KEYS[i + 1];
    const u = smoothstep(p, a.p, b.p);
    this._camBase.set(
      lerp(a.pos[0], b.pos[0], u),
      lerp(a.pos[1], b.pos[1], u),
      lerp(a.pos[2], b.pos[2], u)
    );
    this._camTarget.set(
      lerp(a.look[0], b.look[0], u),
      lerp(a.look[1], b.look[1], u),
      lerp(a.look[2], b.look[2], u)
    );

    const offset = this._camBase.clone().sub(this._camTarget).multiplyScalar(this._zBoost);
    const desired = this._camTarget.clone().add(offset);
    if (!REDUCED_MOTION) {
      desired.x += this._mouse.x * 0.55;
      desired.y += -this._mouse.y * 0.35;
    }

    if (!this._camReady) {
      this._camPos.copy(desired);
      this._camLook.copy(this._camTarget);
      this._camReady = true;
    } else {
      // Frame-rate independent damping: the same smoothing at 30fps and 144fps.
      const k = 1 - Math.pow(0.0009, dt);
      this._camPos.lerp(desired, k);
      this._camLook.lerp(this._camTarget, k);
    }

    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);

    if (this._shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this._shake;
      this.camera.position.y += (Math.random() - 0.5) * this._shake;
    }
  }

  _tick() {
    requestAnimationFrame(() => this._tick());

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.getElapsedTime();
    // Smooth the scroll value once, here, so the camera, fades and object
    // animations all inherit the same easing instead of tracking raw scroll.
    this.progress += (this._targetProgress - this.progress) * (1 - Math.pow(0.0025, dt));
    const p = this.progress;

    this._mouse.lerp(this._mouseTarget, REDUCED_MOTION ? 0 : 0.06);
    this.dust.rotation.y = time * 0.012;
    this.emberMat.uniforms.uTime.value = time;
    this.arcs.forEach((a) => {
      a.material.uniforms.uTime.value = time;
    });

    // Crossfade the gradient sky out to open starfield as the globe comes in.
    const space = clamp((p - 1.72) / 0.5, 0, 1);
    this.starfield.material.opacity = 0.75 + space * 0.25;
    this.backdrop.material.opacity = 0.82 - space * 0.72;
    this.dust.material.opacity = 0.32 * (1 - space * 0.6);

    // Overlap windows so consecutive phases dissolve into each other. Previously
    // each group was toggled on exactly where the last one switched off, so the
    // opacity ramps never actually overlapped and the cut was visible.
    const aVis = p < 1 + OVERLAP;
    const bVis = p > 1 - OVERLAP && p < 2 + OVERLAP;
    const cVis = p > 2 - OVERLAP;
    this.groupA.visible = aVis;
    this.groupB.visible = bVis;
    this.groupC.visible = cVis;

    if (aVis) this._updatePhaseA(p, time);
    else this.forge.intensity = 0; // only phase A drives it; don't leave it lit
    if (bVis) this._updatePhaseB(p - 1, time, dt);
    if (cVis) this._updatePhaseC(p - 2, time);

    this._updateCamera(p, time, dt);

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
