const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendJsonlRecordSync, readJsonlRecordsSync } = require('./jsonl-persistence');

describe('JSONL append recovery', () => {
  let directory;
  let storagePath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-jsonl-'));
    storagePath = path.join(directory, 'records.jsonl');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each([
    ['complete record without newline', '{"id":"previous"}', [{ id: 'previous' }]],
    ['interrupted record', '{"id":"interrupted', []],
    ['interrupted UTF-8 character', Buffer.from([0x7b, 0x22, 0xe2, 0x82]), []],
  ])('preserves later records after a %s', (_label, tail, previous) => {
    const first = { id: 'first' };
    fs.writeFileSync(storagePath, Buffer.concat([
      Buffer.from(`${JSON.stringify(first)}\n`),
      Buffer.from(tail),
    ]));
    appendJsonlRecordSync(storagePath, { id: 'next', message: 'Ready ✓\nSecond line' });
    appendJsonlRecordSync(storagePath, { id: 'last' });

    expect(readJsonlRecordsSync(storagePath)).toEqual([
      first,
      ...previous,
      { id: 'next', message: 'Ready ✓\nSecond line' },
      { id: 'last' },
    ]);
  });

  test.each(['', '{"id":"previous"}\n', '{"id":"previous"}\r\n'])(
    'keeps normal line boundaries without adding blank lines: %j',
    (contents) => {
      fs.writeFileSync(storagePath, contents);
      appendJsonlRecordSync(storagePath, { id: 'next' });
      expect(fs.readFileSync(storagePath, 'utf8')).toBe(`${contents}{"id":"next"}\n`);
    },
  );

  test('creates missing parent directories and storage', () => {
    storagePath = path.join(directory, 'nested', 'records.jsonl');
    appendJsonlRecordSync(storagePath, { id: 'first' });
    expect(readJsonlRecordsSync(storagePath)).toEqual([{ id: 'first' }]);
  });
});
