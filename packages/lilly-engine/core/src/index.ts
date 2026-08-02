import {
  createLevelRecipeFromPrompt,
  generateLevel,
  isGeneratedForRecipe,
  normalizeLevelRecipe,
  validateGeneratedLevel,
  validateLevelRecipe,
  type LillyGeneratedLevel,
  type LillyLevelRecipe,
} from './level-generator';

export * from './level-generator';

export const ENGINE_VERSION = '0.2.0';
export const PROJECT_SCHEMA = 'LillyProject/v1' as const;
export const SCENE_SCHEMA = 'LillyScene/v1' as const;
export const ENTITY_SCHEMA = 'LillyEntity/v1' as const;
export const BLUEPRINT_SCHEMA = 'LillyBlueprint/v1' as const;
export const COMMAND_SCHEMA = 'LillyCommand/v1' as const;
export const BUILD_SCHEMA = 'LillyBuild/v1' as const;

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type LillyComponentType =
  | 'Transform'
  | 'Camera'
  | 'MeshRenderer'
  | 'Light'
  | 'RigidBody'
  | 'Collider'
  | 'AudioSource'
  | 'Animator'
  | 'Blueprint'
  | 'Script'
  | 'ParticleEmitter'
  | 'UIAnchor';

export interface LillyComponent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: LillyComponentType;
  enabled?: boolean;
  data: T;
}

export interface LillyEntity {
  schema: typeof ENTITY_SCHEMA;
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
  locked?: boolean;
  tags: string[];
  components: LillyComponent[];
}

export interface LillyEnvironment {
  background: string;
  ambientIntensity: number;
  fog?: { color: string; near: number; far: number } | null;
}

export interface LillyScene {
  schema: typeof SCENE_SCHEMA;
  id: string;
  name: string;
  environment: LillyEnvironment;
  entities: LillyEntity[];
  blueprintGraphIds: string[];
}

export interface LillyInputBinding {
  action: string;
  kind: 'button' | 'axis2d';
  keys: string[];
}

export interface LillyBlueprintPin {
  id: string;
  name: string;
  kind: 'exec' | 'data';
  direction: 'input' | 'output';
  dataType?: 'boolean' | 'number' | 'string' | 'vector2' | 'vector3' | 'entity' | 'asset' | 'any';
  required?: boolean;
}

export interface LillyBlueprintNode {
  id: string;
  type: string;
  label?: string;
  position: Vec2;
  pins: LillyBlueprintPin[];
  config?: Record<string, unknown>;
}

export interface LillyBlueprintEdge {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
}

export interface LillyBlueprint {
  schema: typeof BLUEPRINT_SCHEMA;
  id: string;
  name: string;
  variables: Array<{ id: string; name: string; dataType: string; defaultValue: unknown }>;
  nodes: LillyBlueprintNode[];
  edges: LillyBlueprintEdge[];
}

export interface LillyProject {
  schema: typeof PROJECT_SCHEMA;
  id: string;
  name: string;
  slug: string;
  engineVersion: string;
  revision: number;
  entryScene: string;
  scenes: LillyScene[];
  blueprints: LillyBlueprint[];
  levelRecipes: LillyLevelRecipe[];
  generatedLevels: LillyGeneratedLevel[];
  assets: Array<{ id: string; name: string; type: string; uri: string; metadata?: Record<string, unknown> }>;
  inputMap: LillyInputBinding[];
  settings: {
    renderer: 'webgl2' | 'webgpu-experimental';
    fixedStepHz: number;
    gravity: Vec3;
    mobileMode: 'play-review' | 'author-play';
    legacyImport?: Record<string, unknown>;
  };
}

export type LillyCommandOperation =
  | 'entity.create'
  | 'entity.delete'
  | 'entity.rename'
  | 'entity.reparent'
  | 'entity.set-enabled'
  | 'entity.set-locked'
  | 'component.set'
  | 'component.remove'
  | 'scene.set-environment'
  | 'blueprint.replace'
  | 'project.set-settings'
  | 'level.generate'
  | 'level.restore';

export interface LillyCommand {
  schema: typeof COMMAND_SCHEMA;
  commandId: string;
  projectId: string;
  baseRevision: number;
  operation: LillyCommandOperation;
  target: {
    sceneId?: string;
    entityId?: string;
    componentType?: LillyComponentType;
    graphId?: string;
  };
  payload: Record<string, unknown>;
}

export interface LillyBuild {
  schema: typeof BUILD_SCHEMA;
  id: string;
  projectId: string;
  projectRevision: number;
  engineVersion: string;
  status: 'queued' | 'building' | 'success' | 'failed' | 'published';
  tests: Array<{ name: string; status: 'passed' | 'failed'; details?: string }>;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  previewUrl: string;
  publicUrl?: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path: string;
  severity: 'error' | 'warning';
}

