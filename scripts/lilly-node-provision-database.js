'use strict';

// Primary-only, approved installation step. Password never leaves the host.
const fs = require('node:fs');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const dir = '/etc/lilly-node';
const role = 'lilly_node_primary';
function sql(statement) {
  return execFileSync('/usr/local/bin/kubectl', ['exec', '-i', '-n', 'kimibuilt', 'deployment/postgres', '--',
    'psql', '-X', '-U', 'kimibuilt', '-d', 'kimibuilt', '-v', 'ON_ERROR_STOP=1', '-At'],
  { input: statement, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
async function main() {
  assert.equal(os.hostname(), 'ubuntu-32gb-fsn1-1');
  assert.equal(process.getuid(), 0);
  const verifyOnly = process.argv[2] === '--verify-only';
  assert.equal(sql(`SELECT count(*) FROM pg_roles WHERE rolname='${role}';`), verifyOnly ? '1' : '0');
  assert.equal(sql("SELECT count(*) FROM pg_namespace WHERE nspname='public' AND EXISTS (SELECT 1 FROM aclexplode(coalesce(nspacl,acldefault('n',nspowner))) WHERE grantee=0 AND privilege_type='CREATE');"), '0');
  if (!verifyOnly) {
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(dir, { mode: 0o700 });
  const password = randomBytes(36).toString('hex');
  fs.writeFileSync(`${dir}/database.password`, password, { mode: 0o600, flag: 'wx' });
  fs.copyFileSync('/root/lilly-postgres-tls.N5ZBKo/ca.crt', `${dir}/database-ca.crt`, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(`${dir}/database-ca.crt`, 0o600);
  sql(`BEGIN;
    CREATE TABLE IF NOT EXISTS public.lilly_agent_teams (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
    GRANT CONNECT ON DATABASE kimibuilt TO ${role};
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT, UPDATE (state, updated_at) ON public.lilly_agent_teams TO ${role};
    COMMIT;`);
  }
  const password = fs.readFileSync(`${dir}/database.password`, 'utf8');
  const { Client } = require('/opt/kimibuilt/node_modules/pg');
  const client = new Client({ host: '10.43.84.112', port: 5432, database: 'kimibuilt', user: role, password,
    ssl: { ca: fs.readFileSync(`${dir}/database-ca.crt`), servername: 'postgres.kimibuilt.svc.cluster.local', rejectUnauthorized: true }, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    assert.equal(tls.rows[0].ssl, true);
    await client.query('SELECT id, owner_id, state, updated_at FROM public.lilly_agent_teams LIMIT 0');
    await client.query('UPDATE public.lilly_agent_teams SET state=state, updated_at=updated_at WHERE false');
    for (const statement of ['DELETE FROM public.lilly_agent_teams WHERE false',
      "INSERT INTO public.lilly_agent_teams SELECT 'denied', 'denied', '{}'::jsonb, NOW() WHERE false",
      'CREATE TABLE public.lilly_node_denied_probe (id text)']) {
      await client.query('BEGIN');
      try { await assert.rejects(client.query(statement), error => error.code === '42501'); }
      finally { await client.query('ROLLBACK'); }
    }
    console.log(JSON.stringify({ tlsVerified: true, schemaReadable: true, stateUpdateAllowed: true,
      insertDenied: true, deleteDenied: true, ddlDenied: true, agentsStarted: 0 }));
  } finally { await client.end(); }
}
main().catch(error => { console.error('Node database verification failed:', /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : error.name); process.exitCode = 1; });
