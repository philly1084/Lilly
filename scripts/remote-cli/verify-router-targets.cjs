#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const NAMESPACE = 'n8n-openai-gateway';
const DEPLOYMENT = 'n8n-openai-cli-gateway';
const TARGET_CONFIG = 'n8n-openai-cli-gateway-targets';
const ROOTS = ['/opt/kimibuilt', '/opt/lilly-agent-workbench'];
const EXPECTED_HOSTS = {
  'k3s-primary': '168.119.176.121',
  'k3s-secondary': '162.55.163.199',
  'k3s-prod': '168.119.176.121',
  prod: '168.119.176.121',
};
const MAINTENANCE = 'Ordinary Lilly releases never change or restart the shared router. Arrange separately approved gateway maintenance after active work is safely drained, then retry this release.';
const PROBE = 'const fs=require("fs");process.stdout.write(JSON.stringify({targets:fs.readFileSync("/app/config/remote-targets/targets.yaml","utf8"),roots:process.env.CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS||""}));';

function fail(message) {
  throw new Error(`Router target verification failed: ${message}. ${MAINTENANCE}`);
}

function normalizeYaml(value) {
  if (typeof value !== 'string' || !value.trim()) fail('target registry is missing');
  return value.replace(/\r\n/g, '\n').trimEnd();
}

function assertRoots(value) {
  const roots = typeof value === 'string' ? value.split(',').map((root) => root.trim()).filter(Boolean).sort() : [];
  if (JSON.stringify(roots) !== JSON.stringify([...ROOTS].sort())) fail('allowed workspace roots differ from the expected contract');
}

function assertTargetIdentities(yaml) {
  const actual = new Map();
  let target = '';
  for (const line of yaml.split('\n')) {
    const identity = line.match(/^\s*- targetId:\s*([\w-]+)\s*$/);
    if (identity) {
      target = identity[1];
      if (actual.has(target)) fail('duplicate target identity');
      actual.set(target, null);
    } else {
      const host = line.match(/^\s*host:\s*([\w.-]+)\s*$/);
      if (target && host) actual.set(target, host[1]);
    }
  }
  for (const [targetId, host] of Object.entries(EXPECTED_HOSTS)) {
    if (actual.get(targetId) !== host) fail(`target identity ${targetId} does not match its registered server`);
  }
}

function runKubectl(args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function verifyRouterTargets({ run = runKubectl, manifest = path.resolve(__dirname, '../../k8s/remote-cli-targets-configmap.yaml') } = {}) {
  const json = (args, label) => {
    try {
      const parsed = JSON.parse(run(args));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} returned invalid data`);
      return parsed;
    } catch {
      // Never dump Kubernetes responses, command stderr, or environment values.
      fail(`${label} could not be read and verified`);
    }
  };
  // Client-only decoding of the repository manifest, not a Kubernetes mutation.
  const desired = json(['create', '--dry-run=client', '--validate=false', '-f', manifest, '-o', 'json'], 'repository target manifest');
  if (desired.kind !== 'ConfigMap' || desired.metadata?.name !== TARGET_CONFIG || desired.metadata?.namespace !== NAMESPACE) fail('repository target manifest identity changed');
  const desiredYaml = normalizeYaml(desired.data?.['targets.yaml']);
  assertTargetIdentities(desiredYaml);
  const live = json(['get', 'configmap', TARGET_CONFIG, '-n', NAMESPACE, '-o', 'json'], 'live target ConfigMap');
  if (normalizeYaml(live.data?.['targets.yaml']) !== desiredYaml) fail('live target registry differs from the repository; existing targets were preserved');

  const deployment = json(['get', 'deployment', DEPLOYMENT, '-n', NAMESPACE, '-o', 'json'], 'router deployment');
  const spec = deployment.spec?.template?.spec;
  const volume = spec?.volumes?.find((entry) => entry.name === 'remote-cli-targets');
  if (volume?.configMap?.name !== TARGET_CONFIG) fail('router target volume points to a different ConfigMap');
  const containers = spec?.containers?.filter((container) => container.volumeMounts?.some((mount) => mount.name === 'remote-cli-targets')) || [];
  if (containers.length !== 1) fail('router target container is missing or ambiguous');
  const containerName = containers[0].name;
  assertRoots(containers[0].env?.find((entry) => entry.name === 'CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS')?.value);

  const labels = deployment.spec?.selector?.matchLabels;
  if (!labels || !Object.keys(labels).length || deployment.spec.selector.matchExpressions?.length) fail('router pod selector cannot be verified');
  const selector = Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',');
  const podList = json(['get', 'pods', '-n', NAMESPACE, '-l', selector, '-o', 'json'], 'router pods');
  const pods = podList.items;
  const replicas = deployment.spec.replicas ?? 1;
  if (!Array.isArray(pods) || !Number.isInteger(replicas) || replicas < 1 || pods.length !== replicas) fail('router replica inventory is unsettled');
  for (const pod of pods) {
    if (!pod.metadata?.name || pod.metadata.deletionTimestamp || pod.status?.phase !== 'Running'
        || !pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')) fail('router has a non-ready or terminating pod');
    const runtime = json(['exec', pod.metadata.name, '-n', NAMESPACE, '-c', containerName, '--', 'node', '-e', PROBE], 'mounted router target contract');
    if (normalizeYaml(runtime.targets) !== desiredYaml) fail('mounted router target registry differs from the repository');
    assertRoots(runtime.roots);
  }
  return { verified: true, pods: pods.length, changed: false };
}

if (require.main === module) {
  try {
    const result = verifyRouterTargets();
    console.log(`Router target registry verified in ${result.pods} ready pod(s). No router resources changed or restarted.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyRouterTargets, assertTargetIdentities, MAINTENANCE };
