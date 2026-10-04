import * as THREE from 'three';
import { createDialKit, createDialRoot } from 'dialkit/vanilla';
import 'dialkit/vanilla/styles.css';

// All sizes in the dials are "design units": 1000 = the short side of the viewport.
const MAX = 30000;
const SCENES = ['ring', 'shape', 'dots'];
const MASK_SCALE = 0.5; // shape mask resolution relative to CSS pixels
const TAU = Math.PI * 2;

// ?embed → no dials/hint, nothing persisted, pauses off-screen. ?embed&dials → dials back on.
const params = new URLSearchParams(location.search);
const EMBED = params.has('embed');
const DIALS = !EMBED || params.has('dials');
if (EMBED) document.documentElement.classList.add('embed');

// ─── renderer ────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.autoClear = false;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
const scene = new THREE.Scene();

// fullscreen quad used to fade the previous frame (trails)
const fadeMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color('#000') }, uOpacity: { value: 1 } },
  vertexShader: `void main(){ gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uOpacity;
    void main(){ gl_FragColor = vec4(uColor, uOpacity); }`,
  transparent: true, depthTest: false, depthWrite: false,
});
const fadeScene = new THREE.Scene();
fadeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMat));

const positions = new Float32Array(MAX * 3);
const seeds = new Float32Array(MAX * 2);
for (let i = 0; i < MAX * 2; i++) seeds[i] = Math.random();

const geo = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr);
geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 2));
geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

const pointMat = new THREE.ShaderMaterial({
  uniforms: {
    uSize: { value: 2 }, uPR: { value: renderer.getPixelRatio() }, uVar: { value: 0.5 },
    uTime: { value: 0 }, uTwinkle: { value: 0 }, uColor: { value: new THREE.Color('#fff') },
    uOpacity: { value: 1 }, uSoft: { value: 0.3 },
  },
  vertexShader: `
    attribute vec2 aSeed;
    uniform float uSize, uPR, uVar, uTime, uTwinkle;
    varying float vAlpha;
    void main(){
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
      float s = uSize * (1. + uVar * (aSeed.x * 2. - 1.) * .8);
      gl_PointSize = max(s, .5) * uPR;
      float tw = .5 + .5 * sin(uTime * (1.5 + aSeed.y * 3.) + aSeed.x * 40.);
      vAlpha = 1. - uTwinkle * tw;
    }`,
  fragmentShader: `
    uniform vec3 uColor; uniform float uOpacity, uSoft;
    varying float vAlpha;
    void main(){
      float d = length(gl_PointCoord - .5) * 2.;
      float a = 1. - smoothstep(1. - uSoft - .001, 1., d);
      if (a <= 0.) discard;
      gl_FragColor = vec4(uColor, a * uOpacity * vAlpha);
    }`,
  transparent: true, depthTest: false, depthWrite: false,
});
const points = new THREE.Points(geo, pointMat);
scene.add(points);

// ─── particle state ──────────────────────────────────────────────────────────

const px = new Float32Array(MAX), py = new Float32Array(MAX);
const vx = new Float32Array(MAX), vy = new Float32Array(MAX);
const cur = new Int8Array(MAX).fill(-1);   // scene the particle currently follows
const next = new Int8Array(MAX).fill(-1);  // scene it will switch to
const switchAt = new Float32Array(MAX);
// ring
const ringA = new Float32Array(MAX), ringR = new Float32Array(MAX), ringS = new Float32Array(MAX);
// shape (mask wander)
const tx = new Float32Array(MAX), ty = new Float32Array(MAX), head = new Float32Array(MAX);
// feather: fixed gaussian offset per particle (blurs the shape's density at its edges)
const fx = new Float32Array(MAX), fy = new Float32Array(MAX);
for (let i = 0; i < MAX; i++) {
  const m = Math.sqrt(-2 * Math.log(1 - Math.random())), a = Math.random() * TAU;
  fx[i] = Math.cos(a) * m; fy[i] = Math.sin(a) * m;
}
// dots
const dotI = new Uint8Array(MAX), dotA = new Float32Array(MAX), dotR = new Float32Array(MAX);

