'use strict';

const { EventEmitter } = require('events');
const { WebSocket } = require('ws');
const { config } = require('../config');
const { sanitizeConfigValue } = require('../config-placeholders');
const {
  createId,
  normalizeCommandJob,
  normalizeJobResult,
  normalizeRunnerMetadata,
  normalizeRunnerRegistration,
  normalizeText,
} = require('./protocol');

function parseBearerToken(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  const match = normalized.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeText(match[1]) : normalized;
}

function getRequestToken(req = null) {
  if (!req) {
    return '';
  }

  const authorization = req.headers?.authorization || '';
  if (authorization) {
    return parseBearerToken(authorization);
  }

  try {
    const url = new URL(req.url || '', 'http://localhost');
    const queryToken = normalizeText(url.searchParams.get('token') || url.searchParams.get('runnerToken'));
    if (queryToken) {
      console.warn('[RemoteRunner] Query-string runner tokens are deprecated; use Authorization: Bearer instead.');
    }
    return queryToken;
  } catch (_error) {
    return '';
  }
}

function getRunnerSocketOpen(runner = null) {
  return Boolean(runner?.online && runner.ws && runner.ws.readyState === WebSocket.OPEN);
}

function getRunnerFreshness(runner = null, staleAfterMs = 45000) {
  const normalizedStaleAfterMs = Math.max(5000, Number(staleAfterMs) || 45000);
  const lastHeartbeatMs = Date.parse(runner?.lastHeartbeat || runner?.connectedAt || '');
  const heartbeatAgeMs = Number.isFinite(lastHeartbeatMs) ? Math.max(0, Date.now() - lastHeartbeatMs) : null;
  const stale = heartbeatAgeMs !== null && heartbeatAgeMs > normalizedStaleAfterMs;
  return {
    staleAfterMs: normalizedStaleAfterMs,
    heartbeatAgeMs,
    stale,
  };
}

