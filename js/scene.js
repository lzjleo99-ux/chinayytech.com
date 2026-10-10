import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { EffectComposer } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js";

const LOW_POWER = window.matchMedia("(max-width: 820px)").matches ||
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

const OFFICES = [
  { name: "Serbia", lat: 44.8, lon: 20.5 },
  { name: "United Kingdom", lat: 51.5, lon: -0.12 },
  { name: "Nigeria", lat: 9.1, lon: 7.4 },
  { name: "United States", lat: 39.0, lon: -98.0 },
  { name: "Chile", lat: -33.4, lon: -70.6 },
];
const CHINA = { lat: 23.1, lon: 113.3 };

function latLonToVec3(lat, lon, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function makeEarthTexture() {
  const w = 1024, h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a2342";
  ctx.fillRect(0, 0, w, h);

  // very simplified continent blobs, positioned by rough lat/lon bounding regions
  const land = "#2f6b4f";
  ctx.fillStyle = land;
  const project = (lat, lon) => [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];

  function blob(points) {
    ctx.beginPath();
    points.forEach(([lat, lon], i) => {
      const [x, y] = project(lat, lon);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }

  // Asia / China
  blob([[55,60],[60,140],[40,150],[20,110],[10,95],[25,65]]);
  // Europe
  blob([[60,-10],[60,40],[45,40],[36,10],[40,-10]]);
  // Africa
  blob([[37,-10],[32,35],[-5,42],[-35,20],[-20,10],[10,-15]]);
  // North America
  blob([[70,-160],[70,-60],[25,-80],[15,-100],[30,-120]]);
  // South America
  blob([[10,-80],[-5,-35],[-55,-68],[-20,-75]]);
  // Oceania
  blob([[-10,113],[-12,153],[-38,145],[-35,115]]);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeArcCurve(a, b, radius) {
  const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(radius * 1.35);
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

export class CinematicScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.progress = 0; // 0 -> 3 across the whole storyboard
    this.clock = new THREE.Clock();
    this._shake = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOW_POWER ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.012);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(0, 1.4, 6);

    this._initLights();
    this._initPhaseA();
    this._initPhaseB();
    this._initPhaseC();
    this._initComposer();

    this.resize();
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => {
      this._paused = document.hidden;
    });

    this._tick();
  }

  _initLights() {
    const key = new THREE.DirectionalLight(0xfff2d9, 2.2);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x5588ff, 0.6);
    rim.position.set(-6, 2, -4);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x202633, 1.1));
  }

  // ---- Phase A: hammer impact + sparks ----
  _initPhaseA() {
    const g = new THREE.Group();

    const anvilMat = new THREE.MeshStandardMaterial({ color: 0x8b8f96, metalness: 0.85, roughness: 0.35 });
    const anvil = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.5, 24), anvilMat);
    anvil.position.y = -0.4;
    g.add(anvil);

    const hammerMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.7, roughness: 0.4 });
    const hammerHead = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.6, 0.8), hammerMat);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 10), new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 }));
    handle.position.y = 1.3;
    const hammer = new THREE.Group();
    hammer.add(hammerHead, handle);
    hammer.position.y = 3.2;
    g.add(hammer);
    this.hammer = hammer;

    // sparks: particle burst
    const COUNT = LOW_POWER ? 900 : 2200;
    const pos = new Float32Array(COUNT * 3);
    const vel = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = 0; pos[i * 3 + 1] = -0.1; pos[i * 3 + 2] = 0;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const speed = 1.5 + Math.random() * 3.5;
      vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      vel[i * 3 + 1] = Math.cos(phi) * speed * 1.3 + 1;
      vel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("velocity", new THREE.BufferAttribute(vel, 3));
    geo.userData.basePos = pos.slice();
    const mat = new THREE.PointsMaterial({
      color: 0xffb04a,
      size: 0.045,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sparks = new THREE.Points(geo, mat);
    g.add(sparks);
    this.sparks = sparks;

    g.position.set(0, -0.3, 0);
    g.visible = false;
    this.scene.add(g);
    this.groupA = g;
  }

  // ---- Phase B: assembled machine -> container -> ship ----
  _initPhaseB() {
    const g = new THREE.Group();

    const machine = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd9dee5, metalness: 0.6, roughness: 0.3 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xe8b24d, metalness: 0.5, roughness: 0.3 });
    machine.add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1), bodyMat));
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 20), accentMat);
    drum.rotation.z = Math.PI / 2;
    drum.position.x = 0.9;
    machine.add(drum);
    this.machine = machine;
    g.add(machine);

    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.3, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xb33b2e, metalness: 0.2, roughness: 0.6 })
    );
    crate.visible = false;
    this.crate = crate;
    g.add(crate);

    const ship = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.8, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x25303d, metalness: 0.4, roughness: 0.6 })
    );
    ship.add(hull);
    const containerColors = [0xb33b2e, 0x2f6b8f, 0xe8b24d, 0x3c6e4f];
    for (let i = 0; i < 10; i++) {
      const c = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.6, 1.3),
        new THREE.MeshStandardMaterial({ color: containerColors[i % containerColors.length], metalness: 0.2, roughness: 0.6 })
      );
      c.position.set(-2.4 + i * 0.55, 0.65 + ((i % 2) * 0.62), 0);
      ship.add(c);
    }
    ship.position.set(0, -0.6, 0);
    ship.visible = false;
    this.ship = ship;
    g.add(ship);

    const waterGeo = new THREE.PlaneGeometry(60, 60, 1, 1);
    const water = new THREE.Mesh(
      waterGeo,
      new THREE.MeshStandardMaterial({ color: 0x08263a, metalness: 0.3, roughness: 0.15 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -1.0;
    water.visible = false;
    this.water = water;
    g.add(water);

    g.visible = false;
    this.scene.add(g);
    this.groupB = g;
  }

  // ---- Phase C: globe + trade routes ----
  _initPhaseC() {
    const g = new THREE.Group();
    const R = 2.2;

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 48),
      new THREE.MeshStandardMaterial({ map: makeEarthTexture(), roughness: 0.75, metalness: 0.05 })
    );
    g.add(globe);
    this.globe = globe;

    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.04, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x4d8fe8, transparent: true, opacity: 0.12, side: THREE.BackSide })
    );
    g.add(atmo);

    this.arcs = [];
    const originVec = latLonToVec3(CHINA.lat, CHINA.lon, R);
    OFFICES.forEach((office) => {
      const targetVec = latLonToVec3(office.lat, office.lon, R);
      const curve = makeArcCurve(originVec, targetVec, R);
      const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.012, 6, false);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd37a, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(tubeGeo, mat);
      mesh.geometry.setDrawRange(0, 0);
      mesh.userData.maxIndex = tubeGeo.index.count;
      g.add(mesh);
      this.arcs.push(mesh);

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xffd37a })
      );
      dot.position.copy(targetVec);
      dot.visible = false;
      g.add(dot);
      mesh.userData.dot = dot;
    });

    const originDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff7a3c })
    );
    originDot.position.copy(originVec);
    g.add(originDot);

    g.visible = false;
    g.position.set(0, 0, -2);
    this.scene.add(g);
    this.groupC = g;
  }

  _initComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (!LOW_POWER) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.65, 0.5, 0.82);
      this.composer.addPass(this.bloom);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
  }

  setProgress(p) {
    this.progress = THREE.MathUtils.clamp(p, 0, 3);
  }

  _updatePhaseA(local) {
    // local: 0..1 across phase A
    this.groupA.visible = local > 0 && local < 1;
    if (!this.groupA.visible) return;
    const fadeIn = THREE.MathUtils.smoothstep(local, 0, 0.08);
    const fadeOut = 1 - THREE.MathUtils.smoothstep(local, 0.88, 1);
    this.groupA.traverse((o) => {
      if (o.isMesh && o !== this.sparks) {
        o.material.transparent = true;
        o.material.opacity = fadeIn * fadeOut;
      }
    });

    const strike = THREE.MathUtils.clamp((local - 0.15) / 0.12, 0, 1);
    this.hammer.position.y = THREE.MathUtils.lerp(3.2, 0.42, THREE.MathUtils.smoothstep(strike, 0, 1));

    const burst = THREE.MathUtils.clamp((local - 0.27) / 0.5, 0, 1);
    const pos = this.sparks.geometry.attributes.position;
    const vel = this.sparks.geometry.attributes.velocity;
    const base = this.sparks.geometry.userData.basePos;
    for (let i = 0; i < pos.count; i++) {
      const t = burst;
      pos.array[i * 3] = base[i * 3] + vel.array[i * 3] * t * 0.9;
      pos.array[i * 3 + 1] = base[i * 3 + 1] + vel.array[i * 3 + 1] * t * 0.9 - 2.2 * t * t;
      pos.array[i * 3 + 2] = base[i * 3 + 2] + vel.array[i * 3 + 2] * t * 0.9;
    }
    pos.needsUpdate = true;
    this.sparks.material.opacity = burst > 0 ? (1 - burst) * fadeIn : 0;

    this._shake = local > 0.15 && local < 0.4 ? (1 - burst) * 0.12 : 0;
  }

  _updatePhaseB(local) {
    this.groupB.visible = local > 0 && local < 1;
    if (!this.groupB.visible) return;

    const assembleIn = THREE.MathUtils.smoothstep(local, 0.0, 0.18);
    this.machine.visible = local < 0.42;
    this.machine.scale.setScalar(assembleIn);
    this.machine.rotation.y = local * Math.PI * 1.4;

    const boxIn = THREE.MathUtils.smoothstep(local, 0.3, 0.42);
    this.crate.visible = local >= 0.3 && local < 0.62;
    this.crate.scale.setScalar(boxIn);
    this.crate.rotation.y = local * 2.2;

    const shipIn = THREE.MathUtils.smoothstep(local, 0.55, 0.68);
    this.ship.visible = local >= 0.55;
    this.water.visible = local >= 0.55;
    this.ship.scale.setScalar(THREE.MathUtils.lerp(0.3, 1, shipIn));
    this.ship.position.x = THREE.MathUtils.lerp(-4, 2.5, THREE.MathUtils.smoothstep(local, 0.6, 1));
  }

  _updatePhaseC(local) {
    this.groupC.visible = local > 0;
    if (!this.groupC.visible) return;
    const fadeIn = THREE.MathUtils.smoothstep(local, 0, 0.12);
    this.globe.material.opacity = 1;
    const scale = THREE.MathUtils.lerp(0.4, 1, THREE.MathUtils.smoothstep(local, 0, 0.3));
    this.groupC.scale.setScalar(scale);
    this.groupC.rotation.y = local * 0.6;

    this.arcs.forEach((arc, i) => {
      const start = 0.25 + i * 0.07;
      const reveal = THREE.MathUtils.clamp((local - start) / 0.22, 0, 1);
      const idx = Math.floor(arc.userData.maxIndex * reveal);
      arc.geometry.setDrawRange(0, idx);
      arc.material.opacity = fadeIn;
      arc.userData.dot.visible = reveal > 0.95;
    });
  }

  _tick() {
    requestAnimationFrame(() => this._tick());
    if (this._paused) return;
    const dt = this.clock.getDelta();

    const p = this.progress;
    this._updatePhaseA(THREE.MathUtils.clamp(p, 0, 1));
    this._updatePhaseB(THREE.MathUtils.clamp(p - 1, 0, 1));
    this._updatePhaseC(THREE.MathUtils.clamp(p - 2, 0, 1));

    // camera path across the whole storyboard
    if (p < 1) {
      this.camera.position.set(2.2, 1.6, 4.4);
      this.camera.lookAt(0, 0.2, 0);
    } else if (p < 2) {
      const t = p - 1;
      this.camera.position.set(THREE.MathUtils.lerp(2, -1, t), THREE.MathUtils.lerp(1.4, 1.1, t), THREE.MathUtils.lerp(4.4, 5.5, t));
      this.camera.lookAt(THREE.MathUtils.lerp(0, 1.5, t), 0, 0);
    } else {
      const t = p - 2;
      this.camera.position.set(0, THREE.MathUtils.lerp(1.1, 1.0, t), THREE.MathUtils.lerp(5.5, 8.5, t));
      this.camera.lookAt(0, 0, -2);
    }

    if (this._shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this._shake;
      this.camera.position.y += (Math.random() - 0.5) * this._shake;
    }

    this.composer.render();
  }
}
