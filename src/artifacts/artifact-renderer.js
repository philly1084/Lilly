const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');
const { createZip } = require('../utils/zip');
const { createFriendlyFilenameBase, createUniqueFilename, escapeHtml, escapeXml, normalizeWhitespace, slugifyFilename, stripHtml } = require('../utils/text');
const { FORMAT_EXTENSIONS, FORMAT_MIME_TYPES, normalizeFormat } = require('./constants');
const { artifactStore } = require('./artifact-store');
const { config } = require('../config');

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_BROWSER_ARGS = [
    '--allow-file-access-from-files',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-sandbox',
];
const PDF_RENDER_CRASHLOG_DIR = path.join(process.cwd(), 'output', 'crashlogs', 'pdf-renderer');
const GENERATED_ARTIFACT_STYLE_MARKER = 'data-kimibuilt-style-safety-net';
const GENERATED_ARTIFACT_BASE_CSS = `
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
      background:
        linear-gradient(180deg, rgba(255,255,255,0.78), rgba(245,247,251,0.95)),
        var(--kb-bg);
      font-family: "Aptos", "Segoe UI", Arial, sans-serif;
      line-height: 1.58;
    }
    body > header, body > main, body > section, body > article, body > footer {
      width: min(1120px, calc(100% - 40px));
      margin-left: auto;
      margin-right: auto;
    }
    body > main, body > article { padding: 32px 0 64px; }
    header, .hero, [data-dashboard-zone="hero"] {
      padding: 36px 0 24px;
    }
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

function serializePdfRenderError(error) {
    return {
        name: error?.name || 'Error',
        message: error?.message || String(error || 'Unknown PDF render error'),
        stack: error?.stack || '',
        code: error?.code || '',
        signal: error?.signal || '',
        killed: Boolean(error?.killed),
        stdout: typeof error?.stdout === 'string' ? error.stdout.slice(0, 20000) : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr.slice(0, 20000) : '',
    };
}

async function writePdfRenderCrashLog({
    stage = 'unknown',
    error = null,
    title = '',
    browserPath = '',
    htmlPath = '',
    pdfPath = '',
    html = '',
} = {}) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const slug = createFriendlyFilenameBase(title || stage || 'pdf-render', 'pdf-render');
        const baseName = `${timestamp}-${process.pid}-${slug}`.slice(0, 180);
        await fs.mkdir(PDF_RENDER_CRASHLOG_DIR, { recursive: true });
        const metadata = {
            timestamp,
            stage,
            title,
            pid: process.pid,
            platform: process.platform,
            node: process.version,
            browserPath,
            htmlPath,
            pdfPath,
            pdfTimeoutMs: config.artifacts.pdfTimeoutMs,
            browserArgs: config.artifacts.browserArgs || '',
            error: serializePdfRenderError(error),
        };
        await fs.writeFile(
            path.join(PDF_RENDER_CRASHLOG_DIR, `${baseName}.json`),
            `${JSON.stringify(metadata, null, 2)}\n`,
            'utf8',
        );
        if (html) {
            await fs.writeFile(
                path.join(PDF_RENDER_CRASHLOG_DIR, `${baseName}.html`),
                html,
                'utf8',
            );
        }
    } catch (logError) {
        console.warn('[Artifacts] Failed to write PDF render crashlog:', logError.message);
    }
}

function splitArgs(value = '') {
    return String(value || '')
        .trim()
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function getBrowserCandidates() {
    const candidates = [
        process.env.PLAYWRIGHT_EXECUTABLE_PATH,
        config.artifacts.browserPath,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.BROWSER_EXECUTABLE_PATH,
        process.env.CHROME_BIN,
    ];

    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || '';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        candidates.push(
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        );
    } else {
        candidates.push(
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/snap/bin/chromium',
            'chromium',
            'chromium-browser',
            'google-chrome',
            'google-chrome-stable',
        );
    }

    return Array.from(new Set(candidates.filter(Boolean)));
}

function loadPlaywrightPackage() {
    const moduleNames = ['playwright', 'playwright-core'];

    for (const moduleName of moduleNames) {
        try {
            const loaded = require(moduleName);
            if (loaded?.chromium) {
                return { moduleName, chromium: loaded.chromium };
            }
        } catch (error) {
            const missingModule = error?.code === 'MODULE_NOT_FOUND'
                && String(error.message || '').includes(moduleName);
            if (!missingModule) {
                throw error;
            }
        }
    }

    return null;
}

function detectMermaidDiagramType(text = '') {
    const source = String(text || '').trim();
    const detectors = [
        ['flowchart', /^(?:flowchart|graph)\b/i],
        ['sequence', /^sequenceDiagram\b/i],
        ['class', /^classDiagram\b/i],
        ['er', /^erDiagram\b/i],
        ['state', /^stateDiagram(?:-v2)?\b/i],
        ['gantt', /^gantt\b/i],
        ['pie', /^pie\b/i],
        ['journey', /^journey\b/i],
        ['timeline', /^timeline\b/i],
        ['mindmap', /^mindmap\b/i],
        ['gitgraph', /^gitGraph\b/i],
    ];

    return detectors.find(([, pattern]) => pattern.test(source))?.[0] || 'unknown';
}

function normalizeMermaidSource(text = '') {
    let source = String(text || '')
        .replace(/\r\n?/g, '\n')
        .trim();

    if (!source) {
        return '';
    }

    const fenced = source.match(/^```(?:mermaid)?\s*([\s\S]*?)```$/i);
    if (fenced) {
        source = fenced[1].trim();
    }

    const diagramType = detectMermaidDiagramType(source);
    const canRecoverFromInlineSpacing = diagramType !== 'mindmap';

    if (!source.includes('\n') && canRecoverFromInlineSpacing && /\s{2,}/.test(source)) {
        source = source
            .split(/\s{2,}/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join('\n');
    }

    source = source
        .replace(/^(flowchart|graph)\s+([A-Za-z]{2})\s+(?=\S)/i, '$1 $2\n')
        .replace(/^(sequenceDiagram|classDiagram|erDiagram|stateDiagram(?:-v2)?|gitGraph|journey|timeline)\s+(?=\S)/i, '$1\n');

    if (canRecoverFromInlineSpacing) {
        source = source.replace(
            /\s+(?=(?:style|classDef|class|linkStyle|click|subgraph|end|section|participant|actor|note|title|accTitle|accDescr)\b)/g,
            '\n',
        );
    }

    return source
        .split('\n')
        .flatMap((line) => (
            canRecoverFromInlineSpacing && /\s{2,}/.test(line) && !/^\s/.test(line)
                ? line.split(/\s{2,}/)
                : [line]
        ))
        .map((line) => line.trimEnd())
        .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
        .join('\n')
        .trim();
}

function extractHtmlBody(html = '') {
    const source = String(html || '').trim();
    if (!source) {
        return { body: '', head: '' };
    }

    const headMatch = source.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

    return {
        head: headMatch ? headMatch[1].trim() : '',
        body: bodyMatch ? bodyMatch[1].trim() : source,
    };
}

function findLikelyHtmlStartIndex(text = '') {
    const match = String(text || '').match(
        /```html\b|<!doctype html>|<html\b|<body\b|<main\b|<article\b|<section\b|<header\b|<footer\b|<nav\b|<aside\b|<figure\b|<table\b|<div\b|<h1\b|<h2\b|<h3\b|<ul\b|<ol\b|<p\b/i,
    );

    return match && Number.isInteger(match.index) ? match.index : -1;
}

