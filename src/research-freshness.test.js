const {
  applyResearchFreshnessDefaults,
  inferDefaultResearchTimeRange,
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
    expect(inferDefaultResearchTimeRange('AI tools', { publishedAfter: '05/01/2026' })).toBe('all');
  });
});
