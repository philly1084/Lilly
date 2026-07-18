const { Router } = require('express');
const { createHash } = require('crypto');
const path = require('path').posix;
const { TextDecoder } = require('util');
const { sessionStore } = require('../session-store');
const { artifactService } = require('../artifacts/artifact-service');
const { parseMultipartRequest } = require('../utils/multipart');
const { validate } = require('../middleware/validate');
const { ensureRuntimeToolManager } = require('../runtime-tool-manager');
const {
    getLocalGeneratedAudioArtifact,
    isLocalGeneratedAudioArtifactId,
} = require('../generated-audio-artifacts');
const {
    getLocalGeneratedVideoArtifact,
    isLocalGeneratedVideoArtifactId,
} = require('../generated-video-artifacts');
const {
    buildFrontendBundlePreviewUrl,
    createFrontendBundleArchive,
    getArtifactFrontendBundle,
    getFrontendBundleFile,
    hasFrontendBundleArchive,
    hasExplicitFrontendBundle,
    injectBundleBaseHref,
    normalizeBundlePath,
    readFrontendBundleArchive,
    resolveArtifactFrontendBundleFile,
    resolveFrontendBundleContentType,
    rewriteRootRelativeFrontendPaths,
} = require('../frontend-bundles');
const {
    buildScopedSessionMetadata,
    resolveClientSurface,
    resolveSessionScope,
    sessionMatchesScope,
} = require('../session-scope');
const { rehydrateHtml, rehydrateText, resolvePiiPolicy } = require('../pii');
const { validateResultArtifactSet } = require('../artifacts/artifact-quality-gate');

const router = Router();
const ARTIFACT_ATTACH_MAX_BYTES = 4 * 1024 * 1024;
const artifactAttachInFlight = new Map();
const UNSUPPORTED_MANAGED_APP_BINARY_ASSET_EXTENSIONS = new Set([
    '.avif',
    '.bin',
    '.bmp',
    '.eot',
    '.gif',
    '.glb',
    '.ico',
    '.jpeg',
    '.jpg',
    '.mp3',
    '.mp4',
    '.ogg',
    '.otf',
    '.pdf',
    '.png',
    '.ttf',
    '.wasm',
    '.wav',
    '.webm',
    '.webp',
    '.woff',
    '.woff2',
    '.zip',
]);

function applyPreviewResponseHeaders(res) {
    removeFrameBlockingHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Generated previews are commonly embedded in sandboxed iframes, which
    // appear cross-origin to the browser and would otherwise trip Helmet's
    // default CORP protection for same-origin assets.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Origin-Agent-Cluster', '?0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=()');
    if (!res.hasHeader('Content-Security-Policy')) {
        res.setHeader(
            'Content-Security-Policy',
            [
                "default-src 'self' data: blob: https:",
                "img-src 'self' data: blob: https:",
                "media-src 'self' data: blob: https:",
                "font-src 'self' data: blob: https:",
                "style-src 'self' 'unsafe-inline' https:",
                "script-src 'self' 'unsafe-inline' https:",
                "connect-src 'self' data: blob: https:",
                "frame-src 'self' data: blob: https:",
                "worker-src 'self' blob:",
                "base-uri 'self'",
                "form-action 'self'",
            ].join('; '),
        );
    }
}

function shouldSuppressUploadedArtifactPreview(req, artifact = {}) {
    if (String(artifact?.direction || '').toLowerCase() !== 'uploaded') {
        return false;
    }

    const piiMetadata = artifact?.metadata?.piiCleansing && typeof artifact.metadata.piiCleansing === 'object'
        ? artifact.metadata.piiCleansing
        : null;
    if (
        artifact?.metadata?.privacyPreviewSuppressed === true
        || piiMetadata?.enabled === true
        || piiMetadata?.uploadPreviewSuppressed === true
    ) {
        return true;
    }

    try {
        return resolvePiiPolicy({
            metadata: {
                ...(artifact.metadata || {}),
                clientSurface: 'web-chat',
            },
            clientSurface: 'web-chat',
            route: req?.path || '/api/artifacts/preview',
        }).enabled === true;
    } catch (_error) {
        return false;
    }
}