let W = innerWidth, H = innerHeight, U = Math.min(W, H) / 1000;
let count = 0, time = 0, sceneIdx = -1, sceneStart = 0;
let v = null; // current dial values

// ─── shape mask (text or image/SVG) ──────────────────────────────────────────

let mask = { w: 0, h: 0, data: new Uint8Array(0), filled: new Int32Array(0), n: 0 };
let maskToken = 0, maskKey = '';

function insideMask(x, y) {
  const mx = ((x + W / 2) * MASK_SCALE) | 0, my = ((H / 2 - y) * MASK_SCALE) | 0;
  if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) return false;
  return mask.data[my * mask.w + mx] === 1;
}

function sampleMask(out, k) {
  if (!mask.n) { // fallback while the mask is building: a small disc
    const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * 80 * U;
    out[k] = Math.cos(a) * r; out[k + 1] = Math.sin(a) * r; return;
  }
  const p = mask.filled[(Math.random() * mask.n) | 0];
  const mx = p % mask.w, my = (p / mask.w) | 0;
  out[k] = (mx + Math.random()) / MASK_SCALE - W / 2;
  out[k + 1] = H / 2 - (my + Math.random()) / MASK_SCALE;
}

const loadImage = (src) => new Promise((res, rej) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => res(img); img.onerror = rej; img.src = src;
});

async function rebuildMask() {
  const s = v.shape;
  const key = [W, H, s.source, v.number, s.font, s.weight, s.size, s.tracking, s.image, s.imageScale, s.threshold].join('|');
  if (key === maskKey || W < 2 || H < 2) return;
  maskKey = key;
  const tok = ++maskToken;

  const mw = Math.ceil(W * MASK_SCALE), mh = Math.ceil(H * MASK_SCALE);
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const k = U * MASK_SCALE;

  try {
    if (s.source === 'image' && s.image) {
      // Any image works here, including uploaded SVGs. Shape = opaque pixels.
      const img = await loadImage(s.image);
      const iw = img.naturalWidth || 512, ih = img.naturalHeight || 512;
      const box = 1000 * s.imageScale * k;
      const sc = Math.min(box / iw, box / ih);
      ctx.drawImage(img, (mw - iw * sc) / 2, (mh - ih * sc) / 2, iw * sc, ih * sc);
    } else {
      const font = `${s.weight} ${s.size * k}px "${s.font}"`;
      const text = String(v.number ?? '') || ' ';
      await document.fonts.load(font, text).catch(() => {});
      ctx.font = font;
      ctx.letterSpacing = `${s.tracking * k}px`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      const m = ctx.measureText(text);
      const y = mh / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
      ctx.fillText(text, mw / 2 + s.tracking * k / 2, y);
    }
  } catch (e) {
    console.warn('shape mask failed', e);
  }
  if (tok !== maskToken) return;

  const px8 = ctx.getImageData(0, 0, mw, mh).data;
  const data = new Uint8Array(mw * mh);
  const filled = [];
  const thr = s.threshold * 255;
  for (let i = 0; i < mw * mh; i++) {
    if (px8[i * 4 + 3] > thr) { data[i] = 1; filled.push(i); }
  }
  mask = { w: mw, h: mh, data, filled: Int32Array.from(filled), n: filled.length };

  // reseat shape particles that are now outside
  const tmp = [0, 0];
  for (let i = 0; i < count; i++) {
    if ((cur[i] === 1 || next[i] === 1) && !insideMask(tx[i], ty[i])) {
      sampleMask(tmp, 0); tx[i] = tmp[0]; ty[i] = tmp[1];
    }
  }
}

// ─── scene assignment ────────────────────────────────────────────────────────

function sortByKey(indices, keys) {
  return indices.sort((a, b) => keys[a] - keys[b]);
}

