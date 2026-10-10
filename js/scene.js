import * as THREE from "./vendor/three.module.min.js";

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

// Soft radial falloff, tinted per-material. Stands in for a bloom pass.
function glowTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.65)");
  g.addColorStop(0.55, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function backdropTexture() {
  const w = 8, h = 256;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#02040a");
  g.addColorStop(0.42, "#061024");
  g.addColorStop(0.68, "#0d2c4d");
  g.addColorStop(0.86, "#071526");
  g.addColorStop(1, "#02040a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function earthTexture() {
  const w = 1024, h = 512;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#071a33";
  ctx.fillRect(0, 0, w, h);

  const project = (lat, lon) => [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];

  ctx.strokeStyle = "rgba(6,182,212,0.10)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(0, lon);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project(lat, 0);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Rough continent silhouettes — stylized, not survey-accurate.
  const blob = (points) => {
    ctx.beginPath();
    points.forEach(([lat, lon], i) => {
      const [x, y] = project(lat, lon);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  ctx.fillStyle = "#15493f";
  ctx.strokeStyle = "rgba(52,211,153,0.35)";
  ctx.lineWidth = 1.5;
  blob([[55, 60], [60, 140], [40, 150], [20, 110], [10, 95], [25, 65]]);
  blob([[60, -10], [60, 40], [45, 40], [36, 10], [40, -10]]);
  blob([[37, -10], [32, 35], [-5, 42], [-35, 20], [-20, 10], [10, -15]]);
  blob([[70, -160], [70, -60], [25, -80], [15, -100], [30, -120]]);
  blob([[10, -80], [-5, -35], [-55, -68], [-20, -75]]);
  blob([[-10, 113], [-12, 153], [-38, 145], [-35, 115]]);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class CinematicScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.progress = 0; // 0 -> 3 across the storyboard
    this.clock = new THREE.Clock();
    this._shake = 0;
    this._zBoost = 1;
    this._mouse = new THREE.Vector2();
    this._mouseTarget = new THREE.Vector2();
    this._camTarget = new THREE.Vector3();
    this._camBase = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !LOW_POWER,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW_POWER ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Transparent clear so the CSS gradient under the canvas shows if a frame is ever empty.
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x03060f, 0.008);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);

    this.glow = glowTexture();

    this._initEnvironment();
    this._initLights();
    this._initPhaseA();
    this._initPhaseB();
    this._initPhaseC();

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
    return s;
  }

  _initEnvironment() {
    const backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(120, 32, 16),
      new THREE.MeshBasicMaterial({
        map: backdropTexture(),
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    this.scene.add(backdrop);

    const COUNT = LOW_POWER ? 450 : 1100;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const r = 14 + Math.random() * 34;
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
        size: 0.5,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    this.scene.add(this.dust);

    // Always-on ambient wash so the canvas never reads as flat black.
    const ambientGlow = this._sprite(0x1e5fa8, 26, 0.5);
    ambientGlow.position.set(-1.5, 0.5, -9);
    this.scene.add(ambientGlow);
  }

  _initLights() {
    const key = new THREE.DirectionalLight(0xfff2d9, 2.4);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x3b82f6, 1.1);
    rim.position.set(-6, 2, -4);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x2a3346, 1.4));
  }

  // ---- Phase A: hammer, anvil, hearth glow, embers, spark burst ----
  _initPhaseA() {
    const g = new THREE.Group();

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.35, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x1b222e, metalness: 0.5, roughness: 0.7, transparent: true })
    );
    base.position.y = -1.0;
    g.add(base);

    const anvil = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.15, 0.55, 28),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.3, transparent: true })
    );
    anvil.position.y = -0.275;
    g.add(anvil);

    const hammer = new THREE.Group();
    hammer.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 0.55, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x424954, metalness: 0.85, roughness: 0.35, transparent: true })
      )
    );
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 1.5, 12),
      new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 0.85, transparent: true })
    );
    handle.position.y = 0.95;
    hammer.add(handle);
    hammer.position.y = 1.9;
    g.add(hammer);
    this.hammer = hammer;

    this.hearth = this._sprite(0xf59e0b, 3.6, 0.85);
    this.hearth.position.set(0, 0.05, 0);
    g.add(this.hearth);

    const EMBERS = LOW_POWER ? 90 : 220;
    const ePos = new Float32Array(EMBERS * 3);
    this._emberSpeed = new Float32Array(EMBERS);
    for (let i = 0; i < EMBERS; i++) {
      const r = Math.random() * 1.5;
      const a = Math.random() * Math.PI * 2;
      ePos[i * 3] = Math.cos(a) * r;
      ePos[i * 3 + 1] = -0.4 + Math.random() * 3.4;
      ePos[i * 3 + 2] = Math.sin(a) * r;
      this._emberSpeed[i] = 0.18 + Math.random() * 0.42;
    }
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
    this.embers = new THREE.Points(
      eGeo,
      new THREE.PointsMaterial({
        map: this.glow,
        color: 0xffb347,
        size: 0.17,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    g.add(this.embers);

    const SPARKS = LOW_POWER ? 900 : 2200;
    const sPos = new Float32Array(SPARKS * 3);
    this._sparkBase = new Float32Array(SPARKS * 3);
    this._sparkVel = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) {
      const ox = (Math.random() - 0.5) * 0.3;
      const oz = (Math.random() - 0.5) * 0.3;
      this._sparkBase[i * 3] = ox;
      this._sparkBase[i * 3 + 1] = 0.05;
      this._sparkBase[i * 3 + 2] = oz;
      sPos[i * 3] = ox;
      sPos[i * 3 + 1] = 0.05;
      sPos[i * 3 + 2] = oz;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const speed = 1.6 + Math.random() * 3.8;
      this._sparkVel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      this._sparkVel[i * 3 + 1] = Math.cos(phi) * speed * 1.35 + 1.1;
      this._sparkVel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
    this.sparks = new THREE.Points(
      sGeo,
      new THREE.PointsMaterial({
        map: this.glow,
        color: 0xffc04d,
        size: 0.14,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    g.add(this.sparks);

    this.scene.add(g);
    this.groupA = g;
  }

  // ---- Phase B: machine -> crate -> container ship ----
  _initPhaseB() {
    const g = new THREE.Group();

    const machine = new THREE.Group();
    machine.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xd9dee5, metalness: 0.65, roughness: 0.3, transparent: true })
      )
    );
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 1.2, 20),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.55, roughness: 0.3, transparent: true })
    );
    drum.rotation.z = Math.PI / 2;
    drum.position.x = 0.9;
    machine.add(drum);
    this.machine = machine;
    g.add(machine);

    this.crate = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.3, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xb33b2e, metalness: 0.25, roughness: 0.6, transparent: true })
    );
    g.add(this.crate);

    const ship = new THREE.Group();
    ship.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(6, 0.8, 1.6),
        new THREE.MeshStandardMaterial({ color: 0x25303d, metalness: 0.45, roughness: 0.6, transparent: true })
      )
    );
    const colors = [0xb33b2e, 0x06b6d4, 0xf59e0b, 0x3c6e4f];
    for (let i = 0; i < 10; i++) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.6, 1.3),
        new THREE.MeshStandardMaterial({
          color: colors[i % colors.length],
          metalness: 0.25,
          roughness: 0.6,
          transparent: true,
        })
      );
      box.position.set(-2.4 + i * 0.55, 0.65 + (i % 2) * 0.62, 0);
      ship.add(box);
    }
    const deckGlow = this._sprite(0x06b6d4, 4.5, 0.4);
    deckGlow.position.set(0, 0.8, 0);
    ship.add(deckGlow);
    ship.position.set(0, -0.6, 0);
    this.ship = ship;
    g.add(ship);

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x08263a, metalness: 0.4, roughness: 0.15, transparent: true })
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -1.0;
    g.add(this.water);

    g.visible = false;
    this.scene.add(g);
    this.groupB = g;
  }

  // ---- Phase C: globe + trade route arcs ----
  _initPhaseC() {
    const g = new THREE.Group();

    this.globe = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_R, 48, 48),
      new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: 0.8, metalness: 0.1, transparent: true })
    );
    g.add(this.globe);

    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_R * 1.05, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0x06b6d4,
        transparent: true,
        opacity: 0.14,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    g.add(atmo);

    const halo = this._sprite(0x1e6fd0, GLOBE_R * 4.4, 0.45);
    g.add(halo);

    const origin = latLonToVec3(CHINA.lat, CHINA.lon, GLOBE_R);
    this.arcs = [];
    OFFICES.forEach((office) => {
      const target = latLonToVec3(office.lat, office.lon, GLOBE_R);
      const mid = origin.clone().add(target).multiplyScalar(0.5).normalize().multiplyScalar(GLOBE_R * 1.38);
      const curve = new THREE.QuadraticBezierCurve3(origin, mid, target);
      const geo = new THREE.TubeGeometry(curve, 64, 0.016, 6, false);
      const arc = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xffc04d, transparent: true, opacity: 0.95, fog: false })
      );
      geo.setDrawRange(0, 0);
      arc.userData.maxIndex = geo.index.count;
      arc.userData.marker = this._sprite(0xffc04d, 0.3, 0);
      arc.userData.marker.position.copy(target);
      g.add(arc, arc.userData.marker);
      this.arcs.push(arc);
    });

    this.originMarker = this._sprite(0xff8a3c, 0.45, 0.95);
    this.originMarker.position.copy(origin);
    g.add(this.originMarker);

    g.position.set(0, 0, -2);
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
    // Portrait screens need extra distance to keep the subject framed.
    this._zBoost = aspect >= 1 ? 1 : clamp(1 / Math.max(aspect, 0.4), 1, 2.1);
    this.renderer.setSize(w, h, false);
  }

  setProgress(p) {
    this.progress = clamp(p, 0, 3);
  }

  _fade(group, opacity) {
    group.traverse((o) => {
      if (o.material && o !== this.sparks && o !== this.embers) o.material.opacity = opacity;
    });
  }

  _updatePhaseA(t, time, dt) {
    const fade = 1 - smoothstep(t, 0.86, 1);
    this._fade(this.groupA, fade);

    const fall = smoothstep(t, 0.12, 0.26);
    const bob = REDUCED_MOTION ? 0 : Math.sin(time * 1.2) * 0.12 * (1 - fall);
    this.hammer.position.y = lerp(1.9 + bob, 0.5, fall);
    this.hammer.rotation.z = lerp(-0.22, 0, fall);

    const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 2.2) * 0.07;
    const heat = 0.55 + fall * 0.5;
    this.hearth.scale.setScalar(3.6 * pulse * heat);
    this.hearth.material.opacity = 0.75 * fade * heat;

    const ePos = this.embers.geometry.attributes.position;
    for (let i = 0; i < ePos.count; i++) {
      let y = ePos.array[i * 3 + 1] + this._emberSpeed[i] * dt;
      if (y > 3.2) {
        y = -0.4;
        const r = Math.random() * 1.5;
        const a = Math.random() * Math.PI * 2;
        ePos.array[i * 3] = Math.cos(a) * r;
        ePos.array[i * 3 + 2] = Math.sin(a) * r;
      }
      ePos.array[i * 3 + 1] = y;
    }
    ePos.needsUpdate = true;
    this.embers.material.opacity = 0.8 * fade;

    // Burst position is derived from scroll, so it scrubs cleanly in both directions.
    const burst = clamp((t - 0.26) / 0.5, 0, 1);
    const sPos = this.sparks.geometry.attributes.position;
    for (let i = 0; i < sPos.count; i++) {
      sPos.array[i * 3] = this._sparkBase[i * 3] + this._sparkVel[i * 3] * burst * 0.9;
      sPos.array[i * 3 + 1] =
        this._sparkBase[i * 3 + 1] + this._sparkVel[i * 3 + 1] * burst * 0.9 - 2.4 * burst * burst;
      sPos.array[i * 3 + 2] = this._sparkBase[i * 3 + 2] + this._sparkVel[i * 3 + 2] * burst * 0.9;
    }
    sPos.needsUpdate = true;
    this.sparks.material.opacity = burst > 0 ? (1 - burst) * fade : 0;

    this._shake = t > 0.24 && t < 0.4 ? (1 - burst) * 0.14 : 0;
  }

  _updatePhaseB(t, time) {
    this._shake = 0;
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
    this.ship.position.x = lerp(-4, 2.6, smoothstep(t, 0.58, 1));
    this.ship.position.y = -0.6 + (REDUCED_MOTION ? 0 : Math.sin(time * 1.1) * 0.05);
    this.ship.rotation.z = REDUCED_MOTION ? 0 : Math.sin(time * 0.9) * 0.02;
  }

  _updatePhaseC(t, time) {
    this._shake = 0;
    const fade = smoothstep(t, 0, 0.1);
    this.globe.material.opacity = fade;
    this.groupC.scale.setScalar(lerp(0.55, 1, smoothstep(t, 0, 0.32)));
    this.groupC.rotation.y = (REDUCED_MOTION ? 0 : time * 0.04) + t * 0.5;

    this.arcs.forEach((arc, i) => {
      const reveal = clamp((t - (0.22 + i * 0.07)) / 0.24, 0, 1);
      arc.geometry.setDrawRange(0, Math.floor(arc.userData.maxIndex * reveal));
      arc.material.opacity = fade;
      arc.userData.marker.material.opacity = reveal > 0.9 ? fade : 0;
    });

    const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 3) * 0.18;
    this.originMarker.scale.setScalar(0.45 * pulse);
    this.originMarker.material.opacity = fade;
  }

  _updateCamera(p, time) {
    if (p < 1) {
      this._camBase.set(2.4, 2.0, lerp(6.6, 5.8, p));
      this._camTarget.set(0, 1.0, 0);
    } else if (p < 2) {
      const t = p - 1;
      this._camBase.set(lerp(-0.6, 1.8, t), lerp(1.8, 1.3, t), lerp(5.4, 7.6, t));
      this._camTarget.set(lerp(0, 1.2, t), 0, 0);
    } else {
      const t = p - 2;
      this._camBase.set(0, lerp(1.0, 0.5, t), lerp(6.8, 9.4, t));
      this._camTarget.set(0, 0, -2);
    }

    // Scale distance from the target rather than the raw position, so framing survives portrait aspects.
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

    // Clamped so a backgrounded tab resuming doesn't teleport the ember field.
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.getElapsedTime();
    const p = this.progress;

    this._mouse.lerp(this._mouseTarget, REDUCED_MOTION ? 0 : 0.06);
    this.dust.rotation.y = time * 0.012;

    const phase = p < 1 ? 0 : p < 2 ? 1 : 2;
    this.groupA.visible = phase === 0;
    this.groupB.visible = phase === 1;
    this.groupC.visible = phase === 2;

    if (phase === 0) this._updatePhaseA(p, time, dt);
    else if (phase === 1) this._updatePhaseB(p - 1, time);
    else this._updatePhaseC(Math.min(p - 2, 1), time);

    this._updateCamera(p, time);
    this.renderer.render(this.scene, this.camera);
  }
}
