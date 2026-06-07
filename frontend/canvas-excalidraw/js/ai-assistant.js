/**
 * AI Assistant Module - object-first canvas agent panel.
 */

const CANVAS_AGENT_TOOL_LANES = Object.freeze({
    inspect: {
        label: 'Inspect',
        toolIds: [],
        actionPolicy: 'read_board_context',
    },
    create: {
        label: 'Create',
        toolIds: ['graph-diagram'],
        actionPolicy: 'create_editable_canvas_objects',
    },
    arrange: {
        label: 'Arrange',
        toolIds: ['graph-diagram'],
        actionPolicy: 'move_and_align_existing_objects',
    },
    label: {
        label: 'Label',
        toolIds: ['graph-diagram'],
        actionPolicy: 'add_text_sticky_and_connection_labels',
    },
    research: {
        label: 'Research',
        toolIds: ['web-search', 'web-fetch'],
        actionPolicy: 'ground_board_content_before_editing',
    },
    qa: {
        label: 'QA',
        toolIds: ['design-resource-search'],
        actionPolicy: 'review_layout_readability_and_missing_links',
    },
});

const CANVAS_AGENT_DEFAULT_TOOL_LANES = ['inspect', 'create', 'arrange', 'label'];
const CANVAS_AGENT_TOOL_LANE_STORAGE_KEY = 'kimi-canvas-agent-tool-lanes';
const CANVAS_AGENT_STEP_ORDER = ['read', 'tool', 'apply'];

class AIAssistant {
    constructor() {
        this.panel = document.getElementById('aiPanel');
        this.input = document.getElementById('aiInput');
        this.generateBtn = document.getElementById('aiGenerateBtn');
        this.status = document.getElementById('aiStatus');
        this.conversation = document.getElementById('aiConversation');
        this.conversationEmpty = document.getElementById('aiConversationEmpty');
        this.scopeSelect = document.getElementById('aiScopeSelect');
        this.groundingTitle = document.getElementById('aiGroundingTitle');
        this.groundingState = document.getElementById('aiGroundingState');
        this.boardSummary = document.getElementById('aiBoardSummary');
        this.selectionSummary = document.getElementById('aiSelectionSummary');
        this.applySummary = document.getElementById('aiApplySummary');
        this.stateSummary = document.getElementById('aiStateSummary');
        this.toolPlanSummary = document.getElementById('aiToolPlanSummary');
        this.toolPlanPill = document.getElementById('aiToolPlanPill');
        this.planSteps = document.getElementById('aiPlanSteps');
        this.isGenerating = false;
        this.scope = 'auto';
        this.toolLaneIds = this.loadToolLaneSelection();
        
        // Mode: 'chat' | 'diagram' | 'image'
        this.mode = 'chat';
        
        // Available models
        this.models = [];
        this.imageModels = [];
        
        // Image generation settings
        this.imageSettings = {
            model: 'gpt-image-2',
            size: 'auto',
            quality: null,
            style: null
        };
        
        // Image click position for placing generated images
        this.pendingImagePosition = null;

        this.chatHistory = [];
        this.lastAppliedActionCount = 0;
        this.lastAgentRunAt = 0;
        
        this.init();
    }
    
