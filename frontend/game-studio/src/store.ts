import { create } from 'zustand';
import { studioApi, StudioApiError } from './api';
import type {
  AiRun,
  BottomTab,
  LillyCommand,
  LillyComponent,
  LillyComponentType,
  LillyEntity,
  PlayState,
  Playtest,
  StudioBuild,
  StudioConsoleItem,
  StudioMetadata,
  StudioProjectResponse,
  TransformMode,
} from './types';

type HistoryEntry = { forward: LillyCommand[]; inverse: LillyCommand[] };

type StudioState = {
  status: 'loading' | 'ready' | 'empty' | 'disconnected' | 'error';
  error: string;
  projects: StudioMetadata[];
  current: StudioProjectResponse | null;
  selectedEntityId: string | null;
  selectedGraphId: string | null;
  transformMode: TransformMode;
  playState: PlayState;
  stepToken: number;
  bottomTab: BottomTab;
  aiOpen: boolean;
  aiRun: AiRun | null;
  aiStatus: 'idle' | 'thinking' | 'ready' | 'applying' | 'error';
  saveStatus: 'saved' | 'saving' | 'conflict' | 'error';
  buildStatus: 'idle' | 'testing' | 'building' | 'publishing' | 'success' | 'error';
  latestPlaytest: Playtest | null;
  consoleItems: StudioConsoleItem[];
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  initialize(): Promise<void>;
  createProject(name: string, prompt?: string): Promise<void>;
  importProject(file: File): Promise<void>;
  openProject(id: string): Promise<void>;
  selectEntity(id: string | null): void;
  setSelectedGraph(id: string | null): void;
  setTransformMode(mode: TransformMode): void;
  setPlayState(state: PlayState): void;
  step(): void;
  setBottomTab(tab: BottomTab): void;
  setAiOpen(open: boolean): void;
  dispatch(commands: Partial<LillyCommand>[], source?: string, recordHistory?: boolean): Promise<boolean>;
  renameEntity(entityId: string, name: string): Promise<void>;
  setEntityEnabled(entityId: string, enabled: boolean): Promise<void>;
  setEntityLocked(entityId: string, locked: boolean): Promise<void>;
  reparentEntity(entityId: string, parentId: string | null): Promise<void>;
  setComponent(entityId: string, component: LillyComponent): Promise<void>;
  removeComponent(entityId: string, componentType: LillyComponentType): Promise<void>;
  addComponent(entityId: string, component: LillyComponent): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  proposeAi(prompt: string, options?: { mode?: 'level' | 'edit'; seed?: string; difficulty?: number }): Promise<void>;
  rejectAi(): void;
  applyAi(): Promise<void>;
  runPlaytest(): Promise<void>;
  build(): Promise<void>;
  publish(build: StudioBuild): Promise<void>;
  rollback(revision: number): Promise<void>;
  log(level: StudioConsoleItem['level'], message: string): void;
};

function consoleItem(level: StudioConsoleItem['level'], message: string): StudioConsoleItem {
  return { id: crypto.randomUUID(), level, message, timestamp: new Date().toISOString() };
}

function selectedSceneId(current: StudioProjectResponse | null) {
  return current?.project.entryScene || '';
}

