import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GAMEPLAY_MAX_FRAME_DELTA_SECONDS, GameplaySimulation, scheduleGameplaySteps } from './gameplay.js';

const canvas = document.querySelector('#game-canvas');
const loading = document.querySelector('#loading');
const errorOverlay = document.querySelector('#error-overlay');
const scoreValue = document.querySelector('#score-value');
const scoreTotal = document.querySelector('#score-total');
const healthValue = document.querySelector('#health-value');
const enemyValue = document.querySelector('#enemy-value');
const objective = document.querySelector('#objective');
const levelName = document.querySelector('#level-name');
const resetButton = document.querySelector('#reset-button');
const saveButton = document.querySelector('#save-button');
const attackButton = document.querySelector('#attack-button');
const statusPill = document.querySelector('#status-pill');
const touchButtons = [...document.querySelectorAll('[data-move-code]')];

let renderer;
let project;
let scene;
let camera;
let player;
let goal;
let gameplay;
let gameplayState;
let levelDesign;
let levelRecipe;
let pickupCount = 0;
let totalPickups = 0;
let won = false;
let hazardCooldown = 0;
let attackHeld = false;
let audioContext;
let fixedStep = 1 / 60;
let accumulator = 0;
const keys = new Set();
const touchKeys = new Set();
const touchActions = new Set();
const touchPointers = new Map();
const pickups = [];
const hazards = [];
const obstacles = [];
const walkableAreas = [];
const particles = [];
const objectMap = new Map();
const enemyObjects = new Map();
const gateObjects = new Map();
const checkpointObjects = new Map();
const clock = new THREE.Clock();
const playerVelocity = new THREE.Vector3();
const playerSpawn = new THREE.Vector3();
const playerRadius = 0.44;
const gltfLoader = new GLTFLoader();

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
    if (mesh.data.assetId) {
      object.userData.assetId = String(mesh.data.assetId);
    } else {
      const material = mesh.data.material || {};
      const roleGlow = ['pickup', 'goal', 'hazard', 'enemy', 'encounter-gate', 'checkpoint']
        .some((tag) => entity.tags.includes(tag));
      object = new THREE.Mesh(geometry(mesh.data.geometry), new THREE.MeshStandardMaterial({
        color: material.color || '#8ea7c4',
        roughness: Number(material.roughness ?? 0.65),
        metalness: Number(material.metalness ?? 0.05),
        emissive: material.emissive || (roleGlow ? material.color || '#a78bfa' : '#000000'),
        emissiveIntensity: Number(material.emissiveIntensity ?? (roleGlow ? 0.42 : 0)),
      }));
      object.castShadow = mesh.data.castShadow !== false;
      object.receiveShadow = mesh.data.receiveShadow !== false;
    }
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
  object.userData.attackPulse = 0;
  return object;
}

async function loadAssetObject(entity, object) {
  const assetId = object.userData.assetId;
  if (!assetId) return;
  const asset = (project.assets || []).find((entry) => entry.id === assetId);
  if (!asset || !String(asset.uri || '').startsWith('assets/')) throw new Error(`Asset ${assetId} is unavailable for ${entity.name}`);
  if (!/\.glb$/i.test(asset.uri) && !/gltf|model/i.test(String(asset.type || ''))) throw new Error(`Asset ${asset.name} is not a supported GLB model`);
  const gltf = await gltfLoader.loadAsync(`./${asset.uri}`);
  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = component(entity, 'MeshRenderer')?.data.castShadow !== false;
    child.receiveShadow = component(entity, 'MeshRenderer')?.data.receiveShadow !== false;
  });
  object.add(gltf.scene);
  object.userData.animations = gltf.animations || [];
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
      entityId: entity.id,
      gateId: entity.tags.includes('encounter-gate') ? entity.id : null,
      minX: object.position.x - size.x / 2,
      maxX: object.position.x + size.x / 2,
      minZ: object.position.z - size.z / 2,
      maxZ: object.position.z + size.z / 2,
    });
  }
  if (entity.tags.includes('hazard')) hazards.push({ object, radius: Math.max(0.6, size.x / 2) });
}

