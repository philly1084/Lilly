const DEFAULT_DETECTORS = [
  'email',
  'phone',
  'ssn',
  'creditCard',
  'dateOfBirth',
  'address',
  'ipAddress',
];

const ACTIONABLE_DICTIONARY_TYPES = new Set([
  'personName',
  'organization',
  'orgName',
  'employer',
  'workplace',
  'company',
  'clientName',
  'teamName',
]);

const BUILTIN_PATTERNS = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,
  address: /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,5}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?)\b/g,
  ipAddress: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  organization: /\b[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}\s+(?:Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Company|Co\.?|Group|Systems|Solutions|Technologies|Tech|Labs|Security|Health|Bank|University|College)\b/g,
};

const MONTH_NAMES = [
  'january', 'jan',
  'february', 'feb',
  'march', 'mar',
  'april', 'apr',
  'may',
  'june', 'jun',
  'july', 'jul',
  'august', 'aug',
  'september', 'sept', 'sep',
  'october', 'oct',
  'november', 'nov',
  'december', 'dec',
];

const PERSON_NAME_STOPWORDS = new Set([
  'date', 'birth', 'born', 'dob', 'email', 'phone', 'ssn', 'address',
  'street', 'road', 'avenue', 'drive', 'court', 'place', 'company',
  'inc', 'llc', 'corp', 'corporation', 'limited', 'ltd',
  ...MONTH_NAMES,
]);

const PERSON_LABEL_PATTERN = /\b(?:my\s+name\s+is|name\s*(?:is|:|-)|full\s+name\s*(?:is|:|-)|patient\s+name\s*(?:is|:|-)|employee\s+name\s*(?:is|:|-))\s*([A-Z][A-Za-z'-]*(?:\s+(?:[A-Z]\.?\s+)?[A-Z][A-Za-z'-]*){0,3})\b/g;
const PERSON_FREE_PATTERN = /\b[A-Z][A-Za-z'-]*(?:\s+(?:[A-Z]\.?\s+)?[A-Z][A-Za-z'-]*){1,3}\b/g;
const DOB_VALUE_PATTERN = '(?:\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{4})';
const DOB_LABEL_PATTERN = new RegExp(`\\b(?:DOB|D\\.O\\.B\\.|date\\s+of\\s+birth|birth\\s*date|birthdate|birthday|born(?:\\s+on)?)\\s*(?:is|was|:|#|-)?\\s*(${DOB_VALUE_PATTERN})\\b`, 'gi');

function normalizeDetectorId(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized === 'credit_card') return 'creditCard';
  if (normalized === 'date_of_birth' || normalized === 'dob') return 'dateOfBirth';
  if (normalized === 'ip' || normalized === 'ip_address') return 'ipAddress';
  if (normalized === 'org' || normalized === 'org_name' || normalized === 'organization_name' || normalized === 'employer' || normalized === 'workplace') return 'organization';
  return normalized;
}

function isValidCreditCardCandidate(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum > 0 && sum % 10 === 0;
}

function isValidDateCandidate(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return false;

  const yearMatch = normalized.match(/\b(19\d{2}|20\d{2})\b/);
  if (!yearMatch) return false;
  const year = Number(yearMatch[1]);
  const currentYear = new Date().getFullYear();
  if (year < 1900 || year > currentYear) return false;

  const numericParts = normalized.match(/\d{1,4}/g) || [];
  if (numericParts.length >= 3 && !/[A-Za-z]/.test(normalized)) {
    const first = Number(numericParts[0]);
    const second = Number(numericParts[1]);
    const third = Number(numericParts[2]);
    const month = first > 31 ? second : first;
    const day = first > 31 ? third : second;
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  const monthRegex = new RegExp(`\\b(?:${MONTH_NAMES.join('|')})\\.?\\b`, 'i');
  if (monthRegex.test(normalized)) {
    const day = Number((normalized.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\b/i) || [])[1]);
    return day >= 1 && day <= 31;
  }

  return false;
}

