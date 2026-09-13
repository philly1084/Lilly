const https = require('node:https');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { isIPv4 } = require('node:net');
const WebSocket = require('ws');
const { GrokBuildAcpClient } = require('./acp-client');

const NAMESPACE = 'lilly-team-workers';
const APP = 'lilly-grok-worker';
const BINARY = '/opt/grok/bin/xai-grok-pager';
const HOME = '/state/home';
const CWD = '/state/workspace';
const MAX_API_BYTES = 2 * 1024 * 1024;
const fail = (code, status) => Object.assign(new Error(`Kubernetes worker: ${code}`), { code: `grok_kubernetes_${code}`, ...(status ? { status } : {}) });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validName = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);

function checkSignal(signal) { if (signal?.aborted) throw fail('cancelled'); }
function bounded(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fail('invalid_limit');
  return value;
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(fail('cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// ACP expects synchronous spawn. Defer only connection establishment so an
// authoritative Pod/image check can run again at start, without stdin replay.
function deferredExec(start) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let inner; let ended = false;
  const stop = (code = null, reason = 'exec_unavailable') => {
    if (ended) return; ended = true;
    child.emit('exit', code, reason); child.stdout.end(); child.stderr.end();
  };
  const ready = Promise.resolve().then(() => {
    if (ended) throw fail('cancelled');
    return start(() => !ended);
  }).then(process => {
    inner = process;
    if (ended) { inner.kill(); throw fail('cancelled'); }
    inner.on('exit', stop); inner.on('error', () => stop());
    inner.stdin.on('error', () => stop());
    for (const key of ['stdout', 'stderr']) {
      inner[key].on('error', () => stop());
      inner[key].on('data', data => {
        if (ended) return;
        if (child[key].readableLength + data.length > 1024 * 1024) { child.kill(); return; }
        child[key].write(data);
      });
    }
    return process;
  });
  ready.catch(() => stop());
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    if (child.stdin.writableLength > 1024 * 1024) { callback(fail('stdin_limit')); child.kill(); return; }
    ready.then(process => {
      if (ended) throw fail('cancelled');
      process.stdin.write(chunk, callback);
    }).catch(() => callback(fail('exec_unavailable')));
  } });
  child.kill = () => { inner?.kill(); stop(null, 'termination_requested'); return true; };
  return child;
}

/** Kubernetes v4 channel protocol: byte 0 stdin, 1 stdout, 2 stderr, 3 Status.
 * Source: kubernetes-client/javascript src/web-socket-handler.ts. No reconnect
 * or replay: replaying stdin can execute an action twice. Socket close is NOT
 * proof of remote process exit; deleting the exact Pod UID is the authority.
 */
