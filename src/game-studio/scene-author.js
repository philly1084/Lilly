'use strict';

const { applyCommandBatch, COMPONENT_DEFINITIONS, createProjectFromTemplate } = require('../../packages/lilly-engine/dist/core/src');
const { invalid } = require('./game-plan');

const SCENE_OPERATIONS = ['scene.create', 'scene.rename', 'scene.set-environment', 'entity.create', 'component.set', 'input.replace', 'project.set-entry-scene', 'project.set-settings'];
function sceneAuthorPrompt(plan, project) {
  const reference = createProjectFromTemplate({ id: 'syntax-reference', template: 'third-person-explorer' });
  const examples = reference.scenes[0].entities.filter(entity => ['player', 'camera', 'sun', 'ground'].includes(entity.id));
  const commandExamples = examples.map(entity => ({ operation: 'entity.create', target: { sceneId: project.entryScene }, payload: { entity } }));
  const defaults = Object.fromEntries(Object.entries(COMPONENT_DEFINITIONS).map(([name, definition]) => [name, definition.defaults]));
  return `You are Lilly's original scene builder. Build the spatial foundation of ${plan.name} from this EMPTY editable project. Do not generate an expedition or substitute a template. Return JSON only {commands:[...]}, using 1–100 commands from ${JSON.stringify(SCENE_OPERATIONS)}. Design: ${JSON.stringify(plan)}. Scene brief: ${plan.scenePrompt}. Current project: ${JSON.stringify(project)}. Every entry scene needs an enabled player-tagged entity with the supported CharacterController for movement, a visible MeshRenderer, an enabled primary Camera, a ground/collision surface where appropriate, and a real Move axis2d binding for keyboard and touch. Set runtimeProfile module-driven. The next programmer authors the full rules and HUD; create stable entity ids and semantic tags they can query. Create all targetEntityId placeholders named in the asset plan. For physics-driven games use native components with appropriate colliders. Aim for the requested camera and geometry, not a generic room chain. Every command is a flat object with operation, target and payload fields; never use the operation name as an object key. Complete command examples illustrate valid syntax ONLY; compose your own world: ${JSON.stringify(commandExamples)}. Exact component defaults: ${JSON.stringify(defaults)}. Commands: entity.create uses target:{sceneId} and payload:{entity:{schema:'LillyEntity/v1',id,name,parentId:'world',enabled:true,tags:[],components:[{type,enabled:true,data}]}}. scene.rename uses target:{sceneId},payload:{name}. component.set uses target:{sceneId,entityId,componentType},payload:{data,enabled:true}. input.replace uses target:{},payload:{inputMap:[{action:'Move',kind:'axis2d',keys:['KeyW','KeyS','KeyA','KeyD']},{action:'Reset',kind:'button',keys:['KeyR']}]} preserving useful action bindings. project.set-settings uses target:{},payload:{runtimeProfile:'module-driven',mobileMode:'author-play'}. Do not invent component types or data fields.`;
}
function validateSceneCommands(studio, project, commands, plan) {
  if (!Array.isArray(commands)) throw invalid('Return a JSON object with a commands array. Each command needs operation, target and payload fields.');
  if (!commands.length || commands.length > 100) throw invalid(`Scene author returned ${commands.length} commands; use 1–100 commands. Combine related geometry into fewer entities.`);
  const unsupported = commands.findIndex(command => !SCENE_OPERATIONS.includes(command?.operation));
  if (unsupported !== -1) throw invalid(`Scene command ${unsupported + 1} uses unsupported operation ${JSON.stringify(String(commands[unsupported]?.operation || '(missing)').slice(0, 100))}. Allowed operations: ${SCENE_OPERATIONS.join(', ')}. Use the field operation, not op or action.`);
  const candidate = applyCommandBatch(project, studio.normalizeCommands(project, commands, project.revision), project.revision).project;
  validatePlayableScene(candidate, plan);
  return candidate;
}
function validatePlayableScene(candidate, plan) {
  if (candidate.settings.runtimeProfile !== 'module-driven') throw invalid('Authored games must retain the module-driven runtime; implement the actual requested rules.');
  const scene = candidate.scenes.find(entry => entry.id === candidate.entryScene);
  const enabled = entity => entity.enabled !== false;
  const component = (entity, type) => entity.components.find(c => c.type === type && c.enabled !== false);
  const player = scene.entities.find(entity => enabled(entity) && entity.tags.includes('player'));
  if (!player || !component(player, 'MeshRenderer') || !component(player, 'CharacterController')) throw invalid('Create a visible, enabled player with a supported native controller.');
  if (!scene.entities.some(entity => enabled(entity) && component(entity, 'Camera')?.data.primary === true)) throw invalid('Create an enabled primary camera in the entry scene.');
  if (component(player, 'CharacterController').data.moveAction !== 'Move' || !candidate.inputMap.some(binding => binding.action === 'Move' && binding.kind === 'axis2d' && new Set(binding.keys).size === 4)) throw invalid('Bind four distinct keyboard keys to the Move axis and use it for the player controller.');
  for (const asset of plan.assets) if (asset.targetEntityId && !scene.entities.some(entity => entity.id === asset.targetEntityId && component(entity, 'MeshRenderer'))) throw invalid(`Create a MeshRenderer placeholder with id ${asset.targetEntityId} for ${asset.name}.`);
  return candidate;
}
module.exports = { SCENE_OPERATIONS, sceneAuthorPrompt, validateSceneCommands, validatePlayableScene };
