const { piiVaultStore } = require('./pii-vault-store');
const { resolvePiiPolicy } = require('./pii-policy');

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEntryMap(entries = []) {
  const map = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (!entry?.placeholder || map.has(entry.placeholder)) return;
    try {
      map.set(entry.placeholder, {
        value: piiVaultStore.decryptEntry(entry),
        type: entry.piiType || entry.pii_type || 'PII',
      });
    } catch (error) {
      console.warn(`[PII] Failed to decrypt placeholder ${entry.placeholder}: ${error.message}`);
    }
  });
  return map;
}

function rehydrateWithMap(text = '', entryMap = new Map(), {
  highlight = false,
  escapeValues = false,
} = {}) {
  const source = String(text || '');
  const restorations = [];
  if (!source || entryMap.size === 0) {
    return { text: source, restorations };
  }

  let output = source;
  for (const [placeholder, entry] of entryMap.entries()) {
    const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedPlaceholder, 'g');
    output = output.replace(regex, () => {
      const replacement = highlight
        ? `<mark class="kb-pii-restored" title="Restored locally; model saw a placeholder." data-pii-type="${escapeHtml(entry.type)}">${escapeHtml(entry.value)}</mark>`
        : (escapeValues ? escapeHtml(entry.value) : entry.value);
      restorations.push({
        placeholder,
        type: entry.type,
        restored: true,
      });
      return replacement;
    });
  }
  return { text: output, restorations };
}

async function loadEntries({ sessionId = '', ownerId = null, contextIds = [] } = {}) {
  const ids = (Array.isArray(contextIds) ? contextIds : []).map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length > 0) {
    return piiVaultStore.listEntriesForContexts(ids, ownerId);
  }
  if (!sessionId) return [];
  return piiVaultStore.listEntriesForSession(sessionId, ownerId);
}

async function rehydrateText(text = '', {
  sessionId = '',
  ownerId = null,
  contextIds = [],
  metadata = {},
  clientSurface = '',
  route = '',
  highlight = null,
} = {}) {
  const policy = resolvePiiPolicy({ metadata, clientSurface, route });
  if (!policy.enabled || !text) {
    return { text: String(text || ''), restorations: [], enabled: policy.enabled };
  }
  if (policy.reintroductionMode === 'never') {
    return { text: String(text || ''), restorations: [], enabled: true };
  }
  if (policy.reintroductionMode === 'admin-only' && clientSurface !== 'admin' && route !== 'admin') {
    return { text: String(text || ''), restorations: [], enabled: true };
  }
  const entries = await loadEntries({ sessionId, ownerId, contextIds });
  const result = rehydrateWithMap(text, buildEntryMap(entries), {
    highlight: highlight === null ? policy.highlightRestored !== false : Boolean(highlight),
  });
  return {
    ...result,
    enabled: true,
  };
}

function splitHtmlTextSegments(html = '') {
  const source = String(html || '');
  const segments = [];
  let index = 0;
  let inTag = false;
  let skipUntil = '';
  let textStart = 0;

  while (index < source.length) {
    if (skipUntil) {
      const closeIndex = source.toLowerCase().indexOf(skipUntil, index);
      if (closeIndex < 0) break;
      index = closeIndex + skipUntil.length;
      textStart = index;
      skipUntil = '';
      continue;
    }

    const char = source[index];
    if (char === '<') {
      if (!inTag && textStart < index) {
        segments.push([textStart, index]);
      }
      const tag = source.slice(index, index + 16).toLowerCase();
      if (tag.startsWith('<script')) skipUntil = '</script>';
      if (tag.startsWith('<style')) skipUntil = '</style>';
      inTag = true;
    } else if (char === '>' && inTag) {
      inTag = false;
      textStart = index + 1;
    }
    index += 1;
  }

  if (!inTag && !skipUntil && textStart < source.length) {
    segments.push([textStart, source.length]);
  }
  return segments;
}

async function rehydrateHtml(html = '', options = {}) {
  const policy = resolvePiiPolicy(options);
  const source = String(html || '');
  if (!policy.enabled || !source) {
    return { html: source, restorations: [], enabled: policy.enabled };
  }
  if (policy.reintroductionMode === 'never') {
    return { html: source, restorations: [], enabled: true };
  }
  if (policy.reintroductionMode === 'admin-only' && options.clientSurface !== 'admin' && options.route !== 'admin') {
    return { html: source, restorations: [], enabled: true };
  }
  const entries = await loadEntries(options);
  const entryMap = buildEntryMap(entries);
  if (entryMap.size === 0) {
    return { html: source, restorations: [], enabled: true };
  }
  const segments = splitHtmlTextSegments(source);
  const restorations = [];
  let output = source;
  [...segments].reverse().forEach(([start, end]) => {
    const result = rehydrateWithMap(source.slice(start, end), entryMap, {
      highlight: options.highlight !== false,
      escapeValues: options.escapeValues === true,
    });
    restorations.push(...result.restorations);
    output = `${output.slice(0, start)}${result.text}${output.slice(end)}`;
  });
  return { html: output, restorations, enabled: true };
}

async function rehydrateMessage(message = {}, options = {}) {
  if (!message || typeof message !== 'object') return message;
  const result = await rehydrateText(message.content || '', options);
  if (result.restorations.length === 0) return message;
  return {
    ...message,
    displayContent: result.text,
    piiRestorations: result.restorations,
    metadata: {
      ...(message.metadata || {}),
      piiRehydrated: true,
      piiRestorationCount: result.restorations.length,
    },
  };
}

module.exports = {
  rehydrateText,
  rehydrateHtml,
  rehydrateMessage,
  rehydrateWithMap,
  splitHtmlTextSegments,
};