// Precompute each particle's slot in the incoming scene.
function assign(target) {
  const idx = Array.from({ length: count }, (_, i) => i);

  if (target === 1) {
    const samples = new Float32Array(count * 2);
    for (let k = 0; k < count; k++) sampleMask(samples, k * 2);
    if (v.motion.mapping === 'angular') {
      // particles at angle θ go to points at angle θ → coherent morph
      const pk = new Float32Array(count), sk = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pk[i] = Math.atan2(py[i], px[i]);
        sk[i] = Math.atan2(samples[i * 2 + 1], samples[i * 2]);
      }
      const pi = sortByKey(idx.slice(), pk), si = sortByKey(idx.slice(), sk);
      for (let k = 0; k < count; k++) {
        tx[pi[k]] = samples[si[k] * 2]; ty[pi[k]] = samples[si[k] * 2 + 1];
      }
    } else {
      for (let i = 0; i < count; i++) { tx[i] = samples[i * 2]; ty[i] = samples[i * 2 + 1]; }
    }
    for (let i = 0; i < count; i++) head[i] = Math.random() * TAU;
  }

  if (target === 2) {
    // split left→right into thirds so particles go to the nearest dot
    const order = v.motion.mapping === 'angular' ? sortByKey(idx, px) : idx;
    for (let k = 0; k < count; k++) {
      const i = order[k];
      dotI[i] = Math.min(2, Math.floor((k / count) * 3));
      dotA[i] = Math.random() * TAU;
      dotR[i] = Math.sqrt(Math.random());
    }
  }

  if (target === 0) {
    for (let i = 0; i < count; i++) {
      ringR[i] = Math.random() - 0.5;
      ringS[i] = Math.random() * 2 - 1;
    }
  }
}

// called the moment a particle actually switches
function enter(i, s) {
  if (s === 0) ringA[i] = Math.atan2(py[i], px[i]);
  const sc = v.motion.scatter * U;
  if (sc > 0) {
    const a = Math.random() * TAU, m = sc * (0.3 + Math.random() * 0.7);
    vx[i] += Math.cos(a) * m; vy[i] += Math.sin(a) * m;
  }
}

function goTo(s) {
  s = ((s % 3) + 3) % 3;
  if (s === sceneIdx) return;
  sceneIdx = s;
  sceneStart = time;
  assign(s);

  const { stagger, staggerMode } = v.motion;
  const maxD = Math.hypot(W, H) / 2;
  for (let i = 0; i < count; i++) {
    let f;
    if (staggerMode === 'sweep') f = (px[i] / W + 0.5) * 0.85 + Math.random() * 0.15;
    else if (staggerMode === 'radial') f = (Math.hypot(px[i], py[i]) / maxD) * 0.85 + Math.random() * 0.15;
    else f = Math.random();
    next[i] = s;
    switchAt[i] = time + Math.max(0, f) * stagger;
  }
  if (kit && v.scene !== SCENES[s]) kit.setValue('scene', SCENES[s]);
}

function setCount(n) {
  n = Math.min(MAX, Math.max(1, n | 0));
  for (let i = count; i < n; i++) {
    px[i] = (Math.random() - 0.5) * W; py[i] = (Math.random() - 0.5) * H;
    vx[i] = vy[i] = 0;
    cur[i] = -1; next[i] = sceneIdx; switchAt[i] = time + Math.random() * 0.5;
    // give newcomers a slot in the current scene
    ringR[i] = Math.random() - 0.5; ringS[i] = Math.random() * 2 - 1;
    const t = [0, 0]; sampleMask(t, 0); tx[i] = t[0]; ty[i] = t[1]; head[i] = Math.random() * TAU;
    dotI[i] = (Math.random() * 3) | 0; dotA[i] = Math.random() * TAU; dotR[i] = Math.sqrt(Math.random());
  }
  count = n;
  geo.setDrawRange(0, count);
}

// ─── simulation ──────────────────────────────────────────────────────────────

