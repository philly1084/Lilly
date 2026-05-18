const { sanitizeText } = require('./pii-redactor');
const { DEFAULT_PRIVACY_PII_SETTINGS } = require('./pii-policy');

const SAFE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/i;
const PLACEHOLDER_PATTERN = /^\[\[PII:[^\]]+\]\]$/;
const SENSITIVE_HEADER_TYPES = [
  { pattern: /\b(?:patient\s*key|patient\s*(?:id|identifier|number)|mrn|medical\s*record)\b/i, type: 'patientIdentifier' },
  { pattern: /\b(?:legal\s*)?(?:first|last|full)?\s*name\b/i, type: 'personName' },
  { pattern: /\b(?:subscriber|emergency\s*contact)\s*name\b/i, type: 'personName' },
  { pattern: /\b(?:dob|date\s*of\s*birth|birth\s*date|subscriber\s*dob)\b/i, type: 'dateOfBirth' },
  { pattern: /\bssn\b|\bsocial\s*security\b/i, type: 'ssn' },
  { pattern: /\bphone\b/i, type: 'phone' },
  { pattern: /\bemail\b/i, type: 'email' },
  { pattern: /\baddress\b|\bcity\b|\bstate\b|\bzip\b|\bpostal\b/i, type: 'address' },
  { pattern: /\b(?:claim|invoice|policy|group)\s*(?:number|id)?\b/i, type: 'patientIdentifier' },
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStructuredTables(input = []) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.structuredTables)) return input.structuredTables;
  if (Array.isArray(input?.metadata?.structuredTables)) return input.metadata.structuredTables;
  return [];
}

function normalizeId(candidate = '', fallback = '') {
  const normalized = String(candidate || '').trim();
  if (SAFE_ID_PATTERN.test(normalized)) return normalized.slice(0, 80);
  return fallback;
}

