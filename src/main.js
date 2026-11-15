
import * as THREE from 'three';
import { ALL_OBJECTS, CATEGORIES, stepObject } from './catalog/index.js';
import { compileObject } from './compile.js';
import { HandTracks, predictPalm, twoHandPose, wrapAngle } from './hands.js';
import { GESTURE_COLORS, Overlay } from './overlay.js';
import { ParticleField } from './particles.js';
import { SnapDetector } from './snap.js';
import { HandTracker } from './tracker.js';

const PARTICLES = 200_000;
const CAMERA_Z = 5;
const FOV = 40;
const WORLD_H = 2 * CAMERA_Z * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const BASE_SCALE = 1.15;
const FORM_SECONDS = 1.1;
const DISSOLVE_SECONDS = 0.9;
const SWITCH_COOLDOWN_MS = 1200;
const INSPECT_RADIUS = 80;
const INSPECT_LINGER_MS = 700;
const DEFAULT_VIEW = [0.15, 0.4, 0];
const SPHERE_POINT = 0.011;
const MAX_POINT_PX = 5;
const EXPLODED_FIT = 1.5;
const HANDS_CLOSED = 2.4;
const HANDS_OPEN = 7.5;
const SETTLE_RATE = 4;
const HOLD_GESTURES = new Set(['open', 'relaxed', 'fist', 'pinch']);

const HAND_STYLES = ['off', 'subtle', 'full'];
const HAND_STYLE_KEY = 'snapsplode.handStyle';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const GUIDE = [
  { key: 'snap', icon: '🫰', name: 'Snap', text: 'Show the object, or make it vanish' },
  { key: 'fist', icon: '✊', name: 'Fist', text: 'Close it up; it follows your fist' },
  { key: 'open', icon: '🖐️', name: 'Open hand', text: 'It follows your hand; open wider to pull apart' },
  { key: 'both', icon: '🙌', name: 'Both hands', text: 'Hold it between them: spread to pull apart, twist to turn' },
  { key: 'point', icon: '👉', name: 'Point', text: 'Point at a part to read about it' },
  { key: 'peace', icon: '✌️', name: 'Peace', text: 'Next object' },
  { key: 'three', icon: '🤟', name: 'Three fingers', text: 'Previous object (pinky folded)' },
  { key: 'pinch', icon: '🤏', name: 'Pinch both hands', text: 'Stretch to zoom, move together to spin' },
];

// ---------- scene ----------

