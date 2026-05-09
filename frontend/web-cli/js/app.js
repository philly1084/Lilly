/**
 * Code CLI App
 * Terminal-style coding interface for LillyBuilt AI
 */

class CodeCLIApp {
    constructor() {
        this.history = [];
        this.historyIndex = -1;
        this.currentOutput = '';
        this.isProcessing = false;
        this.themeCatalog = window.KimiBuiltThemePresets || null;
        this.theme = this.normalizeThemeId(
            localStorage.getItem('codecli-theme')
            || localStorage.getItem(this.themeCatalog?.storageKeys?.preset || 'kimibuilt_theme_preset')
            || 'voxel'
        ) || 'voxel';
        this.commandHistory = JSON.parse(localStorage.getItem('codecli-cmd-history') || '[]');
        this.autocompleteIndex = -1;
        this.autocompleteMatches = [];
        this.lastResponse = '';
        this.sessionStartTime = Date.now();
        this.voxel = window.VoxelPets;
        this.voxelPet = this.loadVoxelPet();
        this.voxelPetHidden = localStorage.getItem('codecli-voxel-pet-hidden') === 'true';
        this.activePetAction = 'idle';
        this.lastVoxelTypingReaction = 0;
        this.lastVoxelAmbientMove = Date.now();
        this.lastVoxelRoamPlacement = 'prompt';
        this.voxelRoamHoldUntil = 0;
        this.pixelStreamBuffer = '';
        this.pixelStreamTimer = null;
        this.pixelStreamWaiters = [];
        this.voxelPersonality = this.loadVoxelPersonality();
        this.activeVoxelTool = 'chat';
        this.liveProgressState = null;
        this.liveReasoningSummary = '';
        this.liveToolEvents = [];
        
        // Session file storage
        this.sessionFiles = [];
        this.nextFileId = 1;
        
        // Command queue
        this.commandQueue = [];
        this.isProcessingQueue = false;
        
        // Available commands for autocomplete
        this.commands = [
            '/help', '/?', '/clear', '/cls', '/new', '/sessions', '/switch', '/delete', '/models', '/model', '/theme', '/voxel',
            '/export', '/save', '/load', '/copy', '/image', '/image-models', '/unsplash', '/podcast', '/video-podcast', '/diagram',
            '/upload', '/session', '/history', '/artifacts', '/stats', '/shortcuts', '/keys', '/health', '/tools', '/tool', '/tool-help',
            '/skills', '/skill', '/skill-create', '/skill-update',
            '/files', '/ls', '/download', '/open', '/pet', '/spawn', '/agent', '/voxel-agent', '/random-agent', '/creator', '/voxel-creator',
            '/buddy', '/toolbelt', '/build', '/remote', '/sandbox', '/sandbox-help',
        ];
        
        this.init();
    }
    
    init() {
        this.terminalOutput = document.getElementById('terminalOutput');
        this.commandInput = document.getElementById('commandInput');
        this.modelSelect = document.getElementById('modelSelect');
        this.themeButton = document.getElementById('themeButton');
        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');
        this.sessionInfo = document.getElementById('sessionInfo');
        this.inputPrompt = document.querySelector('.input-prompt');
        this.autocompleteEl = document.getElementById('autocomplete');
        this.shortcutsModal = document.getElementById('shortcutsModal');
        this.cliStatus = document.getElementById('cliStatus');
        this.queueIndicator = document.getElementById('queueIndicator');
        // Queue elements removed - using inline status only
        this.queueSection = null;
        this.queueList = null;
        this.queueCount = null;
        this.dragEnterCounter = 0;  // For reliable drag overlay
        this.voxelDock = document.getElementById('voxelDock');
        this.voxelPetStage = document.getElementById('voxelPetStage');
        this.voxelPetName = document.getElementById('voxelPetName');
        this.voxelPetKind = document.getElementById('voxelPetKind');
        this.voxelPetMood = document.getElementById('voxelPetMood');
        this.voxelPetEnergy = document.getElementById('voxelPetEnergy');
        this.voxelPetSeed = document.getElementById('voxelPetSeed');
        this.voxelPetPrompt = document.getElementById('voxelPetPrompt');
        this.voxelPetButton = document.getElementById('voxelPetButton');
        this.voxelPetMini = document.getElementById('voxelPetMini');
        this.voxelPetStatus = document.getElementById('voxelPetStatus');
        this.voxelRoamer = document.getElementById('voxelRoamer');
        this.voxelRoamerStage = document.getElementById('voxelRoamerStage');
        this.voxelToolbelt = document.getElementById('voxelToolbelt');
        this.voxelBondStat = document.getElementById('voxelBondStat');
        this.voxelFocusStat = document.getElementById('voxelFocusStat');
        this.voxelBuildStat = document.getElementById('voxelBuildStat');
        this.voxelToolStat = document.getElementById('voxelToolStat');
        
        this.setupEventListeners();
        this.applyTheme(this.theme);
        this.renderVoxelPet();
        this.initMermaid();
        this.checkConnection();
        this.loadModels();
        this.printWelcome();
        this.sessionRestorePromise = this.restoreSharedSession();
        this.scheduleVoxelAmbientMove();
    }
    
