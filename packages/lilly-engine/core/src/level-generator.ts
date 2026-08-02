import type {
  LillyComponent,
  LillyEntity,
  LillyEnvironment,
  Vec3,
} from './index';

export const LEVEL_RECIPE_SCHEMA = 'LillyLevelRecipe/v1' as const;
export const GENERATED_LEVEL_SCHEMA = 'LillyGeneratedLevel/v1' as const;
export const ENCOUNTER_SCHEMA = 'LillyEncounterSpec/v1' as const;

export type LillyLevelTheme =
  | 'neon-ruins'
  | 'verdant-temple'
  | 'ember-foundry'
  | 'frost-vault';

export type LillyLevelObjective = 'collect-and-exit' | 'reach-exit' | 'secure-and-exit';

export interface LillyLevelRecipe {
  schema: typeof LEVEL_RECIPE_SCHEMA;
  id: string;
  sceneId: string;
  name: string;
  prompt: string;
  seed: string;
  theme: LillyLevelTheme;
  objective: LillyLevelObjective;
  layout: {
    roomCount: number;
    roomSize: number;
    roomSpacing: number;
    pathWidth: number;
    verticality: number;
  };
  gameplay: {
    difficulty: number;
    pickupCount: number;
    hazardCount: number;
    encounterCount: number;
    enemyCount: number;
  };
}

export interface LillyGeneratedRoom {
  id: string;
  grid: { x: number; z: number };
  position: Vec3;
  kind: 'spawn' | 'traversal' | 'challenge' | 'reward' | 'goal';
}

export interface LillyGeneratedConnection {
  id: string;
  fromRoomId: string;
  toRoomId: string;
}

export interface LillyEncounterSpec {
  schema: typeof ENCOUNTER_SCHEMA;
  id: string;
  kind: 'room-combat-clear';
  roomId: string;
  enemyIds: string[];
  gateIds: string[];
  checkpointId: string;
  checkpointPosition: Vec3;
}

export interface LillyGeneratedLevel {
  schema: typeof GENERATED_LEVEL_SCHEMA;
  recipeId: string;
  sceneId: string;
  seed: string;
  seedHash: string;
  checksum: string;
  theme: LillyLevelTheme;
  objective: LillyLevelObjective;
  rooms: LillyGeneratedRoom[];
  connections: LillyGeneratedConnection[];
  encounters: LillyEncounterSpec[];
  spawn: { roomId: string; position: Vec3 };
  goal: { roomId: string; position: Vec3 };
  bounds: { min: Vec3; max: Vec3 };
  metrics: {
    roomCount: number;
    pathCount: number;
    pickupCount: number;
    hazardCount: number;
    landmarkCount: number;
    encounterCount: number;
    enemyCount: number;
    checkpointCount: number;
  };
}

export interface GeneratedLevelResult {
  recipe: LillyLevelRecipe;
  design: LillyGeneratedLevel;
  environment: LillyEnvironment;
  entities: LillyEntity[];
}

export interface LevelValidationIssue {
  code: string;
  message: string;
  path: string;
  severity: 'error' | 'warning';
}

type ThemePalette = {
  background: string;
  fog: string;
  floor: string;
  corridor: string;
  wall: string;
  accent: string;
  pickup: string;
  hazard: string;
  landmark: string;
  enemy: string;
  gate: string;
  checkpoint: string;
};

const ENTITY_SCHEMA = 'LillyEntity/v1' as const;

const THEME_PALETTES: Record<LillyLevelTheme, ThemePalette> = {
  'neon-ruins': {
    background: '#06111a',
    fog: '#07131d',
    floor: '#152531',
    corridor: '#203846',
    wall: '#263b48',
    accent: '#38bdf8',
    pickup: '#c084fc',
    hazard: '#fb7185',
    landmark: '#fbbf24',
    enemy: '#f43f5e',
    gate: '#38bdf8',
    checkpoint: '#34d399',
  },
  'verdant-temple': {
    background: '#07140f',
    fog: '#0d1d15',
    floor: '#20372c',
    corridor: '#315341',
    wall: '#3b5246',
    accent: '#6ee7b7',
    pickup: '#fde68a',
    hazard: '#f97316',
    landmark: '#a7f3d0',
    enemy: '#fb7185',
    gate: '#6ee7b7',
    checkpoint: '#fde68a',
  },
  'ember-foundry': {
    background: '#170a08',
    fog: '#24100c',
    floor: '#37211f',
    corridor: '#51302a',
    wall: '#5b3931',
    accent: '#fb923c',
    pickup: '#facc15',
    hazard: '#ef4444',
    landmark: '#fdba74',
    enemy: '#f43f5e',
    gate: '#fb923c',
    checkpoint: '#facc15',
  },
  'frost-vault': {
    background: '#07121d',
    fog: '#0c1c2b',
    floor: '#203447',
    corridor: '#2d4d67',
    wall: '#3d5c73',
    accent: '#7dd3fc',
    pickup: '#e0f2fe',
    hazard: '#818cf8',
    landmark: '#bae6fd',
    enemy: '#a78bfa',
    gate: '#7dd3fc',
    checkpoint: '#67e8f9',
  },
};

const DIRECTIONS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isFiniteVector(value: unknown): value is Vec3 {
  if (!value || typeof value !== 'object') return false;
  const vector = value as Vec3;
  return [vector.x, vector.y, vector.z].every(Number.isFinite);
}

