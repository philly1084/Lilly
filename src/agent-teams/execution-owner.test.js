'use strict';

const { createExecutionOwnerResolver, normalizeExecutionOwner, parseProcessStart } = require('./execution-owner');

const bootId = '01234567-89ab-4cde-8fab-0123456789ab';
const at = '2026-09-07T00:00:00.000Z';
const processStat = (pid = 42, ticks = '123456') => `${pid} (node worker (fixture)) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0\n`;
const base = () => ({ version: 1, bootId, platform: 'win32', pid: 42, startedAt: at, kernel: null, pod: null });
const linux = () => ({ ...base(), platform: 'linux', kernel: { bootId, startTicks: '123456', pidNamespace: '1001', mountNamespace: '1002' } });
const fixture = (overrides = {}) => createExecutionOwnerResolver({ environment: {}, platform: 'linux', pid: 42, bootId, now: () => at,
  readFile: async file => file.endsWith('/boot_id') ? `${bootId}\n` : processStat(),
  readlink: async file => file.endsWith('/pid') ? 'pid:[1001]' : 'mnt:[1002]', ...overrides });

test('Linux records bounded local kernel identity without inferring a container ID', async () => {
  const readFile = jest.fn(async file => file.endsWith('/boot_id') ? `${bootId}\n` : processStat());
  const readlink = jest.fn(async file => file.endsWith('/pid') ? 'pid:[1001]' : 'mnt:[1002]');
  const resolver = fixture({ readFile, readlink });
  expect(await resolver()).toEqual(linux());
  expect(readFile.mock.calls.map(call => call[0])).toEqual(['/proc/sys/kernel/random/boot_id', '/proc/42/stat']);
  expect(readlink.mock.calls.map(call => call[0])).toEqual(['/proc/42/ns/pid', '/proc/42/ns/mnt']);
});

test('runtime boots are unique even when PID and host kernel identity are unchanged', async () => {
  const first = await fixture({ bootId: undefined })();
  const second = await fixture({ bootId: undefined })();
  expect(first.bootId).not.toBe(second.bootId);
  expect(first.kernel).toEqual(second.kernel);
  expect(first.pid).toBe(second.pid);
});

test('local non-Linux owner does not fabricate kernel or container proof', async () => {
  const readFile = jest.fn(); const readlink = jest.fn();
  expect(await fixture({ platform: 'win32', readFile, readlink })()).toEqual(base());
  expect(readFile).not.toHaveBeenCalled(); expect(readlink).not.toHaveBeenCalled();
});

test('Pod metadata is allowlisted release context, never a derived container identity', async () => {
  const owner = await fixture({ environment: { KUBERNETES_SERVICE_HOST: '10.43.0.1',
    LILLY_TEAMS_BROKER_POD_NAME: 'backend-a', LILLY_TEAMS_BROKER_POD_UID: bootId,
    LILLY_TEAMS_BROKER_POD_NAMESPACE: 'kimibuilt', PRIVATE_TOKEN: 'NEVER_PERSIST' } })();
  expect(owner.pod).toEqual({ name: 'backend-a', uid: bootId, namespace: 'kimibuilt', containerName: 'backend' });
  expect(JSON.stringify(owner)).not.toContain('NEVER_PERSIST');
  expect(owner.pod).not.toHaveProperty('containerId');
});

test.each([{ KUBERNETES_SERVICE_HOST: '10.43.0.1' }, { LILLY_TEAMS_BROKER_POD_NAME: 'backend-a' },
  { LILLY_TEAMS_BROKER_POD_NAME: '../foreign', LILLY_TEAMS_BROKER_POD_UID: bootId, LILLY_TEAMS_BROKER_POD_NAMESPACE: 'kimibuilt' }])('incomplete or unsafe Pod context fails closed: %p', async environment => {
  await expect(fixture({ environment })()).rejects.toMatchObject({ code: 'team_execution_owner_invalid' });
});

