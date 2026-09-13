'use strict';

const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { TeamService } = require('../agent-teams/service');
const { TestStore } = require('../agent-teams/test-store');
const { serveComputer } = require('./remote-runtime');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const { createBrowserNodeAdapter } = require('./browser-node-adapter');
const { createKubernetesComputerFactory, createKubernetesComputerRuntime } = require('./kubernetes-supervisor');

const image = `registry.example/browser@sha256:${'a'.repeat(64)}`;
const configuration = { namespace: 'lilly-team-workers', image, seccompProfile: 'lilly/chromium-v1.json',
  readyTimeoutMs: 30, closeTimeoutMs: 15, pollMs: 1 };
async function fixture() {
  const store = new TestStore(); const service = new TeamService({ store });
  const team = await service.create('owner', { name: 'Supervisor fixture', objective: 'Synthetic Kubernetes responses only.' });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  const agent = await command('create_agent', { name: 'Browser', job: 'Fixture only.' });
  await command('configure_execution', { enabled: true });
  await command('assign_task', { agentId: agent.id, title: 'Private browser', instruction: 'No real resource creation.' });
  const executionOwner = { version: 1, bootId: randomUUID(), platform: 'win32', pid: 1,
    startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
  const [task] = await service.claimEnabled(team.id, 'owner', 'worker', 1, executionOwner);
  const scope = { ownerId: 'owner', teamId: team.id, agentId: agent.id, taskId: task.id,
    claim: { taskId: task.id, workerId: 'worker', claimId: task.worker.claimId }, authorize: jest.fn(async () => true) };
  const objects = new Map(); let endpoint;
  const remote = { open: jest.fn(async () => ({ computerId: 'fixture-computer' })), dispose: jest.fn(async () => []) };
  const cluster = {
    request: jest.fn(async (method, path, body) => {
      if (method === 'GET') {
        if (!objects.has(path)) throw Object.assign(new Error('Fixture missing'), { status: 404 });
        return structuredClone(objects.get(path));
      }
      if (method === 'POST') {
        // The real service's durable intent must precede all provisioning.
        expect((await service.get(team.id, 'owner')).tasks[0].computerLease.phase).toBe('provisioning');
        const object = structuredClone(body); object.metadata.uid = randomUUID();
        if (body.kind === 'Pod') object.spec.nodeName = 'fixture-node';
        if (body.kind === 'Pod') object.status = { phase: 'Running', containerStatuses: [{ name: 'worker', ready: true,
          state: { running: {} }, restartCount: 0, imageID: `containerd://registry.example/browser@${image.split('@')[1]}`,
          containerID: `containerd://${'b'.repeat(64)}` }] };
        objects.set(`${path}/${body.metadata.name}`, object); return structuredClone(object);
      }
      if (method === 'DELETE') {
        expect(body.preconditions.uid).toBe(objects.get(path)?.metadata.uid);
        objects.delete(path); return { status: 'Success' };
      }
      throw new Error('Unexpected fake API request');
    }),
    exec: jest.fn(() => {
      const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
      endpoint = serveComputer({ input: stdin, output: stdout, createRuntime: ({ authorize }) => ({ ...remote,
        open: async (identity, input) => {
          if (await authorize({ identity, operation: 'open', url: input.url }) !== true) throw Object.assign(new Error('Denied'), { code: 'computer_policy_denied' });
          return remote.open(identity, input);
        },
      }) });
      return { stdin, stdout, stderr, kill: jest.fn(() => { stdin.end(); stdout.end(); stderr.end(); }) };
    }),
  };
  // Fixture-only acknowledgements, not evidence of real container termination.
  const nodeBoot = randomUUID();
  const bindContainer = jest.fn(async ({ lease }) => ({ version: 1,
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    nodeName: 'fixture-node', hostBootId: nodeBoot, initPid: 123, initStartTicks: '12345', pidNamespace: '42', mountNamespace: '43',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '789' },
    observedAt: '2026-09-07T00:00:00.000Z' }));
  const observeTermination = jest.fn(async ({ lease }) => {
    const stopEvidence = lease.nodeBinding ? createBrowserStopEvidence(lease, {
      ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
      podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:00:00.000Z',
    }) : null;
    return { ...lease, podStopped: true, profileReleased: true,
      ...(stopEvidence ? { stopEvidence, profileRecovery: syntheticProfileRecovery({ ...lease, stopEvidence }) } : {}) };
  });
  const requestStop = jest.fn(async () => ({ requested: true }));
  const captureStop = jest.fn(async ({ lease }) => createBrowserStopEvidence(lease, {
    ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]])),
    podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:00:00.000Z',
  }));
  const factory = createKubernetesComputerFactory({ service, configuration, cluster, bindContainer, requestStop, captureStop, observeTermination });
  const saved = async () => (await service.get(team.id, 'owner')).tasks[0].computerLease;
  return { scope, service, store, objects, cluster, factory, saved, bindContainer, requestStop, captureStop, observeTermination, remote, command,
    finish: async lease => { await lease?.computer.dispose(); await endpoint?.close(); } };
}