export const useStudioStore = create<StudioState>((set, get) => ({
  status: 'loading',
  error: '',
  projects: [],
  current: null,
  selectedEntityId: null,
  selectedGraphId: null,
  transformMode: 'translate',
  playState: 'editing',
  stepToken: 0,
  bottomTab: 'content',
  aiOpen: false,
  aiRun: null,
  aiStatus: 'idle',
  saveStatus: 'saved',
  buildStatus: 'idle',
  latestPlaytest: null,
  consoleItems: [consoleItem('info', 'Lilly Engine editor initialized')],
  undoStack: [],
  redoStack: [],

  async initialize() {
    set({ status: 'loading', error: '' });
    try {
      const listing = await studioApi.listProjects();
      if (listing.projects.length === 0) {
        set({ status: 'empty', projects: [] });
        return;
      }
      const remembered = localStorage.getItem('lilly-game-studio:project');
      const selected = listing.projects.find((project) => project.id === remembered) || listing.projects[0];
      const current = await studioApi.getProject(selected.id);
      set({ status: 'ready', projects: listing.projects, current, selectedEntityId: current.project.scenes[0]?.entities.find((entity) => entity.tags.includes('player'))?.id || null, selectedGraphId: current.project.blueprints[0]?.id || null });
    } catch (error) {
      set({ status: error instanceof TypeError ? 'disconnected' : 'error', error: error instanceof Error ? error.message : 'Game Studio failed to load' });
    }
  },

  async createProject(name, prompt) {
    set({ status: 'loading', error: '' });
    try {
      const current = await studioApi.createProject({ name, ...(prompt ? { prompt } : {}) });
      const listing = await studioApi.listProjects();
      localStorage.setItem('lilly-game-studio:project', current.project.id);
      set({ status: 'ready', projects: listing.projects, current, selectedEntityId: 'player', selectedGraphId: current.project.blueprints[0]?.id || null, undoStack: [], redoStack: [] });
      get().log('success', `Created ${current.project.name} from a deterministic AI level recipe`);
    } catch (error) { set({ status: 'error', error: error instanceof Error ? error.message : 'Project creation failed' }); }
  },

  async importProject(file) {
    set({ status: 'loading', error: '' });
    try {
      const text = await file.text();
      let parsed: any = null;
      if (/\.json$/i.test(file.name) || /json/i.test(file.type)) parsed = JSON.parse(text);
      const project = parsed?.schema === 'LillyProject/v1' ? parsed : null;
      const candidateBundle = parsed?.metadata?.bundle || parsed?.bundle || (parsed?.entry && parsed?.files ? parsed : null);
      const importBundle = project ? null : (candidateBundle || {
        entry: 'index.html',
        files: [{ path: 'index.html', content: text }],
      });
      const current = await studioApi.createProject({
        name: String(project?.name || file.name.replace(/\.[^.]+$/, '') || 'Imported Game'),
        ...(project ? { project } : { importBundle }),
      });
      const listing = await studioApi.listProjects();
      localStorage.setItem('lilly-game-studio:project', current.project.id);
      set({ status: 'ready', projects: listing.projects, current, selectedEntityId: current.project.scenes[0]?.entities[0]?.id || null, selectedGraphId: current.project.blueprints[0]?.id || null, undoStack: [], redoStack: [] });
      get().log('success', project ? 'Imported LillyProject/v1 as a new revision history' : 'Archived compatible web game source; manual component mapping is required');
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : 'Game import failed' });
    }
  },

  async openProject(id) {
    set({ status: 'loading', error: '' });
    try {
      const current = await studioApi.getProject(id);
      localStorage.setItem('lilly-game-studio:project', id);
      set({ status: 'ready', current, selectedEntityId: current.project.scenes[0]?.entities[0]?.id || null, selectedGraphId: current.project.blueprints[0]?.id || null, undoStack: [], redoStack: [], playState: 'editing' });
    } catch (error) { set({ status: 'error', error: error instanceof Error ? error.message : 'Project failed to open' }); }
  },

  selectEntity: (id) => set({ selectedEntityId: id }),
  setSelectedGraph: (id) => set({ selectedGraphId: id }),
  setTransformMode: (mode) => set({ transformMode: mode }),
  setPlayState: (state) => set({ playState: state }),
  step: () => set((state) => ({ stepToken: state.stepToken + 1, playState: 'paused' })),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  setAiOpen: (open) => set({ aiOpen: open }),

  async dispatch(rawCommands, source = 'editor', recordHistory = true) {
    const current = get().current;
    if (!current || rawCommands.length === 0) return false;
    set({ saveStatus: 'saving' });
    try {
      const result = await studioApi.applyCommands(current.project.id, current.project.revision, rawCommands, source);
      const entry = result.commandBatch ? { forward: result.commandBatch.commands, inverse: result.commandBatch.inverses } : null;
      set((state) => ({
        current: result,
        saveStatus: 'saved',
        undoStack: recordHistory && entry ? [...state.undoStack, entry].slice(-80) : state.undoStack,
        redoStack: recordHistory ? [] : state.redoStack,
      }));
      return true;
    } catch (error) {
      const conflict = error instanceof StudioApiError && error.status === 409;
      set({ saveStatus: conflict ? 'conflict' : 'error' });
      get().log('error', conflict ? `Revision conflict — the project is now at r${error.currentRevision ?? '?'}` : (error instanceof Error ? error.message : 'Command failed'));
      if (conflict) await get().openProject(current.project.id);
      return false;
    }
  },

  async renameEntity(entityId, name) {
    await get().dispatch([{ operation: 'entity.rename', target: { sceneId: selectedSceneId(get().current), entityId }, payload: { name } }]);
  },
  async setEntityEnabled(entityId, enabled) {
    await get().dispatch([{ operation: 'entity.set-enabled', target: { sceneId: selectedSceneId(get().current), entityId }, payload: { enabled } }]);
  },
  async setEntityLocked(entityId, locked) {
    await get().dispatch([{ operation: 'entity.set-locked', target: { sceneId: selectedSceneId(get().current), entityId }, payload: { locked } }]);
  },
  async reparentEntity(entityId, parentId) {
    await get().dispatch([{ operation: 'entity.reparent', target: { sceneId: selectedSceneId(get().current), entityId }, payload: { parentId } }]);
  },
  async setComponent(entityId, component) {
    await get().dispatch([{ operation: 'component.set', target: { sceneId: selectedSceneId(get().current), entityId, componentType: component.type }, payload: { enabled: component.enabled, data: component.data } }]);
  },
  async removeComponent(entityId, componentType) {
    await get().dispatch([{ operation: 'component.remove', target: { sceneId: selectedSceneId(get().current), entityId, componentType }, payload: {} }]);
  },
  async addComponent(entityId, component) { await get().setComponent(entityId, component); },

  async undo() {
    const entry = get().undoStack.at(-1);
    if (!entry) return;
    const success = await get().dispatch(entry.inverse, 'undo', false);
    if (success) set((state) => ({ undoStack: state.undoStack.slice(0, -1), redoStack: [...state.redoStack, entry] }));
  },
  async redo() {
    const entry = get().redoStack.at(-1);
    if (!entry) return;
    const success = await get().dispatch(entry.forward, 'redo', false);
    if (success) set((state) => ({ redoStack: state.redoStack.slice(0, -1), undoStack: [...state.undoStack, entry] }));
  },

  async proposeAi(prompt, options = {}) {
    const current = get().current;
    if (!current) return;
    set({ aiStatus: 'thinking', aiRun: null });
    try {
      const aiRun = await studioApi.proposeAi(current.project.id, current.project.revision, prompt, options);
      set({ aiRun, aiStatus: 'ready' });
      const level = aiRun.preview.level;
      get().log('info', level
        ? `AI proposed ${level.name}: ${level.metrics.roomCount} rooms, ${level.metrics.encounterCount} encounters, ${level.metrics.enemyCount} guardians, seed ${level.seed}`
        : `AI proposed ${aiRun.commands.length} revision-safe command${aiRun.commands.length === 1 ? '' : 's'}`);
    } catch (error) { set({ aiStatus: 'error' }); get().log('error', error instanceof Error ? error.message : 'AI proposal failed'); }
  },
  rejectAi: () => set({ aiRun: null, aiStatus: 'idle' }),
  async applyAi() {
    const run = get().aiRun;
    if (!run) return;
    set({ aiStatus: 'applying' });
    const success = await get().dispatch(run.commands, `ai-run:${run.id}`);
    set({ aiRun: success ? null : run, aiStatus: success ? 'idle' : 'error' });
    if (success) {
      const design = get().current?.project.generatedLevels?.find((level) => level.sceneId === get().current?.project.entryScene);
      get().log('success', design
        ? `Generated level ${design.checksum} saved at revision ${get().current?.project.revision}`
        : `Applied AI command batch to revision ${get().current?.project.revision}`);
    }
  },

  async runPlaytest() {
    const current = get().current;
    if (!current) return;
    set({ buildStatus: 'testing', bottomTab: 'tests' });
    try {
      const latestPlaytest = await studioApi.playtest(current.project.id);
      set({ latestPlaytest, buildStatus: latestPlaytest.status === 'passed' ? 'success' : 'error' });
      get().log(latestPlaytest.status === 'passed' ? 'success' : 'error', `Playtest ${latestPlaytest.status}: ${latestPlaytest.tests.filter((test) => test.status === 'passed').length}/${latestPlaytest.tests.length} checks passed`);
    } catch (error) { set({ buildStatus: 'error' }); get().log('error', error instanceof Error ? error.message : 'Playtest failed'); }
  },
  async build() {
    const current = get().current;
    if (!current) return;
    set({ buildStatus: 'building', bottomTab: 'build' });
    try {
      const build = await studioApi.build(current.project.id, current.project.revision);
      const refreshed = await studioApi.getProject(current.project.id);
      set({ current: refreshed, buildStatus: 'success' });
      get().log('success', `Immutable build ${build.id.slice(0, 8)} created for r${build.projectRevision}`);
    } catch (error) { set({ buildStatus: 'error' }); get().log('error', error instanceof Error ? error.message : 'Build failed'); }
  },
  async publish(build) {
    set({ buildStatus: 'publishing', bottomTab: 'build' });
    try {
      const result = await studioApi.publish(build.id);
      const current = get().current;
      if (current) set({ current: await studioApi.getProject(current.project.id), buildStatus: 'success' });
      get().log('success', `Publish queued for ${result.build.publicUrl}; private preview remains active until HTTPS verifies`);
    } catch (error) { set({ buildStatus: 'error' }); get().log('error', error instanceof Error ? error.message : 'Publish failed'); }
  },
  async rollback(revision) {
    const current = get().current;
    if (!current) return;
    try {
      const result = await studioApi.rollback(current.project.id, revision);
      set({ current: result, undoStack: [], redoStack: [], saveStatus: 'saved' });
      get().log('warning', `Rolled back r${current.project.revision} to snapshot r${revision}; saved as r${result.project.revision}`);
    } catch (error) { get().log('error', error instanceof Error ? error.message : 'Rollback failed'); }
  },

  log(level, message) { set((state) => ({ consoleItems: [...state.consoleItems, consoleItem(level, message)].slice(-300) })); },
}));

export function currentScene(current: StudioProjectResponse | null) {
  return current?.project.scenes.find((scene) => scene.id === current.project.entryScene) || null;
}

export function currentEntity(current: StudioProjectResponse | null, entityId: string | null): LillyEntity | null {
  return currentScene(current)?.entities.find((entity) => entity.id === entityId) || null;
}