export const COMPONENT_DEFINITIONS: Record<LillyComponentType, { defaults: Record<string, unknown>; validate: (value: Record<string, unknown>) => string[] }> = {
  Transform: {
    defaults: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    validate: (value) => validateTransform(value),
  },
  Camera: { defaults: { projection: 'perspective', fov: 60, near: 0.1, far: 1000, primary: false }, validate: numericRangeValidator('fov', 1, 179) },
  MeshRenderer: { defaults: { geometry: 'box', material: { color: '#8ea7c4', roughness: 0.65, metalness: 0.05 }, castShadow: true, receiveShadow: true }, validate: () => [] },
  Light: { defaults: { kind: 'directional', color: '#fff4df', intensity: 2, castShadow: true }, validate: numericRangeValidator('intensity', 0, 100) },
  RigidBody: { defaults: { bodyType: 'dynamic', mass: 1, linearDamping: 0.1, angularDamping: 0.1, lockRotations: false }, validate: numericRangeValidator('mass', 0.0001, 100000) },
  Collider: { defaults: { shape: 'box', size: { x: 1, y: 1, z: 1 }, sensor: false, restitution: 0.1, friction: 0.7 }, validate: () => [] },
  AudioSource: { defaults: { assetId: '', volume: 0.8, loop: false, spatial: true, autoplay: false }, validate: numericRangeValidator('volume', 0, 1) },
  Animator: { defaults: { assetId: '', clip: '', speed: 1, autoplay: true }, validate: numericRangeValidator('speed', -20, 20) },
  Blueprint: { defaults: { graphId: '', enabled: true }, validate: () => [] },
  Script: { defaults: { source: '', enabled: true, timeoutMs: 8, capabilities: ['entity.read', 'entity.write', 'events.emit'] }, validate: numericRangeValidator('timeoutMs', 1, 16) },
  ParticleEmitter: { defaults: { rate: 12, lifetime: 0.8, color: '#7dd3fc', size: 0.08, burst: 0 }, validate: numericRangeValidator('rate', 0, 10000) },
  UIAnchor: { defaults: { anchor: 'top-left', offset: { x: 16, y: 16 }, text: '', visible: true }, validate: () => [] },
};

function numericRangeValidator(key: string, min: number, max: number) {
  return (value: Record<string, unknown>) => {
    const number = Number(value[key]);
    return Number.isFinite(number) && number >= min && number <= max
      ? []
      : [`${key} must be between ${min} and ${max}`];
  };
}

function isFiniteVec3(value: unknown): value is Vec3 {
  if (!value || typeof value !== 'object') return false;
  const vector = value as Vec3;
  return [vector.x, vector.y, vector.z].every(Number.isFinite);
}

function validateTransform(value: Record<string, unknown>) {
  const errors: string[] = [];
  if (!isFiniteVec3(value.position)) errors.push('position must be a finite Vector3');
  if (!isFiniteVec3(value.rotation)) errors.push('rotation must be a finite Vector3');
  if (!isFiniteVec3(value.scale) || Object.values(value.scale as Vec3).some((entry) => entry === 0)) errors.push('scale must be a non-zero finite Vector3');
  return errors;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function upgradeProject(projectInput: LillyProject): LillyProject {
  const project = deepClone(projectInput);
  project.levelRecipes = Array.isArray(project.levelRecipes)
    ? project.levelRecipes.map((recipe) => normalizeLevelRecipe(recipe))
    : [];
  project.generatedLevels = Array.isArray(project.generatedLevels) ? project.generatedLevels : [];
  project.assets = Array.isArray(project.assets) ? project.assets : [];
  project.inputMap = Array.isArray(project.inputMap) ? project.inputMap : [];
  project.settings = {
    renderer: project.settings?.renderer === 'webgpu-experimental' ? 'webgpu-experimental' : 'webgl2',
    fixedStepHz: Number(project.settings?.fixedStepHz || 60),
    gravity: project.settings?.gravity || { x: 0, y: -9.81, z: 0 },
    mobileMode: project.settings?.mobileMode === 'play-review' ? 'play-review' : 'author-play',
    ...(project.settings?.legacyImport ? { legacyImport: deepClone(project.settings.legacyImport) } : {}),
  };
  return project;
}

export function getScene(project: LillyProject, sceneId = project.entryScene): LillyScene {
  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) throw Object.assign(new Error(`Scene ${sceneId} was not found`), { code: 'SCENE_NOT_FOUND' });
  return scene;
}

export function getEntity(scene: LillyScene, entityId: string): LillyEntity {
  const entity = scene.entities.find((entry) => entry.id === entityId);
  if (!entity) throw Object.assign(new Error(`Entity ${entityId} was not found`), { code: 'ENTITY_NOT_FOUND' });
  return entity;
}

export function getComponent<T extends Record<string, unknown> = Record<string, unknown>>(entity: LillyEntity, type: LillyComponentType): LillyComponent<T> | null {
  return (entity.components.find((component) => component.type === type) as LillyComponent<T> | undefined) || null;
}

export function createsRecursiveParenting(scene: LillyScene, entityId: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (entityId === parentId) return true;
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const visited = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === entityId || visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = byId.get(cursor)?.parentId || null;
  }
  return false;
}

