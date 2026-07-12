(function() {
    const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
    const API_BASE_URL = LOCAL_HOSTNAMES.has(window.location.hostname)
        ? 'http://localhost:3000'
        : `${window.location.protocol}//${window.location.host}`;

    const state = {
        artifacts: [],
        selectedArtifactIds: [],
        outputFormat: '',
    };

    function normalizeArtifactRecord(artifact) {
        if (!artifact || typeof artifact !== 'object') {
            return null;
        }

        const artifactId = String(artifact.id || artifact.artifactId || artifact.artifact_id || '').trim();
        const documentId = String(artifact.documentId || artifact.document_id || '').trim();
        const id = artifactId || documentId;
        if (!id) {
            return null;
        }

        const sizeValue = artifact.sizeBytes ?? artifact.size_bytes ?? artifact.size;
        const sizeBytes = Number.isFinite(Number(sizeValue)) ? Number(sizeValue) : 0;
        const filename = String(artifact.filename || artifact.name || id).trim() || id;
        const mimeType = String(artifact.mimeType || artifact.mime_type || '').trim();
        const extension = String(artifact.extension || '').trim();
        const format = String(
            artifact.format
            || extension
            || (mimeType.includes('/') ? mimeType.split('/').pop() : '')
            || ''
        ).trim();

        return {
            ...artifact,
            id,
            artifactId: id,
            filename,
            format,
            mimeType,
            size: sizeBytes,
            sizeBytes,
            downloadUrl: String(
                artifact.downloadUrl
                || artifact.download_url
                || `/api/${artifactId ? 'artifacts' : 'documents'}/${encodeURIComponent(id)}/download`
            ).trim(),
            previewUrl: String(artifact.previewUrl || artifact.preview_url || '').trim(),
            sandboxUrl: String(artifact.sandboxUrl || artifact.sandbox_url || '').trim(),
            bundleDownloadUrl: String(artifact.bundleDownloadUrl || artifact.bundle_download_url || '').trim(),
        };
    }

    function normalizeArtifacts(artifacts) {
        return (Array.isArray(artifacts) ? artifacts : [])
            .map(normalizeArtifactRecord)
            .filter(Boolean);
    }

    function extractResponseArtifacts(data = {}) {
        const content = data.content && typeof data.content === 'object' ? data.content : {};
        const assistantMetadata = data.assistantMetadata
            || data.assistant_metadata
            || content.assistantMetadata
            || content.assistant_metadata
            || {};
        return normalizeArtifacts(
            content.artifacts
            || data.artifacts
            || assistantMetadata.artifacts
            || [],
        );
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .artifact-strip { margin: 12px 0; padding: 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; background: rgba(255,255,255,0.03); }
            .artifact-strip .artifact-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
            .artifact-strip .artifact-list { display: flex; flex-direction: column; gap: 8px; max-height: 180px; overflow: auto; }
            .artifact-strip .artifact-item { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px; }
            .artifact-strip .artifact-item.active { border-color: #3b82f6; }
            .artifact-strip .artifact-actions { display: flex; gap: 8px; margin-top: 6px; }
        `;
        document.head.appendChild(style);
    }

    async function ensureSession() {
        if (window.NotationAPI?.sessionId) {
            return window.NotationAPI.sessionId;
        }

        const response = await fetch(`${API_BASE_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metadata: { mode: 'notation' } }),
        });
        const session = await response.json();
        if (window.NotationAPI) {
            window.NotationAPI.sessionId = session.id;
        }
        return session.id;
    }

    async function fetchArtifacts() {
        const sessionId = window.NotationAPI?.sessionId;
        if (!sessionId) return;
        const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/artifacts`);
        if (!response.ok) return;
        const data = await response.json();
        state.artifacts = normalizeArtifacts(data.artifacts);
        renderArtifacts();
    }

    async function uploadArtifact(file) {
        const sessionId = await ensureSession();
        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('mode', 'notation');
        formData.append('file', file);

        const response = await fetch(`${API_BASE_URL}/api/artifacts/upload`, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `Upload failed (${response.status})`);
        }

        await fetchArtifacts();
    }

    function renderArtifacts() {
        const list = document.getElementById('notation-artifact-list');
        if (!list) return;
        list.innerHTML = '';

        state.artifacts.forEach((artifact) => {
            const item = document.createElement('div');
            item.className = `artifact-item${state.selectedArtifactIds.includes(artifact.id) ? ' active' : ''}`;
            const formatLabel = artifact.format || artifact.mimeType || 'file';
            const previewUrl = artifact.sandboxUrl || artifact.previewUrl;
            const downloadUrl = artifact.downloadUrl || artifact.bundleDownloadUrl;
            item.innerHTML = `
                <strong>${artifact.filename}</strong>
                <div>${formatLabel} | ${artifact.sizeBytes} bytes</div>
                <div class="artifact-actions">
                    <button type="button" data-action="toggle">${state.selectedArtifactIds.includes(artifact.id) ? 'Detach' : 'Attach'}</button>
                    ${previewUrl ? `<a href="${previewUrl}" target="_blank" rel="noopener">Preview</a>` : ''}
                    ${downloadUrl ? `<a href="${downloadUrl}" target="_blank" rel="noopener">Download</a>` : ''}
                </div>
            `;
            item.querySelector('[data-action="toggle"]').addEventListener('click', () => {
                if (state.selectedArtifactIds.includes(artifact.id)) {
                    state.selectedArtifactIds = state.selectedArtifactIds.filter((id) => id !== artifact.id);
                } else {
                    state.selectedArtifactIds = [...state.selectedArtifactIds, artifact.id];
                }
                renderArtifacts();
            });
            list.appendChild(item);
        });
    }

    function injectPanel() {
        const contextBar = document.getElementById('contextBar');
        if (!contextBar) return;

        const panel = document.createElement('div');
        panel.className = 'artifact-strip';
        panel.innerHTML = `
            <div class="artifact-toolbar">
                <button id="notation-upload-btn" class="secondary-btn" type="button">Upload File</button>
                <select id="notation-output-format">
                    <option value="">No file output</option>
                    <option value="html">HTML</option>
                    <option value="pdf">PDF</option>
                    <option value="xml">XML</option>
                    <option value="mermaid">Mermaid</option>
                    <option value="xlsx">XLSX</option>
                    <option value="power-query">Power Query</option>
                </select>
                <input id="notation-file-input" type="file" hidden>
            </div>
            <div id="notation-artifact-list" class="artifact-list"></div>
        `;
        contextBar.insertAdjacentElement('afterend', panel);

        document.getElementById('notation-upload-btn').addEventListener('click', () => {
            document.getElementById('notation-file-input').click();
        });
        document.getElementById('notation-file-input').addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                await uploadArtifact(file);
                window.NotationApp?._showToast?.(`Uploaded ${file.name}`, 'success');
            } catch (error) {
                window.NotationApp?._showToast?.(error.message, 'error');
            }
            event.target.value = '';
        });
        document.getElementById('notation-output-format').addEventListener('change', (event) => {
            state.outputFormat = event.target.value;
        });
    }

    function patchApi() {
        if (!window.NotationAPI) return;

        const originalProcess = window.NotationAPI.process.bind(window.NotationAPI);
        window.NotationAPI.process = function(data) {
            return originalProcess({
                ...data,
                artifactIds: state.selectedArtifactIds,
                outputFormat: state.outputFormat || undefined,
            });
        };

        window.NotationAPI.processWS = function(data) {
            if (!this.isConnected || !this.ws) {
                return false;
            }
            const message = {
                type: 'notation',
                sessionId: data.sessionId || this.sessionId,
                payload: {
                    notation: data.notation || '',
                    helperMode: data.helperMode || 'expand',
                    context: data.context || '',
                    artifactIds: state.selectedArtifactIds,
                    outputFormat: state.outputFormat || undefined,
                },
            };
            this.ws.send(JSON.stringify(message));
            this._notifyStatus('processing');
            return true;
        };

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (resource, options = {}) => {
            if (typeof resource === 'string' && resource.endsWith('/api/notation') && options?.body && options.headers?.['Content-Type'] === 'application/json') {
                try {
                    const body = JSON.parse(options.body);
                    body.artifactIds = state.selectedArtifactIds;
                    if (state.outputFormat) {
                        body.outputFormat = state.outputFormat;
                    }
                    options.body = JSON.stringify(body);
                } catch {
                    // ignore
                }
            }
            return originalFetch(resource, options);
        };
    }

    function patchApp() {
        const app = window.NotationApp;
        if (!app) return;
        const originalHandleResponse = app._handleResponse.bind(app);
        app._handleResponse = function(data) {
            originalHandleResponse(data);
            const artifacts = extractResponseArtifacts(data);
            if (Array.isArray(artifacts) && artifacts.length > 0) {
                state.artifacts = [...artifacts, ...state.artifacts.filter((artifact) => !artifacts.find((next) => next.id === artifact.id))];
                renderArtifacts();
            } else {
                fetchArtifacts();
            }
        };
    }

    document.addEventListener('DOMContentLoaded', () => {
        injectStyles();
        injectPanel();
        patchApi();
        setTimeout(() => {
            patchApp();
            fetchArtifacts();
        }, 50);
    });

    window.notationArtifactPanel = {
        normalizeArtifactRecord,
        normalizeArtifacts,
        extractResponseArtifacts,
        getState: () => state,
    };
})();
