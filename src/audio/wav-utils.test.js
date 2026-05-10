const {
  concatWavBuffers,
  createSilenceWavBuffer,
  applyWavEdgeFade,
  normalizeWavBufferFormat,
  parseWavBuffer,
  writeWavBuffer,
} = require('./wav-utils');

describe('wav-utils', () => {
  test('writes and parses PCM wav buffers', () => {
    const input = writeWavBuffer({
      sampleRate: 22050,
      bitsPerSample: 16,
      numChannels: 1,
      data: Buffer.from([1, 2, 3, 4]),
    });

    const parsed = parseWavBuffer(input);

    expect(parsed.sampleRate).toBe(22050);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.data.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  test('concatenates wav buffers with matching pcm format', () => {
    const wavA = writeWavBuffer({
      sampleRate: 22050,
      bitsPerSample: 16,
      numChannels: 1,
      data: Buffer.from([1, 2]),
    });
    const wavB = writeWavBuffer({
      sampleRate: 22050,
      bitsPerSample: 16,
      numChannels: 1,
      data: Buffer.from([3, 4, 5, 6]),
    });

    const combined = concatWavBuffers([wavA, wavB]);
    const parsed = parseWavBuffer(combined);

    expect(parsed.data.equals(Buffer.from([1, 2, 3, 4, 5, 6]))).toBe(true);
  });

  test('creates silence with the same wav format', () => {
    const silence = createSilenceWavBuffer({
      sampleRate: 16000,
      bitsPerSample: 16,
      numChannels: 1,
    }, 250);
    const parsed = parseWavBuffer(silence);

    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.data.some((value) => value !== 0)).toBe(false);
  });

  test('normalizes a wav buffer to a different pcm sample rate', () => {
    const source = writeWavBuffer({
      sampleRate: 16000,
      bitsPerSample: 16,
      numChannels: 1,
      data: Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]),
    });

    const normalized = normalizeWavBufferFormat(source, {
      audioFormat: 1,
      sampleRate: 22050,
      bitsPerSample: 16,
      numChannels: 1,
    });
    const parsed = parseWavBuffer(normalized);

    expect(parsed.sampleRate).toBe(22050);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.data.length).toBeGreaterThan(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]).length);
  });

  test('normalizes IEEE float wav buffers to 16-bit PCM', () => {
    const floatData = Buffer.alloc(8);
    floatData.writeFloatLE(-0.5, 0);
    floatData.writeFloatLE(0.5, 4);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + floatData.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(24000 * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(32, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(floatData.length, 40);
    const source = Buffer.concat([header, floatData]);

    expect(() => parseWavBuffer(source)).toThrow('Only PCM WAV audio is supported for stitching.');

    const normalized = normalizeWavBufferFormat(source, {
      audioFormat: 1,
      sampleRate: 24000,
      bitsPerSample: 16,
      numChannels: 1,
    });
    const parsed = parseWavBuffer(normalized);

    expect(parsed.audioFormat).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.data.readInt16LE(0)).toBeLessThan(0);
    expect(parsed.data.readInt16LE(2)).toBeGreaterThan(0);
  });

  test('applies short edge fades to 16-bit pcm audio', () => {
    const source = writeWavBuffer({
      sampleRate: 1000,
      bitsPerSample: 16,
      numChannels: 1,
      data: Buffer.from([100, 0, 100, 0, 100, 0, 100, 0]),
    });

    const faded = parseWavBuffer(applyWavEdgeFade(source, 2));

    expect(faded.data.readInt16LE(0)).toBe(0);
    expect(faded.data.readInt16LE(2)).toBeGreaterThan(0);
    expect(faded.data.readInt16LE(6)).toBeLessThan(100);
  });

  test('can keep the end of speech untouched when disabling fade out', () => {
    const source = writeWavBuffer({
      sampleRate: 1000,
      bitsPerSample: 16,
      numChannels: 1,
      data: Buffer.from([100, 0, 100, 0, 100, 0, 100, 0]),
    });

    const faded = parseWavBuffer(applyWavEdgeFade(source, 2, { fadeOut: false }));

    expect(faded.data.readInt16LE(0)).toBe(0);
    expect(faded.data.readInt16LE(6)).toBe(100);
  });
});