    initMermaid() {
        // Initialize Mermaid with appropriate theme
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: this.theme === 'light' ? 'default' : 'dark',
                securityLevel: 'loose',
                fontFamily: 'var(--font-family)'
            });
        }
    }
    
    setupEventListeners() {
        // Input handling
        this.commandInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (this.autocompleteMatches.length > 0 && this.autocompleteIndex >= 0) {
                    this.selectAutocomplete();
                } else {
                    this.sendCommand();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.autocompleteMatches.length > 0) {
                    this.navigateAutocomplete(-1);
                } else {
                    this.navigateHistory(-1);
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.autocompleteMatches.length > 0) {
                    this.navigateAutocomplete(1);
                } else {
                    this.navigateHistory(1);
                }
            } else if (e.key === 'Tab') {
                e.preventDefault();
                this.handleTabCompletion();
            } else if (e.ctrlKey && e.key === 'l') {
                e.preventDefault();
                this.clearOutput();
            } else if (e.ctrlKey && e.key === 'c') {
                // Only intercept if no text is selected (allow normal copy)
                const selection = window.getSelection().toString();
                if (!selection) {
                    e.preventDefault();
                    this.copyLastOutput();
                }
            } else if (e.key === 'Escape') {
                this.hideAutocomplete();
                this.closeShortcuts();
                this.closeFileManager();
                this.closeVoxelCreator();
            } else if (e.key === 'F1') {
                e.preventDefault();
                this.showShortcuts();
            } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
                e.preventDefault();
                this.openFileManager();
            }
        });
        
        // Input for autocomplete
        this.commandInput.addEventListener('input', () => {
            this.updateAutocomplete();
            this.queueVoxelTypingReaction();
        });

        if (this.voxelPetPrompt) {
            this.voxelPetPrompt.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.generateAIVoxelPetFromInput();
                }
            });
        }
        
        // Focus input on click anywhere
        document.addEventListener('click', (e) => {
            if (!e.target.closest('button, input, textarea, select, a, [contenteditable="true"], .autocomplete, .modal, .voxel-creator-modal, .file-manager-modal')) {
                this.commandInput.focus();
            }
        });
        
        // Model selection
        this.modelSelect.addEventListener('change', () => {
            api.setModel(this.modelSelect.value);
            this.updateModelInfo();
            this.printSystem(`Model set to: ${this.modelSelect.value}`);
        });
        
        // File drop handling
        this.dragOverlay = document.getElementById('dragOverlay');
        this.dragEnterCounter = 0;
        
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            this.dragEnterCounter++;
            if (this.dragOverlay) {
                this.dragOverlay.classList.add('active');
            }
            this.roamVoxelPet('alert', 'guard', 1400);
        });
        
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            this.dragEnterCounter--;
            if (this.dragEnterCounter <= 0 && this.dragOverlay) {
                this.dragEnterCounter = 0;
                this.dragOverlay.classList.remove('active');
            }
        });
        
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dragEnterCounter = 0;
            if (this.dragOverlay) {
                this.dragOverlay.classList.remove('active');
            }
            
            const files = Array.from(e.dataTransfer.files);
            this.roamVoxelPet('alert', 'scout', 1400);
            files.forEach(file => this.handleFile(file));
        });
        
        // Cancel drag when pressing Escape
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') {
                return;
            }

            this.closeVoxelCreator();
            if (this.dragOverlay && this.dragOverlay.classList.contains('active')) {
                this.cancelDrag();
            }
        });
    }

    // ==================== Voxel Pet System ====================

    loadVoxelPet() {
        const generator = this.voxel;
        if (!generator) {
            return null;
        }

        try {
            const stored = localStorage.getItem('codecli-voxel-pet');
            if (stored) {
                return generator.normalize(JSON.parse(stored));
            }
        } catch (error) {
            console.warn('[CLI] Failed to load voxel pet:', error);
        }

        return typeof generator.random === 'function'
            ? generator.random()
            : generator.generate('curious neon fox with amber goggles');
    }

    saveVoxelPet() {
        if (!this.voxelPet) {
            return;
        }

        localStorage.setItem('codecli-voxel-pet', JSON.stringify(this.voxelPet));
    }

    loadVoxelPersonality() {
        const fallback = {
            turns: 0,
            bond: 18,
            curiosity: 46,
            confidence: 38,
            playfulness: 34,
            sandboxRuns: 0,
            buildRuns: 0,
            toolRuns: 0,
            lastThought: '',
        };

        try {
            const stored = JSON.parse(localStorage.getItem('codecli-voxel-personality') || 'null');
            if (!stored || typeof stored !== 'object') {
                return fallback;
            }

            return {
                ...fallback,
                ...stored,
                turns: Number.isFinite(Number(stored.turns)) ? Number(stored.turns) : fallback.turns,
                bond: this.clampPersonalityValue(stored.bond, fallback.bond),
                curiosity: this.clampPersonalityValue(stored.curiosity, fallback.curiosity),
                confidence: this.clampPersonalityValue(stored.confidence, fallback.confidence),
                playfulness: this.clampPersonalityValue(stored.playfulness, fallback.playfulness),
                sandboxRuns: Math.max(0, Number.parseInt(stored.sandboxRuns, 10) || fallback.sandboxRuns),
                buildRuns: Math.max(0, Number.parseInt(stored.buildRuns, 10) || fallback.buildRuns),
                toolRuns: Math.max(0, Number.parseInt(stored.toolRuns, 10) || fallback.toolRuns),
            };
        } catch (_error) {
            return fallback;
        }
    }

    saveVoxelPersonality() {
        localStorage.setItem('codecli-voxel-personality', JSON.stringify(this.voxelPersonality));
    }

    clampPersonalityValue(value, fallback = 0) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : fallback;
    }

    setVoxelPalette() {
        if (!this.voxelPet?.palette) {
            return;
        }

        document.body.style.setProperty('--voxel-pet-primary', this.voxelPet.palette.primary);
        document.body.style.setProperty('--voxel-pet-secondary', this.voxelPet.palette.secondary);
        document.body.style.setProperty('--voxel-pet-accent', this.voxelPet.palette.accent);
    }

    renderVoxelPet(action = this.activePetAction || 'idle') {
        if (!this.voxel || !this.voxelPet) {
            return;
        }

        this.setVoxelPalette();
        if (this.voxelPetStage) {
            this.voxelPetStage.replaceChildren(this.voxel.renderElement(this.voxelPet, { action, variant: 'full' }));
        }
        if (this.voxelPetMini) {
            this.voxelPetMini.replaceChildren(this.voxel.renderElement(this.voxelPet, {
                action,
                variant: 'mini',
                decorative: true,
            }));
        }
        if (this.voxelRoamerStage) {
            this.voxelRoamerStage.replaceChildren(this.voxel.renderElement(this.voxelPet, {
                action,
                variant: 'peek',
                decorative: true,
            }));
        }

        if (this.voxelPetName) {
            this.voxelPetName.textContent = this.voxelPet.name;
        }
        if (this.voxelPetKind) {
            this.voxelPetKind.textContent = `${this.voxelPet.trait} ${this.voxelPet.species}`;
        }
        if (this.voxelPetMood) {
            this.voxelPetMood.textContent = this.voxel.MOODS[this.voxelPet.mood] || this.voxelPet.mood;
        }
        if (this.voxelPetEnergy) {
            this.voxelPetEnergy.style.setProperty('--value', `${this.voxelPet.energy}%`);
        }
        if (this.voxelPetSeed) {
            this.voxelPetSeed.textContent = `Seed: ${this.voxelPet.prompt}`;
        }
        if (this.voxelPetPrompt && !this.voxelPetPrompt.value) {
            this.voxelPetPrompt.value = this.voxelPet.prompt;
        }
        if (this.inputPrompt) {
            this.inputPrompt.textContent = this.getPromptLabel();
        }
        if (this.voxelPetStatus) {
            const mood = this.voxel.MOODS[this.voxelPet.mood] || this.voxelPet.mood;
            const bond = Math.round(this.voxelPersonality?.bond || 0);
            this.voxelPetStatus.textContent = this.voxelPetHidden
                ? 'Voxel companion hidden'
                : `${this.voxelPet.name} | ${mood} | bond ${bond}%`;
            this.voxelPetStatus.title = `${this.voxelPet.trait} ${this.voxelPet.species} - ${this.voxelPet.prompt} - ${this.voxelPet.energy}% energy`;
        }
        this.renderVoxelAgentStats();
        if (this.voxelPetButton) {
            this.voxelPetButton.classList.toggle('is-hidden', this.voxelPetHidden);
        }
        if (this.voxelRoamer) {
            this.voxelRoamer.classList.toggle('hidden', this.voxelPetHidden);
        }

        if (action !== 'idle') {
            window.clearTimeout(this.voxelActionTimer);
            this.voxelActionTimer = window.setTimeout(() => {
                this.activePetAction = 'idle';
                this.renderVoxelPet('idle');
            }, 900);
        }
    }

    renderVoxelAgentStats() {
        const personality = this.voxelPersonality || {};
        const focus = Math.round((
            Number(personality.curiosity || 0)
            + Number(personality.confidence || 0)
        ) / 2);

        if (this.voxelBondStat) {
            this.voxelBondStat.textContent = `${Math.round(personality.bond || 0)}%`;
        }
        if (this.voxelFocusStat) {
            this.voxelFocusStat.textContent = `${focus}%`;
        }
        if (this.voxelBuildStat) {
            this.voxelBuildStat.textContent = String(personality.buildRuns || 0);
        }
        if (this.voxelToolStat) {
            const toolRuns = Number(personality.toolRuns || 0) + Number(personality.sandboxRuns || 0);
            this.voxelToolStat.textContent = String(toolRuns);
        }
    }

    scheduleVoxelAmbientMove() {
        window.clearTimeout(this.voxelAmbientTimer);
        const delay = 4200 + Math.floor(Math.random() * 6200);
        this.voxelAmbientTimer = window.setTimeout(() => {
            if (!this.voxelPetHidden && !this.isProcessing && document.hasFocus()) {
                const actions = ['idle', 'scout', 'guard', 'sleep', 'dance'];
                const action = actions[Math.floor(Math.random() * actions.length)];
                const thought = this.getVoxelAmbientThought(action);
                if (action === 'idle') {
                    this.renderVoxelPet('idle');
                } else {
                    const placement = this.getVoxelRoamPlacement(action);
                    const duration = placement.startsWith('corner') ? 6200 : 2600;
                    this.roamVoxelPet(placement, action, duration, { thought, linger: placement.startsWith('corner') });
                }
                this.lastVoxelAmbientMove = Date.now();
            }
            this.scheduleVoxelAmbientMove();
        }, delay);
    }

    setVoxelPetHidden(hidden) {
        this.voxelPetHidden = Boolean(hidden);
        localStorage.setItem('codecli-voxel-pet-hidden', String(this.voxelPetHidden));
        if (this.voxelPetHidden) {
            this.closeVoxelCreator();
            this.clearVoxelRoamerPlacementClasses();
        }
        this.renderVoxelPet(this.voxelPetHidden ? 'idle' : 'scout');
    }

    closeVoxelCreator() {
        this.voxelDock?.classList.add('hidden');
    }

    getVoxelRoamPlacement(action = 'scout') {
        const normalized = String(action || 'scout').toLowerCase();
        const placements = normalized === 'sleep'
            ? ['corner-bl', 'corner-br', 'prompt']
            : ['prompt', 'stream', 'edge-left', 'edge-right', 'corner-tl', 'corner-tr', 'corner-bl', 'corner-br'];
        const recent = this.lastVoxelRoamPlacement;
        const available = placements.filter((placement) => placement !== recent);
        const chosen = available[Math.floor(Math.random() * available.length)] || placements[0];
        this.lastVoxelRoamPlacement = chosen;
        return chosen;
    }

    clearVoxelRoamerPlacementClasses() {
        this.voxelRoamer?.classList.remove(
            'is-visible',
            'is-prompt',
            'is-stream',
            'is-alert',
            'is-edge-left',
            'is-edge-right',
            'is-corner-tl',
            'is-corner-tr',
            'is-corner-bl',
            'is-corner-br',
            'is-lingering',
        );
        this.voxelRoamHoldUntil = 0;
    }

    roamVoxelPet(placement = 'prompt', action = 'scout', duration = 1200, options = {}) {
        if (this.voxelPetHidden || !this.voxelRoamer || !this.voxelRoamerStage || !this.voxel || !this.voxelPet) {
            return;
        }

        const now = Date.now();
        const isHeldInCorner = this.voxelRoamer.classList.contains('is-lingering') && now < this.voxelRoamHoldUntil;
        const isUrgent = placement === 'alert' || ['jump', 'guard'].includes(String(action || '').toLowerCase());
        if (isHeldInCorner && !options.force && !isUrgent) {
            return;
        }

        const isTravelAction = ['scout', 'guard', 'idle', 'dance'].includes(String(action || '').toLowerCase());
        const renderedAction = isTravelAction ? 'roam' : action;
        const directionYaw = /right|stream|tr|br/.test(placement) ? 18 : -18;
        const nodes = [this.voxel.renderElement(this.voxelPet, {
            action: renderedAction,
            variant: 'peek',
            decorative: true,
            yaw: directionYaw,
        })];
        const thought = String(options.thought || '').trim();
        if (thought) {
            const bubble = document.createElement('span');
            bubble.className = 'voxel-roamer-bubble';
            bubble.textContent = thought.slice(0, 48);
            nodes.push(bubble);
        }
        this.voxelRoamerStage.replaceChildren(...nodes);
        this.clearVoxelRoamerPlacementClasses();
        this.voxelRoamer.classList.remove('hidden');
        this.voxelRoamer.classList.add(`is-${placement}`, 'is-visible');
        this.voxelRoamer.classList.toggle('is-lingering', Boolean(options.linger));
        this.voxelRoamHoldUntil = options.linger ? now + Math.min(duration, 7000) : 0;

        window.clearTimeout(this.voxelRoamTimer);
        this.voxelRoamTimer = window.setTimeout(() => {
            this.clearVoxelRoamerPlacementClasses();
        }, duration);
    }

    queueVoxelTypingReaction() {
        if (this.voxelPetHidden || !this.commandInput?.value.trim()) {
            return;
        }

        window.clearTimeout(this.voxelTypingTimer);
        this.voxelTypingTimer = window.setTimeout(() => {
            const now = Date.now();
            const typed = this.commandInput?.value.trim() || '';
            if (typed.length < 4 || now - this.lastVoxelTypingReaction < 2200) {
                return;
            }
            this.lastVoxelTypingReaction = now;
            this.renderVoxelPet('scout');
            const placement = typed.length > 42 ? 'corner-bl' : 'prompt';
            this.roamVoxelPet(placement, 'scout', placement.startsWith('corner') ? 5000 : 1900, {
                thought: this.getVoxelTypingThought(),
                linger: placement.startsWith('corner'),
            });
        }, 520);
    }

    recordVoxelInteraction(input = '', response = '') {
        if (!this.voxelPersonality || this.voxelPetHidden) {
            return;
        }

        const text = `${input} ${response}`.toLowerCase();
        const asksQuestion = input.includes('?');
        const praise = /\b(thanks|thank you|nice|great|awesome|perfect|love|cool)\b/.test(text);
        const complexWork = /\b(debug|deploy|implement|refactor|kubectl|docker|test|fix|error|commit|build)\b/.test(text);

        this.voxelPersonality = {
            ...this.voxelPersonality,
            turns: this.voxelPersonality.turns + 1,
            bond: this.clampPersonalityValue(this.voxelPersonality.bond + (praise ? 5 : 1)),
            curiosity: this.clampPersonalityValue(this.voxelPersonality.curiosity + (asksQuestion ? 3 : 1)),
            confidence: this.clampPersonalityValue(this.voxelPersonality.confidence + (complexWork ? 3 : 1)),
            playfulness: this.clampPersonalityValue(this.voxelPersonality.playfulness + (praise ? 2 : 0.5)),
        };
        this.saveVoxelPersonality();
        this.renderVoxelPet();
    }

    recordVoxelToolUse(kind = 'tool') {
        if (!this.voxelPersonality) {
            return;
        }

        const normalized = String(kind || 'tool').toLowerCase();
        const key = normalized === 'sandbox'
            ? 'sandboxRuns'
            : normalized === 'build'
                ? 'buildRuns'
                : 'toolRuns';

        this.voxelPersonality = {
            ...this.voxelPersonality,
            [key]: Number(this.voxelPersonality[key] || 0) + 1,
            bond: this.clampPersonalityValue(Number(this.voxelPersonality.bond || 0) + 1),
            curiosity: this.clampPersonalityValue(Number(this.voxelPersonality.curiosity || 0) + (normalized === 'sandbox' ? 2 : 1)),
            confidence: this.clampPersonalityValue(Number(this.voxelPersonality.confidence || 0) + (normalized === 'build' ? 3 : 2)),
        };
        this.saveVoxelPersonality();
        this.renderVoxelAgentStats();
    }

    setActiveVoxelTool(tool = 'chat') {
        this.activeVoxelTool = tool;
        if (!this.voxelToolbelt) {
            return;
        }

        this.voxelToolbelt.querySelectorAll('.voxel-tool-chip').forEach((button) => {
            button.classList.toggle('active', button.dataset.tool === tool);
        });
    }

    useVoxelQuickTool(tool = 'chat') {
        const normalized = String(tool || 'chat').toLowerCase();
        this.setActiveVoxelTool(normalized);
        this.setVoxelPetHidden(false);

        const actions = {
            chat: () => {
                this.commandInput.value = '';
                this.commandInput.placeholder = 'Ask Lilly for help, open /files, or list /tools...';
                this.commandInput.focus();
                this.roamVoxelPet('prompt', 'scout', 1000, { thought: 'buddy link' });
            },
            sandbox: () => {
                this.commandInput.value = '/sandbox javascript console.log("hello from the voxel sandbox")';
                this.commandInput.focus();
                this.roamVoxelPet('prompt', 'guard', 1200, { thought: 'sandbox ready' });
            },
            build: () => {
                this.printBuildDeck();
                this.commandInput.value = 'Build a small feature in this repo: ';
                this.commandInput.focus();
                this.recordVoxelToolUse('build');
                this.roamVoxelPet('stream', 'scout', 1300, { thought: 'build map open' });
            },
            tools: async () => {
                this.recordVoxelToolUse('tool');
                this.roamVoxelPet('stream', 'scout', 1200, { thought: 'tool scan' });
                await this.listTools();
            },
            files: () => {
                this.openFileManager();
                this.roamVoxelPet('prompt', 'scout', 1000, { thought: 'file crate' });
            },
        };

        const handler = actions[normalized] || actions.chat;
        handler();
    }

    useCommandSuggestion(command = '', options = {}) {
        const normalized = String(command || '').trim();
        if (!normalized || !this.commandInput) {
            return;
        }

        this.commandInput.value = normalized;
        this.commandInput.focus();
        this.hideAutocomplete();

        if (options && options.submit) {
            this.sendCommand();
        }
    }

    getVoxelTypingThought() {
        const name = this.voxelPet?.name?.split('-')[0] || 'Vox';
        const thoughts = [
            `${name} is listening`,
            'mapping that',
            'tiny gears on',
            'scanning...',
        ];
        return thoughts[Math.floor(Math.random() * thoughts.length)];
    }

    getVoxelAmbientThought(action = 'idle') {
        const name = this.voxelPet?.name?.split('-')[0] || 'Vox';
        const personality = this.voxelPersonality || {};
        const curious = Number(personality.curiosity || 0) > 58;
        const bonded = Number(personality.bond || 0) > 48;
        const confident = Number(personality.confidence || 0) > 54;
        const playful = Number(personality.playfulness || 0) > 52;

        const pool = [
            bonded ? `${name} is comfy here` : `${name} checks in`,
            curious ? 'what is that signal?' : 'keeping watch',
            confident ? 'systems feel steady' : 'calibrating...',
            playful || action === 'dance' ? 'little victory hop' : 'quiet cube thoughts',
        ];

        const thought = pool[Math.floor(Math.random() * pool.length)];
        this.voxelPersonality = {
            ...this.voxelPersonality,
            lastThought: thought,
        };
        this.saveVoxelPersonality();
        return thought;
    }

    shouldAttachVoxelPersona(input = '') {
        if (this.theme !== 'voxel' || this.voxelPetHidden || !this.voxelPet) {
            return false;
        }

        const text = String(input || '').toLowerCase();
        if (!text || text.startsWith('/')) {
            return false;
        }

        const hardWork = /\b(kubectl|docker|git|npm|node|test|build|deploy|commit|push|fix|debug|implement|refactor|make|create|generate|write|update|change|add|remove|design|code|page|site|html|css|javascript|file|spec|report|research|analyze|security|prod|production|tls|secret|api key)\b/.test(text);
        if (hardWork) {
            return false;
        }

        const casual = /\b(hello|hi|hey|thanks|thank you|what do you think|ideas|brainstorm|explain|why|how would|should we|help me think)\b/.test(text);
        return casual || (text.length < 90 && Math.random() < 0.35);
    }

    buildVoxelChatOptions(input = '') {
        if (!this.shouldAttachVoxelPersona(input)) {
            return {};
        }

        const pet = this.voxel.normalize(this.voxelPet);
        const mood = this.voxel.MOODS[pet.mood] || pet.mood;
        const personality = this.voxelPersonality || {};
        const systemContent = [
            'You are answering inside Lilly Voxel CLI with a visible voxel companion profile.',
            `Current companion name: ${pet.name}. Use this exact current name if the persona naturally refers to itself.`,
            `Profile: ${pet.trait} ${pet.species}, mood ${mood}, energy ${pet.energy}%, palette ${pet.palette?.name || 'custom'}, seed "${pet.prompt}".`,
            `Long-running personality: bond ${Math.round(personality.bond || 0)}%, curiosity ${Math.round(personality.curiosity || 0)}%, confidence ${Math.round(personality.confidence || 0)}%, playfulness ${Math.round(personality.playfulness || 0)}%, shared turns ${Math.round(personality.turns || 0)}.`,
            'For casual, reflective, brainstorming, or conversational replies only, lightly let the answer feel like it comes through this companion. Keep it subtle: at most one small emotional beat or one mention of the companion name.',
            'Do not apply the voxel persona to CLI agent work, tool results, code, commands, deployment steps, test output, file edits, exact specs, or safety-critical guidance. In those cases, answer normally and professionally.',
        ].join('\n');

        return {
            systemMessages: [{ role: 'system', content: systemContent }],
            metadata: {
                voxelPersona: {
                    enabled: true,
                    name: pet.name,
                    mood,
                    trait: pet.trait,
                    species: pet.species,
                },
            },
        };
    }

    pulseVoxelStreaming() {
        const now = Date.now();
        if (this.voxelPetHidden || now - (this.lastVoxelStreamPulse || 0) < 650) {
            return;
        }

        this.lastVoxelStreamPulse = now;
        const placements = ['stream', 'edge-right', 'corner-tr', 'corner-br'];
        const placement = placements[Math.floor((now / 650) % placements.length)];
        this.roamVoxelPet(placement, 'scout', placement.startsWith('corner') ? 5200 : 2200, {
            thought: Math.random() < 0.28 ? 'pixeling...' : '',
            linger: placement.startsWith('corner'),
        });
    }

    generateVoxelPet(prompt) {
        if (!this.voxel) {
            return;
        }

        const seed = String(prompt || this.voxelPetPrompt?.value || '').trim();
        if (!seed) {
            this.printWarning('Usage: /pet <prompt>');
            return;
        }

        this.voxelPet = this.voxel.generate(seed);
        this.voxelPetHidden = false;
        localStorage.setItem('codecli-voxel-pet-hidden', 'false');
        if (this.voxelPetPrompt) {
            this.voxelPetPrompt.value = seed;
        }
        this.activePetAction = 'jump';
        this.saveVoxelPet();
        this.renderVoxelPet('jump');
        this.roamVoxelPet('prompt', 'jump', 1200);
        this.printPetCard('spawned');
    }

    generateVoxelPetFromInput() {
        this.generateVoxelPet(this.voxelPetPrompt?.value || '');
    }

    focusVoxelCreator(options = {}) {
        this.setVoxelPetHidden(false);
        this.voxelDock?.classList.remove('hidden');
        this.renderVoxelPet('scout');
        this.roamVoxelPet('prompt', 'scout', 900);
        window.setTimeout(() => {
            this.voxelPetPrompt?.focus();
            this.voxelPetPrompt?.select();
        }, 0);

        if (!options.silent) {
            this.printSystem('Voxel buddy opened. Use Chat, Tools, or Files, or type a buddy idea and press Enter for AI fill.');
        }
    }

    generateRandomVoxelPet(options = {}) {
        if (!this.voxel) {
            return;
        }

        this.voxelPet = typeof this.voxel.random === 'function'
            ? this.voxel.random()
            : this.voxel.generate(`random voxel companion ${Date.now()}`);
        this.voxelPetHidden = false;
        localStorage.setItem('codecli-voxel-pet-hidden', 'false');
        if (this.voxelPetPrompt) {
            this.voxelPetPrompt.value = this.voxelPet.prompt;
        }
        this.activePetAction = 'dance';
        this.saveVoxelPet();
        this.renderVoxelPet('dance');
        this.roamVoxelPet('prompt', 'dance', 1300);

        if (!options.silent) {
            this.printPetCard('randomized');
        }
    }

    async generateAIVoxelPetFromInput() {
        await this.generateAIVoxelAgent(this.voxelPetPrompt?.value || 'random helpful voxel terminal agent');
    }

    buildVoxelAgentPrompt(prompt) {
        const promptJson = JSON.stringify(prompt);
        return `Create one compact 3D voxel terminal companion for this user prompt: ${promptJson}.

Return JSON only. No markdown, no prose.
Use this exact shape:
{
  "name": "short agent name",
  "species": "fox|cat|dog|dragon|owl|bot|rabbit|panda|lizard|turtle",
  "trait": "scout|builder|guardian|spark|mapper|scribe|tinker|pilot|forager|warden",
  "palette": {
    "name": "two word palette name",
    "primary": "#49d3a7",
    "secondary": "#f4c95d",
    "accent": "#ff6f91"
  },
  "ears": "point|round|antenna|crest",
  "tail": "stub|curl|saber|spark",
  "eyes": "round|bright|sleepy|scan",
  "mood": "ready|curious|thinking|proud|sleepy|alert|playful",
  "energy": 82,
  "prompt": ${promptJson}
}`;
    }

    extractJsonObject(text = '') {
        const cleaned = String(text || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

        try {
            return JSON.parse(cleaned);
        } catch (_error) {
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start >= 0 && end > start) {
                return JSON.parse(cleaned.slice(start, end + 1));
            }
            throw new Error('AI did not return a JSON object');
        }
    }

    async generateAIVoxelAgent(prompt) {
        if (!this.voxel) {
            return;
        }

        if (this.isProcessing) {
            this.printWarning('Already processing. Please wait...');
            return;
        }

        const seed = String(prompt || this.voxelPetPrompt?.value || 'random helpful voxel terminal agent').trim()
            || 'random helpful voxel terminal agent';
        this.isProcessing = true;
        this.setStatus('thinking');
        this.reactVoxelPet(seed, 'think');
        this.printSystem(`Asking AI for voxel agent spec: ${seed}`);

        try {
            const response = await api.sendMessage(this.buildVoxelAgentPrompt(seed));
            const spec = this.extractJsonObject(response.content || '');
            this.voxelPet = typeof this.voxel.fromSpec === 'function'
                ? this.voxel.fromSpec(spec, seed)
                : this.voxel.generate(seed);
            this.voxelPetHidden = false;
            localStorage.setItem('codecli-voxel-pet-hidden', 'false');
            if (this.voxelPetPrompt) {
                this.voxelPetPrompt.value = this.voxelPet.prompt;
            }
            this.activePetAction = 'jump';
            this.saveVoxelPet();
            this.renderVoxelPet('jump');
            this.roamVoxelPet('prompt', 'jump', 1200);
            this.printPetCard('AI-filled');
            this.setStatus('ready');
        } catch (error) {
            this.printError(`AI voxel agent failed: ${error.message}`);
            this.handlePetAction('guard', { silent: true });
            this.setStatus('error');
        } finally {
            this.isProcessing = false;
            this.processQueue();
        }
    }

    async handlePetCommand(args = []) {
        const subcommand = String(args[0] || '').toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (!subcommand) {
            this.printPetCard();
            return;
        }

        if (['new', 'make', 'generate', 'spawn'].includes(subcommand)) {
            this.generateVoxelPet(rest);
            return;
        }

        if (subcommand === 'random') {
            this.generateRandomVoxelPet();
            return;
        }

        if (['ai', 'agent', 'fill', 'design'].includes(subcommand)) {
            await this.generateAIVoxelAgent(rest || this.voxelPetPrompt?.value || 'random helpful voxel terminal agent');
            return;
        }

        if (subcommand === 'act') {
            this.handlePetAction(rest || 'jump');
            return;
        }

        if (subcommand === 'name') {
            if (!rest) {
                this.printWarning('Usage: /pet name <name>');
                return;
            }
            this.voxelPet = { ...this.voxelPet, name: rest.slice(0, 28) };
            this.saveVoxelPet();
            this.renderVoxelPet('scout');
            this.printPetCard('renamed');
            return;
        }

        if (subcommand === 'hide') {
            this.setVoxelPetHidden(true);
            this.printSystem('Voxel companion hidden. Use /pet show to restore it.');
            return;
        }

        if (subcommand === 'show') {
            this.setVoxelPetHidden(false);
            this.focusVoxelCreator({ silent: true });
            this.renderVoxelPet('jump');
            this.printPetCard();
            return;
        }

        if (subcommand === 'help') {
            this.printAI(`## Voxel Pet Commands

  /pet <prompt>          Spawn a prompt-generated voxel pet
  /pet random            Spawn a random voxel character
  /pet ai <prompt>       Ask AI for a voxel agent spec
  /pet act <action>      Run jump, dance, scout, guard, or sleep
  /pet name <name>       Rename the active pet
  /pet show              Open the pet creator
  /pet hide              Hide the prompt companion
  /agent <prompt>        Same AI-backed voxel agent generator

The pet reacts to prompts while chat responses stream.`);
            return;
        }

        this.generateVoxelPet(args.join(' '));
    }

    handlePetAction(action = 'ready', options = {}) {
        if (!this.voxel || !this.voxelPet) {
            return;
        }

        const normalizedAction = String(action || 'ready').trim().toLowerCase();
        this.voxelPet = this.voxel.mutate(this.voxelPet, normalizedAction);
        this.activePetAction = normalizedAction === 'nap' ? 'sleep' : normalizedAction;
        this.saveVoxelPet();
        this.renderVoxelPet(this.activePetAction);
        this.roamVoxelPet('prompt', this.activePetAction, 1100);

        if (!options.silent) {
            this.printSystem(`${this.voxelPet.name} ${this.voxelPet.lastAction}.`);
        }
    }

    reactVoxelPet(input = '', fallbackAction = 'ready') {
        if (!this.voxel || !this.voxelPet) {
            return;
        }

        this.voxelPet = fallbackAction && fallbackAction !== 'auto'
            ? this.voxel.mutate(this.voxelPet, fallbackAction)
            : this.voxel.reactToText(this.voxelPet, input);
        const moodAction = {
            sleepy: 'sleep',
            playful: 'dance',
            thinking: 'scout',
            proud: 'jump',
            alert: 'guard',
            curious: 'scout',
        };
        this.activePetAction = moodAction[this.voxelPet.mood] || 'idle';
        this.saveVoxelPet();
        this.renderVoxelPet(this.activePetAction);
        this.roamVoxelPet(this.activePetAction === 'jump' ? 'prompt' : 'stream', this.activePetAction, 1200);
    }

    printPetCard(eventLabel = 'status') {
        if (!this.voxelPet) {
            return;
        }

        const mood = this.voxel?.MOODS?.[this.voxelPet.mood] || this.voxelPet.mood;
        this.printAI(`## ${this.voxelPet.name}

${this.voxelPet.trait} ${this.voxelPet.species} | ${this.voxelPet.palette.name} | ${eventLabel}

- Mood: ${mood}
- Energy: ${this.voxelPet.energy}%
- Seed: ${this.voxelPet.prompt}
- Last action: ${this.voxelPet.lastAction || 'ready'}`);
    }
    
    // ==================== Command Processing ====================
    
    async sendCommand() {
        const input = this.commandInput.value.trim();
        if (!input) return;
        this.commandInput.value = '';
        this.hideAutocomplete();

        if (this.sessionRestorePromise) {
            await this.sessionRestorePromise;
        }
        
        // Add to history
        this.history.push(input);
        this.historyIndex = this.history.length;
        this.saveCommandHistory();
        
        // Print input
        this.printInput(input);
        this.roamVoxelPet(input.startsWith('/') ? 'edge-left' : 'prompt', input.startsWith('/') ? 'guard' : 'scout', 1800, {
            thought: input.startsWith('/') ? 'command seen' : 'on it',
        });
        
        // If currently processing, queue the command
        if (this.isProcessing) {
            this.commandQueue.push(input);
            this.updateQueueDisplay();
            this.printSystem(`Queued: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`);
            return;
        }
        
        // Process immediately
        await this.processCommandItem(input);
    }
    
    async processCommandItem(input) {
        // Process command
        if (input.startsWith('/')) {
            await this.processCommand(input);
        } else {
            await this.processQuery(input);
        }
        
        // Process next queued command if any
        this.processQueue();
    }
    
    async processQueue() {
        if (this.isProcessingQueue || this.commandQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        while (this.commandQueue.length > 0 && !this.isProcessing) {
            const nextCommand = this.commandQueue.shift();
            this.updateQueueDisplay();
            this.printSystem(`Running queued: ${nextCommand.substring(0, 50)}${nextCommand.length > 50 ? '...' : ''}`);
            await this.processCommandItem(nextCommand);
        }
        
        this.isProcessingQueue = false;
    }
    
    updateQueueDisplay() {
        const count = this.commandQueue.length;
        
        // Update indicator only (side panel removed)
        if (this.queueIndicator) {
            this.queueIndicator.textContent = count;
            this.queueIndicator.classList.toggle('hidden', count === 0);
        }
    }
    
    async processCommand(input) {
        const parts = input.slice(1).split(' ');
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        switch (cmd) {
            case 'help':
            case '?':
                this.printHelp();
                break;
            case 'clear':
            case 'cls':
                this.clearOutput();
                break;
            case 'new':
                await this.startNewSession(args.join(' '));
                break;
            case 'sessions':
                await this.listSessions();
                break;
            case 'switch':
                await this.switchSession(args[0]);
                break;
            case 'delete':
            case 'del':
            case 'rm':
                await this.deleteSession(args[0]);
                break;
            case 'models':
                await this.listModels();
                break;
            case 'model':
                if (args[0]) {
                    api.setModel(args[0]);
                    // Reload models to update dropdown then sync selection
                    await this.loadModels();
                    this.updateModelInfo();
                    this.printSystem(`Model set to: ${args[0]}`);
                } else {
                    this.printSystem(`Current model: ${api.currentModel || 'default'}`);
                }
                break;
            case 'theme':
                if (args[0]) {
                    const themeArg = String(args[0] || '').toLowerCase();
                    if (['list', 'themes', 'help'].includes(themeArg)) {
                        this.printThemeList();
                    } else {
                        this.setTheme(args[0]);
                    }
                } else {
                    this.cycleTheme();
                }
                break;
            case 'voxel':
                this.setTheme('voxel');
                this.printPetCard();
                break;
            case 'buddy':
            case 'toolbelt':
                this.focusVoxelCreator();
                this.printToolbeltCard();
                break;
            case 'build':
                this.printBuildDeck();
                this.recordVoxelToolUse('build');
                break;
            case 'remote':
                await this.handleRemoteCommand(args);
                break;
            case 'sandbox':
                await this.invokeSandboxCommand(args);
                break;
            case 'sandbox-help':
                this.printSandboxHelp();
                break;
            case 'creator':
            case 'voxel-creator':
                this.focusVoxelCreator();
                break;
            case 'pet':
            case 'spawn':
                await this.handlePetCommand(args);
                break;
            case 'agent':
            case 'voxel-agent':
                await this.generateAIVoxelAgent(args.join(' '));
                break;
            case 'random-agent':
                this.generateRandomVoxelPet();
                break;
            case 'export':
                this.exportSession();
                break;
            case 'save':
                this.saveConversation(args[0] || 'session');
                break;
            case 'load':
                this.loadConversation(args[0] || 'session');
                break;
            case 'copy':
                this.copyLastOutput();
                break;
            case 'image':
                await this.generateImage(args.join(' '));
                break;
            case 'image-models':
                await this.listImageModels();
                break;
            case 'unsplash':
                await this.searchUnsplash(args.join(' '));
                break;
            case 'podcast':
                await this.runPodcastCommand(args.join(' '), false);
                break;
            case 'video-podcast':
                await this.runPodcastCommand(args.join(' '), true);
                break;
            case 'diagram':
                if (!args[0] || args[0] === 'help' || args[0] === '?') {
                    this.printDiagramHelp();
                } else {
                    await this.generateDiagram(args[0], args.slice(1).join(' '));
                }
                break;
            case 'upload':
                this.triggerFileUpload();
                break;
            case 'session':
                await this.handleSessionCommand(args);
                break;
            case 'history':
                await this.showSessionHistory();
                break;
            case 'artifacts':
                await this.showSessionArtifacts();
                break;
            case 'stats':
                this.printStats();
                break;
            case 'shortcuts':
            case 'keys':
                this.showShortcuts();
                break;
            case 'health':
                await this.checkHealth();
                break;
            case 'tools':
                await this.listTools(args[0] || null);
                break;
            case 'tool':
                await this.invokeToolCommand(args);
                break;
            case 'tool-help':
                await this.showToolHelp(args);
                break;
            case 'skills':
                await this.listSkills(args.join(' ').trim());
                break;
            case 'skill':
                await this.showSkill(args);
                break;
            case 'skill-create':
                await this.createSkillCommand(args);
                break;
            case 'skill-update':
                await this.updateSkillCommand(args);
                break;
            case 'files':
            case 'ls':
                await this.listFiles();
                break;
            case 'download':
                if (args[0]) {
                    await this.downloadFileById(args[0]);
                } else {
                    this.printError('Usage: /download <file-id>  (use /files to see IDs)');
                }
                break;
            case 'open':
                this.openFileManager();
                break;
            default:
                this.printError(`Unknown command: /${cmd}. Type /help for available commands.`);
        }
    }
    
    async processQuery(input, options = {}) {
        if (this.isProcessing) {
            this.printWarning('Already processing. Please wait...');
            return;
        }
        
        this.isProcessing = true;
        
        // Update status
        this.setStatus('thinking');
        this.reactVoxelPet(input, 'think');
        
        try {
            const chatOptions = {
                ...this.buildVoxelChatOptions(input),
                ...(options || {}),
                metadata: {
                    ...(this.buildVoxelChatOptions(input)?.metadata || {}),
                    ...(options?.metadata || {}),
                },
            };
            
            const response = await api.sendMessage(input, (chunk) => {
                // Stream progress
                if (chunk.type === 'delta') {
                    this.pulseVoxelStreaming();
                    this.appendToCurrentOutput(chunk.content);
                } else if (chunk.type === 'progress') {
                    this.updateLiveProgressCardFromChunk(chunk);
                } else if (chunk.type === 'reasoning_summary_delta') {
                    const summary = String(chunk.summary || chunk.content || '').replace(/\s+/g, ' ').trim();
                    if (summary) {
                        this.updateLiveReasoningSummary(summary);
                    }
                } else if (chunk.type === 'tool_event') {
                    this.recordVoxelToolUse('tool');
                    this.updateLiveToolEvent(chunk);
                }
            }, null, chatOptions);
            
            const reasoningSummary = String(
                response.assistantMetadata?.reasoningSummary
                || response.assistantMetadata?.reasoning_summary
                || '',
            ).replace(/\s+/g, ' ').trim();
            if (reasoningSummary) {
                this.updateLiveReasoningSummary(reasoningSummary);
            }

            // Finalize streaming output after the pixel reveal buffer catches up.
            await this.finalizeStreamingOutput(response.content || 'No response');
            await this.attachLatestAlignmentTargetToLastAIResponse(response);
            this.finalizeLiveProgressCard();
            const addedArtifactFiles = this.syncArtifactsToSessionFiles([
                ...(Array.isArray(response.artifacts) ? response.artifacts : []),
                ...this.collectArtifactsFromValue(response.toolEvents || []),
            ]);
            if (addedArtifactFiles.length > 0) {
                this.printSystem(`Added ${addedArtifactFiles.length} artifact file(s) to /files.`);
            }

            // Update status and session info
            this.setStatus('ready');
            this.reactVoxelPet(input, 'proud');
            this.roamVoxelPet('corner-br', 'jump', 5200, { thought: 'done', linger: true });
            this.updateSessionInfo();
            
            // Add to conversation
            this.lastResponse = response.content;
            this.recordVoxelInteraction(input, response.content || '');
            
        } catch (error) {
            if (this.liveProgressState) {
                this.finalizeLiveProgressCard({ phase: 'blocked', detail: error.message });
            }
            this.printError(`Request failed: ${error.message}`);
            this.handlePetAction('guard', { silent: true });
            this.setStatus('error');
        } finally {
            this.isProcessing = false;
            this.currentOutput = '';
            this.finalizeProgressLine();
            // Process any queued commands
            this.processQueue();
        }
    }

    parsePodcastCliOptions(input = '') {
        const tokens = String(input || '').split(/\s+/).filter(Boolean);
        const flags = {
            music: false,
            audio: false,
            intro: false,
            outro: false,
            unsplash: false,
            aspect: '16:9',
            systemPrompt: '',
            directContentRequest: '',
        };
        const topic = [];

        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index];
            if (token === '--music' || token === '-m') {
                flags.music = true;
            } else if (token === '--audio' || token === '-a') {
                flags.audio = true;
            } else if (token === '--intro') {
                flags.intro = true;
            } else if (token === '--outro') {
                flags.outro = true;
            } else if (token === '--unsplash') {
                flags.unsplash = true;
            } else if (token === '--aspect') {
                flags.aspect = tokens[index + 1] || flags.aspect;
                index += 1;
            } else if (token === '--system') {
                flags.systemPrompt = tokens[index + 1] || '';
                index += 1;
            } else if (token === '--brief') {
                flags.directContentRequest = tokens[index + 1] || '';
                index += 1;
            } else {
                topic.push(token);
            }
        }

        return {
            topic: topic.join(' ').trim(),
            flags,
        };
    }

    async runPodcastCommand(input = '', includeVideo = false) {
        const parsed = this.parsePodcastCliOptions(input);
        if (!parsed.topic) {
            this.printError(`Usage: /${includeVideo ? 'video-podcast' : 'podcast'} <topic> [--music] [--audio] [--system "extra prompt"]`);
            return;
        }

        const includeMusicBed = parsed.flags.music === true || parsed.flags.audio === true;
        const includeIntro = parsed.flags.intro === true || parsed.flags.audio === true;
        const includeOutro = parsed.flags.outro === true || parsed.flags.audio === true;
        const productionType = includeVideo ? 'video-podcast' : 'podcast';
        const message = `Create a ${includeVideo ? 'video podcast' : 'podcast'} about ${parsed.topic}`;

        await this.processQueryWithOptions(message, {
            metadata: {
                podcastOptions: {
                    enabled: true,
                    productionType,
                    includeVideo,
                    voiceOnlyAudio: !(includeMusicBed || includeIntro || includeOutro),
                    includeMusicBed,
                    includeIntro,
                    includeOutro,
                    videoAspectRatio: parsed.flags.aspect || '16:9',
                    videoRenderMode: includeVideo ? 'storyboard' : undefined,
                    videoImageMode: parsed.flags.unsplash ? 'unsplash' : 'generated',
                    videoGenerateImages: includeVideo && !parsed.flags.unsplash,
                    directContentRequest: parsed.flags.directContentRequest,
                    systemPrompt: parsed.flags.systemPrompt,
                },
            },
        });
    }

    async processQueryWithOptions(input, options = {}) {
        const merged = {
            ...this.buildVoxelChatOptions(input),
            ...(options || {}),
            metadata: {
                ...(this.buildVoxelChatOptions(input)?.metadata || {}),
                ...(options?.metadata || {}),
            },
        };
        return this.processQuery(input, merged);
    }
    
    // ==================== Simple Status & Queue ====================
    
    setStatus(state) {
        // state: 'ready', 'thinking', 'error'
        if (!this.cliStatus) return;
        
        this.cliStatus.className = `cli-status ${state}`;
        
        switch(state) {
            case 'thinking':
                this.cliStatus.textContent = 'Thinking...';
                break;
            case 'error':
                this.cliStatus.textContent = 'Error';
                setTimeout(() => this.setStatus('ready'), 3000);
                break;
            case 'ready':
            default:
                this.cliStatus.textContent = 'Ready';
                break;
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // ==================== Session Info ====================
    
    printStats() {
        const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        this.printSystem(`
Session Statistics:
  Duration: ${elapsed}s
  Model: ${api.currentModel || 'default'}
  Session: ${api.sessionId || 'none'}
        `.trim());
    }

    async restoreSharedSession() {
        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            const storedSessionId = String(api.sessionId || '').trim();
            const activeSessionId = String(
                data.activeSessionId
                || (storedSessionId && sessions.some((session) => session.id === storedSessionId) ? storedSessionId : '')
                || sessions[0]?.id
                || '',
            ).trim();

            if (!activeSessionId) {
                this.updateSessionInfo();
                return;
            }

            api.setSessionId(activeSessionId);
            this.updateSessionInfo();
            await this.renderPersistedSessionHistory(activeSessionId, {
                clear: false,
                intro: `Connected to isolated session ${activeSessionId.slice(0, 8)}...`,
            });
        } catch (error) {
            console.warn('Failed to restore isolated session:', error);
        }
    }

    updateSessionInfo() {
        if (!this.sessionInfo) {
            return;
        }

        if (!api.sessionId) {
            this.sessionInfo.textContent = 'Session: new';
            this.sessionInfo.title = 'A new isolated session will be created on the next request.';
            return;
        }

        const shortId = api.sessionId.slice(0, 8);
        this.sessionInfo.textContent = `Session: ${shortId}...`;
        this.sessionInfo.title = `Full session ID: ${api.sessionId}`;
    }

    getPromptLabel() {
        if (this.theme === 'voxel' && this.voxelPet?.name) {
            return `[${this.voxelPet.name.split('-')[0]}]`;
        }

        return '>';
    }
    
    // ==================== Output Methods ====================
    
    printInput(text) {
        const line = document.createElement('div');
        line.className = 'line line-input user-message';
        line.innerHTML = `
            <span class="prompt">${this.escapeHtml(this.getPromptLabel())}</span>
            <span class="input-text">${this.escapeHtml(text)}</span>
        `;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }
    
    printAI(text) {
        const line = document.createElement('div');
        line.className = 'line line-output ai';
        line.innerHTML = this.renderAIContent(text);
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
        this.finishAIContentLine(line);
    }

    printHistoryMessage(message = {}) {
        const role = String(message.role || '').toLowerCase();
        const content = String(message.displayContent || message.content || '').trim();
        if (!content) {
            return;
        }

        if (role === 'user') {
            this.printInput(content);
            return;
        }

        if (role === 'system') {
            this.printSystem(content);
            return;
        }

        this.printAI(content);
    }

    async renderPersistedSessionHistory(sessionId = api.sessionId, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
            return;
        }

        const {
            clear = true,
            intro = '',
            limit = 200,
        } = options;

        if (clear) {
            this.printWelcome();
        }

        if (intro) {
            this.printSystem(intro);
        }

        const messages = await api.getSessionMessages(normalizedSessionId, limit);
        if (!messages.length) {
            this.printSystem('No persisted backend history for this session yet.');
            return;
        }

        messages.forEach((message) => this.printHistoryMessage(message));
        this.printSystem(`Loaded ${messages.length} persisted message${messages.length === 1 ? '' : 's'}.`);
    }

    finishAIContentLine(line) {
        if (!line) {
            return;
        }

        if (typeof hljs !== 'undefined') {
            line.querySelectorAll('pre code').forEach((block) => {
                if (block.classList.contains('language-mermaid') || block.classList.contains('nohighlight')) {
                    return;
                }
                hljs.highlightElement(block);
            });
        }

        this.renderMermaidDiagrams(line);
    }

    async attachLatestAlignmentTargetToLastAIResponse(response = {}) {
        const sessionId = String(response?.sessionId || api.sessionId || '').trim();
        if (!sessionId || String(sessionId).startsWith('local_')) {
            return;
        }

        try {
            const messages = await api.getSessionMessages(sessionId, 12);
            const assistantMessage = [...messages].reverse()
                .find((message) => String(message?.role || '').toLowerCase() === 'assistant' && String(message?.id || '').trim());
            const line = [...this.terminalOutput.querySelectorAll('.line-output.ai')].reverse()
                .find((entry) => !entry.dataset.alignmentMessageId);
            if (!assistantMessage || !line) {
                return;
            }

            line.dataset.alignmentSessionId = sessionId;
            line.dataset.alignmentMessageId = assistantMessage.id;
            line.querySelectorAll('.cli-alignment-btn').forEach((button) => {
                button.disabled = false;
            });
        } catch (error) {
            console.warn('[WebCLI] Failed to bind alignment feedback target:', error);
        }
    }

    async submitAlignmentFeedback(button = null, rating = '') {
        const line = button?.closest?.('.line-output.ai');
        const normalizedRating = String(rating || '').trim().toLowerCase();
        const sessionId = String(line?.dataset?.alignmentSessionId || api.sessionId || '').trim();
        const messageId = String(line?.dataset?.alignmentMessageId || '').trim();
        if (!line || !['up', 'down'].includes(normalizedRating)) {
            return;
        }
        if (!sessionId || !messageId) {
            this.printWarning('Alignment feedback is not ready for this response yet.');
            return;
        }

        let reason = '';
        if (normalizedRating === 'down') {
            const answer = window.prompt('What issue should the evaluator review for alignment?', '');
            if (answer === null) {
                return;
            }
            reason = String(answer || '').trim().slice(0, 500);
        }

        line.querySelectorAll('.cli-alignment-btn').forEach((entry) => {
            entry.disabled = true;
        });
        line.dataset.alignmentRating = normalizedRating;
        line.dataset.alignmentStatus = normalizedRating === 'up' ? 'recording' : 'reviewing';

        try {
            await api.submitAlignmentFeedback(sessionId, messageId, {
                rating: normalizedRating,
                reason,
            });

            line.dataset.alignmentStatus = normalizedRating === 'up' ? 'recorded' : 'reviewed';
            if (normalizedRating === 'up') {
                this.showAlignmentConfetti(line);
                this.printSuccess('Confetti yaa, alignment registered.');
            } else {
                this.printSuccess('Alignment review saved.');
            }
        } catch (error) {
            line.dataset.alignmentStatus = 'failed';
            line.querySelectorAll('.cli-alignment-btn').forEach((entry) => {
                entry.disabled = false;
            });
            this.printWarning(error.message || 'Alignment feedback failed.');
        }
    }

    showAlignmentConfetti(anchor = null) {
        const burst = document.createElement('div');
        burst.className = 'cli-confetti-burst';
        burst.textContent = 'Confetti yaa';

        const target = anchor?.querySelector?.('.cli-response-head, .voxel-response-head') || anchor || this.terminalOutput;
        target.appendChild(burst);
        window.setTimeout(() => burst.remove(), 1400);
    }

    buildAlignmentActionsMarkup() {
        return `
            <div class="cli-alignment-actions" aria-label="Response alignment feedback">
                <button type="button" class="cli-alignment-btn" data-alignment-rating="up" onclick="app.submitAlignmentFeedback(this, 'up')" title="Mark response aligned" aria-label="Mark response aligned" disabled>Thumbs up</button>
                <button type="button" class="cli-alignment-btn" data-alignment-rating="down" onclick="app.submitAlignmentFeedback(this, 'down')" title="Review alignment" aria-label="Review alignment" disabled>Thumbs down</button>
            </div>
        `;
    }

    toggleAIResponse(button) {
        const line = button?.closest?.('.line-output.ai');
        if (!line) {
            return;
        }

        const collapsed = !line.classList.contains('is-collapsed');
        line.classList.toggle('is-collapsed', collapsed);
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        button.setAttribute('aria-label', collapsed ? 'Expand response' : 'Collapse response');
        button.title = collapsed ? 'Expand response' : 'Collapse response';
        button.textContent = collapsed ? '-' : 'v';
    }

    renderAIContent(text, options = {}) {
        const body = this.renderMarkdown(text);
        const isStreaming = options.streaming === true;
        const title = options.title || 'AI Output';
        const toggleMarkup = `
            <button
                type="button"
                class="ai-response-toggle"
                onclick="app.toggleAIResponse(this)"
                aria-label="Collapse response"
                aria-expanded="true"
                title="Collapse response"
            >v</button>
        `;

        if (this.theme !== 'voxel') {
            return `
                <div class="cli-response-shell${isStreaming ? ' cli-response-shell--streaming' : ''}">
                    <div class="cli-response-head">
                        ${toggleMarkup}
                        <span class="cli-response-title">${this.escapeHtml(title)}</span>
                        ${isStreaming ? '' : this.buildAlignmentActionsMarkup()}
                    </div>
                    <div class="cli-response-body">${body}</div>
                </div>
            `;
        }

        const meta = options.meta || `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`;
        return `
            <div class="voxel-response-head">
                <span class="voxel-response-title"><span class="voxel-response-pip" aria-hidden="true"></span>${this.escapeHtml(title)}</span>
                ${toggleMarkup}
                <span class="voxel-response-meta">${this.escapeHtml(meta)}</span>
                ${isStreaming ? '' : this.buildAlignmentActionsMarkup()}
            </div>
            <div class="voxel-response-body">${body}</div>
        `;
    }
    
    printSystem(text) {
        const line = document.createElement('div');
        line.className = 'line line-output system';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.terminalOutput.scrollTop = 0;
    }
    
    printError(text) {
        const line = document.createElement('div');
        line.className = 'line line-output error';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ? ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }
    
    printWarning(text) {
        const line = document.createElement('div');
        line.className = 'line line-output';
        line.style.color = 'var(--warning)';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ? ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }

    printSuccess(text) {
        const line = document.createElement('div');
        line.className = 'line line-output success';
        line.innerHTML = `<span class="timestamp">${this.getTimestamp()}</span> ${this.escapeHtml(text)}`;
        this.terminalOutput.appendChild(line);
        this.scrollToBottom();
    }

    normalizeProgressStepStatus(status = '') {
        switch (String(status || '').trim().toLowerCase()) {
            case 'completed':
            case 'complete':
            case 'done':
            case 'success':
                return 'completed';
            case 'in_progress':
            case 'running':
            case 'active':
            case 'working':
                return 'in_progress';
            case 'failed':
            case 'error':
            case 'blocked':
                return 'failed';
            case 'skipped':
                return 'skipped';
            default:
                return 'pending';
        }
    }

    normalizeProgressStepTitle(value = null, fallback = '') {
        const raw = typeof value === 'string'
            ? value
            : String(value?.title || value?.label || value?.summary || value?.reason || value?.text || fallback || '');
        return raw
            .replace(/\s*\[truncated\s+\d+\s+chars\]\s*$/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
    }

    buildFallbackProgressSteps(phase = 'thinking', detail = '') {
        const normalizedPhase = String(phase || '').toLowerCase();
        const labels = normalizedPhase.includes('tool') || normalizedPhase.includes('checking')
            ? ['Plan request', 'Run tool', 'Review result', 'Answer']
            : ['Understand request', 'Plan next steps', 'Execute work', 'Summarize result'];
        const activeMap = {
            planning: 1,
            reasoning: 1,
            thinking: 1,
            executing: 2,
            'checking-tools': 2,
            writing: 3,
            finalizing: 3,
            ready: 3,
        };
        const activeIndex = Number.isInteger(activeMap[normalizedPhase]) ? activeMap[normalizedPhase] : 1;
        return labels.map((title, index) => ({
            id: `fallback-${index + 1}`,
            title: index === activeIndex && detail ? this.normalizeProgressStepTitle(detail, title) : title,
            status: index < activeIndex ? 'completed' : (index === activeIndex ? 'in_progress' : 'pending'),
        }));
    }

    normalizeProgressState(rawProgress = {}, options = {}) {
        const progress = rawProgress && typeof rawProgress === 'object' ? rawProgress : {};
        const phase = String(progress.phase || options.phase || 'thinking').trim() || 'thinking';
        const detail = String(progress.detail || options.detail || '').replace(/\s+/g, ' ').trim();
        let steps = (Array.isArray(progress.steps) ? progress.steps : [])
            .map((step, index) => {
                const title = this.normalizeProgressStepTitle(step, `Step ${index + 1}`);
                if (!title) {
                    return null;
                }
                return {
                    id: String(step?.id || `step-${index + 1}`),
                    title,
                    status: this.normalizeProgressStepStatus(step?.status),
                };
            })
            .filter(Boolean);

        if (steps.length < 2) {
            steps = this.buildFallbackProgressSteps(phase, detail);
        }

        const totalSteps = Math.max(steps.length, Number(progress.totalSteps || progress.total_steps || steps.length) || steps.length);
        const completedHint = Number(progress.completedSteps ?? progress.completed_steps);
        const activeStepId = String(progress.activeStepId || progress.active_step_id || '').trim();
        let activeStepIndex = Number.isFinite(Number(progress.activeStepIndex ?? progress.active_step_index))
            ? Math.max(0, Math.min(steps.length - 1, Math.round(Number(progress.activeStepIndex ?? progress.active_step_index))))
            : steps.findIndex((step) => activeStepId && step.id === activeStepId);

        if (Number.isFinite(completedHint) && completedHint >= 0) {
            steps = steps.map((step, index) => (
                index < completedHint && !['failed', 'skipped'].includes(step.status)
                    ? { ...step, status: 'completed' }
                    : step
            ));
        }

        if (activeStepIndex < 0) {
            activeStepIndex = steps.findIndex((step) => step.status === 'in_progress');
        }
        if (activeStepIndex < 0) {
            activeStepIndex = steps.findIndex((step) => step.status === 'pending');
        }
        if (activeStepIndex >= 0 && steps[activeStepIndex]?.status === 'pending') {
            steps = steps.map((step, index) => index === activeStepIndex
                ? { ...step, status: 'in_progress' }
                : step);
        }

        const completedSteps = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
        const progressUnits = progress.terminal === true
            ? totalSteps
            : Math.min(totalSteps, completedSteps + (activeStepIndex >= 0 && completedSteps < totalSteps ? 0.45 : 0));
        const percent = totalSteps > 0
            ? Math.max(8, Math.min(100, Math.round((progressUnits / totalSteps) * 100)))
            : 0;

        return {
            ...progress,
            phase,
            detail,
            summary: String(progress.summary || `${completedSteps}/${totalSteps} steps complete`).trim(),
            terminal: progress.terminal === true || options.terminal === true,
            totalSteps,
            completedSteps,
            activeStepIndex,
            percent,
            steps,
        };
    }

    ensureLiveProgressCard() {
        const existing = this.terminalOutput.querySelector('.line-output.agent-progress-card-line.stream-progress');
        if (existing) {
            return existing;
        }

        const line = document.createElement('div');
        line.className = 'line line-output system agent-progress-card-line stream-progress';
        this.terminalOutput.appendChild(line);
        return line;
    }

    getProgressPhaseLabel(phase = '') {
        const normalized = String(phase || '').toLowerCase();
        const labels = {
            planning: 'Planning',
            reasoning: 'Reasoning',
            thinking: 'Thinking',
            executing: 'Working',
            'checking-tools': 'Using tools',
            writing: 'Writing',
            finalizing: 'Finalizing',
            ready: 'Ready',
            blocked: 'Blocked',
        };
        return labels[normalized] || 'Working';
    }

    renderLiveProgressCard() {
        const progressState = this.liveProgressState;
        if (!progressState) {
            return;
        }

        const line = this.ensureLiveProgressCard();
        const phaseLabel = this.getProgressPhaseLabel(progressState.phase);
        const reasoning = this.liveReasoningSummary || progressState.detail || progressState.summary || 'Working through the next step.';
        const toolEvents = this.liveToolEvents.slice(-3);
        const toolMarkup = toolEvents.length
            ? `<div class="agent-progress-card__tools">${toolEvents.map((event) => `
                <span class="agent-progress-card__tool agent-progress-card__tool--${this.escapeHtmlAttr(event.stage || 'started')}">
                    ${this.escapeHtml(event.detail || event.toolName || 'Tool event')}
                </span>
            `).join('')}</div>`
            : '';
        const stepsMarkup = progressState.steps.map((step, index) => {
            const isActive = index === progressState.activeStepIndex;
            return `
                <li class="agent-progress-card__step agent-progress-card__step--${this.escapeHtmlAttr(step.status)}${isActive ? ' is-active' : ''}">
                    <span class="agent-progress-card__step-dot" aria-hidden="true"></span>
                    <span class="agent-progress-card__step-title">${this.escapeHtml(step.title)}</span>
                </li>
            `;
        }).join('');

        line.innerHTML = `
            <div class="agent-progress-card${progressState.terminal ? ' is-terminal' : ' is-live'}" aria-live="polite">
                <div class="agent-progress-card__header">
                    <span class="agent-progress-card__phase">${this.escapeHtml(phaseLabel)}</span>
                    <span class="agent-progress-card__badge">${progressState.terminal ? 'Final' : 'Live'}</span>
                </div>
                <div class="agent-progress-card__summary">${this.escapeHtml(reasoning)}</div>
                <div class="agent-progress-card__bar" aria-hidden="true"><span style="width:${progressState.percent}%"></span></div>
                <ol class="agent-progress-card__steps">${stepsMarkup}</ol>
                ${toolMarkup}
            </div>
        `;
        this.scrollToBottom();
    }

    updateLiveProgressCardFromChunk(chunk = {}) {
        const progress = chunk.progress && typeof chunk.progress === 'object' ? chunk.progress : {};
        this.liveProgressState = this.normalizeProgressState(progress, {
            phase: chunk.phase || progress.phase || 'thinking',
            detail: chunk.detail || progress.detail || '',
        });
        this.renderLiveProgressCard();
    }

    updateLiveReasoningSummary(summary = '') {
        const normalized = String(summary || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return;
        }
        this.liveReasoningSummary = normalized;
        this.liveProgressState = this.normalizeProgressState(this.liveProgressState || {}, {
            phase: 'reasoning',
            detail: normalized,
        });
        this.renderLiveProgressCard();
    }

    updateLiveToolEvent(chunk = {}) {
        const event = {
            stage: String(chunk.stage || '').toLowerCase().includes('complete') ? 'completed' : 'started',
            toolName: String(chunk.toolName || chunk.tool_name || 'tool'),
            detail: String(chunk.detail || 'Running tool').replace(/\s+/g, ' ').trim(),
        };
        this.liveToolEvents.push(event);
        this.liveToolEvents = this.liveToolEvents.slice(-8);
        this.liveProgressState = this.normalizeProgressState(this.liveProgressState || {}, {
            phase: event.stage === 'completed' ? 'checking-tools' : 'executing',
            detail: event.detail,
        });
        this.renderLiveProgressCard();
    }

    finalizeLiveProgressCard(options = {}) {
        const existing = this.terminalOutput.querySelector('.line-output.agent-progress-card-line.stream-progress');
        if (!existing && !this.liveProgressState) {
            return;
        }

        const finalPhase = String(options.phase || 'ready').trim().toLowerCase();
        const removeOnComplete = options.removeOnComplete !== false && finalPhase !== 'blocked';
        if (removeOnComplete) {
            const line = existing || this.terminalOutput.querySelector('.line-output.agent-progress-card-line');
            if (line) {
                line.remove();
            }
            this.liveProgressState = null;
            this.liveReasoningSummary = '';
            this.liveToolEvents = [];
            return;
        }

        if (this.liveProgressState) {
            this.liveProgressState = this.normalizeProgressState({
                ...this.liveProgressState,
                terminal: true,
                completedSteps: this.liveProgressState.totalSteps,
                steps: this.liveProgressState.steps.map((step) => (
                    step.status === 'failed' ? step : { ...step, status: 'completed' }
                )),
                phase: options.phase || 'ready',
                detail: options.detail || this.liveProgressState.detail,
            }, { terminal: true });
            this.renderLiveProgressCard();
        }

        const line = this.terminalOutput.querySelector('.line-output.agent-progress-card-line.stream-progress');
        if (line) {
            line.classList.remove('stream-progress');
        }
        this.liveProgressState = null;
        this.liveReasoningSummary = '';
        this.liveToolEvents = [];
    }

    updateProgressLine(text) {
        const normalized = String(text || '').trim();
        if (!normalized) {
            return;
        }

        const existing = this.terminalOutput.querySelector('.line-output.system.stream-progress');
        const content = `<span class="timestamp">${this.getTimestamp()}</span> ... ${this.escapeHtml(normalized)}`;
        if (existing) {
            existing.innerHTML = content;
        } else {
            const line = document.createElement('div');
            line.className = 'line line-output system stream-progress';
            line.innerHTML = content;
            this.terminalOutput.appendChild(line);
        }
        this.scrollToBottom();
    }

    finalizeProgressLine() {
        const existing = this.terminalOutput.querySelector('.line-output.system.stream-progress');
        if (existing) {
            existing.classList.remove('stream-progress');
        }
    }
    
    printWelcome() {
        this.terminalOutput.innerHTML = '';
        if (this.theme === 'voxel') {
            this.printVoxelBoot();
        } else {
            this.printSystem('Welcome to Lilly Code CLI v3.0');
            this.printSystem('Type /help for available commands');
            this.printSystem(`Session started: ${new Date().toLocaleString()}`);
        }
        this.terminalOutput.appendChild(document.createElement('div')).style.height = '8px';
        if (this.theme === 'voxel') {
            const resetWelcomeScroll = () => {
                this.terminalOutput.scrollTop = 0;
            };
            resetWelcomeScroll();
            requestAnimationFrame(resetWelcomeScroll);
            window.setTimeout(resetWelcomeScroll, 80);
        }
    }

    printVoxelBoot() {
        const line = document.createElement('div');
        line.className = 'line line-output ai';
        const currentModel = this.escapeHtml(api.currentModel || 'loading');
        const sessionLabel = this.escapeHtml(api.sessionId ? api.sessionId.slice(0, 8) : 'pending');
        line.innerHTML = `
            <div class="voxel-response-head">
                <span>KimiBuilt Web CLI</span>
                <span class="voxel-response-meta">${this.escapeHtml(new Date().toLocaleString())}</span>
            </div>
            <div class="voxel-response-body">
                <div class="voxel-boot">
                    <div class="voxel-boot-main">
                        <div class="voxel-boot-kicker">Agent command surface</div>
                        <div class="voxel-boot-title">Command from the browser, keep the terminal rhythm.</div>
                        <div class="voxel-boot-copy">Chat, inspect tools, run sandboxes, call remote agents, and keep generated files in the same session.</div>
                        <div class="voxel-boot-status-grid" aria-label="Current web CLI status">
                            <div class="voxel-boot-status">
                                <span>Mode</span>
                                <strong>chat</strong>
                            </div>
                            <div class="voxel-boot-status">
                                <span>Model</span>
                                <strong>${currentModel}</strong>
                            </div>
                            <div class="voxel-boot-status">
                                <span>Session</span>
                                <strong>${sessionLabel}</strong>
                            </div>
                        </div>
                        <div class="voxel-command-grid" aria-label="Suggested commands">
                            <button type="button" class="voxel-command-chip voxel-command-chip--primary" onclick="app.useVoxelQuickTool('chat')">
                                <code>Ask</code>
                                <span>Start with a normal request</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/tools', { submit: true })">
                                <code>/tools</code>
                                <span>Inspect available actions</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/skills', { submit: true })">
                                <code>/skills</code>
                                <span>Route with reusable skills</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/files', { submit: true })">
                                <code>/files</code>
                                <span>Review generated artifacts</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useCommandSuggestion('/remote plan', { submit: true })">
                                <code>/remote plan</code>
                                <span>See remote deploy lanes</span>
                            </button>
                            <button type="button" class="voxel-command-chip" onclick="app.useVoxelQuickTool('build')">
                                <code>Build</code>
                                <span>Draft a repo task prompt</span>
                            </button>
                        </div>
                    </div>
                    <div class="voxel-boot-side" aria-label="Companion and backend contract">
                        <div class="voxel-mini-pet" data-voxel-mini-pet></div>
                        <div class="voxel-boot-contract">
                            <div class="voxel-boot-kicker">Live contract</div>
                            <ul>
                                <li><span>/api/chat</span><strong>SSE</strong></li>
                                <li><span>/api/tools</span><strong>actions</strong></li>
                                <li><span>/api/skills</span><strong>routing</strong></li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.terminalOutput.appendChild(line);

        const petSlot = line.querySelector('[data-voxel-mini-pet]');
        if (petSlot && this.voxel && this.voxelPet) {
            petSlot.appendChild(this.voxel.renderElement(this.voxelPet, { action: 'idle', variant: 'peek', decorative: true }));
        }

        this.scrollToBottom();
    }
    
    printHelp() {
        this.printAI(`
## Available Commands

**General:**
  /help, /?          Show this help message
  /clear, /cls       Clear the screen
  /new [name]        Start a fresh isolated backend session
  /sessions          List isolated Voxel CLI sessions
  /switch <id>       Switch to a session by number, id, or id prefix
  /delete <id>       Delete a session by number, id, or id prefix
  /theme [name]      Set voxel or a shared web-chat theme
  /theme list        Show available shared themes
  /voxel             Switch back to the voxel CLI theme
  /shortcuts, /keys  Show keyboard shortcuts

**Voxel Command Deck:**
  /pet <prompt>      Spawn a prompt-generated voxel pet
  /pet random        Spawn a random 3D voxel character
  /pet ai <prompt>   Ask AI to design and fill the voxel pet
  /agent <prompt>    AI-backed voxel agent generator
  /random-agent      Spawn a random 3D voxel character
  /creator           Focus the voxel creator panel
  /pet act <action>  Run jump, dance, scout, guard, or sleep
  /pet name <name>   Rename the active pet
  /pet hide|show     Hide prompt pet or open creator
  /buddy             Open the voxel coding buddy panel
  /toolbelt          Show chat/tools/files shortcuts
  /build             Show the coding-agent build workflow
  /remote <cmd>      status, tools, plan, run, or verify through remote CLI
  /sandbox <lang>    Run code, or save previewable HTML/Vite-style projects

**AI Controls:**
  /models            List available AI models
  /model <name>      Change AI model
  /tools [category]  List frontend-available tools
  /tool <id> <json>  Invoke a tool with JSON params
  /tool-help <id>    Show on-demand documentation for a tool
  /skills [search]   List registered low-context skills
  /skill <id>        Show one registered skill
  /skill-create <json>
                     Create a reusable skill chain
  /skill-update <id> <json>
                     Update a reusable skill chain
  /image <prompt>    Generate an image
                     Defaults to the backend image model (official OpenAI if configured)
                     Options: --model gpt-image-2|gpt-image-1.5|gpt-image-1|gpt-image-1-mini
                     --size auto|1024x1024|1536x1024|1024x1536 --quality auto|low|medium|high
                     --format png|jpeg|webp --compression 0-100 --background auto|opaque
  /image-models      List available image models
  /unsplash <query>  Search Unsplash for stock images
                     Options: --orientation landscape|portrait|squarish
  /podcast <topic>   Create a basic audio podcast
                     Options: --music --audio --intro --outro --system "extra prompt"
  /video-podcast <topic>
                     Create a video podcast; add --music for background soundtrack
  /diagram <type>    Generate Mermaid diagram
  /upload            Upload a file for context

**Session:**
  /session           Show session information
  /session new       Start a fresh isolated backend session
  /session list      List isolated Voxel CLI sessions
  /session switch    Switch to a session by number, id, or id prefix
  /session delete    Delete a session by number, id, or id prefix
  /history           Show persisted isolated session history
  /artifacts         Show persisted isolated session artifacts
  /stats             Show session statistics
  /save <name>       Save conversation
  /load <name>       Load conversation
  /export            Export session to JSON file
  /copy              Copy last response to clipboard

**Files:**
  /files, /ls        List session files
  /download <id>     Download file by ID
  /open              Open file manager (GUI)

**System:**
  /health            Check API connection health

Type any message to chat with the AI.
        `.trim());
    }

    printToolbeltCard() {
        const personality = this.voxelPersonality || {};
        this.printAI(`## Lilly Coding Toolbelt

Your buddy is focused on the three primary actions in the prompt bar.

- Chat starts a normal Lilly conversation.
- \`/tools [category]\` and \`/tool-help <id>\` inspect the backend tool catalog.
- \`/skills\`, \`/skill-create {...}\`, and \`/skill-update <id> {...}\` manage reusable low-context chains.
- \`/files\` and \`/open\` manage generated session files.

Buddy stats: bond ${Math.round(personality.bond || 0)}%, guided runs ${personality.buildRuns || 0}, tool runs ${personality.toolRuns || 0}.`);
    }

    printBuildDeck() {
        this.setActiveVoxelTool('build');
        this.printAI(`## Build Mode

Use this when you want the agent to build through the remote CLI pipeline.

1. Describe the target behavior in the prompt.
2. The agent uses \`remote-command\` through the remote runner first, with SSH as fallback.
3. Planned inspect, search, edit, build, test, deploy, rollout, and verify steps continue automatically.
4. The agent stops for off-plan sudo/package installs, secret mutation, destructive deletes, force pushes, missing credentials, repeated failures, or unclear recovery.
5. Use \`/remote tools\` for the command catalog, \`/remote status\` for runner health, \`/remote run <command>\` for expert execution, and \`/remote verify [host]\` for HTTPS checks.

Good prompt:
\`\`\`text
Improve the repo feature that handles <area>. Keep changes scoped, run relevant tests, and summarize the verification.
\`\`\``);
    }

    printSandboxHelp() {
        this.printAI(`## Sandbox Command

Run short code snippets through the backend \`code-sandbox\` tool, or persist previewable frontend project files.

Usage:
\`\`\`text
/sandbox <language> <code>
/sandbox project {"projectName":"demo","files":[{"path":"index.html","content":"<h1>Hello</h1>"}]}
\`\`\`

Languages: \`javascript\`, \`python\`, \`bash\`, \`sql\`, \`ruby\`, \`go\`, \`rust\`, \`html\`, \`vite\`

Examples:
\`\`\`text
/sandbox javascript console.log([1,2,3].map(n => n * 2))
/sandbox python print(sum(range(10)))
/sandbox bash printf "voxel-ready"
/sandbox html <!doctype html><html><body><h1>Preview me</h1></body></html>
\`\`\``);
    }

    async invokeSandboxCommand(args = []) {
        const language = String(args[0] || '').toLowerCase();
        const code = args.slice(1).join(' ').trim();
        const languages = new Set(['javascript', 'python', 'bash', 'sql', 'ruby', 'go', 'rust', 'html', 'vite', 'project']);

        this.setActiveVoxelTool('sandbox');
        if (!languages.has(language) || !code) {
            this.printSandboxHelp();
            return;
        }

        this.setStatus('thinking');
        this.reactVoxelPet(code, 'guard');
        this.recordVoxelToolUse('sandbox');

        try {
            let params = {
                language,
                code,
                limits: {
                    timeout: 30000,
                    maxOutput: 80000,
                },
            };

            if (language === 'project') {
                try {
                    const projectParams = JSON.parse(code);
                    params = {
                        mode: 'project',
                        language: projectParams.language || 'vite',
                        code: projectParams.code || '',
                        projectName: projectParams.projectName || projectParams.name || '',
                        entry: projectParams.entry || 'index.html',
                        files: Array.isArray(projectParams.files) ? projectParams.files : [],
                    };
                } catch (error) {
                    throw new Error(`Project sandbox expects JSON after /sandbox project: ${error.message}`);
                }
            } else if (language === 'html' || language === 'vite') {
                params = {
                    mode: 'project',
                    language,
                    code,
                    projectName: `${language}-sandbox`,
                    entry: 'index.html',
                };
            }

            const invocation = await api.invokeTool('code-sandbox', params);
            const envelope = invocation?.result || {};
            const result = envelope?.data || envelope || {};
            const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 'unknown';
            const stdout = String(result.stdout || '').trim();
            const stderr = String(result.stderr || '').trim();
            const files = Array.isArray(result.files) ? result.files : [];
            const artifacts = this.collectArtifactsFromValue(result);
            const artifactFiles = this.syncArtifactsToSessionFiles(artifacts, 'sandbox-artifact');
            const artifact = artifacts[0] || result.artifact || (Array.isArray(result.artifacts) ? result.artifacts[0] : null);
            const lines = [`## Sandbox Result: \`${language}\``, '', `Exit code: \`${exitCode}\``];

            if (stdout) {
                lines.push('', 'STDOUT:', '', '```text', stdout, '```');
            }

            if (stderr) {
                lines.push('', 'STDERR:', '', '```text', stderr, '```');
            }

            if (result.workspacePath) {
                lines.push('', `Workspace: \`${result.workspacePath}\``);
            }

            if (files.length > 0) {
                lines.push('', 'Files:');
                files.slice(0, 20).forEach((file) => {
                    lines.push(`- \`${file.path}\` (${this.formatFileSize(Number(file.sizeBytes) || 0)})`);
                });
            }

            if (artifact) {
                lines.push('', `Artifact: \`${artifact.filename || artifact.id}\``);
                if (artifact.sandboxUrl || artifact.previewUrl) {
                    lines.push(`Preview: ${artifact.sandboxUrl || artifact.previewUrl}`);
                }
                if (artifact.bundleDownloadUrl || artifact.downloadUrl) {
                    lines.push(`Download: ${artifact.bundleDownloadUrl || artifact.downloadUrl}`);
                }
                if (artifactFiles.length > 0) {
                    lines.push(`File IDs: ${artifactFiles.map((file) => `#${file.id}`).join(', ')}`);
                }
            }

            if (!stdout && !stderr && !result.workspacePath && !artifact) {
                lines.push('', '```json', JSON.stringify(result, null, 2), '```');
            }

            this.printAI(lines.join('\n'));
            this.handlePetAction(Number(exitCode) === 0 ? 'proud' : 'guard', { silent: true });
        } catch (error) {
            this.printError(`Sandbox failed: ${error.message}`);
            this.handlePetAction('guard', { silent: true });
        } finally {
            this.setStatus('ready');
        }
    }

    getRemoteCommandEnvelope(invocation) {
        const envelope = invocation?.result || {};
        return envelope?.data || envelope?.result || envelope || {};
    }

    formatRemoteCommandResult(result = {}) {
        const exitCode = Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 'unknown';
        const stdout = String(result.stdout || result.output || '').trim();
        const stderr = String(result.stderr || '').trim();
        const lines = ['## Remote CLI Result', '', `Exit code: \`${exitCode}\``];

        if (result.transport || result.source || result.runnerId) {
            lines.push(`Transport: \`${result.transport || result.source || 'remote'}${result.runnerId ? `:${result.runnerId}` : ''}\``);
        }
        if (result.cwd || result.workspacePath) {
            lines.push(`Workspace: \`${result.cwd || result.workspacePath}\``);
        }
        if (stdout) {
            lines.push('', 'STDOUT:', '', '```text', stdout, '```');
        }
        if (stderr) {
            lines.push('', 'STDERR:', '', '```text', stderr, '```');
        }
        if (!stdout && !stderr) {
            lines.push('', '```json', JSON.stringify(result, null, 2), '```');
        }

        return lines.join('\n');
    }

    extractRemoteAgentActionItems(text = '') {
        const lines = String(text || '').split(/\r?\n/);
        const actionItems = [];
        let capture = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (/^(#+\s*)?(next steps?|actions?|action items?|todo|follow[- ]?ups?)\b/i.test(trimmed)) {
                capture = true;
                continue;
            }
            if (capture && /^#{1,6}\s+\S/.test(trimmed)) {
                break;
            }
            if (capture) {
                const item = trimmed.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/)
                    || trimmed.match(/^[-*]\s+(.+)$/)
                    || trimmed.match(/^\d+[.)]\s+(.+)$/);
                if (item?.[1]) {
                    actionItems.push(item[1].trim());
                } else if (!trimmed && actionItems.length > 0) {
                    break;
                }
            }
        }

        return actionItems.slice(0, 8);
    }

    formatRemoteAgentResult(result = {}) {
        const finalOutput = String(result.finalOutput || result.output || '').trim();
        const lines = ['## Remote CLI Agent Result', ''];
        const metadata = [
            result.targetId ? `Target: \`${result.targetId}\`` : '',
            result.cwd ? `Workspace: \`${result.cwd}\`` : '',
            result.sessionId ? `Remote session: \`${result.sessionId}\`` : '',
            result.mcpSessionId ? `MCP session: \`${result.mcpSessionId}\`` : '',
            result.model ? `Agent model: \`${result.model}\`` : '',
            result.gitRepo ? `Repo: \`${result.gitRepo}\`` : '',
            result.gitCommit ? `Commit: \`${result.gitCommit}\`` : '',
            result.publicHost ? `Public host: \`${result.publicHost}\`` : '',
            result.uiCheckReport ? `UI check: \`${result.uiCheckReport}\`` : '',
        ].filter(Boolean);

        if (metadata.length > 0) {
            lines.push('### Run Metadata', '', ...metadata.map((item) => `- ${item}`), '');
        }

        const actionItems = this.extractRemoteAgentActionItems(finalOutput);
        if (actionItems.length > 0) {
            lines.push('### Action Items', '', ...actionItems.map((item) => `- ${item}`), '');
        }

        if (Array.isArray(result.uiScreenshots) && result.uiScreenshots.length > 0) {
            lines.push('### Screenshots', '', ...result.uiScreenshots.slice(0, 6).map((item) => `- \`${item}\``), '');
        }

        lines.push('### Agent Report', '', finalOutput || 'Remote CLI agent completed.');
        return lines.join('\n');
    }

    async loadRemoteToolCatalog() {
        const response = await api.getAvailableTools('ssh', {
            executionProfile: 'remote-build',
        });
        const tools = response?.tools || [];
        const remoteTool = tools.find((tool) => tool.id === 'remote-command')
            || tools.find((tool) => Array.isArray(tool.runtime?.commandCatalog));
        return {
            tools,
            runtime: response?.meta?.runtime || null,
            remoteTool,
            catalog: remoteTool?.runtime?.commandCatalog || [],
        };
    }

    printRemotePlan() {
        this.printAI(`## Remote CLI Plan

1. \`/remote status\` - confirm remote runner health and fallback target.
2. \`/remote tools\` - choose a catalog command: baseline, repo-inspect, file-search, build, test, docker-buildkit, kubectl-inspect, logs, rollout, or https-verify.
3. \`/remote run <command>\` - execute one purposeful inspect, fix, or verify batch.
4. \`/remote agent <task>\` - hand a full coding/build/deploy loop to the backend remote CLI agent.
5. Continue normal build/test failures while the next step is still on plan.
6. Stop and report on privilege boundaries, secrets, destructive deletes, force push, repeated failures, missing credentials, or unclear recovery.

Raw expert access remains available:
\`\`\`text
/tool remote-command {"command":"hostname && whoami && uname -m","profile":"inspect"}
\`\`\``);
    }

    async handleRemoteCommand(args = []) {
        const subcommand = String(args[0] || 'plan').toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        this.setActiveVoxelTool('tools');

        if (subcommand === 'plan' || subcommand === 'help' || subcommand === '?') {
            this.printRemotePlan();
            return;
        }

        if (subcommand === 'status') {
            this.setStatus('thinking');
            try {
                const { runtime, remoteTool, tools } = await this.loadRemoteToolCatalog();
                const runner = runtime?.remoteRunner || {};
                const ssh = runtime?.sshDefaults || {};
                const deploy = runtime?.deployDefaults || {};
                const lines = ['## Remote CLI Status', ''];
                lines.push(`Remote runner: \`${runner.healthy ? 'healthy' : 'not healthy'}\` (enabled=${runner.enabled ? 'yes' : 'no'}, preferred=${runner.preferred ? 'yes' : 'no'})`);
                lines.push(`Remote-command: \`${remoteTool?.runtime?.configured ? 'configured' : 'not configured'}\` via \`${remoteTool?.runtime?.source || 'unknown'}\``);
                lines.push(`Remote-cli-agent: \`${tools.find((tool) => tool.id === 'remote-cli-agent')?.runtime?.configured ? 'configured' : 'not configured'}\``);
                lines.push(`Default target: \`${remoteTool?.runtime?.defaultTarget || 'none'}\``);
                lines.push(`SSH fallback: \`${ssh.configured ? `${ssh.username || 'unknown'}@${ssh.host}:${ssh.port || 22}` : 'not configured'}\``);
                lines.push(`Deploy defaults: namespace=\`${deploy.namespace || 'unset'}\`, deployment=\`${deploy.deployment || 'unset'}\`, domain=\`${deploy.publicDomain || 'unset'}\``);
                if (Array.isArray(runner.runners) && runner.runners.length) {
                    lines.push('', 'Runners:');
                    runner.runners.slice(0, 8).forEach((item) => {
                        lines.push(`- \`${item.runnerId || item.id || 'runner'}\` healthy=${item.healthy ? 'yes' : 'no'} host=${item.hostname || item.host || 'unknown'}`);
                    });
                }
                this.printAI(lines.join('\n'));
            } catch (error) {
                this.printError(`Remote status failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'tools') {
            this.setStatus('thinking');
            try {
                const { catalog } = await this.loadRemoteToolCatalog();
                if (!catalog.length) {
                    this.printSystem('No remote CLI command catalog is available.');
                    return;
                }
                const lines = ['## Remote CLI Tools', ''];
                catalog.forEach((entry) => {
                    lines.push(`- \`${entry.id}\` (${entry.profile || 'inspect'}): ${entry.description || entry.purpose || 'Remote command pattern.'}`);
                    if (entry.command) {
                        lines.push(`  \`${entry.command}\``);
                    }
                });
                this.printAI(lines.join('\n'));
            } catch (error) {
                this.printError(`Remote tools failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'run') {
            if (!rest) {
                this.printError('Usage: /remote run <command>');
                return;
            }
            this.setStatus('thinking');
            this.recordVoxelToolUse('tool');
            try {
                const invocation = await api.invokeTool('remote-command', {
                    command: rest,
                    profile: 'build',
                    workflowAction: 'remote-cli-manual-run',
                    timeout: 120000,
                });
                this.printAI(this.formatRemoteCommandResult(this.getRemoteCommandEnvelope(invocation)));
            } catch (error) {
                this.printError(`Remote run failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'agent') {
            if (!rest) {
                this.printError('Usage: /remote agent <coding/build/deploy task>');
                return;
            }
            this.setStatus('thinking');
            this.recordVoxelToolUse('tool');
            try {
                this.liveProgressState = this.normalizeProgressState({
                    phase: 'planning',
                    detail: 'Preparing the remote CLI agent and target workspace.',
                    steps: [
                        { id: 'catalog', title: 'Load remote runner catalog', status: 'in_progress' },
                        { id: 'launch', title: 'Launch remote CLI agent', status: 'pending' },
                        { id: 'run', title: 'Run remote coding loop', status: 'pending' },
                        { id: 'report', title: 'Format result and action items', status: 'pending' },
                    ],
                });
                this.renderLiveProgressCard();
                const { runtime, tools } = await this.loadRemoteToolCatalog();
                const remoteAgent = tools.find((tool) => tool.id === 'remote-cli-agent') || null;
                this.liveProgressState = this.normalizeProgressState({
                    ...this.liveProgressState,
                    phase: 'executing',
                    detail: 'Remote CLI agent is running. This can include repo edits, deploy checks, and verification.',
                    steps: [
                        { id: 'catalog', title: 'Load remote runner catalog', status: 'completed' },
                        { id: 'launch', title: 'Launch remote CLI agent', status: 'completed' },
                        { id: 'run', title: 'Run remote coding loop', status: 'in_progress' },
                        { id: 'report', title: 'Format result and action items', status: 'pending' },
                    ],
                });
                this.renderLiveProgressCard();
                const invocation = await api.invokeTool('remote-cli-agent', {
                    task: rest,
                    cwd: remoteAgent?.runtime?.defaultCwd || runtime?.remoteRunner?.defaultWorkspace || '',
                    waitMs: 30000,
                    maxTurns: 30,
                    adminMode: true,
                }, {
                    executionProfile: 'remote-build',
                    timeout: 900000,
                    metadata: {
                        remoteBuildAutonomyApproved: true,
                        remoteCommandSource: 'web-cli',
                    },
                });
                const result = invocation?.result?.data || invocation?.result?.result || invocation?.result || {};
                this.liveProgressState = this.normalizeProgressState({
                    ...this.liveProgressState,
                    phase: 'finalizing',
                    detail: 'Remote CLI agent returned a report. Extracting metadata and next actions.',
                    steps: [
                        { id: 'catalog', title: 'Load remote runner catalog', status: 'completed' },
                        { id: 'launch', title: 'Launch remote CLI agent', status: 'completed' },
                        { id: 'run', title: 'Run remote coding loop', status: 'completed' },
                        { id: 'report', title: 'Format result and action items', status: 'in_progress' },
                    ],
                });
                this.renderLiveProgressCard();
                this.finalizeLiveProgressCard({ detail: 'Remote CLI agent completed.' });
                this.printAI(this.formatRemoteAgentResult(result));
            } catch (error) {
                this.liveProgressState = this.normalizeProgressState({
                    ...(this.liveProgressState || {}),
                    phase: 'blocked',
                    detail: error.message,
                    steps: (this.liveProgressState?.steps || []).map((step) => (
                        step.status === 'in_progress' ? { ...step, status: 'failed' } : step
                    )),
                });
                this.renderLiveProgressCard();
                this.finalizeLiveProgressCard({ phase: 'blocked', detail: error.message });
                this.printError(`Remote agent failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        if (subcommand === 'verify') {
            const host = rest || 'demoserver2.buzz';
            if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) {
                this.printError('Host must be a domain, IP address, or host:port without shell characters.');
                return;
            }
            const command = `host=${JSON.stringify(host)}\ngetent ahosts "$host" || true\ncurl -fsSIL --max-time 20 "https://$host"`;
            this.setStatus('thinking');
            this.recordVoxelToolUse('tool');
            try {
                const invocation = await api.invokeTool('remote-command', {
                    command,
                    profile: 'inspect',
                    workflowAction: 'remote-cli-https-verify',
                    timeout: 60000,
                });
                this.printAI(this.formatRemoteCommandResult(this.getRemoteCommandEnvelope(invocation)));
            } catch (error) {
                this.printError(`Remote verify failed: ${error.message}`);
            } finally {
                this.setStatus('ready');
            }
            return;
        }

        this.printError('Usage: /remote status | /remote tools | /remote plan | /remote run <command> | /remote agent <task> | /remote verify [host]');
    }

    async listTools(category = null) {
        this.setActiveVoxelTool('tools');
        try {
            const toolResponse = await api.getAvailableTools(category);
            const tools = Array.isArray(toolResponse) ? toolResponse : (toolResponse.tools || []);
            const runtime = toolResponse?.meta?.runtime || null;
            if (!tools.length) {
                this.printSystem(category ? `No tools available in category "${category}".` : 'No tools are currently available.');
                return;
            }

            const lines = ['## Available Tools', ''];
            if (runtime) {
                const gatewayScope = runtime.modelGateway?.internalCluster ? 'internal cluster' : 'external endpoint';
                lines.push(`Runtime source: \`${runtime.source || 'backend'}\``);
                lines.push(`Model gateway: \`${runtime.modelGateway?.baseURL || 'unknown'}\` (${gatewayScope})`);
                if (runtime.sshDefaults?.enabled) {
                    const target = runtime.sshDefaults.host
                        ? `${runtime.sshDefaults.username || 'unknown'}@${runtime.sshDefaults.host}:${runtime.sshDefaults.port || 22}`
                        : 'not set';
                    lines.push(`SSH defaults: source=${runtime.sshDefaults.source || 'unknown'}, target=${target}, configured=${runtime.sshDefaults.configured ? 'yes' : 'no'}`);
                } else {
                    lines.push('SSH defaults: disabled');
                }
                lines.push('');
            }

            tools.forEach((tool) => {
                const params = Array.isArray(tool.parameters)
                    ? tool.parameters
                    : Object.keys(tool.inputSchema?.properties || {});
                lines.push(`- \`${tool.id}\` (${tool.category})`);
                lines.push(`  ${tool.description || 'No description provided.'}`);
                if (tool.support?.status) {
                    lines.push(`  Support: ${tool.support.status}`);
                }
                if (tool.runtime?.defaultTarget) {
                    lines.push(`  Runtime: ${tool.runtime.defaultTarget} via ${tool.runtime.source || 'unknown'}`);
                } else if (tool.runtime && Object.prototype.hasOwnProperty.call(tool.runtime, 'configured')) {
                    lines.push(`  Runtime: configured=${tool.runtime.configured ? 'yes' : 'no'}`);
                }
                if (params.length) {
                    const paramNames = Array.isArray(params)
                        ? params.map((param) => typeof param === 'string' ? param : param.name).filter(Boolean)
                        : [];
                    if (paramNames.length) {
                        lines.push(`  Params: ${paramNames.join(', ')}`);
                    }
                }
            });
            lines.push('');
            lines.push('Usage: /tool <id> {"key":"value"}');
            lines.push('Help: /tool-help <id>');
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to load tools: ${error.message}`);
        }
    }

    async showToolHelp(args) {
        const [toolId] = args;
        if (!toolId) {
            this.printError('Usage: /tool-help <id>');
            return;
        }

        this.setActiveVoxelTool('tools');
        this.setStatus('thinking');
        try {
            const doc = await api.getToolDoc(toolId);
            this.printAI(`## Tool Help: \`${toolId}\`\n\nSupport: \`${doc?.support?.status || 'unknown'}\`\n\n${doc?.content || 'No documentation found.'}`);
        } catch (error) {
            this.printError(`Tool help failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }

    async listSkills(search = '') {
        this.setActiveVoxelTool('tools');
        try {
            const response = await api.listSkills({ search });
            const skills = Array.isArray(response) ? response : (response.skills || []);
            const meta = response?.meta || {};

            if (!skills.length) {
                this.printSystem(search ? `No skills matched "${search}".` : 'No registered skills yet.');
                return;
            }

            const lines = ['## Registered Skills', ''];
            if (meta.root) {
                lines.push(`Location: \`${meta.root}\``);
                lines.push('');
            }
            skills.forEach((skill) => {
                lines.push(`- \`${skill.id}\` - ${skill.name || skill.id}`);
                if (skill.description) {
                    lines.push(`  ${skill.description}`);
                }
                if (Array.isArray(skill.tools) && skill.tools.length > 0) {
                    lines.push(`  Tools: ${skill.tools.map((tool) => `\`${tool}\``).join(', ')}`);
                }
            });
            lines.push('');
            lines.push('Usage: /skill <id>, /skill-create {...}, /skill-update <id> {...}');
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to load skills: ${error.message}`);
        }
    }

    async showSkill(args) {
        const [skillId] = args;
        if (!skillId) {
            this.printError('Usage: /skill <id>');
            return;
        }

        this.setActiveVoxelTool('tools');
        this.setStatus('thinking');
        try {
            const skill = await api.getSkill(skillId);
            this.printAI(`## Skill: \`${skill.id}\`\n\n${skill.description || 'No description provided.'}\n\nTools: ${(skill.tools || []).map((tool) => `\`${tool}\``).join(', ') || 'none'}\n\nTriggers: ${(skill.triggerPatterns || []).map((trigger) => `\`${trigger}\``).join(', ') || 'none'}\n\n\`\`\`markdown\n${skill.body || ''}\n\`\`\``);
        } catch (error) {
            this.printError(`Skill read failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }

    async createSkillCommand(args) {
        const rawPayload = args.join(' ').trim();
        if (!rawPayload) {
            this.printError('Usage: /skill-create {"name":"...","description":"...","body":"...","tools":["image-generate"]}');
            return;
        }

        try {
            const response = await api.createSkill(JSON.parse(rawPayload));
            const skill = response?.data || {};
            this.printAI(`## Skill Saved\n\n\`${skill.id || 'unknown'}\` is registered in \`${response?.meta?.root || 'data/skills'}\`.`);
        } catch (error) {
            this.printError(`Skill create failed: ${error.message}`);
        }
    }

    async updateSkillCommand(args) {
        const [skillId, ...payloadParts] = args;
        if (!skillId || payloadParts.length === 0) {
            this.printError('Usage: /skill-update <id> {"description":"...","body":"..."}');
            return;
        }

        try {
            const response = await api.updateSkill(skillId, JSON.parse(payloadParts.join(' ')));
            const skill = response?.data || {};
            this.printAI(`## Skill Updated\n\n\`${skill.id || skillId}\` is registered in \`${response?.meta?.root || 'data/skills'}\`.`);
        } catch (error) {
            this.printError(`Skill update failed: ${error.message}`);
        }
    }

    async invokeToolCommand(args) {
        const [toolId, ...paramParts] = args;
        if (!toolId) {
            this.printError('Usage: /tool <id> {"key":"value"}');
            return;
        }

        const rawParams = paramParts.join(' ').trim();
        let params = {};

        if (rawParams) {
            try {
                params = JSON.parse(rawParams);
            } catch (error) {
                this.printError(`Invalid JSON params: ${error.message}`);
                return;
            }
        }

        this.setActiveVoxelTool('tools');
        this.setStatus('thinking');
        this.recordVoxelToolUse('tool');
        try {
            const invocation = await api.invokeTool(toolId, params);
            const artifactFiles = this.syncArtifactsToSessionFiles(
                this.collectArtifactsFromValue(invocation?.result),
                'tool-artifact'
            );
            const serialized = JSON.stringify(invocation?.result, null, 2);
            const artifactNote = artifactFiles.length > 0
                ? `\n\nAdded artifact file(s): ${artifactFiles.map((file) => `#${file.id}`).join(', ')}. Use /files to manage.`
                : '';
            this.printAI(`## Tool Result: \`${toolId}\`\n\n\`\`\`json\n${serialized}\n\`\`\`${artifactNote}`);
        } catch (error) {
            this.printError(`Tool failed: ${error.message}`);
        } finally {
            this.setStatus('ready');
        }
    }
    
    printDiagramHelp() {
        this.printAI(`
## Diagram Command

Generate Mermaid diagrams using the AI or templates.

**Usage:**
  /diagram <type> [description]

**Diagram Types:**
  flowchart   - Flowchart diagram (default)
  sequence    - Sequence diagram
  class       - Class diagram
  er          - Entity relationship diagram
  mindmap     - Mind map
  gantt       - Gantt chart
  pie         - Pie chart
  state       - State diagram
  gitgraph    - Git graph

**Examples:**
  /diagram flowchart login process
  /diagram sequence user authentication
  /diagram class user management system
  /diagram mindmap project planning

The AI will generate appropriate Mermaid syntax. If AI is unavailable, a template will be used.
        `.trim());
    }

    sanitizeMermaidCode(text, type = '') {
        let source = String(text || '')
            .replace(/\r\n?/g, '\n')
            .trim();

        if (!source) {
            return '';
        }

        source = source.replace(/^```mermaid\s*/i, '');
        source = source.replace(/^```\s*/i, '');
        source = source.replace(/```\s*$/i, '');

        const normalizedType = String(type || '').toLowerCase();
        const whitespaceSensitive = normalizedType === 'mindmap';

        if (!source.includes('\n') && !whitespaceSensitive && /\s{2,}/.test(source)) {
            source = source
                .split(/\s{2,}/)
                .map((line) => line.trim())
                .filter(Boolean)
                .join('\n');
        }

        source = source
            .replace(/^(flowchart|graph)\s+([A-Za-z]{2})\s+(?=\S)/i, '$1 $2\n')
            .replace(/^(sequenceDiagram|classDiagram|erDiagram|stateDiagram(?:-v2)?|gitGraph|journey|timeline)\s+(?=\S)/i, '$1\n');

        if (!whitespaceSensitive) {
            source = source.replace(
                /\s+(?=(?:style|classDef|class|linkStyle|click|subgraph|end|section|participant|actor|note|title|accTitle|accDescr)\b)/g,
                '\n',
            );
        }

        return source
            .split('\n')
            .flatMap((line) => (
                !whitespaceSensitive && /\s{2,}/.test(line) && !/^\s/.test(line)
                    ? line.split(/\s{2,}/)
                    : [line]
            ))
            .map((line) => line.trimEnd())
            .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
            .join('\n')
            .trim();
    }

    async validateMermaidCode(source) {
        if (typeof mermaid === 'undefined' || typeof mermaid.parse !== 'function') {
            return true;
        }

        try {
            await mermaid.parse(source);
            return true;
        } catch (error) {
            console.warn('[CLI] Mermaid validation failed:', error);
            return false;
        }
    }
    
    // ==================== Helper Methods ====================
    
    renderMarkdown(text) {
        const codeBlocks = [];
        let source = window.LillyModelOutputParser?.normalizeModelOutputMarkdown
            ? window.LillyModelOutputParser.normalizeModelOutputMarkdown(text)
            : String(text || '');
        if (window.LillyModelOutputParser?.normalizePresentationMarkupMarkdown) {
            source = window.LillyModelOutputParser.normalizePresentationMarkupMarkdown(source);
        }
        source = String(source || '').replace(/\r\n?/g, '\n');
        
        // Code blocks (including mermaid)
        source = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (match, lang, code) => {
            const language = String(lang || 'text').trim().split(/\s+/)[0] || 'text';
            const trimmedCode = language === 'mermaid'
                ? this.sanitizeMermaidCode(code)
                : code.trim();
            const escapedCode = this.escapeHtml(trimmedCode);
            const flaggedToolPayload = this.detectToolPayloadBlock(language, trimmedCode);
            if (flaggedToolPayload) {
                codeBlocks.push(this.renderFlaggedToolPayloadBlock(flaggedToolPayload, language, trimmedCode));
                return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
            }
            
            // Special handling for mermaid diagrams
            if (language === 'mermaid') {
                const filenameBase = `diagram-${Date.now()}`;
                codeBlocks.push(`
                    <div class="diagram-block">
                        <div class="code-block mermaid-code">
                            <div class="code-header">
                                <span>mermaid</span>
                                <div class="code-actions">
                                    <button class="code-action-btn" onclick="app.copyCode(this)" aria-label="Copy code">Copy</button>
                                    <button class="code-action-btn" onclick="app.downloadMermaidSourceFromButton(this)" data-code="${this.escapeHtmlAttr(trimmedCode)}" data-filename="${filenameBase}.mmd" aria-label="Download Mermaid source">.mmd</button>
                                    <button class="code-action-btn" onclick="app.downloadMermaidPdfFromButton(this)" data-code="${this.escapeHtmlAttr(trimmedCode)}" data-filename="${filenameBase}.pdf" aria-label="Download Mermaid PDF">PDF</button>
                                </div>
                            </div>
                            <pre><code class="language-mermaid nohighlight">${escapedCode}</code></pre>
                        </div>
                        <div class="diagram-preview">
                            <div class="mermaid-render-surface" data-mermaid-source="${this.escapeHtmlAttr(trimmedCode)}" data-mermaid-filename="${filenameBase}">
                                <div class="text-sm" style="color: var(--text-secondary);">Rendering diagram...</div>
                            </div>
                        </div>
                    </div>
                `);
                return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
            }
            
            codeBlocks.push(`
                <div class="code-block">
                    <div class="code-header">
                        <span>${language}</span>
                        <div class="code-actions">
                            <button class="code-action-btn" onclick="app.copyCode(this)" aria-label="Copy code">Copy</button>
                        </div>
                    </div>
                    <pre><code class="language-${language}">${escapedCode}</code></pre>
                </div>
            `);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });

        let html = this.renderMarkdownBlocks(source);
        html = html.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => codeBlocks[Number(index)] || match);
        
        return `<div class="markdown-content">${html}</div>`;
    }

    detectToolPayloadBlock(language = '', code = '') {
        const normalizedLanguage = String(language || '').trim().toLowerCase();
        if (!['json', 'javascript', 'js', 'text', ''].includes(normalizedLanguage)) {
            return null;
        }

        if (window.LillyModelOutputParser?.detectToolPayload) {
            return window.LillyModelOutputParser.detectToolPayload(code);
        }

        try {
            const payload = JSON.parse(String(code || '').trim());
            const command = String(payload?.command || payload?.params?.command || '').trim();
            const toolId = String(payload?.tool || payload?.toolId || payload?.name || '').trim().toLowerCase().replace(/_/g, '-');
            const hasRemoteTarget = Boolean(payload?.host || payload?.hostname || payload?.username || payload?.port);
            if (command && (toolId === 'remote-command' || hasRemoteTarget)) {
                return {
                    toolId: toolId || 'remote-command',
                    command,
                    host: String(payload.host || payload.hostname || '').trim(),
                    username: String(payload.username || '').trim(),
                    port: payload.port || null,
                    payload,
                };
            }
        } catch (_error) {
            return null;
        }

        return null;
    }

    renderFlaggedToolPayloadBlock(payload = {}, language = 'json', code = '') {
        const toolId = String(payload.toolId || 'remote-command').trim() || 'remote-command';
        const host = [payload.username, payload.host].filter(Boolean).join('@');
        const target = [host || payload.host || '', payload.port ? `:${payload.port}` : ''].join('').trim();
        const command = String(payload.command || '').trim();
        const preview = command.length > 220 ? `${command.slice(0, 217)}...` : command;
        const meta = [
            `tool=${toolId}`,
            target ? `target=${target}` : '',
        ].filter(Boolean).join(' | ');
        const displayLanguage = String(language || 'json').trim() || 'json';

        return `
            <details class="tool-payload-flag">
                <summary>
                    <span class="tool-payload-flag__badge">Flagged</span>
                    <span class="tool-payload-flag__title">Remote command payload appeared in assistant text</span>
                    <span class="tool-payload-flag__meta">${this.escapeHtml(meta)}</span>
                </summary>
                <div class="tool-payload-flag__body">
                    ${preview ? `<div class="tool-payload-flag__command"><code class="inline-code">${this.escapeHtml(preview)}</code></div>` : ''}
                    <div class="code-block">
                        <div class="code-header">
                            <span>${this.escapeHtml(displayLanguage)}</span>
                            <div class="code-actions">
                                <button class="code-action-btn" onclick="app.copyCode(this)" aria-label="Copy code">Copy</button>
                            </div>
                        </div>
                        <pre><code class="language-${this.escapeHtmlAttr(displayLanguage)}">${this.escapeHtml(code)}</code></pre>
                    </div>
                </div>
            </details>
        `;
    }

    renderMarkdownBlocks(source) {
        const lines = String(source || '').split('\n');
        const blocks = [];
        let i = 0;

        const isSpecialBlock = (line) => (
            /^(#{1,6})\s+/.test(line)
            || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
            || /^\s*[-*+]\s+/.test(line)
            || /^\s*\d+[.)]\s+/.test(line)
            || /^\|.+\|$/.test(line)
            || /^>\s?/.test(line)
            || /^__CODE_BLOCK_\d+__$/.test(line.trim())
        );

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
                i += 1;
                continue;
            }

            if (/^__CODE_BLOCK_\d+__$/.test(trimmed)) {
                blocks.push(trimmed);
                i += 1;
                continue;
            }

            const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (heading) {
                const level = Math.min(6, heading[1].length);
                blocks.push(`<h${level}>${this.renderInlineMarkdown(heading[2])}</h${level}>`);
                i += 1;
                continue;
            }

            if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                blocks.push('<hr>');
                i += 1;
                continue;
            }

            if (/^\|.+\|$/.test(trimmed) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
                const headerCells = this.parseMarkdownTableRow(trimmed);
                i += 2;
                const rows = [];
                while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
                    rows.push(this.parseMarkdownTableRow(lines[i].trim()));
                    i += 1;
                }
                blocks.push(`
                    <table>
                        <thead><tr>${headerCells.map((cell) => `<th>${this.renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>
                        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${this.renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
                    </table>
                `);
                continue;
            }

            if (/^\s*[-*+]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*[-*+]\s+/, '').trim());
                    i += 1;
                }
                blocks.push(`<ul>${items.map((item) => `<li>${this.renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
                continue;
            }

            if (/^\s*\d+[.)]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
                    items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '').trim());
                    i += 1;
                }
                blocks.push(`<ol>${items.map((item) => `<li>${this.renderInlineMarkdown(item)}</li>`).join('')}</ol>`);
                continue;
            }

            if (/^>\s?/.test(line)) {
                const quoteLines = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) {
                    quoteLines.push(lines[i].replace(/^>\s?/, '').trim());
                    i += 1;
                }
                const callout = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|SUCCESS|DANGER|INFO)\]\s*(.*)$/i);
                if (callout) {
                    const tone = String(callout[1] || 'note').toLowerCase();
                    const title = String(callout[2] || this.getPresentationCalloutLabel(tone)).trim();
                    const body = quoteLines.slice(1).filter(Boolean);
                    blocks.push(`
                        <div class="kb-callout kb-callout--${tone}">
                            <div class="kb-callout__title">${this.renderInlineMarkdown(title)}</div>
                            ${body.length > 0 ? `<div class="kb-callout__body">${body.map((item) => this.renderInlineMarkdown(item)).join('<br>')}</div>` : ''}
                        </div>
                    `);
                    continue;
                }
                blocks.push(`<blockquote>${quoteLines.map((item) => this.renderInlineMarkdown(item)).join('<br>')}</blockquote>`);
                continue;
            }

            const paragraphLines = [trimmed];
            i += 1;
            while (i < lines.length && lines[i].trim() && !isSpecialBlock(lines[i].trim())) {
                paragraphLines.push(lines[i].trim());
                i += 1;
            }
            blocks.push(`<p>${this.renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
        }

        return blocks.join('');
    }

    parseMarkdownTableRow(line) {
        return String(line || '')
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim());
    }

    getPresentationCalloutLabel(tone = '') {
        return ({
            note: 'Note',
            tip: 'Tip',
            important: 'Important',
            warning: 'Warning',
            success: 'Success',
            danger: 'Danger',
            info: 'Info',
        })[String(tone || '').toLowerCase()] || 'Note';
    }

    renderInlineMarkdown(text) {
        const inlineCodes = [];
        let html = String(text || '').replace(/`([^`]+)`/g, (match, code) => {
            inlineCodes.push(`<code class="inline-code">${this.escapeHtml(code)}</code>`);
            return `__INLINE_CODE_${inlineCodes.length - 1}__`;
        });

        html = this.escapeHtml(html);
        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        html = html.replace(/&lt;mark class=&quot;kb-highlight&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g, '<mark class="kb-highlight">$1</mark>');
        html = html.replace(/&lt;span class=&quot;kb-tone kb-tone--(accent|success|warning|danger|info|muted)&quot;&gt;([\s\S]*?)&lt;\/span&gt;/g, '<span class="kb-tone kb-tone--$1">$2</span>');
        html = html.replace(/__INLINE_CODE_(\d+)__/g, (match, index) => inlineCodes[Number(index)] || match);

        return html;
    }
    
    /**
     * Render Mermaid diagrams after content is added to DOM
     */
    renderMermaidDiagrams(element) {
        if (typeof mermaid !== 'undefined') {
            try {
                const nodes = Array.from(element?.querySelectorAll?.('.mermaid-render-surface') || document.querySelectorAll('.mermaid-render-surface'));
                nodes.forEach(async (node) => {
                    const source = this.sanitizeMermaidCode(node.dataset.mermaidSource || '');
                    if (!source || node.dataset.renderedSource === source) {
                        return;
                    }

                    try {
                        const result = await mermaid.render(
                            `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                            source,
                        );
                        node.innerHTML = result.svg;
                        node.dataset.renderedSource = source;
                        if (typeof result.bindFunctions === 'function') {
                            result.bindFunctions(node);
                        }
                    } catch (error) {
                        node.innerHTML = `
                            <div class="text-sm" style="color: var(--error); margin-bottom: 8px;">Mermaid render failed: ${this.escapeHtml(error.message)}</div>
                            <pre><code>${this.escapeHtml(source)}</code></pre>
                        `;
                        delete node.dataset.renderedSource;
                    }
                });
            } catch (err) {
                console.warn('[CLI] Mermaid rendering failed:', err);
            }
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeHtmlAttr(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    getMermaidFilename(baseName = 'diagram', extension = 'mmd') {
        return `${String(baseName || 'diagram').replace(/\.[a-z0-9]+$/i, '')}.${extension}`;
    }

    downloadMermaidSourceFromButton(button) {
        const source = this.sanitizeMermaidCode(button?.dataset?.code || '');
        if (!source) {
            this.printWarning('No Mermaid source available to download.');
            return;
        }

        this.downloadFile(source, this.getMermaidFilename(button?.dataset?.filename || 'diagram', 'mmd'), 'text/plain');
    }

    async svgMarkupToImage(svgMarkup) {
        const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);

        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Failed to load Mermaid SVG'));
                img.src = svgUrl;
            });
            return image;
        } finally {
            URL.revokeObjectURL(svgUrl);
        }
    }

    async createMermaidPdfBlob(source) {
        if (!window.PDFLib?.PDFDocument) {
            throw new Error('PDF library is not loaded');
        }
        if (typeof mermaid === 'undefined') {
            throw new Error('Mermaid is not loaded');
        }

        const result = await mermaid.render(
            `mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            source,
        );
        const image = await this.svgMarkupToImage(result.svg);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(image.naturalWidth || image.width || 1200));
        canvas.height = Math.max(1, Math.ceil(image.naturalHeight || image.height || 800));

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        const pngDataUrl = canvas.toDataURL('image/png');
        const pngBytes = await fetch(pngDataUrl).then((response) => response.arrayBuffer());

        const pdfDoc = await window.PDFLib.PDFDocument.create();
        const pngImage = await pdfDoc.embedPng(pngBytes);
        const margin = 36;
        const pageWidth = Math.max(612, canvas.width + margin * 2);
        const pageHeight = Math.max(792, canvas.height + margin * 2);
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const scale = Math.min(
            (pageWidth - margin * 2) / pngImage.width,
            (pageHeight - margin * 2) / pngImage.height,
            1,
        );

        page.drawImage(pngImage, {
            x: (pageWidth - (pngImage.width * scale)) / 2,
            y: (pageHeight - (pngImage.height * scale)) / 2,
            width: pngImage.width * scale,
            height: pngImage.height * scale,
        });

        const pdfBytes = await pdfDoc.save({
            updateFieldAppearances: false,
            useObjectStreams: false,
        });

        return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    async downloadMermaidPdfFromButton(button) {
        const source = this.sanitizeMermaidCode(button?.dataset?.code || '');
        if (!source) {
            this.printWarning('No Mermaid source available to export.');
            return;
        }

        try {
            const pdfBlob = await this.createMermaidPdfBlob(source);
            this.downloadFile(pdfBlob, this.getMermaidFilename(button?.dataset?.filename || 'diagram', 'pdf'), 'application/pdf');
            this.printSystem('Mermaid PDF downloaded.');
        } catch (error) {
            console.error('[CLI] Mermaid PDF export failed:', error);
            this.printError(`Failed to export Mermaid PDF: ${error.message}`);
        }
    }
    
    getTimestamp() {
        const now = new Date();
        return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    }
    
    scrollToBottom() {
        this.terminalOutput.scrollTop = this.terminalOutput.scrollHeight;
        this.enforceScrollbackLimit();
    }
    
    enforceScrollbackLimit(maxLines = 1000) {
        const lines = this.terminalOutput.querySelectorAll('.line, .imported-file');
        if (lines.length > maxLines) {
            const toRemove = lines.length - maxLines;
            for (let i = 0; i < toRemove; i++) {
                lines[i].remove();
            }
        }
    }
    
    // ==================== API Methods ====================
    
    async checkConnection() {
        try {
            this.statusDot.className = 'status-dot connecting';
            this.statusText.textContent = 'Connecting...';
            
            const health = await api.healthCheck();
            
            if (health.connected) {
                this.statusDot.className = 'status-dot online';
                this.statusText.textContent = 'Connected';
            } else {
                this.statusDot.className = 'status-dot offline';
                this.statusText.textContent = 'Disconnected';
                this.roamVoxelPet('alert', 'guard', 1200);
            }
        } catch (error) {
            this.statusDot.className = 'status-dot offline';
            this.statusText.textContent = 'Offline';
            this.roamVoxelPet('alert', 'guard', 1200);
        }
    }
    
    async checkHealth() {
        this.setStatus('thinking');
        try {
            const health = await api.healthCheck();
            this.printSystem(`Health Check:
  Status: ${health.connected ? '? Connected' : '? Disconnected'}
  Version: ${health.version || 'unknown'}
  Models: ${health.models || 'unknown'}
            `.trim());
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Health check failed: ${error.message}`);
            this.setStatus('error');
        }
    }
    
    async loadModels() {
        try {
            const models = await api.getModels();
            if (models.length === 0) {
                throw new Error('No models returned');
            }
            const selectableModels = models.some((model) => model.id === 'auto')
                ? models
                : [{ id: 'auto' }, ...models];
            this.modelSelect.innerHTML = selectableModels.map(m =>
                `<option value="${m.id}" ${m.id === api.currentModel ? 'selected' : ''}>${m.id}</option>`
            ).join('');
            this.updateModelInfo();
        } catch (error) {
            this.modelSelect.innerHTML = '<option value="auto">auto</option>';
            api.setModel('auto');
            this.updateModelInfo();
        }
    }
    
    async listModels() {
        try {
            const models = await api.getModels();
            this.printAI(`## Available Models\n\n${models.map(m => '  - ' + m.id).join('\n')}`);
        } catch (error) {
            this.printError('Failed to load models');
        }
    }
    async listImageModels() {
        try {
            const models = await api.getImageModels();
            if (!Array.isArray(models) || models.length === 0) {
                this.printError('No image models available');
                return;
            }

            this.printAI(`## Available Image Models\n\n${models.map((model) => {
                const details = [];
                if (Array.isArray(model.sizes) && model.sizes.length > 0) {
                    details.push(`sizes: ${model.sizes.join(', ')}`);
                }
                if (Array.isArray(model.qualities) && model.qualities.length > 0) {
                    details.push(`qualities: ${model.qualities.join(', ')}`);
                }
                if (Array.isArray(model.styles) && model.styles.length > 0) {
                    details.push(`styles: ${model.styles.join(', ')}`);
                }
                const suffix = details.length > 0 ? ` (${details.join(' | ')})` : '';
                return `  - ${model.name || model.id || 'Backend default'}${suffix}`;
            }).join('\n')}`);
        } catch (error) {
            this.printError(`Failed to load image models: ${error.message}`);
        }
    }

    
    updateModelInfo() {
        const model = api.currentModel || 'auto';
        
        // Update the select dropdown to match current model
        if (this.modelSelect) {
            // Check if the model exists in the dropdown
            const options = Array.from(this.modelSelect.options);
            const modelExists = options.some(opt => opt.value === model);
            
            if (modelExists) {
                this.modelSelect.value = model;
            } else if (options.length > 0 && options[0].value !== 'Loading models...') {
                // If model not in list, add it as a temporary option
                const tempOption = document.createElement('option');
                tempOption.value = model;
                tempOption.textContent = model;
                this.modelSelect.insertBefore(tempOption, this.modelSelect.firstChild);
                this.modelSelect.value = model;
            }
        }
        
        // Update header model display
        const headerModel = document.getElementById('headerModelDisplay');
        if (headerModel) {
            headerModel.textContent = model;
            headerModel.title = `Current model: ${model}`;
        }
    }
    
    // ==================== File Handling ====================
    
    triggerFileUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.md,.json,.js,.ts,.py,.html,.css,.sql,.docx,.pdf';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) this.handleFile(file);
        };
        input.click();
    }
    
    async handleFile(file) {
        this.setStatus('thinking');
        
        try {
            const content = await api.uploadFile(file);
            this.printSystem(`File uploaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
            this.printAI(`File content from "${file.name}":\n\n\`\`\`\n${content.substring(0, 2000)}${content.length > 2000 ? '\n... (truncated)' : ''}\n\`\`\``);
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Failed to process file: ${error.message}`);
            this.setStatus('error');
        }
    }
    
    // ==================== Image Generation ====================

    getImageDiagnosticSummary(response) {
        const diagnostics = response?.diagnostics?.imageGeneration || response?.imageDiagnostics || null;
        if (!diagnostics || typeof diagnostics !== 'object') {
            return '';
        }

        const counts = diagnostics.counts || {};
        const flags = diagnostics.flags || {};
        const provider = diagnostics.provider || {};
        const transport = diagnostics.transport || {};
        const artifactPersistence = diagnostics.artifactPersistence || {};
        const parts = [
            diagnostics.code || 'image_diagnostics',
            diagnostics.stage ? `stage=${diagnostics.stage}` : '',
            provider.source ? `provider=${provider.source}` : '',
            provider.status ? `providerStatus=${provider.status}` : '',
            transport.category ? `transport=${transport.category}` : '',
            artifactPersistence.primaryReason ? `artifactPersistence=${artifactPersistence.primaryReason}` : '',
            `parsed=${Number(counts.parsedImageRecords || 0)}`,
            `returned=${Number(counts.returnedImageRecords || 0)}`,
            `usable=${Number(counts.usableReturnedImageRecords || 0)}`,
            `artifacts=${Number(counts.artifacts || 0)}`,
        ].filter(Boolean);
        const usableCount = Number(counts.usableReturnedImageRecords || 0);
        const artifactCount = Number(counts.artifacts || 0);
        const likely = (flags.likelyArtifactPersistenceIssue || (usableCount > 0 && artifactCount === 0))
            ? 'Backend parsed usable image data, but no reusable artifact was persisted; inspect artifact persistence/image validation path.'
            : flags.providerSocketClosedByPeer
                ? 'Provider/router closed the socket before an HTTP response completed; inspect gateway logs, upstream connectivity, and proxy timeouts.'
                : flags.likelyFrontendReceiveOrParserIssue
                    ? 'Backend sent usable persisted image data; inspect the web CLI receive/parser path.'
                    : (diagnostics.likelyCause || '');

        return `${parts.join(' | ')}${likely ? ` | ${likely}` : ''}`;
    }

    printImageDiagnosticError(message, response) {
        const summary = this.getImageDiagnosticSummary(response);
        this.printError(summary ? `${message}\n${summary}` : message);
    }
    
    async generateImage(input) {
        if (!input) {
            this.printError('Please provide a prompt. Usage: /image <prompt> [--model gpt-image-2] [--size auto] [--quality auto]');
            return;
        }
        
        // Parse options from input
        const { prompt, options } = this.parseImageArgs(input);
        
        if (!prompt) {
            this.printError('Please provide a prompt. Usage: /image <prompt> [--model gpt-image-2] [--size auto] [--quality auto]');
            return;
        }
        
        this.isProcessing = true;
        this.setStatus('thinking');
        this.printSystem(`Generating image with ${options.model || 'gpt-image-2'}...`);
        
        try {
            const response = await api.generateImage(prompt, options);
            
            const generatedImages = Array.isArray(response.data) ? response.data : [];

            if (generatedImages.length > 0) {
                const timestamp = Date.now();
                const fileIds = generatedImages
                    .map((image, index) => {
                        const imageUrl = image.b64_json
                            ? `data:image/png;base64,${image.b64_json}`
                            : image.url || null;
                        if (!imageUrl) {
                            return null;
                        }

                        return this.addSessionFile(
                            `image-${timestamp}-${index + 1}.png`,
                            imageUrl,
                            'image/png',
                            'image'
                        );
                    })
                    .filter((file) => file && file.id)
                    .map((file) => file.id)
                    .filter((fileId) => fileId !== null);

                if (fileIds.length === 0) {
                    this.printImageDiagnosticError('No usable image data received from API', response);
                    this.setStatus('error');
                    return;
                }

                this.printSystem('Image generated with ' + (response.model || options.model || 'gpt-image-2') + ' (' + (response.size || options.size || 'auto') + ')');
                this.printSystem('Saved ' + fileIds.length + ' image file(s): #' + fileIds.join(', #') + '. Use /download <id> or /open.');
            } else {
                this.printImageDiagnosticError('No image data received from API', response);
            }
            
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Image generation failed: ${error.message}`);
            this.setStatus('error');
        } finally {
            this.isProcessing = false;
        }
    }
    
    /**
     * Parse image command arguments
     * Supports: --model, --size, --quality, --style, --format, --compression, --background, --moderation
     */
    parseImageArgs(input) {
        const options = {
            model: null,
            size: 'auto',
            quality: null,
            style: null,
            output_format: null,
            output_compression: null,
            background: null,
            moderation: null
        };
        
        let prompt = input;
        
        // Parse --model
        const modelMatch = input.match(/--model\s+(\S+)/);
        if (modelMatch) {
            options.model = modelMatch[1];
            prompt = prompt.replace(modelMatch[0], '').trim();
        }
        
        // Parse --size
        const sizeMatch = input.match(/--size\s+(\S+)/);
        if (sizeMatch) {
            options.size = sizeMatch[1];
            prompt = prompt.replace(sizeMatch[0], '').trim();
        }
        
        // Parse --quality
        const qualityMatch = input.match(/--quality\s+(\S+)/);
        if (qualityMatch) {
            options.quality = qualityMatch[1];
            prompt = prompt.replace(qualityMatch[0], '').trim();
        }
        
        // Parse --style
        const styleMatch = input.match(/--style\s+(\S+)/);
        if (styleMatch) {
            options.style = styleMatch[1];
            prompt = prompt.replace(styleMatch[0], '').trim();
        }

        const formatMatch = input.match(/--(?:output-)?format\s+(\S+)/);
        if (formatMatch) {
            options.output_format = formatMatch[1];
            prompt = prompt.replace(formatMatch[0], '').trim();
        }

        const compressionMatch = input.match(/--compression\s+(\S+)/);
        if (compressionMatch) {
            options.output_compression = Number(compressionMatch[1]);
            prompt = prompt.replace(compressionMatch[0], '').trim();
        }

        const backgroundMatch = input.match(/--background\s+(\S+)/);
        if (backgroundMatch) {
            options.background = backgroundMatch[1];
            prompt = prompt.replace(backgroundMatch[0], '').trim();
        }

        const moderationMatch = input.match(/--moderation\s+(\S+)/);
        if (moderationMatch) {
            options.moderation = moderationMatch[1];
            prompt = prompt.replace(moderationMatch[0], '').trim();
        }
        
        return { prompt: prompt.trim(), options };
    }
    
    /**
     * Search Unsplash for stock images
     */
    async searchUnsplash(query) {
        if (!query) {
            this.printError('Please provide a search query. Usage: /unsplash <query> [--orientation landscape|portrait|squarish]');
            return;
        }
        
        // Parse options
        let searchQuery = query;
        let orientation = null;
        
        const orientationMatch = query.match(/--orientation\s+(landscape|portrait|squarish)/);
        if (orientationMatch) {
            orientation = orientationMatch[1];
            searchQuery = searchQuery.replace(orientationMatch[0], '').trim();
        }
        
        if (!searchQuery) {
            this.printError('Please provide a search query. Usage: /unsplash <query> [--orientation landscape|portrait|squarish]');
            return;
        }
        
        this.isProcessing = true;
        this.setStatus('thinking');
        this.printSystem(`Searching Unsplash for "${searchQuery}"...`);
        
        try {
            const response = await api.searchUnsplash(searchQuery, { orientation });
            
            if (response.results && response.results.length > 0) {
                this.displayUnsplashResults(response.results, searchQuery, response.total);
            } else {
                this.printWarning(`No images found for "${searchQuery}"`);
            }
            
            this.setStatus('ready');
        } catch (error) {
            this.printError(`Unsplash search failed: ${error.message}`);
            this.setStatus('error');
        } finally {
            this.isProcessing = false;
        }
    }
    
    /**
     * Display Unsplash search results
     */
    displayUnsplashResults(results, query, total) {
        let output = `## Unsplash Results for "${this.escapeHtml(query)}"\n\n`;
        output += `Found ${total} images. Showing top ${results.length}:\n\n`;
        
        results.forEach((image, index) => {
            const num = index + 1;
            const author = image.author ? image.author.name : 'Unknown';
            const dimensions = `${image.width}x${image.height}`;
            
            output += `${num}. **${this.escapeHtml(image.altDescription || image.description || 'Untitled')}**\n`;
            output += `   ?? ${dimensions} | ?? ${image.likes} | ?? ${this.escapeHtml(author)}\n`;
            output += `   ?? [View on Unsplash](${image.links.html})\n\n`;
            
            // Add small thumbnail preview
            output += `   <img src="${image.urls.small}" alt="${this.escapeHtml(image.altDescription || '')}" style="max-width: 300px; border-radius: 4px; margin: 5px 0;" />\n\n`;
        });
        
        output += `---\n`;
        output += `To download, click the image or visit the Unsplash link.\n`;
        output += `Images are licensed under the [Unsplash License](https://unsplash.com/license).`;
        
        this.printAI(output);
    }
    
    /**
     * Generate a Mermaid diagram file
     */
    async generateDiagram(type = 'flowchart', description = '') {
        this.isProcessing = true;
        this.setStatus('thinking');
        
        try {
            // Try to get AI-generated diagram code
            const diagramPrompt = `Create a ${type} diagram for: ${description || 'a simple process'}
            
Return ONLY Mermaid v10.9.5 compatible syntax code.
Use newline-separated statements.
Do not wrap the answer in markdown code fences.
Do not put the entire diagram on one line.`;
            
            const response = await api.sendMessage(diagramPrompt);
            let diagramCode = this.sanitizeMermaidCode(response.content || '', type);
            
            // If no valid code returned, use template
            if (!diagramCode || diagramCode.length < 10) {
                diagramCode = this.getMermaidTemplate(type, description);
            }

            const isValid = await this.validateMermaidCode(diagramCode);
            if (!isValid) {
                this.printWarning('AI-generated Mermaid was invalid for v10.9.5. Using a safe template instead.');
                diagramCode = this.getMermaidTemplate(type, description);
            }
            
            // Create and download file
            const baseName = `diagram-${type}-${Date.now()}`;
            const filename = `${baseName}.mmd`;
            this.downloadFile(diagramCode, filename, 'text/plain');
            const pdfFilename = `${baseName}.pdf`;
            let pdfBlob = null;
            try {
                pdfBlob = await this.createMermaidPdfBlob(diagramCode);
                this.downloadFile(pdfBlob, pdfFilename, 'application/pdf');
            } catch (pdfError) {
                console.error('[CLI] Mermaid PDF export failed:', pdfError);
                this.printWarning(`Mermaid PDF export failed: ${pdfError.message}`);
            }
            
            // Add to session files
            const file = this.addSessionFile(filename, diagramCode, 'text/plain', 'diagram');
            const pdfFile = pdfBlob
                ? this.addSessionFile(pdfFilename, pdfBlob, 'application/pdf', 'diagram')
                : null;
            
            // Show preview in terminal
            this.printAI(`## Generated ${type} diagram

\`\`\`mermaid
${diagramCode}
\`\`\`

**Downloaded:** ${filename}
${pdfFile ? `**Downloaded:** ${pdfFilename}\n` : ''}**File IDs:** #${file.id}${pdfFile ? `, #${pdfFile.id}` : ''} (use /files to manage)`);
            
            this.setStatus('ready');
        } catch (error) {
            // Fallback: generate template
            const diagramCode = this.getMermaidTemplate(type, description);
            const baseName = `diagram-${type}-${Date.now()}`;
            const filename = `${baseName}.mmd`;
            this.downloadFile(diagramCode, filename, 'text/plain');
            let pdfBlob = null;
            let pdfFilename = `${baseName}.pdf`;
            try {
                pdfBlob = await this.createMermaidPdfBlob(diagramCode);
                this.downloadFile(pdfBlob, pdfFilename, 'application/pdf');
            } catch (pdfError) {
                console.error('[CLI] Mermaid PDF fallback export failed:', pdfError);
            }
            
            // Add to session files
            const file = this.addSessionFile(filename, diagramCode, 'text/plain', 'diagram');
            const pdfFile = pdfBlob
                ? this.addSessionFile(pdfFilename, pdfBlob, 'application/pdf', 'diagram')
                : null;
            
            this.printAI(`## Generated ${type} diagram (template)

\`\`\`mermaid
${diagramCode}
\`\`\`

**Downloaded:** ${filename}
${pdfFile ? `**Downloaded:** ${pdfFilename}\n` : ''}**File IDs:** #${file.id}${pdfFile ? `, #${pdfFile.id}` : ''} (use /files to manage)`);
            
            this.setStatus('ready');
        } finally {
            this.isProcessing = false;
        }
    }
    
    /**
     * Get Mermaid template
     */
    getMermaidTemplate(type, description) {
        const desc = description || 'Process';
        const templates = {
            flowchart: `graph TD
    A[Start] --> B{${desc}?}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[Result]
    D --> E
    E --> F[End]`,
            sequence: `sequenceDiagram
    participant U as User
    participant S as System
    participant D as Database
    
    U->>S: ${desc}
    S->>D: Query data
    D-->>S: Return results
    S-->>U: Display response`,
            class: `classDiagram
    class User {
        +String name
        +String email
        +login()
        +logout()
    }
    class System {
        +process()
    }
    User --> System : uses
    note for User "${desc}"`,
            er: `erDiagram
    USER ||--o{ ORDER : places
    USER {
        string name
        string email
    }
    ORDER {
        int id
        date created
    }`,
            mindmap: `mindmap
  root((${desc}))
    Planning
      Research
      Design
    Execution
      Development
      Testing
    Delivery`,
            gantt: `gantt
    title ${desc} Timeline
    dateFormat  YYYY-MM-DD
    section Phase 1
    Planning           :done, p1, 2024-01-01, 7d
    Design             :active, p2, after p1, 7d
    section Phase 2
    Development        :p3, after p2, 14d
    Testing            :p4, after p3, 7d`,
            pie: `pie title ${desc}
    "Category A" : 40
    "Category B" : 30
    "Category C" : 20
    "Category D" : 10`,
            state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : ${desc}
    Processing --> Success : valid
    Processing --> Error : invalid
    Success --> [*]
    Error --> Idle : retry`,
            gitgraph: `gitGraph
    commit id: "Initial"
    branch feature
    checkout feature
    commit id: "Add feature"
    checkout main
    merge feature id: "Merge ${desc}"
    commit id: "Release"`
        };
        
        return templates[type] || templates.flowchart;
    }
    
    /**
     * Download file helper
     */
    downloadFile(content, filename, mimeType) {
        const a = document.createElement('a');
        let url = null;

        if (typeof content === 'string' && /^(data:|blob:|https?:|\/)/i.test(content)) {
            url = content;
        } else {
            const blob = new Blob([content], { type: mimeType });
            url = URL.createObjectURL(blob);
        }

        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    }
    
    // ==================== Session Management ====================

    resetLocalSessionState() {
        this.history = [];
        this.historyIndex = -1;
        this.lastResponse = '';
        this.currentOutput = '';
        this.sessionStartTime = Date.now();
        this.sessionFiles = [];
        this.nextFileId = 1;
    }

    getSessionDisplayName(session = null) {
        return String(
            session?.metadata?.title
            || session?.metadata?.label
            || session?.metadata?.name
            || session?.id
            || 'Untitled session',
        ).trim();
    }

    async handleSessionCommand(args = []) {
        const subcommand = String(args[0] || '').trim().toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        if (!subcommand) {
            await this.printSessionInfo();
            return;
        }

        if (['new', 'create', 'start'].includes(subcommand)) {
            await this.startNewSession(rest);
            return;
        }

        if (['list', 'ls', 'sessions'].includes(subcommand)) {
            await this.listSessions();
            return;
        }

        if (['switch', 'use', 'open'].includes(subcommand)) {
            await this.switchSession(args[1]);
            return;
        }

        if (['delete', 'del', 'rm'].includes(subcommand)) {
            await this.deleteSession(args[1]);
            return;
        }

        this.printError('Usage: /session, /session new [name], /session list, /session switch <id>, or /session delete <id>');
    }

    async startNewSession(name = '', options = {}) {
        try {
            const sessionName = String(name || '').trim();
            const session = await api.createSession({
                title: sessionName || `Voxel CLI ${new Date().toLocaleString()}`,
            });
            this.resetLocalSessionState();
            this.updateSessionInfo();
            if (options.clear === true) {
                this.printWelcome();
            }
            this.printSystem(`Started isolated session ${session.id.slice(0, 8)}...${sessionName ? ` (${sessionName})` : ''}`);
        } catch (error) {
            this.printError(`Failed to start new session: ${error.message}`);
        }
    }

    async listSessions() {
        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];

            if (!sessions.length) {
                this.printSystem('No Voxel CLI sessions found. Use /new to start one.');
                return;
            }

            const activeSessionId = api.sessionId || data.activeSessionId || null;
            const lines = ['## Voxel CLI Sessions', ''];
            sessions.forEach((session, index) => {
                const marker = session.id === activeSessionId ? '*' : ' ';
                const title = this.getSessionDisplayName(session);
                const updatedAt = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : 'unknown time';
                const count = Number(session.messageCount || 0);
                lines.push(`${marker} ${index + 1}. ${title}`);
                lines.push(`   ${session.id} | ${count} messages | ${updatedAt}`);
                lines.push('');
            });
            lines.push('Use `/switch <number-or-id>` to activate a session.');
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to list sessions: ${error.message}`);
        }
    }

    async switchSession(sessionRef = '') {
        const ref = String(sessionRef || '').trim();
        if (!ref) {
            this.printError('Usage: /switch <number-or-session-id>');
            return;
        }

        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            const numericIndex = Number(ref);
            const session = Number.isInteger(numericIndex) && numericIndex >= 1
                ? sessions[numericIndex - 1]
                : sessions.find((candidate) => candidate.id === ref || candidate.id.startsWith(ref));

            if (!session) {
                this.printError(`Session not found: ${ref}`);
                return;
            }

            await api.setActiveSession(session.id);
            this.resetLocalSessionState();
            this.updateSessionInfo();
            await this.renderPersistedSessionHistory(session.id, {
                clear: true,
                intro: `Switched to isolated session ${session.id.slice(0, 8)}... (${this.getSessionDisplayName(session)})`,
            });
        } catch (error) {
            this.printError(`Failed to switch session: ${error.message}`);
        }
    }

    async deleteSession(sessionRef = '') {
        const ref = String(sessionRef || '').trim();
        if (!ref) {
            this.printError('Usage: /delete <number-or-session-id>');
            return;
        }

        try {
            const data = await api.getSessionState();
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            const numericIndex = Number(ref);
            const session = Number.isInteger(numericIndex) && numericIndex >= 1
                ? sessions[numericIndex - 1]
                : sessions.find((candidate) => candidate.id === ref || candidate.id.startsWith(ref));

            if (!session) {
                this.printError(`Session not found: ${ref}`);
                return;
            }

            const previousActiveSessionId = api.sessionId || data.activeSessionId || null;
            await api.deleteSession(session.id);
            this.printSystem(`Deleted isolated session ${session.id.slice(0, 8)}... (${this.getSessionDisplayName(session)})`);

            const wasActive = session.id === previousActiveSessionId;
            if (!wasActive) {
                return;
            }

            const remaining = sessions.filter((candidate) => candidate.id !== session.id);
            if (remaining[0]) {
                await api.setActiveSession(remaining[0].id);
                this.resetLocalSessionState();
                this.updateSessionInfo();
                await this.renderPersistedSessionHistory(remaining[0].id, {
                    clear: true,
                    intro: `Selected isolated session ${remaining[0].id.slice(0, 8)}... (${this.getSessionDisplayName(remaining[0])})`,
                });
                return;
            }

            api.clearSession();
            this.resetLocalSessionState();
            this.updateSessionInfo();
            this.printWelcome();
            this.printSystem('No Voxel CLI sessions remain. Use /new to start one.');
        } catch (error) {
            this.printError(`Failed to delete session: ${error.message}`);
        }
    }
    
    async printSessionInfo() {
        const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const queueSize = this.commandQueue.length;
        let historyCount = 0;
        let artifactCount = 0;

        if (api.sessionId) {
            try {
                const [messages, artifacts] = await Promise.all([
                    api.getSessionMessages(api.sessionId, 200),
                    api.getSessionArtifacts(api.sessionId),
                ]);
                historyCount = messages.length;
                artifactCount = artifacts.length;
            } catch (error) {
                console.warn('Failed to load session details:', error);
            }
        }

        this.printSystem(`Session Info:
  Isolated Session: ${api.sessionId || 'new on next request'}
  Duration: ${minutes}m ${seconds}s
  Backend History: ${historyCount}
  Backend Artifacts: ${artifactCount}
  Files: ${this.sessionFiles.length}
  Queue: ${queueSize}
  Commands: ${this.commandHistory.length}`);
    }

    async showSessionHistory() {
        if (!api.sessionId) {
            this.printSystem('No isolated session is active yet. Use /new or send a message to create one.');
            return;
        }

        try {
            const messages = await api.getSessionMessages(api.sessionId, 40);
            if (!messages.length) {
                this.printSystem('No persisted backend history for this session yet.');
                return;
            }

            const lines = ['## Isolated Session History', ''];
            messages.forEach((message, index) => {
                const role = String(message.role || 'unknown').toUpperCase();
                const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : 'unknown time';
                const content = String(message.content || '').trim() || '[empty]';
                lines.push(`${index + 1}. ${role} | ${timestamp}`);
                lines.push(content);
                lines.push('');
            });
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to load session history: ${error.message}`);
        }
    }

    async showSessionArtifacts() {
        if (!api.sessionId) {
            this.printSystem('No isolated session is active yet. Use /new or send a message to create one.');
            return;
        }

        try {
            const artifacts = await api.getSessionArtifacts(api.sessionId);
            this.syncArtifactsToSessionFiles(artifacts);
            if (!artifacts.length) {
                this.printSystem('No persisted artifacts for this session yet.');
                return;
            }

            const lines = ['## Isolated Session Artifacts', ''];
            artifacts.forEach((artifact, index) => {
                const filename = artifact.filename || artifact.id || `artifact-${index + 1}`;
                const format = String(artifact.format || 'file').toUpperCase();
                const size = Number.isFinite(Number(artifact.sizeBytes))
                    ? this.formatFileSize(Number(artifact.sizeBytes))
                    : 'unknown size';
                const createdAt = artifact.createdAt ? new Date(artifact.createdAt).toLocaleString() : 'unknown time';
                lines.push(`${index + 1}. ${filename}`);
                lines.push(`   ${format} | ${size} | ${createdAt}`);
                if (artifact.downloadUrl) {
                    lines.push(`   Download: ${artifact.downloadUrl}`);
                }
                lines.push('');
            });
            this.printAI(lines.join('\n'));
        } catch (error) {
            this.printError(`Failed to load session artifacts: ${error.message}`);
        }
    }
    saveConversation(name) {
        const data = {
            history: this.history,
            timestamp: Date.now(),
            model: api.currentModel,
        };
        localStorage.setItem(`codecli_conv_${name}`, JSON.stringify(data));
        this.printSystem(`Conversation saved as "${name}"`);
    }
    loadConversation(name) {
        const data = localStorage.getItem(`codecli_conv_${name}`);
        if (data) {
            const parsed = JSON.parse(data);
            this.history = parsed.history || [];
            this.printSystem(`Conversation "${name}" loaded (${this.history.length} messages)`);
        } else {
            this.printError(`Conversation "${name}" not found`);
        }
    }
    
    exportSession() {
        const data = {
            history: this.history,
            timestamp: Date.now(),
            model: api.currentModel
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `codecli-session-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.printSystem('Session exported');
    }
    
    // ==================== File Management ====================
    
    /**
     * Add a file to the session
     */
    addSessionFile(filename, content, mimeType, type = 'generated', metadata = {}) {
        const file = {
            id: this.nextFileId++,
            filename,
            content,
            mimeType,
            type,
            size: Number.isFinite(Number(metadata.size))
                ? Number(metadata.size)
                : new Blob([content || '']).size,
            createdAt: metadata.createdAt || new Date().toISOString(),
            artifactId: metadata.artifactId || null,
            downloadUrl: metadata.downloadUrl || null,
            previewUrl: metadata.previewUrl || null,
            bundleDownloadUrl: metadata.bundleDownloadUrl || null,
        };
        this.sessionFiles.push(file);
        return file;
    }

    collectArtifactsFromValue(value, depth = 0) {
        if (depth > 5 || value == null) {
            return [];
        }

        if (Array.isArray(value)) {
            return value.flatMap((entry) => this.collectArtifactsFromValue(entry, depth + 1));
        }

        if (typeof value !== 'object') {
            return [];
        }

        const artifacts = [];
        const normalized = this.normalizeArtifactFileSource(value);
        if (normalized) {
            artifacts.push(normalized);
        }

        [
            'artifact',
            'artifacts',
            'document',
            'documents',
            'generatedArtifact',
            'generatedArtifacts',
            'video',
            'videoArtifact',
            'data',
            'result',
        ].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                artifacts.push(...this.collectArtifactsFromValue(value[key], depth + 1));
            }
        });

        return artifacts;
    }

    normalizeArtifactFileSource(artifact = null) {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
            return null;
        }

        const id = String(artifact.id || artifact.artifactId || artifact.artifact_id || artifact.documentId || '').trim();
        const filename = String(artifact.filename || artifact.name || '').trim();
        const downloadUrl = String(artifact.bundleDownloadUrl || artifact.bundle_download_url || artifact.downloadUrl || artifact.download_url || artifact.inlinePath || '').trim();
        const previewUrl = String(artifact.previewUrl || artifact.preview_url || artifact.sandboxUrl || '').trim();
        const artifactLike = Boolean(
            filename
            || downloadUrl
            || previewUrl
            || artifact.artifactId
            || artifact.artifact_id
            || artifact.documentId
            || artifact.document_id
            || artifact.format
            || artifact.extension
            || artifact.mimeType
            || artifact.mime_type
        );

        if (!artifactLike || (!id && !downloadUrl && !previewUrl)) {
            return null;
        }

        const extension = String(artifact.extension || artifact.format || '').trim().replace(/^\./, '');
        const fallbackDownloadUrl = id ? `/api/artifacts/${encodeURIComponent(id)}/download` : '';
        return {
            ...artifact,
            id,
            filename: filename || (id ? `${id}${extension ? `.${extension}` : ''}` : 'artifact'),
            mimeType: String(artifact.mimeType || artifact.mime_type || 'application/octet-stream').trim(),
            sizeBytes: Number.isFinite(Number(artifact.sizeBytes || artifact.size))
                ? Number(artifact.sizeBytes || artifact.size)
                : 0,
            downloadUrl: downloadUrl || previewUrl || fallbackDownloadUrl,
            previewUrl,
            bundleDownloadUrl: String(artifact.bundleDownloadUrl || artifact.bundle_download_url || '').trim(),
        };
    }

    syncArtifactsToSessionFiles(artifacts = [], type = 'artifact') {
        const added = [];
        const seenInBatch = new Set();

        (Array.isArray(artifacts) ? artifacts : [artifacts]).forEach((artifact) => {
            const normalized = this.normalizeArtifactFileSource(artifact);
            if (!normalized) {
                return;
            }

            const identity = normalized.id
                || normalized.downloadUrl
                || normalized.bundleDownloadUrl
                || normalized.previewUrl
                || normalized.filename;
            if (!identity || seenInBatch.has(identity)) {
                return;
            }
            seenInBatch.add(identity);

            const exists = this.sessionFiles.some((file) => (
                (normalized.id && file.artifactId === normalized.id)
                || (normalized.downloadUrl && (file.downloadUrl === normalized.downloadUrl || file.content === normalized.downloadUrl))
                || (normalized.bundleDownloadUrl && file.bundleDownloadUrl === normalized.bundleDownloadUrl)
            ));
            if (exists) {
                return;
            }

            const content = normalized.bundleDownloadUrl || normalized.downloadUrl || normalized.previewUrl || '';
            const file = this.addSessionFile(
                normalized.filename,
                content,
                normalized.mimeType,
                type,
                {
                    size: normalized.sizeBytes,
                    createdAt: normalized.createdAt,
                    artifactId: normalized.id,
                    downloadUrl: normalized.downloadUrl,
                    previewUrl: normalized.previewUrl,
                    bundleDownloadUrl: normalized.bundleDownloadUrl,
                }
            );
            added.push(file);
        });

        return added;
    }

    async syncStoredSessionArtifacts() {
        if (!api.sessionId) {
            return [];
        }

        try {
            const artifacts = await api.getSessionArtifacts(api.sessionId);
            return this.syncArtifactsToSessionFiles(artifacts);
        } catch (error) {
            console.warn('[CLI] Failed to sync stored artifacts into session files:', error);
            return [];
        }
    }
    
    /**
     * List all session files
     */
    async listFiles() {
        await this.syncStoredSessionArtifacts();

        if (this.sessionFiles.length === 0) {
            this.printSystem('No files in this session. Generate files with /diagram, /image, or AI file generation.');
            return;
        }
        
        const lines = ['## Session Files', ''];
        lines.push('ID  | Name                          | Type       | Size   | Created');
        lines.push('----|-------------------------------|------------|--------|----------------');
        
        this.sessionFiles.forEach(file => {
            const id = String(file.id).padStart(3);
            const name = file.filename.substring(0, 30).padEnd(30);
            const type = file.type.padEnd(10);
            const size = this.formatFileSize(file.size).padEnd(6);
            const time = new Date(file.createdAt).toLocaleTimeString();
            lines.push(`${id} | ${name} | ${type} | ${size} | ${time}`);
        });
        
        lines.push('');
        lines.push('Commands: /download <id> | /open (GUI) | Click file in output');
        
        this.printAI(lines.join('\n'));
    }
    
    /**
     * Download a file by ID
     */
    async downloadFileById(id) {
        const fileId = parseInt(id, 10);
        const file = this.sessionFiles.find(f => f.id === fileId);
        
        if (!file) {
            this.printError(`File #${id} not found. Use /files to see available files.`);
            return;
        }
        
        this.downloadFile(file.content, file.filename, file.mimeType);
        this.printSystem(`Downloaded: ${file.filename}`);
    }
    
    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    
    /**
     * Open file manager modal
     */
    openFileManager() {
        this.syncStoredSessionArtifacts().then(() => this.renderFileManager()).catch(() => this.renderFileManager());
    }

    renderFileManager() {
        // Remove existing modal
        const existing = document.getElementById('file-manager-modal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.id = 'file-manager-modal';
        modal.className = 'file-manager-modal';
        modal.innerHTML = `
            <div class="file-manager-overlay" onclick="app.closeFileManager()"></div>
            <div class="file-manager-content">
                <div class="file-manager-header">
                    <h3>Session Files (${this.sessionFiles.length})</h3>
                    <button class="file-manager-close" onclick="app.closeFileManager()" aria-label="Close file manager">&times;</button>
                </div>
                <div class="file-manager-body">
                    ${this.sessionFiles.length === 0 ? 
                        '<div class="file-manager-empty">No files yet. Generate files with /diagram, /image, or ask the AI.</div>' :
                        this.sessionFiles.map(f => `
                            <div class="file-item" onclick="app.downloadFileById('${f.id}')">
                                <span class="file-icon">${this.getFileIcon(f.filename)}</span>
                                <span class="file-name">${f.filename}</span>
                                <span class="file-meta">${this.formatFileSize(f.size)} | ${f.type}</span>
                                <button class="file-download-btn" onclick="event.stopPropagation(); app.downloadFileById('${f.id}')">Download</button>
                            </div>
                        `).join('')
                    }
                </div>
                <div class="file-manager-footer">
                    <button class="btn" onclick="app.closeFileManager()">Close</button>
                    <button class="btn" onclick="app.downloadAllFiles()">Download All</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }
    
    /**
     * Close file manager modal
     */
    closeFileManager() {
        const modal = document.getElementById('file-manager-modal');
        if (modal) modal.remove();
    }
    
    cancelDrag() {
        this.dragEnterCounter = 0;
        if (this.dragOverlay) {
            this.dragOverlay.classList.remove('active');
        }
    }
    
    /**
     * Get icon for file type
     */
    getFileIcon(filename) {
        const ext = filename.split('.').pop()?.toLowerCase();
        const icons = {
            mmd: '??', png: '??', jpg: '??', jpeg: '??', gif: '??', svg: '??',
            pdf: '??', docx: '??', doc: '??', txt: '??', md: '??',
            js: '??', ts: '??', py: '??', html: '??', css: '??',
            json: '??', xml: '??', csv: '??', xlsx: '??',
            zip: '??', gz: '??'
        };
        return icons[ext] || '??';
    }
    
    /**
     * Download all files as ZIP (simplified - downloads individually)
     */
    downloadAllFiles() {
        if (this.sessionFiles.length === 0) return;
        
        this.printSystem(`Downloading ${this.sessionFiles.length} files...`);
        this.sessionFiles.forEach((file, i) => {
            setTimeout(() => {
                this.downloadFile(file.content, file.filename, file.mimeType);
            }, i * 200);
        });
        this.closeFileManager();
    }
    
    // ==================== UI Methods ====================
    
    clearOutput() {
        this.terminalOutput.innerHTML = '';
        this.printWelcome();
    }

    getThemePresets() {
        return Array.isArray(this.themeCatalog?.presets) ? this.themeCatalog.presets : [];
    }

    getThemePreset(theme) {
        const normalized = String(theme || '').trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        if (typeof this.themeCatalog?.getById === 'function') {
            return this.themeCatalog.getById(normalized);
        }

        return this.getThemePresets().find((preset) => preset.id === normalized) || null;
    }

    getDefaultSharedThemeId(mode = 'dark') {
        const normalizedMode = String(mode || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
        if (typeof this.themeCatalog?.getDefaultId === 'function') {
            return this.themeCatalog.getDefaultId(normalizedMode);
        }

        return this.themeCatalog?.defaults?.[normalizedMode] || (normalizedMode === 'light' ? 'paper' : 'obsidian');
    }

    normalizeThemeId(theme) {
        const normalized = String(theme || '').trim().toLowerCase();
        if (!normalized) {
            return '';
        }

        if (normalized === 'voxel') {
            return 'voxel';
        }

        const presets = this.getThemePresets();
        if (presets.length > 0) {
            if (normalized === 'dark' || normalized === 'light') {
                return this.getDefaultSharedThemeId(normalized);
            }

            return this.getThemePreset(normalized) ? normalized : '';
        }

        return ['dark', 'light'].includes(normalized) ? normalized : '';
    }

    getThemeCycleIds() {
        const presetIds = this.getThemePresets().map((preset) => preset.id);
        return presetIds.length > 0 ? ['voxel', ...presetIds] : ['voxel', 'dark', 'light'];
    }

    getThemeLabel(theme = this.theme) {
        if (theme === 'voxel') {
            return 'Voxel';
        }

        const preset = this.getThemePreset(theme);
        if (preset) {
            return preset.name;
        }

        return theme === 'light' ? 'Light' : 'Dark';
    }

    getThemeOptionSummary() {
        const presets = this.getThemePresets();
        if (!presets.length) {
            return 'voxel, dark, or light';
        }

        return ['voxel', ...presets.map((preset) => preset.id)].join(', ');
    }

    printThemeList() {
        const presets = this.getThemePresets();
        if (!presets.length) {
            this.printAI('## Themes\n\n- `voxel`\n- `dark`\n- `light`');
            return;
        }

        const grouped = presets.reduce((groups, preset) => {
            const group = preset.group || 'core';
            if (!groups[group]) {
                groups[group] = [];
            }
            groups[group].push(preset);
            return groups;
        }, {});

        const labels = this.themeCatalog?.groupLabels || {};
        const lines = ['## Themes', '', '- `voxel` - Voxel CLI companion theme'];
        Object.keys(grouped).forEach((group) => {
            lines.push('', `### ${labels[group] || group}`);
            grouped[group].forEach((preset) => {
                const marker = preset.id === this.theme ? ' (current)' : '';
                lines.push(`- \`${preset.id}\` - ${preset.name}, ${preset.mode}${marker}`);
            });
        });

        this.printAI(lines.join('\n'));
    }
    
    cycleTheme() {
        const themes = this.getThemeCycleIds();
        const currentIndex = themes.indexOf(this.theme);
        const nextTheme = themes[(currentIndex + 1) % themes.length] || themes[0];
        this.setTheme(nextTheme, { silent: true });
        this.printSystem(`Theme: ${this.getThemeLabel(this.theme)}`);
    }

    setTheme(theme, options = {}) {
        const normalizedTheme = this.normalizeThemeId(theme);
        if (!normalizedTheme) {
            this.printError(`Unknown theme: ${theme}. Use ${this.getThemeOptionSummary()}.`);
            return;
        }

        this.theme = normalizedTheme;
        this.applyTheme(this.theme);
        this.persistThemePreference(this.theme);
        this.renderVoxelPet();
        if (!options.silent) {
            this.printSystem(`Theme: ${this.getThemeLabel(this.theme)}`);
        }
    }
    
    applyTheme(theme) {
        const normalizedTheme = this.normalizeThemeId(theme) || 'voxel';
        const preset = this.getThemePreset(normalizedTheme);
        if (normalizedTheme === 'voxel') {
            document.body.setAttribute('data-theme', 'voxel');
            document.body.removeAttribute('data-chat-theme');
            this.clearSharedThemeProperties();
        } else {
            const mode = preset?.mode === 'light' || normalizedTheme === 'light' ? 'light' : 'dark';
            document.body.setAttribute('data-theme', mode);
            if (preset) {
                document.body.setAttribute('data-chat-theme', preset.id);
                this.applySharedThemeProperties(preset);
            } else {
                document.body.removeAttribute('data-chat-theme');
                this.clearSharedThemeProperties();
            }
        }
        this.updateThemeButton();
        
        // Update mermaid theme
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: document.body.getAttribute('data-theme') === 'light' ? 'default' : 'dark',
                securityLevel: 'loose',
                fontFamily: 'var(--font-family)'
            });
        }
    }

    persistThemePreference(theme) {
        localStorage.setItem('codecli-theme', theme);
        const preset = this.getThemePreset(theme);
        if (!preset) {
            return;
        }

        const storageKeys = this.themeCatalog?.storageKeys || {
            preset: 'kimibuilt_theme_preset',
            mode: 'kimibuilt_theme',
        };
        localStorage.setItem(storageKeys.preset, preset.id);
        localStorage.setItem(storageKeys.mode, preset.mode);
    }

    applySharedThemeProperties(preset) {
        const mode = preset?.mode === 'light' ? 'light' : 'dark';
        const preview = preset?.preview || {};
        const palette = mode === 'light'
            ? {
                bgPrimary: '#f8fafc',
                bgSecondary: '#ffffff',
                bgTertiary: '#eef2f7',
                bgHover: '#e2e8f0',
                border: 'rgba(15, 23, 42, 0.14)',
                textPrimary: '#172033',
                textSecondary: '#475569',
                textMuted: '#64748b',
                overlay: 'rgba(15, 23, 42, 0.28)',
                panelShadow: '0 18px 44px rgba(15, 23, 42, 0.14)',
                controlShadow: '0 10px 24px rgba(15, 23, 42, 0.08)',
            }
            : {
                bgPrimary: '#0d1117',
                bgSecondary: '#161b22',
                bgTertiary: '#21262d',
                bgHover: '#30363d',
                border: 'rgba(148, 163, 184, 0.16)',
                textPrimary: '#e5edf5',
                textSecondary: '#a7b4c4',
                textMuted: '#778397',
                overlay: 'rgba(2, 6, 12, 0.72)',
                panelShadow: '0 20px 54px rgba(0, 0, 0, 0.34)',
                controlShadow: '0 10px 24px rgba(0, 0, 0, 0.18)',
            };

        const accent = preview.accent || (mode === 'light' ? '#2563eb' : '#58a6ff');
        const properties = {
            '--bg-primary': palette.bgPrimary,
            '--bg-secondary': palette.bgSecondary,
            '--bg-tertiary': palette.bgTertiary,
            '--bg-hover': palette.bgHover,
            '--border-color': palette.border,
            '--text-primary': palette.textPrimary,
            '--text-secondary': palette.textSecondary,
            '--text-muted': palette.textMuted,
            '--accent': accent,
            '--accent-hover': accent,
            '--success': mode === 'light' ? '#15803d' : '#238636',
            '--success-bright': mode === 'light' ? '#16a34a' : '#3fb950',
            '--warning': mode === 'light' ? '#a16207' : '#d29922',
            '--error': mode === 'light' ? '#dc2626' : '#f85149',
            '--info': accent,
            '--cli-theme-page-background': preview.background || palette.bgPrimary,
            '--cli-theme-panel-background': preview.surface || palette.bgSecondary,
            '--cli-theme-output-background': preview.assistantBubble || palette.bgSecondary,
            '--cli-theme-user-background': preview.userBubble || accent,
            '--cli-theme-overlay-background': palette.overlay,
            '--cli-theme-panel-shadow': palette.panelShadow,
            '--cli-theme-control-shadow': palette.controlShadow,
            '--cli-theme-accent-ring': mode === 'light' ? 'rgba(37, 99, 235, 0.18)' : 'rgba(88, 166, 255, 0.2)',
        };

        Object.entries(properties).forEach(([name, value]) => {
            document.body.style.setProperty(name, value);
        });
    }

    clearSharedThemeProperties() {
        [
            '--bg-primary',
            '--bg-secondary',
            '--bg-tertiary',
            '--bg-hover',
            '--border-color',
            '--text-primary',
            '--text-secondary',
            '--text-muted',
            '--accent',
            '--accent-hover',
            '--success',
            '--success-bright',
            '--warning',
            '--error',
            '--info',
            '--cli-theme-page-background',
            '--cli-theme-panel-background',
            '--cli-theme-output-background',
            '--cli-theme-user-background',
            '--cli-theme-overlay-background',
            '--cli-theme-panel-shadow',
            '--cli-theme-control-shadow',
            '--cli-theme-accent-ring',
        ].forEach((property) => document.body.style.removeProperty(property));
    }

    updateThemeButton() {
        if (!this.themeButton) {
            return;
        }

        const label = this.getThemeLabel(this.theme);
        this.themeButton.title = `Theme: ${label}`;
        this.themeButton.setAttribute('aria-label', `Cycle theme. Current theme: ${label}`);
    }
    
    copyLastOutput() {
        if (this.lastResponse) {
            navigator.clipboard.writeText(this.lastResponse);
            this.printSystem('Last response copied to clipboard');
        } else {
            this.printWarning('No response to copy');
        }
    }
    
    copyCode(btn) {
        const code = btn.closest('.code-block').querySelector('code').textContent;
        navigator.clipboard.writeText(code);
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = originalText, 2000);
    }
    
    showShortcuts() {
        document.getElementById('shortcutsContent').innerHTML = `
            <div class="grid gap-2 text-sm">
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>Send message</span>
                    <code class="inline-code">Enter</code>
                </div>
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>Command history</span>
                    <code class="inline-code">? / ?</code>
                </div>
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>Autocomplete</span>
                    <code class="inline-code">Tab</code>
                </div>
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>Clear screen</span>
                    <code class="inline-code">Ctrl + L</code>
                </div>
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>Copy last response</span>
                    <code class="inline-code">Ctrl + C</code>
                </div>
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>Show help</span>
                    <code class="inline-code">F1</code>
                </div>
                <div class="flex justify-between py-1 border-b" style="border-color: var(--border-color);">
                    <span>File manager</span>
                    <code class="inline-code">Ctrl + Shift + F</code>
                </div>
                <div class="flex justify-between py-1">
                    <span>Close/cancel</span>
                    <code class="inline-code">Esc</code>
                </div>
            </div>
        `;
        this.shortcutsModal.classList.add('active');
    }
    
    closeShortcuts() {
        this.shortcutsModal.classList.remove('active');
    }
    
    // ==================== Autocomplete ====================
    
    updateAutocomplete() {
        const input = this.commandInput.value;
        if (!input.startsWith('/')) {
            this.hideAutocomplete();
            return;
        }
        
        const matches = this.commands.filter(cmd => cmd.startsWith(input.toLowerCase()));
        if (matches.length === 0 || (matches.length === 1 && matches[0] === input)) {
            this.hideAutocomplete();
            return;
        }
        
        this.autocompleteMatches = matches;
        this.autocompleteIndex = -1;
        
        this.autocompleteEl.innerHTML = matches.map((match, i) => `
            <div class="autocomplete-item ${i === 0 ? 'selected' : ''}" data-index="${i}">${match}</div>
        `).join('');
        
        this.autocompleteEl.classList.remove('hidden');
        
        // Click handlers
        this.autocompleteEl.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
                this.commandInput.value = item.textContent + ' ';
                this.commandInput.focus();
                this.hideAutocomplete();
            });
        });
    }
    
    navigateAutocomplete(direction) {
        if (this.autocompleteMatches.length === 0) return;
        
        this.autocompleteIndex += direction;
        if (this.autocompleteIndex < 0) {
            this.autocompleteIndex = this.autocompleteMatches.length - 1;
        } else if (this.autocompleteIndex >= this.autocompleteMatches.length) {
            this.autocompleteIndex = 0;
        }
        
        this.autocompleteEl.querySelectorAll('.autocomplete-item').forEach((item, i) => {
            item.classList.toggle('selected', i === this.autocompleteIndex);
        });
    }
    
    selectAutocomplete() {
        if (this.autocompleteIndex >= 0) {
            this.commandInput.value = this.autocompleteMatches[this.autocompleteIndex] + ' ';
            this.commandInput.focus();
            this.hideAutocomplete();
        }
    }
    
    hideAutocomplete() {
        this.autocompleteEl.classList.add('hidden');
        this.autocompleteMatches = [];
        this.autocompleteIndex = -1;
    }
    
    handleTabCompletion() {
        const input = this.commandInput.value;
        if (input.startsWith('/')) {
            const matches = this.commands.filter(cmd => cmd.startsWith(input.toLowerCase()));
            if (matches.length === 1) {
                this.commandInput.value = matches[0] + ' ';
            } else if (matches.length > 0) {
                this.printSystem('Commands: ' + matches.join(', '));
            }
        }
    }
    
    // ==================== History ====================
    
    navigateHistory(direction) {
        if (this.history.length === 0) return;
        
        this.historyIndex += direction;
        if (this.historyIndex < 0) {
            this.historyIndex = 0;
        } else if (this.historyIndex >= this.history.length) {
            this.historyIndex = this.history.length;
            this.commandInput.value = '';
            return;
        }
        
        this.commandInput.value = this.history[this.historyIndex];
    }
    
    saveCommandHistory() {
        localStorage.setItem('codecli-cmd-history', JSON.stringify(this.history.slice(-100)));
    }
    
    // ==================== Streaming Helpers ====================
    
    getStreamingLine() {
        const lines = this.terminalOutput.querySelectorAll('.line-output.ai');
        const lastLine = lines[lines.length - 1] || null;
        return lastLine?.classList.contains('streaming') ? lastLine : null;
    }

    ensureStreamingLine() {
        const existing = this.getStreamingLine();
        if (existing) {
            return existing;
        }

        const line = document.createElement('div');
        line.className = 'line line-output ai streaming pixel-streaming';
        line.innerHTML = this.renderAIContent('', {
            title: 'Streaming',
            meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
            streaming: true,
        });
        this.terminalOutput.appendChild(line);
        return line;
    }

    updateStreamingLine(text, options = {}) {
        const line = this.ensureStreamingLine();
        line.innerHTML = this.renderAIContent(text, {
            title: options.title || 'Streaming',
            meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
            streaming: true,
        });
        this.scrollToBottom();
        return line;
    }

    getPixelStreamStep() {
        const backlog = this.pixelStreamBuffer.length;
        if (backlog > 2400) return 18;
        if (backlog > 900) return 10;
        if (backlog > 240) return 6;
        return 2;
    }

    startPixelStreamDrain() {
        if (this.pixelStreamTimer) {
            return;
        }

        const tick = () => {
            if (!this.pixelStreamBuffer) {
                this.pixelStreamTimer = null;
                const waiters = this.pixelStreamWaiters.splice(0);
                waiters.forEach((resolve) => resolve());
                return;
            }

            const step = this.getPixelStreamStep();
            const next = this.pixelStreamBuffer.slice(0, step);
            this.pixelStreamBuffer = this.pixelStreamBuffer.slice(step);
            this.currentOutput += next;
            this.updateStreamingLine(this.currentOutput);

            if (!this.voxelPetHidden && this.currentOutput.length % 96 < step) {
                this.roamVoxelPet(this.getVoxelRoamPlacement('scout'), 'scout', 2800);
            }

            const delay = this.pixelStreamBuffer.length > 900 ? 12 : 28;
            this.pixelStreamTimer = window.setTimeout(tick, delay);
        };

        this.pixelStreamTimer = window.setTimeout(tick, 18);
    }

    waitForPixelStreamDrain() {
        if (!this.pixelStreamBuffer && !this.pixelStreamTimer) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            this.pixelStreamWaiters.push(resolve);
        });
    }

    appendToCurrentOutput(text) {
        const chunk = String(text || '');
        if (!chunk) {
            return;
        }

        if (this.theme === 'voxel') {
            this.ensureStreamingLine();
            this.pixelStreamBuffer += chunk;
            this.startPixelStreamDrain();
            return;
        }

        // For streaming responses - update the last AI output line
        const lines = this.terminalOutput.querySelectorAll('.line-output.ai');
        const lastLine = lines[lines.length - 1];
        if (lastLine && lastLine.classList.contains('streaming')) {
            lastLine.innerHTML = this.renderAIContent(this.currentOutput + chunk, {
                title: 'Streaming',
                meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
                streaming: true,
            });
            this.currentOutput += chunk;
            if (typeof hljs !== 'undefined') {
                lastLine.querySelectorAll('pre code').forEach((block) => {
                    if (block.classList.contains('language-mermaid') || block.classList.contains('nohighlight')) {
                        return;
                    }
                    hljs.highlightElement(block);
                });
            }
        } else {
            this.currentOutput = chunk;
            const line = document.createElement('div');
            line.className = 'line line-output ai streaming';
            line.innerHTML = this.renderAIContent(chunk, {
                title: 'Streaming',
                meta: `${api.currentModel || 'default'} | ${this.voxelPet?.name || 'voxel companion'}`,
                streaming: true,
            });
            this.terminalOutput.appendChild(line);
        }
        this.scrollToBottom();
    }
    
    /**
     * Trigger mermaid rendering (useful for re-rendering after streaming)
     */
    refreshMermaidDiagrams() {
        this.renderMermaidDiagrams(this.terminalOutput);
    }
    
    /**
     * Remove streaming line before printing final response
     */
    async finalizeStreamingOutput(finalText = '') {
        const expected = String(finalText || '');
        if (this.theme === 'voxel') {
            const pending = this.currentOutput + this.pixelStreamBuffer;
            if (expected && expected !== pending) {
                if (expected.startsWith(pending)) {
                    this.pixelStreamBuffer += expected.slice(pending.length);
                } else {
                    this.currentOutput = '';
                    this.pixelStreamBuffer = expected;
                }
            } else if (expected && !pending) {
                this.pixelStreamBuffer = expected;
            }

            if (this.pixelStreamBuffer) {
                this.ensureStreamingLine();
                this.startPixelStreamDrain();
                await this.waitForPixelStreamDrain();
            }

            const streamingLine = this.getStreamingLine();
            if (streamingLine) {
                streamingLine.classList.remove('streaming', 'pixel-streaming');
                streamingLine.innerHTML = this.renderAIContent(expected || this.currentOutput);
                this.finishAIContentLine(streamingLine);
                this.scrollToBottom();
                return;
            }

            if (expected) {
                this.printAI(expected);
            }
            return;
        }

        const streamingLine = this.terminalOutput.querySelector('.line-output.ai.streaming');
        if (streamingLine) {
            streamingLine.classList.remove('streaming');
            streamingLine.innerHTML = this.renderAIContent(expected || this.currentOutput);
            this.finishAIContentLine(streamingLine);
            this.scrollToBottom();
            return;
        }

        if (expected) {
            this.printAI(expected);
        }
    }
}

const app = new CodeCLIApp();
