import {
  computeGeneratedLevelChecksum,
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

export const ENGINE_VERSION = '0.7.0';
export const PROJECT_SCHEMA = 'LillyProject/v1' as const;
export const SCENE_SCHEMA = 'LillyScene/v1' as const;
export const ENTITY_SCHEMA = 'LillyEntity/v1' as const;
export const BLUEPRINT_SCHEMA = 'LillyBlueprint/v1' as const;
export const COMMAND_SCHEMA = 'LillyCommand/v1' as const;
export const BUILD_SCHEMA = 'LillyBuild/v1' as const;
export const SOURCE_FILE_SCHEMA = 'LillySourceFile/v1' as const;
export const GAME_MODULE_SCHEMA = 'LillyGameModule/v1' as const;
export const MECHANIC_SCHEMA = 'LillyMechanic/v1' as const;
export const PREFAB_SCHEMA = 'LillyPrefab/v1' as const;
export const MECHANIC_TEST_SCHEMA = 'LillyMechanicTest/v1' as const;
export const MATERIAL_SCHEMA = 'LillyMaterial/v1' as const;
export const ASSET_METADATA_SCHEMA = 'LillyAssetMetadata/v1' as const;
export const ANIMATION_CONTROLLER_SCHEMA = 'LillyAnimationController/v1' as const;
export const TERRAIN_SCHEMA = 'LillyTerrain/v1' as const;
export const PREFAB_INSTANCE_SCHEMA = 'LillyPrefabInstance/v1' as const;
export const DATA_ASSET_SCHEMA = 'LillyDataAsset/v1' as const;
export const BUILD_PROFILE_SCHEMA = 'LillyBuildProfile/v1' as const;

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };
export type LillyRuntimeProfile = 'expedition' | 'module-driven';
export type LillyProjectTemplateId = 'blank' | 'expedition' | 'third-person-explorer' | 'top-down-action';

export interface LillyProjectTemplateDefinition {
  id: LillyProjectTemplateId;
  name: string;
  description: string;
  genre: string;
  runtimeProfile: LillyRuntimeProfile;
  playable: boolean;
  tags: string[];
}

export type LillySourceFileKind =
  | 'module-manifest'
  | 'mechanic'
  | 'system'
  | 'prefab'
  | 'test'
  | 'material'
  | 'asset-metadata'
  | 'animation-controller'
  | 'terrain'
  | 'blueprint'
  | 'scene'
  | 'data';

export interface LillySourceFile {
  schema: typeof SOURCE_FILE_SCHEMA;
  path: string;
  kind: LillySourceFileKind;
  language: 'json' | 'typescript';
  content: string;
  enabled: boolean;
}

export type LillyComponentType =
  | 'Transform'
  | 'Camera'
  | 'CharacterController'
  | 'MeshRenderer'
  | 'Light'
  | 'RigidBody'
  | 'Collider'
  | 'AudioSource'
  | 'Animator'
  | 'DataReference'
  | 'Terrain'
  | 'Blueprint'
  | 'Script'
  | 'ParticleEmitter'
  | 'UIAnchor'
  | 'Health'
  | 'Combatant'
  | 'EnemyBrain'
  | 'EncounterMember'
  | 'EncounterGate'
  | 'Checkpoint'
  | 'Behavior'
  | 'State';

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

export interface LillyPrefabDefinition {
  schema: typeof PREFAB_SCHEMA;
  id: string;
  moduleId: string;
  name: string;
  rootEntityId: string;
  entities: LillyEntity[];
  variants?: LillyPrefabVariantDefinition[];
}

export interface LillyPrefabEntityOverride {
  name?: string;
  enabled?: boolean;
  locked?: boolean;
  tags?: string[];
  components?: Partial<Record<LillyComponentType, Record<string, unknown>>>;
  componentEnabled?: Partial<Record<LillyComponentType, boolean>>;
}

export interface LillyPrefabVariantDefinition {
  id: string;
  name?: string;
  entities: Record<string, LillyPrefabEntityOverride>;
}

export interface LillyPrefabInstanceConfig {
  /** Optional authored variant applied before instance-specific overrides. */
  variant?: string;
  /** Translation added to the authored root Transform position. */
  position?: Vec3;
  /** Overrides keyed by the source entity id stored in LillyPrefab/v1. */
  entities?: Record<string, LillyPrefabEntityOverride>;
}

export interface LillyPrefabInstance {
  schema: typeof PREFAB_INSTANCE_SCHEMA;
  instanceId: string;
  prefabId: string;
  prefabPath: string;
  sourceHash: string;
  rootEntityId: string;
  parentId: string | null;
  variant?: string;
  overrides: LillyPrefabInstanceConfig;
  status: 'linked' | 'missing-source' | 'invalid-source';
}

export interface LillyDataAsset {
  schema: typeof DATA_ASSET_SCHEMA;
  id: string;
  name: string;
  type: 'config' | 'stats' | 'table' | 'dialogue' | 'custom';
  tags: string[];
  data: Record<string, unknown>;
}

export interface LillyBuildProfile {
  schema: typeof BUILD_PROFILE_SCHEMA;
  id: string;
  name: string;
  target: 'browser';
  mode: 'development' | 'release';
  entryScene: string;
  renderer: 'webgl2' | 'webgpu-experimental';
  quality: 'performance' | 'balanced' | 'quality';
  debugOverlay: boolean;
  mobileControls: boolean;
}

export type LillyMaterialTextureSlot = 'baseColor' | 'normal' | 'roughness' | 'metalness' | 'emissive';

export interface LillyMaterialDefinition {
  schema: typeof MATERIAL_SCHEMA;
  id: string;
  moduleId: string;
  name: string;
  shading: 'standard' | 'physical' | 'toon' | 'unlit';
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  transparent?: boolean;
  doubleSided?: boolean;
  flatShading?: boolean;
  wireframe?: boolean;
  clearcoat?: number;
  clearcoatRoughness?: number;
  textures?: Partial<Record<LillyMaterialTextureSlot, string>>;
  tiling?: Vec2;
}

export interface LillyAssetMetadataDefinition {
  schema: typeof ASSET_METADATA_SCHEMA;
  id: string;
  moduleId: string;
  assetId: string;
  name: string;
  kind: 'model' | 'texture' | 'audio';
  scale?: Vec3;
  pivot?: Vec3;
  castShadow?: boolean;
  receiveShadow?: boolean;
  collision?: {
    shape: 'box' | 'sphere' | 'capsule' | 'cylinder';
    size?: Vec3;
    center?: Vec3;
    sensor?: boolean;
  } | null;
  lods?: Array<{ assetId: string; maxDistance: number }>;
  animations?: Array<{ name: string; clip: string; loop?: boolean; speed?: number }>;
}

export interface LillyAnimationStateDefinition {
  id: string;
  mode: 'clip' | 'spin' | 'float' | 'pulse';
  clip?: string;
  loop?: boolean;
  speed?: number;
  axis?: 'x' | 'y' | 'z';
  amplitude?: number;
  frequency?: number;
  fadeSeconds?: number;
}

export interface LillyAnimationControllerDefinition {
  schema: typeof ANIMATION_CONTROLLER_SCHEMA;
  id: string;
  moduleId: string;
  name: string;
  assetId?: string;
  defaultState: string;
  states: LillyAnimationStateDefinition[];
}

export interface LillyTerrainDefinition {
  schema: typeof TERRAIN_SCHEMA;
  id: string;
  moduleId: string;
  name: string;
  size: Vec2;
  resolution: number;
  heights: number[];
  heightScale: number;
  materialId?: string;
  collision?: boolean;
  walkable?: boolean;
}

export interface LillyProjectAsset {
  id: string;
  name: string;
  type: string;
  uri: string;
  metadata?: Record<string, unknown>;
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
  prefabInstances: LillyPrefabInstance[];
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
  files: LillySourceFile[];
  assets: LillyProjectAsset[];
  dataAssets: LillyDataAsset[];
  buildProfiles: LillyBuildProfile[];
  activeBuildProfileId: string;
  inputMap: LillyInputBinding[];
  settings: {
    renderer: 'webgl2' | 'webgpu-experimental';
    fixedStepHz: number;
    gravity: Vec3;
    mobileMode: 'play-review' | 'author-play';
    runtimeProfile: LillyRuntimeProfile;
    buildProfile?: {
      id: string;
      mode: LillyBuildProfile['mode'];
      quality: LillyBuildProfile['quality'];
      debugOverlay: boolean;
      mobileControls: boolean;
    };
    legacyImport?: Record<string, unknown>;
  };
}

export type LillyCommandOperation =
  | 'scene.create'
  | 'scene.delete'
  | 'scene.rename'
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
  | 'blueprint.delete'
  | 'file.upsert'
  | 'file.delete'
  | 'prefab.instantiate'
  | 'prefab.update-instance'
  | 'prefab.refresh'
  | 'prefab.unpack'
  | 'prefab.restore-state'
  | 'data-asset.upsert'
  | 'data-asset.delete'
  | 'build-profile.upsert'
  | 'build-profile.delete'
  | 'project.set-active-build-profile'
  | 'input.replace'
  | 'project.set-entry-scene'
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
    path?: string;
    prefabId?: string;
    instanceId?: string;
    dataAssetId?: string;
    buildProfileId?: string;
  };
  payload: Record<string, unknown>;
}

export interface LillyBuild {
  schema: typeof BUILD_SCHEMA;
  id: string;
  projectId: string;
  projectRevision: number;
  engineVersion: string;
  buildProfileId: string;
  buildProfile: LillyBuildProfile;
  status: 'queued' | 'building' | 'success' | 'failed' | 'published';
  tests: Array<{ name: string; status: 'passed' | 'failed'; details?: string }>;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  previewUrl: string;
  publicUrl?: string;
}

export function createDefaultBuildProfiles(
  entryScene: string,
  renderer: LillyBuildProfile['renderer'] = 'webgl2',
): LillyBuildProfile[] {
  return [
    {
      schema: BUILD_PROFILE_SCHEMA,
      id: 'development',
      name: 'Development',
      target: 'browser',
      mode: 'development',
      entryScene,
      renderer,
      quality: 'balanced',
      debugOverlay: true,
      mobileControls: true,
    },
    {
      schema: BUILD_PROFILE_SCHEMA,
      id: 'release',
      name: 'Release',
      target: 'browser',
      mode: 'release',
      entryScene,
      renderer,
      quality: 'quality',
      debugOverlay: false,
      mobileControls: true,
    },
  ];
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
  Camera: {
    defaults: { projection: 'perspective', fov: 60, orthographicHeight: 20, near: 0.1, far: 1000, primary: false },
    validate: (value) => {
      const issues = numericRangeValidator('fov', 1, 179)(value);
      if (value.projection !== undefined && !['perspective', 'orthographic'].includes(String(value.projection))) issues.push('projection must be perspective or orthographic');
      if (value.orthographicHeight !== undefined) issues.push(...numericRangeValidator('orthographicHeight', 0.01, 100000)(value));
      const near = Number(value.near ?? 0.1), far = Number(value.far ?? 1000);
      if (!Number.isFinite(near) || near < 0 || !Number.isFinite(far) || far <= near) issues.push('Camera clipping needs finite 0 <= near < far');
      if (value.projection !== 'orthographic' && near === 0) issues.push('Perspective camera near clipping must be greater than zero');
      return issues;
    },
  },
  CharacterController: {
    defaults: { moveAction: 'Move', speed: 6, rotateToMovement: true, collisionRadius: 0.44 },
    validate: (value) => {
      const issues = [
        ...numericRangeValidator('speed', 0, 100)(value),
        ...numericRangeValidator('collisionRadius', 0.05, 20)(value),
      ];
      if (!String(value.moveAction || '').trim()) issues.push('moveAction must be a non-empty input action');
      return issues;
    },
  },
  MeshRenderer: { defaults: { geometry: 'box', assetId: '', materialId: '', material: { color: '#8ea7c4', roughness: 0.65, metalness: 0.05 }, castShadow: true, receiveShadow: true }, validate: validateMeshRenderer },
  Light: { defaults: { kind: 'directional', color: '#fff4df', intensity: 2, castShadow: true }, validate: numericRangeValidator('intensity', 0, 100) },
  RigidBody: { defaults: { bodyType: 'dynamic', mass: 1, linearDamping: 0.1, angularDamping: 0.1, lockRotations: false }, validate: numericRangeValidator('mass', 0.0001, 100000) },
  Collider: { defaults: { shape: 'box', size: { x: 1, y: 1, z: 1 }, sensor: false, restitution: 0.1, friction: 0.7 }, validate: () => [] },
  AudioSource: { defaults: { assetId: '', volume: 0.8, loop: false, spatial: true, autoplay: false }, validate: numericRangeValidator('volume', 0, 1) },
  Animator: { defaults: { assetId: '', controllerId: '', state: '', clip: '', speed: 1, autoplay: true }, validate: validateAnimator },
  DataReference: {
    defaults: { assetId: '', alias: 'data' },
    validate: (value) => {
      const errors: string[] = [];
      if (!RESOURCE_ID_PATTERN.test(String(value.assetId || ''))) errors.push('assetId must reference a Lilly data asset');
      if (!RESOURCE_ID_PATTERN.test(String(value.alias || ''))) errors.push('alias must be a stable resource identifier');
      return errors;
    },
  },
  Terrain: { defaults: { terrainId: '', walkable: true, collision: true }, validate: validateTerrainComponent },
  Blueprint: { defaults: { graphId: '', enabled: true }, validate: () => [] },
  Script: { defaults: { source: '', enabled: true, timeoutMs: 8, capabilities: ['entity.read', 'entity.write', 'events.emit'] }, validate: numericRangeValidator('timeoutMs', 1, 16) },
  ParticleEmitter: { defaults: { rate: 12, lifetime: 0.8, color: '#7dd3fc', size: 0.08, burst: 0 }, validate: numericRangeValidator('rate', 0, 10000) },
  UIAnchor: { defaults: { anchor: 'top-left', offset: { x: 16, y: 16 }, text: '', visible: true }, validate: () => [] },
  Health: {
    defaults: { max: 3, current: 3, invulnerabilitySeconds: 0.55 },
    validate: (value) => {
      const maximum = Number(value.max);
      const current = Number(value.current);
      const invulnerability = Number(value.invulnerabilitySeconds);
      const errors: string[] = [];
      if (!Number.isFinite(maximum) || maximum < 1 || maximum > 10000) errors.push('max must be between 1 and 10000');
      if (!Number.isFinite(current) || current < 0 || current > maximum) errors.push('current must be between 0 and max');
      if (!Number.isFinite(invulnerability) || invulnerability < 0 || invulnerability > 10) errors.push('invulnerabilitySeconds must be between 0 and 10');
      return errors;
    },
  },
  Combatant: {
    defaults: { team: 'neutral', damage: 1, range: 1.8, cooldownSeconds: 0.55, attackAction: 'Attack' },
    validate: (value) => {
      const errors: string[] = [];
      if (!['player', 'enemy', 'neutral'].includes(String(value.team || ''))) errors.push('team must be player, enemy, or neutral');
      if (!Number.isFinite(Number(value.damage)) || Number(value.damage) <= 0 || Number(value.damage) > 10000) errors.push('damage must be between 0 and 10000');
      if (!Number.isFinite(Number(value.range)) || Number(value.range) < 0.1 || Number(value.range) > 100) errors.push('range must be between 0.1 and 100');
      if (!Number.isFinite(Number(value.cooldownSeconds)) || Number(value.cooldownSeconds) < 0.05 || Number(value.cooldownSeconds) > 60) errors.push('cooldownSeconds must be between 0.05 and 60');
      return errors;
    },
  },
  EnemyBrain: {
    defaults: { behavior: 'chaser', moveSpeed: 2.2, detectionRange: 9, attackRange: 1.25, windupSeconds: 0.28, recoverSeconds: 0.65 },
    validate: (value) => {
      const errors: string[] = [];
      if (String(value.behavior || '') !== 'chaser') errors.push('behavior must be chaser in Lilly Engine v0.3');
      for (const [key, minimum, maximum] of [
        ['moveSpeed', 0.1, 20],
        ['detectionRange', 0.5, 100],
        ['attackRange', 0.2, 20],
        ['windupSeconds', 0.05, 10],
        ['recoverSeconds', 0.05, 30],
      ] as const) {
        const number = Number(value[key]);
        if (!Number.isFinite(number) || number < minimum || number > maximum) errors.push(`${key} must be between ${minimum} and ${maximum}`);
      }
      return errors;
    },
  },
  EncounterMember: { defaults: { encounterId: '' }, validate: (value) => String(value.encounterId || '').trim() ? [] : ['encounterId is required'] },
  EncounterGate: { defaults: { encounterId: '', startsOpen: true }, validate: (value) => String(value.encounterId || '').trim() ? [] : ['encounterId is required'] },
  Checkpoint: { defaults: { checkpointId: '', encounterId: '', activate: 'encounter-clear' }, validate: (value) => {
    const errors: string[] = [];
    if (!String(value.checkpointId || '').trim()) errors.push('checkpointId is required');
    if (!String(value.encounterId || '').trim()) errors.push('encounterId is required');
    if (String(value.activate || '') !== 'encounter-clear') errors.push('activate must be encounter-clear');
    return errors;
  } },
  Behavior: {
    defaults: { moduleId: '', systemId: '', config: {} },
    validate: (value) => {
      const errors: string[] = [];
      if (!String(value.moduleId || '').trim()) errors.push('moduleId is required');
      if (!String(value.systemId || '').trim()) errors.push('systemId is required');
      if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)) errors.push('config must be an object');
      return errors;
    },
  },
  State: {
    defaults: { schemaId: '', values: {} },
    validate: (value) => {
      const errors: string[] = [];
      if (!String(value.schemaId || '').trim()) errors.push('schemaId is required');
      if (!value.values || typeof value.values !== 'object' || Array.isArray(value.values)) errors.push('values must be an object');
      return errors;
    },
  },
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