const renderer = new THREE.WebGLRenderer({
  canvas: $('scene'),
  alpha: true,
  antialias: false,
  powerPreference: 'high-performance',
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
camera.position.z = CAMERA_Z;

const field = new ParticleField(scene, PARTICLES);
const overlay = new Overlay($('overlay'));
const video = $('video');

const dpr = Math.min(1.5, window.devicePixelRatio || 1);

function resize() {
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  overlay.resize();
}

window.addEventListener('resize', resize);
resize();

// ---------- app state ----------

const app = {
  state: 'empty',
  object: ALL_OBJECTS.find((o) => o.id === 'airliner'),
  loaded: null,
  pendingObject: null,
  autoFormAt: 0,
  form: 0,
  formTarget: 0,
  dissolve: 1,
  dissolveTarget: 1,
  explode: 0,
  explodeTarget: 0,
  highlight: -1,
  highlightUntil: 0,
  pos: new THREE.Vector3(0.5, 0.1, 0),
  posTarget: new THREE.Vector3(0.5, 0.1, 0),
  userScale: 1,
  userRot: new THREE.Quaternion(),
  drift: 0,
  control: null,
  lastSwitch: 0,
  visibleFraction: 1,
  hasCamera: false,
  handStyle: loadHandStyle(),
};

function loadHandStyle() {
  try {
    const saved = localStorage.getItem(HAND_STYLE_KEY);
    return HAND_STYLES.includes(saved) ? saved : 'subtle';
  } catch {
    return 'subtle';
  }
}

function setHandStyle(style) {
  app.handStyle = style;

  try {
    localStorage.setItem(HAND_STYLE_KEY, style);
  } catch {
    // Private browsing: do not remember the setting.
  }

  for (const b of document.querySelectorAll('#hand-style button')) {
    b.setAttribute('aria-pressed', String(b.dataset.style === style));
  }
}

// Compiled objects are large, so only recently used objects stay in memory.
const cache = new Map();

function compiled(def) {
  if (!cache.has(def.id)) {
    cache.set(def.id, compileObject(def, PARTICLES));

    if (cache.size > 6) {
      cache.delete(cache.keys().next().value);
    }
  }

  return cache.get(def.id);
}

function loadNow(def) {
  app.loaded = compiled(def);
  field.setObject(app.loaded);
  app.userRot.setFromEuler(new THREE.Euler(...(def.view || DEFAULT_VIEW)));
  app.userScale = 1;
  app.highlight = -1;
}

// ---------- object controls ----------

function selectObject(def, { auto = false, announce = true } = {}) {
  if (!def || !ALL_OBJECTS.some((item) => item.id === def.id)) {
    return;
  }

  const hidden = app.state === 'empty';
  app.object = def;

  if (announce) {
    toast(
      hidden && app.hasCamera
        ? `${def.name} is ready · snap to show it`
        : `Next: ${def.name}`,
    );
  }

  renderPicker();
  renderInfo();

  app.explodeTarget = 0;
  app.autoFormAt = auto ? -1 : 0;

  if (hidden) {
    if (!app.hasCamera) {
      summon();
    }
    return;
  }

  app.state = 'sphere';
  app.formTarget = 0;
  app.pendingObject = def;
}

function summon(atHand) {
  if (app.state !== 'empty') return;

  if (app.loaded?.def.id !== app.object.id) {
    loadNow(app.object);
  }

  app.autoFormAt = -1;
  app.state = 'sphere';
  app.form = 0;
  app.formTarget = 0;
  app.dissolveTarget = 0;
  app.explode = app.explodeTarget = 0;
  app.userScale = 1;

  app.userRot.setFromEuler(
    new THREE.Euler(...(app.object.view || DEFAULT_VIEW)),
  );

  if (atHand) {
    app.posTarget.copy(atHand);
  }
}

function form() {
  if (app.state !== 'sphere' || app.pendingObject) return;

  app.state = 'formed';
  app.formTarget = 1;
  toast(`Assembling ${app.object.name}`);
}

function dissolve() {
  if (app.state === 'empty') return;

  app.state = 'empty';
  app.dissolveTarget = 1;
  app.explodeTarget = 0;
  app.pendingObject = null;

  toast('Dissolved');
}

function onSnap() {
  if (app.state === 'empty') {
    const h = view.hands[0];
    summon(h ? screenToWorld(h.screenPalm) : null);
    toast('Snap!');
  } else {
    dissolve();
  }

  flashGuide('snap');
}

const snap = new SnapDetector(onSnap);

// ---------- coordinates ----------

function normToScreen(p) {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const W = window.innerWidth;
  const H = window.innerHeight;

  const s = Math.max(W / vw, H / vh);
  const dw = vw * s;
  const dh = vh * s;

  return {
    x: (W - dw) / 2 + (1 - p.x) * dw,
    y: (H - dh) / 2 + p.y * dh,
  };
}

function screenToWorld(p) {
  const w = WORLD_H * camera.aspect;

  return new THREE.Vector3(
    (p.x / window.innerWidth - 0.5) * w,
    (0.5 - p.y / window.innerHeight) * WORLD_H,
    0,
  );
}

const tmp = new THREE.Vector3();

function projectPart(point, offset, explode) {
  tmp.set(
    point[0] + offset[0] * explode,
    point[1] + offset[1] * explode,
    point[2] + offset[2] * explode,
  );

  tmp.applyMatrix4(field.points.matrixWorld).project(camera);

  return {
    x: (tmp.x * 0.5 + 0.5) * window.innerWidth,
    y: (-tmp.y * 0.5 + 0.5) * window.innerHeight,
  };
}

// ---------- hands ----------

const tracks = new HandTracks(normToScreen);
const view = { hands: [] };

function onHands(raw, now) {
  tracks.update(raw, now);
  view.hands = tracks.hands;
}

function startControl(mode, hands, extra) {
  const keys = hands.map((h) => h.key).join(',');

  if (app.control?.mode === mode && app.control.keys === keys) {
    return app.control;
  }

  app.control = {
    mode,
    keys,
    ...extra(),
  };

  return app.control;
}

function handleGestures(now, dt) {
  view.hands = tracks.hands;

  const { hands } = view;

  for (const gesture of tracks.takeChanges()) {
    const step = { peace: 1, three: -1 }[gesture];

    if (step && now - app.lastSwitch > SWITCH_COOLDOWN_MS) {
      app.lastSwitch = now;
      switchObject(step);
      flashGuide(gesture);
    }
  }

  const holders =
    app.state === 'empty'
      ? []
      : hands.filter((h) => HOLD_GESTURES.has(h.gesture));

  if (
    holders.length === 2 &&
    app.state === 'formed' &&
    holders.every((h) => h.gesture === 'pinch')
  ) {
    const pose = twoHandPose(holders[0], holders[1], now);

    const c = startControl('zoom', holders, () => ({
      pose,
      scale: app.userScale,
      rot: app.userRot.clone(),
    }));

    app.userScale = clamp(
      (c.scale * pose.spreadPx) / c.pose.spreadPx,
      0.4,
      2.6,
    );

    const yaw =
      ((pose.mid.x - c.pose.mid.x) / window.innerWidth) *
      Math.PI *
      2.4;

    const pitch =
      ((pose.mid.y - c.pose.mid.y) / window.innerHeight) *
      Math.PI *
      1.6;

    app.userRot
      .copy(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(pitch, yaw, 0, 'YXZ'),
        ),
      )
      .multiply(c.rot);
  } else if (holders.length === 2) {
    const pose = twoHandPose(holders[0], holders[1], now);
    const mid = screenToWorld(pose.mid);

    const c = startControl('hold', holders, () => ({
      offset: app.posTarget.clone().sub(mid),
      angle: pose.angle,
      rot: app.userRot.clone(),
    }));

    c.offset.multiplyScalar(Math.exp(-dt * SETTLE_RATE));
    app.posTarget.copy(mid).add(c.offset);

    const twist = wrapAngle(pose.angle - c.angle);

    app.userRot
      .copy(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          -twist,
        ),
      )
      .multiply(c.rot);

    if (app.state === 'formed') {
      app.explodeTarget = clamp(
        (pose.spread - HANDS_CLOSED) / (HANDS_OPEN - HANDS_CLOSED),
        0,
        1,
      );
    }
  } else if (holders.length === 1) {
    const h = holders[0];
    const at = screenToWorld(predictPalm(h, now));

    const c = startControl('follow', holders, () => ({
      offset: app.posTarget.clone().sub(at),
    }));

    app.posTarget.copy(at).add(c.offset);

    if (app.state === 'formed') {
      if (h.gesture === 'fist') {
        app.explodeTarget = 0;
      } else if (h.gesture !== 'pinch') {
        app.explodeTarget = h.openness;
      }
    }
  } else {
    app.control = null;
  }

  // Pointing selects the nearest part on screen.
  const pointer = hands.find((h) => h.gesture === 'point');

  if (pointer && app.state === 'formed' && app.loaded) {
    let best = -1;
    let bestD = INSPECT_RADIUS;

    app.loaded.parts.forEach((part, i) => {
      for (const pt of part.pickPoints) {
        const s = projectPart(pt, part.offset, app.explode);
        const d = Math.hypot(
          s.x - pointer.screenIndex.x,
          s.y - pointer.screenIndex.y,
        );

        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    });

    if (best >= 0) {
      app.highlight = best;
      app.highlightUntil = now + INSPECT_LINGER_MS;
    }
  }

  if (now > app.highlightUntil) {
    app.highlight = -1;
  }
}

// ---------- object switching ----------

function switchObject(step) {
  const def = stepObject(app.object.id, step);

  const where =
    def.category !== app.object.category
      ? ` · ${def.category}`
      : '';

  const later =
    app.state === 'empty'
      ? ' · snap to show it'
      : '';

  toast(`${step > 0 ? 'Next' : 'Back'}: ${def.name}${where}${later}`);

  selectObject(def, {
    auto: true,
    announce: false,
  });
}

// ---------- ui ----------

let toastTimer;

function toast(msg) {
  const t = $('toast');

  t.textContent = msg;
  t.classList.add('show');

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    t.classList.remove('show');
  }, 1600);
}

