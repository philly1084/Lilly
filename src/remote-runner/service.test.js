'use strict';

const { EventEmitter } = require('events');
const { WebSocket } = require('ws');
const { RemoteRunnerService } = require('./service');
const { AsyncLabStore } = require('../async-lab/store');
const { AgentRunService } = require('../agent-runs/service');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

describe('RemoteRunnerService', () => {
  test('rejects unauthenticated runner requests', () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'secret',
      },
    });

    expect(() => service.authenticateToken('wrong')).toThrow('Invalid remote runner token');
  });

  test('accepts runner bearer auth and preserves deprecated query-token compatibility', () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'secret',
      },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => service.authenticateRequest({
      headers: { authorization: 'Bearer secret' },
      url: '/api/runners/register',
    })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();

    expect(() => service.authenticateRequest({
      headers: {},
      url: '/ws/runners?runnerToken=secret',
    })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Query-string runner tokens are deprecated'));

    warn.mockRestore();
  });

  test('rejects placeholder runner tokens as unset configuration', () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'REPLACE_WITH_THE_BACKEND_RUNNER_TOKEN',
      },
    });

    expect(service.hasToken()).toBe(false);
    expect(() => service.authenticateToken('REPLACE_WITH_THE_BACKEND_RUNNER_TOKEN'))
      .toThrow('KIMIBUILT_REMOTE_RUNNER_TOKEN is required');
  });

  test('registers a websocket runner and dispatches command jobs', async () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'secret',
        staleAfterMs: 45000,
        jobTimeoutMs: 30000,
      },
    });
    const socket = new FakeSocket();
    service.registerRunner({
      runnerId: 'runner-1',
      capabilities: ['inspect', 'deploy'],
      allowedRoots: ['/opt'],
    }, socket);

    const pending = service.dispatchCommand('runner-1', {
      command: 'hostname',
      timeout: 30000,
    }, {
      ownerId: 'phil',
      sessionId: 'session-1',
    });

    expect(socket.sent[0]).toEqual(expect.objectContaining({
      type: 'job',
      job: expect.objectContaining({
        command: 'hostname',
      }),
    }));

    service.handleJobResult({
      jobId: socket.sent[0].job.id,
      stdout: 'deploy-host\n',
      stderr: '',
      exitCode: 0,
      duration: 10,
      host: 'runner-host',
    });

    await expect(pending).resolves.toEqual(expect.objectContaining({
      stdout: 'deploy-host\n',
      exitCode: 0,
      host: 'runner-host',
    }));
    expect(service.getJob(socket.sent[0].job.id)).toEqual(expect.objectContaining({
      status: 'completed',
      ownerId: 'phil',
      sessionId: 'session-1',
    }));
  });

  test('returns canonical AgentRun metadata while preserving the remote job id', async () => {
    const agentRunService = new AgentRunService({
      store: new AsyncLabStore({ persistToPostgres: false }),
    });
    const service = new RemoteRunnerService({
      agentRunService,
      config: {
        enabled: true,
        token: 'secret',
        staleAfterMs: 45000,
        jobTimeoutMs: 30000,
      },
    });
    const socket = new FakeSocket();
    service.registerRunner({
      runnerId: 'runner-proof',
      capabilities: ['inspect'],
    }, socket);

    const pending = service.dispatchCommand('runner-proof', {
      id: 'remote-job-proof',
      command: 'hostname',
    }, {
      ownerId: 'phil',
      sessionId: 'session-proof',
    });
    await new Promise((resolve) => setImmediate(resolve));
    service.handleJobResult({
      jobId: 'remote-job-proof',
      stdout: 'proof-host\n',
      exitCode: 0,
    });

    const result = await pending;
    expect(result.jobId).toBe('remote-job-proof');
    expect(result.runId).toMatch(/^agent-run-/);
    expect(result.agentRunEvent).toMatchObject({
      version: 'AgentRunEvent/v1',
      state: 'completed',
      type: 'remote_runner.completed',
    });
    const stored = await agentRunService.getRun(result.runId, 'phil');
    expect(stored.state).toBe('completed');
  });

  test('selects only runners that support the requested capability profile', async () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'secret',
        staleAfterMs: 45000,
        jobTimeoutMs: 30000,
      },
    });
    const inspectSocket = new FakeSocket();
    const buildSocket = new FakeSocket();
    service.registerRunner({
      runnerId: 'inspect-only',
      capabilities: ['inspect'],
      allowedRoots: ['/workspace'],
    }, inspectSocket);
    service.registerRunner({
      runnerId: 'builder',
      capabilities: ['inspect', 'build'],
      allowedRoots: ['/workspace'],
    }, buildSocket);

    const pending = service.dispatchCommand('', {
      command: 'npm test',
      profile: 'build',
      timeout: 30000,
    });

    expect(inspectSocket.sent).toHaveLength(0);
    expect(buildSocket.sent[0]).toEqual(expect.objectContaining({
      type: 'job',
      job: expect.objectContaining({
        command: 'npm test',
        profile: 'build',
      }),
    }));

    service.handleJobResult({
      jobId: buildSocket.sent[0].job.id,
      stdout: 'ok\n',
      exitCode: 0,
      duration: 12,
      host: 'builder-host',
    });

    await expect(pending).resolves.toEqual(expect.objectContaining({
      stdout: 'ok\n',
    }));
  });

  test('rejects a named runner that lacks the requested capability profile', async () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'secret',
        staleAfterMs: 45000,
        jobTimeoutMs: 30000,
      },
    });
    service.registerRunner({
      runnerId: 'inspect-only',
      capabilities: ['inspect'],
    }, new FakeSocket());

    await expect(service.dispatchCommand('inspect-only', {
      command: 'npm test',
      profile: 'build',
    })).rejects.toThrow('does not support');
  });

  test('reports heartbeat-stale runners as expected timeout state', async () => {
    const service = new RemoteRunnerService({
      config: {
        enabled: true,
        token: 'secret',
        staleAfterMs: 5000,
        jobTimeoutMs: 30000,
      },
    });
    const socket = new FakeSocket();
    service.registerRunner({
      runnerId: 'sleeping-laptop',
      capabilities: ['inspect'],
    }, socket);
    const runner = service.runners.get('sleeping-laptop');
    runner.lastHeartbeat = new Date(Date.now() - 10000).toISOString();

    expect(service.getRunner('sleeping-laptop')).toEqual(expect.objectContaining({
      online: false,
      stale: true,
      staleAfterMs: 5000,
      offlineReason: 'heartbeat_stale',
    }));

    await expect(service.dispatchCommand('sleeping-laptop', {
      command: 'hostname',
      profile: 'inspect',
    })).rejects.toThrow(/heartbeat is stale/i);
    await expect(service.dispatchCommand('sleeping-laptop', {
      command: 'hostname',
      profile: 'inspect',
    })).rejects.toThrow(/expected after sleep or network loss/i);
  });
});
