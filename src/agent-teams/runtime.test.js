'use strict';

jest.mock('./worker', () => ({ createTeamWorker: jest.fn(() => jest.fn()), readBackArtifact: jest.fn() }));
jest.mock('../agent-computer/runtime', () => ({ AgentComputerRuntime: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })) }));
jest.mock('./grok-loop', () => ({ createGrokTaskLoop: jest.fn(() => jest.fn()) }));
const os = require('node:os');
const supervisor = require('../grok-build/kubernetes-supervisor');
const { createGrokTaskLoop } = require('./grok-loop');
const { createTeamRuntime } = require('./runtime');
const { createTeamWorker } = require('./worker');
const { AgentComputerRuntime } = require('../agent-computer/runtime');
const { TestStore } = require('./test-store');
const configuredComputer = require('../agent-computer/configured-factory');

const make = (environment = {}, extra = {}) => createTeamRuntime({
  environment, store: new TestStore(), artifactService: {}, sessionStore: {}, toolManager: {},
  getModelClient: jest.fn(), ...extra,
});

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

const podEnvironment = (ip = '10.42.1.17') => ({ LILLY_TEAMS_ENGINE: 'grok-build', LILLY_TEAMS_GROK_IMAGE: `example/grok@sha256:${'a'.repeat(64)}`,
  LILLY_TEAMS_BROKER_POD_IP: ip, LILLY_TEAMS_BROKER_POD_UID: '01234567-89ab-4cde-8fab-0123456789ab',
  LILLY_TEAMS_BROKER_POD_NAME: 'backend-replica-a', LILLY_TEAMS_BROKER_POD_NAMESPACE: 'kimibuilt' });
const localInterface = address => ({ eth0: [{ address, family: 'IPv4', internal: false }] });

test('execution owner binding requires separate opt-in and stays inactive when team execution is disabled', async () => {
  const configure = jest.spyOn(configuredComputer, 'createConfiguredOwnerBinder').mockReturnValue(jest.fn());
  await make({ LILLY_TEAMS_BIND_EXECUTION_OWNER: 'true' }).stop();
  await make({ LILLY_TEAMS_ENABLED: 'true' }).stop();
  expect(configure).not.toHaveBeenCalled();
  const environment = { LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_BIND_EXECUTION_OWNER: 'true' };
  const runtime = make(environment);
  expect(configure).toHaveBeenCalledWith({ environment });
  expect(configure.mock.results[0].value).not.toHaveBeenCalled();
  await runtime.stop();
  expect(() => make(environment, { bindExecutionContainer: jest.fn() })).toThrow('Configured execution owner binding cannot be overridden.');
});

test('owner binding configuration failure does not silently fall back to unbound execution', () => {
  jest.spyOn(configuredComputer, 'createConfiguredOwnerBinder').mockImplementation(() => { throw new Error('Unavailable owner binding'); });
  expect(() => make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_BIND_EXECUTION_OWNER: 'true' })).toThrow('Unavailable owner binding');
});

test('Grok runtime requires owning local Pod address, never shared Service or external routing', () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(localInterface('10.42.1.17'));
  for (const overrides of [
    { LILLY_TEAMS_BROKER_POD_IP: undefined }, { LILLY_TEAMS_BROKER_POD_IP: '10.43.1.1' },
    { LILLY_TEAMS_BROKER_POD_IP: '10.42.2.29' }, { LILLY_TEAMS_BROKER_POD_IP: '127.0.0.1' },
    { LILLY_TEAMS_BROKER_POD_UID: undefined }, { LILLY_TEAMS_BROKER_POD_NAME: '../other' },
    { LILLY_TEAMS_BROKER_POD_NAMESPACE: 'other' },
  ]) expect(() => make({ ...podEnvironment(), ...overrides })).toThrow('Verified owning broker Pod identity');
  expect(() => make({ ...podEnvironment(), LILLY_TEAMS_BROKER_CLUSTER_IP: '10.43.1.1' })).toThrow('Shared worker broker routing');
  expect(() => make({ ...podEnvironment(), LILLY_TEAMS_WORKER_BASE_URL: 'https://other.example' })).toThrow('Shared worker broker routing');
});