function step(dt) {
  const { ring, shape, dots, motion } = v;
  const k = motion.stiffness, damp = Math.exp(-motion.damping * dt);

  // dot animation (shared per dot)
  const dc = [], ds = [];
  for (let d = 0; d < 3; d++) {
    const ph = time * dots.speed * TAU - d * dots.stagger * TAU;
    const b = Math.max(0, Math.sin(ph));
    dc.push({ x: (d - 1) * dots.gap * U, y: Math.pow(b, 1.5) * dots.bounce * U });
    ds.push(1 + dots.pulse * b);
  }

  const R = ring.radius * U, T = ring.thickness * U;
  const flowStep = shape.flow * U * dt, turn = shape.turn * Math.sqrt(dt) * 2;
  const jit = shape.jitter * U;
  const feather = v.look.feather * U;

  for (let i = 0; i < count; i++) {
    if (cur[i] !== next[i] && time >= switchAt[i]) { cur[i] = next[i]; enter(i, cur[i]); }

    let gx = px[i], gy = py[i];
    const s = cur[i];

    if (s === 0) {
      ringA[i] += ring.speed * (1 + ringS[i] * ring.speedVariance) * dt;
      const r = R + T * (ringR[i] + ring.wobble * 0.5 * Math.sin(time * ring.wobbleSpeed + seeds[i * 2] * TAU * 4));
      gx = Math.cos(ringA[i]) * r; gy = Math.sin(ringA[i]) * r;
    } else if (s === 1) {
      if (flowStep > 0) {
        head[i] += (Math.random() - 0.5) * turn;
        const nx = tx[i] + Math.cos(head[i]) * flowStep, ny = ty[i] + Math.sin(head[i]) * flowStep;
        if (insideMask(nx, ny)) { tx[i] = nx; ty[i] = ny; } else head[i] += Math.PI * (0.5 + Math.random());
      }
      gx = tx[i]; gy = ty[i];
      if (jit > 0) {
        const sd = seeds[i * 2] * 50;
        gx += Math.sin(time * 7 + sd) * jit; gy += Math.cos(time * 6 + sd * 1.3) * jit;
      }
    } else if (s === 2) {
      const d = dotI[i], rr = dotR[i];
      dotA[i] += dots.swirl * dt / (0.25 + rr);
      const r = rr * dots.radius * U * ds[d];
      gx = dc[d].x + Math.cos(dotA[i]) * r; gy = dc[d].y + Math.sin(dotA[i]) * r;
    }

    if (s >= 0 && feather > 0) { gx += fx[i] * feather; gy += fy[i] * feather; }

    vx[i] = (vx[i] + (gx - px[i]) * k * dt) * damp;
    vy[i] = (vy[i] + (gy - py[i]) * k * dt) * damp;
    px[i] += vx[i] * dt; py[i] += vy[i] * dt;
    positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i];
  }
  posAttr.needsUpdate = true;
}

// ─── render loop ─────────────────────────────────────────────────────────────

// inside an iframe, pause while the iframe is scrolled out of view
// (hidden tabs already stop requestAnimationFrame on their own)
let onScreen = true;
if (window.self !== window.top) {
  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
  }).observe(document.documentElement);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!v || !onScreen) { last = now; return; }
  let dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  dt *= v.timeScale;

  const sub = 2;
  for (let s = 0; s < sub; s++) { time += dt / sub; step(dt / sub); }

  if (v.autoplay && time - sceneStart > v.hold + v.motion.stagger) goTo(sceneIdx + 1);

  pointMat.uniforms.uTime.value = time;
  const trails = v.look.trails;
  if (trails > 0) {
    fadeMat.uniforms.uOpacity.value = 1 - trails;
    renderer.render(fadeScene, camera);
  } else {
    renderer.setClearColor(v.look.background, 1);
    renderer.clear();
  }
  renderer.render(scene, camera);
}

function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  if (w === W && h === H && renderer.domElement.width) return;
  W = w; H = h; U = Math.min(W, H) / 1000;
  renderer.setSize(W, H);
  camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2;
  camera.updateProjectionMatrix();
  renderer.setClearColor(v ? v.look.background : '#000', 1);
  renderer.clear();
  if (v) rebuildMask();
}
new ResizeObserver(resize).observe(document.documentElement);
addEventListener('resize', resize);
W = H = 0;
resize();

// ─── dials ───────────────────────────────────────────────────────────────────