let activeCategory = app.object.category;

function renderPicker() {
  activeCategory = app.object.category;
  renderTabs();
  renderChips();
}

function renderTabs() {
  $('tabs').replaceChildren(
    ...CATEGORIES.map((c) => {
      const b = document.createElement('button');

      b.textContent = `${c.id} · ${c.items.length}`;
      b.setAttribute('role', 'tab');
      b.setAttribute(
        'aria-selected',
        String(c.id === activeCategory),
      );

      b.onclick = () => {
        activeCategory = c.id;
        renderTabs();
        renderChips();
      };

      return b;
    }),
  );
}

function renderChips() {
  const cat = CATEGORIES.find((c) => c.id === activeCategory);

  $('chips').replaceChildren(
    ...cat.items.map((o) => {
      const b = document.createElement('button');

      b.textContent = o.name;
      b.setAttribute(
        'aria-pressed',
        String(o.id === app.object.id),
      );

      b.onclick = () => {
        selectObject(
          ALL_OBJECTS.find((x) => x.id === o.id),
          { auto: true },
        );
      };

      return b;
    }),
  );
}

function renderInfo() {
  $('obj-cat').textContent = app.object.category;
  $('obj-name').textContent = app.object.name;
  $('obj-blurb').textContent = app.object.blurb;
}