function sendSuppressedUploadedArtifactPreview(res) {
    applyPreviewResponseHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Preview hidden</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #172033; background: #f8fafc; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    section { max-width: 520px; border: 1px solid #d8e0ea; background: #ffffff; border-radius: 8px; padding: 22px; box-shadow: 0 16px 42px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.3; }
    p { margin: 0; font-size: 14px; line-height: 1.55; color: #536176; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Preview hidden</h1>
      <p>PII protection is enabled, so uploaded-file previews are not displayed in web chat. The file can still be used as protected context.</p>
    </section>
  </main>
</body>
</html>`);
}

function applySandboxShellHeaders(res) {
    removeFrameBlockingHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Origin-Agent-Cluster', '?0');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=()');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            "frame-src 'self'",
            "img-src data:",
            "base-uri 'none'",
            "form-action 'none'",
        ].join('; '),
    );
}

function removeFrameBlockingHeaders(res) {
    // The preview document is nested inside a sandboxed shell iframe. Helmet's
    // default X-Frame-Options: SAMEORIGIN treats that opaque shell as not
    // same-origin, so the browser refuses to render the inner preview.
    res.removeHeader('X-Frame-Options');
}

function isPdfArtifact(artifact = {}) {
    const extension = String(artifact.extension || artifact.format || '').toLowerCase();
    const mimeType = String(artifact.mimeType || '').toLowerCase();
    const filename = String(artifact.filename || '').toLowerCase();
    return extension === 'pdf' || mimeType.includes('pdf') || filename.endsWith('.pdf');
}

function escapeHtmlAttribute(value = '') {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildSandboxPreviewShell(artifactId = '') {
    return buildTokenizedSandboxPreviewShell(artifactId);
}

function buildArtifactPreviewPath(artifactId = '', previewAccessToken = '', relativePath = '') {
    const encodedId = encodeURIComponent(String(artifactId || '').trim());
    const normalizedPath = String(relativePath || '').trim().replace(/^\/+/, '');
    const token = String(previewAccessToken || '').trim();
    const base = token
        ? `/api/artifacts/${encodedId}/preview-access/${encodeURIComponent(token)}/`
        : `/api/artifacts/${encodedId}/preview/`;
    return normalizedPath ? `${base}${normalizedPath}` : base;
}

function buildTokenizedSandboxPreviewShell(artifactId = '', previewAccessToken = '') {
    const previewSrc = buildArtifactPreviewPath(artifactId, previewAccessToken).replace(/\/$/, '');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandboxed Artifact Preview</title>
<style>
html, body { margin: 0; min-height: 100%; background: #0f172a; color: #e5e7eb; font-family: Arial, sans-serif; }
.sandbox-shell { min-height: 100vh; display: grid; grid-template-rows: minmax(0, 1fr); }
iframe { width: 100%; height: 100vh; border: 0; background: #fff; display: block; }
</style>
</head>
<body>
<main class="sandbox-shell">
  <iframe
    src="${escapeHtmlAttribute(previewSrc)}"
    title="Sandboxed artifact preview"
    loading="eager"
    referrerpolicy="no-referrer"
    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
  ></iframe>
</main>
</body>
</html>`;
}

function appendAccessTokenToUrl(rawUrl = '', previewAccessToken = '') {
    const token = String(previewAccessToken || '').trim();
    const source = String(rawUrl || '').trim();
    if (!token || !source || !source.startsWith('/api/artifacts/')) {
        return rawUrl;
    }

    try {
        const parsed = new URL(source, 'http://localhost');
        if (!/\/api\/artifacts\/[^/]+\/download$/i.test(parsed.pathname)) {
            return rawUrl;
        }
        if (!parsed.searchParams.has('access_token')) {
            parsed.searchParams.set('access_token', token);
        }
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_error) {
        const separator = source.includes('?') ? '&' : '?';
        return `${source}${separator}access_token=${encodeURIComponent(token)}`;
    }
}

function appendAccessTokenToInternalArtifactUrls(content = '', previewAccessToken = '') {
    const token = String(previewAccessToken || '').trim();
    if (!token) {
        return String(content || '');
    }

    return String(content || '')
        .replace(/(\b(?:href|src|action|poster)=["'])(\/api\/artifacts\/[^"']+)(["'])/gi, (_match, prefix, url, suffix) => (
            `${prefix}${appendAccessTokenToUrl(url, token)}${suffix}`
        ))
        .replace(/url\((['"]?)(\/api\/artifacts\/[^'")]+)\1\)/gi, (_match, quote, url) => (
            `url(${quote}${appendAccessTokenToUrl(url, token)}${quote})`
        ));
}

function getRequestOwnerId(req) {
    if (String(req.user?.role || '').trim().toLowerCase() === 'open') {
        return null;
    }
    return String(req.user?.username || '').trim() || null;
}

function canAdminAccessAgentCompanyArtifact(req, session = {}) {
    const role = String(req.user?.role || '').trim().toLowerCase();
    const clientSurface = String(session?.metadata?.clientSurface || '').trim().toLowerCase();
    return role === 'admin' && clientSurface === 'agent-company';
}

async function rehydratePreviewBuffer(buffer, artifact, req, {
    contentType = '',
    path: previewPath = '',
    metadata = {},
} = {}) {
    const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const type = String(contentType || '').toLowerCase();
    const filename = String(previewPath || artifact?.filename || '').toLowerCase();
    const looksHtml = type.includes('text/html') || /\.(?:html?)$/i.test(filename);
    const looksText = !looksHtml && (type.startsWith('text/') || /\.(?:txt|md|markdown|csv|json)$/i.test(filename));
    if (!looksHtml && !looksText) {
        return source;
    }
    const options = {
        sessionId: artifact?.sessionId || artifact?.session_id || '',
        ownerId: getRequestOwnerId(req),
        metadata: {
            ...(artifact?.metadata || {}),
            ...(metadata || {}),
        },
        clientSurface: 'artifact-preview',
        route: '/api/artifacts/:id/preview',
        highlight: true,
    };
    try {
        if (looksHtml) {
            const result = await rehydrateHtml(source.toString('utf8'), options);
            return Buffer.from(result.html, 'utf8');
        }
        const result = await rehydrateText(source.toString('utf8'), options);
        return Buffer.from(result.text, 'utf8');
    } catch (error) {
        console.warn(`[Artifacts] Failed to rehydrate preview for ${artifact?.id || 'artifact'}: ${error.message}`);
        return source;
    }
}

function isManagedAppTextSource(contentType = '', sourcePath = '') {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const filename = String(sourcePath || '').trim().toLowerCase();
    return type.startsWith('text/')
        || /(?:json|javascript|xml|svg\+xml|yaml)/i.test(type)
        || /\.(?:css|csv|html?|js|json|jsx|md|markdown|mjs|svg|ts|tsx|txt|xml|yaml|yml)$/i.test(filename);
}

function hasManagedAppPiiPlaceholder(value = '') {
    return /\[\[PII:[^\]\r\n]+\]\]/i.test(String(value || ''));
}

function assertManagedAppPiiRestorationComplete(outputText = '') {
    if (hasManagedAppPiiPlaceholder(outputText)) {
        throw new Error('Protected placeholders remain after final-byte restoration.');
    }
}

async function rehydrateManagedAppSourceBuffer(buffer, artifact, req, {
    contentType = '',
    path: sourcePath = '',
    metadata = {},
} = {}) {
    const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const type = String(contentType || '').toLowerCase();
    const filename = String(sourcePath || artifact?.filename || '').toLowerCase();
    const looksHtml = type.includes('text/html') || /\.(?:html?)$/i.test(filename);
    if (!looksHtml && !isManagedAppTextSource(type, filename)) {
        return source;
    }

    const options = {
        sessionId: artifact?.sessionId || artifact?.session_id || '',
        ownerId: getRequestOwnerId(req),
        metadata: {
            ...(artifact?.metadata || {}),
            ...(metadata || {}),
        },
        clientSurface: 'managed-app-promotion',
        route: '/api/artifacts/:id/managed-app',
        highlight: false,
        escapeValues: true,
    };
    if (looksHtml) {
        const sourceText = source.toString('utf8');
        const result = await rehydrateHtml(sourceText, options);
        if (!result || typeof result.html !== 'string') {
            throw new Error('PII HTML restoration returned invalid content.');
        }
        assertManagedAppPiiRestorationComplete(result.html);
        return Buffer.from(result.html, 'utf8');
    }

    const sourceText = source.toString('utf8');
    if (hasManagedAppPiiPlaceholder(sourceText)) {
        throw new Error('Protected placeholders cannot be restored safely into a non-HTML deployment file.');
    }
    const result = await rehydrateText(sourceText, options);
    if (!result || typeof result.text !== 'string') {
        throw new Error('PII text restoration returned invalid content.');
    }
    if (Array.isArray(result.restorations) && result.restorations.length > 0) {
        throw new Error('Protected values cannot be restored safely into a non-HTML deployment file.');
    }
    assertManagedAppPiiRestorationComplete(result.text);
    return Buffer.from(result.text, 'utf8');
}

async function getOwnedArtifact(req, artifactId, options = {}) {
    if (isLocalGeneratedAudioArtifactId(artifactId)) {
        const localArtifact = await getLocalGeneratedAudioArtifact(artifactId, options);
        if (!localArtifact) {
            return null;
        }

        const session = await sessionStore.getOwned(localArtifact.sessionId, getRequestOwnerId(req));
        return session ? localArtifact : null;
    }

    if (isLocalGeneratedVideoArtifactId(artifactId)) {
        const localArtifact = await getLocalGeneratedVideoArtifact(artifactId, options);
        if (!localArtifact) {
            return null;
        }

        const session = await sessionStore.getOwned(localArtifact.sessionId, getRequestOwnerId(req));
        return session ? localArtifact : null;
    }

    const artifact = await artifactService.getArtifact(artifactId, options);
    if (!artifact) {
        return null;
    }

    const session = await sessionStore.getOwned(artifact.sessionId, getRequestOwnerId(req));
    if (session) {
        return artifact;
    }

    // Agent Company runs under its own system-owned session. Its deliverables
    // are intentionally listed in the Admin workspace, so let the signed-in
    // administrator fetch only those explicitly marked shared company files.
    const sharedSession = await sessionStore.get(artifact.sessionId);
    return canAdminAccessAgentCompanyArtifact(req, sharedSession) ? artifact : null;
}

function normalizeArtifactAttachFormat(artifact = {}) {
    const explicit = String(artifact.extension || artifact.format || '').trim().toLowerCase().replace(/^\./, '');
    if (explicit) {
        return explicit;
    }
    return path.extname(String(artifact.filename || '').trim()).replace(/^\./, '').toLowerCase();
}

function buildArtifactAttachImportCapability(artifact = {}, clientSurface = '') {
    const surface = String(clientSurface || '').trim().toLowerCase();
    const format = normalizeArtifactAttachFormat(artifact);
    const notesSurface = surface === 'notes' || surface === 'notes-notion';
    const canvasSurface = surface === 'canvas' || surface === 'canvas-excalidraw';

    if (notesSurface) {
        if (['md', 'markdown', 'txt', 'text'].includes(format)) {
            return {
                surface,
                format,
                disposition: 'direct',
                browserImportAllowed: true,
                fidelity: 'editable-text',
                reason: 'Notes can import this text format into editable blocks.',
            };
        }
        if (['html', 'htm', 'json', 'docx', 'pdf'].includes(format)) {
            return {
                surface,
                format,
                disposition: 'lossy',
                browserImportAllowed: true,
                fidelity: 'converted',
                reason: 'Notes can convert this format, but source layout or structure may not be preserved exactly.',
            };
        }
    }

    if (canvasSurface) {
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(format)) {
            return {
                surface,
                format,
                disposition: 'direct',
                browserImportAllowed: true,
                fidelity: 'visual-object',
                reason: 'Canvas can place this image as a visual object without claiming editable source structure.',
            };
        }
        if (['json', 'drawio', 'csv', 'xls', 'xlsx', 'pdf', 'mm', 'opml'].includes(format)) {
            return {
                surface,
                format,
                disposition: 'lossy',
                browserImportAllowed: true,
                fidelity: 'converted',
                reason: 'Canvas can attempt a validated conversion, but unsupported source details may be omitted.',
            };
        }
    }

    return {
        surface: surface || 'unknown',
        format: format || 'unknown',
        disposition: 'context-only',
        browserImportAllowed: false,
        fidelity: 'source-preserved',
        reason: 'The exact source remains attached for agent context and download; this surface has no honest direct import for the format.',
    };
}

function isArtifactAttachPrivacySuppressed(req, artifact = {}) {
    const piiMetadata = artifact?.metadata?.piiCleansing && typeof artifact.metadata.piiCleansing === 'object'
        ? artifact.metadata.piiCleansing
        : {};
    return artifact?.metadata?.privacyPreviewSuppressed === true
        || piiMetadata.uploadPreviewSuppressed === true
        || shouldSuppressUploadedArtifactPreview(req, artifact);
}

function getArtifactAttachSessionOwnerId(session = null) {
    const metadata = session?.metadata && typeof session.metadata === 'object'
        ? session.metadata
        : {};
    return String(
        metadata.ownerId
        || metadata.userId
        || metadata.username
        || '',
    ).trim();
}

function buildArtifactAttachMetadata(sourceArtifact = {}, targetSession = {}, {
    clientSurface = '',
    mode = '',
    taskType = '',
    sha256 = '',
} = {}) {
    const sourceMetadata = sourceArtifact.metadata && typeof sourceArtifact.metadata === 'object' && !Array.isArray(sourceArtifact.metadata)
        ? sourceArtifact.metadata
        : {};
    const sourceProvenance = sourceMetadata.provenance && typeof sourceMetadata.provenance === 'object' && !Array.isArray(sourceMetadata.provenance)
        ? sourceMetadata.provenance
        : {};
    const createdFromArtifactIds = Array.from(new Set([
        ...(Array.isArray(sourceProvenance.createdFromArtifactIds) ? sourceProvenance.createdFromArtifactIds : []),
        ...(Array.isArray(sourceMetadata.artifactIds) ? sourceMetadata.artifactIds : []),
        sourceArtifact.id,
    ].map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 32);
    const sourceSurface = String(
        sourceProvenance.sourceSurface
        || sourceMetadata.clientSurface
        || sourceArtifact.sourceMode
        || 'artifact-attach',
    ).trim().slice(0, 80);
    const targetSurface = String(clientSurface || mode || taskType || 'artifact-attach').trim().slice(0, 80);

    return {
        ...sourceMetadata,
        lineageVersion: 'ArtifactLineage/v1',
        parentArtifactId: null,
        revision: 1,
        artifactIds: createdFromArtifactIds,
        createdFromArtifactIds,
        handoffSourceArtifactId: sourceArtifact.id,
        handoffSourceSessionId: sourceArtifact.sessionId,
        handoffSourceSha256: sha256,
        handoffTargetSurface: clientSurface,
        handoffAttachedAt: new Date().toISOString(),
        provenance: {
            ...sourceProvenance,
            schemaVersion: 'ArtifactProvenance/v1',
            sourceSurface,
            targetSurface,
            sessionId: targetSession.id,
            sourceSessionId: sourceArtifact.sessionId,
            handoffSourceArtifactId: sourceArtifact.id,
            sourceSha256: sha256,
            createdFromArtifactIds,
            createdAt: new Date().toISOString(),
        },
    };
}

function hasArtifactAttachMarker(artifact = {}, sourceArtifactId = '', sha256 = '') {
    return String(artifact?.direction || '').trim().toLowerCase() === 'attached'
        && String(artifact?.sourceMode || artifact?.source_mode || '').trim().toLowerCase() === 'artifact-attach'
        && String(artifact?.metadata?.handoffSourceArtifactId || '').trim() === sourceArtifactId
        && String(artifact?.metadata?.handoffSourceSha256 || '').trim().toLowerCase() === sha256;
}

async function findVerifiedAttachedArtifact(targetSessionId = '', sourceArtifactId = '', sha256 = '') {
    const artifacts = await artifactService.listSessionArtifacts(targetSessionId, { includeSuppressed: true });
    const candidates = (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => (
        hasArtifactAttachMarker(artifact, sourceArtifactId, sha256)
    ));

    for (const candidate of candidates) {
        const stored = await artifactService.getArtifact(candidate.id, { includeContent: true });
        if (!stored
            || String(stored.sessionId || '').trim() !== targetSessionId
            || !hasArtifactAttachMarker(stored, sourceArtifactId, sha256)
            || stored.contentBuffer == null) {
            continue;
        }

        const storedBuffer = Buffer.isBuffer(stored.contentBuffer)
            ? stored.contentBuffer
            : Buffer.from(stored.contentBuffer);
        const storedSha256 = String(stored.sha256 || '').trim().toLowerCase();
        const computedSha256 = createHash('sha256').update(storedBuffer).digest('hex');
        if (storedSha256 !== sha256 || computedSha256 !== sha256) {
            continue;
        }

        return typeof artifactService.serializeArtifact === 'function'
            ? artifactService.serializeArtifact(stored)
            : stored;
    }

    return null;
}

function isArtifactAttachUniqueConflict(error = null) {
    return String(error?.code || '') === '23505'
        && String(error?.constraint || '') === 'idx_artifacts_attach_handoff_unique';
}

function buildArtifactAttachIdempotencyConflictError() {
    const error = new Error('A conflicting artifact handoff exists, but its stored bytes could not be verified.');
    error.code = 'ARTIFACT_ATTACH_IDEMPOTENCY_CONFLICT';
    error.statusCode = 409;
    return error;
}

async function attachArtifactToSession({
    sourceArtifact,
    targetSession,
    clientSurface,
    mode,
    taskType,
    sha256,
    ownerId,
}) {
    const existing = await findVerifiedAttachedArtifact(targetSession.id, sourceArtifact.id, sha256);
    if (existing) {
        return { artifact: existing, reused: true };
    }

    const metadata = buildArtifactAttachMetadata(sourceArtifact, targetSession, {
        clientSurface,
        mode,
        taskType,
        sha256,
    });
    let stored;
    try {
        stored = await artifactService.createStoredArtifact({
            sessionId: targetSession.id,
            session: targetSession,
            parentArtifactId: null,
            direction: 'attached',
            sourceMode: 'artifact-attach',
            filename: sourceArtifact.filename || `artifact-${sourceArtifact.id}`,
            extension: normalizeArtifactAttachFormat(sourceArtifact) || 'bin',
            mimeType: sourceArtifact.mimeType || 'application/octet-stream',
            buffer: sourceArtifact.contentBuffer,
            extractedText: sourceArtifact.extractedText || '',
            previewHtml: sourceArtifact.previewHtml || '',
            metadata,
            ownerId,
            vectorize: false,
        });
    } catch (error) {
        if (!isArtifactAttachUniqueConflict(error)) {
            throw error;
        }
        const conflictArtifact = await findVerifiedAttachedArtifact(targetSession.id, sourceArtifact.id, sha256);
        if (conflictArtifact) {
            return { artifact: conflictArtifact, reused: true };
        }
        throw buildArtifactAttachIdempotencyConflictError();
    }
    const serialized = typeof artifactService.serializeArtifact === 'function'
        ? artifactService.serializeArtifact(stored)
        : stored;
    return { artifact: serialized, reused: false };
}

const generationSchema = {
    sessionId: { required: true, type: 'string' },
    mode: { required: true, type: 'string' },
    prompt: { required: true, type: 'string' },
    format: { required: true, type: 'string' },
    artifactIds: { required: false, type: 'array' },
    existingContent: { required: false, type: 'string' },
    template: { required: false, type: 'string' },
    model: { required: false, type: 'string' },
    parentArtifactId: { required: false, type: 'string' },
    missionId: { required: false, type: 'string' },
    revision: { required: false, type: 'number' },
    provenance: { required: false, type: 'object' },
    reasoningEffort: { required: false, type: 'string' },
    executionProfile: { required: false, type: 'string' },
    memoryKeywords: { required: false, type: 'array' },
    asyncRuntime: { required: false, type: 'boolean' },
    asyncRuntimePreferred: { required: false, type: 'boolean' },
    idempotencyKey: { required: false, type: 'string' },
};

function shouldQueueArtifactAsyncGeneration(body = {}) {
    return body?.asyncRuntime === true
        || body?.asyncRuntimePreferred === true
        || String(body?.executionProfile || '').trim().toLowerCase() === 'async-runtime';
}

async function maybeQueueArtifactAsyncGeneration(req, {
    session = null,
    sessionId = '',
    ownerId = '',
    mode = '',
    prompt = '',
    format = '',
    model = null,
    reasoningEffort = null,
    executionProfile = 'default',
    memoryKeywords = [],
    parentArtifactId = null,
    missionId = null,
    revision = null,
    provenance = {},
} = {}) {
    if (!shouldQueueArtifactAsyncGeneration(req.body || {})) {
        return null;
    }

    const asyncService = req.app.locals.asyncLabService;
    if (!asyncService?.isEnabled?.() || !asyncService?.createRun) {
        return null;
    }

    const normalizedSessionId = String(sessionId || session?.id || '').trim();
    const normalizedFormat = String(format || 'html').trim().toLowerCase() || 'html';
    return asyncService.createRun({
        adapter: 'document-workflow',
        task: prompt,
        targetKey: `artifact:${normalizedSessionId || 'session'}:${normalizedFormat}`,
        sessionId: normalizedSessionId,
        idempotencyKey: String(req.body?.idempotencyKey || req.body?.idempotency_key || '').trim(),
        requireGeneratedIdempotency: true,
        metadata: {
            source: 'artifact-generate',
            artifactMode: mode,
            outputFormat: normalizedFormat,
            executionProfile,
            memoryKeywords,
            toolParams: {
                action: 'generate',
                prompt,
                format: normalizedFormat,
                model,
                reasoningEffort,
                buildMode: normalizedFormat === 'html' ? 'sandbox' : 'document',
                includeContent: false,
                parentArtifactId,
                missionId,
                revision,
                provenance,
            },
        },
    }, ownerId);
}

function buildPreviewContentBuffer(artifactId, file, previewAccessToken = '') {
    const filePath = String(file?.path || '').trim();
    const source = String(file?.content || '');
    if (!source) {
        return Buffer.alloc(0);
    }

    const previewRoot = buildArtifactPreviewPath(artifactId, previewAccessToken);
    if (/\.html?$/i.test(filePath)) {
        const directory = path.dirname(filePath);
        const baseHref = buildArtifactPreviewPath(
            artifactId,
            previewAccessToken,
            directory && directory !== '.' ? `${directory.replace(/\/+$/g, '')}/` : '',
        );
        return Buffer.from(
            appendAccessTokenToInternalArtifactUrls(injectBundleBaseHref(
                rewriteRootRelativeFrontendPaths(source, previewRoot),
                baseHref,
            ), previewAccessToken),
            'utf8',
        );
    }

    if (/\.(?:css|svg|js|mjs)$/i.test(filePath)) {
        return Buffer.from(
            appendAccessTokenToInternalArtifactUrls(
                rewriteRootRelativeFrontendPaths(source, previewRoot),
                previewAccessToken,
            ),
            'utf8',
        );
    }

    return Buffer.from(source, 'utf8');
}

function resolveMetadataBundlePreviewFile(artifact, requestedPath = '', previewAccessToken = '') {
    if (!hasExplicitFrontendBundle(artifact?.metadata || {})) {
        return null;
    }

    const file = getFrontendBundleFile(getArtifactFrontendBundle(artifact), requestedPath);
    if (!file) {
        return null;
    }

    return {
        path: file.path,
        contentType: resolveFrontendBundleContentType(file.path),
        contentBuffer: buildPreviewContentBuffer(artifact.id, file, previewAccessToken),
    };
}

function normalizeManagedAppPublicPath(filePath = '') {
    const normalized = normalizeBundlePath(filePath);
    if (!normalized) {
        return '';
    }

    if (normalized.startsWith('public/')) {
        return normalized;
    }

    if (normalized === 'package.json' || normalized === 'vite.config.js' || normalized.startsWith('src/')) {
        return normalized;
    }

    return `public/${normalized}`;
}

function normalizeSafeManagedAppSourcePath(filePath = '') {
    const rawPath = String(filePath || '').trim().replace(/\\/g, '/');
    if (
        !rawPath
        || /[\u0000-\u001f\u007f\ufffd]/.test(rawPath)
        || rawPath.startsWith('/')
        || /^[a-z]:\//i.test(rawPath)
    ) {
        return '';
    }

    const relativePath = rawPath.replace(/^(?:\.\/)+/, '');
    if (!relativePath || relativePath.split('/').some((segment) => segment === '..')) {
        return '';
    }

    return normalizeBundlePath(relativePath);
}

function getDeclaredSiteBundleFiles(artifact = {}) {
    const bundle = artifact?.metadata?.siteBundle || artifact?.metadata?.bundle || null;
    const rawFiles = Array.isArray(bundle?.files)
        ? bundle.files.map((file) => ({
            filePath: typeof file === 'string' ? file : (file?.path || file?.name || ''),
            metadata: file && typeof file === 'object' ? file : {},
        }))
        : (bundle?.files && typeof bundle.files === 'object'
            ? Object.entries(bundle.files).map(([filePath, file]) => ({
                filePath,
                metadata: file && typeof file === 'object' ? file : {},
            }))
            : []);
    const files = new Map();
    const invalidMembers = new Set();
    const duplicateMembers = new Set();

    rawFiles.forEach(({ filePath, metadata }) => {
        const sourcePath = normalizeSafeManagedAppSourcePath(filePath);
        if (!sourcePath || String(filePath || '').replace(/\\/g, '/').endsWith('/')) {
            invalidMembers.add(String(filePath || '').trim() || '(empty path)');
            return;
        }
        if (files.has(sourcePath)) {
            duplicateMembers.add(sourcePath);
            return;
        }
        files.set(sourcePath, metadata);
    });

    return {
        bundle,
        files,
        invalidMembers: Array.from(invalidMembers).sort((left, right) => left.localeCompare(right)),
        duplicateMembers: Array.from(duplicateMembers).sort((left, right) => left.localeCompare(right)),
    };
}

function isLikelyBinaryAssetBuffer(buffer = null) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return false;
    }
    if (buffer.includes(0)) {
        return true;
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (_error) {
        return true;
    }
    let controlBytes = 0;
    for (const byte of buffer) {
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            controlBytes += 1;
        }
    }
    return controlBytes / buffer.length > 0.02;
}

