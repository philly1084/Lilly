const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { createInClusterApi, createExecChild, createKubernetesWorkerFactory } = require('./kubernetes-supervisor');

const image = `registry.example/lilly-grok@sha256:${'a'.repeat(64)}`;
// Fixture-only identity. Production derives its owning Pod from Downward API.
const config = { namespace: 'lilly-team-workers', image, brokerPodIP: '10.42.1.17', brokerPodUid: '01234567-89ab-4cde-8fab-0123456789ab', brokerPodName: 'backend-replica-a', pollMs: 1, readyTimeoutMs: 30, closeTimeoutMs: 10 };
const makeScope = overrides => ({ ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task', claim: { taskId: 'task', workerId: 'worker', claimId: 'claim' }, model: 'approved-model', modelEndpoint: 'http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001/api/agent-team-workers/abcdefghijklmnop/v1', modelToken: 'task-scoped-token-1234567890', ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
const missing = () => Object.assign(new Error('not found'), { status: 404 });

function setup(configuration = config) {
  const objects = new Map(); let sequence = 0;
  const records = [];
  const service = {
    getEngineSession: jest.fn(async () => ({ sessionId: 'persisted-session' })),
    saveEngineSession: jest.fn(async () => {}),
    recordWorkerLease: jest.fn(async (identity, record) => { records.push({ identity: structuredClone(identity), record: structuredClone(record) }); }),
  };
  const cluster = {
    request: jest.fn(async (method, apiPath, body) => {
      if (method === 'GET') { if (!objects.has(apiPath)) throw missing(); return structuredClone(objects.get(apiPath)); }
      if (method === 'POST') {
        const key = `${apiPath}/${body.metadata.name}`;
        if (objects.has(key)) throw Object.assign(new Error('conflict'), { status: 409 });
        const result = structuredClone(body);
        result.metadata.uid = `uid-${++sequence}`;
        if (body.kind === 'Pod') result.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'worker', ready: true, state: { running: {} }, imageID: `docker-pullable://${image}` }] };
        objects.set(key, result); return structuredClone(result);
      }
      if (method === 'DELETE') {
        if (!objects.has(apiPath)) throw missing();
        expect(body.preconditions.uid).toBe(objects.get(apiPath).metadata.uid);
        objects.delete(apiPath); return { kind: 'Status', status: 'Success' };
      }
      throw new Error('unexpected method');
    }),
    exec: jest.fn(),
  };
  const factory = createKubernetesWorkerFactory({ service, configuration, cluster });
  return { objects, records, service, cluster, factory };
}