function findHtmlFence(source = '') {
    const fencePattern = /```([a-z0-9_-]*)\s*([\s\S]*?)```/ig;
    let match;

    while ((match = fencePattern.exec(String(source || ''))) !== null) {
        const language = String(match[1] || '').trim().toLowerCase();
        const content = String(match[2] || '').trim();

        if (language === 'html' || (!language && findLikelyHtmlStartIndex(content) === 0)) {
            return {
                fullMatch: match[0],
                content,
            };
        }
    }

    return null;
}

function extractCompositeDocumentParts(input = '') {
    let source = String(input || '').replace(/\r\n?/g, '\n').trim();
    if (!source) {
        return { mermaidSource: '', bodyContent: '', headContent: '' };
    }

    let bodyContent = '';
    let headContent = '';
    let preserveSourceText = true;

    const htmlFence = findHtmlFence(source);
    if (htmlFence) {
        source = source.replace(htmlFence.fullMatch, '').trim();
        const htmlParts = extractHtmlBody(htmlFence.content);
        bodyContent = htmlParts.body;
        headContent = htmlParts.head;
        preserveSourceText = false;
    } else {
        const htmlStart = findLikelyHtmlStartIndex(source);
        if (htmlStart >= 0) {
            const htmlParts = extractHtmlBody(source.slice(htmlStart));
            source = source.slice(0, htmlStart).trim();
            bodyContent = htmlParts.body;
            headContent = htmlParts.head;
            preserveSourceText = false;
        }
    }

    let mermaidSource = '';
    const mermaidFence = source.match(/```mermaid\s*([\s\S]*?)```/i);
    if (mermaidFence) {
        mermaidSource = normalizeMermaidSource(mermaidFence[1]);
        source = source.replace(mermaidFence[0], '').trim();
    } else if (detectMermaidDiagramType(source) !== 'unknown') {
        const htmlStart = source.search(/```html\b|<!doctype html>|<html\b|<body\b|<main\b|<article\b|<section\b|<header\b|<footer\b|<nav\b|<aside\b|<figure\b|<table\b|<div\b|<h1\b|<h2\b|<h3\b|<ul\b|<ol\b|<p\b|^#\s|^\d+\.\s|\n#\s|\n\d+\.\s/m);
        const mermaidCandidate = htmlStart > 0 ? source.slice(0, htmlStart).trim() : source;
        const normalizedMermaid = normalizeMermaidSource(mermaidCandidate);
        if (detectMermaidDiagramType(normalizedMermaid) !== 'unknown') {
            mermaidSource = normalizedMermaid;
            source = htmlStart > 0 ? source.slice(htmlStart).trim() : '';
        }
    }

    if (!bodyContent) {
        bodyContent = source.trim();
    } else if (preserveSourceText && source.trim()) {
        bodyContent = `${source.trim()}\n\n${bodyContent}`.trim();
    }

    return { mermaidSource, bodyContent, headContent };
}

function renderBodyMarkup(content = '') {
    const trimmed = String(content || '').trim();
    if (!trimmed) {
        return '';
    }

    if (/<[a-z][\s\S]*>/i.test(trimmed)) {
        return trimmed;
    }

    return trimmed
        .split(/\n{2,}/)
        .map((block) => {
            const normalized = block.trim();
            if (!normalized) {
                return '';
            }
            return `<p>${escapeHtml(normalized).replace(/\n/g, '<br>')}</p>`;
        })
        .filter(Boolean)
        .join('\n');
}

function buildMermaidMarkup(mermaidSource = '') {
    if (!mermaidSource) {
        return '';
    }

    return `
<section class="mermaid-section">
  <div class="mermaid-frame">
    <div class="mermaid">${escapeHtml(mermaidSource)}</div>
  </div>
</section>`;
}

function ensureHtmlDocument(bodyHtml, title = 'Document') {
    const { mermaidSource, bodyContent, headContent } = extractCompositeDocumentParts(bodyHtml);
    const content = renderBodyMarkup(bodyContent);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeXml(title)}</title>
<style ${GENERATED_ARTIFACT_STYLE_MARKER}>
${GENERATED_ARTIFACT_BASE_CSS}
code { background: #eef2f7; padding: 2px 4px; border-radius: 5px; }
.mermaid-section { margin: 0 0 24px; }
.mermaid-frame { border: 1px solid #d1d5db; border-radius: 12px; padding: 16px; background: #ffffff; }
.mermaid { text-align: center; }
.mermaid svg { max-width: 100%; height: auto; }
</style>
${headContent}
${mermaidSource ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>' : ''}
${mermaidSource ? `<script>
window.addEventListener('load', async () => {
  if (!window.mermaid) return;
  try {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    const nodes = document.querySelectorAll('.mermaid');
    if (nodes.length) {
      await window.mermaid.run({ nodes });
    }
  } catch (error) {
    console.error('Mermaid render failed:', error);
  }
});
</script>` : ''}
</head>
<body>
${buildMermaidMarkup(mermaidSource)}
${content}
</body>
</html>`;
}

function hasSubstantiveCss(html = '') {
    const source = String(html || '');
    const styleBlocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/ig)]
        .map((match) => String(match?.[1] || '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
        .filter(Boolean);
    const hasMeaningfulStyleBlock = styleBlocks.some((css) => css.replace(/\s+/g, '').length >= 80);
    const hasInlineStyle = /\sstyle=["'][^"']{12,}["']/i.test(source);
    const hasStylesheetLink = /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/i.test(source);

    return hasMeaningfulStyleBlock || hasInlineStyle || hasStylesheetLink;
}

function injectHtmlStyleSafetyNet(html = '') {
    const source = String(html || '');
    if (!source || hasSubstantiveCss(source) || source.includes(GENERATED_ARTIFACT_STYLE_MARKER)) {
        return source;
    }

    const styleTag = `<style ${GENERATED_ARTIFACT_STYLE_MARKER}>\n${GENERATED_ARTIFACT_BASE_CSS}\n</style>`;
    if (/<\/head>/i.test(source)) {
        return source.replace(/<\/head>/i, `${styleTag}\n</head>`);
    }
    if (/<html[^>]*>/i.test(source)) {
        return source.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${styleTag}\n</head>`);
    }
    return `${styleTag}\n${source}`;
}

function getInternalArtifactBaseUrl() {
    const configured = String(process.env.API_BASE_URL || '').trim();
    if (configured) {
        try {
            return new URL(configured).toString().replace(/\/+$/, '');
        } catch (_error) {
            // Fall through to the runtime-local url if API_BASE_URL is invalid.
        }
    }

    return `http://127.0.0.1:${config.port || 3000}`;
}

function injectArtifactBaseForPdf(html = '') {
    const source = String(html || '');
    if (!/\/api\/artifacts\/.+\/download\b/i.test(source) || /<base\b/i.test(source)) {
        return source;
    }

    const baseTag = `<base href="${escapeXml(`${getInternalArtifactBaseUrl()}/`)}">`;
    if (/<head[^>]*>/i.test(source)) {
        return source.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`);
    }

    return `${baseTag}\n${source}`;
}

function extractInternalArtifactIdFromUrl(url = '') {
    const normalized = String(url || '').trim();
    const match = normalized.match(/^(?:https?:\/\/[^/]+)?\/api\/artifacts\/([^/?#]+)\/download\b/i);
    return match?.[1] ? match[1].trim() : null;
}

async function inlineInternalArtifactImagesForPdf(html = '') {
    const source = String(html || '');
    const imgSrcPattern = /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/ig;
    const matches = [...source.matchAll(imgSrcPattern)];
    if (matches.length === 0) {
        return source;
    }

    const replacements = new Map();
    for (const match of matches) {
        const originalUrl = match?.[2] || '';
        const artifactId = extractInternalArtifactIdFromUrl(originalUrl);
        if (!artifactId || replacements.has(originalUrl)) {
            continue;
        }

        try {
            const artifact = await artifactStore.get(artifactId, { includeContent: true });
            if (!artifact?.contentBuffer || !String(artifact.mimeType || '').startsWith('image/')) {
                continue;
            }

            replacements.set(
                originalUrl,
                `data:${artifact.mimeType};base64,${artifact.contentBuffer.toString('base64')}`,
            );
        } catch (error) {
            console.warn('[Artifacts] Failed to inline internal artifact image for PDF:', error.message);
        }
    }

    if (replacements.size === 0) {
        return source;
    }

    return source.replace(imgSrcPattern, (fullMatch, prefix, url, suffix) => {
        return `${prefix}${replacements.get(url) || url}${suffix}`;
    });
}

async function inlineExternalImagesForPdf(html = '') {
    const source = String(html || '');
    const imgSrcPattern = /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/ig;
    const matches = [...source.matchAll(imgSrcPattern)];
    if (matches.length === 0 || typeof fetch !== 'function') {
        return source;
    }

    const replacements = new Map();
    for (const match of matches) {
        const originalUrl = String(match?.[2] || '').trim();
        if (!/^https?:\/\//i.test(originalUrl) || replacements.has(originalUrl)) {
            continue;
        }

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), 15000) : null;

        try {
            const response = await fetch(originalUrl, {
                method: 'GET',
                signal: controller?.signal,
                headers: {
                    Accept: 'image/*',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
            if (!contentType.startsWith('image/')) {
                throw new Error(`Unexpected content-type: ${contentType || 'unknown'}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            replacements.set(
                originalUrl,
                `data:${contentType.split(';')[0].trim()};base64,${Buffer.from(arrayBuffer).toString('base64')}`,
            );
        } catch (error) {
            console.warn('[Artifacts] Failed to inline external image for PDF:', error.message);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    if (replacements.size === 0) {
        return source;
    }

    return source.replace(imgSrcPattern, (fullMatch, prefix, url, suffix) => {
        return `${prefix}${replacements.get(url) || url}${suffix}`;
    });
}

async function inlineRenderableImagesForPdf(html = '') {
    const withInternalImages = await inlineInternalArtifactImagesForPdf(html);
    return inlineExternalImagesForPdf(withInternalImages);
}

function buildPdfBufferFromText(text, title = 'Document') {
    const lines = normalizeWhitespace(text || '').split('\n');
    const safeLines = lines.length > 0 ? lines : [''];
    let y = 760;
    const commands = ['BT', '/F1 11 Tf'];

    for (const line of safeLines.slice(0, 120)) {
        const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        commands.push(`1 0 0 1 50 ${y} Tm (${escaped.slice(0, 120)}) Tj`);
        y -= 14;
        if (y < 60) break;
    }

    commands.push('ET');
    const contentStream = Buffer.from(commands.join('\n'), 'utf8');
    const objects = [];
    const offsets = [0];

    function addObject(body) {
        const objectNumber = objects.length + 1;
        const rendered = `${objectNumber} 0 obj\n${body}\nendobj\n`;
        objects.push(rendered);
        return objectNumber;
    }

    const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const contentId = addObject(`<< /Length ${contentStream.length} >>\nstream\n${contentStream.toString('binary')}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const pagesId = addObject(`<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
    const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const infoId = addObject(`<< /Title (${title.replace(/[()]/g, '')}) >>`);

    let output = '%PDF-1.4\n';
    for (const object of objects) {
        offsets.push(Buffer.byteLength(output, 'binary'));
        output += object;
    }

    const xrefOffset = Buffer.byteLength(output, 'binary');
    output += `xref\n0 ${objects.length + 1}\n`;
    output += '0000000000 65535 f \n';
    for (let index = 1; index <= objects.length; index += 1) {
        output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    }
    output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(output, 'binary');
}

function decodeHtmlEntities(text = '') {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code) || 32))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16) || 32));
}

