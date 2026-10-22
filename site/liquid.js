// Liquid particles for the hero card. The live card is rebuilt from tens of thousands of GPU-simulated particles
// sampled from its own pixels: the pointer turns it liquid, and it settles back into the crisp card.
//
// The engine is a plain-JavaScript port of the WebGL2 GPGPU engine in "Sculpture Hero" by Guglielmo Giannattasio
// (guglielmogiannattasio.it), published on 21st.dev. Changes for Ode: it takes any canvas as its image (the card's SVG
// is rasterised at full resolution first), reports when it starts and stops moving (so the page can show the live,
// animated card whenever it is still), keeps the card's own motion going while it is liquid (the page hands it the
// live card to copy each frame), and drops the React wrapper.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ── shaders (unchanged from the original) ───────────────────────────── */

const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x), u.y); }
vec2 ambientField(vec2 uv, float t){
  vec2 q = uv*vec2(3.2,1.7);
  vec2 a = vec2(vnoise(q+vec2(t*0.11,0.0))-0.5, vnoise(q+vec2(5.2,t*0.08)+3.1)-0.5);
  vec2 q2 = uv*vec2(7.5,4.0) + vec2(-t*0.19, t*0.13);
  vec2 b = vec2(vnoise(q2+1.7)-0.5, vnoise(q2+9.3)-0.5);
  return a + b*0.45;
}
`;

const ENERGY = `
float energyAt(vec2 rectPx, vec2 mouse, float radius, float presence, float wakeEnergy){
  vec2 d = rectPx - mouse;
  float f = exp(-dot(d,d)/(radius*radius))*presence;
  return smoothstep(0.06, 0.5, f*1.15 + wakeEnergy*1.7);
}
`;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }
`;

const FLOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform vec2 uMouse;
uniform vec2 uVel;
uniform vec2 uSize;
uniform float uRadius;
uniform float uPresence;
uniform float uDecay;
vec2 decV(vec4 c){ return (c.rg*255.0-128.0)/127.0; }
void main(){
  vec2 v0 = decV(texture(uPrev, vUv));
  vec2 uv = vUv - v0*uTexel*2.5;
  vec4 c = texture(uPrev, uv)*0.52
    + 0.12*(texture(uPrev, uv+vec2(uTexel.x,0.0)) + texture(uPrev, uv-vec2(uTexel.x,0.0))
          + texture(uPrev, uv+vec2(0.0,uTexel.y)) + texture(uPrev, uv-vec2(0.0,uTexel.y)));
  vec2 v = decV(c);
  float p = c.b;
  vec2 d = (vUv-uMouse)*uSize;
  float f = exp(-dot(d,d)/(uRadius*uRadius))*uPresence;
  float sp = clamp(length(uVel)*2.5, 0.0, 1.0);
  v += uVel*f*0.22;
  p = max(p, f*sp);
  v *= uDecay;
  p *= uDecay;
  v = sign(v)*max(abs(v)-1.2/127.0, 0.0);
  p = max(p-1.2/255.0, 0.0);
  v = clamp(v, -1.0, 1.0);
  o = vec4((v*127.0+128.0)/255.0, p, 1.0);
}
`;

const SIM_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform sampler2D uFlow;
uniform vec2 uSize;
uniform vec2 uMouse;
uniform float uRadius;
uniform float uPresence;
uniform float uStrength;
uniform float uSpread;
uniform float uTurb;
uniform float uReturn;
uniform float uTime;
uniform float uDt;
uniform float uIntro;
uniform float uBlast;
${NOISE}
vec2 curl(vec2 p){
  const float e = 0.35;
  float a = vnoise(p+vec2(0.0,e)) - vnoise(p-vec2(0.0,e));
  float b = vnoise(p+vec2(e,0.0)) - vnoise(p-vec2(e,0.0));
  return vec2(a, -b)/(2.0*e);
}
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 hm = texelFetch(uHome, ij, 0);
  if(hm.w <= 0.0){ o = vec4(0.0); return; }
  vec4 st = texelFetch(uState, ij, 0);
  vec2 off = st.xy;
  vec2 vel = st.zw;
  float sd = hm.z;
  float light = 0.45 + sd*1.1;

  vec2 p = hm.xy*uSize + off;
  vec4 fl = texture(uFlow, clamp(p/uSize, 0.0, 1.0));
  vec2 wake = (fl.rg*255.0-128.0)/127.0;
  float pr = fl.b;

  vec2 toM = p - uMouse;
  float r2 = dot(toM,toM);
  float f = exp(-r2/(uRadius*uRadius))*uPresence;
  vec2 n = toM*inversesqrt(r2+1.0);
  float e = clamp(pr*2.0 + f, 0.0, 1.0);

  vec2 acc = vec2(0.0);
  acc += n*f*1.25*uStrength*uSpread*light;
  acc += vec2(-n.y, n.x)*f*1.45*uStrength*uSpread*(0.4+sd);
  acc += (wake*42.0*uSpread*light - vel)*e*0.08;
  // Dissolving: every particle is pushed away from the card's centre (more for the lighter ones), on top of the swirl.
  vec2 away = p - uSize*0.5;
  acc += away*inversesqrt(dot(away,away)+1.0)*uBlast*(0.5 + sd*0.9)*0.55;
  vec2 q = p*0.0095 + vec2(uTime*0.35, -uTime*0.2);
  vec2 c = curl(q) + 0.5*curl(q*2.3 + 7.1);
  acc += c*(e*1.2*uSpread + uIntro*1.5)*uTurb*light;
  float k = (0.006 + 0.02*uReturn)*(0.65+sd*0.7)*(1.0 - uIntro*0.75);
  acc -= off*k;

  vel += acc*uDt;
  vel *= pow(mix(0.93, 0.955, e), uDt);
  off += vel*uDt;
  if(dot(off,off) < 0.0004 && dot(vel,vel) < 0.0004){ off = vec2(0.0); vel = vec2(0.0); }
  o = vec4(off, vel);
}
`;

