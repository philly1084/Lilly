/**
 * Artifacts Module - Simplified version that works with FileManager
 * Handles file upload toolbar and generated file display
 */

(function() {
    const API_BASE = window.location.protocol === 'file:'
        ? 'http://localhost:3000'
        : `${window.location.protocol}//${window.location.host}`;
    const gatewayStreamHelpers = window.KimiBuiltGatewaySSE || {};
    const DEFAULT_CHAT_MODEL = gatewayStreamHelpers.DEFAULT_CODEX_MODEL_ID || 'auto';
    const REMOTE_BUILD_AUTONOMY_STORAGE_KEY = 'kimibuilt_remote_build_autonomy';
    const remoteArtifactWorkflow = window.KimiBuiltRemoteArtifactWorkflow || {};
    const DEFAULT_PUBLIC_WEB_DOMAIN = remoteArtifactWorkflow.DEFAULT_PUBLIC_WEB_DOMAIN || 'demoserver2.buzz';

    function isRemoteBuildAutonomyApproved() {
        try {
            const stored = window.sessionManager?.safeStorageGet?.(REMOTE_BUILD_AUTONOMY_STORAGE_KEY)
                ?? '';
            const normalized = String(stored || '').trim().toLowerCase();
            if (!normalized) {
                return true;
            }
            if (['0', 'false', 'no', 'off'].includes(normalized)) {
                return false;
            }
            return ['1', 'true', 'yes', 'on'].includes(normalized);
        } catch (_error) {
            return true;
        }
    }

    const state = {
        artifacts: [],
        selectedArtifactIds: [],
        outputFormat: '',
        lastDone: null,
    };
    let previewAccessTokenCache = null;
    let fetchArtifactsInFlight = null;
    let fetchArtifactsBackoffUntil = 0;
    let fetchArtifactsQueued = false;

    function getCurrentSessionId() {
        return String(window.sessionManager?.currentSessionId || window.apiClient?.getSessionId?.() || '').trim();
    }

    function resolveApiUrl(urlPath = '', { absolute = false } = {}) {
        const normalized = String(urlPath || '').trim();
        if (!normalized) return '';
        if (/^https?:\/\//i.test(normalized) || normalized.startsWith('blob:') || normalized.startsWith('data:')) {
            return normalized;
        }

        const relativePath = normalized.startsWith('/') ? normalized : `/${normalized}`;
        return absolute ? `${API_BASE}${relativePath}` : relativePath;
    }

    function normalizeArtifactRecord(artifact = null) {
        if (!artifact || typeof artifact !== 'object') {
            return null;
        }
        const id = String(artifact.id || artifact.artifactId || artifact.artifact_id || '').trim();
        if (!id) {
            return null;
        }
        const normalized = {
            ...artifact,
            id,
            filename: artifact.filename || artifact.fileName || artifact.file_name || artifact.name || id,
        };
        const fieldPairs = [
            ['artifactId', 'artifact_id'],
            ['mimeType', 'mime_type'],
            ['sizeBytes', 'size_bytes'],
            ['downloadUrl', 'download_url'],
            ['previewUrl', 'preview_url'],
            ['sandboxUrl', 'sandbox_url'],
            ['bundleDownloadUrl', 'bundle_download_url'],
        ];
        fieldPairs.forEach(([camelKey, snakeKey]) => {
            if (normalized[camelKey] === undefined && artifact[snakeKey] !== undefined) {
                normalized[camelKey] = artifact[snakeKey];
            }
        });
        return normalized;
    }

    function normalizeArtifactList(artifacts = []) {
        return (Array.isArray(artifacts) ? artifacts : [])
            .map((artifact) => normalizeArtifactRecord(artifact))
            .filter(Boolean);
    }

    async function getPreviewAccessToken() {
        const now = Date.now();
        if (
            previewAccessTokenCache?.token
            && Number(previewAccessTokenCache.expiresAt || 0) * 1000 > now + 30000
        ) {
            return previewAccessTokenCache.token;
        }

        const response = await fetch(resolveApiUrl('/api/auth/ws-token', { absolute: true }), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`Preview authentication failed (${response.status})`);
        }

        const data = await response.json().catch(() => ({}));
        const token = String(data?.token || '').trim();
        if (!token) {
            return '';
        }

        previewAccessTokenCache = {
            token,
            expiresAt: Number(data?.expiresAt || 0),
        };
        return token;
    }

    function applyPreviewAccessToken(urlPath = '', token = '') {
        const accessToken = String(token || '').trim();
        if (!accessToken) {
            return resolveApiUrl(urlPath, { absolute: true });
        }

        try {
            const parsed = new URL(resolveApiUrl(urlPath, { absolute: true }), window.location.href);
            if (/\/api\/artifacts\/[^/]+\/sandbox(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/sandbox\/?$/i, `/sandbox-access/${encodeURIComponent(accessToken)}`);
                return parsed.toString();
            }
            if (/\/api\/artifacts\/[^/]+\/preview(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/preview\/?$/i, `/preview-access/${encodeURIComponent(accessToken)}/`);
                return parsed.toString();
            }
            if (/\/api\/sandbox-workspaces\/[^/]+\/sandbox(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/sandbox\/?$/i, `/sandbox-access/${encodeURIComponent(accessToken)}`);
                return parsed.toString();
            }
            if (/\/api\/sandbox-workspaces\/[^/]+\/preview(?:\/)?$/i.test(parsed.pathname)) {
                parsed.pathname = parsed.pathname.replace(/\/preview\/?$/i, `/preview-access/${encodeURIComponent(accessToken)}/`);
                return parsed.toString();
            }
            if (parsed.pathname.startsWith('/api/artifacts/') && !parsed.searchParams.has('access_token')) {
                parsed.searchParams.set('access_token', accessToken);
            }
            return parsed.toString();
        } catch (_error) {
            const absoluteUrl = resolveApiUrl(urlPath, { absolute: true });
            const separator = absoluteUrl.includes('?') ? '&' : '?';
            return `${absoluteUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
        }
    }

    async function resolveAuthenticatedPreviewUrl(urlPath = '') {
        const token = await getPreviewAccessToken();
        return applyPreviewAccessToken(urlPath, token);
    }

    function isCurrentSessionId(sessionId = '') {
        const normalizedSessionId = String(sessionId || '').trim();
        return Boolean(normalizedSessionId) && normalizedSessionId === getCurrentSessionId();
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* Compact artifact toolbar - replaces the growing box */
            .artifact-toolbar-compact {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 8px 0;
                background: transparent;
                border: 0;
                border-radius: 8px;
                margin-top: 6px;
            }
            
            .artifact-toolbar-compact .toolbar-btn {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 9px;
                border: 1px solid transparent;
                background: transparent;
                color: var(--text-secondary);
                font-size: 13px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
                white-space: nowrap;
            }
            
            .artifact-toolbar-compact .toolbar-btn:hover {
                border-color: var(--accent);
                color: var(--text-primary);
                background: color-mix(in srgb, var(--accent) 8%, transparent);
            }
            
            .artifact-toolbar-compact .toolbar-btn.primary {
                background: color-mix(in srgb, var(--accent) 11%, transparent);
                color: var(--accent);
                border-color: color-mix(in srgb, var(--accent) 30%, transparent);
                font-weight: 700;
            }
            
            .artifact-toolbar-compact .toolbar-btn.primary:hover {
                background: color-mix(in srgb, var(--accent) 17%, transparent);
                opacity: 1;
            }
            
            .artifact-toolbar-compact .toolbar-divider {
                width: 1px;
                height: 24px;
                background: var(--border);
                margin: 0 4px;
            }
            
            .artifact-toolbar-compact .selected-count {
                font-size: 12px;
                color: var(--text-tertiary);
                padding: 0 4px;
            }
            
            /* Selected files indicator */
            .artifact-selected-chips {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 8px;
                max-height: 80px;
                overflow-y: auto;
            }

            body.layout-minimal .artifact-toolbar-compact {
                width: max-content;
                max-width: 100%;
                margin: 8px auto 0;
                padding: 0;
                gap: 6px;
                border: 0;
                background: transparent;
            }

            body.layout-minimal .artifact-toolbar-compact .toolbar-btn {
                width: 36px;
                height: 36px;
                justify-content: center;
                padding: 0;
                border-radius: 10px;
                background: color-mix(in srgb, var(--bg-tertiary) 78%, transparent);
            }

            body.layout-minimal .artifact-toolbar-compact .toolbar-btn.primary {
                background: color-mix(in srgb, var(--bg-tertiary) 78%, transparent);
                color: var(--text-secondary);
                border-color: var(--border);
                font-weight: 400;
            }

            body.layout-minimal .artifact-toolbar-compact .toolbar-btn.primary:hover {
                border-color: var(--accent);
                color: var(--text-primary);
                opacity: 1;
            }

            body.layout-minimal .artifact-toolbar-compact .toolbar-btn span,
            body.layout-minimal .artifact-toolbar-compact .toolbar-divider,
            body.layout-minimal .artifact-toolbar-compact .selected-count {
                display: none;
            }

            body.layout-minimal .artifact-selected-chips:empty {
                display: none;
            }
            
            .artifact-selected-chip {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                background: rgba(56, 189, 248, 0.15);
                border: 1px solid rgba(56, 189, 248, 0.3);
                border-radius: 16px;
                font-size: 12px;
                color: var(--text-primary);
            }
            
            .artifact-selected-chip button {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 16px;
                height: 16px;
                border: none;
                background: transparent;
                color: var(--text-secondary);
                cursor: pointer;
                border-radius: 50%;
                margin-left: 2px;
            }
            
            .artifact-selected-chip button:hover {
                background: rgba(255, 255, 255, 0.1);
                color: var(--text-primary);
            }
            
            /* Generated artifact card in chat */
            .artifact-generated-card {
                border: 1px solid rgba(56, 189, 248, 0.3);
                border-radius: 12px;
                padding: 16px;
                margin-top: 12px;
                background: rgba(56, 189, 248, 0.05);
            }
            
            .artifact-generated-card .file-icon {
                width: 40px;
                height: 40px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 12px;
            }
            
            .artifact-generated-card .file-icon.docx { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
            .artifact-generated-card .file-icon.pdf { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
            .artifact-generated-card .file-icon.pptx { background: rgba(234, 88, 12, 0.15); color: #ea580c; }
            .artifact-generated-card .file-icon.html { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
            .artifact-generated-card .file-icon.image { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
            .artifact-generated-card .file-icon.code { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
            .artifact-generated-card .file-icon.mermaid { background: rgba(255, 193, 7, 0.15); color: #ffc107; }
            .artifact-generated-card .file-icon.svg { background: rgba(0, 188, 212, 0.15); color: #00bcd4; }
            
            .artifact-generated-card h4 {
                font-weight: 600;
                margin-bottom: 4px;
            }
            
            .artifact-generated-card .file-meta {
                font-size: 13px;
                color: var(--text-secondary);
                margin-bottom: 12px;
            }

            .artifact-generated-card .artifact-mermaid-preview {
                margin-bottom: 12px;
            }

            .artifact-generated-card .artifact-mermaid-preview .mermaid-render-surface {
                min-height: 220px;
            }

            .artifact-generated-card .artifact-html-preview {
                margin-bottom: 12px;
                border: 1px solid rgba(245, 158, 11, 0.22);
                border-radius: 12px;
                overflow: hidden;
                background: rgba(15, 23, 42, 0.06);
            }

            .artifact-generated-card .artifact-html-preview-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 8px 10px;
                border-bottom: 1px solid rgba(245, 158, 11, 0.18);
                color: var(--text-secondary);
                font-size: 12px;
                font-weight: 650;
            }

            .artifact-generated-card .artifact-html-preview-actions {
                display: inline-flex;
                gap: 6px;
            }

            .artifact-generated-card .artifact-html-preview-status {
                color: var(--text-tertiary);
                font-size: 11px;
                font-weight: 600;
            }

            .artifact-generated-card .artifact-html-preview-stage {
                min-height: 180px;
                display: grid;
                place-items: center;
                padding: 10px;
                color: var(--text-secondary);
                font-size: 13px;
            }

            .artifact-generated-card .artifact-html-preview iframe {
                display: block;
                width: 100%;
                height: 320px;
                border: none;
                background: #ffffff;
            }

            .artifact-generated-card .artifact-html-preview.is-loading .artifact-html-preview-stage,
            .artifact-generated-card .artifact-html-preview.is-error .artifact-html-preview-stage {
                background: rgba(15, 23, 42, 0.08);
            }

            .artifact-generated-card .artifact-html-preview.is-error .artifact-html-preview-stage {
                color: var(--error);
            }

            .artifact-generated-card .artifact-image-preview {
                margin-bottom: 12px;
                border: 1px solid rgba(168, 85, 247, 0.24);
                border-radius: 12px;
                overflow: hidden;
                background: rgba(15, 23, 42, 0.08);
            }

            .artifact-generated-card .artifact-image-preview img {
                display: block;
                width: 100%;
                max-height: min(420px, 62vh);
                object-fit: contain;
                background: #0f172a;
            }

            .artifact-generated-card .artifact-text-preview {
                margin-bottom: 12px;
                max-height: 220px;
                overflow: auto;
                padding: 12px;
                border: 1px solid rgba(148, 163, 184, 0.24);
                border-radius: 12px;
                background: rgba(15, 23, 42, 0.08);
                color: var(--text-primary);
                font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                white-space: pre-wrap;
            }

            .artifact-generated-card .artifact-privacy-preview-note {
                margin-bottom: 12px;
                padding: 12px;
                border: 1px solid rgba(14, 165, 233, 0.24);
                border-radius: 12px;
                background: rgba(14, 165, 233, 0.08);
                color: var(--text-secondary);
                font-size: 13px;
                line-height: 1.45;
            }

            .site-preview-modal {
                position: fixed;
                inset: 0;
                z-index: 1000;
                display: grid;
                grid-template-rows: 52px minmax(0, 1fr);
                background: #0b1020;
            }

            .site-preview-modal[hidden] {
                display: none;
            }

            .site-preview-toolbar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                border-bottom: 1px solid rgba(148, 163, 184, 0.26);
                background: rgba(15, 23, 42, 0.96);
                color: #e5e7eb;
            }

            .site-preview-toolbar button {
                width: 36px;
                height: 36px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid rgba(148, 163, 184, 0.32);
                border-radius: 8px;
                background: rgba(30, 41, 59, 0.86);
                color: #e5e7eb;
                cursor: pointer;
            }

            .site-preview-toolbar button:hover {
                border-color: rgba(56, 189, 248, 0.7);
                color: #ffffff;
            }

            .site-preview-title {
                min-width: 0;
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 13px;
                font-weight: 650;
            }

            .site-preview-modal iframe {
                display: block;
                width: 100%;
                height: 100%;
                border: 0;
                background: #ffffff;
            }
            
            .artifact-generated-card .file-actions {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            
            .artifact-generated-card .file-actions button {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px 14px;
                border: 1px solid var(--border);
                background: var(--bg-secondary);
                color: var(--text-primary);
                font-size: 13px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
            }
            
            .artifact-generated-card .file-actions button:hover {
                border-color: var(--accent);
            }
            
            .artifact-generated-card .file-actions button.primary {
                background: var(--accent);
                color: white;
                border-color: var(--accent);
            }

            .artifact-generated-card .file-actions button.is-secondary {
                background: rgba(255, 255, 255, 0.035);
            }
            
            @media (max-width: 640px) {
                .artifact-toolbar-compact {
                    flex-wrap: wrap;
                }
                
                .artifact-toolbar-compact .toolbar-btn span {
                    display: none;
                }
                
                .artifact-toolbar-compact .toolbar-btn {
                    padding: 6px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    async function ensureSession() {
        if (window.sessionManager?.currentSessionId) {
            return window.sessionManager.currentSessionId;
        }
        if (window.chatApp?.createNewSession) {
            await window.chatApp.createNewSession();
            return window.sessionManager.currentSessionId;
        }
        return null;
    }

    async function fetchArtifacts() {
        const sessionId = getCurrentSessionId();
        if (!sessionId || window.sessionManager?.isLocalSession?.(sessionId)) {
            state.artifacts = [];
            renderSelectedChips();
            return;
        }

        const now = Date.now();
        if (fetchArtifactsInFlight) {
            fetchArtifactsQueued = true;
            return fetchArtifactsInFlight;
        }
        if (fetchArtifactsBackoffUntil > now) {
            fetchArtifactsQueued = true;
            return null;
        }

        fetchArtifactsInFlight = (async () => {
            const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/artifacts`);
            if (response.status === 429) {
                const retryAfter = Math.max(2, Math.min(30, Number(response.headers.get('Retry-After')) || 5));
                fetchArtifactsBackoffUntil = Date.now() + (retryAfter * 1000);
                fetchArtifactsQueued = true;
                return;
            }
            if (response.status === 404 || response.status === 503) {
                if (!isCurrentSessionId(sessionId)) {
                    return;
                }
                state.artifacts = [];
                renderSelectedChips();
                return;
            }
            if (!response.ok) return;
            const data = await response.json();
            if (!isCurrentSessionId(sessionId)) {
                return;
            }
            state.artifacts = normalizeArtifactList(data.artifacts);

            // Sync with file manager if available
            if (window.fileManager) {
                state.artifacts.forEach(artifact => {
                    window.fileManager.addFile(artifact, { sessionId });
                });
            }

            renderSelectedChips();
        })();

        try {
            await fetchArtifactsInFlight;
        } catch (error) {
            console.error('[Artifacts] Failed to fetch:', error);
        } finally {
            fetchArtifactsInFlight = null;
            if (fetchArtifactsQueued) {
                fetchArtifactsQueued = false;
                const delay = Math.max(0, fetchArtifactsBackoffUntil - Date.now());
                window.setTimeout(() => {
                    void fetchArtifacts();
                }, delay || 250);
            }
        }
    }

    function hasExplicitArtifactIntent(text = '') {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) return false;

        return /\b(export|download|save|convert|turn\b[\s\S]{0,20}\binto|turn\b[\s\S]{0,20}\bas|format\b[\s\S]{0,20}\bas)\b/i.test(normalized)
            || /\b(create|make|generate|build|produce|render|prepare|draft)\b[\s\S]{0,60}\b(file|artifact|document|page|report|brief|pdf|html|docx|xml|spreadsheet|excel|workbook|mermaid|diagram|flowchart|sequence diagram|erd|class diagram|state diagram)\b/i.test(normalized)
            || /\b(as|into|in)\s+(?:an?\s+)?(?:pdf|html|docx|xml|spreadsheet|excel workbook|workbook|mermaid|mmd)\b/i.test(normalized)
            || /\b(pdf|html|docx|xml|spreadsheet|excel|workbook)\s+(?:file|document|artifact|export)\b/i.test(normalized);
    }

    function hasExplicitMermaidIntent(text = '') {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) return false;

        if (/\b(mermaid|\.mmd\b)\b/i.test(normalized)) {
            return hasExplicitArtifactIntent(normalized)
                || /\b(mermaid|mmd)\s+(?:file|artifact|diagram|chart|export)\b/i.test(normalized);
        }

        return /\b(create|make|generate|build|produce|render|export|draw)\b[\s\S]{0,60}\b(diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram)\b/i.test(normalized)
            || /\b(diagram|flowchart|sequence diagram|erd|entity relationship|class diagram|state diagram)\s+(?:file|artifact|export)\b/i.test(normalized);
    }

    function hasExplicitHtmlArtifactIntent(text = '') {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) return false;

        return /\b(standalone html|html file|downloadable html|shareable html|html artifact|html export)\b/.test(normalized)
            || (/\bhtml\b/.test(normalized) && /\b(export|download|save|artifact|file|link|share|attachment)\b/.test(normalized));
    }

    function isInteractiveDocumentRequest(text = '') {
        const normalized = String(text || '')
            .trim()
            .toLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ');
        if (!normalized || /\b(text only|text-only|plain text|no html|without html|no website|not a website|no interactive|without interaction|static only)\b/.test(normalized)) {
            return false;
        }

        const hasResearchCue = /\b(research|sources?|citations?|latest|recent|current|news|headline|headlines|coverage|fact check|fact-check|verify|look up|web search|online|evidence)\b/.test(normalized);
        const hasDocumentCue = /\b(document|doc|report|brief|guide|research|case study|whitepaper|dossier|analysis|article|memo|note)\b/.test(normalized);
        const hasInteractiveCue = /\b(interactive|clickable|explorable|sortable|filterable|drill down|drilldown|animated|animation|motion|web native|browser native|website grade|website feel|site like|living document|rich document|evidence explorer|source explorer|source map)\b/.test(normalized);

        return /\binteractive\s+(?:document|doc|report|brief|research|guide|dossier|whitepaper|article|page)\b/.test(normalized)
            || /\b(?:document|doc|report|brief|research|guide|dossier|whitepaper|article|analysis)\b.{0,60}\b(?:interactive|clickable|explorable|animated|animation|motion|web native|browser native|website grade|website feel|site like|rich)\b/.test(normalized)
            || (/\b(?:website grade|website feel|web native|browser native|living document|rich document|interactive article|interactive essay)\b/.test(normalized) && hasDocumentCue)
            || (hasResearchCue && /\b(research dashboard|evidence explorer|source explorer|source map|visual report|microsite|web page|webpage|html page|browser page)\b/.test(normalized))
            || (hasResearchCue && hasDocumentCue && hasInteractiveCue);
    }

    function inferRequestedOutputFormat(messages = []) {
        const lastUserMessage = [...messages].reverse().find((message) => message?.role === 'user' && message?.content);
        const text = String(lastUserMessage?.content || '').toLowerCase();
        if (!text) return '';

        const hasArtifactIntent = hasExplicitArtifactIntent(text);
        const hasBuildIntent = /\b(create|make|generate|build|built|produce|render|prepare|draft)\b/.test(text);
        const hasWebsiteArtifactSubject = /\b(website|web page|webpage|html page|page|landing page|homepage|microsite|marketing site|frontend demo|front-end demo|site mockup|site prototype)\b/.test(text);
        const hasSandboxPreviewCue = /\b(sandbox|preview|browser preview|live preview|full screen preview|fullscreen preview)\b/.test(text);
        const hasExplicitHtmlCue = /\bhtml\b/.test(text);

        if ((/\b(power\s*query|\.(pq|m)\b)/.test(text) && hasArtifactIntent)
            || /\b(power\s*query)\s+(?:file|script|artifact|export)\b/.test(text)) {
            return 'power-query';
        }

        if ((/\b(xlsx|spreadsheet|excel|workbook)\b/.test(text) && hasArtifactIntent)
            || /\b(excel|spreadsheet|workbook)\s+(?:file|artifact|export)\b/.test(text)) {
            return 'xlsx';
        }

        if (isInteractiveDocumentRequest(text)) return 'html';
        if (/\bpdf\b/.test(text) && hasArtifactIntent) return 'pdf';
        if (/\b(docx|word document)\b/.test(text) && hasArtifactIntent) return 'html';
        if (/\bxml\b/.test(text) && hasArtifactIntent) return 'xml';
        if (hasExplicitMermaidIntent(text)) return 'mermaid';
        if (hasExplicitHtmlArtifactIntent(text)) return 'html';
        if (hasExplicitHtmlCue && (hasBuildIntent || hasSandboxPreviewCue || hasArtifactIntent)) return 'html';
        if (hasWebsiteArtifactSubject && hasBuildIntent && hasSandboxPreviewCue) return 'html';

        return '';
    }

    async function uploadArtifact(file) {
        const sessionId = await ensureSession();
        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('mode', 'chat');
        formData.append('file', file);

        const response = await fetch(resolveApiUrl('/api/artifacts/upload', { absolute: true }), {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `Upload failed (${response.status})`);
        }

        const artifact = normalizeArtifactRecord(await response.json().catch(() => null));
        await fetchArtifacts();
        if (artifact?.id) {
            upsertArtifact(artifact);
            selectArtifactForContext(artifact.id);
            renderUploadedArtifactsMessage([artifact]);
        }
        return artifact;
    }

    function upsertArtifact(artifact) {
        const normalizedArtifact = normalizeArtifactRecord(artifact);
        if (!normalizedArtifact?.id) return;
        state.artifacts = [
            normalizedArtifact,
            ...state.artifacts.filter((entry) => entry?.id !== normalizedArtifact.id),
        ];
        if (window.fileManager) {
            window.fileManager.addFile(normalizedArtifact, { sessionId: getCurrentSessionId() });
        }
    }

    function selectArtifactForContext(id = '') {
        const normalizedId = String(id || '').trim();
        if (!normalizedId || state.selectedArtifactIds.includes(normalizedId)) {
            return;
        }
        state.selectedArtifactIds.push(normalizedId);
        renderSelectedChips();
    }

    function normalizeArtifactOutputFormat(artifact = null) {
        const format = String(artifact?.format || artifact?.extension || '').trim().toLowerCase();
        if (artifact?.bundleDownloadUrl || artifact?.sandboxUrl || artifact?.previewUrl) {
            if (format === 'html' || format === 'htm' || artifact?.bundleDownloadUrl) {
                return 'html';
            }
        }
        if (['pdf', 'html', 'xml', 'xlsx', 'mermaid', 'power-query'].includes(format)) {
            return format;
        }
        if (format === 'docx' || format === 'doc') {
            return 'html';
        }
        if (format === 'mmd') {
            return 'mermaid';
        }
        return '';
    }

    function getArtifactIterationLabel(artifact = null) {
        const filename = String(artifact?.filename || '').toLowerCase();
        const format = normalizeArtifactOutputFormat(artifact);
        if (artifact?.bundleDownloadUrl || /\b(game|play|arcade)\b/.test(filename)) {
            return 'game/site';
        }
        if (format === 'html' && /\b(site|website|page|landing|frontend)\b/.test(filename)) {
            return 'site';
        }
        if (['pdf', 'html', 'xlsx', 'mermaid', 'power-query'].includes(format)) {
            return 'document';
        }
        return 'artifact';
    }

    function setComposerDraft(text = '') {
        const input = document.getElementById('message-input');
        if (!input) {
            return false;
        }
        input.value = String(text || '').trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        if (typeof input.setSelectionRange === 'function') {
            input.setSelectionRange(input.value.length, input.value.length);
        }
        window.uiHelpers?.scrollToBottom?.();
        return true;
    }

    function renderUploadedArtifactsMessage(artifacts = []) {
        const files = (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => artifact?.id);
        const sessionId = getCurrentSessionId();
        if (files.length === 0 || !sessionId || !window.sessionManager || !window.uiHelpers) {
            return;
        }

        const message = {
            id: window.uiHelpers.generateMessageId(),
            role: 'user',
            content: files.length === 1
                ? `Uploaded ${files[0].filename || 'a file'}`
                : `Uploaded ${files.length} files`,
            artifacts: files,
            excludeFromTranscript: true,
            metadata: {
                excludeFromTranscript: true,
                uploadedArtifactIds: files.map((artifact) => artifact.id),
            },
            timestamp: new Date().toISOString(),
        };
        const savedMessage = window.sessionManager.addMessage(sessionId, message);
        const container = document.getElementById('messages-container');
        if (container) {
            const messageEl = window.uiHelpers.renderMessage(savedMessage);
            container.appendChild(messageEl);
            window.uiHelpers.reinitializeIcons(messageEl);
            window.uiHelpers.renderMermaidDiagrams?.(messageEl);
            window.uiHelpers.scrollToBottom?.();
        }
    }

    function renderSelectedChips() {
        const container = document.getElementById('artifact-selected-chips');
        if (!container) return;

        if (state.selectedArtifactIds.length === 0) {
            container.innerHTML = '';
            updateSelectedCount();
            return;
        }

        container.innerHTML = state.selectedArtifactIds.map(id => {
            const artifact = state.artifacts.find(a => a.id === id);
            if (!artifact) return '';
            return `
                <div class="artifact-selected-chip">
                    <span>${escapeHtml(artifact.filename)}</span>
                    <button onclick="artifactManager.deselectArtifact('${id}')" title="Remove">
                        <i data-lucide="x" class="w-3 h-3"></i>
                    </button>
                </div>
            `;
        }).join('');

        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        updateSelectedCount();
    }

    function updateSelectedCount() {
        const countEl = document.getElementById('artifact-selected-count');
        if (countEl) {
            countEl.textContent = `${state.selectedArtifactIds.length} selected`;
        }
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function escapeHtmlAttr(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function getArtifactBaseName(filename = 'diagram') {
        return String(filename || 'diagram').replace(/\.[a-z0-9]+$/i, '');
    }

    function getMermaidSourceFromArtifact(artifact) {
        if (!artifact) return '';

        if (artifact.preview?.type === 'text') {
            return String(artifact.preview.content || '').trim();
        }

        if (artifact.preview?.type === 'html') {
            const div = document.createElement('div');
            div.innerHTML = artifact.preview.content || '';
            return String(div.textContent || '').trim();
        }

        if (typeof artifact.contentPreview === 'string' && artifact.contentPreview.trim()) {
            return String(artifact.contentPreview).trim();
        }

        if (typeof artifact.metadata?.mermaidSource === 'string' && artifact.metadata.mermaidSource.trim()) {
            return String(artifact.metadata.mermaidSource).trim();
        }

        return '';
    }

    function isMermaidArtifact(artifact = null) {
        const format = String(artifact?.format || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        return format === 'mermaid'
            || filename.endsWith('.mmd')
            || filename.endsWith('.mermaid');
    }

    function isImageArtifact(artifact = null) {
        const format = String(artifact?.format || '').toLowerCase();
        const mimeType = String(artifact?.mimeType || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        return mimeType.startsWith('image/')
            || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(format)
            || /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
    }

    function isPdfArtifact(artifact = null) {
        const format = String(artifact?.format || '').toLowerCase();
        const mimeType = String(artifact?.mimeType || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        return format === 'pdf' || mimeType.includes('pdf') || filename.endsWith('.pdf');
    }

    function isPrivacyPreviewSuppressed(artifact = null) {
        return artifact?.metadata?.privacyPreviewSuppressed === true
            || artifact?.metadata?.piiCleansing?.uploadPreviewSuppressed === true
            || artifact?.preview?.type === 'privacy-hidden';
    }

    function getArtifactImagePreviewUrl(artifact) {
        if (isPrivacyPreviewSuppressed(artifact)) {
            return '';
        }

        if (!isImageArtifact(artifact)) {
            return '';
        }

        const inlinePath = artifact?.inlinePath
            || artifact?.inlineUrl
            || artifact?.absoluteInlineUrl
            || (artifact?.downloadUrl ? `${artifact.downloadUrl}?inline=1` : '');
        return resolveApiUrl(inlinePath, { absolute: true });
    }

    function getArtifactTextPreview(artifact) {
        if (!artifact || isPrivacyPreviewSuppressed(artifact) || isMermaidArtifact(artifact) || isImageArtifact(artifact)) {
            return '';
        }
        const format = String(artifact.format || '').toLowerCase();
        const mimeType = String(artifact.mimeType || '').toLowerCase();
        const filename = String(artifact.filename || '').toLowerCase();
        const isStructuredText = ['csv', 'xml', 'power-query'].includes(format)
            || /\.(csv|xml|pq|m)$/i.test(filename);
        const isGenericText = ['txt', 'text', 'md', 'markdown'].includes(format)
            || mimeType === 'text/plain'
            || /\.(txt|md|markdown)$/i.test(filename);
        if (artifact.preview?.type === 'text' && !isGenericText && isStructuredText) {
            return String(artifact.preview.content || '').trim();
        }
        if (['csv', 'xml', 'power-query'].includes(format) && typeof artifact.contentPreview === 'string') {
            return artifact.contentPreview.trim();
        }
        return '';
    }

    function getFileIconClass(filename, artifact = null) {
        if (artifact?.previewUrl && artifact?.bundleDownloadUrl) {
            return 'html';
        }

        const ext = filename.split('.').pop()?.toLowerCase();
        const docExts = ['doc', 'docx'];
        const pdfExts = ['pdf'];
        const slideExts = ['ppt', 'pptx'];
        const htmlExts = ['html', 'htm'];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
        const diagramExts = ['mmd', 'mermaid'];
        
        if (docExts.includes(ext)) return 'docx';
        if (pdfExts.includes(ext)) return 'pdf';
        if (slideExts.includes(ext)) return 'pptx';
        if (htmlExts.includes(ext)) return 'html';
        if (imageExts.includes(ext)) return 'image';
        if (diagramExts.includes(ext)) return 'mermaid';
        return 'code';
    }

    function getFileIcon(filename, artifact = null) {
        if (artifact?.previewUrl && artifact?.bundleDownloadUrl) {
            return 'globe';
        }

        const ext = filename.split('.').pop()?.toLowerCase();
        const icons = {
            pdf: 'file-text',
            doc: 'file-type',
            docx: 'file-type',
            ppt: 'presentation',
            pptx: 'presentation',
            html: 'globe',
            htm: 'globe',
            jpg: 'image',
            jpeg: 'image',
            png: 'image',
            gif: 'image',
        };
        return icons[ext] || 'file';
    }

    function formatFileSize(bytes) {
        if (!bytes || bytes === 0) return 'Unknown size';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
    }

    function shouldCollapseArtifactTranscript(artifact) {
        if (artifact?.previewUrl) {
            return true;
        }

        const format = String(artifact?.format || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        const collapsibleFormats = new Set(['pdf', 'docx', 'xlsx', 'xml', 'html', 'mermaid', 'power-query', 'ppt', 'pptx']);
        const collapsibleExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.xml', '.html', '.htm', '.mmd', '.mermaid', '.pq', '.m', '.ppt', '.pptx'];
        return collapsibleFormats.has(format) || collapsibleExtensions.some((ext) => filename.endsWith(ext));
    }

    function buildArtifactSummary(artifacts) {
        const files = (artifacts || []).filter(shouldCollapseArtifactTranscript);
        if (files.length === 0) {
            return '';
        }

        const hasHtml = files.some((artifact) => {
            const format = String(artifact?.format || '').toLowerCase();
            const filename = String(artifact?.filename || '').toLowerCase();
            return Boolean(artifact?.previewUrl)
                || isMermaidArtifact(artifact)
                || format === 'html'
                || filename.endsWith('.html')
                || filename.endsWith('.htm');
        });
        const actionLabel = hasHtml ? 'Preview and Download below.' : 'Use Download below.';

        if (files.length === 1) {
            return `Created ${files[0].filename}. ${actionLabel}`;
        }

        return `Created ${files.length} files. ${actionLabel}`;
    }

    function getArtifactPreviewUrl(artifact, options = {}) {
        if (isPrivacyPreviewSuppressed(artifact)) {
            return '';
        }

        const absolute = options && options.absolute === true;
        const preferSandbox = options && options.sandbox === true;

        if (preferSandbox && artifact?.sandboxUrl) {
            return resolveApiUrl(artifact.sandboxUrl, { absolute });
        }

        if (artifact?.previewUrl) {
            return resolveApiUrl(artifact.previewUrl, { absolute });
        }

        const format = String(artifact?.format || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        const isHtmlLike = format === 'html' || filename.endsWith('.html') || filename.endsWith('.htm');
        if (!isHtmlLike) {
            return '';
        }

        if (!artifact?.downloadUrl) {
            return '';
        }

        const inlinePath = `${artifact.downloadUrl}?inline=1`;
        return resolveApiUrl(inlinePath, { absolute });
    }

    function findArtifactById(id = '') {
        const artifactId = String(id || '').trim();
        if (!artifactId) {
            return null;
        }

        const directArtifact = state.artifacts.find((entry) => entry?.id === artifactId)
            || state.lastDone?.artifacts?.find((entry) => entry?.id === artifactId);
        if (directArtifact) {
            return normalizeArtifactRecord(directArtifact);
        }

        const sessionId = getCurrentSessionId();
        const messages = window.sessionManager?.getMessages?.(sessionId) || [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index] || {};
            const messageArtifacts = [
                ...(Array.isArray(message.artifacts) ? message.artifacts : []),
                ...(Array.isArray(message.metadata?.artifacts) ? message.metadata.artifacts : []),
            ];
            const messageArtifact = messageArtifacts
                .map((entry) => normalizeArtifactRecord(entry))
                .find((entry) => entry?.id === artifactId);
            if (messageArtifact) {
                return messageArtifact;
            }
        }

        return normalizeArtifactRecord(window.fileManager?.files?.find?.((entry) => entry?.id === artifactId)) || null;
    }

    function isFullSitePreviewArtifact(artifact) {
        return Boolean(
            artifact?.bundleDownloadUrl
            || artifact?.preview?.type === 'site'
            || artifact?.metadata?.siteBundle,
        );
    }

    function isDeployableSiteArtifact(artifact) {
        if (!artifact?.id || !getArtifactPreviewUrl(artifact) || isPdfArtifact(artifact)) {
            return false;
        }

        const format = String(artifact?.format || artifact?.extension || '').toLowerCase();
        const mimeType = String(artifact?.mimeType || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        const metadata = artifact?.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
        return Boolean(
            artifact?.bundleDownloadUrl
            || artifact?.preview?.type === 'site'
            || metadata.siteBundle
            || metadata.bundle
            || metadata.type === 'frontend'
            || String(metadata.generationStrategy || '').includes('frontend')
            || ['html', 'htm'].includes(format)
            || mimeType.includes('text/html')
            || /\.(?:html?|xhtml)$/.test(filename),
        );
    }

    function shouldRenderInlineArtifactPreview(artifact) {
        if (!getArtifactPreviewUrl(artifact)) {
            return false;
        }

        if (isPdfArtifact(artifact)) {
            return false;
        }

        if (artifact?.bundleDownloadUrl || artifact?.preview?.type === 'site') {
            return false;
        }

        return true;
    }

    function getArtifactPreviewLabel(artifact = null) {
        const format = String(artifact?.format || '').toLowerCase();
        const mimeType = String(artifact?.mimeType || '').toLowerCase();
        const filename = String(artifact?.filename || '').toLowerCase();
        if (format === 'pdf' || mimeType.includes('pdf') || filename.endsWith('.pdf')) {
            return 'PDF preview';
        }
        return 'File preview';
    }

    function buildArtifactCardMarkup(artifact) {
        const normalizedArtifact = normalizeArtifactRecord(artifact) || {};
        artifact = normalizedArtifact;
        const artifactFilename = artifact.filename || artifact.fileName || artifact.file_name || artifact.name || artifact.id || 'artifact';
        const iconClass = getFileIconClass(artifactFilename, artifact);
        const iconName = getFileIcon(artifactFilename, artifact);
        const mermaidArtifact = isMermaidArtifact(artifact);
        const mermaidSource = mermaidArtifact ? getMermaidSourceFromArtifact(artifact) : '';
        const mermaidBaseName = getArtifactBaseName(artifactFilename);
        const mermaidDownloadUrl = mermaidArtifact && artifact?.downloadUrl
            ? resolveApiUrl(artifact.downloadUrl, { absolute: true })
            : '';
        const htmlPreviewUrl = getArtifactPreviewUrl(artifact);
        const inlineHtmlPreview = shouldRenderInlineArtifactPreview(artifact);
        const mermaidPreview = mermaidArtifact
            ? `
                <div class="artifact-mermaid-preview">
                    <div
                        class="mermaid-render-surface"
                        data-mermaid-source="${escapeHtmlAttr(mermaidSource)}"
                        data-mermaid-filename="${escapeHtmlAttr(mermaidBaseName)}"
                        data-mermaid-url="${escapeHtmlAttr(mermaidDownloadUrl)}"
                    >
                        <div class="mermaid-placeholder">Rendering diagram...</div>
                    </div>
                </div>
            `
            : '';
        const htmlPreview = inlineHtmlPreview
            ? `
                <div class="artifact-html-preview" data-preview-url="${escapeHtmlAttr(htmlPreviewUrl)}" data-preview-title="${escapeHtmlAttr(artifactFilename || 'Artifact preview')}">
                    <div class="artifact-html-preview-toolbar">
                        <span>${escapeHtml(getArtifactPreviewLabel(artifact))}</span>
                        <span class="artifact-html-preview-status">Loading</span>
                    </div>
                    <div class="artifact-html-preview-stage">
                        Loading page preview...
                    </div>
                </div>
            `
            : '';
        const imagePreviewUrl = getArtifactImagePreviewUrl(artifact);
        const imagePreview = imagePreviewUrl
            ? `
                <div class="artifact-image-preview">
                    <img
                        src="${escapeHtmlAttr(imagePreviewUrl)}"
                        alt="${escapeHtmlAttr(artifactFilename || 'Uploaded image')}"
                        loading="lazy"
                        onerror="uiHelpers.handleImageLoadError(this)"
                        referrerpolicy="no-referrer"
                        onclick="uiHelpers.openImageLightbox('${escapeHtmlAttr(imagePreviewUrl)}')"
                    >
                </div>
            `
            : '';
        const textPreviewContent = getArtifactTextPreview(artifact);
        const textPreview = textPreviewContent
            ? `<pre class="artifact-text-preview">${escapeHtml(textPreviewContent.slice(0, 2400))}</pre>`
            : '';
        const privacyPreviewNote = isPrivacyPreviewSuppressed(artifact)
            ? '<div class="artifact-privacy-preview-note">Preview hidden while PII protection is enabled. The file can still be used as protected context.</div>'
            : '';
        const mermaidActions = mermaidArtifact
            ? `
                <button
                    onclick="uiHelpers.downloadMermaidPdf(this)"
                    data-code="${escapeHtmlAttr(mermaidSource)}"
                    data-mermaid-url="${escapeHtmlAttr(mermaidDownloadUrl)}"
                    data-filename="${escapeHtmlAttr(mermaidBaseName)}.pdf"
                >
                    <i data-lucide="download" class="w-4 h-4"></i>
                    PDF
                </button>
            `
            : '';
        const htmlActions = htmlPreviewUrl
            ? `
                <button class="primary" onclick="artifactManager.openArtifactPreview('${artifact.id}')">
                    ${artifact?.bundleDownloadUrl ? 'Open Site' : 'Open Preview'}
                </button>
            `
            : '';
        const updateAction = `
            <button onclick="artifactManager.prepareArtifactUpdate('${artifact.id}')">
                Update
            </button>
        `;
        const deployActions = isDeployableSiteArtifact(artifact)
            ? `
                <button onclick="artifactManager.exportSiteToManagedApp('${artifact.id}')">
                    Push to Web
                </button>
            `
            : '';
        const contextAction = htmlPreviewUrl
            ? ''
            : `
                <button onclick="artifactManager.addToContext('${artifact.id}')">
                    Add to Context
                </button>
            `;
        const downloadLabel = artifact?.bundleDownloadUrl ? 'Bundle Zip' : 'Download';

        return `
            <div class="artifact-generated-card">
                <div class="file-icon ${iconClass}">
                    <i data-lucide="${iconName}" class="w-5 h-5"></i>
                </div>
                <h4>${escapeHtml(artifactFilename)}</h4>
                <div class="file-meta">
                    ${artifact.format?.toUpperCase() || 'FILE'} | ${formatFileSize(artifact.sizeBytes)}
                </div>
                ${imagePreview}
                ${mermaidPreview}
                ${htmlPreview}
                ${textPreview}
                ${privacyPreviewNote}
                <div class="file-actions">
                    ${htmlActions}
                    <button class="${htmlPreviewUrl ? 'is-secondary' : 'primary'}" onclick="artifactManager.downloadArtifact('${artifact.id}', '${escapeHtml(artifactFilename)}')">
                        ${downloadLabel}
                    </button>
                    ${mermaidActions}
                    ${deployActions}
                    ${updateAction}
                    ${contextAction}
                </div>
            </div>
        `;
    }

    function buildArtifactGalleryMarkup(artifacts = []) {
        return normalizeArtifactList(artifacts)
            .map((artifact) => buildArtifactCardMarkup(artifact))
            .join('');
    }

    function buildArtifactGalleryMessage(artifacts = [], parentMessageId = '') {
        const files = normalizeArtifactList(artifacts);
        if (files.length === 0) {
            return null;
        }

        return {
            id: parentMessageId ? `${parentMessageId}-artifacts` : uiHelpers.generateMessageId(),
            parentMessageId: parentMessageId || '',
            role: 'assistant',
            type: 'artifact-gallery',
            content: buildArtifactSummary(files) || `Generated ${files.length} file${files.length === 1 ? '' : 's'}.`,
            artifacts: files,
            excludeFromTranscript: true,
            timestamp: new Date().toISOString(),
        };
    }

    function looksLikeRawGeneratedArtifactText(value = '') {
        const source = String(value || '').trim();
        return /^\s*(?:```(?:html)?\s*)?(?:html\s+)?(?:<!doctype\s+html\b|<html\b)/i.test(source)
            || /```html\b[\s\S]*?(?:<!doctype\s+html\b|<html\b)[\s\S]*?```/i.test(source)
            || /\b(?:save|saved|saving|download|open)\b[\s\S]{0,80}?\b[a-z0-9][a-z0-9._ -]{1,100}\.html?\b/i.test(source);
    }

    function renderGeneratedArtifacts(artifacts) {
        const container = document.getElementById('messages-container');
        if (!container) return;

        normalizeArtifactList(artifacts).forEach((artifact) => {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buildArtifactCardMarkup(artifact);
            const card = wrapper.firstElementChild;
            if (!card) {
                return;
            }

            container.appendChild(card);

            if (window.fileManager) {
                window.fileManager.addFile(artifact, { sessionId: getCurrentSessionId() });
            }

            window.uiHelpers?.renderMermaidDiagrams?.(card);
            hydrateInlineArtifactPreviews(card);
        });

        container.scrollTop = container.scrollHeight;

        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    function startArtifactPreviewObserver() {
        if (window.__kimibuiltArtifactPreviewObserverStarted) {
            hydrateInlineArtifactPreviews(document);
            return;
        }

        window.__kimibuiltArtifactPreviewObserverStarted = true;
        hydrateInlineArtifactPreviews(document);
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes?.forEach?.((node) => {
                    if (node?.nodeType === 1) {
                        hydrateInlineArtifactPreviews(node);
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function injectToolbar() {
        const inputArea = document.querySelector('.input-area .max-w-4xl');
        if (!inputArea || document.getElementById('artifact-toolbar')) return;

        const toolbar = document.createElement('div');
        toolbar.id = 'artifact-toolbar';
        toolbar.className = 'artifact-toolbar-compact';
        toolbar.innerHTML = `
            <button class="toolbar-btn" type="button" title="Upload file" aria-label="Upload file" onclick="document.getElementById('artifact-file-input').click()">
                <i data-lucide="upload" class="w-4 h-4"></i>
                <span>Upload</span>
            </button>
            <button class="toolbar-btn primary" type="button" title="Open files" aria-label="Open files" onclick="fileManager.open()">
                <i data-lucide="folder-open" class="w-4 h-4"></i>
                <span>Files</span>
            </button>
            <span class="toolbar-divider"></span>
            <span id="artifact-selected-count" class="selected-count">0 selected</span>
            <input id="artifact-file-input" type="file" hidden multiple>
        `;
        
        inputArea.appendChild(toolbar);

        // Selected chips container
        const chipsContainer = document.createElement('div');
        chipsContainer.id = 'artifact-selected-chips';
        chipsContainer.className = 'artifact-selected-chips';
        inputArea.appendChild(chipsContainer);

        // Setup file input
        document.getElementById('artifact-file-input').addEventListener('change', async (event) => {
            const files = Array.from(event.target.files);
            if (files.length === 0) return;
            
            // Show loading toast
            if (window.uiHelpers?.showToast) {
                uiHelpers.showToast(`Uploading ${files.length} file(s)...`, 'info');
            }
            
            for (const file of files) {
                try {
                    await uploadArtifact(file);
                    if (window.uiHelpers?.showToast) {
                        uiHelpers.showToast(`Uploaded ${file.name}`, 'success');
                    }
                } catch (error) {
                    if (window.uiHelpers?.showToast) {
                        uiHelpers.showToast(error.message, 'error');
                    }
                }
            }
            
            event.target.value = '';
        });

        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    function overrideApiClient() {
        if (!window.apiClient) return;
        if (window.apiClient.__artifactStreamingPatched) return;

        window.apiClient.uploadArtifact = uploadArtifact;
        window.apiClient.listArtifacts = fetchArtifacts;
        const originalStreamChat = typeof window.apiClient.streamChat === 'function'
            ? window.apiClient.streamChat.bind(window.apiClient)
            : null;

        if (!originalStreamChat) {
            return;
        }

        window.apiClient.streamChat = async function*(messages, model = DEFAULT_CHAT_MODEL, signal = null, reasoningEffort = '', requestOptions = {}) {
            const nextRequestOptions = {
                ...(requestOptions && typeof requestOptions === 'object' ? requestOptions : {}),
            };

            if (isRemoteBuildAutonomyApproved()) {
                nextRequestOptions.metadata = {
                    ...(nextRequestOptions.metadata && typeof nextRequestOptions.metadata === 'object'
                        ? nextRequestOptions.metadata
                        : {}),
                    remoteBuildAutonomyApproved: true,
                };
            }

            const inferredOutputFormat = inferRequestedOutputFormat(messages);
            if (inferredOutputFormat && !nextRequestOptions.outputFormat) {
                nextRequestOptions.outputFormat = inferredOutputFormat;
            }

            if (state.selectedArtifactIds.length > 0) {
                nextRequestOptions.artifactIds = [...state.selectedArtifactIds];
            }

            const explicitOutputFormat = String(state.outputFormat || '').trim();
            if (explicitOutputFormat) {
                nextRequestOptions.outputFormat = explicitOutputFormat;
            }

            for await (const chunk of originalStreamChat(messages, model, signal, reasoningEffort, nextRequestOptions)) {
                if (chunk.type === 'done') {
                    state.lastDone = {
                        sessionId: chunk.sessionId || window.apiClient.currentSessionId || null,
                        artifacts: normalizeArtifactList(chunk.artifacts),
                    };
                }

                yield chunk;
            }
        };

        window.apiClient.__artifactStreamingPatched = true;
    }

    function patchApp() {
        if (!window.chatApp) return;

        const originalHandleDone = window.chatApp.handleDone?.bind(window.chatApp);
        window.chatApp.handleDone = function(...args) {
            if (originalHandleDone) originalHandleDone(...args);
            if (state.lastDone?.artifacts?.length) {
                const completedArtifactState = state.lastDone;
                const sessionId = String(completedArtifactState.sessionId || getCurrentSessionId()).trim();
                const isCurrentSession = isCurrentSessionId(sessionId);
                if (sessionId) {
                    const messages = window.sessionManager.getMessages(sessionId) || [];
                    const lastMessage = [...messages].reverse().find((message) => (
                        message
                        && message.role === 'assistant'
                        && message.syntheticUserCheckpoint !== true
                    ));
                    if (lastMessage && lastMessage.role === 'assistant') {
                        const artifactSummary = buildArtifactSummary(state.lastDone.artifacts);
                        const existingDisplayContent = String(lastMessage.displayContent || lastMessage.content || '');
                        const hasSurveyDisplay = typeof window.chatApp?.extractSurveyDefinition === 'function'
                            && Boolean(window.chatApp.extractSurveyDefinition(existingDisplayContent));
                        const hasAssistantText = Boolean(String(lastMessage.content || '').trim());
                        const hasRawArtifactText = looksLikeRawGeneratedArtifactText(lastMessage.content || '');
                        const shouldUseArtifactSummary = Boolean(artifactSummary && !hasSurveyDisplay && (!hasAssistantText || hasRawArtifactText));

                        if (shouldUseArtifactSummary) {
                            lastMessage.displayContent = artifactSummary;
                            if (hasRawArtifactText) {
                                lastMessage.content = artifactSummary;
                            }
                        } else if (!hasSurveyDisplay && String(lastMessage.displayContent || '').trim() === artifactSummary) {
                            delete lastMessage.displayContent;
                        }
                        lastMessage.artifacts = state.lastDone.artifacts
                            .filter((artifact) => artifact?.id && artifact?.downloadUrl);
                        const nextMetadata = {
                            ...(lastMessage.metadata && typeof lastMessage.metadata === 'object' ? lastMessage.metadata : {}),
                            ...(lastMessage.artifacts.length > 0 ? { artifacts: lastMessage.artifacts } : {}),
                        };
                        if (shouldUseArtifactSummary) {
                            nextMetadata.displayContent = artifactSummary;
                        } else if (!hasSurveyDisplay && String(nextMetadata.displayContent || '').trim() === artifactSummary) {
                            delete nextMetadata.displayContent;
                        }
                        lastMessage.metadata = nextMetadata;
                        window.sessionManager.saveToStorage?.();
                        if (isCurrentSession && lastMessage.id && window.chatApp?.renderOrReplaceMessage) {
                            window.chatApp.renderOrReplaceMessage(lastMessage);
                        }
                    }
                }
                if (isCurrentSession) {
                    state.artifacts = [
                        ...completedArtifactState.artifacts,
                        ...state.artifacts.filter((artifact) => !completedArtifactState.artifacts.find((next) => next.id === artifact.id)),
                    ];
                    completedArtifactState.artifacts.forEach((artifact) => {
                        window.fileManager?.addFile?.(artifact, { sessionId });
                    });
                    state.selectedArtifactIds = [];
                    state.outputFormat = '';
                    renderSelectedChips();
                }
                state.lastDone = null;
            } else {
                fetchArtifacts();
            }
        };
        
        // Handle errors better - don't immediately show red error on disconnect
        const originalHandleError = window.chatApp.handleError?.bind(window.chatApp);
        window.chatApp.handleError = function(error, status = null) {
            const normalizedMessage = String(error || '').toLowerCase();

            // Check if it's a network/connection error
            if (normalizedMessage.includes('fetch') ||
                normalizedMessage.includes('network') ||
                normalizedMessage.includes('failed to fetch') ||
                status === 0) {
                // Show a more user-friendly message
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('Connection interrupted. Retrying...', 'warning');
                }
                // Don't clear the chat or show red error
                return;
            }
            
            if (originalHandleError) {
                originalHandleError(error, status);
            }
        };
    }

    function hookSessionEvents() {
        if (!window.sessionManager) return;
        
        window.sessionManager.addEventListener('sessionCreated', () => {
            state.selectedArtifactIds = [];
            state.outputFormat = '';
            state.artifacts = [];
            renderSelectedChips();
            fetchArtifacts();
        });

        window.sessionManager.addEventListener('sessionSwitched', () => {
            state.selectedArtifactIds = [];
            state.outputFormat = '';
            renderSelectedChips();
            fetchArtifacts();
        });

        window.sessionManager.addEventListener('sessionPromoted', () => {
            fetchArtifacts();
        });
        
        window.sessionManager.addEventListener('sessionDeleted', () => {
            state.selectedArtifactIds = [];
            state.outputFormat = '';
            state.artifacts = [];
            renderSelectedChips();
        });
    }

    /**
     * Generate a diagram file (Mermaid)
     */
    async function generateDiagram(description, type = 'flowchart') {
        const sessionId = await ensureSession();
        
        try {
            const response = await fetch(`${API_BASE}/api/documents/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    templateId: 'mermaid-diagram',
                    variables: {
                        description: description,
                        diagramType: type
                    },
                    format: 'mmd',
                    options: {
                        includePageNumbers: false
                    }
                })
            });
            
            if (!response.ok) {
                // Fallback: create a simple diagram
                const diagramCode = generateMermaidCode(description, type);
                downloadFile(diagramCode, `diagram-${Date.now()}.mmd`, 'text/plain');
                return;
            }
            
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `diagram-${Date.now()}.mmd`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            if (window.uiHelpers?.showToast) {
                uiHelpers.showToast('Diagram generated successfully', 'success');
            }
        } catch (error) {
            console.error('[Artifacts] Diagram generation failed:', error);
            // Fallback: generate locally
            const diagramCode = generateMermaidCode(description, type);
            downloadFile(diagramCode, `diagram-${Date.now()}.mmd`, 'text/plain');
        }
    }
    
    /**
     * Generate Mermaid code locally as fallback
     */
    function generateMermaidCode(description, type) {
        const templates = {
            flowchart: `graph TD
    A[Start] --> B{${description}}
    B -->|Yes| C[Process]
    B -->|No| D[End]
    C --> D`,
            sequence: `sequenceDiagram
    participant User
    participant System
    User->>System: ${description}
    System-->>User: Response`,
            class: `classDiagram
    class Subject {
        +String name
        +action()
    }
    note for Subject "${description}"`,
            er: `erDiagram
    ENTITY ||--o{ RELATED : has
    ENTITY {
        string name
        string description
    }`,
            mindmap: `mindmap
  root((${description}))
    Topic 1
    Topic 2
    Topic 3`
        };
        
        return templates[type] || templates.flowchart;
    }
    
    /**
     * Download file helper
     */
    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
        }, 60 * 1000);
    }

    function triggerBlobDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
        }, 60 * 1000);
    }

    function ensureSitePreviewModal() {
        let modal = document.getElementById('site-preview-modal');
        if (modal) {
            return modal;
        }

        modal = document.createElement('div');
        modal.id = 'site-preview-modal';
        modal.className = 'site-preview-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="site-preview-toolbar">
                <button type="button" data-action="close" title="Back to chat" aria-label="Back to chat">
                    <i data-lucide="arrow-left" class="w-4 h-4"></i>
                </button>
                <button type="button" data-action="back" title="Back" aria-label="Back">
                    <i data-lucide="chevron-left" class="w-4 h-4"></i>
                </button>
                <button type="button" data-action="forward" title="Forward" aria-label="Forward">
                    <i data-lucide="chevron-right" class="w-4 h-4"></i>
                </button>
                <button type="button" data-action="refresh" title="Refresh" aria-label="Refresh">
                    <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                </button>
                <div class="site-preview-title"></div>
                <button type="button" data-action="external" title="Open in new tab" aria-label="Open in new tab">
                    <i data-lucide="external-link" class="w-4 h-4"></i>
                </button>
            </div>
            <iframe
                title="Website artifact preview"
                loading="eager"
                referrerpolicy="no-referrer"
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            ></iframe>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            const action = button.dataset.action;
            const iframe = modal.querySelector('iframe');
            const src = iframe?.dataset.previewSrc || iframe?.src || '';

            if (action === 'close') {
                modal.hidden = true;
                document.body.classList.remove('site-preview-open');
                return;
            }
            if (action === 'external' && src) {
                window.open(src, '_blank', 'noopener');
                return;
            }
            try {
                if (action === 'back') iframe.contentWindow.history.back();
                if (action === 'forward') iframe.contentWindow.history.forward();
                if (action === 'refresh') iframe.contentWindow.location.reload();
            } catch (_error) {
                if (action === 'refresh' && src) {
                    iframe.src = src;
                }
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !modal.hidden) {
                modal.hidden = true;
                document.body.classList.remove('site-preview-open');
            }
        });
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        return modal;
    }

    async function openSitePreviewModal(artifact, previewUrl) {
        const modal = ensureSitePreviewModal();
        const iframe = modal.querySelector('iframe');
        const title = modal.querySelector('.site-preview-title');
        const absolutePreviewUrl = await resolveAuthenticatedPreviewUrl(previewUrl);
        title.textContent = artifact?.filename || 'Website preview';
        iframe.dataset.previewSrc = absolutePreviewUrl;
        if (isFullSitePreviewArtifact(artifact)) {
            iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-downloads allow-same-origin');
        } else {
            iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
        }
        iframe.src = absolutePreviewUrl;
        modal.hidden = false;
        document.body.classList.add('site-preview-open');
    }

    async function openArtifactPreviewUrl(artifact, previewUrl) {
        if (!isPdfArtifact(artifact)) {
            await openSitePreviewModal(artifact, previewUrl);
            return;
        }

        const previewWindow = window.open('', '_blank');
        try {
            const absolutePreviewUrl = await resolveAuthenticatedPreviewUrl(previewUrl);
            if (previewWindow) {
                previewWindow.opener = null;
                previewWindow.location.href = absolutePreviewUrl;
                return;
            }
            window.location.href = absolutePreviewUrl;
        } catch (error) {
            previewWindow?.close?.();
            throw error;
        }
    }

    function getInlineArtifactPreviewElements(target) {
        const wrapper = target?.classList?.contains?.('artifact-html-preview')
            ? target
            : target?.closest?.('.artifact-html-preview');
        return {
            wrapper,
            stage: wrapper?.querySelector?.('.artifact-html-preview-stage') || null,
            status: wrapper?.querySelector?.('.artifact-html-preview-status') || null,
        };
    }

    async function startInlineArtifactPreview(target) {
        const { wrapper, stage, status } = getInlineArtifactPreviewElements(target);
        if (!wrapper || !stage || !wrapper?.dataset?.previewUrl) {
            if (window.uiHelpers?.showToast) {
                uiHelpers.showToast('Preview is not available for this artifact.', 'warning');
            }
            return;
        }

        if (wrapper.dataset.previewActive === 'true' || wrapper.dataset.previewLoading === 'true') {
            return;
        }

        wrapper.dataset.previewLoading = 'true';
        wrapper.classList.add('is-loading');
        wrapper.classList.remove('is-error');
        stage.textContent = 'Loading page preview...';
        if (status) status.textContent = 'Loading';

        let previewUrl = '';
        try {
            previewUrl = await resolveAuthenticatedPreviewUrl(wrapper.dataset.previewUrl);
        } catch (error) {
            wrapper.classList.remove('is-loading');
            wrapper.classList.add('is-error');
            wrapper.dataset.previewLoading = 'false';
            stage.textContent = 'Preview authentication failed. Sign in again and retry.';
            if (status) status.textContent = 'Auth blocked';
            if (window.uiHelpers?.showToast) {
                uiHelpers.showToast(error.message || 'Preview authentication failed', 'error');
            }
            return;
        }

        try {
            const previewResponse = await fetch(previewUrl, {
                credentials: 'include',
                cache: 'no-store',
            });
            if (!previewResponse.ok) {
                throw new Error(`Preview returned ${previewResponse.status}`);
            }
        } catch (error) {
            wrapper.classList.remove('is-loading');
            wrapper.classList.add('is-error');
            wrapper.dataset.previewLoading = 'false';
            stage.textContent = 'Preview file is not available anymore.';
            if (status) status.textContent = 'Unavailable';
            console.warn('[Artifacts] Inline preview unavailable', error);
            return;
        }

        const iframe = document.createElement('iframe');
        iframe.src = previewUrl;
        iframe.title = wrapper.dataset.previewTitle || 'Artifact preview';
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'no-referrer';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
        iframe.addEventListener('load', () => {
            wrapper.classList.remove('is-loading');
            wrapper.dataset.previewLoading = 'false';
            if (status) status.textContent = 'Ready';
        }, { once: true });
        stage.innerHTML = '';
        stage.appendChild(iframe);
        wrapper.dataset.previewActive = 'true';
    }

    function stopInlineArtifactPreview(target) {
        const { wrapper, stage, status } = getInlineArtifactPreviewElements(target);
        if (!wrapper || !stage) {
            return;
        }

        stage.innerHTML = 'Preview paused.';
        wrapper.dataset.previewActive = 'false';
        wrapper.dataset.previewLoading = 'false';
        wrapper.classList.remove('is-loading', 'is-error');
        if (status) status.textContent = 'Paused';
    }

    function hydrateInlineArtifactPreviews(root = document) {
        const scope = root?.querySelectorAll ? root : document;
        scope.querySelectorAll('.artifact-html-preview[data-preview-url]:not([data-preview-hydrated="true"])')
            .forEach((wrapper) => {
                wrapper.dataset.previewHydrated = 'true';
                startInlineArtifactPreview(wrapper);
            });
    }

    function normalizePublicDomainHost(value = '') {
        if (typeof remoteArtifactWorkflow.normalizePublicDomainHost === 'function') {
            return remoteArtifactWorkflow.normalizePublicDomainHost(value);
        }
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return '';
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
        if (labels.length < 2 || normalized.length > 253) return '';
        if (labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
            return '';
        }
        return labels.join('.');
    }

    function normalizeDnsLabel(value = '') {
        if (typeof remoteArtifactWorkflow.normalizeDnsLabel === 'function') {
            return remoteArtifactWorkflow.normalizeDnsLabel(value);
        }
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

    function getSuggestedDnsLabel(artifact = null) {
        if (typeof remoteArtifactWorkflow.getSuggestedDnsLabel === 'function') {
            return remoteArtifactWorkflow.getSuggestedDnsLabel(artifact);
        }
        const source = String(
            artifact?.metadata?.title
            || artifact?.filename
            || 'demo',
        )
            .replace(/\.[a-z0-9]+$/i, '')
            .trim();
        return normalizeDnsLabel(source) || 'demo';
    }

    function resolveRequestedPublicHost(input = '', baseDomain = DEFAULT_PUBLIC_WEB_DOMAIN) {
        if (typeof remoteArtifactWorkflow.resolveRequestedPublicHost === 'function') {
            return remoteArtifactWorkflow.resolveRequestedPublicHost(input, baseDomain);
        }
        const raw = String(input || '').trim();
        if (!raw) {
            return null;
        }
        const fullHost = normalizePublicDomainHost(raw);
        if (fullHost) {
            const hostLabel = fullHost.split('.')[0] || '';
            return {
                dnsName: hostLabel,
                publicHost: fullHost,
                slug: normalizeDnsLabel(hostLabel),
            };
        }
        const dnsName = normalizeDnsLabel(raw);
        if (!dnsName) {
            return null;
        }
        const normalizedBaseDomain = normalizePublicDomainHost(baseDomain) || DEFAULT_PUBLIC_WEB_DOMAIN;
        return {
            dnsName,
            publicHost: `${dnsName}.${normalizedBaseDomain}`,
            slug: dnsName,
        };
    }

    function promptForPublicHost(artifact = null) {
        const suggested = getSuggestedDnsLabel(artifact);
        const entered = window.prompt(
            `Choose the public DNS name for this site. Enter a subdomain like "${suggested}" or a full host like "${suggested}.${DEFAULT_PUBLIC_WEB_DOMAIN}".`,
            suggested,
        );
        if (entered === null) {
            return null;
        }
        return resolveRequestedPublicHost(entered, DEFAULT_PUBLIC_WEB_DOMAIN);
    }
    
    // Create global artifact manager for external access
    window.artifactManager = {
        deselectArtifact: (id) => {
            state.selectedArtifactIds = state.selectedArtifactIds.filter(artifactId => artifactId !== id);
            renderSelectedChips();
        },
        
        selectArtifact: (id) => {
            if (!state.selectedArtifactIds.includes(id)) {
                state.selectedArtifactIds.push(id);
                renderSelectedChips();
            }
        },
        
        downloadArtifact: async (id, filename) => {
            const artifact = state.artifacts.find((entry) => entry.id === id) || state.lastDone?.artifacts?.find((entry) => entry.id === id);
            // Use file manager if available
            if (window.fileManager && !artifact?.bundleDownloadUrl && window.fileManager.files?.some?.((file) => file.id === id)) {
                await window.fileManager.downloadFile(id);
                return;
            }
            
            // Fallback download
            try {
                const downloadPath = artifact?.bundleDownloadUrl || artifact?.downloadUrl || `/api/artifacts/${encodeURIComponent(id)}/download`;
                const response = await fetch(resolveApiUrl(downloadPath, { absolute: true }));
                if (!response.ok) throw new Error('Download failed');
                
                const blob = await response.blob();
                const downloadFilename = artifact?.bundleDownloadUrl
                    ? `${getArtifactBaseName(filename || artifact?.filename || 'site')}.zip`
                    : (filename || 'download');
                triggerBlobDownload(blob, downloadFilename);
            } catch (error) {
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('Download failed: ' + error.message, 'error');
                }
            }
        },

        openArtifactPreview: async (id) => {
            const artifact = findArtifactById(id);
            const previewUrl = getArtifactPreviewUrl(artifact);
            if (!previewUrl) {
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('Preview is not available for this file yet.', 'warning');
                }
                return;
            }

            try {
                await openArtifactPreviewUrl(artifact, previewUrl);
            } catch (error) {
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast(error.message || 'Preview authentication failed', 'error');
                }
            }
        },

        startInlineArtifactPreview,
        stopInlineArtifactPreview,
        hydrateInlineArtifactPreviews,

        exportSiteToManagedApp: async (id) => {
            const artifact = findArtifactById(id);
            if (!isDeployableSiteArtifact(artifact)) {
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('Only previewable HTML/site artifacts can be pushed to the web build lane.', 'warning');
                }
                return;
            }

            try {
                await ensureSession();
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('Checking final website bytes and deployment readiness...', 'info');
                }
                const preflightResponse = await fetch(resolveApiUrl(`/api/artifacts/${encodeURIComponent(id)}/managed-app/preflight`, { absolute: true }), {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        sessionId: getCurrentSessionId(),
                        validateOnly: true,
                    }),
                });
                const preflight = await preflightResponse.json().catch(() => ({}));
                if (!preflightResponse.ok) {
                    throw new Error(preflight.error?.message || `Website preflight failed (${preflightResponse.status})`);
                }
                const blocker = Array.isArray(preflight.blockers) ? preflight.blockers[0] : null;
                if (preflight.pushToWebEligible !== true) {
                    const message = blocker?.message || 'This website is not eligible for Push to Web yet.';
                    throw new Error(blocker?.remediation ? `${message} Next: ${blocker.remediation}` : message);
                }
                const expectedSourceSha256 = String(preflight.sha256 || '').trim().toLowerCase();
                if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256)) {
                    throw new Error('Website preflight did not return a valid final-byte fingerprint.');
                }

                const requestedHost = promptForPublicHost(artifact);
                if (!requestedHost) {
                    if (window.uiHelpers?.showToast) {
                        uiHelpers.showToast('Enter a valid DNS label like demo or a full host like demo.demoserver2.buzz.', 'warning');
                    }
                    return;
                }
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast(`Requesting ${requestedHost.publicHost} through the remote web lane...`, 'info');
                }
                const response = await fetch(resolveApiUrl(`/api/artifacts/${encodeURIComponent(id)}/managed-app`, { absolute: true }), {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        sessionId: getCurrentSessionId(),
                        requestedAction: 'deploy',
                        deployRequested: true,
                        dnsName: requestedHost.dnsName,
                        publicBaseDomain: DEFAULT_PUBLIC_WEB_DOMAIN,
                        publicHost: requestedHost.publicHost,
                        slug: requestedHost.slug,
                        expectedSourceSha256,
                        metadata: {
                            requestedPublicHost: requestedHost.publicHost,
                            acmeRequestHost: requestedHost.publicHost,
                        },
                    }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error?.message || `Remote build export failed (${response.status})`);
                }
                if (window.uiHelpers?.showToast) {
                    const appName = data.app?.appName || data.app?.slug || 'site';
                    const host = data.publicHost || data.app?.publicHost || requestedHost.publicHost;
                    uiHelpers.showToast(`Queued ${appName} for https://${host}.`, 'success');
                }
                if (data.asyncRuntime?.run?.id && typeof window.chatApp?.createAsyncRemoteJobCardFromRun === 'function') {
                    window.chatApp.createAsyncRemoteJobCardFromRun(data.asyncRuntime, getCurrentSessionId());
                }
            } catch (error) {
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast(error.message, 'error');
                }
            }
        },
        getAuthenticatedPreviewUrl: resolveAuthenticatedPreviewUrl,
        applyPreviewAccessToken,
        getPreviewAccessToken,
        
        addToContext: (id) => {
            if (!state.selectedArtifactIds.includes(id)) {
                state.selectedArtifactIds.push(id);
                renderSelectedChips();
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('File added to context', 'success');
                }
            }
        },

        prepareArtifactUpdate: (id) => {
            const artifact = state.artifacts.find((entry) => entry.id === id) || state.lastDone?.artifacts?.find((entry) => entry.id === id);
            if (!artifact) {
                if (window.uiHelpers?.showToast) {
                    uiHelpers.showToast('That artifact is not available in this session yet.', 'warning');
                }
                return;
            }

            state.selectedArtifactIds = [id];
            state.outputFormat = normalizeArtifactOutputFormat(artifact);
            renderSelectedChips();

            const label = getArtifactIterationLabel(artifact);
            const filename = artifact.filename ? ` (${artifact.filename})` : '';
            setComposerDraft(`Update this ${label}${filename}: `);

            if (window.uiHelpers?.showToast) {
                uiHelpers.showToast('This artifact is pinned for the next update.', 'success');
            }
        },

        sendArtifactUpdate: async (id, prompt) => {
            const artifact = state.artifacts.find((entry) => entry.id === id) || state.lastDone?.artifacts?.find((entry) => entry.id === id);
            const normalizedPrompt = String(prompt || '').trim();
            if (!artifact || !normalizedPrompt || !window.chatApp?.sendPreparedMessage) {
                return false;
            }
            const outputFormat = normalizeArtifactOutputFormat(artifact);
            return window.chatApp.sendPreparedMessage(normalizedPrompt, {
                artifactIds: [id],
                ...(outputFormat ? { outputFormat } : {}),
                metadata: {
                    workflowAction: 'web-chat-artifact-update',
                    artifactUpdateIntent: {
                        artifactId: id,
                        filename: artifact.filename || '',
                        outputFormat,
                    },
                },
            });
        },
        
        uploadFile: uploadArtifact,
        persistGeneratedFile: async (content, filename, mimeType = 'application/octet-stream') => {
            await ensureSession();
            const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
            const file = new File([blob], filename, { type: mimeType || blob.type || 'application/octet-stream' });
            await uploadArtifact(file);
        },
        buildArtifactSummary,
        buildGalleryMarkup: buildArtifactGalleryMarkup,
        buildGalleryMessage: buildArtifactGalleryMessage,
        refresh: fetchArtifacts,
        getSelectedIds: () => [...state.selectedArtifactIds],
        clearSelection: () => {
            state.selectedArtifactIds = [];
            state.outputFormat = '';
            renderSelectedChips();
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        injectStyles();
        injectToolbar();
        overrideApiClient();
        
        setTimeout(() => {
            patchApp();
            hookSessionEvents();
            fetchArtifacts();
            startArtifactPreviewObserver();
        }, 100);
    });
})();