function isExplicitManagedAppSiteArchive(artifact = {}) {
    const extension = String(artifact?.extension || '').trim().toLowerCase().replace(/^\./, '');
    const mimeType = String(artifact?.mimeType || '').split(';')[0].trim().toLowerCase();
    return Boolean(artifact?.metadata?.siteBundle)
        || extension === 'zip'
        || mimeType === 'application/zip'
        || mimeType === 'application/x-zip-compressed';
}

function buildInvalidManagedAppSiteBundle(reason, affectedMembers = []) {
    return {
        reason,
        affectedMembers: Array.from(new Set(affectedMembers.filter(Boolean)))
            .sort((left, right) => left.localeCompare(right)),
    };
}

function isUnsupportedManagedAppBinaryAsset(filePath = '', metadata = {}, buffer = null) {
    const extension = path.extname(String(filePath || '').toLowerCase());
    if (UNSUPPORTED_MANAGED_APP_BINARY_ASSET_EXTENSIONS.has(extension)) {
        return true;
    }

    const language = String(metadata?.language || '').trim().toLowerCase();
    const mimeType = String(metadata?.mimeType || metadata?.contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (language === 'binary') {
        return true;
    }
    if (isLikelyBinaryAssetBuffer(buffer)) {
        return true;
    }
    if (mimeType === 'image/svg+xml' || mimeType === 'application/xml' || mimeType === 'text/xml') {
        return false;
    }
    return /^(?:audio|font|image|video)\//.test(mimeType)
        || /^(?:application\/(?:octet-stream|pdf|wasm|zip)|model\/)/.test(mimeType);
}

function extractArtifactSiteFilesForManagedApp(artifact = {}) {
    const files = new Map();
    const unsupportedBinaryAssets = new Set();
    const declaredBundle = getDeclaredSiteBundleFiles(artifact);
    const declaredFileMetadata = declaredBundle.files;
    const enforceBinaryAssetGate = Boolean(artifact?.metadata?.siteBundle || artifact?.metadata?.bundle);
    const explicitSiteArchive = isExplicitManagedAppSiteArchive(artifact);
    let invalidSiteBundle = null;

    if (explicitSiteArchive) {
        let entries;
        try {
            entries = readFrontendBundleArchive(artifact.contentBuffer || Buffer.alloc(0));
        } catch (_error) {
            return {
                files: [],
                unsupportedBinaryAssets: [],
                invalidSiteBundle: buildInvalidManagedAppSiteBundle('archive_parse_failed'),
            };
        }

        if (declaredBundle.invalidMembers.length > 0) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'invalid_declared_member_paths',
                declaredBundle.invalidMembers,
            );
        } else if (declaredBundle.duplicateMembers.length > 0) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'duplicate_declared_members',
                declaredBundle.duplicateMembers,
            );
        }

        const archivedSourcePaths = new Set();
        const targetSourcePaths = new Map();
        const invalidArchiveMembers = new Set();
        const duplicateArchiveMembers = new Set();
        entries.forEach((buffer, filePath) => {
            const rawPath = String(filePath || '').replace(/\\/g, '/');
            const isDirectory = rawPath.endsWith('/');
            const sourcePath = normalizeSafeManagedAppSourcePath(isDirectory ? rawPath.slice(0, -1) : rawPath);
            if (!sourcePath) {
                invalidArchiveMembers.add(rawPath || '(empty path)');
                return;
            }
            if (isDirectory) {
                if (buffer.length > 0) {
                    invalidArchiveMembers.add(rawPath);
                }
                return;
            }
            const targetPath = normalizeManagedAppPublicPath(sourcePath);
            if (!targetPath) {
                invalidArchiveMembers.add(rawPath);
                return;
            }
            if (archivedSourcePaths.has(sourcePath) || targetSourcePaths.has(targetPath)) {
                duplicateArchiveMembers.add(sourcePath);
                return;
            }

            archivedSourcePaths.add(sourcePath);
            targetSourcePaths.set(targetPath, sourcePath);
            if (isUnsupportedManagedAppBinaryAsset(
                sourcePath,
                declaredFileMetadata.get(sourcePath) || {},
                buffer,
            )) {
                unsupportedBinaryAssets.add(sourcePath);
                return;
            }

            files.set(targetPath, {
                path: targetPath,
                content: buffer.toString('utf8'),
            });
        });

        if (!invalidSiteBundle && invalidArchiveMembers.size > 0) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'unsafe_archive_member_paths',
                Array.from(invalidArchiveMembers),
            );
        }
        if (!invalidSiteBundle && duplicateArchiveMembers.size > 0) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'duplicate_archive_members',
                Array.from(duplicateArchiveMembers),
            );
        }

        const omittedDeclaredMembers = Array.from(declaredFileMetadata.keys())
            .filter((filePath) => !archivedSourcePaths.has(filePath));
        if (!invalidSiteBundle && omittedDeclaredMembers.length > 0) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'declared_members_missing_from_archive',
                omittedDeclaredMembers,
            );
        }

        const rawDeclaredEntry = String(
            declaredBundle.bundle?.entry || declaredBundle.bundle?.entryFile || '',
        ).trim();
        const declaredEntry = normalizeSafeManagedAppSourcePath(rawDeclaredEntry);
        if (!invalidSiteBundle && rawDeclaredEntry && !declaredEntry) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'invalid_declared_entry_path',
                [rawDeclaredEntry],
            );
        }
        if (!invalidSiteBundle && declaredEntry && !archivedSourcePaths.has(declaredEntry)) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle(
                'declared_entry_missing_from_archive',
                [declaredEntry],
            );
        }

        const rawDeclaredFileCount = declaredBundle.bundle?.fileCount;
        if (!invalidSiteBundle && rawDeclaredFileCount !== undefined && rawDeclaredFileCount !== null) {
            const declaredFileCount = Number(rawDeclaredFileCount);
            if (!Number.isInteger(declaredFileCount) || declaredFileCount < 0) {
                invalidSiteBundle = buildInvalidManagedAppSiteBundle('invalid_declared_file_count');
            } else if (declaredFileCount !== archivedSourcePaths.size) {
                invalidSiteBundle = buildInvalidManagedAppSiteBundle('declared_file_count_mismatch');
            }
        }

        if (!invalidSiteBundle && archivedSourcePaths.size === 0) {
            invalidSiteBundle = buildInvalidManagedAppSiteBundle('empty_archive');
        }

        return {
            files: Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path)),
            unsupportedBinaryAssets: Array.from(unsupportedBinaryAssets).sort((left, right) => left.localeCompare(right)),
            invalidSiteBundle,
        };
    }

    const bundle = getArtifactFrontendBundle(artifact);
    if (declaredBundle.invalidMembers.length > 0) {
        invalidSiteBundle = buildInvalidManagedAppSiteBundle(
            'invalid_declared_member_paths',
            declaredBundle.invalidMembers,
        );
    } else if (declaredBundle.duplicateMembers.length > 0) {
        invalidSiteBundle = buildInvalidManagedAppSiteBundle(
            'duplicate_declared_members',
            declaredBundle.duplicateMembers,
        );
    }
    const extractedSourcePaths = new Set();
    const targetSourcePaths = new Map();
    if (Array.isArray(bundle?.files)) {
        bundle.files.forEach((file) => {
            const sourcePath = normalizeSafeManagedAppSourcePath(file?.path || '');
            const targetPath = normalizeManagedAppPublicPath(sourcePath);
            if (!sourcePath || !targetPath) {
                invalidSiteBundle = invalidSiteBundle || buildInvalidManagedAppSiteBundle(
                    'invalid_declared_member_paths',
                    [String(file?.path || '').trim() || '(empty path)'],
                );
                return;
            }
            if (extractedSourcePaths.has(sourcePath) || targetSourcePaths.has(targetPath)) {
                invalidSiteBundle = invalidSiteBundle || buildInvalidManagedAppSiteBundle(
                    'duplicate_declared_members',
                    [sourcePath],
                );
                return;
            }
            extractedSourcePaths.add(sourcePath);
            targetSourcePaths.set(targetPath, sourcePath);
            const contentBuffer = Buffer.isBuffer(file?.contentBuffer)
                ? file.contentBuffer
                : Buffer.from(typeof file.content === 'string' ? file.content : '', 'utf8');
            if (enforceBinaryAssetGate && isUnsupportedManagedAppBinaryAsset(
                sourcePath,
                file,
                contentBuffer,
            )) {
                unsupportedBinaryAssets.add(sourcePath);
                return;
            }

            files.set(targetPath, { path: targetPath, content: contentBuffer.toString('utf8') });
        });
    }

    const omittedDeclaredMembers = Array.from(declaredFileMetadata.keys())
        .filter((filePath) => !extractedSourcePaths.has(filePath));
    if (!invalidSiteBundle && omittedDeclaredMembers.length > 0) {
        invalidSiteBundle = buildInvalidManagedAppSiteBundle(
            'declared_members_missing_from_bundle',
            omittedDeclaredMembers,
        );
    }

    if (!declaredBundle.bundle && files.size === 0 && String(artifact.previewHtml || '').trim()) {
        files.set('public/index.html', {
            path: 'public/index.html',
            content: artifact.previewHtml,
        });
    }

    return {
        files: Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path)),
        unsupportedBinaryAssets: Array.from(unsupportedBinaryAssets).sort((left, right) => left.localeCompare(right)),
        invalidSiteBundle,
    };
}

