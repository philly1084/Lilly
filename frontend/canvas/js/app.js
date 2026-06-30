/**
 * LillyBuilt Canvas - Main Application
 * Front-end #3 of 4 - Side-by-side editor for structured content
 */

class CanvasApp {
    constructor() {
        // Core components
        this.editor = new EditorManager();
        this.typeManager = new CanvasTypeManager();
        this.history = new HistoryManager(50);
        this.exportManager = new ExportManager();
        this.api = new CanvasAPI();

        // State
        this.state = {
            sessionId: null,
            canvasType: 'code',
            content: '',
            metadata: {},
            suggestions: [],
            isPreviewMode: false,
            isSplitView: false,
            aiResponse: null,
            lastSaved: null,
            selectedModel: 'gpt-4o',
            reasoningEffort: '',
            applyTarget: 'full',
            lastSelection: null,
            lastRequestContract: null,
        };

        // Auto-save timer
        this.autoSaveTimer = null;
        this.previewRenderTimer = null;

        this.init();
    }

    /**
     * Initialize the application
     */
    init() {
        this.loadFromLocalStorage();
        this.initializeEditor();
        this.setupEventListeners();
        this.setupHistoryListener();
        this.setupTemplateChips();
        this.loadModels();
        this.updateUI();
        this.updateGroundingPanel();
        
        // Try to connect WebSocket
        this.api.connectWebSocket().catch(() => {
            console.log('WebSocket connection failed, using HTTP fallback');
        });

        // Setup WebSocket callbacks
        this.setupWebSocketListeners();

        // Setup keyboard shortcuts
        this.setupKeyboardShortcuts();

        // Setup help modal
        this.setupHelpModal();

        console.log('LillyBuilt Canvas initialized');
    }

    /**
     * Setup WebSocket event listeners
     */
    setupWebSocketListeners() {
        // Handle incoming messages
        this.api.on('done', (data) => {
            this.handleAIResponse(data);
        });

        // Handle connection open
        this.api.on('open', () => {
            this.hideWebSocketDisconnectBanner();
        });

        // Handle connection close
        this.api.on('close', (event) => {
            if (!event.wasClean) {
                this.showWebSocketDisconnectBanner();
            }
        });

        // Handle errors
        this.api.on('error', () => {
            this.showWebSocketDisconnectBanner();
        });
    }

    /**
     * Show WebSocket disconnect banner
     */
    showWebSocketDisconnectBanner() {
        const banner = document.getElementById('ws-disconnect-banner');
        if (banner) {
            banner.classList.remove('hidden');
            // Adjust app padding for banner
            document.getElementById('app').style.paddingTop = '48px';
        }
    }

    /**
     * Hide WebSocket disconnect banner
     */
    hideWebSocketDisconnectBanner() {
        const banner = document.getElementById('ws-disconnect-banner');
        if (banner) {
            banner.classList.add('hidden');
            // Reset app padding
            document.getElementById('app').style.paddingTop = '0';
        }
    }