test('scoped Pod/PVC and private exec connect to persisted task ownership, preserve profile on cleanup', async () => {
  const f = await fixture(); const lease = await f.factory(f.scope);
  const pod = [...f.objects.values()].find(value => value.kind === 'Pod');
  expect(pod.spec).toMatchObject({ restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false });
  const worker = pod.spec.containers[0];
  expect(worker.securityContext).toMatchObject({ runAsUser: 10001, allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'Localhost' } });
  expect(worker.ports).toBeUndefined(); expect(pod.spec.volumes.some(value => value.secret || value.hostPath)).toBe(false);
  expect(worker.env.map(value => value.name)).toEqual(['HOME', 'LILLY_COMPUTER_IDENTITY', 'LILLY_PROFILE_LEASE_ID']);
  expect(worker.resources.limits).toMatchObject({ cpu: '1', memory: '1Gi' });
  expect(f.cluster.exec).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 16 * 1024 * 1024,
    command: ['/usr/local/bin/node', '/opt/lilly-browser/worker/stdio-worker.js', '--serve'] }));
  expect((await f.saved()).phase).toBe('ready');
  expect((await f.saved()).nodeBinding).toMatchObject({ nodeName: 'fixture-node', initPid: 123 });
  expect(f.bindContainer.mock.invocationCallOrder[0]).toBeLessThan(f.cluster.exec.mock.invocationCallOrder[0]);
  expect(await lease.computer.open(f.scope, { url: 'https://fixture/' })).toEqual({ computerId: 'fixture-computer' });
  expect(f.scope.authorize).toHaveBeenCalledTimes(1);
  await f.finish(lease);
  expect((await f.saved()).phase).toBe('closed');
  expect([...f.objects.values()].map(value => value.kind)).toEqual(['PersistentVolumeClaim']);
  expect(f.observeTermination).toHaveBeenCalled();
});

test('database reservation failure never provisions a resource', async () => {
  const f = await fixture(); jest.spyOn(f.service, 'reserveComputerLease').mockRejectedValue(new Error('Unavailable'));
  await expect(f.factory(f.scope)).rejects.toThrow('Unavailable');
  expect(f.cluster.request).not.toHaveBeenCalled(); expect(f.cluster.exec).not.toHaveBeenCalled();
});

test('browser stop receipt is durably readable before Pod DELETE and recovery', async () => {
  const f = await fixture(); const worker = await f.factory(f.scope);
  const request = f.cluster.request.getMockImplementation(); const events = [];
  f.requestStop.mockImplementation(async () => { events.push('stop'); return { requested: true }; });
  const capture = f.captureStop.getMockImplementation();
  f.captureStop.mockImplementation(async input => {
    expect([...f.objects.values()].some(value => value.kind === 'Pod')).toBe(true);
    events.push('capture'); return capture(input);
  });
  f.cluster.request.mockImplementation(async (...args) => {
    if (args[0] === 'DELETE') { expect((await f.saved()).stopEvidence).toBeDefined(); events.push('delete'); }
    return request(...args);
  });
  const observe = f.observeTermination.getMockImplementation();
  f.observeTermination.mockImplementation(async input => { expect(input.lease.stopEvidence).toBeDefined(); events.push('recover'); return observe(input); });
  await worker.close(); expect(events).toEqual(['stop', 'capture', 'delete', 'recover']); await f.finish(worker);
});

