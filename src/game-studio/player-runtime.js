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
let moduleBundle;
let moduleHost;
let moduleRuntimeState = { states: {}, saves: {} };
let moduleDispatchPending = false;
let activeCollisionPairs = new Map();
let moduleSpawnSequence = 0;
let pickupCount = 0;
let totalPickups = 0;
let won = false;
let hazardCooldown = 0;
let attackHeld = false;
let editorPaused = false;
let editorStepRequests = 0;
let editorCompletedSteps = 0;
let visualElapsed = 0;
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
const runtimeColliders = new Map();
const pendingModuleCollisions = [];
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

function moduleWorldSnapshot() {
  const sceneData = project?.scenes?.find((entry) => entry.id === project.entryScene);
  return {
    playerId: player?.userData?.entityId || 'player',
    entities: (sceneData?.entities || []).map((entity) => {
      const object = objectMap.get(entity.id);
      return {
        id: entity.id,
        name: entity.name,
        tags: entity.tags,
        enabled: entity.enabled !== false && object?.visible !== false,
        position: object ? { x: object.position.x, y: object.position.y, z: object.position.z } : null,
        components: entity.components,
      };
    }),
  };
}

function moduleInputSnapshot(overrides = null) {
  if (overrides) return overrides;
  const buttons = {};
  const axes = {};
  for (const binding of project?.inputMap || []) {
    if (binding.kind === 'button') buttons[binding.action] = actionPressed(binding.action, binding.keys || []);
    else if (binding.kind === 'axis2d') {
      const [up, down, left, right] = binding.keys || [];
      axes[binding.action] = {
        x: Number(Boolean(right) && pressed(right)) - Number(Boolean(left) && pressed(left)),
        y: Number(Boolean(up) && pressed(up)) - Number(Boolean(down) && pressed(down)),
      };
    }
  }
  return { buttons, axes };
}

function emitModuleInputEvent() {
  if (!moduleHost) return;
  moduleHost.emit('input', {
    delta: 0,
    input: moduleInputSnapshot(),
    world: moduleWorldSnapshot(),
  }).catch(showRuntimeError);
}

