'use strict';

const { ContainerStopArchive, ContainerStopStore, ownerIdentity } = require('./container-stop-archive');
const bootId = '01234567-89ab-4cde-8fab-0123456789ab';
const at = '2026-09-07T00:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reverseKeys = value => value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;

function fixture() {
  const owner = { version: 2, bootId, platform: 'linux', pid: 1, startedAt: at,
    kernel: { bootId, startTicks: '300', pidNamespace: '1001', mountNamespace: '1002' },
    pod: { namespace: 'kimibuilt', name: 'backend-a', uid: bootId, containerName: 'backend' },
    containerBinding: { version: 2, containerId: `containerd://${'a'.repeat(64)}`, nodeName: 'node-a', podUid: bootId,
      hostBootId: bootId, initPid: 500, hostPid: 500, initStartTicks: '300', processStartTicks: '300',
      pidNamespace: '1001', mountNamespace: '1002', observedAt: at,
      cgroup: { path: `/kubepods/pod${bootId}/${'a'.repeat(64)}`, device: '29', inode: '1000' } } };
  const rows = new Map();
  const store = { get: jest.fn(async id => rows.has(id) ? structuredClone(rows.get(id)) : null),
    insertOnce: jest.fn(async receipt => { if (!rows.has(receipt.ownerFingerprint)) rows.set(receipt.ownerFingerprint, structuredClone(receipt)); return rows.get(receipt.ownerFingerprint); }) };
  const inspectContainer = jest.fn(async () => ({ status: { id: 'a'.repeat(64), state: 'CONTAINER_EXITED', labels: {
    'io.kubernetes.pod.uid': bootId, 'io.kubernetes.pod.namespace': 'kimibuilt', 'io.kubernetes.pod.name': 'backend-a', 'io.kubernetes.container.name': 'backend' } } }));
  const readCgroup = jest.fn(async () => ({ identity: owner.containerBinding.cgroup, populated: false, hostBootId: bootId }));
  const options = { store, inspectContainer, readCgroup, now: () => at };
  return { owner, rows, store, inspectContainer, readCgroup, options, archive: new ContainerStopArchive(options) };
}

test('persists a positively observed stop and reads it after observer reconstruction and cgroup removal', async () => {
  const f = fixture();
  const receipt = await f.archive.capture(f.owner);
  expect(receipt).toMatchObject({ version: 1, stopped: true, ownerBootId: bootId, ownerFingerprint: ownerIdentity(f.owner).fingerprint });
  expect(f.inspectContainer).toHaveBeenCalledTimes(2); expect(f.readCgroup).toHaveBeenCalledTimes(2);
  expect(f.store.insertOnce).toHaveBeenCalledTimes(1); expect(f.store.get).toHaveBeenCalledTimes(2);
  f.inspectContainer.mockRejectedValue(new Error('CRI garbage collected'));
  f.readCgroup.mockRejectedValue(new Error('Cgroup removed'));
  const restarted = new ContainerStopArchive(f.options);
  expect(await restarted.read(reverseKeys(f.owner))).toEqual(receipt);
  expect(await restarted.capture(f.owner)).toEqual(receipt);
  expect(f.inspectContainer).toHaveBeenCalledTimes(2);
  expect(f.store.insertOnce).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(receipt)).not.toContain(f.owner.containerBinding.cgroup.path);
  expect(receipt).not.toHaveProperty('workerStopped');
});

test.each(['running', 'populated', 'missing'])('never archives %s as stopped', async mode => {
  const f = fixture();
  if (mode === 'running') f.inspectContainer.mockResolvedValue({ status: { state: 'CONTAINER_RUNNING' } });
  if (mode === 'populated') f.readCgroup.mockResolvedValue({ populated: true });
  if (mode === 'missing') f.readCgroup.mockRejectedValue(Object.assign(new Error('PRIVATE'), { code: 'ENOENT' }));
  expect(await f.archive.capture(f.owner)).toBeNull();
  expect(f.rows.size).toBe(0); expect(f.store.insertOnce).not.toHaveBeenCalled();
});

test('concurrent captures share one pending observation and never duplicate its write', async () => {
  const f = fixture(); const gate = deferred();
  f.readCgroup.mockReturnValue(gate.promise);
  const first = f.archive.capture(f.owner);
  for (let i = 0; i < 20; i += 1) expect(f.archive.capture(reverseKeys(f.owner))).toBe(first);
  gate.resolve({ populated: false, identity: f.owner.containerBinding.cgroup, hostBootId: bootId });
  await first;
  expect(f.store.insertOnce).toHaveBeenCalledTimes(1); expect(f.archive.pending.size).toBe(0);
});

test('a committed receipt with lost acknowledgement is recovered without repeating the observation', async () => {
  const f = fixture(); const insert = f.store.insertOnce.getMockImplementation();
  f.store.insertOnce.mockImplementationOnce(async receipt => { await insert(receipt); throw new Error('Lost DB reply'); });
  await expect(f.archive.capture(f.owner)).rejects.toMatchObject({ code: 'team_stop_archive_unavailable' });
  f.inspectContainer.mockRejectedValue(new Error('Gone'));
  expect(await new ContainerStopArchive(f.options).read(f.owner)).toMatchObject({ stopped: true });
  expect(await f.archive.capture(f.owner)).toMatchObject({ stopped: true });
  expect(f.store.insertOnce).toHaveBeenCalledTimes(1); expect(f.inspectContainer).toHaveBeenCalledTimes(2);
});