if (DIALS) createDialRoot();
let kit = null;
kit = createDialKit('Particles', {
  scene: { type: 'select', options: SCENES, default: 'ring' },
  number: { type: 'text', default: '3.2k', placeholder: 'number or text' },
  autoplay: true,
  hold: [4.6, 0.5, 12, 0.1],
  timeScale: [1, 0, 3, 0.05],
  prev: { type: 'action' },
  next: { type: 'action' },
  look: {
    count: [8500, 500, MAX, 500],
    size: [2.2, 0.5, 10, 0.1],
    sizeVariance: [0.75, 0, 1, 0.01],
    softness: [0.73, 0, 1, 0.01],
    opacity: [0.85, 0, 1, 0.01],
    twinkle: [0.37, 0, 1, 0.01],
    trails: [0.17, 0, 0.97, 0.01],
    feather: [0, 0, 150, 1],
    additive: true,
    color: '#ffffff',
    background: '#000000',
  },
  motion: {
    stiffness: [60, 2, 400, 1],
    damping: [9, 0.5, 60, 0.5],
    stagger: [1.25, 0, 3, 0.05],
    staggerMode: { type: 'select', options: ['sweep', 'radial', 'random'], default: 'sweep' },
    scatter: [960, 0, 2000, 10],
    mapping: { type: 'select', options: ['angular', 'random'], default: 'angular' },
  },
  ring: {
    radius: [310, 40, 490, 1],
    thickness: [110, 2, 400, 1],
    speed: [0.35, -3, 3, 0.01],
    speedVariance: [0.6, 0, 2, 0.01],
    wobble: [0.25, 0, 1.5, 0.01],
    wobbleSpeed: [1.2, 0, 6, 0.05],
  },
  shape: {
    source: { type: 'select', options: ['text', 'image'], default: 'text' },
    font: { type: 'select', options: ['Inter', 'Manrope', 'Space Grotesk', 'Helvetica Neue', 'system-ui'], default: 'Inter' },
    weight: [800, 100, 900, 100],
    size: [820, 100, 1400, 5],
    tracking: [-30, -150, 150, 1],
    image: { type: 'image', options: ['/mark.svg'] },
    imageScale: [0.75, 0.05, 1.5, 0.01],
    threshold: [0.5, 0.01, 0.99, 0.01],
    flow: [45, 0, 400, 1],
    turn: [3, 0, 25, 0.1],
    jitter: [0, 0, 12, 0.1],
  },
  dots: {
    radius: [84, 8, 220, 1],
    gap: [253, 20, 450, 1],
    bounce: [55, 0, 250, 1],
    pulse: [0.34, 0, 0.8, 0.01],
    speed: [0.7, 0.1, 4, 0.05],
    stagger: [0.25, 0, 0.5, 0.01],
    swirl: [0.25, -6, 6, 0.05],
  },
}, {
  id: 'particle-scenes',
  persist: !EMBED,
  onAction: (path) => {
    if (path === 'next') goTo(sceneIdx + 1);
    if (path === 'prev') goTo(sceneIdx - 1);
  },
});

kit.subscribe((vals) => {
  const first = !v;
  v = vals;
  const L = v.look;
  pointMat.uniforms.uSize.value = L.size;
  pointMat.uniforms.uVar.value = L.sizeVariance;
  pointMat.uniforms.uSoft.value = L.softness;
  pointMat.uniforms.uOpacity.value = L.opacity;
  pointMat.uniforms.uTwinkle.value = L.twinkle;
  pointMat.uniforms.uColor.value.set(L.color);
  pointMat.blending = L.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  pointMat.needsUpdate = true;
  fadeMat.uniforms.uColor.value.set(L.background);
  if (L.count !== count) setCount(L.count);
  rebuildMask();
  const want = SCENES.indexOf(v.scene);
  if (first || want !== sceneIdx) goTo(want < 0 ? 0 : want);
});

// ─── input ───────────────────────────────────────────────────────────────────

renderer.domElement.addEventListener('click', () => goTo(sceneIdx + 1));
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); goTo(sceneIdx + 1); }
  else if (e.key === 'ArrowLeft') goTo(sceneIdx - 1);
  else if (e.key >= '1' && e.key <= '3') goTo(+e.key - 1);
});

requestAnimationFrame(frame);
