'use strict';

// Test-only derivation from the inspected host default. Chromium needs to enter
// its own child namespaces. Do not use unconfined mode, grant SYS_ADMIN, or
// alter any other syscall policy. The kernel still checks namespace ownership.
function browserNamespaceProfile(input, { chroot = false } = {}) {
  const invalid = () => { throw new Error('Unsupported default seccomp policy; review required.'); };
  if (!input || input.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(input.syscalls)
    || JSON.stringify(input).length > 256 * 1024) invalid();
  const policy = JSON.parse(JSON.stringify(input));
  const empty = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  const unconditionalAllow = policy.syscalls.some(rule => rule.action === 'SCMP_ACT_ALLOW'
    && rule.names?.includes('setns') && Array.isArray(rule.args) && rule.args.length === 0 && empty(rule.includes) && empty(rule.excludes));
  const denied = policy.syscalls.filter(rule => rule.names?.includes('setns') && rule.action !== 'SCMP_ACT_ALLOW');
  if (!unconditionalAllow || denied.length !== 1) invalid();
  const rule = denied[0];
  if (rule.action !== 'SCMP_ACT_ERRNO' || rule.errnoRet !== 1 || rule.errno !== 'EPERM'
    || !Array.isArray(rule.args) || rule.args.length !== 0 || !empty(rule.includes)
    || Object.keys(rule.excludes || {}).length !== 1 || JSON.stringify(rule.excludes.caps) !== '["CAP_SYS_ADMIN"]') invalid();
  rule.names = rule.names.filter(name => name !== 'setns');
  if (!rule.names.length) policy.syscalls = policy.syscalls.filter(entry => entry !== rule);
  if (chroot) {
    const rules = policy.syscalls.filter(entry => entry.names?.includes('chroot'));
    const allow = rules.find(entry => entry.action === 'SCMP_ACT_ALLOW');
    const deny = rules.find(entry => entry.action === 'SCMP_ACT_ERRNO');
    if (rules.length !== 2 || !allow || !deny || rules.some(entry => JSON.stringify(entry.names) !== '["chroot"]'
      || !Array.isArray(entry.args) || entry.args.length !== 0)
      || JSON.stringify(allow.includes) !== '{"caps":["CAP_SYS_CHROOT"]}' || !empty(allow.excludes)
      || !empty(deny.includes) || JSON.stringify(deny.excludes) !== '{"caps":["CAP_SYS_CHROOT"]}'
      || deny.errnoRet !== 1 || deny.errno !== 'EPERM') invalid();
    // Chromium chroots inside its own user namespace before dropping its
    // namespace-local capabilities. No capability is added to the container.
    allow.includes = {};
    policy.syscalls = policy.syscalls.filter(entry => entry !== deny);
  }
  return policy;
}
module.exports = { browserNamespaceProfile };
