import * as THREE from 'three';
import './style.css';
import { BALL_RADIUS, Level, type Surface } from './level';
import { Ball } from './physics';

interface Club {
  name: string;
  /** Launch angle (radians). */
  loft: number;
  /** Ball speed at full power (m/s). */
  maxSpeed: number;
  /** Backspin at full power (rad/s); scales with power. */
  spin: number;
  /** Sidespin per degree of swing path off the target line, at full power (rad/s per degree). */
  sideSpin: number;
}

const deg = (d: number) => (d * Math.PI) / 180;
const CLUBS: Club[] = [
  { name: 'Driver', loft: deg(26), maxSpeed: 44, spin: 120, sideSpin: 180 / 12 },
  { name: 'Iron', loft: deg(38), maxSpeed: 31, spin: 400, sideSpin: 95 / 12 },
  { name: 'Wedge', loft: deg(52), maxSpeed: 21, spin: 250, sideSpin: 30 / 12 },
  { name: 'Putter', loft: 0, maxSpeed: 7, spin: 0, sideSpin: 0 },
];
/**
 * Swing path off the target line (the camera's view direction) beyond which sidespin stops
 * growing. A full-power driver aimed 12° right draws back to about the target line.
 */
const MAX_PATH_ANGLE = deg(48);
const PUTTER = CLUBS.length - 1;
const LIE_NAMES: Record<Surface, string> = { tee: 'Tee', fairway: 'Fairway', green: 'Green', rough: 'Rough' };
const HOLES_PER_ROUND = 9;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const hud = {
  holeNum: $('hole-num'),
  par: $('par'),
  toPin: $('to-pin'),
  strokes: $('strokes'),
  club: $('club'),
  lie: $('lie'),
  round: $('round'),
  windArrow: document.getElementById('wind-arrow') as unknown as SVGPathElement,
  windSpeed: $('wind-speed'),
  windRelative: $('wind-relative'),
  power: $('power'),
  powerFill: $('power-fill'),
  powerLabel: $('power-label'),
  toast: $('toast'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultDetail: $('result-detail'),
  scorecard: $('scorecard'),
  roundSummary: $('round-summary'),
  resultNew: $('result-new'),
  dragLine: document.getElementById('drag-line') as unknown as SVGLineElement,
};

// --- Renderer, scene, lighting -------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$('app').appendChild(renderer.domElement);

const HORIZON = new THREE.Color(0xcfe7f7);
const scene = new THREE.Scene();
scene.background = HORIZON;
scene.fog = new THREE.Fog(HORIZON, 150, 520);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x4a90d9) }, horizon: { value: HORIZON } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float t = clamp(vDir.y * 1.6, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(t, 0.7)), 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
scene.add(sky);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 2000);

scene.add(new THREE.HemisphereLight(0xd8ecff, 0x4b6b2f, 1.1));
const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(40, 70, 25);

// --- Ball and aiming visuals -----------------------------------------------

function makeBallTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#f7f7f4';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(0, 0, 0, 0.07)';
  for (let i = 0; i < 600; i++) {
    g.beginPath();
    g.arc(Math.random() * 256, Math.random() * 128, 1.6, 0, Math.PI * 2);
    g.fill();
  }
  // Alignment line so the roll is visible.
  g.fillStyle = '#d63a2f';
  g.fillRect(0, 61, 256, 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_RADIUS, 32, 16),
  new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.35 }),
);
ballMesh.castShadow = true;
scene.add(ballMesh);

const readyRing = new THREE.Mesh(
  new THREE.RingGeometry(0.22, 0.27, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }),
);
scene.add(readyRing);

const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x5bd65b, depthTest: false, transparent: true, opacity: 0.9 });
const arrowShaft = new THREE.Mesh(
  new THREE.CylinderGeometry(0.035, 0.035, 1, 8).rotateX(Math.PI / 2).translate(0, 0, 0.5),
  arrowMaterial,
);
const arrowHead = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 12).rotateX(Math.PI / 2), arrowMaterial);
const arrow = new THREE.Group();
arrow.add(arrowShaft, arrowHead);
arrow.renderOrder = 10;
arrowShaft.renderOrder = 10;
arrowHead.renderOrder = 10;
arrow.visible = false;
scene.add(arrow);