test.each(['missing', 'foreign', 'uncommitted', 'timeout', 'stop_failed'])('%s pre-deletion evidence retains Pod and blocks recovery', async mode => {
  const f = await fixture(); const worker = await f.factory(f.scope); let signal;
  if (mode === 'missing') f.captureStop.mockResolvedValue(null);
  if (mode === 'foreign') { const capture = f.captureStop.getMockImplementation(); f.captureStop.mockImplementation(async input => ({ ...await capture(input), fingerprint: 'f'.repeat(64) })); }
  if (mode === 'uncommitted') jest.spyOn(f.service, 'recordComputerStop').mockRejectedValue(new Error('not committed'));
  if (mode === 'timeout') f.requestStop.mockImplementation(input => { signal = input.signal; return new Promise(() => {}); });
  if (mode === 'stop_failed') f.requestStop.mockRejectedValue(new Error('unknown stop request'));
  await expect(worker.close()).rejects.toMatchObject({ code: 'computer_supervisor_cleanup_unconfirmed' });
  expect(f.cluster.request.mock.calls.some(call => call[0] === 'DELETE')).toBe(false);
  expect(f.observeTermination).not.toHaveBeenCalled(); expect((await f.saved()).phase).toBe('reconciliation');
  expect([...f.objects.values()].some(value => value.kind === 'Pod')).toBe(true);
  if (mode === 'timeout') expect(signal.aborted).toBe(true);
  await f.finish(worker);
});

test('lost committed stop acknowledgment is read back before deleting the Pod', async () => {
  const f = await fixture(); const worker = await f.factory(f.scope); const write = f.service.recordComputerStop.bind(f.service);
  jest.spyOn(f.service, 'recordComputerStop').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('reply lost'); });
  await worker.close(); expect((await f.saved()).phase).toBe('closed');
  expect(f.captureStop).toHaveBeenCalledTimes(1); await f.finish(worker);
});

test('late stop observation after deadline cannot archive or delete', async () => {
  const f = await fixture(); const worker = await f.factory(f.scope); const capture = f.captureStop.getMockImplementation(); let finish;
  f.captureStop.mockImplementation(input => new Promise(resolve => { finish = async () => resolve(await capture(input)); }));
  await expect(worker.close()).rejects.toBeDefined(); await finish(); await new Promise(resolve => setImmediate(resolve));
  expect((await f.saved()).stopEvidence).toBeUndefined();
  expect(f.cluster.request.mock.calls.some(call => call[0] === 'DELETE')).toBe(false); await f.finish(worker);
});

test.each([false, true])('real browser node adapter composes with TeamService and supervisor (PID changed: %s)', async changedPid => {
  const f = await fixture(); const boot = randomUUID(); let exited = false; let startTicks = '12345';
  const reader = {
    inspectContainer: jest.fn(async () => {
      const lease = await f.saved();
      return { status: { id: lease.containerId.slice(13), state: exited ? 'CONTAINER_EXITED' : 'CONTAINER_RUNNING', labels: {
        'io.kubernetes.pod.uid': lease.podUid, 'io.kubernetes.pod.namespace': lease.namespace,
        'io.kubernetes.pod.name': lease.podName, 'io.kubernetes.container.name': 'worker',
      } }, info: { pid: 123 } };
    }),
    observeProcess: jest.fn(async () => {
      const init = { pid: 123, namespacePid: 1, startTicks, pidNamespace: '42', mountNamespace: '43' };
      return { hostBootId: boot, init, process: { ...init } };
    }),
    observeCgroup: jest.fn(async ({ podUid, containerId }) => ({ populated: !exited,
      identity: { path: `/kubepods/pod${podUid}/${containerId.slice(13)}`, device: '0', inode: '789' } })),
    readCgroup: jest.fn(async binding => ({ populated: !exited, identity: binding.cgroup, hostBootId: boot })),
  };
  const execute = jest.fn(async () => { exited = true; return { stdout: '', stderr: '' }; });
  const recovery = { recover: jest.fn(async identity => {
    const lease = await f.saved(); expect(lease.stopEvidence).toBeDefined();
    await f.service.recordComputerRecovery(identity, syntheticProfileRecovery(lease));
  }) };
  const adapter = createBrowserNodeAdapter({ service: f.service, reader, recovery, execute,
    readPod: ({ namespace, name, signal }) => f.cluster.request('GET', `/api/v1/namespaces/${namespace}/pods/${name}`, undefined, { signal }),
    readFile: async () => boot, hostname: 'fixture-node', platform: 'linux', now: () => '2026-09-07T01:00:00.000Z' });
  const factory = createKubernetesComputerFactory({ service: f.service, configuration: { ...configuration, closeTimeoutMs: 100, readyTimeoutMs: 100 }, cluster: f.cluster, ...adapter });
  const worker = await factory(f.scope);
  if (changedPid) startTicks = '99999';
  if (changedPid) {
    await expect(worker.close()).rejects.toBeDefined(); expect(execute).not.toHaveBeenCalled(); expect(recovery.recover).not.toHaveBeenCalled();
    expect([...f.objects.values()].some(value => value.kind === 'Pod')).toBe(true);
  } else {
    await worker.close(); expect((await f.saved()).phase).toBe('closed');
    expect(execute).toHaveBeenCalledWith('/usr/local/bin/crictl', [
      '--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=15s', 'stop', '--timeout=10', 'b'.repeat(64),
    ], expect.objectContaining({ shell: false, timeout: 20000, maxBuffer: 16384 }));
    expect(recovery.recover).toHaveBeenCalledTimes(1); expect(reader.readCgroup).toHaveBeenCalledTimes(2);
  }
  await f.finish(worker);
});

