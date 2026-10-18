// Ode's hero stage: the album you're playing, in 3D. The cover is printed on a record sleeve; a vinyl record, with the
// cover as its label, slides out of it and spins at the song's mood. Behind it the hero's background flows in the
// album's colours, with faint rings pulsing out from the record on the beat.
//
// The stage tilts toward the pointer, the record slides further out under it and can be grabbed and scratched, and
// scrolling away slides the record home and turns the sleeve away. It only renders while the hero is on screen.
// app.js loads this module only when WebGL works and motion is welcome; otherwise the page keeps its CSS hero.

import * as THREE from "./vendor/three.module.min.js";

const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const SLEEVE = 2;        // world units, square
const DISC = 0.95;       // record radius
const OUT = 1.3;         // how far the record slides out while playing: far enough to show its label
// Seconds per turn: a real LP turns once every 1.8 s; calmer songs drift slower, intense ones faster.
const TURN = { calm: 2.6, steady: 1.8, lively: 1.4, intense: 1.1 };
const BEAT = { calm: 0.7, steady: 1, lively: 1.35, intense: 1.8 };

/** Concentric grooves for the record's roughness and bump: fine rings, with smoother bands between tracks. */
function groovesTexture() {
  const size = 1024, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), mid = size / 2;
  g.fillStyle = "#7a7a7a";
  g.fillRect(0, 0, size, size);
  const gaps = [0.52, 0.63, 0.74, 0.86];
  for (let r = mid * 0.36; r < mid * 0.985; r += 1.6) {
    const k = r / mid;
    const smooth = gaps.some((gap) => Math.abs(k - gap) < 0.012);
    const v = smooth ? 50 : 80 + Math.round(Math.random() * 46);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(mid, mid, r, 0, Math.PI * 2);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}

/** Vinyl's light: two soft opposite wedges across the grooves, clear of the label. It stays put while the record
    spins under it, as the light on a turntable does. */
function sheenTexture() {
  const size = 512, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), mid = size / 2;
  const cone = g.createConicGradient(-Math.PI / 2 + 0.6, mid, mid);
  for (const [at, a] of [[0, 0], [0.06, 0.55], [0.13, 0], [0.5, 0], [0.56, 0.38], [0.63, 0], [1, 0]]) cone.addColorStop(at, `rgba(255,255,255,${a})`);
  g.fillStyle = cone;
  g.beginPath();
  g.arc(mid, mid, mid, 0, Math.PI * 2);
  g.fill();
  // Fade toward the label and the rim.
  g.globalCompositeOperation = "destination-in";
  const ring = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  ring.addColorStop(0, "rgba(0,0,0,0)");
  ring.addColorStop(0.38, "rgba(0,0,0,0)");
  ring.addColorStop(0.5, "rgba(0,0,0,1)");
  ring.addColorStop(0.94, "rgba(0,0,0,1)");
  ring.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = ring;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A dark studio with soft boxes of light, for the record's and the sleeve's reflections. */
function studio(renderer) {
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x0c0c10);
  const panel = (w, h, pos, strength) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(strength, strength, strength), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  panel(7, 1.6, [0, 5, 3], 7);
  panel(1.6, 6, [-6, 0.5, 2.5], 3.5);
  panel(1.4, 5, [6, 1, -1], 2.2);
  panel(9, 1, [0, -4.5, 4], 1);
  // Behind the viewer: what a record facing you reflects, so its grooves catch a sweep of light.
  panel(1.4, 10, [2.2, 0.5, 9], 2.2);
  panel(6, 4, [-3, 2, 9], 0.3);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(room, 0.035).texture;
  pmrem.dispose();
  return env;
}

