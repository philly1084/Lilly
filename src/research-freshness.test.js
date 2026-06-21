const {
  applyPerplexityResearchLevel,
  applyResearchFreshnessDefaults,
  inferDefaultResearchTimeRange,
  inferPerplexityResearchMode,
  needsExpandedResearchEvidence,
} = require('./research-freshness');

describe('research freshness defaults', () => {
  test('adds recent month qualifier and range for undated news or technology', () => {
    expect(applyResearchFreshnessDefaults({
      query: 'AI chip startups',
    })).toEqual({
      query: 'AI chip startups recent this month',
      timeRange: 'month',
      freshnessQualifier: 'recent this month',
    });
  });

  test('adds modern qualifier for broad provider research without forcing recency', () => {
    expect(applyResearchFreshnessDefaults({
      query: 'managed Postgres providers for startups',
    })).toEqual({
      query: 'managed Postgres providers for startups modern',
      timeRange: 'all',
      freshnessQualifier: 'modern',
    });
  });

  test('preserves explicit timeframe cues and date filters', () => {
    expect(applyResearchFreshnessDefaults({
      query: 'AI chip startups in 2025',
    })).toEqual({
      query: 'AI chip startups in 2025',
      timeRange: 'all',
      freshnessQualifier: '',
    });
    expect(inferDefaultResearchTimeRange('latest GPU prices')).toBe('day');
    expect(inferDefaultResearchTimeRange('modern provider comparison')).toBe('all');
    expect(inferDefaultResearchTimeRange('AI funding activity this quarter')).toBe('month');
    expect(inferDefaultResearchTimeRange('AI tools', { publishedAfter: '05/01/2026' })).toBe('all');
  });

  test('routes explicit research to richer Perplexity modes while preserving raw discovery', () => {
    expect(inferPerplexityResearchMode('Please research managed Postgres providers')).toBe('pro-search');
    expect(inferPerplexityResearchMode('Gather article sources for Canadian AI regulation')).toBe('pro-search');
    expect(inferPerplexityResearchMode('Latest AI headlines')).toBe('pro-search');
    expect(inferPerplexityResearchMode('Do deep research on managed Postgres providers')).toBe('sonar-deep-research');
    expect(inferPerplexityResearchMode('Find URLs for managed Postgres pricing pages')).toBe('search');
    expect(needsExpandedResearchEvidence('Please research managed Postgres providers')).toBe(true);
    expect(needsExpandedResearchEvidence('Latest AI headlines')).toBe(true);
  });

  test('applies admin Perplexity research levels without escalating URL discovery', () => {
    expect(applyPerplexityResearchLevel({
      researchMode: 'pro-search',
      researchLevel: 'regular',
      text: 'Please research managed Postgres providers',
    })).toBe('search');
    expect(applyPerplexityResearchLevel({
      researchMode: 'search',
      researchLevel: 'pro',
      text: 'Please research managed Postgres providers',
    })).toBe('pro-search');
    expect(applyPerplexityResearchLevel({
      researchMode: 'pro-search',
      researchLevel: 'deep',
      text: 'Please research managed Postgres providers',
    })).toBe('sonar-deep-research');
    expect(applyPerplexityResearchLevel({
      researchMode: 'search',
      researchLevel: 'deep',
      text: 'Find URLs for managed Postgres pricing pages',
    })).toBe('search');
  });
});