async function setupScene() {
  const sceneData = project.scenes.find((entry) => entry.id === project.entryScene);
  if (!sceneData) throw new Error('Entry scene is missing');
  levelDesign = (project.generatedLevels || []).find((entry) => entry.sceneId === sceneData.id) || null;
  levelRecipe = levelDesign
    ? (project.levelRecipes || []).find((entry) => entry.id === levelDesign.recipeId) || null
    : null;
  fixedStep = 1 / Math.max(1, Math.min(240, Number(project.settings?.fixedStepHz || 60)));
  gameplay = new GameplaySimulation(project);
  gameplayState = gameplay.getState();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(sceneData.environment.background || '#081018');
  if (sceneData.environment.fog) {
    scene.fog = new THREE.Fog(
      sceneData.environment.fog.color,
      sceneData.environment.fog.near,
      sceneData.environment.fog.far,
    );
  }
  scene.add(new THREE.HemisphereLight('#d8ecff', '#101923', Number(sceneData.environment.ambientIntensity || 0.5)));
  sceneData.entities
    .filter((entity) => entity.enabled !== false)
    .forEach((entity) => objectMap.set(entity.id, makeObject(entity)));
  const assetLoads = [];
  sceneData.entities.forEach((entity) => {
    const object = objectMap.get(entity.id);
    if (!object) return;
    const parent = entity.parentId ? objectMap.get(entity.parentId) : null;
    (parent || scene).add(object);
    if (entity.tags.includes('player')) player = object;
    if (entity.tags.includes('pickup')) pickups.push({ id: entity.id, object });
    if (entity.tags.includes('goal')) goal = object;
    if (entity.tags.includes('enemy')) enemyObjects.set(entity.id, object);
    if (entity.tags.includes('encounter-gate')) gateObjects.set(entity.id, object);
    if (entity.tags.includes('checkpoint')) checkpointObjects.set(entity.id, object);
    if (component(entity, 'Camera')?.data.primary === true) camera = object;
    registerCollisionRole(entity, object);
    if (object.userData.assetId) assetLoads.push(loadAssetObject(entity, object));
  });
  await Promise.all(assetLoads);
  totalPickups = pickups.length;
  if (!player) throw new Error('A playable build requires one entity tagged player');
  playerSpawn.copy(levelDesign ? vector(levelDesign.spawn.position) : player.position);
  if (!(camera instanceof THREE.Camera)) {
    camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 1000);
    scene.add(camera);
  }
  camera.position.set(playerSpawn.x + 7, playerSpawn.y + 7, playerSpawn.z + 11);
  camera.lookAt(player.position);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  scoreTotal.textContent = String(totalPickups);
  levelName.textContent = levelRecipe?.name || project.name;
  resize();
}

function playTone(frequency = 520, duration = 0.18) {
  try {
    audioContext ||= new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequency;
    oscillator.type = frequency < 300 ? 'sawtooth' : 'sine';
    gain.gain.setValueAtTime(0.075, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration + 0.02);
  } catch (_error) {
    // Audio is optional and may be unavailable before a user gesture.
  }
}

