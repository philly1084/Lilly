/**
 * AI Assistant Module - object-first canvas agent panel.
 */

const CANVAS_AGENT_CONTEXT_LIMITS = Object.freeze({
    selectedElements: 4,
    referenceElements: 4,
    relationships: 4,
    promptCharacters: 900,
    restoredHistory: 2,
    liveHistory: 2,
});
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
        this.pinboardSummary = document.getElementById('aiPinboardSummary');
        this.templateSummary = document.getElementById('aiTemplateSummary');
        this.organizerSummary = document.getElementById('aiOrganizerSummary');
        this.ledgerSummary = document.getElementById('aiLedgerSummary');
        this.actionList = document.getElementById('aiActionList');
        this.changeSetSummary = document.getElementById('aiChangeSetSummary');
        this.changeSetList = document.getElementById('aiChangeSetList');
        this.workSetSummary = document.getElementById('aiWorkSetSummary');
        this.workSetList = document.getElementById('aiWorkSetList');
        this.checkpointSummary = document.getElementById('aiCheckpointSummary');
        this.checkpointList = document.getElementById('aiCheckpointList');
        this.briefSummary = document.getElementById('aiBriefSummary');
        this.briefList = document.getElementById('aiBriefList');
        this.boardIndexSummary = document.getElementById('aiBoardIndexSummary');
        this.boardIndexInput = document.getElementById('aiBoardIndexInput');
        this.boardIndexList = document.getElementById('aiBoardIndexList');
        this.decisionSummary = document.getElementById('aiDecisionSummary');
        this.decisionList = document.getElementById('aiDecisionList');
        this.gatesSummary = document.getElementById('aiGatesSummary');
        this.gatesList = document.getElementById('aiGatesList');
        this.opsSummary = document.getElementById('aiOpsSummary');
        this.opsGrid = document.getElementById('aiOpsGrid');
        this.reviewSummary = document.getElementById('aiReviewSummary');
        this.reviewGrid = document.getElementById('aiReviewGrid');
        this.evidenceSummary = document.getElementById('aiEvidenceSummary');
        this.evidenceGrid = document.getElementById('aiEvidenceGrid');
        this.selectionBar = document.getElementById('aiSelectionBar');
        this.selectionBarSummary = document.getElementById('aiSelectionBarSummary');
        this.healthSummary = document.getElementById('aiHealthSummary');
        this.healthScore = document.getElementById('aiHealthScore');
        this.healthList = document.getElementById('aiHealthList');
        this.fixSummary = document.getElementById('aiFixSummary');
        this.fixList = document.getElementById('aiFixList');
        this.isGenerating = false;
        this.scope = 'auto';
        this.actionLedger = [];
        this.changeSets = [];
        this.workSets = [];
        this.pendingFixPlan = { fixes: [], actions: [] };
        this.lastBoardBriefText = '';
        this.lastReviewQueueText = '';
        this.boardIndexMatches = [];
        
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

        document.querySelectorAll('[data-ai-command-prompt]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.runCommandPrompt(btn.dataset.aiCommandPrompt || '', btn.dataset.aiCommandMode || 'chat');
            });
        });

        document.querySelectorAll('[data-ai-change-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.handleChangeSetAction(btn.dataset.aiChangeAction || '');
            });
        });

        ['pointerdown', 'mousedown', 'touchstart'].forEach((eventName) => {
            this.selectionBar?.addEventListener(eventName, (event) => {
                event.stopPropagation();
            }, { passive: eventName === 'touchstart' });
        });
        this.selectionBar?.addEventListener('click', (event) => {
            event.stopPropagation();
            const button = event.target?.closest?.('[data-ai-selection-action]');
            if (!button || button.disabled) {
                return;
            }
            this.handleSelectionAction(button.dataset.aiSelectionAction || '');
        });

        // Fetch models on init
        this.fetchModels();
        this.setMode('chat');
        this.restoreSharedConversation();
        this.updateGroundingPanel();
        this.renderToolPlan();
        this.renderActionLedger();
        this.renderChangeSets();
        this.updateSelectionActionBar();
        this.setAgentPlanStep();
    }

    loadToolLaneSelection() {
        return [];
    }

    loadWorkSets() {
        return [];
    }

    saveWorkSets() {
        // Legacy no-op. Reusable object storage now lives in the Canvas Blocks shelf.
    }

    renderWorkSets() {
        if (this.workSetSummary) {
            this.workSetSummary.textContent = this.workSets.length > 0
                ? `${this.workSets.length} saved`
                : 'No saved sets';
        }
        if (!this.workSetList) {
            return;
        }

        if (this.workSets.length === 0) {
            this.workSetList.innerHTML = '<div class="ai-workset-empty">Save a selection to reuse it later.</div>';
            return;
        }

        this.workSetList.innerHTML = this.workSets.map((set) => {
            const count = set.elementIds.length;
            return `
                <div class="ai-workset-item">
                    <div class="ai-workset-item__main">
                        <strong>${this.escapeHtml(set.name)}</strong>
                        <span>${count} object${count === 1 ? '' : 's'}</span>
                    </div>
                    <div class="ai-workset-item__actions">
                        <button type="button" data-ai-workset-action="select" data-ai-workset-id="${this.escapeHtml(set.id)}">Select</button>
                        <button type="button" data-ai-workset-action="tidy" data-ai-workset-id="${this.escapeHtml(set.id)}">Tidy</button>
                        <button type="button" data-ai-workset-action="connect" data-ai-workset-id="${this.escapeHtml(set.id)}">Connect</button>
                        <button type="button" data-ai-workset-action="frame" data-ai-workset-id="${this.escapeHtml(set.id)}">Frame</button>
                        <button type="button" data-ai-workset-action="delete" data-ai-workset-id="${this.escapeHtml(set.id)}">Delete</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    saveCurrentSelectionAsWorkSet() {
        const selected = window.infiniteCanvas?.selectedElements || [];
        if (selected.length === 0) {
            this.recordActionLedger('No selection to save as a work set', 'warning', 'work set');
            window.app?.showToast?.('Select objects before saving a work set', 'warning');
            return;
        }

        const defaultName = selected.length === 1 ? 'Selected object' : `${selected.length} object set`;
        const requestedName = window.prompt?.('Name this work set', defaultName);
        const name = String(requestedName || '').trim();
        if (!name) {
            return;
        }

        const elementIds = selected.map((element) => element.id).filter(Boolean);
        const workSet = {
            id: `workset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: name.slice(0, 64),
            elementIds,
            createdAt: new Date().toISOString(),
        };
        this.workSets = [workSet, ...this.workSets.filter((set) => set.name !== workSet.name)].slice(0, 12);
        this.saveWorkSets();
        this.renderWorkSets();
        this.recordActionLedger(`Saved work set "${workSet.name}"`, 'success', 'work set');
        window.app?.showToast?.(`Saved work set "${workSet.name}"`);
    }

    selectWorkSet(workSetId = '', options = {}) {
        const canvas = window.infiniteCanvas;
        const workSet = this.workSets.find((set) => set.id === workSetId);
        if (!canvas || !workSet) {
            this.recordActionLedger('Work set was not found', 'warning', 'work set');
            return [];
        }

        const idSet = new Set(workSet.elementIds);
        const found = (canvas.elements || []).filter((element) => idSet.has(element.id));
        const missing = Math.max(0, workSet.elementIds.length - found.length);
        if (found.length === 0) {
            this.recordActionLedger(`Work set "${workSet.name}" has no remaining objects`, 'warning', 'work set');
            window.app?.showToast?.('No saved work set objects remain', 'warning');
            return [];
        }

        canvas.selectElements(found);
        canvas.render();
        this.updateGroundingPanel();
        if (!options.silent) {
            const suffix = missing > 0 ? ` (${missing} missing)` : '';
            this.recordActionLedger(`Selected work set "${workSet.name}"${suffix}`, missing > 0 ? 'warning' : 'success', 'work set');
            window.app?.showToast?.(`Selected "${workSet.name}"${suffix}`);
        }
        return found;
    }

    handleWorkSetAction(action = '', workSetId = '') {
        if (action === 'save') {
            this.saveCurrentSelectionAsWorkSet();
            return;
        }

        if (action === 'delete') {
            const workSet = this.workSets.find((set) => set.id === workSetId);
            this.workSets = this.workSets.filter((set) => set.id !== workSetId);
            this.saveWorkSets();
            this.renderWorkSets();
            if (workSet) {
                this.recordActionLedger(`Deleted work set "${workSet.name}"`, 'success', 'work set');
            }
            return;
        }

        const selected = this.selectWorkSet(workSetId, { silent: action !== 'select' });
        if (selected.length === 0 || action === 'select') {
            return;
        }

        if (action === 'tidy') {
            this.tidySelection();
        } else if (action === 'connect') {
            this.connectSelection();
        } else if (action === 'frame') {
            this.frameSelection();
        }
    }

    renderCheckpoints() {
        const checkpoints = window.app?.loadCanvasCheckpoints?.() || [];
        if (this.checkpointSummary) {
            this.checkpointSummary.textContent = checkpoints.length > 0
                ? `${checkpoints.length} saved`
                : 'No checkpoints';
        }
        if (!this.checkpointList) {
            return;
        }

        if (checkpoints.length === 0) {
            this.checkpointList.innerHTML = '<div class="ai-checkpoint-empty">Save a board checkpoint before a risky edit.</div>';
            return;
        }

        this.checkpointList.innerHTML = checkpoints.map((checkpoint) => {
            const created = checkpoint.createdAt
                ? new Date(checkpoint.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : 'Saved';
            const count = Number(checkpoint.elementCount || checkpoint.elements?.length || 0);
            return `
                <div class="ai-checkpoint-item">
                    <div class="ai-checkpoint-item__main">
                        <strong>${this.escapeHtml(checkpoint.name)}</strong>
                        <span>${this.escapeHtml(created)} - ${count} object${count === 1 ? '' : 's'}</span>
                    </div>
                    <div class="ai-checkpoint-item__actions">
                        <button type="button" data-ai-checkpoint-action="restore" data-ai-checkpoint-id="${this.escapeHtml(checkpoint.id)}">Restore</button>
                        <button type="button" data-ai-checkpoint-action="delete" data-ai-checkpoint-id="${this.escapeHtml(checkpoint.id)}">Delete</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    handleCheckpointAction(action = '', checkpointId = '') {
        if (action === 'save') {
            const checkpoint = window.app?.saveCanvasCheckpoint?.();
            if (checkpoint) {
                this.recordActionLedger(`Saved checkpoint "${checkpoint.name}"`, 'success', 'checkpoint');
                this.renderCheckpoints();
            }
            return;
        }

        if (action === 'restore') {
            const restored = window.app?.restoreCanvasCheckpoint?.(checkpointId);
            if (restored) {
                this.recordActionLedger('Restored board checkpoint', 'success', 'checkpoint');
                this.updateGroundingPanel();
            }
            return;
        }

        if (action === 'delete') {
            window.app?.deleteCanvasCheckpoint?.(checkpointId);
            this.recordActionLedger('Deleted board checkpoint', 'muted', 'checkpoint');
            this.renderCheckpoints();
        }
    }

    buildBoardReadinessItems(data) {
        return [
            {
                label: 'Board content',
                state: data.objectCount > 0 ? 'ready' : 'missing',
                detail: data.objectCount > 0 ? `${data.objectCount} editable object${data.objectCount === 1 ? '' : 's'}` : 'Add objects before handoff',
            },
            {
                label: 'Readable text',
                state: data.textPreviews.length > 0 ? 'ready' : 'attention',
                detail: data.textPreviews.length > 0 ? `${data.textPreviews.length} text preview${data.textPreviews.length === 1 ? '' : 's'} captured` : 'Add labels or notes for reviewers',
            },
            {
                label: 'Structure health',
                state: data.healthScore == null ? 'missing' : (data.healthScore >= 76 ? 'ready' : (data.healthScore >= 50 ? 'attention' : 'missing')),
                detail: data.healthScore == null ? 'No auditable board yet' : `Board audit score ${data.healthScore}`,
            },
            {
                label: 'Checkpoint',
                state: data.checkpoints > 0 ? 'ready' : 'attention',
                detail: data.checkpoints > 0 ? `${data.checkpoints} rollback point${data.checkpoints === 1 ? '' : 's'} saved` : 'Save a checkpoint before risky edits',
            },
            {
                label: 'Selection focus',
                state: data.selectedCount > 0 ? 'ready' : 'optional',
                detail: data.selectedCount > 0 ? `${data.selectedCount} selected for focused edits` : 'No focused selection',
            },
        ];
    }

    buildBoardNextActions(data) {
        const actions = [];

        if (data.objectCount === 0) {
            actions.push({
                label: 'Draft a board starter',
                detail: 'Open the agent with a structured starter prompt.',
                action: 'starter-prompt',
                priority: 'high',
            });
        }
        if (data.textPreviews.length === 0 && data.objectCount > 0) {
            actions.push({
                label: 'Add QA note',
                detail: 'Create an editable note with missing labels and structure gaps.',
                action: 'qa-note',
                priority: 'high',
            });
        }
        if (data.healthScore != null && data.healthScore < 76) {
            actions.push({
                label: 'Select suggested fixes',
                detail: 'Highlight objects that need labels, links, or grouping.',
                action: 'select-fixes',
                priority: data.healthScore < 50 ? 'high' : 'medium',
            });
        }
        if (data.checkpoints === 0 && data.objectCount > 0) {
            actions.push({
                label: 'Save checkpoint',
                detail: 'Create a rollback point before major changes.',
                action: 'save-checkpoint',
                priority: 'medium',
            });
        }
        if (data.selectedCount === 0 && data.objectCount > 0) {
            actions.push({
                label: 'Refresh audit',
                detail: 'Recompute structure health and fix suggestions.',
                action: 'refresh-audit',
                priority: 'low',
            });
        }
        actions.push({
            label: 'Add brief note',
            detail: 'Place the current board brief on the canvas.',
            action: 'brief-note',
            priority: 'low',
        });
        actions.push({
            label: 'Copy brief',
            detail: 'Copy the handoff summary for another tool or chat.',
            action: 'copy-brief',
            priority: 'low',
        });

        return actions.slice(0, 6);
    }

    buildBoardBriefData(context = this.buildCanvasContext()) {
        const elements = window.infiniteCanvas?.elements || [];
        const checkpoints = window.app?.loadCanvasCheckpoints?.() || [];
        const textPreviews = elements
            .filter((element) => typeof element.text === 'string' && element.text.trim())
            .slice(0, 5)
            .map((element) => element.text.trim().replace(/\s+/g, ' '));
        const issues = (context.boardHealth?.issues || [])
            .filter((issue) => issue.severity !== 'good')
            .map((issue) => issue.text)
            .slice(0, 4);
        const actions = this.actionLedger.slice(0, 4).map((entry) => entry.text);
        const data = {
            createdAt: new Date(),
            objectCount: context.board?.elementCount || 0,
            boardTypes: context.board?.typeCounts || 'None',
            selectedCount: context.selection?.count || 0,
            selectedTypes: context.selection?.typeCounts || 'None',
            healthScore: context.boardHealth?.objectCount > 0 ? context.boardHealth.score : null,
            checkpoints: checkpoints.length,
            issues,
            textPreviews,
            actions,
        };
        data.readiness = this.buildBoardReadinessItems(data);
        data.nextActions = this.buildBoardNextActions(data);
        return data;
    }

    buildBoardBriefText(data = this.buildBoardBriefData()) {
        const lines = [
            'Lilly Canvas Board Brief',
            `Created: ${data.createdAt.toLocaleString()}`,
            `Objects: ${data.objectCount}`,
            `Types: ${data.boardTypes}`,
            `Selection: ${data.selectedCount}${data.selectedTypes && data.selectedTypes !== 'None' ? ` (${data.selectedTypes})` : ''}`,
            `Health score: ${data.healthScore ?? '--'}`,
            `Checkpoints: ${data.checkpoints}`,
            '',
            'Issues:',
            ...(data.issues.length > 0 ? data.issues.map((issue) => `- ${issue}`) : ['- No major board issues detected.']),
            '',
            'Visible text:',
            ...(data.textPreviews.length > 0 ? data.textPreviews.map((text) => `- ${text}`) : ['- No text objects yet.']),
            '',
            'Readiness:',
            ...(data.readiness || []).map((item) => `- [${item.state}] ${item.label}: ${item.detail}`),
            '',
            'Next actions:',
            ...(data.nextActions || []).map((item) => `- [${item.priority}] ${item.label}: ${item.detail}`),
            '',
            'Recent actions:',
            ...(data.actions.length > 0 ? data.actions.map((action) => `- ${action}`) : ['- No recent canvas actions.']),
        ];

        return lines.join('\n');
    }

    renderBoardBrief(context = this.buildCanvasContext()) {
        const data = this.buildBoardBriefData(context);
        this.lastBoardBriefText = this.buildBoardBriefText(data);

        if (this.briefSummary) {
            this.briefSummary.textContent = data.objectCount > 0
                ? `${data.objectCount} objects, score ${data.healthScore ?? '--'}`
                : 'No board content';
        }

        if (!this.briefList) {
            return;
        }

        const issueSummary = data.issues[0] || 'No major issues';
        const textSummary = data.textPreviews[0] || 'No text objects yet';
        const rows = [
            ['Board', data.boardTypes],
            ['Selection', data.selectedCount > 0 ? `${data.selectedCount} selected - ${data.selectedTypes}` : 'Nothing selected'],
            ['Health', `${data.healthScore ?? '--'} - ${issueSummary}`],
            ['Text', textSummary],
            ['Checkpoints', `${data.checkpoints} saved`],
        ];
        const readiness = (data.readiness || []).map((item) => `
            <div class="ai-brief-readiness-item ${this.escapeHtml(item.state)}">
                <strong>${this.escapeHtml(item.label)}</strong>
                <span>${this.escapeHtml(item.detail)}</span>
            </div>
        `).join('');
        const nextActions = (data.nextActions || []).map((item) => `
            <button type="button" class="ai-brief-next-action ${this.escapeHtml(item.priority)}" data-ai-brief-next-action="${this.escapeHtml(item.action)}">
                <strong>${this.escapeHtml(item.label)}</strong>
                <span>${this.escapeHtml(item.detail)}</span>
            </button>
        `).join('');

        this.briefList.innerHTML = rows.map(([label, value]) => `
            <div class="ai-brief-item">
                <strong>${this.escapeHtml(label)}</strong>
                <span>${this.escapeHtml(value)}</span>
            </div>
        `).join('') + `
            <div class="ai-brief-readiness" aria-label="Board readiness checklist">${readiness}</div>
            <div class="ai-brief-next-actions" aria-label="Board suggested next actions">${nextActions}</div>
        `;
    }

    getBoardIndexLabel(element = {}) {
        const text = String(element.text || element.label || '').replace(/\s+/g, ' ').trim();
        if (text) {
            return text.slice(0, 96);
        }
        if (element.type === 'arrow' || element.type === 'line') {
            return `${element.type || 'connector'} ${String(element.id || '').slice(0, 8)}`;
        }
        return `${element.type || 'object'} ${String(element.id || '').slice(0, 8)}`;
    }

    getBoardIndexSearchText(element = {}) {
        return [
            element.id,
            element.type,
            element.text,
            element.label,
            element.healthRole,
            element.groupId,
            element.strokeColor,
            element.backgroundColor,
        ].map((value) => String(value || '')).join(' ').toLowerCase();
    }

    buildBoardIndexItems(query = '') {
        const canvas = window.infiniteCanvas;
        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!canvas || !normalizedQuery) {
            return [];
        }

        return (canvas.elements || [])
            .filter((element) => this.getBoardIndexSearchText(element).includes(normalizedQuery))
            .map((element) => {
                const bounds = this.getElementBounds(element);
                const label = this.getBoardIndexLabel(element);
                return {
                    id: element.id,
                    element,
                    label,
                    detail: `${element.type || 'object'} - ${Math.round(bounds.width || element.width || 0)}x${Math.round(bounds.height || element.height || 0)} at ${Math.round(element.x || 0)}, ${Math.round(element.y || 0)}`,
                };
            })
            .slice(0, 12);
    }

    renderBoardIndex(query = this.boardIndexInput?.value || '') {
        const normalizedQuery = String(query || '').trim();
        const matches = this.buildBoardIndexItems(normalizedQuery);
        this.boardIndexMatches = matches;

        if (this.boardIndexSummary) {
            this.boardIndexSummary.textContent = normalizedQuery
                ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
                : 'No query';
        }

        if (!this.boardIndexList) {
            return;
        }

        if (!normalizedQuery) {
            this.boardIndexList.innerHTML = '<div class="ai-board-index-empty">Search board objects to focus or select them.</div>';
            return;
        }

        if (matches.length === 0) {
            this.boardIndexList.innerHTML = `<div class="ai-board-index-empty">No board objects matched "${this.escapeHtml(normalizedQuery)}".</div>`;
            return;
        }

        this.boardIndexList.innerHTML = matches.map((match) => `
            <div class="ai-board-index-item" title="${this.escapeHtml(match.id)}">
                <div class="ai-board-index-item__main">
                    <strong>${this.escapeHtml(match.label)}</strong>
                    <span>${this.escapeHtml(match.detail)}</span>
                </div>
                <div class="ai-board-index-item__actions">
                    <button type="button" data-ai-board-index-action="select" data-ai-board-index-id="${this.escapeHtml(match.id)}">Select</button>
                </div>
            </div>
        `).join('');
    }

    buildBoardIndexSummaryText(query = this.boardIndexInput?.value || '') {
        const normalizedQuery = String(query || '').trim();
        const canvas = window.infiniteCanvas;
        const elements = canvas?.elements || [];
        const matches = normalizedQuery ? (this.boardIndexMatches || []) : elements.slice(0, 12).map((element) => {
            const bounds = this.getElementBounds(element);
            return {
                id: element.id,
                element,
                label: this.getBoardIndexLabel(element),
                detail: `${element.type || 'object'} - ${Math.round(bounds.width || element.width || 0)}x${Math.round(bounds.height || element.height || 0)} at ${Math.round(element.x || 0)}, ${Math.round(element.y || 0)}`,
            };
        });
        const selected = canvas?.selectedElements || [];
        const lines = [
            'KimiBuilt Canvas Board Index',
            `Created: ${new Date().toLocaleString()}`,
            `Query: ${normalizedQuery || 'All board objects'}`,
            `Objects: ${elements.length}`,
            `Matches listed: ${matches.length}`,
            `Selection: ${selected.length}`,
            '',
            'Matches:',
            ...(matches.length > 0
                ? matches.map((match, index) => `${index + 1}. ${match.label} [${match.detail}] id=${match.id}`)
                : ['- No matching objects.']),
        ];
        return lines.join('\n');
    }

    async copyBoardIndexSummary() {
        const text = this.buildBoardIndexSummaryText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied board index summary', 'success', 'index');
            this.showStatus('Board index copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for board index', 'warning', 'index');
            this.showStatus('Clipboard unavailable for board index.', 'error');
        }
    }

    buildCanvasHandoffPacketText() {
        const context = this.buildCanvasContext();
        const healthScore = context.boardHealth?.objectCount > 0 ? context.boardHealth.score : '--';
        return [
            'KimiBuilt Canvas Continuation Packet',
            `Created: ${new Date().toLocaleString()}`,
            `Objects: ${context.board?.elementCount || 0}`,
            `Types: ${context.board?.typeCounts || 'None'}`,
            `Selection: ${context.selection?.count || 0}${context.selection?.typeCounts && context.selection.typeCounts !== 'None' ? ` (${context.selection.typeCounts})` : ''}`,
            `Health score: ${healthScore}`,
            `Scope: ${context.scope}`,
            '',
            '--- Board Brief ---',
            this.buildBoardBriefText(this.buildBoardBriefData(context)),
            '',
            '--- Board Index ---',
            this.buildBoardIndexSummaryText(),
            '',
            '--- Canvas Audit ---',
            this.buildCanvasAuditText(this.buildCanvasAuditData(context)),
        ].join('\n');
    }

    async copyCanvasHandoffPacket() {
        const text = this.buildCanvasHandoffPacketText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied canvas continuation packet', 'success', 'packet');
            this.showStatus('Canvas packet copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for canvas packet', 'warning', 'packet');
            this.showStatus('Clipboard unavailable for canvas packet.', 'error');
        }
    }

    classifyDecisionText(text = '') {
        const normalized = String(text || '').trim();
        const lower = normalized.toLowerCase();
        if (!normalized || normalized.length < 8) {
            return null;
        }
        if (/\b(decision|decided|approved|chosen|selected|agreed)\b/.test(lower)) {
            return 'decision';
        }
        if (/\b(risk|blocked|blocker|concern|issue|problem|failure|regression|missing)\b/.test(lower)) {
            return 'risk';
        }
        if (/\b(next|todo|action|follow up|follow-up|verify|ship|fix|run|check|owner|due)\b/.test(lower)) {
            return 'action';
        }
        return null;
    }

    buildDecisionRegisterData(context = this.buildCanvasContext()) {
        const elements = window.infiniteCanvas?.elements || [];
        const buckets = { decision: [], risk: [], action: [] };
        const seen = new Set();
        elements
            .filter((element) => typeof element.text === 'string' && element.text.trim())
            .forEach((element) => {
                String(element.text || '')
                    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9/-])/)
                    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean)
                    .forEach((line) => {
                        const type = this.classifyDecisionText(line);
                        if (!type) {
                            return;
                        }
                        const key = `${type}:${line.toLowerCase()}`;
                        if (seen.has(key)) {
                            return;
                        }
                        seen.add(key);
                        buckets[type].push({
                            type,
                            text: line.slice(0, 180),
                            source: `${element.type || 'object'} ${String(element.id || '').slice(0, 8)}`,
                        });
                    });
            });

        return {
            objectCount: context.board?.elementCount || elements.length,
            selectedCount: context.selection?.count || 0,
            decisions: buckets.decision.slice(0, 8),
            risks: buckets.risk.slice(0, 8),
            actions: buckets.action.slice(0, 8),
        };
    }

    buildDecisionRegisterText(data = this.buildDecisionRegisterData()) {
        const formatItems = (items) => items.length > 0
            ? items.map((item, index) => `${index + 1}. ${item.text} (${item.source})`)
            : ['- None detected locally.'];
        return [
            'KimiBuilt Canvas Decision Register',
            `Created: ${new Date().toLocaleString()}`,
            `Objects: ${data.objectCount}`,
            `Selection: ${data.selectedCount}`,
            '',
            'Decisions:',
            ...formatItems(data.decisions),
            '',
            'Risks:',
            ...formatItems(data.risks),
            '',
            'Actions:',
            ...formatItems(data.actions),
        ].join('\n');
    }

    renderDecisionRegister(context = this.buildCanvasContext()) {
        const data = this.buildDecisionRegisterData(context);
        const total = data.decisions.length + data.risks.length + data.actions.length;
        if (this.decisionSummary) {
            this.decisionSummary.textContent = total > 0
                ? `${data.decisions.length} decisions / ${data.risks.length} risks / ${data.actions.length} actions`
                : 'No signals';
        }
        if (!this.decisionList) {
            return;
        }

        const renderBucket = (label, items, type) => {
            if (items.length === 0) {
                return `<div class="ai-decision-empty">${label}: none detected locally.</div>`;
            }
            return items.slice(0, 4).map((item) => `
                <div class="ai-decision-item ${this.escapeHtml(type)}">
                    <strong>${this.escapeHtml(label)} - ${this.escapeHtml(item.source)}</strong>
                    <span>${this.escapeHtml(item.text)}</span>
                </div>
            `).join('');
        };

        this.decisionList.innerHTML = [
            renderBucket('Decision', data.decisions, 'decision'),
            renderBucket('Risk', data.risks, 'risk'),
            renderBucket('Action', data.actions, 'action'),
        ].join('');
    }

    async copyDecisionRegister() {
        const text = this.buildDecisionRegisterText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied decision register', 'success', 'register');
            this.showStatus('Decision register copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for decision register', 'warning', 'register');
            this.showStatus('Clipboard unavailable for decision register.', 'error');
        }
    }

    addDecisionRegisterNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = this.buildDecisionRegisterText().slice(0, 1100);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `decision-register-${Date.now()}`,
            type: 'sticky',
            x: center.x + 300,
            y: center.y + 90,
            width: 300,
            height: 240,
            text,
            backgroundColor: '#eef2ff',
            strokeColor: '#3730a3',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 14,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Arial',
            qaGenerated: true,
            healthRole: 'note',
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Decision register note', 'register', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable decision register note', 'success', 'register');
        this.showStatus('Added a decision register note.', 'success');
    }

    handleDecisionRegisterAction(action = '') {
        if (action === 'copy') {
            this.copyDecisionRegister();
            return;
        }
        if (action === 'note') {
            this.addDecisionRegisterNote();
        }
    }

    buildGateReviewData(context = this.buildCanvasContext()) {
        const brief = this.buildBoardBriefData(context);
        const register = this.buildDecisionRegisterData(context);
        const health = context.boardHealth || {};
        const gates = [
            {
                label: 'Board content',
                state: (context.board?.elementCount || 0) > 0 ? 'pass' : 'fail',
                detail: `${context.board?.elementCount || 0} editable objects`,
            },
            {
                label: 'Readable labels',
                state: brief.textPreviews.length > 0 ? 'pass' : 'warn',
                detail: brief.textPreviews.length > 0 ? `${brief.textPreviews.length} text previews` : 'No readable text objects',
            },
            {
                label: 'Structure health',
                state: health.objectCount > 0 && health.score >= 76 ? 'pass' : (health.objectCount > 0 ? 'warn' : 'fail'),
                detail: health.objectCount > 0 ? `Score ${health.score}` : 'No auditable board',
            },
            {
                label: 'Checkpoint',
                state: brief.checkpoints > 0 ? 'pass' : 'warn',
                detail: brief.checkpoints > 0 ? `${brief.checkpoints} saved rollback point${brief.checkpoints === 1 ? '' : 's'}` : 'No rollback point saved',
            },
            {
                label: 'Decision trace',
                state: register.decisions.length > 0 ? 'pass' : 'warn',
                detail: register.decisions.length > 0 ? `${register.decisions.length} decisions detected` : 'No decision language detected',
            },
            {
                label: 'Risk visibility',
                state: register.risks.length > 0 ? 'warn' : 'pass',
                detail: register.risks.length > 0 ? `${register.risks.length} risks detected` : 'No explicit risks detected',
            },
            {
                label: 'Action path',
                state: register.actions.length > 0 || (brief.nextActions || []).length > 0 ? 'pass' : 'warn',
                detail: register.actions.length > 0 ? `${register.actions.length} local actions detected` : `${(brief.nextActions || []).length} suggested next actions`,
            },
            {
                label: 'Focused selection',
                state: (context.selection?.count || 0) > 0 ? 'pass' : 'warn',
                detail: (context.selection?.count || 0) > 0 ? `${context.selection.count} selected` : 'No focused selection',
            },
        ];
        const counts = gates.reduce((acc, gate) => {
            acc[gate.state] = (acc[gate.state] || 0) + 1;
            return acc;
        }, { pass: 0, warn: 0, fail: 0 });
        return { gates, counts, context };
    }

    buildGateReviewText(data = this.buildGateReviewData()) {
        return [
            'KimiBuilt Canvas Gate Review',
            `Created: ${new Date().toLocaleString()}`,
            `Pass: ${data.counts.pass || 0}`,
            `Warn: ${data.counts.warn || 0}`,
            `Fail: ${data.counts.fail || 0}`,
            '',
            ...data.gates.map((gate) => `- [${gate.state}] ${gate.label}: ${gate.detail}`),
        ].join('\n');
    }

    renderGateReview(context = this.buildCanvasContext()) {
        const data = this.buildGateReviewData(context);
        const verdict = (data.counts.fail || 0) > 0
            ? 'Needs attention'
            : ((data.counts.warn || 0) > 0 ? 'Ready with warnings' : 'Ready');
        if (this.gatesSummary) {
            this.gatesSummary.textContent = `${verdict} - ${data.counts.pass || 0}/${data.gates.length} pass`;
        }
        if (!this.gatesList) {
            return;
        }
        this.gatesList.innerHTML = data.gates.map((gate) => `
            <div class="ai-gates-item ${this.escapeHtml(gate.state)}">
                <strong>${this.escapeHtml(gate.label)}</strong>
                <span>${this.escapeHtml(gate.detail)}</span>
            </div>
        `).join('');
    }

    async copyGateReview() {
        const text = this.buildGateReviewText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied gate review', 'success', 'gates');
            this.showStatus('Gate review copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for gate review', 'warning', 'gates');
            this.showStatus('Clipboard unavailable for gate review.', 'error');
        }
    }

    addGateReviewNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = this.buildGateReviewText().slice(0, 1000);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `gate-review-${Date.now()}`,
            type: 'sticky',
            x: center.x + 330,
            y: center.y - 130,
            width: 300,
            height: 230,
            text,
            backgroundColor: '#ecfdf3',
            strokeColor: '#166534',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 14,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Arial',
            qaGenerated: true,
            healthRole: 'note',
        };
        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Gate review note', 'gates', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable gate review note', 'success', 'gates');
        this.showStatus('Added a gate review note.', 'success');
    }

    handleGateReviewAction(action = '') {
        if (action === 'copy') {
            this.copyGateReview();
            return;
        }
        if (action === 'note') {
            this.addGateReviewNote();
        }
    }

    buildCanvasOpsSnapshotData(context = this.buildCanvasContext()) {
        const brief = this.buildBoardBriefData(context);
        const gates = this.buildGateReviewData(context);
        const register = this.buildDecisionRegisterData(context);
        const checkpoints = window.app?.loadCanvasCheckpoints?.() || [];
        const verdict = (gates.counts.fail || 0) > 0
            ? 'Needs attention'
            : ((gates.counts.warn || 0) > 0 ? 'Ready with warnings' : 'Ready');
        const openSignals = [
            ...(context.boardHealth?.issues || [])
                .filter((issue) => issue.severity !== 'good')
                .map((issue) => ({ type: 'Health', text: issue.text })),
            ...(register.risks || []).map((item) => ({ type: 'Risk', text: item.text })),
            ...gates.gates.filter((gate) => gate.state === 'fail').map((gate) => ({ type: 'Gate', text: `${gate.label}: ${gate.detail}` })),
        ].slice(0, 5);
        return {
            createdAt: new Date(),
            verdict,
            context,
            brief,
            gates,
            register,
            checkpoints,
            ledger: this.actionLedger.slice(0, 5),
            changeSets: this.changeSets.slice(0, 5),
            openSignals,
            nextActions: (brief.nextActions || []).slice(0, 5),
        };
    }

    buildCanvasOpsSnapshotText(data = this.buildCanvasOpsSnapshotData()) {
        const formatRows = (rows, fallback = '- None') => rows.length > 0
            ? rows.map((row, index) => {
                if (typeof row === 'string') {
                    return `${index + 1}. ${row}`;
                }
                if (row.label && row.detail) {
                    return `${index + 1}. ${row.label}: ${row.detail}`;
                }
                if (row.type && row.text) {
                    return `${index + 1}. ${row.type}: ${row.text}`;
                }
                return `${index + 1}. ${row.text || row.title || 'Signal'}`;
            })
            : [fallback];
        return [
            'KimiBuilt Canvas Ops Snapshot',
            `Created: ${data.createdAt.toLocaleString()}`,
            `Verdict: ${data.verdict}`,
            `Objects: ${data.context.board?.elementCount || 0}`,
            `Types: ${data.context.board?.typeCounts || 'None'}`,
            `Selection: ${data.context.selection?.count || 0}`,
            `Health score: ${data.context.boardHealth?.objectCount > 0 ? data.context.boardHealth.score : '--'}`,
            `Gates: ${data.gates.counts.pass || 0} pass / ${data.gates.counts.warn || 0} warn / ${data.gates.counts.fail || 0} fail`,
            `Register: ${data.register.decisions.length} decisions / ${data.register.risks.length} risks / ${data.register.actions.length} actions`,
            `Checkpoints: ${data.checkpoints.length}`,
            `Change sets: ${data.changeSets.length}`,
            `Ledger entries: ${data.ledger.length}`,
            '',
            'Open signals:',
            ...formatRows(data.openSignals),
            '',
            'Next actions:',
            ...formatRows(data.nextActions),
            '',
            'Recent ledger:',
            ...formatRows(data.ledger.map((entry) => entry.text)),
        ].join('\n');
    }

    renderOpsSnapshot(context = this.buildCanvasContext()) {
        const data = this.buildCanvasOpsSnapshotData(context);
        if (this.opsSummary) {
            this.opsSummary.textContent = `${data.verdict} - ${data.gates.counts.pass || 0}/${data.gates.gates.length} gates`;
        }
        if (!this.opsGrid) {
            return;
        }

        const metricRows = [
            ['Objects', String(data.context.board?.elementCount || 0)],
            ['Selection', String(data.context.selection?.count || 0)],
            ['Health', data.context.boardHealth?.objectCount > 0 ? String(data.context.boardHealth.score) : '--'],
            ['Gates', `${data.gates.counts.pass || 0}/${data.gates.gates.length}`],
            ['Register', `${data.register.decisions.length}/${data.register.risks.length}/${data.register.actions.length}`],
            ['Checkpoints', String(data.checkpoints.length)],
            ['Change Sets', String(data.changeSets.length)],
            ['Ledger', String(data.ledger.length)],
        ].map(([label, value]) => `
            <div class="ai-ops-metric">
                <span>${this.escapeHtml(label)}</span>
                <strong>${this.escapeHtml(value)}</strong>
            </div>
        `).join('');
        const signalRows = data.openSignals.length > 0
            ? data.openSignals.map((signal) => `
                <div class="ai-ops-item signal">
                    <strong>${this.escapeHtml(signal.type)}</strong>
                    <span>${this.escapeHtml(signal.text)}</span>
                </div>
            `).join('')
            : '<div class="ai-ops-empty">No open blockers detected locally.</div>';
        const actionRows = data.nextActions.length > 0
            ? data.nextActions.map((action) => `
                <div class="ai-ops-item">
                    <strong>${this.escapeHtml(action.label)}</strong>
                    <span>${this.escapeHtml(action.detail)}</span>
                </div>
            `).join('')
            : '<div class="ai-ops-empty">No next action detected yet.</div>';

        this.opsGrid.innerHTML = `
            <div class="ai-ops-metrics">${metricRows}</div>
            <div class="ai-ops-columns">
                <section>
                    <span class="ai-grounding-kicker">Open Signals</span>
                    ${signalRows}
                </section>
                <section>
                    <span class="ai-grounding-kicker">Next Actions</span>
                    ${actionRows}
                </section>
            </div>
        `;
    }

    async copyOpsSnapshot() {
        const text = this.buildCanvasOpsSnapshotText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied ops snapshot', 'success', 'ops');
            this.showStatus('Ops snapshot copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for ops snapshot', 'warning', 'ops');
            this.showStatus('Clipboard unavailable for ops snapshot.', 'error');
        }
    }

    addOpsSnapshotNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = this.buildCanvasOpsSnapshotText().slice(0, 1100);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `ops-snapshot-${Date.now()}`,
            type: 'sticky',
            x: center.x + 360,
            y: center.y + 20,
            width: 320,
            height: 250,
            text,
            backgroundColor: '#f8fafc',
            strokeColor: '#334155',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 14,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Arial',
            qaGenerated: true,
            healthRole: 'note',
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Ops snapshot note', 'ops', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable ops snapshot note', 'success', 'ops');
        this.showStatus('Added an ops snapshot note.', 'success');
    }

    handleOpsSnapshotAction(action = '') {
        if (action === 'copy') {
            this.copyOpsSnapshot();
            return;
        }
        if (action === 'note') {
            this.addOpsSnapshotNote();
        }
    }

    buildCanvasEvidencePackData(context = this.buildCanvasContext()) {
        const ops = this.buildCanvasOpsSnapshotData(context);
        const audit = this.buildCanvasAuditData(context);
        const gates = this.buildGateReviewData(context);
        const register = this.buildDecisionRegisterData(context);
        const checkpoints = window.app?.loadCanvasCheckpoints?.() || [];
        const coverage = [
            {
                label: 'Board content',
                state: (context.board?.elementCount || 0) > 0 ? 'pass' : 'fail',
                detail: `${context.board?.elementCount || 0} editable objects`,
            },
            {
                label: 'Health audit',
                state: context.boardHealth?.objectCount > 0 && context.boardHealth.score >= 76 ? 'pass' : (context.boardHealth?.objectCount > 0 ? 'warn' : 'fail'),
                detail: context.boardHealth?.objectCount > 0 ? `Score ${context.boardHealth.score}` : 'No auditable board',
            },
            {
                label: 'Gate review',
                state: (gates.counts.fail || 0) > 0 ? 'fail' : ((gates.counts.warn || 0) > 0 ? 'warn' : 'pass'),
                detail: `${gates.counts.pass || 0} pass / ${gates.counts.warn || 0} warn / ${gates.counts.fail || 0} fail`,
            },
            {
                label: 'Decision register',
                state: register.decisions.length + register.risks.length + register.actions.length > 0 ? 'pass' : 'warn',
                detail: `${register.decisions.length} decisions / ${register.risks.length} risks / ${register.actions.length} actions`,
            },
            {
                label: 'Rollback proof',
                state: checkpoints.length > 0 ? 'pass' : 'warn',
                detail: `${checkpoints.length} checkpoint${checkpoints.length === 1 ? '' : 's'}`,
            },
            {
                label: 'Change ledger',
                state: this.changeSets.length + this.actionLedger.length > 0 ? 'pass' : 'warn',
                detail: `${this.changeSets.length} change sets / ${this.actionLedger.length} ledger entries`,
            },
        ];
        return {
            createdAt: new Date(),
            verdict: ops.verdict,
            context,
            ops,
            audit,
            gates,
            register,
            checkpoints,
            changeSets: this.changeSets.slice(0, 6),
            ledger: this.actionLedger.slice(0, 8),
            coverage,
        };
    }

    buildCanvasEvidencePackText(data = this.buildCanvasEvidencePackData()) {
        const formatRows = (rows, formatter, fallback = '- None') => rows.length > 0
            ? rows.map((row, index) => `${index + 1}. ${formatter(row)}`)
            : [fallback];
        return [
            'KimiBuilt Canvas Evidence Pack',
            `Created: ${data.createdAt.toLocaleString()}`,
            `Verdict: ${data.verdict}`,
            `Objects: ${data.context.board?.elementCount || 0}`,
            `Selection: ${data.context.selection?.count || 0}`,
            `Health score: ${data.context.boardHealth?.objectCount > 0 ? data.context.boardHealth.score : '--'}`,
            '',
            'Evidence coverage:',
            ...formatRows(data.coverage, (item) => `[${item.state}] ${item.label}: ${item.detail}`),
            '',
            'Recent audit events:',
            ...formatRows(data.audit.events.slice(0, 8), (event) => `[${event.state}] ${event.kind || 'event'} ${event.label}: ${event.detail}`),
            '',
            'Gate review:',
            ...data.gates.gates.map((gate) => `- [${gate.state}] ${gate.label}: ${gate.detail}`),
            '',
            'Checkpoints:',
            ...formatRows(data.checkpoints.slice(0, 6), (checkpoint) => `${checkpoint.name} (${Number(checkpoint.elementCount || checkpoint.elements?.length || 0)} objects)`),
            '',
            'Change sets:',
            ...formatRows(data.changeSets, (entry) => `${entry.label}: ${entry.summary || entry.type || 'change'}`),
            '',
            'Recent ledger:',
            ...formatRows(data.ledger, (entry) => `[${entry.status}] ${entry.text}`),
        ].join('\n');
    }

    renderEvidencePack(context = this.buildCanvasContext()) {
        const data = this.buildCanvasEvidencePackData(context);
        if (this.evidenceSummary) {
            this.evidenceSummary.textContent = `${data.verdict} - ${data.coverage.filter((item) => item.state === 'pass').length}/${data.coverage.length} covered`;
        }
        if (!this.evidenceGrid) {
            return;
        }

        const metricRows = [
            ['Objects', String(data.context.board?.elementCount || 0)],
            ['Health', data.context.boardHealth?.objectCount > 0 ? String(data.context.boardHealth.score) : '--'],
            ['Gates', `${data.gates.counts.pass || 0}/${data.gates.gates.length}`],
            ['Register', String(data.register.decisions.length + data.register.risks.length + data.register.actions.length)],
            ['Checkpoints', String(data.checkpoints.length)],
            ['Changes', String(data.changeSets.length)],
            ['Ledger', String(data.ledger.length)],
            ['Events', String(data.audit.events.length)],
        ].map(([label, value]) => `
            <div class="ai-ops-metric">
                <span>${this.escapeHtml(label)}</span>
                <strong>${this.escapeHtml(value)}</strong>
            </div>
        `).join('');
        const coverageRows = data.coverage.map((item) => `
            <div class="ai-ops-item ${this.escapeHtml(item.state)}">
                <strong>${this.escapeHtml(item.label)}</strong>
                <span>${this.escapeHtml(item.detail)}</span>
            </div>
        `).join('');
        const auditRows = data.audit.events.length > 0
            ? data.audit.events.slice(0, 5).map((event) => `
                <div class="ai-ops-item">
                    <strong>${this.escapeHtml(event.label)}</strong>
                    <span>${this.escapeHtml(event.detail)}</span>
                </div>
            `).join('')
            : '<div class="ai-ops-empty">No audit proof captured yet.</div>';

        this.evidenceGrid.innerHTML = `
            <div class="ai-ops-metrics">${metricRows}</div>
            <div class="ai-ops-columns">
                <section>
                    <span class="ai-grounding-kicker">Coverage</span>
                    ${coverageRows}
                </section>
                <section>
                    <span class="ai-grounding-kicker">Audit Proof</span>
                    ${auditRows}
                </section>
            </div>
        `;
    }

    async copyEvidencePack() {
        const text = this.buildCanvasEvidencePackText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied evidence pack', 'success', 'evidence');
            this.showStatus('Evidence pack copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for evidence pack', 'warning', 'evidence');
            this.showStatus('Clipboard unavailable for evidence pack.', 'error');
        }
    }

    addEvidencePackNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = this.buildCanvasEvidencePackText().slice(0, 1200);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `evidence-pack-${Date.now()}`,
            type: 'sticky',
            x: center.x + 390,
            y: center.y + 190,
            width: 330,
            height: 270,
            text,
            backgroundColor: '#f1f5f9',
            strokeColor: '#334155',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 14,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Arial',
            qaGenerated: true,
            healthRole: 'note',
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Evidence pack note', 'evidence', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable evidence pack note', 'success', 'evidence');
        this.showStatus('Added an evidence pack note.', 'success');
    }

    handleEvidencePackAction(action = '') {
        if (action === 'copy') {
            this.copyEvidencePack();
            return;
        }
        if (action === 'note') {
            this.addEvidencePackNote();
        }
    }

    buildReviewQueueData(context = this.buildCanvasContext()) {
        const ops = this.buildCanvasOpsSnapshotData(context);
        const gates = this.buildGateReviewData(context);
        const register = this.buildDecisionRegisterData(context);
        const recents = this.actionLedger
            .slice(0, 6)
            .map((entry) => String(entry?.text || '').trim())
            .filter(Boolean);
        const signals = [];

        gates.gates
            .filter((gate) => gate.state === 'fail' || gate.state === 'warn')
            .forEach((gate) => {
                signals.push({
                    priority: gate.state === 'fail' ? 'high' : 'medium',
                    kind: 'Gate',
                    text: `${gate.label}: ${gate.detail}`,
                });
            });

        register.risks.forEach((risk) => {
            signals.push({
                priority: 'high',
                kind: 'Risk',
                text: `${risk.text}`,
            });
        });

        register.actions.forEach((action) => {
            signals.push({
                priority: 'medium',
                kind: 'Action',
                text: `${action.text}`,
            });
        });

        register.decisions.forEach((decision) => {
            signals.push({
                priority: 'low',
                kind: 'Decision',
                text: `${decision.text}`,
            });
        });

        const orderedSignals = signals
            .slice(0, 12)
            .map((item) => ({
                ...item,
                state: item.priority === 'high' ? 'fail' : (item.priority === 'medium' ? 'warn' : 'pass'),
            }));

        const counts = orderedSignals.reduce((acc, signal) => {
            acc[signal.priority] = (acc[signal.priority] || 0) + 1;
            return acc;
        }, {});
        const total = orderedSignals.length;
        const verdict = counts.high > 0
            ? 'Needs immediate attention'
            : (counts.medium > 0 ? 'Needs review' : 'Ready');

        return {
            createdAt: new Date(),
            verdict,
            total,
            counts: {
                high: counts.high || 0,
                medium: counts.medium || 0,
                low: counts.low || 0,
            },
            signals: orderedSignals,
            recents,
            ops,
            gates,
            register,
        };
    }

    buildReviewQueueText(data = this.buildReviewQueueData()) {
        const formatItems = (items, formatter, fallback = '- None') => items.length > 0
            ? items.map((item, index) => `${index + 1}. ${formatter(item)}`)
            : [fallback];

        return [
            'KimiBuilt Canvas Review Queue',
            `Created: ${data.createdAt.toLocaleString()}`,
            `Verdict: ${data.verdict}`,
            `Objects: ${data.ops.context?.board?.objectCount || 0}`,
            `Selection: ${data.ops.context?.selection?.count || 0}`,
            `Total: ${data.total} item${data.total === 1 ? '' : 's'}`,
            `High: ${data.counts.high} / Medium: ${data.counts.medium} / Low: ${data.counts.low}`,
            '',
            'Queue:',
            ...formatItems(data.signals, (signal) => `[${signal.priority}] ${signal.kind}: ${signal.text}`),
            '',
            'Recent actions:',
            ...formatItems(data.recents, (item) => item, '- No recent board actions'),
        ].join('\n');
    }

    renderReviewQueue(context = this.buildCanvasContext()) {
        const data = this.buildReviewQueueData(context);
        this.lastReviewQueueText = this.buildReviewQueueText(data);

        if (this.reviewSummary) {
            this.reviewSummary.textContent = `${data.verdict} - ${data.counts.high}/${data.counts.medium}/${data.counts.low}`;
        }
        if (!this.reviewGrid) {
            return;
        }

        const metricRows = [
            ['High', String(data.counts.high)],
            ['Medium', String(data.counts.medium)],
            ['Low', String(data.counts.low)],
            ['Total', String(data.total)],
        ].map(([label, value]) => `
            <div class="ai-ops-metric">
                <span>${this.escapeHtml(label)}</span>
                <strong>${this.escapeHtml(value)}</strong>
            </div>
        `).join('');
        const signalRows = data.signals.length > 0
            ? data.signals.map((signal) => `
                <div class="ai-ops-item ${this.escapeHtml(signal.state)}">
                    <strong>${this.escapeHtml(signal.kind)}</strong>
                    <span>[${this.escapeHtml(signal.priority)}] ${this.escapeHtml(signal.text)}</span>
                </div>
            `).join('')
            : '<div class="ai-ops-empty">No review items queued.</div>';
        const recentRows = data.recents.length > 0
            ? data.recents.map((command) => `
                <div class="ai-ops-item">
                    <strong>Action</strong>
                    <span>${this.escapeHtml(command)}</span>
                </div>
            `).join('')
            : '<div class="ai-ops-empty">No recent board actions.</div>';

        this.reviewGrid.innerHTML = `
            <div class="ai-ops-metrics">${metricRows}</div>
            <div class="ai-ops-columns">
                <section>
                    <span class="ai-grounding-kicker">Queue</span>
                    ${signalRows}
                </section>
                <section>
                    <span class="ai-grounding-kicker">Recent actions</span>
                    ${recentRows}
                </section>
            </div>
        `;
    }

    async copyReviewQueue() {
        const text = this.lastReviewQueueText || this.buildReviewQueueText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied review queue', 'success', 'review');
            this.showStatus('Review queue copied.', 'success');
        } catch (_error) {
            this.recordActionLedger('Clipboard unavailable for review queue', 'warning', 'review');
            this.showStatus('Clipboard unavailable for review queue.', 'error');
        }
    }

    addReviewQueueNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = this.buildReviewQueueText().slice(0, 1050);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `review-queue-${Date.now()}`,
            type: 'sticky',
            x: center.x + 420,
            y: center.y + 20,
            width: 300,
            height: 240,
            text,
            backgroundColor: '#e0edff',
            strokeColor: '#2563eb',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 14,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Arial',
            qaGenerated: true,
            healthRole: 'note',
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Review queue note', 'review', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable review queue note', 'success', 'review');
        this.showStatus('Added a review queue note.', 'success');
    }

    handleReviewQueueAction(action = '') {
        if (action === 'copy') {
            this.copyReviewQueue();
            return;
        }
        if (action === 'note') {
            this.addReviewQueueNote();
        }
    }

    selectBoardIndexMatch(elementId = '') {
        const canvas = window.infiniteCanvas;
        if (!canvas || !elementId) {
            return;
        }
        const element = (canvas.elements || []).find((item) => item.id === elementId);
        if (!element) {
            this.recordActionLedger('Board index object was not found', 'warning', 'index');
            this.renderBoardIndex();
            return;
        }
        canvas.selectElements([element]);
        canvas.render();
        this.updateGroundingPanel();
        this.recordActionLedger(`Selected indexed object "${this.getBoardIndexLabel(element)}"`, 'success', 'index');
        this.showStatus('Selected board index match.', 'success');
    }

    selectBoardIndexMatches() {
        const canvas = window.infiniteCanvas;
        const matches = this.boardIndexMatches || [];
        if (!canvas || matches.length === 0) {
            this.recordActionLedger('No board index matches to select', 'warning', 'index');
            this.showStatus('No board index matches to select.', 'error');
            return;
        }
        canvas.selectElements(matches.map((match) => match.element));
        canvas.render();
        this.updateGroundingPanel();
        this.recordActionLedger(`Selected ${matches.length} board index match${matches.length === 1 ? '' : 'es'}`, 'success', 'index');
        this.showStatus(`Selected ${matches.length} board index match${matches.length === 1 ? '' : 'es'}.`, 'success');
    }

    handleBoardIndexAction(action = '', elementId = '') {
        if (action === 'clear') {
            if (this.boardIndexInput) {
                this.boardIndexInput.value = '';
            }
            this.renderBoardIndex('');
            return;
        }

        if (action === 'select-all') {
            this.selectBoardIndexMatches();
            return;
        }

        if (action === 'copy') {
            this.copyBoardIndexSummary();
            return;
        }

        if (action === 'select') {
            this.selectBoardIndexMatch(elementId);
        }
    }

    renderPinnedActions(context = this.buildCanvasContext()) {
        if (!this.pinboardSummary) {
            return;
        }
        const objectCount = context.board?.elementCount || 0;
        const selectedCount = context.selection?.count || 0;
        const healthScore = context.boardHealth?.objectCount > 0 ? context.boardHealth.score : '--';
        this.pinboardSummary.textContent = `${objectCount} objects - ${selectedCount} selected - score ${healthScore}`;
        this.pinboardSummary.title = 'Pinned actions reuse board brief, index, checkpoint, and audit workflows.';
    }

    handlePinnedBoardAction(action = '') {
        if (action === 'save-checkpoint') {
            const checkpoint = window.app?.saveCanvasCheckpoint?.();
            if (checkpoint) {
                this.recordActionLedger(`Saved checkpoint "${checkpoint.name}" from pinboard`, 'success', 'pinboard');
                this.renderCheckpoints();
                this.showStatus('Checkpoint saved.', 'success');
            }
            return;
        }

        if (action === 'refresh-audit') {
            this.handleHealthAction('refresh');
            return;
        }

        if (action === 'preview-fixes') {
            this.handleFixAction('preview');
            return;
        }

        if (action === 'copy-brief') {
            this.copyBoardBrief();
            return;
        }

        if (action === 'copy-index') {
            this.copyBoardIndexSummary();
            return;
        }

        if (action === 'copy-packet') {
            this.copyCanvasHandoffPacket();
            return;
        }

        if (action === 'qa-note') {
            this.addBoardQaNote();
            return;
        }

        this.recordActionLedger('Unknown pinned board action requested', 'warning', 'pinboard');
        this.showStatus('That pinned action is not available.', 'error');
    }

    async copyBoardBrief() {
        const text = this.lastBoardBriefText || this.buildBoardBriefText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied board brief', 'success', 'brief');
            this.showStatus('Board brief copied.', 'success');
        } catch {
            this.recordActionLedger('Clipboard unavailable for board brief', 'warning', 'brief');
            this.showStatus('Clipboard unavailable. Add the brief as a note instead.', 'error');
        }
    }

    addBoardBriefNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }

        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = (this.lastBoardBriefText || this.buildBoardBriefText()).slice(0, 900);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `brief-note-${Date.now()}`,
            type: 'sticky',
            x: center.x + 250,
            y: center.y + 50,
            width: 280,
            height: 210,
            text,
            backgroundColor: '#dbeafe',
            strokeColor: '#1d4ed8',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 15,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Virgil, cursive',
            qaGenerated: true,
            healthRole: 'note',
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Board brief note', 'brief', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable board brief note', 'success', 'brief');
        this.showStatus('Added a board brief note to the canvas.', 'success');
    }

    handleBoardBriefAction(action = '') {
        if (action === 'copy') {
            this.copyBoardBrief();
            return;
        }

        if (action === 'note') {
            this.addBoardBriefNote();
        }
    }

    handleBoardBriefNextAction(action = '') {
        if (action === 'starter-prompt') {
            this.setMode('chat');
            this.showPanel();
            if (this.input) {
                this.input.value = 'Create an enterprise-ready canvas starter with three labeled sections, decisions, risks, and next actions.';
                this.input.focus();
            }
            this.recordActionLedger('Loaded board starter prompt', 'success', 'brief');
            return;
        }

        if (action === 'qa-note') {
            this.addBoardQaNote();
            return;
        }

        if (action === 'select-fixes') {
            this.handleFixAction('select');
            return;
        }

        if (action === 'save-checkpoint') {
            this.handleCheckpointAction('save');
            this.updateGroundingPanel();
            return;
        }

        if (action === 'refresh-audit') {
            this.handleHealthAction('refresh');
            return;
        }

        if (action === 'brief-note') {
            this.addBoardBriefNote();
            return;
        }

        if (action === 'copy-brief') {
            this.copyBoardBrief();
        }
    }

    setupToolLaneControls() {
        // Legacy no-op: the active Canvas agent now uses a lean mode plan.
    }

    getSelectedToolLaneIds() {
        return [];
    }

    persistToolLaneSelection() {
        // Legacy no-op.
    }

    buildToolPlan(mode = this.mode) {
        const normalizedMode = mode === 'image'
            ? 'image'
            : (mode === 'diagram' ? 'diagram' : 'chat');
        const plannedTools = normalizedMode === 'image'
            ? ['image-generate']
            : (normalizedMode === 'diagram' ? ['graph-diagram'] : []);

        return {
            mode: normalizedMode,
            plannedTools,
            preferredTool: plannedTools[0] || null,
            executionProfile: 'lean-canvas',
            creationMode: normalizedMode === 'image' ? 'explicit-image-asset' : 'editable-object-actions',
            preferEditableObjects: normalizedMode !== 'image',
            avoidRasterSnapshots: normalizedMode !== 'image',
            allowedActions: normalizedMode === 'image'
                ? ['add image asset after explicit image generation']
                : ['add', 'add_many', 'update', 'update_many', 'delete', 'select'],
        };
    }

    buildAgentToolPlan(mode = this.mode) {
        const fullPlan = this.buildToolPlan(mode);
        const plannedTools = Array.isArray(fullPlan.plannedTools)
            ? fullPlan.plannedTools.filter((toolId) => toolId !== 'image-generate').slice(0, 4)
            : [];

        return {
            mode,
            plannedTools: mode === 'image' ? ['image-generate'] : plannedTools,
            preferredTool: mode === 'image' ? 'image-generate' : (plannedTools[0] || null),
            executionProfile: fullPlan.executionProfile || 'lean-canvas',
            preferEditableObjects: mode !== 'image',
            avoidRasterSnapshots: mode !== 'image',
        };
    }

    renderToolPlan() {
        const plan = this.buildToolPlan();
        if (this.toolPlanSummary) {
            this.toolPlanSummary.textContent = plan.mode === 'image'
                ? 'Image asset only'
                : (plan.mode === 'diagram' ? 'Editable object build' : 'Lean board read');
        }
        if (this.toolPlanPill) {
            this.toolPlanPill.textContent = plan.preferEditableObjects ? 'Object-first' : 'Image asset';
        }
        if (this.stateSummary) {
            const elementCount = window.infiniteCanvas?.elements?.length || 0;
            const lastRun = this.lastAgentRunAt ? `run ${new Date(this.lastAgentRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'ready';
            const actionText = this.lastAppliedActionCount > 0 ? `, ${this.lastAppliedActionCount} edits` : '';
            this.stateSummary.textContent = `${elementCount} objects, ${lastRun}${actionText}`;
        }
    }

    recordActionLedger(text, status = 'success', meta = '') {
        const entry = {
            text: String(text || '').trim() || 'Canvas action',
            status,
            meta: String(meta || '').trim(),
            createdAt: Date.now(),
        };
        this.actionLedger.unshift(entry);
        this.actionLedger = this.actionLedger.slice(0, 8);
        this.renderActionLedger();
    }

    renderActionLedger() {
        if (this.ledgerSummary) {
            const appliedCount = this.actionLedger.filter((entry) => entry.status === 'success').length;
            this.ledgerSummary.textContent = this.actionLedger.length > 0
                ? `${appliedCount}/${this.actionLedger.length} clean`
                : 'No actions yet';
        }

        if (!this.actionList) {
            return;
        }

        if (this.actionLedger.length === 0) {
            this.actionList.innerHTML = '<div class="ai-action-empty">Applied edits, local moves, and skipped actions will appear here.</div>';
            return;
        }

        this.actionList.innerHTML = this.actionLedger.map((entry) => {
            const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const status = ['success', 'warning', 'error'].includes(entry.status) ? entry.status : 'success';
            return `
                <div class="ai-action-item ${status}" title="${this.escapeHtml(entry.text)}">
                    <span class="ai-action-dot"></span>
                    <span class="ai-action-text">${this.escapeHtml(entry.text)}</span>
                    <span class="ai-action-meta">${this.escapeHtml(entry.meta || time)}</span>
                </div>
            `;
        }).join('');
    }

    buildCanvasAuditData(context = this.buildCanvasContext()) {
        const checkpoints = window.app?.loadCanvasCheckpoints?.() || [];
        const ledgerEvents = this.actionLedger.map((entry) => ({
            kind: 'ledger',
            label: entry.text,
            detail: entry.meta || entry.status,
            state: entry.status || 'success',
            createdAt: entry.createdAt,
        }));
        const changeEvents = this.changeSets.map((entry) => ({
            kind: 'change',
            label: entry.label,
            detail: `${entry.changedIds.length} object${entry.changedIds.length === 1 ? '' : 's'} changed from ${entry.source}`,
            state: 'success',
            createdAt: entry.createdAt,
        }));
        const checkpointEvents = checkpoints.slice(0, 4).map((checkpoint) => ({
            kind: 'checkpoint',
            label: checkpoint.name || 'Board checkpoint',
            detail: `${Number(checkpoint.elementCount || checkpoint.elements?.length || 0)} object snapshot`,
            state: 'success',
            createdAt: checkpoint.createdAt ? new Date(checkpoint.createdAt).getTime() : Date.now(),
        }));

        return {
            createdAt: new Date(),
            board: context.board,
            selection: context.selection,
            healthScore: context.boardHealth?.objectCount > 0 ? context.boardHealth.score : null,
            checkpoints: checkpoints.length,
            events: [...ledgerEvents, ...changeEvents, ...checkpointEvents]
                .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
                .slice(0, 14),
        };
    }

    buildCanvasAuditText(data = this.buildCanvasAuditData()) {
        const lines = [
            'Lilly Canvas Audit Trail',
            `Created: ${data.createdAt.toLocaleString()}`,
            `Objects: ${data.board?.elementCount || 0}`,
            `Types: ${data.board?.typeCounts || 'None'}`,
            `Selection: ${data.selection?.count || 0}`,
            `Health score: ${data.healthScore ?? '--'}`,
            `Checkpoints: ${data.checkpoints}`,
            '',
            'Events:',
            ...(data.events.length > 0
                ? data.events.map((event) => {
                    const time = event.createdAt ? new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--';
                    return `- [${event.kind}] ${time} ${event.label}: ${event.detail}`;
                })
                : ['- No action events captured yet.']),
        ];

        return lines.join('\n');
    }

    async copyCanvasAudit() {
        const text = this.buildCanvasAuditText();
        try {
            await navigator.clipboard.writeText(text);
            this.recordActionLedger('Copied canvas audit trail', 'success', 'audit');
            this.showStatus('Canvas audit copied.', 'success');
        } catch {
            this.recordActionLedger('Clipboard unavailable for canvas audit', 'warning', 'audit');
            this.showStatus('Clipboard unavailable. Add the audit as a note instead.', 'error');
        }
    }

    addCanvasAuditNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }

        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const text = this.buildCanvasAuditText().slice(0, 1000);
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `audit-note-${Date.now()}`,
            type: 'sticky',
            x: center.x + 260,
            y: center.y + 60,
            width: 300,
            height: 230,
            text,
            backgroundColor: '#e0f2fe',
            strokeColor: '#0369a1',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 14,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Virgil, cursive',
            qaGenerated: true,
            healthRole: 'note',
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Canvas audit note', 'audit', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable canvas audit note', 'success', 'audit');
        this.showStatus('Added a canvas audit note.', 'success');
    }

    handleCanvasAuditAction(action = '') {
        if (action === 'copy') {
            this.copyCanvasAudit();
            return;
        }

        if (action === 'note') {
            this.addCanvasAuditNote();
        }
    }

    cloneElementForChangeSet(element) {
        if (!element || typeof element !== 'object') {
            return element;
        }

        const clone = {};
        Object.entries(element).forEach(([key, value]) => {
            if (key === 'imageElement') {
                return;
            }

            if (Array.isArray(value)) {
                clone[key] = value.map((entry) => {
                    if (entry && typeof entry === 'object') {
                        return { ...entry };
                    }
                    return entry;
                });
                return;
            }

            if (value && typeof value === 'object') {
                clone[key] = { ...value };
                return;
            }

            clone[key] = value;
        });

        if (element.imageElement) {
            clone.imageElement = element.imageElement;
        }

        return clone;
    }

    cloneElementsForChangeSet(elements = []) {
        return (Array.isArray(elements) ? elements : []).map((element) => this.cloneElementForChangeSet(element));
    }

    sortSerializableValue(value) {
        if (Array.isArray(value)) {
            return value.map((entry) => this.sortSerializableValue(entry));
        }

        if (value && typeof value === 'object') {
            return Object.keys(value)
                .filter((key) => key !== 'imageElement')
                .sort()
                .reduce((acc, key) => {
                    acc[key] = this.sortSerializableValue(value[key]);
                    return acc;
                }, {});
        }

        return value;
    }

    getElementsSignature(elements = []) {
        const serializable = (Array.isArray(elements) ? elements : []).map((element) => this.sortSerializableValue(element));
        return JSON.stringify(serializable);
    }

    computeChangedElementIds(beforeElements = [], afterElements = []) {
        const beforeById = new Map(beforeElements.map((element) => [element.id, this.getElementsSignature([element])]));
        const afterById = new Map(afterElements.map((element) => [element.id, this.getElementsSignature([element])]));
        const changedIds = new Set();

        afterById.forEach((signature, id) => {
            if (!beforeById.has(id) || beforeById.get(id) !== signature) {
                changedIds.add(id);
            }
        });
        beforeById.forEach((signature, id) => {
            if (!afterById.has(id)) {
                changedIds.add(id);
            }
        });

        return Array.from(changedIds);
    }

    recordChangeSet(label, source, beforeElements, afterElements, explicitChangedIds = []) {
        const before = this.cloneElementsForChangeSet(beforeElements);
        const after = this.cloneElementsForChangeSet(afterElements);
        const changedIds = explicitChangedIds.length > 0
            ? Array.from(new Set(explicitChangedIds))
            : this.computeChangedElementIds(before, after);

        if (changedIds.length === 0 && before.length === after.length) {
            return null;
        }

        const changeSet = {
            id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            label: String(label || 'Canvas change').trim(),
            source: String(source || 'agent').trim(),
            changedIds,
            before,
            after,
            afterSignature: this.getElementsSignature(after),
            createdAt: Date.now(),
        };

        this.changeSets.unshift(changeSet);
        this.changeSets = this.changeSets.slice(0, 6);
        this.renderChangeSets();
        return changeSet;
    }

    renderChangeSets() {
        if (this.changeSetSummary) {
            const latest = this.changeSets[0];
            this.changeSetSummary.textContent = latest
                ? `${latest.changedIds.length} changed, ${latest.source}`
                : 'No reversible edits yet';
        }

        if (!this.changeSetList) {
            return;
        }

        if (this.changeSets.length === 0) {
            this.changeSetList.innerHTML = '<div class="ai-action-empty">AI and board-fix edits will appear here.</div>';
            return;
        }

        const currentSignature = this.getElementsSignature(window.infiniteCanvas?.elements || []);
        this.changeSetList.innerHTML = this.changeSets.map((entry, index) => {
            const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isLatest = index === 0;
            const canUndo = isLatest && currentSignature === entry.afterSignature;
            const statusClass = isLatest && !canUndo ? 'blocked' : '';
            const meta = canUndo ? `${entry.changedIds.length} objects` : (isLatest ? 'changed since' : time);
            return `
                <div class="ai-change-set-item ${statusClass}" title="${this.escapeHtml(entry.label)}">
                    <span class="ai-change-set-dot"></span>
                    <span class="ai-change-set-text">${this.escapeHtml(entry.label)}</span>
                    <span class="ai-change-set-meta">${this.escapeHtml(meta)}</span>
                </div>
            `;
        }).join('');
    }

    handleChangeSetAction(action) {
        if (action === 'undo') {
            this.undoLastChangeSet();
            return;
        }

        if (action === 'select') {
            this.selectLastChangeSet();
        }
    }

    undoLastChangeSet() {
        const canvas = window.infiniteCanvas;
        const changeSet = this.changeSets[0];
        if (!canvas || !changeSet) {
            this.recordActionLedger('No change set to undo', 'warning', 'change');
            this.showStatus('No reversible change set is available.', 'error');
            return;
        }

        const currentSignature = this.getElementsSignature(canvas.elements || []);
        if (currentSignature !== changeSet.afterSignature) {
            this.renderChangeSets();
            this.recordActionLedger('Skipped undo because the board changed', 'warning', 'change');
            this.showStatus('The board changed after that edit. Use the normal history controls instead.', 'error');
            return;
        }

        canvas.elements = this.cloneElementsForChangeSet(changeSet.before);
        canvas.deselectAll();
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.changeSets.shift();
        this.renderChangeSets();
        this.updateGroundingPanel();
        this.recordActionLedger(`Undid ${changeSet.label}`, 'success', 'change');
        this.showStatus('Undid the last AI change set.', 'success');
    }

    selectLastChangeSet() {
        const canvas = window.infiniteCanvas;
        const changeSet = this.changeSets[0];
        if (!canvas || !changeSet) {
            this.recordActionLedger('No change set to select', 'warning', 'change');
            this.showStatus('No change set is available to select.', 'error');
            return;
        }

        const changed = (canvas.elements || []).filter((element) => changeSet.changedIds.includes(element.id));
        if (changed.length === 0) {
            this.recordActionLedger('Change set objects are no longer present', 'warning', 'change');
            this.showStatus('Those changed objects are no longer on the board.', 'error');
            return;
        }

        canvas.selectElements(changed);
        this.updateGroundingPanel();
        this.recordActionLedger(`Selected ${changed.length} changed objects`, 'success', 'change');
        this.showStatus(`Selected ${changed.length} changed object${changed.length === 1 ? '' : 's'}.`, 'success');
    }

    renderBoardHealth(health = null) {
        if (!health) {
            health = this.analyzeCanvasHealth(window.infiniteCanvas?.elements || []);
        }

        if (this.healthSummary) {
            this.healthSummary.textContent = health.objectCount > 0
                ? `${health.objectCount} objects, ${health.connectorCount} connectors`
                : 'No board audit yet';
        }

        if (this.healthScore) {
            this.healthScore.textContent = health.objectCount > 0 ? `${health.score}` : '--';
            this.healthScore.classList.toggle('warning', health.objectCount > 0 && health.score < 76 && health.score >= 50);
            this.healthScore.classList.toggle('error', health.objectCount > 0 && health.score < 50);
        }

        if (!this.healthList) {
            return;
        }

        if (!Array.isArray(health.issues) || health.issues.length === 0) {
            this.healthList.innerHTML = '<div class="ai-health-empty">Select objects or build a board to see structure signals.</div>';
            return;
        }

        this.healthList.innerHTML = health.issues.map((issue) => {
            const severity = ['good', 'warning', 'error'].includes(issue.severity) ? issue.severity : 'warning';
            return `<div class="ai-health-item ${severity}"><span>${this.escapeHtml(issue.text)}</span></div>`;
        }).join('');

        this.renderFixPlan(this.buildHealthFixPlan(health, window.infiniteCanvas?.elements || []));
    }

    buildHealthFixPlan(health = null, elements = []) {
        const canvas = window.infiniteCanvas;
        const objects = Array.isArray(elements) ? elements : [];
        const ignoredHealthRoles = new Set(['annotation', 'connector', 'container', 'layout', 'note']);
        const nodes = objects.filter((element) => element
            && !element.qaGenerated
            && !ignoredHealthRoles.has(element.healthRole)
            && !['line', 'arrow', 'freedraw', 'frame'].includes(element.type));
        const fixes = [];
        const actions = [];

        if (!health) {
            health = this.analyzeCanvasHealth(objects);
        }

        const unlabeled = nodes.filter((element) => health.unlabeledIds?.includes(element.id));
        if (unlabeled.length > 0) {
            fixes.push({
                id: 'label-unlabeled',
                title: `Label ${unlabeled.length} object${unlabeled.length === 1 ? '' : 's'}`,
                count: unlabeled.length,
                targetIds: unlabeled.map((element) => element.id),
            });
            actions.push({
                type: 'update_many',
                patches: unlabeled.map((element, index) => ({
                    id: element.id,
                    patch: {
                        text: this.suggestLabelForElement(element, index),
                        fontSize: element.fontSize || 18,
                    },
                })),
            });
        }

        const disconnected = nodes
            .filter((element) => health.disconnectedIds?.includes(element.id))
            .sort((a, b) => (Number(a.x) || 0) - (Number(b.x) || 0) || (Number(a.y) || 0) - (Number(b.y) || 0));
        if (disconnected.length > 1) {
            const arrows = [];
            for (let index = 0; index < disconnected.length - 1; index += 1) {
                arrows.push(this.buildArrowBetweenElements(disconnected[index], disconnected[index + 1]));
            }
            fixes.push({
                id: 'connect-disconnected',
                title: `Connect ${disconnected.length} objects`,
                count: arrows.length,
                targetIds: disconnected.map((element) => element.id),
            });
            actions.push({ type: 'add_many', elements: arrows });
        }

        if (nodes.length > 4 && health.frameCount === 0 && canvas) {
            const frame = this.buildFrameForElements(nodes, 'Main flow');
            if (frame) {
                fixes.push({
                    id: 'frame-board',
                    title: 'Frame main flow',
                    count: nodes.length,
                    targetIds: nodes.map((element) => element.id),
                });
                actions.push({ type: 'add', element: frame });
            }
        }

        return { fixes, actions };
    }

    renderFixPlan(plan = { fixes: [], actions: [] }) {
        this.pendingFixPlan = plan;
        const fixes = Array.isArray(plan.fixes) ? plan.fixes : [];

        if (this.fixSummary) {
            this.fixSummary.textContent = fixes.length > 0
                ? `${fixes.length} fix${fixes.length === 1 ? '' : 'es'} ready`
                : 'No fixes queued';
        }

        if (!this.fixList) {
            return;
        }

        if (fixes.length === 0) {
            this.fixList.innerHTML = '<div class="ai-health-empty">Board audit suggestions will appear here.</div>';
            return;
        }

        this.fixList.innerHTML = fixes.map((fix) => `
            <div class="ai-fix-item" title="${this.escapeHtml(fix.targetIds?.join(', ') || '')}">
                <span class="ai-fix-title">${this.escapeHtml(fix.title)}</span>
                <span class="ai-fix-count">${this.escapeHtml(String(fix.count || 0))}</span>
            </div>
        `).join('');
    }

    suggestLabelForElement(element = {}, index = 0) {
        const type = String(element.type || 'object');
        const labels = {
            rectangle: 'Step',
            diamond: 'Decision',
            ellipse: 'Start / End',
            sticky: 'Note',
            text: 'Label',
            image: 'Image',
        };
        const base = labels[type] || type.charAt(0).toUpperCase() + type.slice(1);
        return `${base} ${index + 1}`;
    }

    buildArrowBetweenElements(from = {}, to = {}) {
        const fromBounds = this.getElementBounds(from);
        const toBounds = this.getElementBounds(to);
        const horizontal = Math.abs((Number(to.x) || 0) - (Number(from.x) || 0)) >= Math.abs((Number(to.y) || 0) - (Number(from.y) || 0));
        const start = horizontal
            ? { x: fromBounds.right + 8, y: (fromBounds.top + fromBounds.bottom) / 2 }
            : { x: (fromBounds.left + fromBounds.right) / 2, y: fromBounds.bottom + 8 };
        const end = horizontal
            ? { x: toBounds.left - 8, y: (toBounds.top + toBounds.bottom) / 2 }
            : { x: (toBounds.left + toBounds.right) / 2, y: toBounds.top - 8 };

        return {
            type: 'arrow',
            points: [start, end],
            strokeColor: window.toolManager?.defaultProperties?.strokeColor || '#1e1e1e',
            backgroundColor: 'transparent',
            strokeWidth: Math.max(2, window.toolManager?.defaultProperties?.strokeWidth || 2),
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
        };
    }

    buildFrameForElements(elements = [], label = 'Frame') {
        if (!Array.isArray(elements) || elements.length === 0) {
            return null;
        }

        const bounds = elements.map((element) => this.getElementBounds(element));
        const minLeft = Math.min(...bounds.map((entry) => entry.left));
        const maxRight = Math.max(...bounds.map((entry) => entry.right));
        const minTop = Math.min(...bounds.map((entry) => entry.top));
        const maxBottom = Math.max(...bounds.map((entry) => entry.bottom));
        const padding = 44;

        return {
            type: 'frame',
            x: (minLeft + maxRight) / 2,
            y: (minTop + maxBottom) / 2,
            width: Math.max(180, maxRight - minLeft + padding * 2),
            height: Math.max(140, maxBottom - minTop + padding * 2),
            text: label,
            strokeColor: '#0f766e',
            backgroundColor: 'transparent',
            strokeWidth: 2,
            strokeStyle: 'dashed',
            roughness: 1,
            opacity: 1,
        };
    }

    getTemplateCenter() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return { x: 0, y: 0 };
        }

        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas?.clientWidth || canvas.canvas?.width || 900) / 2,
            y: (canvas.canvas?.clientHeight || canvas.canvas?.height || 600) / 2,
        };
        return canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
    }

    buildTemplateElement(type, x, y, width, height, text = '', options = {}) {
        return {
            type,
            x,
            y,
            width,
            height,
            text,
            strokeColor: options.strokeColor || '#1e293b',
            backgroundColor: options.backgroundColor || '#ffffff',
            strokeWidth: options.strokeWidth || 2,
            strokeStyle: options.strokeStyle || 'solid',
            roughness: options.roughness ?? 1,
            opacity: options.opacity ?? 1,
            fontSize: options.fontSize || 18,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Virgil, cursive',
            smartTemplate: options.smartTemplate || true,
            healthRole: options.healthRole || '',
        };
    }

    buildTemplateArrow(start, end, options = {}) {
        return {
            type: 'arrow',
            points: [start, end],
            strokeColor: options.strokeColor || '#334155',
            backgroundColor: 'transparent',
            strokeWidth: options.strokeWidth || 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            smartTemplate: true,
            healthRole: 'connector',
        };
    }

    buildSmartTemplate(templateId = '') {
        const center = this.getTemplateCenter();
        const x = center.x;
        const y = center.y;
        const labelBase = {
            'decision-flow': 'Decision flow',
            'journey-map': 'Journey map',
            wireframe: 'Wireframe',
            retro: 'Retro board',
        }[templateId] || '';

        if (!labelBase) {
            return null;
        }

        const frameOptions = {
            strokeColor: '#0f766e',
            backgroundColor: 'transparent',
            strokeStyle: 'dashed',
            fontSize: 20,
            healthRole: 'container',
        };
        const nodeOptions = {
            strokeColor: '#1d4ed8',
            backgroundColor: '#eff6ff',
            healthRole: 'node',
        };
        const accentOptions = {
            strokeColor: '#7c2d12',
            backgroundColor: '#fff7ed',
            healthRole: 'node',
        };
        const noteOptions = {
            strokeColor: '#854d0e',
            backgroundColor: '#fef3c7',
            fontSize: 16,
            healthRole: 'note',
        };
        const elements = [];

        if (templateId === 'decision-flow') {
            elements.push(
                this.buildTemplateElement('frame', x, y, 850, 330, 'Decision Flow', frameOptions),
                this.buildTemplateElement('ellipse', x - 320, y, 130, 76, 'Start', { strokeColor: '#166534', backgroundColor: '#ecfdf3' }),
                this.buildTemplateElement('rectangle', x - 120, y, 150, 82, 'Gather context', nodeOptions),
                this.buildTemplateElement('diamond', x + 100, y, 138, 104, 'Decision', accentOptions),
                this.buildTemplateElement('rectangle', x + 320, y - 70, 150, 82, 'Path A', nodeOptions),
                this.buildTemplateElement('rectangle', x + 320, y + 70, 150, 82, 'Path B', nodeOptions),
                this.buildTemplateElement('sticky', x + 95, y + 145, 210, 86, 'AI note\nDefine the decision criteria.', noteOptions),
                this.buildTemplateArrow({ x: x - 250, y }, { x: x - 195, y }),
                this.buildTemplateArrow({ x: x - 45, y }, { x: x + 30, y }),
                this.buildTemplateArrow({ x: x + 168, y: y - 24 }, { x: x + 245, y: y - 70 }),
                this.buildTemplateArrow({ x: x + 168, y: y + 24 }, { x: x + 245, y: y + 70 }),
            );
        }

        if (templateId === 'journey-map') {
            const stages = ['Discover', 'Compare', 'Try', 'Decide', 'Return'];
            elements.push(this.buildTemplateElement('frame', x, y, 980, 430, 'Journey Map', frameOptions));
            stages.forEach((stage, index) => {
                const sx = x - 380 + index * 190;
                elements.push(
                    this.buildTemplateElement('rectangle', sx, y - 80, 142, 76, stage, nodeOptions),
                    this.buildTemplateElement('sticky', sx, y + 70, 150, 96, `Signal\n${index + 1}. Replace with evidence`, noteOptions),
                );
                if (index < stages.length - 1) {
                    elements.push(this.buildTemplateArrow({ x: sx + 75, y: y - 80 }, { x: sx + 115, y: y - 80 }));
                }
            });
            elements.push(this.buildTemplateElement('text', x, y + 180, 520, 52, 'AI pass: ask for pain points, opportunities, and missing evidence.', { strokeColor: '#334155', backgroundColor: 'transparent', fontSize: 18, healthRole: 'note' }));
        }

        if (templateId === 'wireframe') {
            const layoutOptions = { strokeColor: '#334155', backgroundColor: '#f8fafc', healthRole: 'layout' };
            elements.push(
                this.buildTemplateElement('frame', x, y, 900, 520, 'Product Wireframe', frameOptions),
                this.buildTemplateElement('rectangle', x, y - 185, 720, 58, 'Header / navigation', layoutOptions),
                this.buildTemplateElement('rectangle', x - 145, y - 20, 420, 250, 'Primary workspace', { ...nodeOptions, healthRole: 'layout' }),
                this.buildTemplateElement('rectangle', x + 260, y - 20, 260, 250, 'AI panel', { strokeColor: '#7c3aed', backgroundColor: '#f5f3ff', healthRole: 'layout' }),
                this.buildTemplateElement('rectangle', x - 145, y + 150, 420, 56, 'Contextual toolbar', { strokeColor: '#166534', backgroundColor: '#ecfdf3', healthRole: 'layout' }),
                this.buildTemplateElement('sticky', x + 260, y + 150, 260, 86, 'Agent hooks\n- Inspect selection\n- Apply object actions\n- Undo change set', noteOptions),
            );
        }

        if (templateId === 'retro') {
            const columns = [
                ['Worked', '#ecfdf3', '#166534'],
                ['Stuck', '#fef2f2', '#991b1b'],
                ['Try next', '#eff6ff', '#1d4ed8'],
                ['Questions', '#fef3c7', '#854d0e'],
            ];
            elements.push(this.buildTemplateElement('frame', x, y, 920, 410, 'Retro Board', frameOptions));
            columns.forEach(([title, backgroundColor, strokeColor], index) => {
                const sx = x - 330 + index * 220;
                elements.push(
                    this.buildTemplateElement('rectangle', sx, y - 110, 180, 52, title, { strokeColor, backgroundColor, fontSize: 20, healthRole: 'layout' }),
                    this.buildTemplateElement('sticky', sx, y - 20, 170, 92, 'Add note', { strokeColor, backgroundColor, fontSize: 17, healthRole: 'note' }),
                    this.buildTemplateElement('sticky', sx, y + 90, 170, 92, 'Ask AI to cluster', { strokeColor, backgroundColor, fontSize: 17, healthRole: 'note' }),
                );
            });
        }

        return {
            id: templateId,
            label: labelBase,
            elements,
        };
    }

    handleTemplateAction(templateId = '') {
        const template = this.buildSmartTemplate(templateId);
        if (!template || !Array.isArray(template.elements) || template.elements.length === 0) {
            this.recordActionLedger('Unknown smart start requested', 'warning', 'template');
            this.showStatus('That smart start is not available.', 'error');
            return;
        }

        const applied = this.applyCanvasActions(
            {
                message: `Inserted ${template.label}.`,
                actions: [{ type: 'add_many', elements: template.elements }],
            },
            {
                label: `Smart start: ${template.label}`,
                source: 'template',
            },
        );

        if (applied > 0) {
            this.scope = 'selection';
            if (this.templateSummary) {
                this.templateSummary.textContent = template.label;
            }
            this.recordActionLedger(`Inserted ${template.label}`, 'success', 'template');
            this.showStatus(`Inserted ${template.label} as editable canvas objects.`, 'success');
            this.updateGroundingPanel();
        } else {
            this.recordActionLedger(`Skipped ${template.label}`, 'warning', 'template');
            this.showStatus('No template objects were inserted.', 'error');
        }
    }

    getOrganizerCandidates() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        const source = selected.length >= 2 ? selected : (canvas?.elements || []);
        const allowedTypes = new Set(['sticky', 'text', 'rectangle', 'diamond', 'ellipse']);

        return source
            .filter((element) => element
                && allowedTypes.has(element.type)
                && !['layout', 'container', 'connector'].includes(element.healthRole)
                && String(element.text || element.name || '').trim().length > 0)
            .slice(0, 24);
    }

    categorizeOrganizerText(text = '') {
        const normalized = String(text || '').toLowerCase();
        const groups = [
            {
                id: 'customer',
                label: 'Customer',
                color: ['#eff6ff', '#1d4ed8'],
                keywords: ['customer', 'user', 'client', 'buyer', 'feedback', 'support', 'persona', 'journey'],
            },
            {
                id: 'risk',
                label: 'Risks',
                color: ['#fef2f2', '#991b1b'],
                keywords: ['risk', 'blocked', 'blocker', 'issue', 'bug', 'fail', 'problem', 'concern', 'security'],
            },
            {
                id: 'action',
                label: 'Actions',
                color: ['#ecfdf3', '#166534'],
                keywords: ['todo', 'task', 'action', 'next', 'ship', 'build', 'fix', 'launch', 'follow up'],
            },
            {
                id: 'idea',
                label: 'Ideas',
                color: ['#f5f3ff', '#6d28d9'],
                keywords: ['idea', 'maybe', 'could', 'experiment', 'concept', 'option', 'brainstorm'],
            },
            {
                id: 'question',
                label: 'Questions',
                color: ['#fef3c7', '#854d0e'],
                keywords: ['?', 'question', 'why', 'how', 'what', 'unclear', 'unknown', 'decide'],
            },
        ];

        const found = groups.find((group) => group.keywords.some((keyword) => normalized.includes(keyword)));
        return found || {
            id: 'theme',
            label: 'Theme',
            color: ['#f8fafc', '#334155'],
            keywords: [],
        };
    }

    buildOrganizerClusters(candidates = []) {
        const byId = new Map();
        candidates.forEach((element) => {
            const category = this.categorizeOrganizerText(element.text || element.name || '');
            const key = category.id;
            if (!byId.has(key)) {
                byId.set(key, {
                    id: key,
                    label: category.label,
                    backgroundColor: category.color[0],
                    strokeColor: category.color[1],
                    items: [],
                });
            }
            byId.get(key).items.push(element);
        });

        const sorted = Array.from(byId.values())
            .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

        if (sorted.length <= 4) {
            return sorted;
        }

        const kept = sorted.slice(0, 3);
        const merged = sorted.slice(3).reduce((acc, cluster) => {
            acc.items.push(...cluster.items);
            return acc;
        }, {
            id: 'other',
            label: 'Other',
            backgroundColor: '#f8fafc',
            strokeColor: '#334155',
            items: [],
        });

        return [...kept, merged];
    }

    buildClusterActions(clusters = []) {
        const center = this.getTemplateCenter();
        const columnWidth = 220;
        const columnGap = 42;
        const rowGap = 118;
        const startX = center.x - ((clusters.length - 1) * (columnWidth + columnGap)) / 2;
        const startY = center.y - 180;
        const actions = [];
        const added = [];
        const patches = [];

        clusters.forEach((cluster, clusterIndex) => {
            const columnX = startX + clusterIndex * (columnWidth + columnGap);
            const itemCount = cluster.items.length;
            const frameHeight = Math.max(250, 120 + itemCount * rowGap);
            added.push(
                this.buildTemplateElement('frame', columnX, startY + frameHeight / 2 - 18, columnWidth + 44, frameHeight, cluster.label, {
                    strokeColor: cluster.strokeColor,
                    backgroundColor: 'transparent',
                    strokeStyle: 'dashed',
                    healthRole: 'container',
                    fontSize: 18,
                }),
                this.buildTemplateElement('rectangle', columnX, startY - 42, columnWidth, 50, `${cluster.label} (${itemCount})`, {
                    strokeColor: cluster.strokeColor,
                    backgroundColor: cluster.backgroundColor,
                    healthRole: 'layout',
                    fontSize: 18,
                }),
            );

            cluster.items.forEach((element, itemIndex) => {
                patches.push({
                    id: element.id,
                    patch: {
                        x: columnX,
                        y: startY + 52 + itemIndex * rowGap,
                        width: Math.max(160, Math.min(190, Number(element.width) || 170)),
                        height: Math.max(78, Math.min(110, Number(element.height) || 92)),
                        backgroundColor: cluster.backgroundColor,
                        strokeColor: cluster.strokeColor,
                        healthRole: 'note',
                        smartTemplate: false,
                    },
                });
            });

            const preview = cluster.items
                .slice(0, 3)
                .map((element) => String(element.text || element.name || '').split('\n')[0].slice(0, 34))
                .filter(Boolean);
            added.push(this.buildTemplateElement('sticky', columnX, startY + frameHeight - 18, columnWidth, 88, `AI summary\n${preview.join('\n') || 'Review this cluster.'}`, {
                strokeColor: cluster.strokeColor,
                backgroundColor: cluster.backgroundColor,
                healthRole: 'note',
                fontSize: 15,
            }));
        });

        if (patches.length > 0) {
            actions.push({ type: 'update_many', patches });
        }
        if (added.length > 0) {
            actions.push({ type: 'add_many', elements: added });
        }

        return actions;
    }

    organizeNoteClusters() {
        const candidates = this.getOrganizerCandidates();
        if (candidates.length < 2) {
            this.recordActionLedger('Organizer needs at least two text notes', 'warning', 'organizer');
            this.showStatus('Select two or more notes, or add text notes to the board first.', 'error');
            return;
        }

        const clusters = this.buildOrganizerClusters(candidates);
        const actions = this.buildClusterActions(clusters);
        const applied = this.applyCanvasActions(
            {
                message: `Organized ${candidates.length} notes into ${clusters.length} cluster${clusters.length === 1 ? '' : 's'}.`,
                actions,
            },
            {
                label: `Clustered ${candidates.length} notes`,
                source: 'organizer',
            },
        );

        if (applied > 0) {
            if (this.organizerSummary) {
                this.organizerSummary.textContent = `${clusters.length} clusters`;
            }
            this.scope = 'selection';
            this.recordActionLedger(`Clustered ${candidates.length} notes`, 'success', 'organizer');
            this.showStatus(`Clustered ${candidates.length} notes into editable groups.`, 'success');
            this.updateGroundingPanel();
        }
    }

    extractOrganizerActions() {
        const candidates = this.getOrganizerCandidates();
        if (candidates.length === 0) {
            this.recordActionLedger('No note text for task extraction', 'warning', 'organizer');
            this.showStatus('Add or select notes with text before extracting tasks.', 'error');
            return;
        }

        const center = this.getTemplateCenter();
        const x = center.x + 340;
        const y = center.y - 50;
        const taskTexts = candidates.slice(0, 6).map((element, index) => {
            const text = String(element.text || element.name || '').replace(/\s+/g, ' ').trim();
            return `${index + 1}. ${text.slice(0, 72)}${text.length > 72 ? '...' : ''}`;
        });
        const elements = [
            this.buildTemplateElement('frame', x, y + 95, 330, 330, 'Action Plan', {
                strokeColor: '#166534',
                backgroundColor: 'transparent',
                strokeStyle: 'dashed',
                healthRole: 'container',
                fontSize: 20,
            }),
            this.buildTemplateElement('sticky', x, y - 35, 280, 116, `Next actions\n${taskTexts.slice(0, 3).join('\n')}`, {
                strokeColor: '#166534',
                backgroundColor: '#ecfdf3',
                healthRole: 'note',
                fontSize: 15,
            }),
            this.buildTemplateElement('sticky', x, y + 105, 280, 116, `Follow-up\n${taskTexts.slice(3).join('\n') || 'Ask AI to assign owners and dates.'}`, {
                strokeColor: '#854d0e',
                backgroundColor: '#fef3c7',
                healthRole: 'note',
                fontSize: 15,
            }),
            this.buildTemplateElement('rectangle', x, y + 230, 280, 52, 'Ask: assign owners, dates, and risks', {
                strokeColor: '#1d4ed8',
                backgroundColor: '#eff6ff',
                healthRole: 'layout',
                fontSize: 16,
            }),
        ];

        const applied = this.applyCanvasActions(
            {
                message: `Extracted tasks from ${candidates.length} notes.`,
                actions: [{ type: 'add_many', elements }],
            },
            {
                label: `Extracted ${Math.min(candidates.length, 6)} tasks`,
                source: 'organizer',
            },
        );

        if (applied > 0) {
            if (this.organizerSummary) {
                this.organizerSummary.textContent = `${Math.min(candidates.length, 6)} tasks`;
            }
            this.scope = 'selection';
            this.recordActionLedger(`Extracted tasks from ${candidates.length} notes`, 'success', 'organizer');
            this.showStatus('Created an editable action plan from the notes.', 'success');
            this.updateGroundingPanel();
        }
    }

    handleOrganizerAction(action = '') {
        if (action === 'cluster-notes') {
            this.organizeNoteClusters();
            return;
        }

        if (action === 'extract-actions') {
            this.extractOrganizerActions();
            return;
        }

        this.recordActionLedger('Unknown organizer action requested', 'warning', 'organizer');
        this.showStatus('That organizer action is not available.', 'error');
    }

    escapeHtml(value = '') {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
            this.prepareOpenPanelScroll();
        }
    }

    showPanel() {
        document.getElementById('toolbar')?.classList.remove('active');
        document.getElementById('propertiesPanel')?.classList.remove('active');
        if (!this.panel?.classList.contains('active')) {
            this.panel?.classList.add('active');
        }
        this.prepareOpenPanelScroll();
    }

    prepareOpenPanelScroll() {
        const content = this.panel?.querySelector('.ai-panel-content');
        if (content) {
            content.scrollTop = 0;
        }
        if (this.input) {
            try {
                this.input.focus({ preventScroll: true });
            } catch (_error) {
                this.input.focus();
            }
        }
        requestAnimationFrame(() => {
            if (content) {
                content.scrollTop = 0;
            }
        });
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
            text: String(element.text || '').slice(0, 180),
            name: String(element.name || element.title || '').slice(0, 80),
            strokeColor: element.strokeColor,
            backgroundColor: element.backgroundColor,
            canvasRole: element.canvasRole || element.healthRole || '',
        };

        if (Array.isArray(element.points)) {
            clone.points = element.points.slice(0, 4).map((point) => ({
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

    findNearestElementAtPoint(point = {}, candidates = [], maxDistance = 80) {
        let best = null;
        let bestDistance = maxDistance;
        const pointX = Number(point.x) || 0;
        const pointY = Number(point.y) || 0;

        candidates.forEach((element) => {
            if (!element || ['line', 'arrow', 'freedraw'].includes(element.type)) {
                return;
            }
            const bounds = this.getElementBounds(element);
            const clampedX = Math.max(bounds.left, Math.min(pointX, bounds.right));
            const clampedY = Math.max(bounds.top, Math.min(pointY, bounds.bottom));
            const distance = Math.hypot(pointX - clampedX, pointY - clampedY);
            if (distance < bestDistance) {
                best = element;
                bestDistance = distance;
            }
        });

        return best;
    }

    buildCanvasRelationships(elements = []) {
        const nodes = elements.filter((element) => !['line', 'arrow', 'freedraw', 'frame'].includes(element.type));
        const connectors = elements.filter((element) => ['line', 'arrow'].includes(element.type) && Array.isArray(element.points) && element.points.length >= 2);
        const frames = elements.filter((element) => element.type === 'frame');
        const relationships = [];

        connectors.slice(-40).forEach((connector) => {
            const first = connector.points[0];
            const last = connector.points[connector.points.length - 1];
            const from = this.findNearestElementAtPoint(first, nodes);
            const to = this.findNearestElementAtPoint(last, nodes);
            if (from && to && from.id !== to.id) {
                relationships.push({
                    type: connector.type,
                    connectorId: connector.id,
                    fromId: from.id,
                    toId: to.id,
                    label: connector.text || '',
                });
            }
        });

        frames.slice(-20).forEach((frame) => {
            const frameBounds = this.getElementBounds(frame);
            const contains = nodes
                .filter((element) => element.id !== frame.id)
                .filter((element) => {
                    const bounds = this.getElementBounds(element);
                    const centerX = (bounds.left + bounds.right) / 2;
                    const centerY = (bounds.top + bounds.bottom) / 2;
                    return centerX >= frameBounds.left
                        && centerX <= frameBounds.right
                        && centerY >= frameBounds.top
                        && centerY <= frameBounds.bottom;
                })
                .map((element) => element.id)
                .slice(0, 30);
            if (contains.length > 0) {
                relationships.push({
                    type: 'frame_contains',
                    frameId: frame.id,
                    elementIds: contains,
                    label: frame.text || frame.name || '',
                });
            }
        });

        return relationships.slice(0, 60);
    }

    analyzeCanvasHealth(elements = []) {
        const objects = elements.filter((element) => element && typeof element === 'object');
        const ignoredHealthRoles = new Set(['annotation', 'connector', 'container', 'layout', 'note']);
        const nodes = objects.filter((element) => !element.qaGenerated
            && !ignoredHealthRoles.has(element.healthRole)
            && !['line', 'arrow', 'freedraw', 'frame'].includes(element.type));
        const relationships = this.buildCanvasRelationships(objects);
        const connectedIds = new Set();
        relationships.forEach((relationship) => {
            if (relationship.fromId) connectedIds.add(relationship.fromId);
            if (relationship.toId) connectedIds.add(relationship.toId);
        });

        const frames = objects.filter((element) => element.type === 'frame');
        const framedIds = new Set();
        relationships
            .filter((relationship) => relationship.type === 'frame_contains')
            .forEach((relationship) => {
                relationship.elementIds?.forEach((id) => framedIds.add(id));
            });

        const unlabeled = nodes.filter((element) => {
            const text = String(element.text || element.name || '').trim();
            return !text && !['image'].includes(element.type);
        });
        const disconnected = nodes.filter((element) => !connectedIds.has(element.id));
        const unframed = nodes.filter((element) => !framedIds.has(element.id));
        const connectorCount = objects.filter((element) => ['line', 'arrow'].includes(element.type)).length;
        const labelledCount = Math.max(0, nodes.length - unlabeled.length);
        const connectionRatio = nodes.length > 1 ? (nodes.length - disconnected.length) / nodes.length : 1;
        const labelRatio = nodes.length > 0 ? labelledCount / nodes.length : 1;
        const frameRatio = nodes.length > 2 ? (nodes.length - unframed.length) / nodes.length : 1;
        const score = Math.round(Math.max(0, Math.min(100, (
            connectionRatio * 42
            + labelRatio * 34
            + frameRatio * 14
            + (connectorCount > 0 || nodes.length < 2 ? 10 : 0)
        ))));

        const issues = [];
        if (objects.length === 0) {
            issues.push({
                severity: 'warning',
                text: 'Empty board. Start with editable shapes or ask the agent to build a map.',
            });
        }
        if (unlabeled.length > 0) {
            issues.push({
                severity: unlabeled.length > 3 ? 'error' : 'warning',
                text: `${unlabeled.length} object${unlabeled.length === 1 ? ' needs' : 's need'} labels.`,
            });
        }
        if (nodes.length > 1 && disconnected.length > 0) {
            issues.push({
                severity: disconnected.length > 2 ? 'error' : 'warning',
                text: `${disconnected.length} object${disconnected.length === 1 ? '' : 's'} are disconnected.`,
            });
        }
        if (nodes.length > 4 && frames.length === 0) {
            issues.push({
                severity: 'warning',
                text: 'No frames yet. Grouping would make the board easier to scan.',
            });
        }
        if (issues.length === 0 && objects.length > 0) {
            issues.push({
                severity: 'good',
                text: 'Board structure looks ready for a deeper AI pass.',
            });
        }

        return {
            score,
            objectCount: objects.length,
            nodeCount: nodes.length,
            connectorCount,
            frameCount: frames.length,
            labelledCount,
            unlabeledIds: unlabeled.map((element) => element.id).slice(0, 12),
            disconnectedIds: disconnected.map((element) => element.id).slice(0, 12),
            unframedIds: unframed.map((element) => element.id).slice(0, 12),
            issues: issues.slice(0, 5),
            nextActions: issues
                .filter((issue) => issue.severity !== 'good')
                .map((issue) => issue.text)
                .slice(0, 4),
        };
    }

    buildCanvasContext(options = {}) {
        const canvas = window.infiniteCanvas;
        const elements = canvas?.elements || [];
        const selected = canvas?.selectedElements || [];
        const scope = this.getEffectiveScope();
        const scopedElements = scope === 'selection'
            ? selected
            : (scope === 'viewport' ? this.getElementsInViewport() : elements);
        const includeHealth = options?.includeHealth === true;
        const boardHealth = includeHealth ? this.analyzeCanvasHealth(elements) : null;
        const selectedIds = new Set(selected.map((element) => element.id));
        const selectedElements = selected
            .slice(0, CANVAS_AGENT_CONTEXT_LIMITS.selectedElements)
            .map((element) => this.cloneElementForAI(element));
        const referenceElements = scopedElements
            .filter((element) => !selectedIds.has(element.id))
            .slice(-CANVAS_AGENT_CONTEXT_LIMITS.referenceElements)
            .map((element) => this.cloneElementForAI(element));
        const relationships = this.buildCanvasRelationships([...selected, ...scopedElements.slice(-16)])
            .slice(0, CANVAS_AGENT_CONTEXT_LIMITS.relationships)
            .map((relationship) => {
                if (relationship.type === 'frame_contains') {
                    return {
                        type: relationship.type,
                        frameId: relationship.frameId,
                        elementIds: (relationship.elementIds || []).slice(0, 6),
                    };
                }
                return {
                    type: relationship.type,
                    connectorId: relationship.connectorId,
                    fromId: relationship.fromId,
                    toId: relationship.toId,
                    label: relationship.label || '',
                };
            });

        return {
            surface: 'canvas-excalidraw',
            compact: true,
            scope,
            board: {
                elementCount: elements.length,
                typeCounts: this.summarizeTypeCounts(elements),
            },
            selection: {
                count: selected.length,
                ids: selected.map((element) => element.id),
                typeCounts: this.summarizeTypeCounts(selected),
                elements: selectedElements,
            },
            viewport: this.getViewportBounds(),
            elements: referenceElements,
            relationships,
            boardHealth: boardHealth ? {
                score: boardHealth.score,
                objectCount: boardHealth.objectCount,
                issues: (boardHealth.issues || []).slice(0, 2),
                unlabeledIds: (boardHealth.unlabeledIds || []).slice(0, 4),
                disconnectedIds: (boardHealth.disconnectedIds || []).slice(0, 4),
            } : null,
            toolPlan: this.buildAgentToolPlan(),
            allowedActions: ['add', 'add_many', 'update', 'update_many', 'delete', 'select'],
        };
    }

    buildCanvasPromptContext(canvasContext = this.buildCanvasContext()) {
        const context = canvasContext || {};
        const board = context.board || {};
        const selection = context.selection || {};
        const viewport = context.viewport || {};
        const elementLines = (context.elements || [])
            .slice(0, 8)
            .map((element) => {
                const label = String(element.name || element.text || element.canvasRole || '').replace(/\s+/g, ' ').trim();
                const size = element.width && element.height ? `${element.width}x${element.height}` : 'line';
                return `${element.id || 'new'} ${element.type || 'object'} @${element.x || 0},${element.y || 0} ${size}${label ? ` "${label.slice(0, 80)}"` : ''}`;
            });
        const relationshipLines = (context.relationships || [])
            .slice(0, 8)
            .map((relationship) => relationship.type === 'frame_contains'
                ? `frame ${relationship.frameId} contains ${(relationship.elementIds || []).join(', ')}`
                : `${relationship.fromId || '?'} -> ${relationship.toId || '?'}${relationship.label ? ` "${relationship.label}"` : ''}`);
        const issueLines = (context.boardHealth?.issues || [])
            .slice(0, 3)
            .map((issue) => `${issue.severity || 'note'}: ${issue.text || ''}`);

        return [
            `surface=${context.surface || 'canvas-excalidraw'} scope=${context.scope || 'board'}`,
            `board=${board.elementCount || 0} objects; types=${board.typeCounts || 'none'}`,
            `selection=${selection.count || 0}; ids=${(selection.ids || []).slice(0, 10).join(', ') || 'none'}; types=${selection.typeCounts || 'none'}`,
            viewport ? `viewport=${viewport.x || 0},${viewport.y || 0},${viewport.width || 0}x${viewport.height || 0}; zoom=${viewport.zoom || '1.00'}` : '',
            elementLines.length ? `objects:\n- ${elementLines.join('\n- ')}` : 'objects: none in scope',
            relationshipLines.length ? `relationships:\n- ${relationshipLines.join('\n- ')}` : 'relationships: none',
            issueLines.length ? `board health:\n- ${issueLines.join('\n- ')}` : '',
            'allowed creative types: rectangle, diamond, ellipse, arrow, line, text, sticky, frame, storyboardFrame, animationBeat, audioCue, mermaidDiagram',
        ].filter(Boolean).join('\n').slice(0, CANVAS_AGENT_CONTEXT_LIMITS.promptCharacters);
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
        this.renderChangeSets();
        this.renderActionLedger();
        this.updateSelectionActionBar(context);
    }

    handleHealthAction(action) {
        if (action === 'refresh') {
            const health = this.analyzeCanvasHealth(window.infiniteCanvas?.elements || []);
            this.renderBoardHealth(health);
            this.recordActionLedger(`Board audit score ${health.objectCount > 0 ? health.score : '--'}`, 'success', 'audit');
            this.showStatus('Board audit refreshed.', 'success');
            return;
        }

        if (action === 'note') {
            this.addBoardQaNote();
        }
    }

    handleFixAction(action) {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }

        const health = this.analyzeCanvasHealth(canvas.elements || []);
        const plan = this.buildHealthFixPlan(health, canvas.elements || []);
        this.renderFixPlan(plan);

        if (action === 'preview') {
            const targetIds = Array.from(new Set((plan.fixes || []).flatMap((fix) => fix.targetIds || [])));
            const targets = canvas.elements.filter((element) => targetIds.includes(element.id));
            if (targets.length > 0) {
                canvas.selectElements(targets);
            }
            this.recordActionLedger(
                plan.fixes.length > 0 ? `Previewing ${plan.fixes.length} suggested fixes` : 'No suggested fixes to preview',
                plan.fixes.length > 0 ? 'success' : 'warning',
                'plan',
            );
            this.showStatus(plan.fixes.length > 0 ? 'Suggested fixes are selected on the board.' : 'No suggested fixes available.', plan.fixes.length > 0 ? 'success' : 'error');
            return;
        }

        if (action === 'apply') {
            if (!Array.isArray(plan.actions) || plan.actions.length === 0) {
                this.recordActionLedger('No suggested fixes to apply', 'warning', 'plan');
                this.showStatus('No suggested fixes available.', 'error');
                return;
            }

            const applied = this.applyCanvasActions(
                { message: 'Applied board-intelligence fixes.', actions: plan.actions },
                { label: 'Board intelligence fixes', source: 'plan' },
            );
            this.recordActionLedger(`Applied ${applied} board fix action${applied === 1 ? '' : 's'}`, applied > 0 ? 'success' : 'warning', 'plan');
            this.showStatus(applied > 0 ? `Applied ${applied} suggested fix action${applied === 1 ? '' : 's'}.` : 'No suggested fixes were applied.', applied > 0 ? 'success' : 'error');
            this.updateGroundingPanel();
        }
    }

    addBoardQaNote() {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return;
        }

        const health = this.analyzeCanvasHealth(canvas.elements || []);
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const issueLines = health.issues
            .filter((issue) => issue.severity !== 'good')
            .map((issue) => issue.text)
            .slice(0, 4);
        const text = issueLines.length > 0
            ? ['Board QA', ...issueLines.map((line) => `- ${line}`)].join('\n')
            : 'Board QA\n- Structure looks ready for a deeper AI pass.';
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const center = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const note = {
            id: window.toolManager?.generateId?.() || `qa-note-${Date.now()}`,
            type: 'sticky',
            x: center.x + 240,
            y: center.y - 120,
            width: 230,
            height: 150,
            text,
            backgroundColor: '#ffec99',
            strokeColor: '#b7791f',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 1,
            fontSize: 16,
            fontFamily: window.toolManager?.defaultProperties?.fontFamily || 'Virgil, cursive',
            qaGenerated: true,
        };

        canvas.addElement(note);
        canvas.selectElement(note);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet('Board QA note', 'audit', beforeElements, canvas.elements || [], [note.id]);
        this.updateGroundingPanel();
        this.recordActionLedger('Added editable board QA note', 'success', 'audit');
        this.showStatus('Added a board QA note to the canvas.', 'success');
    }

    updateSelectionActionBar(context = this.buildCanvasContext()) {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (!this.selectionBar || !canvas || selected.length === 0) {
            if (this.selectionBar) {
                this.selectionBar.hidden = true;
            }
            return;
        }

        const bounds = selected.map((element) => this.getElementBounds(element));
        const minLeft = Math.min(...bounds.map((entry) => entry.left));
        const maxRight = Math.max(...bounds.map((entry) => entry.right));
        const minTop = Math.min(...bounds.map((entry) => entry.top));
        const centerX = (minLeft + maxRight) / 2;
        const screen = canvas.worldToScreen(centerX, minTop);
        const containerRect = canvas.container.getBoundingClientRect();
        const barWidth = Math.min(620, Math.max(280, this.selectionBar.offsetWidth || 360));
        const left = Math.min(
            Math.max(16 + barWidth / 2, screen.x),
            Math.max(16 + barWidth / 2, containerRect.width - 16 - barWidth / 2),
        );
        const top = Math.max(12, Math.min(containerRect.height - 54, screen.y - 48));

        this.selectionBar.hidden = false;
        this.selectionBar.style.left = `${left}px`;
        this.selectionBar.style.top = `${top}px`;
        this.selectionBar.style.transform = 'translateX(-50%)';

        const summary = context?.selection?.typeCounts || `${selected.length} object${selected.length === 1 ? '' : 's'}`;
        if (this.selectionBarSummary) {
            this.selectionBarSummary.textContent = selected.length === 1 ? summary : `${selected.length} selected`;
            this.selectionBarSummary.title = selected.map((element) => element.id).join(', ');
        }

        this.selectionBar.querySelectorAll('[data-ai-selection-action]').forEach((button) => {
            const action = button.dataset.aiSelectionAction;
            button.disabled = (action === 'connect' || action === 'tidy') && selected.length < 2;
        });
    }

    handleLocalAction(action) {
        if (action === 'tidy-selection') {
            this.tidySelection();
        } else if (action === 'frame-selection') {
            this.frameSelection();
        } else if (action === 'connect-selection') {
            this.connectSelection();
        }
    }

    handleSelectionAction(action) {
        if (this.isGenerating) {
            return;
        }

        if (action === 'ask') {
            this.showPanel();
            this.setMode('chat');
            if (this.input) {
                this.input.value = 'What should I improve about the selected objects?';
                this.input.focus();
            }
            this.recordActionLedger('Loaded selected-object question', 'success', 'selection');
            return;
        }

        if (action === 'polish') {
            this.runCommandPrompt(
                'Polish the selected objects: improve spacing, add concise labels where needed, preserve existing ids with update_many, and add only editable arrows or notes.',
                'diagram',
            );
            return;
        }

        if (action === 'tidy') {
            this.tidySelection();
            return;
        }

        if (action === 'connect') {
            this.connectSelection();
            return;
        }

        if (action === 'frame') {
            this.frameSelection();
        }
    }

    runCommandPrompt(prompt, mode = 'chat') {
        const trimmed = String(prompt || '').trim();
        if (!trimmed || this.isGenerating) {
            return;
        }

        this.setMode(mode === 'diagram' ? 'diagram' : 'chat');
        this.showPanel();
        if (this.input) {
            this.input.value = trimmed;
        }
        this.generate();
    }

    tidySelection() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (!canvas || selected.length < 2) {
            this.recordActionLedger('Tidy needs at least two selected objects', 'warning', 'local');
            this.showStatus('Select two or more objects to tidy the layout.', 'error');
            return;
        }

        const bounds = selected.map((element) => this.getElementBounds(element));
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const selectedIds = selected.map((element) => element.id);
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
        this.recordChangeSet(`Tidied ${selected.length} selected objects`, 'local', beforeElements, canvas.elements || [], selectedIds);
        this.updateGroundingPanel();
        window.app?.showToast?.('Tidied selected objects');
        this.recordActionLedger(`Tidied ${selected.length} selected objects`, 'success', 'local');
        this.showStatus('Tidied selected objects locally. Ask the agent for labels or deeper restructuring.', 'success');
    }

    connectSelection() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (!canvas || selected.length < 2) {
            this.recordActionLedger('Connect needs at least two selected objects', 'warning', 'local');
            this.showStatus('Select two or more objects to connect.', 'error');
            return;
        }

        const bounds = selected.map((element) => this.getElementBounds(element));
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const selectedIds = selected.map((element) => element.id);
        const spreadX = Math.max(...bounds.map((entry) => entry.right)) - Math.min(...bounds.map((entry) => entry.left));
        const spreadY = Math.max(...bounds.map((entry) => entry.bottom)) - Math.min(...bounds.map((entry) => entry.top));
        const horizontal = spreadX >= spreadY;
        const sorted = [...selected].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
        const arrows = [];

        for (let index = 0; index < sorted.length - 1; index += 1) {
            const from = sorted[index];
            const to = sorted[index + 1];
            const fromBounds = this.getElementBounds(from);
            const toBounds = this.getElementBounds(to);
            const start = horizontal
                ? { x: fromBounds.right + 8, y: (fromBounds.top + fromBounds.bottom) / 2 }
                : { x: (fromBounds.left + fromBounds.right) / 2, y: fromBounds.bottom + 8 };
            const end = horizontal
                ? { x: toBounds.left - 8, y: (toBounds.top + toBounds.bottom) / 2 }
                : { x: (toBounds.left + toBounds.right) / 2, y: toBounds.top - 8 };
            const arrow = {
                id: window.toolManager?.generateId?.() || `arrow-${Date.now()}-${index}`,
                type: 'arrow',
                points: [start, end],
                strokeColor: window.toolManager?.defaultProperties?.strokeColor || '#1e1e1e',
                backgroundColor: 'transparent',
                strokeWidth: Math.max(2, window.toolManager?.defaultProperties?.strokeWidth || 2),
                strokeStyle: 'solid',
                roughness: 1,
                opacity: 1,
            };

            canvas.addElement(arrow);
            arrows.push(arrow);
        }

        canvas.selectElements([...selected, ...arrows]);
        window.historyManager?.pushState(canvas.elements);
        window.app?.saveCanvasToStorage?.();
        canvas.render();
        this.recordChangeSet(
            `Connected ${selected.length} selected objects`,
            'local',
            beforeElements,
            canvas.elements || [],
            [...selectedIds, ...arrows.map((arrow) => arrow.id)],
        );
        this.updateGroundingPanel();
        this.recordActionLedger(`Connected ${selected.length} objects with ${arrows.length} arrows`, 'success', 'local');
        this.showStatus(`Connected ${selected.length} objects locally.`, 'success');
    }

    frameSelection() {
        const canvas = window.infiniteCanvas;
        const selected = canvas?.selectedElements || [];
        if (!canvas || selected.length === 0) {
            this.recordActionLedger('Frame needs a selection', 'warning', 'local');
            this.showStatus('Select one or more objects to frame.', 'error');
            return;
        }

        const bounds = selected.map((element) => this.getElementBounds(element));
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        const selectedIds = selected.map((element) => element.id);
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
        this.recordChangeSet(
            `Framed ${selected.length} selected objects`,
            'local',
            beforeElements,
            canvas.elements || [],
            [frame.id, ...selectedIds],
        );
        this.updateGroundingPanel();
        this.recordActionLedger(`Framed ${selected.length} selected objects`, 'success', 'local');
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
            const canvasPromptContext = this.buildCanvasPromptContext(canvasContext);
            const toolPlan = canvasContext.toolPlan || this.buildToolPlan('chat');
            this.setAgentPlanStep('tool', ['read']);
            let response;
            try {
                response = await window.apiManager.requestCanvasAgent({
                    message: prompt,
                    canvasContext,
                    existingContent: canvasPromptContext,
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
            const applied = this.applyCanvasActions(structured, {
                label: structured.message || 'Agent canvas actions',
                source: 'agent',
            });
            this.lastAppliedActionCount = applied;
            this.setAgentPlanStep('', ['read', 'tool', 'apply']);
            const assistantText = structured?.message || content;
            this.chatHistory.push({ role: 'assistant', content: assistantText });
            this.trimChatHistory();
            this.addConversationMessage('assistant', assistantText);
            if (applied > 0) {
                this.recordActionLedger(`Agent applied ${applied} editable action${applied === 1 ? '' : 's'}`, 'success', 'agent');
            } else if ((structured.actions?.length || 0) > 0 || (structured.elements?.length || 0) > 0) {
                this.recordActionLedger('Agent returned actions but none matched this board', 'warning', 'agent');
            }
            this.showStatus(applied > 0 ? `Applied ${applied} canvas action${applied === 1 ? '' : 's'}.` : 'Agent response ready.', 'success');
            this.input.value = '';
        } catch (error) {
            console.error('Agent chat error:', error);
            this.setAgentPlanStep('', ['read'], 'tool');
            this.addConversationMessage('assistant', `Error: ${error.message}`);
            this.recordActionLedger(error.message || 'Agent request failed', 'error', 'agent');
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
            const canvasPromptContext = this.buildCanvasPromptContext(canvasContext);
            const toolPlan = canvasContext.toolPlan || this.buildToolPlan('diagram');
            const existingContent = canvasPromptContext;
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
                if (applied > 0) {
                    this.setAgentPlanStep('', ['read', 'tool', 'apply']);
                    this.addConversationMessage('assistant', `Applied ${applied} editable object action${applied === 1 ? '' : 's'} to the canvas.`);
                    this.recordActionLedger(`Agent applied ${applied} editable action${applied === 1 ? '' : 's'}`, 'success', 'agent');
                    this.showStatus('Canvas objects updated.', 'success');
                    this.input.value = '';
                } else {
                    this.setAgentPlanStep('', ['read', 'tool'], 'apply');
                    this.recordActionLedger('Agent returned no editable object actions', 'warning', 'agent');
                    this.showStatus('No object actions returned. Try a different prompt.', 'error');
                }
            } else {
                this.setAgentPlanStep('', ['read', 'tool'], 'apply');
                this.recordActionLedger('Agent returned no content', 'warning', 'agent');
                this.showStatus('No object actions returned. Try a different prompt.', 'error');
            }
        } catch (error) {
            console.error('Generation error:', error);
            this.setAgentPlanStep('', ['read'], 'tool');
            this.recordActionLedger(error.message || 'Object build failed', 'error', 'agent');
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
                this.recordActionLedger(`Generated ${generatedImages.length} raster ${noun}`, 'success', 'image');
                this.showStatus(`Generated ${generatedImages.length} ${noun} successfully!`, 'success');
                this.input.value = '';
                
                // Show revised prompt if available
                if (generatedImages[0].revised_prompt) {
                    console.log('Revised prompt:', generatedImages[0].revised_prompt);
                }
            } else {
                this.recordActionLedger('Image model returned no usable image', 'warning', 'image');
                this.showStatus('No image generated. Try a different prompt.', 'error');
            }
        } catch (error) {
            console.error('Image generation error:', error);
            this.recordActionLedger(error.message || 'Image generation failed', 'error', 'image');
            this.showStatus(`Error: ${error.message}`, 'error');
        } finally {
            this.isGenerating = false;
            this.generateBtn.disabled = false;
            window.app?.hideLoading();
        }
    }
    
    async addImageToCanvas(imageData, position = null) {
        const canvas = window.infiniteCanvas;
        const beforeElements = this.cloneElementsForChangeSet(canvas?.elements || []);
        
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
                this.recordChangeSet('Generated image asset', 'image', beforeElements, canvas.elements || [], [element.id]);
                
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
        const allowedTypes = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'sticky', 'frame', 'storyboardFrame', 'animationBeat', 'audioCue', 'mermaidDiagram']);
        const requestedType = allowedTypes.has(element.type) ? element.type : 'rectangle';
        const normalized = {
            ...element,
            id: window.toolManager?.generateId?.() || `el-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            type: requestedType,
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

        if (requestedType === 'storyboardFrame') {
            normalized.width = Math.max(normalized.width, 300);
            normalized.height = Math.max(normalized.height, 220);
            normalized.title = String(element.title || element.name || 'Storyboard Frame').slice(0, 80);
            normalized.text = String(element.text || element.note || 'Shot, action, camera, and composition notes').slice(0, 360);
            normalized.startTime = Number.isFinite(Number(element.startTime)) ? Number(element.startTime) : 0;
            normalized.durationSeconds = Number.isFinite(Number(element.durationSeconds)) ? Math.max(1, Number(element.durationSeconds)) : 4;
            normalized.canvasRole = element.canvasRole || 'storyboard';
        } else if (requestedType === 'animationBeat') {
            normalized.width = Math.max(normalized.width, 260);
            normalized.height = Math.max(normalized.height, 150);
            normalized.title = String(element.title || element.name || 'Animation Beat').slice(0, 80);
            normalized.text = String(element.text || element.note || 'Motion, easing, transition').slice(0, 360);
            normalized.motionPreset = String(element.motionPreset || 'ease').slice(0, 32);
            normalized.startTime = Number.isFinite(Number(element.startTime)) ? Number(element.startTime) : 0;
            normalized.durationSeconds = Number.isFinite(Number(element.durationSeconds)) ? Math.max(1, Number(element.durationSeconds)) : 4;
            normalized.canvasRole = element.canvasRole || 'animation';
        } else if (requestedType === 'audioCue') {
            normalized.width = Math.max(normalized.width, 300);
            normalized.height = Math.max(normalized.height, 132);
            normalized.title = String(element.title || element.name || 'Audio Cue').slice(0, 80);
            normalized.text = String(element.text || element.note || 'Voice, music, SFX, or ambience note').slice(0, 360);
            normalized.audioName = String(element.audioName || element.title || 'Audio cue').slice(0, 120);
            normalized.startTime = Number.isFinite(Number(element.startTime)) ? Number(element.startTime) : 0;
            normalized.durationSeconds = Number.isFinite(Number(element.durationSeconds)) ? Math.max(1, Number(element.durationSeconds)) : 4;
            normalized.audioPersistent = element.audioPersistent !== false;
            normalized.waveformPeaks = Array.isArray(element.waveformPeaks) ? element.waveformPeaks.slice(0, 24) : window.app?.createWaveformPeaks?.(normalized.audioName || normalized.text) || [];
            normalized.canvasRole = element.canvasRole || 'audio';
        } else if (requestedType === 'mermaidDiagram') {
            normalized.width = Math.max(normalized.width, 360);
            normalized.height = Math.max(normalized.height, 220);
            normalized.title = String(element.title || element.name || 'Mermaid Diagram').slice(0, 80);
            normalized.mermaidSource = String(element.mermaidSource || element.text || 'flowchart TD\n  Idea --> Draft\n  Draft --> Review\n  Review --> Ship').slice(0, 2400);
            normalized.mermaidNodes = Array.isArray(element.mermaidNodes)
                ? element.mermaidNodes.slice(0, 24)
                : window.app?.parseMermaidFlow?.(normalized.mermaidSource)?.nodes?.map((node) => node.label).slice(0, 24) || [];
            normalized.canvasRole = element.canvasRole || 'diagram-source';
        }

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
            'healthRole',
            'smartTemplate',
            'title',
            'startTime',
            'durationSeconds',
            'audioName',
            'audioType',
            'audioSize',
            'audioUrl',
            'audioPersistent',
            'waveformPeaks',
            'mermaidSource',
            'mermaidNodes',
            'canvasRole',
            'motionPreset',
        ]);
        const safePatch = {};

        Object.entries(patch).forEach(([key, value]) => {
            if (!allowed.has(key)) {
                return;
            }

            if (['x', 'y', 'width', 'height', 'strokeWidth', 'roughness', 'opacity', 'fontSize', 'startTime', 'durationSeconds', 'audioSize'].includes(key)) {
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

            if (key === 'waveformPeaks') {
                if (Array.isArray(value)) {
                    safePatch.waveformPeaks = value.slice(0, 32).map((entry) => Math.max(0, Math.min(1, Number(entry) || 0)));
                }
                return;
            }

            if (key === 'mermaidNodes') {
                if (Array.isArray(value)) {
                    safePatch.mermaidNodes = value.slice(0, 32).map((entry) => String(entry || '').slice(0, 120));
                }
                return;
            }

            safePatch[key] = value;
        });

        return safePatch;
    }

    applyCanvasActions(structured = {}, options = {}) {
        const canvas = window.infiniteCanvas;
        if (!canvas) {
            return 0;
        }

        const actions = Array.isArray(structured.actions) ? structured.actions : [];
        const elements = Array.isArray(structured.elements) ? structured.elements : [];
        const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
        let applied = 0;
        let mutated = false;
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
                    mutated = true;
                });
                return;
            }

            if (type === 'add' && action.element) {
                const element = this.normalizeGeneratedElement(action.element);
                canvas.addElement(element);
                nextSelectionIds.add(element.id);
                applied += 1;
                mutated = true;
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
                    mutated = true;
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
                mutated = true;
                return;
            }

            if (type === 'delete' && action.id) {
                const before = canvas.elements.length;
                canvas.removeElement(action.id);
                if (canvas.elements.length !== before) {
                    applied += 1;
                    mutated = true;
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
            mutated = true;
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
            if (mutated) {
                this.recordChangeSet(
                    options.label || structured.message || 'Applied canvas actions',
                    options.source || 'agent',
                    beforeElements,
                    canvas.elements || [],
                    Array.from(nextSelectionIds),
                );
            }
            this.updateGroundingPanel();
        }

        return applied;
    }
    
    processGeneratedContent(response) {
        const canvas = window.infiniteCanvas;
        const structured = this.parseStructuredCanvasResponse(response.content || '');
        const actionCount = this.applyCanvasActions(structured, {
            label: structured.message || 'AI object actions',
            source: 'agent',
        });
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
        const objectTypes = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'sticky', 'frame', 'storyboardFrame', 'animationBeat', 'audioCue', 'mermaidDiagram']);
        elements = elements.filter(el => el && typeof el === 'object' && objectTypes.has(el.type));
        
        // Add elements to canvas
        if (elements.length > 0) {
            const beforeElements = this.cloneElementsForChangeSet(canvas.elements || []);
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
                this.recordChangeSet(
                    `Added ${addedCount} generated diagram objects`,
                    'agent',
                    beforeElements,
                    canvas.elements || [],
                    canvas.selectedElements.map((element) => element.id),
                );
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
                    'Default to editable objects and object actions. Creative object types are allowed: storyboardFrame, animationBeat, audioCue, mermaidDiagram.',
                    'For storyboardFrame or animationBeat include title, text, startTime, and durationSeconds. For audioCue include title, text, audioName, startTime, and durationSeconds. For mermaidDiagram include title and mermaidSource.',
                    'Do not create image elements, screenshots, or raster snapshots unless image asset mode is explicit.',
                    'For discussion-only answers, plain text is fine.',
                ].join(' '),
            },
            {
                role: 'system',
                content: `Current canvas grounding:\n${this.buildCanvasPromptContext(canvasContext)}`,
            },
            ...this.chatHistory,
        ];
    }

    trimChatHistory() {
        if (this.chatHistory.length > CANVAS_AGENT_CONTEXT_LIMITS.liveHistory) {
            this.chatHistory = this.chatHistory.slice(-CANVAS_AGENT_CONTEXT_LIMITS.liveHistory);
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
            const messages = await window.apiManager.getSessionMessages(activeSessionId, 16);
            this.chatHistory = messages
                .filter((message) => message?.role === 'user' || message?.role === 'assistant')
                .map((message) => ({
                    role: message.role,
                    content: this.extractHistoryContent(message.content),
                }))
                .filter((message) => message.content)
                .slice(-CANVAS_AGENT_CONTEXT_LIMITS.restoredHistory);

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