const PART_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
uniform sampler2D uState;
uniform sampler2D uHome;
uniform sampler2D uCol;
uniform sampler2D uFlow;
uniform sampler2D uImg;
uniform float uLive;
uniform float uFade;
uniform int uTexW;
uniform vec4 uRect;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uRadius;
uniform float uPresence;
uniform float uDot;
uniform float uTime;
uniform float uAmbient;
uniform float uStreak;
uniform float uIntroVis;
uniform float uRest;
uniform vec3 uTint;
out vec2 vLocal;
out float vHalfLen;
out float vR;
out vec3 vCol;
out float vA;
${NOISE}
${ENERGY}
void main(){
  int id = gl_InstanceID;
  ivec2 ij = ivec2(id % uTexW, id / uTexW);
  vec4 hm = texelFetch(uHome, ij, 0);
  vec4 st = texelFetch(uState, ij, 0);
  vec4 cl = texelFetch(uCol, ij, 0);

  float wakeE = texture(uFlow, hm.xy).b;
  float E = energyAt(hm.xy*uRect.zw, uMouse, uRadius, uPresence, wakeE);
  float lift = smoothstep(0.35, 2.5, length(st.xy));
  // The particles fade out only at the very end of a settle, once the picture under them is nearly all the way in. Fading them in
  // step with the picture's arrival thinned the card for a moment (two layers at half strength cover only three quarters).
  float restA = smoothstep(0.0, 0.15, uRest);
  float a = max(max(E, lift), max(restA, 1.0-uIntroVis));
  if(a < 0.01 || hm.w <= 0.0){ gl_Position = vec4(2.0,2.0,2.0,1.0); return; }

  vec2 base = uRect.xy + hm.xy*uRect.zw + st.xy;
  base -= ambientField(hm.xy, uTime)*10.0*uAmbient;

  vec2 v = st.zw;
  float sp = length(v);
  vec2 dir = sp > 0.001 ? v/sp : vec2(1.0,0.0);
  float r = uDot*hm.w*0.5;
  float len = min(sp*1.25, 18.0)*uStreak;
  vec2 lc = aCorner*vec2(r + len*0.5 + 1.0, r + 1.0);
  vec2 center = base - dir*len*0.5;
  vec2 world = center + dir*lc.x + vec2(-dir.y, dir.x)*lc.y;

  vec2 clip = world/uRes*2.0-1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vLocal = lc;
  vHalfLen = len*0.5;
  vR = r;
  // Near its place a particle takes the colour of the live card (so the wave, the equaliser and the cover keep moving
  // through the liquid); once it has flown off it keeps the colour it left with.
  vec3 live = textureLod(uImg, hm.xy, 0.0).rgb;
  vec3 col = mix(cl.rgb, live, uLive*(1.0 - smoothstep(0.4, 5.0, length(st.xy))))*uTint;
  float glint = smoothstep(2.0, 16.0, sp);
  col = mix(col, min(col*1.18 + vec3(0.07,0.075,0.085), vec3(1.0)), glint*0.75);
  vCol = col;
  vA = a*uFade;
}
`;

const PART_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vHalfLen;
in float vR;
in vec3 vCol;
in float vA;
uniform float uDpr;
out vec4 o;
void main(){
  vec2 q = vec2(max(abs(vLocal.x)-vHalfLen, 0.0), vLocal.y);
  float d = length(q) - vR;
  float a = clamp(0.5 - d*uDpr, 0.0, 1.0);
  float tail = vHalfLen > 0.0 ? clamp(0.5 - vLocal.x/(2.0*(vHalfLen+vR)), 0.0, 1.0) : 0.0;
  a *= 1.0 - tail*0.55;
  a *= vA;
  if(a < 0.004) discard;
  o = vec4(vCol*a, a);
}
`;

