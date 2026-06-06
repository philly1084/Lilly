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

  test('separates generated sections with dividers instead of full card borders', () => {
    const generator = new PdfGenerator();
    const definition = generator.buildContentDefinition({
      title: 'Decision Brief',
      sections: [
        { heading: 'Recommendation', content: 'Approve the rollout.' },
        { heading: 'Evidence', content: 'The rollout checks are green.' },
      ],
    });

    const firstSection = definition.content[1];
    const secondSection = definition.content[2];

    expect(firstSection.stack[0].layout).toBe('noBorders');
    expect(secondSection.stack[0].canvas[0]).toEqual(expect.objectContaining({
      type: 'line',
      lineWidth: 0.75,
    }));
    expect(secondSection.stack[1].layout).toBe('noBorders');
    expect(secondSection.layout).toBeUndefined();
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

  test('embeds prepared Notes image data with caption and subtext', () => {
    const generator = new PdfGenerator();
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

    const definition = generator.buildNotesPageDefinition({
      title: 'Image Notes',
      blocks: [
        {
          type: 'ai_image',
          content: {
            prompt: 'A clean product diagram',
            _exportImageDataUrl: imageDataUrl,
            _exportCaption: 'Product architecture',
            _exportSubtext: 'Prompt: A clean product diagram',
          },
        },
      ],
    });

    const imageCard = definition.content.find((node) =>
      Array.isArray(node?.table?.body)
      && node.table.body.some((row) =>
        row.some((cell) => cell?.stack?.some((entry) => entry?.image === imageDataUrl))
      )
    );

    expect(imageCard).toBeTruthy();
    const stack = imageCard.table.body[0][0].stack;
    expect(stack).toEqual(expect.arrayContaining([
      expect.objectContaining({ image: imageDataUrl }),
      expect.objectContaining({ text: 'Product architecture' }),
      expect.objectContaining({ text: 'Prompt: A clean product diagram' }),
    ]));
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
