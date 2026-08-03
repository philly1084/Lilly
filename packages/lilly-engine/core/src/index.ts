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

export const ENGINE_VERSION = '0.5.0';
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

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

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
  | 'MeshRenderer'
  | 'Light'
  | 'RigidBody'
  | 'Collider'
  | 'AudioSource'
  | 'Animator'
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
  tags?: string[];
  components?: Partial<Record<LillyComponentType, Record<string, unknown>>>;
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
  MeshRenderer: { defaults: { geometry: 'box', assetId: '', materialId: '', material: { color: '#8ea7c4', roughness: 0.65, metalness: 0.05 }, castShadow: true, receiveShadow: true }, validate: validateMeshRenderer },
  Light: { defaults: { kind: 'directional', color: '#fff4df', intensity: 2, castShadow: true }, validate: numericRangeValidator('intensity', 0, 100) },
  RigidBody: { defaults: { bodyType: 'dynamic', mass: 1, linearDamping: 0.1, angularDamping: 0.1, lockRotations: false }, validate: numericRangeValidator('mass', 0.0001, 100000) },
  Collider: { defaults: { shape: 'box', size: { x: 1, y: 1, z: 1 }, sensor: false, restitution: 0.1, friction: 0.7 }, validate: () => [] },
  AudioSource: { defaults: { assetId: '', volume: 0.8, loop: false, spatial: true, autoplay: false }, validate: numericRangeValidator('volume', 0, 1) },
  Animator: { defaults: { assetId: '', controllerId: '', state: '', clip: '', speed: 1, autoplay: true }, validate: validateAnimator },
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
    const invalidOverrideKey = Object.keys(rawOverride).find((key) => !['name', 'enabled', 'tags', 'components'].includes(key));
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
    entities[entityId] = override;
  }
  return {
    ...(variantId ? { variant: variantId } : {}),
    ...(value.position === undefined ? {} : { position: deepClone(value.position as Vec3) }),
    ...(Object.keys(entities).length === 0 ? {} : { entities }),
  };
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
        if (component.type === 'Terrain' && String(data.terrainId || '') && !resourceIds.terrain.has(String(data.terrainId))) issues.push({ code: 'TERRAIN_REFERENCE_MISSING', message: `Terrain component references missing terrain ${data.terrainId}`, path: `${path}.components[${componentIndex}].data.terrainId`, severity: 'error' });
      }
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
      inverse = previous
        ? { ...inverseBase, operation: 'file.upsert', target: { path: previous.path }, payload: { file: previous } }
        : { ...inverseBase, operation: 'file.delete', target: { path: file.path }, payload: {} };
      break;
    }
    case 'file.delete': {
      const filePath = normalizeSourcePath(String(command.target.path || ''));
      const index = project.files.findIndex((entry) => entry.path === filePath);
      if (index < 0) throw Object.assign(new Error(`Source file ${filePath} was not found`), { code: 'SOURCE_FILE_NOT_FOUND' });
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
      const sourceFile = project.files.find((entry) => entry.path === prefabPath && entry.kind === 'prefab');
      if (!sourceFile) throw Object.assign(new Error(`Prefab source ${prefabPath} was not found`), { code: 'PREFAB_NOT_FOUND' });
      let prefab: LillyPrefabDefinition;
      try { prefab = JSON.parse(sourceFile.content) as typeof prefab; }
      catch (_error) { throw Object.assign(new Error(`Prefab source ${prefabPath} is not valid JSON`), { code: 'INVALID_PREFAB' }); }
      try { assertSafeStructuredValue(prefab, 'prefab'); }
      catch (error) { throw Object.assign(new Error(`Prefab source ${prefabPath} is unsafe: ${(error as Error).message}`), { code: 'INVALID_PREFAB' }); }
      const prefabIssues = validatePrefabDefinition(prefab).filter((issue) => issue.severity === 'error');
      if (prefabIssues.length > 0) throw Object.assign(new Error(`Prefab source ${prefabPath} is invalid: ${prefabIssues[0].message}`), { code: prefabIssues[0].code, issues: prefabIssues });
      const requestedPrefabId = String(command.target.prefabId || command.payload.prefabId || '').trim();
      if (requestedPrefabId && requestedPrefabId !== prefab.id) throw Object.assign(new Error(`Prefab id ${requestedPrefabId} does not match source id ${prefab.id}`), { code: 'PREFAB_ID_MISMATCH' });
      const targetInstanceId = String(command.target.instanceId || '').trim();
      const payloadInstanceId = String(command.payload.instanceId || '').trim();
      if (targetInstanceId && payloadInstanceId && targetInstanceId !== payloadInstanceId) throw Object.assign(new Error('Prefab target instanceId and payload instanceId must match'), { code: 'PREFAB_INSTANCE_ID_MISMATCH' });
      const instanceId = targetInstanceId || payloadInstanceId;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(instanceId)) throw Object.assign(new Error('prefab.instantiate requires a stable alphanumeric instanceId'), { code: 'INVALID_PREFAB_INSTANCE_ID' });
      const instanceConfig = normalizePrefabInstanceConfig(command.payload.config, prefab);
      const idMap = new Map(prefab.entities.map((entry) => [entry.id, `${instanceId}:${entry.id}`]));
      const parentId = command.payload.parentId ? String(command.payload.parentId) : null;
      if (parentId && !scene.entities.some((entry) => entry.id === parentId)) throw Object.assign(new Error('Prefab parent entity does not exist'), { code: 'PARENT_MISSING' });
      const entities = prefab.entities.map((entry) => {
        const cloned = deepClone(entry);
        const override = instanceConfig.entities?.[entry.id];
        if (override?.name !== undefined) cloned.name = override.name;
        if (override?.enabled !== undefined) cloned.enabled = override.enabled;
        if (override?.tags !== undefined) cloned.tags = deepClone(override.tags);
        for (const [componentType, componentPatch] of Object.entries(override?.components || {})) {
          const component = cloned.components.find((candidate) => candidate.type === componentType) as LillyComponent | undefined;
          if (!component || !componentPatch) continue;
          component.data = mergeSafeRecords(component.data, componentPatch);
          const validationErrors = COMPONENT_DEFINITIONS[component.type].validate(component.data);
          if (validationErrors.length > 0) throw Object.assign(new Error(`Prefab override ${entry.id}.${component.type} is invalid: ${validationErrors[0]}`), { code: 'INVALID_PREFAB_COMPONENT_OVERRIDE' });
        }
        if (entry.id === prefab.rootEntityId && instanceConfig.position) {
          const transform = cloned.components.find((candidate) => candidate.type === 'Transform');
          if (!transform) throw Object.assign(new Error('Prefab config.position requires a Transform on the prefab root'), { code: 'PREFAB_ROOT_TRANSFORM_REQUIRED' });
          const authoredPosition = transform.data.position as Vec3;
          const translated = {
            x: authoredPosition.x + instanceConfig.position.x,
            y: authoredPosition.y + instanceConfig.position.y,
            z: authoredPosition.z + instanceConfig.position.z,
          };
          if (!isFiniteVec3(translated)) throw Object.assign(new Error('Prefab config.position produces a non-finite root position'), { code: 'INVALID_PREFAB_CONFIG' });
          transform.data.position = translated;
        }
        cloned.id = idMap.get(entry.id) as string;
        cloned.parentId = entry.id === prefab.rootEntityId ? parentId : (entry.parentId ? idMap.get(entry.parentId) || parentId : parentId);
        cloned.tags = [...new Set([...(cloned.tags || []), `prefab:${prefab.id || prefabPath}`, `instance:${instanceId}`])];
        return cloned;
      });
      if (entities.some((entry) => scene.entities.some((existing) => existing.id === entry.id))) throw Object.assign(new Error(`Prefab instance ${instanceId} already exists`), { code: 'DUPLICATE_ENTITY_ID' });
      scene.entities.push(...entities);
      const rootEntityId = idMap.get(prefab.rootEntityId) as string;
      inverse = { ...inverseBase, operation: 'entity.delete', target: { sceneId: scene.id, entityId: rootEntityId }, payload: {} };
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
    inputMap: [
      { action: 'Move', kind: 'axis2d', keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] },
      { action: 'Jump', kind: 'button', keys: ['Space'] },
      { action: 'Attack', kind: 'button', keys: ['Space', 'Enter'] },
      { action: 'Reset', kind: 'button', keys: ['KeyR'] },
    ],
    settings: { renderer: 'webgl2', fixedStepHz: 60, gravity: { x: 0, y: -9.81, z: 0 }, mobileMode: 'author-play' },
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
    }],
    blueprints: [],
    levelRecipes: [],
    generatedLevels: [],
    files: [],
    assets: [],
    inputMap: [],
    settings: { renderer: 'webgl2', fixedStepHz: 60, gravity: { x: 0, y: -9.81, z: 0 }, mobileMode: 'author-play' },
  };
}