function extractPdfMakeBlocksFromHtml(html = '', fallbackTitle = 'Document') {
    const source = String(html || '');
    const body = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source;
    const blocks = [];
    const pattern = /<(h1|h2|h3|p|li|figcaption|blockquote)[^>]*>([\s\S]*?)<\/\1>/ig;
    let match;

    while ((match = pattern.exec(body)) !== null) {
        const tag = String(match[1] || '').toLowerCase();
        const text = decodeHtmlEntities(stripHtml(match[2] || ''))
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) {
            continue;
        }

        if (tag === 'h1') {
            blocks.push({ text, style: 'title', margin: [0, 0, 0, 12] });
        } else if (tag === 'h2') {
            blocks.push({ text, style: 'heading', margin: [0, 18, 0, 8] });
        } else if (tag === 'h3') {
            blocks.push({ text, style: 'subheading', margin: [0, 12, 0, 6] });
        } else if (tag === 'li') {
            blocks.push({ text: `- ${text}`, style: 'body', margin: [12, 0, 0, 6] });
        } else if (tag === 'figcaption') {
            blocks.push({ text, style: 'caption', margin: [0, 2, 0, 10] });
        } else if (tag === 'blockquote') {
            blocks.push({ text, style: 'quote', margin: [0, 8, 0, 10] });
        } else {
            blocks.push({ text, style: 'body', margin: [0, 0, 0, 9] });
        }
    }

    if (blocks.length === 0) {
        const text = decodeHtmlEntities(stripHtml(source)).replace(/\s+/g, ' ').trim();
        blocks.push(
            { text: fallbackTitle, style: 'title', margin: [0, 0, 0, 12] },
            { text: text || 'No content provided.', style: 'body' },
        );
    }

    return blocks.slice(0, 180);
}

