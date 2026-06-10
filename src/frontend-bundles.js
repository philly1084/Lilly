const path = require('path').posix;
const { createZip, readZipEntries } = require('./utils/zip');
const { createUniqueFilename, escapeHtml, stripHtml } = require('./utils/text');

const MAX_FRONTEND_BUNDLE_EXTRACTED_TEXT_CHARS = 20000;
const STYLE_SAFETY_NET_PATH = 'styles.css';
const STYLE_SAFETY_NET_MARKER = 'kimibuilt bundle style safety net';
const BUNDLE_README_PATH = 'README.md';
const IMAGE_MANIFEST_PATH = 'assets/images.json';
const STYLE_SAFETY_NET_CSS = `/* ${STYLE_SAFETY_NET_MARKER} */
:root {
  --kb-bg: #f5f7fb;
  --kb-surface: #ffffff;
  --kb-panel: #eef3f8;
  --kb-text: #172033;
  --kb-muted: #5d6b7f;
  --kb-accent: #2563eb;
  --kb-accent-2: #0f766e;
  --kb-border: #d8e0ea;
  --kb-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--kb-bg); }
body {
  margin: 0;
  color: var(--kb-text);
  background: linear-gradient(180deg, rgba(255,255,255,0.78), rgba(245,247,251,0.95)), var(--kb-bg);
  font-family: "Aptos", "Segoe UI", Arial, sans-serif;
  line-height: 1.58;
}
body > header, body > main, body > section, body > article, body > footer {
  width: min(1120px, calc(100% - 40px));
  margin-left: auto;
  margin-right: auto;
}
body > main, body > article { padding: 32px 0 64px; }
header, .hero, [data-dashboard-zone="hero"] { padding: 36px 0 24px; }
h1, h2, h3 { color: #0f172a; line-height: 1.06; letter-spacing: 0; }
h1 { font-size: clamp(2.25rem, 5vw, 4.4rem); margin: 0 0 16px; max-width: 13ch; }
h2 { font-size: clamp(1.45rem, 3vw, 2.25rem); margin: 0 0 14px; }
h3 { font-size: 1.08rem; margin: 0 0 10px; }
p { color: var(--kb-muted); margin: 0 0 14px; }
a { color: var(--kb-accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
nav { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 22px; }
nav a, button, .button, [role="button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 9px 14px;
  border: 1px solid var(--kb-border);
  border-radius: 8px;
  background: var(--kb-surface);
  color: var(--kb-text);
  font: inherit;
  font-weight: 650;
  text-decoration: none;
  cursor: pointer;
}
button, .button, [role="button"] {
  background: var(--kb-accent);
  color: #ffffff;
  border-color: transparent;
  box-shadow: 0 12px 28px rgba(37, 99, 235, 0.18);
}
section, article, aside, .card, .panel, .tile, .widget, .metric, .kpi, [data-dashboard-zone] {
  border: 1px solid var(--kb-border);
  background: rgba(255,255,255,0.92);
  border-radius: 14px;
  box-shadow: var(--kb-shadow);
  padding: 22px;
  margin: 0 0 18px;
}
header section, main section section, article section section { box-shadow: none; }
.grid, .cards, .dashboard-grid, .metrics, .kpis, [data-dashboard-zone="kpi-rail"], [data-dashboard-zone="chart-grid"] {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}
table {
  width: 100%;
  border-collapse: collapse;
  overflow: hidden;
  border-radius: 10px;
  background: var(--kb-surface);
}
th, td { border-bottom: 1px solid var(--kb-border); padding: 10px 12px; text-align: left; vertical-align: top; }
th { color: #0f172a; background: var(--kb-panel); font-weight: 750; }
input, select, textarea {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--kb-border);
  border-radius: 8px;
  padding: 9px 11px;
  background: #ffffff;
  color: var(--kb-text);
  font: inherit;
}
img, video, canvas, svg { max-width: 100%; height: auto; }
img { border-radius: 12px; display: block; }
pre {
  overflow: auto;
  padding: 14px;
  border-radius: 10px;
  background: #111827;
  color: #e5e7eb;
}
@media (max-width: 720px) {
  body > header, body > main, body > section, body > article, body > footer { width: min(100% - 24px, 1120px); }
  section, article, aside, .card, .panel, .tile, .widget, .metric, .kpi, [data-dashboard-zone] { padding: 16px; }
  nav { align-items: stretch; }
}
`;

const CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.htm': 'text/html; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.jsx': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ts': 'text/typescript; charset=utf-8',
    '.tsx': 'text/typescript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8',
};

function inferFrontendTitle(content = '') {
    const match = String(content || '').match(/<title>\s*([^<]+)\s*<\/title>/i)
        || String(content || '').match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i);
    return match?.[1]?.trim() || 'Frontend Demo';
}

function normalizeBundlePath(filePath = '') {
    const normalized = String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .trim();
    if (!normalized) {
        return '';
    }

    const safePath = path.normalize(normalized);
    if (!safePath || safePath === '.' || safePath.startsWith('../') || safePath.includes('/../')) {
        return '';
    }

    return safePath;
}

function inferBundleLanguage(filePath = '') {
    const extension = path.extname(String(filePath || '').toLowerCase());
    switch (extension) {
    case '.css':
        return 'css';
    case '.js':
    case '.mjs':
        return 'javascript';
    case '.json':
        return 'json';
    case '.svg':
        return 'svg';
    case '.html':
    case '.htm':
        return 'html';
    default:
        return null;
    }
}

