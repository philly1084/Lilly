#!/usr/bin/env node
'use strict';

// Explicit, disposable Linux proof. Never reads production database/model config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const https = require('node:https');
const { X509Certificate, createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const { runIsolated } = require('./lilly-team-postgres-proof');
const { TeamStore } = require('../src/agent-teams/store');

function systemdProperties(template, { runtime, cli, configPath }) {
  for (const value of [runtime, cli, configPath]) assert.match(value, /^\/[A-Za-z0-9/_.-]+$/);
  const section = template.split('[Service]')[1]?.split('[Install]')[0]; assert.ok(section);
  const lines = section.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const expected = ['Type', 'User', 'Group', 'WorkingDirectory', 'ExecStartPre', 'ExecStart', 'Restart', 'RestartSec',
    'UMask', 'NoNewPrivileges', 'CapabilityBoundingSet', 'RestrictAddressFamilies', 'LimitNOFILE', 'TasksMax',
    'MemoryMax', 'CPUQuota', 'TimeoutStopSec', 'KillMode'];
  assert.deepEqual(lines.map(line => line.split('=')[0]).sort(), [...expected].sort(), 'Review changed unit properties before proof.');
  return lines.filter(line => !line.startsWith('ExecStart=')).map(line => {
    if (line.startsWith('WorkingDirectory=')) return `WorkingDirectory=${path.resolve(__dirname, '..')}`;
    if (line.startsWith('ExecStartPre=')) return `ExecStartPre=${runtime} ${cli} --config ${configPath} --check`;
    return line;
  });
}

async function prove(pool, { systemd = false, evidence = {} } = {}) {
  assert.equal(process.getuid(), 0);
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Proof must use the supported Node runtime.');
  assert.match(pool.options.host, /^\/tmp\/lilly-team-pg-proof\.[^/]+\/socket$/);
  const root = path.dirname(pool.options.host);
  const file = (name, data) => {
    const target = path.join(root, name); fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' }); return target;
  };
  const checks = [];
  const store = new TeamStore({ database: { query: (...args) => pool.query(...args), getPool: () => pool } });
  await store.initialize();
  await pool.query('CREATE ROLE lilly_node_proof LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await pool.query('GRANT USAGE ON SCHEMA public TO lilly_node_proof');
  await pool.query('GRANT SELECT, UPDATE (state, updated_at) ON lilly_agent_teams TO lilly_node_proof');
  checks.push('isolated_existing_schema_and_limited_role');
  const key = path.join(root, 'fixture-key.pem'); const cert = path.join(root, 'fixture-cert.pem');
  const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
  { timeout: 15000, encoding: 'utf8' });
  assert.equal(generated.status, 0, 'Disposable certificate generation failed.');
  fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
  let child; let ended; let database; let unit;
  const systemctl = args => spawnSync('/usr/bin/systemctl', args, { timeout: 20000, encoding: 'utf8' });
  const stopUnit = () => {
    if (!unit) return;
    const state = systemctl(['show', unit, '--property=LoadState', '--value']);
    if (state.stdout.trim() === 'not-found') { unit = null; return; }
    assert.equal(systemctl(['show', unit, '--property=Description', '--value']).stdout.trim(), `Lilly isolated proof ${unit}`);
    const stopped = systemctl(['stop', unit]); assert.equal(stopped.status, 0, 'Transient service stop was not confirmed.');
  };
  try {
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const config = { version: 1, nodeName: os.hostname(), listen: { host: '127.0.0.1', port },
      tlsFiles: { key, cert, ca: cert }, clientFingerprints: [new X509Certificate(fs.readFileSync(cert)).fingerprint256],
      database: { host: pool.options.host, port: 5432, database: 'lilly_team_proof', user: 'lilly_node_proof',
        passwordFile: file('fixture-password', 'unused-isolated-proof'), caFile: null },
      kubernetes: { server: 'https://127.0.0.1:9', tokenPath: file('fixture-token', 'not-a-kubernetes-credential'), caPath: cert },
      recovery: { image: `invalid.example/recovery@sha256:${'a'.repeat(64)}`, storageRoot: root } };
    const configPath = file('fixture-config.json', JSON.stringify(config));
    const cli = path.resolve(__dirname, 'lilly-node-service.js');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}) };
    const preflight = spawnSync(process.execPath, [cli, '--config', configPath, '--check'], { env, timeout: 20000, encoding: 'utf8' });
    assert.equal(preflight.status, 0, `Native preflight failed: ${preflight.stderr}`);
    assert.equal(preflight.stdout.trim(), '[LillyNode] local_preflight_passed');
    checks.push('real_cli_linux_host_tls_database_preflight');
    database = new Pool({ ...pool.options, user: 'lilly_node_proof', max: 1 });
    for (const sql of ['CREATE TABLE forbidden (id int)', 'DELETE FROM lilly_agent_teams',
      "INSERT INTO lilly_agent_teams (id, owner_id, state) VALUES ('forbidden', 'fixture', '{}')"]) {
      await assert.rejects(database.query(sql), { code: '42501' });
    }
    await database.query("UPDATE lilly_agent_teams SET state = state, updated_at = updated_at WHERE id = 'absent-fixture'");
    checks.push('real_database_denies_ddl_insert_delete_allows_state_update');
    await pool.query('GRANT CREATE ON SCHEMA public TO lilly_node_proof');
    const rejected = spawnSync(process.execPath, [cli, '--config', configPath, '--check'], { env, timeout: 20000, encoding: 'utf8' });
    assert.equal(rejected.status, 1); assert.equal(rejected.stderr.trim(), '[LillyNode] startup_unavailable');
    await pool.query('REVOKE CREATE ON SCHEMA public FROM lilly_node_proof');
    checks.push('native_startup_rejects_overprivileged_role');
    let executable = process.execPath; let args = [cli, '--config', configPath];
    if (systemd) {
      unit = `lilly-node-proof-${randomUUID()}.service`;
      assert.equal(systemctl(['show', unit, '--property=LoadState', '--value']).stdout.trim(), 'not-found');
      const template = fs.readFileSync(path.resolve(__dirname, '../deploy/lilly-node/lilly-node.service'), 'utf8');
      const properties = systemdProperties(template, { runtime: process.execPath, cli, configPath });
      evidence.unitName = unit; evidence.properties = properties; evidence.unitTemplateSha256 = createHash('sha256').update(template).digest('hex');
      executable = '/usr/bin/systemd-run';
      args = ['--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--description=Lilly isolated proof ${unit}`,
        '--property=RuntimeMaxSec=45', ...properties.map(value => `--property=${value}`),
        ...Object.entries(env).map(([name, value]) => `--setenv=${name}=${value}`), process.execPath, cli, '--config', configPath];
    }
    child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    ended = once(child, 'exit');
    let output = ''; child.stderr.on('data', value => { evidence.childDiagnostics = `${evidence.childDiagnostics || ''}${value}`.slice(-3000); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Private listener startup timed out.')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Private listener exited before ready.')); });
      child.stdout.on('data', value => { output += value; if (output.includes('[LillyNode] listening')) { clearTimeout(timer); resolve(); } });
    });
    if (systemd) {
      const result = systemctl(['show', unit, '--property=MainPID,Transient,NoNewPrivileges,MemoryMax,TasksMax,CPUQuotaPerSecUSec,CapabilityBoundingSet']);
      assert.equal(result.status, 0);
      const properties = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
      assert.equal(properties.Transient, 'yes'); assert.equal(properties.NoNewPrivileges, 'yes');
      assert.equal(properties.MemoryMax, '536870912'); assert.equal(properties.TasksMax, '64');
      assert.equal(properties.CPUQuotaPerSecUSec, '1s');
      assert.deepEqual(properties.CapabilityBoundingSet.split(' ').sort(), ['cap_dac_read_search', 'cap_sys_ptrace']);
      assert.match(properties.MainPID, /^[1-9]\d*$/);
      const status = fs.readFileSync(`/proc/${properties.MainPID}/status`, 'utf8');
      assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^CapEff:\s+0*80004$/m);
      evidence.activeProperties = properties;
      checks.push('systemd_enforces_template_caps_no_new_privileges_cpu_memory_and_tasks');
    }
    const status = await new Promise((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port, path: '/not-a-node-operation', ca: fs.readFileSync(cert),
        key: fs.readFileSync(key), cert: fs.readFileSync(cert), minVersion: 'TLSv1.3', agent: false }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Private request timeout.'))); req.once('error', reject);
    });
    assert.ok(status >= 400 && status < 500);
    checks.push('real_private_mutual_tls_listener_rejects_non_operation');
    if (systemd) stopUnit(); else child.kill('SIGTERM');
    const [exitCode, signal] = await Promise.race([ended, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Shutdown timed out.')), 10000); timer.unref();
    })]);
    assert.equal(exitCode, 0); assert.equal(signal, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'lilly-node-service'")).rows[0].n, 0);
    checks.push('native_sigterm_exits_cleanly_and_closes_database_sessions');
    if (systemd) {
      assert.equal(systemctl(['show', unit, '--property=LoadState', '--value']).stdout.trim(), 'not-found');
      evidence.unitCollected = true; unit = null;
      checks.push('transient_unit_removed_without_installing_or_enabling_service');
    }
    return checks;
  } finally {
    stopUnit();
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
    if (database) await database.end();
    // Only exact disposable credential files created above; retain nonsecret report.
    for (const name of ['fixture-key.pem', 'fixture-cert.pem', 'fixture-password', 'fixture-token', 'fixture-config.json']) {
      const target = path.join(root, name); if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  }
}

async function main() {
  const args = process.argv.slice(2); const systemd = args[1] === '--systemd';
  assert.deepEqual(args, systemd ? ['--run-isolated', '--systemd'] : ['--run-isolated']);
  const evidence = {};
  const report = await runIsolated(pool => prove(pool, { systemd, evidence }));
  report.systemd = systemd ? evidence : null;
  report.nodeVersion = process.versions.node;
  for (const source of Object.keys(require.cache)) {
    const relative = path.relative(path.resolve(__dirname, '..'), source);
    if (relative.startsWith('..') || relative.split(path.sep).includes('node_modules')) continue;
    report.sourceSha256[relative.split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  }
  for (const source of ['bin/lilly-node-service.js', 'src/agent-computer/node-service.js', 'src/agent-computer/node-service-config.js']) {
    report.sourceSha256[source] = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', source))).digest('hex');
  }
  report.scope = 'Native Linux preflight, restricted SQL, private TLS listener and shutdown; no models, workers or Kubernetes operations.';
  fs.writeFileSync(path.join(report.root, 'node-service-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`NODE_SERVICE_REPORT ${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch(() => { console.error('Node service proof failed.'); process.exitCode = 1; });
module.exports = { prove, systemdProperties };
