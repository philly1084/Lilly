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
    const matches = detectPii('Sample Person works at Sample Employer on Sample Product.', {
      detectors: [],
      customPatterns: [],
      dictionary: [
        { type: 'personName', value: 'Sample Person', action: 'mask' },
        { type: 'employer', value: 'Sample Employer', action: 'mask' },
        { type: 'productName', value: 'Sample Product', action: 'mask' },
      ],
    });

    expect(matches).toEqual([
      expect.objectContaining({ type: 'personName', action: 'mask', grounded: true }),
      expect.objectContaining({ type: 'employer', action: 'mask', grounded: true }),
      expect.objectContaining({ type: 'productName', action: 'mask', grounded: true }),
    ]);
  });

  test('detects common person-name and DOB formats in admin preview text', () => {
    const matches = detectPii('My name is Sample Person and my DOB is 1984-07-04. Born on July 5, 84. DOB: 10/08/84.', {
      detectors: ['personName', 'dateOfBirth'],
      customPatterns: [],
      dictionary: [],
      enablePersonNames: true,
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'personName', value: 'Sample Person' }),
      expect.objectContaining({ type: 'dateOfBirth', value: '1984-07-04' }),
      expect.objectContaining({ type: 'dateOfBirth', value: 'July 5, 84' }),
      expect.objectContaining({ type: 'dateOfBirth', value: '10/08/84' }),
    ]));
  });

  test('detects short numeric DOB literals and rejects impossible dates', () => {
    const matches = detectPii('Birth date 31/12/84. DOB: 02/31/84. Reference 99/99/84.', {
      detectors: ['dateOfBirth'],
      customPatterns: [],
      dictionary: [],
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dateOfBirth', value: '31/12/84', source: 'builtin' }),
    ]));
    expect(matches.some((match) => match.value === '02/31/84')).toBe(false);
    expect(matches.some((match) => match.value === '99/99/84')).toBe(false);
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

  test('detects FHIR patient and HL7 PID private fields', () => {
    const sample = [
      'FHIR Patient resource: {"resourceType":"Patient","identifier":[{"system":"urn:mrn","value":"MRN-445566"}],"name":[{"family":"Sampleton","given":["Jamie"]}],"birthDate":"1984-07-04","telecom":[{"value":"902-555-0199"}],"address":[{"line":["123 Main Street"]}]}',
      'HL7: PID|1||MRN12345^^^HOSP^MR||Sampleton^Jamie||19840704|F|||123 Main Street^^Halifax^NS^B3J2K9||902-555-0199|',
    ].join('\n');
    const matches = detectPii(sample, {
      detectors: ['personName', 'dateOfBirth', 'medicalRecordNumber', 'patientIdentifier', 'phone', 'address'],
      customPatterns: [],
      dictionary: [],
      enablePersonNames: true,
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'medicalRecordNumber', value: 'MRN-445566', source: 'fhir' }),
      expect.objectContaining({ type: 'personName', value: 'Sampleton', source: 'fhir' }),
      expect.objectContaining({ type: 'personName', value: 'Jamie', source: 'fhir' }),
      expect.objectContaining({ type: 'dateOfBirth', value: '1984-07-04', source: 'fhir' }),
      expect.objectContaining({ type: 'medicalRecordNumber', value: 'MRN12345', source: 'hl7' }),
      expect.objectContaining({ type: 'personName', value: 'Sampleton^Jamie', source: 'hl7' }),
      expect.objectContaining({ type: 'dateOfBirth', value: '19840704', source: 'hl7' }),
    ]));
  });

  test('detects Canadian SIN, health card, and postal code fields', () => {
    const sample = [
      'Canadian intake:',
      'SIN: 046 454 286',
      'OHIP: 1234-567-890 AB',
      'Health card number: PEI-99887766',
      'Postal code: K1A 0B1',
    ].join('\n');
    const matches = detectPii(sample, {
      detectors: ['socialInsuranceNumber', 'healthCardNumber', 'postalCode'],
      customPatterns: [],
      dictionary: [],
    });

    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'socialInsuranceNumber', value: '046 454 286', source: 'canadianSin' }),
      expect.objectContaining({ type: 'healthCardNumber', value: '1234-567-890 AB', source: 'canadianHealthCard' }),
      expect.objectContaining({ type: 'healthCardNumber', value: 'PEI-99887766', source: 'canadianHealthCard' }),
      expect.objectContaining({ type: 'postalCode', value: 'K1A 0B1', source: 'builtin' }),
    ]));
  });
});
