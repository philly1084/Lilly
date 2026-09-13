'use strict';
const fs = require('node:fs'); const https = require('node:https'); const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'); const crypto = require('node:crypto');
const cfg = '/etc/lilly-node';
function request(credentials, localAddress) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: '10.42.0.1', port: 9447, path: '/unsupported', localAddress,
      ca: fs.readFileSync(`${cfg}/node-ca.crt`), rejectUnauthorized: true,
      ...(credentials ? { key: fs.readFileSync(`${cfg}/client.key`), cert: fs.readFileSync(`${cfg}/client.crt`) } : {}) }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(2500, () => req.destroy(new Error('deadline'))); req.on('error', reject);
  });
}
async function main() {
  const properties = execFileSync('/usr/bin/systemctl', ['show', 'lilly-node.service', '-p', 'ActiveState', '-p', 'SubState', '-p', 'NoNewPrivileges', '-p', 'MemoryMax', '-p', 'TasksMax', '-p', 'IPAddressDeny', '-p', 'IPAddressAllow'], { encoding: 'utf8' });
  assert.ok(properties.includes('ActiveState=active')); assert.ok(properties.includes('NoNewPrivileges=yes'));
  assert.equal(await request(true), 400);
  await assert.rejects(request(false));
  await assert.rejects(request(true, '168.119.176.121'));
  const hashes = JSON.parse(fs.readFileSync('/tmp/lilly-node-install-hashes.json'));
  for (const [name, hash] of Object.entries(hashes)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`/opt/lilly-node/${name}`)).digest('hex'), hash);
  const config = require('/opt/lilly-node/src/agent-computer/node-service-config').loadNodeServiceConfig(`${cfg}/service.json`);
  const { Pool } = require('/opt/lilly-node/node_modules/pg'); const pool = new Pool(config.database);
  try {
    const result = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'); assert.equal(result.rows[0].ssl, true);
  } finally { await pool.end(); }
  const report = { at: new Date().toISOString(), installed: true, serviceActive: true, sourceHashesVerified: Object.keys(hashes).length,
    authenticatedTls: true, missingClientCertificateDenied: true, unapprovedSourceAddressDenied: true,
    databaseTlsVerified: true, backendConnected: false, agentsStarted: 0, properties };
  fs.writeFileSync('/opt/lilly-node/install-proof.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