function resolveManagedAppSourceType(artifact = {}) {
    if (isExplicitManagedAppSiteArchive(artifact)) {
        return 'native-site-archive';
    }
    if (hasExplicitFrontendBundle(artifact?.metadata || {})) {
        return 'frontend-bundle';
    }
    if (String(artifact?.previewHtml || '').trim()) {
        return 'preview-html';
    }
    return 'none';
}

function buildInvalidManagedAppSiteBundleError(invalidSiteBundle = {}) {
    return {
        statusCode: 422,
        error: {
            code: 'ARTIFACT_MANAGED_APP_INVALID_SITE_BUNDLE',
            message: 'Push to Web cannot safely promote this site because its declared native bundle could not be preserved exactly.',
            blocker: 'invalid_site_bundle',
            details: {
                reason: invalidSiteBundle.reason,
                ...(Array.isArray(invalidSiteBundle.affectedMembers) && invalidSiteBundle.affectedMembers.length > 0
                    ? { affectedMembers: invalidSiteBundle.affectedMembers }
                    : {}),
                remediation: 'Regenerate the site ZIP so every declared file is present at a safe relative path, then retry Push to Web.',
            },
        },
    };
}

function buildUnsupportedManagedAppBinaryAssetsError(unsupportedBinaryAssets = []) {
    return {
        statusCode: 422,
        error: {
            code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
            message: 'Push to Web cannot safely promote this site because the managed-app repository lane cannot preserve one or more binary assets.',
            blocker: 'unsupported_binary_assets',
            details: {
                unsupportedAssets: unsupportedBinaryAssets,
                remediation: 'Replace these assets with SVG/XML/text equivalents or add binary repository-file support before deploying this bundle.',
            },
        },
    };
}

