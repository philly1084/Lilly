'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AgentOrchestrator } = require('../agent-sdk/AgentOrchestrator');
const { ToolDefinition } = require('../agent-sdk/tools/ToolDefinition');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');

async function execute({ prompt, workspace, actions = [], recentMessages = [], injectTransientFailure = false }) {
  const root = await fs.realpath(workspace);
  const resolveFile = async (name) => {
    const target = await fs.realpath(path.resolve(root, name));
    if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target))) {
      throw new Error('File is outside the isolated evaluation workspace');
    }
    return target;
  };
  let failures = 0;
  const orchestrator = new AgentOrchestrator({
    llmClient: { complete: async (input) => extractResponseText(await createResponse({
      input, stream: false, enableAutomaticToolCalls: false, maxOutputTokens: 1500,
    })) },
    embedder: { embed: async () => { throw new Error('Memory disabled for isolated trials'); } },
    config: { enableSkills: false, enableConversationAgentExecutor: true },
  });
  orchestrator.registerTool(new ToolDefinition({
    id: 'file-read', name: 'Read file', description: 'Read an existing UTF-8 file in the assigned workspace.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    handler: async ({ path: name }) => ({ content: await fs.readFile(await resolveFile(name), 'utf8') }),
  }));
  orchestrator.registerTool(new ToolDefinition({
    id: 'file-edit', name: 'Replace exact text', description: 'Replace one exact occurrence in an existing file. Returns changed=true only after writing and reading back the result. Transient failures may be retried.',
    inputSchema: { type: 'object', required: ['path', 'oldText', 'newText'], properties: {
      path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' },
    } },
    handler: async ({ path: name, oldText, newText }) => {
      if (injectTransientFailure && failures++ === 0) throw new Error('Temporary connection timeout; retry the same edit');
      const target = await resolveFile(name);
      const before = await fs.readFile(target, 'utf8');
      if (!oldText || before.split(oldText).length !== 2) throw new Error('Expected exactly one matching text occurrence');
      const after = before.replace(oldText, newText);
      await fs.writeFile(target, after);
      return { changed: (await fs.readFile(target, 'utf8')) === after };
    },
  }));
  const result = await orchestrator.executeConversation({
    sessionId: crypto.randomUUID(), input: prompt, recentMessages,
    instructions: ['Complete the requested edit using the listed tools. Preserve unrelated content.',
      ...actions.map((entry) => String(entry.content || ''))].join('\n'),
    stream: false, useAgentExecutor: true,
  });
  return { runId: result.task?.id || crypto.randomUUID(), status: result.success ? 'completed' : 'failed',
    output: result.output, repeatedFailures: Math.max(0, failures - 1), costUsd: null };
}

module.exports = { execute };
