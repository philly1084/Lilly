'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inflateSync } = require('node:zlib');
const { pngFixture, collectImages } = require('../../bin/lilly-grok-loop-proof');

test('transport image is a deterministic, real 64x64 PNG large enough for upstream extraction', () => {
  const png = pngFixture();
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(64); expect(png.readUInt32BE(20)).toBe(64);
  expect(png.toString('base64').length).toBeGreaterThan(1024);
  let offset = 8; const data = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset); const type = png.subarray(offset + 4, offset + 8).toString();
    if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(data));
  expect(pixels).toHaveLength(64 * 193);
  expect(pngFixture()).toEqual(png);
});

test('proof requires actual typed image input, not a text mention of base64', () => {
  const url = `data:image/png;base64,${pngFixture().toString('base64')}`;
  expect(collectImages([{ role: 'user', content: [{ type: 'input_text', text: url }] }])).toEqual([]);
  expect(collectImages([{ role: 'user', content: [{ type: 'input_image', image_url: url }] }])).toEqual([url]);
});

test('real-loop proof stays networkless and uses only synthetic scripted inference', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../bin/lilly-grok-loop-proof.js'), 'utf8');
  expect(source).toContain('...sandboxArgs()');
  expect(source).toContain('externalModelCalls: 0');
  expect(source).toContain("killSignal: 'SIGKILL'");
  expect(source).toContain("assert.equal(container.Config.Labels['lilly.loop-proof'], proofId)");
  expect(source).not.toContain('--network=host');
  expect(source).not.toContain('OPENAI_API_KEY');
  expect(source).not.toContain('process.env');
});

test('resume proof requires removed container, revoked lease, prior context, and a read-only replacement catalog', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../bin/lilly-grok-loop-proof.js'), 'utf8');
  for (const contract of ["assert.equal(process.pid, 1)", 'if (index === 1) cleanup(names[0])',
    'assert.equal(revoked.status, 401)', 'context.includes(continuityMarker)', 'context.includes(state.artifactSha256)',
    "toolNames: ['lilly_probe_read']", 'assert.equal(loaded.sessionId, saved.sessionId)', 'assert.equal(state.fileWrites, 1)',
    'assert.equal(path.dirname(path.resolve(directory)), root)', 'assert(!fs.lstatSync(directory).isSymbolicLink())']) {
    expect(source).toContain(contract);
  }
  expect(source).not.toContain('process.kill(');
});