test('stop retains an already dispatched write promise until independent read-back finishes', async () => {
  const f = fixture(); const gate = deferred(); const entered = deferred(); const insert = f.store.insertOnce.getMockImplementation();
  f.store.insertOnce.mockImplementation(async receipt => { entered.resolve(); await gate.promise; return insert(receipt); });
  const work = f.archive.capture(f.owner); await entered.promise;
  f.archive.stop();
  expect(f.archive.capture(f.owner)).toBe(work);
  expect(f.archive.pending.size).toBe(1);
  gate.resolve(); expect(await work).toMatchObject({ stopped: true });
  expect(f.archive.pending.size).toBe(0);
  expect(await f.archive.capture({ ...f.owner, bootId: '11234567-89ab-4cde-8fab-0123456789ab' })).toBeNull();
});

test('stop during observation prevents a late new write', async () => {
  const f = fixture(); const gate = deferred(); const entered = deferred();
  f.readCgroup.mockImplementation(() => { entered.resolve(); return gate.promise; });
  const work = f.archive.capture(f.owner); await entered.promise;
  f.archive.stop(); gate.resolve({ populated: false, identity: f.owner.containerBinding.cgroup, hostBootId: bootId });
  expect(await work).toBeNull(); expect(f.store.insertOnce).not.toHaveBeenCalled();
});

test('old evidence cannot bind a different runtime boot, process or cgroup generation', async () => {
  const f = fixture(); await f.archive.capture(f.owner);
  for (const change of [owner => { owner.bootId = '11234567-89ab-4cde-8fab-0123456789ab'; },
    owner => { owner.kernel.startTicks = '301'; owner.containerBinding.initStartTicks = '301'; owner.containerBinding.processStartTicks = '301'; },
    owner => { owner.containerBinding.cgroup.inode = '1001'; }]) {
    const owner = JSON.parse(JSON.stringify(f.owner)); change(owner);
    expect(await f.archive.read(owner)).toBeNull();
  }
});

test.each(['wrong_owner', 'wrong_container', 'wrong_key', 'extra', 'old_time', 'not_stopped'])('rejects corrupt stored evidence: %s', async mode => {
  const f = fixture(); await f.archive.capture(f.owner); const receipt = [...f.rows.values()][0];
  if (mode === 'wrong_owner') receipt.ownerBootId = 'foreign';
  if (mode === 'wrong_container') receipt.containerId = `containerd://${'b'.repeat(64)}`;
  if (mode === 'wrong_key') receipt.ownerFingerprint = 'b'.repeat(64);
  if (mode === 'extra') receipt.privateData = 'NEVER_RETURN';
  if (mode === 'old_time') receipt.observedAt = '2026-09-06T00:00:00.000Z';
  if (mode === 'not_stopped') receipt.stopped = false;
  await expect(f.archive.read(f.owner)).rejects.toMatchObject({ message: 'Container stop archive unavailable or invalid.' });
  await expect(f.archive.capture(f.owner)).rejects.toBeDefined();
  expect(f.store.insertOnce).toHaveBeenCalledTimes(1);
});

test('capacity bounds do not discard or replace pending observations', async () => {
  const f = fixture(); const gate = deferred(); f.readCgroup.mockReturnValue(gate.promise);
  const archive = new ContainerStopArchive({ ...f.options, maxPending: 1 });
  const work = archive.capture(f.owner);
  await expect(archive.capture({ ...f.owner, bootId: '11234567-89ab-4cde-8fab-0123456789ab' })).rejects.toBeDefined();
  expect(archive.capture(f.owner)).toBe(work);
  gate.resolve({ populated: true }); await work;
});

test('SQL store uses a bound key and insert-only persistence, never an update', async () => {
  const f = fixture(); const receipt = await f.archive.capture(f.owner);
  const database = { query: jest.fn(async sql => ({ rows: sql.includes('SELECT receipt') ? [{ receipt }] : [] })) };
  const store = new ContainerStopStore({ database });
  await expect(store.get("'; DROP TABLE secrets")).rejects.toBeDefined();
  expect(database.query).not.toHaveBeenCalled();
  await expect(store.insertOnce({ ownerFingerprint: 'a'.repeat(64) })).rejects.toBeDefined();
  expect(database.query).not.toHaveBeenCalled();
  const fingerprint = receipt.ownerFingerprint;
  await store.insertOnce(receipt);
  expect(database.query.mock.calls[1][0]).toContain('ON CONFLICT (owner_fingerprint) DO NOTHING');
  expect(database.query.mock.calls[1][0]).not.toContain('UPDATE');
  expect(database.query.mock.calls[1][1][0]).toBe(fingerprint);
  expect(database.query.mock.calls[2][1]).toEqual([fingerprint]);
});
