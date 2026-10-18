// Ode's hero stage: a field you can play. Ridge lines in the album's colours run back to a horizon, like the pulsar
// plot on Joy Division's Unknown Pleasures, and breathe with the song's mood. The pointer presses into the surface;
// a tap sends a ripple across it and plays a soft note, pitched by where you tap, in a key taken from the album's
// colours. While music plays, the live card sends a ripple across the field on the beat.
//
// It only renders while the hero is on screen. app.js loads this module only when WebGL works and motion is
// welcome; otherwise the page keeps its CSS hero.

import * as THREE from "./vendor/three.module.min.js";

const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const ROWS = 64;           // ridge lines, near to far
const COLS = 220;          // points along each
const WIDTH = 22;          // world units across
const NEAR = 2.5, FAR = -16; // row depths
const RIPPLES = 8;
// Beats per second, and how fast the ridges drift, for each mood.
const BEAT = { calm: 0.75, steady: 1.0, lively: 1.3, intense: 1.65 };
const FLOW = { calm: 0.22, steady: 0.34, lively: 0.5, intense: 0.7 };

const HEIGHT_GLSL = /* glsl */ `
  uniform float uTime, uAmp, uPulse, uFlow, uCentre;
  uniform vec3 uPointer;              // x, z, strength
  uniform vec4 uRipples[${RIPPLES}];  // x, z, start time, strength
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float height(vec2 p) {
    // Peaks gather in a band, as in the pulsar plot (under the live card, clear of the words), and drift back.
    float env = exp(-pow((p.x - uCentre) / 4.0, 2.0));
    float t = uTime * uFlow;
    float n = noise(vec2(p.x * 1.3, p.y * 0.8 - t)) * 0.62 + noise(vec2(p.x * 3.1, p.y * 1.9 - t * 1.6)) * 0.38;
    float h = pow(n, 2.4) * env * uAmp * (1.0 + 0.32 * uPulse);
    // The pointer presses a soft dome into the surface.
    float d = distance(p, uPointer.xy);
    h += uPointer.z * 0.75 * exp(-d * d * 0.9);
    // Ripples: a ring rolling outward, fading as it goes.
    for (int i = 0; i < ${RIPPLES}; i++) {
      vec4 r = uRipples[i];
      float age = uTime - r.z;
      if (r.w <= 0.0 || age < 0.0 || age > 6.0) continue;
      float x = distance(p, r.xy) - age * 3.4;
      h += r.w * 0.55 * sin(x * 4.2) * exp(-x * x * 0.9) * exp(-age * 0.62);
    }
    return h;
  }
`;

const FIELD_VERTEX = /* glsl */ `
  attribute float aTop;    // 1 on the ridge line, 0 at the floor below it
  attribute float aRow;    // 0 near .. 1 far
  varying float vDown, vRow;
  ${HEIGHT_GLSL}
  void main() {
    float h = height(position.xz);
    vec3 p = vec3(position.x, aTop > 0.5 ? h : -1.4, position.z);
    // Distance below the ridge line, in world units: the line is the top few hundredths of each row's curtain.
    vDown = aTop > 0.5 ? 0.0 : h + 1.4;
    vRow = aRow;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FIELD_FRAGMENT = /* glsl */ `
  uniform vec3 uBase, uNear, uFar;
  uniform vec2 uRes;
  uniform float uCalmLeft, uFade;
  varying float vDown, vRow;
  void main() {
    float aa = fwidth(vDown) * 1.2;
    float line = 1.0 - smoothstep(0.028, 0.028 + aa, vDown);
    // Far rows dissolve into the horizon; the copy's side is kept quiet so the words read.
    float fade = (1.0 - smoothstep(0.55, 1.0, vRow)) * uFade;
    float sx = gl_FragCoord.x / uRes.x;
    fade *= mix(1.0, mix(0.12, 1.0, smoothstep(0.22, 0.6, sx)), uCalmLeft);
    vec3 lineColour = mix(uNear, uFar, smoothstep(0.0, 0.8, vRow));
    gl_FragColor = vec4(mix(uBase, lineColour, line * fade), 1.0);
    #include <colorspace_fragment>
  }
