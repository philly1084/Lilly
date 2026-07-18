const { Router } = require('express');
const fs = require('fs/promises');
const path = require('path');
const {
  injectBundleBaseHref,
  resolveFrontendBundleContentType,
  rewriteRootRelativeFrontendPaths,
} = require('../frontend-bundles');
const {
  normalizeSandboxWorkspaceId,
  resolveSandboxWorkspacePath,
} = require('../sandbox-workspace-storage');

const router = Router();

function escapeHtmlAttribute(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function applyPreviewHeaders(res, contentType) {
  removeFrameBlockingHeaders(res);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Origin-Agent-Cluster', '?0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=()');
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

function applyShellHeaders(res) {
  removeFrameBlockingHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Origin-Agent-Cluster', '?0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
  // Workspace previews are loaded through a sandboxed wrapper iframe. A
  // inherited X-Frame-Options: SAMEORIGIN header blocks the nested preview
  // because the wrapper has an opaque sandbox origin.
  res.removeHeader('X-Frame-Options');
}

function resolveWorkspaceFile(workspaceId = '', requestedPath = '') {
  const workspacePath = resolveSandboxWorkspacePath(workspaceId);
  if (!workspacePath) {
    return null;
  }

  const normalizedRequest = String(requestedPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  const relativePath = normalizedRequest || 'index.html';
  const filePath = path.resolve(workspacePath, relativePath);
  const relativeCheck = path.relative(workspacePath, filePath);

  if (!relativeCheck || relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    return null;
  }

  return {
    workspacePath,
    filePath,
    relativePath,
  };
}

function buildWorkspacePreviewPath(workspaceId = '', previewAccessToken = '', relativePath = '') {
  const normalizedPath = String(relativePath || '').trim().replace(/^\/+/, '');
  const token = String(previewAccessToken || '').trim();
  const base = token
    ? `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/preview-access/${encodeURIComponent(token)}/`
    : `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/preview/`;
  return normalizedPath ? `${base}${normalizedPath}` : base;
}

function buildSandboxShell(workspaceId = '', previewAccessToken = '') {
  const previewSrc = buildWorkspacePreviewPath(workspaceId, previewAccessToken);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox Workspace Preview</title>
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
    title="Sandbox workspace preview"
    loading="eager"
    referrerpolicy="no-referrer"
    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
  ></iframe>
</main>
</body>
</html>`;
}

function buildPreviewBasePath(workspaceId = '') {
  return `/api/sandbox-workspaces/${encodeURIComponent(workspaceId)}/preview`;
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

function preparePreviewBuffer(workspaceId = '', relativePath = '', buffer = Buffer.alloc(0), previewAccessToken = '') {
  if (!/\.(?:html?|css|svg|js|mjs)$/i.test(relativePath)) {
    return buffer;
  }

  const previewBasePath = previewAccessToken
    ? buildWorkspacePreviewPath(workspaceId, previewAccessToken).replace(/\/$/, '')
    : buildPreviewBasePath(workspaceId);
  let content = rewriteRootRelativeFrontendPaths(buffer.toString('utf8'), previewBasePath);

  if (/\.html?$/i.test(relativePath)) {
    content = injectBundleBaseHref(content, `${previewBasePath}/`);
  }

  content = appendAccessTokenToInternalArtifactUrls(content, previewAccessToken);
  return Buffer.from(content, 'utf8');
}

router.get('/:workspaceId/sandbox', async (req, res, next) => {
  return serveSandboxShell(req, res, next);
});

router.get('/:workspaceId/sandbox-access/:previewAccessToken', async (req, res, next) => {
  return serveSandboxShell(req, res, next, req.params.previewAccessToken);
});

async function serveSandboxShell(req, res, next, previewAccessToken = '') {
  try {
    const workspaceId = normalizeSandboxWorkspaceId(req.params.workspaceId);
    if (!workspaceId) {
      return res.status(404).json({ error: { message: 'Sandbox workspace not found' } });
    }

    const workspacePath = resolveSandboxWorkspacePath(workspaceId);
    await fs.access(workspacePath);
    applyShellHeaders(res);
    res.send(buildSandboxShell(workspaceId, previewAccessToken));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: { message: 'Sandbox workspace not found' } });
    }
    next(error);
  }
}

async function servePreviewFile(req, res, next, previewAccessToken = '') {
  try {
    const resolved = resolveWorkspaceFile(req.params.workspaceId, req.params[0] || '');
    if (!resolved) {
      return res.status(404).json({ error: { message: 'Preview file not found' } });
    }

    const rawBuffer = await fs.readFile(resolved.filePath);
    const buffer = preparePreviewBuffer(req.params.workspaceId, resolved.relativePath, rawBuffer, previewAccessToken);
    applyPreviewHeaders(res, resolveFrontendBundleContentType(resolved.relativePath));
    res.send(buffer);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      return res.status(404).json({ error: { message: 'Preview file not found' } });
    }
    next(error);
  }
}

router.get('/:workspaceId/preview', servePreviewFile);
router.get('/:workspaceId/preview-access/:previewAccessToken', (req, res, next) => servePreviewFile(req, res, next, req.params.previewAccessToken));
router.get('/:workspaceId/preview-access/:previewAccessToken/*', (req, res, next) => servePreviewFile(req, res, next, req.params.previewAccessToken));
router.get('/:workspaceId/preview/*', servePreviewFile);

module.exports = router;