function buildEmptyManagedAppSourceError() {
    const message = 'This artifact does not contain deployable website files.';
    return {
        statusCode: 400,
        error: {
            code: 'ARTIFACT_MANAGED_APP_NO_DEPLOYABLE_FILES',
            message,
            blocker: 'no_deployable_website_files',
        },
    };
}

function buildManagedAppPiiRestorationError(sourcePath = '') {
    return {
        statusCode: 503,
        error: {
            code: 'ARTIFACT_MANAGED_APP_PII_RESTORATION_FAILED',
            message: 'Push to Web could not safely restore protected content into the final website files.',
            blocker: 'pii_restoration_failed',
            details: {
                ...(sourcePath ? { affectedPath: sourcePath } : {}),
                remediation: 'Retry after the protected-content vault is available. The website was not created or changed.',
            },
        },
    };
}

function hasPreRestoredManagedAppPii(metadata = {}) {
    const pii = metadata?.piiCleansing && typeof metadata.piiCleansing === 'object'
        ? metadata.piiCleansing
        : null;
    return Boolean(
        pii?.restoredInGeneratedArtifact === true
        || Number(pii?.restoredCount || 0) > 0,
    );
}

function buildManagedAppPreRestoredPiiError(affectedPaths = []) {
    return {
        statusCode: 422,
        error: {
            code: 'ARTIFACT_MANAGED_APP_PRE_RESTORED_PII_UNSAFE',
            message: 'Push to Web cannot safely publish protected values that were restored before their HTML, XML, CSS, or script context was known.',
            blocker: 'pre_restored_pii_context_unsafe',
            details: {
                affectedPaths: Array.from(new Set(affectedPaths.filter(Boolean))).sort((left, right) => left.localeCompare(right)),
                remediation: 'Regenerate the site with protected placeholders preserved until deployment, or remove protected values from executable and structured site files.',
            },
        },
    };
}

function normalizeManagedAppQualityPath(filePath = '') {
    const normalized = String(filePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    return normalized.startsWith('public/') ? normalized.slice('public/'.length) : normalized;
}

function resolveManagedAppQualityMimeType(filePath = '') {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (extension === '.cjs') {
        return 'text/javascript; charset=utf-8';
    }
    if (extension === '.map') {
        // Source maps remain opaque text here because .map is not a first-class
        // format in ArtifactStructuralQuality/v1.
        return 'text/plain; charset=utf-8';
    }
    return resolveFrontendBundleContentType(filePath);
}

function buildManagedAppQualityValidationFiles(files = []) {
    const candidates = files.map((file) => {
        const qualityPath = normalizeManagedAppQualityPath(file?.path);
        return {
            path: qualityPath,
            filename: path.basename(qualityPath),
            mimeType: resolveManagedAppQualityMimeType(file?.path || qualityPath),
            content: String(file?.content || ''),
        };
    });
    const entry = candidates.find((file) => file.path.toLowerCase() === 'index.html')
        || candidates.find((file) => /(?:^|\/)index\.html?$/i.test(file.path))
        || candidates.find((file) => /\.html?$/i.test(file.path));

    return candidates.map((file) => ({
        ...file,
        role: entry && file.path === entry.path ? 'site-entry' : 'site-file',
    }));
}

function summarizeManagedAppQualityReport(report = {}) {
    const blockers = Array.isArray(report?.blockers) ? report.blockers : [];
    return {
        version: String(report?.version || ''),
        status: String(report?.status || 'blocked'),
        blockerCount: blockers.length,
        site: {
            enabled: report?.site?.enabled === true,
            entries: Array.isArray(report?.site?.entries)
                ? report.site.entries.map((entry) => String(entry || '').slice(0, 512)).slice(0, 12)
                : [],
            checkedReferences: Number(report?.site?.checkedReferences || 0),
        },
        blockers: blockers.slice(0, 32).map((blocker) => ({
            code: String(blocker?.code || 'REMOTE_AGENT_ARTIFACT_QUALITY_BLOCKED').slice(0, 160),
            path: String(blocker?.path || '').slice(0, 512),
            message: String(blocker?.message || 'Prepared website bytes failed artifact quality validation.').slice(0, 1200),
            ...(blocker?.reference ? { reference: String(blocker.reference).slice(0, 1000) } : {}),
        })),
    };
}

function buildManagedAppQualityError(report = {}) {
    return {
        statusCode: 422,
        error: {
            code: 'ARTIFACT_MANAGED_APP_QUALITY_BLOCKED',
            message: 'Push to Web cannot publish the exact prepared website bytes because artifact quality validation failed.',
            blocker: 'artifact_quality_blocked',
            details: summarizeManagedAppQualityReport(report),
        },
    };
}

async function findManagedAppPreRestoredPiiPaths(artifact = {}, req) {
    const affectedPaths = [];
    if (hasPreRestoredManagedAppPii(artifact?.metadata || {})) {
        affectedPaths.push(String(artifact?.filename || 'artifact'));
    }

    const declaredFiles = Array.isArray(artifact?.metadata?.siteBundle?.files)
        ? artifact.metadata.siteBundle.files
        : (Array.isArray(artifact?.metadata?.bundle?.files) ? artifact.metadata.bundle.files : []);
    const seenArtifactIds = new Set();
    for (const file of declaredFiles) {
        const componentArtifactId = String(file?.artifactId || file?.artifact_id || '').trim();
        if (!componentArtifactId
            || componentArtifactId === artifact?.id
            || seenArtifactIds.has(componentArtifactId)) {
            continue;
        }
        seenArtifactIds.add(componentArtifactId);
        const component = await getOwnedArtifact(req, componentArtifactId, { includeContent: false });
        if (component && hasPreRestoredManagedAppPii(component.metadata || {})) {
            affectedPaths.push(String(file?.path || file?.filename || component?.filename || componentArtifactId));
        }
    }
    return affectedPaths;
}

function buildManagedAppSourceHashInvalidError() {
    return {
        statusCode: 400,
        error: {
            code: 'ARTIFACT_MANAGED_APP_SOURCE_HASH_INVALID',
            message: 'expectedSourceSha256 must be a 64-character SHA-256 value.',
            blocker: 'invalid_expected_source_hash',
        },
    };
}

function buildManagedAppSourceHashMismatchError(expectedSha256 = '', actualSha256 = '') {
    return {
        statusCode: 412,
        error: {
            code: 'ARTIFACT_MANAGED_APP_SOURCE_CHANGED',
            message: 'Push to Web stopped because the prepared website bytes changed after preflight.',
            blocker: 'managed_app_source_changed',
            details: {
                expectedSha256,
                actualSha256,
                remediation: 'Run preflight again, review the new source fingerprint, and retry with that fingerprint.',
            },
        },
    };
}

function buildManagedAppFileFingerprint(files = []) {
    const descriptors = files.map((file) => {
        const contentBuffer = Buffer.from(file.content || '', 'utf8');
        return {
            path: file.path,
            sizeBytes: contentBuffer.length,
            sha256: createHash('sha256').update(contentBuffer).digest('hex'),
        };
    });
    const aggregateHash = createHash('sha256');
    files.forEach((file) => {
        const pathBuffer = Buffer.from(file.path || '', 'utf8');
        const contentBuffer = Buffer.from(file.content || '', 'utf8');
        aggregateHash.update(Buffer.from(`${pathBuffer.length}:`, 'utf8'));
        aggregateHash.update(pathBuffer);
        aggregateHash.update(Buffer.from(`:${contentBuffer.length}:`, 'utf8'));
        aggregateHash.update(contentBuffer);
    });

    return {
        descriptors,
        sizeBytes: descriptors.reduce((total, file) => total + file.sizeBytes, 0),
        sha256: files.length > 0 ? aggregateHash.digest('hex') : null,
    };
}

async function prepareArtifactManagedAppSource(artifact = {}, req) {
    const sourceType = resolveManagedAppSourceType(artifact);
    const preRestoredPiiPaths = await findManagedAppPreRestoredPiiPaths(artifact, req);
    if (preRestoredPiiPaths.length > 0) {
        return {
            sourceType,
            contentEligible: false,
            files: [],
            descriptors: [],
            sizeBytes: 0,
            sha256: null,
            failure: buildManagedAppPreRestoredPiiError(preRestoredPiiPaths),
        };
    }
    const extractedSite = extractArtifactSiteFilesForManagedApp(artifact);
    let failure = null;

    if (extractedSite.invalidSiteBundle) {
        failure = buildInvalidManagedAppSiteBundleError(extractedSite.invalidSiteBundle);
    } else if (extractedSite.unsupportedBinaryAssets.length > 0) {
        failure = buildUnsupportedManagedAppBinaryAssetsError(extractedSite.unsupportedBinaryAssets);
    }

    if (failure) {
        return {
            sourceType,
            contentEligible: false,
            files: [],
            descriptors: [],
            sizeBytes: 0,
            sha256: null,
            failure,
        };
    }

    let files;
    try {
        files = await Promise.all(extractedSite.files.map(async (file) => {
            try {
                return {
                    ...file,
                    content: (await rehydrateManagedAppSourceBuffer(
                        Buffer.from(file.content || '', 'utf8'),
                        artifact,
                        req,
                        {
                            contentType: resolveFrontendBundleContentType(file.path),
                            path: file.path,
                        },
                    )).toString('utf8'),
                };
            } catch (error) {
                error.managedAppSourcePath = file.path;
                throw error;
            }
        }));
    } catch (error) {
        const affectedPath = String(error?.managedAppSourcePath || '').trim();
        console.warn(
            `[Artifacts] Failed to restore managed-app source${affectedPath ? ` ${affectedPath}` : ''} for ${artifact?.id || 'artifact'}: ${error.message}`,
        );
        return {
            sourceType,
            contentEligible: false,
            files: [],
            descriptors: [],
            sizeBytes: 0,
            sha256: null,
            failure: buildManagedAppPiiRestorationError(affectedPath),
        };
    }
    if (files.length === 0) {
        return {
            sourceType,
            contentEligible: false,
            files: [],
            descriptors: [],
            sizeBytes: 0,
            sha256: null,
            failure: buildEmptyManagedAppSourceError(),
        };
    }

    const artifactQuality = validateResultArtifactSet({
        files: buildManagedAppQualityValidationFiles(files),
    });
    if (artifactQuality.status !== 'passed') {
        return {
            sourceType,
            contentEligible: false,
            files: [],
            descriptors: [],
            sizeBytes: 0,
            sha256: null,
            failure: buildManagedAppQualityError(artifactQuality),
        };
    }

    const fingerprint = buildManagedAppFileFingerprint(files);
    return {
        sourceType,
        contentEligible: true,
        files,
        descriptors: fingerprint.descriptors,
        sizeBytes: fingerprint.sizeBytes,
        sha256: fingerprint.sha256,
        failure: null,
    };
}

function buildManagedAppControlPlaneError() {
    return {
        statusCode: 503,
        error: {
            code: 'ARTIFACT_MANAGED_APP_CONTROL_PLANE_UNAVAILABLE',
            message: 'Managed app export requires the managed app control plane to be available.',
            blocker: 'managed_app_control_plane_unavailable',
        },
    };
}

function getExpectedManagedAppSourceSha256(body = {}) {
    const rawValue = body?.expectedSourceSha256 ?? body?.expected_source_sha256;
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return { value: '', failure: null };
    }
    const value = String(rawValue).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) {
        return { value: '', failure: buildManagedAppSourceHashInvalidError() };
    }
    return { value, failure: null };
}

