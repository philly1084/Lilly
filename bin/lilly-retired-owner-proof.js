#!/usr/bin/env node
'use strict';

// Fixed-process Kubernetes fixture, never an agent. Cluster execution requires
// an explicitly approved sandbox and SAFE_APPLY=1; rendering is mutation-free.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createNodeContainerReader } = require('../src/agent-teams/node-container-reader');

function fixture({ proofId, namespace, image, nodeName }) {
  assert.match(proofId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(namespace, 'kimibuilt-async-lab', 'Only the explicitly reviewed lab is supported.');
  assert.match(image, /^ghcr\.io\/philly1084\/lilly@sha256:[a-f0-9]{64}$/);
  assert.match(nodeName, /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/);
  const name = `lilly-retired-proof-${proofId.slice(0, 8)}`;
  const labels = { 'lilly.proof-id': proofId };
  return {
    pod: { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace, labels }, spec: {
      nodeName, restartPolicy: 'Never', activeDeadlineSeconds: 180, terminationGracePeriodSeconds: 5,
      automountServiceAccountToken: false, enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'worker', image, imagePullPolicy: 'Never', command: ['/bin/sleep', '120'],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } } }],
    } },
    networkPolicy: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name, namespace, labels },
      spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] } },
  };
}

function command(binary, args, input) {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024, shell: false });
  if (result.status !== 0) throw new Error(`Fixture command failed: ${path.basename(binary)} ${args[0]}`);
  return result.stdout;
}