function createExecChild({ connect, signal, maxBytes = 1024 * 1024 }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let socket;
  let ended = false;
  let connectResolve;
  let connectReject;
  const ready = new Promise((resolve, reject) => { connectResolve = resolve; connectReject = reject; });
  ready.catch(() => {});
  const end = (code = null, reason = 'transport_closed') => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener('abort', aborted);
    connectReject(fail(reason));
    // Emit exit first so the ACP adapter records authoritative non-success
    // rather than interpreting a subsequent stdout end as normal completion.
    child.emit('exit', code, code === null ? reason : null);
    child.stdout.end(); child.stderr.end();
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  };
  const aborted = () => end(null, 'cancelled');
  child.stdin = new Writable({
    highWaterMark: maxBytes,
    write(chunk, _encoding, callback) {
      if (chunk.length > maxBytes || child.stdin.writableLength > maxBytes) { callback(fail('stdin_limit')); end(); return; }
      ready.then(() => {
        if (ended || socket.bufferedAmount > maxBytes) throw fail('stdin_unavailable');
        socket.send(Buffer.concat([Buffer.from([0]), chunk]), error => callback(error ? fail('stdin_write') : undefined));
      }).catch(() => callback(fail('stdin_unavailable')));
    },
    final(callback) { end(null, 'stdin_closed'); callback(); },
  });
  child.kill = () => { end(null, 'termination_requested'); return true; };
  signal?.addEventListener('abort', aborted, { once: true });
  queueMicrotask(async () => {
    try {
      checkSignal(signal);
      socket = await connect();
      if (ended) { socket.terminate(); return; }
      socket.on('error', () => end(null, 'websocket_error'));
      socket.on('close', () => end());
      socket.on('message', (raw, binary) => {
        if (ended) return;
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (!binary || bytes.length < 1 || bytes.length > maxBytes) return end(null, 'channel_frame_invalid');
        const channel = bytes[0];
        const data = bytes.subarray(1);
        if (channel === 1 || channel === 2) {
          const output = channel === 1 ? child.stdout : child.stderr;
          if (output.readableLength + data.length > maxBytes) return end(null, 'stdout_limit');
          output.write(data);
        } else if (channel === 3) {
          try {
            const status = JSON.parse(data.toString('utf8'));
            if (status.status === 'Success') return end(0);
            const cause = status.details?.causes?.find(entry => entry.reason === 'ExitCode');
            if (cause && /^\d{1,3}$/.test(cause.message)) return end(Number(cause.message));
            return end(null, 'exec_failed');
          } catch { return end(null, 'status_invalid'); }
        } else end(null, 'channel_unsupported');
      });
      const opened = () => {
        if (socket.protocol !== 'v4.channel.k8s.io') { end(null, 'exec_protocol'); return; }
        connectResolve(); child.emit('spawn');
      };
      socket.once('open', opened);
      if (socket.readyState === WebSocket.OPEN) opened();
    } catch { end(null, signal?.aborted ? 'cancelled' : 'exec_connect'); }
  });
  return child;
}

