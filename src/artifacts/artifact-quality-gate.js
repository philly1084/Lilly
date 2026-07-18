'use strict';

const path = require('path').posix;
const { JSDOM } = require('jsdom');

const ARTIFACT_STRUCTURAL_QUALITY_VERSION = 'ArtifactStructuralQuality/v1';

const FORMAT_DEFINITIONS = Object.freeze({
  html: {
    extensions: new Set(['html', 'htm']),
    mimeTypes: new Set(['text/html']),
  },
  json: {
    extensions: new Set(['json']),
    mimeTypes: new Set(['application/json', 'text/json']),
  },
  xml: {
    extensions: new Set(['xml']),
    mimeTypes: new Set(['application/xml', 'text/xml']),
  },
  svg: {
    extensions: new Set(['svg']),
    mimeTypes: new Set(['image/svg+xml']),
  },
  css: {
    extensions: new Set(['css']),
    mimeTypes: new Set(['text/css']),
  },
  javascript: {
    extensions: new Set(['js', 'mjs', 'cjs', 'jsx']),
    mimeTypes: new Set([
      'application/ecmascript',
      'application/javascript',
      'text/ecmascript',
      'text/javascript',
    ]),
  },
});

const TEXT_EXTENSIONS = new Set([
  'css',
  'csv',
  'htm',
  'html',
  'js',
  'json',
  'jsx',
  'md',
  'mjs',
  'cjs',
  'svg',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);

const SITE_ENTRY_ROLE = 'site-entry';
const SITE_FILE_ROLE = 'site-file';
const SITE_ROLES = new Set([SITE_ENTRY_ROLE, SITE_FILE_ROLE]);

const HTML_SURFACE_SELECTOR = [
  'a',
  'article',
  'aside',
  'audio',
  'button',
  'canvas',
  'div',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'img',
  'input',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'select',
  'svg',
  'table',
  'textarea',
  'ul',
  'video',
  '[id]',
  '[role]',
].join(',');

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_FORBIDDEN_ELEMENTS = new Set(['foreignobject', 'iframe', 'script']);
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i;
const SVG_EXTERNAL_ACTIVE_URL_PATTERN = /^(?:\/\/|[a-z][a-z0-9+.-]*:)/i;
const PLATFORM_LIBRARY_REFERENCE_PATTERN = /^\/api\/sandbox-libraries\//i;

function normalizeMimeType(value = '') {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function inferFormatFromExtension(extension = '') {
  const normalized = String(extension || '').replace(/^\./, '').toLowerCase();
  return Object.entries(FORMAT_DEFINITIONS)
    .find(([, definition]) => definition.extensions.has(normalized))?.[0] || '';
}

function inferFormatFromMimeType(mimeType = '') {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return '';
  }
  if (normalized === 'image/svg+xml') {
    return 'svg';
  }
  if (/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i.test(normalized)) {
    return 'json';
  }
  if (/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?xml$/i.test(normalized)) {
    return 'xml';
  }
  return Object.entries(FORMAT_DEFINITIONS)
    .find(([, definition]) => definition.mimeTypes.has(normalized))?.[0] || '';
}

function isTextFile(extension = '', mimeType = '') {
  const normalizedMime = normalizeMimeType(mimeType);
  return TEXT_EXTENSIONS.has(String(extension || '').replace(/^\./, '').toLowerCase())
    || normalizedMime.startsWith('text/')
    || /(?:json|javascript|xml|svg\+xml)/i.test(normalizedMime);
}

function validateBase64(value = '') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    return null;
  }
  const buffer = Buffer.from(compact, 'base64');
  return buffer.toString('base64') === compact ? buffer : null;
}

