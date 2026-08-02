export type Vec3 = { x: number; y: number; z: number };

type LillyComponent<T extends Record<string, unknown> = Record<string, unknown>> = {
  type: string;
  enabled?: boolean;
  data: T;
};

type LillyEntity = {
  id: string;
  enabled: boolean;
  tags: string[];
  components: LillyComponent[];
};

type LillyScene = { id: string; entities: LillyEntity[] };
type LillyEncounterSpec = {
  id: string;
  roomId: string;
  enemyIds: string[];
  gateIds: string[];
  checkpointId: string;
  checkpointPosition: Vec3;
};
type LillyGeneratedLevel = {
  recipeId: string;
  sceneId: string;
  checksum: string;
  rooms: Array<{ id: string; position: Vec3 }>;
  encounters: LillyEncounterSpec[];
  spawn: { position: Vec3 };
};
type LillyLevelRecipe = { id: string; layout: { roomSize: number } };

export type GameplayProject = {
  id: string;
  entryScene: string;
  scenes: LillyScene[];
  levelRecipes?: LillyLevelRecipe[];
  generatedLevels?: LillyGeneratedLevel[];
};

export const GAMEPLAY_SAVE_SCHEMA = 'LillyGameplaySave/v1' as const;

type EnemyPhase = 'idle' | 'chase' | 'windup' | 'recover' | 'dead';

export interface GameplayEnemyState {
  id: string;
  encounterId: string;
  position: Vec3;
  spawnPosition: Vec3;
  health: number;
  maxHealth: number;
  phase: EnemyPhase;
  phaseSeconds: number;
  moveSpeed: number;
  detectionRange: number;
  attackRange: number;
  windupSeconds: number;
  recoverSeconds: number;
  damage: number;
}

export interface GameplayEncounterState {
  id: string;
  roomId: string;
  enemyIds: string[];
  gateIds: string[];
  checkpointId: string;
  checkpointPosition: Vec3;
  active: boolean;
  cleared: boolean;
}

export interface GameplayState {
  tick: number;
  elapsedSeconds: number;
  player: {
    health: number;
    maxHealth: number;
    hitCooldownSeconds: number;
    invulnerabilitySeconds: number;
    attackCooldownSeconds: number;
    attackRange: number;
    attackDamage: number;
  };
  activeEncounterId: string | null;
  checkpoint: { id: string; position: Vec3 };
  encounters: GameplayEncounterState[];
  enemies: GameplayEnemyState[];
  gates: Record<string, boolean>;
}

export interface GameplayStepInput {
  playerPosition: Vec3;
  attackPressed?: boolean;
  canOccupy?: (position: Vec3, enemyId: string) => boolean;
}

export type GameplayEvent =
  | { type: 'encounter-started'; encounterId: string; gateIds: string[] }
  | { type: 'player-attacked'; targetId: string | null }
  | { type: 'enemy-damaged'; enemyId: string; health: number; damage: number }
  | { type: 'enemy-defeated'; enemyId: string; encounterId: string }
  | { type: 'player-damaged'; enemyId: string; health: number; damage: number }
  | { type: 'encounter-cleared'; encounterId: string; checkpointId: string; gateIds: string[] }
  | { type: 'checkpoint-activated'; checkpointId: string; position: Vec3 }
  | { type: 'player-respawned'; checkpointId: string; position: Vec3 };

export interface LillyGameplaySave {
  schema: typeof GAMEPLAY_SAVE_SCHEMA;
  projectId: string;
  levelChecksum: string | null;
  tick: number;
  elapsedSeconds: number;
  playerHealth: number;
  activeEncounterId: string | null;
  clearedEncounterIds: string[];
  checkpoint: { id: string; position: Vec3 };
  enemies: Array<{ id: string; health: number; position: Vec3 }>;
}

