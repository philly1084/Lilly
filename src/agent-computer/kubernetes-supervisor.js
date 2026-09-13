'use strict';

const { randomUUID } = require('node:crypto');
const { createInClusterApi } = require('../grok-build/kubernetes-supervisor');
const { connectComputer } = require('./remote-runtime');
const { normalizeIdentity } = require('./runtime');
const { createSupervisedComputerRuntime } = require('./supervised-runtime');
const { normalizeBrowserBinding } = require('./node-binding');
const { normalizeBrowserStopEvidence, browserFingerprint } = require('./stop-evidence');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const { isRecoveryHelperClosed } = require('./recovery-helper');

const NAMESPACE = 'lilly-team-workers';
const APP = 'lilly-private-browser';
const ENTRYPOINT = '/opt/lilly-browser/worker/stdio-worker.js';
const fail = code => Object.assign(new Error(`Private browser supervisor: ${code}`), { code: `computer_supervisor_${code}` });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const name = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const limit = (value, fallback, max) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fail('invalid_limit');
  return value;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Trusted deployment factory, never a model/owner command. The observer must
// settle the exact container and profile lock independently of API Pod deletion.
// API requests and raw exec pipes are private; no ports, Secrets or model keys.
function createKubernetesComputerFactory({ service, configuration, bindContainer, requestStop, captureStop, observeTermination, cluster } = {}) {
  if (!['get', 'reserveComputerLease', 'recordComputerLease', 'recordComputerStop', 'recordComputerRecovery'].every(key => typeof service?.[key] === 'function')
    || ![bindContainer, requestStop, captureStop, observeTermination].every(value => typeof value === 'function')) throw fail('ownership_observer_required');
  if (configuration?.namespace !== NAMESPACE || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(configuration.image || '')) throw fail('immutable_image_required');
  const storageClassName = configuration.storageClassName || 'local-path';
  // A reviewed, preinstalled node profile, not an unconfined fallback or a
  // model-selected filesystem path. Its deployed availability needs live proof.
  if (!name(storageClassName) || !/^lilly\/[a-z0-9][a-z0-9-]{0,80}\.json$/.test(configuration.seccompProfile || '')) throw fail('sandbox_configuration_required');
  const readyTimeoutMs = limit(configuration.readyTimeoutMs, 120000, 300000);
  const closeTimeoutMs = limit(configuration.closeTimeoutMs, 60000, 300000);
  const pollMs = limit(configuration.pollMs, 1000, 10000);
  const api = cluster || createInClusterApi();
  const apiPath = (kind, id) => `/api/v1/namespaces/${NAMESPACE}/${kind}${id ? `/${id}` : ''}`;
  const get = async (kind, id, signal) => {
    try { return await api.request('GET', apiPath(kind, id), undefined, { signal }); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  return async scope => {
    const identity = { ...normalizeIdentity(scope), taskId: scope.taskId, claim: scope.claim };
    if (typeof scope.authorize !== 'function' || scope.taskId !== scope.claim?.taskId) throw fail('claim_required');
    const guard = () => { if (scope.signal?.aborted) throw fail('cancelled'); };
    guard();
    let record = await service.reserveComputerLease(identity, { leaseId: randomUUID(), image: configuration.image });
    // Use only durable server-generated resource names. No caller controls them.
    if (record.namespace !== NAMESPACE || !name(record.podName) || !name(record.pvcName)
      || !uuid(record.leaseId) || record.phase !== 'reserved' || record.image !== configuration.image) throw fail('reservation_invalid');
    const persist = async update => { record = await service.recordComputerLease(identity, { leaseId: record.leaseId, ...update }); return record; };
    const labels = { 'app.kubernetes.io/name': APP, 'lilly.ai/agent': record.identityHash.slice(0, 32) };
    const profileAnnotations = { 'lilly.ai/identity': record.identityHash };
    const annotations = { ...profileAnnotations, 'lilly.ai/lease-id': record.leaseId, 'lilly.ai/owner-boot': record.ownerBootId };
    const ownsPod = pod => pod?.metadata?.name === record.podName && pod.metadata.namespace === NAMESPACE
      && uuid(pod.metadata.uid) && Object.entries(annotations).every(([key, value]) => pod.metadata.annotations?.[key] === value)
      && (!record.podUid || pod.metadata.uid === record.podUid);
    const ownsProfile = pvc => pvc?.metadata?.name === record.pvcName && pvc.metadata.namespace === NAMESPACE
      && uuid(pvc.metadata.uid) && (!record.pvcUid || pvc.metadata.uid === record.pvcUid)
      && pvc.metadata.annotations?.['lilly.ai/identity'] === record.identityHash && !pvc.metadata.deletionTimestamp
      && pvc.spec?.storageClassName === storageClassName && pvc.spec?.volumeMode !== 'Block'
      && pvc.spec?.accessModes?.length === 1 && pvc.spec.accessModes[0] === 'ReadWriteOnce';
    let podAttempted = false; let uncertainPod = false; let uncertainProfile = false;
    let child; let computer; let stopping; let latestPod;
    const bindPod = async pod => {
      if (!ownsPod(pod)) throw fail('pod_identity_conflict');
      const status = pod.status?.containerStatuses?.find(value => value.name === 'worker');
      const containerId = status?.containerID;
      if (containerId && !/^containerd:\/\/[a-f0-9]{64}$/.test(containerId)) throw fail('container_identity_invalid');
      latestPod = pod;
      await persist({ phase: record.phase, podUid: pod.metadata.uid, ...(containerId ? { containerId } : {}) });
    };
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        scope.signal?.removeEventListener('abort', aborted);
        child?.kill();
        let persistenceError;
        try { await persist({ phase: 'closing' }); } catch (error) { persistenceError = error; }
        try {
          let pod = podAttempted ? await get('pods', record.podName) : null;
          if (pod) {
            if (!ownsPod(pod)) throw fail('cleanup_identity_conflict');
            // Capture the exact late-created object, never replay its POST.
            try { await bindPod(pod); } catch (error) { persistenceError ||= error; }
            if (!record.podUid || record.podUid !== pod.metadata.uid) throw fail('cleanup_binding_unavailable');
            uncertainPod = false;
          }
          if (uncertainPod || uncertainProfile) throw fail('create_outcome_uncertain');
          if (record.nodeBinding) {
            // Never delete a used browser Pod before its exact stopped owner is
            // archived. Deletion can garbage-collect the CRI record we need.
            // A closed exec pipe or successful stop request is not evidence.
            if (persistenceError) throw persistenceError;
            const fingerprint = browserFingerprint(record);
            const observer = new AbortController(); const until = Date.now() + closeTimeoutMs;
            const bounded = async run => {
              let timer;
              try {
                if (observer.signal.aborted || Date.now() >= until) { observer.abort(); throw fail('observation_timeout'); }
                return await Promise.race([
                  Promise.resolve().then(() => {
                    if (observer.signal.aborted || Date.now() >= until) { observer.abort(); throw fail('observation_timeout'); }
                    return run();
                  }),
                  new Promise((_, reject) => { timer = setTimeout(() => {
                    observer.abort(); reject(fail('observation_timeout'));
                  }, Math.max(1, until - Date.now())); }),
                ]);
              } finally { clearTimeout(timer); }
            };
            const refresh = async () => {
              const team = await service.get(identity.teamId, identity.ownerId);
              const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
              const latest = task?.computerLease;
              if (team.id !== identity.teamId || team.ownerId !== identity.ownerId
                || task.worker?.id !== identity.claim.workerId || task.worker.claimId !== identity.claim.claimId
                || latest?.ownerBootId !== task.worker.executionOwner?.bootId || latest?.claimId !== identity.claim.claimId
                || !['closing', 'reconciliation'].includes(latest?.phase) || browserFingerprint(latest) !== fingerprint) throw fail('cleanup_identity_conflict');
              return latest;
            };
            try {
              record = await bounded(refresh);
              if (!record.stopEvidence) {
                await bounded(() => requestStop({ identity, lease: { ...record }, signal: observer.signal }));
                let receipt;
                while (!receipt) {
                  receipt = await bounded(() => captureStop({ identity, lease: { ...record }, signal: observer.signal }));
                  if (!receipt) {
                    if (Date.now() >= until) throw fail('cleanup_unconfirmed');
                    await delay(Math.min(pollMs, Math.max(1, until - Date.now())));
                  }
                }
                receipt = normalizeBrowserStopEvidence(record, receipt);
                // Lost commit replies are resolved only by an authoritative
                // read. A caller-returned receipt alone cannot authorize DELETE.
                try { await bounded(() => service.recordComputerStop(identity, receipt)); }
                catch { if (observer.signal.aborted) throw fail('observation_timeout'); }
                record = await bounded(refresh);
              }
              normalizeBrowserStopEvidence(record, record.stopEvidence);
            } finally { observer.abort(); }
          }
          // Startup failures before any node-bound exec retain the original
          // never-used-container cleanup path. No browser profile was opened.
          if (pod) {
            pod = await get('pods', record.podName);
            if (pod && !ownsPod(pod)) throw fail('cleanup_identity_conflict');
          }
          if (pod) {
            try {
              await api.request('DELETE', apiPath('pods', record.podName), { apiVersion: 'v1', kind: 'DeleteOptions',
                preconditions: { uid: record.podUid }, propagationPolicy: 'Foreground' });
            } catch (error) { if (error.status !== 404) throw error; }
          }
          if (podAttempted && record.podUid) {
            const until = Date.now() + closeTimeoutMs;
            while (true) {
              pod = await get('pods', record.podName);
              if (pod && !ownsPod(pod)) throw fail('cleanup_identity_conflict');
              const observerSignal = new AbortController(); let timer;
              const evidence = await Promise.race([
                Promise.resolve().then(() => observeTermination({ identity, lease: { ...record }, pod: pod || latestPod, signal: observerSignal.signal })),
                new Promise((_, reject) => { timer = setTimeout(() => {
                  observerSignal.abort(); reject(fail('observation_timeout'));
                }, Math.max(1, until - Date.now())); }),
              ]).finally(() => clearTimeout(timer));
              const fields = ['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'];
              const exact = evidence && fields.every(key => evidence[key] === record[key]);
              if (!pod && exact && evidence.podStopped === true && evidence.profileReleased === true) {
                if (record.nodeBinding) {
                  await service.recordComputerStop(identity, evidence.stopEvidence);
                  await service.recordComputerRecovery(identity, evidence.profileRecovery);
                }
                break;
              }
              if (Date.now() >= until) throw fail('cleanup_unconfirmed');
              await delay(pollMs);
            }
          } else if (podAttempted) {
            // A confirmed API rejection with no object is safe only when no
            // unknown create remains. No browser could have mounted the profile.
            if (pod) throw fail('cleanup_binding_unavailable');
          }
          if (persistenceError) throw persistenceError;
          await persist({ phase: 'closed', podStopped: true, profileReleased: true });
        } catch {
          await persist({ phase: 'reconciliation', reason: 'cleanup_unconfirmed' }).catch(() => {});
          throw fail('cleanup_unconfirmed');
        }
      })();
      return stopping;
    };
    const aborted = () => { if (computer) computer.dispose().catch(() => {}); else stop().catch(() => {}); };
    const confirmClosed = async () => {
      // Private factory callback, never a model-supplied flag. This only reads
      // authoritative state; it cannot replay cleanup, release or provisioning.
      try {
        if (!record.nodeBinding) return false;
        const team = await service.get(identity.teamId, identity.ownerId);
        const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
        const lease = task?.computerLease;
        if (team.id !== identity.teamId || team.ownerId !== identity.ownerId
          || task.worker?.id !== identity.claim.workerId || task.worker.claimId !== identity.claim.claimId
          || lease?.ownerBootId !== task.worker.executionOwner?.bootId || lease?.claimId !== identity.claim.claimId
          || lease?.phase !== 'closed' || lease.podStopped !== true || lease.profileReleased !== true
          || browserFingerprint(lease) !== browserFingerprint(record)) return false;
        normalizeBrowserStopEvidence(lease, lease.stopEvidence);
        normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
        if (lease.recoveryHelper && !isRecoveryHelperClosed(lease)) return false;
        return await get('pods', lease.podName) === null;
      } catch { return false; }
    };
    try {
      guard(); await persist({ phase: 'provisioning' }); guard();
      let pvc = await get('persistentvolumeclaims', record.pvcName, scope.signal); guard();
      if (!pvc) {
        if (record.pvcUid) throw fail('profile_missing'); // Never replace lost persisted storage.
        const body = { apiVersion: 'v1', kind: 'PersistentVolumeClaim',
          metadata: { name: record.pvcName, namespace: NAMESPACE, labels, annotations: profileAnnotations },
          spec: { storageClassName, accessModes: ['ReadWriteOnce'], volumeMode: 'Filesystem', resources: { requests: { storage: '2Gi' } } } };
        try { pvc = await api.request('POST', apiPath('persistentvolumeclaims'), body, { signal: scope.signal }); }
        catch (error) {
          uncertainProfile = !error.status || error.status >= 500;
          // Read back an acknowledged conflict or possibly committed creation.
          if (error.status !== 409 && !uncertainProfile) throw error;
          pvc = await get('persistentvolumeclaims', record.pvcName);
          if (!pvc) throw fail('profile_create_unconfirmed');
        }
      }
      if (!ownsProfile(pvc)) throw fail('profile_identity_conflict');
      uncertainProfile = false;
      await persist({ phase: 'provisioning', pvcUid: pvc.metadata.uid }); guard();
      if (await get('pods', record.podName, scope.signal)) throw fail('pod_already_exists'); guard();
      const seccompProfile = { type: 'Localhost', localhostProfile: configuration.seccompProfile };
      const securityContext = { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001,
        allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile };
      const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: record.podName, namespace: NAMESPACE, labels, annotations }, spec: {
        restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false, serviceAccountName: 'lilly-grok-worker',
        terminationGracePeriodSeconds: 10, activeDeadlineSeconds: 900,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
          fsGroupChangePolicy: 'OnRootMismatch', seccompProfile },
        containers: [{ name: 'worker', image: configuration.image, imagePullPolicy: 'IfNotPresent', securityContext,
          command: ['/bin/sleep', 'infinity'], workingDir: '/opt/lilly-browser',
          resources: { requests: { cpu: '100m', memory: '256Mi', 'ephemeral-storage': '64Mi' },
            limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '256Mi' } },
          env: [{ name: 'HOME', value: '/tmp' }, { name: 'LILLY_COMPUTER_IDENTITY', value: JSON.stringify(normalizeIdentity(identity)) },
            { name: 'LILLY_PROFILE_LEASE_ID', value: record.leaseId }],
          volumeMounts: [{ name: 'profile', mountPath: '/profiles' }, { name: 'tmp', mountPath: '/tmp' }, { name: 'shm', mountPath: '/dev/shm' }],
          readinessProbe: { exec: { command: ['/bin/test', '-r', ENTRYPOINT] }, periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 10 },
        }], volumes: [{ name: 'profile', persistentVolumeClaim: { claimName: record.pvcName } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '128Mi' } }, { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '128Mi' } }],
      } };
      podAttempted = true;
      let created;
      try { created = await api.request('POST', apiPath('pods'), pod, { signal: scope.signal }); }
      catch (error) { uncertainPod = !error.status || error.status >= 500; throw error; }
      uncertainPod = true; // Clear only after exact identity and durable binding.
      await bindPod(created); uncertainPod = false; guard();
      const until = Date.now() + readyTimeoutMs;
      let current;
      while (true) {
        guard(); current = await get('pods', record.podName, scope.signal); guard();
        if (!ownsPod(current) || current.metadata.deletionTimestamp) throw fail('pod_identity_conflict');
        if (['Failed', 'Succeeded'].includes(current.status?.phase)) throw fail('pod_not_running');
        const status = current.status?.containerStatuses?.find(value => value.name === 'worker');
        if (status?.ready && status.state?.running) break;
        if (Date.now() >= until) throw fail('ready_timeout');
        await delay(pollMs);
      }
      const verifyRunning = value => {
        if (!ownsPod(value) || value.metadata.deletionTimestamp) throw fail('pod_identity_conflict');
        const worker = value.spec?.containers?.find(item => item.name === 'worker');
        const status = value.status?.containerStatuses?.find(item => item.name === 'worker');
        const security = worker?.securityContext;
        const volumes = value.spec?.volumes || [];
        if (value.spec?.restartPolicy !== 'Never' || value.spec.automountServiceAccountToken !== false
          || ['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace'].some(key => value.spec[key] === true)
          || value.spec.containers.length !== 1 || value.spec.initContainers?.length || value.spec.ephemeralContainers?.length
          || security?.runAsUser !== 10001 || security.runAsGroup !== 10001 || security.runAsNonRoot !== true
          || security.allowPrivilegeEscalation !== false || security.readOnlyRootFilesystem !== true || security.privileged === true
          || security.capabilities?.add?.length || !security.capabilities?.drop?.includes('ALL')
          || security.seccompProfile?.type !== 'Localhost' || security.seccompProfile.localhostProfile !== configuration.seccompProfile
          || volumes.length !== 3 || volumes.some(volume => volume.secret || volume.hostPath || volume.projected)
          || volumes.find(volume => volume.name === 'profile')?.persistentVolumeClaim?.claimName !== record.pvcName
          || !['tmp', 'shm'].every(key => volumes.find(volume => volume.name === key)?.emptyDir?.medium === 'Memory')
          || worker.volumeMounts?.length !== 3 || !pod.spec.containers[0].volumeMounts.every(expected =>
            worker.volumeMounts.some(actual => actual.name === expected.name && actual.mountPath === expected.mountPath
              && !actual.subPath && !actual.subPathExpr))) throw fail('sandbox_unverified');
        if (worker?.image !== configuration.image || !status?.ready || !status.state?.running
          || !status.imageID?.endsWith(`@${configuration.image.split('@')[1]}`)
          || !/^containerd:\/\/[a-f0-9]{64}$/.test(status.containerID || '') || (status.restartCount ?? 0) !== 0
          || (record.containerId && record.containerId !== status.containerID)) throw fail('image_unverified');
      };
      verifyRunning(current);
      await bindPod(current); guard();
      // Persist a double-sampled node/kernel/cgroup owner before the first exec.
      // An API container ID alone cannot support recovery after Pod deletion.
      const bindingSignal = new AbortController(); let bindingTimer; let rejectBinding;
      const cancelledBinding = new Promise((_, reject) => { rejectBinding = reject; });
      const cancelBinding = () => { bindingSignal.abort(); rejectBinding(fail('node_binding_cancelled')); };
      scope.signal?.addEventListener('abort', cancelBinding, { once: true });
      bindingTimer = setTimeout(cancelBinding, Math.max(1, until - Date.now()));
      let nodeBinding;
      try {
        guard();
        nodeBinding = normalizeBrowserBinding(await Promise.race([
          Promise.resolve().then(() => { guard(); return bindContainer({ identity, lease: { ...record }, nodeName: current.spec.nodeName, signal: bindingSignal.signal }); }),
          cancelledBinding,
        ]), record);
      } finally { clearTimeout(bindingTimer); scope.signal?.removeEventListener('abort', cancelBinding); }
      guard();
      if (nodeBinding.nodeName !== current.spec.nodeName) throw fail('node_binding_conflict');
      await persist({ phase: 'provisioning', nodeBinding }); guard();
      await persist({ phase: 'ready' }); guard();
      // Persistence can yield long enough for deletion/replacement. Re-read
      // exact Pod/container and profile immediately before the one exec attempt.
      current = await get('pods', record.podName, scope.signal); guard(); verifyRunning(current);
      if (current.spec.nodeName !== record.nodeBinding.nodeName) throw fail('node_binding_conflict');
      if (!ownsProfile(await get('persistentvolumeclaims', record.pvcName, scope.signal))) throw fail('profile_identity_conflict');
      guard();
      child = api.exec({ namespace: NAMESPACE, podName: record.podName, container: 'worker',
        command: ['/usr/local/bin/node', ENTRYPOINT, '--serve'], signal: scope.signal, maxBytes: 16 * 1024 * 1024 });
      // Drain and discard stderr; it is never an operator terminal or audit log.
      child.stderr.on('data', () => {}); child.stderr.on('error', () => {});
      computer = connectComputer({ input: child.stdout, output: child.stdin, authorize: scope.authorize, terminate: stop });
      scope.signal?.addEventListener('abort', aborted, { once: true }); guard();
      return { computer, close: stop, confirmClosed };
    } catch (error) {
      await stop();
      throw error.code?.startsWith('computer_supervisor_') ? error : fail('provision_failed');
    }
  };
}

// Composition entrypoint for createTeamRuntime's trusted computerFactory. It
// constructs no resources until the first authorized computer_open of a claim.
function createKubernetesComputerRuntime({ service, authorize, configuration, bindContainer, requestStop, captureStop, observeTermination, cluster, maxComputers } = {}) {
  return createSupervisedComputerRuntime({ authorize, maxComputers,
    createLease: createKubernetesComputerFactory({ service, configuration, bindContainer, requestStop, captureStop, observeTermination, cluster }) });
}

module.exports = { createKubernetesComputerFactory, createKubernetesComputerRuntime };