function burst(position, color, count = 18) {
  for (let index = 0; index < count; index += 1) {
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

function setStatus(text, state = 'playing') {
  statusPill.textContent = text;
  statusPill.dataset.state = state;
}

function objectiveRequirementsMet() {
  if (levelRecipe?.objective === 'collect-and-exit') return pickupCount >= totalPickups;
  if (levelRecipe?.objective === 'secure-and-exit') return gameplayState.encounters.every((entry) => entry.cleared);
  return true;
}

function updateObjective() {
  if (won) {
    objective.textContent = 'Expedition complete. Seeded level '
      + (levelDesign?.checksum || 'verified')
      + ' cleared.';
    setStatus('Victory', 'success');
    return;
  }
  if (levelRecipe?.objective === 'secure-and-exit') {
    const active = gameplayState.encounters.find((entry) => entry.active) || null;
    const remainingEncounters = gameplayState.encounters.filter((entry) => !entry.cleared).length;
    const remainingEnemies = gameplayState.enemies.filter((entry) => entry.health > 0).length;
    if (active) objective.textContent = `Arena sealed. Defeat ${remainingEnemies} guardian${remainingEnemies === 1 ? '' : 's'} to open the gates.`;
    else if (remainingEncounters > 0) objective.textContent = `Find and secure ${remainingEncounters} guardian room${remainingEncounters === 1 ? '' : 's'}.`;
    else objective.textContent = 'All checkpoints secured. Reach the exit beacon.';
  } else if (levelRecipe?.objective === 'collect-and-exit') {
    const remaining = Math.max(0, totalPickups - pickupCount);
    objective.textContent = remaining > 0
      ? `Recover ${remaining} energy core${remaining === 1 ? '' : 's'}, then find the exit.`
      : 'Exit unlocked. Follow the beacon to finish the level.';
  } else {
    objective.textContent = 'Find and reach the exit beacon.';
  }
  setStatus('Playing');
}

function syncGameplay(nextState) {
  gameplayState = nextState;
  healthValue.textContent = String(Math.ceil(gameplayState.player.health));
  enemyValue.textContent = String(gameplayState.enemies.filter((enemy) => enemy.health > 0).length);
  gameplayState.enemies.forEach((enemy) => {
    const object = enemyObjects.get(enemy.id);
    if (!object) return;
    object.visible = enemy.health > 0;
    object.position.set(enemy.position.x, enemy.position.y, enemy.position.z);
    object.userData.phase = enemy.phase;
  });
  Object.entries(gameplayState.gates).forEach(([gateId, closed]) => {
    const object = gateObjects.get(gateId);
    if (object) object.visible = closed;
  });
  checkpointObjects.forEach((object, checkpointId) => {
    const active = gameplayState.checkpoint.id === checkpointId;
    object.userData.checkpointActive = active;
    if (object.material) object.material.emissiveIntensity = active ? 1.15 : 0.24;
  });
}

function processGameplayEvents(events) {
  let objectiveChanged = false;
  events.forEach((event) => {
    if (event.type === 'encounter-started') {
      playTone(260, 0.3);
      setStatus('Arena sealed', 'warning');
      objectiveChanged = true;
    }
    if (event.type === 'player-attacked') {
      player.userData.attackPulse = 0.16;
      playTone(event.targetId ? 610 : 420, 0.08);
    }
    if (event.type === 'enemy-damaged') {
      const object = enemyObjects.get(event.enemyId);
      if (object) burst(object.position, object.material?.color || '#fb7185', 10);
    }
    if (event.type === 'enemy-defeated') {
      const object = enemyObjects.get(event.enemyId);
      if (object) burst(object.position, '#fda4af', 26);
      playTone(720, 0.2);
      objectiveChanged = true;
    }
    if (event.type === 'player-damaged') {
      playTone(170, 0.22);
      setStatus('Shield hit', 'warning');
    }
    if (event.type === 'encounter-cleared') {
      playTone(940, 0.34);
      setStatus('Checkpoint secured', 'success');
      objectiveChanged = true;
    }
    if (event.type === 'player-respawned') {
      player.position.copy(vector(event.position));
      playerVelocity.set(0, 0, 0);
      setStatus('Checkpoint restored', 'warning');
      objectiveChanged = true;
    }
  });
  if (objectiveChanged) updateObjective();
}

function collectPickups() {
  pickups.forEach(({ object }) => {
    if (!object.visible || object.position.distanceTo(player.position) >= 1.2) return;
    object.visible = false;
    pickupCount += 1;
    scoreValue.textContent = String(pickupCount);
    burst(object.position, object.material?.color || '#a78bfa');
    playTone(520 + pickupCount * 70);
    updateObjective();
  });
}

function evaluateGoal() {
  if (!goal || won || goal.position.distanceTo(player.position) >= 1.45) return;
  if (!objectiveRequirementsMet()) {
    const remainingEnemies = gameplayState.enemies.filter((entry) => entry.health > 0).length;
    const remainingPickups = Math.max(0, totalPickups - pickupCount);
    setStatus(levelRecipe?.objective === 'secure-and-exit' ? `${remainingEnemies} guardians remain` : `${remainingPickups} cores remain`, 'warning');
    return;
  }
  won = true;
  burst(goal.position, goal.material?.color || '#38bdf8', 30);
  playTone(880, 0.4);
  updateObjective();
}

function onWalkableGround(x, z) {
  if (!walkableAreas.length) {
    const bounds = levelDesign?.bounds;
    return !bounds || (x >= bounds.min.x && x <= bounds.max.x && z >= bounds.min.z && z <= bounds.max.z);
  }
  return walkableAreas.some((area) => (
    x >= area.minX - 0.18
    && x <= area.maxX + 0.18
    && z >= area.minZ - 0.18
    && z <= area.maxZ + 0.18
  ));
}

function hitsObstacle(x, z, radius = playerRadius, ignoredEntityId = '') {
  return obstacles.some((box) => {
    if (box.entityId === ignoredEntityId) return false;
    if (box.gateId && !gameplayState?.gates?.[box.gateId]) return false;
    return x + radius > box.minX
      && x - radius < box.maxX
      && z + radius > box.minZ
      && z - radius < box.maxZ;
  });
}

function movePlayer(deltaX, deltaZ) {
  const nextX = player.position.x + deltaX;
  if (onWalkableGround(nextX, player.position.z) && !hitsObstacle(nextX, player.position.z)) player.position.x = nextX;
  else playerVelocity.x = 0;
  const nextZ = player.position.z + deltaZ;
  if (onWalkableGround(player.position.x, nextZ) && !hitsObstacle(player.position.x, nextZ)) player.position.z = nextZ;
  else playerVelocity.z = 0;
}

function pressed(code) {
  return keys.has(code) || touchKeys.has(code);
}

function actionCodes(action, fallback = []) {
  return project.inputMap?.find((binding) => binding.action === action)?.keys || fallback;
}

function actionPressed(action, fallback = []) {
  return touchActions.has(action) || actionCodes(action, fallback).some(pressed);
}

function movementInput() {
  const codes = actionCodes('Move', ['KeyW', 'KeyS', 'KeyA', 'KeyD']);
  const [forward = 'KeyW', backward = 'KeyS', left = 'KeyA', right = 'KeyD'] = codes;
  return new THREE.Vector3(
    Number(pressed(right)) - Number(pressed(left)),
    0,
    Number(pressed(backward)) - Number(pressed(forward)),
  );
}

function takeHazardDamage() {
  if (hazardCooldown > 0 || won) return;
  hazardCooldown = 1.25;
  gameplay.damagePlayerFromHazard(1);
  syncGameplay(gameplay.getState());
  processGameplayEvents(gameplay.drainEvents());
}

function simulate(delta) {
  hazardCooldown = Math.max(0, hazardCooldown - delta);
  const input = movementInput();
  if (input.lengthSq() > 0) input.normalize();
  const speed = 5.8 + Number(levelRecipe?.gameplay?.difficulty || 2) * 0.08;
  playerVelocity.x = THREE.MathUtils.damp(playerVelocity.x, input.x * speed, 10, delta);
  playerVelocity.z = THREE.MathUtils.damp(playerVelocity.z, input.z * speed, 10, delta);
  movePlayer(playerVelocity.x * delta, playerVelocity.z * delta);
  if (input.lengthSq() > 0) player.rotation.y = Math.atan2(input.x, input.z);
  const attacking = actionPressed('Attack', ['Space', 'Enter']);
  const nextState = gameplay.step(delta, {
    playerPosition: { x: player.position.x, y: player.position.y, z: player.position.z },
    attackPressed: attacking && !attackHeld && !won,
    canOccupy: (position, enemyId) => onWalkableGround(position.x, position.z)
      && !hitsObstacle(position.x, position.z, 0.4, enemyId),
  });
  attackHeld = attacking;
  syncGameplay(nextState);
  processGameplayEvents(gameplay.drainEvents());
  collectPickups();
  hazards.forEach((hazard) => {
    if (hazard.object.position.distanceTo(player.position) < hazard.radius + playerRadius) takeHazardDamage();
  });
  evaluateGoal();
}

function animateWorld(elapsed, delta) {
  pickups.forEach(({ object }, index) => {
    if (!object.visible) return;
    object.rotation.y = elapsed * 1.8 + index * 0.3;
    object.position.y = object.userData.baseY + Math.sin(elapsed * 2.2 + index) * 0.12;
  });
  hazards.forEach((hazard, index) => {
    hazard.object.rotation.y = elapsed * (0.7 + (index % 3) * 0.08);
    const pulse = 1 + Math.sin(elapsed * 4 + index) * 0.07;
    hazard.object.scale.x = hazard.object.userData.baseScale.x * pulse;
    hazard.object.scale.z = hazard.object.userData.baseScale.z * pulse;
  });
  enemyObjects.forEach((object, enemyId) => {
    if (!object.visible) return;
    object.rotation.y += delta * (object.userData.phase === 'windup' ? 7 : 1.3);
    const pulse = object.userData.phase === 'windup' ? 1.16 + Math.sin(elapsed * 20) * 0.08 : 1;
    object.scale.copy(object.userData.baseScale).multiplyScalar(pulse);
    const enemy = gameplayState.enemies.find((entry) => entry.id === enemyId);
    if (enemy) object.position.y = enemy.position.y + Math.sin(elapsed * 3 + enemyId.length) * 0.08;
  });
  gateObjects.forEach((object, gateId) => {
    if (object.visible) object.material.emissiveIntensity = 0.5 + Math.sin(elapsed * 7 + gateId.length) * 0.18;
  });
  checkpointObjects.forEach((object, checkpointId) => {
    const active = gameplayState.checkpoint.id === checkpointId;
    object.rotation.y += delta * (active ? 1.4 : 0.35);
    const scale = active ? 1 + Math.sin(elapsed * 4) * 0.06 : 1;
    object.scale.copy(object.userData.baseScale).multiplyScalar(scale);
  });
  player.userData.attackPulse = Math.max(0, player.userData.attackPulse - delta);
  const playerScale = player.userData.attackPulse > 0 ? 1.12 : 1;
  player.scale.copy(player.userData.baseScale).multiplyScalar(playerScale);
  if (goal) {
    goal.rotation.y += delta * 0.85;
    goal.rotation.x = Math.sin(elapsed * 0.7) * 0.12;
  }
  const targetCamera = new THREE.Vector3(player.position.x + 6.5, player.position.y + 6.2, player.position.z + 8.5);
  camera.position.lerp(targetCamera, 1 - Math.pow(0.0004, delta));
  camera.lookAt(player.position.x, player.position.y + 0.7, player.position.z);
}

function frame() {
  const frameDelta = clock.getDelta();
  const schedule = scheduleGameplaySteps(accumulator, frameDelta, fixedStep);
  accumulator = schedule.accumulatorSeconds;
  for (let stepIndex = 0; stepIndex < schedule.steps; stepIndex += 1) {
    simulate(fixedStep);
  }
  const delta = Math.min(GAMEPLAY_MAX_FRAME_DELTA_SECONDS, Math.max(0, frameDelta));
  animateWorld(clock.elapsedTime, delta);
  updateParticles(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function reset(fullReset = true) {
  player.position.copy(playerSpawn);
  playerVelocity.set(0, 0, 0);
  won = false;
  attackHeld = false;
  hazardCooldown = 0.8;
  syncGameplay(gameplay.reset());
  if (fullReset) {
    pickupCount = 0;
    pickups.forEach(({ object }) => { object.visible = true; });
  }
  scoreValue.textContent = String(pickupCount);
  updateObjective();
}

function saveSnapshot() {
  return {
    schema: 'LillyPlayerSave/v2',
    levelChecksum: levelDesign?.checksum || '',
    position: player.position.toArray(),
    pickupCount,
    hiddenPickupIds: pickups.filter(({ object }) => !object.visible).map(({ id }) => id),
    gameplay: gameplay.serialize(),
    won,
  };
}

function applySaveSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.position) || snapshot.position.length !== 3) return false;
  if (snapshot.levelChecksum && levelDesign?.checksum && snapshot.levelChecksum !== levelDesign.checksum) return false;
  if (snapshot.schema === 'LillyPlayerSave/v2' && snapshot.gameplay && !gameplay.restore(snapshot.gameplay)) return false;
  else if (snapshot.schema !== 'LillyPlayerSave/v1' && snapshot.schema !== 'LillyPlayerSave/v2') return false;
  player.position.fromArray(snapshot.position.map(Number));
  pickupCount = Math.max(0, Math.min(totalPickups, Number(snapshot.pickupCount) || 0));
  const hiddenIds = snapshot.schema === 'LillyPlayerSave/v2'
    ? new Set(snapshot.hiddenPickupIds || [])
    : new Set(pickups.filter((_pickup, index) => Boolean(snapshot.hidden?.[index])).map(({ id }) => id));
  pickups.forEach(({ id, object }) => { object.visible = !hiddenIds.has(id); });
  syncGameplay(gameplay.getState());
  won = snapshot.won === true && objectiveRequirementsMet();
  scoreValue.textContent = String(pickupCount);
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
    const stored = localStorage.getItem(`lilly:${project.id}:save`);
    if (stored) applySaveSnapshot(JSON.parse(stored));
  } catch (_error) {
    storageBridge('load');
  }
}