$('guide').replaceChildren(
  ...GUIDE.map((g) => {
    const li = document.createElement('li');
    li.dataset.key = g.key;

    const icon = document.createElement('span');
    icon.textContent = g.icon;
    icon.setAttribute('aria-hidden', 'true');

    const body = document.createElement('span');

    const name = document.createElement('b');
    name.textContent = g.name;

    const text = document.createElement('span');
    text.className = 'txt';
    text.textContent = g.text;

    body.append(name, text);
    li.append(icon, body);

    return li;
  }),
);

const guideItems = Object.fromEntries(
  [...$('guide').children].map((li) => [
    li.dataset.key,
    li,
  ]),
);

let flashKey = null;
let flashUntil = 0;

function flashGuide(k) {
  flashKey = k;
  flashUntil = performance.now() + 700;
}

$('panel-toggle').onclick = () => {
  const c = $('panel').classList.toggle('collapsed');

  $('panel-toggle').setAttribute(
    'aria-expanded',
    String(!c),
  );
};

const GESTURE_NAMES = {
  open: 'Open hand',
  relaxed: 'Relaxed hand',
  fist: 'Fist',
  peace: 'Peace',
  three: 'Three fingers',
  point: 'Pointing',
  pinch: 'Pinch',
  none: 'Detecting…',
};

function nextHint() {
  if (!app.hasCamera) {
    return app.state === 'empty'
      ? 'Pick an object below to view it'
      : '';
  }

  if (app.state === 'empty') {
    return snap.mode === 'mic'
      ? 'Snap your fingers to summon the particles'
      : 'Touch thumb to middle finger, then flick, to summon';
  }

  if (app.explode < 0.05 && app.explodeTarget < 0.05) {
    return 'Open your hand, or spread both hands, to pull it apart';
  }

  return '';
}

let frameCount = 0;
let fpsWindowStart = performance.now();
let fps = 60;
let slowSeconds = 0;

