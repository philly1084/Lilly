jest.mock('../../../../git-credentials', () => ({
  createGitCredentialSession: jest.fn(async () => ({
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
    cleanup: async () => {},
  })),
}));

jest.mock('../../../../repository-workspace', () => ({
  ensureRepositoryWorkspace: jest.fn(async ({ repositoryPath }) => ({
    repositoryPath,
    bootstrapped: false,
  })),
}));

const { GitLocalTool } = require('./GitLocalTool');
const { createGitCredentialSession } = require('../../../../git-credentials');
const { ensureRepositoryWorkspace } = require('../../../../repository-workspace');
const path = require('path');

describe('GitLocalTool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      KIMIBUILT_GIT_COMMIT_NAME: 'KimiBuilt Agent',
      KIMIBUILT_GIT_COMMIT_EMAIL: 'agent@example.com',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('builds save-and-push flow with staged paths and current branch push', async () => {
    const tool = new GitLocalTool();
    const commands = [];

    tool.resolveRepoRoot = jest.fn().mockResolvedValue('/repo');
    tool.getCurrentBranch = jest.fn().mockResolvedValue('master');
    tool.spawnGit = jest.fn().mockImplementation(async (args) => {
      commands.push(args);
      if (args.join(' ') === 'diff --cached --quiet --') {
        const error = new Error('');
        error.exitCode = 1;
        error.stdout = '';
        error.stderr = '';
        throw error;
      }
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        duration: 5,
      };
    });

    const result = await tool.execute({
      action: 'save-and-push',
      repositoryPath: '/repo',
      paths: ['src/app.js'],
      message: 'Update app',
    });

    expect(result.success).toBe(true);
    expect(commands).toEqual([
      ['add', '--', 'src/app.js'],
      ['diff', '--cached', '--quiet', '--'],
      ['-c', 'user.name=KimiBuilt Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'Update app'],
      ['push', 'origin', 'master'],
    ]);
    expect(ensureRepositoryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: path.resolve('/repo'),
    }));
    expect(createGitCredentialSession).toHaveBeenCalledTimes(1);
  });

  test('save-and-push skips commit when selected paths produce no staged changes', async () => {
    const tool = new GitLocalTool();
    const commands = [];

    tool.resolveRepoRoot = jest.fn().mockResolvedValue('/repo');
    tool.getCurrentBranch = jest.fn().mockResolvedValue('master');
    tool.spawnGit = jest.fn().mockImplementation(async (args) => {
      commands.push(args);
      return {
        exitCode: 0,
        stdout: args[0] === 'push' ? 'Everything up-to-date' : '',
        stderr: '',
        duration: 5,
      };
    });

    const result = await tool.execute({
      action: 'save-and-push',
      repositoryPath: '/repo',
      paths: ['src/app.js'],
      message: 'Update app',
    });

    expect(result.success).toBe(true);
    expect(commands).toEqual([
      ['add', '--', 'src/app.js'],
      ['diff', '--cached', '--quiet', '--'],
      ['push', 'origin', 'master'],
    ]);
    expect(result.data.stdout).toContain('No staged changes to commit.');
    expect(result.data.stdout).toContain('Everything up-to-date');
  });

  test('rejects invalid pathspecs that look like flags', async () => {
    const tool = new GitLocalTool();
    tool.resolveRepoRoot = jest.fn().mockResolvedValue('/repo');

    const result = await tool.execute({
      action: 'add',
      repositoryPath: '/repo',
      paths: ['--all'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot start with');
  });

  test('reports branch, head, upstream, and remotes without failing when upstream is missing', async () => {
    const tool = new GitLocalTool();

    tool.resolveRepoRoot = jest.fn().mockResolvedValue('/repo');
    tool.getCurrentBranch = jest.fn().mockResolvedValue('main');
    tool.spawnGit = jest.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123', stderr: '', duration: 3 })
      .mockRejectedValueOnce(Object.assign(new Error('no upstream'), {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: no upstream configured',
      }))
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'origin https://github.com/example/repo.git (fetch)\norigin https://github.com/example/repo.git (push)',
        stderr: '',
        duration: 4,
      });

    const result = await tool.execute({
      action: 'remote-info',
      repositoryPath: '/repo',
    });

    expect(result.success).toBe(true);
    expect(result.data.stdout).toContain('branch: main');
    expect(result.data.stdout).toContain('head: abc123');
    expect(result.data.stdout).toContain('upstream: none');
    expect(result.data.stdout).toContain('origin https://github.com/example/repo.git (fetch)');
  });

  test('returns a helpful error when git is missing from the runtime', async () => {
    const tool = new GitLocalTool();

    tool.resolveRepoRoot = jest.fn().mockRejectedValue(Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
    }));

    const result = await tool.execute({
      action: 'status',
      repositoryPath: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Git CLI is unavailable in the backend runtime');
  });

  test('bootstraps the managed workspace before resolving the repo root', async () => {
    const tool = new GitLocalTool();
    ensureRepositoryWorkspace.mockResolvedValueOnce({
      repositoryPath: '/managed/repo',
      bootstrapped: true,
    });
    tool.resolveRepoRoot = jest.fn().mockResolvedValue('/managed/repo');
    tool.getCurrentBranch = jest.fn().mockResolvedValue('main');
    tool.spawnGit = jest.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '## main',
      stderr: '',
      duration: 5,
    });

    const result = await tool.execute({
      action: 'status',
      repositoryPath: '/managed/repo',
      repositoryUrl: 'https://github.com/example/app.git',
    });

    expect(result.success).toBe(true);
    expect(ensureRepositoryWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: path.resolve('/managed/repo'),
      repositoryUrl: 'https://github.com/example/app.git',
    }));
    expect(tool.resolveRepoRoot).toHaveBeenCalledWith(
      '/managed/repo',
      expect.objectContaining({
        GIT_TERMINAL_PROMPT: '0',
      }),
    );
  });
});