    /**
     * Reconnect WebSocket
     */
    async reconnectWebSocket() {
        const reconnectBtn = document.getElementById('ws-reconnect-btn');
        if (reconnectBtn) {
            reconnectBtn.disabled = true;
            reconnectBtn.innerHTML = '<span class="loading-spinner" style="width:14px;height:14px;"></span> Connecting...';
        }

        try {
            await this.api.connectWebSocket();
            this.hideWebSocketDisconnectBanner();
            this.showToast('Reconnected successfully', 'success');
        } catch (error) {
            console.error('WebSocket reconnect failed:', error);
            this.showToast('Failed to reconnect', 'error');
        } finally {
            if (reconnectBtn) {
                reconnectBtn.disabled = false;
                reconnectBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                    </svg>
                    Reconnect
                `;
            }
        }
    }

    /**
     * Setup keyboard shortcuts
     */
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Don't trigger shortcuts when typing in inputs
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                // Allow Ctrl+Enter in textareas
                if (e.target.id === 'prompt-input' && e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    this.sendToAI();
                }
                return;
            }

            // ? - Show help modal
            if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                this.showHelpModal();
            }

            // Ctrl/Cmd + P - Toggle preview
            if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
                e.preventDefault();
                this.togglePreview();
            }

            // Ctrl/Cmd + \ - Toggle split view
            if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
                e.preventDefault();
                this.toggleSplitView();
            }

            // Ctrl/Cmd + Enter - Send to AI (from anywhere)
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this.sendToAI();
            }

            // Escape - Close modals and sidebar
            if (e.key === 'Escape') {
                this.closeHelpModal();
                this.closeSidebar();
            }
        });
    }

    /**
     * Setup help modal
     */
    setupHelpModal() {
        const closeBtn = document.getElementById('help-modal-close');
        const overlay = document.querySelector('.help-modal-overlay');
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeHelpModal());
        }
        
        if (overlay) {
            overlay.addEventListener('click', () => this.closeHelpModal());
        }

        // Reconnect button
        const reconnectBtn = document.getElementById('ws-reconnect-btn');
        if (reconnectBtn) {
            reconnectBtn.addEventListener('click', () => this.reconnectWebSocket());
        }
    }

    /**
     * Show help modal
     */
    showHelpModal() {
        const modal = document.getElementById('help-modal');
        if (modal) {
            modal.classList.remove('hidden');
        }
    }

    /**
     * Close help modal
     */
    closeHelpModal() {
        const modal = document.getElementById('help-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    /**
     * Close sidebar (mobile)
     */
    closeSidebar() {
        const sidebar = document.getElementById('sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (sidebar) {
            sidebar.classList.remove('open');
        }
        if (backdrop) {
            backdrop.classList.remove('visible');
        }
    }

    /**
     * Toggle sidebar with backdrop
     */
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        const isOpen = sidebar.classList.contains('open');
        
        if (isOpen) {
            sidebar.classList.remove('open');
            backdrop.classList.remove('visible');
        } else {
            sidebar.classList.add('open');
            backdrop.classList.add('visible');
        }
    }
    
    /**
     * Load available AI models
     */
    async loadModels() {
        const modelSelect = document.getElementById('model-select');
        if (!modelSelect) return;
        
        try {
            const response = await fetch('/api/models');
            const data = await response.json();
            const models = Array.isArray(data.data) ? data.data : [];
            
            if (models.length > 0) {
                modelSelect.innerHTML = models.map(m => 
                    `<option value="${m.id}" ${m.id === 'gpt-4o' ? 'selected' : ''}>${m.name || m.id}</option>`
                ).join('');
            } else {
                modelSelect.innerHTML = `
                    <option value="gpt-4o" selected>GPT-4o</option>
                    <option value="gpt-4o-mini">GPT-4o Mini</option>
                    <option value="o3-mini">o3-mini</option>
                `;
            }

            modelSelect.value = this.state.selectedModel || modelSelect.value || 'gpt-4o';
            this.state.selectedModel = modelSelect.value;
        } catch (err) {
            console.log('Failed to load models, using defaults');
            modelSelect.innerHTML = `
                <option value="gpt-4o" selected>GPT-4o</option>
                <option value="gpt-4o-mini">GPT-4o Mini</option>
                <option value="o3-mini">o3-mini</option>
            `;
            modelSelect.value = this.state.selectedModel || modelSelect.value || 'gpt-4o';
            this.state.selectedModel = modelSelect.value;
        }
    }
    
    /**
     * Setup template chip click handlers
     */
    setupTemplateChips() {
        const chips = document.querySelectorAll('.template-chip');
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                const prompt = chip.dataset.prompt;
                const type = chip.dataset.type;
                
                // Set the prompt
                const promptInput = document.getElementById('prompt-input');
                promptInput.value = prompt;
                promptInput.focus();
                
                // Switch canvas type if needed
                if (type && type !== this.state.canvasType) {
                    this.switchCanvasType(type);
                }
            });
        });
    }

    /**
     * Initialize the code editor
     */
    initializeEditor() {
        const handler = this.typeManager.getHandler(this.state.canvasType);
        
        this.editor.initialize({
            mode: handler.getCodeMirrorMode(),
            value: this.state.content || handler.getDefaultContent()
        });

        // Subscribe to editor changes for auto-save and diagram auto-render
        this.editor.onChange((value) => {
            this.state.content = value;
            this.captureSelectionSnapshot();
            this.scheduleAutoSave();
            this.updateStatusBar();
            this.updateGroundingPanel();
            
            // Auto-render diagram with debounce
            if (this.state.canvasType === 'diagram' && (this.state.isPreviewMode || this.state.isSplitView)) {
                const handler = this.typeManager.getHandler('diagram');
                handler.scheduleAutoRender(value, 'diagram-output');
            }

            if (this.state.canvasType === 'frontend' && (this.state.isPreviewMode || this.state.isSplitView)) {
                clearTimeout(this.previewRenderTimer);
                this.previewRenderTimer = setTimeout(() => {
                    this.renderPreview();
                }, 180);
            }
        });

        // Subscribe to cursor activity
        this.editor.onCursorActivity((position) => {
            this.captureSelectionSnapshot();
            document.getElementById('cursor-position').textContent = 
                `Ln ${position.line}, Col ${position.ch}`;
            this.updateGroundingPanel();
        });

        // Push initial state to history
        this.pushToHistory();
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Sidebar toggle with backdrop
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            this.toggleSidebar();
        });

        // Sidebar backdrop click
        document.getElementById('sidebar-backdrop').addEventListener('click', () => {
            this.closeSidebar();
        });

        // Theme toggle
        document.getElementById('theme-toggle').addEventListener('click', () => {
            this.toggleTheme();
        });
        
        // Model selector
        const modelSelect = document.getElementById('model-select');
        if (modelSelect) {
            modelSelect.addEventListener('change', (e) => {
                this.state.selectedModel = e.target.value;
                console.log('Model changed to:', e.target.value);
                this.saveToLocalStorage();
            });
        }

        const reasoningSelect = document.getElementById('reasoning-effort-select');
        if (reasoningSelect) {
            reasoningSelect.addEventListener('change', (e) => {
                this.state.reasoningEffort = String(e.target.value || '').trim().toLowerCase();
                this.saveToLocalStorage();
            });
        }

        // Canvas type selector
        document.querySelectorAll('.type-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = e.currentTarget.dataset.type;
                this.switchCanvasType(type);
            });
        });

        // New session
        document.getElementById('new-session-btn').addEventListener('click', () => {
            this.newSession();
        });

        // Send to AI
        document.getElementById('send-btn').addEventListener('click', () => {
            this.sendToAI();
        });

        // Clear prompt
        document.getElementById('clear-btn').addEventListener('click', () => {
            document.getElementById('prompt-input').value = '';
            document.getElementById('context-input').value = '';
            this.updateGroundingPanel();
        });

        const contextInput = document.getElementById('context-input');
        if (contextInput) {
            contextInput.addEventListener('input', () => this.updateGroundingPanel());
        }

        // Use current content as context
        document.getElementById('use-current-content').addEventListener('click', () => {
            document.getElementById('context-input').value = this.editor.getValue();
            this.updateGroundingPanel();
        });

        const useSelectionBtn = document.getElementById('use-selection-context');
        if (useSelectionBtn) {
            useSelectionBtn.addEventListener('click', () => {
                this.captureSelectionSnapshot();
                if (!this.state.lastSelection?.text) {
                    this.showToast('Select text in the canvas first', 'warning');
                    return;
                }
                document.getElementById('context-input').value = this.state.lastSelection.text;
                const applyTarget = document.getElementById('apply-target-select');
                if (applyTarget) {
                    applyTarget.value = 'selection';
                    this.state.applyTarget = 'selection';
                }
                this.updateGroundingPanel();
            });
        }

        const refreshGroundingBtn = document.getElementById('refresh-grounding');
        if (refreshGroundingBtn) {
            refreshGroundingBtn.addEventListener('click', () => {
                this.captureSelectionSnapshot();
                this.updateGroundingPanel();
            });
        }

        const applyTargetSelect = document.getElementById('apply-target-select');
        if (applyTargetSelect) {
            applyTargetSelect.addEventListener('change', (event) => {
                this.state.applyTarget = event.target.value === 'selection' ? 'selection' : 'full';
                this.updateGroundingPanel();
                this.saveToLocalStorage();
            });
        }

        // Apply AI response
        document.getElementById('apply-btn').addEventListener('click', () => {
            this.applyAIResponse();
        });

        // Toggle preview
        document.getElementById('toggle-preview').addEventListener('click', () => {
            this.togglePreview();
        });

        // Toggle split view
        document.getElementById('toggle-split').addEventListener('click', () => {
            this.toggleSplitView();
        });

        // Undo/Redo
        document.getElementById('undo-btn').addEventListener('click', () => {
            this.undo();
        });

        document.getElementById('redo-btn').addEventListener('click', () => {
            this.redo();
        });

        // Copy to clipboard
        document.getElementById('copy-btn').addEventListener('click', () => {
            this.copyToClipboard();
        });

        // Download
        document.getElementById('download-btn').addEventListener('click', () => {
            this.downloadFile();
        });

        // Diagram zoom controls
        document.getElementById('diagram-zoom-in')?.addEventListener('click', () => {
            this.typeManager.getHandler('diagram').zoomIn();
        });

        document.getElementById('diagram-zoom-out')?.addEventListener('click', () => {
            this.typeManager.getHandler('diagram').zoomOut();
        });

        document.getElementById('diagram-zoom-reset')?.addEventListener('click', () => {
            this.typeManager.getHandler('diagram').resetZoom();
        });

        // Mouse wheel zoom for diagram
        document.getElementById('diagram-wrapper')?.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                if (e.deltaY < 0) {
                    this.typeManager.getHandler('diagram').zoomIn();
                } else {
                    this.typeManager.getHandler('diagram').zoomOut();
                }
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Z - Undo
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            }
            // Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y - Redo
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                this.redo();
            }
        });

        // Window resize
        window.addEventListener('resize', () => {
            this.editor.resize();
        });

        // Save event from editor
        window.addEventListener('editor:save', () => {
            this.saveToLocalStorage();
            this.showToast('Saved', 'success');
        });

        // Before unload - warn about unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (this.editor.isDirtyState()) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // Setup resizer
        this.setupResizer();
    }

    /**
     * Setup sidebar resizer
     */
    setupResizer() {
        const resizer = document.getElementById('resizer');
        const sidebar = document.getElementById('sidebar');
        if (!resizer || !sidebar) return;

        let isResizing = false;
        const minWidth = 260;
        const maxWidth = 500;
        const getCurrentWidth = () => {
            const inlineWidth = parseInt(sidebar.style.width, 10);
            if (Number.isFinite(inlineWidth)) return inlineWidth;
            const measuredWidth = Math.round(sidebar.getBoundingClientRect?.().width || 320);
            return Math.min(maxWidth, Math.max(minWidth, measuredWidth));
        };
        const setSidebarWidth = (width) => {
            const nextWidth = Math.min(maxWidth, Math.max(minWidth, width));
            sidebar.style.width = `${nextWidth}px`;
            resizer.setAttribute('aria-valuenow', String(nextWidth));
            this.editor.resize();
        };

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const newWidth = e.clientX;
            if (newWidth >= minWidth && newWidth <= maxWidth) {
                setSidebarWidth(newWidth);
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizer.classList.remove('resizing');
                document.body.style.cursor = '';
            }
        });

        resizer.addEventListener('keydown', (e) => {
            const keyDeltas = {
                ArrowLeft: -20,
                ArrowRight: 20,
            };

            if (e.key === 'Home') {
                e.preventDefault();
                setSidebarWidth(minWidth);
                return;
            }

            if (e.key === 'End') {
                e.preventDefault();
                setSidebarWidth(maxWidth);
                return;
            }

            if (Object.prototype.hasOwnProperty.call(keyDeltas, e.key)) {
                e.preventDefault();
                setSidebarWidth(getCurrentWidth() + keyDeltas[e.key]);
            }
        });
    }

    /**
     * Setup history change listener
     */
    setupHistoryListener() {
        this.history.onChange((stats) => {
            document.getElementById('undo-btn').disabled = !stats.canUndo;
            document.getElementById('redo-btn').disabled = !stats.canRedo;
        });
    }

    /**
     * Switch canvas type
     * @param {string} type 
     */
    switchCanvasType(type) {
        if (this.state.canvasType === type) return;

        // Save current content to history
        this.pushToHistory();

        // Update state
        this.state.canvasType = type;
        this.typeManager.setType(type);

        // Update UI
        document.querySelectorAll('.type-btn').forEach(btn => {
            const isActive = btn.dataset.type === type;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });

        // Get handler and update editor
        const handler = this.typeManager.getHandler(type);
        this.editor.setMode(handler.getCodeMirrorMode());

        // Set default content if empty
        const currentContent = this.editor.getValue().trim();
        if (!currentContent || currentContent === '// Start coding here...') {
            this.editor.setValue(handler.getDefaultContent());
        }

        // Update preview visibility
        this.updatePreviewVisibility();
        this.updateStatusBar();
        this.saveToLocalStorage();
    }

    /**
     * Update preview visibility based on canvas type
     */
    updatePreviewVisibility() {
        const handler = this.typeManager.getCurrentHandler();
        const info = handler.getInfo();
        const previewBtn = document.getElementById('toggle-preview');
        const splitBtn = document.getElementById('toggle-split');

        if (info.supportsPreview) {
            previewBtn.classList.remove('hidden');
            splitBtn.classList.remove('hidden');
        } else {
            previewBtn.classList.add('hidden');
            splitBtn.classList.add('hidden');
            this.state.isPreviewMode = false;
            this.state.isSplitView = false;
        }

        this.updateViewToggleState();
        this.updateEditorLayout();
    }

    updateViewToggleState() {
        const previewBtn = document.getElementById('toggle-preview');
        const splitBtn = document.getElementById('toggle-split');

        if (previewBtn) {
            const isPreview = Boolean(this.state.isPreviewMode);
            previewBtn.setAttribute('aria-pressed', isPreview ? 'true' : 'false');
            previewBtn.setAttribute('aria-label', isPreview ? 'Hide preview' : 'Show preview');
            previewBtn.title = isPreview ? 'Hide Preview' : 'Show Preview';
        }

        if (splitBtn) {
            const isSplit = Boolean(this.state.isSplitView);
            splitBtn.setAttribute('aria-pressed', isSplit ? 'true' : 'false');
            splitBtn.setAttribute('aria-label', isSplit ? 'Hide split view' : 'Show split view');
            splitBtn.title = isSplit ? 'Hide Split View' : 'Show Split View';
        }
    }

    /**
     * Toggle preview mode
     */
    togglePreview() {
        this.state.isPreviewMode = !this.state.isPreviewMode;
        this.state.isSplitView = false;
        this.updateEditorLayout();
        this.renderPreview();
    }

    /**
     * Toggle split view
     */
    toggleSplitView() {
        this.state.isSplitView = !this.state.isSplitView;
        this.state.isPreviewMode = false;
        this.updateEditorLayout();
        this.renderPreview();
    }

    /**
     * Update editor layout based on view mode
     */
    updateEditorLayout() {
        const editorWrapper = document.getElementById('editor-wrapper');
        const previewWrapper = document.getElementById('preview-wrapper');
        const diagramWrapper = document.getElementById('diagram-wrapper');
        const container = document.querySelector('.editor-container');

        this.updateViewToggleState();

        // Reset classes
        container.classList.remove('split');
        editorWrapper.classList.remove('hidden');
        previewWrapper.classList.add('hidden');
        diagramWrapper.classList.add('hidden');

        if (this.state.canvasType === 'diagram') {
            // Diagram mode
            if (this.state.isPreviewMode || this.state.isSplitView) {
                if (this.state.isSplitView) {
                    container.classList.add('split');
                    diagramWrapper.classList.remove('hidden');
                } else {
                    editorWrapper.classList.add('hidden');
                    diagramWrapper.classList.remove('hidden');
                }
            }
        } else if (this.state.canvasType === 'document' || this.state.canvasType === 'frontend') {
            // Document mode
            if (this.state.isPreviewMode || this.state.isSplitView) {
                if (this.state.isSplitView) {
                    container.classList.add('split');
                    previewWrapper.classList.remove('hidden');
                } else {
                    editorWrapper.classList.add('hidden');
                    previewWrapper.classList.remove('hidden');
                }
            }
        }

        this.editor.refresh();
    }

    /**
     * Render preview content
     */
    async renderPreview() {
        const content = this.editor.getValue();
        const handler = this.typeManager.getCurrentHandler();

        if (this.state.canvasType === 'document') {
            const html = handler.renderMarkdown(content);
            document.getElementById('preview-content').innerHTML = html;
        } else if (this.state.canvasType === 'frontend') {
            handler.renderPreview(content, this.state.metadata, 'preview-content');
        } else if (this.state.canvasType === 'diagram') {
            // Reset zoom when manually rendering
            handler.resetZoom();
            await handler.renderDiagram(content, 'diagram-output');
        }
    }

    /**
     * Validate current diagram syntax
     */
    validateDiagramSyntax() {
        if (this.state.canvasType !== 'diagram') return;

        const content = this.editor.getValue();
        const handler = this.typeManager.getHandler('diagram');
        const validation = handler.validateSyntax(content);

        if (!validation.isValid && validation.errors.length > 0) {
            // Convert errors to format expected by editor
            const markers = validation.errors.map(err => ({
                line: err.line,
                message: err.message
            }));
            this.editor.setErrorMarkers(markers);
        } else {
            this.editor.clearErrorMarkers();
        }

        return validation;
    }

    captureSelectionSnapshot() {
        const selection = this.editor?.getSelectionInfo ? this.editor.getSelectionInfo() : null;
        if (selection?.text) {
            this.state.lastSelection = selection;
        } else if (!this.editor?.getSelection?.()) {
            this.state.lastSelection = null;
        }
        return this.state.lastSelection;
    }

    getApplyTarget() {
        const target = document.getElementById('apply-target-select')?.value || this.state.applyTarget || 'full';
        return target === 'selection' ? 'selection' : 'full';
    }

    getGroundingSnapshot(context = '') {
        const content = this.editor.getValue();
        const selection = this.captureSelectionSnapshot();
        const explicitContext = String(context || document.getElementById('context-input')?.value || '');
        const contextSource = explicitContext.trim()
            ? (selection?.text && explicitContext === selection.text ? 'selection' : 'custom')
            : 'canvas';
        const sourceText = explicitContext.trim() || content;
        const applyTarget = this.getApplyTarget();

        return {
            canvasType: this.state.canvasType,
            applyTarget,
            contextSource,
            selection,
            contentLength: content.length,
            contextLength: sourceText.length,
            hasExplicitContext: Boolean(explicitContext.trim()),
            model: this.state.selectedModel || document.getElementById('model-select')?.value || '',
            reasoningEffort: this.state.reasoningEffort || document.getElementById('reasoning-effort-select')?.value || '',
        };
    }

    updateGroundingPanel() {
        const snapshot = this.getGroundingSnapshot();
        const selectionLabel = snapshot.selection?.text
            ? `${snapshot.selection.startLine}:${snapshot.selection.startColumn}-${snapshot.selection.endLine}:${snapshot.selection.endColumn}`
            : 'None';
        const contextLabel = snapshot.contextSource === 'custom'
            ? `Custom (${snapshot.contextLength} chars)`
            : (snapshot.contextSource === 'selection'
                ? `Selection (${snapshot.contextLength} chars)`
                : `Canvas (${snapshot.contentLength} chars)`);

        const values = {
            'grounding-scope': snapshot.canvasType,
            'grounding-selection': selectionLabel,
            'grounding-context': contextLabel,
            'grounding-apply': snapshot.applyTarget === 'selection' ? 'Current selection' : 'Full canvas',
            'grounding-transport': this.api.isConnected() ? 'WS ready' : 'HTTP',
        };

        Object.entries(values).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) {
                element.textContent = value;
            }
        });

        const selectionOption = document.querySelector('#apply-target-select option[value="selection"]');
        if (selectionOption) {
            selectionOption.disabled = !snapshot.selection?.text;
        }
    }

    buildInteractionContract(prompt = '', context = '') {
        const snapshot = this.getGroundingSnapshot(context);
        const selectedText = snapshot.selection?.text || '';
        return {
            version: 1,
            surface: 'canvas',
            endpoint: '/api/canvas',
            canvasType: snapshot.canvasType,
            intentText: prompt,
            contextSource: snapshot.contextSource,
            contextLength: snapshot.contextLength,
            canvasContentLength: snapshot.contentLength,
            selection: snapshot.selection ? {
                text: selectedText,
                startLine: snapshot.selection.startLine,
                startColumn: snapshot.selection.startColumn,
                endLine: snapshot.selection.endLine,
                endColumn: snapshot.selection.endColumn,
                characterCount: snapshot.selection.characterCount,
            } : null,
            expectedApplyTarget: snapshot.applyTarget,
            responseContract: {
                content: 'candidate canvas replacement or selected-range replacement',
                metadata: 'title, language, handoff, bundle, and request-decision details when available',
                suggestions: 'concrete next grounded edits',
            },
        };
    }

    /**
     * Send prompt to AI
     */
    async sendToAI() {
        const prompt = document.getElementById('prompt-input').value.trim();
        const context = document.getElementById('context-input').value.trim();
        const modelSelect = document.getElementById('model-select');
        const reasoningSelect = document.getElementById('reasoning-effort-select');
        const selectedModel = modelSelect ? modelSelect.value : this.state.selectedModel;
        const reasoningEffort = reasoningSelect ? reasoningSelect.value : this.state.reasoningEffort;
        const existingContent = context || this.editor.getValue();
        const interactionContract = this.buildInteractionContract(prompt, context);

        if (!prompt) {
            this.showToast('Please enter a prompt', 'warning');
            return;
        }

        this.state.lastRequestContract = interactionContract;
        this.updateGroundingPanel();
        this.showLoading(true);

        try {
            const response = await this.api.sendCanvasRequest({
                message: prompt,
                sessionId: this.state.sessionId,
                canvasType: this.state.canvasType,
                existingContent,
                model: selectedModel,
                reasoningEffort,
                metadata: {
                    naturalContext: this.buildNaturalContextSnapshot(existingContent),
                    interactionContract,
                },
            });

            this.handleAIResponse(response);
            this.showToast('AI response received', 'success');
        } catch (error) {
            console.error('AI request failed:', error);
            this.showToast(`Error: ${error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    }

    buildNaturalContextSnapshot(content = '') {
        const selection = this.captureSelectionSnapshot();
        const selectedText = selection?.text || '';
        const cursor = this.editor?.getCursorPosition ? this.editor.getCursorPosition() : null;
        const metadata = this.state.metadata || {};

        return {
            activeSurface: 'canvas',
            activeMode: 'canvas',
            activeCanvas: {
                type: this.state.canvasType,
                title: metadata.title || '',
                language: metadata.language || '',
                selectedText,
                selectionLabel: selectedText ? 'current selection' : '',
                selectionRange: selection ? {
                    startLine: selection.startLine,
                    startColumn: selection.startColumn,
                    endLine: selection.endLine,
                    endColumn: selection.endColumn,
                } : null,
                cursorLine: cursor?.line || null,
                contentExcerpt: String(content || '').slice(0, 2400),
                contentLength: String(content || '').length,
            },
            recentTargets: [
                metadata.title || '',
                selectedText ? 'current selection' : '',
                `${this.state.canvasType} canvas`,
            ].filter(Boolean),
        };
    }

    /**
     * Handle AI response
     * @param {Object} response 
     */
    handleAIResponse(response) {
        this.state.aiResponse = response;
        this.state.sessionId = response.sessionId || this.state.sessionId;
        this.state.metadata = response.metadata || {};
        this.state.suggestions = response.suggestions || [];

        if (response.canvasType && response.canvasType !== this.state.canvasType) {
            this.switchCanvasType(response.canvasType);
        }

        // Update session ID display
        document.getElementById('session-id').textContent = 
            this.state.sessionId ? this.state.sessionId.slice(0, 16) + '...' : 'New Session';

        // Show response preview
        const responseSection = document.getElementById('ai-response-section');
        const responsePreview = document.getElementById('response-preview');
        
        responseSection.classList.remove('hidden');
        responsePreview.textContent = this.buildResponsePreview(response);
        this.updateResponseInspector(response);
        const applyTarget = document.getElementById('apply-target-select');
        if (applyTarget) {
            applyTarget.value = this.state.lastSelection?.text ? this.state.applyTarget : 'full';
        }

        // Update suggestions
        this.updateSuggestions(response.suggestions || []);

        this.saveToLocalStorage();
    }

    buildResponsePreview(response) {
        if (!response) {
            return '';
        }

        if (response.canvasType === 'frontend') {
            const metadata = response.metadata || {};
            const handoff = metadata.handoff || {};
            const files = Array.isArray(metadata.bundle?.files) ? metadata.bundle.files : [];
            return [
                handoff.summary || 'Frontend demo ready for preview and repo handoff.',
                files.length > 0 ? `Files: ${files.map((file) => file.path).filter(Boolean).join(', ')}` : '',
                metadata.frameworkTarget ? `Framework target: ${metadata.frameworkTarget}` : '',
            ].filter(Boolean).join('\n');
        }

        const content = String(response.content || '');
        return content.slice(0, 500) + (content.length > 500 ? '...' : '');
    }

    resolveResponseContentForCanvas(response = null) {
        if (!response) {
            return '';
        }

        if (response.canvasType === 'frontend') {
            const bundle = response.metadata?.bundle || {};
            const files = Array.isArray(bundle.files) ? bundle.files : [];
            const entryPath = String(bundle.entry || 'index.html').trim();
            const entryFile = files.find((file) => file?.path === entryPath)
                || files.find((file) => /\.html?$/i.test(String(file?.path || '')));
            if (typeof entryFile?.content === 'string' && entryFile.content.trim()) {
                return entryFile.content;
            }
        }

        return String(response.content || '');
    }

    updateResponseInspector(response) {
        const inspector = document.getElementById('response-inspector');
        if (!inspector) return;

        inspector.innerHTML = '';
        const metadata = response?.metadata || {};
        const assistantMetadata = response?.assistantMetadata || response?.assistant_metadata || {};
        const handoff = metadata.handoff || {};
        const bundleFiles = Array.isArray(metadata.bundle?.files) ? metadata.bundle.files : [];
        const contract = this.state.lastRequestContract || {};
        const items = [
            { label: 'Type', value: response?.canvasType || this.state.canvasType },
            { label: 'Title', value: metadata.title || 'Untitled' },
            { label: 'Apply', value: contract.expectedApplyTarget === 'selection' ? 'Selection' : 'Full canvas' },
            { label: 'Grounding', value: contract.contextSource || 'canvas' },
        ];

        if (metadata.language) {
            items.push({ label: 'Language', value: metadata.language });
        }
        if (metadata.frameworkTarget) {
            items.push({ label: 'Framework', value: metadata.frameworkTarget });
        }
        if (bundleFiles.length > 0) {
            items.push({ label: 'Bundle', value: `${bundleFiles.length} files` });
        }
        if (assistantMetadata?.requestDecision?.outputFormat || assistantMetadata?.outputFormat) {
            items.push({
                label: 'Output',
                value: assistantMetadata.requestDecision?.outputFormat || assistantMetadata.outputFormat,
            });
        }

        items.forEach((item) => {
            const node = document.createElement('div');
            node.className = 'response-inspector-item';
            node.innerHTML = `<span></span><strong></strong>`;
            node.querySelector('span').textContent = item.label;
            node.querySelector('strong').textContent = String(item.value || '-');
            inspector.appendChild(node);
        });

        const summary = handoff.summary || metadata.summary || '';
        if (summary) {
            const summaryNode = document.createElement('div');
            summaryNode.className = 'response-inspector-summary';
            summaryNode.textContent = summary;
            inspector.appendChild(summaryNode);
        }
    }

    /**
     * Apply AI response to canvas
     */
    applyAIResponse() {
        const content = this.resolveResponseContentForCanvas(this.state.aiResponse);
        if (!content) {
            this.showToast('No AI response to apply', 'warning');
            return;
        }

        // Push current state to history
        this.pushToHistory();

        // Apply content
        const applyTarget = this.getApplyTarget();
        const appliedSelection = applyTarget === 'selection' && this.state.lastSelection?.text
            ? this.editor.replaceRange(content, this.state.lastSelection)
            : false;

        if (applyTarget === 'selection' && !appliedSelection) {
            this.showToast('No saved selection to replace; applying to full canvas', 'warning');
        }

        if (!appliedSelection) {
            this.editor.setValue(content);
        }
        this.state.content = this.editor.getValue();
        this.animateCanvasApply(appliedSelection ? 'selection' : 'full');

        // Update metadata if available
        if (this.state.metadata?.language) {
            const handler = this.typeManager.getHandler('code');
            const mode = handler.getCodeMirrorMode(this.state.metadata.language);
            this.editor.setMode(mode);
        }

        // Hide response section
        document.getElementById('ai-response-section').classList.add('hidden');
        
        // Update tab title
        const title = this.state.metadata?.title || 'Untitled';
        document.getElementById('tab-title').textContent = title;

        if (this.state.isPreviewMode || this.state.isSplitView) {
            this.renderPreview();
        }

        this.saveToLocalStorage();
        this.updateGroundingPanel();
        this.showToast(appliedSelection ? 'Selection updated from AI response' : 'Content applied to canvas', 'success');
    }

    animateCanvasApply(target = 'full') {
        const wrapper = document.getElementById('editor-wrapper');
        if (!wrapper) return;

        wrapper.classList.remove('apply-flash-selection', 'apply-flash-full');
        void wrapper.offsetWidth;
        wrapper.classList.add(target === 'selection' ? 'apply-flash-selection' : 'apply-flash-full');
        setTimeout(() => {
            wrapper.classList.remove('apply-flash-selection', 'apply-flash-full');
        }, 900);
    }

    /**
     * Update suggestions panel
     * @param {Array} suggestions 
     */
    updateSuggestions(suggestions) {
        const panel = document.getElementById('suggestions-panel');
        const list = document.getElementById('suggestions-list');

        if (!suggestions || suggestions.length === 0) {
            panel.classList.add('hidden');
            return;
        }

        panel.classList.remove('hidden');
        list.innerHTML = '';

        suggestions.forEach(suggestion => {
            const chip = document.createElement('button');
            chip.className = 'suggestion-chip';
            chip.textContent = suggestion;
            chip.addEventListener('click', () => {
                document.getElementById('prompt-input').value = suggestion;
            });
            list.appendChild(chip);
        });
    }

    /**
     * Push current state to history
     */
    pushToHistory() {
        this.history.push({
            content: this.editor.getValue(),
            canvasType: this.state.canvasType,
            metadata: { ...this.state.metadata }
        });
    }

    /**
     * Undo last change
     */
    undo() {
        const state = this.history.undo();
        if (state) {
            this.restoreState(state);
            this.showToast('Undo', 'info');
        }
    }

    /**
     * Redo last undone change
     */
    redo() {
        const state = this.history.redo();
        if (state) {
            this.restoreState(state);
            this.showToast('Redo', 'info');
        }
    }

    /**
     * Restore state from history
     * @param {Object} state 
     */
    restoreState(state) {
        if (state.canvasType !== this.state.canvasType) {
            this.switchCanvasType(state.canvasType);
        }
        this.editor.setValue(state.content);
        this.state.metadata = { ...state.metadata };
    }

    /**
     * Toggle between dark and light theme
     */
    toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        html.setAttribute('data-theme', newTheme);
        
        // Update editor theme
        const editorTheme = newTheme === 'dark' ? 'dracula' : 'eclipse';
        this.editor.setTheme(editorTheme);

        // Update mermaid theme if diagram mode
        if (this.state.canvasType === 'diagram') {
            const handler = this.typeManager.getHandler('diagram');
            handler.updateTheme(newTheme);
            this.renderPreview();
        }

        localStorage.setItem('canvas-theme', newTheme);
    }

    /**
     * Create new session
     */
    newSession() {
        // Save current session if dirty
        if (this.editor.isDirtyState()) {
            this.saveToLocalStorage();
        }

        // Clear state
        this.state.sessionId = null;
        this.state.content = '';
        this.state.metadata = {};
        this.state.aiResponse = null;
        this.state.lastSelection = null;
        this.state.lastRequestContract = null;
        this.state.applyTarget = 'full';
        this.history.clear();

        // Clear API session
        this.api.clearSession();

        // Reset UI
        document.getElementById('session-id').textContent = 'New Session';
        document.getElementById('prompt-input').value = '';
        document.getElementById('context-input').value = '';
        document.getElementById('ai-response-section').classList.add('hidden');
        document.getElementById('suggestions-panel').classList.add('hidden');
        const applyTarget = document.getElementById('apply-target-select');
        if (applyTarget) {
            applyTarget.value = 'full';
        }

        // Set default content
        const handler = this.typeManager.getCurrentHandler();
        this.editor.setValue(handler.getDefaultContent(), true);

        // Clear localStorage
        localStorage.removeItem('canvas-session');

        this.showToast('New session started', 'success');
        this.updateGroundingPanel();
    }

    /**
     * Copy content to clipboard
     */
    async copyToClipboard() {
        const content = this.editor.getValue();
        if (!content.trim()) {
            this.showToast('Nothing to copy', 'warning');
            return;
        }

        const success = await this.exportManager.copyToClipboard(content);
        if (success) {
            this.showToast('Copied to clipboard!', 'success');
        } else {
            this.showToast('Failed to copy to clipboard', 'error');
        }
    }

    /**
     * Download file
     */
    downloadFile() {
        const content = this.editor.getValue();
        const handler = this.typeManager.getCurrentHandler();
        const language = this.state.metadata?.language || '';
        const title = this.state.metadata?.title || '';

        if (!content.trim()) {
            this.showToast('Nothing to download', 'warning');
            return;
        }

        try {
            if (this.state.canvasType === 'frontend') {
                const bundleFiles = Array.isArray(this.state.metadata?.bundle?.files)
                    ? this.state.metadata.bundle.files.filter((file) => file?.path && typeof file.content === 'string')
                    : [];
                if (bundleFiles.length > 1) {
                    this.showFrontendExportOptions(bundleFiles);
                    return;
                }
            }

            if (this.state.canvasType === 'diagram') {
                // For diagrams, offer SVG/PNG export
                const svgElement = document.querySelector('#diagram-output svg');
                if (svgElement) {
                    this.showDiagramExportOptions(svgElement);
                    return;
                }
            }

            this.exportManager.downloadFile(
                content,
                this.state.canvasType,
                language,
                title
            );

            this.showToast('File downloaded successfully!', 'success');
        } catch (error) {
            console.error('Download failed:', error);
            this.showToast('Failed to download file', 'error');
        }
    }

    /**
     * Show diagram export options
     * @param {HTMLElement} svgElement 
     */
    showDiagramExportOptions(svgElement) {
        const options = [
            { label: 'Mermaid Source (.mmd)', action: () => {
                this.exportManager.downloadFile(
                    this.editor.getValue(),
                    'diagram',
                    'mmd'
                );
            }},
            { label: 'SVG Image (.svg)', action: () => {
                this.exportManager.downloadSVG(svgElement.outerHTML);
            }},
            { label: 'PNG Image (.png)', action: async () => {
                await this.exportManager.downloadPNG(svgElement);
            }}
        ];

        // Create simple modal
        const modal = document.createElement('div');
        modal.className = 'toast info';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', 'Export diagram options');
        modal.innerHTML = `
            <div class="toast-message">
                <strong>Export Diagram</strong><br>
                ${options.map((opt, i) => `<button class="btn btn-secondary" style="margin: 4px;" data-index="${i}">${opt.label}</button>`).join('')}
            </div>
            <button class="toast-close" aria-label="Close export diagram options">&times;</button>
        `;

        modal.querySelectorAll('[data-index]').forEach(btn => {
            btn.addEventListener('click', () => {
                options[btn.dataset.index].action();
                modal.remove();
            });
        });

        modal.querySelector('.toast-close').addEventListener('click', () => {
            modal.remove();
        });

        document.getElementById('toast-container').appendChild(modal);
    }

    showFrontendExportOptions(bundleFiles = []) {
        const safeFiles = bundleFiles.filter((file) => file?.path && typeof file.content === 'string');
        const handoff = this.state.metadata?.handoff || {};
        const options = [
            {
                label: 'Preview HTML (.html)',
                action: () => {
                    this.exportManager.downloadFile(
                        this.editor.getValue(),
                        'frontend',
                        'html',
                        this.state.metadata?.title || 'frontend-demo'
                    );
                },
            },
        ];

        if (safeFiles.length > 0) {
            options.push({
                label: 'All Scaffold Files',
                action: () => {
                    safeFiles.forEach((file) => {
                        this.exportManager.downloadNamedFile(file.content, file.path);
                    });
                },
            });
        }

        options.push({
            label: 'Handoff Manifest (.json)',
            action: () => {
                const manifest = JSON.stringify({
                    title: this.state.metadata?.title || 'Frontend Demo',
                    frameworkTarget: this.state.metadata?.frameworkTarget || 'static',
                    bundle: this.state.metadata?.bundle || { entry: 'index.html', files: safeFiles },
                    handoff,
                }, null, 2);
                this.exportManager.downloadNamedFile(manifest, 'frontend-handoff.json');
            },
        });

        const modal = document.createElement('div');
        modal.className = 'toast info';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', 'Export frontend demo options');
        modal.innerHTML = `
            <div class="toast-message">
                <strong>Export Frontend Demo</strong><br>
                ${options.map((opt, i) => `<button class="btn btn-secondary" style="margin: 4px;" data-index="${i}">${opt.label}</button>`).join('')}
            </div>
            <button class="toast-close" aria-label="Close export frontend demo options">&times;</button>
        `;

        modal.querySelectorAll('[data-index]').forEach((btn) => {
            btn.addEventListener('click', () => {
                options[Number(btn.dataset.index)].action();
                modal.remove();
            });
        });

        modal.querySelector('.toast-close').addEventListener('click', () => {
            modal.remove();
        });

        document.getElementById('toast-container').appendChild(modal);
    }

    /**
     * Schedule auto-save
     */
    scheduleAutoSave() {
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
        }

        document.getElementById('save-status').textContent = 'Unsaved';
        document.getElementById('save-status').classList.add('unsaved');

        this.autoSaveTimer = setTimeout(() => {
            this.saveToLocalStorage();
        }, 2000);
    }

    /**
     * Save to localStorage
     */
    saveToLocalStorage() {
        const data = {
            sessionId: this.state.sessionId,
            canvasType: this.state.canvasType,
            content: this.editor.getValue(),
            metadata: this.state.metadata,
            selectedModel: this.state.selectedModel || '',
            reasoningEffort: this.state.reasoningEffort || '',
            applyTarget: this.state.applyTarget || 'full',
            timestamp: Date.now()
        };

        localStorage.setItem('canvas-session', JSON.stringify(data));
        localStorage.setItem('canvas-history', this.history.serialize());

        document.getElementById('save-status').textContent = 'Saved';
        document.getElementById('save-status').classList.remove('unsaved');
        
        this.state.lastSaved = new Date();
        this.editor.setDirty(false);
    }

    /**
     * Load from localStorage
     */
    loadFromLocalStorage() {
        // Load theme
        const savedTheme = localStorage.getItem('canvas-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);

        // Load session
        const saved = localStorage.getItem('canvas-session');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                this.state.sessionId = data.sessionId;
                this.state.canvasType = data.canvasType || 'code';
                this.state.content = data.content || '';
                this.state.metadata = data.metadata || {};
                this.state.selectedModel = data.selectedModel || this.state.selectedModel || 'gpt-4o';
                this.state.reasoningEffort = ['low', 'medium', 'high', 'xhigh'].includes(data.reasoningEffort)
                    ? data.reasoningEffort
                    : '';
                this.state.applyTarget = data.applyTarget === 'selection' ? 'selection' : 'full';

                // Restore API session
                if (data.sessionId) {
                    this.api.setSessionId(data.sessionId);
                }

                // Restore type
                this.typeManager.setType(this.state.canvasType);
            } catch (error) {
                console.error('Failed to load session:', error);
            }
        }

        // Load history
        const savedHistory = localStorage.getItem('canvas-history');
        if (savedHistory) {
            this.history.deserialize(savedHistory);
        }
    }

