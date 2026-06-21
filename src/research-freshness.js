const DEFAULT_TIME_RANGE = 'all';

const EXPLICIT_TIMEFRAME_RE = /\b(?:today|yesterday|tomorrow|tonight|this\s+(?:week|month|year|quarter)|past\s+\d*\s*(?:hours?|days?|weeks?|months?|years?)|last\s+\d*\s*(?:hours?|days?|weeks?|months?|years?)|recent(?:ly)?|latest|current|modern|new(?:est)?|daily|weekly|monthly|annual(?:ly)?|q[1-4]\s*(?:19|20)?\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|\b(?:19|20)\d{2}\b)\b/i;
const DAY_TIMEFRAME_RE = /\b(?:today|yesterday|tomorrow|tonight|daily|breaking|headlines?|weather|forecast|temperature|latest|current|newest)\b/i;
const WEEK_TIMEFRAME_RE = /\b(?:this week|weekly|past week|last week|last 7 days|past 7 days)\b/i;
const MONTH_TIMEFRAME_RE = /\b(?:this month|monthly|past month|last month|last 30 days|past 30 days|this quarter|past quarter|last quarter|recent(?:ly)?)\b/i;
const YEAR_TIMEFRAME_RE = /\b(?:this year|annual(?:ly)?|past year|last year|last 12 months|past 12 months)\b/i;
const HISTORICAL_RE = /\b(?:history|historical|archive|archives|archived|retrospective|ancient|medieval|legacy|from\s+(?:19|20)\d{2}|between\s+(?:19|20)\d{2}\s+and\s+(?:19|20)\d{2}|before\s+(?:19|20)\d{2})\b/i;
const NEWS_OR_TECH_RE = /\b(?:news|headlines?|current events?|breaking|article roundup|coverage|technology|tech|software|ai|artificial intelligence|machine learning|cybersecurity|cloud|saas|api|apis|sdk|framework|library|javascript|typescript|node\.?js|react|next\.?js|openai|llm|llms|gpu|gpus|chip|chips|semiconductor|hardware|gadgets?|developer|programming|release notes?|version)\b/i;
const MODERN_RESEARCH_RE = /\b(?:best practices?|providers?|vendors?|tools?|options?|alternatives?|trends?|landscape|state of|recommendations?|examples?|patterns?|guide|strategy|strategies|market|pricing|costs?|platforms?)\b/i;
const RAW_DISCOVERY_RE = /\b(?:url hotlist|hotlist urls?|candidate urls?|candidate pages?|find urls?|find pages?|find links?|list links?|search results?|scraping prep|scrape candidates?|playwright candidates?|page discovery|site:\S+)\b/i;
const ADVANCED_DEEP_RESEARCH_RE = /\b(?:advanced deep research|institutional(?:-|\s)grade research|maximum depth research|maximum-depth research)\b/i;
const DEEP_RESEARCH_RE = /\b(?:deep research|in-depth research|comprehensive research|exhaustive research|thorough research)\b/i;
const GATHERED_RESEARCH_RE = /\b(?:pro search|agentic research|autonomous research|multi-tool research|plan\s*\+\s*search\s*\+\s*fetch|one-call research|one call research|daily news|news roundup|news digest|briefing|newsletter|article roundup|articles?|coverage|current events?|gather(?:ed|ing)? sources?|collect(?:ed|ing)? sources?|research data|source-backed|source backed|citations?|sources?)\b/i;
const GROUNDED_ANSWER_RE = /\b(?:grounded answer|answer with citations|one-shot answer|one shot answer|with citations)\b/i;
const EXPLICIT_RESEARCH_RE = /\b(?:research|researched|investigate|investigation|look into|analysis|analyze|analyse|compare|comparison|landscape|survey|review)\b/i;
const PERPLEXITY_RESEARCH_LEVELS = Object.freeze(['auto', 'regular', 'pro', 'deep']);

function normalizeTimeRange(timeRange = DEFAULT_TIME_RANGE) {
  const normalized = String(timeRange || DEFAULT_TIME_RANGE).trim().toLowerCase();
  return normalized || DEFAULT_TIME_RANGE;
}

function queryText(query = '') {
  if (Array.isArray(query)) {
    return query.map((entry) => String(entry || '').trim()).filter(Boolean).join(' ');
  }

  return String(query || '').trim();
}

function hasDateFilter({
  publishedAfter = null,
  publishedBefore = null,
  updatedAfter = null,
  updatedBefore = null,
} = {}) {
  return [publishedAfter, publishedBefore, updatedAfter, updatedBefore]
    .some((value) => String(value || '').trim());
}

function hasExplicitResearchTimeframeCue(text = '', options = {}) {
  if (normalizeTimeRange(options.timeRange) !== DEFAULT_TIME_RANGE || hasDateFilter(options)) {
    return true;
  }

  return EXPLICIT_TIMEFRAME_RE.test(String(text || ''));
}

function hasNewsOrTechnologyResearchCue(text = '') {
  return NEWS_OR_TECH_RE.test(String(text || ''));
}

function hasModernResearchCue(text = '') {
  return MODERN_RESEARCH_RE.test(String(text || ''));
}

function hasHistoricalResearchCue(text = '') {
  return HISTORICAL_RE.test(String(text || ''));
}

