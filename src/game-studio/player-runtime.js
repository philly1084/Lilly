import * as THREE from './vendor/three.module.js';

const canvas = document.querySelector('#game-canvas');
const loading = document.querySelector('#loading');
const errorOverlay = document.querySelector('#error-overlay');
const scoreValue = document.querySelector('#score-value');
const scoreTotal = document.querySelector('#score-total');
const healthValue = document.querySelector('#health-value');
const objective = document.querySelector('#objective');
const levelName = document.querySelector('#level-name');
const resetButton = document.querySelector('#reset-button');
const saveButton = document.querySelector('#save-button');
const statusPill = document.querySelector('#status-pill');
const touchButtons = [...document.querySelectorAll('[data-move-code]')];

let renderer;
let project;
let scene;
let camera;
let player;
let goal;
let levelDesign;
let levelRecipe;
let pickupCount = 0;
let totalPickups = 0;
let health = 3;
let won = false;
let hazardCooldown = 0;
let audioContext;
let fixedStep = 1 / 60;
let accumulator = 0;
const keys = new Set();
const touchKeys = new Set();
const touchPointers = new Map();
const pickups = [];
const hazards = [];
const obstacles = [];
const walkableAreas = [];
const particles = [];
const clock = new THREE.Clock();
const playerVelocity = new THREE.Vector3();
const playerSpawn = new THREE.Vector3();
const playerRadius = 0.44;

function component(entity, type) {
  return entity.components.find((entry) => entry.type === type && entry.enabled !== false) || null;
}

