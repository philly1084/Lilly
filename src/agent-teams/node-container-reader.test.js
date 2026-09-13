'use strict';

const { createNodeContainerReader } = require('./node-container-reader');
const bootId = '01234567-89ab-4cde-8fab-0123456789ab';
const containerId = `containerd://${'a'.repeat(64)}`;
const stat = (pid, ticks = '300') => `${pid} (fixture) S ${Array(18).fill('0').join(' ')} ${ticks} 0`;
function fixture() {
  const execute = jest.fn(async () => ({ stdout: JSON.stringify({ status: { id: 'a'.repeat(64), state: 'CONTAINER_RUNNING',
    labels: { 'io.kubernetes.pod.uid': bootId, unrelated: 'PRIVATE' } }, info: { pid: 500, environment: 'PRIVATE' } }) }));
  const readFile = jest.fn(async file => {
    if (file.endsWith('/boot_id')) return bootId;
    const pid = Number(file.split('/')[2]);
    if (file.endsWith('/stat')) return stat(pid, pid === 510 ? '400' : '300');
    if (file.endsWith('/status')) return `Name:\tfixture\nNSpid:\t${pid}\t${pid === 510 ? 7 : 1}\n`;
    throw new Error('Unexpected read');
  });
  const readlink = jest.fn(async file => file.endsWith('/pid') ? 'pid:[1001]' : 'mnt:[1002]');
  const readdir = jest.fn(async () => ['self', '500', '510']);
  return { execute, readFile, readlink, readdir, args: { execute, readFile, readlink, readdir, hostname: 'node-a', platform: 'linux' } };
}

test('only runs bounded CRI inspect for an exact local container and strips private configuration', async () => {
  const { args, execute } = fixture();
  const reader = createNodeContainerReader(args);
  const value = await reader.inspectContainer(containerId, 'node-a');
  expect(value).toEqual({ status: { id: 'a'.repeat(64), state: 'CONTAINER_RUNNING', labels: { 'io.kubernetes.pod.uid': bootId } }, info: { pid: 500 } });
  expect(execute).toHaveBeenCalledWith('/usr/local/bin/crictl', [
    '--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=5s', 'inspect', 'a'.repeat(64),
  ], expect.objectContaining({ shell: false, timeout: 10000, maxBuffer: 2097152 }));
  for (const [id, node] of [[containerId, 'node-b'], ['../container', 'node-a'], [containerId + '; stop', 'node-a']]) {
    await expect(reader.inspectContainer(id, node)).rejects.toMatchObject({ code: 'team_node_observation_unavailable' });
  }
  expect(execute).toHaveBeenCalledTimes(1);
});

test('PID 1 binding reads exact init kernel identity without enumerating other processes', async () => {
  const { args, readFile, readdir, execute } = fixture();
  const value = await createNodeContainerReader(args).observeProcess({ nodeName: 'node-a', initPid: 500, ownerPid: 1 });
  expect(value.init).toEqual({ pid: 500, namespacePid: 1, startTicks: '300', pidNamespace: '1001', mountNamespace: '1002' });
  expect(value.process).toEqual(value.init);
  expect(readFile.mock.calls.filter(([file]) => file === '/proc/500/stat')).toHaveLength(2);
  expect(readdir).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

test('maps a non-init owner PID only inside the same PID and mount namespaces', async () => {
  const { args } = fixture();
  expect((await createNodeContainerReader(args).observeProcess({ nodeName: 'node-a', initPid: 500, ownerPid: 7 })).process)
    .toMatchObject({ pid: 510, namespacePid: 7, startTicks: '400' });
});

test.each(['node', 'platform', 'invalid_pid', 'missing_owner', 'mount_mismatch', 'unreadable', 'oversized_inventory', 'pid_reuse'])('cannot produce a binding from %s evidence', async mode => {
  const { args, readFile, readlink } = fixture();
  const request = { nodeName: 'node-a', initPid: 500, ownerPid: 7 };
  if (mode === 'node') request.nodeName = 'node-b';
  if (mode === 'platform') args.platform = 'win32';
  if (mode === 'invalid_pid') request.initPid = -1;
  if (mode === 'missing_owner') args.readdir = async () => ['500'];
  if (mode === 'mount_mismatch') args.readlink = async file => file === '/proc/510/ns/mnt' ? 'mnt:[2000]' : readlink(file);
  if (mode === 'unreadable') args.readFile = async () => { throw Object.assign(new Error('PRIVATE'), { code: 'EACCES' }); };
  if (mode === 'oversized_inventory') args.readdir = async () => Array(32769).fill('500');
  if (mode === 'pid_reuse') {
    let reads = 0;
    args.readFile = async file => file === '/proc/500/stat' && ++reads > 2 ? stat(500, '301') : readFile(file);
  }
  await expect(createNodeContainerReader(args).observeProcess(request)).rejects.toMatchObject({
    message: 'Node container observation unavailable.', code: 'team_node_observation_unavailable',
  });
});

test('CRI failures never expose captured command stdout or stderr', async () => {
  const { args } = fixture();
  args.execute = async () => { throw Object.assign(new Error('PRIVATE'), { stderr: 'PRIVATE', stdout: 'PRIVATE' }); };
  await expect(createNodeContainerReader(args).inspectContainer(containerId, 'node-a')).rejects.toMatchObject({ message: 'Node container observation unavailable.' });
});
