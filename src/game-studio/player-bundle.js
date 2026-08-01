'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PLAYER_JAVASCRIPT = String.raw`import * as THREE from './vendor/three.module.js';

const canvas = document.querySelector('#game-canvas');
const loading = document.querySelector('#loading');
const errorOverlay = document.querySelector('#error-overlay');
const scoreValue = document.querySelector('#score-value');
const objective = document.querySelector('#objective');
const resetButton = document.querySelector('#reset-button');
const saveButton = document.querySelector('#save-button');
const statusPill = document.querySelector('#status-pill');

let renderer;
let project;
let scene;
let camera;
let player;
let pickupCount = 0;
let totalPickups = 0;
let won = false;
let audioContext;
const keys = new Set();
const pickups = [];
const particles = [];
const clock = new THREE.Clock();
const playerVelocity = new THREE.Vector3();

function component(entity, type) {
  return entity.components.find((entry) => entry.type === type && entry.enabled !== false) || null;
}

function vector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return new THREE.Vector3(Number(value?.x ?? fallback.x), Number(value?.y ?? fallback.y), Number(value?.z ?? fallback.z));
}

function geometry(kind = 'box') {
  if (kind === 'sphere') return new THREE.SphereGeometry(0.5, 24, 18);
  if (kind === 'capsule') return new THREE.CapsuleGeometry(0.45, 0.7, 8, 16);
  if (kind === 'cylinder') return new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  if (kind === 'octahedron') return new THREE.OctahedronGeometry(0.7, 0);
  if (kind === 'torus') return new THREE.TorusGeometry(0.6, 0.16, 16, 48);
  return new THREE.BoxGeometry(1, 1, 1);
}

function makeObject(entity) {
  const mesh = component(entity, 'MeshRenderer');
  const light = component(entity, 'Light');
  const cameraComponent = component(entity, 'Camera');
  let object = new THREE.Group();
  if (mesh) {
    const material = mesh.data.material || {};
    object = new THREE.Mesh(geometry(mesh.data.geometry), new THREE.MeshStandardMaterial({
      color: material.color || '#8ea7c4',
      roughness: Number(material.roughness ?? 0.65),
      metalness: Number(material.metalness ?? 0.05),
      emissive: entity.tags.includes('pickup') ? material.color || '#a78bfa' : '#000000',
      emissiveIntensity: entity.tags.includes('pickup') ? 0.45 : 0,
    }));
    object.castShadow = mesh.data.castShadow !== false;
    object.receiveShadow = mesh.data.receiveShadow !== false;
  } else if (light) {
    const color = light.data.color || '#ffffff';
    const intensity = Number(light.data.intensity || 1);
    object = light.data.kind === 'point'
      ? new THREE.PointLight(color, intensity, Number(light.data.range || 20))
      : new THREE.DirectionalLight(color, intensity);
    object.castShadow = light.data.castShadow !== false;
  } else if (cameraComponent) {
    object = new THREE.PerspectiveCamera(Number(cameraComponent.data.fov || 58), innerWidth / innerHeight, Number(cameraComponent.data.near || 0.1), Number(cameraComponent.data.far || 1000));
  }
  const transform = component(entity, 'Transform')?.data || {};
  object.position.copy(vector(transform.position));
  object.rotation.set(Number(transform.rotation?.x || 0), Number(transform.rotation?.y || 0), Number(transform.rotation?.z || 0));
  object.scale.copy(vector(transform.scale, { x: 1, y: 1, z: 1 }));
  object.name = entity.name;
  object.userData.entityId = entity.id;
  object.userData.tags = entity.tags;
  return object;
}