function validateMeshRenderer(value: Record<string, unknown>) {
  const errors: string[] = [];
  if (value.geometry !== undefined && !['box', 'sphere', 'capsule', 'cylinder', 'octahedron', 'torus', 'plane'].includes(String(value.geometry))) errors.push('geometry is not supported');
  if (value.assetId !== undefined && typeof value.assetId !== 'string') errors.push('assetId must be a string');
  if (value.materialId !== undefined && typeof value.materialId !== 'string') errors.push('materialId must be a string');
  if (value.material !== undefined && !isPlainRecord(value.material)) errors.push('material must be an object');
  const material = isPlainRecord(value.material) ? value.material : {};
  for (const key of ['roughness', 'metalness', 'opacity', 'clearcoat', 'clearcoatRoughness']) {
    if (material[key] !== undefined && (!Number.isFinite(Number(material[key])) || Number(material[key]) < 0 || Number(material[key]) > 1)) errors.push(`${key} must be between 0 and 1`);
  }
  if (material.emissiveIntensity !== undefined && (!Number.isFinite(Number(material.emissiveIntensity)) || Number(material.emissiveIntensity) < 0 || Number(material.emissiveIntensity) > 100)) errors.push('emissiveIntensity must be between 0 and 100');
  return errors;
}

function validateAnimator(value: Record<string, unknown>) {
  const errors = numericRangeValidator('speed', -20, 20)(value);
  for (const key of ['assetId', 'controllerId', 'state', 'clip']) if (value[key] !== undefined && typeof value[key] !== 'string') errors.push(`${key} must be a string`);
  if (value.autoplay !== undefined && typeof value.autoplay !== 'boolean') errors.push('autoplay must be boolean');
  return errors;
}

function validateTerrainComponent(value: Record<string, unknown>) {
  const errors: string[] = [];
  if (value.terrainId !== undefined && typeof value.terrainId !== 'string') errors.push('terrainId must be a string');
  if (value.walkable !== undefined && typeof value.walkable !== 'boolean') errors.push('walkable must be boolean');
  if (value.collision !== undefined && typeof value.collision !== 'boolean') errors.push('collision must be boolean');
  return errors;
}

const RESOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function resourceIssue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path, severity: 'error' };
}

function validateResourceIdentity(value: { id?: string; moduleId?: string; name?: string } | null | undefined, kind: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!RESOURCE_ID_PATTERN.test(String(value?.id || ''))) issues.push(resourceIssue(`INVALID_${kind}_ID`, `${kind.toLowerCase()} id is invalid`, 'id'));
  if (!RESOURCE_ID_PATTERN.test(String(value?.moduleId || ''))) issues.push(resourceIssue(`${kind}_MODULE_REQUIRED`, `${kind.toLowerCase()} moduleId is invalid`, 'moduleId'));
  if (!String(value?.name || '').trim()) issues.push(resourceIssue(`${kind}_NAME_REQUIRED`, `${kind.toLowerCase()} name is required`, 'name'));
  return issues;
}

export function validateMaterialDefinition(value: LillyMaterialDefinition): ValidationIssue[] {
  const issues = validateResourceIdentity(value, 'MATERIAL');
  if (!value || value.schema !== MATERIAL_SCHEMA) issues.push(resourceIssue('INVALID_MATERIAL_SCHEMA', `Expected ${MATERIAL_SCHEMA}`, 'schema'));
  if (!['standard', 'physical', 'toon', 'unlit'].includes(String(value?.shading || ''))) issues.push(resourceIssue('INVALID_MATERIAL_SHADING', 'shading must be standard, physical, toon, or unlit', 'shading'));
  for (const key of ['color', 'emissive'] as const) if (value?.[key] !== undefined && !HEX_COLOR_PATTERN.test(String(value[key]))) issues.push(resourceIssue('INVALID_MATERIAL_COLOR', `${key} must be a six-digit hex color`, key));
  for (const key of ['roughness', 'metalness', 'opacity', 'clearcoat', 'clearcoatRoughness'] as const) {
    const number = Number(value?.[key]);
    if (value?.[key] !== undefined && (!Number.isFinite(number) || number < 0 || number > 1)) issues.push(resourceIssue('INVALID_MATERIAL_RANGE', `${key} must be between 0 and 1`, key));
  }
  if (value?.emissiveIntensity !== undefined && (!Number.isFinite(Number(value.emissiveIntensity)) || Number(value.emissiveIntensity) < 0 || Number(value.emissiveIntensity) > 100)) issues.push(resourceIssue('INVALID_MATERIAL_RANGE', 'emissiveIntensity must be between 0 and 100', 'emissiveIntensity'));
  if (value?.textures !== undefined && !isPlainRecord(value.textures)) issues.push(resourceIssue('INVALID_MATERIAL_TEXTURES', 'textures must be an object of project asset ids', 'textures'));
  else for (const [slot, assetId] of Object.entries(value?.textures || {})) {
    if (!['baseColor', 'normal', 'roughness', 'metalness', 'emissive'].includes(slot) || typeof assetId !== 'string' || !assetId.trim()) issues.push(resourceIssue('INVALID_MATERIAL_TEXTURE', `Texture slot ${slot} must reference a project asset id`, `textures.${slot}`));
  }
  if (value?.tiling !== undefined && (!value.tiling || !Number.isFinite(value.tiling.x) || !Number.isFinite(value.tiling.y) || value.tiling.x <= 0 || value.tiling.y <= 0)) issues.push(resourceIssue('INVALID_MATERIAL_TILING', 'tiling must be a positive Vector2', 'tiling'));
  return issues;
}

export function validateAssetMetadataDefinition(value: LillyAssetMetadataDefinition): ValidationIssue[] {
  const issues = validateResourceIdentity(value, 'ASSET_METADATA');
  if (!value || value.schema !== ASSET_METADATA_SCHEMA) issues.push(resourceIssue('INVALID_ASSET_METADATA_SCHEMA', `Expected ${ASSET_METADATA_SCHEMA}`, 'schema'));
  if (!String(value?.assetId || '').trim()) issues.push(resourceIssue('ASSET_REFERENCE_REQUIRED', 'assetId must reference an uploaded project asset', 'assetId'));
  if (!['model', 'texture', 'audio'].includes(String(value?.kind || ''))) issues.push(resourceIssue('INVALID_ASSET_KIND', 'kind must be model, texture, or audio', 'kind'));
  if (value?.scale !== undefined && (!isFiniteVec3(value.scale) || Object.values(value.scale).some((entry) => entry === 0))) issues.push(resourceIssue('INVALID_ASSET_SCALE', 'scale must be a non-zero finite Vector3', 'scale'));
  if (value?.pivot !== undefined && !isFiniteVec3(value.pivot)) issues.push(resourceIssue('INVALID_ASSET_PIVOT', 'pivot must be a finite Vector3', 'pivot'));
  if (value?.collision) {
    if (!['box', 'sphere', 'capsule', 'cylinder'].includes(String(value.collision.shape || ''))) issues.push(resourceIssue('INVALID_ASSET_COLLISION', 'collision shape is not supported', 'collision.shape'));
    if (value.collision.size !== undefined && (!isFiniteVec3(value.collision.size) || Object.values(value.collision.size).some((entry) => entry <= 0))) issues.push(resourceIssue('INVALID_ASSET_COLLISION', 'collision size must be a positive Vector3', 'collision.size'));
    if (value.collision.center !== undefined && !isFiniteVec3(value.collision.center)) issues.push(resourceIssue('INVALID_ASSET_COLLISION', 'collision center must be a finite Vector3', 'collision.center'));
  }
  const distances = new Set<number>();
  for (const [index, lod] of (value?.lods || []).entries()) {
    const distance = Number(lod.maxDistance);
    if (!String(lod.assetId || '').trim() || !Number.isFinite(distance) || distance <= 0 || distances.has(distance)) issues.push(resourceIssue('INVALID_ASSET_LOD', 'LOD entries require an asset id and unique positive maxDistance', `lods[${index}]`));
    distances.add(distance);
  }
  const animationNames = new Set<string>();
  for (const [index, animation] of (value?.animations || []).entries()) {
    if (!String(animation.name || '').trim() || !String(animation.clip || '').trim() || animationNames.has(animation.name)) issues.push(resourceIssue('INVALID_ASSET_ANIMATION', 'Animation aliases require unique names and clip values', `animations[${index}]`));
    if (animation.speed !== undefined && (!Number.isFinite(Number(animation.speed)) || Number(animation.speed) === 0)) issues.push(resourceIssue('INVALID_ASSET_ANIMATION', 'Animation speed must be a non-zero number', `animations[${index}].speed`));
    animationNames.add(animation.name);
  }
  return issues;
}

export function validateAnimationControllerDefinition(value: LillyAnimationControllerDefinition): ValidationIssue[] {
  const issues = validateResourceIdentity(value, 'ANIMATION_CONTROLLER');
  if (!value || value.schema !== ANIMATION_CONTROLLER_SCHEMA) issues.push(resourceIssue('INVALID_ANIMATION_CONTROLLER_SCHEMA', `Expected ${ANIMATION_CONTROLLER_SCHEMA}`, 'schema'));
  if (!Array.isArray(value?.states) || value.states.length === 0) {
    issues.push(resourceIssue('ANIMATION_STATES_REQUIRED', 'Animation controllers require at least one state', 'states'));
    return issues;
  }
  const stateIds = new Set<string>();
  for (const [index, state] of value.states.entries()) {
    const path = `states[${index}]`;
    if (!RESOURCE_ID_PATTERN.test(String(state.id || '')) || stateIds.has(state.id)) issues.push(resourceIssue('INVALID_ANIMATION_STATE', 'Animation state ids must be unique resource identifiers', `${path}.id`));
    if (!['clip', 'spin', 'float', 'pulse'].includes(String(state.mode || ''))) issues.push(resourceIssue('INVALID_ANIMATION_MODE', 'Animation mode must be clip, spin, float, or pulse', `${path}.mode`));
    if (state.mode === 'clip' && !String(state.clip || '').trim()) issues.push(resourceIssue('ANIMATION_CLIP_REQUIRED', 'Clip animation states require clip', `${path}.clip`));
    if (state.axis !== undefined && !['x', 'y', 'z'].includes(state.axis)) issues.push(resourceIssue('INVALID_ANIMATION_AXIS', 'axis must be x, y, or z', `${path}.axis`));
    for (const key of ['speed', 'amplitude', 'frequency', 'fadeSeconds'] as const) if (state[key] !== undefined && (!Number.isFinite(Number(state[key])) || (key !== 'speed' && Number(state[key]) < 0))) issues.push(resourceIssue('INVALID_ANIMATION_VALUE', `${key} must be finite${key === 'speed' ? '' : ' and non-negative'}`, `${path}.${key}`));
    stateIds.add(state.id);
  }
  if (!stateIds.has(String(value.defaultState || ''))) issues.push(resourceIssue('ANIMATION_DEFAULT_STATE_MISSING', 'defaultState must reference an authored state', 'defaultState'));
  return issues;
}