function collectManagedAppPreflightBlockers({ controlPlaneAvailable = false, preparedSource = null } = {}) {
    const blockers = [];
    if (!controlPlaneAvailable) {
        blockers.push(buildManagedAppControlPlaneError().error);
    }
    if (preparedSource?.failure) {
        blockers.push(preparedSource.failure.error);
    }
    return blockers;
}

function buildManagedAppNameFromArtifact(artifact = {}, fallback = 'Website Artifact') {
    return String(
        artifact?.metadata?.title
        || artifact?.metadata?.siteBundle?.title
        || artifact?.metadata?.bundle?.title
        || artifact?.filename
        || fallback
    )
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || fallback;
}

function normalizeDomainHost(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }

    let candidate = raw;
    try {
        const parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
        candidate = parsed.hostname;
    } catch (_error) {
        candidate = candidate
            .replace(/^https?:\/\//i, '')
            .split(/[/?#]/)[0];
    }

    const normalized = candidate
        .replace(/^\.+|\.+$/g, '')
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/\.{2,}/g, '.');
    const labels = normalized.split('.').filter(Boolean);
    if (labels.length < 2 || normalized.length > 253) {
        return '';
    }
    if (labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
        return '';
    }

    return labels.join('.');
}

function normalizeDnsLabel(value = '') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .split(/[./?#]/)[0]
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 63)
        .replace(/-+$/g, '');
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized) ? normalized : '';
}

function resolveManagedAppPublicHost(body = {}, service = null) {
    const explicitHost = normalizeDomainHost(
        body.publicHost
        || body.webAddress
        || body.webAddressHost
        || body.host
        || '',
    );
    if (explicitHost) {
        return explicitHost;
    }

    const configuredDomain = typeof service?.getEffectiveManagedAppsConfig === 'function'
        ? service.getEffectiveManagedAppsConfig()?.appBaseDomain
        : '';
    const baseDomain = normalizeDomainHost(
        body.publicBaseDomain
        || body.remoteAddress
        || body.baseDomain
        || configuredDomain
        || 'demoserver2.buzz',
    ) || 'demoserver2.buzz';
    const dnsName = String(
        body.dnsName
        || body.subdomain
        || body.webAddressName
        || body.publicName
        || '',
    ).trim();
    const fullDnsHost = normalizeDomainHost(dnsName);
    if (fullDnsHost) {
        return fullDnsHost;
    }

    const label = normalizeDnsLabel(dnsName);
    return label ? `${label}.${baseDomain}` : '';
}

function shouldQueueManagedAppAsyncDeploy(body = {}, requestedAction = '') {
    if (body?.asyncRuntime === false || body?.queueAsyncDeploy === false) {
        return false;
    }
    const action = String(requestedAction || body?.requestedAction || body?.action || '').trim().toLowerCase();
    return body?.deployRequested === true
        || ['deploy', 'publish', 'launch', 'live'].includes(action);
}

async function maybeQueueManagedAppAsyncDeploy(req, {
    managedAppResult = null,
    requestedAction = '',
    publicHost = '',
    artifact = null,
} = {}) {
    if (!shouldQueueManagedAppAsyncDeploy(req.body || {}, requestedAction)) {
        return null;
    }

    // A newly accepted build with deployRequested=true is promoted by the
    // authenticated build-events webhook after GitLab has attested its OCI
    // digest. Starting a deploy run here would race that queued build and can
    // only deploy stale evidence (or fail while the build is pending).
    if (String(managedAppResult?.buildRun?.id || '').trim()) {
        return null;
    }

    const asyncService = req.app.locals.asyncLabService;
    if (!asyncService?.isEnabled?.() || !asyncService?.createRun) {
        return null;
    }

    const app = managedAppResult?.app || {};
    const appRef = String(app.id || app.slug || '').trim();
    if (!appRef) {
        return null;
    }

    const targetHost = String(publicHost || app.publicHost || '').trim();
    const targetKey = `managed-app:${targetHost || appRef}`;
    const sessionId = String(req.body?.sessionId || artifact?.sessionId || '').trim();
    return asyncService.createRun({
        adapter: 'managed-app',
        task: `Deploy managed app ${app.slug || app.appName || appRef}${targetHost ? ` to ${targetHost}` : ''}.`,
        targetKey,
        sessionId,
        liveRemote: true,
        idempotencyKey: `managed-app-deploy:${appRef}:${managedAppResult?.buildRun?.id || targetHost || requestedAction || 'deploy'}`,
        metadata: {
            source: 'artifact-managed-app-export',
            appRef,
            publicHost: targetHost,
            buildRunId: managedAppResult?.buildRun?.id || '',
            sourceArtifactId: artifact?.id || '',
            toolParams: {
                action: 'deploy',
                appRef,
                requestedAction: 'deploy',
                deployRequested: true,
                sessionId,
                ...(targetHost ? { publicHost: targetHost } : {}),
            },
        },
    }, getRequestOwnerId(req));
}

function buildManagedAppDeploymentLifecycle(managedAppResult = null, requestedAction = '') {
    const buildRun = managedAppResult?.buildRun && typeof managedAppResult.buildRun === 'object'
        ? managedAppResult.buildRun
        : null;
    if (!buildRun || !String(buildRun.id || '').trim()) {
        return null;
    }
    if (!shouldQueueManagedAppAsyncDeploy({
        deployRequested: buildRun.deployRequested === true,
        requestedAction,
    }, requestedAction)) {
        return null;
    }
    return {
        mode: 'build-webhook',
        status: String(buildRun.buildStatus || 'queued').trim().toLowerCase() || 'queued',
        buildRunId: String(buildRun.id).trim(),
        commitSha: String(buildRun.commitSha || '').trim(),
        deployRequested: true,
        digestRequired: true,
    };
}

router.post('/upload', async (req, res, next) => {
    try {
        const { fields, file } = await parseMultipartRequest(req);
        let sessionId = fields.sessionId;
        const mode = fields.mode || 'chat';
        const label = fields.label || '';
        const tags = fields.tags || [];
        const ownerId = getRequestOwnerId(req);
        const requestedSessionMetadata = buildScopedSessionMetadata({
            mode,
            taskType: fields.taskType || mode,
            clientSurface: resolveClientSurface(fields, null, mode),
        });
        const session = ownerId
            ? await sessionStore.resolveOwnedSession(sessionId, requestedSessionMetadata, ownerId)
            : sessionId
                ? await sessionStore.getOrCreate(sessionId, requestedSessionMetadata)
                : await sessionStore.create(requestedSessionMetadata);
        if (!session) {
            return res.status(404).json({ error: { message: 'Session not found' } });
        }
        sessionId = session.id;
        const artifact = await artifactService.uploadArtifact({
            sessionId,
            session,
            mode,
            label,
            tags,
            file,
        });
        if (artifact?.id) {
            const priorUploadedIds = Array.isArray(session?.metadata?.lastUploadedArtifactIds)
                ? session.metadata.lastUploadedArtifactIds
                : [];
            const priorUploadedImageIds = Array.isArray(session?.metadata?.lastUploadedImageArtifactIds)
                ? session.metadata.lastUploadedImageArtifactIds
                : [];
            const uploadedIds = [artifact.id, ...priorUploadedIds.filter((id) => id !== artifact.id)].slice(0, 8);
            const imageLike = String(artifact.mimeType || '').toLowerCase().startsWith('image/')
                || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(String(artifact.format || '').toLowerCase());
            const uploadedImageIds = imageLike
                ? [artifact.id, ...priorUploadedImageIds.filter((id) => id !== artifact.id)].slice(0, 4)
                : priorUploadedImageIds.slice(0, 4);
            await sessionStore.update(sessionId, {
                metadata: {
                    lastUploadedArtifactIds: uploadedIds,
                    lastUploadedImageArtifactIds: uploadedImageIds,
                },
            });
        }

        res.status(201).json(artifact);
    } catch (err) {
        next(err);
    }
});

