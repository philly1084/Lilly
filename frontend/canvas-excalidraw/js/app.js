/**
 * Main App Controller - Event coordination and app initialization
 * Enhanced: Uses OpenAI SDK for API communication
 * Fixed: Share functionality, mobile controls, export/import improvements
 */

const CANVAS_CHECKPOINT_STORAGE_KEY = 'kimi-canvas-checkpoints';
const CANVAS_CHECKPOINT_LIMIT = 8;
const CANVAS_DENSITY_STORAGE_KEY = 'kimi-canvas-density';
const CANVAS_ENTERPRISE_STORAGE_KEY = 'kimi-canvas-enterprise-mode';
const CANVAS_SAVED_BLOCK_STORAGE_KEY = 'kimi-canvas-saved-blocks';
const CANVAS_SAVED_BLOCK_LIMIT = 18;
const CANVAS_SAVED_BOARD_STORAGE_KEY = 'kimi-canvas-saved-boards';
const CANVAS_SAVED_BOARD_LIMIT = 12;

class App {
    constructor() {
        this.currentTool = 'selection';
        this.aiTooltipTimeout = null;
        this.lastImport = null; // For undo import functionality
        this.lastCanvasSavedAt = null;
        this.density = this.normalizeDensity(localStorage.getItem(CANVAS_DENSITY_STORAGE_KEY)) || 'comfortable';
        this.enterpriseMode = localStorage.getItem(CANVAS_ENTERPRISE_STORAGE_KEY) === 'true';
        this.activeDockGroup = '';
        this.contextMenuWorldPos = null;
        this.contextLongPressTimer = null;
        this.timelinePreviewTimers = [];
        this.timelinePlaybackFrame = null;
        this.timelinePlaybackStartedAt = 0;
        this.timelinePlaybackBaseTime = 0;
        this.timelineCurrentTime = 0;
        this.timelineActiveCueId = '';
        this.timelinePlaybackActiveProgress = 0;
        this.timelineIsPlaying = false;
        this.timelineAudio = null;
        this.commandPaletteOpen = false;
        this.commandSearchValue = '';
        this.commandPaletteCommands = [];
        this.lastCommandSelectionIds = [];
        this.objectLibraryQuery = '';
        this.objectLibraryFilter = 'all';
        this.helpModalPreviousFocus = null;
        this.init();
    }
    
    init() {
        // Wait for all modules to load
        document.addEventListener('DOMContentLoaded', () => {
            this.applyCoreWorkspaceMode();
            this.applyDensity(this.density);
            if (this.enterpriseMode) {
                this.applyEnterpriseMode(true, { silent: true });
            } else {
                this.updateEnterpriseButton();
            }
            this.setupEventListeners();
            this.setupImageUpload();
            this.setupTheme();
            this.setupExport();
            this.setupKeyboardShortcuts();
            this.setupAutoSave();
            this.setupMobileControls();
            this.setupToolCategoryHeaders();
            this.setupToolDock();
            this.setupCanvasSideRail();
            this.setupSimplifiedInspector();
            this.setupMiniMap();
            this.setupAITooltip();
            this.setupFontSearch();
            this.setupOpacitySlider();
            this.setupCanvasStatusStrip();
            this.setupCanvasCommandPalette();
            
            // Note: WebSocket not used with OpenAI SDK mode
            console.log('OpenAI SDK mode: WebSocket not used');
            
            // Load saved canvas or initial render
            this.loadCanvasFromStorage();
            window.infiniteCanvas?.render();
            this.updateCanvasStatusStrip();
            this.renderObjectLibrary();
            this.renderBoardShelf();
            this.renderProductionTimeline();
            this.initializeArtifactHandoff();
            
            // Push initial state for undo
            window.historyManager?.pushState(window.infiniteCanvas?.elements || []);
            
            // Setup model selector
            this.setupModelSelector();
            
            // Setup AI panel mode toggles
            this.setupAIModeToggles();
            window.aiAssistant?.setMode('chat');
            
            // Setup tooltips
            this.setupTooltips();
            
            // Setup touch/long-press for mobile
            this.setupTouchHandling();
            this.setupCanvasContextMenu();
            
            console.log('Lilly Canvas initialized with OpenAI SDK');
        });
    }

    async initializeArtifactHandoff() {
        if (!window.apiManager?.artifactLineage?.artifactId
            || typeof window.apiManager.ensureArtifactLineageAttached !== 'function') {
            return null;
        }
        try {
            const handoff = await window.apiManager.ensureArtifactLineageAttached();
            if (!handoff?.artifact) {
                return null;
            }
            const capability = handoff.importCapability || {};
            const filename = handoff.artifact.filename || 'source artifact';
            const contextOnly = capability.disposition === 'context-only' || capability.browserImportAllowed !== true;
            this.showToast(
                contextOnly
                    ? `${filename} is attached as exact agent context; the board was not changed.`
                    : `${filename} is attached for agent context; the board was not changed automatically.`,
                contextOnly ? 'info' : 'success',
                5000,
            );
            return handoff;
        } catch (error) {
            this.showToast(error.message || 'The linked artifact could not be attached to Canvas.', 'error', 5000);
            return null;
        }
    }

