const { calculateRelationship } = require('../pii-relationship-calculator');
const { piiVaultStore } = require('../pii-vault-store');
const {
  inferColumnRole,
  inferWorkbookRelationshipCalculationRequest,
  inferSensitiveColumnType,
  normalizeStructuredTables,
  parseMeasureNumber,
  prepareWorkbookRelationshipInput,
} = require('../pii-workbook-relationship');

describe('PII workbook relationship bridge', () => {
  const originalMasterKey = process.env.KIMIBUILT_PII_MASTER_KEY;
  let createContextSpy;
  let addEntriesSpy;
  let listEntriesSpy;

  beforeEach(() => {
    let contextCounter = 0;
    process.env.KIMIBUILT_PII_MASTER_KEY = 'test-workbook-relationship-key';
    createContextSpy = jest.spyOn(piiVaultStore, 'createContext').mockImplementation(async () => {
      contextCounter += 1;
      return { id: `ctx-workbook-${contextCounter}` };
    });
    addEntriesSpy = jest.spyOn(piiVaultStore, 'addEntries').mockResolvedValue([]);
    listEntriesSpy = jest.spyOn(piiVaultStore, 'listEntriesForContexts').mockResolvedValue([]);
  });

  afterEach(() => {
    createContextSpy.mockRestore();
    addEntriesSpy.mockRestore();
    listEntriesSpy.mockRestore();
    if (originalMasterKey === undefined) {
      delete process.env.KIMIBUILT_PII_MASTER_KEY;
    } else {
      process.env.KIMIBUILT_PII_MASTER_KEY = originalMasterKey;
    }
  });

  function privacyPolicy() {
    return {
      enabled: true,
      failClosed: true,
      hasMasterKey: true,
      storageReady: true,
      detectors: [],
      detectorActions: {},
      customPatterns: [],
      dictionary: [
        { type: 'organization', value: 'Sample Retailer Alpha' },
        { type: 'organization', value: 'Sample Retailer Beta' },
      ],
      placeholderMode: 'opaque-random',
      relationshipCalculations: {
        enabled: true,
        autoDetect: true,
        allowExplicitRequest: true,
        maxRows: 1000,
        maxCells: 20000,
      },
    };
  }

  function workbookTables() {
    return [{
      name: 'sheet1',
      headers: [
        { id: 'c1', header: 'Retailer', columnIndex: 0 },
        { id: 'c2', header: 'Amount', columnIndex: 1 },
        { id: 'c3', header: 'Region', columnIndex: 2 },
      ],
      rows: [
        {
          id: 'r1',
          rowIndex: 1,
          cells: [
            { columnId: 'c1', columnIndex: 0, header: 'Retailer', value: 'Sample Retailer Alpha' },
            { columnId: 'c2', columnIndex: 1, header: 'Amount', value: '$120.50' },
            { columnId: 'c3', columnIndex: 2, header: 'Region', value: 'East' },
          ],
        },
        {
          id: 'r2',
          rowIndex: 2,
          cells: [
            { columnId: 'c1', columnIndex: 0, header: 'Retailer', value: 'Sample Retailer Alpha' },
            { columnId: 'c2', columnIndex: 1, header: 'Amount', value: '80' },
            { columnId: 'c3', columnIndex: 2, header: 'Region', value: 'East' },
          ],
        },
        {
          id: 'r3',
          rowIndex: 3,
          cells: [
            { columnId: 'c1', columnIndex: 0, header: 'Retailer', value: 'Sample Retailer Beta' },
            { columnId: 'c2', columnIndex: 1, header: 'Amount', value: '190' },
            { columnId: 'c3', columnIndex: 2, header: 'Region', value: 'West' },
          ],
        },
      ],
    }];
  }

  test('builds calculator-ready tables without exposing private workbook cells', async () => {
    const prepared = await prepareWorkbookRelationshipInput({
      structuredTables: workbookTables(),
      sessionId: 'session-workbook',
      policy: privacyPolicy(),
    });

    expect(prepared.tables).toEqual([{
      id: 't1',
      columns: [
        { id: 'c1', header: 'Retailer', role: 'private-group-key' },
        { id: 'c2', header: 'Amount', role: 'measure' },
        { id: 'c3', header: 'Region', role: 'dimension' },
      ],
      rows: [
        expect.objectContaining({ id: 't1_r1' }),
        expect.objectContaining({ id: 't1_r2' }),
        expect.objectContaining({ id: 't1_r3' }),
      ],
    }]);
    expect(prepared.tables[0].rows[0].cells.c1).toMatch(/^\[\[PII:[^\]]+\]\]$/);
    expect(prepared.tables[0].rows[0].cells.c2).toBe(120.5);
    expect(prepared.tables[0].rows[1].cells.c2).toBe(80);
    expect(prepared.context.piiEntries).toHaveLength(3);
    expect(prepared.context.piiCleansing.workbookRelationship).toEqual(expect.objectContaining({
      source: 'xlsx-structured-tables',
      tableCount: 1,
      rowCount: 3,
      placeholderCellCount: 3,
      measureColumnCount: 1,
    }));
    expect(JSON.stringify(prepared)).not.toContain('Sample Retailer Alpha');
    expect(JSON.stringify(prepared)).not.toContain('Sample Retailer Beta');
    expect(createContextSpy).toHaveBeenCalledTimes(3);
    expect(addEntriesSpy).toHaveBeenCalledTimes(3);
  });

  test('feeds pii-relationship-calculate group and top operations through HMAC context', async () => {
    const prepared = await prepareWorkbookRelationshipInput({
      structuredTables: workbookTables(),
      sessionId: 'session-workbook',
      policy: privacyPolicy(),
    });

    const top = await calculateRelationship({
      operation: 'top_n',
      tableId: 't1',
      groupBy: 'c1',
      measure: 'c2',
      limit: 1,
      tables: prepared.tables,
    }, prepared.context);
    const count = await calculateRelationship({
      operation: 'group_count',
      tableId: 't1',
      groupBy: 'c1',
      tables: prepared.tables,
    }, prepared.context);

    expect(top).toEqual(expect.objectContaining({
      operation: 'top_n',
      aggregateValue: 200.5,
      rowCount: 2,
      evidenceRowIds: ['t1_r1', 't1_r2'],
      sanitized: true,
    }));
    expect(count.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ aggregateValue: 2, rowCount: 2 }),
      expect.objectContaining({ aggregateValue: 1, rowCount: 1 }),
    ]));
    expect(JSON.stringify(top)).not.toContain('Sample Retailer Alpha');
    expect(JSON.stringify(count)).not.toContain('Sample Retailer Beta');
  });

  test('normalizes extractor metadata inputs and local measure parsing helpers', () => {
    const input = { metadata: { structuredTables: workbookTables() } };

    expect(normalizeStructuredTables(input)).toHaveLength(1);
    expect(inferSensitiveColumnType('Patient Key')).toBe('patientIdentifier');
    expect(inferSensitiveColumnType('MRN')).toBe('patientIdentifier');
    expect(inferColumnRole(['[[PII:abc]]', '[[PII:def]]'])).toBe('private-group-key');
    expect(inferColumnRole(['$1,200.25', '80', '(20)'])).toBe('measure');
    expect(inferColumnRole(['North', 'South'])).toBe('dimension');
    expect(parseMeasureNumber('$1,200.25')).toBe(1200.25);
    expect(parseMeasureNumber('(20)')).toBe(-20);
    expect(parseMeasureNumber('1200')).toBe(1200);
  });

  test('vault-tokenizes identity columns by header context even when values are uid-like', async () => {
    const prepared = await prepareWorkbookRelationshipInput({
      structuredTables: [{
        name: 'sheet1',
        headers: [
          { id: 'c1', header: 'Patient Key', columnIndex: 0 },
          { id: 'c2', header: 'Patient Balance', columnIndex: 1 },
        ],
        rows: [
          {
            id: 'r1',
            cells: [
              { columnId: 'c1', columnIndex: 0, header: 'Patient Key', value: 'P001' },
              { columnId: 'c2', columnIndex: 1, header: 'Patient Balance', value: '120' },
            ],
          },
          {
            id: 'r2',
            cells: [
              { columnId: 'c1', columnIndex: 0, header: 'Patient Key', value: 'P001' },
              { columnId: 'c2', columnIndex: 1, header: 'Patient Balance', value: '80' },
            ],
          },
        ],
      }],
      sessionId: 'session-workbook',
      policy: privacyPolicy(),
    });

    expect(prepared.tables[0].columns[0]).toEqual(expect.objectContaining({
      header: 'Patient Key',
      role: 'private-group-key',
    }));
    expect(prepared.tables[0].rows[0].cells.c1).toMatch(/^\[\[PII:[^\]]+\]\]$/);
    expect(prepared.context.piiEntries).toHaveLength(2);

    const result = await calculateRelationship({
      operation: 'top_n',
      tableId: 't1',
      groupBy: 'c1',
      measure: 'c2',
      limit: 1,
      tables: prepared.tables,
    }, prepared.context);

    expect(result).toEqual(expect.objectContaining({
      aggregateValue: 200,
      rowCount: 2,
      sanitized: true,
    }));
    expect(JSON.stringify(result)).not.toContain('P001');
  });

  test('infers a deterministic top calculation request from a workbook question', async () => {
    const prepared = await prepareWorkbookRelationshipInput({
      structuredTables: [{
        name: 'sheet1',
        headers: [
          { id: 'c1', header: 'Patient Key', columnIndex: 0 },
          { id: 'c2', header: 'Total Charge', columnIndex: 1 },
          { id: 'c3', header: 'Patient Balance', columnIndex: 2 },
        ],
        rows: [
          {
            id: 'r1',
            cells: [
              { columnId: 'c1', columnIndex: 0, value: 'P001' },
              { columnId: 'c2', columnIndex: 1, value: '100' },
              { columnId: 'c3', columnIndex: 2, value: '60' },
            ],
          },
        ],
      }],
      sessionId: 'session-workbook',
      policy: privacyPolicy(),
    });

    const request = inferWorkbookRelationshipCalculationRequest({
      text: 'Which patient has the highest balance in the uploaded spreadsheet?',
      tables: prepared.tables,
    });

    expect(request).toEqual(expect.objectContaining({
      operation: 'top_n',
      tableId: 't1',
      groupBy: 'c1',
      measure: 'c3',
      limit: 1,
    }));
    expect(JSON.stringify(request)).not.toContain('P001');
  });
});
