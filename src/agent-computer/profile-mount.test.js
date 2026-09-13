'use strict';

const { randomUUID } = require('node:crypto');
const { createProfileMountReader, profileMount } = require('./profile-mount');
const stat = (ticks = '300') => `500 (fixture) S ${Array(18).fill('0').join(' ')} ${ticks} 0`;
const line = '36 25 8:1 /private/source /profiles rw,nosuid shared:3 - ext4 /dev/sda1 rw\n';

function fixture() {
  const expected = { nodeName: 'node-a', hostBootId: randomUUID(), initPid: 500, initStartTicks: '300',
    pidNamespace: '1001', mountNamespace: '1002', root: { device: '2049', inode: '5000' } };
  const status = 'NSpid:\t500\t1\nUid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\n';
  const directory = () => ({ dev: 2049n, ino: 5000n, isDirectory: () => true, isSymbolicLink: () => false });
  const handle = { fd: 41, stat: jest.fn(async () => directory()), close: jest.fn(async () => {}) };
  const read = jest.fn(async target => {
    if (target.endsWith('/boot_id')) return expected.hostBootId;
    if (target.endsWith('/stat')) return stat();
    if (target.endsWith('/status')) return status;
    if (target.endsWith('/mountinfo')) return line;
    if (target === '/proc/self/fdinfo/41') return 'pos:\t0\nflags:\t0300000\nmnt_id:\t36\nino:\t5000\n';
    throw new Error('Unexpected metadata read');
  });
  const options = { read, readlink: jest.fn(async target => target.endsWith('/pid') ? 'pid:[1001]' : 'mnt:[1002]'),
    open: jest.fn(async () => handle), lstat: jest.fn(async () => directory()), hostname: 'node-a', platform: 'linux' };
  return { expected, status, directory, handle, options, read };
}

test('exact opened directory, kernel mount ID and process generation are checked without returning private mount paths', async () => {
  const f = fixture(); const result = await createProfileMountReader(f.options).observeProfileMount(f.expected);
  expect(result).toEqual({ version: 1, ...f.expected, mountId: '36' });
  expect(JSON.stringify(result)).not.toContain('/private/source'); expect(JSON.stringify(result)).not.toContain('/dev/sda1');
  expect(f.options.open).toHaveBeenCalledWith('/proc/500/root/profiles', expect.any(Number));
  expect(f.handle.close).toHaveBeenCalledTimes(1);
  expect(f.read.mock.calls.filter(([target]) => target === '/proc/500/stat')).toHaveLength(2);
  expect(f.read.mock.calls.filter(([target]) => target === '/proc/500/mountinfo')).toHaveLength(2);
});

test.each(['missing', 'duplicate', 'nested', 'read_only', 'super_read_only', 'bad_device', 'oversized'])('mount parser rejects %s profile records', mode => {
  const text = mode === 'missing' ? line.replace('/profiles', '/elsewhere')
    : mode === 'duplicate' ? line + line
      : mode === 'nested' ? line + line.replace('/profiles', '/profiles/hidden')
        : mode === 'read_only' ? line.replace('rw,nosuid', 'ro,nosuid')
          : mode === 'super_read_only' ? line.replace('/dev/sda1 rw', '/dev/sda1 ro')
            : mode === 'bad_device' ? line.replace('8:1', '8:4294967296') : 'x'.repeat(2 * 1024 * 1024 + 1);
  expect(() => profileMount(text)).toThrow('Private helper profile mount is unconfirmed.');
});

test.each(['platform', 'node', 'pid', 'pid_namespace', 'mount_namespace', 'boot', 'uid', 'gid', 'privileges', 'caps', 'not_init',
  'inode', 'device', 'fd_mount', 'fd_inode', 'symlink', 'changed_mount', 'reused_pid', 'unreadable', 'close_failure'])
('rejects %s mismatch and releases any opened metadata handle', async mode => {
  const f = fixture(); const read = f.read.getMockImplementation();
  if (mode === 'platform') f.options.platform = 'win32';
  if (mode === 'node') f.expected.nodeName = 'foreign';
  if (mode === 'pid') f.expected.initPid = '../root';
  if (mode === 'pid_namespace') f.expected.pidNamespace = '2001';
  if (mode === 'mount_namespace') f.expected.mountNamespace = '2002';
  if (mode === 'boot') f.read.mockImplementation(async target => target.endsWith('/boot_id') ? randomUUID() : read(target));
  const changedStatus = { uid: f.status.replace('Uid:\t10001', 'Uid:\t0'), gid: f.status.replace('Gid:\t10001', 'Gid:\t0'),
    privileges: f.status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), caps: f.status.replace('0000000000000000', '0000000000000001'),
    not_init: f.status.replace('NSpid:\t500\t1', 'NSpid:\t500\t2') };
  if (changedStatus[mode]) f.read.mockImplementation(async target => target.endsWith('/status') ? changedStatus[mode] : read(target));
  if (mode === 'inode') f.expected.root.inode = '5001';
  if (mode === 'device') f.expected.root.device = '2050';
  if (mode === 'fd_mount') f.read.mockImplementation(async target => target.includes('/fdinfo/') ? 'mnt_id:\t37\nino:\t5000\n' : read(target));
  if (mode === 'fd_inode') f.read.mockImplementation(async target => target.includes('/fdinfo/') ? 'mnt_id:\t36\nino:\t5001\n' : read(target));
  if (mode === 'symlink') f.options.lstat.mockResolvedValue({ ...f.directory(), isSymbolicLink: () => true });
  if (mode === 'changed_mount') {
    let count = 0; f.read.mockImplementation(async target => target.endsWith('/mountinfo') && ++count === 2 ? line.replace('36 25', '37 25') : read(target));
  }
  if (mode === 'reused_pid') {
    let count = 0; f.read.mockImplementation(async target => target.endsWith('/stat') && ++count === 2 ? stat('301') : read(target));
  }
  if (mode === 'unreadable') f.read.mockRejectedValue(new Error('PRIVATE kernel path'));
  if (mode === 'close_failure') f.handle.close.mockRejectedValue(new Error('PRIVATE close error'));
  await expect(createProfileMountReader(f.options).observeProfileMount(f.expected)).rejects.toMatchObject({
    code: 'computer_profile_mount_unknown', message: 'Private helper profile mount is unconfirmed.',
  });
  if (f.options.open.mock.calls.length) expect(f.handle.close).toHaveBeenCalledTimes(1);
});

test('cancellation after opening the directory still closes its handle', async () => {
  const f = fixture(); const controller = new AbortController();
  f.options.open.mockImplementation(async () => { controller.abort(); return f.handle; });
  await expect(createProfileMountReader(f.options).observeProfileMount(f.expected, { signal: controller.signal })).rejects.toBeDefined();
  expect(f.handle.close).toHaveBeenCalledTimes(1); expect(f.handle.stat).not.toHaveBeenCalled();
});
