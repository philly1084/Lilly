'use strict';

const { randomUUID } = require('node:crypto');
const { reserveRecoveryHelper, advanceRecoveryHelper, recoveryHelperFingerprint } = require('./recovery-helper');
const { beginRecoveryHelperLaunch } = require('./recovery-launch');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const { createRecoverySupervisor } = require('./recovery-supervisor');
const { createRecoveryNodeAdapter } = require('./recovery-node-adapter');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const now = '2026-09-07T03:00:00.000Z';
  const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: randomUUID() } };
  const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: identity.claim.claimId,
    ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`, phase: 'closing',
    profileKey: 'e'.repeat(64), identityHash: 'a'.repeat(64), pvcName: `browser-profile-${'a'.repeat(32)}` };
  const fields = Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]]));
  lease.nodeBinding = { version: 1, ...fields, nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 111, initStartTicks: '112', pidNamespace: '113', mountNamespace: '114',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '115' }, observedAt: '2026-09-07T01:00:00.000Z' };
  lease.stopEvidence = createBrowserStopEvidence(lease, { ...fields, podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T01:30:00.000Z' });
  const team = { id: identity.teamId, ownerId: identity.ownerId, tasks: [{ id: identity.taskId, agentId: identity.agentId,
    worker: { id: identity.claim.workerId, claimId: identity.claim.claimId, executionOwner: { bootId: lease.ownerBootId } }, computerLease: lease }] };
  const service = { get: jest.fn(async () => copy(team)), reserveComputerRecoveryHelper: jest.fn(async (_identity, input) => copy(reserveRecoveryHelper(lease, input, now))),
    beginComputerRecoveryHelperLaunch: jest.fn(async (_identity, input) => copy(beginRecoveryHelperLaunch(lease, input, now))),
    recordComputerRecoveryHelper: jest.fn(async (_identity, input) => copy(advanceRecoveryHelper(lease, input, now))) };
  const pvc = { metadata: { namespace: lease.namespace, name: lease.pvcName, uid: lease.pvcUid, annotations: { 'lilly.ai/identity': lease.identityHash } },
    spec: { storageClassName: 'local-path', volumeMode: 'Filesystem', accessModes: ['ReadWriteOnce'] }, status: { phase: 'Bound' } };
  const resources = { pod: null }; const events = [];
  const create = body => {
    const pod = copy(body); pod.metadata.uid = randomUUID();
    pod.status = { phase: 'Running', containerStatuses: [{ name: 'worker', containerID: `containerd://${'d'.repeat(64)}`, state: { running: {} },
      restartCount: 0, imageID: body.spec.containers[0].image }] };
    resources.pod = pod; return copy(pod);
  };
  const cluster = { request: jest.fn(async (method, url, body) => {
    if (method === 'GET') return url.includes('/persistentvolumeclaims/') ? copy(pvc) : resources.pod ? copy(resources.pod) : null;
    if (method === 'POST') { expect(lease.recoveryHelper.launchStartedAt).toBe(now); events.push('create'); return create(body); }
    if (method === 'DELETE') {
      expect(lease.recoveryHelper.stopEvidence).toBeDefined(); expect(body.preconditions.uid).toBe(resources.pod.metadata.uid);
      expect(url).toContain('/pods/'); events.push('delete'); resources.pod = null; return {};
    }
    throw new Error('Unexpected fixture request');
  }) };
  const configuration = { namespace: lease.namespace, image: `registry.example/recovery@sha256:${'c'.repeat(64)}`, timeoutMs: 1000, pollMs: 1 };
  const bindContainer = jest.fn(async ({ lease: current }) => {
    events.push('bind'); const helper = current.recoveryHelper;
    return { version: 1, podUid: helper.podUid, containerId: helper.containerId, nodeName: current.nodeBinding.nodeName,
      hostBootId: current.nodeBinding.hostBootId, initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
      cgroup: { path: `/kubepods/pod${helper.podUid}/${helper.containerId.slice(13)}`, device: '0', inode: '999' }, observedAt: now };
  });
  const controller = { recover: jest.fn(async () => { events.push('recover'); lease.profileRecovery = syntheticProfileRecovery(lease); return copy(lease.profileRecovery); }) };
  const requestStop = jest.fn(async () => { events.push('stop'); });
  const captureStop = jest.fn(async () => { events.push('capture'); return { version: 1, fingerprint: recoveryHelperFingerprint(lease, lease.recoveryHelper),
    source: 'cri-exited-and-cgroup-v2-empty', observedAt: now }; });
  const options = { service, cluster, configuration, controller, bindContainer, requestStop, captureStop };
  return { identity, lease, team, service, pvc, resources, create, events, options, cluster, bindContainer, controller, requestStop, captureStop,
    supervisor: createRecoverySupervisor(options) };
}