test.each(['42 (missing)', processStat(43), processStat(42, 'unsafe'), 'x'.repeat(16385)])('malformed or wrong-process stat is rejected', stat => {
  expect(() => parseProcessStart(stat, 42)).toThrow('Execution owner');
});

test('kernel observation failure is redacted and cannot silently downgrade identity', async () => {
  await expect(fixture({ readFile: async () => { throw new Error('PRIVATE_FS_DETAIL'); } })())
    .rejects.toMatchObject({ code: 'team_execution_owner_invalid', message: 'Execution owner identity unavailable or invalid.' });
  await expect(fixture({ readlink: async () => 'pid:[not-an-inode]' })()).rejects.toMatchObject({ code: 'team_execution_owner_invalid' });
});

test.each([null, {}, { ...base(), secret: 'private' }, { ...base(), bootId: 'old-worker' }, { ...base(), pid: 0 },
  { ...base(), startedAt: 'bad-date' }, { ...base(), kernel: {} }, { ...linux(), kernel: { ...linux().kernel, startTicks: 123 } },
  { ...base(), pod: { name: 'backend', namespace: 'other', uid: bootId, containerName: 'backend' } }])('invalid or extra owner evidence cannot persist: %p', owner => {
  expect(() => normalizeExecutionOwner(owner)).toThrow('Execution owner');
});

const podEnvironment = { LILLY_TEAMS_BROKER_POD_NAMESPACE: 'kimibuilt', LILLY_TEAMS_BROKER_POD_NAME: 'backend-a', LILLY_TEAMS_BROKER_POD_UID: bootId };
const containerBinding = () => ({ version: 1, containerId: `containerd://${'a'.repeat(64)}`, nodeName: 'node-a', podUid: bootId,
  hostBootId: bootId, initPid: 500, initStartTicks: '123000', hostPid: 510, processStartTicks: '123456',
  pidNamespace: '1001', mountNamespace: '1002', observedAt: at });

test('trusted container binding upgrades ownership without changing the process/boot identity', async () => {
  const bindContainer = jest.fn(async value => {
    expect(value.version).toBe(1); expect(value.pid).toBe(42);
    value.pid = 999; // An adapter cannot mutate the retained process observation.
    return containerBinding();
  });
  const owner = await fixture({ environment: podEnvironment, bindContainer })();
  expect(owner).toMatchObject({ version: 2, pid: 42, bootId, containerBinding: containerBinding() });
  const copy = normalizeExecutionOwner(owner);
  owner.containerBinding.hostPid = 999;
  expect(copy.containerBinding.hostPid).toBe(510);
});

test('binding errors cannot downgrade to an unbound owner or leak the node endpoint', async () => {
  for (const bindContainer of [async () => null, async () => { throw new Error('PRIVATE_NODE_ENDPOINT'); }]) {
    await expect(fixture({ environment: podEnvironment, bindContainer })()).rejects.toMatchObject({
      code: 'team_execution_owner_invalid', message: 'Execution owner identity unavailable or invalid.',
    });
  }
  const bindContainer = jest.fn();
  await expect(fixture({ bindContainer })()).rejects.toBeDefined();
  expect(bindContainer).not.toHaveBeenCalled();
  expect(() => fixture({ bindContainer: true })).toThrow('Execution owner');
});

test.each([{ podUid: 'foreign' }, { hostBootId: 'foreign' }, { containerId: 'containerd://short' }, { nodeName: '../node' },
  { processStartTicks: '123457' }, { initStartTicks: '123457' }, { pidNamespace: '1003' }, { mountNamespace: '1003' },
  { hostPid: 500 }, { initPid: 0 }, { observedAt: '2026-09-06T23:59:59.000Z' }, { credentials: 'PRIVATE' }])('rejects foreign, stale or extra container binding fields: %p', async change => {
  await expect(fixture({ environment: podEnvironment, bindContainer: async () => ({ ...containerBinding(), ...change }) })())
    .rejects.toMatchObject({ code: 'team_execution_owner_invalid' });
});