function save() {
  const snapshot = saveSnapshot();
  try {
    localStorage.setItem(`lilly:${project.id}:save`, JSON.stringify(snapshot));
    setStatus('Saved', 'success');
    setTimeout(updateObjective, 900);
  } catch (_error) {
    storageBridge('save', snapshot);
    setStatus('Saving...');
  }
}

function setupHoldButton(button, onPress, onRelease) {
  if (!button) return;
  const press = (event) => {
    event.preventDefault();
    try { button.setPointerCapture?.(event.pointerId); } catch (_error) { /* Pointer ownership can change. */ }
    onPress(event);
    button.dataset.pressed = 'true';
  };
  const release = (event) => {
    onRelease(event);
    button.dataset.pressed = 'false';
  };
  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

function setupTouchControls() {
  touchButtons.forEach((button) => {
    const code = button.dataset.moveCode;
    setupHoldButton(button, (event) => {
      touchPointers.set(event.pointerId, code);
      touchKeys.add(code);
    }, (event) => {
      const releasedCode = touchPointers.get(event.pointerId) || code;
      touchPointers.delete(event.pointerId);
      if (![...touchPointers.values()].includes(releasedCode)) touchKeys.delete(releasedCode);
    });
  });
  setupHoldButton(attackButton, () => touchActions.add('Attack'), () => touchActions.delete('Attack'));
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
  if (actionCodes('Reset', ['KeyR']).includes(event.code)) reset(true);
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => {
  keys.clear();
  touchKeys.clear();
  touchActions.clear();
  touchPointers.clear();
  attackHeld = false;
});
window.addEventListener('resize', resize);
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.schema !== 'LillyPlayerStorage/v1' || message.projectId !== project?.id) return;
  if (message.type === 'load-result' && message.ok && message.state) applySaveSnapshot(message.state);
  if (message.type === 'save-result') {
    setStatus(message.ok ? 'Saved' : 'Save unavailable', message.ok ? 'success' : 'warning');
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
  const snapshot = saveSnapshot();
  const originalPosition = player.position.clone();
  const candidates = actionCodes('Move', ['KeyW', 'KeyS', 'KeyA', 'KeyD']);
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
  applySaveSnapshot(snapshot);
  playerVelocity.set(0, 0, 0);
  return {
    passed: moved > 0.02,
    before: originalPosition.toArray(),
    after,
    moved,
    input: used,
    checksum: levelDesign?.checksum || null,
  };
}

