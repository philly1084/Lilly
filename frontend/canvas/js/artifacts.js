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

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[char]));
    }

    function getArtifactLabel(artifact) {
        return String(artifact?.filename || artifact?.id || 'artifact').trim() || 'artifact';
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .artifact-panel { margin-top: 16px; border: 1px solid var(--border-color, #2f3542); border-radius: 12px; padding: 12px; background: rgba(255,255,255,0.02); }
            .artifact-panel h4 { margin: 0 0 8px; font-size: 13px; }
            .artifact-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
            .artifact-toolbar select { flex: 1; min-width: 160px; }
            .artifact-list { display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow: auto; }
            .artifact-empty { border: 1px dashed var(--border-color, #475569); border-radius: 10px; color: var(--text-secondary, #94a3b8); font-size: 12px; padding: 10px; }
            .artifact-item { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px; }
            .artifact-item.active { border-color: #38bdf8; }
            .artifact-meta { font-size: 12px; opacity: 0.75; margin-top: 4px; }
            .artifact-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
            .artifact-actions button, .artifact-actions a { font-size: 12px; color: inherit; }
        `;
        document.head.appendChild(style);
    }

    async function ensureSession() {
        if (window.canvasApp?.state?.sessionId) {
            return window.canvasApp.state.sessionId;
        }

        const response = await fetch(`${API_BASE_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metadata: { mode: 'canvas' } }),
        });
        const session = await response.json();
        if (window.canvasApp) {
            window.canvasApp.state.sessionId = session.id;
            window.canvasApp.api.setSessionId(session.id);
            document.getElementById('session-id').textContent = session.id.slice(0, 16) + '...';
        }
        return session.id;
    }

    async function fetchArtifacts(sessionId) {
        if (!sessionId) return;
        const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/artifacts`);
        if (!response.ok) return;
        const data = await response.json();
        state.artifacts = data.artifacts || [];
        renderArtifacts();
    }

    async function uploadArtifact(file) {
        const sessionId = await ensureSession();
        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('mode', 'canvas');
        formData.append('file', file);

        const response = await fetch(`${API_BASE_URL}/api/artifacts/upload`, {
            method: 'POST',
            body: formData,
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `Upload failed (${response.status})`);
        }

        await fetchArtifacts(sessionId);
        window.canvasApp?.showToast?.(`Uploaded ${file.name}`, 'success');
    }

    function renderArtifacts() {
        const list = document.getElementById('artifact-list');
        if (!list) return;

        list.innerHTML = '';
        if (state.artifacts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'artifact-empty';
            empty.textContent = 'No artifacts attached yet.';
            list.appendChild(empty);
            return;
        }

        state.artifacts.forEach((artifact) => {
            const isSelected = state.selectedArtifactIds.includes(artifact.id);
            const artifactLabel = getArtifactLabel(artifact);
            const escapedLabel = escapeHtml(artifactLabel);
            const actionLabel = isSelected
                ? `Detach ${artifactLabel} from the next Canvas request`
                : `Attach ${artifactLabel} to the next Canvas request`;
            const item = document.createElement('div');
            item.className = `artifact-item${isSelected ? ' active' : ''}`;
            item.setAttribute('role', 'listitem');
            item.innerHTML = `
                <strong>${escapedLabel}</strong>
                <div class="artifact-meta">${escapeHtml(artifact.format || 'file')} | ${escapeHtml(artifact.sizeBytes ?? 0)} bytes</div>
                <div class="artifact-actions">
                    <button type="button" data-action="toggle" aria-pressed="${isSelected ? 'true' : 'false'}" aria-label="${escapeHtml(actionLabel)}">${isSelected ? 'Detach' : 'Attach'}</button>
                    ${(artifact.sandboxUrl || artifact.previewUrl) ? `<a href="${escapeHtml(artifact.sandboxUrl || artifact.previewUrl)}" target="_blank" rel="noopener" aria-label="Preview ${escapedLabel}">Preview</a>` : ''}
                    <a href="${escapeHtml(artifact.downloadUrl || '#')}" target="_blank" rel="noopener" aria-label="Download ${escapedLabel}">Download</a>
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
        const actionButtons = document.querySelector('.action-buttons');
        if (!actionButtons) return;

        const panel = document.createElement('div');
        panel.className = 'artifact-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'artifact-panel-title');
        panel.innerHTML = `
            <h4 id="artifact-panel-title">Artifacts</h4>
            <div class="artifact-toolbar">
                <button id="artifact-upload-btn" class="btn btn-secondary" type="button" aria-label="Upload artifact file">Upload File</button>
                <select id="artifact-output-format" class="context-textarea" style="height:auto; min-height:40px;" aria-label="Choose generated artifact output format">
                    <option value="">No file output</option>
                    <option value="html">HTML</option>
                    <option value="pdf">PDF</option>
                    <option value="xml">XML</option>
                    <option value="mermaid">Mermaid</option>
                    <option value="xlsx">XLSX</option>
                    <option value="power-query">Power Query</option>
                </select>
                <input id="artifact-file-input" type="file" hidden>
            </div>
            <div id="artifact-list" class="artifact-list" role="list" aria-label="Attached artifacts"></div>
        `;
        actionButtons.parentNode.insertBefore(panel, actionButtons);

        document.getElementById('artifact-upload-btn').addEventListener('click', () => {
            document.getElementById('artifact-file-input').click();
        });
        document.getElementById('artifact-file-input').addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                await uploadArtifact(file);
            } catch (error) {
                window.canvasApp?.showToast?.(error.message, 'error');
            }
            event.target.value = '';
        });
        document.getElementById('artifact-output-format').addEventListener('change', (event) => {
            state.outputFormat = event.target.value;
        });
        renderArtifacts();
    }

    function patchCanvasApi() {
        if (!window.CanvasAPI || !window.canvasApp) return;
        const originalSend = window.canvasApp.api.sendCanvasRequest.bind(window.canvasApp.api);
        window.canvasApp.api.sendCanvasRequest = function(params) {
            return originalSend({
                ...params,
                artifactIds: state.selectedArtifactIds,
                outputFormat: state.outputFormat || undefined,
            });
        };

        const originalWsSend = window.canvasApp.api.sendWebSocketMessage.bind(window.canvasApp.api);
        window.canvasApp.api.sendWebSocketMessage = function(params) {
            return originalWsSend({
                ...params,
                artifactIds: state.selectedArtifactIds,
                outputFormat: state.outputFormat || undefined,
            });
        };

        const originalHandleResponse = window.canvasApp.handleAIResponse.bind(window.canvasApp);
        window.canvasApp.handleAIResponse = function(response) {
            originalHandleResponse(response);
            if (Array.isArray(response.artifacts) && response.artifacts.length > 0) {
                state.artifacts = [...response.artifacts, ...state.artifacts.filter((artifact) => !response.artifacts.find((next) => next.id === artifact.id))];
                renderArtifacts();
            } else if (this.state.sessionId) {
                fetchArtifacts(this.state.sessionId);
            }
        };

        const originalNewSession = window.canvasApp.newSession.bind(window.canvasApp);
        window.canvasApp.newSession = function() {
            state.selectedArtifactIds = [];
            state.artifacts = [];
            renderArtifacts();
            originalNewSession();
        };

        const originalLoad = window.canvasApp.loadFromLocalStorage.bind(window.canvasApp);
        window.canvasApp.loadFromLocalStorage = function() {
            originalLoad();
            if (this.state.sessionId) {
                fetchArtifacts(this.state.sessionId);
            }
        };
    }

    function patchFetchPayloads() {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (resource, options = {}) => {
            if (typeof resource === 'string' && resource.endsWith('/api/canvas') && options?.body && options.headers?.['Content-Type'] === 'application/json') {
                try {
                    const body = JSON.parse(options.body);
                    body.artifactIds = state.selectedArtifactIds;
                    if (state.outputFormat) {
                        body.outputFormat = state.outputFormat;
                    }
                    options.body = JSON.stringify(body);
                } catch {
                    // Ignore malformed JSON payloads.
                }
            }
            return originalFetch(resource, options);
        };
    }

    document.addEventListener('DOMContentLoaded', () => {
        injectStyles();
        injectPanel();
        patchFetchPayloads();
        setTimeout(() => {
            patchCanvasApi();
            const sessionId = window.canvasApp?.state?.sessionId;
            if (sessionId) {
                fetchArtifacts(sessionId);
            }
        }, 50);
    });
})();