test('node binding persists across fresh services and rejects mutation after JSONB-style key reordering', async () => {
  const f = await fixture(); const worker = await f.factory(f.scope); const before = await f.saved();
  const reverse = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value;
  await f.store.mutate(f.scope.teamId, f.scope.ownerId, team => { team.tasks[0].computerLease.nodeBinding = reverse(before.nodeBinding); });
  const fresh = new TeamService({ store: f.store });
  const record = await fresh.recordComputerLease(f.scope, { leaseId: before.leaseId, phase: 'ready', nodeBinding: before.nodeBinding });
  expect(record.nodeBinding).toEqual(before.nodeBinding);
  await expect(fresh.recordComputerLease(f.scope, { leaseId: before.leaseId, phase: 'ready',
    nodeBinding: { ...before.nodeBinding, initStartTicks: '999' } })).rejects.toMatchObject({ code: 'team_computer_lease_conflict' });
  expect((await f.saved()).nodeBinding).toEqual(before.nodeBinding);
  expect(JSON.stringify(await fresh.context(f.scope.teamId, f.scope.ownerId, f.scope.agentId))).not.toContain(before.nodeBinding.hostBootId);
  await f.finish(worker);
});

test.each(['foreign_lease', 'wrong_node', 'missing_cgroup'])('unverified %s node binding never reaches exec', async mode => {
  const f = await fixture(); const original = f.bindContainer.getMockImplementation();
  f.bindContainer.mockImplementation(async input => {
    const binding = await original(input);
    if (mode === 'foreign_lease') binding.leaseId = randomUUID();
    if (mode === 'wrong_node') binding.nodeName = 'different-node';
    if (mode === 'missing_cgroup') delete binding.cgroup;
    return binding;
  });
  await expect(f.factory(f.scope)).rejects.toBeDefined(); expect(f.cluster.exec).not.toHaveBeenCalled();
});

test('a stalled node binder is bounded and receives cancellation without executing a worker', async () => {
  const f = await fixture(); let signal;
  f.bindContainer.mockImplementation(input => { signal = input.signal; return new Promise(() => {}); });
  await expect(f.factory(f.scope)).rejects.toMatchObject({ code: 'computer_supervisor_node_binding_cancelled' });
  expect(signal.aborted).toBe(true); expect(f.bindContainer).toHaveBeenCalledTimes(1);
  expect(f.cluster.exec).not.toHaveBeenCalled();
});

test('lost persistence of node binding never starts a browser', async () => {
  const f = await fixture(); const persist = f.service.recordComputerLease.bind(f.service);
  jest.spyOn(f.service, 'recordComputerLease').mockImplementation((identity, update) => {
    if (update.nodeBinding) throw new Error('Persistence unavailable');
    return persist(identity, update);
  });
  await expect(f.factory(f.scope)).rejects.toBeDefined(); expect(f.cluster.exec).not.toHaveBeenCalled();
});