function trimStandaloneHtmlDocument(content = '') {
    let source = String(content || '').trim();
    if (!source) {
        return '';
    }

    const htmlStart = source.search(/(?:<!doctype\s+html\b|<html\b|<body\b|<main\b|<section\b|<article\b|<div\b|<h1\b)/i);
    if (htmlStart > 0) {
        source = source.slice(htmlStart).trim();
    }

    const closeMatch = source.match(/<\/html\s*>/i);
    if (!closeMatch || !Number.isInteger(closeMatch.index)) {
        return source.replace(/```\s*$/i, '').trim();
    }

    return source.slice(0, closeMatch.index + closeMatch[0].length).trim();
}

function extractFencedHtmlContent(content = '') {
    const fencePattern = /```([a-z0-9_-]*)\s*([\s\S]*?)```/ig;
    let match;

    while ((match = fencePattern.exec(String(content || ''))) !== null) {
        const language = String(match[1] || '').trim().toLowerCase();
        const fencedContent = String(match[2] || '').trim();
        if (!fencedContent) {
            continue;
        }

        if (language === 'html' || /(?:<!doctype\s+html\b|<html\b|<body\b|<main\b|<section\b|<article\b|<div\b|<h1\b)/i.test(fencedContent)) {
            return trimStandaloneHtmlDocument(fencedContent);
        }
    }

    return '';
}

function sanitizeFrontendHtmlContent(content = '') {
    const source = String(content || '').replace(/\r\n?/g, '\n').trim();
    if (!source) {
        return '';
    }

    const fencedHtml = extractFencedHtmlContent(source);
    if (fencedHtml) {
        return fencedHtml;
    }

    const htmlStart = source.search(/(?:<!doctype\s+html\b|<html\b|<body\b|<main\b|<section\b|<article\b|<div\b|<h1\b)/i);
    if (htmlStart > 0) {
        return trimStandaloneHtmlDocument(source.slice(htmlStart));
    }

    return trimStandaloneHtmlDocument(source);
}

function normalizeFrontendRouting(value = '') {
    return String(value || '').trim().toLowerCase() === 'spa'
        ? 'spa'
        : 'multipage';
}

function resolveBundleSource(bundle = null) {
    return bundle?.files || bundle?.assets || bundle?.entries || null;
}

function normalizeFrontendBundle(bundle = null, content = '') {
    const files = [];
    const source = resolveBundleSource(bundle);

    if (Array.isArray(source)) {
        source.forEach((entry) => {
            if (!entry || typeof entry !== 'object') {
                return;
            }

            const fileContent = typeof entry.content === 'string'
                ? entry.content
                : (typeof entry.contents === 'string' ? entry.contents : '');
            const fileBuffer = Buffer.isBuffer(entry.contentBuffer)
                ? entry.contentBuffer
                : (Buffer.isBuffer(entry.buffer) ? entry.buffer : null);
            const base64Content = String(entry.contentBase64 || entry.dataBase64 || '').trim();
            const base64Buffer = base64Content ? Buffer.from(base64Content, 'base64') : null;
            const filePath = normalizeBundlePath(entry.path || entry.name || '');
            if (!filePath || (!fileContent.trim() && !fileBuffer && !base64Content)) {
                return;
            }
            const isHtmlFile = /\.html?$/i.test(filePath);
            const content = isHtmlFile
                ? sanitizeFrontendHtmlContent(
                    fileContent
                    || (fileBuffer ? fileBuffer.toString('utf8') : '')
                    || (base64Buffer ? base64Buffer.toString('utf8') : ''),
                )
                : fileContent;

            files.push({
                path: filePath,
                language: String(entry.language || '').trim() || inferBundleLanguage(filePath),
                purpose: String(entry.purpose || '').trim() || null,
                content,
                ...(fileBuffer && !isHtmlFile ? { contentBuffer: fileBuffer } : {}),
                ...(base64Buffer && !isHtmlFile ? { contentBuffer: base64Buffer } : {}),
            });
        });
    } else if (source && typeof source === 'object') {
        Object.entries(source).forEach(([filePath, fileContent]) => {
            const normalizedPath = normalizeBundlePath(filePath);
            if (!normalizedPath || typeof fileContent !== 'string' || !fileContent.trim()) {
                return;
            }

            files.push({
                path: normalizedPath,
                language: inferBundleLanguage(normalizedPath),
                purpose: null,
                content: /\.html?$/i.test(normalizedPath) ? sanitizeFrontendHtmlContent(fileContent) : fileContent,
            });
        });
    }

    if (!files.find((entry) => entry.path.toLowerCase() === 'index.html') && String(content || '').trim()) {
        files.unshift({
            path: 'index.html',
            language: 'html',
            purpose: 'Standalone demo entry point for preview and export.',
            content: sanitizeFrontendHtmlContent(content),
        });
    }

    const requestedEntry = normalizeBundlePath(bundle?.entry || bundle?.entryFile || 'index.html');
    const entry = files.find((file) => file.path === requestedEntry)
        ? requestedEntry
        : (files.find((file) => /\.html?$/i.test(file.path))?.path || 'index.html');

    return {
        entry,
        frameworkTarget: String(bundle?.frameworkTarget || bundle?.framework || 'static').trim().toLowerCase() || 'static',
        routing: normalizeFrontendRouting(bundle?.routing || bundle?.routeMode || bundle?.mode),
        files,
    };
}

function htmlHasSubstantiveStyle(content = '') {
    const source = String(content || '');
    const styleBlocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/ig)]
        .map((match) => String(match?.[1] || '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
        .filter(Boolean);

    return styleBlocks.some((css) => css.replace(/\s+/g, '').length >= 80)
        || /\sstyle=["'][^"']{12,}["']/i.test(source);
}

function htmlHasStylesheetLink(content = '') {
    return /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/i.test(String(content || ''));
}

function getStylesheetHrefs(content = '') {
    const source = String(content || '');
    const links = [...source.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/ig)];
    return links
        .map((match) => String(match?.[0] || '').match(/\bhref=["']([^"']+)["']/i)?.[1] || '')
        .map((href) => href.trim())
        .filter(Boolean);
}

function isExternalStylesheetHref(href = '') {
    return /^(?:https?:)?\/\//i.test(href) || /^(?:data|blob):/i.test(href);
}

function resolveStylesheetHrefPath(fromPath = '', href = '') {
    const normalizedHref = String(href || '').split(/[?#]/)[0].trim();
    if (!normalizedHref || isExternalStylesheetHref(normalizedHref)) {
        return '';
    }

    const fromDir = path.dirname(normalizeBundlePath(fromPath) || 'index.html');
    return normalizeBundlePath(
        normalizedHref.startsWith('/')
            ? normalizedHref
            : path.join(fromDir && fromDir !== '.' ? fromDir : '', normalizedHref),
    );
}

function findFirstLocalStylesheetPath(htmlFiles = []) {
    for (const file of htmlFiles) {
        const stylesheetPath = getStylesheetHrefs(file.content)
            .map((href) => resolveStylesheetHrefPath(file.path, href))
            .find(Boolean);
        if (stylesheetPath) {
            return stylesheetPath;
        }
    }

    return '';
}

function getRelativeBundleHref(fromPath = '', toPath = '') {
    const fromDir = path.dirname(normalizeBundlePath(fromPath) || 'index.html');
    const normalizedToPath = normalizeBundlePath(toPath);
    const relative = fromDir && fromDir !== '.'
        ? path.relative(fromDir, normalizedToPath)
        : normalizedToPath;
    return relative && !relative.startsWith('.') ? `./${relative}` : relative;
}

function injectStylesheetLink(content = '', href = '') {
    const source = String(content || '');
    if (!source || !href || htmlHasStylesheetLink(source)) {
        return source;
    }

    const linkTag = `<link rel="stylesheet" href="${href}">`;
    if (/<\/head>/i.test(source)) {
        return source.replace(/<\/head>/i, `${linkTag}\n</head>`);
    }
    if (/<html[^>]*>/i.test(source)) {
        return source.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${linkTag}\n</head>`);
    }
    return `${linkTag}\n${source}`;
}

