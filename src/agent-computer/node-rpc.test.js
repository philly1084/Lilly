'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { randomUUID, X509Certificate } = require('node:crypto');
const { createNodeRpcServer } = require('./node-rpc-server');
const { createNodeRpcClient } = require('./node-rpc-client');
const { createNodeOwnerBinder } = require('../agent-teams/node-owner-adapter');
const { ownerFixture } = require('../agent-teams/node-owner-test-fixture');
const { createExecutionOwnerResolver } = require('../agent-teams/execution-owner');
const { TeamRunner } = require('../agent-teams/runner');
const { createBrowserStopEvidence } = require('./stop-evidence');
const { syntheticProfileRecovery } = require('./profile-recovery-fixture');
const contract = require('./node-rpc-contract');
const copy = value => JSON.parse(JSON.stringify(value));
const servers = []; let directory; let certificates;

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lilly-node-rpc-test-'));
  const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : '/usr/bin/openssl';
  const run = args => execFileSync(openssl, args, { cwd: directory, stdio: 'pipe', timeout: 10000, windowsHide: true });
  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '1', '-subj', '/CN=Lilly disposable RPC test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  for (const name of ['server', 'client', 'other']) {
    run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`,
      '-subj', `/CN=Lilly disposable ${name}`, '-addext', `extendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}`,
      ...(name === 'server' ? ['-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'] : [])]);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-copy_extensions', 'copyall']);
  }
  const ca = fs.readFileSync(path.join(directory, 'ca.crt'));
  certificates = Object.fromEntries(['server', 'client', 'other'].map(name => {
    const cert = fs.readFileSync(path.join(directory, `${name}.crt`));
    return [name, { cert, key: fs.readFileSync(path.join(directory, `${name}.key`)), ca, fingerprint: new X509Certificate(cert).fingerprint256 }];
  }));
}, 30000);
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
});
afterAll(() => {
  // Only this test's generated one-day keys/certificates; no user TLS material.
  if (!directory || path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('lilly-node-rpc-test-')) throw new Error('Invalid fixture cleanup target');
  for (const name of ['ca.key', 'ca.crt', 'ca.srl', ...['server', 'client', 'other'].flatMap(value => [`${value}.key`, `${value}.csr`, `${value}.crt`])]) {
    const target = path.join(directory, name); if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
});

async function fixture(overrides = {}) {
  const identity = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: randomUUID() } };
  const lease = { namespace: 'lilly-team-workers', podName: `browser-${'a'.repeat(32)}`, leaseId: randomUUID(), claimId: identity.claim.claimId,
    ownerBootId: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), containerId: `containerd://${'b'.repeat(64)}`, phase: 'provisioning',
    profileKey: 'e'.repeat(64), pvcName: `browser-profile-${'a'.repeat(32)}` };
  const fields = Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, lease[key]]));
  const binding = { version: 1, ...fields, nodeName: 'fixture-node', hostBootId: randomUUID(), initPid: 111, initStartTicks: '112', pidNamespace: '113', mountNamespace: '114',
    cgroup: { path: `/kubepods/pod${lease.podUid}/${lease.containerId.slice(13)}`, device: '0', inode: '115' }, observedAt: '2026-09-07T01:00:00.000Z' };
  const team = { id: identity.teamId, ownerId: identity.ownerId, tasks: [{ id: identity.taskId, agentId: identity.agentId,
    worker: { id: identity.claim.workerId, claimId: identity.claim.claimId, executionOwner: { bootId: lease.ownerBootId } }, computerLease: lease }] };
  const service = { get: jest.fn(async () => copy(team)) };
  const operations = {
    bindContainer: jest.fn(async () => copy(binding)), requestStop: jest.fn(async () => ({ requested: true })),
    captureStop: jest.fn(async () => {
      lease.stopEvidence = createBrowserStopEvidence(lease, { ...fields, podStopped: true, source: 'cri-exited-and-cgroup-v2-empty', observedAt: '2026-09-07T02:00:00.000Z' });
      return copy(lease.stopEvidence);
    }),
    observeTermination: jest.fn(async () => {
      lease.profileRecovery = syntheticProfileRecovery(lease);
      return { ...fields, podStopped: true, profileReleased: true, stopEvidence: copy(lease.stopEvidence), profileRecovery: copy(lease.profileRecovery) };
    }),
  };
  const server = createNodeRpcServer({ service, operations, nodeName: 'fixture-node', tls: certificates.server,
    clientFingerprints: [certificates.client.fingerprint], ...overrides });
  expect(service.get).not.toHaveBeenCalled(); expect(server.listening).toBe(false);
  servers.push(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `https://127.0.0.1:${server.address().port}/`;
  const clientOptions = { nodes: [{ name: 'fixture-node', url, fingerprint: certificates.server.fingerprint }], tls: certificates.client, timeoutMs: 3000 };
  const client = createNodeRpcClient(clientOptions);
  const input = () => ({ identity: copy(identity), lease: copy(lease), nodeName: 'fixture-node' });
  const envelope = method => ({ version: 1, id: randomUUID(), method, identity: copy(identity), leaseId: lease.leaseId, nodeName: 'fixture-node' });
  const closing = () => { lease.nodeBinding = copy(binding); lease.phase = 'closing'; };
  return { identity, lease, binding, team, service, operations, server, url, client, clientOptions, input, envelope, closing };
}