function updateUi(now) {
  $('state-pill').textContent = app.state;
  $('state-pill').dataset.state = app.state;

  const names = view.hands.map(
    (h) => GESTURE_NAMES[h.gesture],
  );

  $('gesture-now').textContent = names.length
    ? names.join(' + ')
    : 'No hand';

  $('gesture-now').style.color = view.hands[0]
    ? GESTURE_COLORS[view.hands[0].gesture]
    : '';

  const open = view.hands.length
    ? Math.max(...view.hands.map((h) => h.openness))
    : 0;

  $('open-val').textContent = `${Math.round(open * 100)}%`;
  $('open-bar').style.width = `${open * 100}%`;

  $('explode-val').textContent = `${Math.round(app.explode * 100)}%`;
  $('explode-bar').style.width = `${app.explode * 100}%`;

  const active = new Set(
    view.hands.map((h) => h.gesture),
  );

  if (active.has('relaxed')) active.add('open');
  if (app.control?.mode === 'hold') active.add('both');
  if (now < flashUntil) active.add(flashKey);

  for (const k in guideItems) {
    guideItems[k].classList.toggle('active', active.has(k));
  }

  $('hint').textContent = nextHint();

  const particles = Math.round(
    PARTICLES * app.visibleFraction,
  );

  const heard = now - snap.transients.lastHit < 300;

  const mic =
    snap.mode === 'mic'
      ? 'mic on'
      : 'mic off · flick to snap';

  $('stats').innerHTML =
    `<b>${fps}</b> fps · <b>${Math.round(particles / 1000)}k</b> particles<br>` +
    (
      app.hasCamera
        ? `hands <b>${tracker?.rate ?? 0}</b> fps · ${Math.round(tracker?.ms ?? 0)} ms ${tracker?.delegate ?? ''}<br>`
        : 'camera off<br>'
    ) +
    `zoom ${app.userScale.toFixed(2)}× · <span class="${heard ? 'heard' : ''}">${heard ? 'snap heard' : mic}</span>`;

  // Inspect card sits beside the highlighted part.
  const card = $('inspect');

  if (app.highlight >= 0 && app.loaded) {
    const part = app.loaded.parts[app.highlight];

    const s = projectPart(
      part.anchor,
      part.offset,
      app.explode,
    );

    $('inspect-name').textContent = part.name;
    $('inspect-note').textContent = part.note;

    card.style.setProperty('--swatch', part.color);
    card.hidden = false;

    card.style.left = `${clamp(s.x + 24, 12, window.innerWidth - 272)}px`;
    card.style.top = `${clamp(s.y - 40, 60, window.innerHeight - 220)}px`;
  } else {
    card.hidden = true;
  }
}

// ---------- frame loop ----------

let tracker = null;
let lastFrame = performance.now();

function step(a, target, rate) {
  return a + clamp(target - a, -rate, rate);
}