// Target line: the camera's view direction, which the swing path is measured against.
const targetLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 14)]),
  new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.35, gapSize: 0.3, transparent: true, opacity: 0.6, depthTest: false }),
);
targetLine.computeLineDistances();
targetLine.renderOrder = 9;
targetLine.visible = false;
scene.add(targetLine);

// --- Game state ------------------------------------------------------------

type State = 'ready' | 'aiming' | 'flying' | 'won';

let level = new Level(randomSeed());
scene.add(level.group);
const ball = new Ball(level);
/** Completed holes in the current round. */
let card: { par: number; strokes: number }[] = [];
let holeNumber = 1;
let strokes = 0;
let state: State = 'ready';
let clubIndex = 0;
let wonTimer = -1;
const lastRest = new THREE.Vector3();

const rig = { target: new THREE.Vector3(), yaw: 0, pitch: 0.3, distance: 8, yawGoal: null as number | null };
/** `path` is the signed angle of the shot from the target line; positive is right (in-to-out). */
const aim = { pointerX: 0, pointerY: 0, power: 0, path: 0, dir: new THREE.Vector3() };
const drag = { mode: null as 'aim' | 'orbit' | null, lastX: 0, lastY: 0, pointerId: -1 };

function randomSeed(): number {
  return (Math.random() * 2 ** 32) >>> 0;
}

function startHole(): void {
  holeNumber = card.length + 1;
  lastRest.copy(level.tee);
  strokes = 0;
  state = 'ready';
  wonTimer = -1;
  hud.result.hidden = true;
  rig.target.copy(ball.position);
  rig.yaw = yawTowardHole();
  rig.yawGoal = null;
  rig.pitch = 0.3;
  rig.distance = 8;
  autoSelectClub();
  hud.holeNum.textContent = String(holeNumber);
  hud.par.textContent = String(level.par);
}

/** Advances to the next hole after a finish; mid-hole it re-rolls the current hole without scoring it. */
function newHole(): void {
  if (card.length >= HOLES_PER_ROUND) card = [];
  scene.remove(level.group);
  level.dispose();
  level = new Level(randomSeed());
  scene.add(level.group);
  ball.setLevel(level);
  startHole();
}

function distanceToPin(): number {
  return Math.hypot(ball.position.x - level.hole.x, ball.position.z - level.hole.y);
}

function yawTowardHole(): number {
  return Math.atan2(-(level.hole.x - ball.position.x), -(level.hole.y - ball.position.z));
}

function autoSelectClub(): void {
  const lie = level.surfaceAt(ball.position.x, ball.position.z);
  const d = distanceToPin();
  clubIndex = lie === 'green' ? PUTTER : d > 120 ? 0 : d > 55 ? 1 : 2;
}

function onBallStopped(): void {
  state = 'ready';
  autoSelectClub();
  rig.yawGoal = yawTowardHole();
}

function shoot(): void {
  const club = CLUBS[clubIndex];
  lastRest.copy(ball.position);
  const speed = club.maxSpeed * aim.power;
  // A putt leaves the face already rolling (topspin matching its speed) so it doesn't skid.
  const backspin = clubIndex === PUTTER ? -speed / BALL_RADIUS : club.spin * aim.power;
  // An in-to-out path (aimed right of the target line) draws; out-to-in fades.
  const pathDegrees = (THREE.MathUtils.clamp(aim.path, -MAX_PATH_ANGLE, MAX_PATH_ANGLE) * 180) / Math.PI;
  const sidespin = club.sideSpin * aim.power * pathDegrees;
  ball.strike(aim.dir, speed, club.loft, backspin, sidespin);
  strokes++;
  state = 'flying';
}

function formatToPar(diff: number): string {
  return diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff);
}

function roundTotals(): { strokes: number; toPar: number } {
  const total = card.reduce((sum, h) => sum + h.strokes, 0);
  return { strokes: total, toPar: total - card.reduce((sum, h) => sum + h.par, 0) };
}