export function validateTerrainDefinition(value: LillyTerrainDefinition): ValidationIssue[] {
  const issues = validateResourceIdentity(value, 'TERRAIN');
  if (!value || value.schema !== TERRAIN_SCHEMA) issues.push(resourceIssue('INVALID_TERRAIN_SCHEMA', `Expected ${TERRAIN_SCHEMA}`, 'schema'));
  if (!value?.size || !Number.isFinite(value.size.x) || !Number.isFinite(value.size.y) || value.size.x <= 0 || value.size.y <= 0 || value.size.x > 4096 || value.size.y > 4096) issues.push(resourceIssue('INVALID_TERRAIN_SIZE', 'size must be a positive Vector2 up to 4096 units', 'size'));
  const resolution = Number(value?.resolution);
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 129) issues.push(resourceIssue('INVALID_TERRAIN_RESOLUTION', 'resolution must be an integer from 2 to 129', 'resolution'));
  if (!Array.isArray(value?.heights) || !Number.isInteger(resolution) || value.heights.length !== resolution * resolution || value.heights.some((height) => !Number.isFinite(height) || height < -1 || height > 1)) issues.push(resourceIssue('INVALID_TERRAIN_HEIGHTS', 'heights must contain resolution squared normalized values from -1 to 1', 'heights'));
  if (!Number.isFinite(Number(value?.heightScale)) || Number(value.heightScale) < 0 || Number(value.heightScale) > 2048) issues.push(resourceIssue('INVALID_TERRAIN_HEIGHT_SCALE', 'heightScale must be between 0 and 2048', 'heightScale'));
  return issues;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const FORBIDDEN_STRUCTURED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeStructuredValue(value: unknown, valuePath: string, depth = 0): void {
  if (depth > 24) throw Object.assign(new Error(`${valuePath} exceeds the maximum nesting depth`), { code: 'INVALID_PREFAB_CONFIG' });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error(`${valuePath} contains a non-finite number`), { code: 'INVALID_PREFAB_CONFIG' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeStructuredValue(entry, `${valuePath}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) throw Object.assign(new Error(`${valuePath} must contain JSON-compatible values`), { code: 'INVALID_PREFAB_CONFIG' });
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_STRUCTURED_KEYS.has(key)) throw Object.assign(new Error(`${valuePath}.${key} is not allowed`), { code: 'INVALID_PREFAB_CONFIG' });
    assertSafeStructuredValue(entry, `${valuePath}.${key}`, depth + 1);
  }
}

function mergeSafeRecords(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) merged[key] = deepClone(value);
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainRecord(value) && isPlainRecord(merged[key])
      ? mergeSafeRecords(merged[key] as Record<string, unknown>, value)
      : deepClone(value);
  }
  return merged;
}

function sourceHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeDataAsset(value: unknown): LillyDataAsset {
  if (!isPlainRecord(value)) throw Object.assign(new Error('Data asset must be an object'), { code: 'INVALID_DATA_ASSET' });
  const id = String(value.id || '').trim();
  const name = String(value.name || '').trim();
  const type = String(value.type || 'custom') as LillyDataAsset['type'];
  if (!RESOURCE_ID_PATTERN.test(id)) throw Object.assign(new Error('Data asset id must be a stable resource identifier'), { code: 'INVALID_DATA_ASSET_ID' });
  if (!name || name.length > 100) throw Object.assign(new Error('Data asset name must contain 1 to 100 characters'), { code: 'INVALID_DATA_ASSET_NAME' });
  if (!['config', 'stats', 'table', 'dialogue', 'custom'].includes(type)) throw Object.assign(new Error('Data asset type must be config, stats, table, dialogue, or custom'), { code: 'INVALID_DATA_ASSET_TYPE' });
  if (!Array.isArray(value.tags) || value.tags.length > 64 || value.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 64)) {
    throw Object.assign(new Error('Data asset tags must contain at most 64 non-empty strings'), { code: 'INVALID_DATA_ASSET_TAGS' });
  }
  if (!isPlainRecord(value.data)) throw Object.assign(new Error('Data asset data must be a JSON object'), { code: 'INVALID_DATA_ASSET_DATA' });
  try { assertSafeStructuredValue(value.data, 'dataAsset.data'); }
  catch (error) { throw Object.assign(new Error((error as Error).message), { code: 'INVALID_DATA_ASSET_DATA' }); }
  if (new TextEncoder().encode(JSON.stringify(value.data)).length > 64 * 1024) throw Object.assign(new Error('Data asset data is limited to 64 KiB'), { code: 'DATA_ASSET_TOO_LARGE' });
  return {
    schema: DATA_ASSET_SCHEMA,
    id,
    name,
    type,
    tags: [...new Set((value.tags as string[]).map((tag) => tag.trim()))],
    data: deepClone(value.data),
  };
}

export function validateDataAsset(value: LillyDataAsset): ValidationIssue[] {
  try {
    const normalized = normalizeDataAsset(value);
    return value.schema === DATA_ASSET_SCHEMA && JSON.stringify(value) === JSON.stringify(normalized)
      ? []
      : value.schema === DATA_ASSET_SCHEMA
        ? []
        : [resourceIssue('INVALID_DATA_ASSET_SCHEMA', `Expected ${DATA_ASSET_SCHEMA}`, 'schema')];
  } catch (error) {
    return [resourceIssue(String((error as { code?: string }).code || 'INVALID_DATA_ASSET'), (error as Error).message, 'dataAssets')];
  }
}

export function normalizeBuildProfile(value: unknown): LillyBuildProfile {
  if (!isPlainRecord(value)) throw Object.assign(new Error('Build profile must be an object'), { code: 'INVALID_BUILD_PROFILE' });
  if (value.target !== undefined && value.target !== 'browser') throw Object.assign(new Error('Build profile target must be browser'), { code: 'INVALID_BUILD_PROFILE_TARGET' });
  const profile: LillyBuildProfile = {
    schema: BUILD_PROFILE_SCHEMA,
    id: String(value.id || '').trim(),
    name: String(value.name || '').trim(),
    target: 'browser',
    mode: String(value.mode || '') as LillyBuildProfile['mode'],
    entryScene: String(value.entryScene || '').trim(),
    renderer: String(value.renderer || '') as LillyBuildProfile['renderer'],
    quality: String(value.quality || '') as LillyBuildProfile['quality'],
    debugOverlay: value.debugOverlay === true,
    mobileControls: value.mobileControls !== false,
  };
  if (!RESOURCE_ID_PATTERN.test(profile.id)) throw Object.assign(new Error('Build profile id must be a stable resource identifier'), { code: 'INVALID_BUILD_PROFILE_ID' });
  if (!profile.name || profile.name.length > 100) throw Object.assign(new Error('Build profile name must contain 1 to 100 characters'), { code: 'INVALID_BUILD_PROFILE_NAME' });
  if (!['development', 'release'].includes(profile.mode)) throw Object.assign(new Error('Build profile mode must be development or release'), { code: 'INVALID_BUILD_PROFILE_MODE' });
  if (!profile.entryScene || profile.entryScene.length > 100) throw Object.assign(new Error('Build profile entryScene is required'), { code: 'INVALID_BUILD_PROFILE_SCENE' });
  if (!['webgl2', 'webgpu-experimental'].includes(profile.renderer)) throw Object.assign(new Error('Build profile renderer must be webgl2 or webgpu-experimental'), { code: 'INVALID_BUILD_PROFILE_RENDERER' });
  if (!['performance', 'balanced', 'quality'].includes(profile.quality)) throw Object.assign(new Error('Build profile quality must be performance, balanced, or quality'), { code: 'INVALID_BUILD_PROFILE_QUALITY' });
  return profile;
}

export function validateBuildProfile(value: LillyBuildProfile, project: Pick<LillyProject, 'scenes'>): ValidationIssue[] {
  try {
    const profile = normalizeBuildProfile(value);
    const issues: ValidationIssue[] = [];
    if (value.schema !== BUILD_PROFILE_SCHEMA) issues.push(resourceIssue('INVALID_BUILD_PROFILE_SCHEMA', `Expected ${BUILD_PROFILE_SCHEMA}`, 'schema'));
    if (!project.scenes.some((scene) => scene.id === profile.entryScene)) issues.push(resourceIssue('BUILD_PROFILE_SCENE_MISSING', `Build profile scene ${profile.entryScene} does not exist`, 'entryScene'));
    return issues;
  } catch (error) {
    return [resourceIssue(String((error as { code?: string }).code || 'INVALID_BUILD_PROFILE'), (error as Error).message, 'buildProfiles')];
  }
}

function normalizePrefabInstanceConfig(value: unknown, prefab: LillyPrefabDefinition): LillyPrefabInstanceConfig {
  if (value == null) return {};
  if (!isPlainRecord(value)) throw Object.assign(new Error('Prefab config must be an object'), { code: 'INVALID_PREFAB_CONFIG' });
  assertSafeStructuredValue(value, 'config');
  const unknownKeys = Object.keys(value).filter((key) => !['variant', 'position', 'entities'].includes(key));
  if (unknownKeys.length > 0) throw Object.assign(new Error(`Unknown prefab config field ${unknownKeys[0]}`), { code: 'INVALID_PREFAB_CONFIG' });
  const variantId = value.variant === undefined ? '' : String(value.variant).trim();
  if (value.variant !== undefined && (!variantId || !RESOURCE_ID_PATTERN.test(variantId))) {
    throw Object.assign(new Error('Prefab config.variant must be a valid authored variant id'), { code: 'INVALID_PREFAB_VARIANT' });
  }
  const variant = variantId ? (prefab.variants || []).find((entry) => entry.id === variantId) : null;
  if (variantId && !variant) throw Object.assign(new Error(`Prefab variant ${variantId} was not found`), { code: 'PREFAB_VARIANT_NOT_FOUND' });
  if (value.position !== undefined && !isFiniteVec3(value.position)) {
    throw Object.assign(new Error('Prefab config.position must be a finite Vector3'), { code: 'INVALID_PREFAB_CONFIG' });
  }
  if (value.entities !== undefined && !isPlainRecord(value.entities)) {
    throw Object.assign(new Error('Prefab config.entities must be an object keyed by source entity id'), { code: 'INVALID_PREFAB_CONFIG' });
  }
  const rawEntities: Record<string, unknown> = {};
  for (const [entityId, rawOverride] of Object.entries(variant?.entities || {})) rawEntities[entityId] = deepClone(rawOverride);
  for (const [entityId, rawOverride] of Object.entries((value.entities || {}) as Record<string, unknown>)) {
    rawEntities[entityId] = isPlainRecord(rawEntities[entityId]) && isPlainRecord(rawOverride)
      ? mergeSafeRecords(rawEntities[entityId] as Record<string, unknown>, rawOverride)
      : deepClone(rawOverride);
  }
  const entities: Record<string, LillyPrefabEntityOverride> = {};
  for (const [entityId, rawOverride] of Object.entries(rawEntities)) {
    const sourceEntity = prefab.entities.find((entry) => entry.id === entityId);
    if (!sourceEntity) throw Object.assign(new Error(`Prefab config references unknown entity ${entityId}`), { code: 'PREFAB_CONFIG_ENTITY_NOT_FOUND' });
    if (!isPlainRecord(rawOverride)) throw Object.assign(new Error(`Prefab override ${entityId} must be an object`), { code: 'INVALID_PREFAB_CONFIG' });
    const invalidOverrideKey = Object.keys(rawOverride).find((key) => !['name', 'enabled', 'locked', 'tags', 'components', 'componentEnabled'].includes(key));
    if (invalidOverrideKey) throw Object.assign(new Error(`Unknown prefab override field ${entityId}.${invalidOverrideKey}`), { code: 'INVALID_PREFAB_CONFIG' });
    const override: LillyPrefabEntityOverride = {};
    if (rawOverride.name !== undefined) {
      const name = String(rawOverride.name).trim();
      if (!name || name.length > 100) throw Object.assign(new Error(`Prefab override ${entityId}.name must contain 1 to 100 characters`), { code: 'INVALID_PREFAB_CONFIG' });
      override.name = name;
    }
    if (rawOverride.enabled !== undefined) {
      if (typeof rawOverride.enabled !== 'boolean') throw Object.assign(new Error(`Prefab override ${entityId}.enabled must be boolean`), { code: 'INVALID_PREFAB_CONFIG' });
      override.enabled = rawOverride.enabled;
    }
    if (rawOverride.locked !== undefined) {
      if (typeof rawOverride.locked !== 'boolean') throw Object.assign(new Error(`Prefab override ${entityId}.locked must be boolean`), { code: 'INVALID_PREFAB_CONFIG' });
      override.locked = rawOverride.locked;
    }
    if (rawOverride.tags !== undefined) {
      if (!Array.isArray(rawOverride.tags) || rawOverride.tags.length > 64 || rawOverride.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 64)) {
        throw Object.assign(new Error(`Prefab override ${entityId}.tags must contain at most 64 non-empty strings`), { code: 'INVALID_PREFAB_CONFIG' });
      }
      override.tags = [...new Set(rawOverride.tags.map((tag) => tag.trim()))];
    }
    if (rawOverride.components !== undefined) {
      if (!isPlainRecord(rawOverride.components)) throw Object.assign(new Error(`Prefab override ${entityId}.components must be an object`), { code: 'INVALID_PREFAB_CONFIG' });
      const componentOverrides: Partial<Record<LillyComponentType, Record<string, unknown>>> = {};
      for (const [componentType, componentPatch] of Object.entries(rawOverride.components)) {
        if (!(componentType in COMPONENT_DEFINITIONS)) throw Object.assign(new Error(`Prefab override ${entityId} references unknown component ${componentType}`), { code: 'PREFAB_CONFIG_COMPONENT_NOT_FOUND' });
        if (!sourceEntity.components.some((entry) => entry.type === componentType)) throw Object.assign(new Error(`Prefab entity ${entityId} does not contain component ${componentType}`), { code: 'PREFAB_CONFIG_COMPONENT_NOT_FOUND' });
        if (!isPlainRecord(componentPatch)) throw Object.assign(new Error(`Prefab override ${entityId}.${componentType} must be an object data patch`), { code: 'INVALID_PREFAB_CONFIG' });
        componentOverrides[componentType as LillyComponentType] = componentPatch;
      }
      override.components = componentOverrides;
    }
    if (rawOverride.componentEnabled !== undefined) {
      if (!isPlainRecord(rawOverride.componentEnabled)) throw Object.assign(new Error(`Prefab override ${entityId}.componentEnabled must be an object`), { code: 'INVALID_PREFAB_CONFIG' });
      const enabledOverrides: Partial<Record<LillyComponentType, boolean>> = {};
      for (const [componentType, enabled] of Object.entries(rawOverride.componentEnabled)) {
        if (!(componentType in COMPONENT_DEFINITIONS) || !sourceEntity.components.some((entry) => entry.type === componentType)) throw Object.assign(new Error(`Prefab entity ${entityId} does not contain component ${componentType}`), { code: 'PREFAB_CONFIG_COMPONENT_NOT_FOUND' });
        if (typeof enabled !== 'boolean') throw Object.assign(new Error(`Prefab override ${entityId}.${componentType} enabled state must be boolean`), { code: 'INVALID_PREFAB_CONFIG' });
        enabledOverrides[componentType as LillyComponentType] = enabled;
      }
      override.componentEnabled = enabledOverrides;
    }
    entities[entityId] = override;
  }
  return {
    ...(variantId ? { variant: variantId } : {}),
    ...(value.position === undefined ? {} : { position: deepClone(value.position as Vec3) }),
    ...(Object.keys(entities).length === 0 ? {} : { entities }),
  };
}

function normalizeLinkedPrefabConfig(value: unknown, prefab: LillyPrefabDefinition): {
  stored: LillyPrefabInstanceConfig;
  resolved: LillyPrefabInstanceConfig;
} {
  const raw = isPlainRecord(value) ? value : {};
  const resolved = normalizePrefabInstanceConfig(raw, prefab);
  const own = normalizePrefabInstanceConfig({
    ...(raw.position === undefined ? {} : { position: raw.position }),
    ...(raw.entities === undefined ? {} : { entities: raw.entities }),
  }, { ...prefab, variants: [] });
  return {
    stored: {
      ...(resolved.variant ? { variant: resolved.variant } : {}),
      ...(own.position ? { position: own.position } : {}),
      ...(own.entities ? { entities: own.entities } : {}),
    },
    resolved,
  };
}

function readPrefabSource(project: LillyProject, prefabPath: string): {
  file: LillySourceFile;
  prefab: LillyPrefabDefinition;
  hash: string;
} {
  const file = project.files.find((entry) => entry.path === prefabPath && entry.kind === 'prefab');
  if (!file) throw Object.assign(new Error(`Prefab source ${prefabPath} was not found`), { code: 'PREFAB_NOT_FOUND' });
  let prefab: LillyPrefabDefinition;
  try { prefab = JSON.parse(file.content) as LillyPrefabDefinition; }
  catch (_error) { throw Object.assign(new Error(`Prefab source ${prefabPath} is not valid JSON`), { code: 'INVALID_PREFAB' }); }
  try { assertSafeStructuredValue(prefab, 'prefab'); }
  catch (error) { throw Object.assign(new Error(`Prefab source ${prefabPath} is unsafe: ${(error as Error).message}`), { code: 'INVALID_PREFAB' }); }
  const issues = validatePrefabDefinition(prefab).filter((issue) => issue.severity === 'error');
  if (issues.length > 0) throw Object.assign(new Error(`Prefab source ${prefabPath} is invalid: ${issues[0].message}`), { code: issues[0].code, issues });
  return { file, prefab, hash: sourceHash(file.content) };
}

function linkedPrefabForEntity(scene: LillyScene, entityId: string): { instance: LillyPrefabInstance; sourceEntityId: string } | null {
  for (const instance of scene.prefabInstances || []) {
    const prefix = `${instance.instanceId}:`;
    const entity = scene.entities.find((entry) => entry.id === entityId);
    if (entityId.startsWith(prefix) && entity?.tags.includes(`instance:${instance.instanceId}`)) return { instance, sourceEntityId: entityId.slice(prefix.length) };
  }
  return null;
}

function prefabEntityOverride(instance: LillyPrefabInstance, sourceEntityId: string): LillyPrefabEntityOverride {
  instance.overrides ||= {};
  instance.overrides.entities ||= {};
  instance.overrides.entities[sourceEntityId] ||= {};
  return instance.overrides.entities[sourceEntityId];
}

function prunePrefabEntityOverride(instance: LillyPrefabInstance, sourceEntityId: string): void {
  const override = instance.overrides.entities?.[sourceEntityId];
  if (!override) return;
  if (override.components && Object.keys(override.components).length === 0) delete override.components;
  if (override.componentEnabled && Object.keys(override.componentEnabled).length === 0) delete override.componentEnabled;
  if (Object.keys(override).length === 0) delete instance.overrides.entities?.[sourceEntityId];
  if (instance.overrides.entities && Object.keys(instance.overrides.entities).length === 0) delete instance.overrides.entities;
}

function structuredValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffStructuredRecord(value: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(value)) {
    const previous = base[key];
    if (isPlainRecord(next) && isPlainRecord(previous)) {
      const nested = diffStructuredRecord(next, previous);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else if (!structuredValuesEqual(next, previous)) result[key] = deepClone(next);
  }
  return result;
}

function prefabSourceEntityState(project: LillyProject, instance: LillyPrefabInstance, sourceEntityId: string): LillyEntity {
  const { prefab } = readPrefabSource(project, instance.prefabPath);
  const source = prefab.entities.find((entry) => entry.id === sourceEntityId);
  if (!source) throw Object.assign(new Error(`Prefab source entity ${sourceEntityId} was not found`), { code: 'PREFAB_CONFIG_ENTITY_NOT_FOUND' });
  const entity = deepClone(source);
  const variant = normalizePrefabInstanceConfig(instance.overrides.variant ? { variant: instance.overrides.variant } : {}, prefab).entities?.[sourceEntityId];
  if (variant?.name !== undefined) entity.name = variant.name;
  if (variant?.enabled !== undefined) entity.enabled = variant.enabled;
  if (variant?.locked !== undefined) entity.locked = variant.locked;
  if (variant?.tags !== undefined) entity.tags = deepClone(variant.tags);
  for (const [componentType, componentPatch] of Object.entries(variant?.components || {})) {
    const target = entity.components.find((entry) => entry.type === componentType);
    if (target && componentPatch) target.data = mergeSafeRecords(target.data, componentPatch);
  }
  for (const [componentType, enabled] of Object.entries(variant?.componentEnabled || {})) {
    const target = entity.components.find((entry) => entry.type === componentType);
    if (target) target.enabled = enabled;
  }
  return entity;
}

function capturePrefabInstanceState(scene: LillyScene, instanceId: string) {
  const instance = (scene.prefabInstances || []).find((entry) => entry.instanceId === instanceId) || null;
  const tag = `instance:${instanceId}`;
  return {
    instance: instance ? deepClone(instance) : null,
    entities: deepClone(scene.entities.filter((entity) => entity.tags.includes(tag))),
  };
}

function restorePrefabInstanceState(scene: LillyScene, instanceId: string, snapshot: { instance: LillyPrefabInstance | null; entities: LillyEntity[] }): void {
  const tag = `instance:${instanceId}`;
  const snapshotIds = new Set((snapshot.entities || []).map((entity) => entity.id));
  scene.entities = scene.entities.filter((entity) => !entity.tags.includes(tag) && !snapshotIds.has(entity.id));
  scene.entities.push(...deepClone(snapshot.entities || []));
  scene.prefabInstances = (scene.prefabInstances || []).filter((entry) => entry.instanceId !== instanceId);
  if (snapshot.instance) scene.prefabInstances.push(deepClone(snapshot.instance));
}

function materializePrefabInstance(project: LillyProject, scene: LillyScene, instance: LillyPrefabInstance, strict = false): LillyPrefabInstance {
  let source;
  try {
    source = readPrefabSource(project, instance.prefabPath);
  } catch (error) {
    instance.status = (error as { code?: string }).code === 'PREFAB_NOT_FOUND' ? 'missing-source' : 'invalid-source';
    if (strict) throw error;
    return instance;
  }
  const { prefab, hash } = source;
  if (instance.prefabId && instance.prefabId !== prefab.id) {
    instance.status = 'invalid-source';
    if (strict) throw Object.assign(new Error(`Prefab id ${instance.prefabId} does not match source id ${prefab.id}`), { code: 'PREFAB_ID_MISMATCH' });
    return instance;
  }
  let config;
  try { config = normalizeLinkedPrefabConfig(instance.overrides || {}, prefab); }
  catch (error) {
    instance.status = 'invalid-source';
    if (strict) throw error;
    return instance;
  }
  const parentId = instance.parentId || null;
  const linkedTag = `instance:${instance.instanceId}`;
  const existingLinkedIds = new Set(scene.entities.filter((entity) => entity.tags.includes(linkedTag)).map((entity) => entity.id));
  if (parentId && !scene.entities.some((entry) => entry.id === parentId && !existingLinkedIds.has(entry.id))) {
    instance.status = 'invalid-source';
    if (strict) throw Object.assign(new Error('Prefab parent entity does not exist'), { code: 'PARENT_MISSING' });
    return instance;
  }
  const idMap = new Map(prefab.entities.map((entry) => [entry.id, `${instance.instanceId}:${entry.id}`]));
  const collisions = [...idMap.values()].filter((id) => scene.entities.some((entity) => entity.id === id && !existingLinkedIds.has(entity.id)));
  if (collisions.length > 0) {
    instance.status = 'invalid-source';
    if (strict) throw Object.assign(new Error(`Prefab instance ${instance.instanceId} conflicts with entity ${collisions[0]}`), { code: 'DUPLICATE_ENTITY_ID' });
    return instance;
  }
  const entities = prefab.entities.map((entry) => {
    const cloned = deepClone(entry);
    const override = config.resolved.entities?.[entry.id];
    if (override?.name !== undefined) cloned.name = override.name;
    if (override?.enabled !== undefined) cloned.enabled = override.enabled;
    if (override?.locked !== undefined) cloned.locked = override.locked;
    if (override?.tags !== undefined) cloned.tags = deepClone(override.tags);
    for (const [componentType, componentPatch] of Object.entries(override?.components || {})) {
      const target = cloned.components.find((candidate) => candidate.type === componentType) as LillyComponent | undefined;
      if (!target || !componentPatch) continue;
      target.data = mergeSafeRecords(target.data, componentPatch);
      const validationErrors = COMPONENT_DEFINITIONS[target.type].validate(target.data);
      if (validationErrors.length > 0) throw Object.assign(new Error(`Prefab override ${entry.id}.${target.type} is invalid: ${validationErrors[0]}`), { code: 'INVALID_PREFAB_COMPONENT_OVERRIDE' });
    }
    for (const [componentType, enabled] of Object.entries(override?.componentEnabled || {})) {
      const target = cloned.components.find((candidate) => candidate.type === componentType);
      if (target) target.enabled = enabled;
    }
    if (entry.id === prefab.rootEntityId && config.resolved.position) {
      const transform = cloned.components.find((candidate) => candidate.type === 'Transform');
      if (!transform) throw Object.assign(new Error('Prefab config.position requires a Transform on the prefab root'), { code: 'PREFAB_ROOT_TRANSFORM_REQUIRED' });
      const authoredPosition = transform.data.position as Vec3;
      transform.data.position = {
        x: authoredPosition.x + config.resolved.position.x,
        y: authoredPosition.y + config.resolved.position.y,
        z: authoredPosition.z + config.resolved.position.z,
      };
    }
    cloned.id = idMap.get(entry.id) as string;
    cloned.parentId = entry.id === prefab.rootEntityId ? parentId : (entry.parentId ? idMap.get(entry.parentId) || parentId : parentId);
    cloned.tags = [...new Set([...(cloned.tags || []), `prefab:${prefab.id}`, linkedTag])];
    return cloned;
  });
  scene.entities = scene.entities.filter((entity) => !existingLinkedIds.has(entity.id));
  scene.entities.push(...entities);
  Object.assign(instance, {
    schema: PREFAB_INSTANCE_SCHEMA,
    prefabId: prefab.id,
    sourceHash: hash,
    rootEntityId: idMap.get(prefab.rootEntityId) as string,
    variant: config.stored.variant,
    overrides: config.stored,
    status: 'linked',
  });
  return instance;
}

function refreshPrefabPath(project: LillyProject, prefabPath: string): void {
  for (const scene of project.scenes) {
    for (const instance of scene.prefabInstances || []) {
      if (instance.prefabPath === prefabPath) materializePrefabInstance(project, scene, instance, false);
    }
  }
}

export function validatePrefabDefinition(prefab: LillyPrefabDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!prefab || prefab.schema !== PREFAB_SCHEMA) issues.push({ code: 'INVALID_PREFAB_SCHEMA', message: `Expected ${PREFAB_SCHEMA}`, path: 'schema', severity: 'error' });
  if (!String(prefab?.id || '').trim()) issues.push({ code: 'PREFAB_ID_REQUIRED', message: 'Prefab id is required', path: 'id', severity: 'error' });
  if (!Array.isArray(prefab?.entities) || prefab.entities.length === 0) {
    issues.push({ code: 'PREFAB_ENTITIES_REQUIRED', message: 'Prefab entities are required', path: 'entities', severity: 'error' });
    return issues;
  }
  const ids = new Set<string>();
  for (const [index, entity] of prefab.entities.entries()) {
    const entityPath = `entities[${index}]`;
    if (!entity?.id || ids.has(entity.id)) issues.push({ code: 'PREFAB_ENTITY_ID_DUPLICATE', message: `Prefab entity id ${entity?.id || '<missing>'} must be unique`, path: `${entityPath}.id`, severity: 'error' });
    ids.add(entity?.id);
    if (entity?.schema !== ENTITY_SCHEMA || typeof entity.name !== 'string' || typeof entity.enabled !== 'boolean' || !Array.isArray(entity.tags) || !Array.isArray(entity.components)) {
      issues.push({ code: 'INVALID_PREFAB_ENTITY', message: `Prefab entities must use ${ENTITY_SCHEMA} with name, enabled, tags, and components`, path: entityPath, severity: 'error' });
      continue;
    }
    const componentTypes = new Set<string>();
    for (const [componentIndex, component] of entity.components.entries()) {
      const componentPath = `${entityPath}.components[${componentIndex}]`;
      if (componentTypes.has(component.type)) issues.push({ code: 'DUPLICATE_COMPONENT', message: `${component.type} can only be added once`, path: componentPath, severity: 'error' });
      componentTypes.add(component.type);
      const definition = COMPONENT_DEFINITIONS[component.type];
      if (!definition || !isPlainRecord(component.data)) issues.push({ code: 'UNKNOWN_COMPONENT', message: `Unknown or malformed component ${component.type}`, path: componentPath, severity: 'error' });
      else definition.validate(component.data).forEach((message) => issues.push({ code: 'INVALID_COMPONENT_VALUE', message, path: `${componentPath}.data`, severity: 'error' }));
    }
  }
  const root = prefab.entities.find((entry) => entry.id === prefab.rootEntityId);
  if (!root) issues.push({ code: 'PREFAB_ROOT_MISSING', message: `Prefab root ${prefab.rootEntityId || '<missing>'} does not exist`, path: 'rootEntityId', severity: 'error' });
  else if (root.parentId !== null) issues.push({ code: 'PREFAB_ROOT_PARENT', message: 'Prefab root parentId must be null', path: 'rootEntityId', severity: 'error' });
  for (const [index, entity] of prefab.entities.entries()) {
    if (entity.id !== prefab.rootEntityId && !entity.parentId) issues.push({ code: 'PREFAB_ENTITY_DISCONNECTED', message: `Prefab entity ${entity.id} must descend from the root`, path: `entities[${index}].parentId`, severity: 'error' });
    if (entity.parentId && !ids.has(entity.parentId)) issues.push({ code: 'PREFAB_PARENT_MISSING', message: `Prefab parent ${entity.parentId} does not exist`, path: `entities[${index}].parentId`, severity: 'error' });
    const visited = new Set<string>();
    let cursor: LillyEntity | undefined = entity;
    while (cursor?.parentId) {
      if (visited.has(cursor.id)) {
        issues.push({ code: 'PREFAB_PARENT_CYCLE', message: `Prefab entity ${entity.id} belongs to a parent cycle`, path: `entities[${index}].parentId`, severity: 'error' });
        break;
      }
      visited.add(cursor.id);
      cursor = prefab.entities.find((entry) => entry.id === cursor?.parentId);
    }
    if (root && entity.id !== root.id && cursor && cursor.id !== root.id) issues.push({ code: 'PREFAB_ENTITY_DISCONNECTED', message: `Prefab entity ${entity.id} must descend from root ${root.id}`, path: `entities[${index}].parentId`, severity: 'error' });
  }
  if (prefab.variants !== undefined && !Array.isArray(prefab.variants)) issues.push({ code: 'INVALID_PREFAB_VARIANTS', message: 'Prefab variants must be an array', path: 'variants', severity: 'error' });
  const variantIds = new Set<string>();
  for (const [index, variant] of (Array.isArray(prefab.variants) ? prefab.variants : []).entries()) {
    const variantPath = `variants[${index}]`;
    if (!RESOURCE_ID_PATTERN.test(String(variant?.id || '')) || variantIds.has(variant.id)) issues.push({ code: 'INVALID_PREFAB_VARIANT', message: 'Prefab variant ids must be unique resource identifiers', path: `${variantPath}.id`, severity: 'error' });
    if (!variant?.entities || !isPlainRecord(variant.entities)) issues.push({ code: 'INVALID_PREFAB_VARIANT', message: 'Prefab variants require entity overrides', path: `${variantPath}.entities`, severity: 'error' });
    else {
      try { normalizePrefabInstanceConfig({ entities: variant.entities }, { ...prefab, variants: [] }); }
      catch (error) { issues.push({ code: String((error as { code?: string }).code || 'INVALID_PREFAB_VARIANT'), message: (error as Error).message, path: variantPath, severity: 'error' }); }
    }
    if (variant?.id) variantIds.add(variant.id);
  }
  return issues;
}

export const MAX_PROJECT_SOURCE_FILES = 240;
export const MAX_PROJECT_SOURCE_FILE_BYTES = 128 * 1024;
export const MAX_PROJECT_SOURCE_BYTES = 2 * 1024 * 1024;

export function detectSourceFileKind(filePath: string): LillySourceFileKind {
  const normalized = String(filePath || '').toLowerCase();
  if (normalized.endsWith('.module.json')) return 'module-manifest';
  if (normalized.endsWith('.mechanic.json')) return 'mechanic';
  if (normalized.endsWith('.system.ts')) return 'system';
  if (normalized.endsWith('.prefab.json')) return 'prefab';
  if (normalized.endsWith('.spec.json')) return 'test';
  if (normalized.endsWith('.material.json')) return 'material';
  if (normalized.endsWith('.asset.json')) return 'asset-metadata';
  if (normalized.endsWith('.animation.json')) return 'animation-controller';
  if (normalized.endsWith('.terrain.json')) return 'terrain';
  if (normalized.endsWith('.blueprint.json')) return 'blueprint';
  if (normalized.endsWith('.scene.json')) return 'scene';
  return 'data';
}

export function normalizeSourcePath(value: string): string {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.length > 180 || normalized.startsWith('/') || normalized.includes('//')) {
    throw Object.assign(new Error('Source paths must be relative project paths up to 180 characters'), { code: 'INVALID_SOURCE_PATH' });
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment))) {
    throw Object.assign(new Error(`Source path ${normalized} contains an invalid segment`), { code: 'INVALID_SOURCE_PATH' });
  }
  const kind = detectSourceFileKind(normalized);
  if (kind === 'data' && !normalized.toLowerCase().endsWith('.json')) {
    throw Object.assign(new Error('Game Studio source files must use .system.ts or a supported .json contract extension'), { code: 'UNSUPPORTED_SOURCE_FILE' });
  }
  return normalized;
}

export function normalizeSourceFile(input: Partial<LillySourceFile> & { path: string; content: string }): LillySourceFile {
  const filePath = normalizeSourcePath(input.path);
  const content = String(input.content ?? '');
  if (new TextEncoder().encode(content).length > MAX_PROJECT_SOURCE_FILE_BYTES) {
    throw Object.assign(new Error(`Source files are limited to ${MAX_PROJECT_SOURCE_FILE_BYTES} bytes`), { code: 'SOURCE_FILE_TOO_LARGE' });
  }
  const kind = detectSourceFileKind(filePath);
  return {
    schema: SOURCE_FILE_SCHEMA,
    path: filePath,
    kind,
    language: kind === 'system' ? 'typescript' : 'json',
    content,
    enabled: input.enabled !== false,
  };
}

export function upgradeProject(projectInput: LillyProject): LillyProject {
  const project = deepClone(projectInput);
  project.engineVersion = ENGINE_VERSION;
  project.scenes = Array.isArray(project.scenes)
    ? project.scenes.map((scene) => ({ ...scene, prefabInstances: Array.isArray(scene.prefabInstances) ? scene.prefabInstances : [] }))
    : [];
  project.levelRecipes = Array.isArray(project.levelRecipes)
    ? project.levelRecipes.map((recipe) => normalizeLevelRecipe(recipe))
    : [];
  project.generatedLevels = Array.isArray(project.generatedLevels)
    ? project.generatedLevels.map((design) => {
      const upgraded = {
        ...design,
        encounters: Array.isArray(design.encounters) ? design.encounters : [],
        metrics: {
          ...design.metrics,
          encounterCount: Number(design.metrics?.encounterCount || 0),
          enemyCount: Number(design.metrics?.enemyCount || 0),
          checkpointCount: Number(design.metrics?.checkpointCount || 0),
        },
      } as LillyGeneratedLevel;
      upgraded.checksum = computeGeneratedLevelChecksum(upgraded);
      return upgraded;
    })
    : [];
  project.files = Array.isArray(project.files)
    ? project.files.map((file) => normalizeSourceFile(file))
    : [];
  project.assets = Array.isArray(project.assets) ? project.assets : [];
  project.dataAssets = Array.isArray(project.dataAssets) ? project.dataAssets.map((asset) => normalizeDataAsset(asset)) : [];
  project.inputMap = Array.isArray(project.inputMap) ? project.inputMap : [];
  const inferredRuntimeProfile: LillyRuntimeProfile = project.levelRecipes.length || project.generatedLevels.length
    ? 'expedition'
    : 'module-driven';
  project.settings = {
    renderer: project.settings?.renderer === 'webgpu-experimental' ? 'webgpu-experimental' : 'webgl2',
    fixedStepHz: Number(project.settings?.fixedStepHz || 60),
    gravity: project.settings?.gravity || { x: 0, y: -9.81, z: 0 },
    mobileMode: project.settings?.mobileMode === 'play-review' ? 'play-review' : 'author-play',
    runtimeProfile: project.settings?.runtimeProfile === 'expedition' || project.settings?.runtimeProfile === 'module-driven'
      ? project.settings.runtimeProfile
      : inferredRuntimeProfile,
    ...(project.settings?.buildProfile ? { buildProfile: deepClone(project.settings.buildProfile) } : {}),
    ...(project.settings?.legacyImport ? { legacyImport: deepClone(project.settings.legacyImport) } : {}),
  };
  project.buildProfiles = Array.isArray(project.buildProfiles) && project.buildProfiles.length > 0
    ? project.buildProfiles.map((profile) => normalizeBuildProfile(profile))
    : createDefaultBuildProfiles(project.entryScene, project.settings.renderer);
  project.activeBuildProfileId = project.buildProfiles.some((profile) => profile.id === project.activeBuildProfileId)
    ? project.activeBuildProfileId
    : project.buildProfiles.find((profile) => profile.id === 'release')?.id || project.buildProfiles[0].id;
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
  if (!['expedition', 'module-driven'].includes(project.settings?.runtimeProfile)) issues.push({ code: 'INVALID_RUNTIME_PROFILE', message: 'settings.runtimeProfile must be expedition or module-driven', path: 'settings.runtimeProfile', severity: 'error' });
  if (!Number.isFinite(project.settings?.fixedStepHz) || project.settings.fixedStepHz < 1 || project.settings.fixedStepHz > 240) issues.push({ code: 'INVALID_FIXED_STEP', message: 'settings.fixedStepHz must be between 1 and 240', path: 'settings.fixedStepHz', severity: 'error' });
  const projectAssets = Array.isArray(project.assets) ? project.assets : [];
  const assetIds = new Set<string>();
  for (const [assetIndex, asset] of projectAssets.entries()) {
    const path = `assets[${assetIndex}]`;
    if (!String(asset?.id || '').trim()) issues.push({ code: 'ASSET_ID_REQUIRED', message: 'Project assets require an id', path: `${path}.id`, severity: 'error' });
    else if (assetIds.has(asset.id)) issues.push({ code: 'DUPLICATE_ASSET_ID', message: `Duplicate asset id ${asset.id}`, path: `${path}.id`, severity: 'error' });
    if (asset?.id) assetIds.add(asset.id);
    if (!String(asset?.name || '').trim()) issues.push({ code: 'ASSET_NAME_REQUIRED', message: 'Project assets require a name', path: `${path}.name`, severity: 'error' });
    if (!String(asset?.type || '').trim()) issues.push({ code: 'ASSET_TYPE_REQUIRED', message: 'Project assets require a MIME type', path: `${path}.type`, severity: 'error' });
    const uri = String(asset?.uri || '').replace(/\\/g, '/');
    if (!uri || uri.startsWith('/') || uri.split('/').some((segment) => segment === '..')) issues.push({ code: 'INVALID_ASSET_URI', message: 'Project asset URIs must be safe relative paths', path: `${path}.uri`, severity: 'error' });
  }
  const dataAssetIds = new Set<string>();
  for (const [dataAssetIndex, dataAsset] of (project.dataAssets || []).entries()) {
    const path = `dataAssets[${dataAssetIndex}]`;
    validateDataAsset(dataAsset).forEach((issue) => issues.push({ ...issue, path: `${path}.${issue.path}` }));
    if (dataAssetIds.has(dataAsset.id)) issues.push({ code: 'DUPLICATE_DATA_ASSET_ID', message: `Duplicate data asset id ${dataAsset.id}`, path: `${path}.id`, severity: 'error' });
    dataAssetIds.add(dataAsset.id);
  }
  const buildProfileIds = new Set<string>();
  for (const [profileIndex, profile] of (project.buildProfiles || []).entries()) {
    const path = `buildProfiles[${profileIndex}]`;
    validateBuildProfile(profile, project).forEach((issue) => issues.push({ ...issue, path: `${path}.${issue.path}` }));
    if (buildProfileIds.has(profile.id)) issues.push({ code: 'DUPLICATE_BUILD_PROFILE_ID', message: `Duplicate build profile id ${profile.id}`, path: `${path}.id`, severity: 'error' });
    buildProfileIds.add(profile.id);
  }
  if (!buildProfileIds.has(String(project.activeBuildProfileId || ''))) issues.push({ code: 'ACTIVE_BUILD_PROFILE_MISSING', message: 'activeBuildProfileId must reference an authored build profile', path: 'activeBuildProfileId', severity: 'error' });
  const sourceFiles = Array.isArray(project.files) ? project.files : [];
  const resourceIds = {
    material: new Set<string>(),
    'animation-controller': new Set<string>(),
    terrain: new Set<string>(),
  };
  for (const file of sourceFiles) {
    if (!file.enabled || !(file.kind in resourceIds)) continue;
    try {
      const value = JSON.parse(file.content) as { id?: string };
      if (String(value?.id || '').trim()) resourceIds[file.kind as keyof typeof resourceIds].add(String(value.id));
    } catch (_error) {
      // The module compiler reports source parse diagnostics with exact file paths.
    }
  }
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
        const data = component.data || {};
        if (['MeshRenderer', 'AudioSource', 'Animator'].includes(component.type) && String(data.assetId || '') && !assetIds.has(String(data.assetId))) issues.push({ code: 'ASSET_REFERENCE_MISSING', message: `${component.type} references missing asset ${data.assetId}`, path: `${path}.components[${componentIndex}].data.assetId`, severity: 'error' });
        if (component.type === 'MeshRenderer' && String(data.materialId || '') && !resourceIds.material.has(String(data.materialId))) issues.push({ code: 'MATERIAL_REFERENCE_MISSING', message: `MeshRenderer references missing material ${data.materialId}`, path: `${path}.components[${componentIndex}].data.materialId`, severity: 'error' });
        if (component.type === 'Animator' && String(data.controllerId || '') && !resourceIds['animation-controller'].has(String(data.controllerId))) issues.push({ code: 'ANIMATION_CONTROLLER_REFERENCE_MISSING', message: `Animator references missing controller ${data.controllerId}`, path: `${path}.components[${componentIndex}].data.controllerId`, severity: 'error' });
        if (component.type === 'DataReference' && !dataAssetIds.has(String(data.assetId || ''))) issues.push({ code: 'DATA_ASSET_REFERENCE_MISSING', message: `DataReference references missing data asset ${data.assetId}`, path: `${path}.components[${componentIndex}].data.assetId`, severity: 'error' });
        if (component.type === 'Terrain' && String(data.terrainId || '') && !resourceIds.terrain.has(String(data.terrainId))) issues.push({ code: 'TERRAIN_REFERENCE_MISSING', message: `Terrain component references missing terrain ${data.terrainId}`, path: `${path}.components[${componentIndex}].data.terrainId`, severity: 'error' });
      }
    }
    const instanceIds = new Set<string>();
    for (const [instanceIndex, instance] of (scene.prefabInstances || []).entries()) {
      const path = `scenes[${sceneIndex}].prefabInstances[${instanceIndex}]`;
      if (instance?.schema !== PREFAB_INSTANCE_SCHEMA) issues.push({ code: 'INVALID_PREFAB_INSTANCE_SCHEMA', message: `Expected ${PREFAB_INSTANCE_SCHEMA}`, path: `${path}.schema`, severity: 'error' });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(String(instance?.instanceId || '')) || instanceIds.has(instance.instanceId)) issues.push({ code: 'INVALID_PREFAB_INSTANCE_ID', message: 'Prefab instance ids must be unique stable identifiers', path: `${path}.instanceId`, severity: 'error' });
      instanceIds.add(instance.instanceId);
      if (!['linked', 'missing-source', 'invalid-source'].includes(String(instance?.status || ''))) issues.push({ code: 'INVALID_PREFAB_INSTANCE_STATUS', message: 'Prefab instance status is invalid', path: `${path}.status`, severity: 'error' });
      const file = sourceFiles.find((entry) => entry.path === instance.prefabPath && entry.kind === 'prefab');
      if (!file || instance.status === 'missing-source') issues.push({ code: 'PREFAB_INSTANCE_SOURCE_MISSING', message: `Linked prefab source ${instance.prefabPath} is missing`, path: `${path}.prefabPath`, severity: 'error' });
      else if (instance.status === 'invalid-source') issues.push({ code: 'PREFAB_INSTANCE_SOURCE_INVALID', message: `Linked prefab source ${instance.prefabPath} is invalid`, path: `${path}.status`, severity: 'error' });
      else if (instance.sourceHash !== sourceHash(file.content)) issues.push({ code: 'PREFAB_INSTANCE_OUT_OF_DATE', message: `Prefab instance ${instance.instanceId} needs a source refresh`, path: `${path}.sourceHash`, severity: 'warning' });
      if (!scene.entities.some((entity) => entity.id === instance.rootEntityId)) issues.push({ code: 'PREFAB_INSTANCE_ROOT_MISSING', message: `Prefab instance root ${instance.rootEntityId} does not exist`, path: `${path}.rootEntityId`, severity: 'error' });
    }
  }
  const sourcePaths = new Set<string>();
  let sourceBytes = 0;
  if (sourceFiles.length > MAX_PROJECT_SOURCE_FILES) {
    issues.push({ code: 'SOURCE_FILE_LIMIT', message: `Projects support at most ${MAX_PROJECT_SOURCE_FILES} source files`, path: 'files', severity: 'error' });
  }
  sourceFiles.forEach((file, fileIndex) => {
    const filePath = `files[${fileIndex}]`;
    try {
      const normalized = normalizeSourceFile(file);
      const bytes = new TextEncoder().encode(normalized.content).length;
      sourceBytes += bytes;
      if (sourcePaths.has(normalized.path)) issues.push({ code: 'DUPLICATE_SOURCE_PATH', message: `Duplicate source path ${normalized.path}`, path: `${filePath}.path`, severity: 'error' });
      sourcePaths.add(normalized.path);
      if (file.schema !== SOURCE_FILE_SCHEMA) issues.push({ code: 'INVALID_SOURCE_FILE_SCHEMA', message: `Expected ${SOURCE_FILE_SCHEMA}`, path: `${filePath}.schema`, severity: 'error' });
      if (file.kind !== normalized.kind || file.language !== normalized.language) issues.push({ code: 'SOURCE_FILE_KIND_MISMATCH', message: `${normalized.path} must be stored as ${normalized.kind}/${normalized.language}`, path: filePath, severity: 'error' });
    } catch (error) {
      issues.push({ code: String((error as { code?: string }).code || 'INVALID_SOURCE_FILE'), message: (error as Error).message, path: filePath, severity: 'error' });
    }
  });
  if (sourceBytes > MAX_PROJECT_SOURCE_BYTES) {
    issues.push({ code: 'SOURCE_SIZE_LIMIT', message: `Project source is limited to ${MAX_PROJECT_SOURCE_BYTES} bytes`, path: 'files', severity: 'error' });
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
    const scene = project.scenes.find((candidate) => candidate.id === design.sceneId) || null;
    if (!scene) continue;
    const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
    (design.encounters || []).forEach((encounter, encounterIndex) => {
      const path = `generatedLevels[${levelIndex}].encounters[${encounterIndex}]`;
      encounter.enemyIds.forEach((entityId, enemyIndex) => {
        const entity = byId.get(entityId);
        const member = entity ? getComponent(entity, 'EncounterMember') : null;
        const health = entity ? getComponent(entity, 'Health') : null;
        const brain = entity ? getComponent(entity, 'EnemyBrain') : null;
        if (!entity || !member || !health || !brain || member.data.encounterId !== encounter.id) {
          issues.push({ code: 'ENCOUNTER_ENEMY_INVALID', message: `Encounter enemy ${entityId} is missing required gameplay components`, path: `${path}.enemyIds[${enemyIndex}]`, severity: 'error' });
        }
      });
      encounter.gateIds.forEach((entityId, gateIndex) => {
        const gate = byId.get(entityId);
        const gateComponent = gate ? getComponent(gate, 'EncounterGate') : null;
        if (!gate || !gateComponent || gateComponent.data.encounterId !== encounter.id) {
          issues.push({ code: 'ENCOUNTER_GATE_INVALID', message: `Encounter gate ${entityId} is missing its matching EncounterGate component`, path: `${path}.gateIds[${gateIndex}]`, severity: 'error' });
        }
      });
      const checkpoint = byId.get(encounter.checkpointId);
      const checkpointComponent = checkpoint ? getComponent(checkpoint, 'Checkpoint') : null;
      if (!checkpoint || !checkpointComponent || checkpointComponent.data.encounterId !== encounter.id) {
        issues.push({ code: 'ENCOUNTER_CHECKPOINT_INVALID', message: `Encounter checkpoint ${encounter.checkpointId} is missing its matching Checkpoint component`, path: `${path}.checkpointId`, severity: 'error' });
      }
    });
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
  playerComponents: LillyComponent[] | null;
  objectiveGraph: LillyBlueprint | null;
  uiAnchor: { entityId: string; component: LillyComponent } | null;
  mobileMode: LillyProject['settings']['mobileMode'];
  inputMap: LillyInputBinding[];
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
    playerComponents: player ? deepClone(player.components) : null,
    objectiveGraph: objectiveGraph ? deepClone(objectiveGraph) : null,
    uiAnchor,
    mobileMode: project.settings.mobileMode,
    inputMap: deepClone(project.inputMap || []),
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
  if (player && snapshot.playerComponents) player.components = deepClone(snapshot.playerComponents);
  project.inputMap = deepClone(snapshot.inputMap || project.inputMap || []);
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

function generatedObjectiveGraph(recipe: LillyLevelRecipe, graphId: string): LillyBlueprint {
  const eventPins = [{ id: 'exec-out', name: 'Then', kind: 'exec' as const, direction: 'output' as const }];
  const actionPins = [
    { id: 'exec-in', name: 'In', kind: 'exec' as const, direction: 'input' as const },
    { id: 'exec-out', name: 'Then', kind: 'exec' as const, direction: 'output' as const },
  ];
  const branchPins = [
    { id: 'exec-in', name: 'In', kind: 'exec' as const, direction: 'input' as const },
    { id: 'true', name: 'True', kind: 'exec' as const, direction: 'output' as const },
    { id: 'condition', name: 'Condition', kind: 'data' as const, direction: 'input' as const, dataType: 'boolean' as const },
  ];
  const variables = [
    { id: 'score', name: 'Score', dataType: 'number' as const, defaultValue: 0 },
    { id: 'exitReached', name: 'Exit Reached', dataType: 'boolean' as const, defaultValue: false },
    { id: 'encountersCleared', name: 'Encounters Cleared', dataType: 'number' as const, defaultValue: 0 },
  ];
  const hudWin = {
    id: 'hud-win',
    type: 'presentation.hud-message',
    label: 'Complete Expedition',
    position: { x: 760, y: 270 },
    pins: [{ id: 'exec-in', name: 'In', kind: 'exec' as const, direction: 'input' as const }],
    config: { message: `${recipe.name} secured!` },
  };
  if (recipe.objective === 'reach-exit') {
    return {
      schema: BLUEPRINT_SCHEMA,
      id: graphId,
      name: 'Expedition Win Condition',
      variables,
      nodes: [
        { id: 'event-exit', type: 'event.custom', label: 'On Exit Reached', position: { x: 40, y: 270 }, pins: eventPins, config: { eventName: 'exit.reached' } },
        hudWin,
      ],
      edges: [{ id: 'exit-win', sourceNodeId: 'event-exit', sourcePinId: 'exec-out', targetNodeId: 'hud-win', targetPinId: 'exec-in' }],
    };
  }
  const secure = recipe.objective === 'secure-and-exit';
  const progressVariable = secure ? 'encountersCleared' : 'score';
  const progressTarget = secure ? recipe.gameplay.encounterCount : recipe.gameplay.pickupCount;
  const progressEvent = secure ? 'encounter.cleared' : 'pickup.collected';
  const progressLabel = secure ? 'On Encounter Cleared' : 'On Pickup';
  const addLabel = secure ? 'Add Encounter Clear' : 'Add Score';
  return {
    schema: BLUEPRINT_SCHEMA,
    id: graphId,
    name: 'Expedition Win Condition',
    variables,
    nodes: [
      { id: 'event-progress', type: 'event.custom', label: progressLabel, position: { x: 40, y: 70 }, pins: eventPins, config: { eventName: progressEvent } },
      { id: 'add-progress', type: 'variable.add', label: addLabel, position: { x: 270, y: 70 }, pins: actionPins, config: { variableId: progressVariable, amount: 1 } },
      { id: 'branch-unlock', type: 'flow.branch', label: 'Progress complete?', position: { x: 500, y: 70 }, pins: branchPins, config: { expression: `${progressVariable} >= ${progressTarget}` } },
      { id: 'hud-unlock', type: 'presentation.hud-message', label: 'Unlock Exit', position: { x: 760, y: 70 }, pins: [{ id: 'exec-in', name: 'In', kind: 'exec' as const, direction: 'input' as const }], config: { message: 'Exit beacon unlocked!' } },
      { id: 'event-exit', type: 'event.custom', label: 'On Exit Reached', position: { x: 40, y: 270 }, pins: eventPins, config: { eventName: 'exit.reached' } },
      { id: 'branch-win', type: 'flow.branch', label: 'Exit unlocked?', position: { x: 500, y: 270 }, pins: branchPins, config: { expression: `${progressVariable} >= ${progressTarget}` } },
      hudWin,
    ],
    edges: [
      { id: 'progress-add', sourceNodeId: 'event-progress', sourcePinId: 'exec-out', targetNodeId: 'add-progress', targetPinId: 'exec-in' },
      { id: 'progress-check', sourceNodeId: 'add-progress', sourcePinId: 'exec-out', targetNodeId: 'branch-unlock', targetPinId: 'exec-in' },
      { id: 'progress-unlock', sourceNodeId: 'branch-unlock', sourcePinId: 'true', targetNodeId: 'hud-unlock', targetPinId: 'exec-in' },
      { id: 'exit-check', sourceNodeId: 'event-exit', sourcePinId: 'exec-out', targetNodeId: 'branch-win', targetPinId: 'exec-in' },
      { id: 'exit-win', sourceNodeId: 'branch-win', sourcePinId: 'true', targetNodeId: 'hud-win', targetPinId: 'exec-in' },
    ],
  };
}

function updateGeneratedObjective(project: LillyProject, scene: LillyScene, recipe: LillyLevelRecipe) {
  const graph = findObjectiveGraph(project, scene);
  if (graph) {
    const next = generatedObjectiveGraph(recipe, graph.id);
    graph.name = next.name;
    graph.variables = next.variables;
    graph.nodes = next.nodes;
    graph.edges = next.edges;
  }
  const rulesEntity = scene.entities.find((entity) => entity.tags.includes('gameplay'));
  const anchor = rulesEntity ? getComponent(rulesEntity, 'UIAnchor') : null;
  if (anchor) {
    anchor.data.text = recipe.objective === 'reach-exit'
      ? 'Find and reach the exit beacon'
      : recipe.objective === 'secure-and-exit'
        ? `Clear ${recipe.gameplay.encounterCount} encounter${recipe.gameplay.encounterCount === 1 ? '' : 's'}, then reach the exit`
        : `Collect ${recipe.gameplay.pickupCount} energy cores, then reach the exit`;
  }
}

function ensurePlayerGameplay(project: LillyProject, scene: LillyScene, recipe: LillyLevelRecipe) {
  const player = scene.entities.find((entity) => entity.tags.includes('player')) || null;
  if (!player) return;
  const setComponent = (type: LillyComponentType, data: Record<string, unknown>) => {
    const next = component(type, data);
    const index = player.components.findIndex((entry) => entry.type === type);
    if (index >= 0) player.components[index] = next;
    else player.components.push(next);
  };
  const maxHealth = Math.max(3, Math.min(8, 3 + Math.floor((recipe.gameplay.difficulty - 1) / 2)));
  setComponent('Health', { max: maxHealth, current: maxHealth, invulnerabilitySeconds: 0.55 });
  setComponent('Combatant', {
    team: 'player',
    damage: recipe.gameplay.difficulty >= 4 ? 2 : 1,
    range: 2.25,
    cooldownSeconds: 0.42,
    attackAction: 'Attack',
  });
  if (!project.inputMap.some((binding) => binding.action === 'Attack')) {
    project.inputMap.push({ action: 'Attack', kind: 'button', keys: ['Space', 'Enter'] });
  }
}

export function applyCommand(projectInput: LillyProject, command: LillyCommand): { project: LillyProject; inverse: LillyCommand } {
  if (command.schema !== COMMAND_SCHEMA) throw Object.assign(new Error(`Commands must use ${COMMAND_SCHEMA}`), { code: 'INVALID_COMMAND_SCHEMA' });
  if (command.projectId !== projectInput.id) throw Object.assign(new Error('Command projectId does not match the project'), { code: 'PROJECT_MISMATCH' });
  const project = upgradeProject(projectInput);
  const scene = command.target.sceneId ? project.scenes.find((entry) => entry.id === command.target.sceneId) || null : null;
  const inverseBase = { schema: COMMAND_SCHEMA, commandId: `${command.commandId}:inverse`, projectId: project.id, baseRevision: command.baseRevision, target: deepClone(command.target) } as Omit<LillyCommand, 'operation' | 'payload'>;
  let inverse: LillyCommand;

  switch (command.operation) {
    case 'scene.create': {
      const created = deepClone(command.payload.scene as LillyScene);
      if (!created?.id || project.scenes.some((entry) => entry.id === created.id)) throw Object.assign(new Error('Created scene id must be unique'), { code: 'DUPLICATE_SCENE_ID' });
      if (created.schema !== SCENE_SCHEMA || !Array.isArray(created.entities) || !Array.isArray(created.blueprintGraphIds)) {
        throw Object.assign(new Error(`scene.create requires a ${SCENE_SCHEMA} scene`), { code: 'INVALID_SCENE' });
      }
      created.prefabInstances = Array.isArray(created.prefabInstances) ? created.prefabInstances : [];
      project.scenes.push(created);
      inverse = { ...inverseBase, operation: 'scene.delete', target: { sceneId: created.id }, payload: {} };
      break;
    }
    case 'scene.delete': {
      if (!scene) throw Object.assign(new Error('scene.delete requires an existing target.sceneId'), { code: 'SCENE_NOT_FOUND' });
      if (project.scenes.length <= 1) throw Object.assign(new Error('A project must keep at least one scene'), { code: 'LAST_SCENE_DELETE' });
      if (project.entryScene === scene.id) throw Object.assign(new Error('Set another entry scene before deleting the current entry scene'), { code: 'ENTRY_SCENE_DELETE' });
      project.scenes = project.scenes.filter((entry) => entry.id !== scene.id);
      inverse = { ...inverseBase, operation: 'scene.create', target: {}, payload: { scene } };
      break;
    }
    case 'scene.rename': {
      if (!scene) throw Object.assign(new Error('scene.rename requires an existing target.sceneId'), { code: 'SCENE_NOT_FOUND' });
      const previous = scene.name;
      scene.name = String(command.payload.name || '').trim() || scene.name;
      inverse = { ...inverseBase, operation: 'scene.rename', payload: { name: previous } };
      break;
    }
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
      const linked = linkedPrefabForEntity(scene, command.target.entityId);
      if (linked) {
        if (linked.instance.rootEntityId !== command.target.entityId) throw Object.assign(new Error('Inherited prefab children cannot be deleted; unpack the instance first'), { code: 'PREFAB_INHERITED_ENTITY_LOCKED' });
        const instance = deepClone(linked.instance);
        const removed = removeEntityTree(scene, command.target.entityId);
        scene.prefabInstances = scene.prefabInstances.filter((entry) => entry.instanceId !== instance.instanceId);
        inverse = { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: instance.instanceId }, payload: { snapshot: { instance, entities: removed } } };
        break;
      }
      const removed = removeEntityTree(scene, command.target.entityId);
      if (removed.length === 0) throw Object.assign(new Error('Entity was not found'), { code: 'ENTITY_NOT_FOUND' });
      inverse = { ...inverseBase, operation: 'entity.create', target: { sceneId: scene.id }, payload: { entity: removed[0], descendants: removed.slice(1) } };
      break;
    }
    case 'entity.rename': {
      if (!scene || !command.target.entityId) throw new Error('entity.rename requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const previous = entity.name;
      const linked = linkedPrefabForEntity(scene, entity.id);
      const linkedSnapshot = linked ? capturePrefabInstanceState(scene, linked.instance.instanceId) : null;
      entity.name = String(command.payload.name || '').trim() || entity.name;
      if (linked) {
        const override = prefabEntityOverride(linked.instance, linked.sourceEntityId);
        const sourceEntity = prefabSourceEntityState(project, linked.instance, linked.sourceEntityId);
        if (entity.name === sourceEntity.name) delete override.name;
        else override.name = entity.name;
        prunePrefabEntityOverride(linked.instance, linked.sourceEntityId);
      }
      inverse = linked && linkedSnapshot
        ? { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: linked.instance.instanceId }, payload: { snapshot: linkedSnapshot } }
        : { ...inverseBase, operation: 'entity.rename', payload: { name: previous } };
      break;
    }
    case 'entity.reparent': {
      if (!scene || !command.target.entityId) throw new Error('entity.reparent requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const parentId = command.payload.parentId ? String(command.payload.parentId) : null;
      if (parentId && !scene.entities.some((entry) => entry.id === parentId)) throw Object.assign(new Error('Parent entity does not exist'), { code: 'PARENT_MISSING' });
      if (createsRecursiveParenting(scene, entity.id, parentId)) throw Object.assign(new Error('Recursive parenting is not allowed'), { code: 'RECURSIVE_PARENT' });
      const linked = linkedPrefabForEntity(scene, entity.id);
      if (linked && linked.instance.rootEntityId !== entity.id) throw Object.assign(new Error('Inherited prefab hierarchy cannot be reparented; unpack the instance first'), { code: 'PREFAB_INHERITED_ENTITY_LOCKED' });
      const linkedSnapshot = linked ? capturePrefabInstanceState(scene, linked.instance.instanceId) : null;
      const previous = entity.parentId;
      entity.parentId = parentId;
      if (linked) linked.instance.parentId = parentId;
      inverse = linked && linkedSnapshot
        ? { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: linked.instance.instanceId }, payload: { snapshot: linkedSnapshot } }
        : { ...inverseBase, operation: 'entity.reparent', payload: { parentId: previous } };
      break;
    }
    case 'entity.set-enabled': {
      if (!scene || !command.target.entityId) throw new Error('entity.set-enabled requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const previous = entity.enabled;
      const linked = linkedPrefabForEntity(scene, entity.id);
      const linkedSnapshot = linked ? capturePrefabInstanceState(scene, linked.instance.instanceId) : null;
      entity.enabled = command.payload.enabled !== false;
      if (linked) {
        const override = prefabEntityOverride(linked.instance, linked.sourceEntityId);
        const sourceEntity = prefabSourceEntityState(project, linked.instance, linked.sourceEntityId);
        if (entity.enabled === sourceEntity.enabled) delete override.enabled;
        else override.enabled = entity.enabled;
        prunePrefabEntityOverride(linked.instance, linked.sourceEntityId);
      }
      inverse = linked && linkedSnapshot
        ? { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: linked.instance.instanceId }, payload: { snapshot: linkedSnapshot } }
        : { ...inverseBase, operation: 'entity.set-enabled', payload: { enabled: previous } };
      break;
    }
    case 'entity.set-locked': {
      if (!scene || !command.target.entityId) throw new Error('entity.set-locked requires a scene and entity');
      const entity = getEntity(scene, command.target.entityId);
      const previous = entity.locked === true;
      const linked = linkedPrefabForEntity(scene, entity.id);
      const linkedSnapshot = linked ? capturePrefabInstanceState(scene, linked.instance.instanceId) : null;
      entity.locked = command.payload.locked === true;
      if (linked) {
        const override = prefabEntityOverride(linked.instance, linked.sourceEntityId);
        const sourceEntity = prefabSourceEntityState(project, linked.instance, linked.sourceEntityId);
        if ((entity.locked === true) === (sourceEntity.locked === true)) delete override.locked;
        else override.locked = entity.locked;
        prunePrefabEntityOverride(linked.instance, linked.sourceEntityId);
      }
      inverse = linked && linkedSnapshot
        ? { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: linked.instance.instanceId }, payload: { snapshot: linkedSnapshot } }
        : { ...inverseBase, operation: 'entity.set-locked', payload: { locked: previous } };
      break;
    }
    case 'component.set': {
      if (!scene || !command.target.entityId || !command.target.componentType) throw new Error('component.set requires a scene, entity, and componentType');
      const entity = getEntity(scene, command.target.entityId);
      const index = entity.components.findIndex((entry) => entry.type === command.target.componentType);
      const previous = index >= 0 ? deepClone(entity.components[index]) : null;
      const definition = COMPONENT_DEFINITIONS[command.target.componentType];
      if (!definition) throw Object.assign(new Error(`Unknown component ${command.target.componentType}`), { code: 'UNKNOWN_COMPONENT' });
      const linked = linkedPrefabForEntity(scene, entity.id);
      if (linked && index < 0) throw Object.assign(new Error('Components cannot be added to a linked prefab member; unpack the instance first'), { code: 'PREFAB_COMPONENT_ADDITION_UNSUPPORTED' });
      const linkedSnapshot = linked ? capturePrefabInstanceState(scene, linked.instance.instanceId) : null;
      const next: LillyComponent = {
        type: command.target.componentType,
        enabled: command.payload.enabled !== false,
        data: index >= 0 && previous
          ? mergeSafeRecords(previous.data, deepClone((command.payload.data || {}) as Record<string, unknown>))
          : mergeSafeRecords(deepClone(definition.defaults), deepClone((command.payload.data || {}) as Record<string, unknown>)),
      };
      const errors = definition.validate(next.data);
      if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'INVALID_COMPONENT_VALUE' });
      if (index >= 0) entity.components[index] = next;
      else entity.components.push(next);
      if (linked) {
        const override = prefabEntityOverride(linked.instance, linked.sourceEntityId);
        const sourceEntity = prefabSourceEntityState(project, linked.instance, linked.sourceEntityId);
        const sourceComponent = sourceEntity.components.find((entry) => entry.type === command.target.componentType);
        if (!sourceComponent) throw Object.assign(new Error(`Prefab entity ${linked.sourceEntityId} no longer contains component ${command.target.componentType}`), { code: 'PREFAB_CONFIG_COMPONENT_NOT_FOUND' });
        const comparableData = deepClone(next.data);
        if (command.target.componentType === 'Transform' && linked.instance.rootEntityId === entity.id) {
          const desired = next.data.position as Vec3;
          const sourcePosition = sourceComponent.data.position as Vec3;
          if (isFiniteVec3(desired) && isFiniteVec3(sourcePosition)) {
            const position = { x: desired.x - sourcePosition.x, y: desired.y - sourcePosition.y, z: desired.z - sourcePosition.z };
            if (Math.abs(position.x) + Math.abs(position.y) + Math.abs(position.z) < 1e-9) delete linked.instance.overrides.position;
            else linked.instance.overrides.position = position;
            comparableData.position = deepClone(sourcePosition);
          }
        }
        const componentPatch = diffStructuredRecord(comparableData, sourceComponent.data);
        override.components ||= {};
        override.componentEnabled ||= {};
        if (Object.keys(componentPatch).length > 0) override.components[command.target.componentType] = componentPatch;
        else delete override.components[command.target.componentType];
        if ((next.enabled !== false) === (sourceComponent.enabled !== false)) delete override.componentEnabled[command.target.componentType];
        else override.componentEnabled[command.target.componentType] = next.enabled !== false;
        prunePrefabEntityOverride(linked.instance, linked.sourceEntityId);
      }
      inverse = linked && linkedSnapshot
        ? { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: linked.instance.instanceId }, payload: { snapshot: linkedSnapshot } }
        : previous
          ? { ...inverseBase, operation: 'component.set', payload: { enabled: previous.enabled, data: previous.data } }
          : { ...inverseBase, operation: 'component.remove', payload: {} };
      break;
    }
    case 'component.remove': {
      if (!scene || !command.target.entityId || !command.target.componentType) throw new Error('component.remove requires a scene, entity, and componentType');
      const entity = getEntity(scene, command.target.entityId);
      const index = entity.components.findIndex((entry) => entry.type === command.target.componentType);
      if (index < 0) throw Object.assign(new Error('Component was not found'), { code: 'COMPONENT_NOT_FOUND' });
      if (linkedPrefabForEntity(scene, entity.id)) throw Object.assign(new Error('Components cannot be removed from a linked prefab member; unpack the instance first'), { code: 'PREFAB_COMPONENT_REMOVAL_UNSUPPORTED' });
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
      if (Array.isArray(command.payload.sceneIds)) {
        for (const sceneId of command.payload.sceneIds as string[]) {
          const referencedScene = project.scenes.find((entry) => entry.id === sceneId);
          if (referencedScene && !referencedScene.blueprintGraphIds.includes(graphId)) referencedScene.blueprintGraphIds.push(graphId);
        }
      }
      inverse = previous
        ? { ...inverseBase, operation: 'blueprint.replace', payload: { graph: previous } }
        : { ...inverseBase, operation: 'blueprint.delete', target: { graphId }, payload: {} };
      break;
    }
    case 'blueprint.delete': {
      const graphId = command.target.graphId;
      if (!graphId) throw new Error('blueprint.delete requires target.graphId');
      const index = project.blueprints.findIndex((entry) => entry.id === graphId);
      if (index < 0) throw Object.assign(new Error('Blueprint was not found'), { code: 'BLUEPRINT_NOT_FOUND' });
      const previous = project.blueprints.splice(index, 1)[0];
      const sceneIds = project.scenes.filter((entry) => entry.blueprintGraphIds.includes(graphId)).map((entry) => entry.id);
      project.scenes.forEach((entry) => { entry.blueprintGraphIds = entry.blueprintGraphIds.filter((id) => id !== graphId); });
      inverse = { ...inverseBase, operation: 'blueprint.replace', target: { graphId }, payload: { graph: previous, sceneIds } };
      break;
    }
    case 'file.upsert': {
      const rawFile = command.payload.file as Partial<LillySourceFile> & { path: string; content: string };
      const file = normalizeSourceFile({ ...rawFile, path: command.target.path || rawFile?.path });
      const index = project.files.findIndex((entry) => entry.path === file.path);
      const previous = index >= 0 ? deepClone(project.files[index]) : null;
      if (index >= 0) project.files[index] = file;
      else project.files.push(file);
      project.files.sort((left, right) => left.path.localeCompare(right.path));
      if (file.kind === 'prefab') refreshPrefabPath(project, file.path);
      inverse = previous
        ? { ...inverseBase, operation: 'file.upsert', target: { path: previous.path }, payload: { file: previous } }
        : { ...inverseBase, operation: 'file.delete', target: { path: file.path }, payload: {} };
      break;
    }
    case 'file.delete': {
      const filePath = normalizeSourcePath(String(command.target.path || ''));
      const index = project.files.findIndex((entry) => entry.path === filePath);
      if (index < 0) throw Object.assign(new Error(`Source file ${filePath} was not found`), { code: 'SOURCE_FILE_NOT_FOUND' });
      if (project.scenes.some((entry) => entry.prefabInstances.some((instance) => instance.prefabPath === filePath))) {
        throw Object.assign(new Error(`Prefab source ${filePath} is still used by linked instances; unpack or delete them first`), { code: 'PREFAB_SOURCE_IN_USE' });
      }
      const previous = project.files.splice(index, 1)[0];
      inverse = { ...inverseBase, operation: 'file.upsert', target: { path: previous.path }, payload: { file: previous } };
      break;
    }
    case 'prefab.instantiate': {
      if (!scene) throw new Error('prefab.instantiate requires target.sceneId');
      const targetPath = command.target.path ? normalizeSourcePath(String(command.target.path)) : '';
      const payloadPath = command.payload.path ? normalizeSourcePath(String(command.payload.path)) : '';
      if (targetPath && payloadPath && targetPath !== payloadPath) throw Object.assign(new Error('Prefab target path and payload path must match'), { code: 'PREFAB_PATH_MISMATCH' });
      const prefabPath = targetPath || payloadPath;
      if (!prefabPath) throw Object.assign(new Error('prefab.instantiate requires a prefab source path'), { code: 'PREFAB_PATH_REQUIRED' });
      const { prefab } = readPrefabSource(project, prefabPath);
      const requestedPrefabId = String(command.target.prefabId || command.payload.prefabId || '').trim();
      if (requestedPrefabId && requestedPrefabId !== prefab.id) throw Object.assign(new Error(`Prefab id ${requestedPrefabId} does not match source id ${prefab.id}`), { code: 'PREFAB_ID_MISMATCH' });
      const targetInstanceId = String(command.target.instanceId || '').trim();
      const payloadInstanceId = String(command.payload.instanceId || '').trim();
      if (targetInstanceId && payloadInstanceId && targetInstanceId !== payloadInstanceId) throw Object.assign(new Error('Prefab target instanceId and payload instanceId must match'), { code: 'PREFAB_INSTANCE_ID_MISMATCH' });
      const instanceId = targetInstanceId || payloadInstanceId;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(instanceId)) throw Object.assign(new Error('prefab.instantiate requires a stable alphanumeric instanceId'), { code: 'INVALID_PREFAB_INSTANCE_ID' });
      if (scene.prefabInstances.some((entry) => entry.instanceId === instanceId)) throw Object.assign(new Error(`Prefab instance ${instanceId} already exists`), { code: 'DUPLICATE_PREFAB_INSTANCE_ID' });
      const parentId = command.payload.parentId ? String(command.payload.parentId) : null;
      const instance: LillyPrefabInstance = {
        schema: PREFAB_INSTANCE_SCHEMA,
        instanceId,
        prefabId: prefab.id,
        prefabPath,
        sourceHash: '',
        rootEntityId: `${instanceId}:${prefab.rootEntityId}`,
        parentId,
        overrides: deepClone((command.payload.config || {}) as LillyPrefabInstanceConfig),
        status: 'linked',
      };
      scene.prefabInstances.push(instance);
      materializePrefabInstance(project, scene, instance, true);
      inverse = { ...inverseBase, operation: 'entity.delete', target: { sceneId: scene.id, entityId: instance.rootEntityId }, payload: {} };
      break;
    }
    case 'prefab.update-instance': {
      if (!scene || !command.target.instanceId) throw new Error('prefab.update-instance requires a scene and instanceId');
      const instance = scene.prefabInstances.find((entry) => entry.instanceId === command.target.instanceId);
      if (!instance) throw Object.assign(new Error(`Prefab instance ${command.target.instanceId} was not found`), { code: 'PREFAB_INSTANCE_NOT_FOUND' });
      const snapshot = capturePrefabInstanceState(scene, instance.instanceId);
      if (Object.prototype.hasOwnProperty.call(command.payload, 'parentId')) instance.parentId = command.payload.parentId ? String(command.payload.parentId) : null;
      if (Object.prototype.hasOwnProperty.call(command.payload, 'config')) instance.overrides = deepClone((command.payload.config || {}) as LillyPrefabInstanceConfig);
      materializePrefabInstance(project, scene, instance, true);
      inverse = { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: instance.instanceId }, payload: { snapshot } };
      break;
    }
    case 'prefab.refresh': {
      if (!scene || !command.target.instanceId) throw new Error('prefab.refresh requires a scene and instanceId');
      const instance = scene.prefabInstances.find((entry) => entry.instanceId === command.target.instanceId);
      if (!instance) throw Object.assign(new Error(`Prefab instance ${command.target.instanceId} was not found`), { code: 'PREFAB_INSTANCE_NOT_FOUND' });
      const snapshot = capturePrefabInstanceState(scene, instance.instanceId);
      materializePrefabInstance(project, scene, instance, true);
      inverse = { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: instance.instanceId }, payload: { snapshot } };
      break;
    }
    case 'prefab.unpack': {
      if (!scene || !command.target.instanceId) throw new Error('prefab.unpack requires a scene and instanceId');
      const instance = scene.prefabInstances.find((entry) => entry.instanceId === command.target.instanceId);
      if (!instance) throw Object.assign(new Error(`Prefab instance ${command.target.instanceId} was not found`), { code: 'PREFAB_INSTANCE_NOT_FOUND' });
      const snapshot = capturePrefabInstanceState(scene, instance.instanceId);
      const tag = `instance:${instance.instanceId}`;
      for (const entity of scene.entities.filter((entry) => entry.tags.includes(tag))) {
        entity.tags = entity.tags.filter((entry) => entry !== tag && entry !== `prefab:${instance.prefabId}`);
      }
      scene.prefabInstances = scene.prefabInstances.filter((entry) => entry.instanceId !== instance.instanceId);
      inverse = { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: instance.instanceId }, payload: { snapshot } };
      break;
    }
    case 'prefab.restore-state': {
      if (!scene || !command.target.instanceId) throw new Error('prefab.restore-state requires a scene and instanceId');
      const current = scene.prefabInstances.find((entry) => entry.instanceId === command.target.instanceId);
      const currentSnapshot = current ? capturePrefabInstanceState(scene, current.instanceId) : { instance: null, entities: [] };
      const snapshot = deepClone(command.payload.snapshot as ReturnType<typeof capturePrefabInstanceState>);
      if (!snapshot || !Array.isArray(snapshot.entities)) throw Object.assign(new Error('prefab.restore-state requires a valid snapshot'), { code: 'INVALID_PREFAB_SNAPSHOT' });
      restorePrefabInstanceState(scene, command.target.instanceId, snapshot);
      inverse = { ...inverseBase, operation: 'prefab.restore-state', target: { sceneId: scene.id, instanceId: command.target.instanceId }, payload: { snapshot: currentSnapshot } };
      break;
    }
    case 'data-asset.upsert': {
      const rawAsset = command.payload.dataAsset as Partial<LillyDataAsset>;
      const dataAsset = normalizeDataAsset({ ...rawAsset, id: command.target.dataAssetId || rawAsset?.id });
      const assetIssues = validateDataAsset(dataAsset).filter((issue) => issue.severity === 'error');
      if (assetIssues.length) throw Object.assign(new Error(assetIssues.map((issue) => issue.message).join('; ')), { code: 'INVALID_DATA_ASSET', issues: assetIssues });
      const index = project.dataAssets.findIndex((entry) => entry.id === dataAsset.id);
      const previous = index >= 0 ? deepClone(project.dataAssets[index]) : null;
      if (index >= 0) project.dataAssets[index] = dataAsset;
      else project.dataAssets.push(dataAsset);
      project.dataAssets.sort((left, right) => left.name.localeCompare(right.name));
      inverse = previous
        ? { ...inverseBase, operation: 'data-asset.upsert', target: { dataAssetId: previous.id }, payload: { dataAsset: previous } }
        : { ...inverseBase, operation: 'data-asset.delete', target: { dataAssetId: dataAsset.id }, payload: {} };
      break;
    }
    case 'data-asset.delete': {
      const dataAssetId = String(command.target.dataAssetId || '');
      const index = project.dataAssets.findIndex((entry) => entry.id === dataAssetId);
      if (index < 0) throw Object.assign(new Error(`Data asset ${dataAssetId} was not found`), { code: 'DATA_ASSET_NOT_FOUND' });
      const referenced = project.scenes.some((entry) => entry.entities.some((entity) => entity.components.some((component) => component.type === 'DataReference' && component.data.assetId === dataAssetId)));
      if (referenced) throw Object.assign(new Error(`Data asset ${dataAssetId} is still referenced by a DataReference component`), { code: 'DATA_ASSET_IN_USE' });
      const previous = project.dataAssets.splice(index, 1)[0];
      inverse = { ...inverseBase, operation: 'data-asset.upsert', target: { dataAssetId: previous.id }, payload: { dataAsset: previous } };
      break;
    }
    case 'build-profile.upsert': {
      const rawProfile = command.payload.buildProfile as Partial<LillyBuildProfile>;
      const buildProfile = normalizeBuildProfile({ ...rawProfile, id: command.target.buildProfileId || rawProfile?.id });
      const profileIssues = validateBuildProfile(buildProfile, project).filter((issue) => issue.severity === 'error');
      if (profileIssues.length) throw Object.assign(new Error(profileIssues.map((issue) => issue.message).join('; ')), { code: 'INVALID_BUILD_PROFILE', issues: profileIssues });
      const index = project.buildProfiles.findIndex((entry) => entry.id === buildProfile.id);
      const previous = index >= 0 ? deepClone(project.buildProfiles[index]) : null;
      if (index >= 0) project.buildProfiles[index] = buildProfile;
      else project.buildProfiles.push(buildProfile);
      inverse = previous
        ? { ...inverseBase, operation: 'build-profile.upsert', target: { buildProfileId: previous.id }, payload: { buildProfile: previous } }
        : { ...inverseBase, operation: 'build-profile.delete', target: { buildProfileId: buildProfile.id }, payload: {} };
      break;
    }
    case 'build-profile.delete': {
      const buildProfileId = String(command.target.buildProfileId || '');
      const index = project.buildProfiles.findIndex((entry) => entry.id === buildProfileId);
      if (index < 0) throw Object.assign(new Error(`Build profile ${buildProfileId} was not found`), { code: 'BUILD_PROFILE_NOT_FOUND' });
      if (project.buildProfiles.length <= 1) throw Object.assign(new Error('A project must keep at least one build profile'), { code: 'LAST_BUILD_PROFILE_DELETE' });
      if (project.activeBuildProfileId === buildProfileId) throw Object.assign(new Error('Select another active build profile before deleting this profile'), { code: 'ACTIVE_BUILD_PROFILE_DELETE' });
      const previous = project.buildProfiles.splice(index, 1)[0];
      inverse = { ...inverseBase, operation: 'build-profile.upsert', target: { buildProfileId: previous.id }, payload: { buildProfile: previous } };
      break;
    }
    case 'project.set-active-build-profile': {
      const buildProfileId = String(command.target.buildProfileId || command.payload.buildProfileId || '');
      if (!project.buildProfiles.some((entry) => entry.id === buildProfileId)) throw Object.assign(new Error(`Build profile ${buildProfileId} was not found`), { code: 'BUILD_PROFILE_NOT_FOUND' });
      const previous = project.activeBuildProfileId;
      project.activeBuildProfileId = buildProfileId;
      inverse = { ...inverseBase, operation: 'project.set-active-build-profile', target: { buildProfileId: previous }, payload: { buildProfileId: previous } };
      break;
    }
    case 'input.replace': {
      const previous = deepClone(project.inputMap);
      const inputMap = deepClone(command.payload.inputMap as LillyInputBinding[]);
      if (!Array.isArray(inputMap) || inputMap.some((binding) => !binding?.action || !['button', 'axis2d'].includes(binding.kind) || !Array.isArray(binding.keys))) {
        throw Object.assign(new Error('input.replace requires a valid inputMap array'), { code: 'INVALID_INPUT_MAP' });
      }
      project.inputMap = inputMap;
      inverse = { ...inverseBase, operation: 'input.replace', payload: { inputMap: previous } };
      break;
    }
    case 'project.set-entry-scene': {
      const sceneId = String(command.payload.sceneId || command.target.sceneId || '');
      if (!project.scenes.some((entry) => entry.id === sceneId)) throw Object.assign(new Error(`Scene ${sceneId} was not found`), { code: 'SCENE_NOT_FOUND' });
      const previous = project.entryScene;
      project.entryScene = sceneId;
      inverse = { ...inverseBase, operation: 'project.set-entry-scene', target: { sceneId: previous }, payload: { sceneId: previous } };
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
      const rawRecipeInput = {
        ...deepClone((command.payload.recipe || {}) as LillyLevelRecipe),
        sceneId: scene.id,
      } as LillyLevelRecipe;
      const rawRecipe = {
        ...rawRecipeInput,
        gameplay: {
          ...rawRecipeInput.gameplay,
          encounterCount: rawRecipeInput.gameplay?.encounterCount ?? 0,
          enemyCount: rawRecipeInput.gameplay?.enemyCount ?? 0,
        },
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
      project.settings.runtimeProfile = 'expedition';
      const player = scene.entities.find((entity) => entity.tags.includes('player')) || null;
      const playerTransform = player ? getComponent(player, 'Transform') : null;
      if (playerTransform) playerTransform.data.position = deepClone(generated.design.spawn.position);
      ensurePlayerGameplay(project, scene, generated.recipe);
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
  const prompt = input.prompt || 'A winding neon ruin with readable rooms, two fair guardian encounters, glowing energy cores, checkpoints, landmarks, and a final exit beacon.';
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
      prefabInstances: [],
      entities: [
        { schema: ENTITY_SCHEMA, id: 'world', name: 'World', parentId: null, enabled: true, tags: ['root'], components: [] },
        { schema: ENTITY_SCHEMA, id: 'sun', name: 'Key Light', parentId: 'world', enabled: true, tags: ['lighting'], components: [transform({ x: 8, y: 14, z: 6 }), component('Light', { kind: 'directional', intensity: 3.4, color: '#dbeafe', castShadow: true })] },
        { schema: ENTITY_SCHEMA, id: 'player', name: 'Player', parentId: 'world', enabled: true, tags: ['player'], components: [transform(generated.design.spawn.position), component('MeshRenderer', { geometry: 'capsule', material: { color: '#38bdf8', roughness: 0.28, metalness: 0.35, emissive: '#075985', emissiveIntensity: 0.22 } }), component('RigidBody', { bodyType: 'dynamic', mass: 1, lockRotations: true }), component('Collider', { shape: 'capsule', size: { x: 0.9, y: 1.4, z: 0.9 } }), component('Health', { max: 4, current: 4, invulnerabilitySeconds: 0.55 }), component('Combatant', { team: 'player', damage: 1, range: 2.25, cooldownSeconds: 0.42, attackAction: 'Attack' }), component('Blueprint', { graphId: 'player-controller' })] },
        { schema: ENTITY_SCHEMA, id: 'camera', name: 'Follow Camera', parentId: 'world', enabled: true, tags: ['camera'], components: [transform({ x: generated.design.spawn.position.x + 7, y: 7, z: generated.design.spawn.position.z + 11 }), component('Camera', { primary: true, fov: 58 })] },
        { schema: ENTITY_SCHEMA, id: 'game-rules', name: 'Expedition Rules', parentId: 'world', enabled: true, tags: ['gameplay'], components: [component('Blueprint', { graphId }), component('UIAnchor', { anchor: 'top-left', text: recipe.objective === 'secure-and-exit' ? `Clear ${recipe.gameplay.encounterCount} encounters, then reach the exit` : `Collect ${pickupCount} energy cores, then reach the exit` })] },
        ...generated.entities,
      ],
    }],
    blueprints: [
      generatedObjectiveGraph(recipe, graphId),
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
    files: [],
    assets: [],
    dataAssets: [],
    buildProfiles: createDefaultBuildProfiles(sceneId),
    activeBuildProfileId: 'release',
    inputMap: [
      { action: 'Move', kind: 'axis2d', keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] },
      { action: 'Jump', kind: 'button', keys: ['Space'] },
      { action: 'Attack', kind: 'button', keys: ['Space', 'Enter'] },
      { action: 'Reset', kind: 'button', keys: ['KeyR'] },
    ],
    settings: { renderer: 'webgl2', fixedStepHz: 60, gravity: { x: 0, y: -9.81, z: 0 }, mobileMode: 'author-play', runtimeProfile: 'expedition' },
  };
}

export function createArenaProject(input: { id: string; name?: string; slug?: string; prompt?: string; seed?: string } = { id: 'arena' }): LillyProject {
  return createProceduralProject(input);
}

export function createBlankProject(input: { id: string; name?: string; slug?: string } = { id: 'blank' }): LillyProject {
  const sceneId = 'main';
  return {
    schema: PROJECT_SCHEMA,
    id: input.id,
    name: input.name || 'Untitled Lilly Game',
    slug: input.slug || 'untitled-lilly-game',
    engineVersion: ENGINE_VERSION,
    revision: 1,
    entryScene: sceneId,
    scenes: [{
      schema: SCENE_SCHEMA,
      id: sceneId,
      name: 'Main Scene',
      environment: { background: '#071018', ambientIntensity: 0.65, fog: null },
      entities: [{ schema: ENTITY_SCHEMA, id: 'world', name: 'World', parentId: null, enabled: true, tags: ['root'], components: [] }],
      blueprintGraphIds: [],
      prefabInstances: [],
    }],
    blueprints: [],
    levelRecipes: [],
    generatedLevels: [],
    files: [],
    assets: [],
    dataAssets: [],
    buildProfiles: createDefaultBuildProfiles(sceneId),
    activeBuildProfileId: 'release',
    inputMap: [],
    settings: { renderer: 'webgl2', fixedStepHz: 60, gravity: { x: 0, y: -9.81, z: 0 }, mobileMode: 'author-play', runtimeProfile: 'module-driven' },
  };
}

export const PROJECT_TEMPLATES: readonly LillyProjectTemplateDefinition[] = Object.freeze([
  {
    id: 'blank',
    name: 'Blank architecture',
    description: 'An empty module-driven scene for fully custom games and imported systems.',
    genre: 'Custom',
    runtimeProfile: 'module-driven',
    playable: false,
    tags: ['empty-scene', 'agent-ready', 'advanced'],
  },
  {
    id: 'third-person-explorer',
    name: 'Third-person explorer',
    description: 'An open 3D landscape with a component-driven controller, follow camera, landmarks, and a discovery mechanic.',
    genre: 'Exploration',
    runtimeProfile: 'module-driven',
    playable: true,
    tags: ['open-world', 'third-person', 'landmarks'],
  },
  {
    id: 'top-down-action',
    name: 'Top-down action',
    description: 'A readable action sandbox with an overhead camera, movement controller, targets, and a tested pulse mechanic.',
    genre: 'Action',
    runtimeProfile: 'module-driven',
    playable: true,
    tags: ['top-down', 'combat', 'systems'],
  },
  {
    id: 'expedition',
    name: 'Procedural expedition',
    description: 'The preserved seeded room-and-encounter generator with checkpoints, pickups, guardians, and exits.',
    genre: 'Expedition',
    runtimeProfile: 'expedition',
    playable: true,
    tags: ['procedural', 'rooms', 'legacy-compatible'],
  },
]);

function templateSourceFile(path: string, value: string | Record<string, unknown>): LillySourceFile {
  return normalizeSourceFile({
    path,
    content: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    enabled: true,
  });
}

function baseAuthoredProject(input: { id: string; name?: string; slug?: string }, scene: LillyScene, files: LillySourceFile[]): LillyProject {
  return {
    schema: PROJECT_SCHEMA,
    id: input.id,
    name: input.name || 'Untitled Lilly Game',
    slug: input.slug || 'untitled-lilly-game',
    engineVersion: ENGINE_VERSION,
    revision: 1,
    entryScene: scene.id,
    scenes: [scene],
    blueprints: [],
    levelRecipes: [],
    generatedLevels: [],
    files,
    assets: [],
    dataAssets: [],
    buildProfiles: createDefaultBuildProfiles(scene.id),
    activeBuildProfileId: 'release',
    inputMap: [
      { action: 'Move', kind: 'axis2d', keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] },
      { action: 'Reset', kind: 'button', keys: ['KeyR'] },
    ],
    settings: { renderer: 'webgl2', fixedStepHz: 60, gravity: { x: 0, y: -9.81, z: 0 }, mobileMode: 'author-play', runtimeProfile: 'module-driven' },
  };
}

export function createThirdPersonExplorerProject(input: { id: string; name?: string; slug?: string } = { id: 'third-person-explorer' }): LillyProject {
  const moduleId = 'explorer-discovery';
  const files = [
    templateSourceFile('modules/explorer/explorer.module.json', {
      schema: GAME_MODULE_SCHEMA,
      id: moduleId,
      name: 'Explorer Discovery',
      version: '1.0.0',
      description: 'Landmark discovery behavior for an open third-person world.',
      dependencies: [],
      capabilities: ['data.read', 'hud.write', 'particles.emit', 'audio.play'],
      systems: ['./discovery.system.ts'],
      mechanics: ['./discovery.mechanic.json'],
      prefabs: [],
      tests: ['./discovery.spec.json'],
    }),
    templateSourceFile('modules/explorer/discovery.mechanic.json', {
      schema: MECHANIC_SCHEMA,
      id: moduleId,
      moduleId,
      name: 'Landmark Discovery',
      description: 'Turns trigger collisions with landmarks into visible discoveries.',
      systems: ['./discovery.system.ts'],
      inputs: ['Move'],
      events: ['landmark.discovered'],
      components: [{ id: 'discovery-state', fields: [{ name: 'discoveries', type: 'number', defaultValue: 0 }] }],
    }),
    templateSourceFile('modules/explorer/discovery.system.ts', `import { defineSystem } from '@lilly/engine-runtime';

export default defineSystem({
  id: 'explorer-discovery',
  state: { discoveries: 0, discovered: [] as string[], target: 3, chimeFrequency: 720 },
  onStart(ctx) {
    const tuning = ctx.data.get('explorer-tuning') as { discoveryTarget?: number; chimeFrequency?: number } | null;
    ctx.state.target = Number(tuning?.discoveryTarget || 3);
    ctx.state.chimeFrequency = Number(tuning?.chimeFrequency || 720);
    ctx.hud.message('Explore the open field and discover ' + ctx.state.target + ' signal monuments.');
  },
  onCollision(ctx) {
    if (ctx.collision.phase !== 'start') return;
    const playerIsA = ctx.collision.entityA === ctx.world.playerId;
    const playerIsB = ctx.collision.entityB === ctx.world.playerId;
    const landmarkIsA = ctx.collision.tagsA.includes('landmark');
    const landmarkIsB = ctx.collision.tagsB.includes('landmark');
    if ((!playerIsA || !landmarkIsB) && (!playerIsB || !landmarkIsA)) return;
    const landmarkId = landmarkIsA ? ctx.collision.entityA : ctx.collision.entityB;
    if (ctx.state.discovered.includes(landmarkId)) return;
    ctx.state.discovered.push(landmarkId);
    ctx.state.discoveries = ctx.state.discovered.length;
    ctx.hud.message('Signal monument discovered: ' + ctx.state.discoveries + '/' + ctx.state.target, { status: 'Discovery', state: 'success' });
    ctx.particles.emit('landmark-discovery', landmarkId);
    ctx.audio.play('discovery-chime', { frequency: ctx.state.chimeFrequency + ctx.state.discoveries * 60, duration: 0.22 });
  },
});`),
    templateSourceFile('modules/explorer/discovery.spec.json', {
      schema: MECHANIC_TEST_SCHEMA,
      id: 'landmark-discovery-fires',
      moduleId,
      name: 'Landmark collision announces a discovery',
      seed: 11,
      steps: [
        {
          event: 'collision',
          payload: { type: 'trigger', phase: 'start', entityA: 'player', entityB: 'monument-a', tagsA: ['player'], tagsB: ['landmark'] },
          world: { playerId: 'player', dataAssets: [{ id: 'explorer-tuning', name: 'Explorer tuning', type: 'stats', tags: ['gameplay'], data: { discoveryTarget: 3, chimeFrequency: 720 } }], entities: [{ id: 'player', tags: ['player'] }, { id: 'monument-a', tags: ['landmark'] }] },
        },
        {
          event: 'collision',
          payload: { type: 'trigger', phase: 'start', entityA: 'player', entityB: 'monument-a', tagsA: ['player'], tagsB: ['landmark'] },
          world: { playerId: 'player', dataAssets: [{ id: 'explorer-tuning', name: 'Explorer tuning', type: 'stats', tags: ['gameplay'], data: { discoveryTarget: 3, chimeFrequency: 720 } }], entities: [{ id: 'player', tags: ['player'] }, { id: 'monument-a', tags: ['landmark'] }] },
        },
      ],
      assertions: [
        { path: 'systems.explorer-discovery.state.discoveries', operator: 'equals', value: 1 },
        { path: 'actions[0].type', operator: 'equals', value: 'hud.message' },
        { path: 'actions[1].type', operator: 'equals', value: 'particles.emit' },
      ],
    }),
  ];
  const landmark = (id: string, name: string, position: Vec3, color: string): LillyEntity => ({
    schema: ENTITY_SCHEMA,
    id,
    name,
    parentId: 'world',
    enabled: true,
    tags: ['landmark', 'discoverable'],
    components: [
      transform(position, { x: 1.4, y: 2.8, z: 1.4 }),
      component('MeshRenderer', { geometry: 'octahedron', material: { color, roughness: 0.22, metalness: 0.62, emissive: color, emissiveIntensity: 0.32 } }),
      component('Collider', { shape: 'sphere', size: { x: 3.2, y: 4, z: 3.2 }, sensor: true }),
      component('Animator', { state: 'spin', speed: 0.35, autoplay: true }),
    ],
  });
  const scene: LillyScene = {
    schema: SCENE_SCHEMA,
    id: 'open-field',
    name: 'Open Signal Field',
    environment: { background: '#071923', ambientIntensity: 0.72, fog: { color: '#102d38', near: 34, far: 92 } },
    blueprintGraphIds: [],
    prefabInstances: [],
    entities: [
      { schema: ENTITY_SCHEMA, id: 'world', name: 'Open World', parentId: null, enabled: true, tags: ['root'], components: [] },
      { schema: ENTITY_SCHEMA, id: 'sun', name: 'Sun', parentId: 'world', enabled: true, tags: ['lighting'], components: [transform({ x: 9, y: 18, z: 7 }), component('Light', { kind: 'directional', intensity: 3.2, color: '#d8f3ff', castShadow: true })] },
      { schema: ENTITY_SCHEMA, id: 'ground', name: 'Open Ground', parentId: 'world', enabled: true, tags: ['ground'], components: [transform({ x: 0, y: -0.15, z: 0 }, { x: 44, y: 0.3, z: 44 }), component('MeshRenderer', { geometry: 'box', material: { color: '#194b48', roughness: 0.92, metalness: 0.02 } }), component('Collider', { shape: 'box', size: { x: 44, y: 0.3, z: 44 } })] },
      { schema: ENTITY_SCHEMA, id: 'player', name: 'Explorer', parentId: 'world', enabled: true, tags: ['player'], components: [transform({ x: 0, y: 0.72, z: 8 }), component('MeshRenderer', { geometry: 'capsule', material: { color: '#67e8f9', roughness: 0.26, metalness: 0.38, emissive: '#0e7490', emissiveIntensity: 0.22 } }), component('RigidBody', { bodyType: 'dynamic', mass: 1, lockRotations: true }), component('Collider', { shape: 'capsule', size: { x: 0.9, y: 1.4, z: 0.9 } }), component('CharacterController', { moveAction: 'Move', speed: 6.2, rotateToMovement: true, collisionRadius: 0.44 })] },
      { schema: ENTITY_SCHEMA, id: 'camera', name: 'Explorer Camera', parentId: 'world', enabled: true, tags: ['camera'], components: [transform({ x: 7, y: 7, z: 19 }), component('Camera', { primary: true, fov: 58, followTargetTag: 'player', followOffset: { x: 6.5, y: 6.2, z: 8.5 }, lookAtHeight: 0.7, smoothing: 0.0004 })] },
      { schema: ENTITY_SCHEMA, id: 'game-rules', name: 'Discovery Objective', parentId: 'world', enabled: true, tags: ['gameplay'], components: [component('DataReference', { assetId: 'explorer-tuning', alias: 'tuning' }), component('UIAnchor', { anchor: 'top-left', text: 'Explore the open field and discover all three signal monuments.' })] },
      landmark('monument-a', 'Azure Signal', { x: -13, y: 2, z: -7 }, '#38bdf8'),
      landmark('monument-b', 'Violet Signal', { x: 14, y: 2, z: -10 }, '#a78bfa'),
      landmark('monument-c', 'Amber Signal', { x: 10, y: 2, z: 13 }, '#fbbf24'),
    ],
  };
  const project = baseAuthoredProject(input, scene, files);
  project.dataAssets = [normalizeDataAsset({ schema: DATA_ASSET_SCHEMA, id: 'explorer-tuning', name: 'Explorer tuning', type: 'stats', tags: ['gameplay', 'exploration'], data: { discoveryTarget: 3, moveSpeed: 6.2, chimeFrequency: 720 } })];
  return project;
}

export function createTopDownActionProject(input: { id: string; name?: string; slug?: string } = { id: 'top-down-action' }): LillyProject {
  const moduleId = 'pulse-action';
  const files = [
    templateSourceFile('modules/action/action.module.json', {
      schema: GAME_MODULE_SCHEMA,
      id: moduleId,
      name: 'Pulse Action',
      version: '1.0.0',
      description: 'A testable top-down pulse weapon authored as a sandboxed system.',
      dependencies: [],
      capabilities: ['input.read', 'data.read', 'entity.read', 'physics.raycast', 'particles.emit', 'audio.play', 'hud.write'],
      systems: ['./pulse.system.ts'],
      mechanics: ['./pulse.mechanic.json'],
      prefabs: [],
      tests: ['./pulse.spec.json'],
    }),
    templateSourceFile('modules/action/pulse.mechanic.json', {
      schema: MECHANIC_SCHEMA,
      id: moduleId,
      moduleId,
      name: 'Pulse Fire',
      description: 'Fires a forward raycast with visible and audible feedback.',
      systems: ['./pulse.system.ts'],
      inputs: ['Move', 'Fire'],
      events: ['pulse.fired'],
      components: [{ id: 'pulse-state', fields: [{ name: 'cooldown', type: 'number', defaultValue: 0 }] }],
    }),
    templateSourceFile('modules/action/pulse.system.ts', `import { defineSystem } from '@lilly/engine-runtime';

export default defineSystem({
  id: 'pulse-action',
  state: { cooldown: 0 },
  onStart(ctx) {
    ctx.hud.message('Move with WASD and fire a pulse with Space.');
  },
  onFixedUpdate(ctx) {
    const tuning = ctx.data.get('pulse-balance') as { cooldownSeconds?: number; range?: number; frequency?: number } | null;
    ctx.state.cooldown = Math.max(0, ctx.state.cooldown - ctx.delta);
    if (!ctx.input.button('Fire') || ctx.state.cooldown > 0) return;
    const player = ctx.entities.read(ctx.world.playerId) as { position?: { x: number; y: number; z: number } };
    const origin = player?.position || { x: 0, y: 0.7, z: 0 };
    ctx.physics.raycast(origin, { x: 0, y: 0, z: -1 }, Number(tuning?.range || 30));
    ctx.particles.emit('pulse-muzzle', ctx.world.playerId);
    ctx.audio.play('pulse-shot', { frequency: Number(tuning?.frequency || 560), duration: 0.1 });
    ctx.hud.message('Pulse fired', { status: 'Armed', state: 'success' });
    ctx.state.cooldown = Number(tuning?.cooldownSeconds || 0.28);
  },
});`),
    templateSourceFile('modules/action/pulse.spec.json', {
      schema: MECHANIC_TEST_SCHEMA,
      id: 'pulse-fires-on-input',
      moduleId,
      name: 'Fire input emits a raycast and starts cooldown',
      seed: 29,
      steps: [{ event: 'fixed-update', delta: 1 / 60, input: { buttons: { Fire: true }, axes: { Move: { x: 0, y: 0 } } }, world: { playerId: 'player', dataAssets: [{ id: 'pulse-balance', name: 'Pulse balance', type: 'stats', tags: ['gameplay'], data: { cooldownSeconds: 0.28, range: 30, frequency: 560 } }], entities: [{ id: 'player', tags: ['player'], position: { x: 0, y: 0.7, z: 4 } }] } }],
      assertions: [
        { path: 'actions[0].type', operator: 'equals', value: 'physics.raycast' },
        { path: 'actions[1].type', operator: 'equals', value: 'particles.emit' },
        { path: 'systems.pulse-action.state.cooldown', operator: 'equals', value: 0.28 },
      ],
    }),
  ];
  const target = (id: string, position: Vec3, color: string): LillyEntity => ({
    schema: ENTITY_SCHEMA,
    id,
    name: `Pulse Target ${id.slice(-1).toUpperCase()}`,
    parentId: 'world',
    enabled: true,
    tags: ['target', 'obstacle'],
    components: [transform(position, { x: 1.5, y: 2.4, z: 1.5 }), component('MeshRenderer', { geometry: 'cylinder', material: { color, roughness: 0.34, metalness: 0.42, emissive: color, emissiveIntensity: 0.18 } }), component('Collider', { shape: 'cylinder', size: { x: 1.5, y: 2.4, z: 1.5 } })],
  });
  const scene: LillyScene = {
    schema: SCENE_SCHEMA,
    id: 'action-floor',
    name: 'Pulse Training Floor',
    environment: { background: '#090d18', ambientIntensity: 0.58, fog: null },
    blueprintGraphIds: [],
    prefabInstances: [],
    entities: [
      { schema: ENTITY_SCHEMA, id: 'world', name: 'Action World', parentId: null, enabled: true, tags: ['root'], components: [] },
      { schema: ENTITY_SCHEMA, id: 'sun', name: 'Arena Light', parentId: 'world', enabled: true, tags: ['lighting'], components: [transform({ x: 5, y: 16, z: 7 }), component('Light', { kind: 'directional', intensity: 3.6, color: '#e0f2fe', castShadow: true })] },
      { schema: ENTITY_SCHEMA, id: 'ground', name: 'Action Floor', parentId: 'world', enabled: true, tags: ['ground'], components: [transform({ x: 0, y: -0.15, z: 0 }, { x: 30, y: 0.3, z: 30 }), component('MeshRenderer', { geometry: 'box', material: { color: '#18253a', roughness: 0.76, metalness: 0.16 } }), component('Collider', { shape: 'box', size: { x: 30, y: 0.3, z: 30 } })] },
      { schema: ENTITY_SCHEMA, id: 'player', name: 'Pulse Runner', parentId: 'world', enabled: true, tags: ['player'], components: [transform({ x: 0, y: 0.72, z: 8 }), component('MeshRenderer', { geometry: 'capsule', material: { color: '#f472b6', roughness: 0.24, metalness: 0.46, emissive: '#9d174d', emissiveIntensity: 0.26 } }), component('RigidBody', { bodyType: 'dynamic', mass: 1, lockRotations: true }), component('Collider', { shape: 'capsule', size: { x: 0.9, y: 1.4, z: 0.9 } }), component('CharacterController', { moveAction: 'Move', speed: 7.2, rotateToMovement: true, collisionRadius: 0.44 })] },
      { schema: ENTITY_SCHEMA, id: 'camera', name: 'Tactical Camera', parentId: 'world', enabled: true, tags: ['camera'], components: [transform({ x: 0, y: 22, z: 18 }), component('Camera', { primary: true, fov: 52, followTargetTag: 'player', followOffset: { x: 0, y: 21, z: 10 }, lookAtHeight: 0, smoothing: 0.001 })] },
      { schema: ENTITY_SCHEMA, id: 'game-rules', name: 'Pulse Objective', parentId: 'world', enabled: true, tags: ['gameplay'], components: [component('DataReference', { assetId: 'pulse-balance', alias: 'balance' }), component('UIAnchor', { anchor: 'top-left', text: 'Move with WASD and fire a pulse with Space.' })] },
      target('target-a', { x: -7, y: 1.2, z: -6 }, '#38bdf8'),
      target('target-b', { x: 0, y: 1.2, z: -10 }, '#fbbf24'),
      target('target-c', { x: 7, y: 1.2, z: -6 }, '#a78bfa'),
      { schema: ENTITY_SCHEMA, id: 'cover-left', name: 'Cover Left', parentId: 'world', enabled: true, tags: ['obstacle', 'cover'], components: [transform({ x: -5, y: 0.8, z: 3 }, { x: 4, y: 1.6, z: 1 }), component('MeshRenderer', { geometry: 'box', material: { color: '#334155', roughness: 0.7, metalness: 0.15 } }), component('Collider', { shape: 'box', size: { x: 4, y: 1.6, z: 1 } })] },
      { schema: ENTITY_SCHEMA, id: 'cover-right', name: 'Cover Right', parentId: 'world', enabled: true, tags: ['obstacle', 'cover'], components: [transform({ x: 5, y: 0.8, z: 1 }, { x: 4, y: 1.6, z: 1 }), component('MeshRenderer', { geometry: 'box', material: { color: '#334155', roughness: 0.7, metalness: 0.15 } }), component('Collider', { shape: 'box', size: { x: 4, y: 1.6, z: 1 } })] },
    ],
  };
  const project = baseAuthoredProject(input, scene, files);
  project.dataAssets = [normalizeDataAsset({ schema: DATA_ASSET_SCHEMA, id: 'pulse-balance', name: 'Pulse balance', type: 'stats', tags: ['gameplay', 'action'], data: { cooldownSeconds: 0.28, range: 30, frequency: 560 } })];
  project.inputMap.splice(1, 0, { action: 'Fire', kind: 'button', keys: ['Space', 'Enter'] });
  return project;
}

export function createProjectFromTemplate(input: {
  id: string;
  name?: string;
  slug?: string;
  prompt?: string;
  seed?: string;
  template?: LillyProjectTemplateId;
}): LillyProject {
  const template = input.template || 'expedition';
  if (template === 'blank') return createBlankProject(input);
  if (template === 'third-person-explorer') return createThirdPersonExplorerProject(input);
  if (template === 'top-down-action') return createTopDownActionProject(input);
  if (template === 'expedition') return createProceduralProject(input);
  throw Object.assign(new Error(`Unknown Lilly project template ${String(template)}`), { code: 'PROJECT_TEMPLATE_NOT_FOUND' });
}