test('two replicas wire distinct verified host addresses while tokens remain process-local', async () => {
  const interfaces = jest.spyOn(os, 'networkInterfaces');
  const workers = [];
  const buildFactory = jest.spyOn(supervisor, 'createKubernetesWorkerFactory').mockImplementation(() => async scope => {
    workers.push(scope); return { client: {}, close: jest.fn() };
  });
  const runtimes = [];
  for (const ip of ['10.42.1.17', '10.42.2.29']) {
    interfaces.mockReturnValue(localInterface(ip));
    runtimes.push(make(podEnvironment(ip), { defaultModel: 'model', getModelClient: () => ({ responses: { create: async () => ({ id: 'fixture-response' }) } }) }));
  }
  expect(buildFactory.mock.calls.map(([options]) => options.configuration.brokerPodIP)).toEqual(['10.42.1.17', '10.42.2.29']);
  const scope = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task' }, maxTimeMs: 1000 };
  const leases = await Promise.all(createGrokTaskLoop.mock.calls.map(([options]) => options.createWorker(scope)));
  expect(workers.every(worker => worker.modelEndpoint.startsWith('http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001/'))).toBe(true);
  const leaseIds = workers.map(worker => new URL(worker.modelEndpoint).pathname.split('/')[3]);
  expect(leaseIds[0]).not.toBe(leaseIds[1]);
  expect(runtimes[0].broker.leases.has(leaseIds[0])).toBe(true);
  expect(runtimes[0].broker.leases.has(leaseIds[1])).toBe(false);
  expect(runtimes[1].broker.leases.has(leaseIds[0])).toBe(false);
  expect(runtimes[1].broker.leases.has(leaseIds[1])).toBe(true);
  try {
    for (const runtime of runtimes) runtime.broker.authorize = async () => true;
    const addresses = await Promise.all(runtimes.map(runtime => runtime.broker.listen({ host: '127.0.0.1', port: 0 })));
    // Actual local HTTP: a lease works on its owning listener and fails closed
    // on the other process. No model/provider is called; responses are fixtures.
    for (let owner = 0; owner < 2; owner += 1) {
      for (let destination = 0; destination < 2; destination += 1) {
        const route = new URL(workers[owner].modelEndpoint).pathname;
        const response = await fetch(`http://127.0.0.1:${addresses[destination].port}${route}/responses`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workers[owner].modelToken}` },
          body: JSON.stringify({ model: 'model', input: 'Fixture only.' }),
        });
        expect(response.status).toBe(owner === destination ? 200 : 401);
        await response.arrayBuffer();
      }
    }
  } finally {
    await Promise.all(leases.map(lease => lease.close()));
    await Promise.all(runtimes.map(runtime => runtime.stop()));
  }
});

test('broker bind failure cannot start the team scheduler', async () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(localInterface('10.42.1.17'));
  const runtime = make({ ...podEnvironment(), LILLY_TEAMS_ENABLED: 'true' });
  jest.spyOn(runtime.broker, 'listen').mockRejectedValue(new Error('listener unavailable'));
  const start = jest.spyOn(runtime.runner, 'start');
  await expect(runtime.start()).rejects.toThrow('listener unavailable');
  expect(start).not.toHaveBeenCalled();
  await runtime.stop();
});

test('standby creates no browser or scheduler; start cannot bypass global opt-in', () => {
  const runtime = make();
  const start = jest.spyOn(runtime.runner, 'start');
  runtime.start();
  expect(start).not.toHaveBeenCalled();
  expect(AgentComputerRuntime).not.toHaveBeenCalled();
  expect(runtime.status()).toEqual({ enabled: false, visionEnabled: false, runtime: 'lilly', grokEnabled: false });
});

test('configured node transport stays inactive without execution and vision opt-in', async () => {
  const configure = jest.spyOn(configuredComputer, 'createConfiguredComputerFactory');
  for (const extra of [{}, { LILLY_TEAMS_ENABLED: 'true' }, { LILLY_TEAMS_VISION_ENABLED: 'true' }]) {
    const runtime = make({ LILLY_TEAMS_COMPUTER_TRANSPORT: 'kubernetes', ...extra });
    expect(runtime.computer).toBeNull(); await runtime.stop();
  }
  expect(configure).not.toHaveBeenCalled(); expect(AgentComputerRuntime).not.toHaveBeenCalled();
});

test('explicit node transport composes configured factory with same authorization and service', async () => {
  const computer = { dispose: jest.fn(async () => []) }; const factory = jest.fn(() => computer);
  jest.spyOn(configuredComputer, 'createConfiguredComputerFactory').mockReturnValue(factory);
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true', LILLY_TEAMS_COMPUTER_TRANSPORT: 'kubernetes' });
  expect(runtime.computer).toBe(computer); expect(factory.mock.calls[0][0].service).toBe(runtime.service);
  expect(factory.mock.calls[0][0].authorize).toEqual(expect.any(Function)); expect(AgentComputerRuntime).not.toHaveBeenCalled();
  await runtime.stop();
});

test('node configuration errors and conflicting overrides never fall back to in-process', () => {
  const environment = { LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true', LILLY_TEAMS_COMPUTER_TRANSPORT: 'kubernetes' };
  jest.spyOn(configuredComputer, 'createConfiguredComputerFactory').mockImplementation(() => { throw new Error('Configuration unavailable'); });
  expect(() => make(environment)).toThrow('Configuration unavailable');
  expect(() => make(environment, { computerFactory: jest.fn() })).toThrow('Configured computer transport cannot be overridden.');
  expect(() => make({ LILLY_TEAMS_COMPUTER_TRANSPORT: 'unknown' })).toThrow('Unsupported private computer transport.');
  expect(AgentComputerRuntime).not.toHaveBeenCalled();
});

test('trusted computer transport injection preserves opt-in and participates in runtime cleanup', async () => {
  const computer = { dispose: jest.fn(async () => []) };
  const computerFactory = jest.fn(() => computer);
  const standby = make({}, { computerFactory });
  expect(computerFactory).not.toHaveBeenCalled(); await standby.stop();
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true' }, { computerFactory });
  expect(runtime.computer).toBe(computer); expect(AgentComputerRuntime).not.toHaveBeenCalled();
  expect(computerFactory.mock.calls[0][0].authorize).toEqual(expect.any(Function));
  expect(computerFactory.mock.calls[0][0].service).toBe(runtime.service);
  expect(createTeamWorker.mock.calls.at(-1)[0].computer).toBe(computer);
  await runtime.stop(); expect(computer.dispose).toHaveBeenCalledTimes(1);
});

test('requested Grok engine without its isolation supervisor stays unavailable, never falls back', async () => {
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_ENGINE: 'grok-build', LILLY_TEAMS_VISION_ENABLED: 'true' });
  const start = jest.spyOn(runtime.runner, 'start');
  runtime.start();
  expect(start).not.toHaveBeenCalled();
  expect(AgentComputerRuntime).not.toHaveBeenCalled();
  expect(runtime.status()).toMatchObject({ enabled: false, grokEnabled: false, runtime: 'grok-build', reason: 'grok_supervisor_unavailable' });
  await expect(runtime.runner.execute({})).rejects.toThrow('no engine fallback');
});

test('tool permission requires both grants and fresh execution state, with no generic fetch bypass', async () => {
  const runtime = make({ LILLY_TEAMS_TOOL_ALLOWLIST: 'web-search,web-fetch,remote-command' });
  const options = createTeamWorker.mock.calls[0][0];
  const team = await runtime.service.create('owner', { name: 'Team', objective: 'Research.' });
  await runtime.service.ownerCommand(team.id, 'owner', 'configure_execution', {
    enabled: true, toolIds: ['web-search', 'web-fetch', 'remote-command'],
  }, 'enable');
  const request = { identity: { teamId: team.id, ownerId: 'owner' }, params: {} };
  expect(await options.authorizeTool({ ...request, toolId: 'web-search' })).toBe(true);
  expect(await options.authorizeTool({ ...request, toolId: 'web-fetch', params: { method: 'POST', url: 'http://localhost/admin' } })).toBe(false);
  expect(await options.authorizeTool({ ...request, toolId: 'remote-command' })).toBe(false);
  await runtime.service.ownerCommand(team.id, 'owner', 'configure_execution', { enabled: false }, 'disable');
  expect(await options.authorizeTool({ ...request, toolId: 'web-search' })).toBe(false);
});

test('vision policy rechecks exact origins and side-effect approval', async () => {
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true' });
  const { authorize } = AgentComputerRuntime.mock.calls[0][0];
  const team = await runtime.service.create('owner', { name: 'Team', objective: 'Observe.' });
  const agent = await runtime.service.ownerCommand(team.id, 'owner', 'create_agent', { name: 'A', job: 'Observe.' }, 'agent');
  await runtime.service.ownerCommand(team.id, 'owner', 'configure_execution', {
    enabled: true, origins: ['https://allowed.test'],
  }, 'enable');
  await runtime.service.ownerCommand(team.id, 'owner', 'assign_task', { agentId: agent.id, title: 'Observe', instruction: 'Observe approved origin.' }, 'task');
  const [task] = await runtime.service.claimEnabled(team.id, 'owner', 'worker');
  const identity = { teamId: team.id, ownerId: 'owner', agentId: agent.id,
    claim: { taskId: task.id, workerId: 'worker', claimId: task.worker.claimId } };
  expect(await authorize({ identity: { ...identity, claim: undefined }, operation: 'request', url: 'https://allowed.test/page' })).toBe(false);
  expect(await authorize({ identity: { ...identity, claim: { ...identity.claim, claimId: 'old' } }, operation: 'request', url: 'https://allowed.test/page' })).toBe(false);
  expect(await authorize({ identity, operation: 'observe', url: 'https://allowed.test/page' })).toBe(true);
  expect(await authorize({ identity, operation: 'observe', url: 'https://allowed.test.attacker.test' })).toBe(false);
  expect(await authorize({ identity, operation: 'act', url: 'https://allowed.test/page' })).toBe(false);
  expect(await authorize({ identity, operation: 'websocket', url: 'wss://allowed.test/ws' })).toBe(false);
  await runtime.service.ownerCommand(team.id, 'owner', 'configure_execution', { allowWebSockets: true, allowSideEffects: true }, 'socket');
  expect(await authorize({ identity, operation: 'websocket', url: 'wss://allowed.test/ws' })).toBe(true);
  expect(await authorize({ identity, operation: 'websocket', url: 'wss://elsewhere.test/ws' })).toBe(false);
  await runtime.service.ownerCommand(team.id, 'owner', 'control_agent', { agentId: agent.id, action: 'stop' }, 'stop');
  expect(await authorize({ identity, operation: 'observe', url: 'https://allowed.test/page' })).toBe(false);
  await runtime.service.ownerCommand(team.id, 'owner', 'control_agent', { agentId: agent.id, action: 'resume' }, 'resume');
  // Resuming a teammate is not authority for its cancelled old page/socket.
  expect(await authorize({ identity, operation: 'request', url: 'https://allowed.test/background' })).toBe(false);
  expect(await authorize({ identity, operation: 'websocket', url: 'wss://allowed.test/ws' })).toBe(false);
});

test('model adapter passes cancellation and never automatically retries a provider call', async () => {
  const create = jest.fn(async () => ({ output: [] }));
  make({}, { defaultModel: 'configured-route', getModelClient: () => ({ responses: { create } }) });
  const { respond } = createTeamWorker.mock.calls[0][0];
  const signal = new AbortController().signal;
  await respond({ input: [], tools: [], instructions: 'Scoped.', signal });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'configured-route', store: false }), { signal, maxRetries: 0 });
});

test('default search settlement rejects structured timeouts and accepted job handles', async () => {
  make();
  const { observeToolSettlement } = createTeamWorker.mock.calls[0][0];
  expect(await observeToolSettlement({ toolId: 'web-search', result: { success: true, results: [] } })).toBe(true);
  for (const result of [{ success: false, errorCode: 'web_search_timeout' }, { success: true, status: 'running' }, { success: true, jobId: 'pending' }, null]) {
    expect(await observeToolSettlement({ toolId: 'web-search', result })).toBe(false);
  }
  expect(await observeToolSettlement({ toolId: 'remote-command', result: { success: true } })).toBe(false);
});

test('shutdown reports actual drain and resources, disables availability and cannot restart disposed runtime', async () => {
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true' });
  const report = await runtime.stop({ timeoutMs: 50 });
  expect(report).toMatchObject({ settled: true, resourcesClosed: true, pendingTaskIds: [] });
  expect(runtime.status()).toMatchObject({ enabled: false, visionEnabled: false, shutdown: { settled: true } });
  await expect(runtime.start()).rejects.toMatchObject({ code: 'team_runtime_stopped' });
});

test('late broker startup after shutdown cannot start scheduler and is closed again', async () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(localInterface('10.42.1.17'));
  const runtime = make({ ...podEnvironment(), LILLY_TEAMS_ENABLED: 'true' });
  let listening; let entered;
  const acquiring = new Promise(resolve => { entered = resolve; });
  jest.spyOn(runtime.broker, 'listen').mockImplementation(() => { entered(); return new Promise((resolve) => { listening = resolve; }); });
  const close = jest.spyOn(runtime.broker, 'close');
  const start = jest.spyOn(runtime.runner, 'start');
  const starting = runtime.start();
  const outcome = expect(starting).rejects.toMatchObject({ code: 'team_runtime_stopped' });
  await acquiring;
  expect(await runtime.stop({ timeoutMs: 5 })).toMatchObject({ settled: false, resourcesClosed: false });
  listening();
  await outcome;
  expect(await runtime.stop({ timeoutMs: 50 })).toMatchObject({ settled: true, resourcesClosed: true });
  expect(start).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(2);
});

test('shutdown during owner acquisition prevents any late broker or scheduler start', async () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(localInterface('10.42.1.17'));
  const runtime = make({ ...podEnvironment(), LILLY_TEAMS_ENABLED: 'true' });
  let finish;
  jest.spyOn(runtime.runner, 'prepareOwner').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const listen = jest.spyOn(runtime.broker, 'listen'); const start = jest.spyOn(runtime.runner, 'start');
  const starting = runtime.start(); const outcome = expect(starting).rejects.toMatchObject({ code: 'team_runtime_stopped' });
  expect((await runtime.stop({ timeoutMs: 50 })).settled).toBe(true);
  finish(); await outcome;
  expect(listen).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});

test('rejected execution-owner acquisition cannot open a broker or start the scheduler', async () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(localInterface('10.42.1.17'));
  const runtime = make({ ...podEnvironment(), LILLY_TEAMS_ENABLED: 'true' });
  jest.spyOn(runtime.runner, 'prepareOwner').mockRejectedValue(new Error('Owner observation failed'));
  const listen = jest.spyOn(runtime.broker, 'listen'); const start = jest.spyOn(runtime.runner, 'start');
  await expect(runtime.start()).rejects.toThrow('Owner observation failed');
  expect(listen).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  await runtime.stop();
});

test('shutdown timeout observes the same pending cleanup, never a repeated no-op', async () => {
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true' });
  let finish;
  runtime.computer.dispose.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  expect(await runtime.stop({ timeoutMs: 5 })).toMatchObject({ settled: false, resourcesClosed: false });
  expect(await runtime.stop({ timeoutMs: 5 })).toMatchObject({ settled: false, resourcesClosed: false });
  expect(runtime.computer.dispose).toHaveBeenCalledTimes(1);
  finish([{ status: 'fulfilled' }]);
  expect(await runtime.stop({ timeoutMs: 50 })).toMatchObject({ settled: true, resourcesClosed: true });
});

test('browser disposal rejection and unresolved runner work remain unconfirmed without exposing task IDs in status', async () => {
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true' });
  runtime.computer.dispose.mockResolvedValue([{ status: 'rejected', reason: new Error('Private browser failure') }]);
  jest.spyOn(runtime.runner, 'drain').mockResolvedValue({ settled: false, pendingTaskIds: ['private-task-id'], admissionUncertain: true });
  expect(await runtime.stop({ timeoutMs: 50 })).toMatchObject({ settled: false, resourcesClosed: false });
  expect(JSON.stringify(runtime.status())).not.toContain('private-task-id');
  expect(runtime.status().shutdown).toMatchObject({ pendingTasks: 1, admissionUncertain: true });
});

const recoveryOwner = { version: 1, bootId: '01234567-89ab-4cde-8fab-0123456789ab', platform: 'win32',
  pid: 42, startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
const quiescent = scope => ({ receiptId: 'fixture-only-observer', claimId: scope.claim.claimId,
  ownerBootId: scope.executionOwner.bootId, ownerStopped: true, workerStopped: true, browserStopped: true });
async function interrupted(runtime) {
  const team = await runtime.service.create('owner', { name: 'Interrupted team', objective: 'Preserve work.' });
  const command = (action, input, key) => runtime.service.ownerCommand(team.id, 'owner', action, input, key);
  const agent = await command('create_agent', { name: 'Builder', job: 'Save output.' }, 'agent');
  await command('configure_execution', { enabled: true }, 'enable');
  await command('assign_task', { agentId: agent.id, title: 'Interrupted', instruction: 'Fixture only.' }, 'task');
  const [task] = await runtime.service.claimEnabled(team.id, 'owner', 'old-worker', 1, recoveryOwner);
  await command('configure_execution', { enabled: false }, 'disable');
  return { team, task, command, saved: async () => (await runtime.service.get(team.id, 'owner')).tasks[0] };
}

test('recovery needs a separate opt-in and an injected observer; flags cannot assert quiescence', async () => {
  const observeQuiescence = jest.fn();
  const off = make({}, { observeQuiescence });
  const unavailable = make({ LILLY_TEAMS_RECOVERY_ENABLED: 'true' });
  const inventory = jest.spyOn(unavailable.service.store, 'listUnsettled');
  await off.start(); await unavailable.start();
  expect(off.reconciler).toBeNull();
  expect(unavailable.reconciler).toBeNull();
  expect(unavailable.status().recovery).toEqual({ available: false, enabled: false, pending: false, reason: 'quiescence_observer_unavailable' });
  expect(inventory).not.toHaveBeenCalled(); expect(observeQuiescence).not.toHaveBeenCalled();
  expect(() => make({}, { observeQuiescence: true })).toThrow('Invalid recovery observer');
  expect(() => make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_VISION_ENABLED: 'true' }, { bindExecutionContainer: true }))
    .toThrow('Invalid execution container binder');
  expect(AgentComputerRuntime).not.toHaveBeenCalled();
  await off.stop(); await unavailable.stop();
});

test('scheduled recovery handles disabled teams while execution, browsers and model calls stay off', async () => {
  jest.useFakeTimers();
  const model = jest.fn();
  const runtime = make({ LILLY_TEAMS_RECOVERY_ENABLED: 'true' }, { observeQuiescence: jest.fn(quiescent), getModelClient: model });
  try {
    const fixture = await interrupted(runtime);
    const before = await runtime.service.get(fixture.team.id, 'owner');
    const admission = jest.spyOn(runtime.runner, 'start');
    const owner = jest.spyOn(runtime.runner, 'prepareOwner');
    await runtime.start(); await runtime.start();
    const timer = runtime.reconciler.timer;
    expect(runtime.status().recovery).toEqual({ available: true, enabled: true, pending: false });
    expect((await fixture.saved()).status).toBe('running');
    await jest.advanceTimersByTimeAsync(3000);
    expect((await fixture.saved()).status).toBe('failed');
    const after = await runtime.service.get(fixture.team.id, 'owner');
    expect(after.execution.enabled).toBe(false);
    expect(after.agents).toEqual(before.agents);
    expect(after.tasks).toHaveLength(1);
    expect(runtime.reconciler.timer).toBe(timer);
    expect(runtime.reconciler.observeQuiescence).toHaveBeenCalledTimes(2);
    expect(admission).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled();
    expect(AgentComputerRuntime).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
    expect(createTeamWorker.mock.results[0].value).not.toHaveBeenCalled();
    await runtime.stop();
    expect(runtime.status().recovery.enabled).toBe(false);
    await jest.advanceTimersByTimeAsync(9000);
    expect(runtime.reconciler.observeQuiescence).toHaveBeenCalledTimes(2);
  } finally { await runtime.stop(); jest.useRealTimers(); }
});

test('recovery shutdown retains a pending observation across deadlines and prevents late fencing', async () => {
  let resolveObservation; let entered;
  const observing = new Promise(resolve => { entered = resolve; });
  const observeQuiescence = jest.fn(scope => { entered(); return new Promise(resolve => { resolveObservation = () => resolve(quiescent(scope)); }); });
  const runtime = make({ LILLY_TEAMS_RECOVERY_ENABLED: 'true' }, { observeQuiescence });
  const fixture = await interrupted(runtime);
  await runtime.start();
  const pending = runtime.reconciler.tick(); await observing;
  expect(runtime.reconciler.tick()).toBe(pending);
  expect(await runtime.stop({ timeoutMs: 5 })).toMatchObject({ settled: false, resourcesClosed: false });
  expect(await runtime.stop({ timeoutMs: 5 })).toMatchObject({ settled: false, resourcesClosed: false });
  expect(runtime.reconciler.pending).toBe(pending);
  expect(runtime.status().recovery).toEqual({ available: true, enabled: false, pending: true });
  expect(JSON.stringify(runtime.status())).not.toContain(fixture.task.worker.claimId);
  resolveObservation(); await pending;
  expect(await runtime.stop({ timeoutMs: 50 })).toMatchObject({ settled: true, resourcesClosed: true });
  expect((await fixture.saved()).status).toBe('running');
  expect(observeQuiescence).toHaveBeenCalledTimes(1);
  expect(() => runtime.reconciler.start()).toThrow('cannot restart');
});

test('shutdown waits for an already dispatched recovery transaction rather than claiming it was cancelled', async () => {
  const runtime = make({ LILLY_TEAMS_RECOVERY_ENABLED: 'true' }, { observeQuiescence: quiescent });
  const fixture = await interrupted(runtime);
  let commit; let entered;
  const dispatched = new Promise(resolve => { entered = resolve; });
  const finish = runtime.service.finishReconciliation.bind(runtime.service);
  jest.spyOn(runtime.service, 'finishReconciliation').mockImplementation((...args) => {
    entered(); return new Promise(resolve => { commit = () => resolve(finish(...args)); });
  });
  const pending = runtime.reconciler.tick(); await dispatched;
  expect(await runtime.stop({ timeoutMs: 5 })).toMatchObject({ settled: false, resourcesClosed: false });
  expect((await fixture.saved()).status).toBe('reconciling');
  commit(); await pending;
  expect(await runtime.stop({ timeoutMs: 50 })).toMatchObject({ settled: true, resourcesClosed: true });
  expect((await fixture.saved()).status).toBe('failed');
  expect(runtime.service.finishReconciliation).toHaveBeenCalledTimes(1);
});

test('failed execution startup cannot leave an unexpected recovery scheduler behind', async () => {
  const runtime = make({ LILLY_TEAMS_ENABLED: 'true', LILLY_TEAMS_RECOVERY_ENABLED: 'true' }, { observeQuiescence: quiescent });
  jest.spyOn(runtime.runner, 'prepareOwner').mockRejectedValue(new Error('Owner unavailable'));
  await expect(runtime.start()).rejects.toThrow('Owner unavailable');
  expect(runtime.reconciler.timer).toBeNull();
  expect(runtime.status().recovery.enabled).toBe(false);
  await runtime.stop();
});
