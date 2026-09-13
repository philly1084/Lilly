'use strict';
const { createClient, projectSnapshot, computerCheckpoints } = require('./team-client');
const snapshot = () => ({ schemaVersion: 1, generatedAt: '2026-09-06T12:00:00Z', team: { id: 'team-1', name: 'Real team', objective: 'Build a verified artifact', limits: { maxAgents: 6, concurrency: 3 } },
  execution: { enabled: false, model: null, toolIds: [], origins: [], maxCalls: 24, maxTimeMs: 120000 },
  agents: [{ id: 'builder', name: 'Mira', role: 'specialist', job: 'Build', persona: 'Careful', enabled: true, status: 'queued', currentTaskId: 'task-1' }],
  tasks: [{ id: 'task-1', agentId: 'builder', title: 'Build artifact', status: 'queued' }], messages: [], events: [{ id: 'e1', agentId: 'builder', type: 'tool_started', tool: 'artifact_write', at: '2026-09-06T12:00:00Z' }], notes: [], artifacts: [], skills: [], routines: [] });
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function storage() { const map = new Map(); return { getItem: (key) => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) }; }

describe('persistent team client', () => {
  test('returns activity before optional metadata and publishes each verified artifact independently', async () => {
    const data = snapshot(); const replies = new Map(); const updates = [];
    data.artifacts = ['a1', 'a2'].map(id => ({ id, sha256: 'a'.repeat(64) }));
    const fetcher = jest.fn(async url => url.startsWith('/api/artifacts/')
      ? new Promise(resolve => replies.set(url.split('/').at(-1), resolve))
      : response(url.endsWith('/runtime') ? {} : data));
    const client = createClient({ fetch: fetcher }); const loaded = await client.load('team-1');
    expect(loaded.snapshot).toBe(data); expect(replies.size).toBe(0);
    const pending = loaded.loadMetadata(() => updates.push(loaded.metadata.size));
    expect(loaded.loadMetadata()).toBe(pending);
    replies.get('a2')(response({ id: 'a2', sha256: 'a'.repeat(64) }));
    await new Promise(resolve => setImmediate(resolve));
    expect(updates).toEqual([1]);
    replies.get('a1')(response({ id: 'a1', sha256: 'a'.repeat(64) })); await pending;
    expect(updates).toEqual([1, 2]);
  });

  test('late cancelled metadata is neither cached nor published', async () => {
    const data = snapshot(); data.artifacts = [{ id: 'a1', sha256: 'a'.repeat(64) }];
    let release; const controller = new AbortController(); const update = jest.fn();
    const fetcher = jest.fn(async url => url.startsWith('/api/artifacts/')
      ? new Promise(resolve => { release = resolve; }) : response(url.endsWith('/runtime') ? {} : data));
    const client = createClient({ fetch: fetcher });
    const loaded = await client.load('team-1', controller.signal);
    const pending = loaded.loadMetadata(update); controller.abort(); client.cancelMetadata();
    release(response({ id: 'a1', sha256: 'a'.repeat(64) })); await pending;
    expect(loaded.metadata.size).toBe(0); expect(update).not.toHaveBeenCalled();
  });

  test('a slow file read survives multiple activity refreshes without duplicate requests', async () => {
    const data = snapshot(); data.artifacts = [{ id: 'a1', sha256: 'a'.repeat(64) }];
    let release; const controller = new AbortController(); const oldUpdate = jest.fn(); const newUpdate = jest.fn();
    const fetcher = jest.fn(async url => url.startsWith('/api/artifacts/')
      ? new Promise(resolve => { release = resolve; }) : response(url.endsWith('/runtime') ? {} : data));
    const client = createClient({ fetch: fetcher }); const first = await client.load('team-1', controller.signal);
    const old = first.loadMetadata(oldUpdate); controller.abort();
    const next = await client.load('team-1'); const current = next.loadMetadata(newUpdate);
    expect(fetcher.mock.calls.filter(([url]) => url.startsWith('/api/artifacts/'))).toHaveLength(1);
    release(response({ id: 'a1', sha256: 'a'.repeat(64) })); await Promise.all([old, current]);
    expect(oldUpdate).not.toHaveBeenCalled(); expect(newUpdate).toHaveBeenCalledTimes(1);
    expect(next.metadata.size).toBe(1);
  });

  test('computer checkpoints are bounded fixed-label history without private event fields', () => {
    const events = Array.from({ length: 30 }, (_, index) => ({ tool: 'computer_observe', type: 'tool_finished', at: `2026-09-07T12:00:${String(index).padStart(2, '0')}Z`,
      title: 'PRIVATE_PAGE', url: 'https://private.example', args: 'PRIVATE_ARGS', result: 'data:image/png;base64,PRIVATE', callId: 'PRIVATE_CALL' }));
    events.push({ tool: 'constructor', type: 'tool_started' }, { tool: 'computer_open', type: 'unknown' }, { tool: 'artifact_write', type: 'tool_finished' });
    const checkpoints = computerCheckpoints(events);
    expect(checkpoints).toHaveLength(24);
    expect(checkpoints[0]).toEqual({ title: 'Observe private browser · finished', timestamp: '2026-09-07T12:00:29Z' });
    expect(JSON.stringify(checkpoints)).not.toMatch(/PRIVATE|private.example|data:image|callId/);
    expect(computerCheckpoints([{ tool: 'computer_act', type: 'tool_failed', at: 'invalid' }])).toEqual([{ title: 'Act in private browser · failed', timestamp: null }]);
  });

  test('computer history remains agent-scoped and does not claim a live browser when execution stops', () => {
    const data = snapshot();
    data.events.push({ agentId: 'other-agent', tool: 'computer_open', type: 'tool_started' },
      { agentId: 'builder', tool: 'computer_act', type: 'tool_failed', at: data.generatedAt });
    const browser = projectSnapshot(data, { visionEnabled: false }).workspaces.get('builder').privateBrowser;
    expect(browser.signals).toEqual([{ title: 'Act in private browser · failed', timestamp: data.generatedAt }]);
    expect(browser.status).toBe('Recorded browser activity · current browser state not reported');
    expect(browser.exposedToOperator).toBe(false);
  });
  test('retains command receipt across uncertain retry and page reload with JSON headers intact', async () => {
    const saved = storage();
    const fetcher = jest.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(response({ result: { id: 'agent' } }));
    const first = createClient({ fetch: fetcher, storage: saved, uuid: () => 'first-key' });
    await expect(first.command('team-1', 'create_agent', { name: 'Mira' })).rejects.toThrow('Connection lost');
    const second = createClient({ fetch: fetcher, storage: saved, uuid: () => 'different-key' });
    await second.command('team-1', 'create_agent', { name: 'Mira' });
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe(fetcher.mock.calls[1][1].headers['Idempotency-Key']);
    expect(fetcher.mock.calls[1][1].headers['Content-Type']).toBe('application/json');
    expect(fetcher.mock.calls[1][1].credentials).toBe('same-origin');
  });

  test('creation retries use a stable idempotency key and never configure execution', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(response({ teams: [] })).mockRejectedValueOnce(new Error('uncertain')).mockResolvedValueOnce(response({ id: 'team-1' }));
    const client = createClient({ fetch: fetcher, storage: storage(), uuid: () => 'create-key' });
    const input = { name: 'Team', objective: 'Outcome' };
    await expect(client.create(input)).rejects.toThrow('uncertain');
    expect(await client.create(input)).toEqual({ id: 'team-1' });
    const writes = fetcher.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0][1].headers['Idempotency-Key']).toBe(writes[1][1].headers['Idempotency-Key']);
    expect(writes.every(([url]) => url === '/api/agent-teams')).toBe(true);
    expect(JSON.parse(writes[0][1].body)).not.toHaveProperty('enabled');
  });

  test('persisted retry keys contain no private memory content or command payload', async () => {
    const saved = { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() };
    const fetcher = jest.fn().mockRejectedValue(new Error('Uncertain write'));
    const client = createClient({ fetch: fetcher, storage: saved, uuid: () => 'opaque-receipt' });
    await expect(client.command('team-1', 'remember', { agentId: 'a', scope: 'private', content: 'Private sensitive fact', source: 'Private source' })).rejects.toThrow();
    expect(saved.setItem).toHaveBeenCalled();
    expect(JSON.stringify(saved.setItem.mock.calls)).not.toMatch(/sensitive|Private|remember|agentId/);
    expect(saved.setItem.mock.calls[0][0]).toMatch(/^lilly-team-command:[a-f0-9]{64}$/);
  });

  test('reads allowlisted workroom projection, not raw team execution state', async () => {
    const fetcher = jest.fn(async (url) => response(url.endsWith('/runtime') ? { enabled: false } : snapshot()));
    const client = createClient({ fetch: fetcher });
    const loaded = await client.load('team-1');
    expect(loaded.snapshot.team.name).toBe('Real team');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/agent-teams/team-1/workroom', '/api/agent-teams/runtime']);
  });

  test('queued/review/reconciling do not masquerade as running and artifacts need actual metadata', () => {
    const data = snapshot();
    data.artifacts.push({ id: 'a1', sha256: 'hash', taskId: 'task-1', agentId: 'builder', reviewStatus: 'needs_review' });
    const projected = projectSnapshot(data, { enabled: false, visionEnabled: false });
    expect(projected.overview.groups.working).toEqual([]);
    expect(projected.overview.groups.needsInput[0].status).toBe('queued');
    expect(projected.overview.goalItems[0].boardColumn).toBe('waiting');
    expect(projected.overview.artifacts[0]).not.toHaveProperty('downloadUrl');
    expect(projected.workspaces.get('builder').terminal[0]).toMatchObject({ command: 'tool_started · artifact_write', output: '' });
    expect(projected.workspaces.get('builder').privateBrowser.status).toBe('Unavailable');
  });

  test('wait and stale heartbeat leave the working group while task execution stays running', () => {
    const data = snapshot(); data.agents[0].status = 'running'; data.tasks[0].status = 'running';
    data.agents[0].activity = { kind: 'waiting_for_team' };
    let view = projectSnapshot(data, { enabled: true });
    expect(view.overview.groups.working).toEqual([]);
    expect(view.overview.groups.needsInput[0]).toMatchObject({ status: 'waiting_for_team', currentAction: 'Waiting for teammate' });
    data.agents[0].activity = { kind: 'unconfirmed' };
    view = projectSnapshot(data, { enabled: true });
    expect(view.overview.groups.needsInput[0].currentAction).toBe('Heartbeat unconfirmed');
    expect(data.tasks[0].status).toBe('running');
    data.agents[0].activity = { kind: 'using_tool', tool: 'artifact_read' };
    expect(projectSnapshot(data).overview.groups.working[0].currentAction).toBe('Using tool · artifact_read');
  });

  test.each([{ id: 'other', sha256: 'a'.repeat(64) }, { id: 'a1', sha256: 'b'.repeat(64) }])('does not link mismatched artifact metadata %j', async (item) => {
    const data = snapshot();
    data.artifacts = [{ id: 'a1', sha256: 'a'.repeat(64), agentId: 'builder', taskId: 'task-1' }];
    const fetcher = jest.fn(async (url) => response(url.startsWith('/api/artifacts/') ? { ...item, downloadUrl: '/wrong-file' } : url.endsWith('/runtime') ? {} : data));
    const client = createClient({ fetch: fetcher });
    const loaded = await client.load('team-1');
    await loaded.loadMetadata();
    expect(loaded.metadata.size).toBe(0);
    expect(projectSnapshot(loaded.snapshot, loaded.runtime, loaded.metadata).overview.artifacts[0]).not.toHaveProperty('downloadUrl');
  });
});

module.exports = { snapshot, response };
