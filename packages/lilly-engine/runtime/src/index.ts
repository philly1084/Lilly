import type { LillyProject } from '../../core/src';
import { FixedStepClock, InputActionState, deepClone, getComponent, getScene } from '../../core/src';
import { compileBlueprint, BlueprintExecutor, type BlueprintCapabilityApi } from '../../blueprints/src';
import { LillyThreeRenderer } from '../../renderer-three/src';
import { RapierPhysicsAdapter } from '../../physics-rapier/src';

export type RuntimeState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

export interface RuntimeHooks {
  onState?: (state: RuntimeState) => void;
  onHud?: (message: string) => void;
  onError?: (error: Error) => void;
  onConsole?: (level: 'log' | 'warn' | 'error', values: unknown[]) => void;
}

export class LillyRuntime {
  state: RuntimeState = 'idle';
  project: LillyProject | null = null;
  readonly input = new InputActionState([]);
  private physics: RapierPhysicsAdapter | null = null;
  private clock = new FixedStepClock(60);
  private graphExecutors: BlueprintExecutor[] = [];
  private animationFrame = 0;

  constructor(readonly renderer: LillyThreeRenderer, private hooks: RuntimeHooks = {}) {}

  async load(projectInput: LillyProject) {
    this.setState('loading');
    try {
      this.project = deepClone(projectInput);
      this.clock = new FixedStepClock(this.project.settings.fixedStepHz);
      this.physics = await RapierPhysicsAdapter.create(this.project.settings.gravity);
      const scene = getScene(this.project);
      this.physics.loadScene(scene);
      await this.renderer.adapter.load(this.project);
      const capabilities: BlueprintCapabilityApi = {
        entity: {
          setEnabled: (id, enabled) => { const entity = scene.entities.find((entry) => entry.id === id); if (entity) entity.enabled = enabled; },
          move: (id, delta) => {
            const entity = scene.entities.find((entry) => entry.id === id);
            const transform = entity && getComponent(entity, 'Transform');
            const position = transform?.data.position as { x: number; y: number; z: number } | undefined;
            if (transform && position) {
              transform.data.position = { x: position.x + delta.x, y: position.y + delta.y, z: position.z + delta.z };
              this.renderer.adapter.syncTransform(id, transform.data);
            }
          },
          destroy: (id) => { scene.entities = scene.entities.filter((entry) => entry.id !== id); this.renderer.adapter.objects.get(id)?.removeFromParent(); },
        },
        physics: { force: (id, value) => this.physics?.applyForce(id, value), impulse: (id, value) => this.physics?.applyImpulse(id, value) },
        presentation: { hud: (message) => this.hooks.onHud?.(message), audio: () => {}, particles: () => {} },
        debug: { log: (...values) => this.hooks.onConsole?.('log', values) },
      };
      this.graphExecutors = this.project.blueprints.map((graph) => new BlueprintExecutor(compileBlueprint(graph), capabilities));
      this.graphExecutors.forEach((executor) => executor.emit('start'));
      this.setState('paused');
    } catch (error) {
      this.fail(error as Error);
      throw error;
    }
  }

  play() {
    if (!this.project || this.state === 'error') return;
    this.setState('playing');
    this.clock.reset(performance.now() / 1000);
    this.loop();
  }

  pause() { if (this.state === 'playing') this.setState('paused'); cancelAnimationFrame(this.animationFrame); }

  step() {
    if (!this.project || !this.physics) return;
    this.fixedStep(1 / this.project.settings.fixedStepHz);
    this.renderer.render(true);
  }

  stop() { cancelAnimationFrame(this.animationFrame); this.setState('stopped'); }

  private loop = () => {
    if (this.state !== 'playing') return;
    try {
      this.clock.advance(performance.now() / 1000, (delta) => this.fixedStep(delta));
      this.graphExecutors.forEach((executor) => executor.emit('update'));
      this.renderer.render(true);
      this.animationFrame = requestAnimationFrame(this.loop);
    } catch (error) { this.fail(error as Error); }
  };

  private fixedStep(delta: number) {
    this.graphExecutors.forEach((executor) => executor.emit('fixed-update', { delta }));
    const events = this.physics?.step(delta) || [];
    events.forEach((event) => this.graphExecutors.forEach((executor) => executor.emit(event.type, { ...event })));
    if (!this.project) return;
    const scene = getScene(this.project);
    scene.entities.forEach((entity) => {
      const transform = getComponent(entity, 'Transform');
      const physicsTransform = this.physics?.getTransform(entity.id);
      if (transform && physicsTransform) {
        transform.data.position = physicsTransform.position;
        this.renderer.adapter.syncTransform(entity.id, transform.data);
      }
    });
  }

  private setState(state: RuntimeState) { this.state = state; this.hooks.onState?.(state); }
  private fail(error: Error) { this.setState('error'); this.hooks.onError?.(error); this.hooks.onConsole?.('error', [error.message]); }
  dispose() { this.stop(); this.physics?.dispose(); this.renderer.dispose(); }
}

export class SaveStorage {
  constructor(private namespace = 'lilly-game') {}
  save(slot: string, value: unknown) { localStorage.setItem(`${this.namespace}:${slot}`, JSON.stringify(value)); }
  load<T>(slot: string): T | null { const value = localStorage.getItem(`${this.namespace}:${slot}`); return value ? JSON.parse(value) as T : null; }
  remove(slot: string) { localStorage.removeItem(`${this.namespace}:${slot}`); }
}

export const SCRIPT_SANDBOX_CAPABILITIES = Object.freeze([
  'clock.read',
  'random.read',
  'input.read',
  'entity.query',
  'entity.read',
  'entity.write',
  'entity.spawn',
  'entity.destroy',
  'physics.force',
  'physics.impulse',
  'physics.raycast',
  'events.emit',
  'hud.write',
  'audio.play',
  'particles.emit',
  'save.read',
  'save.write',
]);

export function createScriptSandboxPolicy() {
  return {
    iframeSandbox: 'allow-scripts',
    opaqueOrigin: true,
    parentMessaging: 'LillyModuleSandboxMessage/v1',
    capabilities: SCRIPT_SANDBOX_CAPABILITIES,
    denied: ['dom', 'cookies', 'credentials', 'filesystem', 'network', 'parent-window'],
    isolation: ['opaque-origin-iframe', 'disposable-worker', 'content-security-policy'],
    executionBudgetMs: 200,
  };
}