class RemoteRunnerService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || config.remoteRunner || {};
    this.runners = new Map();
    this.jobs = new Map();
    this.pending = new Map();
  }

  isEnabled() {
    return this.config.enabled !== false;
  }

  hasToken() {
    return Boolean(sanitizeConfigValue(this.config.token));
  }

  authenticateToken(token = '') {
    if (!this.isEnabled()) {
      throw new Error('Remote runner control plane is disabled');
    }
    if (!this.hasToken()) {
      throw new Error('KIMIBUILT_REMOTE_RUNNER_TOKEN is required before runners can connect');
    }
    if (sanitizeConfigValue(token) !== sanitizeConfigValue(this.config.token)) {
      throw new Error('Invalid remote runner token');
    }
  }

  authenticateRequest(req = null) {
    this.authenticateToken(getRequestToken(req));
  }

  registerRunner(input = {}, ws = null) {
    const normalized = normalizeRunnerRegistration(input);
    const existing = this.runners.get(normalized.runnerId) || {};
    const now = new Date().toISOString();
    const runner = {
      ...existing,
      ...normalized,
      status: ws ? 'online' : (existing.status || 'registered'),
      online: Boolean(ws || existing.ws),
      connectedAt: ws ? now : existing.connectedAt || null,
      lastHeartbeat: now,
      ws: ws || existing.ws || null,
    };

    if (ws) {
      ws.runnerId = normalized.runnerId;
    }

    this.runners.set(normalized.runnerId, runner);
    this.emit('runner:registered', this.serializeRunner(runner));
    return this.serializeRunner(runner);
  }

  heartbeat(runnerId = '', payload = {}) {
    const runner = this.runners.get(runnerId);
    if (!runner) {
      return null;
    }

    runner.lastHeartbeat = new Date().toISOString();
    runner.status = 'online';
    runner.online = true;
    if (payload.hostIdentity && typeof payload.hostIdentity === 'object') {
      runner.hostIdentity = { ...runner.hostIdentity, ...payload.hostIdentity };
    }
    if (payload.metadata && typeof payload.metadata === 'object') {
      runner.metadata = normalizeRunnerMetadata({ ...runner.metadata, ...payload.metadata });
    }
    this.runners.set(runnerId, runner);
    this.emit('runner:heartbeat', this.serializeRunner(runner));
    return this.serializeRunner(runner);
  }

  markDisconnected(runnerId = '') {
    const runner = this.runners.get(runnerId);
    if (!runner) {
      return;
    }
    runner.status = 'offline';
    runner.online = false;
    runner.ws = null;
    runner.disconnectedAt = new Date().toISOString();
    this.runners.set(runnerId, runner);
    this.emit('runner:disconnected', this.serializeRunner(runner));
  }

  isRunnerHealthy(runner = null) {
    if (!getRunnerSocketOpen(runner)) {
      return false;
    }
    const freshness = getRunnerFreshness(runner, this.config.staleAfterMs);
    if (freshness.heartbeatAgeMs === null) {
      return this.runnerSupportsProfile(runner);
    }
    return !freshness.stale && this.runnerSupportsProfile(runner);
  }

  runnerSupportsProfile(runner = null, requiredProfile = '') {
    const normalizedProfile = normalizeText(requiredProfile);
    if (!normalizedProfile) {
      return true;
    }
    const capabilities = Array.isArray(runner?.capabilities)
      ? runner.capabilities.map((capability) => normalizeText(capability)).filter(Boolean)
      : [];
    return capabilities.includes(normalizedProfile) || capabilities.includes('admin');
  }

  isRunnerReadyForProfile(runner = null, requiredProfile = '') {
    if (!getRunnerSocketOpen(runner)) {
      return false;
    }
    const freshness = getRunnerFreshness(runner, this.config.staleAfterMs);
    const fresh = freshness.heartbeatAgeMs === null || !freshness.stale;
    return fresh && this.runnerSupportsProfile(runner, requiredProfile);
  }

  describeRunnerUnavailable(runnerId = '', requiredProfile = '') {
    const profileHint = requiredProfile ? ` ${requiredProfile} jobs` : ' the requested job';
    const runner = runnerId ? this.runners.get(runnerId) : null;
    const runners = runnerId && runner ? [runner] : Array.from(this.runners.values());
    const staleCandidates = runners
      .filter((candidate) => getRunnerSocketOpen(candidate))
      .map((candidate) => ({
        runner: candidate,
        freshness: getRunnerFreshness(candidate, this.config.staleAfterMs),
      }))
      .filter((candidate) => candidate.freshness.stale);

    if (staleCandidates.length > 0) {
      const candidate = staleCandidates[0];
      const ageSeconds = Math.round((candidate.freshness.heartbeatAgeMs || 0) / 1000);
      const staleSeconds = Math.round(candidate.freshness.staleAfterMs / 1000);
      return runnerId
        ? `Remote runner ${runnerId} heartbeat is stale for ${ageSeconds}s, exceeding the ${staleSeconds}s freshness timeout; this is expected after sleep or network loss and the runner should reconnect before accepting${profileHint}`
        : `No healthy remote runner is online for${profileHint}; ${candidate.runner.runnerId || 'a runner'} heartbeat is stale for ${ageSeconds}s, exceeding the ${staleSeconds}s freshness timeout. This is expected after sleep or network loss and the runner should reconnect before accepting work`;
    }

    return runnerId
      ? `Remote runner ${runnerId} is not online or does not support${profileHint}`
      : `No healthy remote runner is online or supports${profileHint}`;
  }

  getHealthyRunner(preferredRunnerId = '', options = {}) {
    const requiredProfile = typeof options === 'string'
      ? normalizeText(options)
      : normalizeText(options.requiredProfile || options.profile);

    if (preferredRunnerId) {
      const runner = this.runners.get(preferredRunnerId);
      return this.isRunnerReadyForProfile(runner, requiredProfile) ? runner : null;
    }

    return Array.from(this.runners.values()).find((runner) => (
      this.isRunnerReadyForProfile(runner, requiredProfile)
    )) || null;
  }

  listRunners() {
    return Array.from(this.runners.values()).map((runner) => this.serializeRunner(runner));
  }

  getRunner(runnerId = '') {
    const runner = this.runners.get(runnerId);
    return runner ? this.serializeRunner(runner) : null;
  }

  serializeRunner(runner = {}) {
    const freshness = getRunnerFreshness(runner, this.config.staleAfterMs);
    const stale = getRunnerSocketOpen(runner) && freshness.stale;
    return {
      runnerId: runner.runnerId,
      displayName: runner.displayName,
      hostIdentity: runner.hostIdentity || {},
      status: this.isRunnerHealthy(runner) ? 'online' : (runner.status === 'registered' ? 'registered' : 'offline'),
      online: this.isRunnerHealthy(runner),
      stale,
      staleAfterMs: freshness.staleAfterMs,
      heartbeatAgeMs: freshness.heartbeatAgeMs,
      offlineReason: stale ? 'heartbeat_stale' : '',
      capabilities: runner.capabilities || [],
      allowedRoots: runner.allowedRoots || [],
      metadata: runner.metadata || {},
      connectedAt: runner.connectedAt || null,
      lastHeartbeat: runner.lastHeartbeat || null,
      disconnectedAt: runner.disconnectedAt || null,
    };
  }

  serializeJob(job = {}) {
    return {
      id: job.id,
      runnerId: job.runnerId,
      type: job.type,
      command: job.command,
      cwd: job.cwd,
      profile: job.profile,
      status: job.status,
      createdAt: job.createdAt,
      sentAt: job.sentAt || null,
      finishedAt: job.finishedAt || null,
      ownerId: job.ownerId || null,
      sessionId: job.sessionId || null,
      result: job.result || null,
      error: job.error || '',
      metadata: job.metadata || {},
    };
  }

  listJobs({ runnerId = '', limit = 50 } = {}) {
    return Array.from(this.jobs.values())
      .filter((job) => !runnerId || job.runnerId === runnerId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
      .map((job) => this.serializeJob(job));
  }

  getJob(jobId = '') {
    const job = this.jobs.get(jobId);
    return job ? this.serializeJob(job) : null;
  }

  async dispatchCommand(runnerId = '', input = {}, context = {}) {
    const normalizedJob = normalizeCommandJob(input);
    const runner = this.getHealthyRunner(runnerId, {
      requiredProfile: normalizedJob.profile,
    });
    if (!runner) {
      const error = new Error(this.describeRunnerUnavailable(runnerId, normalizedJob.profile));
      error.statusCode = 503;
      throw error;
    }

    const job = {
      ...normalizedJob,
      runnerId: runner.runnerId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      ownerId: normalizeText(context.ownerId || context.userId),
      sessionId: normalizeText(context.sessionId),
    };
    this.jobs.set(job.id, job);

    return this.sendJob(runner, job);
  }

  sendJob(runner = {}, job = {}) {
    if (!this.isRunnerReadyForProfile(runner, job.profile)) {
      const error = new Error(`Remote runner ${runner.runnerId || 'unknown'} is not online or does not support ${job.profile || 'the requested'} jobs`);
      error.statusCode = 503;
      throw error;
    }

    job.status = 'sent';
    job.sentAt = new Date().toISOString();
    this.jobs.set(job.id, job);

    const timeoutMs = Math.max(1000, Number(job.timeout || this.config.jobTimeoutMs) || 120000);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        job.status = 'timeout';
        job.finishedAt = new Date().toISOString();
        job.error = `Remote runner job timed out after ${timeoutMs}ms`;
        this.jobs.set(job.id, job);
        reject(new Error(job.error));
      }, timeoutMs + 1000);

      this.pending.set(job.id, { resolve, reject, timer });
    });

    runner.ws.send(JSON.stringify({
      type: 'job',
      job: {
        id: job.id,
        type: job.type,
        command: job.command,
        cwd: job.cwd,
        environment: job.environment,
        timeout: job.timeout,
        profile: job.profile,
        approval: job.approval,
        metadata: {
          ...job.metadata,
          ownerId: job.ownerId,
          sessionId: job.sessionId,
        },
      },
    }));

    return promise;
  }

  handleJobResult(input = {}) {
    const result = normalizeJobResult(input, {
      maxOutputChars: this.config.maxOutputChars,
    });
    if (!result.jobId) {
      throw new Error('job_result.jobId is required');
    }

    const job = this.jobs.get(result.jobId) || {
      id: result.jobId,
      runnerId: normalizeText(input.runnerId),
      type: 'command',
      command: '',
      createdAt: new Date().toISOString(),
    };

    job.status = result.error ? 'failed' : 'completed';
    job.result = result;
    job.finishedAt = result.finishedAt;
    job.error = result.error || '';
    this.jobs.set(job.id, job);

    const pending = this.pending.get(job.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(job.id);
      if (result.error) {
        const error = new Error(result.error);
        error.result = result;
        pending.reject(error);
      } else {
        pending.resolve(result);
      }
    }

    this.emit('job:result', this.serializeJob(job));
    return this.serializeJob(job);
  }

  attachWebSocket(ws, req = null) {
    this.authenticateRequest(req);

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const type = normalizeText(message.type);

        if (type === 'register') {
          const runner = this.registerRunner(message.runner || message.payload || {}, ws);
          ws.send(JSON.stringify({ type: 'registered', runner }));
          return;
        }

        if (type === 'heartbeat') {
          const runnerId = normalizeText(message.runnerId || ws.runnerId);
          const runner = this.heartbeat(runnerId, message.payload || {});
          if (runner) {
            ws.send(JSON.stringify({ type: 'heartbeat_ack', runnerId }));
          }
          return;
        }

        if (type === 'job_result') {
          this.handleJobResult({
            ...(message.result || message.payload || {}),
            runnerId: ws.runnerId,
          });
          return;
        }

        ws.send(JSON.stringify({ type: 'error', message: `Unknown runner message type: ${type}` }));
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });

    ws.on('close', () => {
      if (ws.runnerId) {
        this.markDisconnected(ws.runnerId);
      }
    });
  }
}

const remoteRunnerService = new RemoteRunnerService();

module.exports = {
  RemoteRunnerService,
  getRequestToken,
  remoteRunnerService,
};
