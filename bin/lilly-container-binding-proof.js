#!/usr/bin/env node
'use strict';

// Explicit read-only diagnostic against one existing backend Pod. It samples
// PID 1, not a live team claim, and starts no model/browser/worker. No kube/CRI
// mutations, provider requests, environment reads or raw inspect output.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { bindExecutionContainer } = require('../src/agent-teams/container-binding');
const { createNodeContainerReader } = require('../src/agent-teams/node-container-reader');
const { createNodeOwnerBinder } = require('../src/agent-teams/node-owner-adapter');

function readCommand(args) {
  return execFileSync('/usr/local/bin/kubectl', args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
}

async function main() {
  const [flag, podName] = process.argv.slice(2);
  if (process.platform !== 'linux' || flag !== '--inspect-backend' || process.argv.length !== 4
    || !/^backend-[a-z0-9-]{1,55}$/.test(podName || '')) throw new Error('Invalid explicit backend target.');
  const readPod = async () => JSON.parse(readCommand(['get', 'pod', '-n', 'kimibuilt', podName, '-o', 'json']));
  const pod = await readPod();
  const observedAt = new Date().toISOString();
  const owner = { version: 1, bootId: randomUUID(), platform: 'linux', pid: 1, startedAt: observedAt,
    kernel: null, pod: { namespace: 'kimibuilt', name: podName, uid: pod.metadata.uid, containerName: 'backend' } };
  // Fixed diagnostic reads only: no host or container code files are modified.
  const script = "const f=require('node:fs');process.stdout.write(JSON.stringify({bootId:f.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),stat:f.readFileSync('/proc/1/stat','utf8'),pid:f.readlinkSync('/proc/1/ns/pid'),mnt:f.readlinkSync('/proc/1/ns/mnt')}));";
  const inside = JSON.parse(readCommand(['exec', '-n', 'kimibuilt', podName, '-c', 'backend', '--', 'node', '-e', script]));
  const { parseProcessStart, parseNamespace } = require('../src/agent-teams/execution-owner');
  owner.kernel = { bootId: inside.bootId, startTicks: parseProcessStart(inside.stat, 1),
    pidNamespace: parseNamespace(inside.pid, 'pid'), mountNamespace: parseNamespace(inside.mnt, 'mnt') };
  const readers = createNodeContainerReader();
  const binding = await bindExecutionContainer({ owner, readPod, ...readers });
  const bindOwner = createNodeOwnerBinder({ nodeName: pod.spec.nodeName, podNames: [podName], reader: readers,
    cluster: { request: async (method, route, body) => {
      assert.equal(method, 'GET'); assert.equal(route, `/api/v1/namespaces/kimibuilt/pods/${podName}`);
      assert.equal(body, undefined); return readPod();
    } } });
  const connected = await bindOwner({ owner });
  const { observedAt: firstAt, ...firstIdentity } = binding;
  const { observedAt: secondAt, ...secondIdentity } = connected;
  assert.deepEqual(secondIdentity, firstIdentity);
  const sourceSha256 = {};
  for (const file of ['bin/lilly-container-binding-proof.js', 'src/agent-teams/container-binding.js',
    'src/agent-teams/node-container-reader.js', 'src/agent-teams/execution-owner.js', 'src/agent-teams/cgroup-reader.js',
    'src/agent-teams/node-owner-adapter.js']) {
    sourceSha256[file] = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex');
  }
  const report = { proofId: randomUUID(), passed: true, observedAt, binding, sourceSha256,
    checks: ['direct_kernel_binding', 'scoped_node_owner_adapter_matches_same_live_container'],
    diagnosticPid: 1, liveClaimBound: false, terminationProven: false, modelsStarted: 0, resourcesChanged: false };
  const root = fs.mkdtempSync('/tmp/lilly-container-binding-proof.');
  fs.chmodSync(root, 0o700);
  const reportPath = path.join(root, 'proof-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ reportPath, ...report })}\n`);
}

if (require.main === module) main().catch(() => { process.stderr.write('Container binding diagnostic failed; no stop or takeover is authorized.\n'); process.exitCode = 1; });
