const {
  buildDirectPodcastParams,
} = require('./direct-podcast-chat');

describe('direct podcast chat intent', () => {
  test('preserves the full creative brief and infers a solo host request', () => {
    const request = [
      'Please make a one-speaker podcast.',
      'Title: NASA After Dark: Real Space Facts for a Sci-Fi Night.',
      'Use real NASA facts as launch points: Voyager, the ISS, Mars rovers, Deep Space Network, Parker Solar Probe, JWST, and Apollo moon dust.',
      'Keep it cinematic but grounded.',
    ].join(' ');

    const params = buildDirectPodcastParams({ text: request });

    expect(params).toEqual(expect.objectContaining({
      hostCount: 1,
      requestBrief: request,
    }));
    expect(params.topic).toContain('Title: NASA After Dark');
    expect(params.requestBrief).toContain('one-speaker podcast');
    expect(params.requestBrief).toContain('Voyager');
    expect(params.requestBrief).toContain('cinematic but grounded');
  });

  test.each([
    ['make a proper full podcast on battery recycling', 'proper full'],
    ['create a longer detailed podcast about local food systems', 'longer detailed'],
    ['generate a non-short podcast covering AI safety tradeoffs', 'non-short'],
    ['make an in-depth comprehensive podcast on Mars rovers', 'in-depth comprehensive'],
  ])('infers longer richer parameters from qualitative script request: %s', (request, expectedBriefText) => {
    const params = buildDirectPodcastParams({ text: request });

    expect(params).toEqual(expect.objectContaining({
      durationMinutes: 12,
      detailLevel: 'rich',
      requestBrief: request,
    }));
    expect(params.requestBrief).toContain(expectedBriefText);
  });

  test('preserves explicit duration over qualitative longer wording', () => {
    const params = buildDirectPodcastParams({
      text: 'make a proper full 7 minute podcast on adaptive reuse architecture',
    });

    expect(params).toEqual(expect.objectContaining({
      durationMinutes: 7,
      detailLevel: 'rich',
    }));
  });
});