const IMAGE_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uImg;
uniform sampler2D uFlow;
uniform vec2 uRes;
uniform float uDpr;
uniform vec4 uRect;
uniform vec3 uBg;
uniform vec3 uImgBg;
uniform vec2 uMouse;
uniform float uPresence;
uniform float uRadius;
uniform float uStrength;
uniform float uTime;
uniform float uAmbient;
uniform float uIntroVis;
uniform float uRest;
uniform float uAlphaMode;
${NOISE}
${ENERGY}
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y*uDpr - gl_FragCoord.y)/uDpr;
  vec2 size = uRect.zw;
  vec2 uv = (px-uRect.xy)/size;
  if(uv.x < -0.05 || uv.x > 1.05 || uv.y < -0.12 || uv.y > 1.12){ o = vec4(0.0); return; }
  vec4 fl = texture(uFlow, clamp(uv,0.0,1.0));
  vec2 vel = (fl.rg*255.0-128.0)/127.0;
  vec2 rp = uv*size;
  vec2 toM = rp - uMouse;
  float fall = exp(-dot(toM,toM)/(uRadius*uRadius))*uPresence;
  vec2 disp = -toM*0.22*uStrength*fall - vel*10.0*uStrength;
  disp += ambientField(uv, uTime)*10.0*uAmbient;
  vec2 suv = uv + disp/size;
  vec4 tx = texture(uImg, suv);
  vec3 col = tx.rgb;
  // The card's edges fade over a few pixels while the picture is being pulled about (so the warped picture never shows the hard
  // line where it runs out), but at rest they are crisp, one pixel of anti-aliasing: a soft edge made the canvas card look smaller
  // and blurrier than the real one it hands over to.
  vec2 aa = fwidth(suv)*0.5;
  vec2 fe = max(vec2(0.004,0.01)*smoothstep(0.0, 3.0, length(disp)), aa);
  vec2 e = smoothstep(-aa, fe, suv) * (1.0 - smoothstep(1.0 - fe, 1.0 + aa, suv));
  float key = uAlphaMode > 0.5 ? tx.a : smoothstep(0.012, 0.05, length(col-uImgBg));
  float k = key*e.x*e.y;
  float E = energyAt(rp, uMouse, uRadius, uPresence, fl.b);
  // The picture arrives ahead of the particles leaving (squared, so it is nearly opaque while they still are), never after them.
  float show = (1.0 - max(E, uRest*uRest))*uIntroVis;
  vec3 mat = uAlphaMode > 0.5 ? col : col*(uBg/max(uImgBg, vec3(0.001)));
  float A = k*show;
  o = vec4(mat*A, A);
}
`;

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * Builds programs from [vertex, fragment] sources. Every shader is compiled and every program linked before any of them is
 * asked how it went: asking after each one makes the driver finish it before it starts the next, where this lets it work on
 * them side by side (this was most of the time the card took to build on a phone).
 */
function compileAll(gl, sources) {
  const shader = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const made = sources.map(([vs, fs]) => {
    const p = gl.createProgram(), v = shader(gl.VERTEX_SHADER, vs), f = shader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    return { p, v, f };
  });
  return made.map(({ p, v, f }) => {
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(v) || gl.getShaderInfoLog(f) || gl.getProgramInfoLog(p);
      throw new Error("Shader: " + log);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  });
}

/* ── engine ──────────────────────────────────────────────────────────── */

const TEX_W = 1024;
// How long the material keeps moving after the pointer leaves: long enough to settle gracefully, short enough that the
// card's text is legible again quickly. In real time, not frames: a phone at 30 fps must take no longer than a laptop.
const SETTLE_MS = 1800;
/** After the material has calmed the engine keeps drawing for this long (the canvas still copies the live card), so the
    page can put the real card back underneath and fade the canvas away over it without the two ever differing. */
const HANDOFF_MS = 900;

export class LiquidEngine {
  constructor(canvas, opts, onFail) {
    this.canvas = canvas;
    this.opts = opts;
    this.onFail = onFail;
    /** Called with true when the material starts moving and false once it has settled. */
    this.onActive = null;
    this.wasActive = false;

    this.flowTex = []; this.flowFb = []; this.flowW = 256; this.flowH = 104; this.flowIdx = 0; this.flowDirty = false;
    this.imgTex = null; this.homeTex = null; this.colTex = null; this.stateTex = []; this.stateFb = [];
    this.stateIdx = 0; this.texH = 1; this.n = 0; this.gridW = 1; this.stateDirty = false;
    this.hide = 0; this.tailUntil = 0; this.backed = false; this.onBack = null; this.dissolving = false; this.dissolveT = 0; this.dissolveMs = 850; this.dissolveAt = 0; this.onDissolved = null; this.liveSource = null; this.liveAt = 0; this.alphaMode = false; this.imgBg = [0.918, 0.914, 0.906]; this.flowing = 0; this.homeData = null;
    this.aspect = 3.2; this.rect = { x: 0, y: 0, w: 1, h: 1 }; this.cssW = 1; this.cssH = 1;
    this.target = { x: -9999, y: -9999 }; this.mouse = { x: -9999, y: -9999 }; this.prevMouse = { x: -9999, y: -9999 };
    this.mvel = { x: 0, y: 0 }; this.presence = 0; this.presenceTarget = 0; this.burst = 0; this.settle = 1e9; this.touchRelease = 0;
    this.time = 0; this.introT = 1; this.raf = 0; this.running = false; this.last = 0; this.skip = 0;
    this.visible = true; this.ready = false; this.destroyed = false; this.lost = false;

    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.lowPower = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4 || matchMedia("(pointer: coarse)").matches;
    this.onLost = (e) => { e.preventDefault(); this.lost = true; this.stop(); this.onFail(); };
    this.frame = this.frame.bind(this);
    this.initGL();
    canvas.addEventListener("webglcontextlost", this.onLost, false);
  }

  initGL() {
    const gl = this.gl;
    const full = gl.getExtension("EXT_color_buffer_float");
    const half = full ? null : gl.getExtension("EXT_color_buffer_half_float");
    if (!full && !half) throw new Error("No float render targets");
    this.stateFormat = { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
    [this.pFlow, this.pSim, this.pPart, this.pImg] = compileAll(gl, [[QUAD_VS, FLOW_FS], [QUAD_VS, SIM_FS], [PART_VS, PART_FS], [QUAD_VS, IMAGE_FS]]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let i = 0; i < 2; i++) {
      const t = this.makeTex(gl.RGBA8, this.flowW, this.flowH, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.flowTex.push(t);
      this.flowFb.push(fb);
    }
    this.clearFlow();
  }

  makeTex(internal, w, h, format, type, data, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  clearFlow() {
    const gl = this.gl;
    for (const fb of this.flowFb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, this.flowW, this.flowH);
      gl.clearColor(128 / 255, 128 / 255, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.flowDirty = false;
  }

  clearState() {
    const gl = this.gl;
    for (const fb of this.stateFb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, TEX_W, this.texH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stateDirty = false;
  }

  /** The image to build from: any canvas or image element. `intro` assembles it from flying particles. */
  setImage(img, intro = false) {
    if (this.destroyed || this.lost) return;
    const gl = this.gl;
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    this.aspect = w / h || 3.2;
    this.flowH = Math.max(32, Math.round(this.flowW / this.aspect));
    for (const t of this.flowTex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.flowW, this.flowH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.clearFlow();
    if (this.imgTex) gl.deleteTexture(this.imgTex);
    this.imgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.buildParticles(img, w, h);
    this.ready = true;
    this.dissolving = false;
    this.liveFrozen = false;
    if (intro && !this.opts.reducedMotion) this.startIntro();
    this.wake();
  }

  /** One particle per material pixel of a grid laid over the image. */
  buildParticles(img, iw, ih) {
    const gl = this.gl;
    const baseGrid = this.lowPower ? 640 : 1000;
    const gw = Math.round(baseGrid * Math.sqrt(clamp(this.opts.density, 0.15, 2)));
    const gh = Math.max(1, Math.round(gw / this.aspect));
    this.gridW = gw;
    const c = document.createElement("canvas");
    c.width = gw;
    c.height = gh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, iw, ih, 0, 0, gw, gh);
    const data = ctx.getImageData(0, 0, gw, gh).data;
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) transparent++;
    // A cut-out image is keyed by its alpha; an opaque one by its distance from its background colour, sampled at the
    // corners. `alpha` says which, for images (like the card, with clear rounded corners) too nearly opaque to guess.
    this.alphaMode = this.opts.alpha ?? transparent > data.length / (4 * 7) / 20;
    if (this.opts.imgBg) this.imgBg = this.opts.imgBg;
    else if (!this.alphaMode) {
      let r = 0, g = 0, b = 0, n = 0;
      const pw = Math.max(2, Math.round(gw * 0.012));
      for (const [cx, cy] of [[0, 0], [gw - pw, 0], [0, gh - pw], [gw - pw, gh - pw]]) {
        for (let y = cy; y < cy + pw; y++) for (let x = cx; x < cx + pw; x++) { const i = (y * gw + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      }
      this.imgBg = [r / n / 255, g / n / 255, b / n / 255];
    }
    const home = [], col = [];
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        if (this.alphaMode) {
          const a = data[i + 3] / 255;
          if (a < 0.12) continue;
          if (a < 0.5 && Math.random() > a * 2) continue;
        } else {
          const dev = Math.hypot(r - this.imgBg[0], g - this.imgBg[1], b - this.imgBg[2]);
          if (dev < 0.03) continue;
          if (dev < 0.07 && Math.random() > (dev - 0.03) / 0.04) continue;
        }
        const jx = (Math.random() - 0.5) * 0.6, jy = (Math.random() - 0.5) * 0.6;
        home.push((x + 0.5 + jx) / gw, (y + 0.5 + jy) / gh, Math.random(), 0.85 + Math.random() * 0.3);
        col.push(data[i], data[i + 1], data[i + 2], 255);
      }
    }
    const n = home.length / 4;
    this.n = n;
    this.texH = Math.max(1, Math.ceil(n / TEX_W));
    const total = TEX_W * this.texH;
    const homeArr = new Float32Array(total * 4);
    homeArr.set(home);
    const colArr = new Uint8Array(total * 4);
    colArr.set(col);
    for (const t of [this.homeTex, this.colTex, ...this.stateTex]) if (t) gl.deleteTexture(t);
    for (const f of this.stateFb) gl.deleteFramebuffer(f);
    this.stateTex = [];
    this.stateFb = [];
    this.homeTex = this.makeTex(gl.RGBA32F, TEX_W, this.texH, gl.RGBA, gl.FLOAT, homeArr, gl.NEAREST);
    this.colTex = this.makeTex(gl.RGBA8, TEX_W, this.texH, gl.RGBA, gl.UNSIGNED_BYTE, colArr, gl.NEAREST);
    for (let i = 0; i < 2; i++) {
      const t = this.makeTex(this.stateFormat.internal, TEX_W, this.texH, gl.RGBA, this.stateFormat.type, null, gl.NEAREST);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Float FBO incomplete");
      this.stateTex.push(t);
      this.stateFb.push(fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.homeData = homeArr;
    this.clearState();
  }

  startIntro() {
    const gl = this.gl;
    const home = this.homeData;
    if (!home) return;
    const w = this.rect.w > 10 ? this.rect.w : 1300;
    const st = new Float32Array(TEX_W * this.texH * 4);
    for (let i = 0; i < this.n; i++) {
      const hx = home[i * 4] - 0.5, hy = home[i * 4 + 1] - 0.5, sd = home[i * 4 + 2];
      const ang = (Math.random() - 0.5) * 0.9 + (hx > 0 ? 0 : Math.PI);
      const dist = w * (0.04 + Math.random() * 0.14) * (0.5 + Math.abs(hx) * 1.4);
      st[i * 4] = Math.cos(ang) * dist + hx * w * 0.25 * sd;
      st[i * 4 + 1] = Math.sin(ang) * dist * 0.55 + hy * 120 * (Math.random() - 0.5);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIdx]);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.stateFormat.internal, TEX_W, this.texH, 0, gl.RGBA, gl.FLOAT, st);
    this.introT = 0;
    this.stateDirty = true;
  }

  /**
   * The card breaks apart: its particles are blown away from the centre in a swirl and fade out. Resolves when it has
   * gone, so the page can change the song only then; the next setImage (the new card) assembles from nothing. Resolves
   * at once when there is nothing to see (not on screen, not built yet, reduced motion).
   */
  dissolve(ms = 850) {
    if (this.dissolving) return new Promise((done) => { const was = this.onDissolved; this.onDissolved = () => { was?.(); done(); }; });
    if (!this.canShow()) return Promise.resolve();
    this.dissolving = true;
    this.dissolveT = 0;
    this.dissolveMs = ms;
    this.dissolveAt = performance.now();
    this.liveFrozen = true; // the card on the page is about to change; the particles keep the colours they have
    this.wake();
    return new Promise((done) => { this.onDissolved = done; });
  }

  /** Whether a dissolve or an assembly would be seen: built, on screen, and motion is welcome. */
  canShow() {
    return this.ready && !!this.n && !this.destroyed && !this.lost && this.visible && !this.opts.reducedMotion;
  }

  /** Puts the card back together (if the new card never came): the same card assembles again. */
  restore() {
    if (!this.dissolving) return;
    this.dissolving = false;
    this.liveFrozen = false;
    const done = this.onDissolved;
    this.onDissolved = null;
    done?.();
    this.startIntro();
    this.wake();
  }

  /** Device pixels per CSS pixel for a canvas of this size (capped so a big hero stays affordable). */
  pixelRatio(cssW, cssH) {
    // The canvas card should be as sharp as the real one it hands over to, so it gets the screen's full ratio (a phone's 3x
    // included), within the size budget below; low-power devices lose a little, not the sharpness the eye sees.
    let dpr = Math.min(devicePixelRatio || 1, 3);
    if (cssW * cssH * dpr * dpr > 4.5e6) dpr = Math.max(1, Math.sqrt(4.5e6 / (cssW * cssH)));
    return dpr;
  }

  resize(cssW, cssH, rect) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.rect = rect;
    const dpr = this.pixelRatio(this.cssW, this.cssH);
    const w = Math.round(this.cssW * dpr), h = Math.round(this.cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.draw();
  }

  setVisible(v) {
    this.visible = v;
    if (v) this.wake();
    else this.stop();
  }

  pointer(type, x, y, touch) {
    if (!this.opts.interactive || this.lost) return;
    const now = performance.now();
    if (type === "leave" || type === "up") {
      if (touch) this.touchRelease = now + 260;
      else this.presenceTarget = 0;
      this.wake();
      return;
    }
    if (this.mouse.x < -9000 || type === "down") { this.mouse.x = this.prevMouse.x = x; this.mouse.y = this.prevMouse.y = y; }
    this.target.x = x;
    this.target.y = y;
    this.presenceTarget = 1;
    this.settle = 0;
    if (type === "down") { this.burst = 1; this.touchRelease = 0; }
    this.wake();
  }

  wake() {
    if (!this.ready || this.running || !this.visible || this.destroyed || this.lost) {
      if (this.ready && !this.running) this.draw();
      return;
    }
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  radiusPx() { return this.opts.radius * clamp(this.rect.w / 1400, 0.6, 1.25); }
  strength() { return this.opts.strength * (this.opts.reducedMotion ? 0.5 : 1); }

  /** Tells the page when the material starts and stops moving. */
  report(active) {
    if (active === this.wasActive) return;
    this.wasActive = active;
    this.onActive?.(active);
  }

  frame(now) {
    if (!this.running) return;
    const rawMs = now - this.last;
    const dt = clamp(rawMs / 16.6667, 0.25, 3);
    // For things that must take the same real time on any device (fading, settling), not the same number of frames: a
    // slow phone's long frames must not stretch the tail the card spends dim and soft.
    const dtt = clamp(rawMs / 16.6667, 0.25, 8);
    this.last = now;
    const o = this.opts;
    if (this.touchRelease && now > this.touchRelease) { this.presenceTarget = 0; this.touchRelease = 0; }
    const ease = 1 - Math.pow(1 - 0.22, dt);
    this.mouse.x += (this.target.x - this.mouse.x) * ease;
    this.mouse.y += (this.target.y - this.mouse.y) * ease;
    const vx = (this.mouse.x - this.prevMouse.x) / dt, vy = (this.mouse.y - this.prevMouse.y) / dt;
    this.prevMouse.x = this.mouse.x;
    this.prevMouse.y = this.mouse.y;
    this.mvel.x += (clamp(vx, -60, 60) - this.mvel.x) * 0.5;
    this.mvel.y += (clamp(vy, -60, 60) - this.mvel.y) * 0.5;
    const pk = this.presenceTarget > this.presence ? 0.1 : 0.035;
    this.presence += (this.presenceTarget - this.presence) * (1 - Math.pow(1 - pk, dtt));
    if (this.presence < 0.001 && this.presenceTarget === 0) this.presence = 0;
    const fk = this.presenceTarget > this.flowing ? 0.05 : 0.018;
    this.flowing += (this.presenceTarget - this.flowing) * (1 - Math.pow(1 - fk, dtt));
    if (this.flowing < 0.002 && this.presenceTarget === 0) this.flowing = 0;
    if (this.introT < 1) this.introT = Math.min(1, this.introT + Math.min(rawMs, 100) / 3200);
    if (this.dissolving) {
      this.dissolveT = Math.min(1, this.dissolveT + Math.min(rawMs, 100) / this.dissolveMs);
      if (this.dissolveT >= 1 && this.onDissolved) { const done = this.onDissolved; this.onDissolved = null; done(); }
      // A new card should follow within moments; if it never does, put the old one back rather than leave a blank.
      if (now - this.dissolveAt > 9000) this.restore();
    }

    const interacting = this.presence > 0.001 || this.burst > 0;
    this.settle = interacting ? 0 : this.settle + Math.min(rawMs, 100);
    const active = interacting || this.settle < SETTLE_MS || this.introT < 1 || this.dissolving;
    // While the material is disturbed, the particles are the whole card: the flat picture under them (which would show
    // as a solid card beyond the pointer's reach) eases away. Once it has calmed, the picture (the live, moving card)
    // eases back in over the last of the particles, so the canvas settles into the crisp card and what it hands over to
    // the real card is the same sharp, moving picture.
    const calm = !interacting && this.burst === 0 && this.flowing < 0.25 && this.introT >= 1 && !this.dissolving;
    const target = active && !calm ? 1 : 0;
    this.hide = active ? this.hide + (target - this.hide) * (1 - Math.pow(1 - (target ? 0.25 : 0.1), dtt)) : 0;
    // Once the particles are home and the picture is fully back, the canvas is the whole card, opaque and identical to the
    // real one: the page can put the real card back underneath well before the canvas goes (see liquidCard).
    const backed = (!active || calm) && this.hide < 0.01;
    if (backed !== this.backed) { this.backed = backed; this.onBack?.(backed); }

    if (!active) {
      if (this.flowDirty) this.clearFlow();
      if (this.stateDirty) this.clearState();
      // The last frame is the card at rest, exactly: any trace of the ambient wobble (it fades slowly) would make the
      // hand-off to the real card a visible shift.
      this.flowing = 0;
      if (this.wasActive && !this.tailUntil) this.tailUntil = now + HANDOFF_MS;
      this.report(false);
      this.draw();
      if (this.tailUntil && now < this.tailUntil) { this.raf = requestAnimationFrame(this.frame); return; }
      this.tailUntil = 0;
      this.stop();
      return;
    }
    this.tailUntil = 0;
    this.report(true);
    this.raf = requestAnimationFrame(this.frame);
    this.time += (dt * o.speed * (1 + this.flowing * 1.6)) / 60;
    this.stepFlow(dt);
    this.stepSim(dt);
    this.burst = Math.max(0, this.burst - 0.1 * dtt);
    this.draw();
  }

  stepFlow(dt) {
    const gl = this.gl, P = this.pFlow, dst = 1 - this.flowIdx, r = this.rect;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.flowFb[dst]);
    gl.viewport(0, 0, this.flowW, this.flowH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx]);
    gl.uniform1i(P.u.uPrev, 0);
    gl.uniform2f(P.u.uTexel, 1 / this.flowW, 1 / this.flowH);
    gl.uniform2f(P.u.uMouse, (this.mouse.x - r.x) / r.w, (this.mouse.y - r.y) / r.h);
    gl.uniform2f(P.u.uVel, clamp(this.mvel.x / 40, -1, 1), clamp(this.mvel.y / 40, -1, 1));
    gl.uniform2f(P.u.uSize, r.w, r.h);
    gl.uniform1f(P.u.uRadius, this.radiusPx());
    gl.uniform1f(P.u.uPresence, Math.max(this.presence, this.burst));
    gl.uniform1f(P.u.uDecay, Math.pow(0.968, dt));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.flowIdx = dst;
    this.flowDirty = true;
  }

  stepSim(dt) {
    if (!this.n) return;
    const gl = this.gl, P = this.pSim, o = this.opts, r = this.rect, dst = 1 - this.stateIdx;
    // Dissolving, the swirl and the looser spring build up from nothing, so the card starts to come apart, not explode.
    const intro = o.reducedMotion ? 0 : this.dissolving ? Math.pow(this.dissolveT, 1.3) : Math.pow(1 - this.introT, 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFb[dst]);
    gl.viewport(0, 0, TEX_W, this.texH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIdx]);
    gl.uniform1i(P.u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.homeTex);
    gl.uniform1i(P.u.uHome, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx]);
    gl.uniform1i(P.u.uFlow, 2);
    gl.uniform2f(P.u.uSize, r.w, r.h);
    gl.uniform2f(P.u.uMouse, this.mouse.x - r.x, this.mouse.y - r.y);
    gl.uniform1f(P.u.uRadius, this.radiusPx());
    gl.uniform1f(P.u.uPresence, Math.max(this.presence, this.burst));
    gl.uniform1f(P.u.uStrength, this.strength() * (1 + this.burst * 1.5));
    gl.uniform1f(P.u.uSpread, clamp(o.spread, 0, 2));
    gl.uniform1f(P.u.uTurb, clamp(o.turbulence, 0, 2) * (o.reducedMotion ? 0.3 : 1));
    gl.uniform1f(P.u.uReturn, clamp(o.returnSpeed, 0, 2));
    gl.uniform1f(P.u.uTime, this.time);
    gl.uniform1f(P.u.uDt, dt);
    gl.uniform1f(P.u.uIntro, intro);
    gl.uniform1f(P.u.uBlast, this.dissolving ? 0.8 * Math.min(1, this.dissolveT * 3) * Math.pow(1 - this.dissolveT, 1.2) : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stateIdx = dst;
    this.stateDirty = true;
  }

  /**
   * Copies the card's current frame (its wave, equaliser and cover are animating) into the image texture, so the liquid
   * card keeps moving instead of showing a still picture that the real, moving card then replaces. About 1 ms to draw
   * and 1 ms to upload; every frame, or every other frame on a low-power device.
   */
  refreshLive() {
    if (!this.liveSource || !this.imgTex || this.liveFrozen) return;
    const now = performance.now();
    if (now - this.liveAt < (this.lowPower ? 30 : 12)) return;
    const src = this.liveSource();
    if (!src) return;
    this.liveAt = now;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // Same size as the texture made in setImage, so this only replaces the pixels. (Mipmaps are left as they were: the
    // card is drawn 1:1, so only the first level is ever read.)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  draw() {
    if (!this.ready || this.lost || this.destroyed) return;
    this.refreshLive();
    const gl = this.gl, o = this.opts, r = this.rect;
    const introVis = o.reducedMotion ? 1 : Math.pow(this.introT, 2.2);
    const amb = this.flowing * 0.85 * clamp(o.liquid, 0, 2) * (o.reducedMotion ? 0.3 : 1);
    const [ir, ig, ib] = this.imgBg;
    const dpr = this.canvas.width / this.cssW;
    // The canvas is as tall as a whole number of device pixels, which its CSS height (a fraction of a pixel more or less) is
    // not; positions are worked out against the canvas's own rows, so the card lands on exactly the rows the browser draws the
    // real one on (measured against the CSS height it was a third of a device pixel off, which showed as a step at the hand-off).
    const resY = this.canvas.height / dpr;
    const pres = Math.max(this.presence, this.burst);
    const mx = this.mouse.x - r.x, my = this.mouse.y - r.y;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const I = this.pImg;
    gl.useProgram(I.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.uniform1i(I.u.uImg, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx]);
    gl.uniform1i(I.u.uFlow, 1);
    gl.uniform2f(I.u.uRes, this.cssW, resY);
    gl.uniform1f(I.u.uDpr, dpr);
    gl.uniform4f(I.u.uRect, r.x, r.y, r.w, r.h);
    gl.uniform3f(I.u.uBg, 1, 1, 1);
    gl.uniform3f(I.u.uImgBg, ir, ig, ib);
    gl.uniform2f(I.u.uMouse, mx, my);
    gl.uniform1f(I.u.uPresence, pres);
    gl.uniform1f(I.u.uRadius, this.radiusPx());
    gl.uniform1f(I.u.uStrength, this.strength());
    gl.uniform1f(I.u.uTime, this.time);
    gl.uniform1f(I.u.uAmbient, amb);
    gl.uniform1f(I.u.uIntroVis, introVis);
    gl.uniform1f(I.u.uRest, this.hide);
    gl.uniform1f(I.u.uAlphaMode, this.alphaMode ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (!this.n || (!this.stateDirty && introVis >= 1)) return;

    const P = this.pPart;
    gl.useProgram(P.p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex[this.stateIdx]);
    gl.uniform1i(P.u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.homeTex);
    gl.uniform1i(P.u.uHome, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.colTex);
    gl.uniform1i(P.u.uCol, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex[this.flowIdx]);
    gl.uniform1i(P.u.uFlow, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.uniform1i(P.u.uImg, 4);
    gl.uniform1f(P.u.uLive, this.liveSource && !this.liveFrozen ? 1 : 0);
    // Dissolving: solid at first, thinning to nothing by the end. Assembling: thickening in over the first moments.
    const ease = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
    gl.uniform1f(P.u.uFade, this.dissolving ? 1 - ease((this.dissolveT - 0.35) / 0.65) : ease(this.introT / 0.08));
    gl.uniform1i(P.u.uTexW, TEX_W);
    gl.uniform4f(P.u.uRect, r.x, r.y, r.w, r.h);
    gl.uniform2f(P.u.uRes, this.cssW, resY);
    gl.uniform2f(P.u.uMouse, mx, my);
    gl.uniform1f(P.u.uRadius, this.radiusPx());
    gl.uniform1f(P.u.uPresence, pres);
    gl.uniform1f(P.u.uDot, (r.w / this.gridW) * 1.45 * clamp(o.dotSize, 0.2, 3));
    gl.uniform1f(P.u.uTime, this.time);
    gl.uniform1f(P.u.uAmbient, amb);
    gl.uniform1f(P.u.uStreak, (o.streaks ? 1 : 0) * (0.45 + 0.55 * introVis));
    gl.uniform1f(P.u.uIntroVis, introVis);
    gl.uniform1f(P.u.uRest, this.hide);
    gl.uniform1f(P.u.uDpr, dpr);
    gl.uniform3f(P.u.uTint, 1, 1, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    gl.disable(gl.BLEND);
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    const gl = this.gl;
    if (!this.lost) {
      gl.deleteBuffer(this.quad);
      gl.deleteVertexArray(this.vao);
      for (const t of [...this.flowTex, ...this.stateTex, this.imgTex, this.homeTex, this.colTex]) if (t) gl.deleteTexture(t);
      for (const f of [...this.flowFb, ...this.stateFb]) gl.deleteFramebuffer(f);
      for (const p of [this.pFlow, this.pSim, this.pPart, this.pImg]) if (p) gl.deleteProgram(p.p);
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * Ode's use of it: the live hero card, liquid. The canvas spans the hero so particles can fly past the card; at rest
 * it is hidden and the real, animated card shows. When the pointer comes near the card, the canvas (showing the same
 * pixels) takes over, the card turns liquid, and once it has settled the real card is back. A new song dissolves the
 * old card and assembles the new one from particles.
 */
export function liquidCard({ hero, card, reduced, onEngage }) {
  const canvas = document.createElement("canvas");
  canvas.className = "liquid";
  canvas.setAttribute("aria-hidden", "true");
  hero.prepend(canvas);
  const root = document.documentElement;
  let engine;
  const fail = () => { root.classList.remove("liquid-on", "liquid-live", "liquid-still"); root.classList.add("vinyl-on"); canvas.remove(); engine = null; };
  engine = new LiquidEngine(canvas, {
    interactive: true, strength: 0.75, radius: 200, density: 0.42, dotSize: 1, spread: 1, turbulence: 1,
    returnSpeed: 1, streaks: true, liquid: 0.7, speed: 1, reducedMotion: reduced, imgBg: null, alpha: true,
  }, fail);
  // Anyone waiting for the card to be at rest (a quiet update must not rebuild it under someone's finger).
  const restWaiters = [];
  // Handing back to the real card is two steps, a good while apart. Once the particles are home and the canvas is the whole card
  // again (opaque, and copying the real one), the real card is put back underneath it; and only when everything has settled,
  // a moment later, does the canvas fade away over it. Doing both at once lets the card dip for a frame or two if the real one
  // is slow to appear (it has not been drawn for a few seconds), which looked like the card vanishing and coming back.
  let handoff = 0;
  engine.onBack = (back) => {
    if (back && root.classList.contains("liquid-live")) root.classList.add("liquid-back");
    else if (!back) root.classList.remove("liquid-back");
  };
  engine.onActive = (on) => {
    clearTimeout(handoff);
    if (on) {
      root.classList.add("liquid-live");
      return;
    }
    root.classList.add("liquid-back"); // (already so, unless it all settled at once)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      handoff = setTimeout(() => {
        root.classList.remove("liquid-live", "liquid-back");
        while (restWaiters.length) restWaiters.shift()();
      }, 100);
    }));
  };

  // The card is only taken over (stopped where it is, and made liquid) when someone first comes near it. Until then the engine
  // is built and waiting, so that first touch finds it ready, and the card carries on floating.
  let engaged = false, built = false, easing = null;
  const settleEasing = () => {
    // The tilt and the scroll shrink ease away over a few hundred ms after the card is stopped: the card is measured once they are done.
    const running = hero.getAnimations({ subtree: true }).filter((a) => (a.id === "ode-still" || (a instanceof CSSTransition && a.transitionProperty === "transform")) && !!a.effect?.target?.closest?.(".hero-art"));
    return Promise.all(running.map((a) => a.finished.catch(() => {})));
  };
  const engage = () => {
    if (engaged || !engine) return;
    engaged = true;
    onEngage?.();
    if (!built) return; // setCard finishes the job
    root.classList.add("liquid-on");
    placed = "";
    layout();
    easing = settleEasing().then(() => { placed = ""; layout(); });
  };

  // Where the card sits on the canvas, in CSS pixels, snapped to the device pixel grid. The browser draws the real card
  // on whole device pixels; a canvas card at a fractional position is resampled, which is softer, and the hand-off to
  // the real card would show as a small shift.
  let placed = "";
  const layout = () => {
    if (!engine) return;
    const c = canvas.getBoundingClientRect(), r = card.getBoundingClientRect();
    if (!c.width || !r.width) return;
    const k = engine.pixelRatio(c.width, c.height), snap = (v) => Math.round(v * k) / k;
    const rect = { x: snap(r.left) - snap(c.left), y: snap(r.top) - snap(c.top), w: snap(r.right) - snap(r.left), h: snap(r.bottom) - snap(r.top) };
    const key = [c.width, c.height, rect.x, rect.y, rect.w, rect.h].join();
    if (key === placed) return;
    placed = key;
    engine.resize(c.width, c.height, rect);
  };
  const ro = new ResizeObserver(layout);
  ro.observe(canvas);
  ro.observe(card);

  // The whole card is on screen, and the hero is not shrinking away as the page scrolls (stopping it would make it jump back).
  const fullyInView = () => {
    const r = card.getBoundingClientRect(), art = card.closest(".hero-art");
    return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && (!art || getComputedStyle(art).opacity === "1");
  };

  // The pointer near the card (within reach of the liquid) drives it; elsewhere it rests.
  const near = (e) => {
    const r = card.getBoundingClientRect(), reach = 90;
    return e.clientX > r.left - reach && e.clientX < r.right + reach && e.clientY > r.top - reach && e.clientY < r.bottom + reach;
  };
  const at = (e) => { const c = canvas.getBoundingClientRect(); return [e.clientX - c.left, e.clientY - c.top]; };
  const touch = (e) => e.pointerType !== "mouse";
  // A finger drives the card only once the page has said it is playing with it (see touch() below), not on every touch that
  // lands near it: most of those are someone scrolling the page.
  let touching = false;
  hero.addEventListener("pointermove", (e) => {
    if (!engine || (touch(e) && !touching)) return;
    if (near(e)) {
      engage();
      // The card may have moved since it was measured (its float, a reflow): measure it again before the material wakes.
      if (!root.classList.contains("liquid-live")) layout();
      engine.pointer("move", ...at(e), touch(e));
    }
    else engine.pointer("leave", 0, 0, touch(e));
  });
  hero.addEventListener("pointerdown", (e) => {
    if (!engine || !near(e) || touch(e)) return; // a touch is let in by touch()
    engage();
    if (!root.classList.contains("liquid-live")) layout();
    engine.pointer("down", ...at(e), touch(e));
  });
  hero.addEventListener("pointerup", (e) => engine?.pointer("up", 0, 0, touch(e)));
  hero.addEventListener("pointerleave", (e) => engine?.pointer("leave", 0, 0, touch(e)));
  hero.addEventListener("pointercancel", (e) => engine?.pointer("leave", 0, 0, touch(e)));

  // The simulation runs only while the hero is on screen and the tab is in front.
  let onScreen = true;
  const sync = () => engine?.setVisible(onScreen && !document.hidden);
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }).observe(hero);
  document.addEventListener("visibilitychange", sync);

  /** Rasterises the card's SVG at exactly its on-screen device pixel size (so the canvas card is 1:1 and as crisp as the
      real one) and builds the particles from it. */
  const build = async (src, intro) => {
    // The card on the page is already loaded and decoded: use it, rather than fetch and decode a second copy.
    let img = card;
    if (card.getAttribute("src") !== src || !card.complete || !card.naturalWidth) {
      img = new Image();
      img.decoding = "async";
      img.src = src;
    }
    await img.decode();
    if (!engine) return;
    // If the card has been stopped and is still easing to rest, it is measured once it has.
    if (engaged) await settleEasing();
    if (!engine) return;
    layout();
    const k = engine.pixelRatio(canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
    // The raster is sized from the card's layout box, which a float, a tilt or the shrink on scroll do not change.
    const w = Math.max(64, Math.round((card.offsetWidth || engine.rect.w) * k)), h = Math.max(24, Math.round((card.offsetHeight || engine.rect.h) * k));
    const raster = document.createElement("canvas");
    raster.width = w;
    raster.height = h;
    raster.getContext("2d").drawImage(img, 0, 0, w, h);
    engine.liveSource = null;
    engine.setImage(raster, intro);
    // From now on the engine copies the card as it is on screen, frame by frame, at the same size.
    const live = document.createElement("canvas");
    live.width = w;
    live.height = h;
    const lctx = live.getContext("2d");
    engine.liveSource = () => {
      if (!card.complete || !card.naturalWidth) return null;
      lctx.clearRect(0, 0, w, h);
      lctx.drawImage(card, 0, 0, w, h);
      return live;
    };
  };

  return {
    /** The card's image: the first build is quiet; later ones (a new song) assemble from flying particles. */
    async setCard(src, intro) {
      try {
        // A new card assembles from particles only for someone who is playing with it; otherwise the page swaps it as usual.
        await build(src, intro && engaged);
        built = true;
        if (engaged) {
          root.classList.add("liquid-on");
          // The float stopped just now, so measure the resting card (not the one that was mid-float).
          placed = "";
          layout();
        }
      } catch (e) { console.warn("Ode: liquid card unavailable", e); fail(); }
    },
    /** The first touch, or the pointer coming near, takes the card over: it stops where it is and becomes the liquid one. */
    engage,
    get engaged() { return engaged; },
    /** Resolves once the card is at rest (at once if it already is; after 4 s regardless, e.g. if it is off screen). */
    rested: () => (root.classList.contains("liquid-live") ? new Promise((done) => { restWaiters.push(done); setTimeout(done, 4000); }) : Promise.resolve()),
    /** A finger that is playing with the card (held or dragging) starts to drive it, from where it is, and lets go of it when it
        lifts. A finger that is only scrolling the page never gets here. */
    touch(on, pt) {
      touching = on;
      if (!engine) return;
      if (!on) return engine.pointer("up", 0, 0, true);
      if (!pt || !near(pt)) return;
      engage();
      if (!root.classList.contains("liquid-live")) layout();
      engine.pointer("down", ...at(pt), true);
    },
    /** Plays back a touch the page saw before the card was ready, as if it had just happened at that spot. */
    poke(clientX, clientY) {
      if (!engine) return;
      layout();
      const pt = { clientX, clientY };
      if (!near(pt)) return;
      engine.pointer("down", ...at(pt), true);
      setTimeout(() => engine?.pointer("up", 0, 0, true), 90);
    },
    /** A mouse that was already on the card before it was ready: the card responds as if the pointer had just arrived. */
    hover(clientX, clientY) {
      if (!engine) return;
      const pt = { clientX, clientY };
      if (!near(pt)) return;
      engage();
      layout();
      engine.pointer("move", ...at(pt), false);
    },
    /** The card breaks apart; resolves when it has gone. A change of song is for everyone, not only for someone who has played
        with the card: a card nobody has touched yet is taken over first (as a first touch would), then breaks apart, and the
        new one assembles from particles. Not when it would not be seen, or when taking it over would move it: off screen,
        not built yet, or part-way through shrinking away as the page scrolls. Then the page swaps the card as usual. */
    async dissolve() {
      if (!engine?.canShow() || !built) return;
      if (!engaged) {
        if (!fullyInView()) return;
        engage();
        await easing;
        if (!engine) return;
      }
      await engine.dissolve();
    },
    /** The new card did not come: put the old one back. */
    restore: () => engine?.restore(),
    layout,
  };
}
