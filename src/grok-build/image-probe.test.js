'use strict';

const { sandboxArgs, probe } = require('../../bin/lilly-grok-image-probe');

test('image probe is networkless, nonroot, readonly and has no host or credential mounts', () => {
  const args = sandboxArgs();
  expect(args).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=10001:10001', '--memory=512m', '--cpus=1']));
  expect(args.some((arg) => /--mount|--volume|--privileged|--env/.test(arg))).toBe(false);
  const temporary = args.filter(arg => arg.startsWith('--tmpfs='));
  expect(temporary).toHaveLength(3);
  expect(temporary.every(arg => arg.includes('nosuid,nodev,mode=1777,size=') && !/uid=|gid=/.test(arg))).toBe(true);
});

test('image probe refuses mutable tags before running any container', async () => {
  await expect(probe('localhost/lilly-grok-build:latest')).rejects.toThrow('immutable local image ID');
});