router.post('/generate', validate(generationSchema), async (req, res, next) => {
    try {
        const {
            sessionId: requestedSessionId,
            mode,
            prompt,
            format,
            artifactIds = [],
            existingContent = '',
            template = '',
            model = null,
            parentArtifactId = null,
            missionId = null,
            revision = null,
            provenance = {},
            reasoningEffort = null,
            executionProfile = 'default',
            memoryKeywords = [],
        } = req.body;

        const ownerId = getRequestOwnerId(req);
        const requestTimezone = req.body?.timezone || req.get('x-user-timezone') || null;
        const requestNow = req.body?.now || req.get('x-user-now') || null;
        const requestedSessionMetadata = buildScopedSessionMetadata({
            mode,
            taskType: req.body?.taskType || mode,
            clientSurface: resolveClientSurface(req.body || {}, null, mode),
        });
        const session = ownerId
            ? await sessionStore.resolveOwnedSession(requestedSessionId, requestedSessionMetadata, ownerId)
            : requestedSessionId
                ? await sessionStore.getOrCreate(requestedSessionId, requestedSessionMetadata)
                : await sessionStore.create(requestedSessionMetadata);
        if (!session) {
            return res.status(404).json({ error: { message: 'Session not found' } });
        }
        const sessionId = session.id;
        const clientSurface = resolveClientSurface(req.body || {}, session, mode);
        const memoryScope = resolveSessionScope({
            ...requestedSessionMetadata,
            clientSurface,
        }, session);
        const asyncRuntime = await maybeQueueArtifactAsyncGeneration(req, {
            session,
            sessionId,
            ownerId,
            mode,
            prompt,
            format,
            model,
            reasoningEffort,
            executionProfile,
            memoryKeywords,
            parentArtifactId,
            missionId,
            revision,
            provenance,
        });
        if (asyncRuntime) {
            return res.status(asyncRuntime.duplicate ? 200 : 202).json({
                sessionId,
                asyncRuntime: {
                    run: asyncRuntime.run,
                    events: asyncRuntime.events,
                    duplicate: asyncRuntime.duplicate === true,
                },
            });
        }

        const toolManager = await ensureRuntimeToolManager(req.app);
        const result = await artifactService.generateArtifact({
            session,
            sessionId,
            mode,
            prompt,
            format,
            artifactIds,
            existingContent,
            template,
            model,
            parentArtifactId,
            missionId,
            revision,
            provenance,
            reasoningEffort,
            toolManager,
            toolContext: {
                sessionId,
                route: '/api/artifacts/generate',
                transport: 'http',
                memoryService: req.app.locals.memoryService,
                ownerId,
                clientSurface,
                memoryScope,
                memoryKeywords,
                runId: req.body?.runId || req.body?.agentRunId || null,
                timezone: requestTimezone,
                now: requestNow,
                documentService: req.app.locals.documentService || null,
                workloadService: req.app.locals.agentWorkloadService,
            },
            executionProfile,
        });

        if (result.responseId) {
            await sessionStore.recordResponse(sessionId, result.responseId);
        }

        res.status(201).json({
            sessionId,
            responseId: result.responseId,
            artifact: result.artifact,
        });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/attach', async (req, res, next) => {
    try {
        const ownerId = getRequestOwnerId(req);
        if (!ownerId) {
            return res.status(401).json({
                error: {
                    code: 'ARTIFACT_ATTACH_AUTH_REQUIRED',
                    message: 'Artifact attachment requires an authenticated owner.',
                },
            });
        }

        const sourceArtifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!sourceArtifact) {
            return res.status(404).json({
                error: {
                    code: 'ARTIFACT_ATTACH_SOURCE_NOT_FOUND',
                    message: 'Artifact not found.',
                },
            });
        }
        if (isArtifactAttachPrivacySuppressed(req, sourceArtifact)) {
            return res.status(422).json({
                error: {
                    code: 'ARTIFACT_ATTACH_PRIVACY_SUPPRESSED',
                    message: 'Privacy-protected artifact bytes cannot be attached to a browser editing surface.',
                },
            });
        }

        if (sourceArtifact.contentBuffer == null) {
            return res.status(422).json({
                error: {
                    code: 'ARTIFACT_ATTACH_CONTENT_UNAVAILABLE',
                    message: 'Artifact content is unavailable for attachment.',
                },
            });
        }
        const sourceBuffer = Buffer.isBuffer(sourceArtifact.contentBuffer)
            ? sourceArtifact.contentBuffer
            : Buffer.from(sourceArtifact.contentBuffer);
        if (sourceBuffer.length > ARTIFACT_ATTACH_MAX_BYTES) {
            return res.status(413).json({
                error: {
                    code: 'ARTIFACT_ATTACH_TOO_LARGE',
                    message: `Artifact attachment is limited to ${ARTIFACT_ATTACH_MAX_BYTES} bytes.`,
                },
            });
        }

        const sha256 = createHash('sha256').update(sourceBuffer).digest('hex');
        const declaredSha256 = String(sourceArtifact.sha256 || '').trim().toLowerCase();
        if (/^[a-f0-9]{64}$/.test(declaredSha256) && declaredSha256 !== sha256) {
            return res.status(409).json({
                error: {
                    code: 'ARTIFACT_ATTACH_SOURCE_INTEGRITY_MISMATCH',
                    message: 'Artifact content does not match its stored checksum.',
                },
            });
        }

        const mode = String(req.body?.mode || 'artifact').trim().slice(0, 80) || 'artifact';
        const taskType = String(req.body?.taskType || mode).trim().slice(0, 80) || mode;
        const resolvedClientSurface = resolveClientSurface({
            clientSurface: req.body?.clientSurface || taskType,
        }, null, taskType) || taskType;
        const clientSurface = String(resolvedClientSurface).slice(0, 80);
        const requestedTargetSessionId = String(req.body?.targetSessionId || '').trim();
        if (requestedTargetSessionId.length > 240) {
            return res.status(400).json({
                error: {
                    code: 'ARTIFACT_ATTACH_TARGET_SESSION_INVALID',
                    message: 'Target session id is too long.',
                },
            });
        }
        const targetSessionId = requestedTargetSessionId || null;
        const targetSessionMetadata = buildScopedSessionMetadata({
            mode,
            taskType,
            clientSurface,
        });
        const targetSession = targetSessionId
            ? await sessionStore.get(targetSessionId)
            : await sessionStore.resolveOwnedSession(null, targetSessionMetadata, ownerId);
        const explicitTargetOwnerMatches = !targetSessionId
            || getArtifactAttachSessionOwnerId(targetSession) === String(ownerId).trim();
        if (!targetSession || !explicitTargetOwnerMatches) {
            return res.status(404).json({
                error: {
                    code: 'ARTIFACT_ATTACH_TARGET_SESSION_NOT_FOUND',
                    message: 'Target session not found.',
                },
            });
        }
        const targetScope = resolveSessionScope(targetSessionMetadata);
        if (targetSessionId && (
            String(targetSession.id || '').trim() !== targetSessionId
            || !sessionMatchesScope(targetSession, targetScope)
        )) {
            return res.status(409).json({
                error: {
                    code: 'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
                    message: 'The requested target session does not belong to the requested editing surface.',
                },
            });
        }

        const sourceForAttach = {
            ...sourceArtifact,
            contentBuffer: sourceBuffer,
        };
        const attachKey = `${targetSession.id}:${sourceArtifact.id}:${sha256}`;
        let attachPromise = artifactAttachInFlight.get(attachKey);
        if (!attachPromise) {
            attachPromise = attachArtifactToSession({
                sourceArtifact: sourceForAttach,
                targetSession,
                clientSurface,
                mode,
                taskType,
                sha256,
                ownerId,
            });
            artifactAttachInFlight.set(attachKey, attachPromise);
        }

        let attached;
        try {
            attached = await attachPromise;
        } finally {
            if (artifactAttachInFlight.get(attachKey) === attachPromise) {
                artifactAttachInFlight.delete(attachKey);
            }
        }

        return res.status(attached.reused ? 200 : 201).json({
            targetSessionId: targetSession.id,
            sourceArtifactId: sourceArtifact.id,
            artifact: attached.artifact,
            sha256,
            reused: attached.reused,
            importCapability: buildArtifactAttachImportCapability(sourceArtifact, clientSurface),
        });
    } catch (err) {
        if (err?.code === 'ARTIFACT_ATTACH_IDEMPOTENCY_CONFLICT') {
            return res.status(409).json({
                error: {
                    code: err.code,
                    message: err.message,
                },
            });
        }
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id);
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }
        res.json(artifact);
    } catch (err) {
        next(err);
    }
});

router.get('/:id/sandbox', async (req, res, next) => {
    return serveArtifactSandbox(req, res, next);
});

router.get('/:id/sandbox-access/:previewAccessToken', async (req, res, next) => {
    return serveArtifactSandbox(req, res, next, req.params.previewAccessToken);
});

async function serveArtifactSandbox(req, res, next, previewAccessToken = '') {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id);
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        if (shouldSuppressUploadedArtifactPreview(req, artifact)) {
            return sendSuppressedUploadedArtifactPreview(res);
        }

        applySandboxShellHeaders(res);
        res.send(buildTokenizedSandboxPreviewShell(req.params.id, previewAccessToken));
    } catch (err) {
        next(err);
    }
}

