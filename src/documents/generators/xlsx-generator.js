const { buildXlsxBufferFromWorkbookSpec, ensureHtmlDocument } = require('../../artifacts/artifact-renderer');
const { escapeHtml } = require('../../utils/text');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value = '', limit = 240) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function sanitizeSheetName(name = 'Sheet', usedNames = new Set()) {
  const base = String(name || 'Sheet')
    .replace(/[\\/*?:\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';

  let candidate = base;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` ${counter}`;
    candidate = `${base.slice(0, Math.max(0, 31 - suffix.length)).trim()}${suffix}`.trim();
    counter += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

class XlsxGenerator {
  constructor() {
    this.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  async generateFromContent(content = {}, options = {}) {
    const workbookSpec = this.buildWorkbookSpec(content, options);
    const previewHtml = this.buildPreviewHtml(workbookSpec);
    const extractedText = this.extractWorkbookText(workbookSpec);

    return {
      buffer: buildXlsxBufferFromWorkbookSpec(workbookSpec),
      mimeType: this.mimeType,
      previewHtml,
      extractedText,
      metadata: {
        format: 'xlsx',
        title: workbookSpec.title || content.title || 'Workbook',
        sheetCount: workbookSpec.sheets.length,
        sheets: workbookSpec.sheets.map((sheet) => sheet.name),
      },
    };
  }

  buildWorkbookSpec(content = {}, options = {}) {
    const sections = Array.isArray(content.sections) ? content.sections : [];
    const usedNames = new Set();
    const sheets = [];
    const title = content.title || options.title || 'Workbook';
    const generatedAt = new Date().toISOString();

    const overviewRows = [
      ['Field', 'Value'],
      ['Title', title],
      ['Subtitle', content.subtitle || ''],
      ['Theme', content.theme || options.theme || 'editorial'],
      ['Sections', sections.length],
      ['Generated At', generatedAt],
    ];

    sheets.push({
      name: sanitizeSheetName('Overview', usedNames),
      rows: overviewRows,
      headerRowIndex: 0,
    });

    const sectionRows = [
      ['Section', 'Summary', 'Bullets', 'Stats', 'Table Rows', 'Chart Points'],
      ...sections.map((section, index) => ([
        section.heading || `Section ${index + 1}`,
        truncateText(section.content, 320),
        Array.isArray(section.bullets) ? section.bullets.join(' | ') : '',
        Array.isArray(section.stats)
          ? section.stats
            .map((stat) => [stat.label || 'Metric', stat.value || '', stat.detail || ''].filter(Boolean).join(': '))
            .join(' | ')
          : '',
        Array.isArray(section.table?.rows) ? section.table.rows.length : 0,
        Array.isArray(section.chart?.series) ? section.chart.series.length : 0,
      ])),
    ];

    sheets.push({
      name: sanitizeSheetName('Sections', usedNames),
      rows: sectionRows,
      headerRowIndex: 0,
    });

    sections.forEach((section, index) => {
      if (section.table?.headers?.length || section.table?.rows?.length) {
        const headers = Array.isArray(section.table.headers) ? section.table.headers : [];
        const rows = Array.isArray(section.table.rows) ? section.table.rows : [];
        const tableRows = [];

        if (section.table.caption) {
          tableRows.push(['Caption', section.table.caption]);
          tableRows.push([]);
        }
        const headerRowIndex = headers.length > 0 ? tableRows.length : null;
        if (headers.length > 0) {
          tableRows.push(headers);
        }
        rows.forEach((row) => tableRows.push(Array.isArray(row) ? row : [row]));

        sheets.push({
          name: sanitizeSheetName(`${section.heading || `Section ${index + 1}`} Table`, usedNames),
          rows: tableRows.length > 0 ? tableRows : [['No table rows available']],
          headerRowIndex,
        });
      }

      if (Array.isArray(section.chart?.series) && section.chart.series.length > 0) {
        const chartRows = [];
        if (section.chart.title) {
          chartRows.push(['Chart', section.chart.title]);
        }
        if (section.chart.summary) {
          chartRows.push(['Summary', section.chart.summary]);
        }
        if (chartRows.length > 0) {
          chartRows.push([]);
        }
        const headerRowIndex = chartRows.length;
        chartRows.push(['Label', 'Value']);
        section.chart.series.forEach((point) => {
          chartRows.push([
            point.label || '',
            Number.isFinite(Number(point.value)) ? Number(point.value) : String(point.value ?? ''),
          ]);
        });

        sheets.push({
          name: sanitizeSheetName(`${section.heading || `Section ${index + 1}`} Chart`, usedNames),
          rows: chartRows,
          headerRowIndex,
        });
      }
    });

    return {
      title,
      sheets,
    };
  }

  buildPreviewHtml(workbookSpec = {}) {
    const sheets = Array.isArray(workbookSpec.sheets) ? workbookSpec.sheets : [];
    const body = [
      '<style>',
      '.workbook-preview { font-family: "Aptos", "Segoe UI", sans-serif; color: #17212B; max-width: 1080px; margin: 0 auto; padding: 32px 24px 56px; }',
      '.workbook-header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin-bottom: 24px; }',
      '.workbook-header h1 { margin: 0; font-size: 2rem; }',
      '.workbook-header p { margin: 0; color: #64748B; }',
      '.workbook-sheet { margin: 0 0 24px; padding: 22px; border: 1px solid #D8E1F0; border-radius: 20px; background: #FFFFFF; }',
      '.workbook-sheet h2 { margin: 0 0 14px; font-size: 1.15rem; }',
      '.workbook-sheet-meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0 0 14px; color: #475569; }',
      '.workbook-sheet-meta dt { font-weight: 700; }',
      '.workbook-sheet-meta dd { margin: 0; }',
      '.workbook-sheet table { width: 100%; border-collapse: collapse; }',
      '.workbook-sheet th, .workbook-sheet td { border-bottom: 1px solid #E2E8F0; padding: 10px 12px; text-align: left; vertical-align: top; }',
      '.workbook-sheet th { background: #F8FAFC; font-weight: 700; }',
      '</style>',
      '<div class="workbook-preview">',
      `<header class="workbook-header"><h1>${escapeHtml(workbookSpec.title || 'Workbook')}</h1><p>${sheets.length} sheet${sheets.length === 1 ? '' : 's'}</p></header>`,
      ...sheets.map((sheet) => this.renderSheetPreview(sheet)),
      '</div>',
    ].join('\n');

    return ensureHtmlDocument(body, workbookSpec.title || 'Workbook');
  }

  renderSheetPreview(sheet = {}) {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const maxColumns = rows.reduce((largest, row) => Math.max(largest, Array.isArray(row) ? row.length : 0), 0);
    if (maxColumns === 0) {
      return `<section class="workbook-sheet"><h2>${escapeHtml(sheet.name || 'Sheet')}</h2><p>No rows.</p></section>`;
    }

    const hasExplicitHeader = Number.isInteger(sheet.headerRowIndex)
      && sheet.headerRowIndex >= 0
      && sheet.headerRowIndex < rows.length;
    const headerIndex = hasExplicitHeader
      ? sheet.headerRowIndex
      : rows.findIndex((row) => Array.isArray(row) && row.length === maxColumns && row.every((cell) => normalizeText(cell)));
    const headerRow = headerIndex >= 0 ? rows[headerIndex] : null;
    const contextRows = hasExplicitHeader
      ? rows.slice(0, headerIndex).filter((row) => Array.isArray(row) && row.some((cell) => normalizeText(cell)))
      : [];
    const bodyRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;

    return [
      '<section class="workbook-sheet">',
      `<h2>${escapeHtml(sheet.name || 'Sheet')}</h2>`,
      contextRows.length > 0
        ? `<dl class="workbook-sheet-meta">${contextRows.map((row) => `<dt>${escapeHtml(String(row[0] ?? ''))}</dt><dd>${escapeHtml(String(row.slice(1).join(' ') || ''))}</dd>`).join('')}</dl>`
        : '',
      '<table>',
      headerRow
        ? `<thead><tr>${headerRow.map((cell) => `<th>${escapeHtml(String(cell ?? ''))}</th>`).join('')}</tr></thead>`
        : '',
      `<tbody>${bodyRows.map((row) => `<tr>${this.normalizePreviewRow(row, maxColumns).map((cell) => `<td>${escapeHtml(String(cell ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>`,
      '</table>',
      '</section>',
    ].join('\n');
  }

  normalizePreviewRow(row = [], columnCount = 1) {
    const safeRow = Array.isArray(row) ? row.slice(0, columnCount) : [row];
    while (safeRow.length < columnCount) {
      safeRow.push('');
    }
    return safeRow;
  }

  extractWorkbookText(workbookSpec = {}) {
    const sheets = Array.isArray(workbookSpec.sheets) ? workbookSpec.sheets : [];
    return sheets.map((sheet) => {
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      return [
        `[${sheet.name || 'Sheet'}]`,
        ...rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')).join(' | ') : String(row ?? ''))),
      ].join('\n');
    }).join('\n\n');
  }
}

module.exports = { XlsxGenerator };
