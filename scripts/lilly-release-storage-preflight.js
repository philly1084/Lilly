'use strict';
const fs = require('node:fs');

// Reserve capacity for running workloads plus export/build/import copies.
// This is admission protection, not permission to prune production storage.
function checkReleaseStorage({ directory = '/tmp', imageBytes, statfs = fs.statfsSync } = {}) {
  if (!Number.isSafeInteger(imageBytes) || imageBytes <= 0) throw new Error('Invalid release image size');
  const info = statfs(directory, { bigint: true });
  for (const name of ['bsize', 'blocks', 'bavail']) {
    if (typeof info[name] !== 'bigint' || info[name] < 0n) throw new Error('Invalid filesystem capacity');
  }
  if (info.bsize === 0n || info.blocks === 0n || info.bavail > info.blocks) throw new Error('Invalid filesystem capacity');
  const capacity = info.blocks * info.bsize;
  const available = info.bavail * info.bsize;
  const minimumReserve = 16n * 1024n ** 3n;
  const reserve = capacity * 15n / 100n > minimumReserve ? capacity * 15n / 100n : minimumReserve;
  const required = reserve + BigInt(imageBytes) * 3n;
  const evidence = { availableBytes: available.toString(), requiredBytes: required.toString(), reserveBytes: reserve.toString() };
  if (available < required) throw Object.assign(new Error('Insufficient disk headroom for Lilly release; no build started'),
    { code: 'lilly_release_storage_headroom', evidence });
  return evidence;
}
module.exports = { checkReleaseStorage };