function renderScorecard(): void {
  const cells = (fn: (i: number) => string) =>
    Array.from({ length: HOLES_PER_ROUND }, (_, i) => fn(i)).join('');
  const totals = roundTotals();
  const parTotal = card.reduce((sum, h) => sum + h.par, 0);
  hud.scorecard.innerHTML = `
    <tr><th>Hole</th>${cells((i) => `<th>${i + 1}</th>`)}<th>Tot</th></tr>
    <tr><th>Par</th>${cells((i) => `<td>${card[i]?.par ?? ''}</td>`)}<td>${parTotal}</td></tr>
    <tr><th>Score</th>${cells((i) => {
      const h = card[i];
      if (!h) return '<td></td>';
      const cls = h.strokes < h.par ? 'under' : h.strokes > h.par ? 'over' : '';
      return `<td class="${cls}">${h.strokes}</td>`;
    })}<td>${totals.strokes}</td></tr>`;
}

function showResult(): void {
  const diff = strokes - level.par;
  const names: Record<string, string> = {
    '-3': 'Albatross!',
    '-2': 'Eagle!',
    '-1': 'Birdie!',
    '0': 'Par',
    '1': 'Bogey',
    '2': 'Double bogey',
    '3': 'Triple bogey',
  };
  hud.resultTitle.textContent = strokes === 1 ? 'Hole in one!' : (names[String(diff)] ?? `${diff > 0 ? '+' : ''}${diff}`);
  hud.resultDetail.textContent = `${strokes} stroke${strokes === 1 ? '' : 's'} on a ${Math.round(level.distance)} m par ${level.par}.`;
  renderScorecard();
  const totals = roundTotals();
  const finished = card.length >= HOLES_PER_ROUND;
  hud.roundSummary.textContent = finished
    ? `Round complete: ${totals.strokes} strokes (${formatToPar(totals.toPar)})`
    : `Round: ${totals.strokes} strokes (${formatToPar(totals.toPar)}) after ${card.length} of ${HOLES_PER_ROUND}`;
  hud.resultNew.textContent = finished ? 'Start a new round' : 'Next hole';
  hud.result.hidden = false;
  $('result-new').focus();
}

let toastTimer = 0;
function toast(message: string): void {
  hud.toast.textContent = message;
  hud.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => hud.toast.classList.remove('show'), 2200);
}

// --- Input -----------------------------------------------------------------

const _v = new THREE.Vector3();

function ballScreenPosition(): { x: number; y: number; radius: number } {
  _v.copy(ball.position).project(camera);
  const x = (_v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
  const dist = camera.position.distanceTo(ball.position);
  const radius = (BALL_RADIUS / (dist * Math.tan(deg(camera.fov / 2)))) * (window.innerHeight / 2);
  return { x, y, radius };
}

function maxDragPixels(): number {
  return Math.min(260, Math.max(140, window.innerHeight * 0.3));
}

/** Pull-back aiming: the shot goes opposite to the drag from the ball, power scales with drag length. */
function updateAim(): void {
  const s = ballScreenPosition();
  const dx = aim.pointerX - s.x;
  const dy = aim.pointerY - s.y;
  const len = Math.hypot(dx, dy);
  aim.power = Math.min(1, len / maxDragPixels());
  if (len > 1e-3) {
    // Camera's horizontal basis: screen right/down mapped onto the ground.
    const fx = -Math.sin(rig.yaw);
    const fz = -Math.cos(rig.yaw);
    const dragX = -fz * dx - fx * dy;
    const dragZ = fx * dx - fz * dy;
    aim.dir.set(-dragX, 0, -dragZ).normalize();
    aim.path = Math.atan2(aim.dir.x * -fz + aim.dir.z * fx, aim.dir.x * fx + aim.dir.z * fz);
    // Past max draw/fade the arrow stops turning, showing the limit has been reached.
    if (clubIndex !== PUTTER && Math.abs(aim.path) > MAX_PATH_ANGLE) {
      aim.path = Math.sign(aim.path) * MAX_PATH_ANGLE;
      const c = Math.cos(aim.path);
      const sn = Math.sin(aim.path);
      aim.dir.set(fx * c - fz * sn, 0, fz * c + fx * sn);
    }
  }
}

const canvas = renderer.domElement;

canvas.addEventListener('pointerdown', (e) => {
  if (drag.mode) return;
  const s = ballScreenPosition();
  const nearBall = Math.hypot(e.clientX - s.x, e.clientY - s.y) < Math.max(30, s.radius * 2.5);
  if (e.button === 0 && state === 'ready' && nearBall) {
    drag.mode = 'aim';
    state = 'aiming';
    aim.pointerX = e.clientX;
    aim.pointerY = e.clientY;
    aim.power = 0;
    rig.yawGoal = null;
  } else if (e.button === 0 || e.button === 2) {
    drag.mode = 'orbit';
  } else {
    return;
  }
  drag.pointerId = e.pointerId;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== drag.pointerId) return;
  if (drag.mode === 'aim') {
    aim.pointerX = e.clientX;
    aim.pointerY = e.clientY;
  } else if (drag.mode === 'orbit') {
    rig.yaw -= (e.clientX - drag.lastX) * 0.006;
    rig.pitch = THREE.MathUtils.clamp(rig.pitch + (e.clientY - drag.lastY) * 0.004, 0.05, 1.45);
    rig.yawGoal = null;
  }
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
});

