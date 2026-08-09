'use strict';

const { ToolBase } = require('../../ToolBase');

const ACTIONS = [
  'list-templates',
  'create-project',
  'list-projects',
  'inspect-project',
  'inspect-scene',
  'list-files',
  'read-file',
  'list-assets',
  'upload-asset',
  'write-files',
  'delete-files',
  'compile-project',
  'run-mechanic-tests',
  'instantiate-prefab',
  'refresh-prefab',
  'update-prefab-instance',
  'unpack-prefab',
  'upsert-data-asset',
  'delete-data-asset',
  'upsert-build-profile',
  'delete-build-profile',
  'set-active-build-profile',
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
      version: '3.2.0',
      description: 'Create complete multi-genre browser games as versioned Lilly projects. Author linked prefab instances and variants, shared gameplay data assets, component controllers, typed capability-sandboxed modules, deterministic tests, scenes, Blueprints, assets, animation, and terrain; select versioned development or release build profiles; then build immutable players, publish, and roll back.',
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
          template: { type: 'string', enum: ['blank', 'third-person-explorer', 'top-down-action', 'expedition'] },
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
          dataAssetId: { type: 'string', maxLength: 80 },
          buildProfileId: { type: 'string', maxLength: 80 },
          parentId: { type: 'string', maxLength: 120 },
          config: {
            type: 'object',
            description: 'Strict prefab instance overrides: optional variant, position Vector3, and entities keyed by source entity id with name, enabled, tags, or existing component data patches.',
          },
          dataAsset: {
            type: 'object',
            description: 'A LillyDataAsset/v1 shared gameplay configuration, stats, table, dialogue, or custom data object.',
          },
          buildProfile: {
            type: 'object',
            description: 'A LillyBuildProfile/v1 browser target with scene, renderer, mode, quality, debug, and mobile-control settings.',
          },
          filename: { type: 'string', maxLength: 120 },
          mimeType: { type: 'string', enum: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'image/jpeg', 'image/png', 'image/webp', 'model/gltf-binary', 'model/gltf+json', 'application/octet-stream'] },
          contentBase64: { type: 'string', maxLength: 9500000, description: 'Canonical Base64 only. The AI tool JSON lane is capped below the platform 10 MiB request envelope; the browser editor uses the separate raw-binary 8 MiB asset route.' },
          metadata: {
            type: 'object',
            properties: {
              upAxis: { type: 'string', enum: ['Y', 'Z'] },
              unitsPerMeter: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            },
            additionalProperties: false,
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