function setupScene() {
  const sceneData = project.scenes.find((entry) => entry.id === project.entryScene);
  if (!sceneData) throw new Error('Entry scene is missing');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(sceneData.environment.background || '#081018');
  if (sceneData.environment.fog) scene.fog = new THREE.Fog(sceneData.environment.fog.color, sceneData.environment.fog.near, sceneData.environment.fog.far);
  scene.add(new THREE.HemisphereLight('#d8ecff', '#101923', Number(sceneData.environment.ambientIntensity || 0.5)));
  const objectMap = new Map();
  sceneData.entities.filter((entity) => entity.enabled !== false).forEach((entity) => objectMap.set(entity.id, makeObject(entity)));
  sceneData.entities.forEach((entity) => {
    const object = objectMap.get(entity.id);
    if (!object) return;
    const parent = entity.parentId ? objectMap.get(entity.parentId) : null;
    (parent || scene).add(object);
    if (entity.tags.includes('player')) player = object;
    if (entity.tags.includes('pickup')) pickups.push(object);
    if (component(entity, 'Camera')?.data.primary === true) camera = object;
  });
  totalPickups = pickups.length;
  if (!player) throw new Error('A playable build requires one entity tagged player');
  if (!(camera instanceof THREE.Camera)) {
    camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 1000);
    scene.add(camera);
  }
  camera.position.set(7, 7, 11);
  camera.lookAt(player.position);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  resize();
}

function playTone(frequency = 520) {
  try {
    audioContext ||= new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';
    gain.gain.setValueAtTime(0.08, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.18);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + 0.2);
  } catch (_) {}
}

function burst(position, color) {
  for (let index = 0; index < 18; index += 1) {
    const particle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color }));
    particle.position.copy(position);
    particle.userData.velocity = new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5);
    particle.userData.life = 0.65;
    scene.add(particle); particles.push(particle);
  }
}

function updateParticles(delta) {
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index];
    particle.userData.life -= delta;
    particle.userData.velocity.y -= 7 * delta;
    particle.position.addScaledVector(particle.userData.velocity, delta);
    particle.scale.setScalar(Math.max(0.01, particle.userData.life));
    if (particle.userData.life <= 0) { particle.removeFromParent(); particles.splice(index, 1); }
  }
}

function collectPickups(elapsed) {
  pickups.forEach((pickup) => {
    if (!pickup.visible) return;
    pickup.rotation.y = elapsed * 1.8;
    pickup.position.y += Math.sin(elapsed * 2.2 + pickup.position.x) * 0.002;
    if (pickup.position.distanceTo(player.position) < 1.25) {
      pickup.visible = false;
      pickupCount += 1;
      scoreValue.textContent = String(pickupCount);
      burst(pickup.position, pickup.material?.color || '#a78bfa');
      playTone(520 + pickupCount * 90);
      if (pickupCount >= totalPickups) {
        won = true;
        objective.textContent = 'Arena secured — Blueprint win condition passed.';
        statusPill.textContent = 'Victory';
        statusPill.dataset.state = 'success';
        playTone(880);
      } else objective.textContent = String(totalPickups - pickupCount) + ' energy shards remain';
    }
  });
}

function simulate(delta) {
  const input = new THREE.Vector3(Number(keys.has('KeyD')) - Number(keys.has('KeyA')), 0, Number(keys.has('KeyS')) - Number(keys.has('KeyW')));
  if (input.lengthSq() > 0) input.normalize();
  playerVelocity.x = THREE.MathUtils.damp(playerVelocity.x, input.x * 6, 10, delta);
  playerVelocity.z = THREE.MathUtils.damp(playerVelocity.z, input.z * 6, 10, delta);
  player.position.addScaledVector(playerVelocity, delta);
  player.position.x = THREE.MathUtils.clamp(player.position.x, -8.1, 8.1);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -8.1, 8.1);
  if (input.lengthSq() > 0) player.rotation.y = Math.atan2(input.x, input.z);
  const targetCamera = new THREE.Vector3(player.position.x + 6.5, player.position.y + 6.2, player.position.z + 8.5);
  camera.position.lerp(targetCamera, 1 - Math.pow(0.0004, delta));
  camera.lookAt(player.position.x, player.position.y + 0.7, player.position.z);
}

