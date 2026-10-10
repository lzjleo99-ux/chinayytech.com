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

const RIB = 64;

// The rib pattern is identical for every container colour, so the Sobel pass runs
// once and the resulting normal map is shared.
function corrugationNormal(maxAnisotropy) {
  const w = 1024, h = 512;
  const { ctx } = canvas2d(w, h);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, w, h);
  const rib = RIB / 2;
  for (let x = 0; x < w; x += rib) {
    const g = ctx.createLinearGradient(x, 0, x + rib, 0);
    g.addColorStop(0, "#2a2a2a");
    g.addColorStop(0.5, "#e2e2e2");
    g.addColorStop(1, "#2a2a2a");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, rib, h);
  }
  const t = new THREE.CanvasTexture(sobelNormal(ctx, w, h, 1.5));
  t.anisotropy = maxAnisotropy;
  return t;
}

// Corrugated container side. Rendered large so the branding stays razor sharp;
// text is drawn as vectors, so resolution costs nothing in download size.
function containerAlbedo(baseColor, brand, maxAnisotropy) {
  const w = 2048, h = 1024;
  const { c, ctx } = canvas2d(w, h);
  const rib = RIB;
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, w, h);

  for (let x = 0; x < w; x += rib) {
    const g = ctx.createLinearGradient(x, 0, x + rib, 0);
    g.addColorStop(0, "rgba(0,0,0,0.36)");
    g.addColorStop(0.34, "rgba(255,255,255,0.13)");
    g.addColorStop(0.66, "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(0,0,0,0.36)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 64, rib, h - 128);
  }

  ctx.fillStyle = "rgba(0,0,0,0.44)";
  ctx.fillRect(0, 0, w, 64);
  ctx.fillRect(0, h - 64, w, 64);
  ctx.fillStyle = "rgba(16,20,26,0.92)";
  [[0, 0], [w - 136, 0], [0, h - 88], [w - 136, h - 88]].forEach(([x, y]) => ctx.fillRect(x, y, 136, 88));

  for (let i = 0; i < 520; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, Math.random() * 170, Math.random() * 26);
  }
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(${90 + Math.random() * 60},${50 + Math.random() * 40},30,${Math.random() * 0.22})`;
    const r = 6 + Math.random() * 30;
    ctx.beginPath();
    ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (brand) {
    // System sans only: webfonts may not be rasterisable when this canvas is drawn.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.font = "bold 176px Helvetica, Arial, sans-serif";
    ctx.fillText("CHINA YY TECH", w / 2, h * 0.43);
    ctx.fillStyle = "rgba(255,255,255,0.84)";
    ctx.font = "500 76px Helvetica, Arial, sans-serif";
    ctx.fillText("chinayytech.com", w / 2, h * 0.58);
    ctx.shadowBlur = 0;
  }

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  return map;
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

const SPARK_VERT = `
attribute vec3 aVel;
attribute float aSize;
attribute float aSeed;
uniform float uBurst;
uniform float uPixelRatio;
varying float vFade;
void main() {
  float t = uBurst;
  vec3 p = position + aVel * t * 0.9;
  p.y -= 3.4 * t * t;
  p.x += sin(aSeed * 6.283 + t * 9.0) * 0.07 * t;
  p.z += cos(aSeed * 6.283 + t * 7.5) * 0.07 * t;
  vFade = clamp(1.0 - t, 0.0, 1.0) * (0.45 + 0.55 * aSeed);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uPixelRatio * (260.0 / max(-mv.z, 0.001));
  gl_Position = projectionMatrix * mv;
}`;

const SPARK_FRAG = `
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec3 uHot;
uniform vec3 uCool;
varying float vFade;
void main() {
  vec4 tex = texture2D(uTex, gl_PointCoord);
  vec3 col = mix(uCool, uHot, clamp(vFade * 1.5, 0.0, 1.0));
  // Pushed above 1.0 so the bloom threshold catches the hottest cores.
  gl_FragColor = vec4(col * (1.0 + vFade * 1.6), tex.a * vFade * uOpacity);
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
    this.renderer.toneMappingExposure = 1.12;
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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.72, 0.78);
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
    const key = new THREE.DirectionalLight(0xfff4e2, 2.6);
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

    this.scene.add(new THREE.AmbientLight(0x1e2638, 0.8));
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

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0a0f18,
        metalness: 0.55,
        roughness: 0.72,
        transparent: true,
        envMapIntensity: 0.6,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.18;
    floor.receiveShadow = !LOW_POWER;
    g.add(floor);

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.4, 2.5), this._steelMaterial(0x1a212d, 0.8, 0.55));
    plinth.position.y = -0.98;
    plinth.castShadow = plinth.receiveShadow = !LOW_POWER;
    g.add(plinth);

    const anvilMat = this._steelMaterial(0xb9c0c8, 1.0, 0.26);
    const anvil = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.18, 0.5, 64), anvilMat);
    anvil.position.y = -0.33;
    const anvilTop = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.92, 0.12, 64), anvilMat);
    anvilTop.position.y = -0.03;
    [anvil, anvilTop].forEach((m) => {
      m.castShadow = m.receiveShadow = !LOW_POWER;
      g.add(m);
    });

    const hammer = new THREE.Group();
    const headMat = this._steelMaterial(0x4a515d, 0.95, 0.32);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.58, 0.78), headMat);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.66, 32), headMat);
    collar.position.y = 0.3;
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.105, 1.55, 24),
      new THREE.MeshStandardMaterial({
        color: 0x6b4426,
        roughness: 0.82,
        metalness: 0.05,
        normalMap: this.steel.normalMap,
        transparent: true,
        envMapIntensity: 0.5,
      })
    );
    handle.position.y = 1.0;
    hammer.add(head, collar, handle);
    hammer.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    hammer.position.y = 1.9;
    g.add(hammer);
    this.hammer = hammer;

    this.hearth = this._sprite(0xf59e0b, 3.8, 0.8);
    this.hearth.position.set(0, 0.06, 0);
    g.add(this.hearth);

    const SPARKS = LOW_POWER ? 4000 : 18000;
    const sGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(SPARKS * 3);
    const sVel = new Float32Array(SPARKS * 3);
    const sSize = new Float32Array(SPARKS);
    const sSeed = new Float32Array(SPARKS);
    for (let i = 0; i < SPARKS; i++) {
      sPos[i * 3] = (Math.random() - 0.5) * 0.34;
      sPos[i * 3 + 1] = 0.06;
      sPos[i * 3 + 2] = (Math.random() - 0.5) * 0.34;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const speed = 1.3 + Math.pow(Math.random(), 0.6) * 4.6;
      sVel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed * 1.35;
      sVel[i * 3 + 1] = Math.cos(phi) * speed * 0.85 + 0.5;
      sVel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed * 1.35;
      sSize[i] = 0.5 + Math.random() * 2.2;
      sSeed[i] = Math.random();
    }
    sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
    sGeo.setAttribute("aVel", new THREE.BufferAttribute(sVel, 3));
    sGeo.setAttribute("aSize", new THREE.BufferAttribute(sSize, 1));
    sGeo.setAttribute("aSeed", new THREE.BufferAttribute(sSeed, 1));
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: {
        uBurst: { value: 0 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: this._pixelRatio },
        uTex: { value: this.glow },
        uHot: { value: new THREE.Color(0xfff2d0) },
        uCool: { value: new THREE.Color(0xd43b12) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sparks = new THREE.Points(sGeo, this.sparkMat);
    sparks.frustumCulled = false;
    sparks.userData.skipFade = true;
    g.add(sparks);

    const EMBERS = LOW_POWER ? 300 : 900;
    const eGeo = new THREE.BufferGeometry();
    const ePos = new Float32Array(EMBERS * 3);
    const eSize = new Float32Array(EMBERS);
    const eSeed = new Float32Array(EMBERS);
    const eSpeed = new Float32Array(EMBERS);
    for (let i = 0; i < EMBERS; i++) {
      const r = Math.random() * 1.7;
      const a = Math.random() * Math.PI * 2;
      ePos[i * 3] = Math.cos(a) * r;
      ePos[i * 3 + 1] = 0;
      ePos[i * 3 + 2] = Math.sin(a) * r;
      eSize[i] = 0.4 + Math.random() * 1.4;
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

    const machine = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(1.45, 1.05, 1.05), this._steelMaterial(0xdde3ea, 0.85, 0.28));
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.36, 1.25, 48),
      this._steelMaterial(0xf59e0b, 0.9, 0.28)
    );
    drum.rotation.z = Math.PI / 2;
    drum.position.x = 0.92;
    machine.add(shell, drum);
    machine.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    this.machine = machine;
    g.add(machine);

    this.crate = new THREE.Mesh(new THREE.BoxGeometry(1.65, 1.35, 1.65), this._steelMaterial(0xb33b2e, 0.55, 0.52));
    this.crate.castShadow = !LOW_POWER;
    g.add(this.crate);

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
      new THREE.BoxGeometry(6.2, 0.85, 1.7),
      [hullPlain, hullPlain, hullPlain, hullPlain, hullSide, hullSide]
    );
    ship.add(hull);

    const boot = new THREE.Mesh(new THREE.BoxGeometry(6.26, 0.18, 1.76), this._steelMaterial(0x7c2d12, 0.4, 0.6));
    boot.position.y = -0.36;
    ship.add(boot);

    [-1, 1].forEach((side) => {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.85, 0.12), this._steelMaterial(0x1f2a36, 0.8, 0.45));
      plate.position.set(-3.45, 0, side * 0.44);
      plate.rotation.y = side * 0.62;
      ship.add(plate);
    });

    const house = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.95, 1.32), this._steelMaterial(0xe6ebf2, 0.6, 0.4));
    house.position.set(2.2, 0.9, 0);
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(1.08, 0.22, 1.36),
      new THREE.MeshStandardMaterial({
        color: 0x0b1a2a,
        metalness: 0.95,
        roughness: 0.08,
        transparent: true,
        envMapIntensity: 1.8,
      })
    );
    bridge.position.set(2.2, 1.16, 0);
    const funnel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.19, 0.52, 32),
      this._steelMaterial(0x2b3542, 0.7, 0.45)
    );
    funnel.position.set(2.62, 1.6, 0);
    const funnelBand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.14, 32),
      this._steelMaterial(0xf59e0b, 0.8, 0.35)
    );
    funnelBand.position.set(2.62, 1.68, 0);
    ship.add(house, bridge, funnel, funnelBand);

    const ribNormal = corrugationNormal(this._maxAniso);
    const mk = (map, rough) => {
      const m = new THREE.MeshStandardMaterial({
        map,
        normalMap: ribNormal,
        metalness: 0.5,
        roughness: rough,
        transparent: true,
        envMapIntensity: 1.15,
      });
      m.normalScale.set(0.9, 0.9);
      return m;
    };
    const top = mk(containerAlbedo("#9aa1a9", false, this._maxAniso), 0.6);
    const end = mk(containerAlbedo("#8b9199", false, this._maxAniso), 0.55);
    const matCache = new Map();
    const containerMat = (hex) => {
      if (matCache.has(hex)) return matCache.get(hex);
      const side = mk(containerAlbedo(hex, true, this._maxAniso), 0.5);
      // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
      const mats = [end, end, top, top, side, side];
      matCache.set(hex, mats);
      return mats;
    };
    const palette = ["#b33b2e", "#0e7490", "#b45309", "#3c6e4f"];
    const boxGeo = new THREE.BoxGeometry(1.28, 0.62, 0.76);
    let n = 0;
    for (let bay = 0; bay < 3; bay++) {
      for (let row = 0; row < 2; row++) {
        for (let tier = 0; tier < 2; tier++) {
          const box = new THREE.Mesh(boxGeo, containerMat(palette[n % palette.length]));
          box.position.set(-2.35 + bay * 1.34, 0.74 + tier * 0.64, row === 0 ? 0.41 : -0.41);
          ship.add(box);
          n++;
        }
      }
    }

    ship.traverse((m) => {
      if (m.isMesh) m.castShadow = !LOW_POWER;
    });
    const deckGlow = this._sprite(0x06b6d4, 5, 0.35);
    deckGlow.position.set(0, 0.9, 0);
    ship.add(deckGlow);
    ship.position.set(0, -0.6, 0);
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
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(90, 90, 1, 1), waterMat);
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
    this.progress = clamp(p, 0, 3);
  }

  _fade(group, opacity) {
    group.traverse((o) => {
      if (!o.material || o.userData.skipFade) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.opacity = opacity;
    });
  }

  _updatePhaseA(t, time) {
    const fade = 1 - smoothstep(t, 0.86, 1);
    this._fade(this.groupA, fade);

    const fall = smoothstep(t, 0.12, 0.26);
    const bob = REDUCED_MOTION ? 0 : Math.sin(time * 1.2) * 0.12 * (1 - fall);
    this.hammer.position.y = lerp(1.9 + bob, 0.52, fall);
    this.hammer.rotation.z = lerp(-0.22, 0, fall);

    const burst = clamp((t - 0.26) / 0.5, 0, 1);
    const heat = 0.5 + fall * 0.55;
    const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 2.2) * 0.07;
    this.hearth.scale.setScalar(3.8 * pulse * heat);
    this.hearth.material.opacity = 0.72 * fade * heat;
    this.forge.intensity = (2.5 + (1 - burst) * 9 * (burst > 0 ? 1 : 0.18)) * fade * heat;

    this.sparkMat.uniforms.uBurst.value = burst;
    this.sparkMat.uniforms.uOpacity.value = burst > 0 ? fade : 0;
    this.emberMat.uniforms.uOpacity.value = 0.85 * fade;

    this._shake = t > 0.24 && t < 0.4 ? (1 - burst) * 0.14 : 0;
  }

  _updatePhaseB(t, time, dt) {
    this._shake = 0;
    this.forge.intensity = 0;
    const fade = smoothstep(t, 0, 0.08) * (1 - smoothstep(t, 0.9, 1));
    this._fade(this.groupB, fade);

    this.machine.visible = t < 0.44;
    this.machine.scale.setScalar(lerp(0.4, 1, smoothstep(t, 0, 0.16)));
    this.machine.rotation.y = t * Math.PI * 1.4;

    this.crate.visible = t >= 0.3 && t < 0.64;
    this.crate.scale.setScalar(lerp(0.4, 1, smoothstep(t, 0.3, 0.44)));
    this.crate.rotation.y = t * 2.2;

    const shipIn = smoothstep(t, 0.52, 0.7);
    this.ship.visible = t >= 0.5;
    this.water.visible = t >= 0.5;
    this.ship.scale.setScalar(lerp(0.35, 1, shipIn));
    this.ship.position.x = lerp(-4.2, 2.6, smoothstep(t, 0.58, 1));
    this.ship.position.y = -0.6 + (REDUCED_MOTION ? 0 : Math.sin(time * 1.1) * 0.05);
    this.ship.rotation.z = REDUCED_MOTION ? 0 : Math.sin(time * 0.9) * 0.02;

    if (this.waterNormal) {
      this.waterNormal.offset.x += dt * 0.014;
      this.waterNormal.offset.y += dt * 0.022;
    }
  }

  _updatePhaseC(t, time) {
    this._shake = 0;
    this.forge.intensity = 0;
    const fade = smoothstep(t, 0, 0.1);
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

  _updateCamera(p, time) {
    if (p < 1) {
      this._camBase.set(2.6, 3.1, lerp(7.3, 6.5, p));
      this._camTarget.set(0, 2.05, 0);
    } else if (p < 2) {
      const t = p - 1;
      this._camBase.set(lerp(-0.6, 1.8, t), lerp(1.8, 1.3, t), lerp(5.4, 7.6, t));
      this._camTarget.set(lerp(0, 1.2, t), 0, 0);
    } else {
      const t = p - 2;
      this._camBase.set(0, lerp(1.0, 0.5, t), lerp(6.8, 9.4, t));
      this._camTarget.set(0, 0, -2);
    }

    const offset = this._camBase.clone().sub(this._camTarget).multiplyScalar(this._zBoost);
    this.camera.position.copy(this._camTarget).add(offset);

    if (!REDUCED_MOTION) {
      this.camera.position.x += this._mouse.x * 0.55;
      this.camera.position.y += -this._mouse.y * 0.35 + Math.sin(time * 0.4) * 0.06;
    }
    this.camera.lookAt(this._camTarget);

    if (this._shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this._shake;
      this.camera.position.y += (Math.random() - 0.5) * this._shake;
    }
  }

  _tick() {
    requestAnimationFrame(() => this._tick());

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.getElapsedTime();
    const p = this.progress;

    this._mouse.lerp(this._mouseTarget, REDUCED_MOTION ? 0 : 0.06);
    this.dust.rotation.y = time * 0.012;
    this.emberMat.uniforms.uTime.value = time;
    this.arcs.forEach((a) => {
      a.material.uniforms.uTime.value = time;
    });

    // Crossfade the gradient sky out to open starfield as the globe comes in.
    const space = clamp((p - 1.72) / 0.5, 0, 1);
    this.starfield.material.opacity = space;
    this.backdrop.material.opacity = 1 - space * 0.9;
    this.dust.material.opacity = 0.5 * (1 - space * 0.75);

    const phase = p < 1 ? 0 : p < 2 ? 1 : 2;
    this.groupA.visible = phase === 0;
    this.groupB.visible = phase === 1;
    this.groupC.visible = phase === 2;

    if (phase === 0) this._updatePhaseA(p, time);
    else if (phase === 1) this._updatePhaseB(p - 1, time, dt);
    else this._updatePhaseC(Math.min(p - 2, 1), time);

    this._updateCamera(p, time);

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
