const { PdfGenerator } = require('./pdf-generator');

describe('PdfGenerator', () => {
  test('uses the default large portrait page size with border room', () => {
    const generator = new PdfGenerator();
    const definition = generator.buildContentDefinition({
      title: 'Decision Brief',
      sections: [{ heading: 'Recommendation', content: 'Approve the rollout.' }],
    });

    expect(definition.pageSize).toEqual({
      width: 11.33 * 72,
      height: 14.67 * 72,
    });
    expect(definition.pageMargins).toEqual([54, 62, 54, 58]);
  });

  test('generates a Notes page PDF buffer', async () => {
    const generator = new PdfGenerator();

    const document = await generator.generateFromNotesPage({
      title: 'Planning Notes',
      blocks: [
        { type: 'heading_1', content: 'Launch Plan' },
        { type: 'paragraph', content: 'Prepare the release checklist.' },
        {
          type: 'database',
          content: {
            columns: ['Owner', 'Status'],
            rows: [['Design', 'Ready'], ['Backend', 'In progress']],
          },
        },
      ],
    }, {
      includeOutline: true,
      includePageNumbers: true,
    });

    expect(Buffer.isBuffer(document.buffer)).toBe(true);
    expect(document.buffer.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(document.metadata).toEqual(expect.objectContaining({
      format: 'pdf',
      title: 'Planning Notes',
      blockCount: 3,
    }));
  });

  test('generates structured content PDF fallback buffer', async () => {
    const generator = new PdfGenerator();

    const document = await generator.generateFromContent({
      title: 'Decision Brief',
      sections: [
        {
          heading: 'Recommendation',
          content: 'Approve the rollout.',
          bullets: ['Assign owner', 'Publish checklist'],
        },
      ],
    });

    expect(Buffer.isBuffer(document.buffer)).toBe(true);
    expect(document.buffer.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(document.metadata).toEqual(expect.objectContaining({
      format: 'pdf',
      title: 'Decision Brief',
      sections: 1,
    }));
  });
});