function resolveFileBuffer(file = {}) {
  if (Buffer.isBuffer(file.buffer)) {
    return Buffer.from(file.buffer);
  }
  if (Buffer.isBuffer(file.contentBuffer)) {
    return Buffer.from(file.contentBuffer);
  }
  if (typeof file.content === 'string') {
    return Buffer.from(file.content, 'utf8');
  }
  if (typeof file.contentBase64 === 'string') {
    return validateBase64(file.contentBase64);
  }
  return null;
}

function normalizeRelativePath(value = '', filesDirectory = '') {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  const normalizedDirectory = String(filesDirectory || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
  if (normalizedDirectory && normalized.startsWith(`${normalizedDirectory}/`)) {
    normalized = normalized.slice(normalizedDirectory.length + 1);
  } else {
    const operationScoped = normalized.match(/^\.kimibuilt\/agent-runs\/[^/]+\/output\/files\/(.+)$/i);
    if (operationScoped) {
      normalized = operationScoped[1];
    }
  }
  normalized = normalized.replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || normalized.includes('\0')) {
    return '';
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return '';
  }
  return segments.join('/');
}

function decodeUtf8Strict(buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0')) {
      return { error: 'Text content contains a NUL byte.' };
    }
    return { text };
  } catch (_error) {
    return { error: 'Text content is not valid UTF-8.' };
  }
}

function parseXmlDocument(text = '') {
  const sourceWithoutComments = String(text || '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(sourceWithoutComments)) {
    return {
      error: {
        code: 'REMOTE_AGENT_ARTIFACT_XML_DTD_FORBIDDEN',
        message: 'XML document type and entity declarations are not allowed.',
      },
    };
  }
  let parserWindow;
  try {
    parserWindow = new JSDOM('').window;
    const document = new parserWindow.DOMParser().parseFromString(String(text || ''), 'application/xml');
    const parserError = document.getElementsByTagName('parsererror')[0]
      || document.getElementsByTagNameNS('*', 'parsererror')[0];
    if (parserError || !document.documentElement) {
      return {
        error: {
          code: 'REMOTE_AGENT_ARTIFACT_XML_INVALID',
          message: 'XML content is not well formed.',
        },
      };
    }
    return { document };
  } catch (_error) {
    return {
      error: {
        code: 'REMOTE_AGENT_ARTIFACT_XML_INVALID',
        message: 'XML content is not well formed.',
      },
    };
  } finally {
    parserWindow?.close?.();
  }
}