async function buildStyledPdfBufferFromHtml(html = '', title = 'Document') {
    try {
        const pdfMake = require('pdfmake/build/pdfmake');
        pdfMake.vfs = require('pdfmake/build/vfs_fonts');
        const blocks = extractPdfMakeBlocksFromHtml(html, title);
        const hasTitle = blocks.some((block) => block.style === 'title');
        const content = [
            {
                canvas: [
                    { type: 'rect', x: 0, y: 0, w: 512, h: 56, r: 8, color: '#eef3f8' },
                    { type: 'rect', x: 0, y: 56, w: 512, h: 2, color: '#2563eb' },
                ],
                margin: [0, 0, 0, 14],
            },
            ...(hasTitle ? [] : [{ text: title, style: 'title', margin: [0, 0, 0, 12] }]),
            ...blocks,
        ];
        const definition = {
            pageSize: 'LETTER',
            pageMargins: [42, 54, 42, 48],
            defaultStyle: {
                font: 'Roboto',
                fontSize: 10.5,
                lineHeight: 1.25,
                color: '#172033',
            },
            content,
            styles: {
                title: { fontSize: 28, bold: true, color: '#0f172a', lineHeight: 0.95 },
                heading: { fontSize: 18, bold: true, color: '#0f172a' },
                subheading: { fontSize: 13, bold: true, color: '#172033' },
                body: { fontSize: 10.5, color: '#334155' },
                caption: { fontSize: 8, italics: true, color: '#64748b' },
                quote: { fontSize: 11, italics: true, color: '#334155' },
            },
            footer(currentPage, pageCount) {
                return {
                    columns: [
                        { text: title, color: '#64748b', fontSize: 8 },
                        { text: `${currentPage} / ${pageCount}`, alignment: 'right', color: '#64748b', fontSize: 8 },
                    ],
                    margin: [42, 0, 42, 0],
                };
            },
        };

        return await new Promise((resolve, reject) => {
            pdfMake.createPdf(definition).getBuffer((buffer) => {
                if (!buffer) {
                    reject(new Error('pdfmake returned an empty buffer'));
                    return;
                }
                resolve(Buffer.from(buffer));
            });
        });
    } catch (error) {
        console.warn('[Artifacts] Styled PDF fallback failed:', error.message);
        return null;
    }
}

