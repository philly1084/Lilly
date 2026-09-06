'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadApi() {
  const file = path.resolve(__dirname, '../../frontend/game-studio/src/api.ts');
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  let now = Date.now();
  const context = { exports: {}, fetch: jest.fn(), Date: { now: () => now, parse: Date.parse }, URLSearchParams };
  vm.runInNewContext(compiled, context);
  return { ...context.exports, fetch: context.fetch, advance: ms => { now += ms; } };
}

test.each(['2', new Date(Date.now() + 60000).toUTCString(), null, 'invalid'])('429 pauses requests across endpoints and preserves retry metadata: %s', header => {
  const api = loadApi();
  api.fetch.mockResolvedValue({ ok: false, status: 429, headers: { get: key => key === 'Retry-After' ? header : 'request-123' }, json: async () => ({ error: { code: 'rate_limited' } }) });
  return (async () => {
    let error;
    try { await api.studioApi.listProjects(); } catch (value) { error = value; }
    expect(error).toMatchObject({ status: 429, requestId: 'request-123' });
    expect(error.retryAfterMs).toBeGreaterThan(0);
    await expect(api.productionApi.list()).rejects.toMatchObject({ status: 429 });
    await expect(api.studioApi.build('project', 1)).rejects.toMatchObject({ status: 429 });
    expect(api.fetch).toHaveBeenCalledTimes(1);
    api.advance(error.retryAfterMs + 1);
    api.fetch.mockResolvedValue({ ok: true, json: async () => ({ projects: [] }) });
    await expect(api.studioApi.listProjects()).resolves.toEqual({ projects: [] });
    expect(api.fetch).toHaveBeenCalledTimes(2);
  })();
});

test('a rejected mutation is never automatically replayed', async () => {
  const api = loadApi();
  api.fetch.mockResolvedValue({ ok: false, status: 429, headers: { get: () => '2' }, json: async () => ({}) });
  await expect(api.studioApi.publish('build')).rejects.toMatchObject({ status: 429 });
  api.advance(3000);
  expect(api.fetch).toHaveBeenCalledTimes(1);
});
