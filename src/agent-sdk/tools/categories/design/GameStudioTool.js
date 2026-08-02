'use strict';

const { ToolBase } = require('../../ToolBase');

const ACTIONS = [
  'create-project',
  'list-projects',
  'inspect-project',
  'inspect-scene',
  'list-files',
  'read-file',
  'write-files',
  'delete-files',
  'compile-project',
  'run-mechanic-tests',
  'instantiate-prefab',
  'generate-level',
  'apply-commands',
  'edit-blueprint',
  'run-playtest',
  'build',
  'publish',
  'rollback',
];

class GameStudioTool extends ToolBase {
  constructor() {
    super({
      id: 'game-studio',
      name: 'Lilly Game Studio',
      category: 'design',
      version: '2.0.0',
      description: 'Create complete browser games as versioned Lilly projects. Agents can author typed multi-file modules (.module.json, .mechanic.json, .system.ts, .prefab.json, .spec.json), compile capability-sandboxed systems, run deterministic mechanic tests, compose scenes and Blueprints through revision-safe commands, build immutable players, publish, and roll back.',
      backend: {
        handler: async (params = {}, context = {}) => {
          const gameStudioService = context.gameStudioService;
          if (!gameStudioService?.isEnabled?.()) {
            const error = new Error('Lilly Game Studio is disabled or unavailable');
            error.code = 'GAME_STUDIO_UNAVAILABLE';
            throw error;
          }
          return gameStudioService.executeToolAction(params.action, params, context);
        },
        sideEffects: ['read', 'write', 'execute', 'network'],
        timeout: 120000,
      },
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS },
          name: { type: 'string', maxLength: 100 },
          slug: { type: 'string', maxLength: 60 },
          template: { type: 'string', enum: ['blank', 'expedition'] },
          projectId: { type: 'string' },
          sceneId: { type: 'string' },
          buildId: { type: 'string' },
          baseRevision: { type: 'integer', minimum: 1 },
          revision: { type: 'integer', minimum: 1 },
          projectRevision: { type: 'integer', minimum: 1 },
          commands: { type: 'array', items: { type: 'object' }, maxItems: 100 },
          files: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['path', 'content'],
              properties: {
                path: { type: 'string', maxLength: 180 },
                content: { type: 'string', maxLength: 131072 },
                enabled: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          path: { type: 'string', maxLength: 180 },
          paths: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 180 } },
          testIds: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 100 } },
          executionBudgetMs: { type: 'integer', minimum: 1, maximum: 100 },
          prefabId: { type: 'string', maxLength: 100 },
          instanceId: { type: 'string', maxLength: 80 },
          parentId: { type: 'string', maxLength: 120 },
          config: {
            type: 'object',
            description: 'Strict prefab instance overrides: optional position Vector3 and entities keyed by source entity id with name, enabled, tags, or existing component data patches.',
          },
          graph: { type: 'object' },
          prompt: { type: 'string' },
          seed: { type: 'string', maxLength: 120 },
          difficulty: { type: 'integer', minimum: 1, maximum: 5 },
          publicHost: { type: 'string' },
          fixedSteps: { type: 'integer', minimum: 1, maximum: 3600 },
          sessionId: { type: 'string' },
        },
        additionalProperties: false,
      },
    });
  }
}

module.exports = {
  ACTIONS,
  GameStudioTool,
};