export function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createRandom(seed: string) {
  let state = Number.parseInt(stableHash(seed), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function slug(value: string) {
  return String(value || 'level')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44) || 'level';
}

function component(type: LillyComponent['type'], data: Record<string, unknown>): LillyComponent {
  return { type, enabled: true, data };
}

function transform(position: Vec3, scale: Vec3 = { x: 1, y: 1, z: 1 }): LillyComponent {
  return component('Transform', {
    position,
    rotation: { x: 0, y: 0, z: 0 },
    scale,
  });
}

function entity(input: {
  id: string;
  name: string;
  parentId: string | null;
  tags: string[];
  components: LillyComponent[];
  locked?: boolean;
}): LillyEntity {
  return {
    schema: ENTITY_SCHEMA,
    id: input.id,
    name: input.name,
    parentId: input.parentId,
    enabled: true,
    locked: input.locked,
    tags: input.tags,
    components: input.components,
  };
}

function mesh(color: string, geometry = 'box', material: Record<string, unknown> = {}) {
  return component('MeshRenderer', {
    geometry,
    material: {
      color,
      roughness: 0.66,
      metalness: 0.08,
      ...material,
    },
    castShadow: true,
    receiveShadow: true,
  });
}

function boxCollider(size: Vec3, sensor = false) {
  return component('Collider', {
    shape: 'box',
    size,
    sensor,
    restitution: 0.05,
    friction: 0.82,
  });
}

function normalizeTheme(value: unknown): LillyLevelTheme {
  const candidate = String(value || '').toLowerCase() as LillyLevelTheme;
  return Object.prototype.hasOwnProperty.call(THEME_PALETTES, candidate) ? candidate : 'neon-ruins';
}

export function normalizeLevelRecipe(input: Partial<LillyLevelRecipe> & { id?: string; sceneId?: string } = {}): LillyLevelRecipe {
  const theme = normalizeTheme(input.theme);
  const difficulty = clamp(Math.round(finiteNumber(input.gameplay?.difficulty, 2)), 1, 5);
  const roomSize = clamp(finiteNumber(input.layout?.roomSize, 8), 6, 14);
  const roomSpacing = clamp(finiteNumber(input.layout?.roomSpacing, roomSize + 4), roomSize + 2, 26);
  const recipeId = slug(String(input.id || 'main-level'));
  const encounterCount = clamp(Math.round(finiteNumber(input.gameplay?.encounterCount, 0)), 0, 4);
  const enemyCount = encounterCount === 0
    ? 0
    : clamp(Math.round(finiteNumber(input.gameplay?.enemyCount, encounterCount)), encounterCount, 4);
  return {
    schema: LEVEL_RECIPE_SCHEMA,
    id: recipeId,
    sceneId: String(input.sceneId || 'arena'),
    name: String(input.name || 'Generated Expedition').trim().slice(0, 80) || 'Generated Expedition',
    prompt: String(input.prompt || '').trim().slice(0, 2000),
    seed: String(input.seed || `${recipeId}-lilly`).trim().slice(0, 120) || `${recipeId}-lilly`,
    theme,
    objective: input.objective === 'reach-exit'
      ? 'reach-exit'
      : input.objective === 'secure-and-exit'
        ? 'secure-and-exit'
        : 'collect-and-exit',
    layout: {
      roomCount: clamp(Math.round(finiteNumber(input.layout?.roomCount, 7)), 3, 16),
      roomSize,
      roomSpacing,
      pathWidth: clamp(finiteNumber(input.layout?.pathWidth, 3.2), 2.4, Math.max(2.4, roomSize - 2)),
      verticality: clamp(finiteNumber(input.layout?.verticality, 0.35), 0, 1),
    },
    gameplay: {
      difficulty,
      pickupCount: clamp(Math.round(finiteNumber(input.gameplay?.pickupCount, 4 + difficulty)), 1, 20),
      hazardCount: clamp(Math.round(finiteNumber(input.gameplay?.hazardCount, difficulty * 2)), 0, 30),
      encounterCount,
      enemyCount,
    },
  };
}

function explicitCount(prompt: string, nouns: string) {
  const numberWords: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const match = prompt.match(new RegExp(`\\b(\\d{1,2}|${Object.keys(numberWords).join('|')})\\b(?:\\s+[a-z-]+){0,2}\\s+(?:${nouns})\\b`, 'i'));
  if (!match) return null;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : numberWords[match[1].toLowerCase()] || null;
}

export function createLevelRecipeFromPrompt(input: {
  projectId: string;
  sceneId: string;
  prompt: string;
  seed?: string;
  previous?: LillyLevelRecipe | null;
}): LillyLevelRecipe {
  const prompt = String(input.prompt || '').trim();
  const normalized = prompt.toLowerCase();
  const previous = input.previous || null;
  let theme: LillyLevelTheme = previous?.theme || 'neon-ruins';
  if (/forest|jungle|garden|verdant|moss|temple|nature/.test(normalized)) theme = 'verdant-temple';
  else if (/lava|fire|ember|forge|foundry|volcan/.test(normalized)) theme = 'ember-foundry';
  else if (/ice|snow|frost|frozen|glacier|winter/.test(normalized)) theme = 'frost-vault';
  else if (/neon|cyber|space|sky|future|ruin|city/.test(normalized)) theme = 'neon-ruins';

  let difficulty = previous?.gameplay.difficulty || 2;
  if (/relax|gentle|easy|beginner|calm/.test(normalized)) difficulty = 1;
  if (/medium|balanced/.test(normalized)) difficulty = 3;
  if (/hard|dangerous|intense|challenging/.test(normalized)) difficulty = 4;
  if (/brutal|extreme|nightmare/.test(normalized)) difficulty = 5;

  let roomCount = previous?.layout.roomCount || 7;
  if (/tiny|short|compact|small/.test(normalized)) roomCount = 5;
  if (/large|long|sprawling|epic|labyrinth/.test(normalized)) roomCount = 10;
  const requestedRooms = explicitCount(normalized, 'rooms?|areas?|chambers?');
  if (requestedRooms != null) roomCount = requestedRooms;

  const requestedPickups = explicitCount(normalized, 'pickups?|shards?|crystals?|cores?|relics?');
  const requestedHazards = explicitCount(normalized, 'hazards?|traps?|obstacles?');
  const requestedEncounters = explicitCount(normalized, 'encounters?|ambushes?|battles?|fights?|arenas?');
  const requestedEnemies = explicitCount(normalized, 'enemies|guards?|guardians?(?!\\s+(?:encounters?|rooms?|battles?))|drones?|monsters?|creatures?');
  const peaceful = /no (?:enemies|combat|fighting)|peaceful|nonviolent/.test(normalized);
  const combatRequested = !peaceful && /enemy|enemies|guard|guardian|combat|fight|battle|ambush|attack|monster|drone/.test(normalized);
  let encounterCount = peaceful
    ? 0
    : requestedEncounters ?? (combatRequested ? Math.min(2, Math.max(1, Math.floor(roomCount / 4))) : (previous?.gameplay.encounterCount || 0));
  encounterCount = clamp(Math.round(encounterCount), 0, Math.min(4, Math.max(0, roomCount - 2)));
  const enemyCount = encounterCount === 0
    ? 0
    : clamp(Math.round(requestedEnemies ?? previous?.gameplay.enemyCount ?? (encounterCount + (difficulty >= 4 ? 1 : 0))), encounterCount, 4);
  const objective: LillyLevelObjective = encounterCount > 0
    ? 'secure-and-exit'
    : /race|escape|reach (?:the )?(?:end|exit|goal)/.test(normalized) && !/collect|pickup|shard|crystal|relic/.test(normalized)
      ? 'reach-exit'
      : 'collect-and-exit';
  const seed = String(input.seed || stableHash(`${input.projectId}:${prompt || 'surprise-me'}`));
  const themeLabel = {
    'neon-ruins': 'Neon Ruins',
    'verdant-temple': 'Verdant Temple',
    'ember-foundry': 'Ember Foundry',
    'frost-vault': 'Frost Vault',
  }[theme];

  return normalizeLevelRecipe({
    id: previous?.id || 'main-level',
    sceneId: input.sceneId,
    name: `${themeLabel} ${encounterCount > 0 ? 'Assault' : 'Expedition'}`,
    prompt,
    seed,
    theme,
    objective,
    layout: {
      roomCount,
      roomSize: previous?.layout.roomSize || 8,
      roomSpacing: previous?.layout.roomSpacing || 12,
      pathWidth: previous?.layout.pathWidth || 3.2,
      verticality: /flat|accessible/.test(normalized) ? 0.1 : (/vertical|tower|height/.test(normalized) ? 0.8 : (previous?.layout.verticality || 0.35)),
    },
    gameplay: {
      difficulty,
      pickupCount: requestedPickups ?? (objective === 'reach-exit' ? 1 : Math.min(12, 4 + difficulty)),
      hazardCount: requestedHazards ?? Math.max(0, difficulty * 2 - (/calm|no hazards?/.test(normalized) ? 2 : 0)),
      encounterCount,
      enemyCount,
    },
  });
}

export function validateLevelRecipe(recipe: LillyLevelRecipe): LevelValidationIssue[] {
  const issues: LevelValidationIssue[] = [];
  const error = (code: string, message: string, path: string) => issues.push({ code, message, path, severity: 'error' });
  if (recipe?.schema !== LEVEL_RECIPE_SCHEMA) error('INVALID_LEVEL_RECIPE_SCHEMA', `Expected ${LEVEL_RECIPE_SCHEMA}`, 'schema');
  if (!recipe?.id || !/^[a-z0-9-]+$/.test(recipe.id)) error('INVALID_LEVEL_RECIPE_ID', 'Level recipe id must be a stable slug', 'id');
  if (!recipe?.sceneId) error('LEVEL_RECIPE_SCENE_REQUIRED', 'Level recipe requires a sceneId', 'sceneId');
  if (!recipe?.seed || recipe.seed.length > 120) error('INVALID_LEVEL_SEED', 'Level seed must contain 1 to 120 characters', 'seed');
  if (!Object.prototype.hasOwnProperty.call(THEME_PALETTES, recipe?.theme)) error('INVALID_LEVEL_THEME', 'Level theme is not supported', 'theme');
  if (!['collect-and-exit', 'reach-exit', 'secure-and-exit'].includes(recipe?.objective)) error('INVALID_LEVEL_OBJECTIVE', 'Level objective is not supported', 'objective');
  const layout = recipe?.layout;
  if (!Number.isInteger(layout?.roomCount) || layout.roomCount < 3 || layout.roomCount > 16) error('INVALID_ROOM_COUNT', 'roomCount must be an integer from 3 to 16', 'layout.roomCount');
  if (!Number.isFinite(layout?.roomSize) || layout.roomSize < 6 || layout.roomSize > 14) error('INVALID_ROOM_SIZE', 'roomSize must be between 6 and 14', 'layout.roomSize');
  if (!Number.isFinite(layout?.roomSpacing) || layout.roomSpacing < Number(layout?.roomSize || 0) + 2 || layout.roomSpacing > 26) error('INVALID_ROOM_SPACING', 'roomSpacing must leave at least 2 units between rooms', 'layout.roomSpacing');
  if (!Number.isFinite(layout?.pathWidth) || layout.pathWidth < 2.4 || layout.pathWidth > Number(layout?.roomSize || 0) - 2) error('INVALID_PATH_WIDTH', 'pathWidth must fit safely inside each room', 'layout.pathWidth');
  if (!Number.isFinite(layout?.verticality) || layout.verticality < 0 || layout.verticality > 1) error('INVALID_VERTICALITY', 'verticality must be between 0 and 1', 'layout.verticality');
  const gameplay = recipe?.gameplay;
  if (!Number.isInteger(gameplay?.difficulty) || gameplay.difficulty < 1 || gameplay.difficulty > 5) error('INVALID_DIFFICULTY', 'difficulty must be an integer from 1 to 5', 'gameplay.difficulty');
  if (!Number.isInteger(gameplay?.pickupCount) || gameplay.pickupCount < 1 || gameplay.pickupCount > 20) error('INVALID_PICKUP_COUNT', 'pickupCount must be an integer from 1 to 20', 'gameplay.pickupCount');
  if (!Number.isInteger(gameplay?.hazardCount) || gameplay.hazardCount < 0 || gameplay.hazardCount > 30) error('INVALID_HAZARD_COUNT', 'hazardCount must be an integer from 0 to 30', 'gameplay.hazardCount');
  if (!Number.isInteger(gameplay?.encounterCount) || gameplay.encounterCount < 0 || gameplay.encounterCount > Math.min(4, Math.max(0, Number(layout?.roomCount || 0) - 2))) error('INVALID_ENCOUNTER_COUNT', 'encounterCount must fit in non-spawn, non-goal rooms and cannot exceed 4', 'gameplay.encounterCount');
  if (!Number.isInteger(gameplay?.enemyCount) || gameplay.enemyCount < gameplay.encounterCount || gameplay.enemyCount > 4) error('INVALID_ENEMY_COUNT', 'enemyCount must be at least encounterCount and cannot exceed 4', 'gameplay.enemyCount');
  if (gameplay?.encounterCount === 0 && gameplay?.enemyCount !== 0) error('ENEMIES_REQUIRE_ENCOUNTER', 'enemyCount must be 0 when encounterCount is 0', 'gameplay.enemyCount');
  return issues;
}

function roomKind(index: number, roomCount: number): LillyGeneratedRoom['kind'] {
  if (index === 0) return 'spawn';
  if (index === roomCount - 1) return 'goal';
  if (index % 4 === 0) return 'reward';
  if (index % 2 === 0) return 'challenge';
  return 'traversal';
}

function buildRoomPath(recipe: LillyLevelRecipe, random: () => number) {
  const cells = [{ x: 0, z: 0 }];
  const parentIndexes: number[] = [];
  const occupied = new Set(['0:0']);
  while (cells.length < recipe.layout.roomCount) {
    const candidateBases = [cells[cells.length - 1], ...shuffled(cells.slice(0, -1), random)];
    let chosen: { x: number; z: number } | null = null;
    let parentIndex = -1;
    for (const base of candidateBases) {
      for (const direction of shuffled(DIRECTIONS, random)) {
        const candidate = { x: base.x + direction.x, z: base.z + direction.z };
        if (!occupied.has(`${candidate.x}:${candidate.z}`)) {
          chosen = candidate;
          parentIndex = cells.indexOf(base);
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) throw new Error('Level generator could not extend the room path');
    cells.push(chosen);
    parentIndexes.push(parentIndex);
    occupied.add(`${chosen.x}:${chosen.z}`);
  }
  return { cells, parentIndexes };
}

function wallSegments(roomSize: number, pathWidth: number, hasDoor: boolean) {
  if (!hasDoor) return [{ offset: 0, length: roomSize + 0.32 }];
  const length = Math.max(0.6, (roomSize - pathWidth) / 2);
  const offset = pathWidth / 2 + length / 2;
  return [{ offset: -offset, length }, { offset, length }];
}

function generatedTag(recipeId: string) {
  return `generated:${recipeId}`;
}

function canonicalDesignValue(design: Omit<LillyGeneratedLevel, 'checksum'>) {
  return JSON.stringify({
    schema: design.schema,
    recipeId: design.recipeId,
    sceneId: design.sceneId,
    seed: design.seed,
    seedHash: design.seedHash,
    theme: design.theme,
    objective: design.objective,
    rooms: design.rooms,
    connections: design.connections,
    encounters: design.encounters,
    spawn: design.spawn,
    goal: design.goal,
    bounds: design.bounds,
    metrics: design.metrics,
  });
}

export function computeGeneratedLevelChecksum(design: Omit<LillyGeneratedLevel, 'checksum'> | LillyGeneratedLevel) {
  const { checksum: _checksum, ...withoutChecksum } = design as LillyGeneratedLevel;
  return stableHash(canonicalDesignValue(withoutChecksum));
}

export function generateLevel(recipeInput: LillyLevelRecipe, options: { parentId?: string | null } = {}): GeneratedLevelResult {
  const recipe = normalizeLevelRecipe(recipeInput);
  const issues = validateLevelRecipe(recipe);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw Object.assign(new Error(issues.map((issue) => issue.message).join('; ')), { code: 'INVALID_LEVEL_RECIPE', issues });
  }
  const random = createRandom(`${recipe.id}:${recipe.seed}`);
  const palette = THEME_PALETTES[recipe.theme];
  const parentId = options.parentId === undefined ? 'world' : options.parentId;
  const { cells, parentIndexes } = buildRoomPath(recipe, random);
  const prefix = `level-${recipe.id}`;
  const generationTag = generatedTag(recipe.id);
  const rooms: LillyGeneratedRoom[] = cells.map((cell, index) => ({
    id: `${prefix}-room-${index + 1}`,
    grid: { x: cell.x, z: cell.z },
    position: { x: cell.x * recipe.layout.roomSpacing, y: 0, z: cell.z * recipe.layout.roomSpacing },
    kind: roomKind(index, cells.length),
  }));
  const connections: LillyGeneratedConnection[] = rooms.slice(1).map((room, index) => ({
    id: `${prefix}-path-${index + 1}`,
    fromRoomId: rooms[parentIndexes[index]].id,
    toRoomId: room.id,
  }));
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const connectedDirections = new Map<string, Set<string>>();
  for (const connection of connections) {
    const from = roomById.get(connection.fromRoomId)!;
    const to = roomById.get(connection.toRoomId)!;
    const dx = to.grid.x - from.grid.x;
    const dz = to.grid.z - from.grid.z;
    const fromDirection = dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north';
    const toDirection = dx > 0 ? 'west' : dx < 0 ? 'east' : dz > 0 ? 'north' : 'south';
    if (!connectedDirections.has(from.id)) connectedDirections.set(from.id, new Set());
    if (!connectedDirections.has(to.id)) connectedDirections.set(to.id, new Set());
    connectedDirections.get(from.id)!.add(fromDirection);
    connectedDirections.get(to.id)!.add(toDirection);
  }

  const entities: LillyEntity[] = [];
  const wallHeight = 2.4 + recipe.layout.verticality * 2.2;
  const wallThickness = 0.34;
  for (const [roomIndex, room] of rooms.entries()) {
    entities.push(entity({
      id: `${room.id}-floor`,
      name: `${room.kind[0].toUpperCase()}${room.kind.slice(1)} Room`,
      parentId,
      locked: true,
      tags: [generationTag, 'generated', 'ground', 'room', `room:${room.id}`, `room-kind:${room.kind}`],
      components: [
        transform({ x: room.position.x, y: -0.25, z: room.position.z }, { x: recipe.layout.roomSize, y: 0.5, z: recipe.layout.roomSize }),
        mesh(room.kind === 'goal' ? palette.corridor : palette.floor, 'box', room.kind === 'goal' ? { emissive: palette.accent, emissiveIntensity: 0.12 } : {}),
        boxCollider({ x: recipe.layout.roomSize, y: 0.5, z: recipe.layout.roomSize }),
      ],
    }));

    const doorDirections = connectedDirections.get(room.id) || new Set<string>();
    const sides = [
      { name: 'north', axis: 'x', x: room.position.x, z: room.position.z - recipe.layout.roomSize / 2 },
      { name: 'south', axis: 'x', x: room.position.x, z: room.position.z + recipe.layout.roomSize / 2 },
      { name: 'west', axis: 'z', x: room.position.x - recipe.layout.roomSize / 2, z: room.position.z },
      { name: 'east', axis: 'z', x: room.position.x + recipe.layout.roomSize / 2, z: room.position.z },
    ] as const;
    for (const side of sides) {
      for (const [segmentIndex, segment] of wallSegments(recipe.layout.roomSize, recipe.layout.pathWidth, doorDirections.has(side.name)).entries()) {
        const position = side.axis === 'x'
          ? { x: side.x + segment.offset, y: wallHeight / 2, z: side.z }
          : { x: side.x, y: wallHeight / 2, z: side.z + segment.offset };
        const scale = side.axis === 'x'
          ? { x: segment.length, y: wallHeight, z: wallThickness }
          : { x: wallThickness, y: wallHeight, z: segment.length };
        entities.push(entity({
          id: `${room.id}-wall-${side.name}-${segmentIndex + 1}`,
          name: `Room ${roomIndex + 1} ${side.name} wall`,
          parentId,
          locked: true,
          tags: [generationTag, 'generated', 'wall', 'obstacle', `room:${room.id}`],
          components: [transform(position, scale), mesh(palette.wall), boxCollider(scale)],
        }));
      }
    }
  }

  for (const [index, connection] of connections.entries()) {
    const from = roomById.get(connection.fromRoomId)!;
    const to = roomById.get(connection.toRoomId)!;
    const horizontal = from.grid.x !== to.grid.x;
    const gap = recipe.layout.roomSpacing - recipe.layout.roomSize + 0.5;
    const position = {
      x: (from.position.x + to.position.x) / 2,
      y: -0.24,
      z: (from.position.z + to.position.z) / 2,
    };
    const scale = horizontal
      ? { x: gap, y: 0.48, z: recipe.layout.pathWidth }
      : { x: recipe.layout.pathWidth, y: 0.48, z: gap };
    entities.push(entity({
      id: connection.id,
      name: `Critical Path ${index + 1}`,
      parentId,
      locked: true,
      tags: [generationTag, 'generated', 'ground', 'path', 'critical-path'],
      components: [transform(position, scale), mesh(palette.corridor, 'box', { emissive: palette.accent, emissiveIntensity: 0.07 }), boxCollider(scale)],
    }));
  }

  const encounters: LillyEncounterSpec[] = [];
  const eligibleEncounterRooms = [
    ...rooms.filter((room) => room.kind === 'challenge'),
    ...rooms.filter((room) => room.kind === 'traversal'),
    ...rooms.filter((room) => room.kind === 'reward'),
  ].filter((room, index, values) => (
    room.kind !== 'spawn'
    && room.kind !== 'goal'
    && values.findIndex((candidate) => candidate.id === room.id) === index
  ));
  const selectedEncounterRooms = eligibleEncounterRooms.slice(0, recipe.gameplay.encounterCount);
  let remainingEnemies = recipe.gameplay.enemyCount;
  for (const [encounterIndex, room] of selectedEncounterRooms.entries()) {
    const encounterId = `${prefix}-encounter-${encounterIndex + 1}`;
    const remainingEncounters = selectedEncounterRooms.length - encounterIndex;
    const enemiesForEncounter = Math.max(1, Math.min(2, remainingEnemies - Math.max(0, remainingEncounters - 1)));
    const enemyIds: string[] = [];
    for (let enemyIndex = 0; enemyIndex < enemiesForEncounter; enemyIndex += 1) {
      const enemyId = `${encounterId}-enemy-${enemyIndex + 1}`;
      const angle = (Math.PI * 2 * enemyIndex) / Math.max(1, enemiesForEncounter) + random() * 0.35;
      const radius = Math.min(2.1, recipe.layout.roomSize * 0.22);
      const position = {
        x: room.position.x + Math.cos(angle) * radius,
        y: 0.62,
        z: room.position.z + Math.sin(angle) * radius,
      };
      const enemyHealth = 2 + Math.floor(recipe.gameplay.difficulty / 2);
      enemyIds.push(enemyId);
      entities.push(entity({
        id: enemyId,
        name: `Guardian ${encounterIndex + 1}.${enemyIndex + 1}`,
        parentId,
        locked: true,
        tags: [generationTag, 'generated', 'enemy', 'combatant', `encounter:${encounterId}`, `room:${room.id}`],
        components: [
          transform(position, { x: 0.9, y: 1.2, z: 0.9 }),
          mesh(palette.enemy, 'octahedron', { roughness: 0.24, metalness: 0.5, emissive: palette.enemy, emissiveIntensity: 0.34 }),
          component('Collider', { shape: 'capsule', size: { x: 0.9, y: 1.2, z: 0.9 }, sensor: false, restitution: 0.05, friction: 0.65 }),
          component('Health', { max: enemyHealth, current: enemyHealth, invulnerabilitySeconds: 0.12 }),
          component('Combatant', { team: 'enemy', damage: 1, range: 1.25, cooldownSeconds: 0.75, attackAction: '' }),
          component('EnemyBrain', {
            behavior: 'chaser',
            moveSpeed: 1.65 + recipe.gameplay.difficulty * 0.22,
            detectionRange: Math.max(7, recipe.layout.roomSize * 1.2),
            attackRange: 1.25,
            windupSeconds: Math.max(0.18, 0.38 - recipe.gameplay.difficulty * 0.035),
            recoverSeconds: Math.max(0.42, 0.82 - recipe.gameplay.difficulty * 0.06),
          }),
          component('EncounterMember', { encounterId }),
        ],
      }));
    }
    remainingEnemies -= enemiesForEncounter;

    const gateIds: string[] = [];
    const encounterConnections = connections.filter((connection) => connection.fromRoomId === room.id || connection.toRoomId === room.id);
    encounterConnections.forEach((connection, gateIndex) => {
      const otherRoom = roomById.get(connection.fromRoomId === room.id ? connection.toRoomId : connection.fromRoomId)!;
      const dx = Math.sign(otherRoom.grid.x - room.grid.x);
      const dz = Math.sign(otherRoom.grid.z - room.grid.z);
      const gateId = `${encounterId}-gate-${gateIndex + 1}`;
      const position = {
        x: room.position.x + dx * (recipe.layout.roomSize / 2 + 0.08),
        y: 1.15,
        z: room.position.z + dz * (recipe.layout.roomSize / 2 + 0.08),
      };
      const scale = dx !== 0
        ? { x: 0.34, y: 2.3, z: recipe.layout.pathWidth * 0.94 }
        : { x: recipe.layout.pathWidth * 0.94, y: 2.3, z: 0.34 };
      gateIds.push(gateId);
      entities.push(entity({
        id: gateId,
        name: `Encounter Gate ${encounterIndex + 1}.${gateIndex + 1}`,
        parentId,
        locked: true,
        tags: [generationTag, 'generated', 'encounter-gate', 'obstacle', `encounter:${encounterId}`, `room:${room.id}`],
        components: [
          transform(position, scale),
          mesh(palette.gate, 'box', { roughness: 0.16, metalness: 0.45, emissive: palette.gate, emissiveIntensity: 0.52 }),
          boxCollider(scale),
          component('EncounterGate', { encounterId, startsOpen: true }),
        ],
      }));
    });

    const checkpointId = `${encounterId}-checkpoint`;
    const checkpointPosition = { x: room.position.x, y: 0.65, z: room.position.z };
    entities.push(entity({
      id: checkpointId,
      name: `Checkpoint ${encounterIndex + 1}`,
      parentId,
      locked: true,
      tags: [generationTag, 'generated', 'checkpoint', `encounter:${encounterId}`, `room:${room.id}`],
      components: [
        transform({ ...checkpointPosition, y: 0.08 }, { x: 1.45, y: 0.12, z: 1.45 }),
        mesh(palette.checkpoint, 'cylinder', { roughness: 0.2, metalness: 0.4, emissive: palette.checkpoint, emissiveIntensity: 0.48 }),
        component('Collider', { shape: 'cylinder', size: { x: 1.45, y: 0.15, z: 1.45 }, sensor: true, restitution: 0, friction: 0 }),
        component('Checkpoint', { checkpointId, encounterId, activate: 'encounter-clear' }),
      ],
    }));
    encounters.push({
      schema: ENCOUNTER_SCHEMA,
      id: encounterId,
      kind: 'room-combat-clear',
      roomId: room.id,
      enemyIds,
      gateIds,
      checkpointId,
      checkpointPosition,
    });
  }

  const pickupRooms = rooms.slice(1);
  for (let index = 0; index < recipe.gameplay.pickupCount; index += 1) {
    const room = pickupRooms[index % pickupRooms.length];
    const radius = Math.max(1.2, recipe.layout.roomSize * 0.25);
    const angle = random() * Math.PI * 2;
    const position = {
      x: room.position.x + Math.cos(angle) * radius,
      y: 0.9,
      z: room.position.z + Math.sin(angle) * radius,
    };
    entities.push(entity({
      id: `${prefix}-pickup-${index + 1}`,
      name: `Energy Core ${index + 1}`,
      parentId,
      tags: [generationTag, 'generated', 'pickup', 'objective-item', `room:${room.id}`],
      components: [
        transform(position, { x: 0.52, y: 0.7, z: 0.52 }),
        mesh(palette.pickup, 'octahedron', { roughness: 0.18, metalness: 0.52, emissive: palette.pickup, emissiveIntensity: 0.5 }),
        component('Collider', { shape: 'sphere', size: { x: 1.2, y: 1.2, z: 1.2 }, sensor: true, restitution: 0, friction: 0 }),
        component('ParticleEmitter', { rate: 8, lifetime: 0.9, color: palette.pickup, size: 0.08, burst: 18 }),
      ],
    }));
  }

  const hazardRooms = rooms.slice(1, -1).length ? rooms.slice(1, -1) : rooms.slice(1);
  for (let index = 0; index < recipe.gameplay.hazardCount; index += 1) {
    const room = hazardRooms[index % hazardRooms.length];
    const angle = random() * Math.PI * 2;
    const radius = recipe.layout.roomSize * (0.31 + random() * 0.08);
    const position = {
      x: room.position.x + Math.cos(angle) * radius,
      y: 0.16,
      z: room.position.z + Math.sin(angle) * radius,
    };
    entities.push(entity({
      id: `${prefix}-hazard-${index + 1}`,
      name: `Pulse Trap ${index + 1}`,
      parentId,
      tags: [generationTag, 'generated', 'hazard', 'damage', `room:${room.id}`],
      components: [
        transform(position, { x: 1.25, y: 0.28, z: 1.25 }),
        mesh(palette.hazard, 'cylinder', { roughness: 0.26, metalness: 0.38, emissive: palette.hazard, emissiveIntensity: 0.55 }),
        component('Collider', { shape: 'cylinder', size: { x: 1.25, y: 0.35, z: 1.25 }, sensor: true, restitution: 0, friction: 0 }),
      ],
    }));
  }

  let landmarkCount = 0;
  rooms.forEach((room, index) => {
    if (index === 0 || index === rooms.length - 1 || index % 2 === 0) {
      landmarkCount += 1;
      const side = index % 2 === 0 ? 1 : -1;
      const height = 2.1 + recipe.layout.verticality * (2.4 + random());
      const position = {
        x: room.position.x + side * (recipe.layout.roomSize / 2 - 1.2),
        y: height / 2,
        z: room.position.z - side * (recipe.layout.roomSize / 2 - 1.2),
      };
      entities.push(entity({
        id: `${prefix}-landmark-${landmarkCount}`,
        name: index === rooms.length - 1 ? 'Exit Beacon' : `Wayfinder ${landmarkCount}`,
        parentId,
        tags: [generationTag, 'generated', 'landmark', 'scenery', `room:${room.id}`],
        components: [
          transform(position, { x: 0.65, y: height, z: 0.65 }),
          mesh(palette.landmark, 'cylinder', { roughness: 0.3, metalness: 0.48, emissive: palette.accent, emissiveIntensity: 0.22 }),
        ],
      }));
    }
  });

  const spawnPosition = { x: rooms[0].position.x, y: 0.65, z: rooms[0].position.z };
  const goalRoom = rooms[rooms.length - 1];
  const goalPosition = { x: goalRoom.position.x, y: 0.85, z: goalRoom.position.z };
  entities.push(entity({
    id: `${prefix}-goal`,
    name: 'Expedition Exit',
    parentId,
    tags: [generationTag, 'generated', 'goal', 'exit', `room:${goalRoom.id}`],
    components: [
      transform(goalPosition, { x: 1.1, y: 1.1, z: 1.1 }),
      mesh(palette.accent, 'torus', { roughness: 0.2, metalness: 0.55, emissive: palette.accent, emissiveIntensity: 0.7 }),
      component('Collider', { shape: 'sphere', size: { x: 2.2, y: 2.2, z: 2.2 }, sensor: true, restitution: 0, friction: 0 }),
      component('ParticleEmitter', { rate: 14, lifetime: 1.2, color: palette.accent, size: 0.1, burst: 24 }),
    ],
  }));

  const xValues = rooms.map((room) => room.position.x);
  const zValues = rooms.map((room) => room.position.z);
  const margin = recipe.layout.roomSize / 2 + 1;
  const designWithoutChecksum: Omit<LillyGeneratedLevel, 'checksum'> = {
    schema: GENERATED_LEVEL_SCHEMA,
    recipeId: recipe.id,
    sceneId: recipe.sceneId,
    seed: recipe.seed,
    seedHash: stableHash(`${recipe.id}:${recipe.seed}`),
    theme: recipe.theme,
    objective: recipe.objective,
    rooms,
    connections,
    encounters,
    spawn: { roomId: rooms[0].id, position: spawnPosition },
    goal: { roomId: goalRoom.id, position: goalPosition },
    bounds: {
      min: { x: Math.min(...xValues) - margin, y: -1, z: Math.min(...zValues) - margin },
      max: { x: Math.max(...xValues) + margin, y: wallHeight + 2, z: Math.max(...zValues) + margin },
    },
    metrics: {
      roomCount: rooms.length,
      pathCount: connections.length,
      pickupCount: recipe.gameplay.pickupCount,
      hazardCount: recipe.gameplay.hazardCount,
      landmarkCount,
      encounterCount: encounters.length,
      enemyCount: encounters.reduce((total, encounter) => total + encounter.enemyIds.length, 0),
      checkpointCount: encounters.length,
    },
  };
  const design = { ...designWithoutChecksum, checksum: computeGeneratedLevelChecksum(designWithoutChecksum) };
  const environment: LillyEnvironment = {
    background: palette.background,
    ambientIntensity: recipe.theme === 'ember-foundry' ? 0.72 : 0.58,
    fog: {
      color: palette.fog,
      near: recipe.layout.roomSpacing * 1.7,
      far: recipe.layout.roomSpacing * Math.max(4.2, Math.sqrt(recipe.layout.roomCount) * 2.5),
    },
  };
  return { recipe, design, environment, entities };
}

export function validateGeneratedLevel(design: LillyGeneratedLevel, recipe?: LillyLevelRecipe | null): LevelValidationIssue[] {
  const issues: LevelValidationIssue[] = [];
  const error = (code: string, message: string, path: string) => issues.push({ code, message, path, severity: 'error' });
  if (design?.schema !== GENERATED_LEVEL_SCHEMA) error('INVALID_GENERATED_LEVEL_SCHEMA', `Expected ${GENERATED_LEVEL_SCHEMA}`, 'schema');
  if (recipe && design?.recipeId !== recipe.id) error('GENERATED_LEVEL_RECIPE_MISMATCH', 'Generated level does not match its recipe', 'recipeId');
  if (recipe && design?.sceneId !== recipe.sceneId) error('GENERATED_LEVEL_SCENE_MISMATCH', 'Generated level targets a different scene', 'sceneId');
  const rooms = Array.isArray(design?.rooms) ? design.rooms : [];
  const roomIds = new Set<string>();
  const roomById = new Map<string, LillyGeneratedRoom>();
  rooms.forEach((room, index) => {
    if (!room?.id || roomIds.has(room.id)) error('DUPLICATE_GENERATED_ROOM', `Generated room id ${room?.id || '(missing)'} is not unique`, `rooms[${index}].id`);
    roomIds.add(room?.id);
    roomById.set(room?.id, room);
  });
  if (rooms.length < 3) error('GENERATED_LEVEL_TOO_SMALL', 'Generated level requires at least three rooms', 'rooms');
  if (!roomIds.has(design?.spawn?.roomId)) error('GENERATED_LEVEL_SPAWN_MISSING', 'Spawn room does not exist', 'spawn.roomId');
  if (!roomIds.has(design?.goal?.roomId)) error('GENERATED_LEVEL_GOAL_MISSING', 'Goal room does not exist', 'goal.roomId');
  const adjacency = new Map<string, Set<string>>();
  roomIds.forEach((id) => adjacency.set(id, new Set()));
  (design?.connections || []).forEach((connection, index) => {
    if (!roomIds.has(connection.fromRoomId) || !roomIds.has(connection.toRoomId)) {
      error('GENERATED_LEVEL_CONNECTION_MISSING_ROOM', 'Generated path references a missing room', `connections[${index}]`);
      return;
    }
    const from = roomById.get(connection.fromRoomId)!;
    const to = roomById.get(connection.toRoomId)!;
    if (Math.abs(from.grid.x - to.grid.x) + Math.abs(from.grid.z - to.grid.z) !== 1) {
      error('GENERATED_LEVEL_CONNECTION_NOT_ADJACENT', 'Generated path must connect adjacent rooms', `connections[${index}]`);
    }
    adjacency.get(connection.fromRoomId)!.add(connection.toRoomId);
    adjacency.get(connection.toRoomId)!.add(connection.fromRoomId);
  });
  const visited = new Set<string>();
  const queue = design?.spawn?.roomId ? [design.spawn.roomId] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    adjacency.get(id)?.forEach((neighbor) => { if (!visited.has(neighbor)) queue.push(neighbor); });
  }
  if (design?.goal?.roomId && !visited.has(design.goal.roomId)) error('GENERATED_LEVEL_GOAL_UNREACHABLE', 'No traversable room path connects spawn to goal', 'connections');
  const encounters = Array.isArray(design?.encounters) ? design.encounters : [];
  const encounterIds = new Set<string>();
  const ownedEnemies = new Set<string>();
  const ownedGates = new Set<string>();
  const ownedCheckpoints = new Set<string>();
  encounters.forEach((encounter, index) => {
    const path = `encounters[${index}]`;
    if (encounter?.schema !== ENCOUNTER_SCHEMA) error('INVALID_ENCOUNTER_SCHEMA', `Expected ${ENCOUNTER_SCHEMA}`, `${path}.schema`);
    if (!encounter?.id || encounterIds.has(encounter.id)) error('DUPLICATE_ENCOUNTER_ID', `Encounter id ${encounter?.id || '(missing)'} is not unique`, `${path}.id`);
    encounterIds.add(encounter?.id);
    if (encounter?.kind !== 'room-combat-clear') error('INVALID_ENCOUNTER_KIND', 'Encounter kind must be room-combat-clear', `${path}.kind`);
    if (!roomIds.has(encounter?.roomId)) error('ENCOUNTER_ROOM_MISSING', `Encounter room ${encounter?.roomId || '(missing)'} does not exist`, `${path}.roomId`);
    if (!Array.isArray(encounter?.enemyIds) || encounter.enemyIds.length < 1) error('ENCOUNTER_ENEMIES_REQUIRED', 'Combat encounters require at least one enemy', `${path}.enemyIds`);
    (encounter?.enemyIds || []).forEach((id, enemyIndex) => {
      if (!id || ownedEnemies.has(id)) error('DUPLICATE_ENCOUNTER_ENEMY', `Enemy ${id || '(missing)'} belongs to more than one encounter`, `${path}.enemyIds[${enemyIndex}]`);
      ownedEnemies.add(id);
    });
    if (!Array.isArray(encounter?.gateIds) || encounter.gateIds.length < 1) error('ENCOUNTER_GATES_REQUIRED', 'Combat encounters require at least one gate', `${path}.gateIds`);
    (encounter?.gateIds || []).forEach((id, gateIndex) => {
      if (!id || ownedGates.has(id)) error('DUPLICATE_ENCOUNTER_GATE', `Gate ${id || '(missing)'} belongs to more than one encounter`, `${path}.gateIds[${gateIndex}]`);
      ownedGates.add(id);
    });
    if (!encounter?.checkpointId || ownedCheckpoints.has(encounter.checkpointId)) error('DUPLICATE_ENCOUNTER_CHECKPOINT', `Checkpoint ${encounter?.checkpointId || '(missing)'} is not unique`, `${path}.checkpointId`);
    ownedCheckpoints.add(encounter?.checkpointId);
    if (!isFiniteVector(encounter?.checkpointPosition)) error('INVALID_CHECKPOINT_POSITION', 'Checkpoint position must be a finite Vector3', `${path}.checkpointPosition`);
  });
  if (design?.metrics?.roomCount !== rooms.length) error('GENERATED_LEVEL_METRICS_MISMATCH', 'Generated room metrics do not match the saved topology', 'metrics.roomCount');
  if (design?.metrics?.pathCount !== (design?.connections || []).length) error('GENERATED_LEVEL_METRICS_MISMATCH', 'Generated path metrics do not match the saved topology', 'metrics.pathCount');
  if (design?.metrics?.encounterCount !== encounters.length) error('GENERATED_LEVEL_METRICS_MISMATCH', 'Generated encounter metrics do not match the saved topology', 'metrics.encounterCount');
  if (design?.metrics?.enemyCount !== ownedEnemies.size) error('GENERATED_LEVEL_METRICS_MISMATCH', 'Generated enemy metrics do not match the saved encounters', 'metrics.enemyCount');
  if (design?.metrics?.checkpointCount !== ownedCheckpoints.size) error('GENERATED_LEVEL_METRICS_MISMATCH', 'Generated checkpoint metrics do not match the saved encounters', 'metrics.checkpointCount');
  if (recipe && encounters.length !== recipe.gameplay.encounterCount) error('GENERATED_LEVEL_RECIPE_MISMATCH', 'Generated encounter count does not match its recipe', 'encounters');
  if (recipe && ownedEnemies.size !== recipe.gameplay.enemyCount) error('GENERATED_LEVEL_RECIPE_MISMATCH', 'Generated enemy count does not match its recipe', 'encounters');
  if (design?.checksum !== computeGeneratedLevelChecksum(design)) error('GENERATED_LEVEL_CHECKSUM_MISMATCH', 'Generated level checksum does not match its saved topology', 'checksum');
  return issues;
}

export function isGeneratedForRecipe(entityValue: LillyEntity, recipeId: string) {
  return entityValue.tags.includes(generatedTag(recipeId));
}