function raw(url, value, options = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const req = https.request(new URL(contract.PATH, url), { ...certificates.client, agent: false, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, ...options }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('Fixture request timeout'))); req.end(body);
  });
}

test('real mTLS carries pre-claim owner binding through the scoped node adapter without database access', async () => {
  const data = ownerFixture();
  const operations = Object.fromEntries(contract.METHODS.map(key => [key, jest.fn()]));
  operations.bindExecutionOwner = createNodeOwnerBinder({ nodeName: 'fixture-node', podNames: ['backend-a'], ...data });
  const f = await fixture({ operations });
  const result = await f.client.bindExecutionOwner({ nodeName: 'fixture-node', owner: data.owner });
  expect(result).toMatchObject({ version: 2, hostPid: 510, cgroup: data.group.identity });
  expect(data.cluster.request).toHaveBeenCalledTimes(2);
  expect(f.service.get).not.toHaveBeenCalled();
  for (const key of contract.METHODS) expect(operations[key]).not.toHaveBeenCalled();
  const resolveExecutionOwner = createExecutionOwnerResolver({ platform: 'linux', pid: 7, bootId: data.owner.bootId,
    now: () => data.owner.startedAt,
    environment: { LILLY_TEAMS_BROKER_POD_NAMESPACE: 'kimibuilt', LILLY_TEAMS_BROKER_POD_NAME: 'backend-a', LILLY_TEAMS_BROKER_POD_UID: data.owner.pod.uid },
    readFile: async file => file.endsWith('/stat') ? `7 (node) ${['S', ...Array(18).fill('0'), '400'].join(' ')}` : data.owner.kernel.bootId,
    readlink: async file => file.endsWith('/pid') ? 'pid:[1001]' : 'mnt:[1002]',
    bindContainer: owner => f.client.bindExecutionOwner({ nodeName: 'fixture-node', owner }),
  });
  const runner = new TeamRunner({ service: f.service, execute: jest.fn(), resolveExecutionOwner });
  const bound = await runner.prepareOwner();
  expect(bound).toMatchObject({ version: 2, containerBinding: { version: 2, hostPid: 510, cgroup: data.group.identity } });
  expect(await runner.prepareOwner()).toBe(bound);
  expect(Object.isFrozen(bound.containerBinding.cgroup)).toBe(true);
  expect(f.service.get).not.toHaveBeenCalled();
  const envelope = { version: 1, id: randomUUID(), method: contract.OWNER_METHOD, owner: data.owner, nodeName: 'fixture-node' };
  expect((await raw(f.url, envelope)).status).toBe(200);
  expect((await raw(f.url, envelope)).status).toBe(409);
  expect((await raw(f.url, { ...envelope, id: randomUUID(), leaseId: randomUUID() })).status).toBe(503);
});

test('owner binding is unavailable by default and unknown peer certificates cannot call it', async () => {
  const data = ownerFixture(); const f = await fixture();
  await expect(f.client.bindExecutionOwner({ nodeName: 'fixture-node', owner: data.owner })).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
  expect(f.service.get).not.toHaveBeenCalled();
  const envelope = { version: 1, id: randomUUID(), method: contract.OWNER_METHOD, owner: data.owner, nodeName: 'fixture-node' };
  expect((await raw(f.url, envelope, certificates.other)).status).toBe(403);
});

test('real mutual TLS carries all four scoped operations, never caller container fields', async () => {
  const f = await fixture();
  expect(await f.client.bindContainer(f.input())).toEqual(f.binding);
  f.closing(); const forged = f.input(); forged.lease.containerId = `containerd://${'f'.repeat(64)}`;
  expect(await f.client.requestStop(forged)).toEqual({ requested: true });
  expect(f.operations.requestStop.mock.calls[0][0].lease.containerId).toBe(f.lease.containerId);
  const stop = await f.client.captureStop(f.input()); expect(stop).toEqual(f.lease.stopEvidence);
  const result = await f.client.observeTermination(f.input()); expect(result.profileRecovery).toEqual(f.lease.profileRecovery);
  expect(result).not.toHaveProperty('nodeBinding'); expect(result).not.toHaveProperty('pixels');
  expect(f.service.get).toHaveBeenCalledTimes(8);
});

