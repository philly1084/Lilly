const { XlsxGenerator } = require('./xlsx-generator');

describe('XlsxGenerator previews', () => {
  test('preserves every data row when a table explicitly has no headers', () => {
    const generator = new XlsxGenerator();
    const workbook = generator.buildWorkbookSpec({
      title: 'Regional totals',
      sections: [{
        heading: 'Regions',
        table: { rows: [['Atlantic', 0], ['Pacific', 12], ['Central', false]] },
      }],
    });
    const sheet = workbook.sheets.find((entry) => entry.name === 'Regions Table');
    const preview = generator.renderSheetPreview(sheet);

    expect(sheet.headerRowIndex).toBeNull();
    expect(preview).not.toContain('<thead>');
    expect(preview).toContain('<tr><td>Atlantic</td><td>0</td></tr>');
    expect(preview).toContain('<tr><td>Pacific</td><td>12</td></tr>');
    expect(preview).toContain('<tr><td>Central</td><td>false</td></tr>');
  });

  test('keeps a caption and leading incomplete rows in a headerless table', () => {
    const generator = new XlsxGenerator();
    const workbook = generator.buildWorkbookSpec({
      sections: [{
        heading: 'Regions',
        table: { caption: 'Regional totals', rows: [['Atlantic', '', 0], ['Pacific', 12, 3]] },
      }],
    });
    const preview = generator.renderSheetPreview(workbook.sheets.find((sheet) => sheet.name === 'Regions Table'));

    expect(preview).not.toContain('<thead>');
    expect(preview).toContain('<td>Caption</td><td>Regional totals</td>');
    expect(preview).toContain('<tr><td>Atlantic</td><td></td><td>0</td></tr>');
    expect(preview).toContain('<tr><td>Pacific</td><td>12</td><td>3</td></tr>');
  });

  test('still infers headers for legacy sheets without header metadata', () => {
    const preview = new XlsxGenerator().renderSheetPreview({
      name: 'Legacy',
      rows: [['Region', 'Total'], ['Atlantic', 0]],
    });

    expect(preview).toContain('<th>Region</th><th>Total</th>');
    expect(preview).toContain('<td>Atlantic</td><td>0</td>');
  });

  test('uses data headers instead of chart titles or table captions', () => {
    const generator = new XlsxGenerator();
    const workbook = generator.buildWorkbookSpec({
      title: 'Quarterly performance',
      sections: [{
        heading: 'Revenue',
        table: {
          caption: 'Revenue by region',
          headers: ['Region', 'Revenue'],
          rows: [['Atlantic', '$125K']],
        },
        chart: {
          title: 'Revenue trend',
          summary: 'Quarterly revenue increased.',
          series: [{ label: 'Q1', value: 125 }],
        },
      }],
    });

    const tableSheet = workbook.sheets.find((sheet) => sheet.name === 'Revenue Table');
    const chartSheet = workbook.sheets.find((sheet) => sheet.name === 'Revenue Chart');
    const tablePreview = generator.renderSheetPreview(tableSheet);
    const chartPreview = generator.renderSheetPreview(chartSheet);

    expect(tablePreview).toContain('<th>Region</th><th>Revenue</th>');
    expect(tablePreview).not.toContain('<th>Caption</th>');
    expect(tablePreview).toContain('<dt>Caption</dt><dd>Revenue by region</dd>');
    expect(chartPreview).toContain('<th>Label</th><th>Value</th>');
    expect(chartPreview).not.toContain('<th>Chart</th>');
    expect(chartPreview).not.toContain('<th>Summary</th>');
    expect(chartPreview).toContain('<dt>Chart</dt><dd>Revenue trend</dd>');
    expect(chartPreview).toContain('<dt>Summary</dt><dd>Quarterly revenue increased.</dd>');
  });
});
