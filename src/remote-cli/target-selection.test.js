'use strict';

const {
  extractRemoteCliHostCandidates,
  normalizeRemoteCliTargetIdCandidate,
  resolveConfiguredRemoteCliTargetForHost,
  resolveConfiguredRemoteCliTargetFromText,
} = require('./target-selection');

describe('remote CLI target selection', () => {
  const targetHostMap = {
    '168.119.176.121': 'k3s-primary',
    '162.55.163.199': 'k3s-secondary',
    'demoserver2.buzz': 'k3s-secondary',
    'demosever2.buzz': 'k3s-secondary',
    'secdevsolutions.help': 'k3s-primary',
  };

  test('drops serialized empty target sentinels', () => {
    expect(normalizeRemoteCliTargetIdCandidate(undefined)).toBe('');
    expect(normalizeRemoteCliTargetIdCandidate('undefined')).toBe('');
    expect(normalizeRemoteCliTargetIdCandidate('null')).toBe('');
    expect(normalizeRemoteCliTargetIdCandidate('not_available')).toBe('');
    expect(normalizeRemoteCliTargetIdCandidate('k3s-secondary')).toBe('k3s-secondary');
  });

  test('maps exact hosts and configured domain suffixes', () => {
    expect(resolveConfiguredRemoteCliTargetForHost('root@162.55.163.199', targetHostMap)).toBe('k3s-secondary');
    expect(resolveConfiguredRemoteCliTargetForHost('penguin.demoserver2.buzz', targetHostMap)).toBe('k3s-secondary');
    expect(resolveConfiguredRemoteCliTargetForHost('lilly.secdevsolutions.help', targetHostMap)).toBe('k3s-primary');
  });

  test('recovers a target from project domains, including the known demoserver typo', () => {
    expect(extractRemoteCliHostCandidates('Continue https://penguin.demoserver2.buzz/ please')).toContain('penguin.demoserver2.buzz');
    expect(resolveConfiguredRemoteCliTargetFromText(
      'Find my old Penguin project at penguin.demosever2.buzz and continue it.',
      targetHostMap,
    )).toBe('k3s-secondary');
  });
});