// https://kubernetes.io/docs/tasks/run-application/access-api-from-pod/
// https://github.com/kubernetes-client/javascript/blob/master/src/web-socket-handler.ts
// No kubeconfig parsing, shell, kubectl, proxy environment or insecure TLS mode.
// The service-account token is reread on every operation to honour rotation.
function createInClusterApi(options = {}) {
  if (options.allowProfileVolumeRead !== undefined && typeof options.allowProfileVolumeRead !== 'boolean') throw fail('invalid_api_scope');
  const backendPods = options.backendPodNames === undefined ? [] : options.backendPodNames;
  if (!Array.isArray(backendPods) || backendPods.length > 32 || new Set(backendPods).size !== backendPods.length
    || backendPods.some(name => typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) throw fail('invalid_api_scope');
  const backendPaths = new Set(backendPods.map(name => `/api/v1/namespaces/kimibuilt/pods/${name}`));
  const serverUrl = new URL(options.server || 'https://kubernetes.default.svc');
  if (serverUrl.protocol !== 'https:' || serverUrl.username || serverUrl.password || serverUrl.pathname !== '/' || serverUrl.search || serverUrl.hash) throw fail('invalid_api_origin');
  const readFile = options.readFile || fs.readFile;
  const requestImpl = options.request || https.request;
  const Socket = options.WebSocket || WebSocket;
  const timeoutMs = bounded(options.timeoutMs, 15000, 60000);
  const credentials = async () => {
    const [token, ca] = await Promise.all([
      readFile(options.tokenPath || '/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
      readFile(options.caPath || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
    ]);
    if (!String(token).trim() || !ca?.length) throw fail('cluster_credentials_unavailable');
    return { headers: { Authorization: `Bearer ${String(token).trim()}` }, ca, rejectUnauthorized: true };
  };
  const validatePath = (value, method) => {
    if (method === 'GET' && backendPaths.has(value)) return new URL(value, serverUrl);
    // Separate trusted node opt-in. No PV inventory, mutation, subresource,
    // query or arbitrary cluster endpoint is admitted by this capability.
    if (options.allowProfileVolumeRead === true && method === 'GET' && typeof value === 'string'
      && /^\/api\/v1\/persistentvolumes\/pvc-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) return new URL(value, serverUrl);
    if (typeof value !== 'string' || !value.startsWith(`/api/v1/namespaces/${NAMESPACE}/`) || /[\r\n#]/.test(value)) throw fail('api_path_denied');
    const resolved = new URL(value, serverUrl);
    if (resolved.origin !== serverUrl.origin || !resolved.pathname.startsWith(`/api/v1/namespaces/${NAMESPACE}/`)) throw fail('api_path_denied');
    return resolved;
  };
  return {
    async request(method, apiPath, body, { signal } = {}) {
      if (!['GET', 'POST', 'DELETE'].includes(method)) throw fail('api_method_denied');
      checkSignal(signal);
      const url = validatePath(apiPath, method);
      let auth;
      try { auth = await credentials(); } catch { throw fail('cluster_credentials_unavailable'); }
      checkSignal(signal);
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      if (data && data.length > MAX_API_BYTES) throw fail('api_body_limit');
      return new Promise((resolve, reject) => {
        let timer;
        let done = false;
        const finish = (error, value) => {
          if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        const req = requestImpl(url, { ...auth, method, headers: { ...auth.headers, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
          const chunks = []; let bytes = 0;
          res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_API_BYTES) { req.destroy(); finish(fail('api_response_limit')); } else chunks.push(chunk); });
          res.on('error', () => finish(fail('api_response_error')));
          res.on('end', () => {
            const status = res.statusCode;
            if (status < 200 || status >= 300) return finish(fail('api_status', status));
            try { finish(null, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch { finish(fail('api_invalid_json')); }
          });
        });
        const abort = () => { req.destroy(); finish(fail('cancelled')); };
        req.on('error', () => finish(fail('api_network_error')));
        timer = setTimeout(() => { req.destroy(); finish(fail('api_timeout')); }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        try { req.end(data); } catch { req.destroy(); finish(fail('api_network_error')); }
      }).catch(error => {
        if (error.code?.startsWith('grok_kubernetes_')) throw error;
        throw fail('api_network_error');
      });
    },
    exec({ namespace, podName, container = 'worker', command, signal, maxBytes: requestedMaxBytes }) {
      const maxBytes = bounded(requestedMaxBytes, 1024 * 1024, 16 * 1024 * 1024);
      if (namespace !== NAMESPACE || !validName(podName) || container !== 'worker' || !Array.isArray(command)
        || command.length > 16 || command.some(arg => typeof arg !== 'string' || arg.length > 1024 || /[\0\r\n]/.test(arg))) throw fail('exec_input_denied');
      const url = validatePath(`/api/v1/namespaces/${NAMESPACE}/pods/${podName}/exec`);
      url.protocol = 'wss:';
      for (const arg of command) url.searchParams.append('command', arg);
      for (const [key, value] of Object.entries({ container, stdin: 'true', stdout: 'true', stderr: 'true', tty: 'false' })) url.searchParams.set(key, value);
      return createExecChild({ signal, maxBytes, connect: async () => {
        const auth = await credentials(); checkSignal(signal);
        return new Socket(url, ['v4.channel.k8s.io'], { ...auth, handshakeTimeout: timeoutMs, maxPayload: maxBytes, followRedirects: false });
      } });
    },
  };
}

function modelConfig(scope, configuredOrigin) {
  let endpoint;
  try { endpoint = new URL(scope.modelEndpoint); } catch { throw fail('invalid_model_endpoint'); }
  if (endpoint.origin !== configuredOrigin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^\/api\/agent-team-workers\/[a-zA-Z0-9_-]{16,128}\/v1\/?$/.test(endpoint.pathname)) throw fail('model_endpoint_denied');
  if (typeof scope.modelToken !== 'string' || !/^[A-Za-z0-9._~-]{24,512}$/.test(scope.modelToken)
    || typeof scope.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(scope.model)) throw fail('invalid_model_route');
  // Verified model profile schema: https://docs.x.ai/build/settings
  return `[cli]\nauto_update = false\n[models]\ndefault = "lilly"\nweb_search = "lilly"\n[model.lilly]\nmodel = ${JSON.stringify(scope.model)}\nbase_url = ${JSON.stringify(endpoint.href.replace(/\/$/, ''))}\nname = "Lilly task model"\nenv_key = "LILLY_MODEL_API_KEY"\napi_backend = "responses"\nsupports_backend_search = false\n`;
}

/** Synchronous configuration -> async task-scoped lease factory. No provisioning
 * until factory(scope), and no ACP process until lease.client.start(). Required
 * configuration: namespace, immutable single-platform image, brokerPodIP,
 * brokerPodUid, brokerPodName. Runtime verifies these Downward API fields and
 * its local network interface; do not pass Service IPs or model-provided values.
 * Scope: ownerId/teamId/agentId/taskId/claim + model/modelEndpoint/modelToken,
 * optional signal/maxTimeMs. Tokens never enter service lease records.
 *
 * The caller must revoke its broker before close(), preserve failed cleanup
 * intents, and fence claims across backend replicas; activeAgents is local only.
 * close resolves only after observed deletion of own Pod/Secret UIDs; PVC stays.
 * Verify CNI policy enforcement, storage permissions and imageID on the actual
 * cluster before enabling. The isolated port must serve only token-authorized
 * broker routes; L4 policy cannot authorize individual URL paths, and
 * closing exec alone cannot kill Grok descendants. No deploy occurs here.
 */
function createKubernetesWorkerFactory({ service, configuration, cluster } = {}) {
  for (const method of ['getEngineSession', 'saveEngineSession', 'recordWorkerLease']) if (typeof service?.[method] !== 'function') throw fail('lease_service_required');
  if (configuration?.namespace !== NAMESPACE || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(configuration.image || '')) throw fail('immutable_worker_image_required');
  const origin = configuration.modelOrigin || 'http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001';
  if (origin !== 'http://lilly-worker-broker.kimibuilt.svc.cluster.local:3001') throw fail('model_origin_policy_mismatch');
  const { brokerPodIP, brokerPodUid, brokerPodName } = configuration;
  if (configuration.brokerClusterIP !== undefined || !isIPv4(brokerPodIP || '')
    || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(brokerPodIP)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(brokerPodUid || '') || !validName(brokerPodName)) throw fail('broker_pod_identity_required');
  const imageDigest = configuration.image.split('@')[1];
  const readyTimeoutMs = bounded(configuration.readyTimeoutMs, 120000, 300000);
  const closeTimeoutMs = bounded(configuration.closeTimeoutMs, 60000, 300000);
  const pollMs = bounded(configuration.pollMs, 1000, 10000);
  const storageClassName = configuration.storageClassName || 'local-path';
  if (!validName(storageClassName)) throw fail('invalid_storage_class');
  const api = cluster || createInClusterApi();
  const activeAgents = new Set();
  return async function createWorker(scope = {}) {
    const identity = {};
    for (const key of ['ownerId', 'teamId', 'agentId', 'taskId']) {
      if (typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 256) throw fail('invalid_identity');
      identity[key] = scope[key];
    }
    identity.claim = scope.claim;
    checkSignal(scope.signal);
    const configText = modelConfig(scope, origin);
    const identityHash = hash([identity.ownerId, identity.teamId, identity.agentId]);
    if (activeAgents.has(identityHash)) throw fail('agent_already_leased');
    activeAgents.add(identityHash);
    const leaseId = randomUUID();
    const leaseHash = hash([identity.taskId, leaseId]).slice(0, 32);
    const record = { leaseId, namespace: NAMESPACE, podName: `grok-${leaseHash}`, secretName: `grok-config-${leaseHash}`, pvcName: `grok-state-${identityHash.slice(0, 32)}`, phase: 'provisioning' };
    const labels = { 'app.kubernetes.io/name': APP, 'lilly.ai/agent': identityHash.slice(0, 32), 'lilly.ai/lease': leaseHash };
    const annotations = { 'lilly.ai/identity': identityHash, 'lilly.ai/lease-id': leaseId,
      'lilly.ai/broker-pod-uid': brokerPodUid, 'lilly.ai/broker-pod-name': brokerPodName };
    const pathFor = (kind, name) => `/api/v1/namespaces/${NAMESPACE}/${kind}${name ? `/${name}` : ''}`;
    const persist = () => service.recordWorkerLease(identity, { ...record });
    const get = async (kind, name, signal) => {
      try { return await api.request('GET', pathFor(kind, name), undefined, { signal }); } catch (error) { if (error.status === 404) return null; throw error; }
    };
    const owns = object => object?.metadata?.annotations?.['lilly.ai/identity'] === identityHash && object.metadata.annotations['lilly.ai/lease-id'] === leaseId;
    const attempted = new Set();
    const uncertainCreates = new Set();
    let closing;
    let client;
    let closed = false;
    const deleteOwned = async (kind, name, uidKey) => {
      if (!attempted.has(kind)) return;
      const object = await get(kind, name);
      if (!object) {
        // A timed-out create could still commit after this GET. Absence is not
        // enough to erase its durable intent until the API outcome is resolved.
        if (uncertainCreates.has(kind)) throw fail('create_outcome_uncertain');
        return;
      }
      if (!owns(object) || (record[uidKey] && record[uidKey] !== object.metadata.uid)) throw fail('cleanup_identity_conflict');
      if (!object.metadata.uid) throw fail('cleanup_uid_missing');
      record[uidKey] = object.metadata.uid;
      uncertainCreates.delete(kind);
      let persistenceError;
      try { await persist(); } catch (error) { persistenceError = error; }
      try {
        await api.request('DELETE', pathFor(kind, name), { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: object.metadata.uid }, propagationPolicy: 'Foreground' });
      } catch (error) { if (error.status !== 404) throw error; }
      const until = Date.now() + closeTimeoutMs;
      while (true) {
        const current = await get(kind, name);
        if (!current) { if (persistenceError) throw persistenceError; return; }
        if (current.metadata?.uid !== object.metadata.uid) throw fail('cleanup_identity_conflict');
        if (Date.now() >= until) throw fail('cleanup_unconfirmed');
        await wait(pollMs);
      }
    };
    const close = async () => {
      if (closing) return closing;
      scope.signal?.removeEventListener('abort', aborted);
      try { client?.close(); } catch { /* Exact UID deletion below remains authoritative. */ }
      closing = (async () => {
        record.phase = 'closing';
        try {
          let cleanupError;
          try { await persist(); } catch (error) { cleanupError = error; }
          // Revoke the mounted/env task token before deleting the Pod. External
          // broker revocation is performed by the caller before lease.close().
          for (const [kind, name, uidKey] of [['secrets', record.secretName, 'secretUid'], ['pods', record.podName, 'podUid']]) {
            try { await deleteOwned(kind, name, uidKey); } catch (error) { cleanupError ||= error; }
          }
          if (cleanupError) throw cleanupError;
          record.phase = 'closed'; await persist(); closed = true; activeAgents.delete(identityHash);
        } catch (error) {
          record.phase = 'reconciliation'; record.reason = error.code?.startsWith('grok_kubernetes_') ? error.code : 'lease_cleanup_failed';
          try { await persist(); } catch { /* Original intent and resource names remain durable. */ }
          throw fail('cleanup_unconfirmed');
        }
      })();
      return closing;
    };
    const aborted = () => { close().catch(() => {}); };
    const guard = () => { checkSignal(scope.signal); if (closing || closed) throw fail('cancelled'); };
    const create = async (kind, body, uidKey) => {
      guard();
      if (await get(kind, body.metadata.name, scope.signal)) throw fail('resource_already_exists');
      guard(); attempted.add(kind);
      let result;
      try { result = await api.request('POST', pathFor(kind), body, { signal: scope.signal }); } catch (error) {
        // An uncertain create is not retried; cleanup re-GETs the exact intended
        // name and checks our unguessable lease nonce before touching anything.
        if (!error.status || error.status >= 500) uncertainCreates.add(kind);
        record.phase = 'reconciliation'; await persist(); throw error;
      }
      if (!owns(result) || !result.metadata.uid) throw fail('created_identity_mismatch');
      record[uidKey] = result.metadata.uid; await persist(); guard();
      return result;
    };
    try {
      await persist(); guard();
      const previous = await service.getEngineSession(identity); guard();
      const pvc = await get('persistentvolumeclaims', record.pvcName, scope.signal); guard();
      const pvcBody = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: record.pvcName, namespace: NAMESPACE, labels: { 'app.kubernetes.io/name': APP, 'lilly.ai/agent': identityHash.slice(0, 32) }, annotations: { 'lilly.ai/identity': identityHash } }, spec: { accessModes: ['ReadWriteOnce'], storageClassName, resources: { requests: { storage: '2Gi' } } } };
      let storedPvc = pvc;
      if (!storedPvc) {
        try { storedPvc = await api.request('POST', pathFor('persistentvolumeclaims'), pvcBody, { signal: scope.signal }); } catch (error) {
          if (error.status !== 409) throw error;
          storedPvc = await get('persistentvolumeclaims', record.pvcName, scope.signal);
        }
      }
      if (!storedPvc?.metadata?.uid || storedPvc.metadata.annotations?.['lilly.ai/identity'] !== identityHash
        || storedPvc.spec?.storageClassName !== storageClassName || !storedPvc.spec?.accessModes?.includes('ReadWriteOnce')) throw fail('pvc_identity_conflict');
      record.pvcUid = storedPvc.metadata.uid; await persist(); guard();
      const metadata = name => ({ name, namespace: NAMESPACE, labels, annotations });
      await create('secrets', { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true, metadata: metadata(record.secretName),
        stringData: { 'config.toml': configText, 'model-token': scope.modelToken } }, 'secretUid');
      const securityContext = { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
      const resources = { requests: { cpu: '100m', memory: '256Mi', 'ephemeral-storage': '64Mi' }, limits: { cpu: '1', memory: '2Gi', 'ephemeral-storage': '256Mi' } };
      const pod = {
        apiVersion: 'v1', kind: 'Pod', metadata: metadata(record.podName), spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false, serviceAccountName: 'lilly-grok-worker',
          // The broker owns in-memory task tokens. Pin this worker to its exact
          // owning backend Pod; a shared Service can select the wrong process.
          hostAliases: [{ ip: brokerPodIP, hostnames: ['lilly-worker-broker.kimibuilt.svc.cluster.local'] }],
          dnsPolicy: 'None', dnsConfig: { nameservers: ['127.0.0.1'] },
          terminationGracePeriodSeconds: 10, activeDeadlineSeconds: Math.ceil(bounded(scope.maxTimeMs, 600000, 600000) / 1000) + Math.ceil(readyTimeoutMs / 1000) + 30,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
          initContainers: [{ name: 'state-dirs', image: configuration.image, imagePullPolicy: 'IfNotPresent', securityContext, resources,
            command: ['/bin/sh', '-c', 'mkdir -p /state/home/.grok /state/home/.config /state/home/.local/share /state/home/.cache /state/workspace && chmod 0770 /state/home /state/workspace'],
            volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'tmp', mountPath: '/tmp' }] }],
          containers: [{ name: 'worker', image: configuration.image, imagePullPolicy: 'IfNotPresent', securityContext, resources, workingDir: CWD,
            command: ['/bin/sleep', 'infinity'], env: [
              { name: 'HOME', value: HOME }, { name: 'GROK_HOME', value: `${HOME}/.grok` },
              { name: 'XDG_CONFIG_HOME', value: `${HOME}/.config` }, { name: 'XDG_DATA_HOME', value: `${HOME}/.local/share` }, { name: 'XDG_CACHE_HOME', value: `${HOME}/.cache` },
              { name: 'LILLY_MODEL_API_KEY', valueFrom: { secretKeyRef: { name: record.secretName, key: 'model-token' } } },
            ], volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'tmp', mountPath: '/tmp' }, { name: 'config', mountPath: `${HOME}/.grok/config.toml`, subPath: 'config.toml', readOnly: true }],
            readinessProbe: { exec: { command: ['/bin/test', '-r', `${HOME}/.grok/config.toml`] }, initialDelaySeconds: 1, periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 10 },
          }],
          volumes: [{ name: 'state', persistentVolumeClaim: { claimName: record.pvcName } }, { name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }, { name: 'config', secret: { secretName: record.secretName, defaultMode: 0o440, items: [{ key: 'config.toml', path: 'config.toml' }] } }],
        },
      };
      await create('pods', pod, 'podUid');
      const verifyImage = current => {
        const worker = current.spec?.containers?.find(container => container.name === 'worker');
        const status = current.status?.containerStatuses?.find(container => container.name === 'worker');
        if (worker?.image !== configuration.image || !status?.ready || !status.state?.running
          || typeof status.imageID !== 'string' || !status.imageID.endsWith(`@${imageDigest}`)) throw fail('worker_image_unverified');
      };
      const readyUntil = Date.now() + readyTimeoutMs;
      while (true) {
        guard();
        const current = await get('pods', record.podName, scope.signal);
        if (!current || !owns(current) || current.metadata.uid !== record.podUid) throw fail('pod_identity_conflict');
        if (['Failed', 'Succeeded'].includes(current.status?.phase) || current.metadata.deletionTimestamp) throw fail('pod_not_running');
        if (current.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')) {
          verifyImage(current);
          break;
        }
        if (Date.now() >= readyUntil) throw fail('pod_ready_timeout');
        await wait(pollMs, scope.signal);
      }
      guard();
      let spawned = false;
      client = new GrokBuildAcpClient({ executable: BINARY, cwd: CWD, home: HOME, promptTimeoutMs: 600000,
        spawn(executable, args) {
          guard();
          if (spawned || executable !== BINARY || JSON.stringify(args) !== JSON.stringify(['--no-auto-update', 'agent', 'stdio'])) throw fail('exec_command_denied');
          spawned = true;
          return deferredExec(async alive => {
            const current = await get('pods', record.podName, scope.signal); guard();
            if (!alive() || !current || !owns(current) || current.metadata.uid !== record.podUid || current.metadata.deletionTimestamp) throw fail('pod_identity_conflict');
            verifyImage(current);
            return api.exec({ namespace: NAMESPACE, podName: record.podName, container: 'worker', command: [BINARY, ...args], signal: scope.signal });
          });
        },
      });
      record.phase = 'ready'; await persist(); guard();
      scope.signal?.addEventListener('abort', aborted, { once: true }); guard();
      return { client, sessionId: previous?.sessionId,
        saveSession: async sessionId => {
          guard(); if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw fail('invalid_session');
          await service.saveEngineSession(identity, sessionId); guard();
        },
        close,
      };
    } catch (error) {
      try { await close(); } catch { throw fail('cleanup_unconfirmed'); }
      throw error.code?.startsWith('grok_kubernetes_') ? error : fail('provision_failed');
    }
  };
}

module.exports = { createInClusterApi, createExecChild, createKubernetesWorkerFactory, modelConfig };