function frame(now) {
  requestAnimationFrame(frame);

  const dt = Math.min(
    0.1,
    (now - lastFrame) / 1000,
  );

  lastFrame = now;

  handleGestures(now, dt);
  snap.update(view.hands, now);

  if (app.pendingObject && app.form < 0.02) {
    loadNow(app.pendingObject);
    app.pendingObject = null;

    if (app.autoFormAt === -1) {
      app.autoFormAt = now + 500;
    }
  }

  if (
    app.autoFormAt === -1 &&
    app.state === 'sphere' &&
    !app.pendingObject
  ) {
    app.autoFormAt = now + 500;
  }

  if (app.autoFormAt > 0 && now > app.autoFormAt) {
    app.autoFormAt = 0;
    form();
  }

  app.form = step(
    app.form,
    app.formTarget,
    dt / FORM_SECONDS,
  );

  app.dissolve = step(
    app.dissolve,
    app.dissolveTarget,
    dt / DISSOLVE_SECONDS,
  );

  app.explode +=
    (app.explodeTarget - app.explode) *
    (1 - Math.exp(-dt * 9));

  app.pos.lerp(
    app.posTarget,
    1 - Math.exp(-dt * (app.control ? 45 : 16)),
  );

  const w = WORLD_H * camera.aspect;

  app.posTarget.x = clamp(
    app.posTarget.x,
    -w / 2,
    w / 2,
  );

  app.posTarget.y = clamp(
    app.posTarget.y,
    -WORLD_H / 2,
    WORLD_H / 2,
  );

  const fitted = Math.min(
    BASE_SCALE,
    EXPLODED_FIT / (app.loaded?.explodedRadius ?? 1),
  );

  const scale =
    app.userScale *
    THREE.MathUtils.lerp(
      BASE_SCALE,
      fitted,
      app.explode,
    );

  field.root.position.copy(app.pos);
  field.root.scale.setScalar(scale);

  const free = !app.control;

  app.drift += dt;

  const sway = free
    ? Math.sin(app.drift * 0.5) * 0.14
    : 0;

  field.points.quaternion
    .copy(app.userRot)
    .premultiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        sway,
      ),
    );

  const u = field.uniforms;

  u.uForm.value = app.form;
  u.uExplode.value = app.explode;
  u.uDissolve.value = app.dissolve;
  u.uTime.value = now / 1000;
  u.uHighlight.value = app.highlight;

  const worldWidth = THREE.MathUtils.lerp(
    SPHERE_POINT,
    app.loaded?.pointWorld ?? SPHERE_POINT,
    app.form,
  );

  const pixelsAtOrigin = clamp(
    (worldWidth * scale * renderer.domElement.height) / WORLD_H,
    2 * dpr,
    MAX_POINT_PX * dpr,
  );

  u.uPointSize.value =
    (pixelsAtOrigin * CAMERA_Z) /
    Math.sqrt(app.visibleFraction);

  field.globe.material.opacity =
    (1 - app.dissolve) *
    (0.1 + 0.08 * (1 - app.form));

  field.root.visible = app.dissolve < 1;

  renderer.render(scene, camera);
  field.root.updateMatrixWorld();

  overlay.begin();

  const holding = app.control
    ? app.control.keys.split(',').map(Number)
    : [];

  for (const h of view.hands) {
    overlay.hand(
      h.screenPoints,
      h.gesture,
      h.openness,
      holding.includes(h.key),
      app.handStyle,
    );
  }

  if (
    app.handStyle === 'full' &&
    app.control?.mode === 'hold' &&
    view.hands.length === 2
  ) {
    overlay.span(
      view.hands[0].screenPalm,
      view.hands[1].screenPalm,
      app.explodeTarget,
    );
  }

  if (app.loaded && app.state === 'formed') {
    const c = projectPart(
      [0, 0, 0],
      [0, 0, 0],
      0,
    );

    const labels = app.loaded.parts.map(
      (p, index) => ({
        ...projectPart(p.anchor, p.offset, app.explode),
        name: p.name,
        note: p.note,
        color: p.color,
        index,
      }),
    );

    const reach =
      (Math.max(
        ...labels.map((l) => Math.abs(l.x - c.x)),
      ) || 60) + 20;

    const panel = $('panel').classList.contains('collapsed')
      ? 16
      : 306;

    overlay.labels(
      labels,
      c,
      reach,
      app.explode,
      app.highlight,
      panel,
    );

    const rightOfObject =
      c.x +
      (window.innerHeight * scale) / WORLD_H * 0.9;

    overlay.title(
      app.object.name,
      app.object.blurb,
      rightOfObject,
      c.y - 30,
      app.form > 0.8
        ? 1 - clamp(app.explode * 6, 0, 1)
        : 0,
    );
  }

  updateUi(now);

  frameCount++;

  if (now - fpsWindowStart > 1000) {
    fps = Math.round(
      (frameCount * 1000) /
      (now - fpsWindowStart),
    );

    frameCount = 0;
    fpsWindowStart = now;

    slowSeconds =
      fps < 24 && !document.hidden
        ? slowSeconds + 1
        : 0;

    if (
      slowSeconds >= 3 &&
      app.visibleFraction > 0.4
    ) {
      app.visibleFraction = Math.max(
        0.4,
        app.visibleFraction - 0.2,
      );

      field.setVisibleFraction(app.visibleFraction);
      slowSeconds = 0;
    }
  }
}

// ---------- start ----------

