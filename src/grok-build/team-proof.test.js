'use strict';

const { discoveredName, responseFor, modelHasImage } = require('../../bin/lilly-grok-team-proof');
const { validRequest, protocolProbe } = require('../../bin/lilly-team-browser-proof');
const { verifyArchive, VERSION } = require('../agent-computer/install-browser-driver');
const { allowedConnection } = require('../../bin/lilly-team-services-proof');

test('full product proof allows only its exact DB socket and its own loopback listener targets', () => {
  const socket = '/tmp/lilly-team-pg-proof.example/socket'; const targets = new Set(['127.0.0.1:43210', '::1:43211']);
  expect(allowedConnection([{ path: `${socket}/.s.PGSQL.5432` }], socket, targets)).toBe(true);
  expect(allowedConnection([`${socket}/.s.PGSQL.5432`], socket, targets)).toBe(true);
  expect(allowedConnection([[{ host: '127.0.0.1', port: 43210 }]], socket, targets)).toBe(true);
  expect(allowedConnection([43211, '::1'], socket, targets)).toBe(true);
  for (const args of [[{ host: '127.0.0.1', port: 5432 }], [{ host: 'localhost', port: 43210 }],
    [{ host: 'production.example', port: 443 }], [{ path: '/var/run/postgresql/.s.PGSQL.5432' }], [43210],
    [{ path: `${socket}/../different/.s.PGSQL.5432` }]]) expect(allowedConnection(args, socket, targets)).toBe(false);
});

test('browser image installer pins its driver and rejects unverified archive bytes', () => {
  expect(VERSION).toBe('1.63.0');
  expect(() => verifyArchive(Buffer.from('unverified executable archive'))).toThrow('integrity mismatch');
  expect(() => verifyArchive(Buffer.alloc(0))).toThrow();
  expect(() => verifyArchive('not an archive buffer')).toThrow();
});

test('browser diagnostic retains bounded command timings without private payloads', () => {
  let now = 100; const probe = protocolProbe(() => now);
  probe.record('send', { id: 1, method: 'Page.captureScreenshot', params: { secret: 'PRIVATE_ARGUMENT' } });
  now = 120;
  expect(probe.snapshot().pending).toEqual([{ method: 'Page.captureScreenshot', elapsedMs: 20 }]);
  probe.record('receive', { id: 1, result: { data: 'PRIVATE_PIXELS' } });
  probe.record('send', { id: 2, method: 'Private.url', params: { url: 'PRIVATE_URL' } });
  probe.record('receive', { method: 'Runtime.consoleAPICalled', params: { value: 'PRIVATE_TEXT' } });
  expect(probe.snapshot().pending).toEqual([]);
  expect(probe.snapshot().recent.at(-1)).toEqual({ method: 'Page.captureScreenshot', state: 'received', elapsedMs: 20 });
  expect(JSON.stringify(probe.snapshot())).not.toContain('PRIVATE');
  for (let id = 3; id < 103; id += 1) probe.record('send', { id, method: 'Runtime.evaluate' });
  expect(probe.snapshot().pending).toHaveLength(64); expect(probe.snapshot().recent).toHaveLength(24);
  const snapshot = probe.snapshot(); snapshot.pending[0].method = 'tampered'; snapshot.recent[0].method = 'tampered';
  expect(JSON.stringify(probe.snapshot())).not.toContain('tampered');
});

test('team browser proof verifies typed pixels and rejects textual or different images', () => {
  const image = 'data:image/png;base64,AAAA';
  expect(modelHasImage([{ type: 'input_text', text: image }], image)).toBe(false);
  expect(modelHasImage([{ type: 'input_image', image_url: 'data:image/png;base64,BBBB' }], image)).toBe(false);
  expect(modelHasImage([{ content: [{ type: 'input_image', image_url: image }] }], image)).toBe(true);
});

test('fixture browser RPC has a fixed operation catalog and request envelope', () => {
  expect(validRequest({ id: 1, method: 'open', args: {} })).toBe(true);
  for (const request of [{ id: 1, method: 'exec', args: {} }, { id: 1, method: 'open', args: [] },
    { id: -1, method: 'open', args: {} }, { id: '1', method: 'open', args: {} }]) expect(validRequest(request)).toBe(false);
});

test('team proof resolves only a complete actual discovered MCP tool name', () => {
  expect(discoveredName([{ text: 'lilly-abc__artifact_read' }], 'artifact_read')).toBe('lilly-abc__artifact_read');
  expect(discoveredName([{ text: 'lilly-abc__artifact_reader' }], 'artifact_read')).toBeUndefined();
  expect(() => discoveredName([{ text: 'a__artifact_read b__artifact_read' }], 'artifact_read')).toThrow();
  expect(() => discoveredName([], '.*')).toThrow();
});

test('scripted response preserves the same complete call across streaming and JSON', async () => {
  const item = { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'use_tool', arguments: '{"tool_name":"fixture"}', status: 'completed' };
  const json = responseFor({ model: 'lilly-proof-writer' }, item, 'fixture');
  const events = [];
  for await (const event of responseFor({ model: 'lilly-proof-writer', stream: true }, item, 'fixture')) events.push(event);
  expect(events.at(-1).response).toEqual(json);
  expect(events.find(event => event.type === 'response.function_call_arguments.delta').delta).toBe(item.arguments);
  expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4]);
});
