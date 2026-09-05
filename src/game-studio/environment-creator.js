'use strict';

const crypto = require('crypto');
const { compileModelRecipe, modelRecipePrompt } = require('./asset-creator');
const { assembleModelScene } = require('./model-scene');
const SCHEMA = 'LillyEnvironmentRecipe/v1';
const TAG = 'lilly-scenery';

function invalid(message) { throw Object.assign(new Error(message), { statusCode: 422, code: 'ENVIRONMENT_RECIPE_INVALID' }); }
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${label} must be between ${min} and ${max}`);
  return value;
}
function color(value, label) {
  if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) invalid(`${label} must be #RRGGBB`);
  return value;
}
function pair(value, min, max, label) {
  if (!Array.isArray(value) || value.length !== 2) invalid(`${label} needs two numbers`);
  return value.map(n => number(n, min, max, label));
}
function list(value, max, label) { if (!Array.isArray(value) || value.length > max) invalid(`${label} supports up to ${max} entries`); return value; }
function component(entity, type) { return entity.components.find(c => c.type === type && c.enabled !== false); }

function sceneryContext(project) {
  const scene = project.scenes.find(s => s.id === project.entryScene) || project.scenes[0];
  const player = scene.entities.find(e => e.tags.includes('player'));
  const playerPosition = component(player || { components: [] }, 'Transform')?.data.position || { x: 0, y: 0, z: 0 };
  // Keep flattened terrain just below existing floors to avoid coplanar flicker.
  const origin = { x: Number(playerPosition.x), y: scene.entities.some(e => e.enabled && e.tags.includes('ground')) ? -0.03 : 0, z: Number(playerPosition.z) };
  const clearings = [{ x: 0, z: 0, radius: 5 }];
  for (const entity of scene.entities) {
    if (!entity.enabled || entity.tags.includes(TAG) || component(entity, 'Terrain')) continue;
    if (!component(entity, 'Collider') && !entity.tags.some(t => ['player', 'enemy', 'collectible', 'checkpoint'].includes(t))) continue;
    const transform = component(entity, 'Transform')?.data;
    if (!transform) continue;
    const position = transform.position || { x: 0, z: 0 };
    const size = component(entity, 'Collider')?.data.size || transform.scale || { x: 1, z: 1 };
    const zone = { x: Number(position.x) - origin.x, z: Number(position.z) - origin.z, radius: Math.max(1.2, Math.hypot(Number(size.x || 1), Number(size.z || 1)) / 2 + 0.6) };
    if (entity.tags.includes('ground')) Object.assign(zone, { halfX: Math.abs(Number(size.x || 1)) / 2, halfZ: Math.abs(Number(size.z || 1)) / 2, yaw: Number(transform.rotation?.y || 0) });
    clearings.push(zone);
  }
  return { origin, clearings };
}

function clearanceDistance(x, z, zone) {
  if (zone.halfX !== undefined) {
    const angle = zone.yaw * Math.PI / 180, dx = x - zone.x, dz = z - zone.z;
    return Math.hypot(Math.max(0, Math.abs(Math.cos(angle) * dx - Math.sin(angle) * dz) - zone.halfX), Math.max(0, Math.abs(Math.sin(angle) * dx + Math.cos(angle) * dz) - zone.halfZ));
  }
  return Math.hypot(x - zone.x, z - zone.z) - zone.radius;
}

function terrainHeight(terrain, x, z) {
  const n = terrain.resolution;
  const u = Math.max(0, Math.min(n - 1, (x / terrain.size.x + 0.5) * (n - 1)));
  const v = Math.max(0, Math.min(n - 1, (z / terrain.size.y + 0.5) * (n - 1)));
  const col = Math.min(n - 2, Math.floor(u)), row = Math.min(n - 2, Math.floor(v));
  const tx = u - col, tz = v - row;
  const [a, b, c, d] = [row * n + col, row * n + col + 1, (row + 1) * n + col, (row + 1) * n + col + 1].map(i => terrain.heights[i] * terrain.heightScale);
  return tx + tz <= 1 ? a + tx * (b - a) + tz * (c - a) : d + (1 - tx) * (c - d) + (1 - tz) * (b - d);
}