function runCombatTest() {
  const spec = levelDesign?.encounters?.[0];
  if (!spec) return { passed: true, skipped: true, reason: 'No combat encounter in this game' };
  const snapshot = saveSnapshot();
  const room = levelDesign.rooms.find((entry) => entry.id === spec.roomId);
  player.position.copy(vector(room?.position || spec.checkpointPosition));
  gameplay.step(fixedStep, { playerPosition: { x: player.position.x, y: player.position.y, z: player.position.z } });
  let state = gameplay.getState();
  const started = state.activeEncounterId === spec.id;
  for (let step = 0; step < 480 && !state.encounters.find((entry) => entry.id === spec.id)?.cleared; step += 1) {
    const enemy = state.enemies.find((entry) => entry.encounterId === spec.id && entry.health > 0);
    if (!enemy) break;
    const attackRange = Math.max(0.2, state.player.attackRange - 0.08);
    const combatPosition = { x: enemy.position.x + attackRange, y: player.position.y, z: enemy.position.z };
    player.position.copy(vector(combatPosition));
    state = gameplay.step(0.1, { playerPosition: combatPosition, attackPressed: step % 5 === 0 });
    const respawn = gameplay.drainEvents().find((event) => event.type === 'player-respawned');
    if (respawn) player.position.copy(vector(room?.position || spec.checkpointPosition));
  }
  const cleared = state.encounters.find((entry) => entry.id === spec.id)?.cleared === true;
  const checkpoint = state.checkpoint.id === spec.checkpointId;
  const gatesOpen = spec.gateIds.every((id) => state.gates[id] === false);
  applySaveSnapshot(snapshot);
  playerVelocity.set(0, 0, 0);
  return { passed: started && cleared && checkpoint && gatesOpen, started, cleared, checkpoint, gatesOpen, encounterId: spec.id };
}

async function start() {
  try {
    project = await fetch('./project.json').then((response) => {
      if (!response.ok) throw new Error('Project data failed to load');
      return response.json();
    });
    await setupScene();
    setupTouchControls();
    reset(true);
    restoreSave();
    loading.hidden = true;
    window.__LILLY_GAME__ = {
      schema: 'LillyPlayerDebug/v2',
      getState: () => ({
        pickupCount,
        totalPickups,
        health: gameplayState.player.health,
        maxHealth: gameplayState.player.maxHealth,
        won,
        playerPosition: player.position.toArray(),
        levelChecksum: levelDesign?.checksum || null,
        roomCount: levelDesign?.metrics?.roomCount || 0,
        activeEncounterId: gameplayState.activeEncounterId,
        encountersCleared: gameplayState.encounters.filter((entry) => entry.cleared).length,
        encounterCount: gameplayState.encounters.length,
        enemiesRemaining: gameplayState.enemies.filter((entry) => entry.health > 0).length,
        checkpointId: gameplayState.checkpoint.id,
      }),
      controlTest: runControlTest,
      combatTest: runCombatTest,
      saveSnapshot,
      reset: () => reset(true),
    };
    frame();
  } catch (error) {
    showRuntimeError(error);
  }
}

start();
