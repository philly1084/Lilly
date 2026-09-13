'use strict';
const { checkReleaseStorage } = require('../../scripts/lilly-release-storage-preflight');
const GiB = 1024n ** 3n;
const stats = available => () => ({ bsize: 1n, blocks: 300n * GiB, bavail: available * GiB });
test('blocks builds near the operational disk reserve before allocating copies', () => {
  expect(() => checkReleaseStorage({ imageBytes: Number(4n * GiB), statfs: stats(51n) }))
    .toThrow(expect.objectContaining({ code: 'lilly_release_storage_headroom' }));
});
test('admits a release with explicit reserve and copy headroom', () => {
  expect(checkReleaseStorage({ imageBytes: Number(4n * GiB), statfs: stats(60n) })).toEqual({
    availableBytes: (60n * GiB).toString(), requiredBytes: (57n * GiB).toString(), reserveBytes: (45n * GiB).toString(),
  });
});
test.each([NaN, 0, -1, Infinity, 1.2])('fails closed for unknown image size %s', imageBytes => {
  expect(() => checkReleaseStorage({ imageBytes, statfs: stats(100n) })).toThrow('Invalid release image size');
});
test('fails closed when filesystem statistics are unusable', () => {
  expect(() => checkReleaseStorage({ imageBytes: 1, statfs: () => ({ bsize: 0n, blocks: 1n, bavail: 1n }) })).toThrow();
});

test('release builder checks storage before creating directories or exporting images', () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../../scripts/lilly-team-release-build.js'), 'utf8');
  const mkdir = jest.fn(); const exec = jest.fn(() => JSON.stringify({ status: { size: 4 * 1024 ** 3 } }));
  expect(() => vm.runInNewContext(source, { require: name => {
    if (name === 'node:fs') return { mkdtempSync: mkdir };
    if (name === 'node:crypto') return require(name);
    if (name === 'node:child_process') return { execFileSync: exec };
    if (name === './lilly-release-storage-preflight') return {
      checkReleaseStorage: options => checkReleaseStorage({ ...options, statfs: stats(20n) }),
    };
    throw new Error('Unexpected dependency');
  } })).toThrow('Insufficient disk headroom');
  expect(mkdir).not.toHaveBeenCalled();
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1]).toEqual(['crictl', 'inspecti', 'ghcr.io/philly1084/lilly:sha-0fad485']);
});
