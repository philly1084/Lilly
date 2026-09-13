'use strict';

const { observeContainerStop } = require('./container-stop');
const podUid = '01234567-89ab-4cde-8fab-0123456789ab';
const at = '2026-09-07T00:00:00.000Z';
function fixture() {
  const cgroup = { path: `/kubepods/pod${podUid}/${'a'.repeat(64)}`, device: '29', inode: '1000' };
  const owner = { version: 2, bootId: podUid, platform: 'linux', pid: 1, startedAt: at,
    kernel: { bootId: podUid, startTicks: '300', pidNamespace: '1001', mountNamespace: '1002' },
    pod: { namespace: 'kimibuilt', name: 'backend-a', uid: podUid, containerName: 'backend' },
    containerBinding: { version: 2, containerId: `containerd://${'a'.repeat(64)}`, nodeName: 'node-a', podUid,
      hostBootId: podUid, initPid: 500, hostPid: 500, initStartTicks: '300', processStartTicks: '300',
      pidNamespace: '1001', mountNamespace: '1002', observedAt: at, cgroup } };
  const runtime = { status: { id: 'a'.repeat(64), state: 'CONTAINER_EXITED', labels: {
    'io.kubernetes.pod.uid': podUid, 'io.kubernetes.pod.namespace': 'kimibuilt', 'io.kubernetes.pod.name': 'backend-a',
    'io.kubernetes.container.name': 'backend' } } };
  const group = { identity: cgroup, populated: false, hostBootId: podUid };
  const args = { owner, inspectContainer: jest.fn(async () => structuredClone(runtime)), readCgroup: jest.fn(async () => structuredClone(group)), now: () => at };
  return { owner, runtime, group, args };
}

test('two exact CRI exits and positive empty process-tree reads prove only the bound container stopped', async () => {
  const { args } = fixture();
  expect(await observeContainerStop(args)).toEqual({ ownerBootId: podUid, containerId: args.owner.containerBinding.containerId,
    stopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: at });
  expect(args.inspectContainer).toHaveBeenCalledTimes(2); expect(args.readCgroup).toHaveBeenCalledTimes(2);
});

test.each(['running', 'unknown', 'foreign_container', 'foreign_pod', 'live_descendants', 'host_reboot', 'changed_inode', 'removed', 'legacy', 'restart', 'repopulated'])('does not infer termination from %s', async mode => {
  const { owner, runtime, group, args } = fixture();
  if (mode === 'running') runtime.status.state = 'CONTAINER_RUNNING';
  if (mode === 'unknown') runtime.status.state = 'CONTAINER_UNKNOWN';
  if (mode === 'foreign_container') runtime.status.id = 'b'.repeat(64);
  if (mode === 'foreign_pod') runtime.status.labels['io.kubernetes.pod.uid'] = 'foreign';
  if (mode === 'live_descendants') group.populated = true;
  if (mode === 'host_reboot') group.hostBootId = 'foreign';
  if (mode === 'changed_inode') args.readCgroup = async () => ({ ...group, identity: { ...group.identity, inode: '1001' } });
  if (mode === 'removed') args.readCgroup = async () => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOENT' }); };
  if (mode === 'legacy') { owner.containerBinding.version = 1; delete owner.containerBinding.cgroup; }
  if (mode === 'restart') args.inspectContainer.mockResolvedValueOnce(runtime).mockResolvedValueOnce({ status: { ...runtime.status, state: 'CONTAINER_RUNNING' } });
  if (mode === 'repopulated') args.readCgroup.mockResolvedValueOnce(group).mockResolvedValueOnce({ ...group, populated: true });
  expect(await observeContainerStop(args)).toBeNull();
});
