import { useEffect, useState } from 'react';

type PreviewTokenResponse = {
  token?: string | null;
  expiresAt?: number | null;
  authRequired?: boolean;
};

export type WorkspacePreviewAccess = {
  status: 'idle' | 'resolving' | 'ready' | 'error';
  url: string;
  error: string;
};

function browserOrigin() {
  return typeof window === 'undefined' ? 'http://lilly.local' : window.location.origin;
}

function workspacePreviewMatch(pathname: string) {
  return pathname.match(/^(\/api\/sandbox-workspaces\/[a-zA-Z0-9_-]+)\/(?:sandbox|preview|sandbox-access\/[^/]+|preview-access\/[^/]+)\/?$/i);
}

export function isWorkspacePreviewUrl(rawUrl: string) {
  try {
    const origin = browserOrigin();
    const parsed = new URL(rawUrl, origin);
    return parsed.origin === origin && Boolean(workspacePreviewMatch(parsed.pathname));
  } catch (_error) {
    return false;
  }
}

/**
 * Game Studio already applies an iframe sandbox, so its player must be loaded
 * directly rather than through the generic nested sandbox shell. In an
 * authenticated deployment the signed path also gives opaque-origin module
 * requests a credential that does not depend on cookies or parent headers.
 */
export function rewriteWorkspacePreviewUrl(rawUrl: string, token = '') {
  try {
    const origin = browserOrigin();
    const parsed = new URL(rawUrl, origin);
    const match = parsed.origin === origin ? workspacePreviewMatch(parsed.pathname) : null;
    if (!match) return rawUrl;

    const normalizedToken = String(token || '').trim();
    parsed.pathname = normalizedToken
      ? `${match[1]}/preview-access/${encodeURIComponent(normalizedToken)}/`
      : `${match[1]}/preview/`;
    return rawUrl.startsWith('/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  } catch (_error) {
    return rawUrl;
  }
}

export async function resolveWorkspacePreviewUrl(rawUrl: string, fetchImpl: typeof fetch = fetch) {
  if (!isWorkspacePreviewUrl(rawUrl)) return rawUrl;

  const directPreviewUrl = rewriteWorkspacePreviewUrl(rawUrl);
  const response = await fetchImpl('/api/auth/ws-token', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'Private preview access expired. Refresh the editor and sign in again.'
      : `Private preview access failed (${response.status}).`);
  }

  const payload = await response.json() as PreviewTokenResponse;
  if (payload.authRequired === false) return directPreviewUrl;
  const token = String(payload.token || '').trim();
  if (!token) throw new Error('Private preview access did not return a signed token.');
  return rewriteWorkspacePreviewUrl(rawUrl, token);
}

export function useWorkspacePreviewAccess(rawUrl: string, enabled = true): WorkspacePreviewAccess {
  const [state, setState] = useState<WorkspacePreviewAccess>(() => ({
    status: enabled ? 'resolving' : 'idle',
    url: '',
    error: '',
  }));

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setState({ status: 'idle', url: '', error: '' });
      return () => { active = false; };
    }

    setState({ status: 'resolving', url: '', error: '' });
    resolveWorkspacePreviewUrl(rawUrl)
      .then((url) => {
        if (active) setState({ status: 'ready', url, error: '' });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', url: '', error: error instanceof Error ? error.message : 'Private preview access failed.' });
      });
    return () => { active = false; };
  }, [enabled, rawUrl]);

  return state;
}
