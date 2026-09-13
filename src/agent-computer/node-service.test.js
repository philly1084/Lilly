'use strict';

const { EventEmitter } = require('node:events');
const { loadNodeServiceConfig } = require('./node-service-config');
const { startNodeService, ROLE_CHECK } = require('./node-service');
const { main } = require('../../bin/lilly-node-service');

function fixture() {
  const document = { version: 1, nodeName: 'fixture-node', listen: { host: '127.0.0.1', port: 9443 },
    tlsFiles: { key: '/fixture/server.key', cert: '/fixture/server.crt', ca: '/fixture/ca.crt' }, clientFingerprints: ['a'.repeat(64)],
    database: { host: '/fixture/postgres', port: 5432, database: 'lilly', user: 'lilly_node_observer', passwordFile: '/fixture/password', caFile: null },
    kubernetes: { server: 'https://127.0.0.1:6443/', tokenPath: '/fixture/token', caPath: '/fixture/kube-ca.crt' },
    recovery: { image: `registry.example/recovery@sha256:${'b'.repeat(64)}`, storageRoot: '/fixture/storage' } };
  const files = { '/fixture/token': 'first-token' };
  const read = jest.fn(target => target === '/fixture/config.json' ? JSON.stringify(document) : files[target] || Buffer.from('DISPOSABLE TEST ONLY'));
  const config = loadNodeServiceConfig('/fixture/config.json', { read });
  const role = { role: document.database.user, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    can_insert: false, can_delete: false, can_create: false, can_select: true, can_update_state: true, can_update_time: true };
  const pool = { query: jest.fn(async sql => ({ rows: sql === ROLE_CHECK ? [{ ...role }] : [] })), on: jest.fn(), end: jest.fn(async () => {}) };
  const server = new EventEmitter(); server.listen = jest.fn((_port, _host, ready) => ready()); server.shutdown = jest.fn(async () => {});
  const options = { config, read, hostCheck: jest.fn(async () => {}), poolFactory: jest.fn(() => pool), clusterFactory: jest.fn(() => ({ request() {}, exec() {} })),
    operationsFactory: jest.fn(() => ({})), serverFactory: jest.fn(() => server) };
  return { document, files, read, config, role, pool, server, options };
}

test('config loads bounded host-only credentials and fixed limited database settings', () => {
  const f = fixture(); expect(f.config.database).toMatchObject({ ssl: false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    query_timeout: 15000, options: '-c search_path=public -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000' });
  expect(f.config.kubernetes.allowProfileVolumeRead).toBe(true);
  f.document.database.host = 'postgres.private'; f.document.database.caFile = '/fixture/db-ca.crt';
  expect(loadNodeServiceConfig('/fixture/config.json', { read: f.read }).database.ssl).toMatchObject({ rejectUnauthorized: true });
});

