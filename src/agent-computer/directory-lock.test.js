'use strict';

const { ownsDirectoryLock } = require('./directory-lock');
const stat = { dev: 0x103n, ino: 456n };

test('matches the exact process and directory generation in an exclusive kernel flock', () => {
  expect(ownsDirectoryLock('12: FLOCK ADVISORY WRITE 123 01:03:456 0 EOF\n', stat, 123)).toBe(true);
});
test.each(['12: -> FLOCK ADVISORY WRITE 123 01:03:456 0 EOF', '12: FLOCK ADVISORY READ 123 01:03:456 0 EOF',
  '12: POSIX ADVISORY WRITE 123 01:03:456 0 EOF', '12: FLOCK ADVISORY WRITE 124 01:03:456 0 EOF',
  '12: FLOCK ADVISORY WRITE 123 01:04:456 0 EOF', '12: FLOCK ADVISORY WRITE 123 01:03:457 0 EOF'])('rejects unowned/nonexclusive lock %s', line => {
  expect(ownsDirectoryLock(line, stat, 123)).toBe(false);
});