function vector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return new THREE.Vector3(
    Number(value?.x ?? fallback.x),
    Number(value?.y ?? fallback.y),
    Number(value?.z ?? fallback.z),
  );
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
    const roleGlow = entity.tags.includes('pickup') || entity.tags.includes('goal') || entity.tags.includes('hazard');
    object = new THREE.Mesh(geometry(mesh.data.geometry), new THREE.MeshStandardMaterial({
      color: material.color || '#8ea7c4',
      roughness: Number(material.roughness ?? 0.65),
      metalness: Number(material.metalness ?? 0.05),
      emissive: material.emissive || (roleGlow ? material.color || '#a78bfa' : '#000000'),
      emissiveIntensity: Number(material.emissiveIntensity ?? (roleGlow ? 0.42 : 0)),
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
    object = new THREE.PerspectiveCamera(
      Number(cameraComponent.data.fov || 58),
      innerWidth / innerHeight,
      Number(cameraComponent.data.near || 0.1),
      Number(cameraComponent.data.far || 1000),
    );
  }
  const transform = component(entity, 'Transform')?.data || {};
  object.position.copy(vector(transform.position));
  object.rotation.set(
    Number(transform.rotation?.x || 0),
    Number(transform.rotation?.y || 0),
    Number(transform.rotation?.z || 0),
  );
  object.scale.copy(vector(transform.scale, { x: 1, y: 1, z: 1 }));
  object.name = entity.name;
  object.userData.entityId = entity.id;
  object.userData.tags = entity.tags;
  object.userData.baseY = object.position.y;
  object.userData.baseScale = object.scale.clone();
  return object;
}

function registerCollisionRole(entity, object) {
  const collider = component(entity, 'Collider');
  if (!collider) return;
  const transform = component(entity, 'Transform')?.data || {};
  const size = vector(collider.data.size, transform.scale || { x: 1, y: 1, z: 1 });
  if (entity.tags.includes('ground')) {
    walkableAreas.push({
      minX: object.position.x - size.x / 2,
      maxX: object.position.x + size.x / 2,
      minZ: object.position.z - size.z / 2,
      maxZ: object.position.z + size.z / 2,
    });
  }
  if (collider.data.sensor !== true && (entity.tags.includes('wall') || entity.tags.includes('obstacle'))) {
    obstacles.push({
      minX: object.position.x - size.x / 2,
      maxX: object.position.x + size.x / 2,
      minZ: object.position.z - size.z / 2,
      maxZ: object.position.z + size.z / 2,
    });
  }
  if (entity.tags.includes('hazard')) hazards.push({ object, radius: Math.max(0.6, size.x / 2) });
}

function setupScene() {
  const sceneData = project.scenes.find((entry) => entry.id === project.entryScene);
  if (!sceneData) throw new Error('Entry scene is missing');
  levelDesign = (project.generatedLevels || []).find((entry) => entry.sceneId === sceneData.id) || null;
  levelRecipe = levelDesign
    ? (project.levelRecipes || []).find((entry) => entry.id === levelDesign.recipeId) || null
    : null;
  fixedStep = 1 / Math.max(1, Math.min(240, Number(project.settings?.fixedStepHz || 60)));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(sceneData.environment.background || '#081018');
  if (sceneData.environment.fog) {
    scene.fog = new THREE.Fog(
      sceneData.environment.fog.color,
      sceneData.environment.fog.near,
      sceneData.environment.fog.far,
    );
  }
  scene.add(new THREE.HemisphereLight(
    '#d8ecff',
    '#101923',
    Number(sceneData.environment.ambientIntensity || 0.5),
  ));
  const objectMap = new Map();
  sceneData.entities
    .filter((entity) => entity.enabled !== false)
    .forEach((entity) => objectMap.set(entity.id, makeObject(entity)));
  sceneData.entities.forEach((entity) => {
    const object = objectMap.get(entity.id);
    if (!object) return;
    const parent = entity.parentId ? objectMap.get(entity.parentId) : null;
    (parent || scene).add(object);
    if (entity.tags.includes('player')) player = object;
    if (entity.tags.includes('pickup')) pickups.push(object);
    if (entity.tags.includes('goal')) goal = object;
    if (component(entity, 'Camera')?.data.primary === true) camera = object;
    registerCollisionRole(entity, object);
  });
  totalPickups = pickups.length;
  if (!player) throw new Error('A playable build requires one entity tagged player');
  playerSpawn.copy(levelDesign ? vector(levelDesign.spawn.position) : player.position);
  if (!(camera instanceof THREE.Camera)) {
    camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 1000);
    scene.add(camera);
  }
  camera.position.set(playerSpawn.x + 7, playerSpawn.y + 7, playerSpawn.z + 11);
  camera.lookAt(player.position);
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  scoreTotal.textContent = String(totalPickups);
  levelName.textContent = levelRecipe?.name || project.name;
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
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.2);
  } catch (_error) {
    // Audio is a presentation capability and may be unavailable until a gesture.
  }
}

function burst(position, color) {
  for (let index = 0; index < 18; index += 1) {
    const particle = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 6),
      new THREE.MeshBasicMaterial({ color }),
    );
    particle.position.copy(position);
    particle.userData.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 5,
      Math.random() * 4,
      (Math.random() - 0.5) * 5,
    );
    particle.userData.life = 0.65;
    scene.add(particle);
    particles.push(particle);
  }
}

function updateParticles(delta) {
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index];
    particle.userData.life -= delta;
    particle.userData.velocity.y -= 7 * delta;
    particle.position.addScaledVector(particle.userData.velocity, delta);
    particle.scale.setScalar(Math.max(0.01, particle.userData.life));
    if (particle.userData.life <= 0) {
      particle.removeFromParent();
      particle.geometry.dispose();
      particle.material.dispose();
      particles.splice(index, 1);
    }
  }
}

function updateObjective() {
  if (won) {
    objective.textContent = 'Expedition complete. Seeded level '
      + (levelDesign?.checksum || 'verified')
      + ' cleared.';
    statusPill.textContent = 'Victory';
    statusPill.dataset.state = 'success';
    return;
  }
  const requiresPickups = levelRecipe?.objective !== 'reach-exit';
  const remaining = Math.max(0, totalPickups - pickupCount);
  if (requiresPickups && remaining > 0) {
    objective.textContent = 'Recover ' + remaining + ' energy core'
      + (remaining === 1 ? '' : 's')
      + ', then find the exit.';
  } else {
    objective.textContent = 'Exit unlocked. Follow the beacon to finish the level.';
  }
  statusPill.textContent = 'Playing';
  statusPill.dataset.state = 'playing';
}