function compileEnvironmentRecipe(input, context = { origin: { x: 0, y: 0, z: 0 }, clearings: [{ x: 0, z: 0, radius: 5 }] }) {
  if (input?.schema !== SCHEMA || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) invalid('Name the environment and use LillyEnvironmentRecipe/v1');
  const size = pair(input.terrain?.size, 16, 96, 'Terrain size');
  const height = number(input.terrain?.height, 0, 12, 'Terrain height');
  const hills = list(input.terrain?.hills || [], 12, 'Hills').map(h => ({ center: pair(h.center, -1, 1, 'Hill center'), radius: number(h.radius, 0.1, 1.5, 'Hill radius'), height: number(h.height, 0, 1, 'Hill height') }));
  const sky = { color: color(input.sky?.color, 'Sky color'), ambient: number(input.sky?.ambient, 0.2, 2, 'Ambient light'), sunColor: color(input.sky?.sunColor, 'Sun color'), sunIntensity: number(input.sky?.sunIntensity, 0, 5, 'Sun intensity'), fog: input.sky?.fog ? { color: color(input.sky.fog.color, 'Fog color'), near: number(input.sky.fog.near, 5, 120, 'Fog near'), far: number(input.sky.fog.far, 20, 240, 'Fog far') } : null };
  if (sky.fog && sky.fog.far <= sky.fog.near) invalid('Fog far must exceed fog near');
  const models = list(input.models, 6, 'Models').map(model => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(model.id)) invalid('Model IDs must be lowercase words or hyphens, up to 32 characters');
    const compiled = compileModelRecipe(model.recipe);
    if (Math.max(...compiled.summary.size) > 16) invalid('Scenery props must fit within 16 meters');
    return { id: model.id, ...compiled };
  });
  if (!models.length || new Set(models.map(m => m.id)).size !== models.length) invalid('Use 1–6 uniquely named scenery models');
  const known = new Map(models.map(m => [m.id, m]));
  const scatter = list(input.scatter || [], 8, 'Scatter groups').map(group => {
    if (!known.has(group.modelId)) invalid('Scatter references an unknown model');
    const count = number(group.count, 1, 40, 'Scatter count');
    if (!Number.isInteger(count)) invalid('Scatter count must be an integer');
    const scale = pair(group.scale || [0.8, 1.2], 0.2, 3, 'Scatter scale');
    if (scale[1] < scale[0]) invalid('Scatter scale range is reversed');
    return { modelId: group.modelId, count, center: pair(group.center || [0, 0], -1, 1, 'Scatter center'), radius: number(group.radius ?? 0.9, 0.1, 1.5, 'Scatter radius'), scale };
  });
  const placements = list(input.placements || [], 16, 'Landmarks').map(p => {
    if (!known.has(p.modelId)) invalid('Landmark references an unknown model');
    return { modelId: p.modelId, point: pair(p.point, -1, 1, 'Landmark point'), yaw: number(p.yaw ?? 0, -360, 360, 'Landmark rotation'), scale: number(p.scale ?? 1, 0.2, 3, 'Landmark scale') };
  });
  const requested = scatter.reduce((sum, g) => sum + g.count, placements.length);
  if (requested < 1 || requested > 96) invalid('An environment needs 1–96 scenery instances');
  const recipe = { schema: SCHEMA, name: input.name.trim(), seed: String(input.seed ?? 'lilly-scenery').slice(0, 80), terrain: { size, height, color: color(input.terrain.color, 'Ground color'), hills }, sky, models: models.map(m => ({ id: m.id, recipe: m.recipe })), scatter, placements };
  const resolution = 25;
  const terrain = { schema: 'LillyTerrain/v1', id: '', moduleId: '', name: `${recipe.name} terrain`, size: { x: size[0], y: size[1] }, resolution, heights: [], heightScale: height, collision: true, walkable: true };
  for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) {
    const nx = col / (resolution - 1) * 2 - 1, nz = row / (resolution - 1) * 2 - 1;
    let value = Math.min(1, hills.reduce((sum, hill) => sum + hill.height * Math.exp(-((nx - hill.center[0]) ** 2 + (nz - hill.center[1]) ** 2) / (hill.radius ** 2) * 3), 0));
    for (const clearing of context.clearings) value *= Math.max(0, Math.min(1, (clearanceDistance(nx * size[0] / 2, nz * size[1] / 2, clearing) - Math.max(...size) / (resolution - 1)) / 3));
    terrain.heights.push(Number(value.toFixed(5)));
  }
  let seed = crypto.createHash('sha256').update(recipe.seed).digest().readUInt32LE(0);
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const instances = [];
  const occupied = [];
  const place = (modelId, x, z, scale, yaw) => {
    const model = known.get(modelId);
    const radius = Math.max(0.35, Math.hypot(model.summary.size[0], model.summary.size[2]) * scale * 0.35);
    if (Math.abs(x) + radius > size[0] / 2 || Math.abs(z) + radius > size[1] / 2) return false;
    if ([...context.clearings, ...occupied].some(zone => clearanceDistance(x, z, zone) < radius)) return false;
    instances.push({ modelId, name: model.recipe.name, position: [Number(x.toFixed(4)), Number(terrainHeight(terrain, x, z).toFixed(4)), Number(z.toFixed(4))], yaw, scale });
    occupied.push({ x, z, radius });
    return true;
  };
  for (const p of placements) place(p.modelId, p.point[0] * size[0] / 2, p.point[1] * size[1] / 2, p.scale, p.yaw);
  for (const group of scatter) for (let index = 0; index < group.count; index++) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * group.radius;
      const x = (group.center[0] + Math.cos(angle) * radius) * size[0] / 2;
      const z = (group.center[1] + Math.sin(angle) * radius) * size[1] / 2;
      if (place(group.modelId, x, z, group.scale[0] + random() * (group.scale[1] - group.scale[0]), random() * 360)) break;
    }
  }
  if (!instances.length) invalid('No scenery fits around the existing game objects. Use a larger environment or smaller props.');
  const vertices = [], indices = [];
  for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) vertices.push((col / (resolution - 1) - 0.5) * size[0], terrain.heights[row * resolution + col] * height, (row / (resolution - 1) - 0.5) * size[1]);
  for (let row = 0; row < resolution - 1; row++) for (let col = 0; col < resolution - 1; col++) { const a = row * resolution + col, b = a + resolution; indices.push(a, b, a + 1, b, b + 1, a + 1); }
  const ground = compileModelRecipe({ schema: 'LillyModelRecipe/v1', name: terrain.name, parts: [{ name: 'Ground', shape: 'mesh', vertices, indices, color: recipe.terrain.color, roughness: 0.95 }] });
  const triangles = indices.length / 3 + instances.reduce((sum, p) => sum + known.get(p.modelId).summary.triangles, 0);
  if (triangles > 180000) invalid('Scenery exceeds the 180,000 triangle budget. Use simpler models or fewer instances.');
  const buffer = assembleModelScene([{ id: '__ground', buffer: ground.buffer }, ...models], [{ modelId: '__ground', position: [0, 0, 0] }, ...instances], recipe.name);
  if (buffer.length > 8 * 1024 * 1024) invalid('Scenery preview exceeds 8 MB');
  return { recipe, terrain, models, instances, buffer, summary: { name: recipe.name, models: models.length, instances: instances.length, omitted: requested - instances.length, triangles, size, sizeBytes: buffer.length, origin: context.origin, sky, clearings: context.clearings.length } };
}

