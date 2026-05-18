const DEFAULT_DETECTORS = [
  'email',
  'phone',
  'ssn',
  'creditCard',
  'dateOfBirth',
  'address',
  'ipAddress',
  'postalCode',
  'medicalRecordNumber',
  'patientIdentifier',
  'healthCardNumber',
  'socialInsuranceNumber',
];

const ACTIONABLE_DICTIONARY_TYPES = new Set([
  'personName',
  'organization',
  'orgName',
  'employer',
  'workplace',
  'business',
  'businessName',
  'company',
  'clientName',
  'teamName',
  'vendor',
  'brand',
  'brandName',
  'product',
  'productName',
  'service',
  'serviceName',
]);

const BUILTIN_PATTERNS = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,
  address: /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,5}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?)\b/g,
  ipAddress: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  postalCode: /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi,
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

const MONTH_NUMBER_BY_NAME = new Map([
  ['january', 1], ['jan', 1],
  ['february', 2], ['feb', 2],
  ['march', 3], ['mar', 3],
  ['april', 4], ['apr', 4],
  ['may', 5],
  ['june', 6], ['jun', 6],
  ['july', 7], ['jul', 7],
  ['august', 8], ['aug', 8],
  ['september', 9], ['sept', 9], ['sep', 9],
  ['october', 10], ['oct', 10],
  ['november', 11], ['nov', 11],
  ['december', 12], ['dec', 12],
]);

const PERSON_NAME_STOPWORDS = new Set([
  'date', 'birth', 'born', 'dob', 'email', 'phone', 'ssn', 'address',
  'street', 'road', 'avenue', 'drive', 'court', 'place', 'company',
  'inc', 'llc', 'corp', 'corporation', 'limited', 'ltd',
  'fhir', 'hl7', 'patient', 'resource', 'identifier', 'system', 'value',
  'family', 'given', 'name',
  ...MONTH_NAMES,
]);

