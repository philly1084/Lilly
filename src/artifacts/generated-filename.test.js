const { sanitizeGeneratedFilename } = require('./generated-filename');

describe('sanitizeGeneratedFilename', () => {
  test('keeps the generated format authoritative over a conflicting filename extension', () => {
    expect(sanitizeGeneratedFilename('Quarterly brief.docx', 'pdf'))
      .toBe('Quarterly brief.pdf');
  });

  test('does not duplicate a matching extension', () => {
    expect(sanitizeGeneratedFilename('Release narration.WAV', '.wav'))
      .toBe('Release narration.wav');
  });

  test('keeps the complete filename within the handoff length limit', () => {
    const filename = sanitizeGeneratedFilename(`${'a'.repeat(200)}.html`, 'html');

    expect(filename).toHaveLength(160);
    expect(filename).toMatch(/\.html$/);
  });
});
