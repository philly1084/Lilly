'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { Pool } = require('pg');
const { TeamStore } = require('../agent-teams/store');
const { TeamService } = require('../agent-teams/service');
const { createInClusterApi } = require('../grok-build/kubernetes-supervisor');
const { createNodeComputerOperations } = require('./recovery-runtime');
const { createNodeRpcServer } = require('./node-rpc-server');
const { readPrivateFile, privateIPv4 } = require('./node-service-config');
const { createNodeOwnerBinder } = require('../agent-teams/node-owner-adapter');
const fail = () => Object.assign(new Error('Private node service is unavailable.'), { code: 'lilly_node_service_unavailable' });

async function checkHost(nodeName, listenHost) {
  if (Number(process.versions.node.split('.')[0]) < 24
    || process.platform !== 'linux' || process.getuid?.() !== 0 || os.hostname() !== nodeName || !privateIPv4(listenHost)
    || !Object.values(os.networkInterfaces()).flat().some(value => value?.address === listenHost)
    || ['OPENAI_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'LILLY_MODEL_API_KEY', 'KUBECONFIG'].some(key => process.env[key])) throw fail();
  const [ownPid, hostPid, ownMount, hostMount, group] = await Promise.all([
    fs.readlink('/proc/self/ns/pid'), fs.readlink('/proc/1/ns/pid'), fs.readlink('/proc/self/ns/mnt'), fs.readlink('/proc/1/ns/mnt'),
    fs.statfs('/sys/fs/cgroup', { bigint: true }),
  ]);
  if (ownPid !== hostPid || ownMount !== hostMount || group.type !== 0x63677270n) throw fail();
}

const ROLE_CHECK = `SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
  has_table_privilege(current_user, 'public.lilly_agent_teams', 'SELECT') AS can_select,
  has_column_privilege(current_user, 'public.lilly_agent_teams', 'state', 'UPDATE') AS can_update_state,
  has_column_privilege(current_user, 'public.lilly_agent_teams', 'updated_at', 'UPDATE') AS can_update_time,
  has_table_privilege(current_user, 'public.lilly_agent_teams', 'INSERT') AS can_insert,
  has_table_privilege(current_user, 'public.lilly_agent_teams', 'DELETE') AS can_delete,
  has_schema_privilege(current_user, 'public', 'CREATE') AS can_create
  FROM pg_roles WHERE rolname = current_user`;

// Inactive until invoked by the dedicated native CLI. Check mode opens only
// its explicitly configured database; no scheduler, worker or listener starts.
async function startNodeService({ config, checkOnly = false, hostCheck = checkHost,
  poolFactory = options => new Pool(options), clusterFactory = createInClusterApi,
  operationsFactory = createNodeComputerOperations, serverFactory = createNodeRpcServer,
  ownerBinderFactory = createNodeOwnerBinder,
  read = readPrivateFile, onEvent = () => {}, shutdownMs = 65000 } = {}) {
  let pool; let server; let shutdown;
  if (!Number.isSafeInteger(shutdownMs) || shutdownMs < 1 || shutdownMs > 65000) throw fail();
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), shutdownMs); })]); }
    finally { clearTimeout(timer); }
  };
  const stop = () => {
    if (!shutdown) shutdown = (async () => {
      // Never close the database while node operations are still draining. If
      // this deadline fails, the native supervisor must terminate the process;
      // all durable leases remain unresolved for later reconciliation.
      if (server) await bounded(server.shutdown());
      if (pool) await bounded(pool.end());
    })();
    return shutdown;
  };
  try {
    await hostCheck(config.nodeName, config.listen.host);
    pool = poolFactory(config.database); pool.on('error', () => onEvent('database_unavailable'));
    const role = (await pool.query(ROLE_CHECK)).rows?.[0];
    if (role?.role !== config.database.user
      || !['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'can_insert', 'can_delete', 'can_create'].every(key => role[key] === false)
      || !['can_select', 'can_update_state', 'can_update_time'].every(key => role[key] === true)) throw fail();
    const store = new TeamStore({ database: { query: (...args) => pool.query(...args), getPool: () => pool }, schemaMode: 'existing' });
    await store.initialize();
    const service = new TeamService({ store });
    const cluster = clusterFactory({ ...config.kubernetes, readFile: async (target, encoding) => {
      const value = read(target); return encoding === 'utf8' ? value.toString() : value;
    } });
    const operations = { ...operationsFactory({ service, cluster,
      configuration: { namespace: 'lilly-team-workers', image: config.recovery.image }, storageRoot: config.recovery.storageRoot }),
      ...(config.backendPodNames?.length ? { bindExecutionOwner: ownerBinderFactory({ nodeName: config.nodeName,
        podNames: config.backendPodNames, cluster }) } : {}) };
    server = serverFactory({ service, operations, nodeName: config.nodeName, tls: config.tls, clientFingerprints: config.clientFingerprints });
    if (checkOnly) { await stop(); return { checked: true }; }
    await new Promise((resolve, reject) => {
      const failed = () => reject(fail()); server.once('error', failed);
      server.listen(config.listen.port, config.listen.host, () => { server.removeListener('error', failed); resolve(); });
    });
    server.on('error', () => onEvent('listener_unavailable'));
    return { stop };
  } catch { await stop().catch(() => {}); throw fail(); }
}

module.exports = { startNodeService, checkHost, ROLE_CHECK };