const PERSON_LABEL_PATTERN = /\b(?:my\s+name\s+is|name\s*(?:is|:|-)|full\s+name\s*(?:is|:|-)|patient\s+name\s*(?:is|:|-)|employee\s+name\s*(?:is|:|-))\s*([A-Z][A-Za-z'-]*(?:[ \t]+(?:[A-Z]\.?[ \t]+)?[A-Z][A-Za-z'-]*){0,3})\b/gi;
const PERSON_FREE_PATTERN = /\b[A-Z][A-Za-z'-]*(?:[ \t]+(?:[A-Z]\.?[ \t]+)?[A-Z][A-Za-z'-]*){1,3}\b/g;
const DOB_VALUE_PATTERN = '(?:\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{2,4})';
const DOB_LABEL_PATTERN = new RegExp(`\\b(?:DOB|D\\.O\\.B\\.|date\\s+of\\s+birth|birth\\s*date|birthdate|birthday|born(?:\\s+on)?)\\s*(?:is|was|:|#|-)?\\s*(${DOB_VALUE_PATTERN})\\b`, 'gi');
const SHORT_NUMERIC_DOB_PATTERN = /(?<!\d)(\d{1,2}[/-]\d{1,2}[/-]\d{2})(?!\d)/g;
const FHIR_BIRTH_DATE_PATTERN = /"birthDate"\s*:\s*"(\d{4}-\d{1,2}-\d{1,2})"/gi;
const FHIR_PATIENT_FAMILY_PATTERN = /"family"\s*:\s*"([^"\r\n]{2,80})"/gi;
const FHIR_PATIENT_GIVEN_PATTERN = /"given"\s*:\s*\[\s*"([^"\r\n]{2,80})"/gi;
const FHIR_ADDRESS_LINE_PATTERN = /"line"\s*:\s*\[\s*"([^"\r\n]{3,120})"/gi;
const FHIR_ADDRESS_CITY_PATTERN = /"city"\s*:\s*"([^"\r\n]{2,80})"/gi;
const FHIR_ADDRESS_POSTAL_PATTERN = /"postalCode"\s*:\s*"([^"\r\n]{3,20})"/gi;
const MEDICAL_ID_LABEL_PATTERN = /\b(?:MRN|M\.R\.N\.|medical\s+record(?:\s+number)?|medicalRecordNumber|patient\s*(?:id|identifier|number)|patientId|patientIdentifier|PHN|ULI|MSI)\b\s*(?:is|was|["']?\s*[:#=-]\s*["']?)?\s*([A-Z0-9][A-Z0-9._-]{3,})\b/gi;
const HEALTH_CARD_LABEL_PATTERN = /\b(?:health\s*card(?:\s*number)?|healthCardNumber|OHIP|RAMQ|PHN|provincial\s+health\s+(?:number|id|card)|health\s+services\s+(?:number|card))\b\s*(?:is|was|["']?\s*[:#=-]\s*["']?)?\s*([A-Z0-9][A-Z0-9 ._-]{5,30}[A-Z0-9])\b/gi;
const SIN_LABEL_PATTERN = /\b(?:SIN|S\.I\.N\.|social\s+insurance\s+number)\b\s*(?:is|was|["']?\s*[:#=-]\s*["']?)?\s*([0-9][0-9 -]{7,15}[0-9])\b/gi;
const SIN_FORMATTED_PATTERN = /\b\d{3}[- ]\d{3}[- ]\d{3}\b/g;
const FHIR_IDENTIFIER_VALUE_PATTERN = /"system"\s*:\s*"[^"\r\n]*(?:mrn|medical[-_\s]*record|patient[-_\s]*id|health[-_\s]*card)[^"\r\n]*"[\s\S]{0,160}?"value"\s*:\s*"([^"\r\n]{4,80})"/gi;
const DOCUMENT_FILENAME_PATTERN = /\b([A-Z][A-Za-z0-9]*(?:[-_][A-Z][A-Za-z0-9]*){1,16})\.(?:pdf|docx?|rtf|txt|html?)\b/g;
const DOCUMENT_FILENAME_PREFIXES = new Set([
  'bio',
  'candidate',
  'cv',
  'curriculum',
  'employee',
  'profile',
  'resume',
  'staff',
  'vitae',
]);

function normalizeDetectorId(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized === 'credit_card') return 'creditCard';
  if (normalized === 'date_of_birth' || normalized === 'dob') return 'dateOfBirth';
  if (normalized === 'ip' || normalized === 'ip_address') return 'ipAddress';
  if (normalized === 'postal' || normalized === 'postal_code' || normalized === 'postal-code' || normalized === 'canadian_postal_code') return 'postalCode';
  if (normalized === 'mrn' || normalized === 'medical_record_number' || normalized === 'medical-record-number') return 'medicalRecordNumber';
  if (normalized === 'patient_id' || normalized === 'patient-id' || normalized === 'patient_identifier') return 'patientIdentifier';
  if (normalized === 'health_card' || normalized === 'health-card' || normalized === 'health_card_number' || normalized === 'health-card-number' || normalized === 'ohip' || normalized === 'ramq' || normalized === 'phn') return 'healthCardNumber';
  if (normalized === 'sin' || normalized === 's.i.n.' || normalized === 'social_insurance_number' || normalized === 'social-insurance-number') return 'socialInsuranceNumber';
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

function isValidCanadianSinCandidate(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit = Math.floor(digit / 10) + (digit % 10);
    }
    sum += digit;
  }
  return sum > 0 && sum % 10 === 0;
}

function resolveBirthYear(value = '') {
  const raw = String(value || '').trim();
  if (!/^\d{2}(?:\d{2})?$/.test(raw)) return null;
  const numeric = Number(raw);
  if (raw.length === 4) return numeric;
  const currentYear = new Date().getFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;
  const currentCandidate = currentCentury + numeric;
  return currentCandidate > currentYear ? currentCandidate - 100 : currentCandidate;
}

function isValidDateParts(year, month, day) {
  const currentYear = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > currentYear) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function findMonthNumber(value = '') {
  const monthMatch = String(value || '').match(new RegExp(`\\b(${MONTH_NAMES.join('|')})\\.?\\b`, 'i'));
  if (!monthMatch) return null;
  return MONTH_NUMBER_BY_NAME.get(monthMatch[1].toLowerCase()) || null;
}

function isValidDateCandidate(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return false;

  const numericParts = normalized.match(/\d{1,4}/g) || [];
  if (numericParts.length >= 3 && !/[A-Za-z]/.test(normalized)) {
    const [firstRaw, secondRaw, thirdRaw] = numericParts;
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    const third = Number(thirdRaw);
    if (firstRaw.length === 4) {
      return isValidDateParts(resolveBirthYear(firstRaw), second, third);
    }
    const year = resolveBirthYear(thirdRaw);
    if (!year) return false;
    const candidates = [
      { month: first, day: second },
      { month: second, day: first },
    ];
    return candidates.some((candidate) => isValidDateParts(year, candidate.month, candidate.day));
  }

  const monthAlternation = MONTH_NAMES.join('|');
  const monthFirst = normalized.match(new RegExp(`\\b(?:${monthAlternation})\\.?\\s+([0-3]?\\d)(?:st|nd|rd|th)?,?\\s+(\\d{2,4})\\b`, 'i'));
  if (monthFirst) {
    return isValidDateParts(resolveBirthYear(monthFirst[2]), findMonthNumber(normalized), Number(monthFirst[1]));
  }

  const dayFirst = normalized.match(new RegExp(`\\b([0-3]?\\d)(?:st|nd|rd|th)?\\s+(?:${monthAlternation})\\.?\\s+(\\d{2,4})\\b`, 'i'));
  if (dayFirst) {
    return isValidDateParts(resolveBirthYear(dayFirst[2]), findMonthNumber(normalized), Number(dayFirst[1]));
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

function isLikelyFilenameIdentityToken(value = '') {
  const normalized = String(value || '').trim();
  if (!/^[A-Z][A-Za-z']{1,}$/.test(normalized)) return false;
  return !PERSON_NAME_STOPWORDS.has(normalized.toLowerCase());
}

function splitFilenameTokens(basename = '') {
  const tokens = [];
  const pattern = /[A-Za-z][A-Za-z']*/g;
  let match;
  while ((match = pattern.exec(String(basename || ''))) !== null) {
    tokens.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function findDocumentFilenameIdentityMatches(text = '', {
  detectPersonNames = false,
  detectOrganizations = false,
} = {}) {
  const matches = [];
  const source = String(text || '');
  let match;
  while ((match = DOCUMENT_FILENAME_PATTERN.exec(source)) !== null) {
    const basename = match[1] || '';
    const tokens = splitFilenameTokens(basename)
      .filter((token) => isLikelyFilenameIdentityToken(token.value));
    const identityTokens = tokens.filter((token) => !DOCUMENT_FILENAME_PREFIXES.has(token.value.toLowerCase()));
    if (identityTokens.length < 2) {
      continue;
    }

    if (detectPersonNames) {
      const first = identityTokens[0];
      const second = identityTokens[1];
      const rawValue = basename.slice(first.start, second.end);
      const displayValue = rawValue.replace(/[-_]+/g, ' ');
      if (isLikelyPersonName(displayValue)) {
        matches.push({
          type: 'personName',
          value: rawValue,
          start: match.index + first.start,
          end: match.index + second.end,
          source: 'filename',
          grounded: true,
        });
      }
    }

    if (detectOrganizations && identityTokens.length > 2) {
      identityTokens.slice(2).forEach((token) => {
        matches.push({
          type: 'organization',
          value: token.value,
          start: match.index + token.start,
          end: match.index + token.end,
          source: 'filename',
          grounded: true,
        });
      });
    }
  }
  return matches;
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
  while ((match = SHORT_NUMERIC_DOB_PATTERN.exec(source)) !== null) {
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
      source: 'dateLiteral',
      grounded: true,
    });
  }
  return matches;
}

function findRegexGroupMatches(text = '', regex, type = '', {
  group = 1,
  source = 'builtin',
  grounded = false,
} = {}) {
  const matches = [];
  const input = String(text || '');
  let match;
  while ((match = regex.exec(input)) !== null) {
    const value = match[group] || '';
    const valueOffset = match[0].indexOf(value);
    if (!value || valueOffset < 0) {
      continue;
    }
    const start = match.index + valueOffset;
    matches.push({
      type,
      value,
      start,
      end: start + value.length,
      source,
      ...(grounded ? { grounded: true } : {}),
    });
  }
  return matches;
}

function findFhirPatientMatches(text = '') {
  const matches = [];
  matches.push(...findRegexGroupMatches(text, FHIR_BIRTH_DATE_PATTERN, 'dateOfBirth', { source: 'fhir', grounded: true }));
  matches.push(...findRegexGroupMatches(text, FHIR_PATIENT_FAMILY_PATTERN, 'personName', { source: 'fhir', grounded: true }));
  matches.push(...findRegexGroupMatches(text, FHIR_PATIENT_GIVEN_PATTERN, 'personName', { source: 'fhir', grounded: true }));
  matches.push(...findRegexGroupMatches(text, FHIR_IDENTIFIER_VALUE_PATTERN, 'medicalRecordNumber', { source: 'fhir', grounded: true }));
  matches.push(...findRegexGroupMatches(text, FHIR_ADDRESS_LINE_PATTERN, 'address', { source: 'fhir', grounded: true }));
  matches.push(...findRegexGroupMatches(text, FHIR_ADDRESS_CITY_PATTERN, 'address', { source: 'fhir', grounded: true }));
  matches.push(...findRegexGroupMatches(text, FHIR_ADDRESS_POSTAL_PATTERN, 'address', { source: 'fhir', grounded: true }));
  return matches;
}

function findMedicalIdentifierMatches(text = '') {
  const matches = findRegexGroupMatches(text, MEDICAL_ID_LABEL_PATTERN, 'medicalRecordNumber', {
    source: 'medicalIdentifier',
    grounded: true,
  });
  matches.push(...findRegexGroupMatches(text, HEALTH_CARD_LABEL_PATTERN, 'healthCardNumber', {
    source: 'canadianHealthCard',
    grounded: true,
  }));
  return matches;
}

function findCanadianSinMatches(text = '') {
  const matches = [];
  const source = String(text || '');
  const pushIfValid = (match, value) => {
    const rawValue = String(value || '');
    if (!rawValue || !isValidCanadianSinCandidate(rawValue)) return;
    const valueOffset = match[0].indexOf(rawValue);
    if (valueOffset < 0) return;
    const start = match.index + valueOffset;
    matches.push({
      type: 'socialInsuranceNumber',
      value: rawValue,
      start,
      end: start + rawValue.length,
      source: 'canadianSin',
      grounded: true,
    });
  };

  let match;
  while ((match = SIN_LABEL_PATTERN.exec(source)) !== null) {
    pushIfValid(match, match[1]);
  }
  while ((match = SIN_FORMATTED_PATTERN.exec(source)) !== null) {
    pushIfValid(match, match[0]);
  }
  return matches;
}

function pushHl7FieldMatch(matches, segmentStart, segment, fieldValue, type, {
  source = 'hl7',
  grounded = true,
  occurrenceStart = 0,
} = {}) {
  const value = String(fieldValue || '').trim();
  if (!value) return;
  const localIndex = segment.indexOf(value, occurrenceStart);
  if (localIndex < 0) return;
  matches.push({
    type,
    value,
    start: segmentStart + localIndex,
    end: segmentStart + localIndex + value.length,
    source,
    ...(grounded ? { grounded: true } : {}),
  });
}

function findHl7PidMatches(text = '') {
  const matches = [];
  const source = String(text || '');
  const pidRegex = /\bPID\|[^\r\n]*/g;
  let match;
  while ((match = pidRegex.exec(source)) !== null) {
    const segment = match[0];
    const fields = segment.split('|');
    const patientId = String(fields[3] || '').split('^')[0];
    const patientName = String(fields[5] || '').split('^').filter(Boolean).slice(0, 2).join('^');
    const birthDate = String(fields[7] || '').trim();
    const address = String(fields[11] || '').trim();
    const phone = String(fields[13] || '').trim();
    pushHl7FieldMatch(matches, match.index, segment, patientId, 'medicalRecordNumber');
    pushHl7FieldMatch(matches, match.index, segment, patientName, 'personName');
    if (/^(19|20)\d{6}$/.test(birthDate)) {
      pushHl7FieldMatch(matches, match.index, segment, birthDate, 'dateOfBirth');
    }
    pushHl7FieldMatch(matches, match.index, segment, address, 'address');
    pushHl7FieldMatch(matches, match.index, segment, phone, 'phone');
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
    matches.push(...findRegexGroupMatches(source, FHIR_BIRTH_DATE_PATTERN, 'dateOfBirth', { source: 'fhir', grounded: true }));
  }

  if (policy.enablePersonNames === true || enabled.has('personName')) {
    matches.push(...findPersonNameMatches(source));
  }

  if (enabled.has('medicalRecordNumber') || enabled.has('patientIdentifier') || enabled.has('healthCardNumber')) {
    matches.push(...findMedicalIdentifierMatches(source));
  }

  if (enabled.has('socialInsuranceNumber')) {
    matches.push(...findCanadianSinMatches(source));
  }

  if (enabled.has('personName') || enabled.has('dateOfBirth') || enabled.has('medicalRecordNumber') || enabled.has('patientIdentifier') || enabled.has('healthCardNumber')) {
    matches.push(...findFhirPatientMatches(source));
    matches.push(...findHl7PidMatches(source));
  }

  if (policy.enablePersonNames === true || enabled.has('personName') || enabled.has('organization')) {
    matches.push(...findDocumentFilenameIdentityMatches(source, {
      detectPersonNames: policy.enablePersonNames === true || enabled.has('personName'),
      detectOrganizations: enabled.has('organization'),
    }));
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
  isValidCanadianSinCandidate,
};
