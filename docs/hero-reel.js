// Hero demo reel — the landing page's cinematic header.
//
// A 70vh dark stage. The case renders as an engineering drawing — white
// contour lines over a near-black body — and a shot list cuts between beauty
// angles and full-frame macro close-ups every few seconds, each shot drifting
// slowly like a camera floating in space. Behind everything, the keypad's
// real OLED screens (the same generated bundle the simulator uses,
// window.MKOLED) play as a wall of giant LED pixels, each screen plotting in
// column by column, right to left.
//
// Loads docs/models/case.glb if present, otherwise docs/models/case.stl.
// Progressive enhancement only: if three.js can't load, WebGL is missing, or
// the viewport is narrow, the dark hero simply stays a quiet dark hero.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const canvas = document.getElementById("hero-reel");
const stage = canvas && canvas.parentElement;
if (canvas && stage && window.matchMedia("(min-width: 761px)").matches) {
  try { init(); } catch (e) { canvas.remove(); }
}

function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function init() {
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BG = new THREE.Color("#050507");
  const LINE = new THREE.Color("#e6e9f2");
  const ACCENT = cssColor("--accent", "#0ea5e9");
  const LINE_OP = 0.6;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(BG, 1);
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 300, 900);
  const camera = new THREE.PerspectiveCamera(30, 2, 1, 2000);
  scene.add(camera);

  // ---- the case: dark body + white contours, centered on the origin -------
  // The sweep plane plots the drawing in on load.
  const clip = new THREE.Plane(new THREE.Vector3(1, 0, 0), -1e6);
  const lineMat = new THREE.LineBasicMaterial({
    color: LINE, transparent: true, opacity: LINE_OP, clippingPlanes: [clip],
  });
  // The pointer works the drawing like a hand over wet ink: a trail of six
  // fading touch points rides in the line shader. Where the contours are
  // bright, the touch dissolves them; where they are dim or not yet drawn,
  // it materialises them — one formula, both directions. Injected via
  // onBeforeCompile so clipping and fog keep working untouched.
  let lineShader = null;
  lineMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTrail = { value: Array.from({ length: 6 }, () => new THREE.Vector4(1e6, 0, 0, 0)) };
    sh.uniforms.uAccent = { value: new THREE.Color(ACCENT) };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;")
      .replace("#include <fog_vertex>", "#include <fog_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWp;\nuniform vec4 uTrail[6];\nuniform vec3 uAccent;")
      .replace(
        "#include <opaque_fragment>",
        "float gCur = 0.0;\n" +
        "for (int i = 0; i < 6; i++) {\n" +
        "  gCur += uTrail[i].w * smoothstep(6.0, 0.0, distance(vWp, uTrail[i].xyz));\n" +
        "}\n" +
        "gCur = min(gCur, 1.0);\n" +
        "gCur = gCur * gCur * (3.0 - 2.0 * gCur);\n" +
        "outgoingLight = mix(outgoingLight, vec3(1.0), gCur);\n" +
        "float aFlip = clamp(0.95 - diffuseColor.a * 1.15, 0.0, 1.0);\n" +
        "diffuseColor.a = mix(diffuseColor.a, max(aFlip, 0.12), gCur);\n" +
        "#include <opaque_fragment>",
      );
    lineShader = sh;
  };
  // Solid body slightly off the background so the silhouette occludes the LED
  // wall — that's what turns a wireframe tangle into a drawing with mass.
  const bodyMat = new THREE.MeshBasicMaterial({
    color: 0x0a0a0e, polygonOffset: true, polygonOffsetFactor: 2,
    polygonOffsetUnits: 2, clippingPlanes: [clip],
  });

  const caseSpin = new THREE.Group();
  scene.add(caseSpin);

  loadCase().then((geos) => {
    const inner = new THREE.Group();
    for (const g of geos) {
      inner.add(new THREE.Mesh(g, bodyMat));
      inner.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), lineMat));
    }
    const box = new THREE.Box3().setFromObject(inner);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    inner.position.sub(c);
    caseSpin.add(inner);
    caseSpin.scale.setScalar(120 / Math.max(size.x, size.y, size.z));
  }).catch(() => {});

  // ---- the LED wall: giant OLED pixels riding behind the camera -----------
  const OW = 128, OH = 64, CELL = 10;
  const ledCv = document.createElement("canvas");
  ledCv.width = OW * CELL; ledCv.height = OH * CELL;
  const lctx = ledCv.getContext("2d");
  const tex = new THREE.CanvasTexture(ledCv);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;

  const wallMat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.55, depthWrite: false,
  });
  // A child of the camera: whatever the cut, the screen is always the backdrop.
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(960, 480), wallMat);
  wall.position.set(0, 0, -600);
  camera.add(wall);

  const MK = window.MKOLED || null;
  const scr = MK ? new MK.OledScreens() : null;
  if (!MK) wall.visible = false;

  // Game-of-Life glitch: the pointer seeds live cells along its path; they
  // evolve by Conway's rules for a few generations and burn out. The wake is
  // a small mutating corruption of the screen, not a fading blob.
  const life = new Uint8Array(OW * OH);
  const lifeAge = new Uint8Array(OW * OH);
  const lifeNext = new Uint8Array(OW * OH);
  let lifeCount = 0, lifeClock = 0;
  function seedLife(cx, cy, str) {
    const R = 1.6;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(OW - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(OH - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x - cx, y - cy) > R) continue;
        if (Math.random() > 0.4 * str) continue;
        const i = y * OW + x;
        if (!life[i]) lifeCount++;
        life[i] = 1;
        lifeAge[i] = 0;
      }
    }
  }
  function stepLife(dt) {
    if (!lifeCount) return;
    lifeClock += dt;
    if (lifeClock < 0.12) return; // generations tick at ~8/s
    lifeClock = 0;
    lifeNext.fill(0);
    let n = 0;
    for (let y = 0; y < OH; y++) {
      for (let x = 0; x < OW; x++) {
        const i = y * OW + x;
        let nb = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= OH) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            if (xx >= 0 && xx < OW) nb += life[yy * OW + xx];
          }
        }
        const alive = life[i] ? nb === 2 || nb === 3 : nb === 3;
        // burn-out: colonies age and rot, so every glitch eventually dies
        if (alive && lifeAge[i] < 14 && Math.random() > 0.04) {
          lifeNext[i] = 1;
          lifeAge[i] = life[i] ? lifeAge[i] + 1 : 0;
          n++;
        }
      }
    }
    life.set(lifeNext);
    lifeCount = n;
  }

  // ---- pointer: the reel notices you --------------------------------------
  const cursor = {
    ndc: new THREE.Vector2(), sm: new THREE.Vector2(), has: false, energy: 0,
    world: new THREE.Vector3(), cell: { x: -1e3, y: -1e3 },
  };
  const lastCell = { x: -1e3, y: -1e3 };
  stage.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    cursor.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    cursor.has = true;
  }, { passive: true });
  stage.addEventListener("pointerleave", () => { cursor.has = false; });

  const raycaster = new THREE.Raycaster();
  const CASE_CENTER = new THREE.Vector3();
  // 3D touch trail: [0] is the live cursor, 1..5 are fading history samples.
  const trail3d = Array.from({ length: 6 }, () => ({ p: new THREE.Vector3(1e6, 0, 0), born: -1e9 }));
  const lastSample = new THREE.Vector3(1e6, 0, 0);

  function stepCursor(dt, nowS) {
    // slow build, slow release — the touch effect breathes in and out
    cursor.energy += ((cursor.has ? 1 : 0) - cursor.energy) * Math.min(1, dt * 2.5);
    // heavily damped pointer for the camera, so the frame leans, never jumps
    cursor.sm.x += (cursor.ndc.x * cursor.energy - cursor.sm.x) * Math.min(1, dt * 1.2);
    cursor.sm.y += (cursor.ndc.y * cursor.energy - cursor.sm.y) * Math.min(1, dt * 1.2);
    if (cursor.energy < 0.005) {
      if (lineShader) for (const v of lineShader.uniforms.uTrail.value) v.w = 0;
      cursor.cell.x = -1e3;
      lastCell.x = -1e3;
      return;
    }
    // where the touch lands: the actual surface point under the pointer, so
    // the tight glow hugs the contours; off the model, fall back to the
    // nearest point on the ray to the case
    raycaster.setFromCamera(cursor.ndc, camera);
    const hit = raycaster.intersectObject(caseSpin, true)[0];
    if (hit) {
      cursor.world.copy(hit.point);
    } else {
      raycaster.ray.closestPointToPoint(CASE_CENTER, cursor.world);
      if (cursor.world.length() > 90) cursor.world.setLength(90);
    }
    trail3d[0].p.copy(cursor.world);
    trail3d[0].born = nowS;
    if (cursor.world.distanceTo(lastSample) > 3.5) {
      for (let i = 5; i > 1; i--) {
        trail3d[i].p.copy(trail3d[i - 1].p);
        trail3d[i].born = trail3d[i - 1].born;
      }
      trail3d[1].p.copy(cursor.world);
      trail3d[1].born = nowS;
      lastSample.copy(cursor.world);
    }
    if (lineShader) {
      const u = lineShader.uniforms.uTrail.value;
      for (let i = 0; i < 6; i++) {
        const age = nowS - trail3d[i].born;
        const w = cursor.energy * (i === 0 ? 1 : 0.75) * Math.max(0, 1 - age / 1.1);
        u[i].set(trail3d[i].p.x, trail3d[i].p.y, trail3d[i].p.z, w);
      }
    }
    // the same pointer, mapped onto the LED wall's cells; the wall remembers
    // the path as heat, so moving across it leaves a cooling trace
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 600;
    const wx = cursor.ndc.x * halfH * camera.aspect - wall.position.x;
    const wy = cursor.ndc.y * halfH - wall.position.y;
    cursor.cell.x = ((wx + 480) / 960) * OW;
    cursor.cell.y = (1 - (wy + 240) / 480) * OH;
    // seed the automaton all along the pointer's path — a fast sweep sows one
    // continuous band of colonies; a resting pointer only sputters
    const cx = cursor.cell.x, cy = cursor.cell.y;
    if (lastCell.x > -100) {
      const dx = cx - lastCell.x, dy = cy - lastCell.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.2) {
        if (Math.random() < 0.05) seedLife(cx, cy, cursor.energy * 0.5);
      } else {
        const steps = Math.max(1, Math.ceil(dist / 0.8));
        for (let i = 1; i <= steps; i++) {
          seedLife(lastCell.x + (dx * i) / steps, lastCell.y + (dy * i) / steps, cursor.energy);
        }
      }
    } else {
      seedLife(cx, cy, cursor.energy);
    }
    lastCell.x = cx; lastCell.y = cy;
  }

  // ---- reel state: which screen is up, how far its plot has come ----------
  const DRAW_T = 2.0; // each screen ignites pixel by pixel during the fade
  const XF = 2.0;     // cross-fade between the screen and the drawing
  // ignition order: a fresh shuffle per screen, so every menu burns in along
  // a different scatter instead of wiping across
  const rank = new Uint16Array(OW * OH);
  function shuffleRank() {
    for (let i = 0; i < rank.length; i++) rank[i] = i;
    for (let i = rank.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = rank[i]; rank[i] = rank[j]; rank[j] = t;
    }
  }
  shuffleRank();
  const reel = { list: MK ? buildScreens(MK) : [], idx: 0, t: 0, lang: document.documentElement.lang };

  function paintWall(t) {
    if (!scr) return;
    const cur = reel.list[reel.idx];
    cur.draw(scr, Math.max(0, t - DRAW_T));
    const px = scr.fb.px;
    const thresh = Math.min(1, t / DRAW_T) * OW * OH;
    lctx.clearRect(0, 0, ledCv.width, ledCv.height);
    lctx.fillStyle = "#ffffff";
    for (let y = 0; y < OH; y++) {
      const row = y * OW;
      for (let x = 0; x < OW; x++) {
        if (px[row + x] && rank[row + x] < thresh) {
          lctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }
    // the pointer's wake: a Game-of-Life glitch chewing on the screen — every
    // live cell inverts whatever sits under it, mutates, and burns out
    if (lifeCount) {
      for (let y = 0; y < OH; y++) {
        const row = y * OW;
        for (let x = 0; x < OW; x++) {
          if (!life[row + x]) continue;
          const lit = px[row + x] && rank[row + x] < thresh;
          lctx.fillStyle = lit ? "rgba(5,5,7,0.92)" : "rgba(255,255,255,0.85)";
          lctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }
    tex.needsUpdate = true;
  }

  function stepScreen(dt) {
    if (!scr || !reel.list.length) return;
    reel.t += dt;
    paintWall(reel.t);
  }
  function advanceScreen() {
    reel.t = 0;
    shuffleRank();
    reel.idx = (reel.idx + 1) % reel.list.length;
    const lang = document.documentElement.lang;
    if (lang !== reel.lang) { reel.lang = lang; reel.list = buildScreens(MK); reel.idx = 0; }
  }

  // ---- the shot list: close, slow, abstract; hard cuts --------------------
  // Case after normalize: ~102 wide (x), ~32 tall (y), ~120 deep (z).
  // Every shot is tighter than the old wide; the cut alternates close / wider.
  // hollow: no body fill — pure line drawing, the LED wall shows through.
  // sweep:  the contours plot themselves in across the shot ("axis" picks the
  //         sweep direction). roll: a held dutch angle on top of the float.
  const SHOTS = [
    { dur: 14, fov: 27, pos: [48, 36, 62],   look: [0, 6, 0],     drift: [-0.8, -0.5, -0.7],   turn: 0.35, tilt: [0.15, -0.1],  roll: -0.06, hollow: true, sweep: true, axis: "x" }, // "widest": still a close 3/4
    { dur: 12, fov: 25, pos: [36, 30, 58],   look: [16, 10, 18],  drift: [-0.7, -0.4, -0.6], turn: -0.28, tilt: [-0.12, 0.14],  roll: 0.10,               sweep: true, axis: "z" },  // macro: keys
    { dur: 13, fov: 24, pos: [-6, 85, 2],    look: [4, 0, -6],    drift: [0.5, -1.2, 0.4],     turn: 0.4,  tilt: [0.18, 0.12],  roll: 0.35,  hollow: true, sweep: true, axis: "z" }, // top-down crop, hard dutch
    { dur: 12, fov: 26, pos: [-52, 24, 44],  look: [-28, 8, 16],  drift: [0.7, 0.4, -0.6],   turn: -0.3, tilt: [-0.14, -0.15], roll: -0.12,              sweep: true, axis: "x" },  // macro: corner, low
    { dur: 14, fov: 30, pos: [10, 10, 80],   look: [0, 10, 0],    drift: [0, 0.6, -1.1],     turn: 0.35, tilt: [0.16, -0.13],   roll: 0.05,  hollow: true, sweep: true, axis: "x" }, // grazing the deck
    { dur: 12, fov: 24, pos: [-24, 48, -44], look: [-12, 12, -26],drift: [0.6, -0.5, 0.5],       turn: -0.28, tilt: [-0.16, 0.12],  roll: 0.18,               sweep: true, axis: "z" },  // macro: screen cutout, dutch
    { dur: 13, fov: 27, pos: [-56, 28, -64], look: [0, 2, 0],     drift: [0.9, -0.4, 0.8],   turn: 0.3,  tilt: [0.13, 0.15],   roll: -0.08, hollow: true, sweep: true, axis: "z" },// back 3/4, hollow
    { dur: 11, fov: 23, pos: [26, 22, 36],   look: [12, 12, 12],  drift: [-0.5, -0.3, -0.4],   turn: -0.25, tilt: [-0.1, -0.12], roll: 0.14,               sweep: true, axis: "x" }, // extreme macro: key edge
  ];
  let shotIdx = -1, shotT = 0, sweepLen = 1;
  let baseYaw = 0, baseTX = 0, baseTZ = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();

  function applyShot(i) {
    shotIdx = i; shotT = 0;
    baseYaw = caseSpin.rotation.y;
    baseTX = caseSpin.rotation.x;
    baseTZ = caseSpin.rotation.z;
    const s = SHOTS[i];
    camera.fov = s.fov;
    camera.updateProjectionMatrix();
    bodyMat.visible = !s.hollow;
    if (s.sweep) {
      clip.normal.set(s.axis === "z" ? 0 : 1, 0, s.axis === "z" ? 1 : 0);
      clip.constant = -95;
      // the plot spans the fade-in plus most of the shot's featured phase
      sweepLen = XF + s.dur * 0.85;
    } else {
      clip.constant = 1e6;
    }
  }

  function stepShot(dt, now) {
    if (shotIdx < 0) applyShot(0);
    shotT += dt;
    const s = SHOTS[shotIdx];

    // the plotter: contours sweep in slowly, so the shot spends its life
    // being drawn rather than arriving finished
    if (s.sweep) {
      const k = Math.min(1, shotT / sweepLen);
      clip.constant = k >= 1 ? 1e6 : -95 + 190 * (1 - Math.pow(1 - k, 2));
    }

    // slow dolly (capped: the shot stays on stage while the screen leads) +
    // a whisper of handheld float
    const camT = Math.min(shotT, s.dur + XF * 2);
    camPos.set(
      s.pos[0] + s.drift[0] * camT + Math.sin(now / 2600 + shotIdx) * 0.9 + cursor.sm.x * 2.5,
      s.pos[1] + s.drift[1] * camT + Math.cos(now / 3200 + shotIdx * 2) * 0.7 + cursor.sm.y * 1.8,
      s.pos[2] + s.drift[2] * camT,
    );
    camLook.set(s.look[0], s.look[1], s.look[2]);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    camera.rotateZ((s.roll || 0) + 0.01 * Math.sin(now / 2400 + shotIdx * 3));

    // a big turn-and-tilt per shot with quintic easing: velocity AND
    // acceleration are zero at both ends, so the case swings through the
    // frame like a mass on momentum, never ticking, never snapping. Yaw is
    // a relative sweep; tilt eases toward each shot's absolute pose so the
    // model leans without ever tumbling. A slow float rides on top.
    const kQ = Math.min(1, shotT / (s.dur + XF));
    const kT = kQ * kQ * kQ * (kQ * (kQ * 6 - 15) + 10);
    const tilt = s.tilt || [0, 0];
    caseSpin.rotation.y = baseYaw + (s.turn || 0) * kT;
    caseSpin.rotation.x = baseTX + (tilt[0] - baseTX) * kT + 0.03 * Math.sin(now / 3800);
    caseSpin.rotation.z = baseTZ + (tilt[1] - baseTZ) * kT + 0.02 * Math.cos(now / 4600);
  }

  // ---- master timeline: screen ↔ drawing, hand-off by cross-fade ----------
  // screen leads (~4s, plotting in during the fade) → 2s cross-fade → the 3D
  // shot leads while its contours draw → as it finishes, the next screen
  // plots back in. One conductor, two instruments.
  const WALL_HI = 0.8, WALL_DIM = 0.14, CASE_DIM = 0.22;
  let phase = "toScreen", pt = 0;
  const ease01 = (x) => x * x * (3 - 2 * x);

  function stepSequence(dt) {
    pt += dt;
    let focus; // 1 = the screen leads, 0 = the drawing leads
    if (phase === "toScreen") {
      focus = ease01(Math.min(1, pt / XF));
      stepScreen(dt);
      if (pt >= XF) { phase = "screen"; pt = 0; }
    } else if (phase === "screen") {
      focus = 1;
      stepScreen(dt);
      const hold = reel.list.length ? reel.list[reel.idx].dur : 4;
      if (pt >= hold) { applyShot((shotIdx + 1) % SHOTS.length); phase = "toCase"; pt = 0; }
    } else if (phase === "toCase") {
      focus = 1 - ease01(Math.min(1, pt / XF));
      if (pt >= XF) { phase = "case"; pt = 0; }
    } else {
      focus = 0;
      if (pt >= SHOTS[shotIdx].dur) { advanceScreen(); phase = "toScreen"; pt = 0; }
    }
    // the pointer lifts the dimmed wall a touch, so playing with it pays off
    wallMat.opacity = WALL_DIM + (WALL_HI - WALL_DIM) * focus + 0.2 * cursor.energy * (1 - focus);
    lineMat.opacity = LINE_OP * (CASE_DIM + (1 - CASE_DIM) * (1 - focus));
  }

  // ---- sizing -------------------------------------------------------------
  function layout() {
    const w = stage.clientWidth, h = Math.max(1, stage.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(layout).observe(stage);
  layout();

  // ---- main loop ----------------------------------------------------------
  let running = false, raf = 0, last = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    stepCursor(dt, now / 1000);
    stepLife(dt);
    stepShot(dt, now);
    // wall drifts a touch so the pixels feel physical, not wallpapered
    wall.position.x = Math.sin(now / 9000) * 22;
    wall.position.y = Math.cos(now / 12000) * 12;

    stepSequence(dt);
    // while the drawing leads, the wall only repaints for the pointer's sake
    if ((cursor.energy > 0.01 || lifeCount > 0) && phase !== "toScreen" && phase !== "screen") paintWall(reel.t);
    renderer.render(scene, camera);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  if (REDUCED) {
    // No motion: one finished solid macro with a complete screen behind it.
    clip.constant = 1e6;
    caseSpin.rotation.y = 0.7;
    const s = SHOTS[1];
    camera.fov = s.fov; camera.updateProjectionMatrix();
    camera.position.set(s.pos[0], s.pos[1], s.pos[2]);
    camera.lookAt(s.look[0], s.look[1], s.look[2]);
    if (scr && reel.list.length) { paintWall(DRAW_T + 0.01); wallMat.opacity = 0.55; }
    const t0 = setInterval(() => renderer.render(scene, camera), 400);
    setTimeout(() => clearInterval(t0), 4000);
    renderer.render(scene, camera);
  } else {
    new IntersectionObserver(([en]) => (en.isIntersecting ? start() : stop()))
      .observe(stage);
  }

  // ---- model loading ------------------------------------------------------
  async function loadCase() {
    try {
      const gltf = await new GLTFLoader().loadAsync("models/case.glb");
      gltf.scene.updateMatrixWorld(true);
      const out = [];
      gltf.scene.traverse((o) => {
        if (o.isMesh) out.push(o.geometry.clone().applyMatrix4(o.matrixWorld));
      });
      if (out.length) return out;
    } catch {}
    const geo = await new STLLoader().loadAsync("models/case.stl");
    // CAD STLs are Z-up; the scene is Y-up.
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    return [geo];
  }
}

// The reel itself: real device screens rendered by the shared bundle, with a
// little life in each (a ticking clock, a moving slider, a stepping cursor).
function buildScreens(MK) {
  const tr = document.documentElement.lang === "tr";
  MK.setLang(tr ? "tr" : "en");
  const mmss = (s) => {
    s = Math.trunc(s);
    return `${String(Math.trunc(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const layers = tr
    ? ["yayın", "kurgu", "oyun", "ofis"]
    : ["stream", "edit", "game", "work"];
  const menu = tr
    ? ["Sahne: Oyun", "Mikrofonu sustur", "Kaydı başlat", "Klip al", "Ses karıştırıcı"]
    : ["Scene: Game", "Mute mic", "Start recording", "Clip it", "Audio mixer"];
  const grid = ["OBS", "MIC", "CAM", "CLIP", "REC", "SCN"];

  return [
    {
      dur: 3.2,
      draw: (s, t) => s.show_home(Math.min(3, Math.trunc(t / 2.0)), 4, layers, "", true),
    },
    {
      dur: 3.6,
      draw: (s, t) => s.show_menu(tr ? "ÇARK" : "WHEEL", menu, Math.trunc(t / 1.6) % menu.length),
    },
    {
      dur: 3.2,
      draw: (s, t) => s.show_grid(grid, Math.trunc(t / 1.3) % 6, true, tr ? "(A) YAYIN" : "(A) STREAM"),
    },
    {
      dur: 4.0,
      draw: (s, t) => s.show_obs({
        rec: true,
        blink: Math.trunc(t) % 2 === 0,
        time: mmss(83 + t),
        scene: tr ? "Oyun" : "Gameplay",
        mic: 55 + Math.sin(t * 1.1) * 25,
        hint: null,
      }),
    },
    {
      dur: 3.4,
      draw: (s, t) => {
        const p = 0.15 + 0.7 * (0.5 - 0.5 * Math.cos(t * 0.6));
        s.show_adjust(tr ? "SES" : "VOLUME", `${Math.trunc(p * 100 + 0.5)}%`, p);
      },
    },
  ];
}
