'use strict';

// Invoked only inside lilly-computer-proof's disposable, network-none container.
// Actual Grok ACP/MCP execution; scripted inference, not model perception.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { GrokBuildAcpClient } = require('../src/grok-build/acp-client');
const { modelConfig } = require('../src/grok-build/kubernetes-supervisor');
const { GrokWorkerBroker } = require('../src/agent-teams/worker-broker');
const { createTaskMcpBridge } = require('../src/grok-build/task-mcp-bridge');

function imageUrls(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (value.type === 'input_image') output.push(value.image_url);
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object') imageUrls(nested, output);
  return output;
}

function discoveredToolName(input, suffix) {
  assert(['observe', 'act'].includes(suffix));
  const names = [...new Set([...JSON.stringify(input).matchAll(new RegExp(`([A-Za-z0-9_.:-]+__lilly_browser_${suffix})`, 'g'))].map(match => match[1]))];
  assert.equal(names.length, 1, 'Exactly one discovered browser tool is required.');
  return names[0];
}

async function runGrokBrowser({ runtime, identity, first, getClicks, report }) {
  assert.equal(process.pid, 1); assert.equal(process.getuid(), 10001);
  const state = report.grok = { inference: 'scripted', externalModelCalls: 0, taskRequests: 0, auxiliaryRequests: 0,
    modelRequests: 0, toolCalls: [], activity: [], checks: [] };
  report.modelInference = 'scripted';
  const origin = 'http://127.0.0.1:3001'; const model = 'lilly-fixture';
  const scope = { ...identity, taskId: identity.claim.taskId };
  let client; let bridge; let broker; let lease; let second; let beforeImage; let afterImage; let names;
  const digest = url => createHash('sha256').update(Buffer.from(url.split(',')[1], 'base64')).digest('hex');
  const textItem = (id, text) => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const callItem = (round, name, args) => ({ id: `browser_fc_${round}`, type: 'function_call', call_id: `browser_call_${round}`,
    name, arguments: JSON.stringify(args), status: 'completed' });
  try {
    broker = new GrokWorkerBroker({ baseUrl: origin, authorize: async () => true, modelRequest: async body => {
      report.modelCalls = ++state.modelRequests;
      const round = body.tools?.some(tool => tool.name === 'search_tool') ? ++state.taskRequests : 0;
      let item;
      if (!round) {
        assert(++state.auxiliaryRequests <= 3);
        item = textItem(`aux_${state.auxiliaryRequests}`, 'Private browser integration fixture.');
      } else if (round === 1) {
        item = callItem(round, 'search_tool', { query: 'lilly_browser', limit: 5 });
      } else if (round === 2) {
        names = { observe: discoveredToolName(body.input, 'observe'), act: discoveredToolName(body.input, 'act') };
        item = callItem(round, 'use_tool', { tool_name: names.observe, tool_input: {} });
      } else if (round === 3) {
        assert(beforeImage && imageUrls(body.input).includes(beforeImage), 'Real browser pixels must reach Grok model input.');
        assert(JSON.stringify(body.input).includes(first.frameId), 'Current frame identity must reach Grok model input.');
        state.checks.push('actual_browser_pixels_reach_grok_model_request');
        item = callItem(round, 'use_tool', { tool_name: names.act,
          tool_input: { computerId: first.computerId, frameId: first.frameId, action: { type: 'click', selector: '#confirm' } } });
      } else if ((round === 4 || round === 5) && second) {
        assert(afterImage && imageUrls(body.input).includes(afterImage), 'Post-action pixels must return to Grok.');
        assert.notEqual(afterImage, beforeImage); assert.equal(getClicks(), 1);
        if (round === 4) state.checks.push('grok_tool_action_changes_real_browser', 'post_action_pixels_reach_next_grok_request');
        item = textItem(`final_${round}`, 'The fixture click is independently confirmed.');
      } else throw new Error('Unexpected scripted browser model request.');
      const response = { id: `browser_response_${round}_${state.auxiliaryRequests}`, object: 'response', created_at: 1788756000,
        model, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      if (!body.stream) return response;
      return (async function* () {
        yield { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } };
        yield { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item,
          ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } };
        if (item.type === 'function_call') yield { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: item.id, output_index: 0, delta: item.arguments };
        else yield { type: 'response.output_text.delta', sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text };
        yield { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item };
        yield { type: 'response.completed', sequence_number: 4, response };
      })();
    } });
    await broker.listen({ host: '127.0.0.1', port: 3001 });
    lease = broker.open(scope, { model, deadlineMs: 60000, maxModelCalls: 8 });
    fs.mkdirSync('/grok-state/.grok', { recursive: true, mode: 0o700 });
    fs.writeFileSync('/grok-state/.grok/config.toml', modelConfig({ ...scope, model, modelEndpoint: lease.modelEndpoint,
      modelToken: lease.modelToken }, origin), { mode: 0o600, flag: 'wx' });
    const tools = [
      { type: 'function', name: 'lilly_browser_observe', description: 'Return the current private browser frame.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } },
      { type: 'function', name: 'lilly_browser_act', description: 'Click the authored fixture using the current private frame.',
        parameters: { type: 'object', properties: { computerId: { type: 'string' }, frameId: { type: 'string' },
          action: { type: 'object', properties: { type: { const: 'click' }, selector: { const: '#confirm' } }, required: ['type', 'selector'], additionalProperties: false } },
        required: ['computerId', 'frameId', 'action'], additionalProperties: false } },
    ];
    bridge = await createTaskMcpBridge({ tools, deadlineMs: 60000, maxCalls: 2, onEvent: event => state.activity.push(event),
      dispatch: async (name, args, { signal }) => {
        state.toolCalls.push(name);
        if (name === 'lilly_browser_observe') {
          assert.deepEqual(state.toolCalls, ['lilly_browser_observe']);
          const parts = await runtime.getModelInput(identity, { ...first, signal });
          beforeImage = imageUrls(parts)[0]; assert(beforeImage);
          return { publicResult: { success: true, ...first }, privateModelContent: parts };
        }
        assert.deepEqual(state.toolCalls, ['lilly_browser_observe', 'lilly_browser_act']);
        assert.equal(args.frameId, first.frameId); assert.equal(args.computerId, first.computerId);
        second = await runtime.act(identity, { ...args, signal });
        const until = Date.now() + 2000;
        while (getClicks() !== 1 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(getClicks(), 1);
        // Explicit re-observation covers the asynchronous fixture POST/DOM update.
        second = await runtime.observe(identity, { ...second, signal });
        const parts = await runtime.getModelInput(identity, { ...second, signal });
        afterImage = imageUrls(parts)[0]; assert(afterImage);
        return { publicResult: { success: true, ...second }, privateModelContent: parts };
      } });
    client = new GrokBuildAcpClient({ executable: '/grok-bin/xai-grok-pager', cwd: '/grok-work', home: '/grok-state',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LILLY_MODEL_API_KEY: lease.modelToken }, requestTimeoutMs: 15000, promptTimeoutMs: 45000 });
    await client.start({ authMethodId: 'xai.api_key' });
    const descriptor = lease.connectBridge(bridge.mcpServer);
    client.setTaskMcpPermissions({ serverName: descriptor.name, toolNames: tools.map(tool => tool.name) });
    const session = await client.openSession({ mcpServers: [descriptor] });
    state.sessionCreated = Boolean(session.sessionId);
    await bridge.waitForCatalog({ timeoutMs: 10000 });
    const result = await client.prompt('Run the private browser observation and current-frame click tools. Verify the resulting frame. This is a scripted, isolated integration fixture.');
    state.stopReason = result.stopReason; assert.equal(result.stopReason, 'end_turn');
    assert.equal(state.checks.length, 3); assert.equal(getClicks(), 1);
    assert(!JSON.stringify(state.activity).includes('data:image'));
    for (const url of [beforeImage, afterImage]) assert(!JSON.stringify(state.activity).includes(url.split(',')[1]));
    state.frameHashes = [beforeImage, afterImage].map(digest);
    state.checks.push('operator_activity_contains_no_frame_pixels');
    assert.equal((await bridge.close()).settled, true); lease.close();
    const revoked = await fetch(`${lease.modelEndpoint}/responses`, { method: 'POST', headers: {
      Authorization: `Bearer ${lease.modelToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(revoked.status, 401); await revoked.arrayBuffer();
    state.checks.push('grok_browser_lease_revoked');
    state.passed = true;
    return second;
  } finally {
    // ACP close is not a descendant-exit proof. The outer supervisor removes
    // the exact whole container before accepting this report.
    client?.close(); await bridge?.close(); lease?.close(); await broker?.close();
  }
}

module.exports = { runGrokBrowser, imageUrls, discoveredToolName };