    /**
     * Update UI elements
     */
    updateUI() {
        // Update theme toggle
        const theme = document.documentElement.getAttribute('data-theme');

        // Update canvas type buttons
        document.querySelectorAll('.type-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === this.state.canvasType);
        });

        const modelSelect = document.getElementById('model-select');
        if (modelSelect && this.state.selectedModel) {
            modelSelect.value = this.state.selectedModel;
        }

        const reasoningSelect = document.getElementById('reasoning-effort-select');
        if (reasoningSelect) {
            reasoningSelect.value = this.state.reasoningEffort || '';
        }

        const applyTargetSelect = document.getElementById('apply-target-select');
        if (applyTargetSelect) {
            applyTargetSelect.value = this.state.applyTarget || 'full';
        }

        // Update session ID
        if (this.state.sessionId) {
            document.getElementById('session-id').textContent = 
                this.state.sessionId.slice(0, 16) + '...';
        }

        this.updateStatusBar();
    }

    /**
     * Update status bar
     */
    updateStatusBar() {
        const stats = this.editor.getStats();
        const handler = this.typeManager.getHandler(this.state.canvasType);
        const lang = this.state.metadata?.language || '';

        document.getElementById('canvas-type-badge').textContent = 
            handler.getInfo().name;
        
        const langBadge = document.getElementById('language-badge');
        if (lang && this.state.canvasType === 'code') {
            langBadge.textContent = handler.getLanguageLabel?.(lang) || lang;
            langBadge.classList.remove('hidden');
        } else if (this.state.canvasType === 'frontend') {
            langBadge.textContent = this.state.metadata?.frameworkTarget
                ? `${this.state.metadata.frameworkTarget} demo`
                : 'HTML demo';
            langBadge.classList.remove('hidden');
        } else {
            langBadge.classList.add('hidden');
        }

        document.getElementById('word-count').textContent = 
            `${stats.wordCount} words`;
        document.getElementById('line-count').textContent = 
            `${stats.lineCount} lines`;

        // Update dirty indicator
        const tabDirty = document.querySelector('.tab-dirty');
        if (stats.isDirty) {
            tabDirty.classList.remove('hidden');
        } else {
            tabDirty.classList.add('hidden');
        }
    }

    /**
     * Show/hide loading overlay with progress bar
     * @param {boolean} show 
     */
    showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        const progressBar = document.getElementById('loading-progress-bar');
        
        if (show) {
            overlay.classList.remove('hidden');
            // Animate progress bar
            if (progressBar) {
                progressBar.style.width = '0%';
                setTimeout(() => { progressBar.style.width = '30%'; }, 100);
                setTimeout(() => { progressBar.style.width = '60%'; }, 500);
                setTimeout(() => { progressBar.style.width = '85%'; }, 1000);
            }
        } else {
            if (progressBar) {
                progressBar.style.width = '100%';
            }
            setTimeout(() => {
                overlay.classList.add('hidden');
                if (progressBar) {
                    progressBar.style.width = '0%';
                }
            }, 300);
        }
    }

    /**
     * Show toast notification
     * @param {string} message 
     * @param {string} type - 'success', 'error', 'warning', 'info'
     */
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const isUrgent = type === 'error' || type === 'warning';
        toast.setAttribute('role', isUrgent ? 'alert' : 'status');
        toast.setAttribute('aria-live', isUrgent ? 'assertive' : 'polite');
        toast.setAttribute('aria-atomic', 'true');
        toast.innerHTML = `
            <span class="toast-message">${message}</span>
            <button class="toast-close" aria-label="Dismiss notification">&times;</button>
        `;

        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.remove();
        });

        container.appendChild(toast);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, 3000);
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.canvasApp = new CanvasApp();
});
