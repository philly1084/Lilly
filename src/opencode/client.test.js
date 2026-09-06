'use strict';

const { EventEmitter } = require('events');
const { ReadableStream } = require('stream/web');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../agent-sdk/tools/categories/ssh/SSHExecuteTool', () => ({
  SSHExecuteTool: jest.fn(),
}));

const { spawn } = require('child_process');
const { OpenCodeLocalClient, OpenCodeRemoteClient } = require('./client');

describe('OpenCode event stream text integrity', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  async function consume(transport, chunks) {
    const events = [];
    if (transport === 'HTTP') {
      global.fetch = jest.fn(async () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
          },
        }),
      }));
      const client = new OpenCodeLocalClient({ baseURL: 'http://localhost:4096' });
      await client.openGlobalEventStream((event) => events.push(event));
    } else {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: jest.fn(), end: jest.fn() };
      spawn.mockReturnValue(child);
      const sshTool = {
        getConnectionConfig: jest.fn(async () => ({ host: 'test', username: 'test', privateKeyPath: '/test/key' })),
        findSshBinary: jest.fn(async () => 'ssh'),
        buildRemoteLauncher: jest.fn(() => 'sh'),
        quoteShellArg: jest.fn((value) => `'${value}'`),
      };
      const client = new OpenCodeRemoteClient({ port: 4096, sshTool });
      const pending = client.openGlobalEventStream((event) => events.push(event));
      await new Promise((resolve) => setImmediate(resolve));
      chunks.forEach((chunk) => child.stdout.emit('data', chunk));
      child.emit('close', 0);
      await pending;
    }
    return events;
  }

  describe.each(['HTTP', 'SSH'])('%s transport', (transport) => {
    test.each(['café', '日本語', 'Ready 🛠️'])('preserves %s across every byte split', async (text) => {
      const payload = { type: 'message.part.updated', text, path: `${text}.md` };
      const bytes = Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
      for (let split = 1; split < bytes.length; split += 1) {
        const events = await consume(transport, [bytes.subarray(0, split), bytes.subarray(split)]);
        expect(events).toHaveLength(1);
        expect(events[0].data).toEqual(payload);
      }
    });

    test('preserves multiple events delivered one byte at a time and the final unterminated event', async () => {
      const payloads = [{ text: 'Hello' }, { text: 'résumé 🧭' }];
      const bytes = Buffer.from(payloads.map((payload) => `data: ${JSON.stringify(payload)}`).join('\n\n'));
      const events = await consume(transport, Array.from(bytes, (byte) => Buffer.from([byte])));
      expect(events.map((event) => event.data)).toEqual(payloads);
    });
  });
});
