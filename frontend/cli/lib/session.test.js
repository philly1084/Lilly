const fs = require('fs');
const os = require('os');
const path = require('path');

function loadSessionModule(homeDir) {
  jest.resetModules();
  jest.doMock('os', () => ({
    ...jest.requireActual('os'),
    homedir: () => homeDir,
  }));
  return require('./session');
}

describe('CLI session history', () => {
  let tempHome;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimibuilt-cli-session-'));
  });

  afterEach(() => {
    jest.dontMock('os');
    jest.resetModules();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test('preserves saved reasoning history when refreshing session metadata', () => {
    const session = loadSessionModule(tempHome);

    session.save('session-keep-reasoning', {
      createdAt: '2026-07-11T20:00:00.000Z',
      mode: 'chat',
      name: 'Original session',
      model: 'gpt-5.4-mini',
    });
    expect(session.addReasoningEntry('session-keep-reasoning', {
      id: 'reasoning-1',
      timestamp: '2026-07-11T20:01:00.000Z',
      prompt: 'Explain the deploy',
      text: 'Checked rollout status and picked the smallest fix.',
      model: 'gpt-5.4-mini',
    })).toBe(true);

    session.save('session-keep-reasoning', {
      mode: 'canvas',
      name: 'Renamed session',
    });

    const [entry] = session.getHistory();
    expect(entry).toMatchObject({
      id: 'session-keep-reasoning',
      createdAt: '2026-07-11T20:00:00.000Z',
      mode: 'canvas',
      name: 'Renamed session',
      model: 'gpt-5.4-mini',
    });
    expect(entry.reasoningHistory).toEqual([
      expect.objectContaining({
        id: 'reasoning-1',
        prompt: 'Explain the deploy',
        text: 'Checked rollout status and picked the smallest fix.',
      }),
    ]);
  });
});