export function validateProject(project: LillyProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (project.schema !== PROJECT_SCHEMA) issues.push({ code: 'INVALID_PROJECT_SCHEMA', message: `Expected ${PROJECT_SCHEMA}`, path: 'schema', severity: 'error' });
  if (!project.scenes.some((scene) => scene.id === project.entryScene)) issues.push({ code: 'ENTRY_SCENE_MISSING', message: 'Entry scene does not exist', path: 'entryScene', severity: 'error' });
  for (const [sceneIndex, scene] of project.scenes.entries()) {
    const ids = new Set<string>();
    for (const [entityIndex, entity] of scene.entities.entries()) {
      const path = `scenes[${sceneIndex}].entities[${entityIndex}]`;
      if (ids.has(entity.id)) issues.push({ code: 'DUPLICATE_ENTITY_ID', message: `Duplicate entity id ${entity.id}`, path: `${path}.id`, severity: 'error' });
      ids.add(entity.id);
      if (entity.parentId && !scene.entities.some((candidate) => candidate.id === entity.parentId)) issues.push({ code: 'PARENT_MISSING', message: `Parent ${entity.parentId} does not exist`, path: `${path}.parentId`, severity: 'error' });
      if (createsRecursiveParenting(scene, entity.id, entity.parentId)) issues.push({ code: 'RECURSIVE_PARENT', message: 'Entity hierarchy contains a cycle', path: `${path}.parentId`, severity: 'error' });
      const componentTypes = new Set<string>();
      for (const [componentIndex, component] of entity.components.entries()) {
        if (componentTypes.has(component.type)) issues.push({ code: 'DUPLICATE_COMPONENT', message: `${component.type} can only be added once`, path: `${path}.components[${componentIndex}]`, severity: 'error' });
        componentTypes.add(component.type);
        const definition = COMPONENT_DEFINITIONS[component.type];
        if (!definition) issues.push({ code: 'UNKNOWN_COMPONENT', message: `Unknown component ${component.type}`, path: `${path}.components[${componentIndex}]`, severity: 'error' });
        else definition.validate(component.data).forEach((message) => issues.push({ code: 'INVALID_COMPONENT_VALUE', message, path: `${path}.components[${componentIndex}].data`, severity: 'error' }));
      }
    }
  }
  const recipes = Array.isArray(project.levelRecipes) ? project.levelRecipes : [];
  const generatedLevels = Array.isArray(project.generatedLevels) ? project.generatedLevels : [];
  for (const [recipeIndex, recipe] of recipes.entries()) {
    validateLevelRecipe(recipe).forEach((issue) => issues.push({
      ...issue,
      path: `levelRecipes[${recipeIndex}].${issue.path}`,
    }));
    if (!project.scenes.some((scene) => scene.id === recipe.sceneId)) {
      issues.push({ code: 'LEVEL_RECIPE_SCENE_MISSING', message: `Level recipe scene ${recipe.sceneId} does not exist`, path: `levelRecipes[${recipeIndex}].sceneId`, severity: 'error' });
    }
  }
  for (const [levelIndex, design] of generatedLevels.entries()) {
    const recipe = recipes.find((candidate) => candidate.id === design.recipeId) || null;
    if (!recipe) issues.push({ code: 'GENERATED_LEVEL_RECIPE_MISSING', message: `Generated level recipe ${design.recipeId} does not exist`, path: `generatedLevels[${levelIndex}].recipeId`, severity: 'error' });
    validateGeneratedLevel(design, recipe).forEach((issue) => issues.push({
      ...issue,
      path: `generatedLevels[${levelIndex}].${issue.path}`,
    }));
  }
  return issues;
}

function removeEntityTree(scene: LillyScene, entityId: string) {
  const removedIds = new Set([entityId]);
  let changed = true;
  while (changed) {
    changed = false;
    scene.entities.forEach((entity) => {
      if (entity.parentId && removedIds.has(entity.parentId) && !removedIds.has(entity.id)) {
        removedIds.add(entity.id);
        changed = true;
      }
    });
  }
  const removed = scene.entities.filter((entity) => removedIds.has(entity.id));
  scene.entities = scene.entities.filter((entity) => !removedIds.has(entity.id));
  return removed;
}

type LevelSnapshot = {
  sceneId: string;
  environment: LillyEnvironment;
  recipes: LillyLevelRecipe[];
  designs: LillyGeneratedLevel[];
  entities: LillyEntity[];
  playerTransform: LillyComponent | null;
  objectiveGraph: LillyBlueprint | null;
  uiAnchor: { entityId: string; component: LillyComponent } | null;
  mobileMode: LillyProject['settings']['mobileMode'];
};

function findObjectiveGraph(project: LillyProject, scene: LillyScene) {
  return project.blueprints.find((graph) => scene.blueprintGraphIds.includes(graph.id) && graph.variables.some((variable) => variable.id === 'score')) || null;
}

function isLegacyArenaEntity(entity: LillyEntity) {
  return entity.id === 'arena-floor' || /^pickup-[1-3]$/.test(entity.id);
}

function isReplaceableLevelEntity(entity: LillyEntity) {
  return entity.tags.includes('generated') || isLegacyArenaEntity(entity);
}

