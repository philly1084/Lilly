'use strict';

// Boots the real Lilly storage/auth/routes in the disposable proof process.
// Not a production server entry point, a DB URL adapter, or an agent tool.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function allowedConnection(args, socket, targets = new Set()) {
  const input = Array.isArray(args[0]) ? args[0] : args;
  const options = input[0];
  if (options && typeof options === 'object') {
    if (options.path !== undefined) return options.path === path.posix.join(socket, '.s.PGSQL.5432');
    return targets.has(`${options.host || options.hostname}:${Number(options.port)}`);
  }
  if (typeof options === 'string') return options === path.posix.join(socket, '.s.PGSQL.5432');
  return Number.isInteger(options) && targets.has(`${input[1]}:${options}`);
}

async function createServices({ source, root, pool, report, renderWorkroom = false }) {
  assert.equal(process.platform, 'linux'); assert.equal(process.cwd(), source);
  assert.match(source, /^\/tmp\/lilly-grok-team-source\.[A-Za-z0-9]+$/);
  assert.match(root, /^\/tmp\/lilly-grok-team-proof\.[A-Za-z0-9]+$/);
  assert.match(pool.options.host, /^\/tmp\/lilly-team-pg-proof\.[A-Za-z0-9]+\/socket$/);
  assert.equal(fs.realpathSync(pool.options.host), pool.options.host);
  assert.equal(pool.options.database, 'lilly_team_proof'); assert.equal(pool.options.user, 'lilly_team_proof');
  assert(!fs.existsSync(path.join(source, '.env')));
  assert(!require.cache[require.resolve('../src/config')]); assert(!require.cache[require.resolve('../src/postgres')]);
  const state = report.productServices = { networkDenied: 0, authenticatedHttp: false, closed: false };
  const targets = new Set(); const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function registeredListen(...args) {
    let target;
    this.once('listening', () => {
      const address = this.address();
      if (address && typeof address === 'object') {
        assert(['127.0.0.1', '::1'].includes(address.address), 'Proof listener must be loopback only.');
        target = `${address.address}:${address.port}`; targets.add(target);
      }
    });
    this.once('close', () => { if (target) targets.delete(target); });
    return listen.apply(this, args);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    if (!allowedConnection(args, pool.options.host, targets)) {
      state.networkDenied += 1;
      throw Object.assign(new Error('Proof forbids non-loopback/non-fixture database connections.'), { code: 'proof_network_denied' });
    }
    return connect.apply(this, args);
  };
  // The guard intentionally lasts until this dedicated process exits. No late
  // cleanup callback can regain production/network access after our HTTP close.
  for (const key of Object.keys(process.env)) {
    if (/^(POSTGRES_|PG|DATABASE_URL$|OPENAI_|XAI_|LILLYBUILT_|KIMIBUILT_|LILLY_TEAMS_|QDRANT_|OLLAMA_|REMOTE_CLI_|OPENCODE_)/.test(key)) delete process.env[key];
  }
  const password = randomUUID(); const jwtSecret = randomUUID();
  Object.assign(process.env, {
    NODE_ENV: 'test', KIMIBUILT_DATA_DIR: path.join(root, 'product-state'),
    POSTGRES_HOST: pool.options.host, POSTGRES_PORT: '5432', POSTGRES_USER: 'lilly_team_proof',
    POSTGRES_DB: 'lilly_team_proof', POSTGRES_PASSWORD: 'unused-isolated-proof', POSTGRES_SSL: 'false',
    LILLYBUILT_AUTH_USERNAME: 'proof-owner', LILLYBUILT_AUTH_PASSWORD: password, LILLYBUILT_JWT_SECRET: jwtSecret,
    LILLYBUILT_AUTH_TTL_SECONDS: '300', KIMIBUILT_AUTH_REQUIRED: 'true', KIMIBUILT_AUTH_TOTP_ENABLED: 'false',
    OPENAI_API_KEY: 'isolated-unused-key', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OLLAMA_BASE_URL: 'http://127.0.0.1:9', QDRANT_URL: 'http://127.0.0.1:9',
    LILLY_TEAMS_ENABLED: 'false', LILLY_TEAMS_VISION_ENABLED: 'false',
  });
  const { postgres } = require('../src/postgres');
  assert.equal(postgres.getConnectionConfig().host, pool.options.host);
  try { return await bootServices({ postgres, report, state, source, root, password, renderWorkroom }); }
  catch (error) {
    if (postgres.pool) { await postgres.pool.end(); postgres.pool = null; }
    state.closed = true; state.initializationFailed = true;
    throw error;
  }
}