function buildColumnId(column = {}, index = 0, usedIds = new Set()) {
  const fallback = `c${index + 1}`;
  let candidate = normalizeId(column.id, fallback);
  if (!/^c\d+$/i.test(candidate)) {
    candidate = fallback;
  }
  let id = candidate;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${candidate}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function getCellValue(row = {}, column = {}, columnIndex = 0) {
  const cells = asArray(row.cells);
  const byColumnId = cells.find((cell) => String(cell?.columnId || '') === String(column.id || ''));
  if (byColumnId) return byColumnId.value;
  const byColumnIndex = cells.find((cell) => Number(cell?.columnIndex) === Number(column.columnIndex));
  if (byColumnIndex) return byColumnIndex.value;
  return cells[columnIndex]?.value;
}

function parseMeasureNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const source = String(value ?? '').trim();
  if (!source || PLACEHOLDER_PATTERN.test(source)) return null;
  const normalized = source
    .replace(/\(([^)]+)\)/, '-$1')
    .replace(/[$,%\s,]/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePromptText(value = '') {
  return String(value || '').trim().toLowerCase();
}

function columnText(column = {}) {
  return `${column.id || ''} ${column.header || ''}`.trim().toLowerCase();
}

function promptMentionsAny(prompt = '', words = []) {
  const normalized = normalizePromptText(prompt);
  return words.some((word) => normalized.includes(String(word || '').toLowerCase()));
}

function inferRelationshipOperation(text = '') {
  const normalized = normalizePromptText(text);
  if (/\b(?:average|mean)\b/.test(normalized)) return 'group_average';
  if (/\b(?:count|how many|number of)\b/.test(normalized)) return 'group_count';
  if (/\b(?:lowest|smallest|least|min(?:imum)?|bottom)\b/.test(normalized)) return 'bottom_n';
  if (/\b(?:highest|largest|greatest|most|max(?:imum)?|top|biggest)\b/.test(normalized)) return 'top_n';
  if (/\b(?:sum|total|totals|subtotal|add up|aggregate|balance)\b/.test(normalized)) return 'group_sum';
  return null;
}

function scoreColumnForPrompt(column = {}, text = '', fallbackScore = 0) {
  const haystack = columnText(column);
  const prompt = normalizePromptText(text);
  const headerWords = haystack.split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  const wordScore = headerWords.reduce((score, word) => score + (prompt.includes(word) ? 3 : 0), 0);
  const semanticScore = [
    { words: ['balance', 'balances'], boost: /\bbalance\b/.test(haystack) ? 8 : 0 },
    { words: ['charge', 'charges', 'cost', 'costs'], boost: /\b(?:charge|cost)\b/.test(haystack) ? 8 : 0 },
    { words: ['paid', 'payment', 'payments'], boost: /\b(?:paid|payment)\b/.test(haystack) ? 8 : 0 },
    { words: ['allowed', 'allowance'], boost: /\ballowed\b/.test(haystack) ? 8 : 0 },
    { words: ['patient'], boost: /\bpatient\b/.test(haystack) ? 8 : 0 },
    { words: ['mrn', 'medical record'], boost: /\bmrn\b|\bmedical\b/.test(haystack) ? 7 : 0 },
  ].reduce((score, entry) => score + (promptMentionsAny(text, entry.words) ? entry.boost : 0), 0);
  return fallbackScore + wordScore + semanticScore;
}

function chooseWorkbookRelationshipTable(tables = []) {
  return asArray(tables).find((table) => (
    asArray(table.rows).length > 0
    && asArray(table.columns).some((column) => column.role === 'private-group-key')
    && asArray(table.columns).some((column) => column.role === 'measure')
  )) || null;
}

function chooseGroupColumn(table = {}, text = '') {
  const privateColumns = asArray(table.columns).filter((column) => column.role === 'private-group-key');
  if (privateColumns.length === 0) return null;
  return privateColumns
    .map((column, index) => ({
      column,
      score: scoreColumnForPrompt(column, text, privateColumns.length - index),
    }))
    .sort((left, right) => right.score - left.score)[0]?.column || privateColumns[0];
}

function chooseMeasureColumn(table = {}, text = '') {
  const measureColumns = asArray(table.columns).filter((column) => column.role === 'measure');
  if (measureColumns.length === 0) return null;
  return measureColumns
    .map((column, index) => ({
      column,
      score: scoreColumnForPrompt(column, text, measureColumns.length - index),
    }))
    .sort((left, right) => right.score - left.score)[0]?.column || measureColumns[0];
}

function inferWorkbookRelationshipCalculationRequest({
  text = '',
  tables = [],
  limit = 1,
} = {}) {
  const operation = inferRelationshipOperation(text);
  if (!operation) return null;
  const table = chooseWorkbookRelationshipTable(tables);
  if (!table) return null;
  const groupColumn = chooseGroupColumn(table, text);
  if (!groupColumn) return null;
  const measureColumn = operation === 'group_count' ? null : chooseMeasureColumn(table, text);
  if (operation !== 'group_count' && !measureColumn) return null;

  return {
    operationId: `workbook-${operation}`,
    operation,
    tableId: table.id,
    groupBy: groupColumn.id,
    ...(measureColumn ? { measure: measureColumn.id } : {}),
    ...(operation === 'top_n' || operation === 'bottom_n' ? { limit: Math.max(1, Math.min(Number(limit) || 1, 100)) } : {}),
    tables: [table],
  };
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(String(value || '').trim());
}

function inferColumnRole(values = []) {
  const populated = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (populated.some(isPlaceholder)) return 'private-group-key';
  const numericCount = populated.filter((value) => parseMeasureNumber(value) !== null).length;
  if (numericCount > 0 && numericCount === populated.length) return 'measure';
  return 'dimension';
}

function inferSensitiveColumnType(header = '') {
  const normalized = String(header || '').trim();
  if (!normalized) return '';
  const match = SENSITIVE_HEADER_TYPES.find((entry) => entry.pattern.test(normalized));
  return match?.type || '';
}

function buildPolicy(policy = {}) {
  const source = policy && typeof policy === 'object' ? policy : {};
  return {
    ...DEFAULT_PRIVACY_PII_SETTINGS,
    ...source,
    relationshipCalculations: {
      ...DEFAULT_PRIVACY_PII_SETTINGS.relationshipCalculations,
      ...(source.relationshipCalculations || {}),
      active: true,
      reason: source.relationshipCalculations?.reason || 'workbook-structured-table',
    },
  };
}

async function sanitizeWorkbookText(value, options = {}) {
  const source = String(value ?? '');
  if (!source.trim()) {
    return {
      text: '',
      contextId: null,
      replacements: [],
    };
  }
  return sanitizeText(source, options);
}

async function sanitizeSensitiveWorkbookCell(value, piiType = '', options = {}) {
  const source = String(value ?? '').trim();
  if (!source || !piiType) {
    return {
      text: source,
      contextId: null,
      replacements: [],
    };
  }
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  return sanitizeText(source, {
    ...options,
    metadata,
    policy: {
      ...(options.policy || {}),
      dictionary: [
        ...asArray(options.policy?.dictionary),
        {
          type: piiType,
          value: source,
          action: 'vault-placeholder',
        },
      ],
    },
  });
}

function toContextEntry(replacement = {}, source = {}) {
  if (!replacement?.placeholder || !replacement?.valueIndexHmac) return null;
  return {
    placeholder: replacement.placeholder,
    valueIndexHmac: replacement.valueIndexHmac,
    piiType: replacement.type || replacement.piiType || 'PII',
    source: {
      tableId: source.tableId,
      rowId: source.rowId,
      columnId: source.columnId,
    },
  };
}

async function sanitizeColumnHeaders(headers = [], options = {}) {
  const sanitized = [];
  for (const column of headers) {
    const result = await sanitizeWorkbookText(column.header || '', options);
    sanitized.push(result.text || column.id);
  }
  return sanitized;
}

async function prepareWorkbookRelationshipInput({
  structuredTables = [],
  policy = {},
  sessionId = '',
  ownerId = null,
  clientSurface = 'workbook-relationship',
  route = 'pii-workbook-relationship',
  metadata = {},
} = {}) {
  const tables = normalizeStructuredTables(structuredTables);
  const resolvedPolicy = buildPolicy(policy);
  const sanitizeOptions = {
    sessionId,
    ownerId,
    clientSurface,
    route,
    metadata,
    policy: resolvedPolicy,
  };
  const contextIds = [];
  const piiEntries = [];
  const modelTables = [];

  for (const [tableIndex, table] of tables.entries()) {
    const tableId = `t${tableIndex + 1}`;
    const usedColumnIds = new Set();
    const sourceHeaders = asArray(table.headers);
    const columnMap = sourceHeaders.map((column, columnIndex) => ({
      source: column,
      id: buildColumnId(column, columnIndex, usedColumnIds),
      index: columnIndex,
      sensitiveType: inferSensitiveColumnType(column?.header || ''),
    }));
    const safeHeaders = await sanitizeColumnHeaders(columnMap.map((column) => ({
      id: column.id,
      header: column.source?.header,
    })), sanitizeOptions);
    const rows = [];
    const columnValues = new Map(columnMap.map((column) => [column.id, []]));

    for (const [rowIndex, row] of asArray(table.rows).entries()) {
      const rowId = `${tableId}_${normalizeId(row.id, `r${rowIndex + 1}`)}`;
      const cells = {};

      for (const column of columnMap) {
        const rawValue = getCellValue(row, column.source, column.index);
        let safeValue = rawValue;
        if (typeof rawValue === 'string' || (column.sensitiveType && rawValue !== null && rawValue !== undefined)) {
          const result = column.sensitiveType
            ? await sanitizeSensitiveWorkbookCell(rawValue, column.sensitiveType, sanitizeOptions)
            : await sanitizeWorkbookText(rawValue, sanitizeOptions);
          safeValue = result.text;
          if (result.contextId) contextIds.push(result.contextId);
          asArray(result.replacements).forEach((replacement) => {
            const entry = toContextEntry(replacement, {
              tableId,
              rowId,
              columnId: column.id,
            });
            if (entry) piiEntries.push(entry);
          });
        }
        cells[column.id] = safeValue === null || safeValue === undefined ? '' : safeValue;
        columnValues.get(column.id).push(cells[column.id]);
      }

      if (Object.values(cells).some((value) => String(value ?? '').trim() !== '')) {
        rows.push({ id: rowId, cells });
      }
    }

    const columns = columnMap.map((column, columnIndex) => {
      const role = inferColumnRole(columnValues.get(column.id) || []);
      return {
        id: column.id,
        header: safeHeaders[columnIndex] || column.id,
        role,
      };
    });

    const measureColumns = new Set(columns.filter((column) => column.role === 'measure').map((column) => column.id));
    rows.forEach((row) => {
      measureColumns.forEach((columnId) => {
        const parsed = parseMeasureNumber(row.cells[columnId]);
        row.cells[columnId] = parsed === null ? '' : parsed;
      });
    });

    modelTables.push({
      id: tableId,
      columns,
      rows,
    });
  }

  const relationshipCalculations = {
    ...resolvedPolicy.relationshipCalculations,
    active: true,
    reason: resolvedPolicy.relationshipCalculations?.reason || 'workbook-structured-table',
  };
  const uniqueContextIds = Array.from(new Set(contextIds));

  return {
    tables: modelTables,
    context: {
      piiEntries,
      piiContextIds: uniqueContextIds,
      piiCleansing: {
        contextIds: uniqueContextIds,
        replacementCount: piiEntries.length,
        relationshipCalculations,
        workbookRelationship: {
          source: 'xlsx-structured-tables',
          tableCount: modelTables.length,
          rowCount: modelTables.reduce((count, table) => count + table.rows.length, 0),
          placeholderCellCount: piiEntries.length,
          measureColumnCount: modelTables.reduce(
            (count, table) => count + table.columns.filter((column) => column.role === 'measure').length,
            0,
          ),
        },
      },
    },
  };
}

module.exports = {
  prepareWorkbookRelationshipInput,
  inferWorkbookRelationshipCalculationRequest,
  normalizeStructuredTables,
  inferColumnRole,
  inferSensitiveColumnType,
  parseMeasureNumber,
};