function captureLevelSnapshot(project: LillyProject, scene: LillyScene): LevelSnapshot {
  const player = scene.entities.find((entity) => entity.tags.includes('player')) || null;
  const playerTransform = player ? getComponent(player, 'Transform') : null;
  const objectiveGraph = findObjectiveGraph(project, scene);
  const rulesEntity = scene.entities.find((entity) => entity.tags.includes('gameplay') && getComponent(entity, 'UIAnchor')) || null;
  const uiAnchor = rulesEntity && getComponent(rulesEntity, 'UIAnchor')
    ? { entityId: rulesEntity.id, component: deepClone(getComponent(rulesEntity, 'UIAnchor')!) }
    : null;
  return {
    sceneId: scene.id,
    environment: deepClone(scene.environment),
    recipes: deepClone((project.levelRecipes || []).filter((recipe) => recipe.sceneId === scene.id)),
    designs: deepClone((project.generatedLevels || []).filter((design) => design.sceneId === scene.id)),
    entities: deepClone(scene.entities.filter(isReplaceableLevelEntity)),
    playerTransform: playerTransform ? deepClone(playerTransform) : null,
    objectiveGraph: objectiveGraph ? deepClone(objectiveGraph) : null,
    uiAnchor,
    mobileMode: project.settings.mobileMode,
  };
}

function restoreLevelSnapshot(project: LillyProject, scene: LillyScene, snapshot: LevelSnapshot) {
  scene.entities = scene.entities.filter((entity) => !isReplaceableLevelEntity(entity));
  scene.entities.push(...deepClone(snapshot.entities || []));
  scene.environment = deepClone(snapshot.environment);
  project.levelRecipes = [
    ...(project.levelRecipes || []).filter((recipe) => recipe.sceneId !== scene.id),
    ...deepClone(snapshot.recipes || []),
  ];
  project.generatedLevels = [
    ...(project.generatedLevels || []).filter((design) => design.sceneId !== scene.id),
    ...deepClone(snapshot.designs || []),
  ];
  project.settings.mobileMode = snapshot.mobileMode || 'author-play';
  const player = scene.entities.find((entity) => entity.tags.includes('player')) || null;
  if (player && snapshot.playerTransform) {
    const index = player.components.findIndex((entry) => entry.type === 'Transform');
    if (index >= 0) player.components[index] = deepClone(snapshot.playerTransform);
    else player.components.push(deepClone(snapshot.playerTransform));
  }
  if (snapshot.objectiveGraph) {
    const index = project.blueprints.findIndex((graph) => graph.id === snapshot.objectiveGraph!.id);
    if (index >= 0) project.blueprints[index] = deepClone(snapshot.objectiveGraph);
    else project.blueprints.push(deepClone(snapshot.objectiveGraph));
  }
  if (snapshot.uiAnchor) {
    const entityValue = scene.entities.find((entity) => entity.id === snapshot.uiAnchor!.entityId);
    if (entityValue) {
      const index = entityValue.components.findIndex((entry) => entry.type === 'UIAnchor');
      if (index >= 0) entityValue.components[index] = deepClone(snapshot.uiAnchor.component);
      else entityValue.components.push(deepClone(snapshot.uiAnchor.component));
    }
  }
}

function updateGeneratedObjective(project: LillyProject, scene: LillyScene, recipe: LillyLevelRecipe) {
  const graph = findObjectiveGraph(project, scene);
  if (graph) {
    graph.nodes.forEach((node) => {
      if (node.type === 'flow.branch') {
        node.label = recipe.objective === 'reach-exit' ? 'Exit reached?' : `Score = ${recipe.gameplay.pickupCount}?`;
        node.config = {
          ...(node.config || {}),
          expression: recipe.objective === 'reach-exit' ? 'exitReached === true' : `score >= ${recipe.gameplay.pickupCount}`,
        };
      }
      if (node.type === 'presentation.hud-message') {
        node.config = { ...(node.config || {}), message: `${recipe.name} secured!` };
      }
    });
  }
  const rulesEntity = scene.entities.find((entity) => entity.tags.includes('gameplay'));
  const anchor = rulesEntity ? getComponent(rulesEntity, 'UIAnchor') : null;
  if (anchor) {
    anchor.data.text = recipe.objective === 'reach-exit'
      ? 'Find and reach the exit beacon'
      : `Collect ${recipe.gameplay.pickupCount} energy cores, then reach the exit`;
  }
}