test.each(['no_certificate', 'unapproved_certificate', 'server_pin', 'wrong_ca'])('rejects %s before node operations', async mode => {
  const f = await fixture(); const options = copy({ nodes: f.clientOptions.nodes }); options.tls = certificates.client;
  if (mode === 'no_certificate') await expect(raw(f.url, f.envelope('bindContainer'), { key: undefined, cert: undefined })).rejects.toBeDefined();
  if (mode === 'unapproved_certificate') {
    const response = await raw(f.url, f.envelope('bindContainer'), certificates.other); expect(response.status).toBe(403);
  }
  if (mode === 'server_pin') { options.nodes[0].fingerprint = 'f'.repeat(64); await expect(createNodeRpcClient(options).bindContainer(f.input())).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' }); }
  if (mode === 'wrong_ca') {
    options.tls = { ...certificates.client, ca: certificates.other.cert };
    await expect(createNodeRpcClient(options).bindContainer(f.input())).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
  }
  expect(f.service.get).not.toHaveBeenCalled(); expect(f.operations.bindContainer).not.toHaveBeenCalled();
});

test.each(['owner', 'claim', 'worker', 'boot', 'lease', 'node', 'phase'])('rejects changed %s authority before dispatch', async mode => {
  const f = await fixture(); const body = f.envelope('bindContainer');
  if (mode === 'owner') body.identity.ownerId = 'foreign';
  if (mode === 'claim') body.identity.claim.claimId = randomUUID();
  if (mode === 'worker') f.team.tasks[0].worker.id = 'foreign';
  if (mode === 'boot') f.team.tasks[0].worker.executionOwner.bootId = randomUUID();
  if (mode === 'lease') body.leaseId = randomUUID();
  if (mode === 'node') body.nodeName = 'foreign-node';
  if (mode === 'phase') f.lease.phase = 'closed';
  const response = await raw(f.url, body); expect(response.status).toBe(503); expect(response.text).toBe('{"error":"node_operation_unconfirmed"}');
  expect(f.operations.bindContainer).not.toHaveBeenCalled();
});

test.each(['unknown_method', 'extra_fields', 'oversized', 'invalid_json', 'origin'])('rejects %s request without database/host access', async mode => {
  const f = await fixture(); let body = f.envelope('bindContainer'); let options = {};
  if (mode === 'unknown_method') body.method = 'exec';
  if (mode === 'extra_fields') body.command = 'whoami';
  if (mode === 'oversized') body = 'x'.repeat(8193);
  if (mode === 'invalid_json') body = '{';
  if (mode === 'origin') options.headers = { 'content-type': 'application/json', origin: 'https://public.example' };
  const response = await raw(f.url, body, options); expect(response.status).not.toBe(200);
  expect(f.service.get).not.toHaveBeenCalled();
});

test('duplicate request ID is rejected without replaying operations', async () => {
  const f = await fixture(); const body = f.envelope('bindContainer');
  expect((await raw(f.url, body)).status).toBe(200); expect((await raw(f.url, body)).status).toBe(409);
  expect(f.operations.bindContainer).toHaveBeenCalledTimes(1);
});

test('unknown operation failure returns no internal output and client does not retry', async () => {
  const f = await fixture(); f.operations.bindContainer.mockRejectedValue(new Error('PRIVATE KEY / HOST PATH / STDERR'));
  await expect(f.client.bindContainer(f.input())).rejects.toThrow('Private node operation is unconfirmed.');
  expect(f.operations.bindContainer).toHaveBeenCalledTimes(1);
});

test('returned stop proof must exist in the authoritative store', async () => {
  const f = await fixture(); f.closing(); const save = f.operations.captureStop.getMockImplementation();
  f.operations.captureStop.mockImplementation(async () => { const value = await save(); delete f.lease.stopEvidence; return value; });
  await expect(f.client.captureStop(f.input())).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
});

test('ownership revoked during node work rejects its late result', async () => {
  const f = await fixture(); f.operations.bindContainer.mockImplementation(async () => {
    f.team.tasks[0].worker.claimId = randomUUID(); return copy(f.binding);
  });
  await expect(f.client.bindContainer(f.input())).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
});

test('helper must be closed before profile release can cross RPC', async () => {
  const f = await fixture(); f.closing(); await f.client.captureStop(f.input());
  const recover = f.operations.observeTermination.getMockImplementation();
  f.operations.observeTermination.mockImplementation(async () => { const value = await recover(); f.lease.recoveryHelper = { phase: 'ready' }; return value; });
  await expect(f.client.observeTermination(f.input())).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
});

test.each(['request_id', 'lease_id', 'node', 'binding_node', 'extra_fields', 'oversized', 'redirect'])('client rejects %s response without following or retrying', async mode => {
  const f = await fixture(); let requests = 0;
  const hostile = https.createServer({ ...certificates.server, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    requests += 1; const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const response = { version: 1, id: request.id, leaseId: request.leaseId, nodeName: request.nodeName, result: copy(f.binding) };
      if (mode === 'request_id') response.id = randomUUID();
      if (mode === 'lease_id') response.leaseId = randomUUID();
      if (mode === 'node') response.nodeName = 'foreign-node';
      if (mode === 'binding_node') response.result.nodeName = 'foreign-node';
      if (mode === 'extra_fields') response.pixels = 'PRIVATE';
      if (mode === 'oversized') response.private = 'PRIVATE'.repeat(3000);
      res.writeHead(mode === 'redirect' ? 307 : 200, { 'content-type': 'application/json', location: f.url });
      res.end(JSON.stringify(response));
    });
  });
  servers.push(hostile); await new Promise(resolve => hostile.listen(0, '127.0.0.1', resolve));
  const client = createNodeRpcClient({ ...f.clientOptions,
    nodes: [{ ...f.clientOptions.nodes[0], url: `https://127.0.0.1:${hostile.address().port}/` }] });
  await expect(client.bindContainer(f.input())).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
  expect(requests).toBe(1); expect(f.operations.bindContainer).not.toHaveBeenCalled();
});

