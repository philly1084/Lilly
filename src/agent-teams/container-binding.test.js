'use strict';

const { bindExecutionContainer } = require('./container-binding');
const bootId = '01234567-89ab-4cde-8fab-0123456789ab';
const owner = { version: 1, bootId, platform: 'linux', pid: 7, startedAt: '2026-09-07T00:00:00.000Z',
  kernel: { bootId, startTicks: '400', pidNamespace: '1001', mountNamespace: '1002' },
  pod: { namespace: 'kimibuilt', name: 'backend-a', uid: bootId, containerName: 'backend' } };
function fixture() {
  const pod = { metadata: { namespace: 'kimibuilt', name: 'backend-a', uid: bootId }, spec: { nodeName: 'node-a' },
    status: { containerStatuses: [{ name: 'backend', containerID: `containerd://${'a'.repeat(64)}`, state: { running: {} } }] } };
  const runtime = { status: { id: 'a'.repeat(64), state: 'CONTAINER_RUNNING', labels: {
    'io.kubernetes.pod.uid': bootId, 'io.kubernetes.pod.namespace': 'kimibuilt', 'io.kubernetes.pod.name': 'backend-a',
    'io.kubernetes.container.name': 'backend' } }, info: { pid: 500, secret: 'PRIVATE_RUNTIME_CONFIG' } };
  const observation = { hostBootId: bootId,
    init: { pid: 500, startTicks: '300', pidNamespace: '1001', mountNamespace: '1002' },
    process: { pid: 510, namespacePid: 7, startTicks: '400', pidNamespace: '1001', mountNamespace: '1002' } };
  const args = { owner, readPod: jest.fn(async () => structuredClone(pod)), inspectContainer: jest.fn(async () => structuredClone(runtime)),
    observeProcess: jest.fn(async () => structuredClone(observation)), now: () => '2026-09-07T01:00:00.000Z' };
  return { pod, runtime, observation, args };
}

test('binds exact Pod, CRI container and owner process using two matching observations', async () => {
  const { args } = fixture();
  const result = await bindExecutionContainer(args);
  expect(result).toEqual({ version: 1, containerId: `containerd://${'a'.repeat(64)}`, nodeName: 'node-a', podUid: bootId,
    hostBootId: bootId, initPid: 500, initStartTicks: '300', hostPid: 510, processStartTicks: '400',
    pidNamespace: '1001', mountNamespace: '1002', observedAt: args.now() });
  for (const reader of [args.readPod, args.inspectContainer, args.observeProcess]) expect(reader).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_RUNTIME_CONFIG');
  expect(result).not.toHaveProperty('ownerStopped');
});

test.each(['pod_uid', 'host_pid', 'shared_pid', 'missing_container', 'wrong_runtime', 'cri_uid', 'cri_pid', 'cri_stopped',
  'host_boot', 'process_ticks', 'namespace_pid', 'pid_namespace', 'mount_namespace'])('rejects mismatched or unsupported binding: %s', mode => {
  const { pod, runtime, observation, args } = fixture();
  if (mode === 'pod_uid') pod.metadata.uid = 'foreign';
  if (mode === 'host_pid') pod.spec.hostPID = true;
  if (mode === 'shared_pid') pod.spec.shareProcessNamespace = true;
  if (mode === 'missing_container') pod.status.containerStatuses = [];
  if (mode === 'wrong_runtime') pod.status.containerStatuses[0].containerID = `docker://${'a'.repeat(64)}`;
  if (mode === 'cri_uid') runtime.status.labels['io.kubernetes.pod.uid'] = 'foreign';
  if (mode === 'cri_pid') runtime.info.pid = 0;
  if (mode === 'cri_stopped') runtime.status.state = 'CONTAINER_EXITED';
  if (mode === 'host_boot') observation.hostBootId = 'foreign';
  if (mode === 'process_ticks') observation.process.startTicks = '401';
  if (mode === 'namespace_pid') observation.process.namespacePid = 8;
  if (mode === 'pid_namespace') observation.init.pidNamespace = '2001';
  if (mode === 'mount_namespace') observation.process.mountNamespace = '2002';
  return expect(bindExecutionContainer(args)).rejects.toMatchObject({ code: 'team_container_binding_unavailable' });
});

