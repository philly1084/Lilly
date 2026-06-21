const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { ToolBase } = require('../../ToolBase');
const { config } = require('../../../../config');
const { createGitCredentialSession } = require('../../../../git-credentials');
const { ensureRepositoryWorkspace } = require('../../../../repository-workspace');

const ALLOWED_ACTIONS = new Set([
  'status',
  'diff',
  'branch',
  'remote-info',
  'add',
  'commit',
  'push',
  'save-and-push',
]);

class GitLocalTool extends ToolBase {
  constructor() {
    super({
      id: 'git-safe',
      name: 'Git Save And Push',
      description: 'Restricted local git operations for status, staging, commit, and push',
      category: 'system',
      version: '1.0.0',
      backend: {
        sideEffects: ['read', 'write', 'execute'],
        sandbox: { filesystem: true },
        timeout: 60000,
      },
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: Array.from(ALLOWED_ACTIONS),
            description: 'Restricted git action to run',
          },
          repositoryPath: {
            type: 'string',
            description: 'Local repository path. Defaults to DEFAULT_GIT_REPOSITORY_PATH or the backend working directory.',
          },
          repositoryUrl: {
            type: 'string',
            description: 'Repository URL used to bootstrap a managed workspace when the target path does not contain a git clone yet.',
          },
          paths: {
            type: 'array',
            description: 'Pathspecs for staging. Only used by add/save-and-push.',
            items: { type: 'string' },
          },
          message: {
            type: 'string',
            description: 'Commit message for commit/save-and-push.',
          },
          remote: {
            type: 'string',
            description: 'Git remote name for push. Defaults to origin.',
          },
          branch: {
            type: 'string',
            description: 'Git branch to push. Defaults to the current branch.',
          },
          setUpstream: {
            type: 'boolean',
            default: false,
            description: 'Use -u for push.',
          },
          timeout: {
            type: 'integer',
            default: 60000,
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          repoRoot: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'integer' },
          branch: { type: 'string' },
          duration: { type: 'integer' },
        },
      },
    });
  }

  async handler(params, context, tracker) {
    const action = String(params.action || '').trim();
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new Error(`Unsupported git-safe action '${action}'`);
    }

    try {
      const repositoryPath = params.repositoryPath || context.repositoryPath || config.deploy.defaultRepositoryPath;
      const repoPath = path.resolve(String(repositoryPath || process.cwd()));
      const timeout = Math.max(1000, Number(params.timeout) || 60000);
      const repositoryUrl = String(
        params.repositoryUrl
        || context.repositoryUrl
        || config.deploy.defaultRepositoryUrl
        || '',
      ).trim();
      const gitSession = await createGitCredentialSession(process.env);

      try {
        const prepared = await ensureRepositoryWorkspace({
          repositoryPath: repoPath,
          repositoryUrl,
          ref: params.branch || config.deploy.defaultBranch,
          timeoutMs: timeout,
          env: gitSession.env,
        });
        const repoRoot = await this.resolveRepoRoot(prepared.repositoryPath, gitSession.env);

        let result;
        if (action === 'save-and-push') {
          result = await this.runSaveAndPush(repoRoot, params, timeout, tracker, gitSession.env);
        } else if (action === 'remote-info') {
          result = await this.runRemoteInfo(repoRoot, timeout, tracker, gitSession.env);
        } else {
          const args = await this.buildArgs(action, repoRoot, params, gitSession.env);
          tracker.recordExecution(`git ${args.join(' ')}`, { repoRoot, action });
          result = await this.spawnGit(args, {
            cwd: repoRoot,
            timeout,
            env: gitSession.env,
          });
        }

        const branch = await this.getCurrentBranch(repoRoot, gitSession.env).catch(() => '');

        return {
          action,
          repoRoot,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          branch,
          duration: result.duration,
        };
      } finally {
        await gitSession.cleanup();
      }
    } catch (error) {
      if (error?.code === 'ENOENT' && /git/i.test(String(error?.message || ''))) {
        throw new Error('Git CLI is unavailable in the backend runtime. Install `git` in the runtime image or ensure it is on PATH before using git-safe.');
      }
      throw error;
    }
  }

  async runSaveAndPush(repoRoot, params, timeout, tracker, env) {
    const pathspecs = this.sanitizePathspecs(params.paths, { allowDefaultAll: true });
    const commitMessage = this.sanitizeCommitMessage(params.message || 'Update from KimiBuilt agent');
    const remote = this.sanitizeRemote(params.remote || 'origin');
    const branch = this.sanitizeBranch(params.branch || await this.getCurrentBranch(repoRoot, env));
    const setUpstream = params.setUpstream === true;

    const staged = await this.spawnGit(['add', '--', ...pathspecs], {
      cwd: repoRoot,
      timeout,
      env,
    });
    tracker.recordExecution(`git add -- ${pathspecs.join(' ')}`, { repoRoot, action: 'add' });

    const stagedDiff = await this.spawnGitAllowFailure(['diff', '--cached', '--quiet', '--'], {
      cwd: repoRoot,
      timeout,
      env,
    });
    tracker.recordExecution('git diff --cached --quiet --', { repoRoot, action: 'diff' });

    let committed = {
      exitCode: 0,
      stdout: 'No staged changes to commit.',
      stderr: '',
      duration: stagedDiff.duration || 0,
    };
    if (stagedDiff.exitCode === 1) {
      committed = await this.spawnGit(this.buildCommitArgs(commitMessage), {
        cwd: repoRoot,
        timeout,
        env,
      });
      tracker.recordExecution(`git commit -m ${JSON.stringify(commitMessage)}`, { repoRoot, action: 'commit' });
    } else if (stagedDiff.exitCode !== 0) {
      const detail = stagedDiff.stderr || stagedDiff.stdout || 'unable to inspect staged changes';
      throw new Error(`git-safe could not inspect staged changes before committing: ${detail}`);
    } else {
      tracker.recordExecution('git commit skipped: no staged changes', { repoRoot, action: 'commit' });
    }

    const pushArgs = ['push'];
    if (setUpstream) {
      pushArgs.push('-u');
    }
    pushArgs.push(remote, branch);
    const pushed = await this.spawnGit(pushArgs, {
      cwd: repoRoot,
      timeout,
      env,
    });
    tracker.recordExecution(`git ${pushArgs.join(' ')}`, { repoRoot, action: 'push' });

    return {
      exitCode: pushed.exitCode,
      stdout: [staged.stdout, committed.stdout, pushed.stdout].filter(Boolean).join('\n').trim(),
      stderr: [staged.stderr, committed.stderr, pushed.stderr].filter(Boolean).join('\n').trim(),
      duration: staged.duration + committed.duration + pushed.duration,
    };
  }

  async runRemoteInfo(repoRoot, timeout, tracker, env) {
    tracker.recordExecution('git remote inspection', { repoRoot, action: 'remote-info' });

    const branch = await this.getCurrentBranch(repoRoot, env).catch(() => '');
    const head = await this.spawnGitAllowFailure(['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeout,
      env,
    });
    const upstream = await this.spawnGitAllowFailure(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
      cwd: repoRoot,
      timeout,
      env,
    });
    const remotes = await this.spawnGitAllowFailure(['remote', '-v'], {
      cwd: repoRoot,
      timeout,
      env,
    });

    const stdoutLines = [
      branch ? `branch: ${branch}` : '',
      head.stdout ? `head: ${head.stdout}` : '',
      upstream.exitCode === 0 && upstream.stdout ? `upstream: ${upstream.stdout}` : 'upstream: none',
      remotes.stdout ? `remotes:\n${remotes.stdout}` : 'remotes: none',
    ].filter(Boolean);

    const stderrLines = [head.stderr, upstream.exitCode === 0 ? '' : upstream.stderr, remotes.stderr]
      .filter(Boolean);

    return {
      exitCode: 0,
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n').trim(),
      duration: head.duration + upstream.duration + remotes.duration,
    };
  }

  async buildArgs(action, repoRoot, params, env) {
    switch (action) {
      case 'status':
        return ['status', '--short', '--branch'];
      case 'diff':
        return ['diff', '--stat'];
      case 'branch':
        return ['branch', '--show-current'];
      case 'remote-info':
        return ['remote', '-v'];
      case 'add':
        return ['add', '--', ...this.sanitizePathspecs(params.paths, { allowDefaultAll: false })];
      case 'commit':
        return this.buildCommitArgs(this.sanitizeCommitMessage(params.message));
      case 'push': {
        const remote = this.sanitizeRemote(params.remote || 'origin');
        const branch = this.sanitizeBranch(params.branch || await this.getCurrentBranch(repoRoot, env));
        const args = ['push'];
        if (params.setUpstream === true) {
          args.push('-u');
        }
        args.push(remote, branch);
        return args;
      }
      default:
        throw new Error(`Unsupported git-safe action '${action}'`);
    }
  }

  sanitizePathspecs(paths, options = {}) {
    const input = Array.isArray(paths)
      ? paths
      : (typeof paths === 'string' && paths.trim() ? [paths] : []);
    const sanitized = input
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);

    if (sanitized.length === 0 && options.allowDefaultAll) {
      return ['.'];
    }

    if (sanitized.length === 0) {
      throw new Error('git-safe add requires one or more non-empty paths.');
    }

    sanitized.forEach((entry) => {
      if (entry.startsWith('-')) {
        throw new Error(`Invalid git pathspec '${entry}'. Pathspecs cannot start with '-'.`);
      }
    });

    return sanitized;
  }

  sanitizeCommitMessage(message) {
    const normalized = String(message || '').trim();
    if (!normalized) {
      throw new Error('git-safe commit requires a non-empty commit message.');
    }
    return normalized;
  }

  sanitizeRemote(remote) {
    const normalized = String(remote || '').trim();
    if (!normalized) {
      throw new Error('git-safe push requires a remote name.');
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) {
      throw new Error(`Invalid git remote '${normalized}'.`);
    }
    return normalized;
  }

  sanitizeBranch(branch) {
    const normalized = String(branch || '').trim();
    if (!normalized) {
      throw new Error('git-safe push requires a branch name.');
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) {
      throw new Error(`Invalid git branch '${normalized}'.`);
    }
    return normalized;
  }

  buildCommitArgs(message) {
    const identity = this.resolveCommitIdentity();
    return [
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '-m',
      message,
    ];
  }

  resolveCommitIdentity() {
    const name = String(
      process.env.KIMIBUILT_GIT_COMMIT_NAME
      || process.env.GIT_AUTHOR_NAME
      || process.env.GIT_COMMITTER_NAME
      || 'KimiBuilt Agent',
    ).trim() || 'KimiBuilt Agent';
    const email = String(
      process.env.KIMIBUILT_GIT_COMMIT_EMAIL
      || process.env.GIT_AUTHOR_EMAIL
      || process.env.GIT_COMMITTER_EMAIL
      || 'kimibuilt-agent@local.invalid',
    ).trim() || 'kimibuilt-agent@local.invalid';

    return { name, email };
  }

  async resolveRepoRoot(repoPath, env) {
    await fs.access(repoPath);
    const result = await this.spawnGit(['rev-parse', '--show-toplevel'], {
      cwd: repoPath,
      timeout: 10000,
      env,
    });
    const repoRoot = String(result.stdout || '').trim();
    if (!repoRoot) {
      throw new Error(`Unable to resolve git repository root from ${repoPath}`);
    }
    return repoRoot;
  }

  async getCurrentBranch(repoRoot, env) {
    const result = await this.spawnGit(['branch', '--show-current'], {
      cwd: repoRoot,
      timeout: 10000,
      env,
    });
    const branch = String(result.stdout || '').trim();
    if (!branch) {
      throw new Error('Unable to determine current git branch.');
    }
    return branch;
  }

  async spawnGit(args, options = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn('git', args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`git ${args[0]} timed out after ${options.timeout}ms`));
      }, options.timeout || 60000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (exitCode !== 0) {
          const error = new Error((stderr || stdout || `git exited with code ${exitCode}`).trim());
          error.exitCode = exitCode;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          exitCode: exitCode || 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          duration: Date.now() - startedAt,
        });
      });
    });
  }

  async spawnGitAllowFailure(args, options = {}) {
    const startedAt = Date.now();
    try {
      return await this.spawnGit(args, options);
    } catch (error) {
      return {
        exitCode: Number(error?.exitCode) || 1,
        stdout: String(error?.stdout || '').trim(),
        stderr: String(error?.stderr || error?.message || '').trim(),
        duration: Date.now() - startedAt,
      };
    }
  }
}

module.exports = { GitLocalTool };