function columnName(index) {
    let value = '';
    let current = index + 1;
    while (current > 0) {
        const remainder = (current - 1) % 26;
        value = String.fromCharCode(65 + remainder) + value;
        current = Math.floor((current - remainder) / 26);
    }
    return value;
}

function buildXlsxBufferFromWorkbookSpec(spec = {}) {
    const sheets = Array.isArray(spec.sheets) && spec.sheets.length > 0
        ? spec.sheets
        : [{ name: spec.title || 'Sheet1', rows: [['Output'], [spec.text || '']] }];

    const sharedStrings = [];
    const sharedStringIndex = new Map();
    const sheetEntries = [];

    function getSharedStringId(value) {
        const stringValue = String(value);
        if (!sharedStringIndex.has(stringValue)) {
            sharedStringIndex.set(stringValue, sharedStrings.length);
            sharedStrings.push(stringValue);
        }
        return sharedStringIndex.get(stringValue);
    }

    sheets.forEach((sheet, sheetIndex) => {
        const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
        const rowXml = rows.map((row, rowIndex) => {
            const cells = (Array.isArray(row) ? row : [row]).map((cell, cellIndex) => {
                if (typeof cell === 'number' && Number.isFinite(cell)) {
                    return `<c r="${columnName(cellIndex)}${rowIndex + 1}"><v>${cell}</v></c>`;
                }
                const stringId = getSharedStringId(cell == null ? '' : cell);
                return `<c r="${columnName(cellIndex)}${rowIndex + 1}" t="s"><v>${stringId}</v></c>`;
            }).join('');
            return `<row r="${rowIndex + 1}">${cells}</row>`;
        }).join('');

        sheetEntries.push({
            name: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`,
        });
    });

    const workbookSheets = sheets.map((sheet, index) => `
    <sheet name="${escapeXml(sheet.name || `Sheet${index + 1}`)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');

    const workbookRels = sheets.map((sheet, index) => `
  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');

    const contentOverrides = sheets.map((sheet, index) => `
  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

    const entries = [
        {
            name: '[Content_Types].xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>${contentOverrides}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
        },
        {
            name: '_rels/.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
        },
        {
            name: 'docProps/core.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(spec.title || 'Workbook')}</dc:title>
  <dc:creator>LillyBuilt</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`,
        },
        {
            name: 'docProps/app.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>LillyBuilt</Application>
</Properties>`,
        },
        {
            name: 'xl/workbook.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${workbookSheets}
  </sheets>
</workbook>`,
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
        },
        {
            name: 'xl/sharedStrings.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('')}</sst>`,
        },
        ...sheetEntries,
    ];

    return createZip(entries);
}

function buildWorkbookSpecFromText(text, title = 'Workbook') {
    const lines = normalizeWhitespace(text).split('\n').filter(Boolean);
    const rows = lines.map((line) => line.split('|').map((cell) => cell.trim())).filter((row) => row.length > 0);
    return {
        title,
        sheets: [
            {
                name: 'Sheet1',
                rows: rows.length > 0 ? rows : [['Output'], [text]],
            },
        ],
    };
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function resolveBrowserPath() {
    for (const candidate of getBrowserCandidates()) {
        if (!candidate) continue;
        if (candidate.includes(path.sep)) {
            if (await fileExists(candidate)) {
                return candidate;
            }
            continue;
        }
        return candidate;
    }
    return null;
}

function getBrowserArgs(outputPath, inputPath, html = '') {
    const extraArgs = splitArgs(config.artifacts.browserArgs);
    const htmlSource = String(html || '');
    const imageCount = (htmlSource.match(/<img\b/ig) || []).length;
    const pageOptions = inferPdfPageOptionsFromHtml(htmlSource);
    let virtualTimeBudget = 5000;
    if (/class="mermaid"|cdn\.jsdelivr\.net\/npm\/mermaid/i.test(htmlSource)) {
        virtualTimeBudget = Math.max(virtualTimeBudget, 10000);
    }
    if (imageCount > 0) {
        virtualTimeBudget = Math.max(virtualTimeBudget, Math.min(20000, 8000 + (imageCount * 1000)));
    }
    return [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--allow-file-access-from-files',
        '--disable-dev-shm-usage',
        '--run-all-compositor-stages-before-draw',
        `--virtual-time-budget=${virtualTimeBudget}`,
        '--no-pdf-header-footer',
        ...(pageOptions.landscape ? ['--landscape'] : []),
        `--print-to-pdf=${outputPath}`,
        ...extraArgs,
        pathToFileURL(inputPath).href,
    ];
}

function inferPdfPageOptionsFromHtml(html = '') {
    const source = String(html || '');
    const normalized = source.toLowerCase();
    const explicitPortrait = /@page[^{}]*\{[^}]*\b(?:size\s*:\s*)?(?:a4|letter)?\s*portrait\b/i.test(source);
    if (explicitPortrait) {
        return {
            printBackground: true,
            preferCSSPageSize: true,
        };
    }

    const explicitLandscape = /@page[^{}]*\{[^}]*\blandscape\b/i.test(source);
    const slideLike = explicitLandscape
        || /\b(presentation-deck|deck-slide|slide-track|slide-deck|widescreen)\b/i.test(source)
        || /aspect-ratio\s*:\s*(?:16\s*\/\s*9|1\.77[0-9]*)/i.test(source)
        || /data-(?:layout|format|aspect|document-type)=["'][^"']*(?:slide|deck|widescreen|16:9|16\/9)/i.test(source)
        || normalized.includes('website slides');

    if (!slideLike) {
        return {
            printBackground: true,
            preferCSSPageSize: true,
        };
    }

    return {
        printBackground: true,
        preferCSSPageSize: true,
        landscape: true,
        width: '13.333in',
        height: '7.5in',
    };
}

function buildPdfRuntimeStyleOverrides(pageOptions = {}) {
    if (!pageOptions?.landscape) {
        return '';
    }

    return `
        @page { size: 13.333in 7.5in landscape; margin: 0; }
        html, body { width: 13.333in; min-height: 7.5in; overflow: visible !important; }
        *, *::before, *::after { box-sizing: border-box; }
        .presentation-deck { width: 13.333in; padding: 0 !important; }
        .deck-meta, .deck-footer { display: none !important; }
        .deck-track { max-width: none !important; width: 100% !important; gap: 0 !important; }
        .deck-slide {
            width: 13.333in !important;
            min-height: 7.5in !important;
            height: auto !important;
            margin: 0 !important;
            border-radius: 0 !important;
            break-after: page;
            page-break-after: always;
            overflow: hidden;
        }
        .deck-slide:last-child { break-after: auto; page-break-after: auto; }
    `;
}

async function renderPdfViaPlaywright(htmlPath, pdfPath, browserPath = null, options = {}) {
    const loaded = loadPlaywrightPackage();
    if (!loaded) {
        return null;
    }

    if (loaded.moduleName === 'playwright-core' && !browserPath) {
        return null;
    }

    const timeout = Math.max(1000, Number(config.artifacts.pdfTimeoutMs) || 15000);
    const pageOptions = inferPdfPageOptionsFromHtml(options.html || '');
    const launchOptions = {
        headless: true,
        timeout,
        args: [...PLAYWRIGHT_BROWSER_ARGS, ...splitArgs(config.artifacts.browserArgs)],
    };

    if (browserPath) {
        launchOptions.executablePath = browserPath;
    }

    const browser = await loaded.chromium.launch(launchOptions);
    let context;
    let page;

    try {
        context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: pageOptions.landscape
                ? { width: 1280, height: 720 }
                : { width: 1440, height: 960 },
        });
        page = await context.newPage();
        await page.goto(pathToFileURL(htmlPath).href, {
            waitUntil: 'domcontentloaded',
            timeout,
        });
        await page.emulateMedia({ media: 'screen' });
        await page.waitForLoadState('load', {
            timeout: Math.min(timeout, 5000),
        }).catch(() => {});
        await page.waitForLoadState('networkidle', {
            timeout: Math.min(timeout, 5000),
        }).catch(() => {});
        await page.waitForTimeout(250);
        const runtimeCss = buildPdfRuntimeStyleOverrides(pageOptions);
        if (runtimeCss) {
            await page.addStyleTag({ content: runtimeCss }).catch(() => {});
        }

        return await page.pdf({
            path: pdfPath,
            ...pageOptions,
        });
    } finally {
        await page?.close().catch(() => {});
        await context?.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

async function renderPdfViaBrowser(html, title) {
    const browserPath = await resolveBrowserPath();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lillybuilt-pdf-'));
    const baseName = createFriendlyFilenameBase(title || 'document', 'document');
    const htmlPath = path.join(tempDir, `${baseName}.html`);
    const pdfPath = path.join(tempDir, `${baseName}.pdf`);

    try {
        const resolvedHtml = await inlineRenderableImagesForPdf(html);
        const pdfHtml = injectArtifactBaseForPdf(resolvedHtml);
        await fs.writeFile(htmlPath, pdfHtml, 'utf8');
        const playwrightBuffer = await renderPdfViaPlaywright(htmlPath, pdfPath, browserPath, { html: pdfHtml })
            .catch((error) => {
                console.warn('[Artifacts] Playwright PDF rendering failed:', error.message);
                return writePdfRenderCrashLog({
                    stage: 'playwright',
                    error,
                    title,
                    browserPath,
                    htmlPath,
                    pdfPath,
                    html: pdfHtml,
                }).then(() => null);
            });
        if (playwrightBuffer) {
            return Buffer.from(playwrightBuffer);
        }
        if (!browserPath) {
            return null;
        }
        try {
            await execFileAsync(browserPath, getBrowserArgs(pdfPath, htmlPath, pdfHtml), {
                timeout: config.artifacts.pdfTimeoutMs,
                windowsHide: true,
            });
        } catch (error) {
            console.warn('[Artifacts] Browser PDF command failed:', error.message);
            await writePdfRenderCrashLog({
                stage: 'browser-command',
                error,
                title,
                browserPath,
                htmlPath,
                pdfPath,
                html: pdfHtml,
            });
            return null;
        }
        const buffer = await fs.readFile(pdfPath);
        return buffer;
    } catch (error) {
        console.warn('[Artifacts] Browser PDF rendering failed:', error.message);
        await writePdfRenderCrashLog({
            stage: 'browser-pipeline',
            error,
            title,
            browserPath,
            htmlPath,
            pdfPath,
        });
        return null;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function renderArtifact({ format, content, title = 'artifact', workbookSpec = null }) {
    const normalizedFormat = normalizeFormat(format);
    const extension = FORMAT_EXTENSIONS[normalizedFormat] || '.txt';
    const mimeType = FORMAT_MIME_TYPES[normalizedFormat] || 'application/octet-stream';
    const filename = createUniqueFilename(title, extension, 'artifact');

    if (normalizedFormat === 'html') {
        const html = injectHtmlStyleSafetyNet(ensureHtmlDocument(content, title));
        return {
            filename,
            format: 'html',
            mimeType,
            buffer: Buffer.from(html, 'utf8'),
            previewHtml: html,
            extractedText: stripHtml(html),
            metadata: { title },
        };
    }

    if (normalizedFormat === 'pdf') {
        const html = injectHtmlStyleSafetyNet(ensureHtmlDocument(content, title));
        const text = stripHtml(html);
        const browserBuffer = await renderPdfViaBrowser(html, title);
        const styledFallbackBuffer = browserBuffer ? null : await buildStyledPdfBufferFromHtml(html, title);
        return {
            filename,
            format: 'pdf',
            mimeType,
            buffer: browserBuffer || styledFallbackBuffer || buildPdfBufferFromText(text, title),
            previewHtml: html,
            extractedText: text,
            metadata: {
                title,
                sourceHtml: html,
                renderEngine: browserBuffer ? 'browser' : (styledFallbackBuffer ? 'pdfmake' : 'basic'),
            },
        };
    }

    if (normalizedFormat === 'xlsx') {
        const spec = workbookSpec || buildWorkbookSpecFromText(content, title);
        const text = spec.sheets.map((sheet) => `[${sheet.name}]\n${(sheet.rows || []).map((row) => row.join(' | ')).join('\n')}`).join('\n\n');
        return {
            filename,
            format: 'xlsx',
            mimeType,
            buffer: buildXlsxBufferFromWorkbookSpec(spec),
            previewHtml: `<pre>${escapeHtml(text)}</pre>`,
            extractedText: text,
            metadata: { title: spec.title || title, sheets: (spec.sheets || []).map((sheet) => sheet.name) },
        };
    }

    const textContent = String(content || '');
    const normalizedTextContent = normalizedFormat === 'mermaid'
        ? normalizeMermaidSource(textContent)
        : textContent;
    return {
        filename,
        format: normalizedFormat,
        mimeType,
        buffer: Buffer.from(normalizedTextContent, 'utf8'),
        previewHtml: normalizedFormat === 'xml' || normalizedFormat === 'mermaid' || normalizedFormat === 'power-query'
            ? `<pre>${escapeHtml(normalizedTextContent)}</pre>`
            : '',
        extractedText: normalizedTextContent,
        metadata: { title },
    };
}

module.exports = {
    buildStyledPdfBufferFromHtml,
    buildXlsxBufferFromWorkbookSpec,
    ensureHtmlDocument,
    extractCompositeDocumentParts,
    hasSubstantiveCss,
    injectHtmlStyleSafetyNet,
    inferPdfPageOptionsFromHtml,
    inlineExternalImagesForPdf,
    inlineRenderableImagesForPdf,
    inlineInternalArtifactImagesForPdf,
    normalizeMermaidSource,
    renderArtifact,
    renderPdfViaBrowser,
};