function environmentCommands(project, compiled, context, assetIds) {
  const scene = project.scenes.find(s => s.id === project.entryScene) || project.scenes[0];
  const id = `lilly-scenery-${crypto.createHash('sha256').update(scene.id).digest('hex').slice(0, 8)}`;
  const directory = `world/${id}`;
  const file = (name, content) => ({ operation: 'file.upsert', target: { path: name }, payload: { file: { path: name, content: JSON.stringify(content, null, 2) } } });
  const commands = scene.entities.filter(e => e.tags.includes(TAG)).reverse().map(e => ({ operation: 'entity.delete', target: { sceneId: scene.id, entityId: e.id }, payload: {} }));
  const terrain = { ...compiled.terrain, id: `${id}-terrain`, moduleId: id, materialId: `${id}-ground` };
  commands.push(file(`${directory}/${id}.module.json`, { schema: 'LillyGameModule/v1', id, name: compiled.recipe.name, version: '1.0.0', dependencies: [], capabilities: [], systems: [], mechanics: [], prefabs: [], tests: [], materials: ['./ground.material.json'], terrains: ['./ground.terrain.json'], assets: [], animations: [] }), file(`${directory}/ground.material.json`, { schema: 'LillyMaterial/v1', id: `${id}-ground`, moduleId: id, name: `${compiled.recipe.name} ground`, shading: 'standard', color: compiled.recipe.terrain.color, roughness: 0.95, metalness: 0 }), file(`${directory}/ground.terrain.json`, terrain), file(`${directory}/scenery-recipe.json`, compiled.recipe));
  for (const model of compiled.models) commands.push(file(`models/${assetIds[model.id]}.model.json`, model.recipe));
  const entity = (suffix, name, position, components, yaw = 0, scale = 1) => ({ operation: 'entity.create', target: { sceneId: scene.id }, payload: { entity: { schema: 'LillyEntity/v1', id: `${id}-${suffix}`, name, parentId: null, enabled: true, tags: [TAG, 'ai-created'], components: [{ type: 'Transform', enabled: true, data: { position: { x: position[0] + context.origin.x, y: position[1] + context.origin.y, z: position[2] + context.origin.z }, rotation: { x: 0, y: yaw, z: 0 }, scale: { x: scale, y: scale, z: scale } } }, ...components] } } });
  commands.push(entity('terrain', terrain.name, [0, 0, 0], [{ type: 'Terrain', enabled: true, data: { terrainId: terrain.id, walkable: true, collision: true } }]));
  compiled.instances.forEach((p, index) => commands.push(entity(`prop-${index}`, p.name, p.position, [{ type: 'MeshRenderer', enabled: true, data: { assetId: assetIds[p.modelId], geometry: 'box', castShadow: true, receiveShadow: true } }], p.yaw, p.scale)));
  const sky = compiled.recipe.sky;
  commands.push({ operation: 'scene.set-environment', target: { sceneId: scene.id }, payload: { background: sky.color, ambientIntensity: sky.ambient, fog: sky.fog } });
  const sun = scene.entities.find(e => !e.tags.includes(TAG) && component(e, 'Light')?.data.kind === 'directional');
  if (sun) commands.push({ operation: 'component.set', target: { sceneId: scene.id, entityId: sun.id, componentType: 'Light' }, payload: { data: { ...component(sun, 'Light').data, color: sky.sunColor, intensity: sky.sunIntensity } } });
  else commands.push(entity('sun', 'Scenery sunlight', [12, 18, 8], [{ type: 'Light', enabled: true, data: { kind: 'directional', color: sky.sunColor, intensity: sky.sunIntensity, castShadow: true } }]));
  return commands;
}