`;

const BG_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }
`;
const BG_FRAGMENT = /* glsl */ `
  uniform vec3 uBase, uGlow;
  uniform vec2 uGlowAt;
  uniform float uAspect, uFade;
  varying vec2 vUv;
  void main() {
    // A soft glow of the album's colour rising behind the horizon.
    vec2 d = vec2((vUv.x - uGlowAt.x) * uAspect, vUv.y - uGlowAt.y);
    float g = exp(-dot(d, d) * 2.6);
    gl_FragColor = vec4(mix(uBase, uGlow, g * 0.55 * uFade), 1.0);
    #include <colorspace_fragment>
  }
`;

/** One mesh for the whole field: each row is a curtain whose top edge is the ridge line and which hides the rows
    behind it, as in the plot. */
function fieldGeometry() {
  const verts = ROWS * (COLS + 1) * 2;
  const pos = new Float32Array(verts * 3), top = new Float32Array(verts), row = new Float32Array(verts);
  const index = [];
  let v = 0;
  for (let r = 0; r < ROWS; r++) {
    const k = r / (ROWS - 1);
    const z = NEAR + (FAR - NEAR) * k;
    const base = v;
    for (let c = 0; c <= COLS; c++) {
      const x = -WIDTH / 2 + (WIDTH * c) / COLS;
      for (const t of [1, 0]) {
        pos.set([x, 0, z], v * 3);
        top[v] = t;
        row[v] = k;
        v++;
      }
    }
    for (let c = 0; c < COLS; c++) {
      const a = base + c * 2, b = a + 1, cc = a + 2, d = a + 3;
      index.push(a, b, cc, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aTop", new THREE.BufferAttribute(top, 1));
  g.setAttribute("aRow", new THREE.BufferAttribute(row, 1));
  g.setIndex(index);
  return g;
}

/** Soft notes for taps: a key from the album's colour, a scale from the mood, a short bell-like voice with a little
    echo. Nothing sounds until someone taps, and the page can mute it. */
function instrument() {
  let ctx = null, out = null;
  const start = () => {
    if (ctx) return ctx;
    ctx = new AudioContext();
    out = ctx.createGain();
    out.gain.value = 0.9;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.28;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    out.connect(ctx.destination);
    out.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(ctx.destination);
    return ctx;
  };
  return {
    /** `at` 0..1 across the field picks the note; `root` is a semitone 0..11; `minor` picks the scale. */
    play(at, root, minor) {
      const c = start();
      if (c.state === "suspended") c.resume();
      const scale = minor ? [0, 3, 5, 7, 10, 12, 15, 17, 19, 22] : [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
      const step = scale[Math.round(clamp(at, 0, 1) * (scale.length - 1))];
      const freq = 196 * Math.pow(2, (root + step) / 12);
      const now = c.currentTime;
      const env = c.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.16, now + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0008, now + 1.6);
      const tone = c.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 2400;
      env.connect(tone).connect(out);
      for (const [type, mult, level] of [["sine", 1, 1], ["triangle", 2, 0.22], ["sine", 3.01, 0.08]]) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.value = freq * mult;
        g.gain.value = level;
        o.connect(g).connect(env);
        o.start(now);
        o.stop(now + 1.7);
      }
    },
  };
}

export function createStage({ hero, art }) {
  const canvas = document.createElement("canvas");
  canvas.className = "stage";
  canvas.setAttribute("aria-hidden", "true");
  hero.prepend(canvas);

  const coarse = matchMedia("(pointer: coarse)").matches;
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.75 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

  const shared = {
    uTime: { value: 0 }, uAmp: { value: 1.9 }, uPulse: { value: 0 }, uFlow: { value: 0.34 }, uCentre: { value: 0 },
    uPointer: { value: new THREE.Vector3(0, 0, 0) },
    uRipples: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0)) },
  };
  const fieldUniforms = {
    ...shared,
    uBase: { value: new THREE.Color() }, uNear: { value: new THREE.Color() }, uFar: { value: new THREE.Color() },
    uRes: { value: new THREE.Vector2(1, 1) }, uCalmLeft: { value: 1 }, uFade: { value: 0 },
  };
  const field = new THREE.Mesh(fieldGeometry(), new THREE.ShaderMaterial({ uniforms: fieldUniforms, vertexShader: FIELD_VERTEX, fragmentShader: FIELD_FRAGMENT, side: THREE.DoubleSide }));
  field.frustumCulled = false;
  scene.add(field);

  const bgUniforms = { uBase: fieldUniforms.uBase, uGlow: { value: new THREE.Color() }, uGlowAt: { value: new THREE.Vector2(0.7, 0.55) }, uAspect: { value: 1 }, uFade: fieldUniforms.uFade };
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: bgUniforms, vertexShader: BG_VERTEX, fragmentShader: BG_FRAGMENT, depthTest: false, depthWrite: false }));
  bg.frustumCulled = false;
  bg.renderOrder = -1;
  scene.add(bg);

  const st = {
    playing: false, mood: "steady", root: 0, minor: false, sound: true,
    pointer: new THREE.Vector2(), pointerOn: 0, pointerWant: 0, scroll: 0, visible: true,
    nextBeatRipple: 0, beatPhase: 0,
  };
  const sound = instrument();

  // Layout: the canvas spans the hero; the glow sits behind the live card.
  const layout = () => {
    const c = canvas.getBoundingClientRect();
    if (!c.width || !c.height) return;
    renderer.setSize(c.width, c.height, false);
    camera.aspect = c.width / c.height;
    camera.updateProjectionMatrix();
    bgUniforms.uAspect.value = camera.aspect;
    fieldUniforms.uRes.value.set(c.width * renderer.getPixelRatio(), c.height * renderer.getPixelRatio());
    // Side by side, the words are on the left; stacked (phones), they are above and the field sits below them.
    fieldUniforms.uCalmLeft.value = c.width > 960 ? 1 : 0;
    const a = art.getBoundingClientRect();
    bgUniforms.uGlowAt.value.set((a.left + a.width / 2 - c.left) / c.width, 1 - (a.top + a.height * 0.35 - c.top) / c.height);
    // The peaks' band runs back from under the card (side by side) or down the middle (stacked).
    camera.position.set(0, 2.4, 7.6);
    camera.lookAt(0, 0.2, -4);
    camera.updateMatrixWorld();
    const under = c.width > 960 ? toField(a.left + a.width / 2, a.bottom + 40) : null;
    shared.uCentre.value = under ? clamp(under.x, -6, 6) : 0;
  };
  const ro = new ResizeObserver(layout);
  ro.observe(canvas);

  // Pointer to the field's surface (the y = 0 plane).
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  const toField = (clientX, clientY) => {
    const c = canvas.getBoundingClientRect();
    ndc.set(((clientX - c.left) / c.width) * 2 - 1, -((clientY - c.top) / c.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const p = raycaster.ray.intersectPlane(plane, hitPoint);
    return p && p.z < NEAR + 2 && p.z > FAR ? p : null;
  };
  let rippleSlot = 0;
  const ripple = (x, z, strength) => {
    shared.uRipples.value[rippleSlot].set(x, z, shared.uTime.value, strength);
    rippleSlot = (rippleSlot + 1) % RIPPLES;
  };

  if (fine) {
    hero.addEventListener("pointermove", (e) => {
      const p = toField(e.clientX, e.clientY);
      if (p) { st.pointer.set(p.x, p.z); st.pointerWant = 1; } else st.pointerWant = 0;
    });
    hero.addEventListener("pointerleave", () => (st.pointerWant = 0));
  }
  // A tap on the field (not on a link, a button or the card) ripples it and plays a note.
  canvas.addEventListener("pointerdown", (e) => {
    const p = toField(e.clientX, e.clientY);
    if (!p) return;
    ripple(p.x, p.z, 1.1);
    if (st.sound) sound.play((p.x + WIDTH / 2) / WIDTH, st.root, st.minor);
    api.onTap?.();
  });

  // Render only while the hero is on screen and the tab is visible.
  const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; if (st.visible) kick(); });
  io.observe(hero);
  document.addEventListener("visibilitychange", () => !document.hidden && kick());

  // Quality watch: if the first seconds run slowly, drop to a lower resolution; if it is still slow, hand back to the
  // CSS hero rather than stutter.
  const perf = { frames: 0, since: 0, stage: 0 };
  // `?3d` forces the field on (as app.js does on a software renderer), so it keeps it whatever the frame rate.
  if (new URLSearchParams(location.search).has("3d")) perf.stage = 2;
  let raf = 0, last = 0, t = 0, firstFrame = true;
  const frame = (now) => {
    raf = 0;
    if (!st.visible || document.hidden) { last = 0; perf.since = 0; return; }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    t += dt;
    if (!perf.since) perf.since = now;
    perf.frames++;
    if (now - perf.since > 2500 && perf.stage < 2) {
      const fps = (perf.frames * 1000) / (now - perf.since);
      if (fps < (perf.stage ? 14 : 24)) {
        if (perf.stage === 0) { renderer.setPixelRatio(1); layout(); perf.stage = 1; }
        else { perf.stage = 2; ro.disconnect(); io.disconnect(); renderer.dispose(); api.onLost?.(); return; }
      } else perf.stage = 2;
      perf.frames = 0;
      perf.since = now;
    }

    const hr = hero.getBoundingClientRect();
    st.scroll = clamp(-hr.top / Math.max(1, hr.height * 0.9), 0, 1);

    // The beat: a kick that decays, faster for livelier songs. While playing, the card sends a ripple across the
    // field every bar.
    const beat = BEAT[st.mood] ?? 1;
    st.beatPhase += dt * beat * (st.playing ? 1 : 0.4);
    const thump = Math.pow(1 - (st.beatPhase % 1), 3);
    shared.uPulse.value = st.playing ? thump : thump * 0.3;
    shared.uFlow.value = damp(shared.uFlow.value, (FLOW[st.mood] ?? 0.34) * (st.playing ? 1 : 0.6), 1, dt);
    shared.uAmp.value = damp(shared.uAmp.value, (st.playing ? 2.0 : 1.5) * (1 - 0.6 * st.scroll), 2, dt);
    if (st.playing && t >= st.nextBeatRipple) {
      const card = art.querySelector(".tilt")?.getBoundingClientRect();
      const p = card && toField(card.left + card.width * 0.2, card.bottom);
      if (p) ripple(p.x, p.z, 0.55);
      st.nextBeatRipple = t + 4 / beat;
    }

    st.pointerOn = damp(st.pointerOn, st.pointerWant, 5, dt);
    shared.uPointer.value.set(st.pointer.x, st.pointer.y, st.pointerOn);
    shared.uTime.value = t;
    fieldUniforms.uFade.value = damp(fieldUniforms.uFade.value, 1, 1.4, dt);

    // The camera: low over the field, rising and looking down a little as the page scrolls on, with a slow drift.
    camera.position.set(Math.sin(t * 0.07) * 0.6, 2.4 + st.scroll * 2.4, 7.6 - st.scroll * 1.5);
    camera.lookAt(0, 0.2 - st.scroll * 1.2, -4);

    renderer.render(scene, camera);
    if (firstFrame) { firstFrame = false; canvas.classList.add("on"); }
    request();
  };
  const request = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const kick = request;

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; api.onLost?.(); });

  const api = {
    onLost: null,
    onTap: null,
    /** Palette, mood and whether music is playing, whenever the page learns them. */
    update({ palette, mood, playing, hue }) {
      st.mood = mood in BEAT ? mood : "steady";
      st.playing = !!playing;
      // Every album plays in its own key: its colour's hue picks the root; calm moods are major, livelier minor.
      st.root = Math.round(((hue ?? 0) / 360) * 12) % 12;
      st.minor = st.mood === "intense" || st.mood === "lively";
      fieldUniforms.uBase.value.set(palette.base);
      fieldUniforms.uNear.value.set(palette.near);
      fieldUniforms.uFar.value.set(palette.far);
      bgUniforms.uGlow.value.set(palette.glow);
    },
    setSound(on) { st.sound = !!on; },
  };
  layout();
  request();
  return api;
}