test.each([
  ['10.43.84.112', 'IP Address:10.43.84.112', 'IP Address:10.43.84.113'],
  ['postgres.private', 'DNS:postgres.private', 'DNS:other.private'],
])('database TLS verifies configured host %s even when the driver supplies localhost', (host, valid, invalid) => {
  const f = fixture();
  f.document.database.host = host;
  f.document.database.caFile = '/fixture/db-ca.crt';
  const { ssl } = loadNodeServiceConfig('/fixture/config.json', { read: f.read }).database;
  expect(ssl.rejectUnauthorized).toBe(true);
  expect(ssl.checkServerIdentity('localhost', { subjectaltname: valid })).toBeUndefined();
  expect(ssl.checkServerIdentity('localhost', { subjectaltname: invalid }).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  expect(ssl.checkServerIdentity('localhost', { subjectaltname: 'DNS:localhost' }).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
});

test('native startup composes owner binding only for an explicit bounded Pod allowlist', async () => {
  const f = fixture();
  expect(f.config.backendPodNames).toEqual([]);
  f.document.backendPodNames = ['backend-a'];
  f.options.config = loadNodeServiceConfig('/fixture/config.json', { read: f.read });
  const binder = jest.fn(); f.options.ownerBinderFactory = jest.fn(() => binder);
  await startNodeService({ ...f.options, checkOnly: true });
  expect(f.options.ownerBinderFactory).toHaveBeenCalledWith({ nodeName: 'fixture-node', podNames: ['backend-a'], cluster: expect.any(Object) });
  expect(f.options.clusterFactory).toHaveBeenCalledWith(expect.objectContaining({ backendPodNames: ['backend-a'] }));
  expect(f.options.serverFactory).toHaveBeenCalledWith(expect.objectContaining({ operations: expect.objectContaining({ bindExecutionOwner: binder }) }));
  expect(binder).not.toHaveBeenCalled(); expect(f.server.listen).not.toHaveBeenCalled();
  f.document.backendPodNames = ['*'];
  expect(() => loadNodeServiceConfig('/fixture/config.json', { read: f.read })).toThrow();
});

test.each(['wildcard', 'public_ip', 'low_port', 'inline_password', 'privileged_user', 'tcp_without_ca', 'relative_file', 'mutable_image', 'http_cluster', 'extra', 'oversized'])
  ('rejects %s host configuration', mode => {
    const f = fixture();
    if (mode === 'wildcard') f.document.listen.host = '0.0.0.0';
    if (mode === 'public_ip') f.document.listen.host = '8.8.8.8';
    if (mode === 'low_port') f.document.listen.port = 443;
    if (mode === 'inline_password') f.document.database.password = 'not allowed';
    if (mode === 'privileged_user') f.document.database.user = 'postgres';
    if (mode === 'tcp_without_ca') f.document.database.host = 'postgres.private';
    if (mode === 'relative_file') f.document.kubernetes.tokenPath = 'token';
    if (mode === 'mutable_image') f.document.recovery.image = 'recovery:latest';
    if (mode === 'http_cluster') f.document.kubernetes.server = 'http://127.0.0.1:6443';
    if (mode === 'extra') f.document.publicRoute = true;
    if (mode === 'oversized') f.read.mockReturnValue('x'.repeat(65537));
    expect(() => loadNodeServiceConfig('/fixture/config.json', { read: f.read })).toThrow('Private node service configuration is unavailable.');
  });

test('read-only preflight validates existing schema and credentials without listening or workers', async () => {
  const f = fixture(); expect(await startNodeService({ ...f.options, checkOnly: true })).toEqual({ checked: true });
  expect(f.options.hostCheck).toHaveBeenCalledWith('fixture-node', '127.0.0.1');
  expect(f.pool.query.mock.calls.map(([sql]) => sql)).toEqual([ROLE_CHECK, 'SELECT id, owner_id, state, updated_at FROM lilly_agent_teams LIMIT 0']);
  expect(f.server.listen).not.toHaveBeenCalled(); expect(f.server.shutdown).toHaveBeenCalledTimes(1); expect(f.pool.end).toHaveBeenCalledTimes(1);
  expect(f.options.operationsFactory.mock.calls[0][0]).toMatchObject({ configuration: { namespace: 'lilly-team-workers', image: f.document.recovery.image } });
  const clusterOptions = f.options.clusterFactory.mock.calls[0][0];
  expect(await clusterOptions.readFile('/fixture/token', 'utf8')).toBe('first-token');
  f.files['/fixture/token'] = 'rotated-token'; expect(await clusterOptions.readFile('/fixture/token', 'utf8')).toBe('rotated-token');
});

test.each(['host', 'schema', 'superuser', 'create_schema', 'insert', 'missing_update', 'listener'])('failed %s startup cleans acquired resources without unsafe fallback', async mode => {
  const f = fixture();
  if (mode === 'host') f.options.hostCheck.mockRejectedValue(new Error('PRIVATE HOST DATA'));
  if (mode === 'schema') f.pool.query.mockImplementation(async sql => { if (sql !== ROLE_CHECK) throw new Error('PRIVATE DATABASE'); return { rows: [f.role] }; });
  if (mode === 'superuser') f.role.rolsuper = true;
  if (mode === 'create_schema') f.role.can_create = true;
  if (mode === 'insert') f.role.can_insert = true;
  if (mode === 'missing_update') f.role.can_update_state = false;
  if (mode === 'listener') f.server.listen.mockImplementation(() => f.server.emit('error', new Error('PRIVATE SOCKET DATA')));
  await expect(startNodeService(f.options)).rejects.toMatchObject({ code: 'lilly_node_service_unavailable', message: 'Private node service is unavailable.' });
  if (mode === 'host') expect(f.options.poolFactory).not.toHaveBeenCalled();
  else expect(f.pool.end).toHaveBeenCalledTimes(1);
  if (mode !== 'listener') expect(f.options.operationsFactory).not.toHaveBeenCalled();
});

test('shutdown is idempotent and drains actual RPC work before ending SQL connections', async () => {
  const f = fixture(); let release; f.server.shutdown.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const running = await startNodeService(f.options); expect(f.server.listen).toHaveBeenCalledWith(9443, '127.0.0.1', expect.any(Function));
  const stopped = running.stop(); expect(running.stop()).toBe(stopped); expect(f.pool.end).not.toHaveBeenCalled();
  release(); await stopped; expect(f.pool.end).toHaveBeenCalledTimes(1);
});

test('unconfirmed drain does not prematurely close the database or declare shutdown success', async () => {
  const f = fixture(); f.server.shutdown.mockImplementation(() => new Promise(() => {}));
  const running = await startNodeService({ ...f.options, shutdownMs: 5 });
  await expect(running.stop()).rejects.toMatchObject({ code: 'lilly_node_service_unavailable' });
  expect(f.pool.end).not.toHaveBeenCalled();
});

test('CLI refuses unrelated arguments before loading credentials', async () => {
  await expect(main([])).rejects.toThrow('Invalid private node service invocation.');
  await expect(main(['--config', '/fixture/config.json', '--run-shell'])).rejects.toThrow('Invalid private node service invocation.');
});