function endDrag(e: PointerEvent, cancelled: boolean): void {
  if (e.pointerId !== drag.pointerId) return;
  if (drag.mode === 'aim' && state === 'aiming') {
    updateAim();
    if (!cancelled && aim.power > 0.03) shoot();
    else state = 'ready';
  }
  drag.mode = null;
  drag.pointerId = -1;
}

canvas.addEventListener('pointerup', (e) => endDrag(e, false));
canvas.addEventListener('pointercancel', (e) => endDrag(e, true));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    rig.distance = THREE.MathUtils.clamp(rig.distance * Math.exp(e.deltaY * 0.0012), 2.5, 150);
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'escape' && state === 'aiming') {
    state = 'ready';
    drag.mode = null;
    drag.pointerId = -1;
  } else if (key === 'c' && (state === 'ready' || state === 'aiming')) {
    clubIndex = (clubIndex + 1) % CLUBS.length;
  } else if (key === 'n' || (key === 'enter' && state === 'won' && !hud.result.hidden)) {
    e.preventDefault();
    newHole();
  }
});

$('new-hole').addEventListener('click', newHole);
$('result-new').addEventListener('click', newHole);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Frame loop --------------------------------------------------------------

const _normal = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function updateCamera(dt: number): void {
  const follow = 1 - Math.exp(-dt * (ball.moving ? 5 : 8));
  rig.target.lerp(ball.position, follow);
  if (rig.yawGoal !== null) {
    const diff = Math.atan2(Math.sin(rig.yawGoal - rig.yaw), Math.cos(rig.yawGoal - rig.yaw));
    rig.yaw += diff * (1 - Math.exp(-dt * 3));
    if (Math.abs(diff) < 0.002) rig.yawGoal = null;
  }
  const cp = Math.cos(rig.pitch);
  camera.position.set(
    rig.target.x + Math.sin(rig.yaw) * cp * rig.distance,
    rig.target.y + Math.sin(rig.pitch) * rig.distance,
    rig.target.z + Math.cos(rig.yaw) * cp * rig.distance,
  );
  const minY = level.heightAt(camera.position.x, camera.position.z) + 0.4;
  if (camera.position.y < minY) camera.position.y = minY;
  camera.lookAt(rig.target.x, rig.target.y + 0.3, rig.target.z);
  sky.position.copy(camera.position);
  sun.position.copy(rig.target).add(SUN_OFFSET);
  sun.target.position.copy(rig.target);
}

function updateAimVisuals(time: number): void {
  const p = ball.position;
  readyRing.visible = state === 'ready';
  if (readyRing.visible) {
    level.normalAt(p.x, p.z, _normal);
    readyRing.position.set(p.x, p.y - BALL_RADIUS + 0.015, p.z);
    readyRing.quaternion.setFromUnitVectors(Z_AXIS, _normal);
    readyRing.scale.setScalar(1 + Math.sin(time * 4) * 0.12);
  }

  const aiming = state === 'aiming';
  arrow.visible = aiming && aim.power > 0.01;
  targetLine.visible = aiming && clubIndex !== PUTTER;
  hud.power.hidden = !aiming;
  hud.dragLine.style.visibility = aiming ? 'visible' : 'hidden';
  if (!aiming) return;

  updateAim();
  const club = CLUBS[clubIndex];
  const length = 0.6 + aim.power * 5;
  arrow.position.set(p.x, p.y + 0.05, p.z);
  arrow.rotation.set(-club.loft, Math.atan2(aim.dir.x, aim.dir.z), 0, 'YXZ');
  arrowShaft.scale.set(1, 1, length);
  arrowHead.position.set(0, 0, length);
  arrowMaterial.color.setHSL((1 - aim.power) * 0.33, 0.85, 0.55);

  hud.powerFill.style.width = `${aim.power * 100}%`;
  hud.powerLabel.textContent = clubIndex === PUTTER ? club.name : `${club.name} · ${shotShape()}`;
  targetLine.position.set(p.x, p.y, p.z);
  targetLine.rotation.y = rig.yaw + Math.PI;
  const s = ballScreenPosition();
  hud.dragLine.setAttribute('x1', String(s.x));
  hud.dragLine.setAttribute('y1', String(s.y));
  hud.dragLine.setAttribute('x2', String(aim.pointerX));
  hud.dragLine.setAttribute('y2', String(aim.pointerY));
}