type HealthData = { max?: number; current?: number; invulnerabilitySeconds?: number };
type CombatantData = { damage?: number; range?: number; cooldownSeconds?: number };
type EnemyBrainData = {
  moveSpeed?: number;
  detectionRange?: number;
  attackRange?: number;
  windupSeconds?: number;
  recoverSeconds?: number;
};
type TransformData = { position?: Vec3 };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finite(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function component<T extends Record<string, unknown>>(entity: LillyEntity | null, type: string): LillyComponent<T> | null {
  return (entity?.components.find((entry) => entry.type === type) as LillyComponent<T> | undefined) || null;
}

function positionOf(entity: LillyEntity | null, fallback: Vec3): Vec3 {
  const value = component<TransformData>(entity, 'Transform')?.data.position;
  return value && [value.x, value.y, value.z].every(Number.isFinite) ? clone(value) : clone(fallback);
}

function distance2d(left: Vec3, right: Vec3) {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function findScene(project: GameplayProject): LillyScene {
  return project.scenes.find((entry) => entry.id === project.entryScene) || project.scenes[0];
}

function encounterContainsPlayer(encounter: LillyEncounterSpec, design: LillyGeneratedLevel, recipe: LillyLevelRecipe | null, playerPosition: Vec3) {
  const room = design.rooms.find((entry) => entry.id === encounter.roomId);
  if (!room) return false;
  const halfSize = Math.max(2.4, finite(recipe?.layout.roomSize, 8) / 2 - 0.55);
  return Math.abs(playerPosition.x - room.position.x) <= halfSize
    && Math.abs(playerPosition.z - room.position.z) <= halfSize;
}

export class GameplaySimulation {
  readonly projectId: string;
  readonly levelChecksum: string | null;
  private readonly design: LillyGeneratedLevel | null;
  private readonly recipe: LillyLevelRecipe | null;
  private readonly initialState: GameplayState;
  private state: GameplayState;
  private events: GameplayEvent[] = [];
  private playerAttackCooldown = 0.42;

  constructor(project: GameplayProject) {
    this.projectId = project.id;
    const scene = findScene(project);
    this.design = (project.generatedLevels || []).find((entry) => entry.sceneId === scene.id) || null;
    this.recipe = this.design
      ? (project.levelRecipes || []).find((entry) => entry.id === this.design!.recipeId) || null
      : null;
    this.levelChecksum = this.design?.checksum || null;
    const playerEntity = scene.entities.find((entity) => entity.enabled && entity.tags.includes('player')) || null;
    const playerHealth = component<HealthData>(playerEntity, 'Health')?.data || {};
    const playerCombat = component<CombatantData>(playerEntity, 'Combatant')?.data || {};
    const playerMaxHealth = Math.max(1, finite(playerHealth.max, 3));
    this.playerAttackCooldown = clamp(finite(playerCombat.cooldownSeconds, 0.42), 0.05, 60);
    const spawn = clone(this.design?.spawn.position || positionOf(playerEntity, { x: 0, y: 0.65, z: 0 }));
    const enemies = (this.design?.encounters || []).flatMap((encounter) => encounter.enemyIds.map((enemyId) => {
      const entity = scene.entities.find((candidate) => candidate.id === enemyId) || null;
      const health = component<HealthData>(entity, 'Health')?.data || {};
      const combat = component<CombatantData>(entity, 'Combatant')?.data || {};
      const brain = component<EnemyBrainData>(entity, 'EnemyBrain')?.data || {};
      const maxHealth = Math.max(1, finite(health.max, 2));
      const enemyPosition = positionOf(entity, spawn);
      return {
        id: enemyId,
        encounterId: encounter.id,
        position: enemyPosition,
        spawnPosition: clone(enemyPosition),
        health: clamp(finite(health.current, maxHealth), 0, maxHealth),
        maxHealth,
        phase: 'idle' as EnemyPhase,
        phaseSeconds: 0,
        moveSpeed: clamp(finite(brain.moveSpeed, 2), 0.1, 20),
        detectionRange: clamp(finite(brain.detectionRange, 10), 0.5, 100),
        attackRange: clamp(finite(brain.attackRange, combat.range || 1.25), 0.1, 100),
        windupSeconds: clamp(finite(brain.windupSeconds, 0.32), 0.05, 10),
        recoverSeconds: clamp(finite(brain.recoverSeconds, combat.cooldownSeconds || 0.7), 0.05, 10),
        damage: clamp(finite(combat.damage, 1), 0.1, 10000),
      } satisfies GameplayEnemyState;
    }));
    const encounters = (this.design?.encounters || []).map((encounter) => ({
      id: encounter.id,
      roomId: encounter.roomId,
      enemyIds: [...encounter.enemyIds],
      gateIds: [...encounter.gateIds],
      checkpointId: encounter.checkpointId,
      checkpointPosition: clone(encounter.checkpointPosition),
      active: false,
      cleared: false,
    }));
    this.initialState = {
      tick: 0,
      elapsedSeconds: 0,
      player: {
        health: clamp(finite(playerHealth.current, playerMaxHealth), 0, playerMaxHealth),
        maxHealth: playerMaxHealth,
        hitCooldownSeconds: 0,
        invulnerabilitySeconds: clamp(finite(playerHealth.invulnerabilitySeconds, 0.55), 0, 10),
        attackCooldownSeconds: 0,
        attackRange: clamp(finite(playerCombat.range, 2.25), 0.1, 100),
        attackDamage: clamp(finite(playerCombat.damage, 1), 0.1, 10000),
      },
      activeEncounterId: null,
      checkpoint: { id: 'spawn', position: spawn },
      encounters,
      enemies,
      gates: Object.fromEntries(encounters.flatMap((encounter) => encounter.gateIds.map((id) => [id, false]))),
    };
    this.state = clone(this.initialState);
  }

  getState() {
    return clone(this.state);
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return clone(events);
  }

  reset() {
    this.state = clone(this.initialState);
    this.events = [];
    return this.getState();
  }

  private encounterById(id: string | null) {
    return id ? this.state.encounters.find((entry) => entry.id === id) || null : null;
  }

  private enemyById(id: string) {
    return this.state.enemies.find((entry) => entry.id === id) || null;
  }

  private setEncounterGates(encounter: GameplayEncounterState, closed: boolean) {
    encounter.gateIds.forEach((id) => { this.state.gates[id] = closed; });
  }

  private activateEncounter(playerPosition: Vec3) {
    if (this.state.activeEncounterId || !this.design) return;
    const next = this.state.encounters.find((entry) => {
      if (entry.cleared) return false;
      const spec = this.design!.encounters.find((candidate) => candidate.id === entry.id);
      return Boolean(spec && encounterContainsPlayer(spec, this.design!, this.recipe, playerPosition));
    });
    if (!next) return;
    next.active = true;
    this.state.activeEncounterId = next.id;
    this.setEncounterGates(next, true);
    next.enemyIds.forEach((id) => {
      const enemy = this.enemyById(id);
      if (enemy && enemy.health > 0) enemy.phase = 'chase';
    });
    this.events.push({ type: 'encounter-started', encounterId: next.id, gateIds: [...next.gateIds] });
  }

  private clearEncounter(encounter: GameplayEncounterState) {
    encounter.active = false;
    encounter.cleared = true;
    this.state.activeEncounterId = null;
    this.setEncounterGates(encounter, false);
    this.state.checkpoint = { id: encounter.checkpointId, position: clone(encounter.checkpointPosition) };
    this.events.push({ type: 'encounter-cleared', encounterId: encounter.id, checkpointId: encounter.checkpointId, gateIds: [...encounter.gateIds] });
    this.events.push({ type: 'checkpoint-activated', checkpointId: encounter.checkpointId, position: clone(encounter.checkpointPosition) });
  }

  private checkEncounterClear(encounter: GameplayEncounterState | null) {
    if (!encounter || encounter.cleared) return;
    if (encounter.enemyIds.every((id) => (this.enemyById(id)?.health || 0) <= 0)) this.clearEncounter(encounter);
  }

  private playerAttack(playerPosition: Vec3) {
    if (this.state.player.attackCooldownSeconds > 0) return;
    this.state.player.attackCooldownSeconds = this.playerAttackCooldown;
    const encounter = this.encounterById(this.state.activeEncounterId);
    const target = encounter?.enemyIds
      .map((id) => this.enemyById(id))
      .filter((enemy): enemy is GameplayEnemyState => Boolean(enemy && enemy.health > 0))
      .map((enemy) => ({ enemy, distance: distance2d(enemy.position, playerPosition) }))
      .filter((entry) => entry.distance <= this.state.player.attackRange)
      .sort((left, right) => left.distance - right.distance || left.enemy.id.localeCompare(right.enemy.id))[0]?.enemy || null;
    this.events.push({ type: 'player-attacked', targetId: target?.id || null });
    if (!target) return;
    const damage = this.state.player.attackDamage;
    target.health = Math.max(0, target.health - damage);
    this.events.push({ type: 'enemy-damaged', enemyId: target.id, health: target.health, damage });
    if (target.health <= 0) {
      target.phase = 'dead';
      target.phaseSeconds = 0;
      this.events.push({ type: 'enemy-defeated', enemyId: target.id, encounterId: target.encounterId });
    }
    this.checkEncounterClear(encounter || null);
  }

  private damagePlayer(enemyId: string, damage: number) {
    if (this.state.player.hitCooldownSeconds > 0) return;
    this.state.player.health = Math.max(0, this.state.player.health - damage);
    this.state.player.hitCooldownSeconds = this.state.player.invulnerabilitySeconds;
    this.events.push({ type: 'player-damaged', enemyId, health: this.state.player.health, damage });
    if (this.state.player.health <= 0) this.respawn();
  }

  damagePlayerFromHazard(damage = 1) {
    if (this.state.player.health <= 0) return;
    this.damagePlayer('hazard', clamp(finite(damage, 1), 0.1, 10000));
  }

  private respawn() {
    const encounter = this.encounterById(this.state.activeEncounterId);
    if (encounter && !encounter.cleared) {
      encounter.active = false;
      this.setEncounterGates(encounter, false);
      encounter.enemyIds.forEach((id) => {
        const enemy = this.enemyById(id);
        if (!enemy) return;
        enemy.position = clone(enemy.spawnPosition);
        enemy.health = enemy.maxHealth;
        enemy.phase = 'idle';
        enemy.phaseSeconds = 0;
      });
    }
    this.state.activeEncounterId = null;
    this.state.player.health = this.state.player.maxHealth;
    this.state.player.hitCooldownSeconds = 0;
    this.state.player.attackCooldownSeconds = 0;
    this.events.push({ type: 'player-respawned', checkpointId: this.state.checkpoint.id, position: clone(this.state.checkpoint.position) });
  }

  private stepEnemies(deltaSeconds: number, playerPosition: Vec3, canOccupy?: GameplayStepInput['canOccupy']) {
    const encounter = this.encounterById(this.state.activeEncounterId);
    if (!encounter) return;
    for (const enemyId of encounter.enemyIds) {
      const enemy = this.enemyById(enemyId);
      if (!enemy || enemy.health <= 0 || this.state.player.health <= 0) continue;
      const distance = distance2d(enemy.position, playerPosition);
      if (enemy.phase === 'windup') {
        enemy.phaseSeconds = Math.max(0, enemy.phaseSeconds - deltaSeconds);
        if (enemy.phaseSeconds <= 0) {
          if (distance <= enemy.attackRange + 0.35) this.damagePlayer(enemy.id, enemy.damage);
          if (this.state.activeEncounterId !== encounter.id) return;
          enemy.phase = 'recover';
          enemy.phaseSeconds = enemy.recoverSeconds;
        }
        continue;
      }
      if (enemy.phase === 'recover') {
        enemy.phaseSeconds = Math.max(0, enemy.phaseSeconds - deltaSeconds);
        if (enemy.phaseSeconds <= 0) enemy.phase = 'chase';
        continue;
      }
      if (distance <= enemy.attackRange) {
        enemy.phase = 'windup';
        enemy.phaseSeconds = enemy.windupSeconds;
        continue;
      }
      if (distance > enemy.detectionRange || distance <= 0.001) continue;
      enemy.phase = 'chase';
      const amount = Math.min(distance, enemy.moveSpeed * deltaSeconds);
      const next = {
        x: enemy.position.x + ((playerPosition.x - enemy.position.x) / distance) * amount,
        y: enemy.position.y,
        z: enemy.position.z + ((playerPosition.z - enemy.position.z) / distance) * amount,
      };
      if (!canOccupy || canOccupy(next, enemy.id)) enemy.position = next;
    }
  }

  step(deltaSeconds: number, input: GameplayStepInput) {
    const delta = clamp(finite(deltaSeconds, 0), 0, 0.1);
    this.state.tick += 1;
    this.state.elapsedSeconds += delta;
    this.state.player.attackCooldownSeconds = Math.max(0, this.state.player.attackCooldownSeconds - delta);
    this.state.player.hitCooldownSeconds = Math.max(0, this.state.player.hitCooldownSeconds - delta);
    this.activateEncounter(input.playerPosition);
    if (input.attackPressed) this.playerAttack(input.playerPosition);
    this.stepEnemies(delta, input.playerPosition, input.canOccupy);
    return this.getState();
  }

  serialize(): LillyGameplaySave {
    return {
      schema: GAMEPLAY_SAVE_SCHEMA,
      projectId: this.projectId,
      levelChecksum: this.levelChecksum,
      tick: this.state.tick,
      elapsedSeconds: this.state.elapsedSeconds,
      playerHealth: this.state.player.health,
      activeEncounterId: this.state.activeEncounterId,
      clearedEncounterIds: this.state.encounters.filter((entry) => entry.cleared).map((entry) => entry.id),
      checkpoint: clone(this.state.checkpoint),
      enemies: this.state.enemies.map((enemy) => ({ id: enemy.id, health: enemy.health, position: clone(enemy.position) })),
    };
  }

  restore(save: LillyGameplaySave) {
    if (save?.schema !== GAMEPLAY_SAVE_SCHEMA || save.projectId !== this.projectId || save.levelChecksum !== this.levelChecksum) return false;
    this.reset();
    const cleared = new Set(save.clearedEncounterIds || []);
    this.state.encounters.forEach((encounter) => {
      encounter.cleared = cleared.has(encounter.id);
      encounter.active = save.activeEncounterId === encounter.id && !encounter.cleared;
      this.setEncounterGates(encounter, encounter.active);
    });
    this.state.activeEncounterId = this.encounterById(save.activeEncounterId)?.active ? save.activeEncounterId : null;
    this.state.tick = Math.max(0, Math.floor(finite(save.tick, 0)));
    this.state.elapsedSeconds = Math.max(0, finite(save.elapsedSeconds, 0));
    this.state.player.health = clamp(finite(save.playerHealth, this.state.player.maxHealth), 1, this.state.player.maxHealth);
    if (save.checkpoint?.id && save.checkpoint.position) this.state.checkpoint = clone(save.checkpoint);
    const savedEnemies = new Map((save.enemies || []).map((entry) => [entry.id, entry]));
    this.state.enemies.forEach((enemy) => {
      const saved = savedEnemies.get(enemy.id);
      const encounter = this.encounterById(enemy.encounterId);
      if (!saved) return;
      enemy.health = encounter?.cleared ? 0 : clamp(finite(saved.health, enemy.maxHealth), 0, enemy.maxHealth);
      enemy.position = clone(saved.position || enemy.spawnPosition);
      enemy.phase = enemy.health <= 0 ? 'dead' : (encounter?.active ? 'chase' : 'idle');
      enemy.phaseSeconds = 0;
    });
    this.events = [];
    return true;
  }
}

export function createGameplaySimulation(project: GameplayProject) {
  return new GameplaySimulation(project);
}
