const { buildModelFrame } = require('../pii-redactor');

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
});
