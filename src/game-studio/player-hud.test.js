'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

test('round trigger entry occurs at actual contact instead of consuming entry at a bounding-box corner', () => {
  const source = ts.createSourceFile('player-runtime.js', fs.readFileSync(path.join(__dirname, 'player-runtime.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['collisionPairKey', 'collisionPayload', 'scanCollisionTransitions', 'colliderFootprintsOverlap']);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source)).join('\n');
  const bounds = (id, shape, x, z, radius, sensor) => ({ entry: { entity: { id, tags: [] }, collider: { data: { shape, sensor } } }, center: { x, y: 0.8, z }, minX: x - radius, maxX: x + radius, minY: 0, maxY: 1.6, minZ: z - radius, maxZ: z + radius });
  const sensor = bounds('sensor-amber', 'cylinder', 0, 0, 1.05, true);
  const colliders = new Map([['sensor', sensor], ['player', bounds('player', 'capsule', 1.2, 1.2, 0.3, false)]]);
  const context = vm.createContext({ runtimeColliders: colliders, runtimeColliderBounds: value => value, isFixedCollider: () => false, activeCollisionPairs: new Map() });
  vm.runInContext(code, context);
  expect(vm.runInContext('scanCollisionTransitions()', context)).toHaveLength(0);
  colliders.set('player', bounds('player', 'capsule', 0.9, 0.9, 0.3, false));
  expect(vm.runInContext('scanCollisionTransitions()', context)).toEqual([expect.objectContaining({ phase: 'start', type: 'trigger', entityA: 'player', entityB: 'sensor-amber' })]);
  expect(vm.runInContext('scanCollisionTransitions()', context)).toHaveLength(0);
  colliders.set('player', bounds('player', 'capsule', 1.2, 1.2, 0.3, false));
  expect(vm.runInContext('scanCollisionTransitions()', context)).toEqual([expect.objectContaining({ phase: 'end' })]);
  sensor.entry.collider.data.shape = 'box';
  // Rounded player contact at a square portal corner also needs a narrow check.
  colliders.set('player', bounds('player', 'capsule', 1.3, 1.3, 0.3, false));
  expect(vm.runInContext('scanCollisionTransitions()', context)).toHaveLength(0);
  colliders.set('player', bounds('player', 'capsule', 1.2, 1.2, 0.3, false));
  expect(vm.runInContext('scanCollisionTransitions()', context)).toEqual([expect.objectContaining({ phase: 'start' })]);
});

test('fixed authored cameras retain scene transforms while follow cameras start on their target', () => {
  const THREE = require('three');
  const source = ts.createSourceFile('player-runtime.js', fs.readFileSync(path.join(__dirname, 'player-runtime.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'initializePlayerCamera').getText(source);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(2, 18, 3);
  camera.rotation.set(-Math.PI / 2, 0, 0.2);
  const original = camera.matrixWorld.clone();
  camera.updateMatrixWorld();
  original.copy(camera.matrixWorld);
  const context = vm.createContext({ THREE, camera, runtimeProfile: 'module-driven', cameraComponentData: { primary: true }, playerEntityData: { id: 'player' }, playerSpawn: new THREE.Vector3(4, 1, 5), player: { position: new THREE.Vector3(4, 1, 5) }, vector: (value, fallback) => new THREE.Vector3(...['x', 'y', 'z'].map(axis => value?.[axis] ?? fallback[axis])) });
  vm.runInContext(code + '\ninitializePlayerCamera();', context);
  camera.updateMatrixWorld();
  expect(camera.matrixWorld.equals(original)).toBe(true);
  context.cameraComponentData = { followTargetId: 'player', followOffset: { x: 0, y: 9, z: 6 }, lookAtHeight: 2 };
  vm.runInContext('initializePlayerCamera();', context);
  expect(camera.position.toArray()).toEqual([4, 10, 11]);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  expect(direction.distanceTo(new THREE.Vector3(0, -7, -6).normalize())).toBeLessThan(0.000001);
  context.runtimeProfile = 'expedition';
  vm.runInContext('initializePlayerCamera();', context);
  expect(camera.position.toArray()).toEqual([11, 8, 16]);
});

test('portrait cameras retain the landscape horizontal field of view and restore on resize', () => {
  const source = ts.createSourceFile('player-runtime.js', fs.readFileSync(path.join(__dirname, 'player-runtime.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'responsiveCameraFov').getText(source);
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const portrait = vm.runInContext('responsiveCameraFov(60, 390 / 844)', context);
  const horizontal = Math.tan(portrait * Math.PI / 360) * (390 / 844);
  expect(horizontal).toBeCloseTo(Math.tan(Math.PI / 6) * 4 / 3);
  expect(vm.runInContext('responsiveCameraFov(60, 1.5)', context)).toBeCloseTo(60);
});

test('authored HUD reflects visible labels and live patches without repeating unchanged DOM writes', () => {
  const source = ts.createSourceFile('player-runtime.js', fs.readFileSync(path.join(__dirname, 'player-runtime.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['applyModuleActions', 'updateAuthoredHud']);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source)).join('\n');
  const anchor = (id, text, visible = true) => ({ id, enabled: true, components: [{ type: 'UIAnchor', data: { text, visible } }] });
  let text = '', writes = 0;
  const objective = { get textContent() { return text; }, set textContent(value) { text = value; writes++; } };
  const context = vm.createContext({
    project: { entryScene: 'main', scenes: [{ id: 'main', entities: [anchor('timer', '90'), anchor('result', 'YOU WIN', false)] }] },
    objective, runtimeProfile: 'module-driven', objectMap: new Map(),
    component: (entity, type) => entity.components.find(entry => entry.type === type), setStatus: () => {},
  });
  vm.runInContext(code + '\nupdateAuthoredHud();', context);
  expect(text).toBe('90');
  vm.runInContext("applyModuleActions([{type:'entity.patch',entityId:'timer',component:'UIAnchor',values:{text:'89'}},{type:'entity.patch',entityId:'result',component:'UIAnchor',values:{visible:true}}]);", context);
  expect(text).toBe('89 · YOU WIN');
  expect(writes).toBe(2);
  vm.runInContext('updateAuthoredHud();', context);
  expect(writes).toBe(2);
  vm.runInContext("applyModuleActions([{type:'hud.message',text:'Restarted'}]);", context);
  expect(text).toBe('Restarted');
});