function inferDefaultResearchTimeRange(text = '', options = {}) {
  const requestedTimeRange = normalizeTimeRange(options.timeRange);
  if (requestedTimeRange !== DEFAULT_TIME_RANGE || hasDateFilter(options)) {
    return requestedTimeRange;
  }

  const source = String(text || '');
  if (DAY_TIMEFRAME_RE.test(source)) {
    return 'day';
  }
  if (WEEK_TIMEFRAME_RE.test(source)) {
    return 'week';
  }
  if (MONTH_TIMEFRAME_RE.test(source)) {
    return 'month';
  }
  if (YEAR_TIMEFRAME_RE.test(source)) {
    return 'year';
  }
  if (!hasExplicitResearchTimeframeCue(source) && !hasHistoricalResearchCue(source) && hasNewsOrTechnologyResearchCue(source)) {
    return 'month';
  }

  return requestedTimeRange;
}

function appendQualifierToQueryValue(value = '', qualifier = '') {
  const source = String(value || '').trim();
  const suffix = String(qualifier || '').trim();
  if (!source || !suffix || hasExplicitResearchTimeframeCue(source)) {
    return source;
  }

  return `${source.replace(/[.?!]+$/g, '').trim()} ${suffix}`;
}

function appendQualifierToQuery(query = '', qualifier = '') {
  if (Array.isArray(query)) {
    return query.map((entry) => appendQualifierToQueryValue(entry, qualifier));
  }

  return appendQualifierToQueryValue(query, qualifier);
}

function getFreshnessQualifier(text = '', options = {}) {
  const source = String(text || '');
  if (hasExplicitResearchTimeframeCue(source, options) || hasHistoricalResearchCue(source)) {
    return '';
  }

  if (hasNewsOrTechnologyResearchCue(source)) {
    return 'recent this month';
  }

  if (hasModernResearchCue(source)) {
    return 'modern';
  }

  return '';
}

function applyResearchFreshnessDefaults({
  query = '',
  prompt = '',
  timeRange = DEFAULT_TIME_RANGE,
  publishedAfter = null,
  publishedBefore = null,
  updatedAfter = null,
  updatedBefore = null,
} = {}) {
  const source = [prompt, queryText(query)].filter(Boolean).join(' ');
  const options = {
    timeRange,
    publishedAfter,
    publishedBefore,
    updatedAfter,
    updatedBefore,
  };
  const qualifier = getFreshnessQualifier(source, options);
  const resolvedTimeRange = inferDefaultResearchTimeRange(source, options);

  return {
    query: qualifier ? appendQualifierToQuery(query, qualifier) : query,
    timeRange: resolvedTimeRange,
    freshnessQualifier: qualifier,
  };
}

function inferPerplexityResearchMode(text = '', fallback = 'search') {
  const source = String(text || '').trim();
  if (!source) {
    return fallback;
  }

  if (RAW_DISCOVERY_RE.test(source)) {
    return 'search';
  }

  if (ADVANCED_DEEP_RESEARCH_RE.test(source)) {
    return 'advanced-deep-research';
  }

  if (DEEP_RESEARCH_RE.test(source)) {
    return 'sonar-deep-research';
  }

  if (GATHERED_RESEARCH_RE.test(source)) {
    return 'pro-search';
  }

  if (GROUNDED_ANSWER_RE.test(source)) {
    return 'sonar-pro';
  }

  if (EXPLICIT_RESEARCH_RE.test(source)) {
    return 'pro-search';
  }

  return fallback;
}

function normalizePerplexityResearchLevel(value = 'auto') {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return PERPLEXITY_RESEARCH_LEVELS.includes(normalized) ? normalized : 'auto';
}

function needsExpandedResearchEvidence(text = '') {
  const source = String(text || '').trim();
  if (!source) {
    return false;
  }

  return GATHERED_RESEARCH_RE.test(source)
    || EXPLICIT_RESEARCH_RE.test(source)
    || DEEP_RESEARCH_RE.test(source)
    || ADVANCED_DEEP_RESEARCH_RE.test(source);
}

function needsDeepResearchEvidence(text = '') {
  const source = String(text || '').trim();
  return Boolean(source) && (DEEP_RESEARCH_RE.test(source) || ADVANCED_DEEP_RESEARCH_RE.test(source));
}

function applyPerplexityResearchLevel({
  researchMode = 'search',
  researchLevel = 'auto',
  text = '',
} = {}) {
  const mode = String(researchMode || 'search').trim();
  const level = normalizePerplexityResearchLevel(researchLevel);
  const source = String(text || '').trim();
  const isDiscoveryOnly = RAW_DISCOVERY_RE.test(source);
  const isResearchLike = needsExpandedResearchEvidence(source) || mode !== 'search';

  if (level === 'auto' || isDiscoveryOnly) {
    return mode || 'search';
  }

  if (level === 'regular') {
    return 'search';
  }

  if (!isResearchLike) {
    return mode || 'search';
  }

  if (level === 'deep') {
    return 'sonar-deep-research';
  }

  return 'pro-search';
}

module.exports = {
  applyPerplexityResearchLevel,
  applyResearchFreshnessDefaults,
  hasExplicitResearchTimeframeCue,
  hasNewsOrTechnologyResearchCue,
  inferDefaultResearchTimeRange,
  inferPerplexityResearchMode,
  normalizePerplexityResearchLevel,
  needsDeepResearchEvidence,
  needsExpandedResearchEvidence,
};
