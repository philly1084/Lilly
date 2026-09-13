'use strict';

const fs = require('node:fs/promises');
const { normalizeIdentity, identityKey } = require('./runtime');
const { normalizeRecoveryHelperIdentity, normalizeRecoveryHelperBinding } = require('./recovery-helper');
const { recoverProfile, inspectRecoveredProfile } = require('./profile-recovery');
const fail = () => Object.assign(new Error('Private profile helper request rejected.'), { code: 'computer_recovery_request_rejected' });
const MAX_REQUEST_BYTES = 65536;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;

async function readRequest(input) {
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length; if (bytes > MAX_REQUEST_BYTES) throw fail(); chunks.push(buffer);
      // Kubernetes v4 exec cannot half-close stdin without losing stdout.
      // A single newline-framed JSON request lets the helper finish while the
      // supervisor keeps that connection open for the authoritative exit status.
      const assembled = Buffer.concat(chunks); const newline = assembled.indexOf(10);
      if (newline !== -1) {
        if (assembled.subarray(newline + 1).toString('utf8').trim()) throw fail();
        return JSON.parse(assembled.subarray(0, newline).toString('utf8'));
      }
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fail(); }
}

async function kernelIdentity() {
  if (process.platform !== 'linux' || process.getuid() !== 10001 || process.getgid() !== 10001) throw fail();
  const [boot, pidNamespace, mountNamespace] = await Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readlink('/proc/self/ns/pid'), fs.readlink('/proc/self/ns/mnt'),
  ]);
  return { hostBootId: boot.trim(), pidNamespace, mountNamespace };
}

// Called only over private supervisor exec after host-side Pod, PVC/PV and
// opened-mount verification. Start via flock --exclusive --nonblock --no-fork
// /profiles node ... --recover|--inspect. No path, shell or operation is supplied
// by the model; one bounded JSON request arrives on stdin, terminated by LF or EOF.
async function runRecoveryRequest(request, { mode, signal, readKernel = kernelIdentity } = {}) {
  try {
    if (!['recover', 'inspect'].includes(mode) || signal?.aborted
      || !exact(request, ['version', 'identity', 'lease', 'root']) || request.version !== 1
      || !exact(request.root, ['device', 'inode']) || !uint(request.root.device) || !uint(request.root.inode) || request.root.inode === '0') throw fail();
    const { identity, lease } = request; const normalized = normalizeIdentity(identity);
    const helper = lease?.recoveryHelper;
    normalizeRecoveryHelperIdentity(lease, helper);
    const binding = normalizeRecoveryHelperBinding(lease, helper, helper.nodeBinding);
    if (!['closing', 'reconciliation'].includes(lease.phase) || !['ready', 'closing', 'reconciliation'].includes(helper.phase)
      || helper.stopEvidence || identityKey(normalized) !== helper.profileKey
      || identity.claim?.claimId !== lease.claimId || identity.taskId !== identity.claim?.taskId) throw fail();
    const kernel = await readKernel();
    if (signal?.aborted || kernel.hostBootId !== binding.hostBootId || kernel.pidNamespace !== `pid:[${binding.pidNamespace}]`
      || kernel.mountNamespace !== `mnt:[${binding.mountNamespace}]`) throw fail();
    const options = { rootDir: '/profiles', identity, lease, expectedRoot: request.root, signal };
    const filesystem = await (mode === 'recover' ? recoverProfile(options) : inspectRecoveredProfile(options));
    return { version: 1, helperId: helper.helperId, filesystem };
  } catch { throw fail(); }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGTERM', () => { controller.abort(); process.stdin.destroy(); });
  (async () => {
    if (process.argv.length !== 3 || !['--recover', '--inspect'].includes(process.argv[2])
      || Object.keys(process.env).some(key => /^(OPENAI_API_KEY|XAI_API_KEY|LILLY_MODEL_API_KEY|KUBECONFIG)$/.test(key))) throw fail();
    const request = await readRequest(process.stdin);
    const result = await runRecoveryRequest(request, { mode: process.argv[2].slice(2), signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch(() => { process.stderr.write('Private profile helper request rejected.\n'); process.exitCode = 1; process.stdin.destroy(); });
}

module.exports = { readRequest, runRecoveryRequest };
