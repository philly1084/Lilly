const { Router } = require('express');
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
} = require('../session-scope');
const { rehydrateHtml, rehydrateText, resolvePiiPolicy } = require('../pii');

const router = Router();
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

router.post('/:id/managed-app', async (req, res, next) => {
    try {
        const artifact = await getOwnedArtifact(req, req.params.id, { includeContent: true });
        if (!artifact) {
            return res.status(404).json({ error: { message: 'Artifact not found' } });
        }

        const service = req.app.locals.managedAppService;
        if (!service?.isAvailable || !service.isAvailable()) {
            return res.status(503).json({
                error: {
                    message: 'Managed app export requires the managed app control plane to be available.',
                },
            });
        }

        const extractedSite = extractArtifactSiteFilesForManagedApp(artifact);
        if (extractedSite.invalidSiteBundle) {
            return res.status(422).json({
                error: {
                    code: 'ARTIFACT_MANAGED_APP_INVALID_SITE_BUNDLE',
                    message: 'Push to Web cannot safely promote this site because its declared native bundle could not be preserved exactly.',
                    blocker: 'invalid_site_bundle',
                    details: {
                        reason: extractedSite.invalidSiteBundle.reason,
                        ...(extractedSite.invalidSiteBundle.affectedMembers.length > 0
                            ? { affectedMembers: extractedSite.invalidSiteBundle.affectedMembers }
                            : {}),
                        remediation: 'Regenerate the site ZIP so every declared file is present at a safe relative path, then retry Push to Web.',
                    },
                },
            });
        }
        if (extractedSite.unsupportedBinaryAssets.length > 0) {
            return res.status(422).json({
                error: {
                    code: 'ARTIFACT_MANAGED_APP_UNSUPPORTED_BINARY_ASSETS',
                    message: 'Push to Web cannot safely promote this site because the managed-app repository lane cannot preserve one or more binary assets.',
                    blocker: 'unsupported_binary_assets',
                    details: {
                        unsupportedAssets: extractedSite.unsupportedBinaryAssets,
                        remediation: 'Replace these assets with SVG/XML/text equivalents or add binary repository-file support before deploying this bundle.',
                    },
                },
            });
        }
        const files = await Promise.all(extractedSite.files.map(async (file) => ({
            ...file,
            content: (await rehydratePreviewBuffer(Buffer.from(file.content || '', 'utf8'), artifact, req, {
                contentType: resolveFrontendBundleContentType(file.path),
                path: file.path,
            })).toString('utf8'),
        })));
        if (files.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'This artifact does not contain deployable website files.',
                },
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

        res.status(202).json({
            artifactId: artifact.id,
            fileCount: files.length,
            files: files.map((file) => file.path),
            ...result,
            publicHost: publicHost || result?.publicHost || result?.app?.publicHost || null,
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