function normalizeNameCandidate(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isLikelyPersonName(value = '') {
  const normalized = normalizeNameCandidate(value);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  if (words.length === 1 && words[0].length < 3) return false;
  return words.every((word) => {
    const cleaned = word.replace(/\./g, '').replace(/'/g, '').toLowerCase();
    if (!cleaned || PERSON_NAME_STOPWORDS.has(cleaned)) return false;
    return /^[A-Z][A-Za-z'.:-]*$/.test(word);
  });
}

function findMatchesWithPattern(text = '', pattern, type = '') {
  const matches = [];
  if (!pattern) return matches;

  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[0];
    if (!value) {
      regex.lastIndex += 1;
      continue;
    }
    if (type === 'creditCard' && !isValidCreditCardCandidate(value)) {
      continue;
    }
    matches.push({
      type,
      value,
      start: match.index,
      end: match.index + value.length,
      source: 'builtin',
    });
  }
  return matches;
}

function findDateOfBirthMatches(text = '') {
  const matches = [];
  const source = String(text || '');
  let match;
  while ((match = DOB_LABEL_PATTERN.exec(source)) !== null) {
    const value = match[1] || '';
    const valueOffset = match[0].indexOf(value);
    if (!value || valueOffset < 0 || !isValidDateCandidate(value)) {
      continue;
    }
    const start = match.index + valueOffset;
    matches.push({
      type: 'dateOfBirth',
      value,
      start,
      end: start + value.length,
      source: 'builtin',
    });
  }
  return matches;
}

function findPersonNameMatches(text = '') {
  const matches = [];
  const source = String(text || '');
  let match;

  while ((match = PERSON_LABEL_PATTERN.exec(source)) !== null) {
    const value = normalizeNameCandidate(match[1] || '');
    const valueOffset = match[0].indexOf(match[1] || '');
    if (!value || valueOffset < 0 || !isLikelyPersonName(value)) {
      continue;
    }
    const start = match.index + valueOffset;
    matches.push({
      type: 'personName',
      value,
      start,
      end: start + (match[1] || '').length,
      source: 'builtin',
      grounded: true,
    });
  }

  while ((match = PERSON_FREE_PATTERN.exec(source)) !== null) {
    const value = normalizeNameCandidate(match[0] || '');
    if (!isLikelyPersonName(value)) {
      continue;
    }
    matches.push({
      type: 'personName',
      value,
      start: match.index,
      end: match.index + match[0].length,
      source: 'builtin',
      grounded: true,
    });
  }

  return matches;
}

function buildCustomRegex(entry = {}) {
  const pattern = String(entry.pattern || '').trim();
  if (!pattern) return null;
  try {
    const rawFlags = String(entry.flags || 'gi').trim() || 'gi';
    const flags = Array.from(new Set(`${rawFlags}g`.split(''))).join('');
    return new RegExp(pattern, flags);
  } catch (_error) {
    return null;
  }
}

function findCustomMatches(text = '', customPatterns = []) {
  const matches = [];
  (Array.isArray(customPatterns) ? customPatterns : []).forEach((entry) => {
    const type = String(entry.type || entry.label || 'custom').trim() || 'custom';
    const action = String(entry.action || '').trim();
    const regex = buildCustomRegex(entry);
    if (!regex) return;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      if (!value) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({
        type,
        value,
        start: match.index,
        end: match.index + value.length,
        source: 'customPattern',
        ...(action ? { action } : {}),
      });
    }
  });
  return matches;
}

function findDictionaryMatches(text = '', dictionary = []) {
  const matches = [];
  (Array.isArray(dictionary) ? dictionary : []).forEach((entry) => {
    const value = typeof entry === 'string' ? entry : entry?.value;
    const type = typeof entry === 'string' ? 'custom' : (entry?.type || entry?.label || 'custom');
    const action = typeof entry === 'string' ? '' : String(entry?.action || '').trim();
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
        source: 'dictionary',
        ...(action ? { action } : {}),
        grounded: ACTIONABLE_DICTIONARY_TYPES.has(String(type || '').trim()),
      });
    }
  });
  return matches;
}

function removeOverlaps(matches = []) {
  return [...matches]
    .sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)))
    .reduce((accepted, match) => {
      const overlaps = accepted.some((entry) => match.start < entry.end && match.end > entry.start);
      if (!overlaps) accepted.push(match);
      return accepted;
    }, [])
    .sort((a, b) => a.start - b.start);
}

function detectPii(text = '', policy = {}) {
  const source = String(text || '');
  if (!source) return [];

  const enabled = new Set(
    (Array.isArray(policy.detectors) && policy.detectors.length > 0 ? policy.detectors : DEFAULT_DETECTORS)
      .map(normalizeDetectorId)
      .filter(Boolean),
  );

  const matches = [];
  Object.entries(BUILTIN_PATTERNS).forEach(([type, pattern]) => {
    if (enabled.has(type)) {
      matches.push(...findMatchesWithPattern(source, pattern, type));
    }
  });

  if (enabled.has('dateOfBirth')) {
    matches.push(...findDateOfBirthMatches(source));
  }

  if (policy.enablePersonNames === true || enabled.has('personName')) {
    matches.push(...findPersonNameMatches(source));
  }

  matches.push(...findCustomMatches(source, policy.customPatterns));
  matches.push(...findDictionaryMatches(source, policy.dictionary));

  return removeOverlaps(matches);
}

module.exports = {
  DEFAULT_DETECTORS,
  detectPii,
  normalizeDetectorId,
  isValidCreditCardCandidate,
};
