'use strict';

const { createCgroupReader, normalizeCgroup, unifiedPath, populated } = require('./cgroup-reader');
const podUid = '01234567-89ab-4cde-8fab-0123456789ab';
const containerId = `containerd://${'a'.repeat(64)}`;
const groupPath = `/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${podUid.replace(/-/g, '_')}.slice/cri-containerd-${'a'.repeat(64)}.scope`;
const identity = { path: groupPath, device: '29', inode: '1000' };
function fixture() {
  let active = true;
  const args = { hostname: 'node-a', platform: 'linux', realpath: jest.fn(async path => path),
    lstat: jest.fn(async path => ({ dev: 29n, ino: 1000n, isSymbolicLink: () => false,
      isDirectory: () => !path.endsWith('/cgroup.events'), isFile: () => path.endsWith('/cgroup.events') })),
    statfs: jest.fn(async () => ({ type: 0x63677270n })),
    readFile: jest.fn(async path => {
      if (path.endsWith('/boot_id')) return podUid;
      if (path === '/proc/500/cgroup') return `0::${groupPath}\n`;
      if (path === '/proc/510/cgroup') return `0::${groupPath}/browser\n`;
      if (path.endsWith('/cgroup.type')) return 'domain\n';
      if (path.endsWith('/cgroup.events')) return `populated ${active ? 1 : 0}\nfrozen 0\n`;
      throw new Error('Unexpected read');
    }) };
  return { args, empty: () => { active = false; }, scope: { nodeName: 'node-a', containerId, podUid, initPid: 500, hostPid: 510 },
    binding: { nodeName: 'node-a', containerId, podUid, cgroup: identity } };
}

test('binds container-root membership while its owner is in a nested browser subgroup', async () => {
  const { args, scope } = fixture();
  expect(await createCgroupReader(args).observeCgroup(scope)).toEqual({ identity, populated: true });
  expect(args.readFile.mock.calls.some(([path]) => path.endsWith('cgroup.procs'))).toBe(false);
});

test('positive kernel empty-tree observation requires matching filesystem and group identity', async () => {
  const { args, binding, empty } = fixture(); empty();
  expect(await createCgroupReader(args).readCgroup(binding)).toEqual({ identity, populated: false, hostBootId: podUid });
});

test.each(['missing', 'permissions', 'symlink', 'foreign_filesystem', 'foreign_inode', 'replacement', 'threaded', 'escaped_owner', 'moved_init'])('rejects %s evidence instead of claiming an empty tree', async mode => {
  const { args, scope } = fixture();
  const originalRead = args.readFile;
  if (mode === 'missing' || mode === 'permissions') args.lstat = async () => { throw Object.assign(new Error('PRIVATE'), { code: mode === 'missing' ? 'ENOENT' : 'EACCES' }); };
  if (mode === 'symlink') args.realpath = async path => path + '/redirected';
  if (mode === 'foreign_filesystem') args.statfs = async () => ({ type: 0x01021994n });
  if (mode === 'foreign_inode') {
    const { binding } = fixture();
    binding.cgroup = { ...identity, inode: '999' };
    await expect(createCgroupReader(args).readCgroup(binding)).rejects.toMatchObject({ code: 'team_cgroup_unavailable' }); return;
  }
  if (mode === 'replacement') {
    let directories = 0; const original = args.lstat;
    args.lstat = async path => ({ ...await original(path), ino: !path.endsWith('/cgroup.events') && ++directories > 1 ? 1001n : 1000n });
  }
  if (mode === 'threaded') args.readFile = async path => path.endsWith('/cgroup.type') ? 'threaded\n' : originalRead(path);
  if (mode === 'escaped_owner') args.readFile = async path => path === '/proc/510/cgroup' ? '0::/other\n' : originalRead(path);
  if (mode === 'moved_init') {
    let reads = 0;
    args.readFile = async path => path === '/proc/500/cgroup' && ++reads > 1 ? '0::/other\n' : originalRead(path);
  }
  await expect(createCgroupReader(args).observeCgroup(scope)).rejects.toMatchObject({ code: 'team_cgroup_unavailable' });
});

test.each(['/', '/kubepods/../escape', groupPath + '/child', groupPath.replace('a'.repeat(64), 'b'.repeat(64)),
  groupPath.replace(podUid.replace(/-/g, '_'), 'foreign'), groupPath.replace('/kubepods.slice/', '/other/')])('rejects foreign or unsafe group paths: %s', path => {
  expect(() => normalizeCgroup({ ...identity, path }, containerId, podUid)).toThrow();
});

test('unsupported nodes and malformed kernel files cannot make empty observations', async () => {
  const { args, binding } = fixture();
  await expect(createCgroupReader(args).readCgroup({ ...binding, nodeName: 'node-b' })).rejects.toBeDefined();
  expect(args.readFile).not.toHaveBeenCalled();
  for (const value of ['', 'populated 2\n', 'populated 0\npopulated 1\n', 'populated false', 'frozen 0']) expect(() => populated(value)).toThrow();
  for (const value of ['0::/\n1:cpu:/\n', '1:cpu:/', '0::/\n\n']) expect(() => unifiedPath(value)).toThrow();
});