test('creates once, recovers, archives stop before exact-UID deletion and retains browser ownership', async () => {
  const f = fixture(); const result = await f.supervisor.recover(f.identity);
  expect(result).toEqual(f.lease.profileRecovery); expect(f.events).toEqual(['create', 'bind', 'recover', 'stop', 'capture', 'delete']);
  expect(f.lease.recoveryHelper.phase).toBe('closed'); expect(f.lease.phase).toBe('closing');
  expect(await createRecoverySupervisor(f.options).recover(f.identity)).toEqual(result);
  expect(f.events.filter(event => event === 'create')).toHaveLength(1);
  const pod = f.cluster.request.mock.calls.find(([method]) => method === 'POST')[2];
  expect(pod.spec.automountServiceAccountToken).toBe(false); expect(pod.spec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
  expect(pod.spec.volumes[0].persistentVolumeClaim.claimName).toBe(f.lease.pvcName);
});

test.each([false, true])('composes real node stop/archive adapter with lifecycle (lost stop reply: %s)', async lostReply => {
  const f = fixture(); let exited = false;
  const reader = {
    inspectContainer: jest.fn(async () => {
      const helper = f.lease.recoveryHelper;
      return { status: { id: helper.containerId.slice(13), state: exited ? 'CONTAINER_EXITED' : 'CONTAINER_RUNNING', labels: {
        'io.kubernetes.pod.uid': helper.podUid, 'io.kubernetes.pod.namespace': helper.namespace,
        'io.kubernetes.pod.name': helper.podName, 'io.kubernetes.container.name': 'worker',
      } }, info: { pid: 321 } };
    }),
    observeProcess: jest.fn(async () => {
      const binding = f.lease.recoveryHelper.nodeBinding;
      const init = { pid: binding.initPid, namespacePid: 1, startTicks: binding.initStartTicks,
        pidNamespace: binding.pidNamespace, mountNamespace: binding.mountNamespace };
      return { hostBootId: binding.hostBootId, init, process: { ...init } };
    }),
    observeCgroup: jest.fn(async () => ({ populated: !exited, identity: f.lease.recoveryHelper.nodeBinding.cgroup })),
    readCgroup: jest.fn(async () => ({ populated: !exited, identity: f.lease.recoveryHelper.nodeBinding.cgroup,
      hostBootId: f.lease.nodeBinding.hostBootId })),
  };
  const execute = jest.fn(async () => {
    expect(f.lease.profileRecovery).toBeDefined(); expect(f.lease.recoveryHelper.phase).toBe('closing');
    exited = true; f.events.push('node-stop');
    if (lostReply) throw new Error('command reply lost after stopping');
    return { stdout: 'ignored', stderr: '' };
  });
  const adapterOptions = { service: f.service, reader, execute, readPod: async () => copy(f.resources.pod),
    readFile: async () => f.lease.nodeBinding.hostBootId, hostname: 'fixture-node', platform: 'linux', now: () => '2026-09-07T03:00:00.000Z' };
  const run = () => createRecoverySupervisor({ ...f.options, ...createRecoveryNodeAdapter(adapterOptions) }).recover(f.identity);
  if (lostReply) {
    await expect(run()).rejects.toMatchObject({ code: 'computer_recovery_lifecycle_unknown' });
    expect(f.events).not.toContain('delete'); expect(f.lease.recoveryHelper.stopEvidence).toBeUndefined();
  }
  expect(await run()).toEqual(f.lease.profileRecovery);
  expect(f.lease.recoveryHelper.phase).toBe('closed'); expect(f.lease.phase).toBe('closing');
  expect(f.events.filter(event => event === 'create')).toHaveLength(1);
  expect(f.controller.recover).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
  expect(reader.readCgroup).toHaveBeenCalledTimes(2);
  expect(f.events.indexOf('node-stop')).toBeLessThan(f.events.indexOf('delete'));
  expect(f.lease.recoveryHelper.stopEvidence.source).toBe('cri-exited-and-cgroup-v2-empty');
});

test('a lost create response reuses the exact object without another POST', async () => {
  const f = fixture(); const request = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation(async (...args) => { const result = await request(...args); if (args[0] === 'POST') throw new Error('reply lost'); return result; });
  await f.supervisor.recover(f.identity);
  expect(f.events.filter(event => event === 'create')).toHaveLength(1);
});

test('unknown creation with no observed object never replays POST after reconstruction', async () => {
  const f = fixture(); const request = f.cluster.request.getMockImplementation(); let attempted;
  f.cluster.request.mockImplementation(async (...args) => { if (args[0] === 'POST') { attempted = args[2]; throw new Error('unknown'); } return request(...args); });
  await expect(f.supervisor.recover(f.identity)).rejects.toMatchObject({ code: 'computer_recovery_lifecycle_unknown' });
  await expect(createRecoverySupervisor(f.options).recover(f.identity)).rejects.toMatchObject({ code: 'computer_recovery_lifecycle_unknown' });
  expect(f.cluster.request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  f.create(attempted); // The original delayed API operation becomes visible.
  await createRecoverySupervisor(f.options).recover(f.identity);
  expect(f.cluster.request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
});

test('lost launch permission reply holds the intent instead of fabricating new launch authority', async () => {
  const f = fixture(); const launch = f.service.beginComputerRecoveryHelperLaunch.getMockImplementation();
  f.service.beginComputerRecoveryHelperLaunch.mockImplementationOnce(async (...args) => { await launch(...args); throw new Error('lost launch reply'); });
  await expect(f.supervisor.recover(f.identity)).rejects.toBeDefined();
  await expect(createRecoverySupervisor(f.options).recover(f.identity)).rejects.toBeDefined();
  expect(f.cluster.request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(0);
});

test('restart after a failed binding reuses the persisted helper Pod', async () => {
  const f = fixture(); f.bindContainer.mockRejectedValueOnce(new Error('observer unavailable'));
  await expect(f.supervisor.recover(f.identity)).rejects.toBeDefined();
  const helperId = f.lease.recoveryHelper.helperId; const podUid = f.lease.recoveryHelper.podUid;
  await createRecoverySupervisor(f.options).recover(f.identity);
  expect(f.lease.recoveryHelper.helperId).toBe(helperId); expect(f.lease.recoveryHelper.podUid).toBe(podUid);
  expect(f.events.filter(event => event === 'create')).toHaveLength(1);
});

test.each(['pvc', 'image', 'secret', 'sidecar', 'privileged', 'container', 'replacement'])('rejects %s ownership/sandbox mismatch before execution', async mode => {
  const f = fixture(); if (mode === 'pvc') f.pvc.metadata.uid = randomUUID();
  const create = f.create; const request = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation(async (...args) => {
    if (args[0] === 'POST') {
      const pod = create(args[2]);
      if (mode === 'image') f.resources.pod.status.containerStatuses[0].imageID = 'untrusted';
      if (mode === 'secret') f.resources.pod.spec.volumes.push({ name: 'secret', secret: { secretName: 'private' } });
      if (mode === 'sidecar') f.resources.pod.spec.containers.push({ name: 'extra' });
      if (mode === 'privileged') f.resources.pod.spec.containers[0].securityContext.privileged = true;
      if (mode === 'container') f.resources.pod.status.containerStatuses[0].restartCount = 1;
      if (mode === 'replacement') f.resources.pod.metadata.uid = randomUUID();
      return pod;
    }
    return request(...args);
  });
  await expect(f.supervisor.recover(f.identity)).rejects.toMatchObject({ code: 'computer_recovery_lifecycle_unknown' });
  expect(f.controller.recover).not.toHaveBeenCalled(); expect(f.requestStop).not.toHaveBeenCalled();
});

test('signal success or missing death evidence cannot delete the Pod or release the helper', async () => {
  const f = fixture(); f.options.configuration.timeoutMs = 25; f.captureStop.mockResolvedValue(null);
  await expect(createRecoverySupervisor(f.options).recover(f.identity)).rejects.toBeDefined();
  expect(f.lease.recoveryHelper.phase).toBe('closing'); expect(f.events).not.toContain('delete');
  f.captureStop.mockImplementation(async () => ({ version: 1, fingerprint: recoveryHelperFingerprint(f.lease, f.lease.recoveryHelper),
    source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T03:00:00.000Z' }));
  await createRecoverySupervisor(f.options).recover(f.identity);
  expect(f.controller.recover).toHaveBeenCalledTimes(1); expect(f.lease.recoveryHelper.phase).toBe('closed');
});

test('lost deletion reply resumes from archived stop without repeating recovery or stop requests', async () => {
  const f = fixture(); const request = f.cluster.request.getMockImplementation();
  f.cluster.request.mockImplementation(async (...args) => { const result = await request(...args); if (args[0] === 'DELETE') throw new Error('lost reply'); return result; });
  await expect(f.supervisor.recover(f.identity)).rejects.toBeDefined();
  expect(f.lease.recoveryHelper.stopEvidence).toBeDefined();
  await createRecoverySupervisor(f.options).recover(f.identity);
  expect(f.controller.recover).toHaveBeenCalledTimes(1); expect(f.requestStop).toHaveBeenCalledTimes(1); expect(f.captureStop).toHaveBeenCalledTimes(1);
});

test('late node binding cannot mark a timed-out helper ready or start recovery', async () => {
  const f = fixture(); f.options.configuration.timeoutMs = 25; let finish;
  const bind = f.bindContainer.getMockImplementation();
  f.bindContainer.mockImplementationOnce(value => new Promise(resolve => { finish = async () => resolve(await bind(value)); }));
  await expect(createRecoverySupervisor(f.options).recover(f.identity)).rejects.toBeDefined();
  await finish(); await new Promise(resolve => setImmediate(resolve));
  expect(f.lease.recoveryHelper.phase).toBe('provisioning'); expect(f.controller.recover).not.toHaveBeenCalled();
});
