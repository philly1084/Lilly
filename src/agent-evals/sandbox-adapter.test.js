jest.mock('../openai-client', () => ({ createResponse: jest.fn() }));
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createResponse } = require('../openai-client');
const { execute } = require('./sandbox-adapter');

test('SDK trial executes the edit and reads it back through real filesystem tools', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-outcome-'));
  await fs.writeFile(path.join(workspace, 'state.txt'), 'pending');
  const response = (text) => ({ id: 'test-response', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  createResponse.mockResolvedValueOnce(response(JSON.stringify({ steps: [
    { type: 'tool-call', tool: 'file-edit', params: { path: 'state.txt', oldText: 'pending', newText: 'done' }, resultKey: 'edit' },
    { type: 'tool-call', tool: 'file-read', params: { path: 'state.txt' }, resultKey: 'readback' },
    { type: 'llm-call', params: { prompt: 'Summarize the result.' }, resultKey: 'finalResponse' },
  ] }))).mockResolvedValueOnce(response('Done.'));
  const result = await execute({ prompt: 'Replace pending with done in state.txt', workspace });
  expect(await fs.readFile(path.join(workspace, 'state.txt'), 'utf8')).toBe('done');
  expect(result.status).toBe('completed');
  expect(createResponse.mock.calls[0][0].input).toContain('Preserve unrelated content');
});