function collectPickups() {
  pickups.forEach((pickup) => {
    if (!pickup.visible || pickup.position.distanceTo(player.position) >= 1.2) return;
    pickup.visible = false;
    pickupCount += 1;
    scoreValue.textContent = String(pickupCount);
    burst(pickup.position, pickup.material?.color || '#a78bfa');
    playTone(520 + pickupCount * 70);
    updateObjective();
  });
}

function evaluateGoal() {
  if (!goal || won || goal.position.distanceTo(player.position) >= 1.45) return;
  const requiresPickups = levelRecipe?.objective !== 'reach-exit';
  if (requiresPickups && pickupCount < totalPickups) {
    statusPill.textContent = String(totalPickups - pickupCount) + ' cores remain';
    statusPill.dataset.state = 'warning';
    return;
  }
  won = true;
  burst(goal.position, goal.material?.color || '#38bdf8');
  playTone(880);
  updateObjective();
}

function onWalkableGround(x, z) {
  if (!walkableAreas.length) {
    const bounds = levelDesign?.bounds;
    return !bounds || (
      x >= bounds.min.x
      && x <= bounds.max.x
      && z >= bounds.min.z
      && z <= bounds.max.z
    );
  }
  return walkableAreas.some((area) => (
    x >= area.minX - 0.18
    && x <= area.maxX + 0.18
    && z >= area.minZ - 0.18
    && z <= area.maxZ + 0.18
  ));
}

function hitsObstacle(x, z) {
  return obstacles.some((box) => (
    x + playerRadius > box.minX
    && x - playerRadius < box.maxX
    && z + playerRadius > box.minZ
    && z - playerRadius < box.maxZ
  ));
}

function movePlayer(deltaX, deltaZ) {
  const nextX = player.position.x + deltaX;
  if (onWalkableGround(nextX, player.position.z) && !hitsObstacle(nextX, player.position.z)) {
    player.position.x = nextX;
  } else {
    playerVelocity.x = 0;
  }
  const nextZ = player.position.z + deltaZ;
  if (onWalkableGround(player.position.x, nextZ) && !hitsObstacle(player.position.x, nextZ)) {
    player.position.z = nextZ;
  } else {
    playerVelocity.z = 0;
  }
}

function pressed(code) {
  return keys.has(code) || touchKeys.has(code);
}

function takeDamage() {
  if (hazardCooldown > 0 || won) return;
  hazardCooldown = 1.25;
  health -= 1;
  healthValue.textContent = String(health);
  playTone(180);
  if (health <= 0) {
    reset(true);
    statusPill.textContent = 'Run reset';
    statusPill.dataset.state = 'warning';
    return;
  }
  player.position.copy(playerSpawn);
  playerVelocity.set(0, 0, 0);
  statusPill.textContent = 'Pulse hit';
  statusPill.dataset.state = 'warning';
}

function simulate(delta) {
  hazardCooldown = Math.max(0, hazardCooldown - delta);
  const input = new THREE.Vector3(
    Number(pressed('KeyD')) - Number(pressed('KeyA')),
    0,
    Number(pressed('KeyS')) - Number(pressed('KeyW')),
  );
  if (input.lengthSq() > 0) input.normalize();
  const speed = 5.8 + Number(levelRecipe?.gameplay?.difficulty || 2) * 0.08;
  playerVelocity.x = THREE.MathUtils.damp(playerVelocity.x, input.x * speed, 10, delta);
  playerVelocity.z = THREE.MathUtils.damp(playerVelocity.z, input.z * speed, 10, delta);
  movePlayer(playerVelocity.x * delta, playerVelocity.z * delta);
  if (input.lengthSq() > 0) player.rotation.y = Math.atan2(input.x, input.z);
  collectPickups();
  hazards.forEach((hazard) => {
    if (hazard.object.position.distanceTo(player.position) < hazard.radius + playerRadius) takeDamage();
  });
  evaluateGoal();
}

