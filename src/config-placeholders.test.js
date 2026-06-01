'use strict';

const {
  firstConfiguredValue,
  isPlaceholderConfigValue,
  sanitizeConfigValue,
} = require('./config-placeholders');

describe('config placeholder normalization', () => {
  test('treats Kubernetes sentinel values as unset', () => {
    expect(isPlaceholderConfigValue('SET_VIA_KUBECTL_CREATE_SECRET')).toBe(true);
    expect(isPlaceholderConfigValue('OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET')).toBe(true);
    expect(isPlaceholderConfigValue('REPLACE_WITH_THE_BACKEND_RUNNER_TOKEN')).toBe(true);
    expect(sanitizeConfigValue('OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET')).toBe('');
  });

  test('preserves real configured values and finds the first non-placeholder candidate', () => {
    expect(sanitizeConfigValue('root')).toBe('root');
    expect(firstConfiguredValue('REPLACE_WITH_VALUE', 'ssh.example.internal')).toBe('ssh.example.internal');
  });
});