test.each(['pod', 'container', 'node', 'init_pid', 'init_ticks', 'owner_pid'])('rejects a race between binding observations: %s', mode => {
  const { pod, runtime, observation, args } = fixture();
  const changedPod = structuredClone(pod); const changedRuntime = structuredClone(runtime); const changedKernel = structuredClone(observation);
  if (mode === 'pod') changedPod.metadata.uid = 'foreign';
  if (mode === 'container') changedPod.status.containerStatuses[0].containerID = `containerd://${'b'.repeat(64)}`;
  if (mode === 'node') changedPod.spec.nodeName = 'node-b';
  if (mode === 'init_pid') changedRuntime.info.pid = 501;
  if (mode === 'init_ticks') changedKernel.init.startTicks = '301';
  if (mode === 'owner_pid') changedKernel.process.pid = 511;
  args.readPod.mockResolvedValueOnce(pod).mockResolvedValueOnce(changedPod);
  args.inspectContainer.mockResolvedValueOnce(runtime).mockResolvedValueOnce(changedRuntime);
  args.observeProcess.mockResolvedValueOnce(observation).mockResolvedValueOnce(changedKernel);
  return expect(bindExecutionContainer(args)).rejects.toMatchObject({ code: 'team_container_binding_unavailable' });
});

test('read errors and unsupported owner identity fail closed without raw diagnostics', async () => {
  const { args } = fixture();
  args.inspectContainer.mockRejectedValue(new Error('PRIVATE_RUNTIME_CONFIG'));
  await expect(bindExecutionContainer(args)).rejects.toMatchObject({ message: 'Execution container binding unavailable.' });
  await expect(bindExecutionContainer({ ...args, owner: { ...owner, platform: 'win32', kernel: null } })).rejects.toBeDefined();
});

test('a supplied process-tree reader must bind the same populated cgroup twice', async () => {
  const { args } = fixture();
  const identity = { path: `/kubepods/pod${bootId}/${'a'.repeat(64)}`, device: '29', inode: '1000' };
  args.observeCgroup = jest.fn(async () => ({ identity, populated: true }));
  expect(await bindExecutionContainer(args)).toMatchObject({ version: 2, cgroup: identity });
  expect(args.observeCgroup).toHaveBeenCalledTimes(2);
  args.observeCgroup.mockResolvedValueOnce({ identity, populated: true }).mockResolvedValueOnce({ identity: { ...identity, inode: '1001' }, populated: true });
  await expect(bindExecutionContainer(args)).rejects.toBeDefined();
  args.observeCgroup.mockResolvedValue({ identity, populated: false });
  await expect(bindExecutionContainer(args)).rejects.toBeDefined();
  args.observeCgroup.mockRejectedValue(new Error('PRIVATE_KERNEL_PATH'));
  await expect(bindExecutionContainer(args)).rejects.toMatchObject({ message: 'Execution container binding unavailable.' });
});

test('runner persists a frozen bound owner with the claim before dispatch, without exposing it to the model context', async () => {
  const { TeamService } = require('./service');
  const { TeamRunner } = require('./runner');
  const { TestStore } = require('./test-store');
  const { workroomSnapshot } = require('./presentation');
  const service = new TeamService({ store: new TestStore() });
  const team = await service.create('owner', { name: 'Binding fixture', objective: 'No real executor.' });
  const command = (action, input, key) => service.ownerCommand(team.id, 'owner', action, input, key);
  const agent = await command('create_agent', { name: 'Fixture', job: 'No model.' }, 'agent');
  await command('configure_execution', { enabled: true }, 'enable');
  await command('assign_task', { agentId: agent.id, title: 'Claim fixture', instruction: 'State test only.' }, 'task');
  const { args } = fixture();
  args.observeCgroup = async () => ({ populated: true,
    identity: { path: `/kubepods/pod${bootId}/${'a'.repeat(64)}`, device: '29', inode: '1000' } });
  const binding = await bindExecutionContainer(args);
  const boundOwner = { ...owner, version: 2, containerBinding: binding };
  const execute = jest.fn(async ({ claim }) => {
    const saved = (await service.get(team.id, 'owner')).tasks[0];
    expect(saved.worker.claimId).toBe(claim.claimId);
    expect(saved.worker.executionOwner).toEqual(boundOwner);
    return { status: 'cancelled', summary: 'Fixture only; no work dispatched.', artifactIds: [] };
  });
  const runner = new TeamRunner({ service, execute, resolveExecutionOwner: async () => boundOwner });
  try {
    const acquired = await runner.prepareOwner();
    expect(Object.isFrozen(acquired.containerBinding)).toBe(true);
    expect(Object.isFrozen(acquired.containerBinding.cgroup)).toBe(true);
    expect(() => { acquired.containerBinding.hostPid = 999; }).toThrow();
    expect(() => { acquired.containerBinding.cgroup.inode = '999'; }).toThrow();
    await runner.tick();
    await Promise.all([...runner.active.values()].map(entry => entry.done));
    expect(execute).toHaveBeenCalledTimes(1);
    const saved = await service.get(team.id, 'owner');
    expect(saved.tasks[0].worker.executionOwner.containerBinding).toEqual(binding);
    for (const projection of [await service.context(team.id, 'owner', agent.id), workroomSnapshot(saved)]) {
      expect(JSON.stringify(projection)).not.toContain(binding.containerId);
      expect(JSON.stringify(projection)).not.toContain(owner.bootId);
    }
  } finally { runner.stop(); }
});