async function bootServices({ postgres, report, state, source, root, password, renderWorkroom }) {
  assert.equal(await postgres.initialize(), true, 'Real product schema initialization must succeed.');
  const { sessionStore, SessionStore } = require('../src/session-store');
  const { artifactService } = require('../src/artifacts/artifact-service');
  await sessionStore.initialize(); assert(sessionStore.isPersistent()); assert(artifactService.isEnabled());
  const express = require('express'); const { requireAuth, createAuthToken, isAuthEnabled } = require('../src/auth/service');
  assert(isAuthEnabled());
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api', requireAuth);
  app.use('/api/artifacts', require('../src/routes/artifacts'));
  if (renderWorkroom) {
    app.use('/agent-ops', express.static(path.join(source, 'frontend/agent-ops')));
    // UI inspection cannot dispatch additional work or alter the fixed scenario.
    app.use('/api/agent-teams', (req, res, next) => req.method === 'GET' ? next() : res.sendStatus(405));
    for (const file of ['bin/kimibuilt-ui-check.js', 'frontend/agent-ops/index.html',
      'frontend/agent-ops/css/agent-ops.css', 'frontend/agent-ops/js/agent-ops.js',
      'frontend/agent-ops/js/team-client.js', 'frontend/agent-ops/js/team-manager.js',
      'frontend/agent-ops/vendor/fontawesome/css/all.min.css',
      'frontend/agent-ops/vendor/fontawesome/webfonts/fa-solid-900.woff2',
      'frontend/agent-ops/vendor/fontawesome/webfonts/fa-regular-400.woff2']) {
      report.sourceSha256[file] = createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex');
    }
  }
  let server; let base; let cookie; let uiPending;
  const request = async (route, { auth = 'owner', method = 'GET', body } = {}) => {
    assert(route.startsWith('/api/'));
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}) };
    if (auth === 'owner') headers.Cookie = cookie;
    if (auth === 'foreign') headers.Authorization = `Bearer ${createAuthToken('foreign-owner').token}`;
    if (auth === 'invalid') headers.Authorization = 'Bearer invalid-fixture-token';
    return fetch(`${base}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(10000) });
  };
  return {
    artifactService, sessionStore,
    async start(service) {
      if (renderWorkroom) app.locals.agentTeamRuntime = { service, status: () => ({
        enabled: true, visionEnabled: true, grokEnabled: true, runtime: 'grok-build-scripted-proof',
      }) };
      app.use('/api/agent-teams', require('../src/routes/agent-teams').createTeamRouter({ service }));
      app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: { code: error.code || 'product_route_failed' } }));
      server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
      base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await request('/api/agent-teams', { auth: 'none' })).status, 401);
      assert.equal((await request('/api/agent-teams', { auth: 'invalid' })).status, 401);
      const login = await request('/api/auth/login', { auth: 'none', method: 'POST', body: { username: 'proof-owner', password } });
      assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
      assert.equal((await request('/api/agent-teams')).status, 200); state.authenticatedHttp = true;
    },
    async workroom(teamId) {
      const response = await request(`/api/agent-teams/${teamId}/workroom`); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert(!JSON.stringify(body).includes('data:image')); return body;
    },
    async renderWorkroom(teamId, phase) {
      uiPending = (async () => {
      assert(renderWorkroom && ['overlap', 'reviewed'].includes(phase));
      assert.match(teamId, /^[a-f0-9-]{36}$/);
      const output = path.join(root, 'output/playwright', phase);
      const executable = '/snap/bin/chromium';
      assert(fs.existsSync(executable), 'Isolated UI proof requires the inspected host browser.');
      // Existing repository checker; this is an operator-page QA browser, not
      // the sandboxed private agent browser. Only disposable login material is
      // passed in the environment, never command arguments or result receipts.
      try { await promisify(execFile)(process.execPath, [path.join(source, 'bin/kimibuilt-ui-check.js'),
        `${base}/agent-ops/?team=${teamId}`, '--out', output, '--authenticated-app', '--same-origin-only',
        '--wait', '#artifactList a', '--timeout', '15000'], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', NODE_PATH: '/opt/kimibuilt/node_modules',
          PLAYWRIGHT_EXECUTABLE_PATH: executable, API_BASE_URL: base,
          KIMIBUILT_UI_CHECK_TOKEN: createAuthToken('proof-owner').token },
        timeout: 45000, maxBuffer: 1024 * 1024,
      }); } catch (error) {
        report.uiFailure = { phase, code: String(error.code || 'ui_check_failed'),
          diagnostic: String(error.stderr || '').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]').slice(-1000) };
        throw new Error('Isolated workroom rendering failed.');
      }
      const result = JSON.parse(fs.readFileSync(path.join(output, 'ui-check-report.json'), 'utf8'));
      assert.equal(result.authenticated, true); assert.equal(result.checks.length, 2);
      for (const check of result.checks) {
        assert.equal(check.ok, true); assert.deepEqual(check.issues, []);
        assert(check.metrics.bodyTextPreview.includes('Reviewed Grok team'));
      }
      (report.renderedWorkroom ||= []).push({ phase, report: path.join(output, 'ui-check-report.json'),
        screenshots: result.checks.map(check => check.screenshotPath) });
      report.checks.push(`rendered_authenticated_${phase}_workroom_passes_desktop_mobile_ui_checks`);
      })().catch(error => {
        report.uiFailure ||= { phase, code: String(error.code || 'ui_check_failed') };
        throw error;
      });
      return uiPending;
    },
    async verify(team, artifacts) {
      const freshSessions = new SessionStore(); await freshSessions.initialize(); assert(freshSessions.isPersistent());
      for (const agent of team.agents) {
        const session = await freshSessions.getOwned(agent.sessionId, 'proof-owner');
        assert.equal(session.metadata.teamId, team.id); assert.equal(session.metadata.teamAgentId, agent.id);
        assert.equal(await freshSessions.getOwned(agent.sessionId, 'foreign-owner'), null);
      }
      for (const artifact of artifacts) {
        const route = `/api/artifacts/${artifact.id}`;
        const record = await request(route); assert.equal(record.status, 200);
        const data = await record.json(); assert.equal(data.id, artifact.id); assert.equal(data.downloadUrl, `${route}/download`);
        const download = await request(data.downloadUrl); assert.equal(download.status, 200);
        const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(bytes.length, artifact.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
        assert.equal((await request(data.downloadUrl, { auth: 'none' })).status, 401);
        assert.equal((await request(data.downloadUrl, { auth: 'foreign' })).status, 404);
      }
      assert.equal((await request(`/api/agent-teams/${team.id}/workroom`, { auth: 'foreign' })).status, 404);
      assert.equal(state.networkDenied, 0);
      report.checks.push('real_session_store_reloads_owned_agent_sessions', 'real_artifact_service_outputs_read_through_authenticated_downloads',
        'normal_http_routes_reject_anonymous_invalid_and_foreign_access');
    },
    async close() {
      // Keep the exact inspection promise through worker failure; its report
      // must settle before HTTP/SQL close and the final proof receipt is saved.
      if (uiPending) await uiPending.catch(() => {});
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      if (postgres.pool) { await postgres.pool.end(); postgres.pool = null; }
      state.closed = true;
      for (const filename of Object.keys(require.cache)) if (filename.startsWith(`${source}${path.sep}`)) {
        const relative = path.relative(source, filename).replaceAll(path.sep, '/');
        report.sourceSha256[relative] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      }
      assert.equal(state.networkDenied, 0);
    },
  };
}

module.exports = { createServices, allowedConnection };