const BG_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.999, 1.0); }
`;
const BG_FRAGMENT = /* glsl */ `
  uniform float uTime, uAspect, uBeat, uFade;
  uniform vec3 uBase, uA, uB, uC;
  uniform vec2 uCenter;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    float t = uTime * 0.045;
    vec2 q = vec2(fbm(p * 1.3 + t), fbm(p * 1.3 - t + 3.7));
    float f = fbm(p * 1.1 + q * 1.7 + t * 0.5);
    vec3 col = mix(uBase, uA, smoothstep(0.28, 0.9, f));
    col = mix(col, uB, smoothstep(0.42, 0.95, q.x) * 0.7);
    col = mix(col, uC, smoothstep(0.55, 1.0, q.y) * 0.45);
    // Rings of sound from the record, pulsing on the beat.
    vec2 d = vec2((vUv.x - uCenter.x) * uAspect, vUv.y - uCenter.y);
    float r = length(d);
    float ring = pow(sin(r * 34.0 - uTime * uBeat * 2.4) * 0.5 + 0.5, 12.0);
    col += uA * ring * smoothstep(0.85, 0.12, r) * smoothstep(0.05, 0.2, r) * 0.22;
    // Colour gathers around the record and stays calm elsewhere, so the words keep the stage.
    col = mix(uBase, col, 0.28 + 0.72 * smoothstep(1.25, 0.15, r));
    float a = smoothstep(0.0, 0.35, vUv.y) * uFade;
    // Written as is (no blending) and premultiplied, as the canvas expects; converted to the output space first.
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * a, a);
  }
