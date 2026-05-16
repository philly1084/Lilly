const { postgres } = require('../../postgres');
const {
  decryptValue,
  encryptValue,
  valueIndexHmac,
} = require('../pii-vault-store');

describe('PII vault crypto', () => {
  const originalKey = process.env.KIMIBUILT_PII_MASTER_KEY;
  const originalGetStatus = postgres.getStatus;

  beforeEach(() => {
    process.env.KIMIBUILT_PII_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
    postgres.getStatus = () => ({ initialized: true });
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.KIMIBUILT_PII_MASTER_KEY;
    } else {
      process.env.KIMIBUILT_PII_MASTER_KEY = originalKey;
    }
    postgres.getStatus = originalGetStatus;
  });

  test('round-trips values with AES-256-GCM', () => {
    const encrypted = encryptValue('jane@example.com');
    expect(encrypted.encryptedValue).not.toContain('jane@example.com');
    expect(decryptValue(encrypted)).toBe('jane@example.com');
  });

  test('creates stable HMAC indexes without exposing raw values', () => {
    const first = valueIndexHmac('jane@example.com', 'email');
    const second = valueIndexHmac('jane@example.com', 'email');
    expect(first).toBe(second);
    expect(first).not.toContain('jane');
  });
});