test('deadline cancels underlying work but retains admission until it actually settles', async () => {
  const f = await fixture({ timeoutMs: 60, maxConcurrent: 1 }); let finish; let signal;
  f.operations.bindContainer.mockImplementation(input => { signal = input.signal; return new Promise(resolve => { finish = () => resolve(copy(f.binding)); }); });
  await expect(f.client.bindContainer(f.input())).rejects.toBeDefined(); expect(signal.aborted).toBe(true);
  expect((await raw(f.url, f.envelope('bindContainer'))).status).toBe(429);
  expect(f.operations.bindContainer).toHaveBeenCalledTimes(1);
  finish(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  f.operations.bindContainer.mockResolvedValue(copy(f.binding));
  expect(await f.client.bindContainer(f.input())).toEqual(f.binding);
});

test('client abort reaches the running operation without any retry', async () => {
  const f = await fixture(); const abort = new AbortController(); let finish; let observed; let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.operations.bindContainer.mockImplementation(input => { observed = input.signal; started(); return new Promise(resolve => { finish = () => resolve(copy(f.binding)); }); });
  const pending = f.client.bindContainer({ ...f.input(), signal: abort.signal }); await ready; abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'computer_node_rpc_unknown' });
  for (let i = 0; i < 30 && !observed.aborted; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  expect(observed.aborted).toBe(true); finish(); expect(f.operations.bindContainer).toHaveBeenCalledTimes(1);
});

test('server shutdown drains actual operation completion, not just closed sockets', async () => {
  const f = await fixture(); let finish; let signal; let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.operations.bindContainer.mockImplementation(input => { signal = input.signal; started(); return new Promise(resolve => { finish = () => resolve(copy(f.binding)); }); });
  const request = f.client.bindContainer(f.input()).catch(() => null); await ready;
  const stopped = f.server.shutdown(); expect(f.server.shutdown()).toBe(stopped);
  expect(signal.aborted).toBe(true);
  expect(await Promise.race([stopped.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))])).toBe(false);
  finish(); await stopped; await request; expect(f.server.listening).toBe(false);
});

test.each(['http', 'credentials', 'path', 'duplicate', 'unknown_node'])('client rejects %s routing configuration', async mode => {
  const f = await fixture(); const options = { ...f.clientOptions, nodes: copy(f.clientOptions.nodes) };
  if (mode === 'http') options.nodes[0].url = f.url.replace('https:', 'http:');
  if (mode === 'credentials') options.nodes[0].url = f.url.replace('https://', 'https://user:password@');
  if (mode === 'path') options.nodes[0].url += 'other';
  if (mode === 'duplicate') options.nodes.push(copy(options.nodes[0]));
  if (mode === 'unknown_node') await expect(f.client.bindContainer({ ...f.input(), nodeName: 'unconfigured-node' })).rejects.toBeDefined();
  else expect(() => createNodeRpcClient(options)).toThrow();
  expect(f.service.get).not.toHaveBeenCalled();
});