`;

export function createStage({ hero, art }) {
  const canvas = document.createElement("canvas");
  canvas.className = "stage";
  canvas.setAttribute("aria-hidden", "true");
  hero.prepend(canvas);

  const coarse = matchMedia("(pointer: coarse)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.75 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.environment = studio(renderer);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-3, 4, 6);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.12));

  // The background: a quad drawn straight to clip space, first and behind everything. It is an opaque material
  // (three draws transparent ones last, which would put it over the record) that writes its own alpha.
  const bgUniforms = {
    uTime: { value: 0 }, uAspect: { value: 1 }, uBeat: { value: 1 }, uFade: { value: 0 },
    uBase: { value: new THREE.Color() }, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() },
    uCenter: { value: new THREE.Vector2(0.7, 0.5) },
  };
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: bgUniforms, vertexShader: BG_VERTEX, fragmentShader: BG_FRAGMENT, depthTest: false, depthWrite: false }));
  bg.frustumCulled = false;
  bg.renderOrder = -1;
  scene.add(bg);

  // The sleeve: the cover on the front, a plain back, thin dark edges.
  const rig = new THREE.Group();
  const body = new THREE.Group();
  rig.add(body);
  scene.add(rig);
  const coverMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 });
  const backMat = new THREE.MeshStandardMaterial({ color: 0x1d1d22, roughness: 0.85 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.7 });
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(SLEEVE, SLEEVE, 0.05), [edgeMat, edgeMat, edgeMat, edgeMat, coverMat, backMat]);
  body.add(sleeve);

  // The record: glossy black vinyl with grooves, the cover as its label on both sides, a spindle hole.
  const rec = new THREE.Group();
  rec.position.z = -0.045;
  body.add(rec);
  const spin = new THREE.Group();
  rec.add(spin);
  const grooves = groovesTexture();
  const discGeo = new THREE.CylinderGeometry(DISC, DISC, 0.014, 180, 1);
  discGeo.rotateX(Math.PI / 2);
  const discMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0b0e, roughness: 0.55, roughnessMap: grooves, bumpMap: grooves, bumpScale: 0.35, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.6 });
  const disc = new THREE.Mesh(discGeo, discMat);
  spin.add(disc);
  const sheen = new THREE.Mesh(new THREE.CircleGeometry(DISC, 96), new THREE.MeshBasicMaterial({ map: sheenTexture(), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  sheen.position.z = 0.0079;
  rec.add(sheen);
  const labelMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x050506 });
  for (const side of [1, -1]) {
    const label = new THREE.Mesh(new THREE.CircleGeometry(0.33, 96), labelMat);
    label.position.z = side * 0.0074;
    if (side < 0) label.rotation.y = Math.PI;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.024, 32), holeMat);
    hole.position.z = side * 0.0078;
    if (side < 0) hole.rotation.y = Math.PI;
    spin.add(label, hole);
  }

  // State, eased every frame.
  const st = {
    playing: false, mood: "steady", out: 0, outTarget: 0, omega: 0, intro: 0,
    tiltX: 0, tiltY: 0, aimX: 0, aimY: 0, hover: false, grabbed: false, lastAngle: 0, grabVel: 0,
    cover: null, coverWanted: null, swapping: false, scroll: 0, visible: true, fade: 0,
  };
  const textureLoader = new THREE.TextureLoader();
  let currentTexture = null;

  const applyCover = (tex, palette) => {
    if (currentTexture && currentTexture !== tex) currentTexture.dispose();
    currentTexture = tex;
    coverMat.map = tex;
    labelMat.map = tex;
    coverMat.color.set(tex ? 0xffffff : palette?.a ?? "#5b4bd5");
    labelMat.color.set(tex ? 0xffffff : palette?.primary ?? "#c6bfff");
    coverMat.needsUpdate = labelMat.needsUpdate = true;
  };
  let lastPalette = null;

  // Layout: put the sleeve over the space above the live card, sized to it, whatever the screen.
  const size = { w: 1, h: 1, unit: 1 };
  const layout = () => {
    const c = canvas.getBoundingClientRect();
    if (!c.width || !c.height) return;
    renderer.setSize(c.width, c.height, false);
    camera.aspect = c.width / c.height;
    camera.updateProjectionMatrix();
    bgUniforms.uAspect.value = camera.aspect;
    const worldH = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    size.w = c.width;
    size.h = c.height;
    size.unit = worldH / c.height;
    const a = art.getBoundingClientRect();
    const card = art.querySelector(".tilt")?.getBoundingClientRect() ?? a;
    const free = Math.max(120, card.top - a.top + card.height * 0.3);
    const px = Math.min(free * 0.9, a.width * 0.66, 460);
    const cx = a.left + a.width / 2 - c.left, cy = a.top + free * 0.5 - c.top;
    size.cx = cx;
    size.cy = cy;
    size.scale = (px * size.unit) / SLEEVE;
    size.baseX = (cx - c.width / 2) * size.unit - 0.62 * size.scale;
    size.baseY = -(cy - c.height / 2) * size.unit;
    bgUniforms.uCenter.value.set((cx + 0.34 * px) / c.width, 1 - cy / c.height);
  };
  const ro = new ResizeObserver(layout);
  ro.observe(canvas);
  ro.observe(art);

  // Pointer: the stage leans toward it; over the record it can be grabbed and scratched.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const hit = (e) => {
    const c = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - c.left) / c.width) * 2 - 1, -((e.clientY - c.top) / c.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects([disc, sleeve], false)[0]?.object ?? null;
  };
  const discCenter = new THREE.Vector3();
  const angleAt = (e) => {
    spin.getWorldPosition(discCenter).project(camera);
    const c = canvas.getBoundingClientRect();
    const x = (discCenter.x * 0.5 + 0.5) * c.width + c.left, y = (-discCenter.y * 0.5 + 0.5) * c.height + c.top;
    return Math.atan2(-(e.clientY - y), e.clientX - x);
  };
  if (fine) {
    addEventListener("pointermove", (e) => {
      const a = art.getBoundingClientRect();
      st.aimX = clamp((e.clientX - (a.left + a.width / 2)) / (innerWidth / 2), -1, 1);
      st.aimY = clamp((e.clientY - (a.top + a.height / 2)) / (innerHeight / 2), -1, 1);
    }, { passive: true });
  }
  let lastMoveT = 0;
  canvas.addEventListener("pointermove", (e) => {
    if (st.grabbed) {
      const now = performance.now(), ang = angleAt(e);
      let d = ang - st.lastAngle;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      spin.rotation.z += d;
      st.grabVel = d / Math.max(0.008, (now - lastMoveT) / 1000);
      st.lastAngle = ang;
      lastMoveT = now;
      return;
    }
    const h = hit(e);
    st.hover = !!h;
    canvas.style.cursor = h === disc ? "grab" : "";
  });
  canvas.addEventListener("pointerleave", () => { if (!st.grabbed) { st.hover = false; canvas.style.cursor = ""; } });
  canvas.addEventListener("pointerdown", (e) => {
    if (hit(e) !== disc) return;
    st.grabbed = true;
    st.lastAngle = angleAt(e);
    lastMoveT = performance.now();
    st.grabVel = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  const release = (e) => {
    if (!st.grabbed) return;
    st.grabbed = false;
    st.omega = clamp(st.grabVel, -40, 40);
    canvas.style.cursor = "grab";
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  // Render only while the hero is on screen and the tab is visible.
  const io = new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; if (st.visible) kick(); });
  io.observe(hero);
  document.addEventListener("visibilitychange", () => !document.hidden && kick());

  // `?still` settles everything at once: a clean still frame, for screenshots.
  const still = new URLSearchParams(location.search).has("still");
  // Quality watch: if the first seconds run slowly, drop to a lower resolution; if it is still slow, hand back to the
  // CSS hero rather than stutter.
  const perf = { frames: 0, since: 0, stage: 0 };
  let raf = 0, last = 0, t = 0, firstFrame = true;
  const frame = (now) => {
    raf = 0;
    if (!st.visible || document.hidden) { last = 0; perf.since = 0; return; }
    const real = last ? Math.min(0.1, (now - last) / 1000) : 0;
    const dt = still ? 10 : real;
    last = now;
    t += real;
    if (!still) {
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
    }

    // Scroll: 0 with the hero in full view, 1 once it has scrolled away.
    const hr = hero.getBoundingClientRect();
    st.scroll = clamp(-hr.top / Math.max(1, hr.height * 0.9), 0, 1);

    st.intro = damp(st.intro, 1, 2.2, dt);
    st.fade = damp(st.fade, 1, 1.5, dt);

    // The record: home while a new cover is swapped in, out while playing, further under the pointer.
    // Idle, the record rests half out of its sleeve, still; playing, it slides out and spins.
    let want = st.playing ? OUT : 0.65;
    if (st.hover && fine) want += 0.14;
    if (st.swapping) want = 0;
    want *= 1 - st.scroll;
    st.out = damp(st.out, want * Math.min(1, st.intro * 1.4), st.swapping ? 7 : 3.2, dt);
    if (st.swapping && st.out < 0.03 && st.coverWanted) {
      applyCover(st.coverWanted.tex, lastPalette);
      st.coverWanted = null;
      st.swapping = false;
    }
    rec.position.x = st.out;

    // Spin: a motor at the mood's speed while playing; a grabbed record follows the hand, then coasts back.
    if (!st.grabbed) {
      const motor = st.playing ? (Math.PI * 2) / (TURN[st.mood] ?? 1.8) : 0;
      st.omega = damp(st.omega, -motor, st.playing ? 1.4 : 0.8, dt);
      spin.rotation.z += st.omega * real;
    }

    // Lean toward the pointer, float a little, and turn away as the page scrolls on.
    st.tiltX = damp(st.tiltX, st.aimY * 0.22, 4, dt);
    st.tiltY = damp(st.tiltY, st.aimX * 0.3, 4, dt);
    const s = (size.scale ?? 1) * (0.86 + 0.14 * st.intro) * (1 - 0.12 * st.scroll);
    rig.scale.setScalar(s);
    rig.position.set(size.baseX ?? 0, (size.baseY ?? 0) + Math.sin(t * 0.7) * 0.05 * s + st.scroll * 1.6, 0);
    body.rotation.set(0.08 + st.tiltX + st.scroll * 0.35, -0.24 + st.tiltY - (1 - st.intro) * 0.9 + st.scroll * 0.9, -0.03);

    bgUniforms.uTime.value = t;
    bgUniforms.uBeat.value = st.playing ? BEAT[st.mood] ?? 1 : 0.35;
    bgUniforms.uFade.value = st.fade;
    renderer.render(scene, camera);
    if (firstFrame) { firstFrame = false; canvas.classList.add("on"); }
    kick();
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; api.onLost?.(); });

  const api = {
    onLost: null,
    /** Song, palette and mood, whenever the page learns them. A new cover slides the record home, swaps, and back. */
    update({ cover, palette, mood, playing }) {
      lastPalette = palette;
      st.mood = mood in TURN ? mood : "steady";
      st.playing = !!playing;
      bgUniforms.uBase.value.set(palette.base);
      bgUniforms.uA.value.set(palette.a);
      bgUniforms.uB.value.set(palette.b);
      bgUniforms.uC.value.set(palette.c);
      backMat.color.set(palette.back);
      if (cover === st.cover) { if (!cover) applyCover(null, palette); return; }
      st.cover = cover;
      const swap = (tex) => {
        if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); }
        if (!currentTexture && !coverMat.map) { applyCover(tex, palette); return; }
        st.coverWanted = { tex };
        st.swapping = true;
      };
      if (!cover) swap(null);
      else textureLoader.load(cover, swap, undefined, () => swap(null));
    },
  };
  // With `?still`, the stage's state can be read from the console (for checking a still frame).
  if (still) window.__odeStage = { st, size, rig, camera, canvas };
  layout();
  kick();
  return api;
}
