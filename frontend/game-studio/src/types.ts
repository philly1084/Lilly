import type {
  LillyBlueprint,
  LillyBlueprintNode,
  LillyBlueprintPin,
  LillyBuild,
  LillyCommand,
  LillyComponent,
  LillyComponentType,
  LillyEntity,
  LillyProject,
  LillyScene,
  ValidationIssue,
  Vec3,
} from '../../../packages/lilly-engine/core/src';

export type {
  LillyBlueprint,
  LillyBlueprintNode,
  LillyBlueprintPin,
  LillyBuild,
  LillyCommand,
  LillyComponent,
  LillyComponentType,
  LillyEntity,
  LillyProject,
  LillyScene,
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

export type AiRun = {
  schema: 'LillyAiRun/v1';
  id: string;
  projectId: string;
  baseRevision: number;
  prompt: string;
  status: 'proposed' | 'applied' | 'rejected';
  commands: LillyCommand[];
  affected: Array<{ operation: string; sceneId: string | null; entityId: string | null; graphId: string | null }>;
  preview: { revision: number; validation: { projectIssues: ValidationIssue[]; blueprintIssues: ValidationIssue[] } };
  createdAt: string;
};

export type StudioProjectResponse = {
  metadata: StudioMetadata;
  project: LillyProject;
  validation: {
    valid: boolean;
    projectIssues: ValidationIssue[];
    blueprintIssues: Array<ValidationIssue & { graphId?: string }>;
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

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type PlayState = 'editing' | 'playing' | 'paused';
export type BottomTab = 'content' | 'blueprints' | 'typescript' | 'console' | 'tests' | 'build';
