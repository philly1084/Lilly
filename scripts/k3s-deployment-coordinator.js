#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const {
  buildLeasePatch, buildReleasePatch, buildRenewPatch, chooseLeaseAction,
  buildDeploymentImagePatch, hashConfigData, provenanceAnnotations, normalizeIdentity,
} = require('../src/deployment-coordination');

function parseArgs(argv) {
  const options = { action: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--') { options.command = argv.slice(i + 1); break; }
    if (!argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Expected an option and value at ${argv[i]}`);
    }
    options[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return options;
}

function bounded(value, fallback, min = 1, max = 3600) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid bounded time option');
  return n;
}

// execFile's asynchronous API ignores an `input` option. Explicitly close stdin,
// and keep the child/process group alive until it has exited before releasing a lock.
function execute(file, args, { input, signal, timeout = 30000, inherit = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Release cancelled')); return; }
    const child = spawn(file, args, {
      env, detached: process.platform !== 'win32',
      stdio: inherit ? ['inherit', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', failure, killTimer;
    const kill = (sig) => {
      try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); }
      catch (error) { if (error.code !== 'ESRCH') failure ||= error; }
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const abort = () => stop(signal.reason || new Error('Release cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error(`${file} timed out`)), timeout);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) stop(new Error('Command output exceeded limit'));
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.stdin?.on('error', (error) => { if (error.code !== 'EPIPE') stop(error); });
    child.stdin?.end(input || '');
    child.once('error', (error) => { failure = error; });
    child.once('close', (code, sig) => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) {
        const error = failure || new Error(`${file} failed (${code ?? sig})`);
        error.stderr = stderr; error.code ??= code;
        reject(error);
      } else resolve(stdout.trim());
    });
  });
}

async function kubectl(args, input, context, timeout) {
  return execute('kubectl', args, { input, signal: context?.signal, timeout });
}
async function getLease(o) {
  const raw = await kubectl(['get', 'lease', o.leaseName, '-n', o.namespace, '--ignore-not-found', '-o', 'json']);
  return raw ? JSON.parse(raw) : null;
}
async function deployment(o, name = o.deployment) {
  return JSON.parse(await kubectl(['get', 'deployment', name, '-n', o.namespace, '-o', 'json']));
}
function settings(options) {
  const namespace = options.namespace || process.env.KIMIBUILT_RELEASE_NAMESPACE || 'kimibuilt';
  return {
    ...options, namespace, deployment: options.deployment || 'backend', container: options.container || 'backend',
    leaseName: options.leaseName || 'deployment-coordination',
    owner: normalizeIdentity(options.owner || process.env.KIMIBUILT_RELEASE_OWNER || `release-${crypto.randomUUID()}`),
    expectedImage: options.expectedImage || process.env.KIMIBUILT_RELEASE_EXPECTED_IMAGE,
    sourceSha: options.sourceSha || process.env.KIMIBUILT_RELEASE_SOURCE_SHA,
    leaseDurationSeconds: bounded(options.leaseDurationSeconds, 120, 60, 600),
    waitSeconds: bounded(options.waitSeconds, 300, 1, 1800),
  };
}
async function assertImage(o) {
  if (!o.expectedImage) throw new Error('--expected-image is required');
  const d = await deployment(o);
  const actual = d.spec.template.spec.containers.find((c) => c.name === o.container)?.image;
  if (actual !== o.expectedImage) throw new Error(`Image CAS rejected: expected ${o.expectedImage}, found ${actual}`);
  return d;
}
async function assertFreshSource(o) {
  if (!/^[0-9a-f]{40}$/i.test(o.sourceSha || '')) throw new Error('--source-sha must be a full commit SHA');
  const head = await execute('git', ['rev-parse', 'HEAD']);
  if (head !== o.sourceSha) throw new Error('Source SHA does not match this checkout');
  const remote = await execute('git', ['ls-remote', 'origin', 'refs/heads/master']);
  if (remote.split(/\s+/)[0] !== o.sourceSha) throw new Error('Stale release: source is no longer origin/master');
}
async function assertOwned(o) {
  const lease = await getLease(o);
  const until = Date.parse(lease?.spec?.renewTime || '') + Number(lease?.spec?.leaseDurationSeconds || 0) * 1000;
  if (lease?.spec?.holderIdentity !== o.owner || !Number.isFinite(until) || Date.now() >= until) {
    throw new Error('Release Lease ownership was lost or expired');
  }
  return lease;
}
async function release(o) {
  const lease = await getLease(o);
  if (lease?.spec?.holderIdentity !== o.owner) return false;
  await kubectl(['patch', 'lease', o.leaseName, '-n', o.namespace, '--type=json', '-p', JSON.stringify(buildReleasePatch(lease, o.owner))]);
  return true;
}
async function acquire(o, signal) {
  const end = Date.now() + o.waitSeconds * 1000;
  while (Date.now() < end) {
    if (signal.aborted) throw signal.reason;
    const lease = await getLease(o);
    const action = chooseLeaseAction(lease, { owner: o.owner });
    if (action === 'owned') throw new Error('Owner identity is already in use; use a unique owner');
    try {
      if (action === 'create') {
        const now = new Date().toISOString().replace(/Z$/, '000Z');
        await kubectl(['create', '-f', '-'], JSON.stringify({
          apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
          metadata: { name: o.leaseName, namespace: o.namespace },
          spec: { holderIdentity: o.owner, acquireTime: now, renewTime: now, leaseDurationSeconds: o.leaseDurationSeconds },
        }));
        return;
      }
      if (action === 'takeover') {
        await kubectl(['patch', 'lease', o.leaseName, '-n', o.namespace, '--type=json', '-p', JSON.stringify(buildLeasePatch(lease, o))]);
        return;
      }
    } catch (error) {
      if (!/AlreadyExists|Conflict|test failed|test operation|object has been modified/.test(error.stderr || '')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for release Lease ${o.namespace}/${o.leaseName}`);
}

async function withLease(options, operation) {
  const o = settings(options);
  const inherited = process.env.KIMIBUILT_RELEASE_OWNER;
  const controller = new AbortController();
  const cancelled = () => controller.abort(new Error('Release cancelled by signal'));
  process.once('SIGTERM', cancelled); process.once('SIGINT', cancelled);
  let acquired = false, timer, renewal = Promise.resolve(), stopped = false;
  const context = { ...o, signal: controller.signal, assertOwned: async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    return assertOwned(o);
  } };
  try {
    if (inherited) {
      if (inherited !== o.owner || process.env.KIMIBUILT_RELEASE_NAMESPACE !== o.namespace) throw new Error('Nested release owner or namespace mismatch');
      await context.assertOwned();
    } else {
      await acquire(o, controller.signal); acquired = true;
      const renew = () => {
        renewal = (async () => {
          const lease = await assertOwned(o);
          await kubectl(['patch', 'lease', o.leaseName, '-n', o.namespace, '--type=json', '-p', JSON.stringify(buildRenewPatch(lease, o))]);
        })().catch((error) => controller.abort(error)).finally(() => {
          if (!stopped && !controller.signal.aborted) timer = setTimeout(renew, 10000);
        });
      };
      timer = setTimeout(renew, 10000);
    }
    await assertFreshSource(o);
    await assertImage(o);
    await context.assertOwned();
    const result = await operation(context);
    await context.assertOwned();
    return result;
  } finally {
    stopped = true; clearTimeout(timer); await renewal;
    if (acquired) await release(o);
    process.removeListener('SIGTERM', cancelled); process.removeListener('SIGINT', cancelled);
  }
}