export function applyCommand(projectInput: LillyProject, command: LillyCommand): { project: LillyProject; inverse: LillyCommand } {
  if (command.schema !== COMMAND_SCHEMA) throw Object.assign(new Error(`Commands must use ${COMMAND_SCHEMA}`), { code: 'INVALID_COMMAND_SCHEMA' });
  if (command.projectId !== projectInput.id) throw Object.assign(new Error('Command projectId does not match the project'), { code: 'PROJECT_MISMATCH' });
  const project = upgradeProject(projectInput);
  const scene = command.target.sceneId ? getScene(project, command.target.sceneId) : null;
  const inverseBase = { schema: COMMAND_SCHEMA, commandId: `${command.commandId}:inverse`, projectId: project.id, baseRevision: command.baseRevision, target: deepClone(command.target) } as Omit<LillyCommand, 'operation' | 'payload'>;
  let inverse: LillyCommand;

  switch (command.operation) {
    case 'entity.create': {
      if (!scene) throw new Error('entity.create requires target.sceneId');
      const entity = deepClone(command.payload.entity as LillyEntity);
      if (!entity?.id || scene.entities.some((entry) => entry.id === entity.id)) throw Object.assign(new Error('Created entity id must be unique'), { code: 'DUPLICATE_ENTITY_ID' });
      if (entity.parentId && !scene.entities.some((entry) => entry.id === entity.parentId)) throw Object.assign(new Error('Parent entity does not exist'), { code: 'PARENT_MISSING' });
      scene.entities.push(entity);
      const descendants = Array.isArray(command.payload.descendants)
        ? deepClone(command.payload.descendants as LillyEntity[])
        : [];
      for (const descendant of descendants) {
        if (!descendant?.id || scene.entities.some((entry) => entry.id === descendant.id)) {
          throw Object.assign(new Error('Restored descendant id must be unique'), { code: 'DUPLICATE_ENTITY_ID' });
        }
        scene.entities.push(descendant);
      }
      inverse = { ...inverseBase, operation: 'entity.delete', target: { ...command.target, entityId: entity.id }, payload: {} };
      break;
    }
    case 'entity.delete': {
      if (!scene || !command.target.entityId) throw new Error('entity.delete requires a scene and entity');
      const removed = removeEntityTree(scene, command.target.entityId);
      if (removed.length === 0) throw Object.assign(new Error('Entity was not found'), { code: 'ENTITY_NOT_FOUND' });
      inverse = { ...inverseBase, operation: 'entity.create', target: { sceneId: scene.id }, payload: { entity: removed[0], descendants: removed.slice(1) } };
      break;
    }
    case 'entity.rename': {
      if (!scene || !command.target.entityId) throw new Error('entity.rename requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const previous = entity.name;
      entity.name = String(command.payload.name || '').trim() || entity.name;
      inverse = { ...inverseBase, operation: 'entity.rename', payload: { name: previous } };
      break;
    }
    case 'entity.reparent': {
      if (!scene || !command.target.entityId) throw new Error('entity.reparent requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const parentId = command.payload.parentId ? String(command.payload.parentId) : null;
      if (parentId && !scene.entities.some((entry) => entry.id === parentId)) throw Object.assign(new Error('Parent entity does not exist'), { code: 'PARENT_MISSING' });
      if (createsRecursiveParenting(scene, entity.id, parentId)) throw Object.assign(new Error('Recursive parenting is not allowed'), { code: 'RECURSIVE_PARENT' });
      const previous = entity.parentId;
      entity.parentId = parentId;
      inverse = { ...inverseBase, operation: 'entity.reparent', payload: { parentId: previous } };
      break;
    }
    case 'entity.set-enabled': {
      if (!scene || !command.target.entityId) throw new Error('entity.set-enabled requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const previous = entity.enabled;
      entity.enabled = command.payload.enabled !== false;
      inverse = { ...inverseBase, operation: 'entity.set-enabled', payload: { enabled: previous } };
      break;
    }
    case 'entity.set-locked': {
      if (!scene || !command.target.entityId) throw new Error('entity.set-locked requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const previous = entity.locked === true;
      entity.locked = command.payload.locked === true;
      inverse = { ...inverseBase, operation: 'entity.set-locked', payload: { locked: previous } };
      break;
    }
    case 'component.set': {
      if (!scene || !command.target.entityId || !command.target.componentType) throw new Error('component.set requires a scene, entity, and componentType');
      const entity = getEntity(scene, command.target.entityId);
      const index = entity.components.findIndex((entry) => entry.type === command.target.componentType);
      const previous = index >= 0 ? deepClone(entity.components[index]) : null;
      const definition = COMPONENT_DEFINITIONS[command.target.componentType];
      const next: LillyComponent = {
        type: command.target.componentType,
        enabled: command.payload.enabled !== false,
        data: { ...deepClone(definition.defaults), ...deepClone((command.payload.data || {}) as Record<string, unknown>) },
      };
      const errors = definition.validate(next.data);
      if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'INVALID_COMPONENT_VALUE' });
      if (index >= 0) entity.components[index] = next;
      else entity.components.push(next);
      inverse = previous
        ? { ...inverseBase, operation: 'component.set', payload: { enabled: previous.enabled, data: previous.data } }
        : { ...inverseBase, operation: 'component.remove', payload: {} };
      break;
    }
    case 'component.remove': {
      if (!scene || !command.target.entityId || !command.target.componentType) throw new Error('component.remove requires a scene, entity, and componentType');
      const entity = getEntity(scene, command.target.entityId);
      const index = entity.components.findIndex((entry) => entry.type === command.target.componentType);
      if (index < 0) throw Object.assign(new Error('Component was not found'), { code: 'COMPONENT_NOT_FOUND' });
      const previous = entity.components.splice(index, 1)[0];
      inverse = { ...inverseBase, operation: 'component.set', payload: { enabled: previous.enabled, data: previous.data } };
      break;
    }
    case 'scene.set-environment': {
      if (!scene) throw new Error('scene.set-environment requires target.sceneId');
      const previous = deepClone(scene.environment);
      scene.environment = { ...scene.environment, ...deepClone(command.payload) } as LillyEnvironment;
      inverse = { ...inverseBase, operation: 'scene.set-environment', payload: { ...previous } };
      break;
    }
    case 'blueprint.replace': {
      const graph = deepClone(command.payload.graph as LillyBlueprint);
      const graphId = command.target.graphId || graph?.id;
      if (!graphId || !graph) throw new Error('blueprint.replace requires a graph');
      const index = project.blueprints.findIndex((entry) => entry.id === graphId);
      const previous = index >= 0 ? deepClone(project.blueprints[index]) : null;
      if (index >= 0) project.blueprints[index] = graph;
      else project.blueprints.push(graph);
      inverse = previous
        ? { ...inverseBase, operation: 'blueprint.replace', payload: { graph: previous } }
        : { ...inverseBase, operation: 'blueprint.replace', payload: { graph: { ...graph, nodes: [], edges: [] } } };
      break;
    }
    case 'project.set-settings': {
      const previous = deepClone(project.settings);
      project.settings = { ...project.settings, ...deepClone(command.payload) } as LillyProject['settings'];
      inverse = { ...inverseBase, operation: 'project.set-settings', payload: previous };
      break;
    }
    case 'level.generate': {
      if (!scene) throw new Error('level.generate requires target.sceneId');
      const rawRecipe = {
        ...deepClone((command.payload.recipe || {}) as LillyLevelRecipe),
        sceneId: scene.id,
      } as LillyLevelRecipe;
      const recipeIssues = validateLevelRecipe(rawRecipe).filter((issue) => issue.severity === 'error');
      if (recipeIssues.length) throw Object.assign(new Error(recipeIssues.map((issue) => issue.message).join('; ')), { code: 'INVALID_LEVEL_RECIPE', issues: recipeIssues });
      const recipe = normalizeLevelRecipe(rawRecipe);
      const snapshot = captureLevelSnapshot(project, scene);
      const rootEntity = scene.entities.find((entity) => entity.parentId === null && entity.tags.includes('root'))
        || scene.entities.find((entity) => entity.parentId === null)
        || null;
      const generated = generateLevel(recipe, { parentId: rootEntity?.id || null });
      scene.entities = scene.entities.filter((entity) => !isReplaceableLevelEntity(entity));
      scene.entities.push(...generated.entities);
      scene.environment = generated.environment;
      project.engineVersion = ENGINE_VERSION;
      project.levelRecipes = [...(project.levelRecipes || []).filter((entry) => entry.sceneId !== scene.id), generated.recipe];
      project.generatedLevels = [...(project.generatedLevels || []).filter((entry) => entry.sceneId !== scene.id), generated.design];
      project.settings.mobileMode = 'author-play';
      const player = scene.entities.find((entity) => entity.tags.includes('player')) || null;
      const playerTransform = player ? getComponent(player, 'Transform') : null;
      if (playerTransform) playerTransform.data.position = deepClone(generated.design.spawn.position);
      updateGeneratedObjective(project, scene, generated.recipe);
      inverse = {
        ...inverseBase,
        operation: 'level.restore',
        target: { sceneId: scene.id },
        payload: { snapshot },
      };
      break;
    }
    case 'level.restore': {
      if (!scene) throw new Error('level.restore requires target.sceneId');
      const snapshot = deepClone(command.payload.snapshot as LevelSnapshot);
      if (!snapshot || snapshot.sceneId !== scene.id || !Array.isArray(snapshot.entities)) {
        throw Object.assign(new Error('level.restore requires a valid saved level snapshot'), { code: 'INVALID_LEVEL_SNAPSHOT' });
      }
      const currentSnapshot = captureLevelSnapshot(project, scene);
      restoreLevelSnapshot(project, scene, snapshot);
      inverse = {
        ...inverseBase,
        operation: 'level.restore',
        target: { sceneId: scene.id },
        payload: { snapshot: currentSnapshot },
      };
      break;
    }
    default:
      throw Object.assign(new Error(`Unsupported command operation ${(command as LillyCommand).operation}`), { code: 'UNSUPPORTED_COMMAND' });
  }

  const issues = validateProject(project).filter((issue) => issue.severity === 'error');
  if (issues.length) throw Object.assign(new Error(issues.map((issue) => issue.message).join('; ')), { code: 'PROJECT_VALIDATION_FAILED', issues });
  return { project, inverse };
}

export function applyCommandBatch(projectInput: LillyProject, commands: LillyCommand[], baseRevision: number): { project: LillyProject; inverses: LillyCommand[] } {
  if (!Number.isInteger(baseRevision) || projectInput.revision !== baseRevision) {
    throw Object.assign(new Error(`Revision conflict: project is at ${projectInput.revision}, command batch targets ${baseRevision}`), { code: 'REVISION_CONFLICT', currentRevision: projectInput.revision });
  }
  let project = deepClone(projectInput);
  const inverses: LillyCommand[] = [];
  for (const command of commands) {
    if (command.baseRevision !== baseRevision) throw Object.assign(new Error('Every command must target the same baseRevision'), { code: 'MIXED_BASE_REVISION' });
    const result = applyCommand(project, command);
    project = result.project;
    inverses.unshift(result.inverse);
  }
  project.revision = baseRevision + 1;
  inverses.forEach((inverse) => { inverse.baseRevision = project.revision; });
  return { project, inverses };
}

export class CommandHistory {
  private undoStack: Array<{ forward: LillyCommand[]; inverse: LillyCommand[] }> = [];
  private redoStack: Array<{ forward: LillyCommand[]; inverse: LillyCommand[] }> = [];

  record(forward: LillyCommand[], inverse: LillyCommand[]) {
    this.undoStack.push({ forward: deepClone(forward), inverse: deepClone(inverse) });
    this.redoStack = [];
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo(project: LillyProject) {
    const entry = this.undoStack.pop();
    if (!entry) return project;
    const commands = entry.inverse.map((command) => ({ ...command, baseRevision: project.revision }));
    const result = applyCommandBatch(project, commands, project.revision);
    this.redoStack.push(entry);
    return result.project;
  }

  redo(project: LillyProject) {
    const entry = this.redoStack.pop();
    if (!entry) return project;
    const commands = entry.forward.map((command) => ({ ...command, baseRevision: project.revision }));
    const result = applyCommandBatch(project, commands, project.revision);
    this.undoStack.push(entry);
    return result.project;
  }
}

export class FixedStepClock {
  readonly stepSeconds: number;
  private accumulator = 0;
  private lastTime = 0;

  constructor(fixedStepHz = 60) {
    if (!Number.isFinite(fixedStepHz) || fixedStepHz < 1 || fixedStepHz > 240) throw new Error('fixedStepHz must be between 1 and 240');
    this.stepSeconds = 1 / fixedStepHz;
  }

  reset(nowSeconds = 0) { this.accumulator = 0; this.lastTime = nowSeconds; }

  advance(nowSeconds: number, step: (deltaSeconds: number) => void, maxSteps = 8) {
    const frameDelta = this.lastTime > 0 ? Math.min(0.25, Math.max(0, nowSeconds - this.lastTime)) : 0;
    this.lastTime = nowSeconds;
    this.accumulator += frameDelta;
    let steps = 0;
    while (this.accumulator + Number.EPSILON >= this.stepSeconds && steps < maxSteps) {
      step(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      steps += 1;
    }
    if (steps === maxSteps) this.accumulator = 0;
    return { steps, alpha: this.accumulator / this.stepSeconds };
  }
}

export class InputActionState {
  private pressed = new Set<string>();
  constructor(private bindings: LillyInputBinding[]) {}
  setKey(code: string, isPressed: boolean) { isPressed ? this.pressed.add(code) : this.pressed.delete(code); }
  button(action: string) { return this.bindings.some((binding) => binding.action === action && binding.keys.some((key) => this.pressed.has(key))); }
  axis2d(action: string): Vec2 {
    const binding = this.bindings.find((entry) => entry.action === action && entry.kind === 'axis2d');
    if (!binding) return { x: 0, y: 0 };
    const [up, down, left, right] = binding.keys;
    return { x: Number(this.pressed.has(right)) - Number(this.pressed.has(left)), y: Number(this.pressed.has(up)) - Number(this.pressed.has(down)) };
  }
}

function component(type: LillyComponentType, data: Record<string, unknown>): LillyComponent {
  return { type, enabled: true, data: { ...deepClone(COMPONENT_DEFINITIONS[type].defaults), ...data } };
}

function transform(position: Vec3, scale: Vec3 = { x: 1, y: 1, z: 1 }) {
  return component('Transform', { position, rotation: { x: 0, y: 0, z: 0 }, scale });
}

export function createProceduralProject(input: {
  id: string;
  name?: string;
  slug?: string;
  prompt?: string;
  seed?: string;
} = { id: 'expedition' }): LillyProject {
  const id = input.id;
  const sceneId = 'arena';
  const graphId = 'arena-win-condition';
  const prompt = input.prompt || 'A winding neon ruin with readable rooms, a few pulse traps, glowing energy cores, landmarks, and a final exit beacon.';
  const recipe = createLevelRecipeFromPrompt({
    projectId: id,
    sceneId,
    prompt,
    seed: input.seed || `${id}-first-world`,
    previous: null,
  });
  const generated = generateLevel(recipe, { parentId: 'world' });
  const pickupCount = recipe.gameplay.pickupCount;
  return {
    schema: PROJECT_SCHEMA,
    id,
    name: input.name || 'Neon Trail',
    slug: input.slug || 'neon-trail',
    engineVersion: ENGINE_VERSION,
    revision: 1,
    entryScene: sceneId,
    scenes: [{
      schema: SCENE_SCHEMA,
      id: sceneId,
      name: recipe.name,
      environment: generated.environment,
      blueprintGraphIds: [graphId],
      entities: [
        { schema: ENTITY_SCHEMA, id: 'world', name: 'World', parentId: null, enabled: true, tags: ['root'], components: [] },
        { schema: ENTITY_SCHEMA, id: 'sun', name: 'Key Light', parentId: 'world', enabled: true, tags: ['lighting'], components: [transform({ x: 8, y: 14, z: 6 }), component('Light', { kind: 'directional', intensity: 3.4, color: '#dbeafe', castShadow: true })] },
        { schema: ENTITY_SCHEMA, id: 'player', name: 'Player', parentId: 'world', enabled: true, tags: ['player'], components: [transform(generated.design.spawn.position), component('MeshRenderer', { geometry: 'capsule', material: { color: '#38bdf8', roughness: 0.28, metalness: 0.35, emissive: '#075985', emissiveIntensity: 0.22 } }), component('RigidBody', { bodyType: 'dynamic', mass: 1, lockRotations: true }), component('Collider', { shape: 'capsule', size: { x: 0.9, y: 1.4, z: 0.9 } }), component('Blueprint', { graphId: 'player-controller' })] },
        { schema: ENTITY_SCHEMA, id: 'camera', name: 'Follow Camera', parentId: 'world', enabled: true, tags: ['camera'], components: [transform({ x: generated.design.spawn.position.x + 7, y: 7, z: generated.design.spawn.position.z + 11 }), component('Camera', { primary: true, fov: 58 })] },
        { schema: ENTITY_SCHEMA, id: 'game-rules', name: 'Expedition Rules', parentId: 'world', enabled: true, tags: ['gameplay'], components: [component('Blueprint', { graphId }), component('UIAnchor', { anchor: 'top-left', text: `Collect ${pickupCount} energy cores, then reach the exit` })] },
        ...generated.entities,
      ],
    }],
    blueprints: [
      {
        schema: BLUEPRINT_SCHEMA,
        id: graphId,
        name: 'Expedition Win Condition',
        variables: [
          { id: 'score', name: 'Score', dataType: 'number', defaultValue: 0 },
          { id: 'exitReached', name: 'Exit Reached', dataType: 'boolean', defaultValue: false },
        ],
        nodes: [
          { id: 'event-pickup', type: 'event.custom', label: 'On Pickup', position: { x: 40, y: 80 }, pins: [{ id: 'exec-out', name: 'Then', kind: 'exec', direction: 'output' }] },
          { id: 'add-score', type: 'variable.add', label: 'Add Score', position: { x: 280, y: 80 }, pins: [{ id: 'exec-in', name: 'In', kind: 'exec', direction: 'input' }, { id: 'exec-out', name: 'Then', kind: 'exec', direction: 'output' }], config: { variableId: 'score', amount: 1 } },
          { id: 'branch-win', type: 'flow.branch', label: `Score = ${pickupCount}?`, position: { x: 510, y: 80 }, pins: [{ id: 'exec-in', name: 'In', kind: 'exec', direction: 'input' }, { id: 'true', name: 'True', kind: 'exec', direction: 'output' }, { id: 'condition', name: 'Condition', kind: 'data', direction: 'input', dataType: 'boolean' }], config: { expression: `score >= ${pickupCount}` } },
          { id: 'hud-win', type: 'presentation.hud-message', label: 'Unlock Exit', position: { x: 760, y: 20 }, pins: [{ id: 'exec-in', name: 'In', kind: 'exec', direction: 'input' }], config: { message: 'Exit beacon unlocked!' } },
        ],
        edges: [
          { id: 'e1', sourceNodeId: 'event-pickup', sourcePinId: 'exec-out', targetNodeId: 'add-score', targetPinId: 'exec-in' },
          { id: 'e2', sourceNodeId: 'add-score', sourcePinId: 'exec-out', targetNodeId: 'branch-win', targetPinId: 'exec-in' },
          { id: 'e3', sourceNodeId: 'branch-win', sourcePinId: 'true', targetNodeId: 'hud-win', targetPinId: 'exec-in' },
        ],
      },
      {
        schema: BLUEPRINT_SCHEMA,
        id: 'player-controller',
        name: 'Third Person Controller',
        variables: [],
        nodes: [
          { id: 'fixed', type: 'event.fixed-update', label: 'Fixed Update', position: { x: 40, y: 60 }, pins: [{ id: 'exec-out', name: 'Then', kind: 'exec', direction: 'output' }] },
          { id: 'move', type: 'transform.move', label: 'Move from Input', position: { x: 290, y: 60 }, pins: [{ id: 'exec-in', name: 'In', kind: 'exec', direction: 'input' }], config: { inputAction: 'Move', speed: 6 } },
        ],
        edges: [{ id: 'pc1', sourceNodeId: 'fixed', sourcePinId: 'exec-out', targetNodeId: 'move', targetPinId: 'exec-in' }],
      },
    ],
    levelRecipes: [generated.recipe],
    generatedLevels: [generated.design],
    assets: [],
    inputMap: [
      { action: 'Move', kind: 'axis2d', keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] },
      { action: 'Jump', kind: 'button', keys: ['Space'] },
      { action: 'Reset', kind: 'button', keys: ['KeyR'] },
    ],
    settings: { renderer: 'webgl2', fixedStepHz: 60, gravity: { x: 0, y: -9.81, z: 0 }, mobileMode: 'author-play' },
  };
}

export function createArenaProject(input: { id: string; name?: string; slug?: string; prompt?: string; seed?: string } = { id: 'arena' }): LillyProject {
  return createProceduralProject(input);
}