/** Describes the wind relative to the line from the ball to the pin. */
function windRelativeLabel(): string {
  const w = level.wind;
  const speed = w.length();
  if (speed < 0.5) return 'Calm';
  const hx = level.hole.x - ball.position.x;
  const hz = level.hole.y - ball.position.z;
  const len = Math.hypot(hx, hz) || 1;
  const along = (w.x * hx + w.z * hz) / (len * speed);
  // Positive when the wind blows to the right of the pin line.
  const cross = (w.x * -hz + w.z * hx) / (len * speed);
  if (along > 0.75) return 'Helping';
  if (along < -0.75) return 'Into you';
  const side = cross > 0 ? 'left to right' : 'right to left';
  return along > 0.3 ? `Helping, ${side}` : along < -0.3 ? `Into, ${side}` : `Cross, ${side}`;
}

function updateWindIndicator(): void {
  const w = level.wind;
  // Rotate so "up" on the dial is the camera's view direction.
  const fx = -Math.sin(rig.yaw);
  const fz = -Math.cos(rig.yaw);
  const angle = Math.atan2(w.x * -fz + w.z * fx, w.x * fx + w.z * fz);
  hud.windArrow.setAttribute('transform', `rotate(${(angle * 180) / Math.PI})`);
  hud.windArrow.style.visibility = w.length() < 0.5 ? 'hidden' : 'visible';
  hud.windSpeed.textContent = `${w.length().toFixed(1)} m/s`;
  hud.windRelative.textContent = windRelativeLabel();
}

function shotShape(): string {
  const amount = Math.abs(aim.path) / MAX_PATH_ANGLE;
  if (amount < 0.06) return 'Straight';
  const shape = aim.path > 0 ? 'Draw' : 'Fade';
  // Sidespin stops growing past MAX_PATH_ANGLE.
  if (amount < 0.25) return `Slight ${shape.toLowerCase()}`;
  if (amount < 0.6) return shape;
  return amount < 0.95 ? `Big ${shape.toLowerCase()}` : `Max ${shape.toLowerCase()}`;
}

function updateHud(): void {
  updateWindIndicator();
  const d = distanceToPin();
  hud.toPin.textContent = state === 'won' ? 'In the hole' : `${d < 10 ? d.toFixed(1) : Math.round(d)} m`;
  hud.strokes.textContent = String(strokes);
  hud.club.textContent = CLUBS[clubIndex].name;
  const totals = roundTotals();
  hud.round.textContent = card.length ? `${totals.strokes} (${formatToPar(totals.toPar)})` : '–';
  hud.lie.textContent = ball.sunk ? 'Cup' : ball.moving ? '–' : LIE_NAMES[level.surfaceAt(ball.position.x, ball.position.z)];
}

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const time = now / 1000;

  if (ball.moving) {
    const event = ball.update(dt);
    if (event === 'sunk') {
      card.push({ par: level.par, strokes });
      state = 'won';
      wonTimer = 0.9;
    } else if (event === 'stopped' && state === 'flying') {
      onBallStopped();
    } else if (event === 'out' && state === 'flying') {
      strokes++;
      toast('Out of bounds · +1 stroke penalty');
      ball.placeAt(lastRest);
      onBallStopped();
    }
  }
  if (wonTimer > 0) {
    wonTimer -= dt;
    if (wonTimer <= 0) showResult();
  }

  ballMesh.position.copy(ball.position);
  ballMesh.quaternion.copy(ball.orientation);
  level.update(time);
  updateCamera(dt);
  updateAimVisuals(time);
  updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

startHole();
requestAnimationFrame(frame);
