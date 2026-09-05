import type {
  LillyBlueprint,
  LillyBlueprintNode,
  LillyBlueprintPin,
  LillyBuild,
  LillyBuildProfile,
  LillyCommand,
  LillyComponent,
  LillyComponentType,
  LillyEntity,
  LillyDataAsset,
  LillyPrefabInstance,
  LillyGeneratedLevel,
  LillyLevelRecipe,
  LillyProject,
  LillyProjectTemplateId,
  LillyProjectAsset,
  LillyScene,
  LillySourceFile,
  LillyAnimationControllerDefinition,
  LillyAssetMetadataDefinition,
  LillyMaterialDefinition,
  LillyTerrainDefinition,
  ValidationIssue,
  Vec3,
} from '../../../packages/lilly-engine/core/src';

export type {
  LillyBlueprint,
  LillyBlueprintNode,
  LillyBlueprintPin,
  LillyBuild,
  LillyBuildProfile,
  LillyCommand,
  LillyComponent,
  LillyComponentType,
  LillyEntity,
  LillyDataAsset,
  LillyPrefabInstance,
  LillyGeneratedLevel,
  LillyLevelRecipe,
  LillyProject,
  LillyProjectTemplateId,
  LillyProjectAsset,
  LillyScene,
  LillySourceFile,
  LillyAnimationControllerDefinition,
  LillyAssetMetadataDefinition,
  LillyMaterialDefinition,
  LillyTerrainDefinition,
  ValidationIssue,
  Vec3,
};

export type StudioMetadata = {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  revision: number;
  engineVersion: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioBuild = LillyBuild & {
  workspaceId: string;
  createdAt: string;
  publishedAt?: string | null;
  publicUrl?: string;
  managedApp?: { appId?: string | null; buildRunId?: string | null; status?: string } | null;
};

export type EditorPreview = {
  schema: 'LillyEditorPreview/v1';
  projectId: string;
  projectRevision: number;
  buildProfileId: string;
  buildProfile: LillyBuildProfile;
  moduleSourceHash: string;
  playerRuntimeHash: string;
  workspaceId: string;
  previewUrl: string;
  sandboxUrl: string;
  cached: boolean;
  tests: Array<{ name: string; status: 'passed' | 'failed'; details?: string }>;
  createdAt: string;
};

export type AiRun = {
  schema: 'LillyAiRun/v1';
  id: string;
  projectId: string;
  baseRevision: number;
  prompt: string;
  mode?: 'level' | 'edit' | 'asset' | 'environment';
  refinement?: { assetId: string; name: string; instances: number };
  generation?: { source: 'ai' | 'preset' | 'commands' | 'recipe'; requestedModel?: string | null; warning?: string | null };
  status: 'proposed' | 'applied' | 'rejected';
  commands: LillyCommand[];
  affected: Array<{ operation: string; sceneId: string | null; entityId: string | null; graphId: string | null; recipeId?: string | null }>;
  preview: {
    environment?: { name: string; models: number; instances: number; omitted: number; triangles: number; size: number[]; sizeBytes: number; sky: { color: string; ambient: number; sunColor: string; sunIntensity: number } };
    asset?: { name: string; parts: number; triangles: number; size: number[]; sizeBytes: number; format: string };
    revision: number;
    validation: { projectIssues: ValidationIssue[]; blueprintIssues: ValidationIssue[] };
    level?: {
      recipeId: string;
      name: string;
      theme: string;
      seed: string;
      objective: string;
      difficulty: number;
      checksum: string;
      metrics: LillyGeneratedLevel['metrics'];
    } | null;
  };
  createdAt: string;
};

export type StudioProjectResponse = {
  metadata: StudioMetadata;
  project: LillyProject;
  validation: {
    valid: boolean;
    projectIssues: ValidationIssue[];
    blueprintIssues: Array<ValidationIssue & { graphId?: string }>;
    moduleIssues: Array<{ code: string; message: string; path: string; severity: 'error' | 'warning'; line?: number; column?: number }>;
    worldIssues: Array<{ code: string; message: string; path: string; severity: 'error' | 'warning' }>;
  };
  moduleSummary: {
    schema: 'LillyModuleBundle/v1';
    sourceHash: string;
    loadOrder: string[];
    modules: Array<{ id: string; name: string; version: string; sourcePath: string; capabilities: string[] }>;
    systems: Array<{ moduleId: string; path: string; sourceHash: string }>;
    mechanics: Array<{ id: string; moduleId: string; name: string; sourcePath: string; inputs: string[]; events: string[] }>;
    prefabs: Array<{ id: string; moduleId: string; name: string; sourcePath: string; variants: Array<{ id: string; name: string }> }>;
    tests: Array<{ id: string; moduleId: string; name: string; sourcePath: string }>;
    materials: Array<LillyMaterialDefinition & { sourcePath: string }>;
    assets: Array<LillyAssetMetadataDefinition & { sourcePath: string }>;
    animations: Array<LillyAnimationControllerDefinition & { sourcePath: string }>;
    terrains: Array<LillyTerrainDefinition & { sourcePath: string }>;
  };
  builds: StudioBuild[];
  aiRuns: AiRun[];
  commandBatch?: {
    schema: 'LillyCommandBatch/v1';
    baseRevision: number;
    revision: number;
    commands: LillyCommand[];
    inverses: LillyCommand[];
  };
};

export type Playtest = {
  schema: 'LillyPlaytest/v1';
  id: string;
  status: 'passed' | 'failed';
  tests: Array<{ name: string; status: 'passed' | 'failed'; details?: string }>;
  fixedSteps: number;
  createdAt: string;
};

export type StudioConsoleItem = {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: string;
};

export type ModuleCompileReport = {
  schema: 'LillyModuleBundle/v1';
  projectId: string;
  projectRevision: number;
  sourceHash: string;
  valid: boolean;
  loadOrder: string[];
  modules: Array<{ id: string; name: string; version: string; sourcePath: string; capabilities: string[]; dependencies: string[] }>;
  systems: Array<{ moduleId: string; path: string; sourceHash: string }>;
  mechanics: Array<{ id: string; moduleId: string; name: string; sourcePath: string; inputs: string[]; events: string[] }>;
  prefabs: Array<{ id: string; moduleId: string; name: string; sourcePath: string; entityCount: number; variants: Array<{ id: string; name: string }> }>;
  tests: Array<{ id: string; moduleId: string; name: string; sourcePath: string; assertionCount: number }>;
  materials: Array<LillyMaterialDefinition & { sourcePath: string }>;
  assets: Array<LillyAssetMetadataDefinition & { sourcePath: string }>;
  animations: Array<LillyAnimationControllerDefinition & { sourcePath: string }>;
  terrains: Array<LillyTerrainDefinition & { sourcePath: string }>;
  worldIssues: Array<{ code: string; message: string; path: string; severity: 'error' | 'warning' }>;
  diagnostics: Array<{ code: string; message: string; path: string; severity: 'error' | 'warning'; line?: number; column?: number }>;
};

export type MechanicTestRun = {
  schema: 'LillyMechanicTestRun/v1';
  projectId: string;
  projectRevision: number;
  sourceHash: string;
  status: 'passed' | 'failed';
  passed: number;
  failed: number;
  tests: Array<{ id: string; name: string; moduleId: string; status: 'passed' | 'failed'; assertions: Array<{ path: string; operator: string; value?: unknown; actual?: unknown; passed: boolean }>; error?: { code: string; message: string } }>;
};

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type PlayState = 'editing' | 'playing' | 'paused';
export type BottomTab = 'content' | 'data' | 'blueprints' | 'typescript' | 'console' | 'tests' | 'build';
