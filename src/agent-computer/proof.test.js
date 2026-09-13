'use strict';
const { classifyFailure } = require('../../bin/lilly-computer-proof');
const { browserNamespaceProfile } = require('../../bin/lilly-browser-seccomp');
test.each(['No usable sandbox!', 'Failed to move to new namespace: Operation not permitted'])('private computer proof classifies sandbox failure without leaking launch diagnostics: %s', message => {
  expect(classifyFailure(new Error(`${message} PRIVATE_TOKEN`))).toBe('browser_sandbox_unavailable');
});
test('private computer proof does not return raw browser errors', () => {
  expect(classifyFailure(new Error('SECRET_URL'))).toBe('browser_proof_failed');
  expect(classifyFailure({ code: 'PRIVATE TOKEN https://secret' })).toBe('browser_proof_failed');
  expect(classifyFailure(new Error('Executable doesn\'t exist'))).toBe('browser_executable_unavailable');
});

const policyFixture = () => ({ defaultAction: 'SCMP_ACT_ERRNO', archMap: [{ architecture: 'SCMP_ARCH_AARCH64', subArchitectures: [] }], syscalls: [
  { names: ['read', 'clone', 'setns', 'unshare'], action: 'SCMP_ACT_ALLOW', args: [], includes: {}, excludes: {} },
  { names: ['setns', 'bpf', 'perf_event_open'], action: 'SCMP_ACT_ERRNO', args: [], includes: {}, excludes: { caps: ['CAP_SYS_ADMIN'] }, errnoRet: 1, errno: 'EPERM' },
] });

test('browser policy changes only the known setns denial and does not mutate the baseline', () => {
  const baseline = policyFixture(); const expected = policyFixture(); expected.syscalls[1].names = ['bpf', 'perf_event_open'];
  expect(browserNamespaceProfile(baseline)).toEqual(expected);
  expect(baseline).toEqual(policyFixture());
});

test.each(['unconfined', 'wrong_errno', 'conditional', 'missing_allow', 'multiple_denials', 'wrong_capability'])('browser policy rejects unsupported baseline: %s', mode => {
  const baseline = policyFixture();
  if (mode === 'unconfined') baseline.defaultAction = 'SCMP_ACT_ALLOW';
  if (mode === 'wrong_errno') baseline.syscalls[1].errnoRet = 38;
  if (mode === 'conditional') baseline.syscalls[1].args = [{ index: 1, value: 0, op: 'SCMP_CMP_EQ' }];
  if (mode === 'missing_allow') baseline.syscalls[0].names = ['read'];
  if (mode === 'multiple_denials') baseline.syscalls.push({ ...baseline.syscalls[1] });
  if (mode === 'wrong_capability') baseline.syscalls[1].excludes.caps = ['CAP_NET_ADMIN'];
  expect(() => browserNamespaceProfile(baseline)).toThrow('review required');
});

const chrootPolicyFixture = () => ({ ...policyFixture(), syscalls: [...policyFixture().syscalls,
  { names: ['chroot'], action: 'SCMP_ACT_ALLOW', args: [], includes: { caps: ['CAP_SYS_CHROOT'] }, excludes: {} },
  { names: ['chroot'], action: 'SCMP_ACT_ERRNO', args: [], includes: {}, excludes: { caps: ['CAP_SYS_CHROOT'] }, errnoRet: 1, errno: 'EPERM' },
] });

test('explicit chroot policy changes only the known chroot rules and setns denial', () => {
  const baseline = chrootPolicyFixture();
  const expected = chrootPolicyFixture();
  expected.syscalls[1].names = ['bpf', 'perf_event_open'];
  expected.syscalls[2].includes = {}; expected.syscalls.pop();
  expect(browserNamespaceProfile(baseline, { chroot: true })).toEqual(expected);
  expect(baseline).toEqual(chrootPolicyFixture());
  expect(browserNamespaceProfile(baseline).syscalls.slice(2)).toEqual(baseline.syscalls.slice(2));
});

test.each(['missing', 'wrong_capability', 'combined', 'conditional', 'wrong_errno'])('chroot policy rejects unknown shape: %s', mode => {
  const baseline = chrootPolicyFixture();
  if (mode === 'missing') baseline.syscalls.pop();
  if (mode === 'wrong_capability') baseline.syscalls[2].includes.caps = ['CAP_SYS_ADMIN'];
  if (mode === 'combined') baseline.syscalls[3].names.push('mount');
  if (mode === 'conditional') baseline.syscalls[2].args = [{ index: 0, value: 0 }];
  if (mode === 'wrong_errno') baseline.syscalls[3].errnoRet = 38;
  expect(() => browserNamespaceProfile(baseline, { chroot: true })).toThrow('review required');
});
