const { detectPii } = require('./pii-detectors');
const { DEFAULT_PRIVACY_PII_SETTINGS } = require('./pii-policy');
const { piiVaultStore } = require('./pii-vault-store');

const RELATIONSHIP_CALCULATION_TOOL_ID = 'pii-relationship-calculate';

const SUPPORTED_OPERATIONS = new Set([
  'group_sum',
  'group_count',
  'group_average',
  'top_n',
  'bottom_n',
  'filter',
  'join',
]);

const FILTER_OPERATORS = new Set(['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'contains']);

const RELATIONSHIP_CALCULATION_SCHEMA = {
  type: 'object',
  required: ['operation', 'tables'],
  properties: {
    operationId: { type: 'string', maxLength: 80 },
    operation: {
      type: 'string',
      enum: Array.from(SUPPORTED_OPERATIONS),
    },
    tableId: { type: 'string', maxLength: 80 },
    groupBy: { type: 'string', maxLength: 80 },
    measure: { type: 'string', maxLength: 80 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    filters: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['column', 'operator', 'value'],
        properties: {
          column: { type: 'string', maxLength: 80 },
          operator: { type: 'string', enum: Array.from(FILTER_OPERATORS) },
          value: { type: 'string', maxLength: 240 },
        },
        additionalProperties: false,
      },
    },
    join: {
      type: 'object',
      required: ['leftTableId', 'rightTableId', 'leftKey', 'rightKey'],
      properties: {
        leftTableId: { type: 'string', maxLength: 80 },
        rightTableId: { type: 'string', maxLength: 80 },
        leftKey: { type: 'string', maxLength: 80 },
        rightKey: { type: 'string', maxLength: 80 },
      },
      additionalProperties: false,
    },
    tables: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        required: ['id', 'columns', 'rows'],
        properties: {
          id: { type: 'string', maxLength: 80 },
          columns: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string', maxLength: 80 },
                header: { type: 'string', maxLength: 160 },
                role: { type: 'string', maxLength: 80 },
              },
              additionalProperties: false,
            },
          },
          rows: {
            type: 'array',
            maxItems: 10000,
            items: {
              type: 'object',
              required: ['id', 'cells'],
              properties: {
                id: { type: 'string', maxLength: 120 },
                cells: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

function normalizeId(value = '') {
  return String(value || '').trim();
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? value : String(value).trim();
}

function isPlaceholder(value = '') {
  return /^\[\[PII:[^\]]+\]\]$/.test(String(value || '').trim());
}

function collectObjectErrors(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object.`);
      return errors;
    }
    const properties = schema.properties || {};
    (schema.required || []).forEach((key) => {
      if (!(key in value)) errors.push(`${path}.${key} is required.`);
    });
    if (schema.additionalProperties === false) {
      Object.keys(value).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}.${key} is not allowed.`);
        }
      });
    }
    Object.entries(properties).forEach(([key, childSchema]) => {
      if (key in value) errors.push(...collectObjectErrors(value[key], childSchema, `${path}.${key}`));
    });
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array.`);
      return errors;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} must include at least ${schema.minItems} item(s).`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} must include at most ${schema.maxItems} item(s).`);
    value.forEach((item, index) => errors.push(...collectObjectErrors(item, schema.items, `${path}[${index}]`)));
    return errors;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path} must be a string.`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}.`);
    if (typeof schema.maxLength === 'number' && typeof value === 'string' && value.length > schema.maxLength) errors.push(`${path} is too long.`);
    return errors;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path} must be an integer.`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}.`);
  }
  return errors;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = String(value ?? '').replace(/[$,%\s,]/g, '').trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function containsRawPii(value = '') {
  const source = String(value || '').trim();
  if (!source || isPlaceholder(source)) return false;
  return detectPii(source, {
    ...DEFAULT_PRIVACY_PII_SETTINGS,
    customPatterns: [],
    dictionary: [],
  }).length > 0;
}

function getContextIds(context = {}) {
  return Array.from(new Set([
    ...(Array.isArray(context?.piiContextIds) ? context.piiContextIds : []),
    ...(Array.isArray(context?.piiCleansing?.contextIds) ? context.piiCleansing.contextIds : []),
    ...(Array.isArray(context?.metadata?.piiCleansing?.contextIds) ? context.metadata.piiCleansing.contextIds : []),
  ].map((entry) => String(entry || '').trim()).filter(Boolean)));
}

async function loadPlaceholderIndex(context = {}) {
  if (Array.isArray(context.piiEntries)) {
    return new Map(context.piiEntries
      .filter((entry) => entry?.placeholder && entry?.valueIndexHmac)
      .map((entry) => [entry.placeholder, {
        placeholder: entry.placeholder,
        valueIndexHmac: entry.valueIndexHmac,
        piiType: entry.piiType || entry.pii_type || 'PII',
      }]));
  }
  const contextIds = getContextIds(context);
  if (contextIds.length === 0) return new Map();
  const entries = await piiVaultStore.listEntriesForContexts(contextIds, context.ownerId || context.userId || null);
  return new Map(entries.map((entry) => [entry.placeholder, entry]));
}

function findTable(params = {}, tableId = '') {
  const tables = Array.isArray(params.tables) ? params.tables : [];
  if (tableId) return tables.find((table) => table.id === tableId) || null;
  if (params.tableId) return tables.find((table) => table.id === params.tableId) || null;
  return tables[0] || null;
}

function getColumnIds(table = {}) {
  return new Set((Array.isArray(table.columns) ? table.columns : []).map((column) => column.id));
}

function validateRows(table = {}, params = {}, placeholderIndex = new Map(), policy = {}) {
  const errors = [];
  const columnIds = getColumnIds(table);
  const referencedColumns = [params.groupBy, params.measure]
    .concat((params.filters || []).map((filter) => filter.column))
    .filter(Boolean);
  referencedColumns.forEach((columnId) => {
    if (!columnIds.has(columnId)) errors.push(`Column "${columnId}" does not exist on table "${table.id}".`);
  });

  const maxRows = Number(policy.maxRows || 1000);
  const maxCells = Number(policy.maxCells || 20000);
  const rows = Array.isArray(table.rows) ? table.rows : [];
  if (rows.length > maxRows) errors.push(`Table "${table.id}" exceeds the privacy calculation row limit (${maxRows}).`);
  if (rows.reduce((count, row) => count + Object.keys(row.cells || {}).length, 0) > maxCells) {
    errors.push(`Table "${table.id}" exceeds the privacy calculation cell limit (${maxCells}).`);
  }

  rows.forEach((row) => {
    Object.entries(row.cells || {}).forEach(([columnId, value]) => {
      if (!columnIds.has(columnId)) errors.push(`Row "${row.id}" references unknown column "${columnId}".`);
      const normalized = normalizeCell(value);
      if (typeof normalized === 'string' && normalized.trim().startsWith('=')) {
        errors.push(`Row "${row.id}" column "${columnId}" contains a formula; v1 supports extracted values only.`);
      }
      if (typeof normalized === 'string' && containsRawPii(normalized)) {
        errors.push(`Row "${row.id}" column "${columnId}" appears to contain raw PII instead of a placeholder.`);
      }
      if (columnId === params.groupBy && normalized && !isPlaceholder(normalized)) {
        errors.push(`Group column "${columnId}" must use vault-backed placeholders.`);
      }
      if (columnId === params.groupBy && isPlaceholder(normalized) && !placeholderIndex.has(normalized)) {
        errors.push(`Placeholder "${normalized}" in row "${row.id}" is not available in the trusted PII context.`);
      }
    });
  });
  return errors;
}

function getRelationshipLimits(context = {}) {
  return context?.metadata?.piiCleansing?.relationshipCalculations
    || context?.piiCleansing?.relationshipCalculations
    || {};
}

function validateJoinRequest(params = {}, context = {}, placeholderIndex = new Map()) {
  const join = params.join || {};
  const errors = [];
  const left = findTable(params, join.leftTableId);
  const right = findTable(params, join.rightTableId);
  if (!left || !right) {
    return ['join requires valid leftTableId and rightTableId.'];
  }
  const leftColumns = getColumnIds(left);
  const rightColumns = getColumnIds(right);
  if (!leftColumns.has(join.leftKey)) errors.push(`Column "${join.leftKey}" does not exist on table "${left.id}".`);
  if (!rightColumns.has(join.rightKey)) errors.push(`Column "${join.rightKey}" does not exist on table "${right.id}".`);

  const policy = getRelationshipLimits(context);
  errors.push(...validateRows(left, { ...params, groupBy: join.leftKey, filters: [] }, placeholderIndex, policy));
  errors.push(...validateRows(right, { ...params, groupBy: join.rightKey, filters: [] }, placeholderIndex, policy));
  return errors;
}

function buildRepairBlocker(errors = []) {
  return {
    repairable: true,
    instruction: [
      'Rewrite only the structured relationship calculation request.',
      'Do not calculate the answer in prose.',
      'Use existing row ids, column ids, placeholder cells, filters, and supported operations only.',
    ].join(' '),
    errors,
  };
}

function validateRelationshipCalculationRequest(params = {}, context = {}, placeholderIndex = new Map()) {
  const schemaErrors = collectObjectErrors(params, RELATIONSHIP_CALCULATION_SCHEMA);
  if (schemaErrors.length > 0) {
    return { ok: false, errors: schemaErrors, repair: buildRepairBlocker(schemaErrors) };
  }
  const errors = [];
  if (!SUPPORTED_OPERATIONS.has(params.operation)) errors.push(`Unsupported operation "${params.operation}".`);
  const table = findTable(params, params.tableId);
  if (!table && params.operation !== 'join') errors.push('A valid tableId or first table is required.');
  if (['group_sum', 'group_average', 'top_n', 'bottom_n'].includes(params.operation)) {
    if (!params.groupBy) errors.push(`${params.operation} requires groupBy.`);
    if (!params.measure) errors.push(`${params.operation} requires measure.`);
  }
  if (params.operation === 'group_count' && !params.groupBy) errors.push('group_count requires groupBy.');
  if (params.operation === 'join' && !params.join) errors.push('join requires join metadata.');
  if (Array.isArray(params.filters)) {
    params.filters.forEach((filter) => {
      if (!FILTER_OPERATORS.has(filter.operator)) errors.push(`Unsupported filter operator "${filter.operator}".`);
      if (containsRawPii(filter.value)) errors.push(`Filter for column "${filter.column}" appears to contain raw PII.`);
    });
  }
  if (params.operation === 'join' && params.join) {
    errors.push(...validateJoinRequest(params, context, placeholderIndex));
  } else if (table) {
    errors.push(...validateRows(
      table,
      params,
      placeholderIndex,
      getRelationshipLimits(context),
    ));
  }
  return errors.length > 0
    ? { ok: false, errors, repair: buildRepairBlocker(errors) }
    : { ok: true, errors: [] };
}

function compareFilter(value, filter = {}) {
  const leftNumber = parseNumber(value);
  const rightNumber = parseNumber(filter.value);
  const left = String(value ?? '').trim();
  const right = String(filter.value ?? '').trim();
  switch (filter.operator) {
    case 'equals': return left === right;
    case 'not_equals': return left !== right;
    case 'contains': return left.includes(right);
    case 'gt': return leftNumber !== null && rightNumber !== null && leftNumber > rightNumber;
    case 'gte': return leftNumber !== null && rightNumber !== null && leftNumber >= rightNumber;
    case 'lt': return leftNumber !== null && rightNumber !== null && leftNumber < rightNumber;
    case 'lte': return leftNumber !== null && rightNumber !== null && leftNumber <= rightNumber;
    default: return false;
  }
}

function applyFilters(rows = [], filters = []) {
  if (!Array.isArray(filters) || filters.length === 0) return rows;
  return rows.filter((row) => filters.every((filter) => compareFilter(row.cells?.[filter.column], filter)));
}

function groupRows(table = {}, params = {}, placeholderIndex = new Map()) {
  const rows = applyFilters(table.rows || [], params.filters || []);
  const groups = new Map();
  rows.forEach((row) => {
    const groupValue = normalizeCell(row.cells?.[params.groupBy]);
    const entry = placeholderIndex.get(groupValue);
    const key = entry?.valueIndexHmac || `safe:${groupValue}`;
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key,
        groupPlaceholder: isPlaceholder(groupValue) ? groupValue : '',
        aggregateValue: 0,
        rowCount: 0,
        evidenceRowIds: [],
      });
    }
    const group = groups.get(key);
    const numeric = parseNumber(row.cells?.[params.measure]);
    group.rowCount += 1;
    group.evidenceRowIds.push(row.id);
    if (numeric !== null) group.aggregateValue += numeric;
  });
  return Array.from(groups.values()).map((group) => ({
    groupPlaceholder: group.groupPlaceholder,
    aggregateValue: params.operation === 'group_average'
      ? (group.rowCount > 0 ? group.aggregateValue / group.rowCount : 0)
      : group.aggregateValue,
    rowCount: group.rowCount,
    evidenceRowIds: group.evidenceRowIds,
  }));
}

function executeFilter(table = {}, params = {}) {
  const rows = applyFilters(table.rows || [], params.filters || []);
  return rows.map((row) => ({
    rowId: row.id,
    evidenceRowIds: [row.id],
  }));
}

function executeJoin(params = {}, placeholderIndex = new Map()) {
  const join = params.join || {};
  const left = findTable(params, join.leftTableId);
  const right = findTable(params, join.rightTableId);
  if (!left || !right) {
    const error = new Error('join requires valid leftTableId and rightTableId.');
    error.code = 'pii_relationship_invalid_request';
    throw error;
  }
  const rightByKey = new Map();
  (right.rows || []).forEach((row) => {
    const placeholder = normalizeCell(row.cells?.[join.rightKey]);
    const entry = placeholderIndex.get(placeholder);
    const key = entry?.valueIndexHmac || `safe:${placeholder}`;
    if (!rightByKey.has(key)) rightByKey.set(key, []);
    rightByKey.get(key).push(row);
  });
  const results = [];
  (left.rows || []).forEach((row) => {
    const placeholder = normalizeCell(row.cells?.[join.leftKey]);
    const entry = placeholderIndex.get(placeholder);
    const key = entry?.valueIndexHmac || `safe:${placeholder}`;
    (rightByKey.get(key) || []).forEach((match) => {
      results.push({
        leftRowId: row.id,
        rightRowId: match.id,
        keyPlaceholder: isPlaceholder(placeholder) ? placeholder : '',
        evidenceRowIds: [row.id, match.id],
      });
    });
  });
  return results;
}

async function calculateRelationship(params = {}, context = {}) {
  const placeholderIndex = await loadPlaceholderIndex(context);
  const validation = validateRelationshipCalculationRequest(params, context, placeholderIndex);
  if (!validation.ok) {
    const error = new Error(`Invalid PII relationship calculation request: ${validation.errors.join('; ')}`);
    error.code = 'pii_relationship_invalid_request';
    error.repair = validation.repair;
    throw error;
  }
  const operationId = normalizeId(params.operationId) || `${params.operation}-${Date.now().toString(36)}`;
  if (params.operation === 'join') {
    return {
      operationId,
      operation: params.operation,
      sanitized: true,
      results: executeJoin(params, placeholderIndex),
    };
  }
  const table = findTable(params, params.tableId);
  if (params.operation === 'filter') {
    return {
      operationId,
      operation: params.operation,
      sanitized: true,
      results: executeFilter(table, params),
    };
  }
  let results = groupRows(table, params, placeholderIndex);
  if (params.operation === 'group_count') {
    results = results.map((group) => ({ ...group, aggregateValue: group.rowCount }));
  }
  if (['top_n', 'bottom_n'].includes(params.operation)) {
    const direction = params.operation === 'top_n' ? -1 : 1;
    results = results.sort((a, b) => direction * (a.aggregateValue - b.aggregateValue))
      .slice(0, params.limit || 1);
  }
  const winner = results[0] || null;
  return {
    operationId,
    operation: params.operation,
    sanitized: true,
    results,
    ...(winner ? {
      winnerPlaceholder: winner.groupPlaceholder || '',
      aggregateValue: winner.aggregateValue,
      rowCount: winner.rowCount,
      evidenceRowIds: winner.evidenceRowIds,
    } : {}),
  };
}

async function calculateRelationshipWithRepair(params = {}, context = {}, repairFn = null) {
  try {
    return await calculateRelationship(params, context);
  } catch (error) {
    if (typeof repairFn !== 'function' || error.code !== 'pii_relationship_invalid_request') {
      throw error;
    }
    const repaired = await repairFn({
      request: params,
      repair: error.repair,
      schema: RELATIONSHIP_CALCULATION_SCHEMA,
    });
    return calculateRelationship(repaired, context);
  }
}

module.exports = {
  RELATIONSHIP_CALCULATION_TOOL_ID,
  RELATIONSHIP_CALCULATION_SCHEMA,
  calculateRelationship,
  calculateRelationshipWithRepair,
  validateRelationshipCalculationRequest,
  loadPlaceholderIndex,
};
