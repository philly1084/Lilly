const {
  calculateRelationship,
  calculateRelationshipWithRepair,
} = require('../pii-relationship-calculator');
const { piiVaultStore } = require('../pii-vault-store');

describe('PII relationship calculator', () => {
  const piiEntries = [
    { placeholder: '[[PII:a1]]', valueIndexHmac: 'retailer-a', piiType: 'organization' },
    { placeholder: '[[PII:a2]]', valueIndexHmac: 'retailer-a', piiType: 'organization' },
    { placeholder: '[[PII:b1]]', valueIndexHmac: 'retailer-b', piiType: 'organization' },
  ];

  test('groups randomized placeholders by vault HMAC and ranks aggregate totals', async () => {
    const result = await calculateRelationship({
      operationId: 'largest-retailer',
      operation: 'top_n',
      tableId: 'sales',
      groupBy: 'retailer',
      measure: 'amount',
      limit: 1,
      tables: [{
        id: 'sales',
        columns: [
          { id: 'retailer', header: 'Retailer', role: 'private-group-key' },
          { id: 'amount', header: 'Amount', role: 'measure' },
        ],
        rows: [
          { id: 'r1', cells: { retailer: '[[PII:a1]]', amount: '120.50' } },
          { id: 'r2', cells: { retailer: '[[PII:a2]]', amount: '80' } },
          { id: 'r3', cells: { retailer: '[[PII:b1]]', amount: '190' } },
        ],
      }],
    }, { piiEntries });

    expect(result).toEqual(expect.objectContaining({
      operationId: 'largest-retailer',
      operation: 'top_n',
      winnerPlaceholder: '[[PII:a1]]',
      aggregateValue: 200.5,
      rowCount: 2,
      evidenceRowIds: ['r1', 'r2'],
      sanitized: true,
    }));
    expect(JSON.stringify(result)).not.toContain('Acme');
    expect(JSON.stringify(result)).not.toContain('retailer-a');
  });

  test('falls back to vault context IDs when direct PII entries are empty', async () => {
    const listEntries = jest.spyOn(piiVaultStore, 'listEntriesForContexts').mockResolvedValue(piiEntries);

    const result = await calculateRelationship({
      operationId: 'largest-retailer',
      operation: 'top_n',
      tableId: 'sales',
      groupBy: 'retailer',
      measure: 'amount',
      limit: 1,
      tables: [{
        id: 'sales',
        columns: [
          { id: 'retailer', header: 'Retailer', role: 'private-group-key' },
          { id: 'amount', header: 'Amount', role: 'measure' },
        ],
        rows: [
          { id: 'r1', cells: { retailer: '[[PII:a1]]', amount: '120.50' } },
          { id: 'r2', cells: { retailer: '[[PII:a2]]', amount: '80' } },
          { id: 'r3', cells: { retailer: '[[PII:b1]]', amount: '190' } },
        ],
      }],
    }, {
      piiEntries: [],
      piiCleansing: { contextIds: ['ctx-live'] },
    });

    expect(listEntries).toHaveBeenCalledWith(['ctx-live'], null);
    expect(result).toEqual(expect.objectContaining({
      winnerPlaceholder: '[[PII:a1]]',
      aggregateValue: 200.5,
      sanitized: true,
    }));

    listEntries.mockRestore();
  });

  test('rejects raw PII and unknown group placeholders', async () => {
    await expect(calculateRelationship({
      operation: 'group_sum',
      tableId: 'sales',
      groupBy: 'retailer',
      measure: 'amount',
      tables: [{
        id: 'sales',
        columns: [
          { id: 'retailer', header: 'Retailer' },
          { id: 'amount', header: 'Amount' },
        ],
        rows: [
          { id: 'r1', cells: { retailer: 'jane@example.com', amount: '12' } },
          { id: 'r2', cells: { retailer: '[[PII:missing]]', amount: '20' } },
        ],
      }],
    }, { piiEntries })).rejects.toMatchObject({
      code: 'pii_relationship_invalid_request',
      repair: expect.objectContaining({ repairable: true }),
    });
  });

  test('rejects formulas instead of evaluating spreadsheet logic', async () => {
    await expect(calculateRelationship({
      operation: 'group_sum',
      tableId: 'sales',
      groupBy: 'retailer',
      measure: 'amount',
      tables: [{
        id: 'sales',
        columns: [
          { id: 'retailer', header: 'Retailer' },
          { id: 'amount', header: 'Amount' },
        ],
        rows: [
          { id: 'r1', cells: { retailer: '[[PII:a1]]', amount: '=SUM(B2:B5)' } },
        ],
      }],
    }, { piiEntries })).rejects.toThrow(/supports extracted values only/);
  });

  test('runs one constrained repair callback before calculating', async () => {
    const repaired = await calculateRelationshipWithRepair({
      operation: 'top_n',
      tableId: 'sales',
      groupBy: 'retailer',
      tables: [{
        id: 'sales',
        columns: [
          { id: 'retailer', header: 'Retailer' },
          { id: 'amount', header: 'Amount' },
        ],
        rows: [
          { id: 'r1', cells: { retailer: '[[PII:b1]]', amount: '12' } },
        ],
      }],
    }, { piiEntries }, async ({ repair }) => {
      expect(repair.instruction).toMatch(/Rewrite only the structured relationship calculation request/);
      return {
        operation: 'top_n',
        tableId: 'sales',
        groupBy: 'retailer',
        measure: 'amount',
        tables: [{
          id: 'sales',
          columns: [
            { id: 'retailer', header: 'Retailer' },
            { id: 'amount', header: 'Amount' },
          ],
          rows: [
            { id: 'r1', cells: { retailer: '[[PII:b1]]', amount: '12' } },
          ],
        }],
      };
    });

    expect(repaired.winnerPlaceholder).toBe('[[PII:b1]]');
    expect(repaired.aggregateValue).toBe(12);
  });

  test('joins randomized placeholders by vault HMAC without exposing private values', async () => {
    const result = await calculateRelationship({
      operation: 'join',
      join: {
        leftTableId: 'orders',
        rightTableId: 'targets',
        leftKey: 'retailer',
        rightKey: 'retailer',
      },
      tables: [
        {
          id: 'orders',
          columns: [
            { id: 'retailer', header: 'Retailer' },
            { id: 'orderId', header: 'Order' },
          ],
          rows: [
            { id: 'o1', cells: { retailer: '[[PII:a1]]', orderId: '101' } },
            { id: 'o2', cells: { retailer: '[[PII:b1]]', orderId: '102' } },
          ],
        },
        {
          id: 'targets',
          columns: [
            { id: 'retailer', header: 'Retailer' },
            { id: 'target', header: 'Target' },
          ],
          rows: [
            { id: 't1', cells: { retailer: '[[PII:a2]]', target: '200' } },
          ],
        },
      ],
    }, { piiEntries });

    expect(result.results).toEqual([{
      leftRowId: 'o1',
      rightRowId: 't1',
      keyPlaceholder: '[[PII:a1]]',
      evidenceRowIds: ['o1', 't1'],
    }]);
    expect(JSON.stringify(result)).not.toContain('retailer-a');
  });

  test('rejects joins that reference placeholders outside the trusted context', async () => {
    await expect(calculateRelationship({
      operation: 'join',
      join: {
        leftTableId: 'orders',
        rightTableId: 'targets',
        leftKey: 'retailer',
        rightKey: 'retailer',
      },
      tables: [
        {
          id: 'orders',
          columns: [{ id: 'retailer', header: 'Retailer' }],
          rows: [{ id: 'o1', cells: { retailer: '[[PII:missing]]' } }],
        },
        {
          id: 'targets',
          columns: [{ id: 'retailer', header: 'Retailer' }],
          rows: [{ id: 't1', cells: { retailer: '[[PII:a1]]' } }],
        },
      ],
    }, { piiEntries })).rejects.toMatchObject({
      code: 'pii_relationship_invalid_request',
    });
  });

  test('returns an XLSX formula plan without exposing the highest private individual', async () => {
    const result = await calculateRelationship({
      operationId: 'formula-only-highest-individual',
      operation: 'xlsx_formula_plan',
      tableId: 'sales',
      groupBy: 'person',
      measures: ['baseSales', 'serviceFees', 'rebates'],
      subtractMeasures: ['credits'],
      limit: 4,
      target: {
        helperStartCell: 'Presentation_Result!A12',
        resultCell: 'Presentation_Result!B5',
      },
      tables: [{
        id: 'sales',
        columns: [
          { id: 'person', header: 'Person', role: 'private-group-key' },
          { id: 'baseSales', header: 'Base Sales', role: 'measure' },
          { id: 'serviceFees', header: 'Service Fees', role: 'measure' },
          { id: 'rebates', header: 'Rebates', role: 'measure' },
          { id: 'credits', header: 'Credits', role: 'measure' },
        ],
        rows: [
          { id: 'r1', cells: { person: '[[PII:a1]]', baseSales: '120.50', serviceFees: '12', rebates: '3.5', credits: '4' } },
          { id: 'r2', cells: { person: '[[PII:a2]]', baseSales: '80', serviceFees: '4.5', rebates: '1.25', credits: '0' } },
          { id: 'r3', cells: { person: '[[PII:b1]]', baseSales: '190', serviceFees: '8', rebates: '2', credits: '11' } },
        ],
      }],
    }, { piiEntries });

    expect(result).toEqual(expect.objectContaining({
      operationId: 'formula-only-highest-individual',
      operation: 'xlsx_formula_plan',
      sanitized: true,
    }));
    expect(result.formulaPlan).toEqual(expect.objectContaining({
      type: 'xlsx_formula_plan',
      targetCells: [
        'Presentation_Result!B12:B15',
        'Presentation_Result!C12:C15',
        'Presentation_Result!B5',
      ],
      privacy: {
        returnsWinnerToModel: false,
        returnsGroupRelationshipToModel: false,
        exposesRawPii: false,
      },
    }));
    expect(result.formulaPlan.formulas[0].formula).toContain('SUMIFS');
    expect(result.formulaPlan.formulas[0].formula).toContain('+ SUMIFS');
    expect(result.formulaPlan.formulas[0].formula).toContain('- SUMIFS');
    expect(result).not.toHaveProperty('winnerPlaceholder');
    expect(result).not.toHaveProperty('aggregateValue');
    expect(JSON.stringify(result)).not.toContain('retailer-a');
    expect(JSON.stringify(result)).not.toContain('[[PII:a1]]');
    expect(JSON.stringify(result)).not.toContain('Private Individual');
  });
});