async function start() {
  const btn = $('start-btn');
  const status = $('start-status');

  btn.disabled = true;

  const testVideo = import.meta.env.DEV
    ? new URLSearchParams(location.search).get('video')
    : null;

  try {
    status.textContent = 'Asking for camera…';

    if (testVideo) {
      video.src = testVideo;
      video.loop = true;
    } else {
      video.srcObject =
        await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
          audio: false,
        });
    }

    await video.play();
    app.hasCamera = true;
  } catch (err) {
    console.warn('Camera unavailable:', err);

    status.textContent =
      'No camera access, so hand control is off. You can still browse the objects.';

    await new Promise((r) => setTimeout(r, 1800));
  }

  if (app.hasCamera && !testVideo) {
    status.textContent = 'Asking for microphone…';

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });

      await snap.attachMic(stream);
    } catch (err) {
      console.warn(
        'Microphone unavailable, using the flick gesture instead:',
        err,
      );

      toast('No mic: touch thumb to middle finger, then flick');
    }
  }

  if (app.hasCamera) {
    status.textContent = 'Loading hand tracking…';

    tracker = new HandTracker(video, onHands);

    try {
      await tracker.start();
    } catch (err) {
      console.error(err);

      app.hasCamera = false;
      tracker = null;

      status.textContent =
        'Hand tracking could not start. You can still browse the objects.';

      await new Promise((r) => setTimeout(r, 1800));
    }
  }

  $('start').hidden = true;
}

// ---------- event listeners ----------

if (window.innerWidth < 900) {
  $('panel').classList.add('collapsed');

  $('panel-toggle').setAttribute(
    'aria-expanded',
    'false',
  );
}

$('start-btn').onclick = start;

for (const b of document.querySelectorAll('#hand-style button')) {
  b.onclick = () => setHandStyle(b.dataset.style);
}

window.addEventListener('keydown', (e) => {
  if (
    e.key.toLowerCase() !== 'h' ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    e.target.closest?.('input, textarea')
  ) {
    return;
  }

  const next =
    HAND_STYLES[
      (HAND_STYLES.indexOf(app.handStyle) + 1) %
      HAND_STYLES.length
    ];

  setHandStyle(next);
  toast(`Hand markers: ${next}`);
});

setHandStyle(app.handStyle);
renderPicker();
renderInfo();

requestAnimationFrame(frame);

// ---------- Gemini AI agent interface ----------

window.snapSplodeAgent = Object.freeze({

  // Return only real objects from the catalog.
  getObjects() {
    return ALL_OBJECTS.map(({ id, name, category }) => ({
      id,
      name,
      category,
    }));
  },

  // Return current scene information.
  getState() {
    return {
      objectId: app.object?.id,
      objectName: app.object?.name,
      category: app.object?.category,
      sceneState: app.state,
      exploded: app.explodeTarget,
    };
  },

  // Return the real components of the currently loaded object.
  getParts() {
    return (app.loaded?.parts || []).map((part) => ({
      name: part.name,
      description: part.note,
      color: part.color,
    }));
  },

  // Select an existing catalog object.
  selectObject(id) {
    const def = ALL_OBJECTS.find(
      (item) => item.id === id,
    );

    if (!def) {
      return {
        success: false,
        message: 'Object not found in the SnapSplode catalog.',
      };
    }

    selectObject(def, { auto: true });

    if (app.state === 'empty') {
      summon();
    }

    return {
      success: true,
      message: `${def.name} selected.`,
    };
  },

  // Move to the next catalog object.
  nextObject() {
    switchObject(1);

    if (app.state === 'empty') {
      summon();
    }

    return {
      success: true,
      message: `Selected ${app.object.name}.`,
    };
  },

  // Move to the previous catalog object.
  previousObject() {
    switchObject(-1);

    if (app.state === 'empty') {
      summon();
    }

    return {
      success: true,
      message: `Selected ${app.object.name}.`,
    };
  },

  // Pull the current object apart.
  explode() {
    if (app.state === 'empty') {
      summon();
    }

    if (app.state === 'sphere' && !app.pendingObject) {
      form();
    }

    if (app.state !== 'formed') {
      return {
        success: false,
        message: 'The object is not ready to explode yet.',
      };
    }

    app.explodeTarget = 1;

    return {
      success: true,
      message: `Exploding ${app.object.name}.`,
    };
  },

  // Bring the object together.
  assemble() {
    if (app.state === 'empty') {
      summon();
    }

    if (app.state === 'sphere' && !app.pendingObject) {
      form();
    }

    app.explodeTarget = 0;

    return {
      success: true,
      message: `Bringing ${app.object.name} together.`,
    };
  },

  // Make the current object disappear.
  disappear() {
    if (app.state === 'empty') {
      return {
        success: true,
        message: 'The scene is already empty.',
      };
    }

    dissolve();

    return {
      success: true,
      message: 'Object disappeared.',
    };
  },
});

