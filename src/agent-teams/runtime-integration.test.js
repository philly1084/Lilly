'use strict';

// Integration fixture: real broker/MCP HTTP and team runtime, scripted worker
// and in-memory persistence. This is NOT a real Grok/model/cluster proof.
const { EventEmitter } = require('events');
const { createHash, randomUUID } = require('crypto');
const os = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createTeamRuntime } = require('./runtime');
const { TestStore } = require('./test-store');

afterEach(() => jest.restoreAllMocks());

test('Grok runtime adapter crosses dedicated broker, saves real fixture bytes, and closes its worker', async () => {
  const records = new Map();
  let runtime; let privateScope; let wireDescriptor; let address; let modelCalls = 0;
  // Emulate Downward API + owning network namespace, without disabling any
  // runtime validation or changing the broker's production endpoint contract.
  jest.spyOn(os, 'networkInterfaces').mockReturnValue({ eth0: [{ address: '10.42.1.17', family: 'IPv4', internal: false }] });
  const localWorkerUrl = value => {
    const url = new URL(value);
    expect(url.origin).toBe('http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001');
    // Scripted worker's test transport models its Pod hostAlias; the real
    // broker listener and SDK remain HTTP, but no cluster network is contacted.
    return new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${address.port}`);
  };
  const close = jest.fn(async () => {});
  const grokWorkerFactory = async (scope) => {
    privateScope = scope;
    const client = new EventEmitter();
    Object.assign(client, {
      start: async () => ({ agentCapabilities: { mcpCapabilities: { http: true } } }),
      setTaskMcpPermissions: jest.fn(),
      openSession: async ({ mcpServers }) => {
        wireDescriptor = mcpServers[0];
        const discovery = new Client({ name: 'scripted-grok-discovery', version: '1.0.0' });
        try {
          await discovery.connect(new StreamableHTTPClientTransport(localWorkerUrl(wireDescriptor.url), {
            requestInit: { headers: { Authorization: wireDescriptor.headers[0].value } },
          }));
          expect((await discovery.listTools()).tools.some(tool => tool.name === 'artifact_write')).toBe(true);
        } finally { await discovery.close(); }
        return { sessionId: 'persistent-upstream-id' };
      },
      prompt: async () => {
        const model = await fetch(localWorkerUrl(`${scope.modelEndpoint}/responses`), { method: 'POST',
          headers: { Authorization: `Bearer ${scope.modelToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: scope.model, input: 'Write the bounded deliverable.' }) });
        expect(model.status).toBe(200);
        const call = (await model.json()).output[0];
        const toolClient = new Client({ name: 'scripted-grok', version: '1.0.0' });
        try {
          await toolClient.connect(new StreamableHTTPClientTransport(localWorkerUrl(wireDescriptor.url), {
            requestInit: { headers: { Authorization: wireDescriptor.headers[0].value } },
          }));
          const result = await toolClient.callTool({ name: call.name, arguments: JSON.parse(call.arguments) });
          expect(result.isError).not.toBe(true);
          const saved = JSON.parse(result.content[0].text);
          client.emit('update', { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Saved ${saved.id}` } } });
        } finally { await toolClient.close(); }
        return { stopReason: 'end_turn' };
      }, cancel: () => {}, close: () => {},
    });
    return { client, close, saveSession: (id) => runtime.service.saveEngineSession(scope, id) };
  };
  runtime = createTeamRuntime({
    environment: { LILLY_TEAMS_ENGINE: 'grok-build', LILLY_TEAMS_BROKER_POD_IP: '10.42.1.17',
      LILLY_TEAMS_BROKER_POD_UID: '01234567-89ab-4cde-8fab-0123456789ab', LILLY_TEAMS_BROKER_POD_NAME: 'backend-fixture',
      LILLY_TEAMS_BROKER_POD_NAMESPACE: 'kimibuilt' }, store: new TestStore(), defaultModel: 'approved', grokWorkerFactory,
    sessionStore: { getOrCreateOwned: async (id, metadata) => ({ id, metadata }) },
    artifactService: {
      createStoredArtifact: async (input) => {
        const item = { ...input, id: input.reservedArtifactId || randomUUID(), contentBuffer: input.buffer,
          sha256: createHash('sha256').update(input.buffer).digest('hex') };
        records.set(item.id, item); return item;
      },
      getArtifact: async (id) => records.get(id),
    },
    getModelClient: () => ({ responses: { create: async () => {
      modelCalls += 1;
      return { output: [{ type: 'function_call', name: 'artifact_write', arguments: JSON.stringify({ filename: 'result.md', content: 'Verified fixture output.' }) }] };
    } } }),
  });
  address = await runtime.broker.listen({ host: '127.0.0.1', port: 0 });
  try {
    const team = await runtime.service.create('owner', { name: 'Integrated', objective: 'Save an output.' });
    const command = (action, input) => runtime.service.ownerCommand(team.id, 'owner', action, input, randomUUID());
    await command('configure_execution', { enabled: true });
    const agent = await command('create_agent', { name: 'Builder', job: 'Save artifacts.' });
    await command('assign_task', { agentId: agent.id, title: 'Write', instruction: 'Save a result.' });
    await runtime.runner.tick();
    await Promise.all([...runtime.runner.active.values()].map((entry) => entry.done));
    const state = await runtime.service.get(team.id, 'owner');
    expect(state.tasks[0].status).toBe('needs_review');
    expect(state.tasks[0].result.artifacts).toHaveLength(1);
    expect([...records.values()][0].contentBuffer.toString()).toBe('Verified fixture output.');
    expect(state.agents[0].engineSession.sessionId).toBe('persistent-upstream-id');
    expect(modelCalls).toBe(1); expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state)).not.toContain(privateScope.modelToken);
    expect(wireDescriptor.url).toContain('/api/agent-team-workers/');
    expect(runtime.broker.leases.size).toBe(0);
  } finally { await runtime.stop(); }
});