test('unknown Pod create is never retried or released on an empty inventory', async () => {
  const f = await fixture(); const original = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation((method, path, body) => {
    if (method === 'POST' && body.kind === 'Pod') throw new Error('Uncertain create');
    return original(method, path, body);
  });
  await expect(f.factory(f.scope)).rejects.toMatchObject({ code: 'computer_supervisor_cleanup_unconfirmed' });
  expect((await f.saved()).phase).toBe('reconciliation');
  expect(f.cluster.request.mock.calls.filter(call => call[0] === 'POST' && call[2].kind === 'Pod')).toHaveLength(1);
  expect(f.observeTermination).not.toHaveBeenCalled(); expect(f.cluster.exec).not.toHaveBeenCalled();
});

test('lost committed Pod create is bound and cleaned exactly once without execution', async () => {
  const f = await fixture(); const original = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation(async (method, path, body) => {
    const result = await original(method, path, body);
    if (method === 'POST' && body.kind === 'Pod') throw new Error('Lost reply after commit');
    return result;
  });
  await expect(f.factory(f.scope)).rejects.toMatchObject({ code: 'computer_supervisor_provision_failed' });
  expect((await f.saved()).phase).toBe('closed');
  expect(f.cluster.exec).not.toHaveBeenCalled(); expect(f.observeTermination).toHaveBeenCalled();
  expect([...f.objects.values()].map(value => value.kind)).toEqual(['PersistentVolumeClaim']);
});

test.each(['missing', 'foreign'])('persisted profile %s is never recreated or adopted', async mode => {
  const f = await fixture();
  const reserve = f.service.reserveComputerLease.bind(f.service);
  jest.spyOn(f.service, 'reserveComputerLease').mockImplementation(async (...args) => {
    const record = await reserve(...args);
    await f.service.recordComputerLease(f.scope, { leaseId: record.leaseId, phase: 'reserved', pvcUid: randomUUID() });
    return f.saved();
  });
  if (mode === 'foreign') {
    const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation((method, path, body) => method === 'GET' && path.includes('/persistentvolumeclaims/')
      ? { metadata: { name: path.split('/').at(-1), namespace: 'lilly-team-workers', uid: randomUUID(), annotations: {} } }
      : original(method, path, body));
  }
  await expect(f.factory(f.scope)).rejects.toMatchObject({ code: `computer_supervisor_profile_${mode === 'missing' ? 'missing' : 'identity_conflict'}` });
  expect(f.cluster.request.mock.calls.some(call => ['POST', 'DELETE'].includes(call[0]))).toBe(false);
});

test.each(['pod_uid', 'container', 'image', 'restart'])('unverified %s never reaches browser exec', async mode => {
  const f = await fixture(); const original = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation(async (method, path, body) => {
    const result = await original(method, path, body);
    if (method === 'GET' && result?.kind === 'Pod') {
      if (mode === 'pod_uid') result.metadata.uid = randomUUID();
      if (mode === 'container') result.status.containerStatuses[0].containerID = 'docker://wrong';
      if (mode === 'image') result.spec.containers[0].image = 'untrusted:latest';
      if (mode === 'restart') result.status.containerStatuses[0].restartCount = 1;
    }
    return result;
  });
  await expect(f.factory(f.scope)).rejects.toBeDefined();
  expect(f.cluster.exec).not.toHaveBeenCalled();
  if (mode === 'pod_uid') expect(f.cluster.request.mock.calls.some(call => call[0] === 'DELETE')).toBe(false);
});

test.each(['missing', 'different', 'profile_locked', 'missing_receipt'])('Pod absence with %s termination evidence keeps ownership unresolved', async mode => {
  const f = await fixture(); const lease = await f.factory(f.scope);
  f.observeTermination.mockImplementation(async ({ lease: record }) => mode === 'missing' ? null : {
    ...record, ...(mode === 'different' ? { containerId: `containerd://${'f'.repeat(64)}` } : {}),
    podStopped: true, profileReleased: mode !== 'profile_locked',
  });
  const results = await lease.computer.dispose();
  expect(results.some(result => result.status === 'rejected')).toBe(true);
  await expect(lease.close()).rejects.toMatchObject({ code: 'computer_supervisor_cleanup_unconfirmed' });
  expect((await f.saved()).phase).toBe('reconciliation');
  expect([...f.objects.values()].map(value => value.kind)).toEqual(['PersistentVolumeClaim']);
});