async function run({ namespace, image, nodeName, approved = process.env.SAFE_APPLY === '1' }) {
  assert.equal(approved, true, 'Explicit sandbox approval and SAFE_APPLY=1 are required.');
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); assert.equal(os.hostname(), nodeName);
  const proofId = randomUUID(); const manifests = fixture({ proofId, namespace, image, nodeName });
  const root = fs.mkdtempSync('/tmp/lilly-retired-owner-proof.'); fs.chmodSync(root, 0o700);
  const report = { proofId, namespace, nodeName, image, root, checks: [], modelsStarted: 0, projectFilesMounted: false, passed: false, cleaned: false, sourceSha256: {} };
  for (const file of ['bin/lilly-retired-owner-proof.js', 'src/agent-teams/node-container-reader.js',
    'src/agent-teams/retired-owner-reader.js', 'src/agent-teams/cgroup-reader.js', 'src/agent-teams/execution-owner.js']) {
    report.sourceSha256[file] = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex');
  }
  const kube = (...args) => command('/usr/local/bin/kubectl', ['--request-timeout=15s', '-n', namespace, ...args]);
  const create = (manifest, dry = false) => JSON.parse(command('/usr/local/bin/kubectl', ['--request-timeout=15s', '-n', namespace,
    'create', ...(dry ? ['--dry-run=server'] : []), '-f', '-', '-o', 'json'], JSON.stringify(manifest)));
  const resources = []; const reader = createNodeContainerReader();
  const owned = (kind, resource) => {
    const value = JSON.parse(kube('get', kind, resource.metadata.name, '-o', 'json'));
    assert.equal(value.metadata.uid, resource.metadata.uid); assert.equal(value.metadata.labels['lilly.proof-id'], proofId);
    return value;
  };
  process.stdout.write(`PROOF_HANDLE ${JSON.stringify({ proofId, root, podName: manifests.pod.metadata.name })}\n`);
  try {
    const lab = JSON.parse(kube('get', 'namespace', namespace, '-o', 'json'));
    assert.equal(lab.metadata.labels['kimibuilt.secdevsolutions.help/runtime-surface'], 'async-lab');
    assert.equal(kube('get', 'pod,networkpolicy', '-l', `lilly.proof-id=${proofId}`, '-o', 'name').trim(), '');
    create(manifests.networkPolicy, true); create(manifests.pod, true);
    report.checks.push('namespace_identity_inventory_and_server_dry_run');
    for (const [kind, manifest] of [['networkpolicy', manifests.networkPolicy], ['pod', manifests.pod]]) resources.push([kind, create(manifest)]);
    const pod = resources[1][1]; report.podUid = pod.metadata.uid;
    let current; const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      current = owned('pod', pod);
      if (current.status.containerStatuses?.[0]?.state?.running) break;
      await delay(500);
    }
    assert.equal(current.spec.restartPolicy, 'Never'); assert.ok(current.status.containerStatuses?.[0]?.state?.running);
    const containerId = current.status.containerStatuses[0].containerID;
    assert.match(containerId, /^containerd:\/\/[a-f0-9]{64}$/); report.containerId = containerId;
    const runtime = await reader.inspectContainer(containerId, nodeName);
    assert.equal(runtime.status.state, 'CONTAINER_RUNNING'); assert.equal(runtime.status.labels['io.kubernetes.pod.uid'], pod.metadata.uid);
    const initPid = runtime.info.pid;
    const kernel = await reader.observeProcess({ nodeName, initPid, ownerPid: 1 });
    assert.equal(kernel.init.namespacePid, 1);
    const group = await reader.observeCgroup({ nodeName, containerId, podUid: pod.metadata.uid, initPid, hostPid: initPid });
    assert.equal(group.populated, true);
    const binding = { nodeName, containerId, podUid: pod.metadata.uid, initPid, initStartTicks: kernel.init.startTicks,
      hostBootId: kernel.hostBootId, cgroup: group.identity };
    await assert.rejects(reader.readRetiredOwner(binding), { code: 'team_retired_owner_unknown' });
    report.checks.push('live_cri_private_pid1_and_cgroup_binding_rejects_retirement');
    owned('pod', pod);
    command('/usr/local/bin/crictl', ['--runtime-endpoint=unix:///run/k3s/containerd/containerd.sock', '--timeout=15s',
      'stop', '--timeout=5', containerId.slice(13)]);
    const retiredDeadline = Date.now() + 10000; let retired;
    while (Date.now() < retiredDeadline) {
      try { retired = await reader.readRetiredOwner(binding); break; } catch { await delay(250); }
    }
    assert.equal(retired?.retired, true, 'Original PID1 and its removed cgroup must be independently confirmed.');
    for (let index = 0; index < 2; index += 1) {
      const stopped = await reader.inspectContainer(containerId, nodeName);
      assert.equal(stopped.status.id, containerId.slice(13)); assert.equal(stopped.status.state, 'CONTAINER_EXITED');
      assert.equal(stopped.status.labels['io.kubernetes.pod.uid'], pod.metadata.uid);
      assert.equal((await reader.readRetiredOwner(binding)).retired, true);
    }
    report.binding = binding; report.checks.push('two_real_cri_exited_and_retired_kernel_owner_samples');
    await assert.rejects(reader.readRetiredOwner({ ...binding, hostBootId: randomUUID() }), { code: 'team_retired_owner_unknown' });
    report.checks.push('different_host_boot_rejected_after_real_container_exit'); report.passed = true;
  } catch (error) { report.failure = error.code || error.message; process.exitCode = 1; }
  finally {
    try {
      for (const [kind, resource] of resources.reverse()) {
        owned(kind, resource); kube('delete', kind, resource.metadata.name, '--wait=true', '--timeout=20s');
        assert.equal(kube('get', kind, resource.metadata.name, '--ignore-not-found', '-o', 'name').trim(), '');
      }
      report.cleaned = true;
    } catch { report.cleanupUnconfirmed = true; process.exitCode = 1; }
    fs.writeFileSync(path.join(root, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`PROOF_REPORT ${JSON.stringify(report)}\n`);
  }
  return report;
}

if (require.main === module) {
  const [mode, namespace, image, nodeName, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  if (mode === '--render') console.log(JSON.stringify(fixture({ proofId: randomUUID(), namespace, image, nodeName }), null, 2));
  else { assert.equal(mode, '--run-isolated'); run({ namespace, image, nodeName }).catch(() => { console.error('Retired-owner proof setup failed.'); process.exitCode = 1; }); }
}
module.exports = { fixture, run };