function animateWorld(elapsed, delta) {
  pickups.forEach((pickup, index) => {
    if (!pickup.visible) return;
    pickup.rotation.y = elapsed * 1.8 + index * 0.3;
    pickup.position.y = pickup.userData.baseY + Math.sin(elapsed * 2.2 + index) * 0.12;
  });
  hazards.forEach((hazard, index) => {
    hazard.object.rotation.y = elapsed * (0.7 + (index % 3) * 0.08);
    const pulse = 1 + Math.sin(elapsed * 4 + index) * 0.07;
    hazard.object.scale.x = hazard.object.userData.baseScale.x * pulse;
    hazard.object.scale.z = hazard.object.userData.baseScale.z * pulse;
  });
  if (goal) {
    goal.rotation.y += delta * 0.85;
    goal.rotation.x = Math.sin(elapsed * 0.7) * 0.12;
  }
  const targetCamera = new THREE.Vector3(
    player.position.x + 6.5,
    player.position.y + 6.2,
    player.position.z + 8.5,
  );
  camera.position.lerp(targetCamera, 1 - Math.pow(0.0004, delta));
  camera.lookAt(player.position.x, player.position.y + 0.7, player.position.z);
}

function frame() {
  const delta = Math.min(0.05, clock.getDelta());
  accumulator = Math.min(0.25, accumulator + delta);
  let steps = 0;
  while (accumulator + Number.EPSILON >= fixedStep && steps < 8) {
    simulate(fixedStep);
    accumulator -= fixedStep;
    steps += 1;
  }
  if (steps === 8) accumulator = 0;
  animateWorld(clock.elapsedTime, delta);
  updateParticles(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function reset(fullReset = true) {
  player.position.copy(playerSpawn);
  playerVelocity.set(0, 0, 0);
  health = 3;
  won = false;
  hazardCooldown = 0.8;
  if (fullReset) {
    pickupCount = 0;
    pickups.forEach((pickup) => { pickup.visible = true; });
  }
  scoreValue.textContent = String(pickupCount);
  healthValue.textContent = String(health);
  updateObjective();
}

function saveSnapshot() {
  return {
    schema: 'LillyPlayerSave/v1',
    levelChecksum: levelDesign?.checksum || '',
    position: player.position.toArray(),
    pickupCount,
    hidden: pickups.map((pickup) => !pickup.visible),
    health,
    won,
  };
}

function applySaveSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.position) || snapshot.position.length !== 3) return false;
  if (
    snapshot.levelChecksum
    && levelDesign?.checksum
    && snapshot.levelChecksum !== levelDesign.checksum
  ) return false;
  player.position.fromArray(snapshot.position.map(Number));
  pickupCount = Math.max(0, Math.min(totalPickups, Number(snapshot.pickupCount) || 0));
  health = Math.max(1, Math.min(3, Number(snapshot.health) || 3));
  pickups.forEach((pickup, index) => { pickup.visible = !Boolean(snapshot.hidden?.[index]); });
  const requiresPickups = levelRecipe?.objective !== 'reach-exit';
  won = snapshot.won === true && (!requiresPickups || pickupCount >= totalPickups);
  scoreValue.textContent = String(pickupCount);
  healthValue.textContent = String(health);
  updateObjective();
  return true;
}

function storageBridge(type, state) {
  const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  window.top.postMessage({
    schema: 'LillyPlayerStorage/v1',
    type,
    requestId,
    projectId: project.id,
    state,
  }, '*');
  return requestId;
}

function restoreSave() {
  try {
    const stored = localStorage.getItem('lilly:' + project.id + ':save');
    if (stored) applySaveSnapshot(JSON.parse(stored));
  } catch (_error) {
    storageBridge('load');
  }
}