test('stalled termination observation is bounded, cancelled and never replayed', async () => {
  const f = await fixture(); const lease = await f.factory(f.scope); let signal;
  f.observeTermination.mockImplementation(input => { signal = input.signal; return new Promise(() => {}); });
  const first = lease.close();
  await expect(first).rejects.toMatchObject({ code: 'computer_supervisor_cleanup_unconfirmed' });
  expect(signal.aborted).toBe(true); expect(lease.close()).toBe(first);
  expect(f.observeTermination).toHaveBeenCalledTimes(1);
  expect((await f.saved()).phase).toBe('reconciliation');
});

test('a stop receipt without a profile recovery receipt cannot close the supervisor lease', async () => {
  const f = await fixture(); const worker = await f.factory(f.scope);
  const observe = f.observeTermination.getMockImplementation();
  f.observeTermination.mockImplementation(async input => { const evidence = await observe(input); delete evidence.profileRecovery; return evidence; });
  await expect(worker.close()).rejects.toMatchObject({ code: 'computer_supervisor_cleanup_unconfirmed' });
  const saved = await f.saved(); expect(saved.phase).toBe('reconciliation');
  expect(saved.stopEvidence).toBeDefined(); expect(saved.profileRecovery).toBeUndefined();
  await f.finish(worker);
});

test('lost durable profile acknowledgment retains the receipt and unresolved supervisor ownership', async () => {
  const f = await fixture(); const worker = await f.factory(f.scope);
  const write = f.service.recordComputerRecovery.bind(f.service);
  jest.spyOn(f.service, 'recordComputerRecovery').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('lost acknowledgment'); });
  const stopping = worker.close();
  await expect(stopping).rejects.toMatchObject({ code: 'computer_supervisor_cleanup_unconfirmed' });
  expect(worker.close()).toBe(stopping); expect(f.observeTermination).toHaveBeenCalledTimes(1);
  const fresh = new TeamService({ store: f.store });
  const saved = (await fresh.get(f.scope.teamId, f.scope.ownerId)).tasks[0].computerLease;
  expect(saved.phase).toBe('reconciliation'); expect(saved.profileRecovery).toBeDefined();
  expect(await fresh.recordComputerRecovery(f.scope, saved.profileRecovery)).toEqual(saved.profileRecovery);
  await fresh.recordComputerLease(f.scope, { leaseId: saved.leaseId, phase: 'closing' });
  expect((await fresh.recordComputerLease(f.scope, { leaseId: saved.leaseId, phase: 'closed', podStopped: true, profileReleased: true })).phase).toBe('closed');
  await f.finish(worker);
});

test('image replacement during ready-record persistence is rejected before exec', async () => {
  const f = await fixture(); const persist = f.service.recordComputerLease.bind(f.service);
  jest.spyOn(f.service, 'recordComputerLease').mockImplementation(async (identity, update) => {
    const saved = await persist(identity, update);
    if (update.phase === 'ready') [...f.objects.values()].find(value => value.kind === 'Pod').spec.containers[0].image = 'changed:latest';
    return saved;
  });
  await expect(f.factory(f.scope)).rejects.toMatchObject({ code: 'computer_supervisor_image_unverified' });
  expect(f.cluster.exec).not.toHaveBeenCalled();
});

test('composed lazy runtime owns durable lease and only permits task result after exact cleanup', async () => {
  const f = await fixture();
  const runtime = createKubernetesComputerRuntime({ service: f.service, authorize: f.scope.authorize,
    configuration, cluster: f.cluster, bindContainer: f.bindContainer, requestStop: f.requestStop, captureStop: f.captureStop, observeTermination: f.observeTermination });
  expect(f.cluster.request).not.toHaveBeenCalled();
  await runtime.open(f.scope, { url: 'https://fixture/' });
  expect((await f.saved()).phase).toBe('ready');
  const result = { status: 'succeeded', summary: 'Fixture state only.', artifactIds: [] };
  await expect(f.service.recordResult(f.scope.teamId, f.scope.ownerId, f.scope.claim, result)).rejects.toMatchObject({ code: 'team_computer_unsettled' });
  await runtime.releaseClaim(f.scope);
  expect((await f.saved()).phase).toBe('closed');
  expect((await f.service.recordResult(f.scope.teamId, f.scope.ownerId, f.scope.claim, result)).status).toBe('needs_review');
  expect(f.scope.authorize).toHaveBeenCalledTimes(2);
  await runtime.dispose();
});

