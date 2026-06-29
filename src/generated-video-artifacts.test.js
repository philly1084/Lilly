const {
  buildGeneratedVideoFilename,
} = require('./generated-video-artifacts');

describe('generated-video-artifacts', () => {
  test('sanitizes explicit generated video filenames before download handoff', () => {
    expect(buildGeneratedVideoFilename({
      filename: '..\\Launch: Reel\r\nFinal"',
    })).toBe('-Launch- ReelFinal.mp4');
  });

  test('uses a stable fallback video filename when no title is available', () => {
    expect(buildGeneratedVideoFilename()).toBe('generated-video.mp4');
  });
});