function save() {
  const snapshot = saveSnapshot();
  try {
    localStorage.setItem('lilly:' + project.id + ':save', JSON.stringify(snapshot));
    statusPill.textContent = 'Saved';
    setTimeout(updateObjective, 900);
  } catch (_error) {
    storageBridge('save', snapshot);
    statusPill.textContent = 'Saving...';
  }
}

function setupTouchControls() {
  touchButtons.forEach((button) => {
    const code = button.dataset.moveCode;
      const press = (event) => {
        event.preventDefault();
        try { button.setPointerCapture?.(event.pointerId); } catch (_error) { /* The pointer may already have been interrupted. */ }
        touchPointers.set(event.pointerId, code);
      touchKeys.add(code);
      button.dataset.pressed = 'true';
    };
    const release = (event) => {
      const releasedCode = touchPointers.get(event.pointerId) || code;
      touchPointers.delete(event.pointerId);
      if (![...touchPointers.values()].includes(releasedCode)) touchKeys.delete(releasedCode);
      button.dataset.pressed = 'false';
    };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  });
}

function resize() {
  if (!renderer || !camera) return;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setSize(innerWidth, innerHeight, false);
  if (camera.isPerspectiveCamera) {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
}

function showRuntimeError(error) {
  loading.hidden = true;
  errorOverlay.hidden = false;
  errorOverlay.querySelector('strong').textContent = error.message;
  console.error('[LillyPlayer]', error);
}

window.addEventListener('keydown', (event) => {
  keys.add(event.code);
  if (event.code === 'KeyR') reset(true);
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => {
  keys.clear();
  touchKeys.clear();
  touchPointers.clear();
});
window.addEventListener('resize', resize);
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.schema !== 'LillyPlayerStorage/v1' || message.projectId !== project?.id) return;
  if (message.type === 'load-result' && message.ok && message.state) applySaveSnapshot(message.state);
  if (message.type === 'save-result') {
    statusPill.textContent = message.ok ? 'Saved' : 'Save unavailable';
    if (message.ok) setTimeout(updateObjective, 900);
  }
});
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  showRuntimeError(new Error('WebGL context was lost. Reload to resume the generated level.'));
});
resetButton.addEventListener('click', () => reset(true));
saveButton.addEventListener('click', save);

function runControlTest() {
  const originalPosition = player.position.clone();
  const originalVelocity = playerVelocity.clone();
  const candidates = ['KeyD', 'KeyA', 'KeyS', 'KeyW'];
  let moved = 0;
  let used = '';
  let after = originalPosition.toArray();
  for (const code of candidates) {
    player.position.copy(originalPosition);
    playerVelocity.set(0, 0, 0);
    keys.add(code);
    for (let step = 0; step < 8; step += 1) simulate(fixedStep);
    keys.delete(code);
    moved = player.position.distanceTo(originalPosition);
    after = player.position.toArray();
    if (moved > 0.02) {
      used = code;
      break;
    }
  }
  player.position.copy(originalPosition);
  playerVelocity.copy(originalVelocity);
  return {
    passed: moved > 0.02,
    before: originalPosition.toArray(),
    after,
    moved,
    input: used,
    checksum: levelDesign?.checksum || null,
  };
}

async function start() {
  try {
    project = await fetch('./project.json').then((response) => {
      if (!response.ok) throw new Error('Project data failed to load');
      return response.json();
    });
    setupScene();
    setupTouchControls();
    reset(true);
    restoreSave();
    loading.hidden = true;
    window.__LILLY_GAME__ = {
      schema: 'LillyPlayerDebug/v1',
      getState: () => ({
        pickupCount,
        totalPickups,
        health,
        won,
        playerPosition: player.position.toArray(),
        levelChecksum: levelDesign?.checksum || null,
        roomCount: levelDesign?.metrics?.roomCount || 0,
      }),
      controlTest: runControlTest,
      reset: () => reset(true),
    };
    frame();
  } catch (error) {
    showRuntimeError(error);
  }
}

start();
