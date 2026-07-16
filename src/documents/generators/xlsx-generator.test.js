const { XlsxGenerator } = require('./xlsx-generator');

describe('XlsxGenerator previews', () => {
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
