import type { AiRun, LillyCommand, Playtest, StudioBuild, StudioMetadata, StudioProjectResponse } from './types';

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
  listProjects: () => request<{ projects: StudioMetadata[]; count: number }>('/api/game-studio/projects'),
  createProject: (input: { name: string; slug?: string; prompt?: string; seed?: string; project?: unknown; importBundle?: unknown }) => request<StudioProjectResponse>('/api/game-studio/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (projectId: string) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}`),
  applyCommands: (projectId: string, baseRevision: number, commands: Partial<LillyCommand>[], source = 'editor') => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/commands`, { method: 'POST', body: JSON.stringify({ baseRevision, commands, source }) }),
  proposeAi: (projectId: string, baseRevision: number, prompt: string, options: { mode?: 'level' | 'edit'; seed?: string; difficulty?: number } = {}) => request<AiRun>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/ai-runs`, { method: 'POST', body: JSON.stringify({ baseRevision, prompt, ...options }) }),
  playtest: (projectId: string) => request<Playtest>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/playtests`, { method: 'POST', body: '{}' }),
  build: (projectId: string, projectRevision: number) => request<StudioBuild>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/builds`, { method: 'POST', body: JSON.stringify({ projectRevision }) }),
  publish: (buildId: string, publicHost?: string) => request<{ build: StudioBuild; previewPreservedUntilHttpsVerified: boolean }>(`/api/game-studio/builds/${encodeURIComponent(buildId)}/publish`, { method: 'POST', body: JSON.stringify({ publicHost }) }),
  rollback: (projectId: string, revision: number) => request<StudioProjectResponse>(`/api/game-studio/projects/${encodeURIComponent(projectId)}/rollback`, { method: 'POST', body: JSON.stringify({ revision }) }),
};
