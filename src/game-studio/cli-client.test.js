'use strict';

const { parseArgs, runCli, StudioCliClient } = require('./cli-client');

function stream() {
  return { value: '', write(chunk) { this.value += chunk; } };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

describe('Lilly Game CLI', () => {
  test('parses flags without swallowing following options', () => {
    expect(parseArgs(['create', '--name', 'Signal Field', '--template=third-person-explorer', '--compact'])).toEqual({
      _: ['create'],
      name: 'Signal Field',
      template: 'third-person-explorer',
      compact: true,
    });
  });

  test('sends authenticated headless project creation requests', async () => {
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, options });
      return response({ project: { id: 'project-1', revision: 1 } }, 201);
    };
    const stdout = stream();
    const stderr = stream();
    const exitCode = await runCli([
      'create', '--name', 'Signal Field', '--template', 'third-person-explorer', '--url', 'https://lilly.example/', '--compact',
    ], { LILLY_API_TOKEN: 'test-token' }, { stdout, stderr }, fetch);
    expect(exitCode).toBe(0);
    expect(stderr.value).toBe('');
    expect(JSON.parse(stdout.value)).toMatchObject({ project: { id: 'project-1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://lilly.example/api/game-studio/projects',
      options: { method: 'POST', headers: { Authorization: 'Bearer test-token' } },
    });
    expect(JSON.parse(calls[0].options.body)).toMatchObject({ name: 'Signal Field', template: 'third-person-explorer' });
  });

  test('returns a non-zero validation code for failed server checks', async () => {
    const stdout = stream();
    const exitCode = await runCli(['validate', '--project', 'broken'], {}, { stdout, stderr: stream() }, async () => response({
      project: { id: 'broken', revision: 2, engineVersion: '0.7.0', settings: { runtimeProfile: 'module-driven' } },
      validation: { valid: false, projectIssues: [{ code: 'BROKEN' }] },
    }));
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({ projectId: 'broken', valid: false });
  });

  test('redacts token values from API errors', async () => {
    const client = new StudioCliClient({ baseUrl: 'https://lilly.example', token: 'secret-token', fetch: async () => response({ error: { code: 'DENIED', message: 'No access' } }, 403) });
    await expect(client.request('/api/game-studio/projects')).rejects.toMatchObject({ code: 'DENIED', status: 403, message: 'No access' });
  });

  test('builds a selected versioned profile from the headless CLI', async () => {
    const calls = [];
    const stdout = stream();
    const exitCode = await runCli(['build', '--project', 'game-1', '--revision', '7', '--profile', 'performance-canary'], {}, { stdout, stderr: stream() }, async (url, options) => {
      calls.push({ url, options });
      return response({ schema: 'LillyBuild/v1', status: 'success', buildProfileId: 'performance-canary' }, 201);
    });
    expect(exitCode).toBe(0);
    expect(calls[0].url).toContain('/projects/game-1/builds');
    expect(JSON.parse(calls[0].options.body)).toEqual({ projectRevision: 7, buildProfileId: 'performance-canary' });
  });
});
