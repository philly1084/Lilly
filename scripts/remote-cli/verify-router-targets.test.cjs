'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRouterTargets, assertTargetIdentities } = require('./verify-router-targets.cjs');

const TARGETS = `remoteCliTargets:
  - targetId: k3s-primary
    host: 168.119.176.121
  - targetId: k3s-secondary
    host: 162.55.163.199
  - targetId: k3s-prod
    host: 168.119.176.121
  - targetId: prod
    host: 168.119.176.121
`;
const ROOTS = '/opt/kimibuilt,/opt/lilly-agent-workbench';

function fixture() {
  const state = {
    desired: { kind: 'ConfigMap', metadata: { name: 'n8n-openai-cli-gateway-targets', namespace: 'n8n-openai-gateway' }, data: { 'targets.yaml': TARGETS } },
    live: { data: { 'targets.yaml': TARGETS } },
    deployment: {
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'n8n-openai-cli-gateway' } },
        template: { spec: {
          volumes: [{ name: 'remote-cli-targets', configMap: { name: 'n8n-openai-cli-gateway-targets' } }],
          containers: [{ name: 'gateway', volumeMounts: [{ name: 'remote-cli-targets', mountPath: '/app/config/remote-targets' }], env: [{ name: 'CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS', value: ROOTS }] }],
        } },
      },
    },
    pods: { items: [{ metadata: { name: 'gateway-123' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] },
    runtime: { targets: TARGETS, roots: ROOTS },
  };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'create') {
      assert.ok(args.includes('--dry-run=client'), 'manifest conversion must never create a resource');
      return JSON.stringify(state.desired);
    }
    if (args[0] === 'exec') {
      assert.deepEqual(args.slice(6, 10), ['--', 'node', '-e', args[9]]);
      assert.match(args[9], /fs\.readFileSync/);
      assert.doesNotMatch(args[9], /writeFile|process\.env\[|process\.env\)|console\.log\(process\.env/);
      return JSON.stringify(state.runtime);
    }
    assert.equal(args[0], 'get', 'unexpected mutation command');
    const key = { configmap: 'live', deployment: 'deployment', pods: 'pods' }[args[1]];
    assert.ok(key, 'unexpected resource read');
    return JSON.stringify(state[key]);
  };
  return { state, calls, run };
}

test('unchanged router is verified using only reads; active jobs require no restart or idle check', () => {
  const { run, calls } = fixture();
  assert.deepEqual(verifyRouterTargets({ run }), { verified: true, pods: 1, changed: false });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map((args) => args[0]), ['create', 'get', 'get', 'get', 'exec']);
  assert.ok(calls[0].includes('--dry-run=client'));
  assert.equal(calls.some((args) => args.some((arg) => /restart|apply|patch|delete|scale|remote-agent-tasks|provider-sessions/.test(arg))), false);
});

test('line endings and order of allowed roots do not manufacture configuration drift', () => {
  const { state, run } = fixture();
  state.live.data['targets.yaml'] = TARGETS.replace(/\n/g, '\r\n') + '\r\n';
  state.runtime.targets = TARGETS.trimEnd();
  state.runtime.roots = '/opt/lilly-agent-workbench, /opt/kimibuilt';
  assert.equal(verifyRouterTargets({ run }).verified, true);
});

test('extra live targets are preserved and drift fails before deployment or pod inspection', () => {
  const { state, run, calls } = fixture();
  state.live.data['targets.yaml'] += '  - targetId: k3s-primary-openrouter\n    host: 168.119.176.121\n';
  assert.throws(() => verifyRouterTargets({ run }), /existing targets were preserved.*separately approved gateway maintenance/);
  assert.equal(calls.length, 2);
});

test('changed target volume and workspace roots fail closed without mutation', () => {
  for (const change of [
    (state) => { state.deployment.spec.template.spec.volumes[0].configMap.name = 'different-targets'; },
    (state) => { state.deployment.spec.template.spec.containers[0].env[0].value = '/opt/kimibuilt'; },
    (state) => { state.deployment.spec.template.spec.containers[0].env[0] = { name: 'CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS', valueFrom: { secretKeyRef: { name: 'never-read', key: 'never-read' } } }; },
  ]) {
    const { state, run, calls } = fixture();
    change(state);
    assert.throws(() => verifyRouterTargets({ run }), /Router target verification failed/);
    assert.equal(calls.length, 3);
  }
});

test('missing, stale or unreadable mounted registry fails closed and errors cannot expose command data', () => {
  for (const value of ['', TARGETS.replace('162.55.163.199', 'wrong-host')]) {
    const { state, run } = fixture();
    state.runtime.targets = value;
    assert.throws(() => verifyRouterTargets({ run }), /separately approved gateway maintenance/);
  }
  const base = fixture();
  assert.throws(() => verifyRouterTargets({ run: (args) => {
    if (args[0] === 'exec') throw new Error('sensitive-content-must-not-be-printed');
    return base.run(args);
  } }), (error) => !error.message.includes('sensitive-content') && error.message.includes('could not be read and verified'));
});

test('nonready, terminating or unsettled replica inventories fail before exec', () => {
  for (const change of [
    (state) => { state.pods.items = []; },
    (state) => { state.pods.items[0].metadata.deletionTimestamp = '2026-09-03T12:00:00Z'; },
    (state) => { state.pods.items[0].status.conditions[0].status = 'False'; },
    (state) => { state.deployment.spec.replicas = 0; },
  ]) {
    const { state, run, calls } = fixture();
    change(state);
    assert.throws(() => verifyRouterTargets({ run }), /Router target verification failed/);
    assert.equal(calls.some((args) => args[0] === 'exec'), false);
  }
});

test('every ready replica must have the expected mounted contract', () => {
  const { state, run, calls } = fixture();
  state.deployment.spec.replicas = 2;
  state.pods.items.push({ ...state.pods.items[0], metadata: { name: 'gateway-456' } });
  assert.equal(verifyRouterTargets({ run }).pods, 2);
  assert.equal(calls.filter((args) => args[0] === 'exec').length, 2);
});

test('target identities and desired manifest identity remain an explicit release contract', () => {
  assert.throws(() => assertTargetIdentities(TARGETS.replace('162.55.163.199', '168.119.176.121')), /target identity/);
  assert.throws(() => assertTargetIdentities(TARGETS + '  - targetId: prod\n    host: 168.119.176.121\n'), /duplicate/);
  const { state, run, calls } = fixture();
  state.desired.metadata.namespace = 'somewhere-else';
  assert.throws(() => verifyRouterTargets({ run }), /manifest identity/);
  assert.equal(calls.length, 1);
});

test('ordinary Lilly deployment has no router target mutation or restart commands', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-k3s.yml'), 'utf8');
  assert.match(workflow, /node scripts\/remote-cli\/verify-router-targets\.cjs/);
  assert.doesNotMatch(workflow, /kubectl apply -f k8s\/remote-cli-targets-configmap\.yaml/);
  assert.doesNotMatch(workflow, /kubectl\s+(?:patch|set env|rollout restart)\s+deployment\/\$\{ROUTER_SERVICE\}/);
  assert.match(workflow, /kubectl rollout restart deployment\/backend/);
});