    init() {
        // Toggle panel
        document.getElementById('aiAssistantBtn')?.addEventListener('click', () => {
            this.togglePanel();
        });
        
        // Close panel
        document.getElementById('closeAiPanel')?.addEventListener('click', () => {
            this.hidePanel();
        });
        
        // Generate button
        this.generateBtn?.addEventListener('click', () => {
            this.generate();
        });
        
        // Enter key in textarea (Ctrl+Enter to submit)
        this.input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                this.generate();
            }
        });
        
        // Suggestion buttons
        document.querySelectorAll('.suggestion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.input.value = btn.dataset.prompt;
                this.generate();
            });
        });

        this.scopeSelect?.addEventListener('change', (event) => {
            this.scope = event.target.value || 'auto';
            this.updateGroundingPanel();
        });

        this.setupToolLaneControls();

        document.querySelectorAll('[data-ai-context-prompt], [data-ai-local-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.dataset.aiLocalAction) {
                    this.handleLocalAction(btn.dataset.aiLocalAction);
                    return;
                }
                this.setMode('chat');
                this.showPanel();
                if (this.input) {
                    this.input.value = btn.dataset.aiContextPrompt || '';
                    this.input.focus();
                }
            });
        });
        
        // Fetch models on init
        this.fetchModels();
        this.setMode('chat');
        this.restoreSharedConversation();
        this.updateGroundingPanel();
        this.renderToolPlan();
        this.setAgentPlanStep();
    }

    loadToolLaneSelection() {
        try {
            const saved = JSON.parse(localStorage.getItem(CANVAS_AGENT_TOOL_LANE_STORAGE_KEY) || 'null');
            if (Array.isArray(saved)) {
                const valid = saved
                    .map((lane) => String(lane || '').trim())
                    .filter((lane) => CANVAS_AGENT_TOOL_LANES[lane]);
                if (valid.length > 0) {
                    return Array.from(new Set(valid));
                }
            }
        } catch {}

        return [...CANVAS_AGENT_DEFAULT_TOOL_LANES];
    }

    setupToolLaneControls() {
        document.querySelectorAll('[data-ai-tool-lane]').forEach((input) => {
            const lane = String(input.dataset.aiToolLane || '').trim();
            input.checked = this.toolLaneIds.includes(lane);
            input.addEventListener('change', () => {
                this.toolLaneIds = this.getSelectedToolLaneIds();
                this.persistToolLaneSelection();
                this.renderToolPlan();
                this.updateGroundingPanel();
            });
        });
    }

    getSelectedToolLaneIds() {
        const selected = Array.from(document.querySelectorAll('[data-ai-tool-lane]'))
            .filter((input) => input.checked)
            .map((input) => String(input.dataset.aiToolLane || '').trim())
            .filter((lane) => CANVAS_AGENT_TOOL_LANES[lane]);

        return selected.length > 0 ? Array.from(new Set(selected)) : [...CANVAS_AGENT_DEFAULT_TOOL_LANES];
    }

    persistToolLaneSelection() {
        try {
            localStorage.setItem(CANVAS_AGENT_TOOL_LANE_STORAGE_KEY, JSON.stringify(this.toolLaneIds));
        } catch {}
    }

    buildToolPlan(mode = this.mode) {
        const lanes = this.getSelectedToolLaneIds();
        const plannedTools = [];
        lanes.forEach((laneId) => {
            CANVAS_AGENT_TOOL_LANES[laneId]?.toolIds?.forEach((toolId) => {
                if (toolId && !plannedTools.includes(toolId)) {
                    plannedTools.push(toolId);
                }
            });
        });

        if (mode === 'image') {
            if (!plannedTools.includes('image-generate')) {
                plannedTools.unshift('image-generate');
            }
        } else {
            const imageToolIndex = plannedTools.indexOf('image-generate');
            if (imageToolIndex !== -1) {
                plannedTools.splice(imageToolIndex, 1);
            }
        }

        const laneLabels = lanes.map((laneId) => CANVAS_AGENT_TOOL_LANES[laneId]?.label || laneId);
        const lanePolicies = lanes
            .map((laneId) => CANVAS_AGENT_TOOL_LANES[laneId]?.actionPolicy)
            .filter(Boolean);

        return {
            mode,
            lanes,
            laneLabels,
            lanePolicies,
            plannedTools,
            preferredTool: plannedTools[0] || null,
            executionProfile: 'default',
            creationMode: mode === 'image' ? 'explicit-image-asset' : 'editable-object-actions',
            preferEditableObjects: mode !== 'image',
            avoidRasterSnapshots: mode !== 'image',
            stateBackend: {
                current: 'browser-local-draft',
                target: 'valkey-live-bus',
                savedAt: new Date().toISOString(),
            },
            allowedActions: mode === 'image'
                ? ['add image asset after explicit image generation']
                : ['add', 'add_many', 'update', 'update_many', 'delete', 'select'],
        };
    }

    renderToolPlan() {
        const plan = this.buildToolPlan();
        if (this.toolPlanSummary) {
            this.toolPlanSummary.textContent = plan.laneLabels.join(', ') || 'Editable object actions';
        }
        if (this.toolPlanPill) {
            this.toolPlanPill.textContent = plan.preferEditableObjects ? 'Object-first' : 'Image asset';
        }
        if (this.stateSummary) {
            const elementCount = window.infiniteCanvas?.elements?.length || 0;
            const lastRun = this.lastAgentRunAt ? `run ${new Date(this.lastAgentRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'ready';
            this.stateSummary.textContent = `${elementCount} objects, ${lastRun}`;
        }
    }

    setAgentPlanStep(activeStep = '', doneSteps = [], errorStep = '') {
        if (!this.planSteps) {
            return;
        }

        const done = new Set(doneSteps);
        CANVAS_AGENT_STEP_ORDER.forEach((step) => {
            const node = this.planSteps.querySelector(`[data-agent-step="${step}"]`);
            if (!node) {
                return;
            }
            node.classList.toggle('active', step === activeStep);
            node.classList.toggle('done', done.has(step));
            node.classList.toggle('error', step === errorStep);
        });
    }
    
    async fetchModels() {
        // Fetch chat models using OpenAI SDK
        this.models = await window.apiManager.getModels();
        
        // Fetch image models
        this.imageModels = await window.apiManager.getImageModels();
        
        // Update UI with models
        this.updateModelSelectors();
    }
    
    updateModelSelectors() {
        const selectedModel = window.apiManager.getSelectedModel();
        const resolvedModel = this.models.find((model) => model.id === selectedModel)?.id || this.models[0]?.id || selectedModel;

        if (resolvedModel !== selectedModel) {
            window.apiManager.setSelectedModel(resolvedModel);
        }

        // Update diagram model selector
        const diagramModelSelect = document.getElementById('diagramModelSelect');
        if (diagramModelSelect) {
            diagramModelSelect.innerHTML = this.models.map(m => 
                `<option value="${m.id}" ${m.id === resolvedModel ? 'selected' : ''}>${m.name}</option>`
            ).join('');
        }

        const topModelSelect = document.getElementById('topModelSelect');
        if (topModelSelect) {
            topModelSelect.innerHTML = this.models.map(m =>
                `<option value="${m.id}" ${m.id === resolvedModel ? 'selected' : ''}>${m.name}</option>`
            ).join('');
        }
        
        // Update image model selector
        const imageModelSelect = document.getElementById('imageModelSelect');
        if (imageModelSelect) {
            if (!this.imageModels.find((model) => model.id === this.imageSettings.model)) {
                this.imageSettings.model = this.imageModels[0]?.id || '';
            }

            imageModelSelect.innerHTML = this.imageModels.map(m => 
                `<option value="${m.id}" ${m.id === this.imageSettings.model ? 'selected' : ''}>${m.name}</option>`
            ).join('');
            imageModelSelect.value = this.imageSettings.model;
            this.updateImageSizeOptions(this.imageSettings.model);
        }
    }
    
    togglePanel() {
        const willOpen = !this.panel?.classList.contains('active');
        if (willOpen) {
            document.getElementById('toolbar')?.classList.remove('active');
            document.getElementById('propertiesPanel')?.classList.remove('active');
        }
        this.panel?.classList.toggle('active');
        if (this.panel?.classList.contains('active')) {
            this.input?.focus();
        }
    }

    showPanel() {
        document.getElementById('toolbar')?.classList.remove('active');
        document.getElementById('propertiesPanel')?.classList.remove('active');
        if (!this.panel?.classList.contains('active')) {
            this.panel?.classList.add('active');
        }
        this.input?.focus();
    }
    
    hidePanel() {
        this.panel?.classList.remove('active');
    }

    getEffectiveScope() {
        const selectedCount = window.infiniteCanvas?.selectedElements?.length || 0;
        if (this.scope === 'auto') {
            return selectedCount > 0 ? 'selection' : 'board';
        }
        return this.scope || 'board';
    }

    summarizeTypeCounts(elements = []) {
        const counts = elements.reduce((acc, element) => {
            const type = element?.type || 'unknown';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
        }, {});

        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');
    }

    cloneElementForAI(element = {}) {
        const clone = {
            id: element.id,
            type: element.type,
            x: Math.round(Number(element.x) || 0),
            y: Math.round(Number(element.y) || 0),
            width: Math.round(Number(element.width) || 0),
            height: Math.round(Number(element.height) || 0),
            text: element.text || '',
            name: element.name || '',
            strokeColor: element.strokeColor,
            backgroundColor: element.backgroundColor,
            strokeWidth: element.strokeWidth,
            strokeStyle: element.strokeStyle,
            opacity: element.opacity,
            fontSize: element.fontSize,
            fontFamily: element.fontFamily,
        };

        if (Array.isArray(element.points)) {
            clone.points = element.points.slice(0, 16).map((point) => ({
                x: Math.round(Number(point.x) || 0),
                y: Math.round(Number(point.y) || 0),
            }));
        }

        return clone;
    }

    getElementBounds(element = {}) {
        if (Array.isArray(element.points) && element.points.length > 0) {
            const xs = element.points.map((point) => Number(point.x) || 0);
            const ys = element.points.map((point) => Number(point.y) || 0);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            return {
                left: minX,
                top: minY,
                right: maxX,
                bottom: maxY,
                width: Math.max(1, maxX - minX),
                height: Math.max(1, maxY - minY),
            };
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

    getViewportBounds() {
        const canvas = window.infiniteCanvas;
        if (!canvas?.canvas) {
            return null;
        }

        const topLeft = canvas.screenToWorld(0, 0);
        const viewport = canvas.getViewportSize?.() || {
            width: canvas.canvas.clientWidth || canvas.canvas.width,
            height: canvas.canvas.clientHeight || canvas.canvas.height,
        };
        const bottomRight = canvas.screenToWorld(viewport.width, viewport.height);
        return {
            x: Math.round(topLeft.x),
            y: Math.round(topLeft.y),
            width: Math.round(bottomRight.x - topLeft.x),
            height: Math.round(bottomRight.y - topLeft.y),
            zoom: Number(canvas.scale || 1).toFixed(2),
        };
    }

    getElementsInViewport() {
        const canvas = window.infiniteCanvas;
        const bounds = this.getViewportBounds();
        if (!canvas || !bounds) {
            return [];
        }

        const right = bounds.x + bounds.width;
        const bottom = bounds.y + bounds.height;
        return canvas.elements.filter((element) => {
            const elementBounds = this.getElementBounds(element);
            return elementBounds.right >= bounds.x
                && elementBounds.left <= right
                && elementBounds.bottom >= bounds.y
                && elementBounds.top <= bottom;
        });
    }

    buildCanvasContext() {
        const canvas = window.infiniteCanvas;
        const elements = canvas?.elements || [];
        const selected = canvas?.selectedElements || [];
        const scope = this.getEffectiveScope();
        const scopedElements = scope === 'selection'
            ? selected
            : (scope === 'viewport' ? this.getElementsInViewport() : elements);

        return {
            surface: 'canvas-excalidraw',
            scope,
            board: {
                elementCount: elements.length,
                typeCounts: this.summarizeTypeCounts(elements),
            },
            selection: {
                count: selected.length,
                ids: selected.map((element) => element.id),
                typeCounts: this.summarizeTypeCounts(selected),
                elements: selected.slice(0, 20).map((element) => this.cloneElementForAI(element)),
            },
            viewport: this.getViewportBounds(),
            elements: scopedElements.slice(-60).map((element) => ({
                ...this.cloneElementForAI(element),
                bounds: this.getElementBounds(element),
            })),
            toolPlan: this.buildToolPlan(),
            allowedActions: ['add', 'add_many', 'update', 'update_many', 'delete', 'select'],
            instruction: 'Ground your answer in selected objects when scope is selection. Preserve element ids for updates. Use editable object actions for canvas edits. Do not create raster snapshots unless the user explicitly switches to image asset mode.',
        };
    }

    updateGroundingPanel() {
        const context = this.buildCanvasContext();
        const selectedCount = context.selection.count;
        const scope = context.scope;
        const scopeLabel = scope === 'selection'
            ? 'Selection'
            : (scope === 'viewport' ? 'Visible area' : 'Whole board');
        const selectedTypes = context.selection.typeCounts || '';

        if (this.scopeSelect && this.scopeSelect.value !== this.scope) {
            this.scopeSelect.value = this.scope;
        }
        if (this.groundingTitle) {
            this.groundingTitle.textContent = scopeLabel;
        }
        if (this.groundingState) {
            this.groundingState.textContent = `${selectedCount} selected`;
        }
        if (this.boardSummary) {
            this.boardSummary.textContent = `${context.board.elementCount} object${context.board.elementCount === 1 ? '' : 's'}`;
            this.boardSummary.title = context.board.typeCounts || 'No objects yet';
        }
        if (this.selectionSummary) {
            this.selectionSummary.textContent = selectedCount > 0 ? selectedTypes || `${selectedCount} objects` : 'None';
            this.selectionSummary.title = selectedCount > 0 ? context.selection.ids.join(', ') : 'No selected objects';
        }
        if (this.applySummary) {
            this.applySummary.textContent = scope === 'selection' ? 'Backend + selected objects' : (scope === 'viewport' ? 'Backend + visible objects' : 'Backend + board');
        }
        this.renderToolPlan();
    }

    handleLocalAction(action) {
        if (action === 'tidy-selection') {
            this.tidySelection();
        } else if (action === 'frame-selection') {
            this.frameSelection();
        }
    }

    tidySelection() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (!canvas || selected.length < 2) {
            this.showStatus('Select two or more objects to tidy the layout.', 'error');
            return;
        }

        const bounds = selected.map((element) => this.getElementBounds(element));
        const minLeft = Math.min(...bounds.map((entry) => entry.left));
        const maxRight = Math.max(...bounds.map((entry) => entry.right));
        const minTop = Math.min(...bounds.map((entry) => entry.top));
        const maxBottom = Math.max(...bounds.map((entry) => entry.bottom));
        const spreadX = maxRight - minLeft;
        const spreadY = maxBottom - minTop;
        const horizontal = spreadX >= spreadY;
        const sorted = [...selected].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
        const averageCrossAxis = horizontal
            ? sorted.reduce((sum, element) => sum + (Number(element.y) || 0), 0) / sorted.length
            : sorted.reduce((sum, element) => sum + (Number(element.x) || 0), 0) / sorted.length;
        const gap = 48;
        let cursor = horizontal ? minLeft : minTop;

        sorted.forEach((element) => {
            const elementBounds = this.getElementBounds(element);
            const nextPosition = {};
            if (horizontal) {
                nextPosition.x = cursor + elementBounds.width / 2;
                nextPosition.y = averageCrossAxis;
                cursor += elementBounds.width + gap;
            } else {
                nextPosition.x = averageCrossAxis;
                nextPosition.y = cursor + elementBounds.height / 2;
                cursor += elementBounds.height + gap;
            }

            const deltaX = nextPosition.x - (Number(element.x) || 0);
            const deltaY = nextPosition.y - (Number(element.y) || 0);
            element.x = nextPosition.x;
            element.y = nextPosition.y;
            if (Array.isArray(element.points)) {
                element.points = element.points.map((point) => ({
                    x: (Number(point.x) || 0) + deltaX,
                    y: (Number(point.y) || 0) + deltaY,
                }));
            }
        });

        window.historyManager?.pushState(canvas.elements);
        canvas.render();
        this.updateGroundingPanel();
        window.app?.showToast?.('Tidied selected objects');
        this.showStatus('Tidied selected objects locally. Ask the agent for labels or deeper restructuring.', 'success');
    }

    frameSelection() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (!canvas || selected.length === 0) {
            this.showStatus('Select one or more objects to frame.', 'error');
            return;
        }

        const bounds = selected.map((element) => this.getElementBounds(element));
        const minLeft = Math.min(...bounds.map((entry) => entry.left));
        const maxRight = Math.max(...bounds.map((entry) => entry.right));
        const minTop = Math.min(...bounds.map((entry) => entry.top));
        const maxBottom = Math.max(...bounds.map((entry) => entry.bottom));
        const padding = 42;
        const frame = {
            id: window.toolManager?.generateId?.() || `frame-${Date.now()}`,
            type: 'frame',
            x: (minLeft + maxRight) / 2,
            y: (minTop + maxBottom) / 2,
            width: Math.max(160, maxRight - minLeft + padding * 2),
            height: Math.max(120, maxBottom - minTop + padding * 2),
            text: 'Frame',
            strokeColor: window.toolManager?.defaultProperties?.strokeColor || '#1971c2',
            backgroundColor: 'transparent',
            strokeWidth: 2,
            strokeStyle: 'dashed',
            roughness: 1,
            opacity: 1,
        };

        canvas.addElement(frame);
        canvas.selectElements([frame, ...selected]);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.updateGroundingPanel();
        this.showStatus('Framed selected objects locally.', 'success');
    }
    
    setMode(mode) {
        this.mode = mode;
        
        // Update UI
        const diagramModeBtn = document.getElementById('diagramModeBtn');
        const chatModeBtn = document.getElementById('chatModeBtn');
        const imageModeBtn = document.getElementById('imageModeBtn');
        const diagramOptions = document.getElementById('diagramOptions');
        const imageOptions = document.getElementById('imageOptions');
        const aiDescription = document.querySelector('.ai-description');
        
        if (mode === 'chat') {
            chatModeBtn?.classList.add('active');
            diagramModeBtn?.classList.remove('active');
            imageModeBtn?.classList.remove('active');
            diagramOptions?.classList.remove('hidden');
            imageOptions?.classList.add('hidden');
            if (aiDescription) {
                aiDescription.textContent = 'Talk through the board and ask for editable object actions when you want changes.';
            }
            if (this.input) {
                this.input.placeholder = "e.g., 'What is missing from this flow?' or 'Arrange these boxes into a cleaner sequence'";
            }
            if (this.generateBtn) {
                this.generateBtn.lastChild.textContent = 'Send';
            }
        } else if (mode === 'diagram') {
            chatModeBtn?.classList.remove('active');
            diagramModeBtn?.classList.add('active');
            imageModeBtn?.classList.remove('active');
            diagramOptions?.classList.remove('hidden');
            imageOptions?.classList.add('hidden');
            if (aiDescription) {
                aiDescription.textContent = "Describe the board objects to create or change; the agent will return editable actions.";
            }
            if (this.input) {
                this.input.placeholder = "e.g., 'Create a login flow with decisions, arrows, labels, and a risk note'";
            }
            if (this.generateBtn) {
                this.generateBtn.lastChild.textContent = 'Build';
            }
        } else {
            chatModeBtn?.classList.remove('active');
            diagramModeBtn?.classList.remove('active');
            imageModeBtn?.classList.add('active');
            diagramOptions?.classList.add('hidden');
            imageOptions?.classList.remove('hidden');
            if (aiDescription) {
                aiDescription.textContent = "Generate a raster asset only when the board needs a non-editable image.";
            }
            if (this.input) {
                this.input.placeholder = "e.g., 'A flat product icon with transparent background'";
            }
            if (this.generateBtn) {
                this.generateBtn.lastChild.textContent = 'Generate';
            }
        }
        this.renderToolPlan();
    }
    
    async generate() {
        const prompt = this.input?.value.trim();
        if (!prompt || this.isGenerating) return;
        
        if (this.mode === 'chat') {
            await this.sendAgentMessage(prompt);
        } else if (this.mode === 'diagram') {
            await this.generateDiagram(prompt);
        } else {
            await this.generateImage(prompt);
        }
    }

    async sendAgentMessage(prompt) {
        this.isGenerating = true;
        this.showStatus('Thinking...', 'loading');
        this.generateBtn.disabled = true;
        window.app?.showLoading('AI is thinking...');
        this.lastAgentRunAt = Date.now();
        this.setAgentPlanStep('read');
        this.renderToolPlan();

        this.chatHistory.push({ role: 'user', content: prompt });
        this.trimChatHistory();
        this.addConversationMessage('user', prompt);

        try {
            const canvasContext = this.buildCanvasContext();
            const toolPlan = canvasContext.toolPlan || this.buildToolPlan('chat');
            this.setAgentPlanStep('tool', ['read']);
            let response;
            try {
                response = await window.apiManager.requestCanvasAgent({
                    message: prompt,
                    canvasContext,
                    mode: 'chat',
                    toolPlan,
                });
            } catch (primaryError) {
                console.warn('Canvas agent route failed, falling back to OpenAI-compatible chat:', primaryError);
                const messages = this.buildChatMessages(canvasContext);
                response = await window.apiManager.chat(messages, canvasContext, toolPlan);
            }
            const content = response.content || 'No response received.';
            const structured = this.parseStructuredCanvasResponse(content);
            const applied = this.applyCanvasActions(structured);
            this.lastAppliedActionCount = applied;
            this.setAgentPlanStep('', ['read', 'tool', 'apply']);
            const assistantText = structured?.message || content;
            this.chatHistory.push({ role: 'assistant', content: assistantText });
            this.trimChatHistory();
            this.addConversationMessage('assistant', assistantText);
            this.showStatus(applied > 0 ? `Applied ${applied} canvas action${applied === 1 ? '' : 's'}.` : 'Agent response ready.', 'success');
            this.input.value = '';
        } catch (error) {
            console.error('Agent chat error:', error);
            this.setAgentPlanStep('', ['read'], 'tool');
            this.addConversationMessage('assistant', `Error: ${error.message}`);
            this.showStatus('Error talking to agent.', 'error');
        } finally {
            this.isGenerating = false;
            this.generateBtn.disabled = false;
            window.app?.hideLoading();
            this.renderToolPlan();
        }
    }
    
    async generateDiagram(prompt) {
        this.isGenerating = true;
        this.showStatus('Building objects...', 'loading');
        this.generateBtn.disabled = true;
        window.app?.showLoading('Building editable objects...');
        this.lastAgentRunAt = Date.now();
        this.setAgentPlanStep('read');
        this.renderToolPlan();
        
        try {
            // Get current canvas state for context
            const canvasContext = this.buildCanvasContext();
            const toolPlan = canvasContext.toolPlan || this.buildToolPlan('diagram');
            const existingContent = JSON.stringify(canvasContext.elements);
            this.addConversationMessage('user', prompt);
            this.setAgentPlanStep('tool', ['read']);
            
            let response;
            try {
                response = await window.apiManager.requestCanvasAgent({
                    message: prompt,
                    canvasContext,
                    mode: 'diagram',
                    existingContent,
                    toolPlan,
                });
            } catch (primaryError) {
                console.warn('Canvas agent route failed, falling back to OpenAI-compatible diagram generation:', primaryError);
                response = await window.apiManager.generateDiagram(prompt, existingContent, canvasContext, toolPlan);
            }
            
            if (response.content) {
                const applied = this.processGeneratedContent(response);
                this.lastAppliedActionCount = applied || 0;
                this.setAgentPlanStep('', ['read', 'tool', 'apply']);
                this.addConversationMessage('assistant', 'Applied editable object actions to the canvas.');
                this.showStatus('Canvas objects updated.', 'success');
                this.input.value = '';
            } else {
                this.setAgentPlanStep('', ['read', 'tool'], 'apply');
                this.showStatus('No object actions returned. Try a different prompt.', 'error');
            }
        } catch (error) {
            console.error('Generation error:', error);
            this.setAgentPlanStep('', ['read'], 'tool');
            this.showStatus('Error building objects. Please try again.', 'error');
        } finally {
            this.isGenerating = false;
            this.generateBtn.disabled = false;
            window.app?.hideLoading();
            this.renderToolPlan();
        }
    }
    
    async generateImage(prompt) {
        this.isGenerating = true;
        this.showStatus('Generating image...', 'loading');
        this.generateBtn.disabled = true;
        window.app?.showLoading('Generating image...');
        
        try {
            this.addConversationMessage('user', prompt);
            // Use OpenAI SDK via apiManager
            const response = await window.apiManager.generateImage({
                prompt: prompt,
                model: this.imageSettings.model,
                size: this.imageSettings.size,
                quality: this.imageSettings.quality,
                style: this.imageSettings.style
            });
            
            const generatedImages = Array.isArray(response.data)
                ? response.data.filter((image) => image?.url || image?.b64_json)
                : [];

            if (generatedImages.length > 0) {
                const canvas = window.infiniteCanvas;
                const viewportCenter = canvas.getViewportCenter?.() || {
                    x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
                    y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
                };
                const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
                const basePosition = this.pendingImagePosition
                    ? { ...this.pendingImagePosition }
                    : center;
                this.pendingImagePosition = null;

                const requestedSizeMatch = String(this.imageSettings.size || '').match(/^(\d+)x(\d+)$/);
                const aspectRatio = requestedSizeMatch
                    ? ((parseInt(requestedSizeMatch[1], 10) / parseInt(requestedSizeMatch[2], 10)) || 1)
                    : 1;
                const previewWidth = 400;
                const previewHeight = previewWidth / aspectRatio;
                const columns = Math.min(generatedImages.length, 2);
                const gap = 40;

                for (let index = 0; index < generatedImages.length; index += 1) {
                    const row = Math.floor(index / columns);
                    const col = index % columns;
                    await this.addImageToCanvas(generatedImages[index], {
                        x: basePosition.x + (col * (previewWidth + gap)),
                        y: basePosition.y + (row * (previewHeight + gap)),
                    });
                }

                const noun = generatedImages.length === 1 ? 'image' : 'images';
                this.addConversationMessage('assistant', `Generated ${generatedImages.length} ${noun} and placed them on the canvas.`);
                this.showStatus(`Generated ${generatedImages.length} ${noun} successfully!`, 'success');
                this.input.value = '';
                
                // Show revised prompt if available
                if (generatedImages[0].revised_prompt) {
                    console.log('Revised prompt:', generatedImages[0].revised_prompt);
                }
            } else {
                this.showStatus('No image generated. Try a different prompt.', 'error');
            }
        } catch (error) {
            console.error('Image generation error:', error);
            this.showStatus(`Error: ${error.message}`, 'error');
        } finally {
            this.isGenerating = false;
            this.generateBtn.disabled = false;
            window.app?.hideLoading();
        }
    }
    
    async addImageToCanvas(imageData, position = null) {
        const canvas = window.infiniteCanvas;
        
        // Create image element
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        return new Promise((resolve, reject) => {
            img.onload = () => {
                // Calculate position
                let x, y;
                
                if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
                    x = position.x;
                    y = position.y;
                } else if (this.pendingImagePosition) {
                    // Use the position where user clicked with AI Image tool
                    x = this.pendingImagePosition.x;
                    y = this.pendingImagePosition.y;
                    this.pendingImagePosition = null;
                } else {
                    // Use center of current view
                    const viewportCenter = canvas.getViewportCenter?.() || {
                        x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
                        y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
                    };
                    const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
                    x = center.x;
                    y = center.y;
                }
                
                // Parse size for aspect ratio
                const requestedSizeMatch = String(this.imageSettings.size || '').match(/^(\d+)x(\d+)$/);
                const aspectRatio = requestedSizeMatch
                    ? ((parseInt(requestedSizeMatch[1], 10) / parseInt(requestedSizeMatch[2], 10)) || 1)
                    : (((img.naturalWidth || img.width || 400) / (img.naturalHeight || img.height || 400)) || 1);
                
                // Default size
                let width = 400;
                let height = width / aspectRatio;
                
                // Create element
                const element = {
                    id: window.toolManager.generateId(),
                    type: 'image',
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    imageElement: img,
                    // Store metadata
                    aiGenerated: true,
                    originalPrompt: this.input?.value.trim(),
                    revisedPrompt: imageData.revised_prompt,
                    imageModel: this.imageSettings.model,
                    imageUrl: imageData.url,
                    ...window.toolManager.defaultProperties
                };
                
                canvas.addElement(element);
                canvas.selectElement(element);
                window.historyManager?.pushState(canvas.elements);
                
                resolve(element);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load generated image'));
            };
            
            img.src = imageData.url || (imageData.b64_json ? `data:image/png;base64,${imageData.b64_json}` : '');
        });
    }
    
    setImagePosition(pos) {
        this.pendingImagePosition = pos;
    }
    
    updateImageSettings(setting, value) {
        this.imageSettings[setting] = value;
        
        // Update available sizes based on model
        if (setting === 'model') {
            this.updateImageSizeOptions(value);
        }
    }

    getImageModelMetadata(model) {
        return this.imageModels.find((entry) => entry.id === model) || {};
    }

    formatImageOptionLabel(value, type = 'generic') {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return 'Backend default';
        }

        if (normalized === 'auto') {
            return 'Auto';
        }

        if (type === 'size') {
            const match = normalized.match(/^(\d+)x(\d+)$/);
            if (match) {
                const width = Number(match[1]);
                const height = Number(match[2]);
                const aspectLabel = width === height
                    ? 'Square'
                    : (width > height ? 'Landscape' : 'Portrait');
                return `${normalized} (${aspectLabel})`;
            }
        }

        if (normalized === 'hd') {
            return 'HD';
        }

        return normalized
            .split('-')
            .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
            .join(' ');
    }
    
    updateImageSizeOptions(model) {
        const sizeSelect = document.getElementById('imageSizeSelect');
        const qualitySelect = document.getElementById('imageQualitySelect');
        const styleSelect = document.getElementById('imageStyleSelect');
        const qualityGroup = document.getElementById('imageQualityGroup');
        const styleGroup = document.getElementById('imageStyleGroup');
        if (!sizeSelect) return;

        const selectedModel = this.getImageModelMetadata(model);
        const sizes = Array.isArray(selectedModel.sizes) && selectedModel.sizes.length > 0
            ? selectedModel.sizes
            : ['1024x1024'];
        const qualities = Array.isArray(selectedModel.qualities) ? selectedModel.qualities : [];
        const styles = Array.isArray(selectedModel.styles) ? selectedModel.styles : [];

        if (!sizes.includes(this.imageSettings.size)) {
            this.imageSettings.size = sizes[0];
        }

        sizeSelect.innerHTML = sizes.map((value) =>
            `<option value="${value}" ${value === this.imageSettings.size ? 'selected' : ''}>${this.formatImageOptionLabel(value, 'size')}</option>`
        ).join('');

        if (qualitySelect) {
            if (qualities.length > 0) {
                const nextQuality = qualities.includes(this.imageSettings.quality)
                    ? this.imageSettings.quality
                    : (qualities.includes('auto') ? 'auto' : qualities[0]);
                this.imageSettings.quality = nextQuality;
                qualitySelect.innerHTML = qualities.map((value) =>
                    `<option value="${value}" ${value === nextQuality ? 'selected' : ''}>${this.formatImageOptionLabel(value)}</option>`
                ).join('');
            } else {
                this.imageSettings.quality = null;
                qualitySelect.innerHTML = '<option value="">Default</option>';
            }
        }

        if (styleSelect) {
            if (styles.length > 0) {
                const nextStyle = styles.includes(this.imageSettings.style)
                    ? this.imageSettings.style
                    : styles[0];
                this.imageSettings.style = nextStyle;
                styleSelect.innerHTML = styles.map((value) =>
                    `<option value="${value}" ${value === nextStyle ? 'selected' : ''}>${this.formatImageOptionLabel(value)}</option>`
                ).join('');
            } else {
                this.imageSettings.style = null;
                styleSelect.innerHTML = '<option value="">Default</option>';
            }
        }

        if (qualityGroup) {
            qualityGroup.style.display = qualities.length > 0 ? '' : 'none';
        }
        if (styleGroup) {
            styleGroup.style.display = styles.length > 0 ? '' : 'none';
        }
    }

    extractJsonCandidate(content = '') {
        const text = String(content || '').trim();
        if (!text) {
            return '';
        }

        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            return fenced[1].trim();
        }

        const firstObject = text.indexOf('{');
        const lastObject = text.lastIndexOf('}');
        if (firstObject !== -1 && lastObject > firstObject) {
            return text.slice(firstObject, lastObject + 1);
        }

        const firstArray = text.indexOf('[');
        const lastArray = text.lastIndexOf(']');
        if (firstArray !== -1 && lastArray > firstArray) {
            return text.slice(firstArray, lastArray + 1);
        }

        return text;
    }

    parseStructuredCanvasResponse(content = '') {
        const candidate = this.extractJsonCandidate(content);
        if (!candidate) {
            return { message: String(content || '').trim(), actions: [], elements: [] };
        }

        try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) {
                return { message: '', actions: [], elements: parsed };
            }
            if (parsed && typeof parsed === 'object') {
                if (!Array.isArray(parsed.actions) && !Array.isArray(parsed.elements) && parsed.content) {
                    if (typeof parsed.content === 'string') {
                        return this.parseStructuredCanvasResponse(parsed.content);
                    }
                    if (typeof parsed.content === 'object') {
                        return {
                            message: typeof parsed.content.message === 'string' ? parsed.content.message : '',
                            actions: Array.isArray(parsed.content.actions) ? parsed.content.actions : [],
                            elements: Array.isArray(parsed.content.elements) ? parsed.content.elements : [],
                        };
                    }
                }
                return {
                    message: typeof parsed.message === 'string' ? parsed.message : '',
                    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
                    elements: Array.isArray(parsed.elements) ? parsed.elements : [],
                };
            }
        } catch {}

        return { message: String(content || '').trim(), actions: [], elements: [] };
    }

    normalizeGeneratedElement(element = {}) {
        const allowedTypes = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'sticky', 'frame']);
        const normalized = {
            ...element,
            id: window.toolManager?.generateId?.() || `el-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            type: allowedTypes.has(element.type) ? element.type : 'rectangle',
            x: Number.isFinite(Number(element.x)) ? Number(element.x) : 0,
            y: Number.isFinite(Number(element.y)) ? Number(element.y) : 0,
            width: Number.isFinite(Number(element.width)) && Number(element.width) > 0 ? Number(element.width) : 140,
            height: Number.isFinite(Number(element.height)) && Number(element.height) > 0 ? Number(element.height) : 80,
            strokeColor: element.strokeColor || window.toolManager?.defaultProperties?.strokeColor || '#000000',
            backgroundColor: element.backgroundColor || window.toolManager?.defaultProperties?.backgroundColor || 'transparent',
            strokeWidth: element.strokeWidth || window.toolManager?.defaultProperties?.strokeWidth || 2,
            strokeStyle: element.strokeStyle || window.toolManager?.defaultProperties?.strokeStyle || 'solid',
            roughness: element.roughness ?? window.toolManager?.defaultProperties?.roughness ?? 1,
            opacity: element.opacity ?? window.toolManager?.defaultProperties?.opacity ?? 1,
        };

        if (Array.isArray(element.points)) {
            normalized.points = element.points.map((point) => ({
                x: Number(point.x) || 0,
                y: Number(point.y) || 0,
            }));
        }

        return normalized;
    }

    sanitizeElementPatch(patch = {}) {
        const allowed = new Set([
            'type',
            'x',
            'y',
            'width',
            'height',
            'text',
            'name',
            'strokeColor',
            'backgroundColor',
            'strokeWidth',
            'strokeStyle',
            'roughness',
            'opacity',
            'fontSize',
            'fontFamily',
            'points',
        ]);
        const safePatch = {};

        Object.entries(patch).forEach(([key, value]) => {
            if (!allowed.has(key)) {
                return;
            }

            if (['x', 'y', 'width', 'height', 'strokeWidth', 'roughness', 'opacity', 'fontSize'].includes(key)) {
                const numberValue = Number(value);
                if (!Number.isFinite(numberValue)) {
                    return;
                }
                safePatch[key] = ['width', 'height'].includes(key) ? Math.max(1, numberValue) : numberValue;
                return;
            }

            if (key === 'points') {
                if (!Array.isArray(value)) {
                    return;
                }
                safePatch.points = value.slice(0, 120).map((point) => ({
                    x: Number(point?.x) || 0,
                    y: Number(point?.y) || 0,
                }));
                return;
            }

            safePatch[key] = value;
        });

        return safePatch;
    }

    applyCanvasActions(structured = {}) {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return 0;
        }

        const actions = Array.isArray(structured.actions) ? structured.actions : [];
        const elements = Array.isArray(structured.elements) ? structured.elements : [];
        let applied = 0;
        const nextSelectionIds = new Set();

        actions.forEach((action) => {
            if (!action || typeof action !== 'object') {
                return;
            }

            const type = String(action.type || '').toLowerCase();
            if (type === 'add_many' && Array.isArray(action.elements)) {
                action.elements.forEach((entry) => {
                    if (!entry || typeof entry !== 'object') {
                        return;
                    }
                    const element = this.normalizeGeneratedElement(entry);
                    canvas.addElement(element);
                    nextSelectionIds.add(element.id);
                    applied += 1;
                });
                return;
            }

            if (type === 'add' && action.element) {
                const element = this.normalizeGeneratedElement(action.element);
                canvas.addElement(element);
                nextSelectionIds.add(element.id);
                applied += 1;
                return;
            }

            if (type === 'update_many' && Array.isArray(action.patches)) {
                action.patches.forEach((entry) => {
                    if (!entry?.id || !entry?.patch || typeof entry.patch !== 'object') {
                        return;
                    }
                    const element = canvas.elements.find((candidate) => candidate.id === entry.id);
                    if (!element) {
                        return;
                    }
                    const safePatch = this.sanitizeElementPatch(entry.patch);
                    Object.assign(element, safePatch);
                    nextSelectionIds.add(element.id);
                    applied += 1;
                });
                return;
            }

            if (type === 'update' && action.id && action.patch && typeof action.patch === 'object') {
                const element = canvas.elements.find((entry) => entry.id === action.id);
                if (!element) {
                    return;
                }
                const safePatch = this.sanitizeElementPatch(action.patch);
                Object.assign(element, safePatch);
                nextSelectionIds.add(element.id);
                applied += 1;
                return;
            }

            if (type === 'delete' && action.id) {
                const before = canvas.elements.length;
                canvas.removeElement(action.id);
                if (canvas.elements.length !== before) {
                    applied += 1;
                }
                return;
            }

            if (type === 'select' && Array.isArray(action.ids)) {
                action.ids.forEach((id) => nextSelectionIds.add(id));
                applied += 1;
            }
        });

        elements.forEach((element) => {
            if (!element || typeof element !== 'object' || !element.type) {
                return;
            }
            const normalized = this.normalizeGeneratedElement(element);
            canvas.addElement(normalized);
            nextSelectionIds.add(normalized.id);
            applied += 1;
        });

        if (nextSelectionIds.size > 0) {
            const selected = canvas.elements.filter((element) => nextSelectionIds.has(element.id));
            if (selected.length > 0) {
                canvas.selectElements(selected);
            }
        }

        if (applied > 0) {
            window.historyManager?.pushState(canvas.elements);
            window.app?.saveCanvasToStorage?.();
            canvas.render();
            this.updateGroundingPanel();
        }

        return applied;
    }
    
    processGeneratedContent(response) {
        const canvas = window.infiniteCanvas;
        const structured = this.parseStructuredCanvasResponse(response.content || '');
        const actionCount = this.applyCanvasActions(structured);
        if (actionCount > 0) {
            if (structured.message) {
                this.addConversationMessage('assistant', structured.message);
            }
            return actionCount;
        }
        
        // Parse the response content
        let elements = [];
        let content = structured.elements.length > 0
            ? JSON.stringify(structured.elements)
            : (response.content || '');
        
        // Try to extract JSON from markdown code blocks
        const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            content = jsonBlockMatch[1].trim();
        }
        
        try {
            // Try to parse as JSON
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                elements = parsed;
            } else if (parsed.elements && Array.isArray(parsed.elements)) {
                elements = parsed.elements;
            } else if (parsed.type && parsed.x !== undefined) {
                // Single element object
                elements = [parsed];
            } else {
                // Unknown format, treat as description
                elements = this.parseDiagramDescription(response.content);
            }
        } catch (e) {
            // Not valid JSON, treat as diagram description
            elements = this.parseDiagramDescription(response.content);
        }
        
        // Validate and filter elements. Image assets are handled by explicit image mode.
        const objectTypes = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'sticky', 'frame']);
        elements = elements.filter(el => el && typeof el === 'object' && objectTypes.has(el.type));
        
        // Add elements to canvas
        if (elements.length > 0) {
            // Clear current selection
            canvas.deselectAll();
            
            // Center elements on current view
            const viewportCenter = canvas.getViewportCenter?.() || {
                x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
                y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
            };
            const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
            
            // Calculate bounding box of new elements
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let hasValidCoords = false;
            
            for (const el of elements) {
                if (el.x === undefined || el.y === undefined) continue;
                hasValidCoords = true;
                const hw = (el.width || 100) / 2;
                const hh = (el.height || 100) / 2;
                minX = Math.min(minX, el.x - hw);
                minY = Math.min(minY, el.y - hh);
                maxX = Math.max(maxX, el.x + hw);
                maxY = Math.max(maxY, el.y + hh);
            }
            
            let offsetX = 0, offsetY = 0;
            if (hasValidCoords) {
                const elementsCenterX = (minX + maxX) / 2;
                const elementsCenterY = (minY + maxY) / 2;
                offsetX = center.x - elementsCenterX;
                offsetY = center.y - elementsCenterY;
            } else {
                // Elements without coordinates, arrange them
                offsetX = center.x - 200;
                offsetY = center.y - (elements.length * 60);
            }
            
            // Add elements with offset
            let addedCount = 0;
            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                
                // Skip invalid elements
                if (!el.type) continue;
                
                // Set default coordinates if missing
                if (el.x === undefined) el.x = 200;
                if (el.y === undefined) el.y = 100 + i * 120;
                
                const newElement = {
                    ...el,
                    id: window.toolManager.generateId(),
                    x: el.x + offsetX,
                    y: el.y + offsetY,
                    // Apply default properties if not specified
                    strokeColor: el.strokeColor || window.toolManager.defaultProperties.strokeColor,
                    backgroundColor: el.backgroundColor || window.toolManager.defaultProperties.backgroundColor,
                    strokeWidth: el.strokeWidth || window.toolManager.defaultProperties.strokeWidth,
                    strokeStyle: el.strokeStyle || window.toolManager.defaultProperties.strokeStyle,
                    roughness: el.roughness ?? window.toolManager.defaultProperties.roughness,
                    opacity: el.opacity ?? window.toolManager.defaultProperties.opacity,
                };
                
                // Offset points for lines/arrows
                if (el.points && Array.isArray(el.points)) {
                    newElement.points = el.points.map(p => ({
                        x: (p.x || 0) + offsetX,
                        y: (p.y || 0) + offsetY
                    }));
                }
                
                // Ensure valid dimensions
                if (!newElement.width) newElement.width = 100;
                if (!newElement.height) newElement.height = 100;
                
                canvas.addElement(newElement);
                canvas.selectElement(newElement, true);
                addedCount++;
            }
            
            if (addedCount > 0) {
                window.historyManager?.pushState(canvas.elements);
                window.app?.saveCanvasToStorage?.();
                this.showStatus(`Added ${addedCount} elements to canvas`, 'success');
                return addedCount;
            }
        } else {
            console.warn('No valid elements found in AI response');
        }

        return 0;
    }
    
    parseDiagramDescription(description) {
        // Enhanced parser for diagram descriptions and markdown-like formats
        const elements = [];
        const lines = description.split('\n').filter(l => l.trim());
        
        let y = 100;
        let x = 400;
        const rowHeight = 120;
        const colWidth = 250;
        let currentCol = 0;
        let maxCols = 3;
        
        // Track nodes for connection
        const nodes = [];
        let lastNode = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines and markdown separators
            if (!line || line.match(/^[-=]{3,}$/)) continue;
            
            // Detect flowchart syntax (like "A --> B" or "A -> B")
            const flowMatch = line.match(/(.+?)\s*(?:-->?|→|=>)\s*(.+)/);
            if (flowMatch) {
                const fromText = flowMatch[1].trim();
                const toText = flowMatch[2].trim();
                
                // Find or create source node
                let fromNode = nodes.find(n => n.text === fromText);
                if (!fromNode) {
                    fromNode = this.createNode(fromText, x + currentCol * colWidth, y, elements);
                    nodes.push(fromNode);
                    currentCol = (currentCol + 1) % maxCols;
                    if (currentCol === 0) y += rowHeight;
                }
                
                // Find or create target node
                let toNode = nodes.find(n => n.text === toText);
                if (!toNode) {
                    toNode = this.createNode(toText, x + currentCol * colWidth, y, elements);
                    nodes.push(toNode);
                    currentCol = (currentCol + 1) % maxCols;
                    if (currentCol === 0) y += rowHeight;
                }
                
                // Create arrow between nodes
                elements.push({
                    type: 'arrow',
                    points: [
                        { x: fromNode.x, y: fromNode.y + 40 },
                        { x: toNode.x, y: toNode.y - 40 }
                    ],
                    strokeColor: '#666666',
                    strokeWidth: 2
                });
                
                lastNode = toNode;
                continue;
            }
            
            // Parse markdown headers as sections
            const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
            if (headerMatch) {
                elements.push({
                    type: 'text',
                    x: x,
                    y: y,
                    text: headerMatch[2],
                    width: 300,
                    height: 40,
                    fontSize: headerMatch[1].length === 1 ? 28 : headerMatch[1].length === 2 ? 24 : 20,
                    strokeColor: '#1971c2'
                });
                y += rowHeight;
                currentCol = 0;
                continue;
            }
            
            // Parse list items
            const listMatch = line.match(/^[\s]*[-*•]\s+(.+)/);
            if (listMatch) {
                elements.push({
                    type: 'text',
                    x: x + 20,
                    y: y,
                    text: '• ' + listMatch[1],
                    width: 250,
                    height: 30,
                    fontSize: 16
                });
                y += 50;
                continue;
            }
            
            // Check for different diagram elements based on keywords
            const lowerLine = line.toLowerCase();
            let element = null;
            
            if (lowerLine.includes('start') || lowerLine.includes('begin') || lowerLine.includes('end')) {
                element = {
                    type: 'ellipse',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 140,
                    height: 80,
                    text: this.extractText(line),
                    backgroundColor: '#e7f5ff',
                    strokeColor: '#1971c2'
                };
            } else if (lowerLine.includes('decision') || lowerLine.includes('if ') || lowerLine.includes('?')) {
                element = {
                    type: 'diamond',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 160,
                    height: 120,
                    text: this.extractText(line),
                    backgroundColor: '#fff9db',
                    strokeColor: '#f08c00'
                };
            } else if (lowerLine.includes('process') || lowerLine.includes('action') || lowerLine.includes('step')) {
                element = {
                    type: 'rectangle',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 180,
                    height: 100,
                    text: this.extractText(line),
                    backgroundColor: '#e6fcf5',
                    strokeColor: '#2f9e44'
                };
            } else if (lowerLine.includes('box') || lowerLine.includes('rect')) {
                element = {
                    type: 'rectangle',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 180,
                    height: 100,
                    text: this.extractText(line),
                    backgroundColor: '#f3f0ff',
                    strokeColor: '#7048e8'
                };
            } else if (lowerLine.includes('database') || lowerLine.includes('db') || lowerLine.includes('store')) {
                element = {
                    type: 'rectangle',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 180,
                    height: 100,
                    text: this.extractText(line),
                    backgroundColor: '#fff5f5',
                    strokeColor: '#e03131',
                    edgeType: 'round'
                };
            } else if (lowerLine.includes('input') || lowerLine.includes('output')) {
                element = {
                    type: 'diamond',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 160,
                    height: 100,
                    text: this.extractText(line),
                    backgroundColor: '#e7f5ff',
                    strokeColor: '#1971c2'
                };
            } else if (lowerLine.includes('circle') || lowerLine.includes('oval')) {
                element = {
                    type: 'ellipse',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 140,
                    height: 100,
                    text: this.extractText(line)
                };
            } else if (lowerLine.includes('note') || lowerLine.includes('sticky')) {
                element = {
                    type: 'sticky',
                    x: x + currentCol * colWidth,
                    y: y,
                    width: 200,
                    height: 150,
                    text: this.extractText(line),
                    backgroundColor: '#ffec99',
                    strokeColor: '#e6b800'
                };
            } else if (lowerLine.includes('arrow') || lowerLine.includes('connect') || lowerLine.includes('→')) {
                if (lastNode) {
                    elements.push({
                        type: 'arrow',
                        points: [
                            { x: lastNode.x, y: lastNode.y + 40 },
                            { x: lastNode.x, y: y - 20 }
                        ],
                        strokeColor: '#666666',
                        strokeWidth: 2
                    });
                }
                continue;
            } else {
                // Default to text
                element = {
                    type: 'text',
                    x: x + currentCol * colWidth,
                    y: y,
                    text: this.extractText(line),
                    width: 200,
                    height: 40
                };
            }
            
            if (element) {
                elements.push(element);
                lastNode = { x: element.x, y: element.y, text: element.text };
                
                currentCol++;
                if (currentCol >= maxCols) {
                    currentCol = 0;
                    y += rowHeight;
                }
            }
        }
        
        return elements;
    }
    
    createNode(text, x, y, elements) {
        const element = {
            type: 'rectangle',
            x: x,
            y: y,
            width: 180,
            height: 80,
            text: text,
            backgroundColor: '#f8f9fa',
            strokeColor: '#495057'
        };
        elements.push(element);
        return { x, y, text };
    }
    
    extractText(line) {
        // Extract text between quotes, after colons, or clean up keywords
        let cleaned = line
            .replace(/^(box|rect|rectangle|diamond|circle|oval|ellipse|arrow|connect|text|note|sticky|process|action|step|decision|start|end|input|output|database|db)\s*[:\-]?\s*/i, '')
            .trim();
        
        const match = cleaned.match(/["'](.+?)["']|:\s*(.+)/);
        return match ? (match[1] || match[2] || cleaned) : cleaned;
    }
    
    showStatus(message, type) {
        if (!this.status) return;
        
        this.status.textContent = message;
        this.status.className = 'ai-status ' + type;
        
        // Add spinner for loading state
        if (type === 'loading') {
            this.status.innerHTML = `<span class="spinner" style="display: inline-block; margin-right: 8px;"></span>${message}`;
        }
        
        // Auto-hide success messages
        if (type === 'success') {
            setTimeout(() => {
                this.status.className = 'ai-status';
            }, 3000);
        }
    }

    buildChatMessages(canvasContext = this.buildCanvasContext()) {
        return [
            {
                role: 'system',
                content: [
                    'You are a canvas agent helping the user reason about and improve a visual Excalidraw-style whiteboard.',
                    'Be concise and ground every answer in the provided canvas context.',
                    'When the user asks you to change the canvas, return strict JSON with this shape:',
                    '{"message":"short summary","actions":[{"type":"add","element":{...}},{"type":"add_many","elements":[...]},{"type":"update","id":"existing-id","patch":{...}},{"type":"update_many","patches":[{"id":"existing-id","patch":{...}}]},{"type":"delete","id":"existing-id"},{"type":"select","ids":["existing-id"]}]}',
                    'Use selected element ids for updates. Do not invent ids for existing objects. Keep geometry changes modest unless asked for a large rewrite.',
                    'Default to editable objects and object actions. Do not create image elements, screenshots, or raster snapshots unless image asset mode is explicit.',
                    'For discussion-only answers, plain text is fine.',
                ].join(' '),
            },
            {
                role: 'system',
                content: `Current canvas grounding: ${JSON.stringify(canvasContext)}`,
            },
            ...this.chatHistory,
        ];
    }

    trimChatHistory() {
        if (this.chatHistory.length > 12) {
            this.chatHistory = this.chatHistory.slice(-12);
        }
    }

    async restoreSharedConversation() {
        try {
            const sessionState = await window.apiManager.getSessionState();
            const activeSessionId = String(sessionState.activeSessionId || '').trim()
                || String(sessionState.sessions?.[0]?.id || '').trim();

            if (!activeSessionId) {
                return;
            }

            window.apiManager.setSessionId(activeSessionId);
            const messages = await window.apiManager.getSessionMessages(activeSessionId, 40);
            this.chatHistory = messages
                .filter((message) => message?.role === 'user' || message?.role === 'assistant')
                .map((message) => ({
                    role: message.role,
                    content: this.extractHistoryContent(message.content),
                }))
                .filter((message) => message.content)
                .slice(-12);

            this.renderConversationHistory();
            if (this.chatHistory.length > 0) {
                this.showStatus('Loaded shared session history.', 'success');
            }
        } catch (error) {
            console.warn('Failed to restore shared canvas conversation:', error);
        }
    }

    extractHistoryContent(content) {
        if (typeof content === 'string') {
            return content.trim();
        }

        if (Array.isArray(content)) {
            return content
                .map((entry) => this.extractHistoryContent(entry))
                .filter(Boolean)
                .join('\n')
                .trim();
        }

        if (!content || typeof content !== 'object') {
            return '';
        }

        return this.extractHistoryContent(
            content.text
            || content.content
            || content.value
            || content.output_text
            || '',
        );
    }

    renderConversationHistory() {
        if (!this.conversation) {
            return;
        }

        this.conversation.innerHTML = '';
        if (this.chatHistory.length === 0) {
            if (this.conversationEmpty) {
                this.conversationEmpty.style.display = '';
            }
            return;
        }

        if (this.conversationEmpty) {
            this.conversationEmpty.style.display = 'none';
        }

        this.chatHistory.forEach((message) => {
            this.addConversationMessage(message.role, message.content);
        });
    }

    addConversationMessage(role, content) {
        if (!this.conversation) return;

        if (this.conversationEmpty) {
            this.conversationEmpty.style.display = 'none';
        }

        const message = document.createElement('div');
        message.className = `ai-message ${role}`;
        message.innerHTML = `
            <div class="ai-message-role">${role === 'user' ? 'You' : 'Agent'}</div>
            <div class="ai-message-bubble"></div>
        `;
        message.querySelector('.ai-message-bubble').textContent = content;
        this.conversation.appendChild(message);
        this.conversation.scrollTop = this.conversation.scrollHeight;
    }
}

// Create global instance
window.aiAssistant = new AIAssistant();