function frame() {
  const delta = Math.min(0.05, clock.getDelta());
  const elapsed = clock.elapsedTime;
  simulate(delta);
  collectPickups(elapsed);
  updateParticles(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function reset() {
  player.position.set(0, 0.65, 5);
  playerVelocity.set(0, 0, 0);
  pickupCount = 0; won = false;
  pickups.forEach((pickup) => { pickup.visible = true; });
  scoreValue.textContent = '0';
  objective.textContent = 'Collect all ' + totalPickups + ' energy shards';
  statusPill.textContent = 'Playing'; statusPill.dataset.state = 'playing';
}

function saveSnapshot() {
  return { position: player.position.toArray(), pickupCount, hidden: pickups.map((pickup) => !pickup.visible), won };
}

function applySaveSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.position) || snapshot.position.length !== 3) return false;
  player.position.fromArray(snapshot.position.map(Number));
  pickupCount = Math.max(0, Math.min(totalPickups, Number(snapshot.pickupCount) || 0));
  pickups.forEach((pickup, index) => { pickup.visible = !Boolean(snapshot.hidden?.[index]); });
  won = snapshot.won === true && pickupCount >= totalPickups;
  scoreValue.textContent = String(pickupCount);
  objective.textContent = won ? 'Arena secured — Blueprint win condition passed.' : String(totalPickups - pickupCount) + ' energy shards remain';
  statusPill.textContent = won ? 'Victory' : 'Playing';
  statusPill.dataset.state = won ? 'success' : 'playing';
  return true;
}

function storageBridge(type, state) {
  const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  window.top.postMessage({ schema: 'LillyPlayerStorage/v1', type, requestId, projectId: project.id, state }, '*');
  return requestId;
}

function restoreSave() {
  try {
    const stored = localStorage.getItem('lilly:' + project.id + ':save');
    if (stored) applySaveSnapshot(JSON.parse(stored));
  } catch (_) {
    storageBridge('load');
  }
}

function save() {
  const snapshot = saveSnapshot();
  try {
    localStorage.setItem('lilly:' + project.id + ':save', JSON.stringify(snapshot));
    statusPill.textContent = 'Saved'; setTimeout(() => { statusPill.textContent = won ? 'Victory' : 'Playing'; }, 900);
  } catch (_) {
    storageBridge('save', snapshot);
    statusPill.textContent = 'Saving…';
  }
}

function resize() {
  if (!renderer || !camera) return;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setSize(innerWidth, innerHeight, false);
  if (camera.isPerspectiveCamera) { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
}

window.addEventListener('keydown', (event) => { keys.add(event.code); if (event.code === 'KeyR') reset(); });
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('resize', resize);
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.schema !== 'LillyPlayerStorage/v1' || message.projectId !== project?.id) return;
  if (message.type === 'load-result' && message.ok && message.state) applySaveSnapshot(message.state);
  if (message.type === 'save-result') {
    statusPill.textContent = message.ok ? 'Saved' : 'Save unavailable';
    if (message.ok) setTimeout(() => { statusPill.textContent = won ? 'Victory' : 'Playing'; }, 900);
  }
});
resetButton.addEventListener('click', reset);
saveButton.addEventListener('click', save);

async function start() {
  try {
    project = await fetch('./project.json').then((response) => {
      if (!response.ok) throw new Error('Project data failed to load');
      return response.json();
    });
    setupScene();
    reset();
    restoreSave();
    loading.hidden = true;
    window.__LILLY_GAME__ = {
      schema: 'LillyPlayerDebug/v1',
      getState: () => ({ pickupCount, totalPickups, won, playerPosition: player.position.toArray() }),
      controlTest: () => {
        const before = player.position.x;
        keys.add('KeyD'); simulate(1 / 30); keys.delete('KeyD');
        return { passed: player.position.x > before, before, after: player.position.x };
      },
      reset,
    };
    frame();
  } catch (error) {
    loading.hidden = true;
    errorOverlay.hidden = false;
    errorOverlay.querySelector('strong').textContent = error.message;
    console.error('[LillyPlayer]', error);
  }
}