function createModuleHost(bundle) {
  if (!bundle?.systems?.length) return Promise.resolve(null);
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.src = './module-sandbox.html';
  document.body.appendChild(iframe);
  const pending = new Map();
  let sequence = 0;
  let settled = false;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error('Agent module sandbox did not become ready')), 3000);
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const message = event.data;
    if (!message || message.schema !== 'LillyModuleSandboxResult/v1') return;
    if (message.type === 'ready') {
      settled = true;
      clearTimeout(readyTimer);
      readyResolve(message);
      return;
    }
    const request = pending.get(message.requestId);
    if (message.requestId) pending.delete(message.requestId);
    if (message.type === 'error') {
      const error = Object.assign(new Error(message.error?.message || 'Agent module sandbox failed'), { code: message.error?.code || 'MODULE_RUNTIME_ERROR' });
      if (!settled) {
        settled = true;
        clearTimeout(readyTimer);
        readyReject(error);
      }
      request?.reject(error);
      if (!request) showRuntimeError(error);
      return;
    }
    if (message.type === 'result') {
      moduleRuntimeState = { states: message.result?.states || {}, saves: message.result?.saves || {} };
      applyModuleActions(message.result?.actions || []);
      request?.resolve(message.result);
    }
  };
  addEventListener('message', onMessage);
  const dispatch = (type, event = '', payload = {}) => {
    const requestId = `module-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      iframe.contentWindow.postMessage({ schema: 'LillyModuleSandboxMessage/v1', type, event, payload, requestId, ...(type === 'restore' ? payload : {}) }, '*');
    });
  };
  return readyPromise.then((ready) => ({
    sourceHash: ready.sourceHash,
    systems: ready.systems,
    emit: (event, payload = {}) => dispatch('dispatch', event, payload),
    restore: (snapshot = {}) => dispatch('restore', '', snapshot),
    reset: () => dispatch('reset'),
    dispose() {
      removeEventListener('message', onMessage);
      iframe.remove();
      for (const request of pending.values()) request.reject(new Error('Module sandbox disposed'));
      pending.clear();
    },
  })).catch((error) => {
    removeEventListener('message', onMessage);
    iframe.remove();
    throw error;
  });
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

function spawnModulePrefab(prefabId, options = {}) {
  const prefab = moduleBundle?.prefabs?.find((entry) => entry.id === prefabId);
  if (!prefab || !Array.isArray(prefab.entities)) return [];
  const sceneData = project.scenes.find((entry) => entry.id === project.entryScene);
  const requested = String(options.instanceId || `runtime-${++moduleSpawnSequence}`).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  const instanceId = requested || `runtime-${moduleSpawnSequence}`;
  const idMap = new Map(prefab.entities.map((entity) => [entity.id, `${instanceId}:${entity.id}`]));
  const parentId = options.parentId && objectMap.has(options.parentId) ? options.parentId : null;
  const offset = vector(options.position || { x: 0, y: 0, z: 0 });
  const entities = prefab.entities.map((sourceEntity) => {
    const entity = JSON.parse(JSON.stringify(sourceEntity));
    entity.id = idMap.get(sourceEntity.id);
    entity.parentId = sourceEntity.id === prefab.rootEntityId
      ? parentId
      : (sourceEntity.parentId ? idMap.get(sourceEntity.parentId) || parentId : parentId);
    entity.tags = [...new Set([...(entity.tags || []), `prefab:${prefab.id}`, `instance:${instanceId}`])];
    const transform = component(entity, 'Transform');
    if (sourceEntity.id === prefab.rootEntityId && transform?.data.position) {
      transform.data.position = {
        x: Number(transform.data.position.x || 0) + offset.x,
        y: Number(transform.data.position.y || 0) + offset.y,
        z: Number(transform.data.position.z || 0) + offset.z,
      };
    }
    return entity;
  });
  entities.forEach((entity) => objectMap.set(entity.id, makeObject(entity)));
  entities.forEach((entity) => {
    const object = objectMap.get(entity.id);
    const parent = entity.parentId ? objectMap.get(entity.parentId) : null;
    (parent || scene).add(object);
    registerCollisionRole(entity, object);
    if (object.userData.assetId) loadAssetObject(entity, object).catch(showRuntimeError);
  });
  sceneData.entities.push(...entities);
  return entities.map((entity) => entity.id);
}

function applyModuleActions(actions) {
  const sceneData = project?.scenes?.find((entry) => entry.id === project.entryScene);
  for (const action of actions) {
    const object = action.entityId ? objectMap.get(action.entityId) : null;
    if (action.type === 'physics.impulse' || action.type === 'physics.force') {
      const value = vector(action.value);
      const multiplier = action.type === 'physics.force' ? fixedStep : 1;
      if (object === player) playerVelocity.addScaledVector(value, multiplier);
      else if (object) object.position.addScaledVector(value, multiplier);
    } else if (action.type === 'physics.raycast') {
      const raycaster = new THREE.Raycaster(vector(action.origin), vector(action.direction).normalize(), 0, Math.max(0, Number(action.maxDistance || 100)));
      const hit = raycaster.intersectObjects([...objectMap.values()], true).find((entry) => entry.object?.userData?.entityId !== action.systemId) || null;
      moduleHost?.emit('event', {
        event: { name: 'physics.raycast-result', payload: { request: action, hit: hit ? { entityId: hit.object.userData.entityId || '', distance: hit.distance, point: hit.point.toArray() } : null } },
        world: moduleWorldSnapshot(),
        input: moduleInputSnapshot(),
      }).catch(showRuntimeError);
    } else if (action.type === 'entity.patch' && sceneData) {
      const entity = sceneData.entities.find((entry) => entry.id === action.entityId);
      if (!entity) continue;
      let target = component(entity, action.component);
      if (!target && action.component === 'State') {
        target = { type: 'State', enabled: true, data: { schemaId: action.values?.schemaId || 'module-state', values: {} } };
        entity.components.push(target);
      }
      if (!target) continue;
      target.data = { ...target.data, ...(action.values || {}) };
      if (target.type === 'Transform' && object) {
        if (target.data.position) object.position.copy(vector(target.data.position));
        if (target.data.rotation) object.rotation.set(Number(target.data.rotation.x || 0), Number(target.data.rotation.y || 0), Number(target.data.rotation.z || 0));
        if (target.data.scale) object.scale.copy(vector(target.data.scale, { x: 1, y: 1, z: 1 }));
      }
    } else if (action.type === 'entity.spawn') {
      spawnModulePrefab(action.prefabId, action.options || {});
    } else if (action.type === 'entity.destroy' && object) {
      removeRuntimeEntityTree(action.entityId);
    } else if (action.type === 'hud.message') {
      objective.textContent = String(action.text || '');
      setStatus(String(action.options?.status || 'Mechanic'), action.options?.state || 'playing');
    } else if (action.type === 'audio.play') {
      playTone(Number(action.options?.frequency || 620), Number(action.options?.duration || 0.16));
    } else if (action.type === 'particles.emit') {
      const target = objectMap.get(action.entityId) || player;
      if (target) burst(target.position, action.options?.color || '#67e8f9', Number(action.options?.count || 18));
    }
  }
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
  runtimeColliders.set(entity.id, { entity, object, collider });
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

function objectVisibleInWorld(object) {
  let cursor = object;
  while (cursor) {
    if (cursor.visible === false) return false;
    cursor = cursor.parent;
  }
  return true;
}

function runtimeColliderBounds(entry) {
  if (!entry?.object?.parent || !objectVisibleInWorld(entry.object)) return null;
  const center = new THREE.Vector3();
  entry.object.getWorldPosition(center);
  const size = vector(entry.collider.data.size, { x: 1, y: 1, z: 1 });
  const half = {
    x: Math.max(0.005, Math.abs(size.x) / 2),
    y: Math.max(0.005, Math.abs(size.y) / 2),
    z: Math.max(0.005, Math.abs(size.z) / 2),
  };
  if (entry.collider.data.shape === 'sphere') {
    const radius = Math.max(half.x, half.y, half.z);
    half.x = radius;
    half.y = radius;
    half.z = radius;
  }
  return {
    entry,
    center,
    minX: center.x - half.x,
    maxX: center.x + half.x,
    minY: center.y - half.y,
    maxY: center.y + half.y,
    minZ: center.z - half.z,
    maxZ: center.z + half.z,
  };
}

function collisionPairKey(entityA, entityB) {
  const [first, second] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
  return `${first.length}:${first}${second}`;
}

function isFixedCollider(entry) {
  const body = component(entry.entity, 'RigidBody');
  return !body || body.data.bodyType === 'fixed';
}

function collisionPayload(left, right, phase) {
  const [entityA, entityB] = left.entry.entity.id < right.entry.entity.id ? [left, right] : [right, left];
  const trigger = entityA.entry.collider.data.sensor === true || entityB.entry.collider.data.sensor === true;
  return {
    type: trigger ? 'trigger' : 'collision',
    phase,
    entityA: entityA.entry.entity.id,
    entityB: entityB.entry.entity.id,
    tagsA: [...(entityA.entry.entity.tags || [])],
    tagsB: [...(entityB.entry.entity.tags || [])],
    positionA: { x: entityA.center.x, y: entityA.center.y, z: entityA.center.z },
    positionB: { x: entityB.center.x, y: entityB.center.y, z: entityB.center.z },
  };
}

function scanCollisionTransitions() {
  const bounds = [...runtimeColliders.values()]
    .map(runtimeColliderBounds)
    .filter(Boolean)
    .sort((left, right) => left.minX - right.minX || left.entry.entity.id.localeCompare(right.entry.entity.id));
  const nextPairs = new Map();
  const transitions = [];
  for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
    const left = bounds[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < bounds.length; rightIndex += 1) {
      const right = bounds[rightIndex];
      if (right.minX > left.maxX) break;
      if (left.maxY < right.minY || left.minY > right.maxY || left.maxZ < right.minZ || left.minZ > right.maxZ) continue;
      const leftSensor = left.entry.collider.data.sensor === true;
      const rightSensor = right.entry.collider.data.sensor === true;
      if (!leftSensor && !rightSensor && isFixedCollider(left.entry) && isFixedCollider(right.entry)) continue;
      const key = collisionPairKey(left.entry.entity.id, right.entry.entity.id);
      const active = collisionPayload(left, right, 'start');
      nextPairs.set(key, active);
      if (!activeCollisionPairs.has(key)) transitions.push(active);
    }
  }
  for (const [key, prior] of activeCollisionPairs) {
    if (!nextPairs.has(key)) transitions.push({ ...prior, phase: 'end' });
  }
  activeCollisionPairs = nextPairs;
  return transitions;
}

function queueModuleCollisions(transitions) {
  if (!transitions.length) return;
  pendingModuleCollisions.push(...transitions);
  if (pendingModuleCollisions.length > 512) {
    pendingModuleCollisions.splice(0, pendingModuleCollisions.length - 512);
    console.warn('[LillyPlayer] Collision event queue was capped at 512 transitions');
  }
}

function removeRuntimeEntityTree(entityId) {
  const sceneData = project?.scenes?.find((entry) => entry.id === project.entryScene);
  if (!sceneData) return [];
  const removed = new Set([entityId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entity of sceneData.entities) {
      if (entity.parentId && removed.has(entity.parentId) && !removed.has(entity.id)) {
        removed.add(entity.id);
        changed = true;
      }
    }
  }
  for (const id of removed) {
    const object = objectMap.get(id);
    object?.removeFromParent();
    objectMap.delete(id);
    runtimeColliders.delete(id);
    enemyObjects.delete(id);
    gateObjects.delete(id);
    checkpointObjects.delete(id);
  }
  for (let index = pickups.length - 1; index >= 0; index -= 1) if (removed.has(pickups[index].id)) pickups.splice(index, 1);
  for (let index = hazards.length - 1; index >= 0; index -= 1) if (removed.has(hazards[index].object.userData.entityId)) hazards.splice(index, 1);
  for (let index = obstacles.length - 1; index >= 0; index -= 1) if (removed.has(obstacles[index].entityId)) obstacles.splice(index, 1);
  sceneData.entities = sceneData.entities.filter((entry) => !removed.has(entry.id));
  activeCollisionPairs = new Map([...activeCollisionPairs].filter(([, pair]) => !removed.has(pair.entityA) && !removed.has(pair.entityB)));
  return [...removed];
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

async function dispatchModuleSimulationStep(delta) {
  if (!moduleHost || moduleDispatchPending) return;
  moduleDispatchPending = true;
  const collisionBatch = pendingModuleCollisions.splice(0, pendingModuleCollisions.length);
  try {
    await moduleHost.emit('fixed-update', {
      delta,
      input: moduleInputSnapshot(),
      world: moduleWorldSnapshot(),
    });
    for (const collision of collisionBatch) {
      await moduleHost.emit('collision', {
        delta: 0,
        input: moduleInputSnapshot(),
        world: moduleWorldSnapshot(),
        collision,
      });
    }
  } catch (error) {
    showRuntimeError(error);
  } finally {
    moduleDispatchPending = false;
  }
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
  queueModuleCollisions(scanCollisionTransitions());
  dispatchModuleSimulationStep(delta);
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
  let renderDelta = 0;
  if (!editorPaused) {
    const schedule = scheduleGameplaySteps(accumulator, frameDelta, fixedStep);
    accumulator = schedule.accumulatorSeconds;
    for (let stepIndex = 0; stepIndex < schedule.steps; stepIndex += 1) simulate(fixedStep);
    renderDelta = Math.min(GAMEPLAY_MAX_FRAME_DELTA_SECONDS, Math.max(0, frameDelta));
  } else {
    accumulator = 0;
    if (editorStepRequests > 0) {
      editorStepRequests -= 1;
      simulate(fixedStep);
      editorCompletedSteps += 1;
      renderDelta = fixedStep;
    }
  }
  visualElapsed += renderDelta;
  animateWorld(visualElapsed, renderDelta);
  updateParticles(renderDelta);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function reset(fullReset = true) {
  player.position.copy(playerSpawn);
  playerVelocity.set(0, 0, 0);
  activeCollisionPairs.clear();
  pendingModuleCollisions.length = 0;
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
  if (moduleHost && fullReset) {
    moduleHost.reset()
      .then(() => moduleHost.emit('start', { delta: 0, input: moduleInputSnapshot(), world: moduleWorldSnapshot() }))
      .catch(showRuntimeError);
  }
}

function saveSnapshot() {
  return {
    schema: 'LillyPlayerSave/v2',
    levelChecksum: levelDesign?.checksum || '',
    position: player.position.toArray(),
    pickupCount,
    hiddenPickupIds: pickups.filter(({ object }) => !object.visible).map(({ id }) => id),
    gameplay: gameplay.serialize(),
    modules: moduleRuntimeState,
    won,
  };
}

function applySaveSnapshot(snapshot, restoreModules = true) {
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
  if (restoreModules && snapshot.modules && moduleHost) moduleHost.restore(snapshot.modules).catch(showRuntimeError);
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
      emitModuleInputEvent();
    }, (event) => {
      const releasedCode = touchPointers.get(event.pointerId) || code;
      touchPointers.delete(event.pointerId);
      if (![...touchPointers.values()].includes(releasedCode)) touchKeys.delete(releasedCode);
      emitModuleInputEvent();
    });
  });
  setupHoldButton(attackButton, () => {
    touchActions.add('Attack');
    emitModuleInputEvent();
  }, () => {
    touchActions.delete('Attack');
    emitModuleInputEvent();
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
  if (!event.repeat) emitModuleInputEvent();
  if (actionCodes('Reset', ['KeyR']).includes(event.code)) reset(true);
});
window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
  emitModuleInputEvent();
});
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
  if (event.source === window.parent && message?.schema === 'LillyEditorPlayerControl/v1' && (!message.projectId || message.projectId === project?.id)) {
    if (message.type === 'play') editorPaused = false;
    if (message.type === 'pause') editorPaused = true;
    if (message.type === 'step') {
      editorPaused = true;
      editorStepRequests = Math.min(8, editorStepRequests + 1);
    }
    if (message.type === 'reset') reset(true);
    return;
  }
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

async function runModuleTest(requestedAction = '') {
  if (!moduleHost) return { passed: true, skipped: true, reason: 'No agent-authored systems in this build' };
  const snapshot = saveSnapshot();
  const beforeVelocity = playerVelocity.toArray();
  const mechanicInputs = (moduleBundle?.mechanics || []).flatMap((mechanic) => mechanic.inputs || []);
  const action = requestedAction || mechanicInputs.find((entry) => !['Move', 'Attack', 'Reset'].includes(entry)) || mechanicInputs[0] || 'Ability1';
  playerVelocity.set(0, 0, 0);
  const result = await moduleHost.emit('fixed-update', {
    delta: fixedStep,
    input: { buttons: { [action]: true, Dash: true, Ability1: true }, axes: { Move: { x: 1, y: 0 } } },
    world: moduleWorldSnapshot(),
  });
  const capabilityActions = result.actions || [];
  const passed = capabilityActions.length > 0;
  playerVelocity.fromArray(beforeVelocity);
  applySaveSnapshot(snapshot, false);
  if (snapshot.modules) await moduleHost.restore(snapshot.modules);
  return {
    passed,
    input: action,
    sourceHash: moduleBundle?.sourceHash || null,
    systems: moduleHost.systems,
    actions: capabilityActions,
  };
}

async function runModuleCollisionTest() {
  if (!moduleHost) return { passed: true, skipped: true, reason: 'No agent-authored systems in this build' };
  const playerCollider = runtimeColliders.get(player?.userData?.entityId || 'player');
  const target = [...runtimeColliders.values()].find((entry) => (
    entry.entity.id !== playerCollider?.entity.id
    && entry.collider.data.sensor === true
    && objectVisibleInWorld(entry.object)
  ));
  if (!playerCollider || !target) return { passed: true, skipped: true, reason: 'No player-to-trigger collision pair is available' };
  for (let attempt = 0; moduleDispatchPending && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (moduleDispatchPending) return { passed: false, code: 'MODULE_DISPATCH_BUSY', reason: 'Module sandbox remained busy during collision proof' };
  const snapshot = saveSnapshot();
  moduleDispatchPending = true;
  try {
    const targetPosition = new THREE.Vector3();
    target.object.getWorldPosition(targetPosition);
    player.position.copy(targetPosition);
    activeCollisionPairs.clear();
    const transitions = scanCollisionTransitions();
    const collision = transitions.find((entry) => (
      entry.phase === 'start'
      && [entry.entityA, entry.entityB].includes(playerCollider.entity.id)
      && [entry.entityA, entry.entityB].includes(target.entity.id)
    ));
    if (!collision) return { passed: false, detected: false, playerId: playerCollider.entity.id, targetId: target.entity.id };
    const result = await moduleHost.emit('collision', {
      delta: 0,
      input: moduleInputSnapshot(),
      world: moduleWorldSnapshot(),
      collision,
    });
    const actions = result.actions || [];
    return {
      passed: actions.length > 0,
      detected: true,
      handled: actions.length > 0,
      collision,
      actions,
      states: result.states || {},
    };
  } finally {
    applySaveSnapshot(snapshot, false);
    if (snapshot.modules) await moduleHost.restore(snapshot.modules);
    playerVelocity.set(0, 0, 0);
    activeCollisionPairs.clear();
    pendingModuleCollisions.length = 0;
    moduleDispatchPending = false;
  }
}

async function start() {
  try {
    [project, moduleBundle] = await Promise.all([
      fetch('./project.json').then((response) => {
        if (!response.ok) throw new Error('Project data failed to load');
        return response.json();
      }),
      fetch('./modules.json').then((response) => {
        if (!response.ok) throw new Error('Agent module bundle failed to load');
        return response.json();
      }),
    ]);
    await setupScene();
    setupTouchControls();
    reset(true);
    moduleHost = await createModuleHost(moduleBundle);
    if (moduleHost) {
      await moduleHost.emit('start', { delta: 0, input: moduleInputSnapshot(), world: moduleWorldSnapshot() });
      setStatus(`${moduleHost.systems.length} systems ready`, 'success');
    }
    restoreSave();
    loading.hidden = true;
    window.__LILLY_GAME__ = {
      schema: 'LillyPlayerDebug/v3',
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
        moduleSourceHash: moduleBundle?.sourceHash || null,
        moduleCount: moduleBundle?.modules?.length || 0,
        systemCount: moduleBundle?.systems?.length || 0,
        editorPaused,
        pendingEditorSteps: editorStepRequests,
        editorCompletedSteps,
      }),
      controlTest: runControlTest,
      combatTest: runCombatTest,
      moduleTest: runModuleTest,
      collisionTest: runModuleCollisionTest,
      saveSnapshot,
      reset: () => reset(true),
    };
    frame();
  } catch (error) {
    showRuntimeError(error);
  }
}

start();