router.get('/:id/download', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const inlineRequested = ['1', 'true', 'yes'].includes(String(req.query.inline || '').toLowerCase());
        if (inlineRequested && shouldSuppressUploadedArtifactPreview(req, artifact)) {
            return sendSuppressedUploadedArtifactPreview(res);
        }
        res.setHeader('Content-Type', artifact.mimeType);
        res.setHeader(
            'Content-Disposition',
            `${inlineRequested ? 'inline' : 'attachment'}; filename="${artifact.filename}"`,
        );
        if (inlineRequested) {
            applyPreviewResponseHeaders(res);
        }
        const outputBuffer = await rehydratePreviewBuffer(artifact.contentBuffer, artifact, req, {
            contentType: artifact.mimeType,
            path: artifact.filename,
        });
        res.send(outputBuffer);
    } catch (err) {
        next(err);
    }
});

router.get('/:id/preview', async (req, res, next) => {
    return serveArtifactPreview(req, res, next, '', '');
});

router.get('/:id/preview-access/:previewAccessToken', async (req, res, next) => {
    return serveArtifactPreview(req, res, next, '', req.params.previewAccessToken);
});

router.get('/:id/preview-access/:previewAccessToken/*', async (req, res, next) => {
    return serveArtifactPreview(req, res, next, String(req.params[0] || '').trim(), req.params.previewAccessToken);
});

async function serveArtifactPreview(req, res, next, requestedPath = '', previewAccessToken = '') {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        if (shouldSuppressUploadedArtifactPreview(req, artifact)) {
            return sendSuppressedUploadedArtifactPreview(res);
        }

        const zipPreview = resolveArtifactFrontendBundleFile(artifact, requestedPath, {
            previewBasePath: buildArtifactPreviewPath(req.params.id, previewAccessToken),
        });
        if (zipPreview) {
            res.setHeader('Content-Type', zipPreview.contentType);
            applyPreviewResponseHeaders(res);
            const tokenizedBuffer = /\.(?:html?|css|svg|js|mjs)$/i.test(zipPreview.path)
                ? Buffer.from(appendAccessTokenToInternalArtifactUrls(zipPreview.contentBuffer.toString('utf8'), previewAccessToken), 'utf8')
                : zipPreview.contentBuffer;
            const buffer = await rehydratePreviewBuffer(tokenizedBuffer, artifact, req, {
                contentType: zipPreview.contentType,
                path: zipPreview.path,
            });
            res.send(buffer);
            return;
        }

        const previewFile = resolveMetadataBundlePreviewFile(artifact, requestedPath, previewAccessToken);

        if (!previewFile && isPdfArtifact(artifact)) {
            res.setHeader('Content-Type', artifact.mimeType || 'application/pdf');
            applyPreviewResponseHeaders(res);
            res.send(artifact.contentBuffer || Buffer.alloc(0));
            return;
        }

        const previewBuffer = previewFile?.contentBuffer
            || (typeof artifact.previewHtml === 'string' && artifact.previewHtml
                ? Buffer.from(artifact.previewHtml, 'utf8')
                : artifact.contentBuffer);

        res.setHeader('Content-Type', previewFile?.contentType || 'text/html; charset=utf-8');
        applyPreviewResponseHeaders(res);
        const tokenizedBuffer = /\.(?:html?|css|svg|js|mjs)$/i.test(previewFile?.path || 'index.html')
            ? Buffer.from(appendAccessTokenToInternalArtifactUrls(previewBuffer.toString('utf8'), previewAccessToken), 'utf8')
            : previewBuffer;
        const outputBuffer = await rehydratePreviewBuffer(tokenizedBuffer, artifact, req, {
            contentType: previewFile?.contentType || 'text/html; charset=utf-8',
            path: previewFile?.path || 'index.html',
        });
        res.send(outputBuffer);
    } catch (err) {
        next(err);
    }
}

router.get('/:id/preview/*', async (req, res, next) => {
    return serveArtifactPreview(req, res, next, String(req.params[0] || '').trim(), '');
});

router.get('/:id/bundle', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const isZipBundleArtifact = String(artifact.extension || '').toLowerCase() === 'zip'
            && artifact?.metadata?.siteBundle;
        if (isZipBundleArtifact) {
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename || 'frontend-bundle.zip'}"`);
            res.send(artifact.contentBuffer);
            return;
        }

        const bundle = getArtifactFrontendBundle(artifact);
        if (!hasFrontendBundleArchive(bundle)) {
            return res.status(404).json({ error: { message: 'Artifact bundle not found' } });
        }

        const zipBuffer = createFrontendBundleArchive(bundle);
        const baseName = String(artifact.filename || 'site').replace(/\.[a-z0-9]+$/i, '') || 'site';

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
        res.send(zipBuffer);
    } catch (err) {
        next(err);
    }
});

router.post('/:id/managed-app/preflight', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const service = req.app.locals.managedAppService;
        const controlPlaneAvailable = Boolean(service?.isAvailable && service.isAvailable());
        const preparedSource = await prepareArtifactManagedAppSource(artifact, req);
        const blockers = collectManagedAppPreflightBlockers({
            controlPlaneAvailable,
            preparedSource,
        });

        res.json({
            artifactId: artifact.id,
            contentEligible: preparedSource.contentEligible,
            controlPlaneAvailable,
            pushToWebEligible: preparedSource.contentEligible && controlPlaneAvailable,
            sourceType: preparedSource.sourceType,
            targetPaths: preparedSource.descriptors.map((file) => file.path),
            fileCount: preparedSource.descriptors.length,
            sizeBytes: preparedSource.sizeBytes,
            sha256: preparedSource.sha256,
            files: preparedSource.descriptors,
            blockers,
        });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/managed-app', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const service = req.app.locals.managedAppService;
        if (!service?.isAvailable || !service.isAvailable()) {
            const failure = buildManagedAppControlPlaneError();
            return res.status(failure.statusCode).json({
                error: failure.error,
            });
        }

        const preparedSource = await prepareArtifactManagedAppSource(artifact, req);
        if (preparedSource.failure) {
            return res.status(preparedSource.failure.statusCode).json({
                error: preparedSource.failure.error,
            });
        }
        const files = preparedSource.files;
        const expectedSource = getExpectedManagedAppSourceSha256(req.body || {});
        if (expectedSource.failure) {
            return res.status(expectedSource.failure.statusCode).json({
                error: expectedSource.failure.error,
            });
        }
        if (expectedSource.value && expectedSource.value !== preparedSource.sha256) {
            const failure = buildManagedAppSourceHashMismatchError(
                expectedSource.value,
                preparedSource.sha256,
            );
            return res.status(failure.statusCode).json({
                error: failure.error,
            });
        }

        const requestedAction = String(req.body?.requestedAction || req.body?.action || '').trim()
            || (req.body?.deployRequested === true ? 'deploy' : 'build');
        const appName = String(req.body?.appName || req.body?.name || '').trim()
            || buildManagedAppNameFromArtifact(artifact);
        const publicHost = resolveManagedAppPublicHost(req.body || {}, service);
        const result = await service.createApp({
            ...(req.body && typeof req.body === 'object' ? req.body : {}),
            appName,
            ...(publicHost ? { publicHost } : {}),
            sourcePrompt: String(
                req.body?.sourcePrompt
                || artifact?.metadata?.sourcePrompt
                || `Exported from web-chat artifact ${artifact.filename || artifact.id}.`
            ).trim(),
            requestedAction,
            deployRequested: req.body?.deployRequested === true || ['deploy', 'publish', 'launch', 'live'].includes(requestedAction),
            files,
            metadata: {
                ...(req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
                sourceArtifact: {
                    id: artifact.id,
                    filename: artifact.filename,
                    format: artifact.extension || artifact.format,
                    sha256: preparedSource.sha256,
                    sizeBytes: preparedSource.sizeBytes,
                    fileCount: preparedSource.descriptors.length,
                },
                ...(publicHost ? {
                    requestedPublicHost: publicHost,
                    acmeRequestHost: publicHost,
                } : {}),
            },
        }, getRequestOwnerId(req), {
            sessionId: artifact.sessionId,
            model: req.body?.model || null,
        });
        const asyncRuntime = await maybeQueueManagedAppAsyncDeploy(req, {
            managedAppResult: result,
            requestedAction,
            publicHost,
            artifact,
        });
        const deploymentLifecycle = buildManagedAppDeploymentLifecycle(result, requestedAction);

        res.status(202).json({
            artifactId: artifact.id,
            fileCount: files.length,
            files: files.map((file) => file.path),
            ...result,
            sourceSha256: preparedSource.sha256,
            sourceSizeBytes: preparedSource.sizeBytes,
            publicHost: publicHost || result?.publicHost || result?.app?.publicHost || null,
            ...(deploymentLifecycle ? { deploymentLifecycle } : {}),
            ...(asyncRuntime ? {
                asyncRuntime: {
                    run: asyncRuntime.run,
                    events: asyncRuntime.events,
                    duplicate: asyncRuntime.duplicate === true,
                },
            } : {}),
        });
    } catch (err) {
        next(err);
    }
});

router.get('/:id/site', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id);
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        res.redirect(302, buildFrontendBundlePreviewUrl(req.params.id));
    } catch (err) {
        next(err);
    }
});

router.get('/:id/site/*', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const requestedPath = String(req.params[0] || '').trim();
        let resolved = resolveArtifactFrontendBundleFile(artifact, requestedPath);
        if (!resolved) {
            resolved = resolveMetadataBundlePreviewFile(artifact, requestedPath);
        }

        if (!resolved) {
            return res.status(404).json({ error: { message: 'Artifact site asset not found' } });
        }

        res.setHeader('Content-Type', resolved.contentType);
        applyPreviewResponseHeaders(res);
        const outputBuffer = await rehydratePreviewBuffer(resolved.contentBuffer, artifact, req, {
            contentType: resolved.contentType,
            path: requestedPath || 'index.html',
        });
        res.send(outputBuffer);
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id);
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const deleted = await artifactService.deleteArtifact(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

module.exports = router;
