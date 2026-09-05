import type { AiRun, EditorPreview, LillyCommand, LillyProject, LillyProjectAsset, LillyProjectTemplateId, LillySourceFile, MechanicTestRun, ModuleCompileReport, Playtest, StudioBuild, StudioMetadata, StudioProjectResponse } from './types';

type ApiErrorPayload = { error?: { code?: string; message?: string; currentRevision?: number; issues?: unknown[] } };

export class StudioApiError extends Error {
  code: string;
  status: number;
  currentRevision?: number;
  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error?.message || `Game Studio request failed (${status})`);
    this.name = 'StudioApiError';
    this.status = status;
    this.code = payload.error?.code || 'GAME_STUDIO_REQUEST_FAILED';
    this.currentRevision = payload.error?.currentRevision;
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try { payload = await response.json(); } catch (_error) {}
    throw new StudioApiError(response.status, payload);
  }
  return response.json() as Promise<T>;
}

export const studioApi = {
  listModels: () => request<{ data: Array<{ id: string; name?: string }> }>('/api/models'),
  modelPreviewUrl: (projectId: string, runId: string) => `/api/game-studio/projects/${encodeURIComponent(projectId)}/ai-runs/${encodeURIComponent(runId)}/model.glb`,
  applyAiRun: (projectId: string, runId: string) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/ai-runs/${encodeURIComponent(runId)}/apply`, { method: 'POST', body: '{}' }),
  listProjects: () => request<{ projects: StudioMetadata[]; count: number }>('/api/game-studio/projects'),
  createProject: (input: { name: string; slug?: string; prompt?: string; seed?: string; template?: LillyProjectTemplateId; project?: unknown; importBundle?: unknown }) => request<StudioProjectResponse>('/api/game-studio/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (projectId: string) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}`),
  applyCommands: (projectId: string, baseRevision: number, commands: Partial<LillyCommand>[], source = 'editor') => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/commands`, { method: 'POST', body: JSON.stringify({ baseRevision, commands, source }) }),
  writeFiles: (projectId: string, baseRevision: number, files: Array<Pick<LillySourceFile, 'path' | 'content'> & Partial<Pick<LillySourceFile, 'enabled'>>>) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/files`, { method: 'PUT', body: JSON.stringify({ baseRevision, files }) }),
  deleteFiles: (projectId: string, baseRevision: number, paths: string[]) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/files`, { method: 'DELETE', body: JSON.stringify({ baseRevision, paths }) }),
  compileModules: (projectId: string, revision: number) => request<ModuleCompileReport>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/compile`, { method: 'POST', body: JSON.stringify({ revision }) }),
  runMechanicTests: (projectId: string, revision: number, testIds?: string[]) => request<MechanicTestRun>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/mechanic-tests`, { method: 'POST', body: JSON.stringify({ revision, testIds }) }),
  instantiatePrefab: (projectId: string, baseRevision: number, input: { sceneId: string; path: string; instanceId: string; parentId?: string | null; config?: Record<string, unknown> }) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/prefab-instances`, { method: 'POST', body: JSON.stringify({ baseRevision, ...input }) }),
  uploadAsset: (projectId: string, input: { file: Blob; filename: string; name: string; mimeType: string; metadata?: { upAxis?: 'Y' | 'Z'; unitsPerMeter?: number } }) => {
    const query = new URLSearchParams({
      filename: input.filename,
      name: input.name,
      mimeType: input.mimeType,
      upAxis: input.metadata?.upAxis || 'Y',
      unitsPerMeter: String(input.metadata?.unitsPerMeter || 1),
    });
    return request<{ asset: LillyProjectAsset; project: LillyProject }>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/assets?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: input.file });
  },
  assetContentUrl: (projectId: string, assetId: string, revision?: number) => `/api/game-studio/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/content${revision ? `?revision=${revision}` : ''}`,
  proposeAi: (projectId: string, baseRevision: number, prompt: string, options: { mode?: 'level' | 'edit' | 'asset'; seed?: string; difficulty?: number; model?: string; requireAi?: boolean } = {}) => request<AiRun>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/ai-runs`, { method: 'POST', body: JSON.stringify({ baseRevision, prompt, ...options }) }),
  playtest: (projectId: string) => request<Playtest>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/playtests`, { method: 'POST', body: '{}' }),
  editorPreview: (projectId: string, projectRevision: number, buildProfileId = 'development') => request<EditorPreview>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/editor-preview`, { method: 'POST', body: JSON.stringify({ projectRevision, buildProfileId }) }),
  build: (projectId: string, projectRevision: number, buildProfileId?: string) => request<StudioBuild>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/builds`, { method: 'POST', body: JSON.stringify({ projectRevision, buildProfileId }) }),
  publish: (buildId: string, publicHost?: string) => request<{ build: StudioBuild; previewPreservedUntilHttpsVerified: boolean }>(`/api/game-studio/builds/${encodeURIComponent(buildId)}/publish`, { method: 'POST', body: JSON.stringify({ publicHost }) }),
  rollback: (projectId: string, revision: number) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/rollback`, { method: 'POST', body: JSON.stringify({ revision }) }),
};
