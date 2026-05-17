const { buildModelFrame, sanitizeText } = require('../pii-redactor');

describe('PII redactor framing', () => {
  test('builds model-safe placeholder framing without raw values', () => {
    const frame = buildModelFrame([
      {
        placeholder: '[[PII:EMAIL:abc]]',
        type: 'email',
        occurrenceIndex: 0,
        sourceRange: { start: 8, end: 24 },
        value: 'jane@example.com',
      },
      {
        placeholder: '[[PII:PHONE:def]]',
        type: 'phone',
        occurrenceIndex: 1,
        sourceRange: { start: 31, end: 43 },
        value: '902-555-0199',
      },
    ]);

    expect(frame.instruction).toMatch(/Preserve placeholders exactly/);
    expect(frame.countsByType).toEqual({ EMAIL: 1, PHONE: 1 });
    expect(JSON.stringify(frame)).not.toContain('jane@example.com');
    expect(JSON.stringify(frame)).not.toContain('902-555-0199');
  });

  test('downgrades vault actions to masking when fail-closed is disabled and vault is unavailable', async () => {
    const result = await sanitizeText('Email jane@example.com', {
      policy: {
        enabled: true,
        failClosed: false,
        hasMasterKey: false,
        storageReady: false,
        detectors: ['email'],
        detectorActions: { email: 'vault-placeholder' },
        customPatterns: [],
        dictionary: [],
        placeholderMode: 'typed-random',
      },
    });

    expect(result.text).toContain('[[PII:EMAIL:MASKED]]');
    expect(result.text).not.toContain('jane@example.com');
    expect(result.contextId).toBeNull();
    expect(result.replacements[0]).toEqual(expect.objectContaining({
      action: 'mask',
      restorable: false,
    }));
  });

  test('masks grounded names and workplaces without creating restorable vault entries', async () => {
    const result = await sanitizeText('Sample Person works at Sample Employer.', {
      policy: {
        enabled: true,
        failClosed: false,
        hasMasterKey: false,
        storageReady: false,
        detectors: [],
        detectorActions: {},
        customPatterns: [],
        dictionary: [
          { type: 'personName', value: 'Sample Person', action: 'mask' },
          { type: 'employer', value: 'Sample Employer', action: 'mask' },
        ],
        placeholderMode: 'typed-random',
      },
    });

    expect(result.text).toContain('[[PII:PERSONNAME:MASKED]]');
    expect(result.text).toContain('[[PII:EMPLOYER:MASKED]]');
    expect(result.text).not.toContain('Sample Person');
    expect(result.text).not.toContain('Sample Employer');
    expect(result.contextId).toBeNull();
    expect(result.replacements).toEqual([
      expect.objectContaining({ type: 'personName', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'employer', action: 'mask', restorable: false }),
    ]);
  });
});