async function configChecksum(o, name) {
  const obj = JSON.parse(await kubectl(['get', 'configmap', name, '-n', o.namespace, '-o', 'json']));
  return hashConfigData({ data: obj.data || {}, binaryData: obj.binaryData || {} });
}
async function deployBackend(o) {
  if (!o.image) throw new Error('--image is required');
  await o.assertOwned();
  await assertImage(o);
  if (o.configFile) await kubectl(['apply', '-f', o.configFile], null, o);
  const checksum = o.configMap ? await configChecksum(o, o.configMap) : '';
  await assertFreshSource(o);
  const current = await assertImage(o);
  const annotations = provenanceAnnotations({
    releaseId: o.releaseId || o.owner, sourceSha: o.sourceSha, image: o.image,
    previousImage: o.expectedImage, configChecksum: checksum, actor: o.actor || process.env.GITHUB_ACTOR || process.env.USER,
  });
  const patch = buildDeploymentImagePatch(current, { expectedImage: o.expectedImage, image: o.image, container: o.container, annotations });
  if (o.imagePullPolicy) {
    if (!['Always', 'IfNotPresent'].includes(o.imagePullPolicy)) throw new Error('Invalid image pull policy');
    const index = current.spec.template.spec.containers.findIndex((c) => c.name === o.container);
    patch.push({ op: 'add', path: `/spec/template/spec/containers/${index}/imagePullPolicy`, value: o.imagePullPolicy });
  }
  await o.assertOwned();
  await kubectl(['patch', 'deployment', o.deployment, '-n', o.namespace, '--type=json', '-p', JSON.stringify(patch)], null, o);
  const timeout = bounded(o.rolloutTimeoutSeconds, 600, 30, 1800);
  await kubectl(['rollout', 'status', `deployment/${o.deployment}`, '-n', o.namespace, `--timeout=${timeout}s`], null, o, (timeout + 10) * 1000);
  const live = await deployment(o);
  if (live.spec.template.spec.containers.find((c) => c.name === o.container)?.image !== o.image) throw new Error('Image changed during rollout');
  return { image: o.image, sourceSha: o.sourceSha, checksum };
}
async function applyFrontend(o) {
  if (!o.frontendConfigFile) return { skipped: true };
  await o.assertOwned();
  await kubectl(['apply', '-f', o.frontendConfigFile], null, o);
  const checksum = await configChecksum(o, 'kimibuilt-nginx-config');
  const current = await deployment(o, 'frontend');
  const index = current.spec.template.spec.containers.findIndex((c) => c.name === 'nginx');
  if (index < 0) throw new Error('Frontend nginx container missing');
  const annotations = { ...current.spec.template.metadata.annotations, 'kimibuilt.secdevsolutions.help/nginx-checksum': checksum };
  await o.assertOwned();
  await kubectl(['patch', 'deployment', 'frontend', '-n', o.namespace, '--type=json', '-p', JSON.stringify([
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    { op: 'add', path: `/spec/template/spec/containers/${index}/livenessProbe/httpGet/path`, value: '/_local/health' },
    { op: 'add', path: '/spec/template/metadata/annotations', value: annotations },
  ])], null, o);
  await kubectl(['rollout', 'status', 'deployment/frontend', '-n', o.namespace, '--timeout=180s'], null, o, 190000);
  return { liveness: '/_local/health', checksum };
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!['run', 'deploy-backend', 'deploy-release', 'apply-frontend'].includes(options.action)) throw new Error('Use run, deploy-backend, deploy-release or apply-frontend');
  return withLease(options, async (o) => {
    if (o.action === 'run') {
      if (!o.command?.length) throw new Error('run requires -- COMMAND ARGS');
      return execute(o.command[0], o.command.slice(1), {
        signal: o.signal, timeout: bounded(o.commandTimeoutSeconds, 1800, 1, 7200) * 1000, inherit: true,
        env: { ...process.env, KIMIBUILT_RELEASE_OWNER: o.owner, KIMIBUILT_RELEASE_NAMESPACE: o.namespace,
          KIMIBUILT_RELEASE_DEPLOYMENT: o.deployment, KIMIBUILT_RELEASE_CONTAINER: o.container,
          KIMIBUILT_RELEASE_EXPECTED_IMAGE: o.expectedImage, KIMIBUILT_RELEASE_SOURCE_SHA: o.sourceSha },
      });
    }
    if (o.action === 'apply-frontend') return applyFrontend(o);
    const backend = await deployBackend(o);
    const frontend = o.action === 'deploy-release' ? await applyFrontend(o) : undefined;
    return { backend, frontend };
  });
}
if (require.main === module) main().then((r) => console.log(JSON.stringify(r))).catch((e) => {
  console.error(e.message); process.exitCode = 1;
});
module.exports = { parseArgs, execute, withLease, main };