start();
`;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function buildIndexHtml(project) {
  const title = escapeHtml(project.name || 'Lilly Game');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" href="data:," />
  <title>${title}</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#05090e;color:#edf7ff}
    *{box-sizing:border-box}html,body,#game-canvas{width:100%;height:100%;margin:0;overflow:hidden}#game-canvas{display:block;background:#081018}
    .hud{position:fixed;inset:0;pointer-events:none;padding:clamp(14px,2vw,24px);display:flex;flex-direction:column;justify-content:space-between}
    .hud-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.panel{background:rgba(7,15,23,.84);border:1px solid rgba(125,211,252,.22);box-shadow:0 18px 60px rgba(0,0,0,.28);backdrop-filter:blur(12px);border-radius:12px;padding:12px 14px}
    .eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#7dd3fc}.score{font-size:28px;font-weight:760;line-height:1;margin-top:3px}.objective{max-width:min(70vw,440px);font-size:13px;color:#c9d8e6;margin-top:5px}
    .status{font-size:11px;font-weight:700;color:#7dd3fc;border:1px solid currentColor;border-radius:999px;padding:7px 10px}.status[data-state=success]{color:#6ee7b7}
    .controls{pointer-events:auto;display:flex;align-items:center;gap:8px}.controls span{font-size:11px;color:#9fb2c4;margin-right:6px}.controls button{border:1px solid #314657;background:#101b25;color:#edf7ff;border-radius:8px;padding:8px 11px;font:inherit;cursor:pointer}.controls button:hover{border-color:#38bdf8;background:#14283a}
    .loading,.error{position:fixed;inset:0;display:grid;place-items:center;background:#071018;z-index:5}.loading[hidden],.error[hidden]{display:none}.loading-card,.error-card{width:min(420px,calc(100vw - 32px));padding:24px;border:1px solid #24394a;border-radius:14px;background:#0c1721;box-shadow:0 28px 80px rgba(0,0,0,.45)}
    .spinner{width:26px;height:26px;border:2px solid #274254;border-top-color:#38bdf8;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}@keyframes spin{to{transform:rotate(360deg)}}
    @media(max-width:600px){.hud-row{flex-direction:column}.hud-row .status{align-self:flex-end;position:absolute;right:14px}.controls span{display:none}.panel{max-width:calc(100vw - 28px)}}
  </style>
</head>
<body>
  <canvas id="game-canvas" aria-label="${title} game viewport"></canvas>
  <div class="hud">
    <div class="hud-row">
      <div class="panel"><div class="eyebrow">Energy recovered</div><div class="score"><span id="score-value">0</span> / 3</div><div class="objective" id="objective">Collect all energy shards</div></div>
      <div class="status" id="status-pill" data-state="playing">Playing</div>
    </div>
    <div class="controls panel"><span>WASD to move · R to reset</span><button id="save-button" type="button">Save</button><button id="reset-button" type="button">Reset</button></div>
  </div>
  <div id="loading" class="loading"><div class="loading-card"><div class="spinner"></div><strong>Loading ${title}</strong><p>Preparing Lilly Engine runtime…</p></div></div>
  <div id="error-overlay" class="error" hidden><div class="error-card"><div class="eyebrow">Runtime error</div><h1>Game could not start</h1><strong>Unknown error</strong><p>Open the build output in Lilly Game Studio for details.</p></div></div>
  <script type="module" src="./player.js"></script>
</body>
</html>`;
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
  };
}

async function writeImmutableBuild({ directory, project, graphIr }) {
  await fs.mkdir(directory, { recursive: false });
  const threeBuildDirectory = path.dirname(require.resolve('three'));
  const [threeModule, threeCore] = await Promise.all([
    fs.readFile(path.join(threeBuildDirectory, 'three.module.js'), 'utf8'),
    fs.readFile(path.join(threeBuildDirectory, 'three.core.js'), 'utf8'),
  ]);
  const files = [
    ['index.html', buildIndexHtml(project)],
    ['player.js', PLAYER_JAVASCRIPT],
    ['vendor/three.module.js', threeModule],
    ['vendor/three.core.js', threeCore],
    ['project.json', `${JSON.stringify(project, null, 2)}\n`],
    ['blueprints.json', `${JSON.stringify(graphIr, null, 2)}\n`],
    ['build-manifest.json', `${JSON.stringify({ schema: 'LillyPlayerBundle/v1', projectId: project.id, revision: project.revision, engineVersion: project.engineVersion, generatedAt: new Date().toISOString() }, null, 2)}\n`],
  ];
  for (const [relativePath, content] of files) {
    const targetPath = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
  }
  return Promise.all(files.map(async ([relativePath]) => ({ path: relativePath, ...await hashFile(path.join(directory, relativePath)) })));
}

module.exports = {
  PLAYER_JAVASCRIPT,
  buildIndexHtml,
  writeImmutableBuild,
};