function collectCssReferences(source = '') {
  const references = [];
  const add = (value) => {
    const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    if (normalized) {
      references.push(normalized);
    }
  };
  const urlPattern = /url\(\s*(['"]?)([^)'"\s][^)]*?)\1\s*\)/gi;
  let match = urlPattern.exec(String(source || ''));
  while (match) {
    add(match[2]);
    match = urlPattern.exec(String(source || ''));
  }
  const importPattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/gi;
  match = importPattern.exec(String(source || ''));
  while (match) {
    add(match[2]);
    match = importPattern.exec(String(source || ''));
  }
  return references;
}

function collectJavascriptReferences(source = '') {
  const references = [];
  const patterns = [
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(String(source || ''));
    while (match) {
      references.push(match[1]);
      match = pattern.exec(String(source || ''));
    }
  }
  return references;
}

function collectSrcsetReferences(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
}

function collectHtmlReferences(document) {
  const references = [];
  const addAttribute = (selector, attribute, options = {}) => {
    document.querySelectorAll(selector).forEach((element) => {
      const value = element.getAttribute(attribute);
      if (!value) {
        return;
      }
      if (options.srcset) {
        references.push(...collectSrcsetReferences(value));
      } else if (options.fileLikeOnly) {
        const clean = value.split(/[?#]/, 1)[0];
        if (/\.[a-z0-9]{1,12}$/i.test(clean) || clean.endsWith('/')) {
          references.push(value);
        }
      } else {
        references.push(value);
      }
    });
  };

  addAttribute('script[src]', 'src');
  addAttribute('link[href]', 'href');
  addAttribute('img[src], input[type="image"][src], source[src], audio[src], video[src], iframe[src], embed[src]', 'src');
  addAttribute('img[srcset], source[srcset]', 'srcset', { srcset: true });
  addAttribute('video[poster]', 'poster');
  addAttribute('object[data]', 'data');
  addAttribute('a[href]', 'href', { fileLikeOnly: true });

  document.querySelectorAll('[style]').forEach((element) => {
    references.push(...collectCssReferences(element.getAttribute('style') || ''));
  });
  document.querySelectorAll('style').forEach((element) => {
    references.push(...collectCssReferences(element.textContent || ''));
  });
  document.querySelectorAll('script:not([src])').forEach((element) => {
    references.push(...collectJavascriptReferences(element.textContent || ''));
  });
  return references;
}

function validateHtml(text = '') {
  if (!/<(?:!doctype\s+html|html|head|body|title|meta|main|article|section|header|footer|nav|aside|figure|div|h[1-6]|p|ul|ol|table|form|button|canvas|svg)\b/i.test(text)) {
    return {
      error: {
        code: 'REMOTE_AGENT_ARTIFACT_HTML_INVALID',
        message: 'HTML content does not contain an HTML document or renderable surface.',
      },
    };
  }
  let dom;
  try {
    dom = new JSDOM(text, { contentType: 'text/html' });
    const document = dom.window.document;
    const bodyText = String(document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const hasSurface = Boolean(document.body?.querySelector(HTML_SURFACE_SELECTOR));
    if (!bodyText && !hasSurface) {
      return {
        error: {
          code: 'REMOTE_AGENT_ARTIFACT_HTML_EMPTY',
          message: 'HTML content has no non-empty body or renderable surface.',
        },
      };
    }
    return { references: collectHtmlReferences(document) };
  } catch (_error) {
    return {
      error: {
        code: 'REMOTE_AGENT_ARTIFACT_HTML_INVALID',
        message: 'HTML content could not be parsed.',
      },
    };
  } finally {
    dom?.window?.close?.();
  }
}

function isUnsafeActiveUrl(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return false;
  }
  if (SAFE_DATA_IMAGE_PATTERN.test(normalized)) {
    return false;
  }
  return SVG_EXTERNAL_ACTIVE_URL_PATTERN.test(normalized);
}

function collectUnsafeCssReferences(source = '') {
  return collectCssReferences(source).filter((reference) => isUnsafeActiveUrl(reference));
}

function validateSvg(text = '') {
  if (/<\?xml-stylesheet\b/i.test(text)) {
    return {
      error: {
        code: 'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
        message: 'SVG XML stylesheet processing instructions are not allowed.',
      },
    };
  }
  const parsed = parseXmlDocument(text);
  if (parsed.error) {
    return parsed;
  }
  const document = parsed.document;
  const root = document.documentElement;
  if (String(root.localName || '').toLowerCase() !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    return {
      error: {
        code: 'REMOTE_AGENT_ARTIFACT_SVG_ROOT_INVALID',
        message: 'SVG content must use an svg root in the SVG namespace.',
      },
    };
  }

  const references = [];
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    const localName = String(element.localName || element.tagName || '').toLowerCase();
    if (SVG_FORBIDDEN_ELEMENTS.has(localName)) {
      return {
        error: {
          code: 'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
          message: `SVG active element is not allowed: ${localName}.`,
        },
      };
    }
    for (const attribute of Array.from(element.attributes || [])) {
      const name = String(attribute.name || '').toLowerCase();
      const value = String(attribute.value || '').trim();
      const styleReferences = name === 'style' ? collectCssReferences(value) : [];
      if (/^on[a-z]/.test(name)
        || (name === 'style' && /(?:expression\s*\(|javascript\s*:|vbscript\s*:|@import\b)/i.test(value))
        || styleReferences.some((reference) => isUnsafeActiveUrl(reference))
        || (['href', 'xlink:href', 'src'].includes(name) && isUnsafeActiveUrl(value))) {
        return {
          error: {
            code: 'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
            message: `SVG active content is not allowed in attribute ${name}.`,
          },
        };
      }
      if (['href', 'xlink:href', 'src'].includes(name) && value) {
        references.push(value);
      }
      if (name === 'style') {
        references.push(...styleReferences);
      }
    }
    if (localName === 'style') {
      const styleText = String(element.textContent || '');
      if (/(?:expression\s*\(|javascript\s*:|vbscript\s*:|@import\b)/i.test(styleText)
        || collectUnsafeCssReferences(styleText).length > 0) {
        return {
          error: {
            code: 'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
            message: 'SVG active CSS content is not allowed.',
          },
        };
      }
      references.push(...collectCssReferences(styleText));
    }
  }
  return { references };
}

function addIssue(report, issue) {
  const normalized = {
    code: issue.code,
    path: issue.path || '',
    message: issue.message,
    ...(issue.reference ? { reference: issue.reference } : {}),
  };
  const key = `${normalized.code}\n${normalized.path}\n${normalized.reference || ''}`;
  if (!report._issueKeys.has(key)) {
    report._issueKeys.add(key);
    report.blockers.push(normalized);
  }
}

function validateFormatCoherence(record, report) {
  const { extension, mimeType, path: filePath } = record;
  const extensionFormat = inferFormatFromExtension(extension);
  const mimeFormat = inferFormatFromMimeType(mimeType);
  if (extensionFormat && (!mimeType || mimeType === 'application/octet-stream')) {
    addIssue(report, {
      code: 'REMOTE_AGENT_ARTIFACT_MIME_REQUIRED',
      path: filePath,
      message: `Recognized .${extension} artifacts require a specific MIME type.`,
    });
    return extensionFormat;
  }
  if (extensionFormat && !mimeFormat) {
    addIssue(report, {
      code: 'REMOTE_AGENT_ARTIFACT_MIME_EXTENSION_MISMATCH',
      path: filePath,
      message: `MIME type ${mimeType || '(missing)'} does not match .${extension}.`,
    });
    return extensionFormat;
  }
  if (extensionFormat && mimeFormat && extensionFormat !== mimeFormat) {
    addIssue(report, {
      code: 'REMOTE_AGENT_ARTIFACT_MIME_EXTENSION_MISMATCH',
      path: filePath,
      message: `MIME type ${mimeType} conflicts with .${extension}.`,
    });
    return extensionFormat;
  }
  if (!extensionFormat && mimeFormat && extension) {
    addIssue(report, {
      code: 'REMOTE_AGENT_ARTIFACT_MIME_EXTENSION_MISMATCH',
      path: filePath,
      message: `MIME type ${mimeType} conflicts with .${extension}.`,
    });
  }
  return extensionFormat || mimeFormat;
}

function isExternalReference(value = '') {
  const normalized = String(value || '').trim();
  return !normalized
    || normalized.startsWith('#')
    || normalized.startsWith('//')
    || /^(?:blob|data|https?|mailto|tel):/i.test(normalized);
}

function normalizeReferencePath(reference = '', sourcePath = '') {
  const source = String(reference || '').trim();
  if (!source || isExternalReference(source) || PLATFORM_LIBRARY_REFERENCE_PATTERN.test(source)) {
    return { external: true };
  }
  if (/^(?:file|javascript|vbscript):/i.test(source)) {
    return { unsafe: true };
  }
  const withoutQuery = source.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch (_error) {
    return { unsafe: true };
  }
  if (!decoded) {
    return { external: true };
  }
  const rootRelative = decoded.startsWith('/');
  const joined = rootRelative
    ? decoded.replace(/^\/+/, '')
    : path.join(path.dirname(sourcePath), decoded);
  const normalized = path.normalize(joined).replace(/^\.\//, '');
  if (!normalized
    || normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || /^[a-z]:\//i.test(normalized)
    || normalized.includes('\0')) {
    return { unsafe: true };
  }
  return { path: normalized, directory: decoded.endsWith('/') };
}

function buildReferenceCandidates(referencePath = '', directory = false) {
  const candidates = [referencePath];
  if (directory) {
    candidates.push(`${referencePath.replace(/\/+$/g, '')}/index.html`);
  }
  if (!path.extname(referencePath)) {
    candidates.push(
      `${referencePath}.html`,
      `${referencePath}.js`,
      `${referencePath}.mjs`,
      `${referencePath}.css`,
      `${referencePath}.json`,
      `${referencePath.replace(/\/+$/g, '')}/index.html`,
      `${referencePath.replace(/\/+$/g, '')}/index.js`,
    );
  }
  return [...new Set(candidates)];
}

function validateSiteReferences(records, report) {
  const siteRecords = records.filter((record) => SITE_ROLES.has(record.role));
  const siteEntries = siteRecords.filter((record) => (
    record.format === 'html' && record.role === SITE_ENTRY_ROLE
  ));
  report.site = {
    enabled: siteEntries.length > 0,
    entries: siteEntries.map((record) => record.path),
    checkedReferences: 0,
  };
  if (siteEntries.length === 0) {
    return;
  }

  const exactPaths = new Set(siteRecords.map((record) => record.path));
  const caseFoldedPaths = new Map(siteRecords.map((record) => [record.path.toLowerCase(), record.path]));
  for (const record of siteRecords) {
    if (!record.text) {
      continue;
    }
    let references = record.references || [];
    if (record.format === 'css') {
      references = collectCssReferences(record.text);
    } else if (record.format === 'javascript') {
      references = collectJavascriptReferences(record.text);
    }
    for (const reference of references) {
      // Browser module specifiers such as "three" are resolved by an import map
      // or a build tool. They are not relative bundle paths, so treating them as
      // missing files would reject the supported sandbox-library import-map lane.
      if (record.format === 'javascript'
        && !/^(?:\.{1,2}\/|\/)/.test(String(reference || '').trim())) {
        continue;
      }
      const normalized = normalizeReferencePath(reference, record.path);
      if (normalized.external) {
        continue;
      }
      report.site.checkedReferences += 1;
      if (normalized.unsafe) {
        addIssue(report, {
          code: 'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_UNSAFE',
          path: record.path,
          reference,
          message: `Site reference escapes the returned artifact set: ${reference}.`,
        });
        continue;
      }
      const candidates = buildReferenceCandidates(normalized.path, normalized.directory);
      const exact = candidates.find((candidate) => exactPaths.has(candidate));
      if (exact) {
        continue;
      }
      const caseInsensitive = candidates
        .map((candidate) => caseFoldedPaths.get(candidate.toLowerCase()))
        .find(Boolean);
      if (caseInsensitive) {
        addIssue(report, {
          code: 'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_CASE_MISMATCH',
          path: record.path,
          reference,
          message: `Site reference casing does not match returned path ${caseInsensitive}.`,
        });
        continue;
      }
      addIssue(report, {
        code: 'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_MISSING',
        path: record.path,
        reference,
        message: `Site reference has no returned file: ${reference}.`,
      });
    }
  }
}

function validateResultArtifactSet(input = {}) {
  const files = Array.isArray(input) ? input : input?.files;
  const filesDirectory = Array.isArray(input) ? '' : input?.filesDirectory;
  const report = {
    version: ARTIFACT_STRUCTURAL_QUALITY_VERSION,
    status: 'passed',
    files: [],
    site: {
      enabled: false,
      entries: [],
      checkedReferences: 0,
    },
    blockers: [],
    warnings: [],
    _issueKeys: new Set(),
  };
  if (!Array.isArray(files) || files.length === 0) {
    addIssue(report, {
      code: 'REMOTE_AGENT_ARTIFACT_RESULT_SET_EMPTY',
      message: 'Returned artifact validation requires at least one file.',
    });
  }

  const seenPaths = new Map();
  for (const [index, file] of (Array.isArray(files) ? files : []).entries()) {
    const rawPath = file?.relativePath || file?.sitePath || file?.path || file?.filename;
    const filePath = normalizeRelativePath(rawPath, filesDirectory);
    const fallbackPath = filePath || `result-${index + 1}`;
    if (!filePath) {
      addIssue(report, {
        code: 'REMOTE_AGENT_ARTIFACT_PATH_INVALID',
        path: String(rawPath || ''),
        message: 'Returned artifact path must be safe and relative.',
      });
    } else if (seenPaths.has(filePath.toLowerCase())) {
      addIssue(report, {
        code: 'REMOTE_AGENT_ARTIFACT_PATH_DUPLICATE',
        path: filePath,
        message: `Returned artifact path duplicates ${seenPaths.get(filePath.toLowerCase())}.`,
      });
    } else {
      seenPaths.set(filePath.toLowerCase(), filePath);
    }

    const extension = path.extname(fallbackPath).slice(1).toLowerCase();
    const mimeType = normalizeMimeType(file?.mimeType || file?.contentType);
    const role = String(file?.role || 'deliverable').trim().toLowerCase() || 'deliverable';
    const buffer = resolveFileBuffer(file || {});
    const record = {
      path: fallbackPath,
      filename: path.basename(fallbackPath),
      role,
      mimeType,
      extension,
      format: '',
      sizeBytes: buffer?.length || 0,
      text: '',
      references: [],
    };
    report.files.push(record);

    if (!buffer || buffer.length === 0) {
      addIssue(report, {
        code: 'REMOTE_AGENT_ARTIFACT_CONTENT_EMPTY',
        path: fallbackPath,
        message: 'Returned artifact content is empty or unavailable.',
      });
      continue;
    }

    record.format = validateFormatCoherence(record, report);
    if (isTextFile(extension, mimeType)) {
      const decoded = decodeUtf8Strict(buffer);
      if (decoded.error) {
        addIssue(report, {
          code: decoded.error.includes('NUL')
            ? 'REMOTE_AGENT_ARTIFACT_TEXT_NUL'
            : 'REMOTE_AGENT_ARTIFACT_TEXT_UTF8_INVALID',
          path: fallbackPath,
          message: decoded.error,
        });
        continue;
      }
      record.text = decoded.text;
    }

    if (record.format === 'json') {
      try {
        JSON.parse(record.text);
      } catch (_error) {
        addIssue(report, {
          code: 'REMOTE_AGENT_ARTIFACT_JSON_INVALID',
          path: fallbackPath,
          message: 'JSON content is not valid JSON.',
        });
      }
    } else if (record.format === 'xml') {
      const parsed = parseXmlDocument(record.text);
      if (parsed.error) {
        addIssue(report, { ...parsed.error, path: fallbackPath });
      }
    } else if (record.format === 'svg') {
      const parsed = validateSvg(record.text);
      if (parsed.error) {
        addIssue(report, { ...parsed.error, path: fallbackPath });
      } else {
        record.references = parsed.references || [];
      }
    } else if (record.format === 'html') {
      const parsed = validateHtml(record.text);
      if (parsed.error) {
        addIssue(report, { ...parsed.error, path: fallbackPath });
      } else {
        record.references = parsed.references || [];
      }
    }
  }

  validateSiteReferences(report.files, report);
  report.status = report.blockers.length > 0 ? 'blocked' : 'passed';
  delete report._issueKeys;
  report.files = report.files.map(({ text: _text, references: _references, ...record }) => record);
  return report;
}

module.exports = {
  ARTIFACT_STRUCTURAL_QUALITY_VERSION,
  validateResultArtifactSet,
};