describe('Kubernetes worker supervisor lifecycle', () => {
  test('inventories before creates, isolates Pod and Secret, retains stable PVC, and confirms UID deletion', async () => {
    const f = setup();
    const lease = await f.factory(makeScope());
    expect(lease.sessionId).toBe('persisted-session');
    expect(f.cluster.exec).not.toHaveBeenCalled();
    const pod = [...f.objects.values()].find(object => object.kind === 'Pod');
    const secret = [...f.objects.values()].find(object => object.kind === 'Secret');
    const pvc = [...f.objects.values()].find(object => object.kind === 'PersistentVolumeClaim');
    expect(pod.spec).toMatchObject({ automountServiceAccountToken: false, enableServiceLinks: false, restartPolicy: 'Never', securityContext: { runAsUser: 10001, fsGroup: 10001 } });
    for (const container of [...pod.spec.containers, ...pod.spec.initContainers]) {
      expect(container.image).toBe(image);
      expect(container.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    }
    expect(pod.spec.volumes.every(volume => !volume.hostPath && !volume.projected)).toBe(true);
    expect(pod.spec.hostAliases).toEqual([{ ip: config.brokerPodIP, hostnames: ['lilly-worker-broker.kimibuilt.svc.cluster.local'] }]);
    expect(pod.metadata.annotations['lilly.ai/broker-pod-uid']).toBe(config.brokerPodUid);
    expect(pod.spec.dnsPolicy).toBe('None');
    expect(secret.immutable).toBe(true);
    expect(secret.stringData['config.toml']).toContain('api_backend = "responses"');
    expect(secret.stringData['config.toml']).toContain('default = "lilly"');
    expect(secret.stringData['config.toml']).not.toContain(makeScope().modelToken);
    expect(JSON.stringify(f.records)).not.toContain(makeScope().modelToken);
    expect(JSON.stringify(f.records)).not.toContain(makeScope().modelEndpoint);
    expect(f.records[0].identity.claim).toEqual(makeScope().claim);
    for (const [index, call] of f.cluster.request.mock.calls.entries()) {
      if (call[0] === 'POST') expect(f.cluster.request.mock.calls.slice(0, index).some(entry => entry[0] === 'GET' && entry[1] === `${call[1]}/${call[2].metadata.name}`)).toBe(true);
    }
    await lease.saveSession('next-session');
    expect(f.service.saveEngineSession).toHaveBeenCalledWith(expect.objectContaining({ claim: makeScope().claim }), 'next-session');
    await lease.close();
    expect([...f.objects.values()].map(object => object.kind)).toEqual(['PersistentVolumeClaim']);
    expect(f.records.at(-1).record.phase).toBe('closed');
    const next = await f.factory(makeScope({ taskId: 'next-task' }));
    expect([...f.objects.values()].filter(object => object.kind === 'PersistentVolumeClaim')).toHaveLength(1);
    expect([...f.objects.values()].find(object => object.kind === 'PersistentVolumeClaim').metadata.uid).toBe(pvc.metadata.uid);
    await next.close();
  });

  test('rejects mutable image, wrong namespace, external model endpoint and duplicate active agent', async () => {
    const f = setup();
    expect(() => createKubernetesWorkerFactory({ service: f.service, configuration: { ...config, image: 'grok:latest' } })).toThrow('immutable_worker_image_required');
    expect(() => createKubernetesWorkerFactory({ service: f.service, configuration: { ...config, namespace: 'default' } })).toThrow('immutable_worker_image_required');
    for (const brokerPodIP of [undefined, 'not-an-ip', '127.0.0.1', '169.254.169.254', '8.8.8.8']) {
      expect(() => createKubernetesWorkerFactory({ service: f.service, configuration: { ...config, brokerPodIP } })).toThrow('broker_pod_identity_required');
    }
    for (const overrides of [{ brokerClusterIP: '10.43.0.1' }, { brokerPodUid: undefined }, { brokerPodName: '../other' }]) {
      expect(() => createKubernetesWorkerFactory({ service: f.service, configuration: { ...config, ...overrides } })).toThrow('broker_pod_identity_required');
    }
    await expect(f.factory(makeScope({ modelEndpoint: 'http://evil.example/v1' }))).rejects.toThrow('model_endpoint_denied');
    await expect(f.factory(makeScope({ modelEndpoint: 'http://backend.kimibuilt.svc.cluster.local:3000/api/agent-team-workers/abcdefghijklmnop/v1' }))).rejects.toThrow('model_endpoint_denied');
    expect(() => createKubernetesWorkerFactory({ service: f.service, configuration: { ...config, modelOrigin: 'http://backend.kimibuilt.svc.cluster.local:3000' } })).toThrow('model_origin_policy_mismatch');
    const first = await f.factory(makeScope());
    await expect(f.factory(makeScope({ taskId: 'other' }))).rejects.toThrow('agent_already_leased');
    await first.close();
  });

  test('does not mutate mismatched existing PVC', async () => {
    const f = setup();
    const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      if (method === 'GET' && apiPath.includes('/persistentvolumeclaims/')) return { metadata: { uid: 'foreign', annotations: { 'lilly.ai/identity': 'foreign' } }, spec: { storageClassName: 'local-path', accessModes: ['ReadWriteOnce'] } };
      return original(method, apiPath, body, options);
    });
    await expect(f.factory(makeScope())).rejects.toThrow('pvc_identity_conflict');
    expect(f.cluster.request.mock.calls.some(call => call[0] === 'POST' || call[0] === 'DELETE')).toBe(false);
  });

  test('separate backend replicas pin workers to their own process addresses, never a shared Service', async () => {
    const a = setup();
    const b = setup({ ...config, brokerPodIP: '10.42.2.29', brokerPodName: 'backend-replica-b', brokerPodUid: 'bbbbbbbb-89ab-4cde-8fab-0123456789ab' });
    const leases = await Promise.all([a.factory(makeScope()), b.factory(makeScope())]);
    const pods = [a, b].map(f => [...f.objects.values()].find(object => object.kind === 'Pod'));
    expect(pods.map(pod => pod.spec.hostAliases[0].ip)).toEqual(['10.42.1.17', '10.42.2.29']);
    expect(pods.every(pod => pod.spec.hostAliases.length === 1 && pod.spec.dnsPolicy === 'None')).toBe(true);
    expect(pods.map(pod => pod.metadata.annotations['lilly.ai/broker-pod-name'])).toEqual(['backend-replica-a', 'backend-replica-b']);
    await Promise.all(leases.map(lease => lease.close()));
  });

  test('cleans partial provisioning after confirmed create and cancellation', async () => {
    const f = setup(); const controller = new AbortController();
    const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      const result = await original(method, apiPath, body, options);
      if (method === 'POST' && body.kind === 'Secret') controller.abort();
      return result;
    });
    await expect(f.factory(makeScope({ signal: controller.signal }))).rejects.toThrow('cancelled');
    expect([...f.objects.values()].every(object => object.kind === 'PersistentVolumeClaim')).toBe(true);
    expect(f.cluster.exec).not.toHaveBeenCalled();
  });

  test('uncertain POST that committed is recovered by exact nonce/UID cleanup without retry', async () => {
    const f = setup(); const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      const result = await original(method, apiPath, body, options);
      if (method === 'POST' && body.kind === 'Pod') throw new Error('socket closed after possible commit');
      return result;
    });
    await expect(f.factory(makeScope())).rejects.toThrow('provision_failed');
    expect([...f.objects.values()].every(object => object.kind === 'PersistentVolumeClaim')).toBe(true);
    expect(f.cluster.request.mock.calls.filter(call => call[0] === 'POST' && call[2].kind === 'Pod')).toHaveLength(1);
  });

  test('uncertain POST with no current object retains reconciliation instead of claiming no future resource', async () => {
    const f = setup(); const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      if (method === 'POST' && body.kind === 'Pod') throw new Error('timeout with unresolved server outcome');
      return original(method, apiPath, body, options);
    });
    await expect(f.factory(makeScope())).rejects.toThrow('cleanup_unconfirmed');
    expect(f.records.at(-1).record.phase).toBe('reconciliation');
    expect(f.records.at(-1).record.podName).toMatch(/^grok-/);
  });

  test('replacement UID is never deleted and cleanup still removes own other resources', async () => {
    const f = setup(); const lease = await f.factory(makeScope());
    const podEntry = [...f.objects].find(([, object]) => object.kind === 'Pod');
    f.objects.get(podEntry[0]).metadata.uid = 'replacement-uid';
    await expect(lease.close()).rejects.toThrow('cleanup_unconfirmed');
    expect(f.objects.has(podEntry[0])).toBe(true);
    expect([...f.objects.values()].some(object => object.kind === 'Secret')).toBe(false);
    expect(f.records.at(-1).record.phase).toBe('reconciliation');
  });

  test('delete response is not termination proof when Pod still exists', async () => {
    const f = setup(); const lease = await f.factory(makeScope());
    const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      if (method === 'DELETE' && apiPath.includes('/pods/')) return { status: 'Success' };
      return original(method, apiPath, body, options);
    });
    await expect(lease.close()).rejects.toThrow('cleanup_unconfirmed');
    expect(f.records.at(-1).record.phase).toBe('reconciliation');
  });

  test.each(['spec', 'digest', 'missing'])('rejects ready Pod with unverified %s image before exec', async mode => {
    const f = setup(); const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      const result = await original(method, apiPath, body, options);
      if (method === 'GET' && result.kind === 'Pod') {
        if (mode === 'spec') result.spec.containers[0].image = 'untrusted:latest';
        if (mode === 'digest') result.status.containerStatuses[0].imageID = `containerd://registry/other@sha256:${'b'.repeat(64)}`;
        if (mode === 'missing') delete result.status.containerStatuses;
      }
      return result;
    });
    await expect(f.factory(makeScope())).rejects.toThrow('worker_image_unverified');
    expect(f.cluster.exec).not.toHaveBeenCalled();
    expect([...f.objects.values()].map(object => object.kind)).toEqual(['PersistentVolumeClaim']);
  });

  test('initial intent persistence failure creates no Kubernetes resources', async () => {
    const f = setup();
    f.service.recordWorkerLease.mockRejectedValue(new Error('private persistence failure'));
    await expect(f.factory(makeScope())).rejects.toThrow('cleanup_unconfirmed');
    expect(f.cluster.request).not.toHaveBeenCalled();
    expect(f.cluster.exec).not.toHaveBeenCalled();
  });

  test('persistence outage during close does not prevent exact UID cleanup', async () => {
    const f = setup(); const lease = await f.factory(makeScope());
    f.service.recordWorkerLease.mockRejectedValue(new Error('private persistence failure'));
    await expect(lease.close()).rejects.toThrow('cleanup_unconfirmed');
    expect([...f.objects.values()].map(object => object.kind)).toEqual(['PersistentVolumeClaim']);
  });

  test('Secret deletion failure does not prevent reaping the Pod', async () => {
    const f = setup(); const lease = await f.factory(makeScope());
    const original = f.cluster.request.getMockImplementation();
    f.cluster.request.mockImplementation(async (method, apiPath, body, options) => {
      if (method === 'DELETE' && apiPath.includes('/secrets/')) throw Object.assign(new Error('denied'), { status: 403 });
      return original(method, apiPath, body, options);
    });
    await expect(lease.close()).rejects.toThrow('cleanup_unconfirmed');
    expect([...f.objects.values()].some(object => object.kind === 'Pod')).toBe(false);
    expect(f.records.at(-1).record.phase).toBe('reconciliation');
  });

  test('abort after readiness closes exact resources and prevents session save', async () => {
    const f = setup(); const controller = new AbortController();
    const lease = await f.factory(makeScope({ signal: controller.signal }));
    controller.abort(); await lease.close();
    await expect(lease.saveSession('forbidden')).rejects.toThrow('cancelled');
    expect(f.service.saveEngineSession).not.toHaveBeenCalled();
    expect([...f.objects.values()].map(object => object.kind)).toEqual(['PersistentVolumeClaim']);
  });

  test('ACP initialize runs only via verified Pod exec and is not started during provisioning', async () => {
    const f = setup(); const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = jest.fn(() => { child.emit('exit', null, 'terminated'); return true; });
    const requests = [];
    child.stdin = new Writable({ write(bytes, _encoding, callback) {
      const message = JSON.parse(bytes.toString()); requests.push(message);
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`));
      callback();
    } });
    f.cluster.exec.mockReturnValue(child);
    const lease = await f.factory(makeScope());
    expect(f.cluster.exec).not.toHaveBeenCalled();
    expect(await lease.client.start()).toMatchObject({ protocolVersion: 1 });
    expect(requests.map(request => request.method)).toEqual(['initialize']);
    expect(f.cluster.exec).toHaveBeenCalledWith(expect.objectContaining({ command: ['/opt/grok/bin/xai-grok-pager', '--no-auto-update', 'agent', 'stdio'], container: 'worker' }));
    await lease.close();
  });

  test('image replacement after readiness fails before opening exec', async () => {
    const f = setup(); const lease = await f.factory(makeScope());
    const pod = [...f.objects.values()].find(object => object.kind === 'Pod');
    pod.spec.containers[0].image = 'attacker:latest';
    await expect(lease.client.start()).rejects.toThrow('process_exit');
    expect(f.cluster.exec).not.toHaveBeenCalled();
    await lease.close();
  });
});

describe('Kubernetes v4 exec transport', () => {
  function socket() {
    const ws = new EventEmitter(); ws.protocol = 'v4.channel.k8s.io'; ws.readyState = 1; ws.bufferedAmount = 0;
    ws.send = jest.fn((_bytes, callback) => callback()); ws.terminate = jest.fn(() => { ws.readyState = 3; });
    return ws;
  }
  test('maps stdin/stdout/stderr and structured Status to process-like lifecycle', async () => {
    const ws = socket(); const child = createExecChild({ connect: async () => ws });
    const out = []; const errors = []; const exits = [];
    child.stdout.on('data', bytes => out.push(bytes.toString())); child.stderr.on('data', bytes => errors.push(bytes.toString()));
    child.on('exit', (...args) => exits.push(args)); child.stdin.on('error', () => {});
    await flush();
    child.stdin.write('hello\n'); await flush();
    expect(ws.send.mock.calls[0][0]).toEqual(Buffer.from('\0hello\n'));
    ws.emit('message', Buffer.from('\x01output'), true); ws.emit('message', Buffer.from('\x02diagnostic'), true);
    ws.emit('message', Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '7' }] } }))]), true);
    expect(out).toEqual(['output']); expect(errors).toEqual(['diagnostic']); expect(exits).toEqual([[7, null]]);
  });
  test('disconnect and kill never claim remote success, oversized channels close', async () => {
    for (const mode of ['disconnect', 'kill', 'oversize']) {
      const ws = socket(); const child = createExecChild({ connect: async () => ws, maxBytes: 16 }); const exits = [];
      child.on('exit', (...args) => exits.push(args)); child.stdin.on('error', () => {}); await flush();
      if (mode === 'disconnect') ws.emit('close'); else if (mode === 'kill') child.kill('SIGTERM'); else ws.emit('message', Buffer.alloc(17), true);
      expect(exits[0][0]).toBeNull(); expect(ws.terminate).toHaveBeenCalled();
    }
  });
});

describe('in-cluster HTTPS API and restricted namespace manifest', () => {
  test('backend bootstrap scope admits only named Pod GETs, never list, exec, queries or mutation', async () => {
    const request = jest.fn((_url, _options, receive) => {
      const req = new EventEmitter(); req.destroy = jest.fn();
      req.end = () => queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 200; receive(res); res.end('{"kind":"Pod"}'); });
      return req;
    });
    const readFile = jest.fn(async file => file.endsWith('/token') ? 'fixture-token' : Buffer.from('ca'));
    const pod = '/api/v1/namespaces/kimibuilt/pods/backend-a'; const names = ['backend-a'];
    const api = createInClusterApi({ readFile, request, backendPodNames: names }); names.push('backend-b');
    expect(await api.request('GET', pod)).toEqual({ kind: 'Pod' });
    for (const [method, route] of [['POST', pod], ['DELETE', pod], ['GET', `${pod}/exec`], ['GET', `${pod}?watch=true`],
      ['GET', '/api/v1/namespaces/kimibuilt/pods'], ['GET', '/api/v1/namespaces/kimibuilt/pods/backend-b']]) {
      await expect(api.request(method, route)).rejects.toThrow('api_path_denied');
    }
    await expect(createInClusterApi({ readFile, request }).request('GET', pod)).rejects.toThrow('api_path_denied');
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => createInClusterApi({ backendPodNames: ['*'] })).toThrow('invalid_api_scope');
  });
  test('only trusted node opt-in permits exact GET of a profile PV; default scope stays namespaced', async () => {
    const request = jest.fn((_url, _options, receive) => {
      const req = new EventEmitter(); req.destroy = jest.fn();
      req.end = () => queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 200; receive(res); res.end('{"kind":"PersistentVolume"}'); });
      return req;
    });
    const readFile = async file => file.endsWith('/token') ? 'fixture-token' : Buffer.from('ca');
    const pv = '/api/v1/persistentvolumes/pvc-01234567-89ab-4cde-8fab-0123456789ab';
    await expect(createInClusterApi({ readFile, request }).request('GET', pv)).rejects.toThrow('api_path_denied');
    const api = createInClusterApi({ readFile, request, allowProfileVolumeRead: true });
    expect(await api.request('GET', pv)).toEqual({ kind: 'PersistentVolume' });
    for (const [method, url] of [['POST', pv], ['DELETE', pv], ['GET', '/api/v1/persistentvolumes'], ['GET', `${pv}/status`],
      ['GET', `${pv}?watch=true`], ['GET', '/api/v1/nodes'], ['GET', '/api/v1/persistentvolumes/arbitrary']]) {
      await expect(api.request(method, url)).rejects.toThrow('api_path_denied');
    }
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('verified CA/TLS and rotated SA token; no secrets in API errors', async () => {
    let tokenRead = 0;
    const readFile = jest.fn(async file => file.endsWith('/token') ? `token-${++tokenRead}` : Buffer.from('test-ca'));
    const request = jest.fn((_url, _options, receive) => {
      const req = new EventEmitter(); req.destroy = jest.fn();
      req.end = () => queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 404; receive(res); res.end('{"message":"private credential diagnostic"}'); });
      return req;
    });
    const api = createInClusterApi({ readFile, request });
    const endpoint = '/api/v1/namespaces/lilly-team-workers/pods/pod-a';
    await expect(api.request('GET', endpoint)).rejects.toMatchObject({ status: 404, message: 'Kubernetes worker: api_status' });
    await expect(api.request('GET', endpoint)).rejects.toMatchObject({ status: 404 });
    expect(request.mock.calls[0][1]).toMatchObject({ rejectUnauthorized: true, ca: Buffer.from('test-ca'), headers: { Authorization: 'Bearer token-1' } });
    expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer token-2');
    expect(() => createInClusterApi({ server: 'http://unsafe' })).toThrow('invalid_api_origin');
    await expect(api.request('GET', '/api/v1/namespaces/default/secrets')).rejects.toThrow('api_path_denied');
  });

  test('bounds stalled HTTP requests and redacts synchronous transport errors', async () => {
    const readFile = async file => file.endsWith('/token') ? 'private-token' : Buffer.from('ca');
    const req = new EventEmitter(); req.destroy = jest.fn(); req.end = jest.fn();
    const endpoint = '/api/v1/namespaces/lilly-team-workers/pods/pod-a';
    const api = createInClusterApi({ readFile, timeoutMs: 5, request: () => req });
    await expect(api.request('GET', endpoint)).rejects.toThrow('api_timeout');
    expect(req.destroy).toHaveBeenCalled();
    const throwing = createInClusterApi({ readFile, request: () => { throw new Error('private transport details'); } });
    await expect(throwing.request('GET', endpoint)).rejects.toThrow('Kubernetes worker: api_network_error');
  });

  test('exec requests secure WSS v4 with channel arguments and no redirects', async () => {
    const socket = new EventEmitter(); socket.protocol = 'v4.channel.k8s.io'; socket.readyState = 1; socket.terminate = jest.fn();
    const Socket = jest.fn(function () { return socket; });
    const readFile = async file => file.endsWith('/token') ? 'private-token' : Buffer.from('ca');
    const api = createInClusterApi({ readFile, WebSocket: Socket });
    const child = api.exec({ namespace: 'lilly-team-workers', podName: 'pod-a', command: ['/bin/test', 'argument with spaces'] });
    child.on('exit', () => {}); await flush();
    const [url, protocols, options] = Socket.mock.calls[0];
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.getAll('command')).toEqual(['/bin/test', 'argument with spaces']);
    expect(protocols).toEqual(['v4.channel.k8s.io']);
    expect(options).toMatchObject({ rejectUnauthorized: true, followRedirects: false, ca: Buffer.from('ca'), headers: { Authorization: 'Bearer private-token' } });
    child.kill();
  });

  test('manifest grants no cluster role, PVC deletion, worker token, ingress or broad internet egress', () => {
    const manifests = yaml.loadAll(fs.readFileSync(path.resolve(__dirname, '../..', 'k8s/lilly-team-workers.yaml'), 'utf8'));
    expect(manifests.some(item => item.kind === 'ClusterRole' || item.kind === 'ClusterRoleBinding' || item.kind === 'Pod')).toBe(false);
    const worker = manifests.find(item => item.kind === 'ServiceAccount' && item.metadata.name === 'lilly-grok-worker');
    expect(worker.automountServiceAccountToken).toBe(false);
    const role = manifests.find(item => item.kind === 'Role');
    expect(role.rules.find(rule => rule.resources.includes('persistentvolumeclaims')).verbs).toEqual(['get', 'create']);
    expect(role.rules.some(rule => rule.verbs.includes('*') || rule.resources.includes('*'))).toBe(false);
    const network = manifests.find(item => item.metadata.name === 'worker-lilly-broker-only');
    expect(network.spec.egress).toHaveLength(1);
    expect(network.spec.egress[0].to).toEqual([{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kimibuilt' } }, podSelector: { matchLabels: { app: 'backend' } } }]);
    expect(network.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 3001 }]);
    expect(manifests.some(item => item.kind === 'Service')).toBe(false);
    expect(manifests.some(item => item.kind === 'Ingress')).toBe(false);
    expect(manifests.find(item => item.metadata.name === 'worker-default-deny').spec.ingress).toEqual([]);
  });

  test('browser-sized exec frames are explicit and capped while default ACP remains 1 MiB', async () => {
    const sockets = [];
    const Socket = jest.fn(function () {
      const socket = new EventEmitter(); socket.protocol = 'v4.channel.k8s.io'; socket.readyState = 1; socket.terminate = jest.fn();
      sockets.push(socket); return socket;
    });
    const api = createInClusterApi({ WebSocket: Socket,
      readFile: async file => file.endsWith('/token') ? 'fixture-token' : Buffer.from('ca') });
    const input = { namespace: 'lilly-team-workers', podName: 'pod-a', command: ['/bin/test'] };
    const ordinary = api.exec(input);
    const browser = api.exec({ ...input, maxBytes: 16 * 1024 * 1024 });
    await flush();
    expect(Socket.mock.calls.map(call => call[2].maxPayload)).toEqual([1024 * 1024, 16 * 1024 * 1024]);
    expect(() => api.exec({ ...input, maxBytes: 16 * 1024 * 1024 + 1 })).toThrow('invalid_limit');
    ordinary.kill(); browser.kill();
  });
});
