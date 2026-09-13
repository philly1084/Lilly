'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { normalizeIdentity } = require('./runtime');
const { normalizeRecoveryHelperIdentity, normalizeRecoveryHelperBinding, normalizeRecoveryHelperStop, isRecoveryHelperClosed } = require('./recovery-helper');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const fail = () => Object.assign(new Error('Private recovery helper lifecycle is unconfirmed.'), { code: 'computer_recovery_lifecycle_unknown' });
const NAMESPACE = 'lilly-team-workers';

// Inactive trusted factory. requestStop targets the exact bound container on its
// owning node; captureStop must positively observe AND archive its stop before
// Kubernetes deletion can garbage-collect runtime evidence. Neither callback
// may treat Pod absence, a timeout or a successful signal request as termination.
function createRecoverySupervisor({ service, cluster, configuration, controller, bindContainer, requestStop, captureStop } = {}) {
  if (!['get', 'reserveComputerRecoveryHelper', 'beginComputerRecoveryHelperLaunch', 'recordComputerRecoveryHelper'].every(key => typeof service?.[key] === 'function')
    || typeof cluster?.request !== 'function' || typeof controller?.recover !== 'function'
    || ![bindContainer, requestStop, captureStop].every(value => typeof value === 'function')
    || configuration?.namespace !== NAMESPACE || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(configuration.image || '')) throw fail();
  const timeoutMs = configuration.timeoutMs ?? 30000; const pollMs = configuration.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10000) throw fail();
  const pending = new Map();
  const apiPath = (kind, name) => `/api/v1/namespaces/${NAMESPACE}/${kind}${name ? `/${name}` : ''}`;
  const get = async (kind, name, signal) => {
    try { return await cluster.request('GET', apiPath(kind, name), undefined, { signal }); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  const guard = signal => { if (signal?.aborted) throw fail(); };
  const bounded = (run, signal) => new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(fail()); };
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { guard(signal); return run(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
  const owned = async identity => {
    const team = await service.get(identity.teamId, identity.ownerId);
    const task = team.tasks?.find(value => value.id === identity.taskId && value.agentId === identity.agentId);
    const lease = task?.computerLease;
    if (team.id !== identity.teamId || team.ownerId !== identity.ownerId || !lease
      || task.worker?.id !== identity.claim.workerId || task.worker.claimId !== identity.claim.claimId
      || lease.claimId !== identity.claim.claimId || lease.ownerBootId !== task.worker.executionOwner?.bootId) throw fail();
    return lease;
  };
  const update = async (identity, helper, value) => {
    try { return await service.recordComputerRecoveryHelper(identity, { helperId: helper.helperId, ...value }); }
    catch {
      const stored = (await owned(identity)).recoveryHelper;
      if (stored?.helperId !== helper.helperId || Object.keys(value).some(key => !same(stored[key], value[key]))) throw fail();
      return stored;
    }
  };
  const annotations = helper => ({ 'lilly.ai/lease-id': helper.leaseId, 'lilly.ai/recovery-id': helper.helperId,
    'lilly.ai/owner-boot': helper.ownerBootId, 'lilly.ai/profile-key': helper.profileKey });
  const podOwned = (pod, helper) => pod?.metadata?.namespace === NAMESPACE && pod.metadata.name === helper.podName
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pod.metadata.uid || '')
    && (!helper.podUid || pod.metadata.uid === helper.podUid)
    && Object.entries(annotations(helper)).every(([key, value]) => pod.metadata.annotations?.[key] === value);
  const manifest = (lease, helper) => {
    const seccompProfile = { type: 'RuntimeDefault' };
    return { apiVersion: 'v1', kind: 'Pod', metadata: { namespace: NAMESPACE, name: helper.podName, annotations: annotations(helper),
      labels: { 'app.kubernetes.io/name': 'lilly-profile-recovery' } }, spec: {
      nodeName: lease.nodeBinding.nodeName, restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
      serviceAccountName: 'lilly-grok-worker', terminationGracePeriodSeconds: 10, activeDeadlineSeconds: 300,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile },
      containers: [{ name: 'worker', image: helper.image, imagePullPolicy: 'IfNotPresent', command: ['/bin/sleep', 'infinity'],
        workingDir: '/opt/lilly-recovery', env: [{ name: 'HOME', value: '/tmp' }],
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile },
        resources: { requests: { cpu: '50m', memory: '64Mi', 'ephemeral-storage': '16Mi' }, limits: { cpu: '1', memory: '128Mi', 'ephemeral-storage': '32Mi' } },
        volumeMounts: [{ name: 'profiles', mountPath: '/profiles' }, { name: 'tmp', mountPath: '/tmp' }],
      }], volumes: [{ name: 'profiles', persistentVolumeClaim: { claimName: helper.pvcName } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
    } };
  };
  const verifyPod = (pod, lease, helper) => {
    const expected = manifest(lease, helper).spec; const actual = pod?.spec;
    if (!podOwned(pod, helper) || pod.metadata.deletionTimestamp || !actual
      || ['hostPID', 'hostIPC', 'hostNetwork', 'shareProcessNamespace'].some(key => actual[key])
      || actual.initContainers?.length || actual.ephemeralContainers?.length || actual.containers?.length !== 1) throw fail();
    for (const key of ['nodeName', 'restartPolicy', 'automountServiceAccountToken', 'enableServiceLinks', 'serviceAccountName',
      'activeDeadlineSeconds', 'terminationGracePeriodSeconds', 'securityContext', 'volumes']) if (!same(actual[key], expected[key])) throw fail();
    const worker = actual.containers[0]; const desired = expected.containers[0];
    for (const key of Object.keys(desired)) if (!same(worker[key], desired[key])) throw fail();
    if (worker.envFrom?.length || worker.lifecycle || worker.ports?.length || worker.args?.length) throw fail();
    const statuses = pod.status?.containerStatuses; const status = statuses?.[0];
    if (statuses?.length !== 1 || status.name !== 'worker' || status.restartCount !== 0 || !status.state?.running
      || !status.imageID?.endsWith(`@${helper.image.split('@')[1]}`) || !/^containerd:\/\/[a-f0-9]{64}$/.test(status.containerID || '')
      || (helper.containerId && helper.containerId !== status.containerID)) throw fail();
    return status;
  };
  const once = async (identity, externalSignal) => {
    const abort = new AbortController(); const cancel = () => abort.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs); const signal = abort.signal;
    const wait = () => new Promise((resolve, reject) => {
      const done = () => { clearTimeout(tick); signal.removeEventListener('abort', stopped); signal.aborted ? reject(fail()) : resolve(); };
      const stopped = () => done(); const tick = setTimeout(done, pollMs); signal.addEventListener('abort', stopped, { once: true }); if (signal.aborted) done();
    });
    try {
      if (externalSignal?.aborted) cancel(); guard(signal);
      let lease = await owned(identity); guard(signal);
      if (lease.profileRecovery && !lease.recoveryHelper) return normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
      if (!lease.recoveryHelper) {
        try { await service.reserveComputerRecoveryHelper(identity, { helperId: randomUUID(), image: configuration.image }); }
        catch { /* Read back a competing reservation or lost committed reply. */ }
        lease = await owned(identity); guard(signal);
      }
      let helper = lease.recoveryHelper; normalizeRecoveryHelperIdentity(lease, helper);
      if (helper.namespace !== NAMESPACE || helper.image !== configuration.image) throw fail();
      if (helper.phase === 'closed') {
        if (!isRecoveryHelperClosed(lease)) throw fail();
        return normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
      }
      if (['reserved', 'provisioning'].includes(helper.phase)) {
        const pvc = await get('persistentvolumeclaims', helper.pvcName, signal); guard(signal);
        if (pvc?.metadata?.namespace !== NAMESPACE || pvc.metadata.name !== helper.pvcName || pvc.metadata.uid !== helper.pvcUid
          || pvc.metadata.deletionTimestamp || pvc.metadata.annotations?.['lilly.ai/identity'] !== lease.identityHash
          || pvc.status?.phase !== 'Bound' || pvc.spec?.storageClassName !== 'local-path' || pvc.spec.volumeMode !== 'Filesystem'
          || !same(pvc.spec.accessModes, ['ReadWriteOnce'])) throw fail();
        let launch;
        try { launch = await service.beginComputerRecoveryHelperLaunch(identity, { helperId: helper.helperId }); }
        catch { launch = { dispatch: false }; }
        lease = await owned(identity); helper = lease.recoveryHelper; guard(signal);
        let pod = await get('pods', helper.podName, signal); guard(signal);
        if (!pod && launch.dispatch === true) {
          try { pod = await cluster.request('POST', apiPath('pods'), manifest(lease, helper), { signal }); }
          catch { pod = await get('pods', helper.podName, signal); }
          guard(signal);
        }
        // No POST replay when its result is unknown or a restarted controller
        // finds an intent without an object. Keep the same durable ownership.
        if (!pod || !podOwned(pod, helper)) throw fail();
        helper = await update(identity, helper, { phase: 'provisioning', podUid: pod.metadata.uid });
        while (true) {
          guard(signal); pod = await get('pods', helper.podName, signal); guard(signal);
          if (!podOwned(pod, helper) || pod.metadata.deletionTimestamp || ['Succeeded', 'Failed'].includes(pod.status?.phase)) throw fail();
          if (pod.status?.containerStatuses?.[0]?.state?.running) break;
          await wait();
        }
        const status = verifyPod(pod, lease, helper);
        helper = await update(identity, helper, { phase: 'provisioning', containerId: status.containerID });
        lease = await owned(identity); guard(signal);
        const binding = normalizeRecoveryHelperBinding(lease, helper, await bounded(() => bindContainer({ lease, signal }), signal)); guard(signal);
        helper = await update(identity, helper, { phase: 'ready', nodeBinding: binding });
      }
      lease = await owned(identity); helper = lease.recoveryHelper; guard(signal);
      if (helper.phase === 'ready') {
        verifyPod(await get('pods', helper.podName, signal), lease, helper); guard(signal);
        await bounded(() => controller.recover(identity, { signal }), signal); guard(signal);
        lease = await owned(identity); helper = lease.recoveryHelper;
        normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
        helper = await update(identity, helper, { phase: 'closing' });
      }
      if (!['closing', 'reconciliation'].includes(helper.phase)) throw fail();
      normalizeProfileRecoveryEvidence(lease, lease.profileRecovery); guard(signal);
      lease = await owned(identity); helper = lease.recoveryHelper;
      let receipt = helper.stopEvidence;
      if (!receipt) {
        await bounded(() => requestStop({ identity, lease, signal }), signal); guard(signal);
        while (!receipt) {
          const currentLease = await owned(identity); guard(signal);
          receipt = await bounded(() => captureStop({ identity, lease: currentLease, signal }), signal); guard(signal);
          if (!receipt) await wait();
        }
        receipt = normalizeRecoveryHelperStop(lease, helper, receipt);
        helper = await update(identity, helper, { phase: 'closing', stopEvidence: receipt });
      } else normalizeRecoveryHelperStop(lease, helper, receipt);
      // Runtime death is already recorded. Delete only the exact Kubernetes UID,
      // then require absence before accepting helper closure. Never delete PVCs.
      let pod = await get('pods', helper.podName, signal); guard(signal);
      if (pod) {
        if (!podOwned(pod, helper)) throw fail();
        try { await cluster.request('DELETE', apiPath('pods', helper.podName), { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: helper.podUid } }, { signal }); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      while ((pod = await get('pods', helper.podName, signal))) {
        guard(signal); if (!podOwned(pod, helper)) throw fail(); await wait();
      }
      guard(signal); await update(identity, helper, { phase: 'closed' });
      lease = await owned(identity);
      if (!isRecoveryHelperClosed(lease)) throw fail();
      return normalizeProfileRecoveryEvidence(lease, lease.profileRecovery);
    } catch { throw fail(); }
    finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); }
  };
  return {
    recover(input, { signal } = {}) {
      let identity; let key;
      try {
        if (signal?.aborted) throw fail();
        const claim = {};
        for (const field of ['taskId', 'workerId', 'claimId']) {
          if (typeof input?.claim?.[field] !== 'string' || !input.claim[field] || input.claim[field].length > 256) throw fail();
          claim[field] = input.claim[field];
        }
        if (input.taskId !== claim.taskId) throw fail();
        identity = { ...normalizeIdentity(input), taskId: input.taskId, claim }; key = JSON.stringify(identity);
        if (pending.has(key)) return pending.get(key); if (pending.size >= 16) throw fail();
      } catch { return Promise.reject(fail()); }
      const work = once(identity, signal).finally(() => pending.delete(key)); pending.set(key, work); return work;
    },
  };
}

module.exports = { createRecoverySupervisor };
