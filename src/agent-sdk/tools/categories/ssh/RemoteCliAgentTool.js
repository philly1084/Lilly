'use strict';

const { ToolBase } = require('../../ToolBase');
const { remoteCliAgentsSdkRunner } = require('../../../../remote-cli/agents-sdk-runner');

class RemoteCliAgentTool extends ToolBase {
  constructor(options = {}) {
    super({
      id: options.id || 'remote-cli-agent',
      name: options.name || 'Remote CLI Agent',
      description: options.description || 'Run a server-side OpenAI Agents SDK coding agent with the remote-cli Streamable HTTP MCP gateway attached.',
      category: 'ssh',
      version: '1.0.0',
      backend: {
        sideEffects: ['network', 'execute', 'write'],
        sandbox: { network: true },
        timeout: 900000,
      },
      inputSchema: {
        type: 'object',
        required: ['task'],
        properties: {
          task: {
            type: 'string',
            description: 'Coding or deployment task for the remote CLI agent.',
          },
          targetId: {
            type: 'string',
            description: 'Gateway remoteCliTargets targetId. Defaults to REMOTE_CLI_DEFAULT_TARGET_ID or prod.',
          },
          cwd: {
            type: 'string',
            description: 'Allowed working directory on the target. Defaults to REMOTE_CLI_DEFAULT_CWD or the gateway target default.',
          },
          sessionId: {
            type: 'string',
            description: 'Remote coding session ID returned by remote_code_run for continuing prior work.',
          },
          mcpSessionId: {
            type: 'string',
            description: 'Streamable HTTP MCP session ID returned by a prior remote-cli-agent call.',
          },
          waitMs: {
            type: 'integer',
            default: 30000,
            description: 'Initial wait time for long remote_code_run jobs before polling remote_code_status.',
          },
          maxTurns: {
            type: 'integer',
            default: 20,
            description: 'Maximum inner Agents SDK turns for this remote task.',
          },
          maxStatusPolls: {
            type: 'integer',
            default: 20,
            description: 'Maximum compatibility-fallback remote_code_status polls when a chat gateway leaks remote_code_run tool JSON instead of executing the tool loop.',
          },
          adminMode: {
            type: 'boolean',
            default: false,
            description: 'Allow the remote CLI agent to use the configured admin-capable runner lane for real remote change/deploy work. Privileged use remains scoped by runner policy and task instructions.',
          },
          model: {
            type: 'string',
            description: 'Optional model override for the inner OpenAI Agents SDK agent.',
          },
          instructions: {
            type: 'string',
            description: 'Optional additional server-side instructions for the remote coding agent.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          finalOutput: { type: 'string' },
          mcpSessionId: { type: 'string' },
          targetId: { type: 'string' },
          cwd: { type: 'string' },
          sessionId: { type: 'string' },
          remoteCodeSessionId: { type: 'string' },
          gitRepo: { type: 'string' },
          gitCommit: { type: 'string' },
          deployment: { type: 'string' },
          publicHost: { type: 'string' },
          publicUrl: { type: 'string' },
          uiCheckReport: { type: 'string' },
          uiScreenshots: { type: 'array' },
          whatChanged: { type: 'string' },
          verifyCommands: { type: 'array' },
          verifyResults: { type: 'array' },
          blocker: { type: 'string' },
          completionStatus: { type: 'string' },
          model: { type: 'string' },
          apiMode: { type: 'string' },
        },
      },
    });

    this.runner = options.runner || remoteCliAgentsSdkRunner;
  }

  async handler(params, _context, tracker) {
    tracker.recordNetworkCall('remote-cli-mcp', 'CONNECT', {
      targetId: params.targetId || null,
      cwd: params.cwd || null,
    });
    tracker.recordExecution('remote-cli-agent', {
      task: String(params.task || '').slice(0, 200),
    });

    return this.runner.run(params);
  }
}

module.exports = {
  RemoteCliAgentTool,
};