    applyCoreWorkspaceMode() {
        const stableTools = new Set(
            window.toolManager?.getSupportedTools?.() || [
                'selection',
                'rectangle',
                'ellipse',
                'diamond',
                'line',
                'arrow',
                'freedraw',
                'eraser',
                'text',
                'sticky',
                'frame',
                'image',
                'ai-image',
            ]
        );

        document.body.classList.add('canvas-core-mode');

        document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
            if (!stableTools.has(btn.dataset.tool)) {
                btn.classList.add('core-hidden');
                btn.setAttribute('aria-hidden', 'true');
                btn.tabIndex = -1;
            }
        });

        [
            'menuBtn',
            'themeDropdown',
            'shareBtn',
            'miniMapToggle',
            'miniMap',
            'layersPanel',
            'stickersPanel',
        ].forEach((id) => {
            const node = document.getElementById(id);
            if (node) {
                node.classList.add('core-hidden');
                node.setAttribute('aria-hidden', 'true');
            }
        });

        ['roughnessPicker', 'edgesPicker', 'alignmentGroup'].forEach((id) => {
            const node = document.getElementById(id);
            const group = node?.closest('.property-group') || node;
            if (group) {
                group.classList.add('core-hidden');
                group.setAttribute('aria-hidden', 'true');
            }
        });

        document.querySelectorAll('.tool-category').forEach((category) => {
            const visibleTools = Array.from(category.querySelectorAll('.tool-btn[data-tool]'))
                .filter((btn) => !btn.classList.contains('core-hidden'));

            if (visibleTools.length === 0 && !category.querySelector('#aiAssistantBtn')) {
                category.classList.add('core-hidden');
                return;
            }

            category.classList.add('expanded');
        });
    }

    normalizeDensity(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        if (['compact', 'dense', 'operator'].includes(normalized)) {
            return 'compact';
        }
        if (['comfortable', 'comfort', 'default', 'roomy'].includes(normalized)) {
            return 'comfortable';
        }
        return '';
    }

    getDensityLabel(value = this.density) {
        return value === 'compact' ? 'Compact' : 'Roomy';
    }

    applyDensity(value = this.density) {
        const density = this.normalizeDensity(value) || 'comfortable';
        this.density = density;
        document.body.setAttribute('data-density', density);
        localStorage.setItem(CANVAS_DENSITY_STORAGE_KEY, density);
        this.updateDensityButton();
        this.updateCanvasStatusStrip();
    }

    toggleDensity() {
        const nextDensity = this.density === 'compact' ? 'comfortable' : 'compact';
        this.applyDensity(nextDensity);
        this.showToast(`Density changed to ${this.getDensityLabel(this.density)}`);
    }

    updateDensityButton() {
        const button = document.getElementById('densityBtn');
        if (!button) {
            return;
        }
        const label = this.getDensityLabel(this.density);
        button.title = `Density: ${label}`;
        button.setAttribute('aria-label', `Toggle layout density. Current density: ${label}`);
        button.classList.toggle('active', this.density === 'compact');
    }

    applyEnterpriseMode(enabled = true, options = {}) {
        this.enterpriseMode = Boolean(enabled);
        document.body.setAttribute('data-enterprise-mode', this.enterpriseMode ? 'on' : 'off');
        localStorage.setItem(CANVAS_ENTERPRISE_STORAGE_KEY, String(this.enterpriseMode));
        this.applyDensity(this.enterpriseMode ? 'compact' : 'comfortable');
        this.updateEnterpriseButton();
        this.updateCanvasStatusStrip();
        if (!options.silent) {
            this.showToast(this.enterpriseMode ? 'Focus workspace on' : 'Focus workspace off');
            if (this.enterpriseMode) {
                this.selectCanvasPanel?.('creative');
            }
        }
    }

    toggleEnterpriseMode() {
        this.applyEnterpriseMode(!this.enterpriseMode);
    }

    updateEnterpriseButton() {
        const button = document.getElementById('enterpriseModeBtn');
        if (!button) {
            return;
        }
        button.classList.toggle('active', this.enterpriseMode);
        button.title = this.enterpriseMode ? 'Focus workspace active' : 'Toggle focus workspace';
        button.setAttribute('aria-label', 'Toggle focus workspace');
        button.setAttribute('aria-pressed', this.enterpriseMode ? 'true' : 'false');
    }
    
    setupAutoSave() {
        // Auto-save every 30 seconds
        this.autoSaveInterval = setInterval(() => {
            this.saveCanvasToStorage();
            this.updateCanvasStatusStrip();
        }, 30000);
        
        // Save on page unload
        window.addEventListener('beforeunload', () => {
            this.saveCanvasToStorage();
        });
        
        // Save on visibility change (tab switch)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveCanvasToStorage();
            }
        });
    }
    
    saveCanvasToStorage() {
        try {
            const canvas = window.infiniteCanvas;
            if (!canvas || canvas.elements.length === 0) {
                localStorage.removeItem('kimi-canvas-autosave');
                this.lastCanvasSavedAt = null;
                this.updateCanvasStatusStrip();
                this.renderObjectLibrary();
                return;
            }
            
            const data = {
                elements: this.getSerializableCanvasElements(canvas.elements),
                timestamp: Date.now(),
                version: '1.0'
            };
            
            localStorage.setItem('kimi-canvas-autosave', JSON.stringify(data));
            this.lastCanvasSavedAt = data.timestamp;
            this.updateCanvasStatusStrip();
        } catch (error) {
            console.warn('Failed to auto-save canvas:', error);
        }
    }

    setupCanvasStatusStrip() {
        this.canvasObjectCount = document.getElementById('canvasObjectCount');
        this.canvasSelectionCount = document.getElementById('canvasSelectionCount');
        this.canvasCheckpointCount = document.getElementById('canvasCheckpointCount');
        this.canvasModeState = document.getElementById('canvasModeState');
        this.canvasSaveState = document.getElementById('canvasSaveState');
        this.updateCanvasStatusStrip();
    }

    updateCanvasStatusStrip() {
        const canvas = window.infiniteCanvas;
        const objectCount = canvas?.elements?.length || 0;
        const selectedCount = canvas?.selectedElements?.length || 0;
        const checkpointCount = this.loadCanvasCheckpoints?.().length || 0;
        const savedAt = Number(this.lastCanvasSavedAt || 0);
        const saveLabel = savedAt
            ? `Saved ${this.formatRelativeTime(savedAt)}`
            : (objectCount > 0 ? 'Draft' : 'Empty');

        if (this.canvasObjectCount) {
            this.canvasObjectCount.textContent = String(objectCount);
        }
        if (this.canvasSelectionCount) {
            this.canvasSelectionCount.textContent = String(selectedCount);
        }
        if (this.canvasCheckpointCount) {
            this.canvasCheckpointCount.textContent = String(checkpointCount);
        }
        if (this.canvasModeState) {
            this.canvasModeState.textContent = this.enterpriseMode ? 'Enterprise' : this.getDensityLabel(this.density);
        }
        if (this.canvasSaveState) {
            this.canvasSaveState.textContent = saveLabel;
        }
    }

    formatRelativeTime(timestamp) {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
        if (elapsedSeconds < 5) return 'now';
        if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
        const minutes = Math.floor(elapsedSeconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    }

    getSerializableCanvasElements(elements = []) {
        return (Array.isArray(elements) ? elements : []).map(el => {
            const copy = {
                ...el,
                points: Array.isArray(el.points)
                    ? el.points.map(point => Array.isArray(point) ? [...point] : point)
                    : el.points,
                boundElements: Array.isArray(el.boundElements)
                    ? el.boundElements.map(bound => ({ ...bound }))
                    : el.boundElements,
            };
            delete copy.imageElement;
            return copy;
        });
    }

    normalizeCanvasElement(element = {}) {
        const normalized = { ...element };
        delete normalized.imageElement;
        if (!normalized.strokeColor) normalized.strokeColor = '#000000';
        if (!normalized.backgroundColor) normalized.backgroundColor = 'transparent';
        if (!normalized.strokeWidth) normalized.strokeWidth = 2;
        if (!normalized.strokeStyle) normalized.strokeStyle = 'solid';
        if (normalized.roughness === undefined) normalized.roughness = 1;
        if (normalized.opacity === undefined) normalized.opacity = 1;
        if (Array.isArray(normalized.points)) {
            normalized.points = normalized.points.map(point => Array.isArray(point) ? [...point] : point);
        }
        if (Array.isArray(normalized.boundElements)) {
            normalized.boundElements = normalized.boundElements.map(bound => ({ ...bound }));
        }
        return normalized;
    }

    loadCanvasCheckpoints() {
        try {
            const saved = JSON.parse(localStorage.getItem(CANVAS_CHECKPOINT_STORAGE_KEY) || '[]');
            if (!Array.isArray(saved)) {
                return [];
            }
            return saved
                .map(checkpoint => ({
                    id: String(checkpoint?.id || '').trim(),
                    name: String(checkpoint?.name || '').trim(),
                    createdAt: String(checkpoint?.createdAt || ''),
                    elementCount: Number(checkpoint?.elementCount || 0),
                    elements: Array.isArray(checkpoint?.elements)
                        ? checkpoint.elements.map(element => this.normalizeCanvasElement(element))
                        : [],
                }))
                .filter(checkpoint => checkpoint.id && checkpoint.name && checkpoint.createdAt)
                .slice(0, CANVAS_CHECKPOINT_LIMIT);
        } catch (error) {
            console.warn('Failed to load canvas checkpoints:', error);
            return [];
        }
    }

    saveCanvasCheckpoints(checkpoints = []) {
        const next = (Array.isArray(checkpoints) ? checkpoints : []).slice(0, CANVAS_CHECKPOINT_LIMIT);
        try {
            localStorage.setItem(CANVAS_CHECKPOINT_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
            console.warn('Failed to save canvas checkpoints:', error);
            this.showToast('Could not save checkpoint storage', 'error');
        }
        return next;
    }

    saveCanvasCheckpoint(name = '') {
        const canvas = window.infiniteCanvas;
        const elements = this.getSerializableCanvasElements(canvas?.elements || []);
        if (!canvas || elements.length === 0) {
            this.showToast('Add board objects before saving a checkpoint', 'warning');
            return null;
        }

        const requestedName = name || window.prompt?.('Name this board checkpoint', `Checkpoint ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        const checkpointName = String(requestedName || '').trim();
        if (!checkpointName) {
            return null;
        }

        const checkpoint = {
            id: `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: checkpointName.slice(0, 72),
            createdAt: new Date().toISOString(),
            elementCount: elements.length,
            elements,
        };
        const checkpoints = [
            checkpoint,
            ...this.loadCanvasCheckpoints().filter(existing => existing.name !== checkpoint.name),
        ].slice(0, CANVAS_CHECKPOINT_LIMIT);
        this.saveCanvasCheckpoints(checkpoints);
        window.aiAssistant?.renderCheckpoints?.();
        this.updateCanvasStatusStrip();
        this.showToast(`Saved checkpoint "${checkpoint.name}"`);
        return checkpoint;
    }

    restoreCanvasCheckpoint(id = '') {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return false;
        }
        const checkpoint = this.loadCanvasCheckpoints().find(item => item.id === id);
        if (!checkpoint) {
            this.showToast('Checkpoint was not found', 'warning');
            return false;
        }

        const accepted = window.confirm?.(`Restore checkpoint "${checkpoint.name}" and replace the current board?`) ?? true;
        if (!accepted) {
            return false;
        }

        canvas.elements = checkpoint.elements.map(element => this.normalizeCanvasElement(element));
        canvas.deselectAll?.();
        canvas.render?.();
        window.historyManager?.pushState(canvas.elements);
        this.saveCanvasToStorage();
        window.aiAssistant?.updateGroundingPanel?.();
        window.aiAssistant?.renderCheckpoints?.();
        this.updateCanvasStatusStrip();
        this.showToast(`Restored checkpoint "${checkpoint.name}"`);
        return true;
    }

    deleteCanvasCheckpoint(id = '') {
        const checkpoints = this.loadCanvasCheckpoints();
        const checkpoint = checkpoints.find(item => item.id === id);
        this.saveCanvasCheckpoints(checkpoints.filter(item => item.id !== id));
        window.aiAssistant?.renderCheckpoints?.();
        this.updateCanvasStatusStrip();
        if (checkpoint) {
            this.showToast(`Deleted checkpoint "${checkpoint.name}"`);
        }
    }

    loadSavedBoards() {
        try {
            const saved = JSON.parse(localStorage.getItem(CANVAS_SAVED_BOARD_STORAGE_KEY) || '[]');
            if (!Array.isArray(saved)) {
                return [];
            }
            return saved
                .map((board) => ({
                    id: String(board?.id || '').trim(),
                    name: String(board?.name || '').trim(),
                    createdAt: String(board?.createdAt || ''),
                    updatedAt: String(board?.updatedAt || board?.createdAt || ''),
                    elementCount: Number(board?.elementCount || 0),
                    summary: String(board?.summary || '').trim(),
                    elements: Array.isArray(board?.elements)
                        ? board.elements.map((element) => this.normalizeCanvasElement(element))
                        : [],
                }))
                .filter((board) => board.id && board.name && board.elements.length > 0)
                .slice(0, CANVAS_SAVED_BOARD_LIMIT);
        } catch (error) {
            console.warn('Failed to load saved canvas boards:', error);
            return [];
        }
    }

    saveSavedBoards(boards = []) {
        const next = (Array.isArray(boards) ? boards : []).slice(0, CANVAS_SAVED_BOARD_LIMIT);
        try {
            localStorage.setItem(CANVAS_SAVED_BOARD_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
            console.warn('Failed to save canvas boards:', error);
            this.showToast('Could not save board shelf', 'error');
        }
        return next;
    }

    buildSavedBoardSummary(elements = []) {
        const typeCounts = elements.reduce((counts, element) => {
            const type = element?.type || 'object';
            counts[type] = (counts[type] || 0) + 1;
            return counts;
        }, {});
        const parts = [
            typeCounts.storyboardFrame ? `${typeCounts.storyboardFrame} scenes` : '',
            typeCounts.animationBeat ? `${typeCounts.animationBeat} motion` : '',
            typeCounts.audioCue ? `${typeCounts.audioCue} audio` : '',
            typeCounts.mermaidDiagram ? `${typeCounts.mermaidDiagram} mermaid` : '',
        ].filter(Boolean);
        return parts.length > 0 ? parts.join(' / ') : `${elements.length} object${elements.length === 1 ? '' : 's'}`;
    }

    saveCurrentBoard(name = '') {
        const canvas = window.infiniteCanvas;
        const elements = this.getSerializableCanvasElements(canvas?.elements || []);
        if (!canvas || elements.length === 0) {
            this.showToast('Add objects before saving a board', 'warning');
            return null;
        }

        const fallbackName = `Board ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
        const requestedName = name || window.prompt?.('Name this saved board', fallbackName);
        const boardName = String(requestedName || '').trim();
        if (!boardName) {
            return null;
        }

        const now = new Date().toISOString();
        const existing = this.loadSavedBoards();
        const board = {
            id: `board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: boardName.slice(0, 72),
            createdAt: now,
            updatedAt: now,
            elementCount: elements.length,
            summary: this.buildSavedBoardSummary(elements),
            elements,
        };
        this.saveSavedBoards([
            board,
            ...existing.filter((item) => item.name !== board.name),
        ]);
        this.renderBoardShelf();
        this.updateCanvasStatusStrip();
        this.showToast(`Saved board "${board.name}"`);
        return board;
    }

    restoreSavedBoard(boardId = '') {
        const canvas = window.infiniteCanvas;
        const board = this.loadSavedBoards().find((item) => item.id === boardId);
        if (!canvas || !board) {
            this.showToast('Saved board was not found', 'warning');
            return false;
        }
        const accepted = window.confirm?.(`Open saved board "${board.name}" and replace the current canvas?`) ?? true;
        if (!accepted) {
            return false;
        }

        canvas.elements = board.elements.map((element) => this.normalizeCanvasElement(element));
        canvas.deselectAll?.();
        canvas.render?.();
        window.historyManager?.pushState(canvas.elements);
        this.onCanvasElementsChanged();
        this.selectCanvasPanel('objects');
        this.showToast(`Opened "${board.name}"`);
        return true;
    }

    duplicateSavedBoard(boardId = '') {
        const boards = this.loadSavedBoards();
        const board = boards.find((item) => item.id === boardId);
        if (!board) {
            this.showToast('Saved board was not found', 'warning');
            return null;
        }
        const now = new Date().toISOString();
        const duplicate = {
            ...board,
            id: `board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: `${board.name} copy`.slice(0, 72),
            createdAt: now,
            updatedAt: now,
            elements: board.elements.map((element) => this.normalizeCanvasElement(element)),
        };
        this.saveSavedBoards([duplicate, ...boards]);
        this.renderBoardShelf();
        this.showToast(`Duplicated "${board.name}"`);
        return duplicate;
    }

    deleteSavedBoard(boardId = '') {
        const boards = this.loadSavedBoards();
        const board = boards.find((item) => item.id === boardId);
        this.saveSavedBoards(boards.filter((item) => item.id !== boardId));
        this.renderBoardShelf();
        this.updateCanvasStatusStrip();
        this.showToast(board ? `Deleted "${board.name}"` : 'Deleted saved board');
    }

    exportSavedBoard(boardId = '') {
        const board = this.loadSavedBoards().find((item) => item.id === boardId);
        if (!board) {
            this.showToast('Saved board was not found', 'warning');
            return false;
        }
        const payload = {
            app: 'Lilly Canvas',
            version: '1.0',
            exportedAt: new Date().toISOString(),
            board,
        };
        const slug = board.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'canvas-board';
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        this.downloadFile(URL.createObjectURL(blob), `${slug}.canvas-board.json`);
        this.showToast(`Exported "${board.name}"`);
        return true;
    }

    renderBoardShelf() {
        const list = document.getElementById('boardShelfList');
        const summary = document.getElementById('boardShelfSummary');
        if (!list) return;

        const boards = this.loadSavedBoards();
        if (summary) {
            summary.textContent = boards.length > 0
                ? `${boards.length} saved board${boards.length === 1 ? '' : 's'}`
                : 'No saved boards yet';
        }
        if (boards.length === 0) {
            list.innerHTML = '<div class="board-shelf-empty">Save named boards here, then restore, duplicate, or export them later.</div>';
            return;
        }

        list.innerHTML = boards.map((board) => {
            const dateMs = Date.parse(board.updatedAt || board.createdAt) || Date.now();
            const detail = `${board.elementCount || board.elements.length} objects - ${this.formatRelativeTime(dateMs)}`;
            const boardName = this.escapeHtmlAttr(board.name);
            return `
                <div class="board-shelf-item" data-board-id="${this.escapeHtmlAttr(board.id)}">
                    <button type="button" class="board-shelf-main" data-board-shelf-action="open" data-board-id="${this.escapeHtmlAttr(board.id)}" aria-label="Open saved board ${boardName}">
                        <strong>${this.escapeHtml(board.name)}</strong>
                        <span>${this.escapeHtml(board.summary || detail)}</span>
                        <small>${this.escapeHtml(detail)}</small>
                    </button>
                    <div class="board-shelf-actions">
                        <button type="button" data-board-shelf-action="duplicate" data-board-id="${this.escapeHtmlAttr(board.id)}" aria-label="Duplicate saved board ${boardName}">Duplicate</button>
                        <button type="button" data-board-shelf-action="export" data-board-id="${this.escapeHtmlAttr(board.id)}" aria-label="Export saved board ${boardName}">Export</button>
                        <button type="button" data-board-shelf-action="delete" data-board-id="${this.escapeHtmlAttr(board.id)}" aria-label="Delete saved board ${boardName}">Delete</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    handleBoardShelfAction(action = '', boardId = '') {
        if (action === 'save-current') {
            this.saveCurrentBoard();
        } else if (action === 'open') {
            this.restoreSavedBoard(boardId);
        } else if (action === 'duplicate') {
            this.duplicateSavedBoard(boardId);
        } else if (action === 'export') {
            this.exportSavedBoard(boardId);
        } else if (action === 'delete') {
            this.deleteSavedBoard(boardId);
        }
    }
    
    loadCanvasFromStorage() {
        try {
            const saved = localStorage.getItem('kimi-canvas-autosave');
            if (!saved) return;
            
            const data = JSON.parse(saved);
            if (!data.elements || !Array.isArray(data.elements)) return;
            
            const canvas = window.infiniteCanvas;
            if (!canvas) return;
            
            const savedTime = new Date(data.timestamp).toLocaleString();
            
            data.elements.forEach(el => {
                canvas.elements.push(this.normalizeCanvasElement(el));
            });
            this.lastCanvasSavedAt = Number(data.timestamp || 0) || null;
            
            canvas.render();
            this.updateCanvasStatusStrip();
            console.log(`Restored ${data.elements.length} elements from auto-save (${savedTime})`);
        } catch (error) {
            console.warn('Failed to load auto-saved canvas:', error);
        }
    }
    
    setupEventListeners() {
        // Zoom controls
        document.getElementById('zoomInBtn')?.addEventListener('click', () => {
            window.infiniteCanvas?.zoomIn();
        });
        
        document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
            window.infiniteCanvas?.zoomOut();
        });
        
        document.getElementById('resetZoomBtn')?.addEventListener('click', () => {
            window.infiniteCanvas?.resetZoom();
        });
        
        // Theme picker dropdown
        const themePickerBtn = document.getElementById('themePickerBtn');
        const themeDropdown = document.getElementById('themeDropdown');
        document.getElementById('densityBtn')?.addEventListener('click', () => {
            this.toggleDensity();
        });
        document.getElementById('enterpriseModeBtn')?.addEventListener('click', () => {
            this.toggleEnterpriseMode();
        });
        
        themePickerBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDropdown(themeDropdown, themePickerBtn);
        });
        this.setupDropdownKeyboard(themeDropdown, themePickerBtn);
        
        // Theme selection
        document.querySelectorAll('[data-theme]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const theme = btn.dataset.theme;
                this.setTheme(theme);
                this.closeDropdown(themeDropdown, themePickerBtn);
                themePickerBtn?.focus?.();
            });
        });
        
        // Close theme dropdown when clicking outside
        document.addEventListener('click', () => {
            this.closeDropdown(themeDropdown, themePickerBtn);
        });
        
        // Export button - show new export dialog
        const exportBtn = document.getElementById('exportBtn');
        const exportDropdown = document.getElementById('exportDropdown');
        
        exportBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (exportDropdown) {
                this.toggleDropdown(exportDropdown, exportBtn);
            } else {
                window.importExportManager?.showExportDialog();
            }
        });
        this.setupDropdownKeyboard(exportDropdown, exportBtn);
        
        // Export dropdown items - auto-close on selection
        document.querySelectorAll('[data-export]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const format = btn.dataset.export;
                
                // Show progress modal for PDF export
                if (format === 'pdf') {
                    this.showExportProgress();
                }
                
                await window.importExportManager?.export(format);
                
                // Hide progress modal
                if (format === 'pdf') {
                    this.hideExportProgress();
                }
                
                if (exportDropdown) {
                    this.closeDropdown(exportDropdown, exportBtn);
                    exportBtn?.focus?.();
                }
            });
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            if (exportDropdown) {
                this.closeDropdown(exportDropdown, exportBtn);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            const closedTheme = this.closeDropdown(themeDropdown, themePickerBtn);
            const closedExport = this.closeDropdown(exportDropdown, exportBtn);
            if (closedTheme || closedExport) {
                event.preventDefault();
            }
        });
        
        // Import button - show import dialog
        document.getElementById('importBtn')?.addEventListener('click', () => {
            window.importExportManager?.showImportDialog();
        });
        
        // File import input
        const fileImportInput = document.getElementById('fileImportInput');
        fileImportInput?.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                await window.importExportManager?.importFiles(files);
            }
            // Reset input
            e.target.value = '';
        });
        
        // Help button
        document.getElementById('helpBtn')?.addEventListener('click', () => {
            this.showHelpModal();
        });
        
        // Share button - implement share functionality
        document.getElementById('shareBtn')?.addEventListener('click', () => {
            this.shareCanvas();
        });
        
        // Clear canvas button
        document.getElementById('clearBtn')?.addEventListener('click', () => {
            this.clearCanvas();
        });
        
        // Templates button (if exists in menu/toolbar)
        document.getElementById('templatesBtn')?.addEventListener('click', () => {
            window.templatesManager?.showTemplatesModal();
        });
        
        // Menu button - open templates
        document.getElementById('menuBtn')?.addEventListener('click', () => {
            window.templatesManager?.showTemplatesModal();
        });
        
        // Stickers toggle button (if exists in toolbar)
        document.querySelector('.tool-btn[data-tool="stickers"]')?.addEventListener('click', () => {
            window.stickersManager?.toggleStickersPanel();
        });
        
        // Legacy Export modal (keep for backward compatibility)
        document.getElementById('closeExportModal')?.addEventListener('click', () => {
            this.hideExportModal();
        });
        
        document.querySelectorAll('.export-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.exportCanvas(btn.dataset.format);
            });
        });
        
        // Help modal
        document.getElementById('closeHelpModal')?.addEventListener('click', () => {
            this.hideHelpModal();
        });

        document.getElementById('helpModal')?.addEventListener('keydown', (event) => {
            this.handleHelpModalKeydown(event);
        });
        
        // Close modals on backdrop click
        document.getElementById('exportModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.hideExportModal();
        });
        
        document.getElementById('helpModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.hideHelpModal();
        });
        
        // Drag and drop for files with overlay
        const fileDropOverlay = document.getElementById('fileDropOverlay');
        let dragCounter = 0;
        
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            if (fileDropOverlay) {
                fileDropOverlay.classList.add('active');
            }
            document.body.classList.add('drag-over');
        });
        
        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter === 0) {
                if (fileDropOverlay) {
                    fileDropOverlay.classList.remove('active');
                }
                document.body.classList.remove('drag-over');
            }
        });
        
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        document.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            if (fileDropOverlay) {
                fileDropOverlay.classList.remove('active');
            }
            document.body.classList.remove('drag-over');
            await this.handleFileDrop(e);
        });
        
        // Prevent leaving page with unsaved changes
        window.addEventListener('beforeunload', (e) => {
            const canvas = window.infiniteCanvas;
            if (canvas && canvas.elements.length > 0) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    toggleDropdown(dropdown, trigger) {
        if (!dropdown) return false;
        const shouldOpen = !dropdown.classList.contains('active');
        this.setDropdownOpen(dropdown, trigger, shouldOpen);
        return shouldOpen;
    }

    closeDropdown(dropdown, trigger) {
        if (!dropdown || !dropdown.classList.contains('active')) return false;
        this.setDropdownOpen(dropdown, trigger, false);
        return true;
    }

    setDropdownOpen(dropdown, trigger, isOpen) {
        dropdown.classList.toggle('active', isOpen);
        trigger?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        this.syncDropdownMenuTabStop(dropdown, isOpen ? this.getDropdownMenuItems(dropdown)[0] : null);
    }

    getDropdownMenuItems(dropdown) {
        return Array.from(dropdown?.querySelectorAll('[role="menuitem"]:not([disabled])') || []);
    }

    syncDropdownMenuTabStop(dropdown, activeItem = null) {
        const items = this.getDropdownMenuItems(dropdown);
        items.forEach((item) => {
            item.setAttribute('tabindex', item === activeItem ? '0' : '-1');
        });
    }

    focusDropdownMenuItem(dropdown, nextIndex = 0) {
        const items = this.getDropdownMenuItems(dropdown);
        if (!items.length) return false;
        const normalizedIndex = ((nextIndex % items.length) + items.length) % items.length;
        this.syncDropdownMenuTabStop(dropdown, items[normalizedIndex]);
        items[normalizedIndex].focus();
        return true;
    }

    setupDropdownKeyboard(dropdown, trigger) {
        if (!dropdown || !trigger) return;
        const menu = dropdown.querySelector('[role="menu"]');
        if (!menu) return;
        this.syncDropdownMenuTabStop(dropdown);

        trigger.addEventListener('keydown', (event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            this.setDropdownOpen(dropdown, trigger, true);
            const items = this.getDropdownMenuItems(dropdown);
            const lastIndex = Math.max(0, items.length - 1);
            this.focusDropdownMenuItem(dropdown, event.key === 'ArrowUp' || event.key === 'End' ? lastIndex : 0);
        });

        menu.addEventListener('keydown', (event) => {
            const items = this.getDropdownMenuItems(dropdown);
            if (!items.length) return;
            const currentIndex = Math.max(0, items.indexOf(document.activeElement));
            let nextIndex = currentIndex;

            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                nextIndex = currentIndex + 1;
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                nextIndex = currentIndex - 1;
            } else if (event.key === 'Home') {
                nextIndex = 0;
            } else if (event.key === 'End') {
                nextIndex = items.length - 1;
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.closeDropdown(dropdown, trigger);
                trigger.focus();
                return;
            } else {
                return;
            }

            event.preventDefault();
            this.focusDropdownMenuItem(dropdown, nextIndex);
        });

        dropdown.addEventListener('focusout', (event) => {
            if (event.relatedTarget && !dropdown.contains(event.relatedTarget)) {
                this.closeDropdown(dropdown, trigger);
            }
        });
    }

    setMobilePanelOpen(panel, trigger, isOpen, { restoreFocus = false } = {}) {
        panel?.classList.toggle('active', isOpen);
        trigger?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        const actionLabel = isOpen ? trigger?.dataset.closeLabel : trigger?.dataset.openLabel;
        const actionTitle = isOpen ? trigger?.dataset.closeTitle : trigger?.dataset.openTitle;
        if (actionLabel) {
            trigger.setAttribute('aria-label', actionLabel);
        }
        if (actionTitle) {
            trigger.title = actionTitle;
        }
        if (!isOpen && restoreFocus) {
            trigger?.focus?.();
        }
    }

    setupMobileControls() {
        // Mobile toolbar toggle
        const mobileToolbarToggle = document.getElementById('mobileToolbarToggle');
        const toolbar = document.getElementById('toolbar');
        const mobileToolbarClose = document.getElementById('mobileToolbarClose');
        
        mobileToolbarToggle?.addEventListener('click', () => {
            this.setMobilePanelOpen(propertiesPanel, mobilePropertiesToggle, false);
            window.aiAssistant?.hidePanel();
            this.setMobilePanelOpen(toolbar, mobileToolbarToggle, true);
            if (!this.activeDockGroup) {
                this.openToolDockGroup('shapes');
            }
        });
        
        mobileToolbarClose?.addEventListener('click', () => {
            this.setMobilePanelOpen(toolbar, mobileToolbarToggle, false, { restoreFocus: true });
        });
        
        // Mobile properties panel toggle
        const mobilePropertiesToggle = document.getElementById('mobilePropertiesToggle');
        const propertiesPanel = document.getElementById('propertiesPanel');
        const mobilePropertiesClose = document.getElementById('mobilePropertiesClose');
        
        mobilePropertiesToggle?.addEventListener('click', () => {
            const isOpen = propertiesPanel?.classList.contains('active');
            this.setMobilePanelOpen(toolbar, mobileToolbarToggle, false);
            window.aiAssistant?.hidePanel();
            this.setMobilePanelOpen(propertiesPanel, mobilePropertiesToggle, !isOpen);
        });
        
        mobilePropertiesClose?.addEventListener('click', () => {
            this.setMobilePanelOpen(propertiesPanel, mobilePropertiesToggle, false, { restoreFocus: true });
        });
    }

    setupToolCategoryHeaders() {
        document.querySelectorAll('.tool-category-header').forEach((header) => {
            const category = header.closest('.tool-category');
            const content = category?.querySelector('.tool-category-content');
            if (!category || !content) return;

            const syncExpandedState = () => {
                header.setAttribute('aria-expanded', category.classList.contains('expanded') ? 'true' : 'false');
            };

            if (content.id) {
                header.setAttribute('aria-controls', content.id);
            }

            syncExpandedState();
            header.addEventListener('click', () => {
                category.classList.toggle('expanded');
                syncExpandedState();
            });
        });
    }

    setupToolDock() {
        const toolbar = document.getElementById('toolbar');
        const railButtons = Array.from(document.querySelectorAll('.tool-dock-btn'));
        if (!toolbar || railButtons.length === 0) return;

        railButtons.forEach((btn) => {
            if (btn.dataset.dockGroup) {
                btn.setAttribute('aria-expanded', 'false');
            }

            btn.addEventListener('click', () => {
                const tool = btn.dataset.dockTool;
                const group = btn.dataset.dockGroup;

                if (tool) {
                    window.toolManager?.setTool(tool);
                    this.closeToolDockTray();
                    this.syncToolDockActive(tool);
                    if (tool === 'image') {
                        document.getElementById('imageInput')?.click();
                    }
                    return;
                }

                if (group) {
                    if (this.activeDockGroup === group) {
                        this.closeToolDockTray();
                    } else {
                        this.openToolDockGroup(group);
                    }
                }
            });

            btn.addEventListener('keydown', (e) => {
                if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Escape'].includes(e.key)) return;
                e.preventDefault();
                if (e.key === 'Escape') {
                    this.closeToolDockTray();
                    btn.focus();
                    return;
                }
                const direction = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
                const nextIndex = (railButtons.indexOf(btn) + direction + railButtons.length) % railButtons.length;
                railButtons[nextIndex]?.focus();
            });
        });

        document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.syncToolDockActive(btn.dataset.tool);
                if (!window.matchMedia('(max-width: 768px)').matches) {
                    this.closeToolDockTray();
                }
            });
        });

        this.syncToolDockActive(window.toolManager?.currentTool || this.currentTool);
    }

    getToolDockGroups(group) {
        const groups = {
            shapes: ['basic', 'shapes'],
            content: ['content'],
            lines: ['lines'],
            draw: ['draw'],
            ai: ['ai'],
        };
        return groups[group] || [group];
    }

    openToolDockGroup(group) {
        this.activeDockGroup = group;
        const openGroups = new Set(this.getToolDockGroups(group));

        document.querySelectorAll('.tool-category[data-tool-group]').forEach((category) => {
            category.classList.toggle('is-open', openGroups.has(category.dataset.toolGroup));
        });

        document.querySelectorAll('.tool-dock-btn').forEach((btn) => {
            const isOpen = btn.dataset.dockGroup === group;
            if (btn.dataset.dockGroup) {
                btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }
            btn.classList.toggle('active', isOpen || btn.dataset.dockTool === (window.toolManager?.currentTool || this.currentTool));
        });
    }

    closeToolDockTray() {
        this.activeDockGroup = '';
        document.querySelectorAll('.tool-category.is-open').forEach((category) => {
            category.classList.remove('is-open');
        });
        document.querySelectorAll('.tool-dock-btn[data-dock-group]').forEach((btn) => {
            btn.setAttribute('aria-expanded', 'false');
            btn.classList.remove('active');
        });
        this.syncToolDockActive(window.toolManager?.currentTool || this.currentTool);
    }

    syncToolDockActive(toolName = 'selection') {
        this.currentTool = toolName;
        const toolToGroup = {
            rectangle: 'shapes',
            ellipse: 'shapes',
            diamond: 'shapes',
            triangle: 'shapes',
            star: 'shapes',
            frame: 'shapes',
            line: 'lines',
            arrow: 'lines',
            freedraw: 'draw',
            eraser: 'draw',
            text: 'content',
            sticky: 'content',
            'ai-image': 'ai',
            'ai-assistant': 'ai',
        };

        document.querySelectorAll('.tool-dock-btn').forEach((btn) => {
            const matchesTool = btn.dataset.dockTool === toolName;
            const matchesOpenGroup = btn.dataset.dockGroup && btn.dataset.dockGroup === this.activeDockGroup;
            const matchesToolGroup = !this.activeDockGroup
                && Boolean(btn.dataset.dockGroup)
                && btn.dataset.dockGroup === toolToGroup[toolName];
            const isActive = Boolean(matchesTool || matchesOpenGroup || matchesToolGroup);
            if (btn.dataset.dockTool) {
                btn.setAttribute('aria-pressed', matchesTool ? 'true' : 'false');
            }
            btn.classList.toggle('active', isActive);
        });
    }

    setupCanvasSideRail() {
        document.querySelectorAll('[data-canvas-panel-tab]').forEach((tab) => {
            tab.addEventListener('click', () => {
                this.selectCanvasPanel(tab.dataset.canvasPanelTab);
            });
            tab.addEventListener('keydown', (event) => this.handleCanvasPanelTabKeydown(event));
        });

        document.querySelectorAll('[data-object-action]').forEach((button) => {
            button.addEventListener('click', () => this.handleObjectLibraryAction(button.dataset.objectAction));
        });

        document.querySelectorAll('[data-creative-action]').forEach((button) => {
            button.addEventListener('click', () => this.handleCreativeAction(button.dataset.creativeAction));
        });

        document.querySelectorAll('[data-draw-preset]').forEach((button) => {
            button.addEventListener('click', () => {
                window.toolManager?.applyDrawPreset?.(button.dataset.drawPreset || 'pencil');
            });
        });

        document.getElementById('savedBlockShelf')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-saved-block-action]');
            if (!button) return;
            this.handleSavedBlockAction(button.dataset.savedBlockAction || '', button.dataset.blockId || '');
        });

        document.getElementById('boardShelf')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-board-shelf-action]');
            if (!button) return;
            this.handleBoardShelfAction(button.dataset.boardShelfAction || '', button.dataset.boardId || '');
        });

        document.getElementById('canvasAudioInput')?.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (file) {
                this.handleCanvasAudioFile(file);
            }
            event.target.value = '';
        });

        document.getElementById('objectLibraryList')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-object-row-action]');
            if (!actionButton) return;
            this.handleObjectRowAction(actionButton.dataset.objectRowAction, actionButton.dataset.objectId);
        });

        document.getElementById('objectLibrarySearch')?.addEventListener('input', (event) => {
            this.objectLibraryQuery = event.target.value || '';
            this.renderObjectLibrary();
        });

        document.getElementById('objectFilterChips')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-object-filter]');
            if (!button) return;
            this.objectLibraryFilter = button.dataset.objectFilter || 'all';
            document.querySelectorAll('[data-object-filter]').forEach((chip) => {
                const isActive = chip === button;
                chip.classList.toggle('active', isActive);
                chip.setAttribute('aria-pressed', String(isActive));
            });
            this.renderObjectLibrary();
        });

        document.getElementById('productionTimeline')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-timeline-action]');
            if (!actionButton) return;
            this.handleTimelineAction(actionButton.dataset.timelineAction, actionButton.dataset.objectId);
        });

        document.getElementById('timelineCueEditor')?.addEventListener('input', (event) => {
            const field = event.target?.dataset?.timelineField;
            if (!field) return;
            this.updateSelectedTimelineCue(field, event.target.value);
        });

        document.getElementById('timelineCueEditor')?.addEventListener('change', (event) => {
            const field = event.target?.dataset?.timelineField;
            if (!field) return;
            this.updateSelectedTimelineCue(field, event.target.value);
        });

        document.getElementById('timelineCueEditor')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-timeline-extra-action]');
            if (!button) return;
            this.handleTimelineExtraAction(button.dataset.timelineExtraAction);
        });

        document.getElementById('selectedAudioInput')?.addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            if (file) {
                await this.replaceSelectedAudioCueFile(file);
            }
            event.target.value = '';
        });

        document.getElementById('mermaidObjectEditor')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-mermaid-object-action]');
            if (!button) return;
            this.handleSelectedMermaidAction(button.dataset.mermaidObjectAction);
        });

        this.selectCanvasPanel('objects');
        this.renderObjectLibrary();
        this.renderProductionTimeline();
        this.renderSelectedMermaidEditor();
        this.renderConnectionBuilder();
        this.renderSavedBlockShelf();
    }

    setupSimplifiedInspector() {
        const inspector = document.querySelector('[data-canvas-panel="inspector"]');
        if (!inspector || inspector.querySelector('.inspector-more-controls')) {
            return;
        }

        const colorStudio = document.getElementById('colorStudio');
        const layerActions = inspector.querySelector('.layer-actions');
        if (!colorStudio || !layerActions) {
            return;
        }

        const details = document.createElement('details');
        details.className = 'inspector-more-controls';
        details.innerHTML = `
            <summary>
                <span>More style controls</span>
                <small>Stroke, text, shape, connector</small>
            </summary>
            <div class="inspector-more-controls-body"></div>
        `;
        const body = details.querySelector('.inspector-more-controls-body');

        let node = colorStudio.nextElementSibling;
        while (node && node !== layerActions) {
            const next = node.nextElementSibling;
            if (node.classList?.contains('property-group')) {
                body.appendChild(node);
            }
            node = next;
        }

        inspector.insertBefore(details, layerActions);
    }

    selectCanvasPanel(panelName = 'inspector') {
        document.querySelectorAll('[data-canvas-panel-tab]').forEach((tab) => {
            const active = tab.dataset.canvasPanelTab === panelName;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.setAttribute('tabindex', active ? '0' : '-1');
        });

        document.querySelectorAll('[data-canvas-panel]').forEach((panel) => {
            const active = panel.dataset.canvasPanel === panelName;
            panel.hidden = !active;
            panel.classList.toggle('active', active);
        });

        if (panelName === 'objects') {
            this.renderObjectLibrary();
        } else if (panelName === 'creative') {
            this.renderProductionTimeline();
            this.renderSelectedMermaidEditor();
            this.renderConnectionBuilder();
        } else if (panelName === 'library') {
            this.renderSavedBlockShelf();
        }
    }

    handleCanvasPanelTabKeydown(event) {
        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key)) return;

        const tabs = Array.from(document.querySelectorAll('[data-canvas-panel-tab]'));
        const currentIndex = tabs.indexOf(event.currentTarget);
        if (currentIndex === -1) return;

        event.preventDefault();

        let nextIndex = currentIndex;
        if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = tabs.length - 1;
        } else {
            const offset = event.key === 'ArrowRight' ? 1 : -1;
            nextIndex = (currentIndex + offset + tabs.length) % tabs.length;
        }

        const nextTab = tabs[nextIndex];
        if (!nextTab) return;
        this.selectCanvasPanel(nextTab.dataset.canvasPanelTab);
        nextTab.focus();
    }

    setupCanvasCommandPalette() {
        this.commandPaletteCommands = this.buildCanvasCommandEntries();

        document.getElementById('canvasCommandBtn')?.addEventListener('click', () => {
            this.toggleCanvasCommandPalette();
        });
        document.getElementById('canvasCommandClose')?.addEventListener('click', () => {
            this.closeCanvasCommandPalette();
        });
        document.getElementById('canvasCommandRail')?.addEventListener('pointerdown', (event) => {
            this.rememberCanvasCommandSelection();
            event.stopPropagation();
        });
        document.getElementById('canvasCommandRail')?.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        document.getElementById('canvasCommandPalette')?.addEventListener('pointerdown', (event) => {
            this.rememberCanvasCommandSelection();
            event.stopPropagation();
            if (event.target === event.currentTarget) {
                this.closeCanvasCommandPalette();
            }
        });
        document.getElementById('canvasCommandPalette')?.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        document.getElementById('canvasCommandSearch')?.addEventListener('input', (event) => {
            this.commandSearchValue = event.target.value || '';
            this.renderCanvasCommandPalette();
        });
        document.getElementById('canvasCommandSearch')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const firstEnabled = document.querySelector('#canvasCommandList .canvas-command-item:not(:disabled)');
                firstEnabled?.click();
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                document.querySelector('#canvasCommandList .canvas-command-item:not(:disabled)')?.focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.closeCanvasCommandPalette();
            }
        });
        document.getElementById('canvasCommandList')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-command-id]');
            if (!button || button.disabled) return;
            this.runCanvasCommand(button.dataset.commandId);
        });
        document.getElementById('canvasCommandList')?.addEventListener('keydown', (event) => {
            const items = Array.from(document.querySelectorAll('#canvasCommandList .canvas-command-item:not(:disabled)'));
            const currentIndex = items.indexOf(document.activeElement);
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                document.activeElement?.click?.();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                const next = items[(currentIndex + direction + items.length) % items.length];
                next?.focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.closeCanvasCommandPalette();
            }
        });
        document.querySelectorAll('[data-command-shortcut]').forEach((button) => {
            button.addEventListener('click', () => {
                this.runCanvasRailShortcut(button.dataset.commandShortcut);
            });
        });

        this.renderCanvasCommandPalette();
    }

    buildCanvasCommandEntries() {
        return [
            {
                id: 'ai-board',
                label: 'Ask Canvas AI',
                meta: 'Open the lean agent with board context',
                group: 'AI',
                keywords: 'agent ai critique prompt board',
                run: () => this.openCanvasAIWithPrompt('What should I improve next on this canvas?'),
            },
            {
                id: 'ai-build',
                label: 'AI Build Pass',
                meta: 'Create editable objects from the creative prompt',
                group: 'AI',
                keywords: 'agent ai build storyboard diagram audio animation',
                run: () => this.handleCreativeAction('ai-brief'),
            },
            {
                id: 'scene-pack',
                label: 'Scene Pack',
                meta: 'Three storyboard frames, audio cues, and motion beats',
                group: 'Create',
                keywords: 'storyboard scene animation audio production',
                run: () => this.handleCreativeAction('scene-pack'),
            },
            {
                id: 'storyboard',
                label: 'Storyboard Frame',
                meta: 'Add an editable production frame',
                group: 'Create',
                keywords: 'shot scene storyboard frame',
                run: () => this.handleCreativeAction('storyboard'),
            },
            {
                id: 'animation',
                label: 'Animation Beat',
                meta: 'Add motion timing and notes',
                group: 'Create',
                keywords: 'animation motion easing timeline',
                run: () => this.handleCreativeAction('animation'),
            },
            {
                id: 'audio',
                label: 'Audio Cue',
                meta: 'Add voice, music, or SFX timing',
                group: 'Create',
                keywords: 'audio voice music sfx sound',
                run: () => this.handleCreativeAction('audio'),
            },
            {
                id: 'mermaid',
                label: 'Mermaid Source Card',
                meta: 'Add editable Mermaid source to the canvas',
                group: 'Diagram',
                keywords: 'mermaid flowchart diagram source',
                run: () => this.handleCreativeAction('mermaid'),
            },
            {
                id: 'mermaid-render',
                label: 'Render Mermaid To Objects',
                meta: 'Turn Mermaid source into editable boxes and arrows',
                group: 'Diagram',
                keywords: 'mermaid render flowchart editable objects',
                run: () => {
                    this.selectCanvasPanel('creative');
                    this.handleCreativeAction('mermaid-render');
                },
            },
            {
                id: 'connect',
                label: 'Connect Selected',
                meta: 'Draw editable arrows between selected objects',
                group: 'Arrange',
                keywords: 'connect arrow selected relationship',
                isEnabled: () => this.getCanvasCommandSelection().length >= 2,
                run: () => {
                    this.restoreCanvasCommandSelection();
                    this.connectSelectedObjects();
                },
            },
            {
                id: 'save-block',
                label: 'Save Selection As Block',
                meta: 'Reuse selected objects from the Blocks shelf',
                group: 'Objects',
                keywords: 'save block library reuse selected',
                isEnabled: () => this.getCanvasCommandSelection().length > 0,
                run: () => {
                    this.restoreCanvasCommandSelection();
                    this.saveSelectionAsBlock();
                },
            },
            {
                id: 'save-board',
                label: 'Save Named Board',
                meta: 'Store this whole canvas in the Saved Boards shelf',
                group: 'Objects',
                keywords: 'save board workspace project canvas restore duplicate export',
                isEnabled: () => (window.infiniteCanvas?.elements || []).length > 0,
                run: () => {
                    this.saveCurrentBoard();
                    this.selectCanvasPanel('objects');
                },
            },
            {
                id: 'duplicate',
                label: 'Duplicate Selection',
                meta: 'Copy selected objects with spacing',
                group: 'Objects',
                keywords: 'duplicate copy selected object',
                isEnabled: () => this.getCanvasCommandSelection().length > 0,
                run: () => {
                    this.restoreCanvasCommandSelection();
                    window.selectionManager?.duplicateSelection?.();
                },
            },
            {
                id: 'objects-panel',
                label: 'Show Object Library',
                meta: 'Select, duplicate, and delete canvas objects',
                group: 'View',
                keywords: 'objects library duplicate save choose',
                run: () => this.selectCanvasPanel('objects'),
            },
            {
                id: 'creative-panel',
                label: 'Show Creative Panel',
                meta: 'Timeline, Mermaid, audio, animation, and blocks',
                group: 'View',
                keywords: 'creative timeline mermaid audio animation storyboard',
                run: () => this.selectCanvasPanel('creative'),
            },
            {
                id: 'blocks-panel',
                label: 'Show Blocks Shelf',
                meta: 'Insert saved reusable object groups',
                group: 'View',
                keywords: 'blocks shelf saved reusable insert',
                run: () => this.selectCanvasPanel('library'),
            },
        ];
    }

    getFilteredCanvasCommands() {
        const query = this.commandSearchValue.trim().toLowerCase();
        const commands = this.commandPaletteCommands.length > 0
            ? this.commandPaletteCommands
            : this.buildCanvasCommandEntries();
        if (!query) return commands;
        return commands.filter((command) => {
            const haystack = [
                command.label,
                command.meta,
                command.group,
                command.keywords,
            ].join(' ').toLowerCase();
            return haystack.includes(query);
        });
    }

    renderCanvasCommandPalette() {
        const list = document.getElementById('canvasCommandList');
        if (!list) return;

        const selectedCount = this.getCanvasCommandSelection().length;
        const commands = this.getFilteredCanvasCommands();
        if (commands.length === 0) {
            const query = this.commandSearchValue.trim();
            const message = query
                ? `No commands match "${query}". Try AI, scene, Mermaid, or objects.`
                : 'No commands are available right now.';
            list.innerHTML = `
                <div class="canvas-command-empty" role="status" aria-live="polite">
                    <strong>${this.escapeHtml(message)}</strong>
                    <span>Search by action, content type, or panel name.</span>
                </div>
            `;
            return;
        }

        list.innerHTML = commands.map((command) => {
            const enabled = typeof command.isEnabled === 'function' ? command.isEnabled() : true;
            const reason = enabled
                ? command.meta
                : (selectedCount === 0 ? 'Select canvas objects first' : 'Select at least two objects');
            const optionId = `canvas-command-option-${String(command.id).replace(/[^a-z0-9_-]/gi, '-')}`;
            return `
                <button type="button" role="option" id="${this.escapeHtml(optionId)}" aria-selected="false" class="canvas-command-item" data-command-id="${this.escapeHtml(command.id)}" ${enabled ? '' : 'disabled'}>
                    <span class="canvas-command-item-main">
                        <strong>${this.escapeHtml(command.label)}</strong>
                        <small>${this.escapeHtml(reason)}</small>
                    </span>
                    <span class="canvas-command-item-group">${this.escapeHtml(command.group)}</span>
                </button>
            `;
        }).join('');
    }

    openCanvasCommandPalette() {
        const palette = document.getElementById('canvasCommandPalette');
        const button = document.getElementById('canvasCommandBtn');
        const input = document.getElementById('canvasCommandSearch');
        if (!palette) return;

        this.rememberCanvasCommandSelection();
        this.commandPaletteOpen = true;
        palette.hidden = false;
        button?.setAttribute('aria-expanded', 'true');
        this.renderCanvasCommandPalette();
        requestAnimationFrame(() => {
            input?.focus();
            input?.select();
        });
    }

    closeCanvasCommandPalette() {
        const palette = document.getElementById('canvasCommandPalette');
        const button = document.getElementById('canvasCommandBtn');
        if (!palette) return;

        this.commandPaletteOpen = false;
        this.commandSearchValue = '';
        const input = document.getElementById('canvasCommandSearch');
        if (input) input.value = '';
        palette.hidden = true;
        button?.setAttribute('aria-expanded', 'false');
    }

    toggleCanvasCommandPalette() {
        if (this.commandPaletteOpen) {
            this.closeCanvasCommandPalette();
        } else {
            this.openCanvasCommandPalette();
        }
    }

    runCanvasRailShortcut(shortcut = '') {
        if (shortcut === 'ai') {
            this.runCanvasCommand('ai-board');
        } else if (shortcut === 'scene') {
            this.runCanvasCommand('scene-pack');
        } else if (shortcut === 'connect') {
            this.runCanvasCommand('connect');
        }
    }

    runCanvasCommand(commandId = '') {
        const command = (this.commandPaletteCommands.length > 0
            ? this.commandPaletteCommands
            : this.buildCanvasCommandEntries())
            .find((entry) => entry.id === commandId);
        if (!command) return false;
        if (typeof command.isEnabled === 'function' && !command.isEnabled()) {
            this.showToast(commandId === 'connect'
                ? 'Select two or more objects to connect'
                : 'Select one or more objects first', 'warning');
            this.renderCanvasCommandPalette();
            return false;
        }

        command.run();
        this.closeCanvasCommandPalette();
        this.renderCanvasCommandPalette();
        return true;
    }

    rememberCanvasCommandSelection() {
        const selected = window.infiniteCanvas?.selectedElements || [];
        if (selected.length > 0) {
            this.lastCommandSelectionIds = selected.map((element) => element.id).filter(Boolean);
        }
    }

    getCanvasCommandSelection() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (selected.length > 0) {
            this.lastCommandSelectionIds = selected.map((element) => element.id).filter(Boolean);
            return selected;
        }
        if (!canvas || this.lastCommandSelectionIds.length === 0) {
            return [];
        }
        const ids = new Set(this.lastCommandSelectionIds);
        return (canvas.elements || []).filter((element) => ids.has(element.id));
    }

    restoreCanvasCommandSelection() {
        const canvas = window.infiniteCanvas;
        if (!canvas) return [];
        const selected = canvas.selectedElements || [];
        if (selected.length > 0) {
            this.rememberCanvasCommandSelection();
            return selected;
        }
        const restored = this.getCanvasCommandSelection();
        if (restored.length > 0) {
            canvas.selectElements(restored);
            canvas.render();
        }
        return restored;
    }

    onCanvasElementsChanged() {
        this.saveCanvasToStorage();
        this.updateCanvasStatusStrip();
        this.renderObjectLibrary();
        this.renderBoardShelf();
        this.renderProductionTimeline();
        this.renderSelectedMermaidEditor();
        this.renderSavedBlockShelf();
        this.renderCanvasCommandPalette();
        this.renderConnectionBuilder();
        window.aiAssistant?.updateGroundingPanel?.();
    }

    loadSavedBlocks() {
        try {
            const saved = JSON.parse(localStorage.getItem(CANVAS_SAVED_BLOCK_STORAGE_KEY) || '[]');
            if (!Array.isArray(saved)) return [];
            return saved
                .map((block) => ({
                    id: String(block?.id || '').trim(),
                    name: String(block?.name || '').trim(),
                    createdAt: String(block?.createdAt || ''),
                    elementCount: Number(block?.elementCount || 0),
                    elements: Array.isArray(block?.elements) ? block.elements.map((element) => this.normalizeCanvasElement(element)) : [],
                }))
                .filter((block) => block.id && block.name && block.elements.length > 0)
                .slice(0, CANVAS_SAVED_BLOCK_LIMIT);
        } catch (error) {
            console.warn('Failed to load saved canvas blocks:', error);
            return [];
        }
    }

    saveSavedBlocks(blocks = []) {
        const next = (Array.isArray(blocks) ? blocks : []).slice(0, CANVAS_SAVED_BLOCK_LIMIT);
        try {
            localStorage.setItem(CANVAS_SAVED_BLOCK_STORAGE_KEY, JSON.stringify(next));
        } catch (error) {
            console.warn('Failed to save canvas blocks:', error);
            this.showToast('Could not save reusable block', 'error');
        }
        return next;
    }

    renderSavedBlockShelf() {
        const list = document.getElementById('savedBlockList');
        const summary = document.getElementById('savedBlockSummary');
        if (!list) return;
        const blocks = this.loadSavedBlocks();
        if (summary) {
            summary.textContent = blocks.length > 0
                ? `${blocks.length} reusable block${blocks.length === 1 ? '' : 's'}`
                : 'No saved blocks yet';
        }
        if (blocks.length === 0) {
            list.innerHTML = '<div class="saved-block-empty">Select drawings, frames, or diagram pieces and save them as reusable blocks.</div>';
            return;
        }
        list.innerHTML = blocks.map((block) => `
            <div class="saved-block-item" data-block-id="${this.escapeHtmlAttr(block.id)}">
                <div class="saved-block-main">
                    <strong>${this.escapeHtml(block.name)}</strong>
                    <span>${this.escapeHtml(`${block.elementCount || block.elements.length} objects - ${this.formatRelativeTime(Date.parse(block.createdAt) || Date.now())}`)}</span>
                </div>
                <div class="saved-block-actions">
                    <button type="button" data-saved-block-action="insert" data-block-id="${this.escapeHtmlAttr(block.id)}">Insert</button>
                    <button type="button" data-saved-block-action="delete" data-block-id="${this.escapeHtmlAttr(block.id)}">Del</button>
                </div>
            </div>
        `).join('');
    }

    handleSavedBlockAction(action = '', blockId = '') {
        if (action === 'save-selection') {
            this.saveSelectionAsBlock();
        } else if (action === 'insert') {
            this.insertSavedBlock(blockId);
        } else if (action === 'delete') {
            this.deleteSavedBlock(blockId);
        }
    }

    saveSelectionAsBlock() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (selected.length === 0) {
            this.showToast('Select drawings or objects before saving a block', 'warning');
            return null;
        }
        const bounds = this.getElementsBounds(selected);
        const center = {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
        const elements = this.getSerializableCanvasElements(selected).map((element) => this.makeElementRelativeToPoint(element, center));
        const firstName = this.getElementDisplayName(selected[0], 0).replace(/:.+$/, '').trim();
        const block = {
            id: `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: `${firstName || 'Canvas'} block ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
            createdAt: new Date().toISOString(),
            elementCount: selected.length,
            elements,
        };
        this.saveSavedBlocks([block, ...this.loadSavedBlocks()]).slice(0, CANVAS_SAVED_BLOCK_LIMIT);
        this.renderSavedBlockShelf();
        this.selectCanvasPanel('library');
        this.showToast(`Saved "${block.name}"`);
        return block;
    }

    insertSavedBlock(blockId = '', pointOverride = null) {
        const block = this.loadSavedBlocks().find((item) => item.id === blockId);
        const canvas = window.infiniteCanvas;
        if (!block || !canvas) {
            this.showToast('Saved block was not found', 'warning');
            return false;
        }
        const point = pointOverride && Number.isFinite(pointOverride.x) && Number.isFinite(pointOverride.y)
            ? pointOverride
            : this.getCanvasInsertionPoint();
        const inserted = block.elements.map((element) => this.makeElementAbsoluteFromPoint(element, point));
        inserted.forEach((element) => {
            element.id = window.toolManager?.generateId?.() || `el-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            canvas.addElement(element);
        });
        canvas.selectElements(inserted);
        window.historyManager?.pushState(canvas.elements);
        this.onCanvasElementsChanged();
        this.showToast(`Inserted "${block.name}"`);
        return true;
    }

    insertMostRecentSavedBlock(pointOverride = null) {
        const block = this.loadSavedBlocks()[0];
        if (!block) {
            this.showToast('Save a block first, then insert it from the canvas', 'warning');
            this.selectCanvasPanel('library');
            return false;
        }
        return this.insertSavedBlock(block.id, pointOverride);
    }

    deleteSavedBlock(blockId = '') {
        const blocks = this.loadSavedBlocks();
        const block = blocks.find((item) => item.id === blockId);
        this.saveSavedBlocks(blocks.filter((item) => item.id !== blockId));
        this.renderSavedBlockShelf();
        this.showToast(block ? `Deleted "${block.name}"` : 'Deleted saved block');
    }

    getElementsBounds(elements = []) {
        const boxes = elements.map((element) => this.getElementBounds(element));
        const left = Math.min(...boxes.map((box) => box.left));
        const top = Math.min(...boxes.map((box) => box.top));
        const right = Math.max(...boxes.map((box) => box.right));
        const bottom = Math.max(...boxes.map((box) => box.bottom));
        return {
            left,
            top,
            right,
            bottom,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top),
        };
    }

    getElementBounds(element = {}) {
        if (Array.isArray(element.points) && element.points.length > 0) {
            const xs = element.points.map((point) => Number(point.x) || 0);
            const ys = element.points.map((point) => Number(point.y) || 0);
            const left = Math.min(...xs);
            const right = Math.max(...xs);
            const top = Math.min(...ys);
            const bottom = Math.max(...ys);
            return { left, top, right, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
        }
        const width = Math.max(1, Number(element.width) || 1);
        const height = Math.max(1, Number(element.height) || 1);
        const x = Number(element.x) || 0;
        const y = Number(element.y) || 0;
        return {
            left: x - width / 2,
            top: y - height / 2,
            right: x + width / 2,
            bottom: y + height / 2,
            width,
            height,
        };
    }

    makeElementRelativeToPoint(element = {}, point = { x: 0, y: 0 }) {
        const copy = this.normalizeCanvasElement(element);
        copy.x = (Number(copy.x) || 0) - point.x;
        copy.y = (Number(copy.y) || 0) - point.y;
        if (Array.isArray(copy.points)) {
            copy.points = copy.points.map((entry) => ({
                x: (Number(entry.x) || 0) - point.x,
                y: (Number(entry.y) || 0) - point.y,
            }));
        }
        return copy;
    }

    makeElementAbsoluteFromPoint(element = {}, point = { x: 0, y: 0 }) {
        const copy = this.normalizeCanvasElement(element);
        copy.x = (Number(copy.x) || 0) + point.x;
        copy.y = (Number(copy.y) || 0) + point.y;
        if (Array.isArray(copy.points)) {
            copy.points = copy.points.map((entry) => ({
                x: (Number(entry.x) || 0) + point.x,
                y: (Number(entry.y) || 0) + point.y,
            }));
        }
        return copy;
    }

    getElementDisplayName(element = {}, index = 0) {
        const typeLabel = {
            rectangle: 'Rectangle',
            ellipse: 'Ellipse',
            diamond: 'Diamond',
            line: 'Line',
            arrow: 'Arrow',
            text: 'Text',
            sticky: 'Sticky note',
            frame: 'Frame',
            image: 'Image',
            freedraw: 'Drawing',
            storyboardFrame: 'Storyboard frame',
            animationBeat: 'Animation beat',
            audioCue: 'Audio cue',
            mermaidDiagram: 'Mermaid diagram',
        }[element.type] || `${String(element.type || 'Object').charAt(0).toUpperCase()}${String(element.type || 'Object').slice(1)}`;

        const label = String(element.name || element.title || element.text || '').replace(/\s+/g, ' ').trim();
        return label ? `${typeLabel}: ${label.slice(0, 36)}` : `${typeLabel} ${index + 1}`;
    }

    getElementDetail(element = {}) {
        const size = element.width && element.height ? `${Math.round(element.width)}x${Math.round(element.height)}` : 'line';
        const role = element.canvasRole || element.healthRole || element.type || 'object';
        if (element.type === 'audioCue') {
            const duration = Number.isFinite(element.duration) ? ` - ${this.formatDuration(element.duration)}` : '';
            const storage = element.audioPersistent === false ? ' - session audio' : '';
            return `${element.audioName || role}${duration}${storage}`;
        }
        if (element.type === 'mermaidDiagram') {
            const nodeCount = Array.isArray(element.mermaidNodes) ? element.mermaidNodes.length : 0;
            const flow = nodeCount > 0 ? `${nodeCount} parsed node${nodeCount === 1 ? '' : 's'}` : 'source card';
            return `${flow} - ${size}`;
        }
        return `${role} - ${size}`;
    }

    getObjectLibraryCategory(element = {}) {
        if (['freedraw', 'line', 'arrow', 'rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'frame'].includes(element.type)) {
            return 'drawing';
        }
        if (['storyboardFrame', 'animationBeat', 'audioCue'].includes(element.type)) {
            return 'production';
        }
        if (['mermaidDiagram'].includes(element.type) || String(element.canvasRole || '').includes('mermaid')) {
            return 'diagram';
        }
        return 'drawing';
    }

    getObjectLibraryPreview(element = {}) {
        const stroke = this.escapeHtmlAttr(element.strokeColor || '#64748b');
        const fill = this.escapeHtmlAttr(element.backgroundColor || 'transparent');
        const fillStyle = fill === 'transparent'
            ? 'background: repeating-conic-gradient(#edf2f7 0% 25%, #475569 0% 50%) 50% / 8px 8px;'
            : `background: ${fill};`;
        const typeClass = this.escapeHtmlAttr(this.getObjectLibraryCategory(element));
        return `<span class="object-preview ${typeClass}" style="border-color:${stroke}; ${fillStyle}"></span>`;
    }

    getFilteredObjectLibraryElements(elements = []) {
        const query = String(this.objectLibraryQuery || '').trim().toLowerCase();
        const filter = this.objectLibraryFilter || 'all';
        return elements.filter((element, index) => {
            const category = this.getObjectLibraryCategory(element);
            if (filter !== 'all' && category !== filter) {
                return false;
            }
            if (!query) {
                return true;
            }
            const haystack = [
                this.getElementDisplayName(element, index),
                this.getElementDetail(element),
                element.id,
                element.type,
                element.canvasRole,
                element.title,
                element.text,
                element.audioName,
                element.mermaidSource,
            ].join(' ').toLowerCase();
            return haystack.includes(query);
        });
    }

    renderObjectLibrary() {
        const list = document.getElementById('objectLibraryList');
        const summary = document.getElementById('objectLibrarySummary');
        const canvas = window.infiniteCanvas;
        if (!list || !canvas) return;

        const elements = Array.isArray(canvas.elements) ? canvas.elements : [];
        const selectedIds = new Set((canvas.selectedElements || []).map((element) => element.id));
        const filteredElements = this.getFilteredObjectLibraryElements(elements);
        if (summary) {
            const selectedText = selectedIds.size > 0 ? `, ${selectedIds.size} selected` : '';
            const filteredText = filteredElements.length !== elements.length ? `${filteredElements.length} shown / ` : '';
            summary.textContent = `${filteredText}${elements.length} saved object${elements.length === 1 ? '' : 's'}${selectedText}`;
        }

        if (elements.length === 0) {
            list.innerHTML = '<div class="object-library-empty">Create shapes, frames, audio cues, storyboard panels, or AI diagrams and they will appear here.</div>';
            return;
        }

        if (filteredElements.length === 0) {
            list.innerHTML = '<div class="object-library-empty">No objects match this filter.</div>';
            return;
        }

        list.innerHTML = filteredElements.map((element, index) => `
            <div class="object-library-item${selectedIds.has(element.id) ? ' selected' : ''}" data-object-id="${this.escapeHtmlAttr(element.id)}">
                ${this.getObjectLibraryPreview(element)}
                <button type="button" class="object-library-main" data-object-row-action="select" data-object-id="${this.escapeHtmlAttr(element.id)}">
                    <strong>${this.escapeHtml(this.getElementDisplayName(element, index))}</strong>
                    <span>${this.escapeHtml(this.getElementDetail(element))}</span>
                </button>
                <div class="object-library-row-actions">
                    <button type="button" data-object-row-action="duplicate" data-object-id="${this.escapeHtmlAttr(element.id)}">Copy</button>
                    <button type="button" data-object-row-action="save-block" data-object-id="${this.escapeHtmlAttr(element.id)}">Save</button>
                    <button type="button" data-object-row-action="delete" data-object-id="${this.escapeHtmlAttr(element.id)}">Del</button>
                </div>
            </div>
        `).join('');
    }

    getProductionTimelineItems() {
        const canvas = window.infiniteCanvas;
        const sequenceTypes = new Set(['storyboardFrame', 'animationBeat', 'audioCue']);
        const elements = Array.isArray(canvas?.elements) ? canvas.elements : [];
        return elements
            .filter((element) => sequenceTypes.has(element.type))
            .map((element, index) => ({
                element,
                index,
                time: Number.isFinite(element.startTime) ? element.startTime : index * 4,
                duration: Number.isFinite(element.durationSeconds)
                    ? element.durationSeconds
                    : (Number.isFinite(element.duration) ? Math.max(1, Math.round(element.duration)) : 4),
            }))
            .sort((a, b) => (a.time - b.time) || ((a.element.x || 0) - (b.element.x || 0)));
    }

    getTimelineTypeLabel(type = '') {
        return {
            storyboardFrame: 'Scene',
            animationBeat: 'Motion',
            audioCue: 'Audio',
        }[type] || 'Cue';
    }

    getProductionDuration(items = this.getProductionTimelineItems()) {
        if (!Array.isArray(items) || items.length === 0) return 0;
        return Math.max(...items.map((item) => item.time + item.duration));
    }

    renderProductionTimeline() {
        const list = document.getElementById('productionTimelineList');
        const summary = document.getElementById('productionTimelineSummary');
        if (!list) return;

        const items = this.getProductionTimelineItems();
        const selectedIds = new Set((window.infiniteCanvas?.selectedElements || []).map((element) => element.id));
        const activeCueId = this.timelineActiveCueId;
        if (summary) {
            const scenes = items.filter((item) => item.element.type === 'storyboardFrame').length;
            const beats = items.filter((item) => item.element.type === 'animationBeat').length;
            const audio = items.filter((item) => item.element.type === 'audioCue').length;
            summary.textContent = items.length > 0
                ? `${scenes} scenes / ${beats} motion / ${audio} audio`
                : 'No scenes yet';
        }

        if (items.length === 0) {
            list.innerHTML = '<div class="production-timeline-empty">Add storyboard, animation, or audio cues to build a sequence.</div>';
            this.timelineCurrentTime = 0;
            this.timelineActiveCueId = '';
            this.timelinePlaybackActiveProgress = 0;
            this.renderTimelineTransport(items);
            this.renderTimelinePreviewStage(items);
            this.renderTimelineCueEditor();
            return;
        }

        list.innerHTML = items.map((item, index) => {
            const element = item.element;
            const title = String(element.title || element.audioName || element.text || this.getElementDisplayName(element, index)).replace(/\s+/g, ' ').trim();
            const note = String(element.text || element.audioName || '').replace(/\s+/g, ' ').trim();
            return `
                <div class="production-timeline-item${selectedIds.has(element.id) ? ' selected' : ''}${activeCueId === element.id ? ' active' : ''}" data-object-id="${this.escapeHtmlAttr(element.id)}">
                    <button type="button" class="production-timeline-main" data-timeline-action="select" data-object-id="${this.escapeHtmlAttr(element.id)}">
                        <span class="timeline-badge ${this.escapeHtmlAttr(element.type)}">${this.escapeHtml(this.getTimelineTypeLabel(element.type))}</span>
                        <strong>${this.escapeHtml(title.slice(0, 48) || `Cue ${index + 1}`)}</strong>
                        <small>${this.escapeHtml(`${this.formatDuration(item.time)}-${this.formatDuration(item.time + item.duration)}${note ? ` - ${note.slice(0, 42)}` : ''}`)}</small>
                    </button>
                    <div class="production-timeline-actions">
                        <button type="button" data-timeline-action="duplicate" data-object-id="${this.escapeHtmlAttr(element.id)}">Copy</button>
                    </div>
                </div>
            `;
        }).join('');
        this.renderTimelineTransport(items);
        this.renderTimelinePreviewStage(items);
        this.renderTimelineCueEditor();
    }

    handleTimelineAction(action = '', objectId = '') {
        if (action === 'preview' || action === 'play') {
            this.startTimelinePlayback();
            return;
        }
        if (action === 'stop') {
            this.stopTimelinePlayback({ reset: true });
            return;
        }
        if (action === 'prev' || action === 'next') {
            this.selectTimelineCueByOffset(action === 'next' ? 1 : -1);
            return;
        }
        if (!objectId) return;
        if (action === 'select') {
            this.selectObjectById(objectId);
            this.selectCanvasPanel('creative');
        } else if (action === 'duplicate') {
            this.duplicateObjectById(objectId);
            this.selectCanvasPanel('creative');
        }
    }

    previewProductionTimeline() {
        this.startTimelinePlayback();
    }

    renderTimelineTransport(items = this.getProductionTimelineItems()) {
        const duration = this.getProductionDuration(items);
        const current = Math.min(Math.max(0, this.timelineCurrentTime || 0), Math.max(duration, 0));
        const currentEl = document.getElementById('timelineCurrentTime');
        const durationEl = document.getElementById('timelineDuration');
        const fill = document.getElementById('timelineProgressFill');
        const playBtn = document.getElementById('timelinePlayBtn');
        const stopBtn = document.getElementById('timelineStopBtn');
        const prevBtn = document.getElementById('timelinePrevBtn');
        const nextBtn = document.getElementById('timelineNextBtn');
        if (currentEl) currentEl.textContent = this.formatDuration(current);
        if (durationEl) durationEl.textContent = this.formatDuration(duration);
        if (fill) fill.style.width = duration > 0 ? `${Math.min(100, (current / duration) * 100)}%` : '0%';
        if (playBtn) {
            playBtn.textContent = this.timelineIsPlaying ? 'Playing' : 'Play';
            playBtn.disabled = items.length === 0;
            playBtn.setAttribute('aria-pressed', this.timelineIsPlaying ? 'true' : 'false');
        }
        if (stopBtn) {
            stopBtn.disabled = items.length === 0 && current <= 0;
        }
        if (prevBtn) prevBtn.disabled = items.length === 0;
        if (nextBtn) nextBtn.disabled = items.length === 0;
    }

    getTimelineActiveItem(items = this.getProductionTimelineItems(), time = this.timelineCurrentTime) {
        if (!Array.isArray(items) || items.length === 0) return null;
        return items.find((item) => time >= item.time && time < item.time + item.duration)
            || items.find((item) => item.element.id === this.timelineActiveCueId)
            || items[0];
    }

    getTimelineCuePreviewState(element = {}) {
        if (!element?.id || element.id !== this.timelineActiveCueId) {
            return null;
        }
        return {
            active: true,
            progress: Math.max(0, Math.min(1, this.timelinePlaybackActiveProgress || 0)),
            isPlaying: this.timelineIsPlaying,
        };
    }

    renderTimelinePreviewStage(items = this.getProductionTimelineItems()) {
        const stage = document.getElementById('timelinePreviewStage');
        if (!stage) return;
        if (!Array.isArray(items) || items.length === 0) {
            stage.innerHTML = '<div class="timeline-preview-empty">Add cues to preview a scene, motion beat, or audio moment.</div>';
            return;
        }

        const active = this.getTimelineActiveItem(items);
        const element = active?.element || items[0]?.element;
        if (!element) {
            stage.innerHTML = '<div class="timeline-preview-empty">Select a cue to preview it here.</div>';
            return;
        }

        const progress = Math.max(0, Math.min(1, this.timelinePlaybackActiveProgress || 0));
        const title = String(element.title || element.audioName || element.text || 'Untitled cue').replace(/\s+/g, ' ').trim();
        const note = String(element.text || element.audioName || '').replace(/\s+/g, ' ').trim();
        const typeLabel = this.getTimelineTypeLabel(element.type);
        const progressLabel = `${Math.round(progress * 100)}%`;
        const timeRange = `${this.formatDuration(active.time)}-${this.formatDuration(active.time + active.duration)}`;
        stage.innerHTML = `
            <div class="timeline-preview-card ${this.escapeHtmlAttr(element.type)}">
                <div class="timeline-preview-main">
                    <span class="timeline-badge ${this.escapeHtmlAttr(element.type)}">${this.escapeHtml(typeLabel)}</span>
                    <strong>${this.escapeHtml(title.slice(0, 72) || typeLabel)}</strong>
                    <small>${this.escapeHtml(`${timeRange}${note ? ` - ${note.slice(0, 78)}` : ''}`)}</small>
                </div>
                <div class="timeline-preview-meter" aria-label="Cue progress ${this.escapeHtmlAttr(progressLabel)}">
                    <span style="width: ${progress * 100}%"></span>
                </div>
                <div class="timeline-preview-meta">
                    <span>${this.timelineIsPlaying ? 'Playing' : 'Ready'}</span>
                    <span>${this.escapeHtml(progressLabel)}</span>
                </div>
            </div>
        `;
    }

    selectTimelineCueByOffset(offset = 1) {
        const items = this.getProductionTimelineItems();
        if (items.length === 0) {
            this.showToast('Add timeline cues first', 'warning');
            return;
        }
        this.stopTimelinePlayback({ reset: false, silent: true });
        const selectedCue = this.getSelectedTimelineCue();
        const activeId = selectedCue?.id || this.timelineActiveCueId;
        const foundIndex = items.findIndex((item) => item.element.id === activeId);
        const currentIndex = foundIndex >= 0 ? foundIndex : (offset > 0 ? -1 : items.length);
        const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + offset));
        const item = items[nextIndex];
        this.timelineCurrentTime = item.time;
        this.timelineActiveCueId = item.element.id;
        this.timelinePlaybackActiveProgress = 0;
        this.selectObjectById(item.element.id);
        this.renderTimelineTransport(items);
        this.renderTimelinePreviewStage(items);
        this.renderProductionTimeline();
        window.infiniteCanvas?.render();
    }

    startTimelinePlayback() {
        this.timelinePreviewTimers.forEach((timer) => clearTimeout(timer));
        this.timelinePreviewTimers = [];
        const items = this.getProductionTimelineItems();
        if (items.length === 0) {
            this.showToast('Add storyboard, animation, or audio cues first', 'warning');
            return;
        }

        const duration = this.getProductionDuration(items);
        if (duration <= 0) {
            this.showToast('Timeline needs cue durations first', 'warning');
            return;
        }

        if (this.timelineIsPlaying) {
            this.stopTimelinePlayback();
            return;
        }

        this.timelineIsPlaying = true;
        this.timelinePlaybackBaseTime = this.timelineCurrentTime >= duration ? 0 : this.timelineCurrentTime;
        this.timelinePlaybackStartedAt = performance.now();
        this.showToast('Timeline preview started');
        this.tickTimelinePlayback();
    }

    tickTimelinePlayback() {
        if (!this.timelineIsPlaying) return;
        const items = this.getProductionTimelineItems();
        const duration = this.getProductionDuration(items);
        const elapsed = ((performance.now() - this.timelinePlaybackStartedAt) / 1000) + this.timelinePlaybackBaseTime;
        this.timelineCurrentTime = Math.min(elapsed, duration);
        this.updateTimelineActiveCue(items, this.timelineCurrentTime);
        this.renderTimelineTransport(items);
        this.renderTimelinePreviewStage(items);
        window.infiniteCanvas?.render();

        if (elapsed >= duration) {
            this.stopTimelinePlayback({ reset: false, finished: true });
            return;
        }

        this.timelinePlaybackFrame = requestAnimationFrame(() => this.tickTimelinePlayback());
    }

    updateTimelineActiveCue(items = this.getProductionTimelineItems(), time = this.timelineCurrentTime) {
        const active = items.find((item) => time >= item.time && time < item.time + item.duration) || items[items.length - 1] || null;
        if (!active) {
            return;
        }
        this.timelinePlaybackActiveProgress = active.duration > 0
            ? Math.max(0, Math.min(1, (time - active.time) / active.duration))
            : 0;
        if (active.element.id === this.timelineActiveCueId) {
            return;
        }

        this.timelineActiveCueId = active.element.id;
        window.infiniteCanvas?.selectElement(active.element);
        window.infiniteCanvas?.render();
        this.renderProductionTimeline();
        this.renderObjectLibrary();
        this.playTimelineAudioCue(active.element);
    }

    playTimelineAudioCue(element = {}) {
        if (this.timelineAudio) {
            this.timelineAudio.pause();
            this.timelineAudio = null;
        }
        if (element.type !== 'audioCue' || !element.audioUrl) {
            return;
        }
        try {
            this.timelineAudio = new Audio(element.audioUrl);
            this.timelineAudio.volume = 0.82;
            const playResult = this.timelineAudio.play();
            if (playResult?.catch) {
                playResult.catch(() => {});
            }
        } catch {}
    }

    stopTimelinePlayback(options = {}) {
        if (this.timelinePlaybackFrame) {
            cancelAnimationFrame(this.timelinePlaybackFrame);
            this.timelinePlaybackFrame = null;
        }
        this.timelinePreviewTimers.forEach((timer) => clearTimeout(timer));
        this.timelinePreviewTimers = [];
        if (this.timelineAudio) {
            this.timelineAudio.pause();
            this.timelineAudio = null;
        }
        this.timelineIsPlaying = false;
        if (options.reset) {
            this.timelineCurrentTime = 0;
            this.timelineActiveCueId = '';
            this.timelinePlaybackActiveProgress = 0;
        }
        this.renderTimelineTransport();
        this.renderTimelinePreviewStage();
        this.renderProductionTimeline();
        if (options.finished) {
            this.showToast('Timeline preview finished');
        } else if (!options.silent) {
            window.infiniteCanvas?.render();
        }
    }

    getSelectedTimelineCue() {
        const selected = window.infiniteCanvas?.selectedElements || [];
        const sequenceTypes = new Set(['storyboardFrame', 'animationBeat', 'audioCue']);
        return selected.find((element) => sequenceTypes.has(element.type)) || null;
    }

    renderTimelineCueEditor() {
        const editor = document.getElementById('timelineCueEditor');
        if (!editor) return;
        const cue = this.getSelectedTimelineCue();
        editor.hidden = !cue;
        if (!cue) return;
        const activeElement = document.activeElement;
        if (activeElement && editor.contains(activeElement)) {
            return;
        }
        const typeEl = document.getElementById('timelineCueType');
        const titleEl = document.getElementById('timelineCueTitle');
        const startEl = document.getElementById('timelineCueStart');
        const durationEl = document.getElementById('timelineCueDuration');
        const noteEl = document.getElementById('timelineCueNote');
        const animationControls = document.getElementById('timelineAnimationControls');
        const motionPresetEl = document.getElementById('timelineMotionPreset');
        const audioControls = document.getElementById('timelineAudioControls');
        const audioMeta = document.getElementById('timelineAudioMeta');
        if (typeEl) typeEl.textContent = this.getTimelineTypeLabel(cue.type);
        if (titleEl) titleEl.value = cue.title || cue.audioName || '';
        if (startEl) startEl.value = Number.isFinite(cue.startTime) ? String(cue.startTime) : '0';
        if (durationEl) durationEl.value = Number.isFinite(cue.durationSeconds) ? String(cue.durationSeconds) : '4';
        if (noteEl) noteEl.value = cue.text || '';
        if (animationControls) animationControls.hidden = cue.type !== 'animationBeat';
        if (motionPresetEl) motionPresetEl.value = cue.motionPreset || 'ease';
        if (audioControls) audioControls.hidden = cue.type !== 'audioCue';
        if (audioMeta) {
            const parts = [
                cue.audioName || 'No file name',
                Number.isFinite(cue.duration) ? this.formatDuration(cue.duration) : '',
                cue.audioUrl ? (cue.audioPersistent === false ? 'session link' : 'saved with board') : 'no attached file',
            ].filter(Boolean);
            audioMeta.textContent = parts.join(' - ');
        }
    }

    updateSelectedTimelineCue(field = '', value = '') {
        const cue = this.getSelectedTimelineCue();
        if (!cue) return;
        if (field === 'startTime' || field === 'durationSeconds') {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) return;
            cue[field] = field === 'durationSeconds' ? Math.max(0.25, numberValue) : Math.max(0, numberValue);
        } else if (field === 'title') {
            cue.title = String(value || '').slice(0, 96);
            if (cue.type === 'audioCue') {
                cue.audioName = cue.title || cue.audioName || 'Audio cue';
            }
        } else if (field === 'text') {
            cue.text = String(value || '').slice(0, 600);
        } else if (field === 'motionPreset') {
            cue.motionPreset = String(value || 'ease').slice(0, 32);
        }
        window.historyManager?.pushState(window.infiniteCanvas?.elements || []);
        this.onCanvasElementsChanged();
        window.infiniteCanvas?.render();
    }

    handleTimelineExtraAction(action = '') {
        if (action === 'play-audio') {
            this.playSelectedAudioCue();
        } else if (action === 'replace-audio') {
            document.getElementById('selectedAudioInput')?.click();
        }
    }

    playSelectedAudioCue() {
        const cue = this.getSelectedTimelineCue();
        if (!cue || cue.type !== 'audioCue') {
            this.showToast('Select an audio cue first', 'warning');
            return false;
        }
        if (!cue.audioUrl) {
            this.showToast('Attach an audio file to this cue first', 'warning');
            return false;
        }
        this.playTimelineAudioCue(cue);
        this.showToast(`Playing ${cue.audioName || cue.title || 'audio cue'}`);
        return true;
    }

    async replaceSelectedAudioCueFile(file) {
        const cue = this.getSelectedTimelineCue();
        if (!cue || cue.type !== 'audioCue') {
            this.showToast('Select an audio cue before replacing audio', 'warning');
            return false;
        }
        if (!file || !file.type?.startsWith('audio/')) {
            this.showToast('Choose an audio file for this cue', 'warning');
            return false;
        }

        const audioUrl = URL.createObjectURL(file);
        let duration = null;
        try {
            duration = await this.readAudioDuration(audioUrl);
        } catch {
            duration = null;
        }

        cue.audioName = file.name;
        cue.title = cue.title || file.name;
        cue.audioType = file.type;
        cue.audioSize = file.size;
        cue.duration = duration;
        cue.durationSeconds = Number.isFinite(duration) ? Math.max(0.25, Math.round(duration * 4) / 4) : cue.durationSeconds || 4;
        cue.audioUrl = audioUrl;
        cue.audioPersistent = false;
        cue.waveformPeaks = this.createWaveformPeaks(file.name, file.size);

        const maxPersistentBytes = 1500 * 1024;
        if (file.size <= maxPersistentBytes) {
            try {
                cue.audioUrl = await this.readFileAsDataUrl(file);
                cue.audioPersistent = true;
            } catch {
                cue.audioUrl = audioUrl;
                cue.audioPersistent = false;
            }
        }

        window.historyManager?.pushState(window.infiniteCanvas?.elements || []);
        this.onCanvasElementsChanged();
        window.infiniteCanvas?.render();
        this.showToast('Audio cue replaced');
        return true;
    }

    getSelectedMermaidDiagram() {
        const selected = window.infiniteCanvas?.selectedElements || [];
        return selected.find((element) => element.type === 'mermaidDiagram') || null;
    }

    renderSelectedMermaidEditor() {
        const editor = document.getElementById('mermaidObjectEditor');
        if (!editor) return;
        const diagram = this.getSelectedMermaidDiagram();
        editor.hidden = !diagram;
        if (!diagram) return;

        const activeElement = document.activeElement;
        if (activeElement && editor.contains(activeElement)) {
            return;
        }

        const sourceInput = document.getElementById('selectedMermaidSource');
        const summary = document.getElementById('mermaidObjectSummary');
        const source = String(diagram.mermaidSource || diagram.text || '').trim();
        const parsed = this.parseMermaidFlow(source);
        if (sourceInput) sourceInput.value = source;
        if (summary) {
            summary.textContent = `${parsed.nodes.length} nodes / ${parsed.edges.length} connectors`;
        }
    }

    handleSelectedMermaidAction(action = '') {
        if (action === 'save') {
            this.saveSelectedMermaidSource();
        } else if (action === 'render') {
            this.renderSelectedMermaidToObjects();
        }
    }

    saveSelectedMermaidSource() {
        const diagram = this.getSelectedMermaidDiagram();
        const source = document.getElementById('selectedMermaidSource')?.value?.trim() || '';
        if (!diagram) {
            this.showToast('Select a Mermaid source card first', 'warning');
            return false;
        }
        if (!source) {
            this.showToast('Add Mermaid source before saving', 'warning');
            return false;
        }

        const parsed = this.parseMermaidFlow(source);
        diagram.mermaidSource = source;
        diagram.mermaidNodes = parsed.nodes.map((node) => node.label);
        diagram.title = diagram.title || 'Mermaid Diagram';
        diagram.text = diagram.text || '';
        const summary = document.getElementById('mermaidObjectSummary');
        if (summary) {
            summary.textContent = `${parsed.nodes.length} nodes / ${parsed.edges.length} connectors`;
        }
        window.historyManager?.pushState(window.infiniteCanvas?.elements || []);
        this.onCanvasElementsChanged();
        window.infiniteCanvas?.render();
        this.showToast('Mermaid source saved');
        return true;
    }

    renderSelectedMermaidToObjects() {
        const diagram = this.getSelectedMermaidDiagram();
        if (!diagram) {
            this.showToast('Select a Mermaid source card first', 'warning');
            return false;
        }
        if (!this.saveSelectedMermaidSource()) {
            return false;
        }
        const source = String(diagram.mermaidSource || '').trim();
        const base = {
            x: (Number(diagram.x) || 0) - 300,
            y: (Number(diagram.y) || 0) - 90,
        };
        const elements = this.buildMermaidFlowElements(source, base, { includeSourceCard: false });
        if (elements.length === 0) {
            this.showToast('Could not find simple Mermaid arrows to render', 'warning');
            return false;
        }
        this.addCreativeElements(elements, 'Selected Mermaid rendered to objects');
        return true;
    }

    handleObjectLibraryAction(action = '') {
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        switch (action) {
            case 'save-board':
                this.saveCurrentBoard();
                break;
            case 'save-checkpoint':
                this.saveCanvasCheckpoint();
                break;
            case 'select-all':
                canvas.selectElements(canvas.elements || []);
                this.renderObjectLibrary();
                break;
            case 'duplicate-selection':
                window.selectionManager?.duplicateSelection();
                this.onCanvasElementsChanged();
                break;
        }
    }

    handleObjectRowAction(action = '', objectId = '') {
        if (!objectId) return;
        if (action === 'select') {
            this.selectObjectById(objectId);
        } else if (action === 'duplicate') {
            this.duplicateObjectById(objectId);
        } else if (action === 'save-block') {
            this.saveObjectAsBlock(objectId);
        } else if (action === 'delete') {
            this.deleteObjectById(objectId);
        }
    }

    saveObjectAsBlock(objectId = '') {
        const canvas = window.infiniteCanvas;
        const element = canvas?.elements?.find((item) => item.id === objectId);
        if (!canvas || !element) {
            this.showToast('Object was not found', 'warning');
            return null;
        }
        canvas.selectElement(element);
        canvas.render();
        return this.saveSelectionAsBlock();
    }

    selectObjectById(objectId = '') {
        const canvas = window.infiniteCanvas;
        const element = canvas?.elements?.find((item) => item.id === objectId);
        if (!canvas || !element) return false;
        canvas.selectElement(element);
        canvas.render();
        this.renderObjectLibrary();
        this.renderProductionTimeline();
        this.selectCanvasPanel('objects');
        return true;
    }

    duplicateObjectById(objectId = '') {
        const canvas = window.infiniteCanvas;
        const element = canvas?.elements?.find((item) => item.id === objectId);
        if (!canvas || !element) return false;
        const copy = {
            ...this.normalizeCanvasElement(element),
            id: window.toolManager?.generateId?.() || `el-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            x: (element.x || 0) + 28,
            y: (element.y || 0) + 28,
            startTime: Number.isFinite(element.startTime)
                ? element.startTime + (Number.isFinite(element.durationSeconds) ? element.durationSeconds : 4)
                : element.startTime,
            points: Array.isArray(element.points)
                ? element.points.map((point) => ({ x: point.x + 28, y: point.y + 28 }))
                : element.points,
        };
        canvas.addElement(copy);
        canvas.selectElement(copy);
        window.historyManager?.pushState(canvas.elements);
        this.onCanvasElementsChanged();
        this.showToast('Duplicated object');
        return true;
    }

    deleteObjectById(objectId = '') {
        const canvas = window.infiniteCanvas;
        if (!canvas) return false;
        canvas.removeElement(objectId);
        window.historyManager?.pushState(canvas.elements);
        this.onCanvasElementsChanged();
        this.showToast('Deleted object');
        return true;
    }

    getCanvasInsertionPoint(offsetX = 0, offsetY = 0) {
        const canvas = window.infiniteCanvas;
        const viewportCenter = canvas?.getViewportCenter?.() || {
            x: (canvas?.canvas?.clientWidth || canvas?.canvas?.width || 800) / 2,
            y: (canvas?.canvas?.clientHeight || canvas?.canvas?.height || 600) / 2,
        };
        const center = canvas?.screenToWorld?.(viewportCenter.x, viewportCenter.y) || { x: 0, y: 0 };
        return { x: center.x + offsetX, y: center.y + offsetY };
    }

    handleCreativeAction(action = '') {
        switch (action) {
            case 'connect':
                this.connectSelectedObjects();
                break;
            case 'ai-brief':
                this.openCanvasAIWithPrompt('Compose a richer editable canvas plan using storyboard frames, labels, connectors, audio cues, animation beats, and diagram objects.', { submit: true });
                break;
            case 'ai-prompt':
                this.openCanvasAIWithPrompt(document.getElementById('creativePromptInput')?.value || '', { submit: true });
                break;
            case 'audio-import':
                document.getElementById('canvasAudioInput')?.click();
                break;
            case 'mermaid-render':
                this.addMermaidFlowFromInput();
                break;
            case 'journey-map':
                this.addJourneyMap();
                break;
            case 'system-flow':
                this.addSystemFlow();
                break;
            case 'scene-pack':
                this.addScenePack();
                break;
            case 'empty-frame':
                this.addCreativeElements([this.createStoryboardFrame(this.getCanvasInsertionPoint(), 'Production Frame', 'Draw, import, or generate inside this frame.')]);
                break;
            default:
                this.addCreativePreset(action);
        }
    }

    openCanvasAIWithPrompt(prompt = '', options = {}) {
        window.aiAssistant?.setMode?.('diagram');
        window.aiAssistant?.showPanel?.();
        const input = document.getElementById('aiInput');
        if (input && prompt.trim()) {
            input.value = prompt.trim();
            input.focus();
        }
        if (options.submit && prompt.trim() && window.aiAssistant && !window.aiAssistant.isGenerating) {
            window.aiAssistant.generate?.();
            this.showToast('Canvas AI is building editable objects');
            return;
        }
        this.showToast('Canvas AI is ready for a creative pass');
    }

    addCreativePreset(type = '') {
        this.addCreativePresetAt(type, this.getCanvasInsertionPoint());
    }

    addCreativePresetAt(type = '', point = this.getCanvasInsertionPoint()) {
        const factories = {
            storyboard: () => [this.createStoryboardFrame(point, 'Scene 1', 'Shot, action, camera, and composition notes', { startTime: 0, durationSeconds: 4 })],
            animation: () => [this.createAnimationBeat(point, 'Animation Beat', '0:00-0:04 - motion, easing, transition', { startTime: 0, durationSeconds: 4 })],
            audio: () => [this.createAudioCue(point, 'Audio Cue', 'Voice, music, SFX, or ambience note', { startTime: 0, durationSeconds: 4 })],
            mermaid: () => [this.createMermaidDiagram(point, document.getElementById('mermaidSourceInput')?.value || 'flowchart TD\n  Idea --> Draft\n  Draft --> Review\n  Review --> Ship')],
        };
        const elements = factories[type]?.() || [];
        this.addCreativeElements(elements, `${this.getElementDisplayName(elements[0] || {}, 0)} added`);
    }

    async handleCanvasAudioFile(file) {
        if (!file || !file.type?.startsWith('audio/')) {
            this.showToast('Choose an audio file to add to the canvas', 'warning');
            return;
        }

        const audioUrl = URL.createObjectURL(file);
        const point = this.getCanvasInsertionPoint();
        const maxPersistentBytes = 1500 * 1024;
        let duration = null;

        try {
            duration = await this.readAudioDuration(audioUrl);
        } catch {
            duration = null;
        }

        const options = {
            audioName: file.name,
            audioType: file.type,
            audioSize: file.size,
            duration,
            startTime: this.getNextProductionStartTime(),
            durationSeconds: Number.isFinite(duration) ? Math.max(1, Math.round(duration)) : 4,
            audioUrl,
            audioPersistent: false,
            waveformPeaks: this.createWaveformPeaks(file.name, file.size),
        };

        if (file.size <= maxPersistentBytes) {
            try {
                options.audioUrl = await this.readFileAsDataUrl(file);
                options.audioPersistent = true;
            } catch {
                options.audioUrl = audioUrl;
                options.audioPersistent = false;
            }
        }

        const note = `${file.name}${Number.isFinite(duration) ? ` - ${this.formatDuration(duration)}` : ''}`;
        this.addCreativeElements([this.createAudioCue(point, 'Imported Audio', note, options)], 'Audio cue imported');
        if (file.size > maxPersistentBytes) {
            this.showToast('Large audio is linked for this session; small clips are saved with the board', 'warning');
        }
    }

    readAudioDuration(audioUrl) {
        return new Promise((resolve, reject) => {
            const audio = new Audio();
            const cleanup = () => {
                audio.removeAttribute('src');
                audio.load();
            };
            audio.preload = 'metadata';
            audio.onloadedmetadata = () => {
                const duration = Number.isFinite(audio.duration) ? audio.duration : null;
                cleanup();
                resolve(duration);
            };
            audio.onerror = () => {
                cleanup();
                reject(new Error('Unable to read audio metadata'));
            };
            audio.src = audioUrl;
        });
    }

    readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
            reader.readAsDataURL(file);
        });
    }

    createWaveformPeaks(seedText = '', seedNumber = 0, count = 36) {
        let seed = Array.from(String(seedText)).reduce((sum, char) => sum + char.charCodeAt(0), Number(seedNumber) || 1);
        return Array.from({ length: count }, () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return 0.2 + ((seed / 4294967296) * 0.8);
        });
    }

    formatDuration(seconds) {
        const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
        const minutes = Math.floor(safeSeconds / 60);
        const rest = String(safeSeconds % 60).padStart(2, '0');
        return `${minutes}:${rest}`;
    }

    getNextProductionStartTime() {
        const items = this.getProductionTimelineItems();
        if (items.length === 0) return 0;
        return Math.max(...items.map((item) => item.time + item.duration));
    }

    addJourneyMap() {
        const base = this.getCanvasInsertionPoint(-260, -40);
        const elements = ['Discover', 'Try', 'Decide', 'Return'].map((title, index) => ({
            id: window.toolManager?.generateId?.() || `journey-${Date.now()}-${index}`,
            type: 'sticky',
            x: base.x + index * 190,
            y: base.y,
            width: 160,
            height: 132,
            text: `${title}\nAction\nEmotion\nOpportunity`,
            backgroundColor: ['#fef3c7', '#dbeafe', '#dcfce7', '#fae8ff'][index],
            strokeColor: '#334155',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'journey',
        }));
        this.addCreativeElements(elements, 'Journey map added');
    }

    addSystemFlow() {
        const base = this.getCanvasInsertionPoint(-220, 0);
        const nodes = ['Input', 'Agent', 'Review', 'Output'].map((title, index) => ({
            id: window.toolManager?.generateId?.() || `flow-${Date.now()}-${index}`,
            type: 'rectangle',
            x: base.x + index * 170,
            y: base.y,
            width: 130,
            height: 76,
            text: title,
            backgroundColor: '#e0f2fe',
            strokeColor: '#075985',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'system-flow',
        }));
        const arrows = nodes.slice(0, -1).map((node, index) => this.createArrowBetween(node, nodes[index + 1]));
        this.addCreativeElements([...nodes, ...arrows], 'System flow added');
    }

    addScenePack() {
        const base = this.getCanvasInsertionPoint(-300, -30);
        const frames = [0, 1, 2].map((index) => this.createStoryboardFrame(
            { x: base.x + index * 250, y: base.y },
            `Scene ${index + 1}`,
            index === 0 ? 'Open on problem' : (index === 1 ? 'Show transformation' : 'Resolve with outcome'),
            { startTime: index * 4, durationSeconds: 4 }
        ));
        const beats = frames.map((frame, index) => this.createAnimationBeat(
            { x: frame.x, y: frame.y + 282 },
            `Motion ${index + 1}`,
            index === 0 ? 'Ease in / establish' : (index === 1 ? 'Move through transformation' : 'Hold for resolution'),
            { startTime: index * 4, durationSeconds: 4 }
        ));
        const cues = frames.map((frame, index) => this.createAudioCue(
            { x: frame.x, y: frame.y + 150 },
            `Audio ${index + 1}`,
            'Voice or music cue',
            { startTime: index * 4, durationSeconds: 4 }
        ));
        this.addCreativeElements([...frames, ...cues, ...beats], 'Scene pack added');
    }

    createStoryboardFrame(point, title, note, options = {}) {
        return {
            id: window.toolManager?.generateId?.() || `story-${Date.now()}`,
            type: 'storyboardFrame',
            x: point.x,
            y: point.y,
            width: 220,
            height: 150,
            title,
            text: note,
            backgroundColor: '#f8fafc',
            strokeColor: '#334155',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'storyboard',
            startTime: Number.isFinite(options.startTime) ? options.startTime : null,
            durationSeconds: Number.isFinite(options.durationSeconds) ? options.durationSeconds : 4,
        };
    }

    createAnimationBeat(point, title, note, options = {}) {
        return {
            id: window.toolManager?.generateId?.() || `anim-${Date.now()}`,
            type: 'animationBeat',
            x: point.x,
            y: point.y,
            width: 260,
            height: 98,
            title,
            text: note,
            motionPreset: options.motionPreset || 'ease',
            backgroundColor: '#ecfeff',
            strokeColor: '#0e7490',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'animation',
            startTime: Number.isFinite(options.startTime) ? options.startTime : null,
            durationSeconds: Number.isFinite(options.durationSeconds) ? options.durationSeconds : 4,
        };
    }

    createAudioCue(point, title, note, options = {}) {
        return {
            id: window.toolManager?.generateId?.() || `audio-${Date.now()}`,
            type: 'audioCue',
            x: point.x,
            y: point.y,
            width: 270,
            height: 104,
            title,
            text: note,
            audioName: options.audioName || '',
            audioType: options.audioType || '',
            audioSize: options.audioSize || 0,
            audioUrl: options.audioUrl || '',
            audioPersistent: options.audioPersistent !== false,
            duration: Number.isFinite(options.duration) ? options.duration : null,
            startTime: Number.isFinite(options.startTime) ? options.startTime : null,
            durationSeconds: Number.isFinite(options.durationSeconds)
                ? options.durationSeconds
                : (Number.isFinite(options.duration) ? Math.max(1, Math.round(options.duration)) : 4),
            waveformPeaks: Array.isArray(options.waveformPeaks)
                ? options.waveformPeaks
                : this.createWaveformPeaks(title || note || 'audio'),
            backgroundColor: '#fff7ed',
            strokeColor: '#9a3412',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'audio',
        };
    }

    createMermaidDiagram(point, source) {
        const mermaidNodes = this.parseMermaidFlow(source).nodes.map((node) => node.label);
        return {
            id: window.toolManager?.generateId?.() || `mermaid-${Date.now()}`,
            type: 'mermaidDiagram',
            x: point.x,
            y: point.y,
            width: 300,
            height: 170,
            title: 'Mermaid Diagram',
            text: source,
            mermaidNodes,
            backgroundColor: '#eef2ff',
            strokeColor: '#3730a3',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'mermaid',
        };
    }

    addMermaidFlowFromInput() {
        const source = document.getElementById('mermaidSourceInput')?.value?.trim() || '';
        if (!source) {
            this.showToast('Add Mermaid source first', 'warning');
            return;
        }

        const base = this.getCanvasInsertionPoint(-260, -50);
        const elements = this.buildMermaidFlowElements(source, base, { includeSourceCard: true });
        if (elements.length === 0) {
            this.addCreativeElements([this.createMermaidDiagram(this.getCanvasInsertionPoint(), source)], 'Mermaid source card added');
            this.showToast('Could not find simple Mermaid arrows; source card saved', 'warning');
            return;
        }

        this.addCreativeElements(elements, 'Editable Mermaid flow added');
    }

    buildMermaidFlowElements(source = '', base = this.getCanvasInsertionPoint(-260, -50), options = {}) {
        const parsed = this.parseMermaidFlow(source);
        if (parsed.nodes.length < 2 || parsed.edges.length === 0) {
            return [];
        }

        const nodeElements = parsed.nodes.map((node, index) => {
            const column = index % 3;
            const row = Math.floor(index / 3);
            const isDecision = node.shape === 'diamond';
            return {
                id: window.toolManager?.generateId?.() || `mermaid-node-${Date.now()}-${index}`,
                type: isDecision ? 'diamond' : 'rectangle',
                x: base.x + column * 190,
                y: base.y + row * 130,
                width: isDecision ? 130 : 150,
                height: isDecision ? 92 : 76,
                text: node.label,
                backgroundColor: isDecision ? '#fef3c7' : '#e0e7ff',
                strokeColor: isDecision ? '#92400e' : '#3730a3',
                strokeWidth: 2,
                strokeStyle: 'solid',
                roughness: 1,
                opacity: 1,
                canvasRole: 'mermaid-node',
                mermaidId: node.id,
            };
        });
        const byMermaidId = new Map(parsed.nodes.map((node, index) => [node.id, nodeElements[index]]));
        const arrows = parsed.edges
            .map((edge) => {
                const from = byMermaidId.get(edge.from);
                const to = byMermaidId.get(edge.to);
                return from && to ? this.createArrowBetween(from, to) : null;
            })
            .filter(Boolean);
        const sourceCard = options.includeSourceCard === false
            ? null
            : this.createMermaidDiagram({ x: base.x + 610, y: base.y + 65 }, source);

        return [...nodeElements, ...arrows, sourceCard].filter(Boolean);
    }

    parseMermaidFlow(source = '') {
        const nodes = new Map();
        const edges = [];
        const cleanLines = String(source)
            .split('\n')
            .map((line) => line.replace(/%%.*$/, '').replace(/;$/, '').trim())
            .filter((line) => line && !/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram)/i.test(line));

        cleanLines.forEach((line) => {
            const match = line.match(/^(.+?)\s*(?:-->|---|\-.->|==>)\s*(.+?)$/);
            if (!match) return;
            const from = this.parseMermaidNodeToken(match[1]);
            const to = this.parseMermaidNodeToken(match[2]);
            if (!from.id || !to.id) return;
            this.rememberMermaidNode(nodes, from);
            this.rememberMermaidNode(nodes, to);
            edges.push({ from: from.id, to: to.id });
        });

        return {
            nodes: Array.from(nodes.values()),
            edges,
        };
    }

    rememberMermaidNode(nodes, node) {
        const existing = nodes.get(node.id);
        if (!existing) {
            nodes.set(node.id, node);
            return;
        }

        const existingIsBareReference = existing.label === existing.id;
        const nodeIsBareReference = node.label === node.id;
        if (existingIsBareReference && !nodeIsBareReference) {
            nodes.set(node.id, node);
        }
    }

    parseMermaidNodeToken(token = '') {
        const cleaned = String(token)
            .replace(/^\|.*?\|/, '')
            .replace(/\|.*?\|$/, '')
            .trim()
            .replace(/^["']|["']$/g, '');
        const bracketMatch = cleaned.match(/^([A-Za-z0-9_-]+)?\s*([\[\(\{])(.+?)([\]\)\}])$/);
        if (bracketMatch) {
            const [, idPrefix, open, label] = bracketMatch;
            return {
                id: this.normalizeMermaidId(idPrefix || label),
                label: label.trim().replace(/^["']|["']$/g, ''),
                shape: open === '{' ? 'diamond' : 'rectangle',
            };
        }
        const plain = cleaned.replace(/^[A-Za-z0-9_-]+:/, '').trim();
        return {
            id: this.normalizeMermaidId(plain),
            label: plain,
            shape: 'rectangle',
        };
    }

    normalizeMermaidId(value = '') {
        const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return normalized || String(value || '').trim();
    }

    createArrowBetween(from, to) {
        const { start, end } = this.getConnectionEndpoints(from, to);
        return {
            id: window.toolManager?.generateId?.() || `arrow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: 'arrow',
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2,
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y),
            points: [start, end],
            arrowhead: 'end',
            strokeColor: '#64748b',
            backgroundColor: 'transparent',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            canvasRole: 'connector',
        };
    }

    getConnectionEndpoints(from = {}, to = {}) {
        const fromBounds = this.getElementBounds(from);
        const toBounds = this.getElementBounds(to);
        const fromCenter = {
            x: (fromBounds.left + fromBounds.right) / 2,
            y: (fromBounds.top + fromBounds.bottom) / 2,
        };
        const toCenter = {
            x: (toBounds.left + toBounds.right) / 2,
            y: (toBounds.top + toBounds.bottom) / 2,
        };
        const dx = toCenter.x - fromCenter.x;
        const dy = toCenter.y - fromCenter.y;

        if (Math.abs(dx) >= Math.abs(dy)) {
            return dx >= 0
                ? {
                    start: { x: fromBounds.right + 8, y: fromCenter.y },
                    end: { x: toBounds.left - 8, y: toCenter.y },
                }
                : {
                    start: { x: fromBounds.left - 8, y: fromCenter.y },
                    end: { x: toBounds.right + 8, y: toCenter.y },
                };
        }

        return dy >= 0
            ? {
                start: { x: fromCenter.x, y: fromBounds.bottom + 8 },
                end: { x: toCenter.x, y: toBounds.top - 8 },
            }
            : {
                start: { x: fromCenter.x, y: fromBounds.top - 8 },
                end: { x: toCenter.x, y: toBounds.bottom + 8 },
            };
    }

    getConnectionBuilderOptions() {
        return {
            mode: document.getElementById('connectionModeSelect')?.value || 'chain',
            label: String(document.getElementById('connectionLabelInput')?.value || '').trim(),
        };
    }

    sortElementsForConnection(elements = []) {
        if (elements.length < 3) return [...elements];
        const boxes = elements.map((element) => this.getElementBounds(element));
        const spreadX = Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left));
        const spreadY = Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top));
        return [...elements].sort((a, b) => spreadX >= spreadY ? (a.x || 0) - (b.x || 0) : (a.y || 0) - (b.y || 0));
    }

    createConnectionLabel(arrow = {}, label = '', index = 0, total = 1) {
        const text = total > 1 && label ? `${label} ${index + 1}` : label;
        if (!text || !Array.isArray(arrow.points) || arrow.points.length < 2) return null;
        const [start, end] = arrow.points;
        return {
            id: window.toolManager?.generateId?.() || `connector-label-${Date.now()}-${index}`,
            type: 'text',
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2 - 12,
            width: Math.max(84, text.length * 8),
            height: 26,
            text,
            strokeColor: arrow.strokeColor || '#475569',
            backgroundColor: 'transparent',
            fontSize: 13,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Inter, system-ui, sans-serif',
            opacity: 1,
            canvasRole: 'connector-label',
        };
    }

    renderConnectionBuilder() {
        const summary = document.getElementById('connectionBuilderSummary');
        if (!summary) return;
        const selectedCount = window.infiniteCanvas?.selectedElements?.length || 0;
        summary.textContent = selectedCount >= 2
            ? `${selectedCount} selected - ready to connect`
            : 'Select two or more objects.';
    }

    connectSelectedObjects() {
        const selected = window.infiniteCanvas?.selectedElements || [];
        if (selected.length < 2) {
            this.showToast('Select two objects to connect', 'warning');
            this.renderConnectionBuilder();
            return;
        }
        const options = this.getConnectionBuilderOptions();
        const pairs = [];
        if (options.mode === 'star') {
            const [source, ...targets] = selected;
            targets.forEach((target) => pairs.push([source, target]));
        } else {
            const sorted = this.sortElementsForConnection(selected);
            for (let index = 0; index < sorted.length - 1; index += 1) {
                pairs.push([sorted[index], sorted[index + 1]]);
            }
        }

        const arrows = pairs.map(([from, to]) => this.createArrowBetween(from, to));
        const labels = arrows
            .map((arrow, index) => this.createConnectionLabel(arrow, options.label, index, arrows.length))
            .filter(Boolean);
        this.addCreativeElements(
            [...arrows, ...labels],
            `Connected ${selected.length} objects with ${arrows.length} arrow${arrows.length === 1 ? '' : 's'}`,
        );
    }

    addCreativeElements(elements = [], message = 'Added canvas block') {
        const canvas = window.infiniteCanvas;
        if (!canvas || elements.length === 0) return;
        elements.forEach((element) => canvas.addElement(element));
        canvas.selectElements(elements);
        window.historyManager?.pushState(canvas.elements);
        this.onCanvasElementsChanged();
        this.selectCanvasPanel('objects');
        this.showToast(message);
    }

    escapeHtml(value = '') {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    escapeHtmlAttr(value = '') {
        return this.escapeHtml(value);
    }
    
    setupMiniMap() {
        const miniMapToggle = document.getElementById('miniMapToggle');
        const miniMap = document.getElementById('miniMap');

        this.syncMiniMapToggleState(miniMapToggle, Boolean(miniMap && miniMap.style.display !== 'none'));
        
        miniMapToggle?.addEventListener('click', () => {
            const isVisible = miniMap?.style.display !== 'none';
            if (miniMap) {
                miniMap.style.display = isVisible ? 'none' : 'block';
            }
            this.syncMiniMapToggleState(miniMapToggle, !isVisible);
            
            if (!isVisible) {
                this.updateMiniMap();
            }
        });
        
        // Update mini map on canvas changes
        window.infiniteCanvas?.canvas?.addEventListener('change', () => {
            if (miniMap?.style.display !== 'none') {
                this.updateMiniMap();
            }
        });
    }

    syncMiniMapToggleState(toggle, isVisible) {
        if (!toggle) return;

        const label = isVisible ? 'Hide mini map' : 'Show mini map';
        toggle.classList.toggle('active', isVisible);
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute('aria-controls', 'miniMap');
        toggle.setAttribute('aria-expanded', String(isVisible));
        toggle.setAttribute('aria-pressed', String(isVisible));
        toggle.setAttribute('title', label);
    }
    
    updateMiniMap() {
        const miniMapCanvas = document.getElementById('miniMapCanvas');
        const miniMapViewport = document.getElementById('miniMapViewport');
        if (!miniMapCanvas || !window.infiniteCanvas) return;
        
        const canvas = window.infiniteCanvas;
        const ctx = miniMapCanvas.getContext('2d');
        
        // Get canvas bounds
        const bounds = canvas.getBounds();
        const padding = 50;
        
        // Set mini map dimensions
        const scale = Math.min(
            miniMapCanvas.width / (bounds.width + padding * 2),
            miniMapCanvas.height / (bounds.height + padding * 2)
        );
        
        // Clear mini map
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg');
        ctx.fillRect(0, 0, miniMapCanvas.width, miniMapCanvas.height);
        
        // Draw elements
        ctx.save();
        ctx.translate(
            miniMapCanvas.width / 2 - (bounds.x + bounds.width / 2) * scale,
            miniMapCanvas.height / 2 - (bounds.y + bounds.height / 2) * scale
        );
        ctx.scale(scale, scale);
        
        for (const element of canvas.elements) {
            window.renderer?.drawElement(ctx, element);
        }
        
        ctx.restore();
        
        // Update viewport indicator
        if (miniMapViewport) {
            const viewport = canvas.getViewportSize?.() || {
                width: canvas.canvas.clientWidth || canvas.canvas.width,
                height: canvas.canvas.clientHeight || canvas.canvas.height,
            };
            const viewportWidth = viewport.width / canvas.scale * scale;
            const viewportHeight = viewport.height / canvas.scale * scale;
            miniMapViewport.style.width = `${viewportWidth}px`;
            miniMapViewport.style.height = `${viewportHeight}px`;
            miniMapViewport.style.left = `${miniMapCanvas.width / 2 - viewportWidth / 2}px`;
            miniMapViewport.style.top = `${miniMapCanvas.height / 2 - viewportHeight / 2}px`;
        }
    }
    
    setupAITooltip() {
        const aiTooltip = document.getElementById('aiImageTooltip');
        const aiTooltipClose = document.getElementById('aiTooltipClose');
        
        // Close button handler
        aiTooltipClose?.addEventListener('click', () => {
            if (aiTooltip) {
                aiTooltip.style.display = 'none';
            }
            if (this.aiTooltipTimeout) {
                clearTimeout(this.aiTooltipTimeout);
            }
        });
        
        // Auto-hide after 3 seconds when shown
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    if (aiTooltip?.style.display === 'block') {
                        if (this.aiTooltipTimeout) {
                            clearTimeout(this.aiTooltipTimeout);
                        }
                        this.aiTooltipTimeout = setTimeout(() => {
                            if (aiTooltip) {
                                aiTooltip.style.display = 'none';
                            }
                        }, 3000);
                    }
                }
            });
        });
        
        if (aiTooltip) {
            observer.observe(aiTooltip, { attributes: true });
        }
        
        // Hide on click elsewhere
        document.addEventListener('click', (e) => {
            if (aiTooltip && !aiTooltip.contains(e.target) && 
                !e.target.closest('[data-tool="ai-image"]')) {
                aiTooltip.style.display = 'none';
            }
        });
    }
    
    setupFontSearch() {
        const fontSearchInput = document.getElementById('fontSearchInput');
        if (!fontSearchInput) return;
        
        let debounceTimer;
        
        fontSearchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                window.propertiesManager?.filterFonts(e.target.value);
            }, 300);
        });
    }
    
    setupOpacitySlider() {
        const opacitySlider = document.getElementById('opacitySlider');
        const opacityValue = document.getElementById('opacityValue');
        const opacityPreview = document.getElementById('opacityPreview');
        
        if (!opacitySlider) return;
        
        const updateOpacity = () => {
            const value = opacitySlider.value;
            if (opacityValue) {
                opacityValue.textContent = `${value}%`;
            }
            if (opacityPreview) {
                opacityPreview.style.width = `${value}%`;
            }
            
            // Update selected elements in real-time
            const canvas = window.infiniteCanvas;
            if (canvas?.selectedElements.length > 0) {
                for (const el of canvas.selectedElements) {
                    el.opacity = value / 100;
                }
                canvas.render();
            }
            
            // Update default properties
            window.toolManager?.updateDefaultProperties({ opacity: value / 100 });
        };
        
        opacitySlider.addEventListener('input', updateOpacity);
        
        // Initial update
        updateOpacity();
    }
    
    showExportProgress() {
        const modal = document.getElementById('exportProgressModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }
    
    hideExportProgress() {
        const modal = document.getElementById('exportProgressModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    updateExportProgress(progress, page = '') {
        const fill = document.getElementById('exportProgressFill');
        const text = document.getElementById('exportProgressText');
        const pageText = document.getElementById('exportProgressPage');
        
        if (fill) fill.style.width = `${progress}%`;
        if (text) text.textContent = progress < 100 ? 'Exporting...' : 'Complete!';
        if (pageText && page) pageText.textContent = page;
    }
    
    setupKeyboardShortcuts() {
        // Global keyboard shortcuts handled in individual modules
        // Additional app-level shortcuts:
        document.addEventListener('keydown', (e) => {
            // Don't process shortcuts when in input fields
            const isInputActive = document.activeElement.tagName === 'TEXTAREA' || 
                                  document.activeElement.tagName === 'INPUT';
            
            // Help shortcut
            if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isInputActive) {
                this.showHelpModal();
            }

            // Command palette (Ctrl/Cmd + K)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                this.toggleCanvasCommandPalette();
                return;
            }
            
            // Templates shortcut (Ctrl/Cmd + T)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !isInputActive) {
                e.preventDefault();
                window.templatesManager?.showTemplatesModal();
            }
            
            // Stickers shortcut (Ctrl/Cmd + Shift + S)
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's' && !isInputActive) {
                e.preventDefault();
                window.stickersManager?.toggleStickersPanel();
            }
            
            // Layers panel toggle (Ctrl/Cmd + L)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !isInputActive && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('layersPanel')?.classList.toggle('active');
            }
            
            // Mini map toggle (M)
            if (e.key.toLowerCase() === 'm' && !isInputActive && !e.ctrlKey && !e.metaKey && !e.altKey) {
                document.getElementById('miniMapToggle')?.click();
            }
            
            // Escape to close modals and deselect
            if (e.key === 'Escape') {
                if (this.commandPaletteOpen) {
                    this.closeCanvasCommandPalette();
                    return;
                }

                // First check if text editor is open
                const textEditor = document.getElementById('textEditor');
                if (textEditor && textEditor.style.display === 'block') {
                    textEditor.blur();
                    return;
                }
                
                // Close mobile panels
                document.getElementById('toolbar')?.classList.remove('active');
                document.getElementById('propertiesPanel')?.classList.remove('active');
                
                this.hideExportModal();
                this.hideHelpModal();
                window.aiAssistant?.hidePanel();
                window.infiniteCanvas?.deselectAll();
            }
            
            // Ctrl/Cmd shortcuts
            if ((e.ctrlKey || e.metaKey) && !isInputActive) {
                switch (e.key.toLowerCase()) {
                    case 'z':
                        e.preventDefault();
                        if (e.shiftKey) {
                            window.historyManager?.redo();
                        } else {
                            window.historyManager?.undo();
                        }
                        break;
                    case 'y':
                        e.preventDefault();
                        window.historyManager?.redo();
                        break;
                    case 'd':
                        e.preventDefault();
                        window.selectionManager?.duplicateSelection();
                        break;
                    case 'c':
                        e.preventDefault();
                        window.toolManager?.copySelection();
                        this.showToast('Copied to clipboard');
                        break;
                    case 'x':
                        e.preventDefault();
                        window.toolManager?.cutSelection();
                        this.showToast('Cut to clipboard');
                        break;
                    case 'v':
                        e.preventDefault();
                        window.toolManager?.paste();
                        break;
                    case 'g':
                        e.preventDefault();
                        if (e.shiftKey) {
                            window.selectionManager?.ungroupSelection();
                        } else {
                            window.selectionManager?.groupSelection();
                        }
                        break;
                    case 's':
                        e.preventDefault();
                        this.exportCanvas('json');
                        break;
                    case 'o':
                        e.preventDefault();
                        this.importJSON();
                        break;
                    case 'e':
                        e.preventDefault();
                        window.importExportManager?.showExportDialog();
                        break;
                    case 'a':
                        e.preventDefault();
                        // Select all
                        const canvas = window.infiniteCanvas;
                        canvas.selectElements(canvas.elements);
                        break;
                }
            }
        });
    }
    
    setupTouchHandling() {
        // Long-press tooltips for mobile
        if (window.matchMedia('(pointer: coarse)').matches) {
            document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
                let pressTimer;
                
                btn.addEventListener('touchstart', (e) => {
                    pressTimer = setTimeout(() => {
                        btn.classList.add('show-tooltip');
                        setTimeout(() => {
                            btn.classList.remove('show-tooltip');
                        }, 1500);
                    }, 500);
                });
                
                btn.addEventListener('touchend', () => {
                    clearTimeout(pressTimer);
                });
                
                btn.addEventListener('touchmove', () => {
                    clearTimeout(pressTimer);
                });
            });
        }
    }

    setupCanvasContextMenu() {
        const container = document.getElementById('canvasContainer');
        const menu = document.getElementById('canvasContextMenu');
        if (!container || !menu) return;

        menu.addEventListener('click', (e) => {
            const actionButton = e.target.closest('[data-context-action]');
            if (!actionButton) return;
            e.preventDefault();
            this.runCanvasContextAction(actionButton.dataset.contextAction);
        });
        menu.addEventListener('keydown', (e) => this.handleCanvasContextMenuKeydown(e));

        document.addEventListener('click', (e) => {
            if (!menu.hidden && !menu.contains(e.target)) {
                this.hideCanvasContextMenu();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideCanvasContextMenu();
            }
        });

        container.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            this.contextLongPressTimer = setTimeout(() => {
                this.handleCanvasContextMenu({
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    preventDefault: () => e.preventDefault(),
                });
            }, 560);
        }, { passive: false });

        ['touchmove', 'touchend', 'touchcancel'].forEach((eventName) => {
            container.addEventListener(eventName, () => {
                clearTimeout(this.contextLongPressTimer);
            });
        });
    }

    handleCanvasContextMenu(event) {
        const canvas = window.infiniteCanvas;
        if (!canvas) return false;

        event.preventDefault();
        this.contextMenuWorldPos = this.getCanvasWorldPosition(event.clientX, event.clientY);

        const element = canvas.getElementAt(this.contextMenuWorldPos.x, this.contextMenuWorldPos.y, 8 / Math.max(canvas.scale || 1, 0.1));
        if (element && !canvas.selectedElements.includes(element)) {
            canvas.selectElement(element);
        }

        this.showCanvasContextMenu(event.clientX, event.clientY, canvas.selectedElements.length > 0);
        return true;
    }

    getCanvasWorldPosition(clientX, clientY) {
        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        return {
            x: (clientX - rect.left - canvas.offsetX) / canvas.scale,
            y: (clientY - rect.top - canvas.offsetY) / canvas.scale,
        };
    }

    showCanvasContextMenu(clientX, clientY, hasSelection) {
        const menu = document.getElementById('canvasContextMenu');
        if (!menu) return;

        menu.hidden = false;
        menu.style.visibility = 'hidden';

        menu.querySelector('[data-context-section="empty"]')?.toggleAttribute('hidden', hasSelection);
        menu.querySelector('[data-context-section="selection"]')?.toggleAttribute('hidden', !hasSelection);
        menu.setAttribute('aria-label', hasSelection ? 'Selected canvas object actions' : 'Canvas board actions');
        menu.querySelectorAll('hr').forEach((rule) => {
            rule.toggleAttribute('hidden', !hasSelection);
        });

        const gap = 10;
        const menuRect = menu.getBoundingClientRect();
        const left = Math.min(Math.max(gap, clientX), window.innerWidth - menuRect.width - gap);
        const top = Math.min(Math.max(gap, clientY), window.innerHeight - menuRect.height - gap);

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.visibility = '';
        this.focusCanvasContextMenuItem(0, menu);
    }

    hideCanvasContextMenu() {
        const menu = document.getElementById('canvasContextMenu');
        if (menu) {
            menu.hidden = true;
            this.syncCanvasContextMenuItems(menu, null);
        }
    }

    getVisibleCanvasContextMenuItems(menu = document.getElementById('canvasContextMenu')) {
        if (!menu) return [];
        return Array.from(menu.querySelectorAll('[data-context-action]'))
            .filter((item) => !item.disabled && !item.hidden && !item.closest('[hidden]'));
    }

    syncCanvasContextMenuItems(menu = document.getElementById('canvasContextMenu'), activeItem = null) {
        if (!menu) return;
        menu.querySelectorAll('[data-context-action]').forEach((item) => {
            const isActive = item === activeItem;
            item.setAttribute('tabindex', isActive ? '0' : '-1');
            if (isActive) {
                item.setAttribute('aria-current', 'true');
            } else {
                item.removeAttribute('aria-current');
            }
        });
    }

    focusCanvasContextMenuItem(index, menu = document.getElementById('canvasContextMenu')) {
        const items = this.getVisibleCanvasContextMenuItems(menu);
        if (items.length === 0) return;

        const normalizedIndex = (index + items.length) % items.length;
        const activeItem = items[normalizedIndex];
        this.syncCanvasContextMenuItems(menu, activeItem);
        activeItem?.focus({ preventScroll: true });
    }

    handleCanvasContextMenuKeydown(event) {
        const menu = document.getElementById('canvasContextMenu');
        if (!menu || menu.hidden) return;

        const items = this.getVisibleCanvasContextMenuItems(menu);
        if (items.length === 0) return;

        const currentIndex = Math.max(0, items.indexOf(document.activeElement));
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                this.focusCanvasContextMenuItem(currentIndex + 1, menu);
                break;
            case 'ArrowUp':
                event.preventDefault();
                this.focusCanvasContextMenuItem(currentIndex - 1, menu);
                break;
            case 'Home':
                event.preventDefault();
                this.focusCanvasContextMenuItem(0, menu);
                break;
            case 'End':
                event.preventDefault();
                this.focusCanvasContextMenuItem(items.length - 1, menu);
                break;
            case 'Enter':
            case ' ':
                {
                    const actionButton = document.activeElement?.closest?.('[data-context-action]');
                    if (!actionButton || !menu.contains(actionButton)) return;
                    event.preventDefault();
                    this.runCanvasContextAction(actionButton.dataset.contextAction);
                }
                break;
            case 'Escape':
                event.preventDefault();
                this.hideCanvasContextMenu();
                break;
        }
    }

    runCanvasContextAction(action) {
        const canvas = window.infiniteCanvas;
        if (!action || !canvas) return;

        if (action.startsWith('tool:')) {
            const tool = action.replace('tool:', '');
            window.toolManager?.setTool(tool);
            this.syncToolDockActive(tool);
            this.hideCanvasContextMenu();
            return;
        }

        if (action.startsWith('create:')) {
            const type = action.replace('create:', '');
            this.addCreativePresetAt(type, this.contextMenuWorldPos || this.getCanvasInsertionPoint());
            this.hideCanvasContextMenu();
            return;
        }

        switch (action) {
            case 'ai:board':
                {
                    const point = this.contextMenuWorldPos || this.getCanvasInsertionPoint();
                    this.openCanvasAIWithPrompt(`Create or improve editable canvas objects around (${Math.round(point.x)}, ${Math.round(point.y)}). Use concise labels, boxes, arrows, storyboard frames, audio cues, or motion beats when useful.`);
                }
                break;
            case 'ai:selection':
                window.aiAssistant?.setMode('chat');
                window.aiAssistant?.showPanel();
                this.showToast('AI panel focused on selection');
                break;
            case 'import':
                this.importJSON();
                break;
            case 'duplicate':
                window.selectionManager?.duplicateSelection();
                this.showToast('Duplicated selection');
                break;
            case 'copy':
                window.toolManager?.copySelection();
                this.showToast('Copied selection');
                break;
            case 'save-selection-block':
                this.saveSelectionAsBlock();
                break;
            case 'delete':
                this.deleteSelectedElements();
                break;
            case 'bring-front':
                window.selectionManager?.bringToFront();
                this.showToast('Brought selection forward');
                break;
            case 'send-back':
                window.selectionManager?.sendToBack();
                this.showToast('Sent selection backward');
                break;
            case 'group':
                window.selectionManager?.groupSelection();
                break;
            case 'ungroup':
                window.selectionManager?.ungroupSelection();
                break;
            case 'connect-selected':
                this.connectSelectedObjects();
                break;
            case 'insert-recent-block':
                this.insertMostRecentSavedBlock(this.contextMenuWorldPos || this.getCanvasInsertionPoint());
                break;
        }

        canvas.render();
        this.onSelectionChange();
        this.hideCanvasContextMenu();
    }

    deleteSelectedElements() {
        const canvas = window.infiniteCanvas;
        if (!canvas?.selectedElements.length) return;

        const selectedIds = new Set(canvas.selectedElements.map((el) => el.id));
        canvas.elements = canvas.elements.filter((el) => !selectedIds.has(el.id));
        canvas.deselectAll();
        window.historyManager?.pushState(canvas.elements);
        this.saveCanvasToStorage();
        this.showToast('Deleted selection');
    }
    
    setupImageUpload() {
        const input = document.getElementById('imageInput');
        if (!input) return;
        
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            this.loadImage(file, {
                x: parseFloat(input.dataset.posX) || 0,
                y: parseFloat(input.dataset.posY) || 0
            }).catch((error) => this.showToast(error.message || 'Image could not be added', 'error'));
            
            // Reset input
            input.value = '';
        });
    }
    
    loadImage(file, pos, metadata = {}) {
        const canvas = window.infiniteCanvas;
        const reader = new FileReader();

        return new Promise((resolve, reject) => {
            reader.onerror = () => reject(new Error('Image could not be read'));
            reader.onload = (event) => {
                const img = new Image();
                img.onerror = () => reject(new Error('Image could not be opened'));
                img.onload = () => {
                    // Calculate size while maintaining aspect ratio
                    const maxWidth = 400;
                    const maxHeight = 300;
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth) {
                        height *= maxWidth / width;
                        width = maxWidth;
                    }
                    if (height > maxHeight) {
                        width *= maxHeight / height;
                        height = maxHeight;
                    }

                    // If no position specified, use center of view
                    const viewportCenter = canvas.getViewportCenter?.() || {
                        x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
                        y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
                    };
                    const centerWorld = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
                    const x = Number.isFinite(pos?.x) ? pos.x : centerWorld.x;
                    const y = Number.isFinite(pos?.y) ? pos.y : centerWorld.y;

                    const element = {
                        id: window.toolManager.generateId(),
                        type: 'image',
                        x,
                        y,
                        width,
                        height,
                        imageElement: img,
                        name: String(metadata.name || file.name || 'Shared image').slice(0, 120),
                        canvasRole: metadata.canvasRole || 'image',
                        sharedWithAI: metadata.sharedWithAI === true,
                        ...window.toolManager.defaultProperties,
                    };

                    canvas.addElement(element);
                    window.historyManager?.pushState(canvas.elements);

                    // Reset tool to selection
                    window.toolManager.setTool('selection');
                    canvas.selectElement(element);
                    this.saveCanvasToStorage?.();
                    resolve(element);
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        });
    }
    
    async handleFileDrop(e) {
        const files = e.dataTransfer.files;
        const canvas = window.infiniteCanvas;
        const rect = canvas.container.getBoundingClientRect();
        
        // Use new import system if available
        if (window.importExportManager) {
            // Get drop position for positioning imported elements
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const worldPos = canvas.screenToWorld(x, y);
            
            // Store current state for undo
            const previousElements = [...canvas.elements];
            const importSummary = {
                count: 0,
                files: [],
                errors: []
            };
            
            // Process each file
            for (const file of files) {
                try {
                    // Check if it's an image type
                    const isImage = file.type.startsWith('image/') || 
                        /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.name);
                    
                    if (isImage) {
                        await window.importExportManager.importImage(file, worldPos);
                        importSummary.count++;
                        importSummary.files.push(file.name);
                    } else {
                        await window.importExportManager.importFile(file);
                        importSummary.count++;
                        importSummary.files.push(file.name);
                    }
                } catch (error) {
                    // Map technical errors to user-friendly messages
                    const errorMessage = this.getUserFriendlyError(error, file.name);
                    importSummary.errors.push({ file: file.name, error: errorMessage });
                }
            }
            
            // Store import data for undo
            this.lastImport = {
                previousElements,
                newElements: canvas.elements.filter(el => !previousElements.includes(el)),
                summary: importSummary
            };
            
            // Show appropriate toast
            if (importSummary.count > 0) {
                this.showToast(`Imported ${importSummary.count} file(s)`);
                
                // Show undo option
                if (importSummary.count > 1) {
                    this.showUndoImportToast(importSummary);
                }
            }
            
            if (importSummary.errors.length > 0) {
                console.error('Import errors:', importSummary.errors);
                this.showToast(`${importSummary.errors.length} file(s) failed to import`, 'error');
            }
        } else {
            // Fallback to legacy import
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    const worldPos = canvas.screenToWorld(x, y);
                    this.loadImage(file, worldPos)
                        .catch((error) => this.showToast(error.message || 'Image could not be added', 'error'));
                } else if (file.name.endsWith('.json')) {
                    this.importJSONFile(file);
                }
            }
        }
    }
    
    getUserFriendlyError(error, filename) {
        const errorMap = {
            'Invalid JSON': `The file "${filename}" is not a valid JSON file.`,
            'Failed to read file': `Could not read "${filename}". The file may be corrupted.`,
            'Failed to load image': `Could not load "${filename}" as an image.`,
            'Unsupported file type': `"${filename}" has an unsupported file format.`
        };
        
        for (const [key, message] of Object.entries(errorMap)) {
            if (error.message?.includes(key)) {
                return message;
            }
        }
        
        return `Failed to import "${filename}": ${error.message || 'Unknown error'}`;
    }
    
    showUndoImportToast(summary) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `
            <div>Imported ${summary.count} items</div>
            <button class="undo-btn" style="margin-left: 12px; padding: 4px 8px; background: var(--accent-color); color: white; border: none; border-radius: 4px; cursor: pointer;">Undo</button>
        `;
        
        toast.querySelector('.undo-btn')?.addEventListener('click', () => {
            this.undoLastImport();
            toast.remove();
        });
        
        document.getElementById('toastContainer')?.appendChild(toast);
        
        setTimeout(() => toast.remove(), 5000);
    }
    
    undoLastImport() {
        if (!this.lastImport) return;
        
        const canvas = window.infiniteCanvas;
        if (!canvas) return;
        
        // Restore previous elements
        canvas.elements = this.lastImport.previousElements;
        canvas.render();
        window.historyManager?.pushState(canvas.elements);
        
        this.showToast('Import undone');
        this.lastImport = null;
    }
    
    setupTheme() {
        if (document.body.classList.contains('canvas-core-mode')) {
            document.documentElement.removeAttribute('data-theme');
            return;
        }

        // Check for saved theme preference
        const savedTheme = localStorage.getItem('kimi-canvas-theme');
        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
        } else {
            // Check system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                document.documentElement.setAttribute('data-theme', 'dark');
            }
        }
    }
    
    setTheme(theme) {
        if (document.body.classList.contains('canvas-core-mode')) {
            return;
        }

        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('kimi-canvas-theme', theme);
        window.infiniteCanvas?.render();
        this.showToast(`Theme changed to ${theme.charAt(0).toUpperCase() + theme.slice(1)}`);
    }
    
    toggleTheme() {
        // Legacy toggle - cycles through light/dark
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        this.setTheme(newTheme);
    }
    
    showLoading(message = 'Loading...') {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.querySelector('span').textContent = message;
            overlay.style.display = 'flex';
        }
    }
    
    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }
    
    setupExport() {
        // Already handled in setupEventListeners
    }
    
    onSelectionChange() {
        const canvas = window.infiniteCanvas;
        
        // Update properties panel
        window.propertiesManager?.updateForSelection();
        window.aiAssistant?.updateGroundingPanel();
        this.updateCanvasStatusStrip();
        this.renderObjectLibrary();
        this.renderBoardShelf();
        this.renderProductionTimeline();
        
        // Selection box update is now handled in canvas.render()
        // which is called after selection changes
    }
    
    showExportModal() {
        document.getElementById('exportModal')?.classList.add('active');
    }
    
    hideExportModal() {
        document.getElementById('exportModal')?.classList.remove('active');
    }
    
    showHelpModal() {
        const modal = document.getElementById('helpModal');
        if (!modal) return;

        this.helpModalPreviousFocus = document.activeElement?.focus ? document.activeElement : null;
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        document.getElementById('closeHelpModal')?.focus({ preventScroll: true });
    }
    
    hideHelpModal() {
        const modal = document.getElementById('helpModal');
        if (!modal) return;

        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        if (this.helpModalPreviousFocus && document.contains(this.helpModalPreviousFocus)) {
            this.helpModalPreviousFocus.focus({ preventScroll: true });
        }
        this.helpModalPreviousFocus = null;
    }

    handleHelpModalKeydown(event) {
        if (event.key !== 'Tab') return;

        const modal = document.getElementById('helpModal');
        if (!modal || !modal.classList.contains('active')) return;

        const focusable = Array.from(modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !element.disabled
            && !element.hasAttribute('hidden')
            && element.getAttribute('aria-hidden') !== 'true');

        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }
    
    setupModelSelector() {
        const topModelSelect = document.getElementById('topModelSelect');
        if (topModelSelect) {
            // Set initial value from localStorage via apiManager
            const selectedModel = window.apiManager.getSelectedModel();
            if ([...topModelSelect.options].some((option) => option.value === selectedModel)) {
                topModelSelect.value = selectedModel;
            }
            
            // Handle model change
            topModelSelect.addEventListener('change', (e) => {
                window.apiManager.setSelectedModel(e.target.value);
                
                // Also update AI panel model selector if it exists
                const diagramModelSelect = document.getElementById('diagramModelSelect');
                if (diagramModelSelect) {
                    diagramModelSelect.value = e.target.value;
                }
            });
        }
    }
    
    setupAIModeToggles() {
        // Mode toggle buttons
        const chatModeBtn = document.getElementById('chatModeBtn');
        const diagramModeBtn = document.getElementById('diagramModeBtn');
        const imageModeBtn = document.getElementById('imageModeBtn');
        
        if (chatModeBtn) {
            chatModeBtn.addEventListener('click', () => {
                window.aiAssistant?.setMode('chat');
            });
        }

        if (diagramModeBtn) {
            diagramModeBtn.addEventListener('click', () => {
                window.aiAssistant?.setMode('diagram');
            });
        }
        
        if (imageModeBtn) {
            imageModeBtn.addEventListener('click', () => {
                window.aiAssistant?.setMode('image');
            });
        }
        
        // Diagram model selector
        const diagramModelSelect = document.getElementById('diagramModelSelect');
        if (diagramModelSelect) {
            const selectedModel = window.apiManager.getSelectedModel();
            if ([...diagramModelSelect.options].some((option) => option.value === selectedModel)) {
                diagramModelSelect.value = selectedModel;
            }
            diagramModelSelect.addEventListener('change', (e) => {
                window.apiManager.setSelectedModel(e.target.value);
                
                // Also update top bar selector
                const topModelSelect = document.getElementById('topModelSelect');
                if (topModelSelect) {
                    topModelSelect.value = e.target.value;
                }
            });
        }
        
        // Image model selector
        const imageModelSelect = document.getElementById('imageModelSelect');
        if (imageModelSelect) {
            imageModelSelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('model', e.target.value);
            });
        }
        
        // Image size selector
        const imageSizeSelect = document.getElementById('imageSizeSelect');
        if (imageSizeSelect) {
            imageSizeSelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('size', e.target.value);
            });
        }
        
        // Image quality selector
        const imageQualitySelect = document.getElementById('imageQualitySelect');
        if (imageQualitySelect) {
            imageQualitySelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('quality', e.target.value);
            });
        }
        
        // Image style selector
        const imageStyleSelect = document.getElementById('imageStyleSelect');
        if (imageStyleSelect) {
            imageStyleSelect.addEventListener('change', (e) => {
                window.aiAssistant?.updateImageSettings('style', e.target.value);
            });
        }
        
        // Download image button
        const downloadImageBtn = document.getElementById('downloadImageBtn');
        if (downloadImageBtn) {
            downloadImageBtn.addEventListener('click', () => {
                this.downloadSelectedImage();
            });
        }
    }
    
    downloadSelectedImage() {
        const canvas = window.infiniteCanvas;
        if (canvas.selectedElements.length === 1) {
            const el = canvas.selectedElements[0];
            if (el.type === 'image' && el.imageUrl) {
                const a = document.createElement('a');
                a.href = el.imageUrl;
                a.download = `ai-image-${Date.now()}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        }
    }
    
    clearCanvas() {
        if (confirm('Are you sure you want to clear the canvas? This cannot be undone.')) {
            const canvas = window.infiniteCanvas;
            canvas.elements = [];
            canvas.selectedElements = [];
            window.historyManager?.clear();
            window.historyManager?.pushState([]);
            canvas.render();
            this.onSelectionChange();
            
            // Clear auto-save
            try {
                localStorage.removeItem('kimi-canvas-autosave');
                this.lastCanvasSavedAt = null;
                this.updateCanvasStatusStrip();
            } catch (e) {
                console.warn('Failed to clear auto-save:', e);
            }
        }
    }
    
    async exportCanvas(format, options = {}) {
        this.hideExportModal();
        
        const canvas = window.infiniteCanvas;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        switch (format) {
            case 'png':
                const dataURL = canvas.exportToDataURL('image/png', options);
                this.downloadFile(dataURL, `canvas-${timestamp}.png`);
                this.showToast('Exported to PNG');
                break;
                
            case 'svg':
                const svgData = this.exportToSVG(options);
                this.downloadFile('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData), `canvas-${timestamp}.svg`);
                this.showToast('Exported to SVG');
                break;
                
            case 'json':
                const jsonData = JSON.stringify(canvas.elements, null, 2);
                const blob = new Blob([jsonData], { type: 'application/json' });
                this.downloadFile(URL.createObjectURL(blob), `canvas-${timestamp}.json`);
                this.showToast('Exported to JSON');
                break;
        }
    }
    
    exportToSVG(options = {}) {
        const canvas = window.infiniteCanvas;
        
        // Calculate bounds
        const bounds = canvas.getBounds();
        const padding = options.padding !== undefined ? options.padding : 20;
        
        const width = bounds.width + padding * 2;
        const height = bounds.height + padding * 2;
        const offsetX = -bounds.x + padding;
        const offsetY = -bounds.y + padding;
        
        let svg = `<?xml version="1.0" encoding="UTF-8"?>`;
        svg += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
        
        // Add background (unless transparent)
        if (!options.transparent) {
            const bgColor = options.backgroundColor || 
                (document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e1e1e' : '#ffffff');
            svg += `<rect width="100%" height="100%" fill="${bgColor}"/>`;
        }
        
        // Export each element
        for (const el of canvas.elements) {
            svg += this.elementToSVG(el, offsetX, offsetY);
        }
        
        svg += '</svg>';
        return svg;
    }
    
    elementToSVG(el, offsetX, offsetY) {
        const x = (el.x || 0) + offsetX;
        const y = (el.y || 0) + offsetY;
        const hw = (el.width || 0) / 2;
        const hh = (el.height || 0) / 2;
        const stroke = el.strokeColor || '#000000';
        const fill = el.backgroundColor || 'none';
        const strokeWidth = el.strokeWidth || 2;
        const opacity = el.opacity ?? 1;
        
        let svg = '';
        
        switch (el.type) {
            case 'rectangle':
                svg = `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}"`;
                svg += ` fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"`;
                if (el.edgeType === 'round') {
                    const r = Math.min(el.width, el.height) * 0.1;
                    svg += ` rx="${r}" ry="${r}"`;
                }
                svg += '/>';
                // Add text if present
                if (el.text) {
                    svg += this.shapeTextToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'diamond':
                const points = `${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}`;
                svg = `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                // Add text if present
                if (el.text) {
                    svg += this.shapeTextToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'ellipse':
                svg = `<ellipse cx="${x}" cy="${y}" rx="${hw}" ry="${hh}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                // Add text if present
                if (el.text) {
                    svg += this.shapeTextToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'text':
                if (el.text) {
                    const lines = el.text.split('\n');
                    const lineHeight = (el.fontSize || 20) * 1.4;
                    const startY = y - (lines.length - 1) * lineHeight / 2;
                    
                    svg += `<g opacity="${opacity}">`;
                    lines.forEach((line, i) => {
                        const lineY = startY + i * lineHeight;
                        svg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${stroke}" font-size="${el.fontSize || 20}" font-family="${this.escapeXml(el.fontFamily || 'sans-serif')}">${this.escapeXml(line)}</text>`;
                    });
                    svg += '</g>';
                }
                break;
                
            case 'sticky':
                svg = `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}"`;
                svg += ` fill="${el.backgroundColor || '#ffec99'}" stroke="${el.strokeColor || '#e6b800'}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                
                if (el.text) {
                    svg += `<text x="${x - hw + 12}" y="${y - hh + 24}" fill="${el.strokeColor || '#5c4b00'}" font-size="16" font-family="${this.escapeXml(el.fontFamily || 'Virgil, cursive')}">${this.escapeXml(el.text)}</text>`;
                }
                break;
                
            case 'line':
            case 'arrow':
                if (el.points && el.points.length >= 2) {
                    const p1 = el.points[0];
                    const p2 = el.points[1];
                    svg = `<line x1="${p1.x + offsetX}" y1="${p1.y + offsetY}" x2="${p2.x + offsetX}" y2="${p2.y + offsetY}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                    
                    if (el.type === 'arrow') {
                        // Simple arrowhead
                        const arrowSize = Math.max(10, strokeWidth * 4);
                        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                        const arrowAngle1 = angle + Math.PI * 0.85;
                        const arrowAngle2 = angle - Math.PI * 0.85;
                        
                        const ax1 = p2.x + Math.cos(arrowAngle1) * arrowSize;
                        const ay1 = p2.y + Math.sin(arrowAngle1) * arrowSize;
                        const ax2 = p2.x + Math.cos(arrowAngle2) * arrowSize;
                        const ay2 = p2.y + Math.sin(arrowAngle2) * arrowSize;
                        
                        svg += `<polygon points="${p2.x + offsetX},${p2.y + offsetY} ${ax1 + offsetX},${ay1 + offsetY} ${ax2 + offsetX},${ay2 + offsetY}" fill="${stroke}" opacity="${opacity}"/>`;
                    }
                }
                break;
                
            case 'freedraw':
                if (el.points && el.points.length >= 2) {
                    // Use quadratic curves for smoother lines
                    let path = `M ${el.points[0].x + offsetX} ${el.points[0].y + offsetY}`;
                    for (let i = 1; i < el.points.length - 1; i++) {
                        const xc = (el.points[i].x + el.points[i + 1].x) / 2;
                        const yc = (el.points[i].y + el.points[i + 1].y) / 2;
                        path += ` Q ${el.points[i].x + offsetX} ${el.points[i].y + offsetY}, ${xc + offsetX} ${yc + offsetY}`;
                    }
                    if (el.points.length > 1) {
                        const last = el.points[el.points.length - 1];
                        path += ` L ${last.x + offsetX} ${last.y + offsetY}`;
                    }
                    
                    let strokeDash = '';
                    if (el.strokeStyle === 'dashed') {
                        strokeDash = ' stroke-dasharray="8,8"';
                    } else if (el.strokeStyle === 'dotted') {
                        strokeDash = ' stroke-dasharray="2,4"';
                    }
                    
                    svg = `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${strokeDash}/>`;
                }
                break;
                
            case 'frame':
                // Frame background
                if (el.backgroundColor && el.backgroundColor !== 'transparent') {
                    svg += `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" fill="${el.backgroundColor}" opacity="${opacity * 0.3}"/>`;
                }
                // Frame border (dashed)
                svg += `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" fill="none" stroke="${el.strokeColor || '#999999'}" stroke-width="${strokeWidth * 2}" stroke-dasharray="5,5" opacity="${opacity}"/>`;
                // Title bar
                const titleHeight = 30;
                svg += `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${titleHeight}" fill="${el.strokeColor || '#999999'}" opacity="${opacity}"/>`;
                if (el.name) {
                    svg += `<text x="${x - hw + 10}" y="${y - hh + titleHeight/2}" dominant-baseline="middle" fill="#ffffff" font-size="14" font-family="system-ui, sans-serif" font-weight="bold">${this.escapeXml(el.name)}</text>`;
                }
                break;
                
            case 'image':
                if (el.imageElement && el.imageElement.src) {
                    svg += `<image x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" href="${el.imageElement.src}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
                } else if (el.imageUrl) {
                    svg += `<image x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" href="${el.imageUrl}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
                }
                break;
        }
        
        return svg;
    }
    
    escapeXml(text) {
        if (!text) return '';
        return text.replace(/[<>&'"]/g, c => ({
            '<': '&lt;',
            '>': '&gt;',
            '&': '&amp;',
            "'": '&apos;',
            '"': '&quot;'
        })[c]);
    }
    
    shapeTextToSVG(el, x, y, hw, hh, opacity) {
        if (!el.text) return '';
        
        const lines = el.text.split('\n');
        const fontSize = el.fontSize || 20;
        const lineHeight = fontSize * 1.4;
        const maxWidth = (el.width || 200) - 20; // padding
        const fontFamily = this.escapeXml(el.fontFamily || 'sans-serif');
        const fill = el.strokeColor || '#000000';
        
        let svg = `<g opacity="${opacity}">`;
        
        // Simple word wrapping
        const wrappedLines = [];
        for (const line of lines) {
            const words = line.split(' ');
            let currentLine = words[0] || '';
            
            for (let i = 1; i < words.length; i++) {
                const testLine = currentLine + ' ' + words[i];
                // Estimate width (rough approximation)
                if (testLine.length * fontSize * 0.6 < maxWidth) {
                    currentLine = testLine;
                } else {
                    wrappedLines.push(currentLine);
                    currentLine = words[i];
                }
            }
            wrappedLines.push(currentLine);
        }
        
        const totalHeight = wrappedLines.length * lineHeight;
        const startY = y - totalHeight / 2 + lineHeight / 2;
        
        wrappedLines.forEach((line, i) => {
            if (i < 5) { // Limit to 5 lines
                const lineY = startY + i * lineHeight;
                svg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${fill}" font-size="${fontSize}" font-family="${fontFamily}">${this.escapeXml(line)}</text>`;
            }
        });
        
        svg += '</g>';
        return svg;
    }
    
    downloadFile(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    importJSON() {
        // Use new import system if available
        if (window.importExportManager) {
            window.importExportManager.showImportDialog();
            return;
        }
        
        // Legacy import
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.importJSONFile(file);
        };
        input.click();
    }
    
    importJSONFile(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const elements = JSON.parse(event.target.result);
                this.importElements(elements);
            } catch (error) {
                console.error('Import error:', error);
                alert('Invalid JSON file');
            }
        };
        reader.readAsText(file);
    }
    
    importElements(elements) {
        if (!Array.isArray(elements)) {
            // Try to handle Lilly sketch format
            if (elements.elements && Array.isArray(elements.elements)) {
                elements = elements.elements;
            } else {
                alert('Invalid format: expected array of elements');
                return;
            }
        }
        
        const canvas = window.infiniteCanvas;
        
        // Generate new IDs for imported elements
        const newElements = elements.map(el => ({
            ...el,
            id: window.toolManager.generateId(),
            imageElement: undefined // Can't serialize image elements
        }));
        
        // Add to canvas
        for (const el of newElements) {
            canvas.addElement(el);
        }
        
        // Select imported elements
        canvas.deselectAll();
        for (const el of newElements) {
            canvas.selectElement(el, true);
        }
        
        window.historyManager?.pushState(canvas.elements);
    }
    
    async shareCanvas() {
        const canvas = window.infiniteCanvas;
        
        try {
            // Try Web Share API first (for mobile)
            if (navigator.share && navigator.canShare) {
                // Export as PNG blob
                const dataURL = canvas.exportToDataURL('image/png');
                const response = await fetch(dataURL);
                const blob = await response.blob();
                const file = new File([blob], 'canvas.png', { type: 'image/png' });
                
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'My Lilly Canvas',
                        text: 'Check out my canvas!',
                        files: [file]
                    });
                    this.showToast('Shared successfully!');
                    return;
                }
            }
            
            // Fallback to clipboard
            if (navigator.clipboard) {
                // Copy canvas data as JSON
                const json = JSON.stringify(canvas.elements, null, 2);
                await navigator.clipboard.writeText(json);
                this.showToast('Canvas data copied to clipboard!');
            } else {
                throw new Error('Clipboard API not available');
            }
        } catch (error) {
            console.error('Share error:', error);
            
            // Final fallback - download JSON
            if (error.name !== 'AbortError') {
                const json = JSON.stringify(canvas.elements, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                this.downloadFile(URL.createObjectURL(blob), 'canvas-share.json');
                this.showToast('Canvas exported as JSON file');
            }
        }
    }
    
    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.2s ease';
            setTimeout(() => toast.remove(), 200);
        }, duration);
    }
    
    setupTooltips() {
        // Add hover tooltips for elements with title attribute
        const tooltip = document.getElementById('tooltip');
        if (!tooltip) return;
        
        document.querySelectorAll('[title]').forEach(el => {
            const title = el.getAttribute('title');
            el.removeAttribute('title');
            el.dataset.tooltip = title;
            
            el.addEventListener('mouseenter', (e) => {
                tooltip.textContent = title;
                tooltip.classList.add('visible');
                this.positionTooltip(e, tooltip);
            });
            
            el.addEventListener('mousemove', (e) => {
                this.positionTooltip(e, tooltip);
            });
            
            el.addEventListener('mouseleave', () => {
                tooltip.classList.remove('visible');
            });
        });
    }
    
    positionTooltip(e, tooltip) {
        const x = e.clientX;
        const y = e.clientY;
        const rect = tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Position above by default
        let top = y - rect.height - 10;
        let left = x - rect.width / 2;
        
        // Adjust if off-screen
        if (left < 10) left = 10;
        if (left + rect.width > viewportWidth - 10) left = viewportWidth - rect.width - 10;
        if (top < 10) top = y + 20;
        
        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
    }
    
    handleAIGeneratedDiagram(payload) {
        window.aiAssistant?.processGeneratedContent({ content: payload });
    }
}

// Create global app instance
window.app = new App();
