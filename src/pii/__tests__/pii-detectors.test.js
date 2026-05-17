const { detectPii } = require('../pii-detectors');

describe('PII detectors', () => {
  test('detects deterministic built-in PII types without overlapping duplicates', () => {
    const matches = detectPii(
      'Email jane@example.com, phone 902-555-0199, SSN 123-45-6789, IP 192.168.1.1, card 4111 1111 1111 1111.',
      {
        detectors: ['email', 'phone', 'ssn', 'creditCard', 'ipAddress'],
        customPatterns: [],
        dictionary: [],
      },
    );

    const types = matches.map((match) => match.type);
    expect(types).toEqual(expect.arrayContaining(['email', 'phone', 'ssn', 'creditCard', 'ipAddress']));
    expect(matches.some((match) => match.value === '4111 1111 1111 1111')).toBe(true);
    matches.forEach((match, index) => {
      const next = matches[index + 1];
      if (next) {
        expect(match.end).toBeLessThanOrEqual(next.start);
      }
    });
  });

  test('supports custom regex and dictionary patterns', () => {
    const matches = detectPii('Customer code ACCT-7788 belongs to Violet Team.', {
      detectors: [],
      customPatterns: [{ type: 'accountCode', pattern: 'ACCT-\\d{4}' }],
      dictionary: [{ type: 'teamName', value: 'Violet Team' }],
    });

    expect(matches.map((match) => match.type)).toEqual(['accountCode', 'teamName']);
  });

  test('carries dictionary actions for grounded private identities', () => {
    const matches = detectPii('Sample Person works at Sample Employer.', {
      detectors: [],
      customPatterns: [],
      dictionary: [
        { type: 'personName', value: 'Sample Person', action: 'mask' },
        { type: 'employer', value: 'Sample Employer', action: 'mask' },
      ],
    });

    expect(matches).toEqual([
      expect.objectContaining({ type: 'personName', action: 'mask', grounded: true }),
      expect.objectContaining({ type: 'employer', action: 'mask', grounded: true }),
    ]);
  });

  test('detects common person-name and DOB formats in admin preview text', () => {
    const matches = detectPii('My name is Sample Person and my DOB is 1984-07-04. Born on July 5, 1984.', {
      detectors: ['personName', 'dateOfBirth'],
      customPatterns: [],
      dictionary: [],
      enablePersonNames: true,
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'personName', value: 'Sample Person' }),
      expect.objectContaining({ type: 'dateOfBirth', value: '1984-07-04' }),
      expect.objectContaining({ type: 'dateOfBirth', value: 'July 5, 1984' }),
    ]));
  });

  test('detects names and workplaces embedded in resume filenames', () => {
    const matches = detectPii('Please improve Resume-Sample-Person-Acme.pdf for me.', {
      detectors: ['personName', 'organization'],
      customPatterns: [],
      dictionary: [],
      enablePersonNames: true,
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'personName', value: 'Sample-Person', source: 'filename' }),
      expect.objectContaining({ type: 'organization', value: 'Acme', source: 'filename' }),
    ]));
  });
});