function rewriteLocalStylesheetLinks(content = '', fromPath = '', availablePaths = new Set()) {
    const source = String(content || '');
    if (!source || !htmlHasStylesheetLink(source)) {
        return source;
    }

    return source.replace(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/ig, (linkTag) => {
        const hrefMatch = String(linkTag || '').match(/\bhref=(["'])([^"']+)\1/i);
        if (!hrefMatch) {
            return linkTag;
        }

        const originalHref = hrefMatch[2];
        if (isExternalStylesheetHref(originalHref)) {
            return linkTag;
        }

        const stylesheetPath = resolveStylesheetHrefPath(fromPath, originalHref);
        if (!stylesheetPath || !availablePaths.has(stylesheetPath)) {
            return linkTag;
        }

        const relativeHref = getRelativeBundleHref(fromPath, stylesheetPath);
        if (!relativeHref || relativeHref === originalHref) {
            return linkTag;
        }

        return linkTag.replace(hrefMatch[0], `href=${hrefMatch[1]}${relativeHref}${hrefMatch[1]}`);
    });
}

function ensureFrontendBundleStyling(bundle = null) {
    const normalized = normalizeFrontendBundle(bundle);
    if (!hasFrontendBundleFiles(normalized)) {
        return normalized;
    }

    const files = normalized.files.map((file) => ({ ...file }));
    const htmlFiles = files.filter((file) => /\.html?$/i.test(file.path));
    if (htmlFiles.length === 0) {
        return normalized;
    }

    let cssFile = files.find((file) => /\.css$/i.test(file.path) && String(file.content || '').trim());
    const needsSafetyNetCss = htmlFiles.some((file) => {
        if (htmlHasSubstantiveStyle(file.content)) {
            return false;
        }

        const stylesheetHrefs = getStylesheetHrefs(file.content);
        return stylesheetHrefs.length === 0
            || (!cssFile && stylesheetHrefs.every((href) => !isExternalStylesheetHref(href)));
    });

    if (!cssFile && needsSafetyNetCss) {
        const fallbackCssPath = findFirstLocalStylesheetPath(htmlFiles) || STYLE_SAFETY_NET_PATH;
        cssFile = {
            path: fallbackCssPath,
            language: 'css',
            purpose: 'Generated fallback styles for server preview.',
            content: STYLE_SAFETY_NET_CSS,
        };
        files.push(cssFile);
    }

    if (!cssFile) {
        return {
            ...normalized,
            files,
        };
    }

    const availablePaths = new Set(files.map((file) => normalizeBundlePath(file.path)).filter(Boolean));
    const styledFiles = files.map((file) => {
        if (!/\.html?$/i.test(file.path)) {
            return file;
        }

        const contentWithRelativeLinks = rewriteLocalStylesheetLinks(file.content, file.path, availablePaths);
        if (htmlHasSubstantiveStyle(contentWithRelativeLinks) || htmlHasStylesheetLink(contentWithRelativeLinks)) {
            return {
                ...file,
                content: contentWithRelativeLinks,
            };
        }

        return {
            ...file,
            content: injectStylesheetLink(contentWithRelativeLinks, getRelativeBundleHref(file.path, cssFile.path)),
        };
    });

    return {
        ...normalized,
        files: styledFiles,
    };
}

function buildEmptyBundleFallbackHtml(title = 'Frontend Demo') {
    const safeTitle = escapeHtml(title || 'Frontend Demo');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body>
<main>
  <h1>${safeTitle}</h1>
  <p>This playable entry point was added because the generated sandbox bundle did not include any files. Regenerate the page to replace this recovery page with the requested experience.</p>
</main>
</body>
</html>`;
}

function buildBundleIndexHtml(title = 'Frontend Bundle', files = []) {
    const links = files
        .filter((file) => file?.path && /\.html?$/i.test(file.path))
        .map((file) => `<li><a href="./${escapeHtml(file.path)}">${escapeHtml(file.path)}</a></li>`)
        .join('\n');
    const safeTitle = escapeHtml(title || 'Frontend Bundle');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body>
<main>
  <h1>${safeTitle}</h1>
  <p>Select a page to play this bundled frontend.</p>
  <ul>
${links || '<li>No HTML pages were included.</li>'}
  </ul>
</main>
</body>
</html>`;
}

function ensurePlayableFrontendEntry(bundle = null, title = 'Frontend Demo') {
    const normalized = normalizeFrontendBundle(bundle);
    const files = normalized.files.map((file) => ({ ...file }));
    let entry = normalizeBundlePath(normalized.entry || 'index.html') || 'index.html';
    const entryExists = files.some((file) => file.path === entry);
    const htmlFile = files.find((file) => /\.html?$/i.test(file.path));

    if (files.length === 0) {
        files.push({
            path: 'index.html',
            language: 'html',
            purpose: 'Playable recovery entry point.',
            content: buildEmptyBundleFallbackHtml(title),
        });
        entry = 'index.html';
    } else if (!entryExists && htmlFile) {
        entry = htmlFile.path;
    } else if (!htmlFile) {
        files.unshift({
            path: 'index.html',
            language: 'html',
            purpose: 'Playable bundle index.',
            content: buildBundleIndexHtml(title, files),
        });
        entry = 'index.html';
    }

    return {
        ...normalized,
        entry,
        files,
    };
}

function extractImageReferencesFromHtml(content = '') {
    const source = String(content || '');
    const refs = [];
    const tagPattern = /<(?:img|source|video)\b[^>]*(?:\bsrc|\bposter)=["']([^"']+)["'][^>]*>/ig;
    let match;
    while ((match = tagPattern.exec(source)) !== null) {
        const tag = match[0] || '';
        const src = String(match[1] || '').trim();
        if (!src) {
            continue;
        }
        const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
        refs.push({
            src,
            alt,
            source: 'html',
        });
    }
    return refs;
}

function extractImageReferencesFromCss(content = '') {
    const refs = [];
    const pattern = /url\((['"]?)([^'")]+)\1\)/ig;
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
        const src = String(match[2] || '').trim();
        if (!src || /^(?:#|data:font|https?:\/\/fonts\.)/i.test(src)) {
            continue;
        }
        refs.push({
            src,
            alt: '',
            source: 'css',
        });
    }
    return refs;
}

function normalizeImageManifestEntries(files = [], explicitReferences = []) {
    const unique = new Map();
    const add = (entry = {}) => {
        const src = String(entry.src || entry.url || entry.imageUrl || '').trim();
        if (!src || unique.has(src)) {
            return;
        }
        unique.set(src, {
            src,
            alt: String(entry.alt || entry.title || entry.imageAlt || '').trim(),
            source: String(entry.source || entry.toolId || 'bundle').trim(),
            ...(entry.artifactId ? { artifactId: String(entry.artifactId).trim() } : {}),
        });
    };

    (Array.isArray(explicitReferences) ? explicitReferences : []).forEach(add);
    files.forEach((file) => {
        if (/\.html?$/i.test(file.path)) {
            extractImageReferencesFromHtml(file.content).forEach(add);
        }
        if (/\.css$/i.test(file.path)) {
            extractImageReferencesFromCss(file.content).forEach(add);
        }
    });

    return Array.from(unique.values());
}

function buildFrontendBundleReadme(bundle = null, title = 'Frontend Bundle', imageManifest = []) {
    const normalized = normalizeFrontendBundle(bundle);
    const fileList = normalized.files
        .map((file) => `- ${file.path}${file.purpose ? ` - ${file.purpose}` : ''}`)
        .join('\n');
    const imageNote = imageManifest.length > 0
        ? `\nImages and media referenced by the bundle are listed in \`${IMAGE_MANIFEST_PATH}\`. Keep local asset files with the same relative paths when moving the bundle.\n`
        : '';

    return [
        `# ${title || 'Frontend Bundle'}`,
        '',
        '## Play',
        '',
        `- In KimiBuilt, open the artifact sandbox/preview URL for the quickest playable view.`,
        `- From the unzipped folder, run a static server and open the entry page:`,
        '',
        '```bash',
        'python -m http.server 8000',
        '```',
        '',
        `Then visit \`http://localhost:8000/${normalized.entry || 'index.html'}\`.`,
        '',
        '## Promote',
        '',
        '- Keep this sandbox as the local prototype and visual reference.',
        '- Move the bundle files into a managed app or repository before live work; preserve `AGENT_SANDBOX_BUILD.md` and this README as handoff context.',
        '- For remote builds, pass the artifact or bundle ID, source files, technology choice, and QA notes to `managed-app iterate` or `remote-cli-agent` instead of rebuilding from scratch.',
        '- Treat live promotion as incomplete until there is source/Git evidence, build or image evidence, rollout/deploy evidence, a public URL, and browser/UI-check proof.',
        imageNote,
        '## Files',
        '',
        fileList || '- index.html',
        '',
    ].join('\n');
}

function ensureFrontendBundleSupportFiles(bundle = null, title = 'Frontend Bundle', options = {}) {
    const normalized = normalizeFrontendBundle(bundle);
    const files = normalized.files.map((file) => ({ ...file }));
    const imageManifest = normalizeImageManifestEntries(files, options.imageReferences);
    const hasReadme = files.some((file) => file.path.toLowerCase() === BUNDLE_README_PATH.toLowerCase());
    const hasImageManifest = files.some((file) => file.path.toLowerCase() === IMAGE_MANIFEST_PATH.toLowerCase());

    if (imageManifest.length > 0 && !hasImageManifest) {
        files.push({
            path: IMAGE_MANIFEST_PATH,
            language: 'json',
            purpose: 'Image and media references used by the playable bundle.',
            content: `${JSON.stringify({ images: imageManifest }, null, 2)}\n`,
        });
    }

    if (!hasReadme) {
        files.push({
            path: BUNDLE_README_PATH,
            language: 'markdown',
            purpose: 'How to play and reuse this frontend bundle.',
            content: buildFrontendBundleReadme({
                ...normalized,
                files,
            }, title, imageManifest),
        });
    }

    return {
        ...normalized,
        files,
    };
}

function normalizeFrontendHandoff(handoff = null, metadata = {}, content = '') {
    const targetFramework = String(
        handoff?.targetFramework
        || handoff?.framework
        || metadata.frameworkTarget
        || metadata.framework
        || 'static'
    ).trim() || 'static';

    const componentMap = Array.isArray(handoff?.componentMap)
        ? handoff.componentMap
            .map((entry) => ({
                name: String(entry?.name || '').trim(),
                purpose: String(entry?.purpose || '').trim(),
                targetPath: normalizeBundlePath(entry?.targetPath || '') || null,
            }))
            .filter((entry) => entry.name && entry.purpose)
        : [];
    const designMoves = Array.isArray(handoff?.designMoves)
        ? handoff.designMoves
            .map((entry) => ({
                name: String(entry?.name || '').trim(),
                purpose: String(entry?.purpose || '').trim(),
                interaction: String(entry?.interaction || '').trim(),
                effect: String(entry?.effect || '').trim(),
                fallback: String(entry?.fallback || '').trim(),
            }))
            .filter((entry) => entry.name && (entry.purpose || entry.interaction || entry.effect))
        : [];
    const buildWorkbenchInput = handoff?.buildWorkbench && typeof handoff.buildWorkbench === 'object'
        ? handoff.buildWorkbench
        : {};
    const normalizeTextList = (value) => Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const buildWorkbench = {
        mode: String(buildWorkbenchInput.mode || 'agent-build-workbench').trim() || 'agent-build-workbench',
        phases: Array.isArray(buildWorkbenchInput.phases)
            ? buildWorkbenchInput.phases
                .map((entry) => ({
                    id: String(entry?.id || entry?.name || '').trim(),
                    name: String(entry?.name || entry?.id || '').trim(),
                    purpose: String(entry?.purpose || '').trim(),
                    entryCondition: String(entry?.entryCondition || entry?.entry || '').trim(),
                    actions: normalizeTextList(entry?.actions),
                    exitCheck: String(entry?.exitCheck || entry?.proof || '').trim(),
                }))
                .filter((entry) => entry.name && (entry.purpose || entry.actions.length > 0 || entry.exitCheck))
            : [],
        commands: Array.isArray(buildWorkbenchInput.commands)
            ? buildWorkbenchInput.commands
                .map((entry) => ({
                    name: String(entry?.name || '').trim(),
                    purpose: String(entry?.purpose || '').trim(),
                    when: String(entry?.when || entry?.phase || '').trim(),
                    args: normalizeTextList(entry?.args),
                }))
                .filter((entry) => entry.name && (entry.purpose || entry.when || entry.args.length > 0))
            : [],
        hookPoints: Array.isArray(buildWorkbenchInput.hookPoints)
            ? buildWorkbenchInput.hookPoints
                .map((entry) => ({
                    phase: String(entry?.phase || '').trim(),
                    kind: String(entry?.kind || entry?.type || '').trim(),
                    description: String(entry?.description || entry?.purpose || '').trim(),
                    scriptOrFunction: String(entry?.scriptOrFunction || entry?.callable || '').trim(),
                }))
                .filter((entry) => entry.phase || entry.description || entry.scriptOrFunction)
            : [],
        callableHooks: Array.isArray(buildWorkbenchInput.callableHooks)
            ? buildWorkbenchInput.callableHooks
                .map((entry) => ({
                    name: String(entry?.name || '').trim(),
                    type: String(entry?.type || '').trim(),
                    when: String(entry?.when || entry?.phase || '').trim(),
                    input: String(entry?.input || '').trim(),
                    output: String(entry?.output || '').trim(),
                    proof: String(entry?.proof || '').trim(),
                }))
                .filter((entry) => entry.name && (entry.type || entry.when || entry.proof))
            : [],
        objectFactories: Array.isArray(buildWorkbenchInput.objectFactories)
            ? buildWorkbenchInput.objectFactories
                .map((entry) => ({
                    name: String(entry?.name || '').trim(),
                    purpose: String(entry?.purpose || '').trim(),
                    creates: String(entry?.creates || entry?.output || '').trim(),
                    placeholderStrategy: String(entry?.placeholderStrategy || entry?.fallback || '').trim(),
                }))
                .filter((entry) => entry.name && (entry.purpose || entry.creates || entry.placeholderStrategy))
            : [],
        qaGates: Array.isArray(buildWorkbenchInput.qaGates)
            ? buildWorkbenchInput.qaGates
                .map((entry) => ({
                    name: String(entry?.name || '').trim(),
                    checks: normalizeTextList(entry?.checks),
                    onFail: String(entry?.onFail || entry?.fallback || '').trim(),
                }))
                .filter((entry) => entry.name && (entry.checks.length > 0 || entry.onFail))
            : [],
    };

    const integrationSteps = Array.isArray(handoff?.integrationSteps)
        ? handoff.integrationSteps
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : [];
    const qaPlan = Array.isArray(handoff?.qaPlan)
        ? handoff.qaPlan
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : [];
    const fallbackGateInput = handoff?.fallbackGate && typeof handoff.fallbackGate === 'object'
        ? handoff.fallbackGate
        : {};
    const fallbackDecision = String(fallbackGateInput.decision || '').trim().toLowerCase();
    const fallbackGate = {
        decision: ['repair', 'redesign', 'ask', 'ready'].includes(fallbackDecision) ? fallbackDecision : 'ready',
        reason: String(fallbackGateInput.reason || '').trim() || 'No fallback blocker was reported during generation.',
        nextAction: String(fallbackGateInput.nextAction || '').trim() || 'Proceed with browser QA and revise if a blocker appears.',
    };
    const placeholderAssets = Array.isArray(handoff?.placeholderAssets)
        ? handoff.placeholderAssets
            .map((entry) => ({
                role: String(entry?.role || entry?.name || '').trim(),
                placeholder: String(entry?.placeholder || entry?.description || '').trim(),
                replaces: String(entry?.replaces || entry?.targetAsset || '').trim(),
                behavior: String(entry?.behavior || '').trim(),
            }))
            .filter((entry) => entry.role && entry.placeholder)
        : [];

    return {
        summary: String(
            handoff?.summary
            || metadata.summary
            || 'Portable frontend demo with a standalone preview and repo-ready file guidance.'
        ).trim() || 'Portable frontend demo with a standalone preview and repo-ready file guidance.',
        targetFramework,
        componentMap,
        buildWorkbench: (
            buildWorkbench.phases.length > 0
            || buildWorkbench.commands.length > 0
            || buildWorkbench.hookPoints.length > 0
            || buildWorkbench.callableHooks.length > 0
            || buildWorkbench.objectFactories.length > 0
            || buildWorkbench.qaGates.length > 0
        ) ? buildWorkbench : {
            mode: 'agent-build-workbench',
            phases: [
                {
                    id: 'brief',
                    name: 'Brief',
                    purpose: 'Confirm the artifact goal, assets, missing context, and acceptance proof.',
                    entryCondition: 'User request is ready to build.',
                    actions: ['Capture assumptions and select the build lane.'],
                    exitCheck: 'A previewable bundle target is named.',
                },
                {
                    id: 'build',
                    name: 'Build',
                    purpose: 'Assemble the runnable bundle and any script/function hooks.',
                    entryCondition: 'Technology and bundle structure are selected.',
                    actions: ['Create source files and wire interactions or object factories.'],
                    exitCheck: 'Entry file renders from the bundle.',
                },
                {
                    id: 'qa_gate',
                    name: 'QA Gate',
                    purpose: 'Check rendering, interaction, accessibility, and fallback behavior.',
                    entryCondition: 'Preview URL or bundle entry exists.',
                    actions: ['Run browser QA and classify repair, redesign, ask, or ready.'],
                    exitCheck: 'Fallback gate has a decision and next action.',
                },
            ],
            commands: [
                {
                    name: 'run_preview_qa',
                    purpose: 'Open the bundle and collect proof before promotion.',
                    when: 'After the first runnable build.',
                    args: ['entryFile', 'targetViewport'],
                },
            ],
            hookPoints: [],
            callableHooks: [],
            objectFactories: [],
            qaGates: [
                {
                    name: 'repair_redesign_gate',
                    checks: ['console errors', 'blank render', 'overflow', 'missing assets', 'generic or mismatched design'],
                    onFail: 'repair or redesign before finalizing',
                },
            ],
        },
        designMoves,
        integrationSteps: integrationSteps.length > 0
            ? integrationSteps
            : [
                'Review the sandbox preview as the local prototype before moving it into a live repository.',
                'Split reusable pieces into project components, preserving the generated design tokens, interaction states, and data adapter boundaries.',
                'Replace demo copy, mock data, and inline scripts with live project data and components.',
                'Promote through managed-app or remote-cli-agent with the bundle/artifact IDs, source files, technology choice, and QA notes attached.',
            ],
        qaPlan: qaPlan.length > 0
            ? qaPlan
            : [
                'Open the bundle entry page from a static server and check for console errors.',
                'Capture desktop and mobile screenshots, including any primary interactive states.',
                'Run contrast, horizontal overflow, broken image, clipped text, opened-control, and canvas/WebGL render checks before handoff.',
            ],
        fallbackGate,
        ...(placeholderAssets.length > 0 ? { placeholderAssets } : {}),
        entryFile: normalizeBundlePath(handoff?.entryFile || 'index.html') || 'index.html',
        sourceType: /<html\b/i.test(String(content || '')) ? 'standalone-html' : 'markup-fragment',
    };
}

function buildFrontendFallbackMetadata(content = '') {
    const title = inferFrontendTitle(content);
    return {
        type: 'frontend',
        title,
        language: 'html',
        frameworkTarget: 'static',
        previewMode: 'iframe',
        bundle: normalizeFrontendBundle(null, content),
        handoff: normalizeFrontendHandoff({ summary: `Standalone frontend demo for ${title}.` }, {}, content),
    };
}

function normalizeFrontendMetadata(metadata = {}, content = '') {
    const normalized = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...metadata }
        : {};

    return {
        ...normalized,
        type: 'frontend',
        title: String(normalized.title || '').trim() || inferFrontendTitle(content),
        language: String(normalized.language || 'html').trim() || 'html',
        frameworkTarget: String(normalized.frameworkTarget || normalized.framework || 'static').trim() || 'static',
        previewMode: 'iframe',
        bundle: normalizeFrontendBundle(normalized.bundle, content),
        handoff: normalizeFrontendHandoff(normalized.handoff, normalized, content),
    };
}

function getFrontendBundleFile(bundle = null, requestedPath = '') {
    const normalizedBundle = normalizeFrontendBundle(bundle);
    const targetPath = normalizeBundlePath(requestedPath);
    const candidates = targetPath
        ? [
            targetPath,
            targetPath.endsWith('/') ? `${targetPath.replace(/\/+$/g, '')}/index.html` : `${targetPath}/index.html`,
            !path.extname(targetPath) ? `${targetPath}.html` : '',
        ].filter(Boolean)
        : [normalizedBundle.entry];

    for (const candidate of candidates) {
        const file = normalizedBundle.files.find((entry) => entry.path === candidate);
        if (file) {
            return file;
        }
    }

    if (normalizedBundle.routing === 'spa' && targetPath && !path.extname(targetPath)) {
        return normalizedBundle.files.find((entry) => entry.path === normalizedBundle.entry) || null;
    }

    return null;
}

function hasFrontendBundleFiles(bundle = null) {
    return Array.isArray(bundle?.files) && bundle.files.length > 0;
}

function hasFrontendBundleArchive(bundle = null) {
    return hasFrontendBundleFiles(bundle) && bundle.files.length > 1;
}

function createFrontendBundleArchive(bundle = null) {
    const normalizedBundle = normalizeFrontendBundle(bundle);
    return createZip(normalizedBundle.files.map((file) => ({
        name: file.path,
        data: file.contentBuffer || file.buffer || file.content,
    })));
}

function buildFrontendBundleExtractedText(bundle = null) {
    const normalized = normalizeFrontendBundle(bundle);
    const parts = [];

    for (const file of normalized.files) {
        const source = String(file.content || '');
        if (!source.trim()) {
            continue;
        }

        const body = /\.html?$/i.test(file.path)
            ? stripHtml(source)
            : source;
        if (!body.trim()) {
            continue;
        }

        parts.push(`[${file.path}]\n${body.trim()}`);
        if (parts.join('\n\n').length >= MAX_FRONTEND_BUNDLE_EXTRACTED_TEXT_CHARS) {
            break;
        }
    }

    return parts.join('\n\n').slice(0, MAX_FRONTEND_BUNDLE_EXTRACTED_TEXT_CHARS);
}

function buildFrontendBundleArtifact(bundle = null, title = 'Frontend Bundle', options = {}) {
    const playable = ensurePlayableFrontendEntry(bundle, title);
    const styled = ensureFrontendBundleStyling(playable);
    const normalized = ensureFrontendBundleSupportFiles(styled, title, options);
    const entryFile = normalized.files.find((file) => file.path === normalized.entry)
        || normalized.files.find((file) => /\.html?$/i.test(file.path))
        || normalized.files[0];

    return {
        filename: createUniqueFilename(title, 'zip', 'frontend-bundle'),
        format: 'zip',
        mimeType: 'application/zip',
        buffer: createFrontendBundleArchive(normalized),
        previewHtml: String(entryFile?.content || ''),
        extractedText: buildFrontendBundleExtractedText(normalized),
        metadata: {
            title,
            bundle: normalized,
            frameworkTarget: normalized.frameworkTarget,
            previewMode: 'site',
            siteBundle: buildFrontendBundleSummary(normalized),
        },
    };
}

function buildFrontendBundlePreviewUrl(artifactId = '', relativePath = '') {
    const encodedId = encodeURIComponent(String(artifactId || '').trim());
    const normalizedPath = String(relativePath || '').trim().replace(/^\/+/, '');
    const base = `/api/artifacts/${encodedId}/preview/`;
    return normalizedPath ? `${base}${normalizedPath}` : base;
}

function injectBundleBaseHref(content = '', baseHref = '') {
    const source = String(content || '');
    if (!source || !baseHref || /<base\b/i.test(source)) {
        return source;
    }

    const baseTag = `<base href="${baseHref}">`;
    if (/<head[^>]*>/i.test(source)) {
        return source.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`);
    }

    return source.replace(/<!doctype html>/i, (match) => `${match}\n<head>${baseTag}</head>`);
}

function readFrontendBundleArchive(buffer = Buffer.alloc(0)) {
    return readZipEntries(buffer);
}

function resolveFrontendBundleContentType(filePath = '') {
    return CONTENT_TYPES[path.extname(String(filePath || '').toLowerCase())] || 'text/plain; charset=utf-8';
}

function rewriteRootRelativeFrontendPaths(content = '', previewBasePath = '') {
    const prefix = `/${String(previewBasePath || '').replace(/^\/+|\/+$/g, '')}`;
    if (!prefix || prefix === '/') {
        return String(content || '');
    }

    return String(content || '')
        .replace(/(\b(?:href|src|action|poster)=["'])\/(?!\/|api\/)([^"']*)(["'])/gi, `$1${prefix}/$2$3`)
        .replace(/url\((['"]?)\/(?!\/|api\/)([^'")]+)\1\)/gi, `url($1${prefix}/$2$1)`);
}

function hasExplicitFrontendBundle(metadata = {}) {
    const source = metadata?.siteBundle || metadata?.bundle || null;
    if (!source || typeof source !== 'object') {
        return false;
    }

    if (Array.isArray(source.files)) {
        return source.files.length > 0;
    }

    return source.files && typeof source.files === 'object'
        ? Object.keys(source.files).length > 0
        : false;
}

function getArtifactFrontendBundle(artifact = {}, options = {}) {
    const fallbackContent = options.includeFallbackContent === false
        ? ''
        : String(
            artifact?.previewHtml
            || (artifact?.mimeType === 'text/html' && Buffer.isBuffer(artifact?.contentBuffer)
                ? artifact.contentBuffer.toString('utf8')
                : ''),
        );

    return normalizeFrontendBundle(
        artifact?.metadata?.siteBundle || artifact?.metadata?.bundle || null,
        fallbackContent,
    );
}

function buildFrontendBundleSummary(bundle = null, content = '') {
    const normalized = normalizeFrontendBundle(bundle, content);
    if (!normalized || normalized.files.length === 0) {
        return null;
    }

    const htmlPages = normalized.files.filter((file) => /\.html?$/i.test(file.path));
    return {
        entry: normalized.entry,
        frameworkTarget: normalized.frameworkTarget,
        routing: normalized.routing,
        fileCount: normalized.files.length,
        htmlPageCount: htmlPages.length,
        files: normalized.files.map((file) => ({
            path: file.path,
            language: file.language,
            purpose: file.purpose,
        })),
    };
}

function sanitizeFrontendArtifactMetadata(metadata = {}, content = '') {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }

    const next = { ...metadata };
    if (next.bundle) {
        next.bundle = buildFrontendBundleSummary(next.bundle, content) || next.bundle;
    }
    if (next.siteBundle) {
        next.siteBundle = buildFrontendBundleSummary(next.siteBundle, content) || next.siteBundle;
    }

    return next;
}

function resolveArtifactFrontendBundleFile(artifact = {}, requestedPath = '', options = {}) {
    let entries;
    try {
        entries = readFrontendBundleArchive(artifact?.contentBuffer || Buffer.alloc(0));
    } catch (_error) {
        return null;
    }
    const bundle = getArtifactFrontendBundle(artifact, { includeFallbackContent: false });
    const entryPath = normalizeBundlePath(bundle.entry || 'index.html') || 'index.html';
    const targetPath = normalizeBundlePath(requestedPath);
    const candidates = targetPath
        ? [
            targetPath,
            targetPath.endsWith('/') ? `${targetPath.replace(/\/+$/g, '')}/index.html` : `${targetPath}/index.html`,
            !path.extname(targetPath) ? `${targetPath}.html` : '',
        ].filter(Boolean)
        : [entryPath];
    const resolvedPath = candidates.find((candidate) => entries.has(candidate));
    if (!resolvedPath) {
        return null;
    }

    let contentBuffer = entries.get(resolvedPath);
    if (/\.html?$/i.test(resolvedPath)) {
        const html = contentBuffer.toString('utf8');
        const directory = path.dirname(resolvedPath);
        const previewBasePath = String(options.previewBasePath || '').trim() || buildFrontendBundlePreviewUrl(artifact.id);
        const normalizedPreviewBase = previewBasePath.endsWith('/') ? previewBasePath : `${previewBasePath}/`;
        const baseHref = directory && directory !== '.'
            ? `${normalizedPreviewBase}${directory.replace(/\/+$/g, '')}/`
            : normalizedPreviewBase;
        contentBuffer = Buffer.from(injectBundleBaseHref(
            rewriteRootRelativeFrontendPaths(html, normalizedPreviewBase),
            baseHref,
        ), 'utf8');
    }

    return {
        path: resolvedPath,
        contentType: resolveFrontendBundleContentType(resolvedPath),
        contentBuffer,
    };
}

function extractRequestedSitePageCount(text = '') {
    const normalized = String(text || '').toLowerCase();
    const ranged = normalized.match(/\b(\d{1,2})\s*(?:or|to|-)\s*(\d{1,2})\s+pages?\b/);
    if (ranged) {
        return Math.max(2, Math.min(10, Number(ranged[2]) || Number(ranged[1]) || 0)) || null;
    }

    const direct = normalized.match(/\b(\d{1,2})\s+pages?\b/);
    if (!direct) {
        return null;
    }

    return Math.max(2, Math.min(10, Number(direct[1]) || 0)) || null;
}

function isComplexFrontendBundleRequest(text = '', existingContent = '') {
    const normalized = `${String(text || '')}\n${String(existingContent || '')}`.toLowerCase();
    if (!normalized.trim()) {
        return false;
    }

    if (/\bvite\b/.test(normalized)) {
        return true;
    }

    if (/\b(3d|three\.?js|webgl|web gpu|webgpu|immersive scene|interactive scene|scene sandbox|sandboxed scene|shader|particles?|orbit controls?)\b/.test(normalized)) {
        return true;
    }

    const hasSiteCue = /\b(website|site|microsite|news site|newsroom|frontend demo|site prototype|site mockup)\b/.test(normalized);
    const hasComplexityCue = /\b(multi[- ]page|multiple pages|full website|full site|complete website|site map|sitemap|navigation|routes?|sub[- ]agents?|delegate|parallel)\b/.test(normalized)
        || /\b\d{1,2}\s+pages?\b/.test(normalized);

    return hasSiteCue && hasComplexityCue;
}

module.exports = {
    buildFrontendBundleArtifact,
    buildFrontendBundleSummary,
    buildFrontendFallbackMetadata,
    buildFrontendBundlePreviewUrl,
    createFrontendBundleArchive,
    ensureFrontendBundleStyling,
    extractRequestedSitePageCount,
    getArtifactFrontendBundle,
    getFrontendBundleFile,
    hasExplicitFrontendBundle,
    hasFrontendBundleArchive,
    hasFrontendBundleFiles,
    inferFrontendTitle,
    injectBundleBaseHref,
    isComplexFrontendBundleRequest,
    normalizeBundlePath,
    normalizeFrontendBundle,
    normalizeFrontendHandoff,
    normalizeFrontendMetadata,
    normalizeFrontendRouting,
    readFrontendBundleArchive,
    resolveArtifactFrontendBundleFile,
    resolveFrontendBundleContentType,
    rewriteRootRelativeFrontendPaths,
    sanitizeFrontendArtifactMetadata,
    sanitizeFrontendHtmlContent,
};
