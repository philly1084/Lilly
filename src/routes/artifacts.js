const { Router } = require('express');
const path = require('path').posix;
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
const DEPLOYABLE_TEXT_EXTENSIONS = new Set([
    '.css',
    '.csv',
    '.html',
    '.htm',
    '.js',
    '.jsx',
    '.json',
    '.md',
    '.mjs',
    '.svg',
    '.txt',
    '.ts',
    '.tsx',
    '.xml',
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
    if (!session) {
        return null;
    }

    return artifact;
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

function isDeployableTextFile(filePath = '') {
    const extension = path.extname(String(filePath || '').toLowerCase());
    return DEPLOYABLE_TEXT_EXTENSIONS.has(extension)
        || String(filePath || '').startsWith('.gitea/workflows/')
        || String(filePath || '') === '.gitlab-ci.yml';
}

function extractArtifactSiteFilesForManagedApp(artifact = {}) {
    const files = new Map();

    try {
        const entries = readFrontendBundleArchive(artifact.contentBuffer || Buffer.alloc(0));
        entries.forEach((buffer, filePath) => {
            const sourcePath = normalizeBundlePath(filePath);
            const targetPath = normalizeManagedAppPublicPath(sourcePath);
            if (!sourcePath || !targetPath || !isDeployableTextFile(sourcePath)) {
                return;
            }
            files.set(targetPath, {
                path: targetPath,
                content: buffer.toString('utf8'),
            });
        });
    } catch (_error) {
        // Non-zip HTML artifacts are handled from metadata or previewHtml below.
    }

    const bundle = getArtifactFrontendBundle(artifact);
    if (Array.isArray(bundle?.files)) {
        bundle.files.forEach((file) => {
            const sourcePath = normalizeBundlePath(file?.path || '');
            const targetPath = normalizeManagedAppPublicPath(sourcePath);
            if (!sourcePath || !targetPath || !isDeployableTextFile(sourcePath)) {
                return;
            }

            const content = typeof file.content === 'string'
                ? file.content
                : (Buffer.isBuffer(file.contentBuffer) ? file.contentBuffer.toString('utf8') : '');
            if (content.trim()) {
                files.set(targetPath, { path: targetPath, content });
            }
        });
    }

    if (files.size === 0 && String(artifact.previewHtml || '').trim()) {
        files.set('public/index.html', {
            path: 'public/index.html',
            content: artifact.previewHtml,
        });
    }

    return Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path));
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

        const files = await Promise.all(extractArtifactSiteFilesForManagedApp(artifact).map(async (file) => ({
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
