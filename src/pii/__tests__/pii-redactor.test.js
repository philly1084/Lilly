const { DEFAULT_PRIVACY_PII_SETTINGS } = require('../pii-policy');
const { buildModelFrame, sanitizeRuntimePayload, sanitizeText } = require('../pii-redactor');
const {
  normalizePrivacyPiiSettings,
  resolveRelationshipCalculationPolicy,
} = require('../pii-policy');

describe('PII redactor framing', () => {
  test('defaults PII protection to opaque placeholders', () => {
    expect(DEFAULT_PRIVACY_PII_SETTINGS).toEqual(expect.objectContaining({
      defaultsVersion: 6,
      enabled: true,
      placeholderMode: 'opaque-random',
      failClosed: true,
      enablePersonNames: true,
      relationshipCalculations: expect.objectContaining({
        enabled: true,
        autoDetect: true,
        allowExplicitRequest: true,
      }),
    }));
    expect(DEFAULT_PRIVACY_PII_SETTINGS.detectors).toEqual(expect.arrayContaining([
      'personName',
      'organization',
      'medicalRecordNumber',
      'patientIdentifier',
      'healthCardNumber',
      'socialInsuranceNumber',
      'postalCode',
    ]));
  });

  test('normalizes relationship calculation settings and auto-detects spreadsheet math', () => {
    const settings = normalizePrivacyPiiSettings({
      relationshipCalculations: {
        maxRows: 25,
        maxCells: 500,
      },
    });

    expect(settings.relationshipCalculations).toEqual(expect.objectContaining({
      enabled: true,
      autoDetect: true,
      allowExplicitRequest: true,
      maxRows: 25,
      maxCells: 500,
    }));

    expect(resolveRelationshipCalculationPolicy(settings, {
      text: 'Use the spreadsheet table to add up totals by retailer.',
    })).toEqual(expect.objectContaining({
      active: true,
      reason: 'auto-detected',
    }));

    expect(resolveRelationshipCalculationPolicy(settings, {
      text: 'Use the spreadsheet table to add up totals by retailer.',
      metadata: { piiRelationshipCalculations: 'off' },
    })).toEqual(expect.objectContaining({
      active: false,
      reason: 'disabled',
    }));

    expect(resolveRelationshipCalculationPolicy(settings, {
      text: 'Hello there.',
      metadata: { piiRelationshipCalculations: 'force' },
    })).toEqual(expect.objectContaining({
      active: true,
      reason: 'explicit',
    }));
  });

  test('builds model-safe placeholder framing without raw values or type context', () => {
    const frame = buildModelFrame([
      {
        placeholder: '[[PII:abc]]',
        type: 'email',
        occurrenceIndex: 0,
        sourceRange: { start: 8, end: 24 },
        value: 'jane@example.com',
      },
      {
        placeholder: '[[PII:def]]',
        type: 'phone',
        occurrenceIndex: 1,
        sourceRange: { start: 31, end: 43 },
        value: '902-555-0199',
      },
    ]);

    expect(frame.instruction).toMatch(/Preserve placeholders exactly/);
    expect(frame.instruction).toMatch(/Do not infer or expose the placeholder category/);
    expect(frame.replacementCount).toBe(2);
    expect(frame.countsByType).toBeUndefined();
    expect(frame.placeholders[0].type).toBeUndefined();
    expect(JSON.stringify(frame)).not.toContain('jane@example.com');
    expect(JSON.stringify(frame)).not.toContain('902-555-0199');
    expect(JSON.stringify(frame)).not.toContain('email');
    expect(JSON.stringify(frame)).not.toContain('phone');
  });

  test('keeps typed placeholder framing as an explicit opt-in choice', () => {
    const frame = buildModelFrame([
      {
        placeholder: '[[PII:EMAIL:abc]]',
        type: 'email',
        occurrenceIndex: 0,
        sourceRange: { start: 8, end: 24 },
      },
    ], { placeholderMode: 'typed-random' });

    expect(frame.countsByType).toEqual({ EMAIL: 1 });
    expect(frame.placeholders[0]).toEqual(expect.objectContaining({
      placeholder: '[[PII:EMAIL:abc]]',
      type: 'email',
    }));
  });

  test('uses opaque placeholders for default non-restorable masks', async () => {
    const result = await sanitizeText('Sample Person works here.', {
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
        ],
      },
    });

    expect(result.text).toMatch(/^\[\[PII:[a-f0-9]{12}\]\] works here\.$/);
    expect(result.text).not.toContain('PERSONNAME');
    expect(result.modelFrame.placeholders[0]).toEqual(expect.objectContaining({
      placeholder: result.replacements[0].placeholder,
      occurrenceIndex: 0,
    }));
    expect(result.modelFrame.placeholders[0].type).toBeUndefined();
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

  test('masks identity-bearing resume filenames with default opaque IDs', async () => {
    const result = await sanitizeText('Please improve Resume-Sample-Person-Acme.pdf.', {
      policy: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
        failClosed: false,
        hasMasterKey: false,
        storageReady: false,
      },
    });

    expect(result.text).toMatch(/Resume-\[\[PII:[a-f0-9]{12}\]\]-\[\[PII:[a-f0-9]{12}\]\]\.pdf/);
    expect(result.text).not.toContain('Sample-Person');
    expect(result.text).not.toContain('Acme');
    expect(result.contextId).toBeNull();
    expect(result.replacements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'personName', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'organization', action: 'mask', restorable: false }),
    ]));
  });

  test('masks FHIR and HL7 patient identifiers with default opaque IDs', async () => {
    const sample = [
      'FHIR Patient resource: {"resourceType":"Patient","identifier":[{"system":"urn:mrn","value":"MRN-445566"}],"name":[{"family":"Sampleton","given":["Jamie"]}],"birthDate":"1984-07-04","telecom":[{"value":"902-555-0199"}],"address":[{"line":["123 Main Street"],"city":"Halifax","postalCode":"B3J 2K9"}]}',
      'HL7: PID|1||MRN12345^^^HOSP^MR||Sampleton^Jamie||19840704|F|||123 Main Street^^Halifax^NS^B3J2K9||902-555-0199|',
    ].join('\n');
    const result = await sanitizeText(sample, {
      policy: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
        failClosed: false,
        hasMasterKey: false,
        storageReady: false,
      },
    });

    expect(result.text).not.toContain('MRN-445566');
    expect(result.text).not.toContain('MRN12345');
    expect(result.text).not.toContain('Sampleton');
    expect(result.text).not.toContain('Jamie');
    expect(result.text).not.toContain('1984-07-04');
    expect(result.text).not.toContain('19840704');
    expect(result.text).not.toContain('902-555-0199');
    expect(result.text).not.toContain('Halifax');
    expect(result.text).not.toContain('B3J 2K9');
    expect(result.text).not.toContain('B3J2K9');
    expect(result.replacements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'medicalRecordNumber', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'personName', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'dateOfBirth' }),
    ]));
  });

  test('masks Canadian PII with default opaque IDs', async () => {
    const sample = [
      'Canadian intake:',
      'Name: Jamie Sampleton',
      'DOB: 1984-07-04',
      'SIN: 046 454 286',
      'OHIP: 1234-567-890 AB',
      'Health card number: PEI-99887766',
      'Address: 123 Main Street, Ottawa ON K1A 0B1',
    ].join('\n');
    const result = await sanitizeText(sample, {
      policy: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
        failClosed: false,
        hasMasterKey: false,
        storageReady: false,
      },
    });

    expect(result.text).not.toContain('Jamie Sampleton');
    expect(result.text).not.toContain('1984-07-04');
    expect(result.text).not.toContain('046 454 286');
    expect(result.text).not.toContain('1234-567-890 AB');
    expect(result.text).not.toContain('PEI-99887766');
    expect(result.text).not.toContain('123 Main Street');
    expect(result.text).not.toContain('K1A 0B1');
    expect(result.replacements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'socialInsuranceNumber', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'healthCardNumber', action: 'mask', restorable: false }),
      expect.objectContaining({ type: 'postalCode' }),
    ]));
  });

  test('uses vault placeholders for identity values during relationship calculations', async () => {
    const addEntries = jest.fn();
    const createContext = jest.fn().mockResolvedValue({ id: 'ctx-calc' });
    jest.spyOn(require('../pii-vault-store').piiVaultStore, 'createContext').mockImplementation(createContext);
    jest.spyOn(require('../pii-vault-store').piiVaultStore, 'addEntries').mockImplementation(addEntries);

    const result = await sanitizeText('Retailer Acme had total 100.', {
      sessionId: 'session-calc',
      policy: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
        failClosed: true,
        hasMasterKey: true,
        storageReady: true,
        detectors: [],
        customPatterns: [],
        dictionary: [
          { type: 'organization', value: 'Acme' },
        ],
        relationshipCalculations: {
          enabled: true,
          autoDetect: true,
          allowExplicitRequest: true,
          maxRows: 1000,
          maxCells: 20000,
          active: true,
          reason: 'auto-detected',
        },
      },
    });

    expect(result.text).toMatch(/\[\[PII:[a-f0-9]{12}\]\] had total 100\./);
    expect(result.text).not.toContain('Acme');
    expect(result.replacements[0]).toEqual(expect.objectContaining({
      action: 'vault-placeholder',
      restorable: true,
    }));
    expect(createContext).toHaveBeenCalled();
    expect(addEntries).toHaveBeenCalledWith('ctx-calc', expect.arrayContaining([
      expect.objectContaining({ value: expect.stringContaining('Acme'), restorable: true }),
    ]));

    require('../pii-vault-store').piiVaultStore.createContext.mockRestore();
    require('../pii-vault-store').piiVaultStore.addEntries.mockRestore();
  });

  test('preserves relationship calculation activation through runtime payload sanitization', async () => {
    const result = await sanitizeRuntimePayload({
      input: 'Which retailer has the largest total in this spreadsheet table?',
      memoryInput: 'Which retailer has the largest total in this spreadsheet table?',
      instructions: 'Answer carefully.',
      metadata: {
        piiCleansing: {
          relationshipCalculations: { active: true },
        },
      },
    }, {
      policy: {
        ...DEFAULT_PRIVACY_PII_SETTINGS,
        failClosed: false,
        hasMasterKey: false,
        storageReady: false,
      },
    });

    expect(result.payload.metadata.piiCleansing.relationshipCalculations).toEqual(expect.objectContaining({
      active: true,
    }));
    expect(result.payload.metadata.piiCleansing.relationshipFrame.instruction).toContain('structured relationship calculation tool');
  });
});