// ---------- development debugging ----------

if (import.meta.env.DEV) {
  window.__ws = {
    app,
    view,
    tracks,
    snap,
    onSnap,
    onHands,
    selectObject,
    loadNow,
    renderer,
    scene,
    camera,
    ALL_OBJECTS,
    field,

    get tracker() {
      return tracker;
    },

    get fps() {
      return fps;
    },
  };
}

// =====================================
// Gemini AI Assistant Connection
// =====================================

const aiForm = document.getElementById('ai-form');
const aiInput = document.getElementById('ai-input');
const aiMessages = document.getElementById('ai-messages');
const aiSend = document.getElementById('ai-send');

function addAiMessage(message, role = 'assistant') {
  const element = document.createElement('div');

  element.className = `ai-message ${role}`;
  element.textContent = message;

  aiMessages.appendChild(element);
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

// Display the real components from the currently loaded 3D object.
function showObjectParts(agent) {
  const parts = agent.getParts();
  const state = agent.getState();

  if (!parts.length) {
    addAiMessage(
      'Component information is not available for this object yet.'
    );
    return;
  }

  const componentList = parts.map((part, index) => {
    return `${index + 1}. ${part.name}\nPurpose: ${part.description}`;
  });

  addAiMessage(
    `Components of ${state.objectName} (${parts.length} parts):\n\n` +
    componentList.join('\n\n')
  );
}

if (aiForm && aiInput && aiMessages && aiSend) {
  aiForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const message = aiInput.value.trim();

    if (!message) return;

    addAiMessage(message, 'user');

    aiInput.value = '';
    aiSend.disabled = true;
    aiSend.textContent = 'Thinking...';

    try {
      const agent = window.snapSplodeAgent;

      if (!agent) {
        throw new Error('SnapSplode controls are not ready.');
      }

      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          objects: agent.getObjects(),
          sceneState: agent.getState(),
          parts: agent.getParts(),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Gemini request failed.');
      }

      if (data.reply) {
        addAiMessage(data.reply);
      }

      const actionHandlers = {
        select_object: (args) => {
          const objectExists = agent.getObjects().some(
            (object) => object.id === args?.object_id
          );

          if (!objectExists) {
            return {
              success: false,
              message: 'That object is not available in the catalog.',
            };
          }

          return agent.selectObject(args.object_id);
        },

        next_object: () => agent.nextObject(),

        previous_object: () => agent.previousObject(),

        explode_object: () => agent.explode(),

        assemble_object: () => agent.assemble(),

        disappear_object: () => agent.disappear(),
      };

      for (const action of data.actions || []) {
        const handler = actionHandlers[action.name];

        if (!handler) continue;

        const result = handler(action.args || {});

        if (result?.message) {
          addAiMessage(result.message);
        }

        // Automatically show the components after successful expansion.
        if (
          action.name === 'explode_object' &&
          result?.success
        ) {
          showObjectParts(agent);
        }
      }

    } catch (error) {
      console.error('SnapSplode AI error:', error);

      addAiMessage(
        error.message || 'Unable to contact the AI assistant.'
      );

    } finally {
      aiSend.disabled = false;
      aiSend.textContent = 'Send';
      aiInput.focus();
    }
  });
}