function environmentPrompt(prompt, context, previous) {
  return `Design a coherent, original stylized 3D environment for Lilly. Return JSON only. Schema: {"schema":"${SCHEMA}","name":"Environment name","seed":"short seed","terrain":{"size":[48,48],"height":4,"color":"#447755","hills":[{"center":[0.6,-0.6],"radius":0.5,"height":0.8}]},"sky":{"color":"#aacddd","ambient":0.8,"sunColor":"#fff0ce","sunIntensity":2.5,"fog":{"color":"#b7d5cd","near":25,"far":85}},"models":[{"id":"tree","recipe":{"schema":"LillyModelRecipe/v1","name":"Tree","parts":[]}}],"scatter":[{"modelId":"tree","count":24,"center":[0,0],"radius":0.9,"scale":[0.8,1.3]}],"placements":[{"modelId":"tree","point":[0.7,-0.5],"yaw":20,"scale":1.5}]}. Design 2–5 distinctive reusable models (trees, rocks, plants, ruins or other scenery fitting the request), each with 3–16 thoughtfully arranged parts. Do not use placeholder cubes. ${modelRecipePrompt('Author each scenery model with cohesive silhouette, color and proportions.')} Each model fits within 16 meters. Terrain size 16–96 meters per side, height 0–12 meters; up to 12 smooth positive hills. Each hill.height MUST be a fraction 0–1 of terrain.height, never a height in meters. Hill center, scatter center and landmark point use normalized x,z -1 to 1 within the patch. All hill and scatter radii are normalized numbers from 0.1 to 1.5 inclusive, never meters or values below 0.1. All instance scales and both ends of scatter scale ranges must be 0.2–3, with min <= max. Sky ambient must be 0.2–2 and sunIntensity 0–5. Fog near must be 5–120 meters; far must be 20–240 meters and greater than near. All colors must be #RRGGBB. Landmark yaw must be -360 to 360 degrees. Check every numeric field against these bounds before returning JSON. Up to 8 scatter groups, 40 instances per group, 96 total. Keep paths and the center clearing open; avoid dense overlapping layouts. Choose daylight, atmosphere, terrain colors and distribution to match the user's setting. The service grounds props on the terrain, protects existing objects, and replaces only earlier Lilly scenery. Context: ${JSON.stringify(context)}. ${previous ? `Previous scenery recipe for continuity: ${JSON.stringify(previous)}.` : ''} User environment request: ${JSON.stringify(prompt)}`;
}

module.exports = { SCHEMA, TAG, sceneryContext, terrainHeight, compileEnvironmentRecipe, environmentCommands, environmentPrompt };