test('lost graceful shutdown reply does not strand a durably recovered workspace or rerun the worker', async () => {
  const f = await fixture();
  f.remote.dispose.mockResolvedValue([{ status: 'rejected', reason: new Error('Fixture browser reply unavailable') }]);
  const runtime = createKubernetesComputerRuntime({ service: f.service, authorize: f.scope.authorize,
    configuration, cluster: f.cluster, bindContainer: f.bindContainer, requestStop: f.requestStop,
    captureStop: f.captureStop, observeTermination: f.observeTermination });
  await runtime.open(f.scope, { url: 'https://fixture/' });
  await expect(runtime.releaseClaim(f.scope)).resolves.toBeUndefined();
  expect((await f.saved()).phase).toBe('closed');
  const result = await f.service.recordResult(f.scope.teamId, f.scope.ownerId, f.scope.claim,
    { status: 'succeeded', summary: 'Verified fixture output.', artifactIds: [] });
  expect(result.status).toBe('needs_review');
  expect(f.cluster.exec).toHaveBeenCalledTimes(1); expect(f.remote.open).toHaveBeenCalledTimes(1);
  expect([...f.objects.values()].map(value => value.kind)).toEqual(['PersistentVolumeClaim']);
  expect(await runtime.dispose()).toEqual([]);
});

test.each(['missing_stop', 'missing_profile', 'changed_claim', 'changed_lease', 'pod_present', 'helper_unclosed', 'pod_lookup_failed'])
('closure read-back refuses %s without issuing new effects', async mode => {
  const f = await fixture(); const lease = await f.factory(f.scope);
  expect(await lease.confirmClosed()).toBe(false);
  const originalPod = structuredClone([...f.objects.values()].find(value => value.kind === 'Pod'));
  await f.finish(lease); expect(await lease.confirmClosed()).toBe(true);
  const storedTask = f.store.rows.get(f.scope.teamId).tasks[0];
  if (mode === 'missing_stop') delete storedTask.computerLease.stopEvidence;
  if (mode === 'missing_profile') delete storedTask.computerLease.profileRecovery;
  if (mode === 'changed_claim') storedTask.worker.claimId = randomUUID();
  if (mode === 'changed_lease') storedTask.computerLease.leaseId = randomUUID();
  if (mode === 'helper_unclosed') storedTask.computerLease.recoveryHelper = { phase: 'closing' };
  if (mode === 'pod_present') f.objects.set(`/api/v1/namespaces/lilly-team-workers/pods/${originalPod.metadata.name}`, originalPod);
  if (mode === 'pod_lookup_failed') f.cluster.request.mockRejectedValue(new Error('Fixture API unavailable'));
  const mutations = () => f.cluster.request.mock.calls.filter(([method]) => method !== 'GET').length;
  const before = mutations();
  expect(await lease.confirmClosed()).toBe(false); expect(mutations()).toBe(before);
  expect(f.cluster.exec).toHaveBeenCalledTimes(1);
});

test.each(['profile_mount', 'privileged', 'unconfined', 'host_network', 'sidecar'])('mutated %s cannot enter the private browser execution path', async mode => {
  const f = await fixture(); const original = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation(async (method, path, body) => {
    const result = await original(method, path, body);
    if (method === 'GET' && result?.kind === 'Pod') {
      if (mode === 'profile_mount') result.spec.volumes[0].persistentVolumeClaim.claimName = 'different-private-profile';
      if (mode === 'privileged') result.spec.containers[0].securityContext.privileged = true;
      if (mode === 'unconfined') result.spec.containers[0].securityContext.seccompProfile.type = 'Unconfined';
      if (mode === 'host_network') result.spec.hostNetwork = true;
      if (mode === 'sidecar') result.spec.containers.push({ name: 'unexpected' });
    }
    return result;
  });
  await expect(f.factory(f.scope)).rejects.toMatchObject({ code: 'computer_supervisor_sandbox_unverified' });
  expect(f.cluster.exec).not.toHaveBeenCalled();
});
