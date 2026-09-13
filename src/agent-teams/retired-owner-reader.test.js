'use strict';

const { randomUUID } = require('node:crypto');
const { createRetiredOwnerReader } = require('./retired-owner-reader');

function fixture() {
  const podUid = randomUUID(); const containerId = `containerd://${'a'.repeat(64)}`;
  const binding = { nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 321, initStartTicks: '456', podUid, containerId,
    cgroup: { path: `/kubepods/pod${podUid}/${containerId.slice(13)}`, device: '30', inode: '99' } };
  const leaf = `/sys/fs/cgroup${binding.cgroup.path}`; const stat = { dev: 30n, ino: 10n, isDirectory: () => true, isSymbolicLink: () => false };
  const options = { hostname: 'fixture-node', platform: 'linux',
    read: jest.fn(async file => { if (file.endsWith('boot_id')) return binding.hostBootId; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }),
    readlink: jest.fn(async file => file.endsWith('/pid') ? 'pid:[100]' : 'mnt:[101]'),
    realpath: jest.fn(async file => file), statfs: jest.fn(async () => ({ type: 0x63677270n })),
    lstat: jest.fn(async file => { if (file === leaf) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return stat; }),
  };
  return { binding, leaf, stat, options, reader: createRetiredOwnerReader(options) };
}

test('two same-boot samples confirm a gone original init and absent group in the host hierarchy', async () => {
  const f = fixture(); const result = await f.reader.readRetiredOwner(f.binding);
  expect(result).toEqual({ version: 1, retired: true, hostBootId: f.binding.hostBootId, initPid: 321, initStartTicks: '456', cgroup: f.binding.cgroup });
  expect(f.options.read.mock.calls.filter(([file]) => file.endsWith('/321/stat'))).toHaveLength(2);
  expect(f.options.statfs).toHaveBeenCalledTimes(2);
});

test.each(['running_init', 'pid_unreadable', 'group_unreadable', 'present_group', 'wrong_node', 'wrong_boot', 'wrong_fs', 'device',
  'symlink', 'mount_namespace', 'pid_namespace', 'parent_replaced', 'abort', 'foreign_path'])('rejects %s rather than interpreting missing evidence as retirement', async mode => {
  const f = fixture(); const controller = new AbortController();
  if (mode === 'running_init') f.options.read.mockImplementation(async file => file.endsWith('boot_id') ? f.binding.hostBootId
    : `321 (fixture) S ${Array(18).fill('0').join(' ')} 456 0`);
  if (mode === 'pid_unreadable') f.options.read.mockImplementation(async file => {
    if (file.endsWith('boot_id')) return f.binding.hostBootId; throw Object.assign(new Error('PRIVATE'), { code: 'EACCES' });
  });
  if (mode === 'group_unreadable') f.options.lstat.mockImplementation(async file => { if (file === f.leaf) throw Object.assign(new Error('PRIVATE'), { code: 'EACCES' }); return f.stat; });
  if (mode === 'present_group') f.options.lstat.mockResolvedValue(f.stat);
  if (mode === 'wrong_node') f.binding.nodeName = 'other';
  if (mode === 'wrong_boot') f.options.read.mockResolvedValue(randomUUID());
  if (mode === 'wrong_fs') f.options.statfs.mockResolvedValue({ type: 123n });
  if (mode === 'device') f.stat.dev = 31n;
  if (mode === 'symlink') f.stat.isSymbolicLink = () => true;
  if (mode === 'mount_namespace') f.options.readlink.mockImplementation(async file => file === '/proc/self/ns/mnt' ? 'mnt:[999]' : file.endsWith('/pid') ? 'pid:[100]' : 'mnt:[101]');
  if (mode === 'pid_namespace') f.options.readlink.mockImplementation(async file => file === '/proc/self/ns/pid' ? 'pid:[999]' : file.endsWith('/pid') ? 'pid:[100]' : 'mnt:[101]');
  if (mode === 'parent_replaced') {
    let count = 0; const original = f.options.lstat.getMockImplementation();
    f.options.lstat.mockImplementation(async file => { const value = await original(file); count += 1; return { ...value, ino: BigInt(count) }; });
  }
  if (mode === 'abort') f.options.statfs.mockImplementation(async () => { controller.abort(); return { type: 0x63677270n }; });
  if (mode === 'foreign_path') f.binding.cgroup.path = '/system.slice/foreign';
  await expect(f.reader.readRetiredOwner(f.binding, { signal: controller.signal })).rejects.toMatchObject({ code: 'team_retired_owner_unknown' });
});
