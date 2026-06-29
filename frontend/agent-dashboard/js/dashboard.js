/**
 * Agent SDK Admin Dashboard
 * Main dashboard controller with state management, navigation, and real-time updates
 */

class Dashboard {
    constructor() {
        this.state = {
            currentView: 'overview',
            sidebarCollapsed: false,
            logsPaused: false,
            selectedPrompt: null,
            selectedTrace: null,
            models: [],
            prompts: [],
            skills: [],
            tools: [],
            toolDocs: {},
            selectedToolId: null,
            logs: [],
            traces: [],
            workloads: [],
            runs: [],
            selectedRun: null,
            agentCompanyStatus: null,
            agentCompanyWorkspace: null,
            agentCompanyFiles: null,
            companyActionRunId: null,
            companyActionContext: null,
            companyActionContexts: {},
            companyActionContextsById: {},
            companyActionHistory: [],
            companyActionHistorySummary: null,
            companyActionHistoryFilter: 'all',
            companyActionHistorySort: 'newest',
            companyActionHistoryLoading: false,
            companyActionHistoryError: '',
            companyFileSearch: '',
            companyFileSourceFilter: 'any',
            companyWorkSearch: '',
            companyWorkStatusFilter: 'all',
            companyRoleFilter: 'all',
            workloadsAvailable: true,
            workloadsSupported: null,
            workloadErrorMessage: '',
            editingWorkloadId: null,
            settings: {},
            storage: null,
            tokenAnalysis: null,
            lillyHistory: null,
            selfReflectionUpdates: [],
            selfReflectionSuggestions: [],
            selfReflectionMeta: {},
            selfReflectionSuggestionMeta: {},
            selfReflectionSupported: null,
            selfReflectionErrorMessage: '',
            applyingSelfReflectionSuggestionId: null,
            afterProcessAudits: [],
            afterProcessAuditMeta: {},
            afterProcessAuditSupported: null,
            afterProcessAuditErrorMessage: '',
            clearingAfterProcessAuditId: null,
            applyingAfterProcessRecommendationId: null,
            stats: {
                totalTasks: 0,
                successRate: 0,
                activeSessions: 0,
                skillsUsed: 0,
                skillsUsedThisWeek: 0
            },
            pagination: {
                logs: { page: 1, limit: 50, total: 0 },
                traces: { page: 1, limit: 20, total: 0 }
            }
        };
        
        this.charts = {};
        this.storageSelection = new Set();
        this.dirtyInputIds = new Set();
        this.promptEditorDirty = false;
        this.companyRoleFilterAliases = new Map();
        this.companyFileSearchTimer = null;
        this.piiDetectorDefinitions = [
            { id: 'email', label: 'Email' },
            { id: 'phone', label: 'Phone' },
            { id: 'ssn', label: 'SSN' },
            { id: 'creditCard', label: 'Credit card' },
            { id: 'dateOfBirth', label: 'Date of birth' },
            { id: 'address', label: 'Address' },
            { id: 'ipAddress', label: 'IP address' },
            { id: 'postalCode', label: 'Postal code' },
            { id: 'personName', label: 'Person names' },
            { id: 'organization', label: 'Organizations' },
            { id: 'medicalRecordNumber', label: 'Medical record number' },
            { id: 'patientIdentifier', label: 'Patient identifier' },
            { id: 'healthCardNumber', label: 'Health card number' },
            { id: 'socialInsuranceNumber', label: 'Social insurance number' },
        ];
        this.ws = null;
        this.reconnectInterval = null;
        this.refreshInterval = null;
        
        this.init();
    }
    
    /**
     * Initialize the dashboard
     */
    async init() {
        this.initializeTheme();
        this.setupEventListeners();
        this.setupNavigation();
        this.setupSettingsNavigation();
        this.setupPromptEditor();
        this.setupCharts();
        this.setupWebSocket();
        this.startPolling();

        const requestedView = new URLSearchParams(window.location.search).get('view');
        if (requestedView && document.getElementById(`${requestedView}View`)) {
            this.navigateTo(requestedView);
        }
        
        // Load initial data
        await this.loadInitialData();
        await this.restoreCompanyActionSelectionFromUrl();
        
        const connected = document.querySelector('#connectionStatus .status-dot')?.classList.contains('online');
        if (!connected) {
            this.showToast('Dashboard loaded in degraded mode', 'warning');
        }
    }

    getCompanyActionSelectionFromUrl() {
        try {
            const params = new window.URLSearchParams(window.location.search);
            if (params.get('view') !== 'agentCompany' || params.get('companyAction') !== '1') {
                return null;
            }

            const runId = String(params.get('companyRun') || '').trim();
            const actionId = String(params.get('companyActionId') || '').trim();
            return runId ? { runId, actionId } : null;
        } catch (error) {
            return null;
        }
    }

    updateCompanyActionSelectionUrl(runId = '', actionId = '') {
        if (!window.history?.replaceState) return;

        try {
            const url = new window.URL(window.location.href);
            if (runId) {
                url.searchParams.set('view', 'agentCompany');
                url.searchParams.set('companyAction', '1');
                url.searchParams.set('companyRun', runId);
                if (actionId) {
                    url.searchParams.set('companyActionId', actionId);
                } else {
                    url.searchParams.delete('companyActionId');
                }
            } else {
                url.searchParams.delete('companyAction');
                url.searchParams.delete('companyRun');
                url.searchParams.delete('companyActionId');
            }
            window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
        } catch (error) {
            // Ignore malformed test URLs or locked-down browser contexts.
        }
    }

    getPersistedCompanyActionContext(runId = '') {
        if (!runId || !window.sessionStorage) return null;

        try {
            const raw = window.sessionStorage.getItem(`kb.companyActionContext.${runId}`);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            const context = {
                id: parsed.id || '',
                actionKey: parsed.actionKey || parsed.id || '',
                label: parsed.label || 'Opened from CEO action queue',
                detail: parsed.detail || '',
                outputPreview: parsed.outputPreview || '',
            };
            if (parsed.contextSource) {
                context.contextSource = parsed.contextSource;
            }
            if (parsed.snapshotAt) {
                context.snapshotAt = parsed.snapshotAt;
            }
            return context;
        } catch (error) {
            return null;
        }
    }

    persistCompanyActionContext(runId = '', context = null) {
        if (!runId || !context || !window.sessionStorage) return;

        try {
            const persisted = {
                id: context.id || '',
                actionKey: context.actionKey || context.id || '',
                label: context.label || 'Opened from CEO action queue',
                detail: context.detail || '',
                outputPreview: context.outputPreview || '',
            };
            if (context.contextSource) {
                persisted.contextSource = context.contextSource;
            }
            if (context.snapshotAt) {
                persisted.snapshotAt = context.snapshotAt;
            }
            window.sessionStorage.setItem(`kb.companyActionContext.${runId}`, JSON.stringify(persisted));
        } catch (error) {
            // Session persistence is a convenience, not a blocker for review.
        }
    }

    buildCompanyActionContext(action = {}, runId = '', options = {}) {
        const actionId = String(action.id || 'company-action');
        const actionKey = String(action.actionKey || actionId);
        const refreshStatus = action.refreshStatus || null;
        const isRefreshRun = refreshStatus?.runId && refreshStatus.runId === runId;
        return {
            id: actionId,
            actionKey,
            label: action.label || 'Opened from CEO action queue',
            detail: isRefreshRun && refreshStatus.title
                ? `Latest repair: ${refreshStatus.title}`
                : (action.detail || ''),
            outputPreview: isRefreshRun
                ? (action.detail || '')
                : (action.outputPreview || ''),
            contextSource: options.contextSource || 'live',
            ...(action.snapshotAt ? { snapshotAt: action.snapshotAt } : {}),
        };
    }

    async loadCompanyActionContext(actionId = '', runId = '') {
        if (!actionId) return null;

        try {
            const client = window.apiClient || (typeof apiClient !== 'undefined' ? apiClient : null);
            if (!client?.get) return null;
            const response = await client.get('/api/admin/agent-company/action', { actionKey: actionId });
            const payload = this.unwrapApiPayload(response, {});
            const action = payload?.action;
            if (!action) return null;
            return this.buildCompanyActionContext(
                action,
                runId || action.runId || action.refreshStatus?.runId || '',
                { contextSource: payload.historical ? 'saved-history' : 'live' },
            );
        } catch (error) {
            console.warn('Error loading agent company action context:', error.message || error);
            return null;
        }
    }

    async restoreCompanyActionSelectionFromUrl() {
        const selection = this.getCompanyActionSelectionFromUrl();
        if (!selection?.runId) return;

        let actionContext = this.state.companyActionContextsById?.[selection.actionId]
            || this.state.companyActionContexts?.[selection.runId]
            || this.getPersistedCompanyActionContext(selection.runId);
        if (!actionContext && selection.actionId) {
            actionContext = await this.loadCompanyActionContext(selection.actionId, selection.runId);
        }
        const currentActionKey = this.state.companyActionContext?.actionKey || this.state.companyActionContext?.id || '';
        if (
            this.state.companyActionRunId === selection.runId
            && this.state.companyActionContext
            && (!selection.actionId || currentActionKey === selection.actionId)
        ) {
            return;
        }

        await this.selectAdminRun(selection.runId, {
            source: 'company-action',
            actionContext,
            persistSelection: false,
        });
    }
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Sidebar toggle
        document.getElementById('sidebarToggle')?.addEventListener('click', () => {
            if (this.isMobileNavigation()) {
                this.closeMobileNavigation();
                return;
            }
            this.toggleSidebar();
        });

        document.getElementById('mobileMenuToggle')?.addEventListener('click', () => {
            this.toggleMobileNavigation();
        });

        document.getElementById('sidebarBackdrop')?.addEventListener('click', () => {
            this.closeMobileNavigation();
        });
        
        // Global search
        document.getElementById('globalSearch')?.addEventListener('input', (e) => {
            this.handleGlobalSearch(e.target.value);
        });
        
        // Theme toggle
        document.getElementById('themeToggle')?.addEventListener('click', () => {
            this.toggleTheme();
        });
        
        // Notifications
        document.getElementById('notificationsBtn')?.addEventListener('click', () => {
            this.showToast('No new notifications', 'info');
        });
        
        // Chart time range
        document.getElementById('chartTimeRange')?.addEventListener('change', (e) => {
            this.updateChartTimeRange(e.target.value);
        });
        
        // Log controls
        document.getElementById('pauseLogsBtn')?.addEventListener('click', () => {
            this.toggleLogsPause();
        });
        
        document.getElementById('clearLogsBtn')?.addEventListener('click', () => {
            this.clearLogs();
        });
        
        document.getElementById('exportLogsBtn')?.addEventListener('click', () => {
            this.exportLogs();
        });

        document.getElementById('refreshWorkloadsBtn')?.addEventListener('click', () => {
            this.loadWorkloads();
        });
        document.getElementById('configureAgentCompanyBtn')?.addEventListener('click', () => {
            this.configureAgentCompany();
        });
        document.getElementById('refreshAgentCompanyBtn')?.addEventListener('click', () => {
            this.loadAgentCompanyDashboard({ force: true });
        });
        document.getElementById('companyHeartbeatBtn')?.addEventListener('click', () => {
            this.runAgentCompanyHeartbeat({ source: 'company-console' });
        });
        document.getElementById('companyStartCycleBtn')?.addEventListener('click', () => {
            this.runAgentCompanyHeartbeat({ source: 'company-ceo-start-cycle' });
        });
        document.getElementById('companyDailyAlignmentBtn')?.addEventListener('click', () => {
            this.runAgentCompanyDailyAlignment();
        });
        document.getElementById('saveCompanyDirectionBtn')?.addEventListener('click', () => {
            this.saveAgentCompanyDirection();
        });
        document.getElementById('companyCeoDirection')?.addEventListener('input', () => {
            this.markInputDirty('companyCeoDirection');
        });
        document.getElementById('settingsAgentCompanyGoal')?.addEventListener('input', () => {
            this.markInputDirty('settingsAgentCompanyGoal');
        });
        document.getElementById('companyFileSearch')?.addEventListener('input', (event) => {
            this.state.companyFileSearch = event.target.value || '';
            clearTimeout(this.companyFileSearchTimer);
            this.companyFileSearchTimer = setTimeout(() => this.searchAgentCompanyFiles(), 250);
        });
        document.getElementById('companyFileSourceFilter')?.addEventListener('change', (event) => {
            this.state.companyFileSourceFilter = event.target.value || 'any';
            this.searchAgentCompanyFiles();
        });
        document.getElementById('refreshCompanyFilesBtn')?.addEventListener('click', () => {
            this.searchAgentCompanyFiles({ refresh: true });
        });
        document.getElementById('companyViewAllWorkloadsBtn')?.addEventListener('click', () => {
            this.navigateTo('workloads');
        });
        document.getElementById('companyWorkSearch')?.addEventListener('input', (event) => {
            this.state.companyWorkSearch = event.target.value || '';
            this.renderAgentCompanyDashboard();
        });
        document.getElementById('companyWorkStatusFilter')?.addEventListener('change', (event) => {
            this.state.companyWorkStatusFilter = event.target.value || 'all';
            this.renderAgentCompanyDashboard();
        });
        document.getElementById('companyRoleFilter')?.addEventListener('change', (event) => {
            this.state.companyRoleFilter = event.target.value || 'all';
            this.renderAgentCompanyDashboard();
        });
        document.getElementById('refreshSelfReflectionBtn')?.addEventListener('click', () => {
            this.loadSelfReflectionUpdates({ force: true });
        });
        document.getElementById('selfReflectionUpdates')?.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-self-reflection-suggestion-id]');
            if (!button) {
                return;
            }
            this.applySelfReflectionSuggestion(button.dataset.selfReflectionSuggestionId);
        });
        document.getElementById('refreshAfterProcessAuditsBtn')?.addEventListener('click', () => {
            this.loadAfterProcessAudits({ force: true });
        });
        document.getElementById('afterProcessAuditList')?.addEventListener('click', (event) => {
            const recommendationButton = event.target?.closest?.('[data-after-process-recommendation-id]');
            if (recommendationButton) {
                this.applyAfterProcessFlagRecommendation(recommendationButton.dataset.afterProcessRecommendationId);
                return;
            }
            const clearButton = event.target?.closest?.('[data-after-process-clear-id]');
            if (clearButton) {
                this.clearAfterProcessAudit(clearButton.dataset.afterProcessClearId);
            }
        });
        document.getElementById('saveWorkloadChangesBtn')?.addEventListener('click', () => {
            this.saveAdminWorkload();
        });
        document.getElementById('editWorkloadTriggerType')?.addEventListener('change', () => {
            this.updateAdminWorkloadTriggerFields();
            this.clearAdminWorkloadError();
        });
        [
            'editWorkloadTitle',
            'editWorkloadPrompt',
            'editWorkloadRunAt',
            'editWorkloadCronExpression',
            'editWorkloadTimezone',
        ].forEach((id) => {
            document.getElementById(id)?.addEventListener('input', () => {
                this.clearAdminWorkloadError();
            });
        });
        
        // Log filters
        document.getElementById('logLevelFilter')?.addEventListener('change', () => {
            this.filterLogs();
        });
        
        document.getElementById('logModelFilter')?.addEventListener('change', () => {
            this.filterLogs();
        });
        
        document.getElementById('logTimeFilter')?.addEventListener('change', () => {
            this.filterLogs();
        });
        
        document.getElementById('logSearch')?.addEventListener('input', (e) => {
            this.debounce(() => this.filterLogs(), 300)();
        });
        
        // Log pagination
        document.getElementById('logsPrevPage')?.addEventListener('click', () => {
            this.changeLogPage(-1);
        });
        
        document.getElementById('logsNextPage')?.addEventListener('click', () => {
            this.changeLogPage(1);
        });
        
        // Prompt controls
        document.getElementById('newPromptBtn')?.addEventListener('click', () => {
            this.createNewPrompt();
        });
        
        document.getElementById('savePromptBtn')?.addEventListener('click', () => {
            this.savePrompt();
        });
        
        document.getElementById('testPromptBtn')?.addEventListener('click', () => {
            this.openTestPromptModal();
        });
        
        document.getElementById('promptHistoryBtn')?.addEventListener('click', () => {
            this.openHistoryModal();
        });
        
        document.getElementById('promptSearch')?.addEventListener('input', (e) => {
            this.searchPrompts(e.target.value);
        });
        
        // Prompt editor tabs
        document.querySelectorAll('.editor-tabs .tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.switchPromptTab(e.target.dataset.tab);
            });
            btn.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }
                event.preventDefault();
                this.switchPromptTab(event.currentTarget.dataset.tab);
            });
        });
        
        // Prompt editor toolbar
        document.querySelectorAll('.toolbar-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.insertVariable(btn.dataset.insert);
            });
        });
        
        // Prompt editor input
        document.getElementById('promptEditor')?.addEventListener('input', (e) => {
            this.promptEditorDirty = true;
            this.updatePromptEditor(e.target.value);
        });
        document.getElementById('promptName')?.addEventListener('input', () => {
            this.promptEditorDirty = true;
        });
        
        // Test prompt modal
        document.getElementById('runTestBtn')?.addEventListener('click', () => {
            this.runPromptTest();
        });
        
        // Model configuration
        document.getElementById('defaultConfigForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveDefaultConfig();
        });
        document.getElementById('orchestrationConfigForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveOrchestrationConfig();
        });
        document.getElementById('agentRuntimeSettingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveAgentRuntimeSettings();
        });
        document.getElementById('agentCompanyHeartbeatBtn')?.addEventListener('click', () => {
            this.runAgentCompanyHeartbeat({ source: 'settings' });
        });
        document.getElementById('settingsAgentDirectedRuntime')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationAgentDirectedRuntime', String(e.target.checked));
        });
        document.getElementById('orchestrationAgentDirectedRuntime')?.addEventListener('change', (e) => {
            this.setCheckboxValue('settingsAgentDirectedRuntime', e.target.value === 'true');
        });
        document.getElementById('settingsNeuralWaveResearchMode')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationNeuralWaveResearchMode', String(e.target.checked));
        });
        document.getElementById('orchestrationNeuralWaveResearchMode')?.addEventListener('change', (e) => {
            this.setCheckboxValue('settingsNeuralWaveResearchMode', e.target.value === 'true');
        });
        document.getElementById('settingsPerplexityResearchLevel')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationPerplexityResearchLevel', e.target.value || 'auto');
        });
        document.getElementById('orchestrationPerplexityResearchLevel')?.addEventListener('change', (e) => {
            this.setInputValue('settingsPerplexityResearchLevel', e.target.value || 'auto');
        });
        document.getElementById('settingsAfterProcessAuditEnabled')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationAfterProcessAuditEnabled', String(e.target.checked));
        });
        document.getElementById('orchestrationAfterProcessAuditEnabled')?.addEventListener('change', (e) => {
            this.setCheckboxValue('settingsAfterProcessAuditEnabled', e.target.value === 'true');
        });
        document.getElementById('settingsAsyncRuntimeEnabled')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationAsyncRuntimeEnabled', String(e.target.checked));
        });
        document.getElementById('orchestrationAsyncRuntimeEnabled')?.addEventListener('change', (e) => {
            this.setCheckboxValue('settingsAsyncRuntimeEnabled', e.target.value === 'true');
        });
        document.getElementById('settingsAsyncRuntimeWebChatParallel')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationAsyncRuntimeWebChatParallel', String(e.target.checked));
        });
        document.getElementById('orchestrationAsyncRuntimeWebChatParallel')?.addEventListener('change', (e) => {
            this.setCheckboxValue('settingsAsyncRuntimeWebChatParallel', e.target.value === 'true');
        });
        document.getElementById('settingsAsyncRuntimeAllowLiveRemote')?.addEventListener('change', (e) => {
            this.setInputValue('orchestrationAsyncRuntimeAllowLiveRemote', String(e.target.checked));
        });
        document.getElementById('orchestrationAsyncRuntimeAllowLiveRemote')?.addEventListener('change', (e) => {
            this.setCheckboxValue('settingsAsyncRuntimeAllowLiveRemote', e.target.value === 'true');
        });
        
        document.getElementById('addModelBtn')?.addEventListener('click', () => {
            this.showToast('Add model functionality coming soon', 'info');
        });
        
        document.getElementById('resetDefaultsBtn')?.addEventListener('click', () => {
            this.resetDefaultConfig();
        });
        
        // Range inputs
        document.querySelectorAll('input[type="range"]').forEach(input => {
            input.addEventListener('input', (e) => {
                const valueDisplay = e.target.parentElement.querySelector('.range-value');
                if (valueDisplay) {
                    valueDisplay.textContent = e.target.value;
                }
            });
        });
        
        // Skill categories
        document.getElementById('skillCategories')?.addEventListener('click', (e) => {
            const button = e.target.closest('.category-btn');
            if (button) {
                this.filterSkills(button.dataset.category);
            }
        });

        document.getElementById('skillSearch')?.addEventListener('input', (e) => {
            this.searchSkills(e.target.value);
        });

        document.getElementById('toolSupportFilter')?.addEventListener('change', () => {
            this.renderSkills(this.getFilteredTools());
        });

        document.getElementById('discoverSkillsBtn')?.addEventListener('click', () => {
            this.discoverSkills();
        });
        
        // Trace filters
        document.getElementById('traceSessionFilter')?.addEventListener('change', () => {
            this.filterTraces();
        });
        
        document.getElementById('traceStatusFilter')?.addEventListener('change', () => {
            this.filterTraces();
        });
        
        document.getElementById('traceSearch')?.addEventListener('input', (e) => {
            this.debounce(() => this.filterTraces(), 300)();
        });
        
        // Settings navigation
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                this.switchSettingsSection(e.currentTarget.dataset.settings);
            });
            item.addEventListener('keydown', (event) => {
                this.handleSettingsNavKeydown(event);
            });
        });
        
        // Settings forms
        document.getElementById('generalSettingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveGeneralSettings();
        });

        document.getElementById('resetPersonalityBtn')?.addEventListener('click', () => {
            this.resetPersonality();
        });

        document.getElementById('resetUserProfileBtn')?.addEventListener('click', () => {
            this.resetUserProfile();
        });

        document.getElementById('resetAgentNotesBtn')?.addEventListener('click', () => {
            this.resetAgentNotes();
        });

        document.getElementById('agentNotesContent')?.addEventListener('input', () => {
            this.markInputDirty('agentNotesContent');
            this.syncAgentNotesCharacterCount();
        });
        document.getElementById('soulContent')?.addEventListener('input', () => {
            this.markInputDirty('soulContent');
            this.syncSoulCharacterCount();
        });
        document.getElementById('userProfileContent')?.addEventListener('input', () => {
            this.markInputDirty('userProfileContent');
            this.syncUserProfileCharacterCount();
        });

        document.querySelectorAll('.podcast-audio-upload').forEach(button => {
            button.addEventListener('click', () => {
                const input = document.querySelector(`.podcast-audio-input[data-track="${button.dataset.track}"]`);
                input?.click();
            });
        });

        document.querySelectorAll('.podcast-audio-input').forEach(input => {
            input.addEventListener('change', () => {
                this.uploadPodcastAudioTrack(input.dataset.track, input.files?.[0]);
                input.value = '';
            });
        });

        document.querySelectorAll('.podcast-audio-remove').forEach(button => {
            button.addEventListener('click', () => {
                this.removePodcastAudioTrack(button.dataset.track);
            });
        });

        document.getElementById('refreshStorageBtn')?.addEventListener('click', () => {
            this.loadStorage();
        });
        document.getElementById('previewStorageCleanupBtn')?.addEventListener('click', () => {
            this.cleanupStorage({ dryRun: true });
        });
        document.getElementById('runStorageCleanupBtn')?.addEventListener('click', () => {
            this.cleanupStorage({ dryRun: false });
        });
        document.getElementById('clearAllStorageBtn')?.addEventListener('click', () => {
            this.clearAllStorage();
        });
        document.getElementById('deleteSelectedStorageBtn')?.addEventListener('click', () => {
            this.deleteSelectedStorageRecords();
        });

        document.getElementById('privacyPiiSettingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.savePrivacyPiiSettings();
        });
        document.getElementById('previewPiiPolicyBtn')?.addEventListener('click', () => {
            this.previewPrivacyPiiPolicy();
        });
        document.getElementById('piiAuditProfile')?.addEventListener('change', () => {
            this.syncPrivacyAuditProfileDefaults();
        });
        
        document.getElementById('apiSettingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveApiSettings();
        });

        document.getElementById('sshSettingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveSshSettings();
        });

        document.getElementById('deploySettingsForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveDeploySettings();
        });
        
        document.getElementById('testConnectionBtn')?.addEventListener('click', () => {
            this.testConnection();
        });

        // API key visibility toggles
        document.getElementById('showApiKey')?.addEventListener('click', () => {
            this.togglePasswordVisibility('apiKey');
        });
        
        document.getElementById('showOpenaiKey')?.addEventListener('click', () => {
            this.togglePasswordVisibility('openaiKey');
        });

        document.getElementById('showSshPassword')?.addEventListener('click', () => {
            this.togglePasswordVisibility('sshPassword');
        });
        
        // Danger zone buttons
        document.getElementById('clearAllLogsBtn')?.addEventListener('click', () => {
            this.confirmClearAllLogs();
        });
        
        document.getElementById('resetConfigBtn')?.addEventListener('click', () => {
            this.confirmResetConfig();
        });
        
        document.getElementById('exportDataBtn')?.addEventListener('click', () => {
            this.exportAllData();
        });
        
        // Feature toggles
        document.querySelectorAll('#featureList input[type="checkbox"]').forEach(toggle => {
            toggle.addEventListener('change', (e) => {
                this.updateFeatureToggle(e.target.id, e.target.checked);
            });
        });
        
        // Modal close buttons
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) {
                    this.closeModal(modal.id);
                }
            });
        });
        
        // Modal overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) {
                    this.closeModal(modal.id);
                }
            });
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeMobileNavigation();
                document.querySelectorAll('.modal.active').forEach(modal => {
                    this.closeModal(modal.id);
                });
            }
            
            // Ctrl/Cmd + K for search
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                document.getElementById('globalSearch')?.focus();
            }
        });
        
        // Window resize
        window.addEventListener('resize', () => {
            this.debounce(() => this.handleResize(), 250)();
        });
    }
    
    /**
     * Setup navigation
     */
    setupNavigation() {
        document.querySelectorAll('.nav-item').forEach(item => {
            const isNativeButton = item.tagName === 'BUTTON';
            if (isNativeButton) {
                item.setAttribute('type', item.getAttribute('type') || 'button');
            } else {
                item.setAttribute('role', 'button');
                item.setAttribute('tabindex', '0');
            }
            item.setAttribute('aria-current', item.classList.contains('active') ? 'page' : 'false');

            const activateItem = () => {
                const view = item.dataset.view;
                if (view) {
                    this.navigateTo(view);
                    this.closeMobileNavigation();
                }
            };

            item.addEventListener('click', activateItem);
            item.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }

                event.preventDefault();
                activateItem();
            });
        });
        
        // View all buttons in cards
        document.querySelectorAll('.card-header .btn-ghost[data-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.navigateTo(btn.dataset.view);
            });
        });
    }
    
    /**
     * Navigate to a view
     */
    navigateTo(view) {
        // Update sidebar
        document.querySelectorAll('.nav-item').forEach(item => {
            const active = item.dataset.view === view;
            item.classList.toggle('active', active);
            item.setAttribute('aria-current', active ? 'page' : 'false');
        });
        
        // Update view
        document.querySelectorAll('.view').forEach(v => {
            v.classList.toggle('active', v.id === `${view}View`);
        });
        
        // Update header
        const viewNames = {
            overview: 'Overview',
            prompts: 'Prompts',
            models: 'Models',
            tokens: 'Token Analyzer',
            logs: 'Logs',
            workloads: 'Workloads',
            agentCompany: 'Agent Company',
            skills: 'Tools',
            traces: 'Traces',
            lillyWiki: 'Lilly Wiki',
            settings: 'Settings'
        };
        
        document.getElementById('pageTitle').textContent = viewNames[view] || view;
        document.querySelector('.breadcrumbs .current').textContent = viewNames[view] || view;
        
        this.state.currentView = view;
        
        // Load view-specific data
        this.loadViewData(view);
    }
    
    /**
     * Load initial data
     */
    async loadInitialData() {
        try {
            // Load stats
            await this.loadStats();
            
            // Load models
            await this.loadModels();
            
            // Load prompts
            await this.loadPrompts();
            
            // Load skills
            await this.loadSkills();
            
            // Load recent activity
            await this.loadRecentActivity();
            
            // Load model usage
            await this.loadModelUsage();

            // Load health
            await this.loadSystemHealth();

            // Load bounded self-reflection updates
            await this.loadSelfReflectionUpdates();

            // Load workload tracking
            await this.loadWorkloads();
            
        } catch (error) {
            console.error('Error loading initial data:', error);
            this.showToast('Failed to load some data', 'error');
        }
    }
    
    /**
     * Load view-specific data
     */
    async loadViewData(view) {
        switch (view) {
            case 'overview':
                await this.loadSelfReflectionUpdates();
                break;
            case 'skills':
                await this.loadSkills();
                break;
            case 'tokens':
                await this.loadTokenAnalyzer();
                break;
            case 'logs':
                await this.loadLogs();
                break;
            case 'workloads':
                await this.loadWorkloads();
                break;
            case 'agentCompany':
                await this.loadAgentCompanyDashboard();
                break;
            case 'traces':
                await this.loadTraces();
                break;
            case 'lillyWiki':
                await this.loadLillyHistory();
                break;
            case 'settings':
                await this.loadSettings();
                break;
        }
    }

    async loadLillyHistory() {
        const renderExisting = this.state.lillyHistory;
        if (renderExisting) {
            this.renderLillyHistory(renderExisting);
            return;
        }

        try {
            const response = await apiClient.get('/api/admin/lilly-history');
            const history = this.unwrapApiPayload(response, {});
            this.state.lillyHistory = history;
            this.renderLillyHistory(history);
        } catch (error) {
            console.error('Error loading Lilly history:', error);
            const fallback = this.getLillyHistoryFallback();
            this.state.lillyHistory = fallback;
            this.renderLillyHistory(fallback);
            this.showToast('Loaded Lilly wiki from fallback history', 'warning');
        }
    }

    getDateSpanDays(firstDate, lastDate) {
        const first = firstDate ? new Date(`${firstDate}T00:00:00Z`) : null;
        const last = lastDate ? new Date(`${lastDate}T00:00:00Z`) : null;
        if (!first || !last || Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) {
            return 0;
        }

        return Math.max(1, Math.round((last.getTime() - first.getTime()) / (24 * 60 * 60 * 1000)) + 1);
    }

    formatLillyDate(value) {
        if (!value) {
            return 'not available';
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return String(value).slice(0, 10);
        }

        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    formatLillyBytes(bytes) {
        const value = Number(bytes || 0);
        if (!value) {
            return '0 MB';
        }

        if (value >= 1024 * 1024 * 1024) {
            return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
        }

        return `${Math.round(value / (1024 * 1024)).toLocaleString()} MB`;
    }

    renderLillyHistory(history = {}) {
        const statsContainer = document.getElementById('lillyWikiStats');
        const phaseContainer = document.getElementById('lillyPhaseMap');
        const collageContainer = document.getElementById('lillyPrCollage');
        const threadsContainer = document.getElementById('lillyGrowthThreads');
        const timelineContainer = document.getElementById('lillyTimeline');
        const pulseContainer = document.getElementById('lillyLatestPulse');

        if (!statsContainer || !phaseContainer || !collageContainer || !threadsContainer || !timelineContainer || !pulseContainer) {
            return;
        }

        const totalPulls = Number(history.totalPulls || 0);
        const codexSessionCount = Number(history.codexSessions?.count || 0);
        const activeDays = this.getDateSpanDays(history.firstDate, history.lastDate);
        const averageDailyPulls = activeDays ? (totalPulls / activeDays).toFixed(1) : '0.0';
        const recentVelocity = history.recentVelocity || {};
        const multiLanePulls = Number(history.multiLanePulls || 0);
        const taggedPulls = Number(history.taggedPulls || 0);
        const maintenancePulls = Number(history.maintenancePulls || 0);
        const generatedAt = history.generatedAt ? this.formatLillyDate(history.generatedAt) : 'live';
        const latestSessionAt = history.codexSessions?.latestAt ? this.formatLillyDate(history.codexSessions.latestAt) : 'not visible';
        const sessionSize = this.formatLillyBytes(history.codexSessions?.totalBytes || 0);
        const primaryCategories = Array.isArray(history.primaryCategories) && history.primaryCategories.length
            ? history.primaryCategories
            : (history.categories || []);
        const recentPulls = Array.isArray(history.recent) ? history.recent : [];
        const recentPullRequests = Array.isArray(history.recentPullRequests) ? history.recentPullRequests : [];
        const newestPull = recentPulls[0] || null;
        const newestPullRequest = recentPullRequests[0] || null;
        const currentPhase = [...(history.phases || [])].reverse().find((phase) => phase.to === '2099-12-31' || phase.to === 'now') || [...(history.phases || [])].reverse()[0] || null;

        statsContainer.innerHTML = [
            { label: 'Repo commits', value: totalPulls.toLocaleString(), detail: `${this.escapeHtml(history.firstDate || 'start')} to ${this.escapeHtml(history.lastDate || 'now')} | ${activeDays.toLocaleString()} days` },
            { label: 'GitHub PR merges', value: Number(history.mergedPullRequests || 0).toLocaleString(), detail: newestPullRequest ? `latest #${Number(newestPullRequest.number || 0).toLocaleString()} on ${this.escapeHtml(newestPullRequest.date || '')}` : 'merge commits not visible here' },
            { label: 'Codex sessions', value: codexSessionCount ? codexSessionCount.toLocaleString() : 'optional', detail: history.codexSessions?.available ? `${sessionSize} logs, latest ${latestSessionAt}` : 'session logs not visible here' },
            { label: 'Last 30 days', value: Number(recentVelocity.last30Days || 0).toLocaleString(), detail: `${Number(recentVelocity.last7Days || 0).toLocaleString()} in latest 7 days` },
            { label: 'Daily build pace', value: averageDailyPulls, detail: 'average repo commits per active day' },
            { label: 'Multi-lane commits', value: multiLanePulls.toLocaleString(), detail: 'commits tagged across multiple work streams' },
            { label: 'Tagged / maintenance', value: `${taggedPulls.toLocaleString()} / ${maintenancePulls.toLocaleString()}`, detail: 'classified by subject-line signals' },
        ].map((item) => `
            <div class="lilly-stat">
                <span class="lilly-stat-value">${item.value}</span>
                <span class="lilly-stat-label">${item.label}</span>
                <span class="lilly-stat-detail">${item.detail}</span>
            </div>
        `).join('');

        pulseContainer.innerHTML = `
            <div class="lilly-pulse-grid">
                <div class="lilly-pulse-item">
                    <span>Newest commit</span>
                    <strong>${this.escapeHtml(newestPull?.date || recentVelocity.latestDate || history.lastDate || 'not visible')}</strong>
                    <p>${this.escapeHtml(newestPull?.subject || 'No recent commit subject visible from this runtime.')}</p>
                </div>
                <div class="lilly-pulse-item">
                    <span>Newest GitHub PR</span>
                    <strong>${newestPullRequest ? `#${Number(newestPullRequest.number || 0).toLocaleString()}` : 'not visible'}</strong>
                    <p>${this.escapeHtml(newestPullRequest?.source || newestPullRequest?.subject || 'No pull-request merge subject visible from this runtime.')}</p>
                </div>
                <div class="lilly-pulse-item">
                    <span>Current chapter</span>
                    <strong>${this.escapeHtml(currentPhase?.label || 'Live history')}</strong>
                    <p>${Number(currentPhase?.count || 0).toLocaleString()} commits in this phase | ${Number(currentPhase?.percent || 0)}% of visible history</p>
                </div>
                <div class="lilly-pulse-item">
                    <span>Velocity</span>
                    <strong>${Number(recentVelocity.last7Days || 0).toLocaleString()} commits</strong>
                    <p>${Number(recentVelocity.last14Days || 0).toLocaleString()} in 14 days | ${Number(recentVelocity.last30Days || 0).toLocaleString()} in 30 days</p>
                </div>
                <div class="lilly-pulse-item">
                    <span>Codex evidence</span>
                    <strong>${codexSessionCount ? codexSessionCount.toLocaleString() : 'optional'}</strong>
                    <p>${history.codexSessions?.available ? `${sessionSize} logs | latest ${latestSessionAt}` : 'session logs are not visible in this runtime'}</p>
                </div>
            </div>
            <div class="lilly-pulse-recent">
                ${recentPullRequests.slice(0, 6).map((pullRequest) => {
                    const label = `#${Number(pullRequest.number || 0).toLocaleString()}`;
                    const body = pullRequest.source || pullRequest.subject || '';
                    const content = `
                        <strong>${this.escapeHtml(label)}</strong>
                        ${this.escapeHtml(body)}
                    `;
                    return pullRequest.url
                        ? `<a class="lilly-pulse-chip lilly-tag-border-${this.escapeHtml(pullRequest.primaryTag || 'maintenance')}" href="${this.escapeHtml(pullRequest.url)}" target="_blank" rel="noopener">${content}</a>`
                        : `<span class="lilly-pulse-chip lilly-tag-border-${this.escapeHtml(pullRequest.primaryTag || 'maintenance')}">${content}</span>`;
                }).join('')}
                ${recentPulls.slice(0, 6).map((commit) => `
                    <span class="lilly-pulse-chip lilly-tag-border-${this.escapeHtml(commit.primaryTag || 'maintenance')}">
                        <strong>${this.escapeHtml(commit.shortHash || '')}</strong>
                        ${this.escapeHtml(commit.subject || '')}
                    </span>
                `).join('') || '<span class="lilly-pulse-chip">Recent pull details are unavailable from the fallback wiki seed.</span>'}
            </div>
        `;

        const maxPhaseCount = Math.max(1, ...(history.phases || []).map((phase) => Number(phase.count || 0)));
        phaseContainer.innerHTML = (history.phases || []).map((phase) => {
            const width = Math.max(8, Math.round((Number(phase.count || 0) / maxPhaseCount) * 100));
            const tagText = (phase.tagCounts || [])
                .slice(0, 4)
                .map((tag) => `${this.escapeHtml(tag.label)} ${Number(tag.count || 0).toLocaleString()}`)
                .join(' | ');
            const primaryTagText = (phase.primaryTagCounts || [])
                .slice(0, 4)
                .map((tag) => `${this.escapeHtml(tag.label)} ${Number(tag.count || 0).toLocaleString()}`)
                .join(' | ');

            return `
                <article class="lilly-phase-card lilly-phase-${this.escapeHtml(phase.id)}">
                    <div class="lilly-phase-topline">
                        <span class="lilly-phase-label">${this.escapeHtml(phase.label)}</span>
                        <span class="lilly-phase-count">${Number(phase.count || 0).toLocaleString()} commits | ${Number(phase.percent || 0)}%</span>
                    </div>
                    <div class="lilly-phase-range">${this.escapeHtml(phase.from)} to ${phase.to === '2099-12-31' ? 'now' : this.escapeHtml(phase.to)}</div>
                    <p>${this.escapeHtml(phase.summary || '')}</p>
                    <div class="lilly-phase-mini-stats">
                        <span>${Number(phase.repairCount || 0).toLocaleString()} repair</span>
                        <span>${Number(phase.growthCount || 0).toLocaleString()} growth</span>
                    </div>
                    <div class="lilly-phase-meter"><span style="width: ${width}%"></span></div>
                    <div class="lilly-phase-tags">${primaryTagText || tagText || 'mixed work'}</div>
                </article>
            `;
        }).join('');

        const tiles = Array.isArray(history.tiles) ? history.tiles : [];
        collageContainer.innerHTML = `
            <div class="lilly-collage-summary">
                <div>
                    <strong>${totalPulls.toLocaleString()}</strong>
                    <span>dots, one for each repo commit in local history</span>
                </div>
                <div class="lilly-data-note">
                    <span>Generated ${this.escapeHtml(generatedAt)}</span>
                    <span>${this.escapeHtml(history.source || 'local history')}</span>
                </div>
                <div class="lilly-legend">
                    ${(history.categories || []).map((category) => `
                        <span class="lilly-legend-item lilly-tag-${this.escapeHtml(category.id)}">
                            ${this.escapeHtml(category.label)} ${Number(category.count || 0).toLocaleString()}
                        </span>
                    `).join('')}
                </div>
            </div>
            <div class="lilly-dot-wall" aria-label="Lilly pull collage">
                ${tiles.map((tile) => `
                    <span
                        class="lilly-dot lilly-tag-${this.escapeHtml(tile.primaryTag || 'maintenance')}"
                        title="#${Number(tile.index || 0).toLocaleString()} ${this.escapeHtml(tile.date || '')}: ${this.escapeHtml(tile.subject || '')}"
                    ></span>
                `).join('')}
            </div>
            <div class="lilly-recent-pulls">
                ${(history.recent || []).slice(0, 12).map((commit) => `
                    <a class="lilly-recent-pull lilly-tag-border-${this.escapeHtml(commit.primaryTag || 'maintenance')}" href="${this.escapeHtml(history.repositoryUrl || 'https://github.com/philly1084/KimiBuilt')}/commit/${this.escapeHtml(commit.hash || '')}" target="_blank" rel="noopener">
                        <span>${this.escapeHtml(commit.shortHash || '')}</span>
                        <strong>${this.escapeHtml(commit.subject || '')}</strong>
                        <em>${this.escapeHtml(commit.date || '')}</em>
                    </a>
                `).join('')}
            </div>
        `;

        const overlapCategories = Array.isArray(history.categories) ? history.categories : [];
        threadsContainer.innerHTML = `
            <div class="lilly-breakdown-summary">
                <div>
                    <strong>${primaryCategories.length}</strong>
                    <span>primary lanes</span>
                </div>
                <div>
                    <strong>${overlapCategories.reduce((sum, category) => sum + Number(category.count || 0), 0).toLocaleString()}</strong>
                    <span>overlapping lane tags</span>
                </div>
            </div>
            ${primaryCategories.map((category) => {
            const percent = totalPulls ? Math.round((Number(category.count || 0) / totalPulls) * 100) : 0;
            const overlap = overlapCategories.find((item) => item.id === category.id);
            return `
                <div class="lilly-thread">
                    <div class="lilly-thread-header">
                        <span class="lilly-thread-name lilly-tag-text-${this.escapeHtml(category.id)}">${this.escapeHtml(category.label)}</span>
                        <span>${Number(category.count || 0).toLocaleString()} primary | ${percent}%</span>
                    </div>
                    <div class="lilly-thread-meter">
                        <span class="lilly-tag-bg-${this.escapeHtml(category.id)}" style="width: ${Math.max(3, percent)}%"></span>
                    </div>
                    <div class="lilly-thread-meta">
                        <span>${Number(overlap?.count || category.count || 0).toLocaleString()} total tag matches</span>
                        <span>${Number(overlap?.primaryCount || category.count || 0).toLocaleString()} primary matches</span>
                    </div>
                    <p>${this.escapeHtml(this.describeLillyThread(category.id))}</p>
                </div>
            `;
        }).join('')}
        `;

        timelineContainer.innerHTML = (history.phases || []).map((phase) => `
            <article class="lilly-timeline-step">
                <div class="lilly-timeline-marker"></div>
                <div>
                    <div class="lilly-timeline-heading">
                        <span>${this.escapeHtml(phase.label)}</span>
                        <span>${Number(phase.count || 0).toLocaleString()} commits | ${Number(phase.percent || 0)}%</span>
                    </div>
                    <p>${this.escapeHtml(phase.summary || '')}</p>
                    <div class="lilly-timeline-highlights">
                        ${(phase.highlights || []).slice(0, 4).map((commit) => `
                            <span>${this.escapeHtml(commit.subject || '')}</span>
                        `).join('')}
                    </div>
                </div>
            </article>
        `).join('');
    }

    describeLillyThread(categoryId) {
        const descriptions = {
            privacy: 'The privacy and trust lane tracks the newest safety layer: PII vault routing, trusted calculation batches, identity masking, approval flows, and audit-ready handling.',
            repair: 'The repair lane is the proof of pressure: crash loops, fallbacks, regressions, CORS, PDF, storage, and routing fixes that kept Lilly usable while it grew.',
            growth: 'The growth lane is where new surfaces appeared: tools, routes, workflows, documents, remote runners, podcast/video paths, skills, and orchestration abilities.',
            interface: 'The interface lane tracks the visible shape of Lilly across web chat, notes, canvas, CLI, admin, voxel polish, and dashboard diagnostics.',
            ops: 'The operations lane made Lilly deployable: k3s, Rancher, Docker, GitLab, ingress, secrets, runners, and live-cluster proof loops.',
            media: 'The media and document lane covers PDFs, generated docs, images, podcasts, audio, video, templates, and the asset flows around them.',
            intelligence: 'The intelligence lane is the system learning to plan: memory, tools, models, prompts, skills, Symphony, and agent orchestration.',
            maintenance: 'The maintenance lane holds quieter build work that does not announce one clear feature theme but still adds up to the working platform.',
        };

        return descriptions[categoryId] || 'Mixed maintenance and build work that does not fit cleanly into one lane.';
    }

    getLillyHistoryFallback() {
        return {
            generatedAt: new Date().toISOString(),
            source: 'fallback static wiki seed refreshed from local history on 2026-06-28',
            repositoryUrl: 'https://github.com/philly1084/KimiBuilt',
            totalPulls: 1373,
            mergedPullRequests: 17,
            repairPulls: 413,
            growthPulls: 253,
            maintenancePulls: 202,
            taggedPulls: 1171,
            multiLanePulls: 636,
            recentVelocity: {
                latestDate: '2026-06-28',
                last7Days: 134,
                last14Days: 205,
                last30Days: 312,
            },
            firstDate: '2026-03-04',
            lastDate: '2026-06-28',
            codexSessions: { available: false, count: 1361, latestAt: '2026-06-28T11:03:20.985Z', totalBytes: 2177943628 },
            categories: [
                { id: 'privacy', label: 'Privacy + Trust', count: 52, primaryCount: 52, percent: 4 },
                { id: 'repair', label: 'Repair', count: 413, primaryCount: 399, percent: 30 },
                { id: 'growth', label: 'Growth', count: 253, primaryCount: 221, percent: 18 },
                { id: 'interface', label: 'Interface', count: 499, primaryCount: 258, percent: 36 },
                { id: 'ops', label: 'Ops', count: 257, primaryCount: 74, percent: 19 },
                { id: 'media', label: 'Media + Docs', count: 232, primaryCount: 89, percent: 17 },
                { id: 'intelligence', label: 'Intelligence', count: 273, primaryCount: 78, percent: 20 },
            ],
            primaryCategories: [
                { id: 'privacy', label: 'Privacy + Trust', count: 52, percent: 4 },
                { id: 'repair', label: 'Repair', count: 399, percent: 29 },
                { id: 'growth', label: 'Growth', count: 221, percent: 16 },
                { id: 'interface', label: 'Interface', count: 258, percent: 19 },
                { id: 'ops', label: 'Ops', count: 74, percent: 5 },
                { id: 'media', label: 'Media + Docs', count: 89, percent: 6 },
                { id: 'intelligence', label: 'Intelligence', count: 78, percent: 6 },
                { id: 'maintenance', label: 'Maintenance', count: 202, percent: 15 },
            ],
            phases: [
                { id: 'ignition', label: 'Ignition', from: '2026-03-04', to: '2026-03-11', count: 71, percent: 5, repairCount: 21, growthCount: 24, summary: 'The first backend, frontends, Rancher/k3s path, Docker publishing, and document generation pieces came online.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'notes-admin', label: 'Notes + Admin Spine', from: '2026-03-12', to: '2026-03-18', count: 74, percent: 5, repairCount: 40, growthCount: 3, summary: 'Notes became a real working surface while admin, auth, chat continuity, PDFs, and crash recovery kept getting repaired.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'runtime', label: 'Agent Runtime', from: '2026-03-19', to: '2026-03-25', count: 75, percent: 5, repairCount: 35, growthCount: 17, summary: 'Tool calls, memory, artifacts, remote command routing, and conversation orchestration turned Lilly into an agent platform.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'remote-builds', label: 'Remote Builds', from: '2026-03-26', to: '2026-04-18', count: 290, percent: 21, repairCount: 98, growthCount: 62, summary: 'The system learned to build, deploy, repair, and continue work across local, remote, and generated artifact paths.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'polish-pipeline', label: 'Polish Pipeline', from: '2026-04-19', to: '2026-04-25', count: 134, percent: 10, repairCount: 43, growthCount: 25, summary: 'Session polish, document workflows, voxel/web UI improvements, remote runners, and artifact handling tightened into a bigger loop.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'media-symphony', label: 'Media + Symphony', from: '2026-04-26', to: '2026-05-01', count: 86, percent: 6, repairCount: 21, growthCount: 33, summary: 'Podcast, video, image gateways, Symphony orchestration, GitLab, and diagnostics became major growth branches.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'live-learning', label: 'Live Learning', from: '2026-05-02', to: '2026-05-13', count: 157, percent: 11, repairCount: 40, growthCount: 40, summary: 'Kokoro, k3s proof loops, skills, frontend standards, and prompt state machines made the platform more durable and self-aware.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'privacy-trust', label: 'Privacy + Trust Layer', from: '2026-05-14', to: '2026-05-20', count: 76, percent: 6, repairCount: 24, growthCount: 11, summary: 'PII vault routing, trusted workbook calculations, admin-preview hardening, self-reflection approvals, and safer note cleanup became a dedicated trust layer.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'remote-agent-loop', label: 'Remote Agent Loop', from: '2026-05-21', to: '2026-05-31', count: 126, percent: 9, repairCount: 47, growthCount: 10, summary: 'Remote CLI agent routing, Kokoro TTS scaling, direct proof markers, and web-chat progress handling turned remote work into a visible operating loop.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'async-ops', label: 'Async Ops + Admin', from: '2026-06-01', to: '2026-06-06', count: 47, percent: 3, repairCount: 7, growthCount: 13, summary: 'Codex-agent defaults, managed-app promotion, async runtime toggles, after-process audits, durable prompt refreshes, and admin capability maps moved into the backend spine.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'artifact-docs', label: 'Artifact + Document Hardening', from: '2026-06-07', to: '2026-06-18', count: 47, percent: 3, repairCount: 18, growthCount: 5, summary: 'Document recovery, real PPTX rendering, Notes image persistence, artifact downloads, skill routing, and conversation-plan repairs made generated outputs more dependable.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'frontend-proof', label: 'Frontend Proof Rotation', from: '2026-06-19', to: '2026-06-25', count: 116, percent: 8, repairCount: 9, growthCount: 6, summary: 'Admin, Web Chat, Web CLI, Canvas, and Notes received focused accessibility, metadata normalization, model-routing, and handoff polish backed by route-level checks.', tagCounts: [], primaryTagCounts: [], highlights: [] },
                { id: 'agent-company', label: 'Agent Company + Review Loop', from: '2026-06-26', to: 'now', count: 74, percent: 5, repairCount: 10, growthCount: 4, summary: 'Agent Company review paths, shared whiteboard recovery, CEO action context, artifact access, trace metadata, and action-history evidence became the active admin focus.', tagCounts: [], primaryTagCounts: [], highlights: [] },
            ],
            tiles: Array.from({ length: 1373 }, (_, index) => ({
                index: index + 1,
                date: '',
                subject: 'Lilly build pull',
                primaryTag: ['privacy', 'repair', 'growth', 'interface', 'ops', 'media', 'intelligence'][index % 7],
            })),
            recent: [
                { hash: '418cbfdff512b95a57aaa7d043d0a59c7998d81c', shortHash: '418cbfd', date: '2026-06-28', subject: 'Normalize image model capabilities in frontends', phase: 'agent-company', primaryTag: 'media' },
                { hash: '26e27784d20258e838fb27b5c4d6786fef00686e', shortHash: '26e2778', date: '2026-06-28', subject: 'Filter admin action history', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: 'ab5485cb2fe7e7d5847df282cac5ca4d64b056b8', shortHash: 'ab5485c', date: '2026-06-28', subject: 'Retry coded sub-agent rate limits', phase: 'agent-company', primaryTag: 'repair' },
                { hash: '3e6aebebbe0b50f1a4e7f415f90fe177895adf00', shortHash: '3e6aebe', date: '2026-06-28', subject: 'Label admin action history evidence', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: '9c86fa941f99533e6eecc1dc7093249b3c3b7ba5', shortHash: '9c86fa9', date: '2026-06-28', subject: 'Improve web chat clipboard fallback', phase: 'agent-company', primaryTag: 'repair' },
                { hash: '00c1925e38f0be2e5882dc8c5606c379dcfef5fd', shortHash: '00c1925', date: '2026-06-28', subject: 'Show saved admin CEO actions', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: 'e13fbd5a6d9c3b72f375dfdac2e2f4ff4f74ea2e', shortHash: 'e13fbd5', date: '2026-06-28', subject: 'Label Web CLI imported file actions', phase: 'agent-company', primaryTag: 'interface' },
                { hash: '571dd8d6cdfe0af166277dd6a04ba32f88fc1046', shortHash: '571dd8d', date: '2026-06-28', subject: 'Show admin action snapshot time', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: '28ecde6b8133dfa1925618bc748317ee0cac280a', shortHash: '28ecde6', date: '2026-06-28', subject: 'Strip fenced reasoning from artifacts', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: '47f205c9acbad929921b84ddf216702e8b69facb', shortHash: '47f205c', date: '2026-06-28', subject: 'Label admin action context source', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: '40a3d0b0d6dc5aaa15a2357f3762ec920e52e480', shortHash: '40a3d0b', date: '2026-06-28', subject: 'Normalize thinking summary aliases', phase: 'agent-company', primaryTag: 'maintenance' },
                { hash: '9abcfaaf8fbab1032313a7d3a45c4e28134701a7', shortHash: '9abcfaa', date: '2026-06-28', subject: 'Preserve admin CEO action context', phase: 'agent-company', primaryTag: 'maintenance' },
            ],
            recentPullRequests: [
                { hash: '71a75eb491530852346cc9eeea7d4096bad606c5', shortHash: '71a75eb', date: '2026-06-21', subject: 'Merge pull request #24 from philly1084/dependabot/npm_and_yarn/npm_and_yarn-88d83b093f', phase: 'frontend-proof', primaryTag: 'maintenance', number: 24, source: 'philly1084/dependabot/npm_and_yarn/npm_and_yarn-88d83b093f', url: 'https://github.com/philly1084/KimiBuilt/pull/24' },
                { hash: '417cdd672c8d37d688682dd1a31f594c07f83ced', shortHash: '417cdd6', date: '2026-06-06', subject: 'Merge pull request #22 from philly1084/codex/admin-durable-prompt-refresh', phase: 'async-ops', primaryTag: 'intelligence', number: 22, source: 'philly1084/codex/admin-durable-prompt-refresh', url: 'https://github.com/philly1084/KimiBuilt/pull/22' },
                { hash: '924b240137d2c323a0d1b0942207626d62156dcf', shortHash: '924b240', date: '2026-05-31', subject: 'Merge pull request #18 from philly1084/dependabot/npm_and_yarn/npm_and_yarn-74c37e61c1', phase: 'remote-agent-loop', primaryTag: 'maintenance', number: 18, source: 'philly1084/dependabot/npm_and_yarn/npm_and_yarn-74c37e61c1', url: 'https://github.com/philly1084/KimiBuilt/pull/18' },
                { hash: 'a01a71daeebb2cd97b7ec90c6de5795f0da37c88', shortHash: 'a01a71d', date: '2026-05-31', subject: 'Merge pull request #20 from philly1084/codex/remote-cli-webchat-proof', phase: 'remote-agent-loop', primaryTag: 'interface', number: 20, source: 'philly1084/codex/remote-cli-webchat-proof', url: 'https://github.com/philly1084/KimiBuilt/pull/20' },
                { hash: '8e36b6f6cf839a275ed778993098e7f031b86e8e', shortHash: '8e36b6f', date: '2026-05-25', subject: 'Merge pull request #19 from philly1084/codex/fix-remote-cli-agent-error', phase: 'remote-agent-loop', primaryTag: 'repair', number: 19, source: 'philly1084/codex/fix-remote-cli-agent-error', url: 'https://github.com/philly1084/KimiBuilt/pull/19' },
                { hash: '2e6e74399a4fa3e01fb70a3d25fb73a2fc3e4ba0', shortHash: '2e6e743', date: '2026-05-18', subject: 'Merge pull request #16 from philly1084/codex/fix-workspace-loading-performance-issue', phase: 'privacy-trust', primaryTag: 'repair', number: 16, source: 'philly1084/codex/fix-workspace-loading-performance-issue', url: 'https://github.com/philly1084/KimiBuilt/pull/16' },
                { hash: 'fb01d3b07ecc3ed51d460178ca73786f318d538f', shortHash: 'fb01d3b', date: '2026-05-01', subject: 'Merge pull request #12 from philly1084/codex/verify-correct-info-for-open-so-endpoint', phase: 'media-symphony', primaryTag: 'maintenance', number: 12, source: 'philly1084/codex/verify-correct-info-for-open-so-endpoint', url: 'https://github.com/philly1084/KimiBuilt/pull/12' },
                { hash: '1f035a1cd2ad28cb3607bd30fa01bb13ba5a2d96', shortHash: '1f035a1', date: '2026-05-01', subject: 'Merge pull request #11 from philly1084/codex/fix-css-styling-in-sandbox-creation', phase: 'media-symphony', primaryTag: 'repair', number: 11, source: 'philly1084/codex/fix-css-styling-in-sandbox-creation', url: 'https://github.com/philly1084/KimiBuilt/pull/11' },
                { hash: '472b7f481dea2be5e9cc510e3b6930d1cdcec18b', shortHash: '472b7f4', date: '2026-05-01', subject: 'Merge pull request #10 from philly1084/codex/fix-podcast-making-error-with-gpt-4o', phase: 'media-symphony', primaryTag: 'repair', number: 10, source: 'philly1084/codex/fix-podcast-making-error-with-gpt-4o', url: 'https://github.com/philly1084/KimiBuilt/pull/10' },
                { hash: '1a906be069a69b84a751fea233844e475341ede1', shortHash: '1a906be', date: '2026-04-29', subject: 'Merge pull request #9 from philly1084/codex/fix-podcast-service-backend-crash', phase: 'media-symphony', primaryTag: 'repair', number: 9, source: 'philly1084/codex/fix-podcast-service-backend-crash', url: 'https://github.com/philly1084/KimiBuilt/pull/9' },
                { hash: '5d14df460fd405df011661d3f9a56ad281c8503d', shortHash: '5d14df4', date: '2026-04-29', subject: 'Merge pull request #8 from philly1084/codex/fix-podcast-server-crashes-with-tts-model', phase: 'media-symphony', primaryTag: 'repair', number: 8, source: 'philly1084/codex/fix-podcast-server-crashes-with-tts-model', url: 'https://github.com/philly1084/KimiBuilt/pull/8' },
                { hash: '7fb611302642fa53c41604a456f3d9a8a1472f31', shortHash: '7fb6113', date: '2026-04-25', subject: 'Merge pull request #6 from philly1084/codex/improve-agent-planning-and-quota-system', phase: 'polish-pipeline', primaryTag: 'intelligence', number: 6, source: 'philly1084/codex/improve-agent-planning-and-quota-system', url: 'https://github.com/philly1084/KimiBuilt/pull/6' },
            ],
        };
    }
    
    /**
     * Load statistics
     */
    async loadStats() {
        try {
            const range = document.getElementById('chartTimeRange')?.value || '24h';
            const response = await apiClient.get('/api/admin/stats', { range });
            const payload = this.unwrapApiPayload(response, {});
            const stats = this.normalizeOverviewStats(payload);
            
            this.state.stats = stats;
            
            // Update UI
            document.getElementById('totalTasks').textContent = stats.totalTasks.toLocaleString();
            document.getElementById('successRate').textContent = `${stats.successRate}%`;
            document.getElementById('activeSessions').textContent = stats.activeSessions;
            document.getElementById('skillsUsed').textContent = stats.skillsUsed.toLocaleString();
            const skillsUsedChange = document.getElementById('skillsUsedChange');
            if (skillsUsedChange) {
                skillsUsedChange.innerHTML = `${stats.skillsUsedThisWeek.toLocaleString()} <span>this week</span>`;
                skillsUsedChange.classList.toggle('positive', stats.skillsUsedThisWeek > 0);
                skillsUsedChange.classList.toggle('neutral', stats.skillsUsedThisWeek <= 0);
            }
            this.renderOverviewTokenUsage(stats);
            this.renderRequestChart(stats.requestChart);
            
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }
    
    /**
     * Load models
     */
    async loadModels() {
        try {
            const [modelsResult, usageResult] = await Promise.allSettled([
                apiClient.get('/api/admin/models'),
                apiClient.get('/api/admin/models/usage/stats'),
            ]);
            const liveModels = modelsResult.status === 'fulfilled'
                ? this.unwrapApiPayload(modelsResult.value, [])
                : [];
            const usageRows = usageResult.status === 'fulfilled'
                ? this.unwrapApiPayload(usageResult.value, [])
                : [];
            const models = this.mergeModelsWithUsage(liveModels, usageRows);

            if (modelsResult.status === 'rejected') {
                console.warn('Admin live model inventory unavailable, showing runtime usage data only:', modelsResult.reason);
            }
            if (usageResult.status === 'rejected') {
                console.warn('Admin model usage unavailable, showing live inventory only:', usageResult.reason);
            }

            this.state.models = models;
            this.syncModelOptions(models);
            this.renderModels(models);
        } catch (error) {
            console.error('Error loading models:', error);
            this.state.models = [];
            this.syncModelOptions([]);
            this.renderModels([]);
        }
    }
    
    /**
     * Load prompts
     */
    async loadPrompts({ preserveEditor = true } = {}) {
        try {
            const response = await apiClient.get('/api/admin/prompts');
            const prompts = this.unwrapApiPayload(response, []);
            const selectedPromptId = this.state.selectedPrompt?.id || null;
            this.state.prompts = prompts;
            this.renderPromptList(prompts);

            const refreshedSelection = selectedPromptId
                ? prompts.find((prompt) => prompt.id === selectedPromptId)
                : null;
            if (refreshedSelection) {
                if (!preserveEditor || !this.promptEditorDirty) {
                    this.selectPrompt(refreshedSelection);
                } else {
                    this.state.selectedPrompt = refreshedSelection;
                    this.updatePromptListActiveState(refreshedSelection.id);
                }
            } else if (prompts.length > 0 && !this.state.selectedPrompt) {
                this.selectPrompt(prompts[0]);
            }
        } catch (error) {
            console.error('Error loading prompts:', error);
            this.state.prompts = [];
            this.renderPromptList([]);
        }
    }
    
    /**
     * Load skills
     */
    async loadSkills() {
        const [skillsResult, toolsResult] = await Promise.allSettled([
            apiClient.getSkills(),
            apiClient.getTools(),
        ]);

        let skills = [];
        if (skillsResult.status === 'fulfilled') {
            skills = this.unwrapApiPayload(skillsResult.value, []).map((skill) => this.normalizeSkill(skill));
        } else {
            console.error('Error loading skills:', skillsResult.reason);
        }

        let tools = [];
        if (toolsResult.status === 'fulfilled') {
            const skillMap = new Map(skills.map((skill) => [skill.id, skill]));
            tools = this.unwrapApiPayload(toolsResult.value, []).map((tool) =>
                this.normalizeTool(tool, skillMap.get(tool.id)),
            );
        } else {
            console.error('Error loading tools:', toolsResult.reason);
            this.showToast('Failed to load live tool catalog', 'error');
        }

        this.state.skills = skills;
        this.state.tools = tools;
        this.renderSkillCategories(tools);
        this.renderToolSummary(tools);
        this.renderSkills(this.getFilteredTools());

        const nextSelectedTool = tools.find((tool) => tool.id === this.state.selectedToolId) || tools[0] || null;
        this.state.selectedToolId = nextSelectedTool?.id || null;
        this.renderToolDetail(nextSelectedTool);
    }
    
    /**
     * Load logs
     */
    async loadLogs() {
        if (this.state.logsPaused) return;
        
        try {
            const { page, limit } = this.state.pagination.logs;
            const response = await apiClient.get('/api/admin/logs', { page, limit });
            const logs = this.unwrapApiPayload(response, []).map(log => this.normalizeLog(log));
            const pagination = this.getApiPagination(response);
            
            this.state.logs = logs;
            if (pagination) {
                this.state.pagination.logs = { ...this.state.pagination.logs, ...pagination, total: pagination.total || 0 };
            }
            this.populateLogModelFilter(logs);
            this.renderLogs(logs);
            this.updateLogsPagination();
        } catch (error) {
            console.error('Error loading logs:', error);
            this.renderLogs(this.getMockLogs());
        }
    }
    
    /**
     * Load traces
     */
    async loadTraces() {
        try {
            const { page, limit } = this.state.pagination.traces;
            const response = await apiClient.get('/api/admin/traces', { page, limit });
            const traces = this.unwrapApiPayload(response, []).map(trace => this.normalizeTrace(trace));
            const pagination = this.getApiPagination(response);
            
            this.state.traces = traces;
            if (pagination) {
                this.state.pagination.traces = { ...this.state.pagination.traces, ...pagination, total: pagination.total || 0 };
            }
            if (this.state.selectedTrace && !traces.some((trace) => trace.id === this.state.selectedTrace.id)) {
                this.state.selectedTrace = null;
            }
            this.renderTraces(traces);
        } catch (error) {
            console.error('Error loading traces:', error);
            this.renderTraces(this.getMockTraces());
        }
    }

    async loadWorkloads() {
        if (this.state.workloadsSupported === false) {
            this.setDeferredWorkloadsUnavailable(this.state.workloadErrorMessage || this.getDeferredWorkloadUnavailableMessage());
            return;
        }

        try {
            const [workloadsResponse, runsResponse] = await Promise.all([
                apiClient.getAdminWorkloads(100),
                apiClient.getAdminRuns(150),
            ]);
            const workloads = this.unwrapApiPayload(workloadsResponse, []).map((workload) => this.normalizeAdminWorkload(workload));
            const runs = this.unwrapApiPayload(runsResponse, []).map((run) => this.normalizeAdminRun(run, workloads));

            this.state.workloads = workloads;
            this.state.runs = runs;
            this.state.workloadsAvailable = true;
            this.state.workloadErrorMessage = '';

            if (this.state.selectedRun?.id) {
                const nextSelectedRun = runs.find((run) => run.id === this.state.selectedRun.id) || null;
                this.state.selectedRun = nextSelectedRun;
            }

            if (!this.state.selectedRun && runs.length > 0) {
                this.state.selectedRun = runs[0];
            }

            this.renderWorkloadSummary(workloads, runs);
            this.renderAdminWorkloads(workloads);
            this.renderAdminRuns(runs);
            this.renderAdminRunDetails(this.state.selectedRun);
            this.renderAgentCompanyDashboard();
            this.updateWorkloadControls();
        } catch (error) {
            const unavailable = this.isPersistenceUnavailableError(error);

            if (unavailable) {
                this.setDeferredWorkloadsUnavailable(this.getDeferredWorkloadUnavailableMessage());
                console.warn('Deferred workloads unavailable:', error.message || error);
                return;
            }

            this.state.workloads = [];
            this.state.runs = [];
            this.state.selectedRun = null;
            this.state.workloadsAvailable = true;
            this.state.workloadErrorMessage = error.userMessage || error.message || 'Failed to load workload data';
            console.error('Error loading workloads:', error);

            this.renderWorkloadSummary([], []);
            this.renderAdminWorkloads([], this.state.workloadErrorMessage);
            this.renderAdminRuns([], this.state.workloadErrorMessage);
            this.renderAdminRunDetails(null, error, this.state.workloadErrorMessage);
            this.renderAgentCompanyDashboard();
            this.updateWorkloadControls();
        }
    }

    isPersistenceUnavailableError(error) {
        const message = String(error?.message || '').toLowerCase();
        return Number(error?.status) === 503
            && message.includes('postgres persistence');
    }

    getDeferredWorkloadUnavailableMessage() {
        return 'Deferred workloads are unavailable until Postgres persistence is configured.';
    }

    applyDashboardCapabilities(capabilities = {}) {
        if (typeof capabilities.deferredWorkloads === 'boolean') {
            this.state.workloadsSupported = capabilities.deferredWorkloads;
            if (!capabilities.deferredWorkloads) {
                this.setDeferredWorkloadsUnavailable(this.getDeferredWorkloadUnavailableMessage());
                return;
            } else {
                this.state.workloadsSupported = true;
            }
        }

        this.updateWorkloadControls();
    }

    setDeferredWorkloadsUnavailable(message = this.getDeferredWorkloadUnavailableMessage()) {
        this.state.workloads = [];
        this.state.runs = [];
        this.state.selectedRun = null;
        this.state.workloadsAvailable = false;
        this.state.workloadsSupported = false;
        this.state.workloadErrorMessage = message;

        this.renderWorkloadSummary([], []);
        this.renderAdminWorkloads([], message);
        this.renderAdminRuns([], message);
        this.renderAdminRunDetails(null, null, message);
        this.renderAgentCompanyDashboard();
        this.updateWorkloadControls();
    }

    updateWorkloadControls() {
        const refreshButton = document.getElementById('refreshWorkloadsBtn');
        if (!refreshButton) {
            return;
        }

        const unsupported = this.state.workloadsSupported === false;
        refreshButton.disabled = unsupported;
        refreshButton.title = unsupported
            ? 'Deferred workloads require Postgres persistence.'
            : 'Refresh deferred workloads';
    }

    async loadSelfReflectionUpdates({ force = false } = {}) {
        if (this.state.selfReflectionSupported === false && !force) {
            this.renderSelfReflectionUpdates(
                [],
                this.state.selfReflectionMeta,
                this.state.selfReflectionErrorMessage,
                this.state.selfReflectionSuggestions,
                this.state.selfReflectionSuggestionMeta
            );
            return;
        }

        try {
            const [updatesResult, suggestionsResult] = await Promise.allSettled([
                typeof apiClient.getSelfReflectionUpdates === 'function'
                    ? apiClient.getSelfReflectionUpdates(6)
                    : apiClient.get('/api/admin/self-reflection-updates', { limit: 6 }),
                typeof apiClient.getSelfReflectionSuggestions === 'function'
                    ? apiClient.getSelfReflectionSuggestions(6)
                    : apiClient.get('/api/admin/self-reflection-updates/suggestions', { limit: 6 }),
            ]);

            if (updatesResult.status === 'rejected') {
                throw updatesResult.reason;
            }

            const payload = this.unwrapApiPayload(updatesResult.value, {});
            const rawUpdates = Array.isArray(payload) ? payload : payload.updates;
            const updates = (Array.isArray(rawUpdates) ? rawUpdates : [])
                .map((update, index) => this.normalizeSelfReflectionUpdate(update, index))
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            let suggestions = this.state.selfReflectionSuggestions || [];
            let suggestionMeta = this.state.selfReflectionSuggestionMeta || {};
            if (suggestionsResult.status === 'fulfilled') {
                const suggestionPayload = this.unwrapApiPayload(suggestionsResult.value, {});
                const rawSuggestions = Array.isArray(suggestionPayload) ? suggestionPayload : suggestionPayload.suggestions;
                suggestions = (Array.isArray(rawSuggestions) ? rawSuggestions : [])
                    .map((suggestion, index) => this.normalizeSelfReflectionSuggestion(suggestion, index))
                    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
                suggestionMeta = Array.isArray(suggestionPayload) ? {} : (suggestionPayload.meta || {});
            } else if (Number(suggestionsResult.reason?.status) !== 404) {
                console.warn('Self-reflection suggestions unavailable:', suggestionsResult.reason?.message || suggestionsResult.reason);
            }

            this.state.selfReflectionUpdates = updates;
            this.state.selfReflectionSuggestions = suggestions;
            this.state.selfReflectionMeta = Array.isArray(payload) ? {} : (payload.meta || {});
            this.state.selfReflectionSuggestionMeta = suggestionMeta;
            this.state.selfReflectionSupported = true;
            this.state.selfReflectionErrorMessage = '';
            this.renderSelfReflectionUpdates(updates, this.state.selfReflectionMeta, '', suggestions, suggestionMeta);
        } catch (error) {
            document.body.classList.remove('api-loading');
            const message = Number(error?.status) === 404
                ? 'Self-reflection update route is not available yet.'
                : (error.userMessage || error.message || 'Failed to load self-reflection updates.');

            this.state.selfReflectionUpdates = [];
            this.state.selfReflectionSupported = Number(error?.status) === 404 ? false : this.state.selfReflectionSupported;
            this.state.selfReflectionErrorMessage = message;
            console.warn('Self-reflection updates unavailable:', error.message || error);
            this.renderSelfReflectionUpdates(
                [],
                this.state.selfReflectionMeta,
                message,
                this.state.selfReflectionSuggestions,
                this.state.selfReflectionSuggestionMeta
            );
        }
    }

    normalizeSelfReflectionUpdate(update = {}, index = 0) {
        const actions = Array.isArray(update.actions)
            ? update.actions.map((action) => this.normalizeSelfReflectionAction(action))
            : [];

        return {
            id: String(update.id || `reflection-${index + 1}`),
            timestamp: update.timestamp || update.createdAt || update.updatedAt || '',
            source: this.stringifySelfReflectionInline(update.source || 'self-reflection'),
            trigger: this.stringifySelfReflectionInline(update.trigger || 'manual'),
            reflection: this.stringifySelfReflectionInline(update.reflection || ''),
            modelCardNote: this.stringifySelfReflectionInline(update.modelCardNote || ''),
            actions,
            logPath: update.logPath ? this.stringifySelfReflectionInline(update.logPath) : '',
        };
    }

    normalizeSelfReflectionAction(action = {}) {
        if (typeof action === 'string') {
            return {
                label: action,
                status: 'noted',
                statusClass: 'neutral',
                detail: '',
            };
        }

        const status = String(action.status || action.state || action.result || (action.completed ? 'completed' : 'pending')).toLowerCase();
        const target = this.stringifySelfReflectionInline(action.target || action.skillId || action.id || '');
        const type = this.stringifySelfReflectionInline(action.type || action.label || action.title || action.name || 'action');
        const label = target ? `${type}: ${target}` : type;
        return {
            label,
            status,
            statusClass: this.getSelfReflectionActionClass(status),
            detail: this.stringifySelfReflectionInline(action.message || action.reason || action.summary || action.note || action.description || ''),
        };
    }

    normalizeSelfReflectionSuggestion(suggestion = {}, index = 0) {
        const input = suggestion.input && typeof suggestion.input === 'object'
            ? suggestion.input
            : {};
        const actions = Array.isArray(input.actions)
            ? input.actions.map((action) => this.normalizeSelfReflectionAction(action))
            : [];
        const status = String(suggestion.status || (suggestion.applied ? 'applied' : 'suggested')).toLowerCase();

        return {
            id: String(suggestion.id || `suggestion-${index + 1}`),
            status,
            statusClass: this.getSelfReflectionActionClass(status),
            applied: Boolean(suggestion.applied || status === 'applied'),
            canApply: suggestion.canApply !== false && actions.length > 0 && status !== 'applied',
            source: this.stringifySelfReflectionInline(input.source || 'alignment-evaluator'),
            trigger: this.stringifySelfReflectionInline(input.trigger || suggestion.reason || 'alignment feedback'),
            reflection: this.stringifySelfReflectionInline(input.reflection || suggestion.evaluation?.lesson || ''),
            updatedAt: suggestion.updatedAt || '',
            sessionId: this.stringifySelfReflectionInline(suggestion.sessionId || ''),
            messageId: this.stringifySelfReflectionInline(suggestion.messageId || ''),
            feedbackId: this.stringifySelfReflectionInline(suggestion.feedbackId || ''),
            actions,
        };
    }

    async applySelfReflectionSuggestion(id = '') {
        const suggestionId = String(id || '').trim();
        if (!suggestionId || this.state.applyingSelfReflectionSuggestionId) {
            return;
        }

        this.state.applyingSelfReflectionSuggestionId = suggestionId;
        this.renderSelfReflectionUpdates(
            this.state.selfReflectionUpdates,
            this.state.selfReflectionMeta,
            '',
            this.state.selfReflectionSuggestions,
            this.state.selfReflectionSuggestionMeta
        );

        try {
            const response = typeof apiClient.applySelfReflectionSuggestion === 'function'
                ? await apiClient.applySelfReflectionSuggestion(suggestionId)
                : await apiClient.post(`/api/admin/self-reflection-updates/suggestions/${encodeURIComponent(suggestionId)}/apply`);
            const payload = this.unwrapApiPayload(response, {});
            const actionCount = Array.isArray(payload.result?.actions) ? payload.result.actions.length : 0;
            this.showToast(`Applied ${actionCount || 1} self-reflection action${actionCount === 1 ? '' : 's'}`, 'success');
            await this.loadSelfReflectionUpdates({ force: true });
            await this.loadSettings({ preserveDirty: true, background: true });
            await this.loadPrompts({ preserveEditor: true });
        } catch (error) {
            this.showToast(error.userMessage || error.message || 'Failed to apply self-reflection suggestion', 'error');
        } finally {
            this.state.applyingSelfReflectionSuggestionId = null;
            this.renderSelfReflectionUpdates(
                this.state.selfReflectionUpdates,
                this.state.selfReflectionMeta,
                this.state.selfReflectionErrorMessage,
                this.state.selfReflectionSuggestions,
                this.state.selfReflectionSuggestionMeta
            );
        }
    }

    async loadAfterProcessAudits({ force = false } = {}) {
        if (this.state.afterProcessAuditSupported === false && !force) {
            this.renderAfterProcessAudits(
                [],
                this.state.afterProcessAuditMeta,
                this.state.afterProcessAuditErrorMessage
            );
            return;
        }

        try {
            const response = await apiClient.get('/api/admin/after-process-audits', { limit: 8 });
            const payload = this.unwrapApiPayload(response, {});
            const audits = (Array.isArray(payload.audits) ? payload.audits : [])
                .map((audit, index) => this.normalizeAfterProcessAudit(audit, index))
                .sort((a, b) => new Date(b.completedAt || b.updatedAt || 0).getTime() - new Date(a.completedAt || a.updatedAt || 0).getTime());
            this.state.afterProcessAudits = audits;
            this.state.afterProcessAuditMeta = payload.meta || {};
            this.state.afterProcessAuditSupported = true;
            this.state.afterProcessAuditErrorMessage = '';
            this.renderAfterProcessAudits(audits, this.state.afterProcessAuditMeta, '');
        } catch (error) {
            const message = Number(error?.status) === 404
                ? 'After-process audit route is not available yet.'
                : (error.userMessage || error.message || 'Failed to load after-process audits.');
            this.state.afterProcessAudits = [];
            this.state.afterProcessAuditSupported = Number(error?.status) === 404 ? false : this.state.afterProcessAuditSupported;
            this.state.afterProcessAuditErrorMessage = message;
            console.warn('After-process audits unavailable:', error.message || error);
            this.renderAfterProcessAudits([], this.state.afterProcessAuditMeta, message);
        }
    }

    normalizeAfterProcessAudit(audit = {}, index = 0) {
        const flagRecommendations = Array.isArray(audit.recommendedFlagChanges)
            ? audit.recommendedFlagChanges.map((recommendation, recommendationIndex) => ({
                id: String(recommendation.id || `after-flag-${index + 1}-${recommendationIndex + 1}`),
                flag: this.stringifySelfReflectionInline(recommendation.flag || ''),
                currentValue: recommendation.currentValue,
                suggestedValue: recommendation.suggestedValue,
                reason: this.stringifySelfReflectionInline(recommendation.reason || ''),
                confidence: recommendation.confidence ?? null,
                canApply: recommendation.canApply === true,
                status: String(recommendation.status || (recommendation.canApply ? 'suggested' : 'review_only')).toLowerCase(),
                hint: recommendation.hint || null,
            }))
            : [];
        const toolSkillReview = audit.toolSkillReview && typeof audit.toolSkillReview === 'object'
            ? audit.toolSkillReview
            : {};
        const toolFailureReview = audit.toolFailureReview && typeof audit.toolFailureReview === 'object'
            ? audit.toolFailureReview
            : {};
        const learningReview = audit.learningReview && typeof audit.learningReview === 'object'
            ? audit.learningReview
            : {};

        return {
            auditId: String(audit.auditId || `after-audit-${index + 1}`),
            sessionId: this.stringifySelfReflectionInline(audit.sessionId || ''),
            status: String(audit.status || 'completed').toLowerCase(),
            model: this.stringifySelfReflectionInline(audit.model || ''),
            completedAt: audit.completedAt || audit.updatedAt || '',
            decision: String(audit.decision || 'watch').toLowerCase(),
            qualityScore: Number.isFinite(Number(audit.qualityScore)) ? Number(audit.qualityScore) : null,
            summary: this.stringifySelfReflectionInline(audit.summary || ''),
            cleared: audit.cleared === true,
            toolSkillReview: {
                selectedSkills: Array.isArray(toolSkillReview.selectedSkills) ? toolSkillReview.selectedSkills : [],
                actualTools: Array.isArray(toolSkillReview.actualTools) ? toolSkillReview.actualTools : [],
                missingTools: Array.isArray(toolSkillReview.missingTools) ? toolSkillReview.missingTools : [],
                misusedTools: Array.isArray(toolSkillReview.misusedTools) ? toolSkillReview.misusedTools : [],
                skillUpdates: Array.isArray(toolSkillReview.skillUpdates) ? toolSkillReview.skillUpdates : [],
                toolPolicyUpdates: Array.isArray(toolSkillReview.toolPolicyUpdates) ? toolSkillReview.toolPolicyUpdates : [],
            },
            toolFailureReview: {
                failedToolCalls: Array.isArray(toolFailureReview.failedToolCalls) ? toolFailureReview.failedToolCalls : [],
                repeatedFailureSignatures: Array.isArray(toolFailureReview.repeatedFailureSignatures) ? toolFailureReview.repeatedFailureSignatures : [],
                recoveryPolicyUpdates: Array.isArray(toolFailureReview.recoveryPolicyUpdates) ? toolFailureReview.recoveryPolicyUpdates : [],
                noRepeatRules: Array.isArray(toolFailureReview.noRepeatRules) ? toolFailureReview.noRepeatRules : [],
            },
            learningReview: {
                durableLessons: Array.isArray(learningReview.durableLessons) ? learningReview.durableLessons : [],
                outputQualityRisks: Array.isArray(learningReview.outputQualityRisks) ? learningReview.outputQualityRisks : [],
            },
            recommendedFlagChanges: flagRecommendations,
            followUpActions: Array.isArray(audit.followUpActions) ? audit.followUpActions : [],
        };
    }

    async applyAfterProcessFlagRecommendation(id = '') {
        const recommendationId = String(id || '').trim();
        if (!recommendationId || this.state.applyingAfterProcessRecommendationId) {
            return;
        }

        this.state.applyingAfterProcessRecommendationId = recommendationId;
        this.renderAfterProcessAudits(
            this.state.afterProcessAudits,
            this.state.afterProcessAuditMeta,
            this.state.afterProcessAuditErrorMessage
        );

        try {
            const response = await apiClient.post(`/api/admin/after-process-audits/recommendations/${encodeURIComponent(recommendationId)}/apply`);
            const payload = this.unwrapApiPayload(response, {});
            const flag = payload.recommendation?.flag || 'flag';
            this.showToast(`Approved chat-time hint for ${flag}`, 'success');
            await this.loadAfterProcessAudits({ force: true });
        } catch (error) {
            this.showToast(error.userMessage || error.message || 'Failed to apply audit recommendation', 'error');
        } finally {
            this.state.applyingAfterProcessRecommendationId = null;
            this.renderAfterProcessAudits(
                this.state.afterProcessAudits,
                this.state.afterProcessAuditMeta,
                this.state.afterProcessAuditErrorMessage
            );
        }
    }

    async clearAfterProcessAudit(id = '') {
        const auditId = String(id || '').trim();
        if (!auditId || this.state.clearingAfterProcessAuditId) {
            return;
        }

        this.state.clearingAfterProcessAuditId = auditId;
        this.renderAfterProcessAudits(
            this.state.afterProcessAudits,
            this.state.afterProcessAuditMeta,
            this.state.afterProcessAuditErrorMessage
        );

        try {
            await apiClient.post(`/api/admin/after-process-audits/${encodeURIComponent(auditId)}/clear`);
            this.showToast('Cleared after-process audit from the review queue', 'success');
            await this.loadAfterProcessAudits({ force: true });
        } catch (error) {
            this.showToast(error.userMessage || error.message || 'Failed to clear after-process audit', 'error');
        } finally {
            this.state.clearingAfterProcessAuditId = null;
            this.renderAfterProcessAudits(
                this.state.afterProcessAudits,
                this.state.afterProcessAuditMeta,
                this.state.afterProcessAuditErrorMessage
            );
        }
    }

    renderAfterProcessAudits(audits = [], meta = {}, errorMessage = '') {
        const container = document.getElementById('afterProcessAuditList');
        const status = document.getElementById('afterProcessAuditStatus');
        if (!container) return;

        if (errorMessage) {
            this.setStatusBadge(status, 'error', 'Unavailable');
            container.innerHTML = `
                <div class="self-reflection-empty">
                    <strong>Unable to load audits</strong>
                    <span>${this.escapeHtml(errorMessage)}</span>
                </div>
            `;
            return;
        }

        const pendingCount = (Array.isArray(audits) ? audits : []).reduce((count, audit) => {
            return count + audit.recommendedFlagChanges.filter((recommendation) => recommendation.canApply).length;
        }, 0);
        if (!audits.length) {
            this.setStatusBadge(status, 'neutral', 'No audits');
            container.innerHTML = `
                <div class="self-reflection-empty">
                    <strong>No after-process audits recorded</strong>
                    <span>Completed calls will appear here after the audit lane records its first review.</span>
                </div>
            `;
            return;
        }

        this.setStatusBadge(status, pendingCount ? 'warning' : 'info', pendingCount ? `${pendingCount} flag suggestions` : `${audits.length} recent`);
        const total = Number(meta.count || audits.length);
        const needsFollowup = Number(meta.needsFollowupCount || audits.filter((audit) => audit.decision === 'needs_followup').length);

        container.innerHTML = `
            <div class="self-reflection-meta">
                <span>${this.escapeHtml(total.toLocaleString())} total audits | ${this.escapeHtml(needsFollowup.toLocaleString())} need follow-up</span>
            </div>
            ${audits.map((audit) => this.renderAfterProcessAuditCard(audit)).join('')}
        `;
    }

    renderAfterProcessAuditCard(audit = {}) {
        const score = audit.qualityScore == null
            ? 'n/a'
            : `${Math.round(Math.max(0, Math.min(1, audit.qualityScore)) * 100)}%`;
        const chips = [
            ...audit.toolSkillReview.missingTools.map((tool) => ({ label: `missing tool: ${tool}`, status: 'warning' })),
            ...audit.toolSkillReview.misusedTools.map((tool) => ({ label: `misused tool: ${tool}`, status: 'error' })),
            ...audit.toolSkillReview.skillUpdates.map((entry) => ({ label: `skill: ${entry}`, status: 'suggested' })),
            ...audit.toolSkillReview.toolPolicyUpdates.map((entry) => ({ label: `tool policy: ${entry}`, status: 'suggested' })),
            ...audit.toolFailureReview.failedToolCalls.map((entry) => ({
                label: `failure: ${this.stringifySelfReflectionInline(entry.toolId || 'tool')} -> ${this.stringifySelfReflectionInline(entry.nextAction || entry.failureKind || 'review')}`,
                status: 'error',
            })),
            ...audit.toolFailureReview.noRepeatRules.map((entry) => ({ label: `no repeat: ${entry}`, status: 'warning' })),
            ...audit.learningReview.outputQualityRisks.map((entry) => ({ label: `risk: ${entry}`, status: 'warning' })),
        ].slice(0, 8);
        const flagRecommendations = audit.recommendedFlagChanges.filter((recommendation) => recommendation.flag);
        const isClearing = this.state.clearingAfterProcessAuditId === audit.auditId;

        return `
            <article class="self-reflection-item">
                <div class="self-reflection-row">
                    <div class="self-reflection-main">
                        <div class="self-reflection-title">
                            <span>${this.escapeHtml(audit.decision)} | score ${this.escapeHtml(score)}</span>
                            <em>${this.escapeHtml(this.formatDate(audit.completedAt))}</em>
                        </div>
                        <div class="self-reflection-trigger">${this.escapeHtml(audit.summary || 'No audit summary recorded.')}</div>
                    </div>
                    <code class="self-reflection-log">${this.escapeHtml(audit.model || 'model n/a')}</code>
                </div>
                <div class="self-reflection-row">
                    <div class="self-reflection-main"></div>
                    <button
                        class="btn btn-sm btn-secondary"
                        type="button"
                        data-after-process-clear-id="${this.escapeHtml(audit.auditId)}"
                        ${isClearing ? 'disabled' : ''}
                    >${isClearing ? 'Clearing...' : 'Clear review'}</button>
                </div>
                <div class="self-reflection-suggestion-meta">
                    ${audit.sessionId ? `<span>Session ${this.escapeHtml(this.truncate(audit.sessionId, 30))}</span>` : ''}
                    <span>Audit ${this.escapeHtml(this.truncate(audit.auditId, 30))}</span>
                </div>
                ${chips.length ? `
                    <div class="self-reflection-actions">
                        ${chips.map((chip) => `
                            <span class="reflection-action-chip ${this.getSelfReflectionActionClass(chip.status)}">
                                <strong>${this.escapeHtml(chip.status)}</strong>
                                ${this.escapeHtml(this.truncate(chip.label, 130))}
                            </span>
                        `).join('')}
                    </div>
                ` : ''}
                ${flagRecommendations.length ? `
                    <section class="self-reflection-suggestions" aria-label="Audit flag recommendations">
                        <div class="self-reflection-section-title">
                            <span>Flag recommendations</span>
                        </div>
                        ${flagRecommendations.map((recommendation) => {
                            const isApplying = this.state.applyingAfterProcessRecommendationId === recommendation.id;
                            const isApproved = recommendation.status === 'approved_chat_hint';
                            return `
                                <article class="self-reflection-suggestion">
                                    <div class="self-reflection-row">
                                        <div class="self-reflection-main">
                                            <div class="self-reflection-title">
                                                <span>${this.escapeHtml(recommendation.flag)}</span>
                                                <em>${this.escapeHtml(String(recommendation.currentValue))} -> ${this.escapeHtml(String(recommendation.suggestedValue))}</em>
                                            </div>
                                            <div class="self-reflection-trigger">${this.escapeHtml(recommendation.reason || 'No reason recorded.')}</div>
                                        </div>
                                        <button
                                            class="btn btn-sm btn-primary"
                                            type="button"
                                            data-after-process-recommendation-id="${this.escapeHtml(recommendation.id)}"
                                            ${recommendation.canApply && !isApplying ? '' : 'disabled'}
                                        >${isApplying ? 'Approving...' : (isApproved ? 'Approved' : (recommendation.canApply ? 'Approve hint' : 'Review only'))}</button>
                                    </div>
                                </article>
                            `;
                        }).join('')}
                    </section>
                ` : ''}
            </article>
        `;
    }

    stringifySelfReflectionInline(value = '') {
        if (value == null || value === '') {
            return '';
        }

        if (typeof value === 'string') {
            return value;
        }

        try {
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    getSelfReflectionActionClass(status = '') {
        switch (String(status || '').toLowerCase()) {
            case 'completed':
            case 'done':
            case 'success':
            case 'applied':
                return 'healthy';
            case 'running':
            case 'in_progress':
            case 'started':
                return 'info';
            case 'failed':
            case 'error':
            case 'blocked':
                return 'error';
            case 'pending':
            case 'queued':
            case 'skipped':
                return 'warning';
            default:
                return 'neutral';
        }
    }

    renderSelfReflectionUpdates(updates = [], meta = {}, errorMessage = '', suggestions = [], suggestionMeta = {}) {
        const container = document.getElementById('selfReflectionUpdates');
        const status = document.getElementById('selfReflectionStatus');
        if (!container) return;

        if (errorMessage) {
            this.setStatusBadge(status, 'error', 'Unavailable');
            container.innerHTML = `
                <div class="self-reflection-empty">
                    <strong>Unable to load updates</strong>
                    <span>${this.escapeHtml(errorMessage)}</span>
                </div>
            `;
            return;
        }

        const pendingSuggestions = (Array.isArray(suggestions) ? suggestions : [])
            .filter((suggestion) => !suggestion.applied);

        if (!updates.length && !pendingSuggestions.length) {
            this.setStatusBadge(status, 'neutral', 'No updates');
            container.innerHTML = `
                <div class="self-reflection-empty">
                    <strong>No self-reflection updates recorded</strong>
                    <span>Waiting for evaluator suggestions or the bounded self-reflection-update tool to write its first record.</span>
                </div>
            `;
            return;
        }

        const total = Number(meta.total || meta.count || updates.length);
        const suggestionTotal = Number(suggestionMeta.total || suggestionMeta.count || suggestions.length || 0);
        const generatedAt = meta.generatedAt || meta.updatedAt || meta.timestamp || '';
        this.setStatusBadge(status, pendingSuggestions.length ? 'warning' : 'info', pendingSuggestions.length ? `${pendingSuggestions.length} pending` : `${updates.length} recent`);
        const pendingSuggestionsHtml = pendingSuggestions.length
            ? `
                <section class="self-reflection-suggestions" aria-label="Pending self-reflection suggestions">
                    <div class="self-reflection-section-title">
                        <span>Pending evaluator suggestions</span>
                        <em>${this.escapeHtml(suggestionTotal.toLocaleString())} total found</em>
                    </div>
                    ${pendingSuggestions.map((suggestion) => {
                        const isApplying = this.state.applyingSelfReflectionSuggestionId === suggestion.id;
                        const actionSummary = suggestion.actions.length
                            ? suggestion.actions.slice(0, 4).map((action) => `
                                <span class="reflection-action-chip ${action.statusClass}" title="${this.escapeHtml(action.detail || action.label)}">
                                    <strong>${this.escapeHtml(action.status)}</strong>
                                    ${this.escapeHtml(action.label)}
                                </span>
                            `).join('')
                            : '<span class="reflection-action-chip neutral"><strong>none</strong> No actions proposed</span>';
                        return `
                            <article class="self-reflection-suggestion">
                                <div class="self-reflection-row">
                                    <div class="self-reflection-main">
                                        <div class="self-reflection-title">
                                            <span>${this.escapeHtml(suggestion.source)}</span>
                                            <em>${this.escapeHtml(this.formatDate(suggestion.updatedAt))}</em>
                                        </div>
                                        <div class="self-reflection-trigger">${this.escapeHtml(suggestion.trigger)}</div>
                                    </div>
                                    <button
                                        class="btn btn-sm btn-primary"
                                        type="button"
                                        data-self-reflection-suggestion-id="${this.escapeHtml(suggestion.id)}"
                                        ${suggestion.canApply && !isApplying ? '' : 'disabled'}
                                    >${isApplying ? 'Applying...' : 'Apply'}</button>
                                </div>
                                <p class="self-reflection-copy">${this.escapeHtml(this.truncate(suggestion.reflection || 'No reflection text recorded.', 220))}</p>
                                <div class="self-reflection-actions">${actionSummary}</div>
                                <div class="self-reflection-suggestion-meta">
                                    ${suggestion.feedbackId ? `<span>Feedback ${this.escapeHtml(suggestion.feedbackId)}</span>` : ''}
                                    ${suggestion.sessionId ? `<span>Session ${this.escapeHtml(this.truncate(suggestion.sessionId, 28))}</span>` : ''}
                                </div>
                            </article>
                        `;
                    }).join('')}
                </section>
            `
            : '';

        container.innerHTML = `
            <div class="self-reflection-meta">
                <span>${this.escapeHtml(total.toLocaleString())} total${generatedAt ? ` | refreshed ${this.escapeHtml(this.formatDate(generatedAt))}` : ''}</span>
            </div>
            ${pendingSuggestionsHtml}
            ${updates.map((update) => {
                const actionSummary = update.actions.length
                    ? update.actions.slice(0, 5).map((action) => `
                        <span class="reflection-action-chip ${action.statusClass}" title="${this.escapeHtml(action.detail || action.label)}">
                            <strong>${this.escapeHtml(action.status)}</strong>
                            ${this.escapeHtml(action.label)}
                        </span>
                    `).join('')
                    : '<span class="reflection-action-chip neutral"><strong>none</strong> No actions recorded</span>';
                const remainingActions = update.actions.length > 5
                    ? `<span class="reflection-action-more">+${update.actions.length - 5} more</span>`
                    : '';

                return `
                    <article class="self-reflection-item">
                        <div class="self-reflection-row">
                            <div class="self-reflection-main">
                                <div class="self-reflection-title">
                                    <span>${this.escapeHtml(update.source)}</span>
                                    <em>${this.escapeHtml(this.formatDate(update.timestamp))}</em>
                                </div>
                                <div class="self-reflection-trigger">${this.escapeHtml(update.trigger)}</div>
                            </div>
                            ${update.logPath ? `<code class="self-reflection-log">${this.escapeHtml(update.logPath)}</code>` : ''}
                        </div>
                        <p class="self-reflection-copy">${this.escapeHtml(this.truncate(update.reflection || 'No reflection text recorded.', 220))}</p>
                        <div class="self-reflection-note">
                            <span>Model-card note</span>
                            <p>${this.escapeHtml(this.truncate(update.modelCardNote || 'No model-card note recorded.', 180))}</p>
                        </div>
                        <div class="self-reflection-actions">
                            ${actionSummary}
                            ${remainingActions}
                        </div>
                    </article>
                `;
            }).join('')}
        `;
    }
    
    /**
     * Load settings
     */
    async loadSettings({ preserveDirty = true, background = false } = {}) {
        try {
            const [settingsResponse, podcastAudioResponse, storageResponse, agentCompanyResponse] = await Promise.allSettled([
                apiClient.get('/api/admin/settings'),
                apiClient.get('/api/admin/podcast-audio'),
                apiClient.get('/api/admin/storage'),
                apiClient.get('/api/admin/agent-company'),
            ]);

            if (settingsResponse.status === 'fulfilled') {
                const settings = this.unwrapApiPayload(settingsResponse.value, null);
                if (settings) {
                    this.state.settings = settings;
                    this.applySettings(settings, { preserveDirty });
                }
            } else {
                throw settingsResponse.reason;
            }

            if (podcastAudioResponse.status === 'fulfilled') {
                this.renderPodcastAudioSettings(this.unwrapApiPayload(podcastAudioResponse.value, null));
            }

            if (storageResponse.status === 'fulfilled') {
                this.renderStorageSettings(this.unwrapApiPayload(storageResponse.value, null));
            }

            if (agentCompanyResponse.status === 'fulfilled') {
                this.renderAgentCompanyStatus(this.unwrapApiPayload(agentCompanyResponse.value, null));
            }

            if (!background) {
                await this.loadAfterProcessAudits();
            }
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    async loadStorage() {
        try {
            const response = await apiClient.get('/api/admin/storage');
            this.renderStorageSettings(this.unwrapApiPayload(response, null));
            this.showToast('Storage refreshed', 'success');
        } catch (error) {
            console.error('Error loading storage:', error);
            this.showToast('Failed to load storage inventory', 'error');
        }
    }

    /**
     * Setup prompt editor
     */
    setupPromptEditor() {
        // Initialize with empty prompt
        this.updatePromptEditor('');
    }
    
    /**
     * Setup charts
     */
    setupCharts() {
        const canvas = document.getElementById('requestVolumeCanvas');
        if (!canvas) return;

        this.charts.requestVolume = {
            canvas,
            labels: [],
            values: [],
            resize: () => this.drawRequestVolumeChart(),
        };

        this.drawRequestVolumeChart();
    }
    
    /**
     * Setup WebSocket connection
     */
    async getAuthenticatedWebSocketUrl(pathname = '/ws') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socketUrl = `${protocol}//${window.location.host}${pathname}`;

        try {
            const response = await fetch('/api/auth/ws-token', {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                cache: 'no-store',
            });

            if (!response.ok) {
                return socketUrl;
            }

            const data = await response.json().catch(() => ({}));
            const token = String(data?.token || '').trim();
            if (!token) {
                return socketUrl;
            }

            const url = new URL(socketUrl);
            url.searchParams.set('access_token', token);
            return url.toString();
        } catch (_error) {
            return socketUrl;
        }
    }

    async setupWebSocket() {
        try {
            this.ws = new WebSocket(await this.getAuthenticatedWebSocketUrl('/ws'));

            this.ws.addEventListener('open', () => {
                this.updateConnectionStatus(true);
                this.ws.send(JSON.stringify({ type: 'admin_subscribe' }));
            });

            this.ws.addEventListener('message', (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleWebSocketMessage(data);
                } catch (error) {
                    console.warn('Failed to parse admin websocket message:', error);
                }
            });

            this.ws.addEventListener('close', () => {
                this.updateConnectionStatus(false);
                this.scheduleReconnect();
            });

            this.ws.addEventListener('error', () => {
                this.updateConnectionStatus(false);
            });
        } catch (error) {
            console.warn('Admin websocket unavailable, falling back to polling:', error);
        }
    }
    
    /**
     * Handle WebSocket messages
     */
    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'admin_connected':
                this.updateConnectionStatus(true);
                break;
            case 'log_event':
            case 'log':
                if (this.state.currentView === 'logs' && !this.state.logsPaused) {
                    this.loadLogs();
                }
                break;
            case 'stats_update':
            case 'stats':
                this.loadStats();
                break;
            case 'task_event':
            case 'trace':
                if (this.state.currentView === 'traces') {
                    this.loadTraces();
                }
                break;
            case 'workload_queued':
            case 'workload_started':
            case 'workload_completed':
            case 'workload_failed':
            case 'workload_updated':
                if (this.state.workloadsSupported !== false) {
                    this.loadWorkloads();
                }
                if (data.type === 'workload_failed') {
                    const title = data?.data?.workload?.title || data?.data?.workloadId || 'workload';
                    this.showToast(`Deferred job failed: ${title}`, 'error');
                }
                break;
        }
    }
    
    /**
     * Schedule WebSocket reconnect
     */
    scheduleReconnect() {
        if (this.reconnectInterval) return;
        
        this.reconnectInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.CLOSED) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
                this.setupWebSocket();
            }
        }, 5000);
    }
    
    /**
     * Start polling for updates
     */
    startPolling() {
        // Poll stats every 30 seconds
        this.refreshInterval = setInterval(async () => {
            await this.loadStats();
            await this.loadSystemHealth();
            await this.loadRecentActivity();
            await this.loadModelUsage();
            if (this.state.currentView === 'overview' && this.state.selfReflectionSupported !== false) {
                await this.loadSelfReflectionUpdates();
            }
            if (this.state.currentView === 'settings' && this.state.afterProcessAuditSupported !== false) {
                await this.loadAfterProcessAudits();
            }
            if (this.state.currentView === 'settings') {
                await this.loadSettings({ preserveDirty: true, background: true });
            }
            if (this.state.currentView === 'prompts') {
                await this.loadPrompts({ preserveEditor: true });
            }
            if (this.state.currentView === 'skills') {
                await this.loadSkills();
            }
            
            if (this.state.currentView === 'logs' && !this.state.logsPaused) {
                await this.loadLogs();
            }
            if (this.state.currentView === 'workloads' && this.state.workloadsSupported !== false) {
                await this.loadWorkloads();
            }
        }, 30000);
    }
    
    // ==================== UI RENDERING ====================
    
    /**
     * Render models
     */
    renderModels(models) {
        const container = document.getElementById('modelsGrid');
        if (!container) return;

        if (!models.length) {
            container.innerHTML = `
                <div class="model-card">
                    <div class="model-card-header">
                        <div>
                            <span class="model-name">No model data yet</span>
                            <span class="model-provider">live inventory and runtime usage</span>
                        </div>
                    </div>
                    <div class="model-stats">
                        <div class="model-stat">
                            <span class="model-stat-value">0</span>
                            <span class="model-stat-label">Models</span>
                        </div>
                        <div class="model-stat">
                            <span class="model-stat-value">Live</span>
                            <span class="model-stat-label">Source</span>
                        </div>
                    </div>
                </div>
            `;
            return;
        }
        
        container.innerHTML = models.map(model => `
            <div class="model-card">
                <div class="model-card-header">
                    <div>
                        <span class="model-name">${model.name}</span>
                        <span class="model-provider">${model.provider}</span>
                    </div>
                    <span class="model-status ${model.active ? '' : 'inactive'}"></span>
                </div>
                <div class="model-stats">
                    <div class="model-stat">
                        <span class="model-stat-value">${model.requests?.toLocaleString() || 0}</span>
                        <span class="model-stat-label">Requests</span>
                    </div>
                    <div class="model-stat">
                        <span class="model-stat-value">${model.avgLatency || 0}ms</span>
                        <span class="model-stat-label">Avg Latency</span>
                    </div>
                    <div class="model-stat">
                        <span class="model-stat-value">${Number(model.totalTokens || 0).toLocaleString()}</span>
                        <span class="model-stat-label">Tokens</span>
                    </div>
                </div>
                <div class="model-capabilities">
                    ${(model.capabilities || []).map(cap => `
                        <span class="capability-tag">${cap}</span>
                    `).join('')}
                </div>
                <div class="model-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="dashboard.editModel('${model.id}')">Edit</button>
                    <button class="btn btn-sm btn-ghost" onclick="dashboard.testModel('${model.id}')">Test</button>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * Render prompt list
     */
    renderPromptList(prompts) {
        const container = document.getElementById('promptList');
        if (!container) return;

        if (!prompts.length) {
            container.innerHTML = '<p class="empty-state">No live runtime prompt slots were returned.</p>';
            return;
        }
        
        container.innerHTML = prompts.map(prompt => `
            <div class="prompt-item ${this.state.selectedPrompt?.id === prompt.id ? 'active' : ''}" 
                 data-id="${this.escapeHtml(prompt.id)}"
                 data-dashboard-list-action="prompt"
                 role="button"
                 tabindex="0"
                 aria-selected="${this.state.selectedPrompt?.id === prompt.id ? 'true' : 'false'}"
                 onclick="dashboard.selectPromptById(this.dataset.id)"
                 onkeydown="dashboard.handleListItemKeydown(event)">
                <span class="prompt-item-name">${this.escapeHtml(prompt.name)}</span>
                <span class="prompt-item-meta">${this.escapeHtml(this.formatPromptSurfaceMeta(prompt))}</span>
            </div>
        `).join('');
    }

    formatPromptSurfaceMeta(prompt = {}) {
        const assignment = prompt.assignment || prompt.category || 'runtime slot';
        if (prompt.inventoryOnly) {
            return `${assignment} | request-time inventory`;
        }
        if (prompt.dynamic && prompt.source) {
            return `${assignment} | ${prompt.source === 'default' ? 'default template' : 'live file'}`;
        }
        return assignment;
    }
    
    /**
     * Render skills
     */
    renderSkills(skills) {
        const container = document.getElementById('skillsGrid');
        if (!container) return;

        if (!skills.length) {
            container.innerHTML = '<div class="empty-state">No tools match the current filters.</div>';
            return;
        }

        container.innerHTML = skills.map((tool) => `
            <div class="skill-card tool-card ${this.state.selectedToolId === tool.id ? 'selected' : ''}">
                <div class="skill-header">
                    <div class="skill-icon">
                        ${this.getToolCategoryIcon(tool.category)}
                    </div>
                    <div class="skill-info">
                        <span class="skill-name">${this.escapeHtml(tool.name)}</span>
                        <span class="skill-category">${this.escapeHtml(tool.id)} - ${this.escapeHtml(tool.category)}</span>
                    </div>
                    <span class="skill-status ${tool.enabled === false ? 'disabled' : ''} ${tool.enabled === null ? 'unknown' : ''}"></span>
                </div>
                <div class="tool-badges">
                    <span class="support-badge ${this.escapeHtml(tool.support)}">${this.escapeHtml(this.formatSupportLabel(tool.support))}</span>
                    <span class="tool-chip">${tool.docAvailable ? 'Docs available' : 'No docs'}</span>
                    <span class="tool-chip">${tool.enabled === null ? 'Registry only' : (tool.enabled ? 'Skill enabled' : 'Skill disabled')}</span>
                </div>
                <p class="skill-description">${this.escapeHtml(tool.description)}</p>
                <div class="skill-footer">
                    <div class="skill-stats">
                        <span class="skill-stat"><strong>${tool.usageCount || 0}</strong> uses</span>
                        <span class="skill-stat"><strong>${tool.successRate || 0}%</strong> success</span>
                        <span class="skill-stat"><strong>${tool.avgDuration || 0}ms</strong> avg</span>
                    </div>
                    <div class="skill-actions">
                        <button class="btn btn-sm btn-ghost" onclick="dashboard.selectTool('${tool.id}')">Details</button>
                        ${tool.docAvailable ? `<button class="btn btn-sm btn-ghost" onclick="dashboard.loadToolDocumentation('${tool.id}')">Docs</button>` : ''}
                        ${tool.enabled === null
                            ? ''
                            : `<button class="btn btn-sm btn-secondary" onclick="dashboard.toggleSkill('${tool.id}')">${tool.enabled ? 'Disable' : 'Enable'}</button>`}
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * Render logs
     */
    renderLogs(logs) {
        const tbody = document.getElementById('logsTableBody');
        if (!tbody) return;
        
        tbody.innerHTML = logs.map(log => `
            <tr onclick="dashboard.showLogDetails('${log.id}')">
                <td class="col-time">${this.formatTime(log.timestamp)}</td>
                <td class="col-level">
                    <span class="log-level ${log.level}">${log.level}</span>
                </td>
                <td class="col-model">${log.model}</td>
                <td class="col-prompt">${this.truncate(log.prompt, 40)}</td>
                <td class="col-tokens">${log.tokens?.toLocaleString() || '-'}</td>
                <td class="col-latency">${log.latency}ms</td>
                <td class="col-status">
                    <span class="status-badge ${log.status === 'success' ? 'healthy' : 'error'}">
                        ${log.status}
                    </span>
                </td>
                <td class="col-actions">
                    <button class="btn btn-sm btn-icon" onclick="event.stopPropagation(); dashboard.showLogDetails('${log.id}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1"/>
                            <circle cx="19" cy="12" r="1"/>
                            <circle cx="5" cy="12" r="1"/>
                        </svg>
                    </button>
                </td>
            </tr>
        `).join('');
    }
    
    /**
     * Render traces
     */
    renderTraces(traces) {
        const container = document.getElementById('tracesList');
        if (!container) return;
        
        container.innerHTML = traces.map(trace => `
            <div class="trace-item ${this.state.selectedTrace?.id === trace.id ? 'active' : ''}"
                 data-id="${this.escapeHtml(trace.id)}"
                 data-dashboard-list-action="trace"
                 role="button"
                 tabindex="0"
                 aria-selected="${this.state.selectedTrace?.id === trace.id ? 'true' : 'false'}"
                 onclick="dashboard.selectTrace(this.dataset.id)"
                 onkeydown="dashboard.handleListItemKeydown(event)">
                <div class="trace-header">
                    <span class="trace-name">${trace.name}</span>
                    <span class="trace-status ${trace.status}"></span>
                </div>
                <div class="trace-meta">
                    ${this.formatDate(trace.startedAt)} • ${trace.duration}ms • ${trace.steps} steps
                </div>
            </div>
        `).join('');
        
        if (traces.length > 0 && !this.state.selectedTrace) {
            this.selectTrace(traces[0].id);
        }
    }

    renderWorkloadSummary(workloads = [], runs = []) {
        const counts = runs.reduce((summary, run) => {
            if (run.status === 'queued') summary.queued += 1;
            if (run.status === 'running') summary.running += 1;
            if (run.status === 'failed') summary.failed += 1;
            return summary;
        }, { queued: 0, running: 0, failed: 0 });

        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element) {
                element.textContent = String(value);
            }
        };

        setText('workloadTotalCount', workloads.length);
        setText('workloadQueuedCount', counts.queued);
        setText('workloadRunningCount', counts.running);
        setText('workloadFailedCount', counts.failed);
        setText('workloadsBadge', counts.running + counts.queued);
    }

    renderAdminWorkloads(workloads = [], emptyMessage = 'No deferred workloads are persisted yet.') {
        const tbody = document.getElementById('adminWorkloadsTableBody');
        if (!tbody) return;

        if (!workloads.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="empty-state">${this.escapeHtml(emptyMessage)}</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = workloads.map((workload) => `
            <tr>
                <td>
                    <div>${this.escapeHtml(workload.title)}</div>
                    <div class="workload-trigger">${this.escapeHtml(this.truncate(workload.prompt || '', 72))}</div>
                </td>
                <td>${this.escapeHtml(workload.sessionId)}</td>
                <td><span class="workload-trigger">${this.escapeHtml(this.describeAdminTrigger(workload.trigger))}</span></td>
                <td><span class="status-badge ${workload.enabled ? 'healthy' : 'warning'}">${workload.enabled ? 'active' : 'paused'}</span></td>
                <td class="col-tokens">${Number(workload.workloadSummary?.queued || 0)}</td>
                <td class="col-tokens">${Number(workload.workloadSummary?.running || 0)}</td>
                <td class="col-tokens">${Number(workload.workloadSummary?.failed || 0)}</td>
                <td>
                    <div class="workload-row-actions">
                        ${workload.enabled
                            ? `<button class="btn btn-sm btn-secondary" onclick="dashboard.pauseAdminWorkload(event, '${workload.id}')">Pause</button>`
                            : `<button class="btn btn-sm btn-ghost" onclick="dashboard.resumeAdminWorkload(event, '${workload.id}')">Resume</button>`}
                        <button class="btn btn-sm btn-secondary" onclick="dashboard.openAdminWorkloadModal(event, '${workload.id}')">Edit</button>
                        <button class="btn btn-sm btn-danger" onclick="dashboard.deleteAdminWorkload(event, '${workload.id}')">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    renderAdminRuns(runs = [], emptyMessage = 'No workload runs have been recorded yet.') {
        const tbody = document.getElementById('adminRunsTableBody');
        if (!tbody) return;

        if (!runs.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="empty-state">${this.escapeHtml(emptyMessage)}</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = runs.map((run) => `
            <tr class="workload-run-row ${this.state.selectedRun?.id === run.id ? 'selected' : ''}"
                data-id="${this.escapeHtml(run.id)}"
                data-dashboard-list-action="admin-run"
                role="button"
                tabindex="0"
                aria-selected="${this.state.selectedRun?.id === run.id ? 'true' : 'false'}"
                onclick="dashboard.selectAdminRun(this.dataset.id, { source: 'table' })"
                onkeydown="dashboard.handleListItemKeydown(event)">
                <td>${this.escapeHtml(run.id)}</td>
                <td>${this.escapeHtml(run.workloadTitle || run.workloadId)}</td>
                <td><span class="status-badge ${this.getRunStatusClass(run.status)}">${this.escapeHtml(run.status)}</span></td>
                <td>${this.escapeHtml(run.reason || 'manual')}</td>
                <td>${this.escapeHtml(this.formatDate(run.scheduledFor))}</td>
                <td>${this.escapeHtml(this.formatDate(run.startedAt))}</td>
                <td>${this.escapeHtml(this.formatDate(run.finishedAt))}</td>
                <td class="workload-run-export-cell">
                    <button
                        class="btn btn-secondary btn-sm"
                        onclick="dashboard.downloadAdminRunTraceJson(event, '${run.id}')"
                        title="Download this run trace as JSON"
                    >
                        JSON
                    </button>
                </td>
            </tr>
        `).join('');
    }

    renderAdminRunDetails(run = null, error = null, emptyMessage = 'Select a run to inspect lifecycle details.') {
        const containers = ['adminRunDetails', 'companyRunDetails']
            .map((id) => document.getElementById(id))
            .filter(Boolean);
        if (!containers.length) return;

        const setContainers = (html) => {
            containers.forEach((container) => {
                container.innerHTML = html;
            });
        };

        if (error) {
            setContainers(`<p class="empty-state">Failed to load run details: ${this.escapeHtml(error.message || 'unknown error')}</p>`);
            return;
        }

        if (!run) {
            setContainers(`<p class="empty-state">${this.escapeHtml(emptyMessage)}</p>`);
            return;
        }

        const metadata = this.stringifyAdminPayload(run.metadata);
        const errorPayload = this.stringifyAdminPayload(run.error);
        const tracePayload = this.stringifyAdminPayload(run.trace);
        const actionContext = this.state.companyActionRunId === run.id ? this.state.companyActionContext : null;
        const actionContextSource = actionContext?.contextSource === 'saved-history'
            ? 'Saved history'
            : (actionContext?.contextSource === 'live' ? 'Live queue' : '');
        const actionSnapshotLabel = actionContext?.contextSource === 'saved-history' && actionContext?.snapshotAt
            ? `Saved ${this.formatDate(actionContext.snapshotAt)}`
            : '';
        const actionContextHtml = actionContext
            ? `
            <div class="workload-action-context">
                <div class="workload-action-context__header">
                    <strong>${this.escapeHtml(actionContext.label || 'Opened from CEO action queue')}</strong>
                    ${actionContextSource ? `<span class="workload-action-source">${this.escapeHtml(actionContextSource)}</span>` : ''}
                </div>
                ${actionSnapshotLabel ? `<span class="workload-action-snapshot">${this.escapeHtml(actionSnapshotLabel)}</span>` : ''}
                <span>${this.escapeHtml(actionContext.detail || "Review this run's output evidence before continuing or packaging company work.")}</span>
                ${actionContext.outputPreview ? `<div class="workload-action-preview">${this.escapeHtml(actionContext.outputPreview)}</div>` : ''}
            </div>`
            : '';

        setContainers(`
            ${actionContextHtml}
            <div>
                <div class="workload-detail-title">${this.escapeHtml(run.workloadTitle || run.workloadId)}</div>
                <div class="workload-detail-subtitle">${this.escapeHtml(run.id)} | ${this.escapeHtml(run.reason || 'manual')} | ${this.escapeHtml(this.formatRunStageLabel(run.stageIndex))}</div>
            </div>
            <div class="workload-detail-grid">
                <div class="workload-detail-item">
                    <span class="workload-detail-label">Status</span>
                    <span class="workload-detail-value"><span class="status-badge ${this.getRunStatusClass(run.status)}">${this.escapeHtml(run.status)}</span></span>
                </div>
                <div class="workload-detail-item">
                    <span class="workload-detail-label">Session</span>
                    <span class="workload-detail-value">${this.escapeHtml(run.sessionId || '-')}</span>
                </div>
                <div class="workload-detail-item">
                    <span class="workload-detail-label">Scheduled</span>
                    <span class="workload-detail-value">${this.escapeHtml(this.formatDate(run.scheduledFor))}</span>
                </div>
                <div class="workload-detail-item">
                    <span class="workload-detail-label">Started</span>
                    <span class="workload-detail-value">${this.escapeHtml(this.formatDate(run.startedAt))}</span>
                </div>
                <div class="workload-detail-item">
                    <span class="workload-detail-label">Finished</span>
                    <span class="workload-detail-value">${this.escapeHtml(this.formatDate(run.finishedAt))}</span>
                </div>
                <div class="workload-detail-item">
                    <span class="workload-detail-label">Response ID</span>
                    <span class="workload-detail-value">${this.escapeHtml(run.responseId || '-')}</span>
                </div>
            </div>
            <div class="workload-detail-block">
                <h4>Prompt</h4>
                <div class="workload-detail-code workload-detail-code--prompt">${this.escapeHtml(run.prompt || '')}</div>
            </div>
            <div class="workload-detail-block">
                <h4>Metadata</h4>
                <div class="workload-detail-code workload-detail-code--json">${this.escapeHtml(metadata)}</div>
            </div>
            <div class="workload-detail-block">
                <h4>Error</h4>
                <div class="workload-detail-code workload-detail-code--json">${this.escapeHtml(errorPayload)}</div>
            </div>
            <div class="workload-detail-block">
                <div class="workload-detail-block__header">
                    <h4>Trace</h4>
                    <button
                        class="btn btn-secondary btn-sm"
                        onclick="dashboard.downloadAdminRunTraceJson(event, '${run.id}')"
                        title="Download this run trace as JSON"
                    >
                        Download trace JSON
                    </button>
                </div>
                <div class="workload-detail-code workload-detail-code--json">${this.escapeHtml(tracePayload)}</div>
            </div>
        `);
    }

    renderAgentCompanyDashboard() {
        const status = this.state.agentCompanyStatus || null;
        const state = status?.state || {};
        const config = status?.config || this.state.settings?.agentCompany || {};
        const heartbeat = state.heartbeat || {};
        const runningWork = state.runningWork || {};
        const dailyAlignment = state.dailyAlignment || {};
        const workspace = this.state.agentCompanyWorkspace || {};
        const deliverables = Array.isArray(workspace.deliverables) ? workspace.deliverables : [];
        const actionQueue = Array.isArray(workspace.actionQueue) ? workspace.actionQueue : [];
        const actionHistory = Array.isArray(workspace.actionHistory) ? workspace.actionHistory : [];
        const allCompanyWorkloads = this.getAgentCompanyWorkloads(this.state.workloads, status);
        const allCompanyRuns = this.getAgentCompanyRuns(this.state.runs, allCompanyWorkloads, status);
        this.syncCompanyRoleFilterOptions(state.roles || config.roles || [], allCompanyWorkloads);
        const companyWorkloads = this.getFilteredCompanyWorkloads(allCompanyWorkloads, allCompanyRuns);
        const companyRuns = this.getFilteredCompanyRuns(allCompanyRuns, allCompanyWorkloads);

        this.setTextContent('agentCompanyGoalSummary', config.companyGoal || state.companyGoal || 'No company goal configured yet.');
        this.setTextContent('companyHeartbeatStatus', heartbeat.status || (status?.available ? 'ready' : 'standby'));
        this.setTextContent('companyNextHeartbeat', heartbeat.nextAt ? `next ${this.formatDate(heartbeat.nextAt)}` : 'not scheduled');
        this.setTextContent('companyRunningCount', Number(runningWork.running ?? this.countRunsByStatus(allCompanyRuns, 'running')));
        this.setTextContent('companyQueuedCount', `${Number(runningWork.queued ?? this.countRunsByStatus(allCompanyRuns, 'queued'))} queued`);
        this.setTextContent('companyWorkloadCount', Number(runningWork.companyWorkloads ?? allCompanyWorkloads.length));
        this.setTextContent('companyWeeklyLimit', `${Number(config.weeklyWorkloadLimit || 0)} weekly slots`);
        this.setTextContent('companyFailedCount', Number(heartbeat.failedWorkloads ?? this.countRunsByStatus(allCompanyRuns, 'failed')));
        this.setTextContent('companyAlignmentStatus', `alignment ${dailyAlignment.status || 'idle'}`);
        this.setTextContent('agentCompanyBadge', allCompanyRuns.filter((run) => ['queued', 'running'].includes(run.status)).length);
        this.setTextContent('companyScheduleStatus', `${(state.shortTermSchedule || []).length} planned`);
        this.setTextContent('companyRunStatus', this.isCompanyWorkFiltered()
            ? `${companyRuns.length} of ${allCompanyRuns.length} runs`
            : `${companyRuns.length} run${companyRuns.length === 1 ? '' : 's'}`);
        this.setTextContent('companyAlignmentNext', dailyAlignment.nextAt ? `next ${this.formatDate(dailyAlignment.nextAt)}` : 'not scheduled');
        const workspaceWorkloadCount = Number(workspace.workspace?.workloadCount ?? allCompanyWorkloads.length);
        this.setTextContent('companyWorkspaceStatus', workspace.workspace?.workloadAvailable === false
            ? 'workloads offline'
            : `${workspaceWorkloadCount} workstream${workspaceWorkloadCount === 1 ? '' : 's'}`);
        this.setTextContent('companyDeliverableStatus', `${deliverables.length} file${deliverables.length === 1 ? '' : 's'}`);
        this.setInputValue('companyCeoDirection', config.companyGoal || state.companyGoal || '', { preserveDirty: true });

        const modelPolicy = [config.primaryModel || state.modelPolicy?.primaryModel || 'default model']
            .concat(config.escalationModels || state.modelPolicy?.escalationModels || [])
            .filter(Boolean)
            .join(' -> ');
        this.setTextContent('companyModelPolicy', modelPolicy || 'Default model');

        this.renderCompanyRoles(state.roles || config.roles || [], allCompanyWorkloads, allCompanyRuns);
        this.renderCompanySchedule(state.shortTermSchedule || []);
        this.renderCompanyWorkloads(companyWorkloads);
        this.renderCompanyRuns(companyRuns);
        this.renderCompanyAlignment(dailyAlignment);
        this.renderCompanyActionQueue(actionQueue);
        this.renderCompanyActionHistory(actionHistory);
        this.renderCompanyDeliverables(deliverables);
        this.renderCompanyImprovementLoop(workspace.improvementLoop || null);
        this.renderCompanySharedWhiteboard(workspace.sharedWhiteboard || null);

        if (this.state.selectedRun?.id && !allCompanyRuns.some((run) => run.id === this.state.selectedRun.id)) {
            this.renderAdminRunDetails(null, null, 'Select a company run to inspect its output.');
        }
    }

    setTextContent(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = String(value ?? '');
        }
    }

    countRunsByStatus(runs = [], status = '') {
        return runs.filter((run) => run.status === status).length;
    }

    getAgentCompanyMetadata(entry = {}) {
        return entry?.metadata?.agentCompany
            || entry?.workload?.metadata?.agentCompany
            || {};
    }

    isAgentCompanyEntry(entry = {}, status = this.state.agentCompanyStatus) {
        const metadata = this.getAgentCompanyMetadata(entry);
        const companyHash = status?.state?.companyGoalHash || status?.config?.companyGoalHash || '';
        return metadata.enabled === true
            || metadata.heartbeatManaged === true
            || Boolean(metadata.planItemId)
            || (companyHash && metadata.companyGoalHash === companyHash)
            || entry.sessionId === (status?.config?.sessionId || 'agent-company');
    }

    getAgentCompanyWorkloads(workloads = [], status = this.state.agentCompanyStatus) {
        return (Array.isArray(workloads) ? workloads : [])
            .filter((workload) => this.isAgentCompanyEntry(workload, status));
    }

    getAgentCompanyRuns(runs = [], workloads = this.getAgentCompanyWorkloads(), status = this.state.agentCompanyStatus) {
        const workloadIds = new Set((workloads || []).map((workload) => workload.id).filter(Boolean));
        return (Array.isArray(runs) ? runs : [])
            .filter((run) => workloadIds.has(run.workloadId) || this.isAgentCompanyEntry(run, status));
    }

    isCompanyWorkFiltered() {
        return Boolean(String(this.state.companyWorkSearch || '').trim())
            || (this.state.companyWorkStatusFilter || 'all') !== 'all'
            || (this.state.companyRoleFilter || 'all') !== 'all';
    }

    normalizeCompanyFilterValue(value = '') {
        return String(value || '').trim().toLowerCase();
    }

    getCompanyRoleLabel(role = {}) {
        return role.name || role.id || role.roleName || role.roleId || 'Company Agent';
    }

    getCompanyRoleKeyFromMetadata(metadata = {}) {
        return this.normalizeCompanyFilterValue(metadata.roleId || metadata.roleName || '');
    }

    getCompanyRoleKeys(role = {}) {
        return new Set([
            role.id,
            role.name,
            role.roleId,
            role.roleName,
        ].map((value) => this.normalizeCompanyFilterValue(value)).filter(Boolean));
    }

    getCompanyWorkloadRoleKey(workload = {}) {
        return this.getCompanyRoleKeyFromMetadata(this.getAgentCompanyMetadata(workload));
    }

    syncCompanyRoleFilterOptions(roles = [], workloads = []) {
        const select = document.getElementById('companyRoleFilter');
        if (!select) return;

        const options = new Map();
        const aliases = new Map();
        roles.forEach((role) => {
            const key = this.normalizeCompanyFilterValue(role.id || role.name);
            if (key && !options.has(key)) {
                options.set(key, this.getCompanyRoleLabel(role));
            }
            if (key) {
                aliases.set(key, this.getCompanyRoleKeys(role));
            }
        });

        workloads.forEach((workload) => {
            const metadata = this.getAgentCompanyMetadata(workload);
            const metadataAliases = new Set([
                metadata.roleId,
                metadata.roleName,
            ].map((value) => this.normalizeCompanyFilterValue(value)).filter(Boolean));
            let key = this.getCompanyRoleKeyFromMetadata(metadata);
            for (const [candidateKey, candidateAliases] of aliases.entries()) {
                if (Array.from(metadataAliases).some((alias) => candidateAliases.has(alias))) {
                    key = candidateKey;
                    metadataAliases.forEach((alias) => candidateAliases.add(alias));
                    break;
                }
            }

            const label = metadata.roleName || metadata.roleId || key;
            if (key && !options.has(key)) {
                options.set(key, label);
            }
            if (key && !aliases.has(key)) {
                aliases.set(key, metadataAliases);
            }
        });

        const current = options.has(this.state.companyRoleFilter) ? this.state.companyRoleFilter : 'all';
        this.state.companyRoleFilter = current;
        this.companyRoleFilterAliases = aliases;
        select.innerHTML = '<option value="all">All roles</option>' + Array.from(options.entries())
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([value, label]) => `<option value="${this.escapeHtml(value)}">${this.escapeHtml(label)}</option>`)
            .join('');
        select.value = current;
    }

    matchesCompanyRoleFilter(roleKey = '') {
        const selectedRole = this.state.companyRoleFilter || 'all';
        if (selectedRole === 'all') return true;
        const aliases = this.companyRoleFilterAliases.get(selectedRole) || new Set([selectedRole]);
        return aliases.has(this.normalizeCompanyFilterValue(roleKey));
    }

    matchesCompanySearch(parts = [], search = '') {
        const query = this.normalizeCompanyFilterValue(search);
        if (!query) return true;
        return parts.some((part) => this.normalizeCompanyFilterValue(part).includes(query));
    }

    getFilteredCompanyWorkloads(workloads = [], runs = []) {
        const search = this.state.companyWorkSearch || '';
        const status = this.state.companyWorkStatusFilter || 'all';
        const role = this.state.companyRoleFilter || 'all';
        const runsByWorkload = new Map();
        runs.forEach((run) => {
            const list = runsByWorkload.get(run.workloadId) || [];
            list.push(run);
            runsByWorkload.set(run.workloadId, list);
        });

        return (workloads || []).filter((workload) => {
            const metadata = this.getAgentCompanyMetadata(workload);
            const workloadRole = this.getCompanyWorkloadRoleKey(workload);
            const relatedRuns = runsByWorkload.get(workload.id) || [];
            const summary = workload.workloadSummary || {};
            const matchesRole = role === 'all' || this.matchesCompanyRoleFilter(workloadRole);
            const matchesSearch = this.matchesCompanySearch([
                workload.id,
                workload.title,
                workload.prompt,
                metadata.roleName,
                metadata.roleId,
                ...relatedRuns.flatMap((run) => [run.id, run.status, run.reason]),
            ], search);
            const matchesStatus = status === 'all'
                || (status === 'active' && workload.enabled !== false)
                || (status === 'paused' && workload.enabled === false)
                || Number(summary[status] || 0) > 0
                || relatedRuns.some((run) => run.status === status);

            return matchesRole && matchesSearch && matchesStatus;
        });
    }

    getFilteredCompanyRuns(runs = [], workloads = []) {
        const search = this.state.companyWorkSearch || '';
        const status = this.state.companyWorkStatusFilter || 'all';
        const role = this.state.companyRoleFilter || 'all';
        const workloadsById = new Map((workloads || []).map((workload) => [workload.id, workload]));

        return (runs || []).filter((run) => {
            const workload = workloadsById.get(run.workloadId) || {};
            const runMetadata = this.getAgentCompanyMetadata(run);
            const workloadMetadata = this.getAgentCompanyMetadata(workload);
            const metadata = Object.keys(runMetadata).length ? runMetadata : workloadMetadata;
            const runRole = this.getCompanyRoleKeyFromMetadata(metadata) || this.getCompanyWorkloadRoleKey(workload);
            const matchesRole = role === 'all' || this.matchesCompanyRoleFilter(runRole);
            const matchesSearch = this.matchesCompanySearch([
                run.id,
                run.workloadId,
                run.workloadTitle,
                run.status,
                run.reason,
                metadata.roleName,
                metadata.roleId,
            ], search);
            const matchesStatus = status === 'all'
                || run.status === status
                || (status === 'active' && workload.enabled !== false)
                || (status === 'paused' && workload.enabled === false);

            return matchesRole && matchesSearch && matchesStatus;
        });
    }

    getCompanyRoleActivity(role = {}, workloads = [], runs = []) {
        const roleKeys = this.getCompanyRoleKeys(role);
        const roleWorkloads = (workloads || []).filter((workload) => roleKeys.has(this.getCompanyWorkloadRoleKey(workload)));
        const workloadIds = new Set(roleWorkloads.map((workload) => workload.id).filter(Boolean));
        const roleRuns = (runs || []).filter((run) => {
            const metadata = this.getAgentCompanyMetadata(run);
            return workloadIds.has(run.workloadId) || roleKeys.has(this.getCompanyRoleKeyFromMetadata(metadata));
        });

        return {
            workloads: roleWorkloads.length,
            queued: roleRuns.filter((run) => run.status === 'queued').length,
            running: roleRuns.filter((run) => run.status === 'running').length,
            failed: roleRuns.filter((run) => run.status === 'failed').length,
        };
    }

    renderCompanyRoles(roles = [], workloads = [], runs = []) {
        const container = document.getElementById('companyRoleList');
        if (!container) return;

        if (!roles.length) {
            container.innerHTML = '<p class="empty-state">No company roles loaded yet.</p>';
            return;
        }

        container.innerHTML = roles.map((role) => `
            <div class="company-role-item">
                <div>
                    <strong>${this.escapeHtml(role.name || role.id || 'Company Agent')}</strong>
                    <span>${this.escapeHtml(role.mission || 'No mission recorded.')}</span>
                    <div class="company-role-metrics">
                        ${(() => {
                            const activity = this.getCompanyRoleActivity(role, workloads, runs);
                            return `
                                <span>${activity.workloads} work</span>
                                <span>${activity.running} running</span>
                                <span>${activity.queued} queued</span>
                                <span>${activity.failed} failed</span>
                            `;
                        })()}
                    </div>
                </div>
                <span class="company-role-id">${this.escapeHtml(role.id || 'agent')}</span>
            </div>
        `).join('');
    }

    renderCompanySchedule(schedule = []) {
        const container = document.getElementById('companyScheduleList');
        if (!container) return;

        if (!schedule.length) {
            container.innerHTML = '<p class="empty-state">No scheduled company work loaded yet.</p>';
            return;
        }

        container.innerHTML = schedule.map((item) => `
            <div class="company-schedule-item">
                <div>
                    <strong>${this.escapeHtml(item.title || 'Company work')}</strong>
                    <span>${this.escapeHtml(item.objective || '')}</span>
                </div>
                <div class="company-schedule-meta">
                    <span>${this.escapeHtml(item.roleName || item.roleId || 'agent')}</span>
                    <span>${this.escapeHtml(this.formatDate(item.plannedFor))}</span>
                </div>
            </div>
        `).join('');
    }

    renderCompanyActionQueue(actions = []) {
        const container = document.getElementById('companyActionQueue');
        if (!container) return;

        this.state.companyActionContexts = {};
        this.state.companyActionContextsById = {};

        if (!actions.length) {
            container.innerHTML = '<p class="empty-state">No CEO actions are waiting right now.</p>';
            return;
        }

        container.innerHTML = actions.map((action, index) => {
            const actionId = String(action.id || `company-action-${index}`);
            const actionKey = String(action.actionKey || actionId);
            const actionHandler = this.formatCompanyActionHandler(action.target || '', action.runId || '', actionKey);
            const refreshHandler = action.refreshStatus?.runId
                ? this.formatCompanyActionHandler('runs', action.refreshStatus.runId, actionKey)
                : '';
            if (action.runId) {
                const actionContext = this.buildCompanyActionContext(action, action.runId);
                this.state.companyActionContexts[action.runId] = actionContext;
                this.state.companyActionContextsById[actionKey] = actionContext;
            }
            if (action.refreshStatus?.runId) {
                const refreshActionContext = this.buildCompanyActionContext(action, action.refreshStatus.runId);
                this.state.companyActionContexts[action.refreshStatus.runId] = refreshActionContext;
                this.state.companyActionContextsById[actionKey] = refreshActionContext;
            }

            return `
            <div class="company-action-item company-action-item--${this.escapeHtml(action.priority || 'low')}" data-action-id="${this.escapeHtml(actionKey)}">
                <div>
                    <strong>${this.escapeHtml(action.label || 'Company action')}</strong>
                    <span>${this.escapeHtml(action.detail || '')}</span>
                    ${action.outputPreview ? `<div class="company-action-preview">${this.escapeHtml(action.outputPreview)}</div>` : ''}
                    ${action.refreshStatus ? `
                        <div class="company-action-status">
                            <span>Latest repair</span>
                            <strong>${this.escapeHtml(action.refreshStatus.runStatus || action.refreshStatus.status || 'scheduled')}</strong>
                            ${action.refreshStatus.title ? `<small>${this.escapeHtml(action.refreshStatus.title)}</small>` : ''}
                            ${action.refreshStatus.runId ? `
                                <button
                                    class="btn btn-sm btn-ghost company-action-status__review"
                                    type="button"
                                    onclick="${refreshHandler}"
                                >
                                    Review repair
                                </button>
                            ` : ''}
                        </div>
                    ` : ''}
                </div>
                <button
                    class="btn btn-sm btn-secondary"
                    type="button"
                    onclick="${actionHandler}"
                >
                    Open
                </button>
            </div>
        `;
        }).join('');
    }

    renderCompanyActionHistory(actions = []) {
        const container = document.getElementById('companyActionHistory');
        if (!container) return;
        this.state.companyActionContexts = this.state.companyActionContexts || {};
        this.state.companyActionContextsById = this.state.companyActionContextsById || {};
        this.state.companyActionHistory = Array.isArray(actions) ? actions : [];

        const history = actions
            .filter((action) => action && (action.actionKey || action.id))
            .slice(0, 6);

        if (!history.length) {
            container.innerHTML = '<p class="empty-state">No saved CEO actions yet.</p>';
            return;
        }

        const endpointSummary = this.state.companyActionHistorySummary || {};
        const localReviewableCount = history.filter((action) => action.runId || action.refreshStatus?.runId).length;
        const localReferenceCount = history.length - localReviewableCount;
        const summaryTotal = Number(endpointSummary.total || 0);
        const summaryReviewable = Number(endpointSummary.reviewable || 0);
        const summaryReferenceOnly = Number(endpointSummary.referenceOnly || 0);
        const reviewableCount = summaryTotal > 0 ? summaryReviewable : localReviewableCount;
        const referenceCount = summaryTotal > 0 ? summaryReferenceOnly : localReferenceCount;
        const sourceCounts = history.reduce((counts, action) => {
            const source = this.getCompanyActionHistorySourceLabel(action);
            counts[source] = (counts[source] || 0) + 1;
            return counts;
        }, {});
        const sourceSummary = Object.entries(sourceCounts)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([source, count]) => `${source} ${count}`)
            .join(' | ');
        const activeFilter = ['all', 'reviewable', 'reference'].includes(this.state.companyActionHistoryFilter)
            ? this.state.companyActionHistoryFilter
            : 'all';
        const activeSort = ['newest', 'oldest'].includes(this.state.companyActionHistorySort)
            ? this.state.companyActionHistorySort
            : 'newest';
        const sortedHistory = [...history].sort((a, b) => {
            const left = Date.parse(a.snapshotAt || a.updatedAt || a.createdAt || '');
            const right = Date.parse(b.snapshotAt || b.updatedAt || b.createdAt || '');
            const safeLeft = Number.isFinite(left) ? left : 0;
            const safeRight = Number.isFinite(right) ? right : 0;
            return activeSort === 'oldest'
                ? safeLeft - safeRight
                : safeRight - safeLeft;
        });
        const visibleHistory = sortedHistory.filter((action) => {
            const hasRunEvidence = Boolean(action.runId || action.refreshStatus?.runId);
            if (activeFilter === 'reviewable') return hasRunEvidence;
            if (activeFilter === 'reference') return !hasRunEvidence;
            return true;
        });
        const historySummary = [
            `${reviewableCount} reviewable`,
            referenceCount ? `${referenceCount} reference` : '',
        ].filter(Boolean).join(' | ');
        const historyWindow = [
            endpointSummary.newestSnapshotAt ? `newest ${this.formatDate(endpointSummary.newestSnapshotAt)}` : '',
            endpointSummary.oldestSnapshotAt ? `oldest ${this.formatDate(endpointSummary.oldestSnapshotAt)}` : '',
        ].filter(Boolean).join(' | ');
        const isLoading = Boolean(this.state.companyActionHistoryLoading);
        const errorMessage = this.state.companyActionHistoryError || '';

        container.innerHTML = `
            <div class="company-action-history__header">
                <div>
                    <strong>Recent saved CEO actions</strong>
                    <span>${this.escapeHtml(historySummary)}</span>
                    ${sourceSummary ? `<small>${this.escapeHtml(sourceSummary)}</small>` : ''}
                    ${historyWindow ? `<small>${this.escapeHtml(historyWindow)}</small>` : ''}
                </div>
                <button
                    class="btn btn-sm btn-ghost company-action-history__more"
                    type="button"
                    onclick="dashboard.loadCompanyActionHistory()"
                    ${isLoading ? 'disabled' : ''}
                >
                    ${isLoading ? 'Loading...' : 'Show more'}
                </button>
            </div>
            ${errorMessage ? `<p class="company-action-history__error">${this.escapeHtml(errorMessage)}</p>` : ''}
            <div class="company-action-history__filters" role="group" aria-label="Saved CEO action filter">
                ${[
                    ['all', `All ${history.length}`],
                    ['reviewable', `Reviewable ${reviewableCount}`],
                    ['reference', `Reference ${referenceCount}`],
                ].map(([value, label]) => `
                    <button
                        class="company-action-history__filter${activeFilter === value ? ' company-action-history__filter--active' : ''}"
                        type="button"
                        aria-pressed="${activeFilter === value ? 'true' : 'false'}"
                        onclick="dashboard.setCompanyActionHistoryFilter('${value}')"
                    >
                        ${this.escapeHtml(label)}
                    </button>
                `).join('')}
            </div>
            <div class="company-action-history__sort" role="group" aria-label="Saved CEO action order">
                ${[
                    ['newest', 'Newest first'],
                    ['oldest', 'Oldest first'],
                ].map(([value, label]) => `
                    <button
                        class="company-action-history__filter${activeSort === value ? ' company-action-history__filter--active' : ''}"
                        type="button"
                        aria-pressed="${activeSort === value ? 'true' : 'false'}"
                        onclick="dashboard.setCompanyActionHistorySort('${value}')"
                    >
                        ${this.escapeHtml(label)}
                    </button>
                `).join('')}
            </div>
            ${visibleHistory.length ? visibleHistory.map((action, index) => {
                const actionId = String(action.id || `company-action-history-${index}`);
                const actionKey = String(action.actionKey || actionId);
                const runId = action.runId || action.refreshStatus?.runId || '';
                const handler = runId
                    ? this.formatCompanyActionHandler('runs', runId, actionKey)
                    : '';
                const evidenceLabel = runId ? 'Reviewable run' : 'Reference only';
                const sourceLabel = this.getCompanyActionHistorySourceLabel(action);
                if (runId) {
                    const actionContext = this.buildCompanyActionContext(action, runId, { contextSource: 'saved-history' });
                    this.state.companyActionContexts[runId] = actionContext;
                    this.state.companyActionContextsById[actionKey] = actionContext;
                }

                return `
                <div class="company-action-history__item" data-action-id="${this.escapeHtml(actionKey)}">
                    <div>
                        <strong>${this.escapeHtml(action.label || 'Saved CEO action')}</strong>
                        <span>${this.escapeHtml(action.detail || '')}</span>
                        <div class="company-action-history__badges">
                            <small class="company-action-history__evidence">${this.escapeHtml(evidenceLabel)}</small>
                            <small class="company-action-history__source">${this.escapeHtml(sourceLabel)}</small>
                        </div>
                        ${action.snapshotAt ? `<small>Saved ${this.escapeHtml(this.formatDate(action.snapshotAt))}</small>` : ''}
                    </div>
                    ${runId ? `
                        <button
                            class="btn btn-sm btn-ghost"
                            type="button"
                            onclick="${handler}"
                        >
                            Review
                        </button>
                    ` : ''}
                </div>
            `;
            }).join('') : '<p class="empty-state">No saved CEO actions match this filter.</p>'}
        `;
    }

    getCompanyActionHistorySourceLabel(action = {}) {
        if (action.historical === true || action.contextSource === 'saved-history') {
            return 'Saved history';
        }
        if (action.refreshStatus || action.id === 'refresh-shared-whiteboard') {
            return 'Whiteboard';
        }
        if (action.runId || action.id === 'review-completed-output') {
            return 'Run output';
        }
        if (action.id === 'review-deliverables' || action.target === 'deliverables') {
            return 'Deliverables';
        }
        return 'Queue snapshot';
    }

    setCompanyActionHistoryFilter(filter = 'all') {
        const nextFilter = ['all', 'reviewable', 'reference'].includes(filter) ? filter : 'all';
        this.state.companyActionHistoryFilter = nextFilter;
        const actions = this.state.companyActionHistory
            || this.state.agentCompanyWorkspace?.actionHistory
            || [];
        this.renderCompanyActionHistory(actions);
    }

    setCompanyActionHistorySort(sort = 'newest') {
        const nextSort = ['newest', 'oldest'].includes(sort) ? sort : 'newest';
        this.state.companyActionHistorySort = nextSort;
        const actions = this.state.companyActionHistory
            || this.state.agentCompanyWorkspace?.actionHistory
            || [];
        this.renderCompanyActionHistory(actions);
    }

    renderCompanyDeliverables(deliverables = []) {
        const container = document.getElementById('companyDeliverableList');
        if (!container) return;

        if (!deliverables.length) {
            container.innerHTML = '<p class="empty-state">No company files or documents have been produced yet.</p>';
            return;
        }

        container.innerHTML = deliverables.map((deliverable) => {
            const previewUrl = deliverable.sandboxUrl || deliverable.previewUrl || '';
            const downloadUrl = deliverable.downloadUrl || deliverable.bundleDownloadUrl || '';
            const meta = [
                deliverable.roleName,
                deliverable.workloadTitle,
                deliverable.updatedAt ? this.formatDate(deliverable.updatedAt) : '',
                deliverable.sizeBytes ? this.formatBytes(deliverable.sizeBytes) : '',
            ].filter(Boolean).join(' | ');
            return `
                <div class="company-deliverable-item">
                    <div>
                        <strong>${this.escapeHtml(deliverable.title || deliverable.filename || 'Business deliverable')}</strong>
                        <span>${this.escapeHtml(meta || deliverable.filename || deliverable.id || '')}</span>
                    </div>
                    <div class="company-deliverable-actions">
                        ${previewUrl ? `<a class="btn btn-sm btn-secondary" href="${this.escapeHtml(previewUrl)}" target="_blank" rel="noopener">Preview</a>` : ''}
                        ${downloadUrl ? `<a class="btn btn-sm btn-ghost" href="${this.escapeHtml(downloadUrl)}" target="_blank" rel="noopener">Download</a>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    renderCompanySharedWhiteboard(whiteboard = null) {
        const container = document.getElementById('companySharedWhiteboard');
        if (!container) return;

        const current = whiteboard?.current || null;
        if (!current?.path) {
            container.innerHTML = `
                <div class="company-whiteboard-card company-whiteboard-card--missing">
                    <div>
                        <strong>Shared whiteboard not attached yet</strong>
                        <span>${this.escapeHtml(whiteboard?.detail || 'Run a heartbeat to attach the weekly coordination whiteboard to new company workloads.')}</span>
                    </div>
                </div>
            `;
            return;
        }

        const sections = Array.isArray(current.sections) ? current.sections.filter(Boolean) : [];
        const roles = Array.isArray(current.roleNames) ? current.roleNames.filter(Boolean) : [];
        const filePreview = current.filePreview || null;
        const previewMeta = filePreview ? [
            filePreview.status ? `File ${filePreview.status}` : '',
            filePreview.updatedAt ? this.formatDate(filePreview.updatedAt) : '',
            filePreview.sizeBytes ? this.formatBytes(filePreview.sizeBytes) : '',
        ].filter(Boolean).join(' | ') : '';
        container.innerHTML = `
            <div class="company-whiteboard-card">
                <div class="company-whiteboard-main">
                    <span class="company-whiteboard-kicker">Shared whiteboard</span>
                    <strong>${this.escapeHtml(current.path)}</strong>
                    <span>${this.escapeHtml(whiteboard.detail || current.purpose || 'Agent-to-agent weekly coordination is attached.')}</span>
                </div>
                <div class="company-whiteboard-meta">
                    ${current.weekKey ? `<span>Week ${this.escapeHtml(current.weekKey)}</span>` : ''}
                    <span>${Number(current.workloadCount || 0)} workload${Number(current.workloadCount || 0) === 1 ? '' : 's'}</span>
                    ${roles.length ? `<span>${this.escapeHtml(roles.slice(0, 3).join(', '))}</span>` : ''}
                </div>
                ${sections.length ? `
                    <div class="company-whiteboard-sections" aria-label="Shared whiteboard sections">
                        ${sections.slice(0, 8).map((section) => `<span>${this.escapeHtml(section)}</span>`).join('')}
                    </div>
                ` : ''}
                ${filePreview ? `
                    <div class="company-whiteboard-preview company-whiteboard-preview--${this.escapeHtml(filePreview.status || 'missing')}">
                        <div class="company-whiteboard-preview-head">
                            <strong>Whiteboard preview</strong>
                            ${previewMeta ? `<span>${this.escapeHtml(previewMeta)}</span>` : ''}
                        </div>
                        <p>${this.escapeHtml(filePreview.preview ? this.truncate(filePreview.preview, 420) : (filePreview.detail || 'No whiteboard text preview is available yet.'))}</p>
                    </div>
                ` : ''}
            </div>
        `;
    }

    renderCompanyFileManager(fileState = this.state.agentCompanyFiles || {}) {
        const container = document.getElementById('companyFileList');
        if (!container) return;

        const results = Array.isArray(fileState.results) ? fileState.results : [];
        const count = Number(fileState.count ?? results.length);
        const refreshed = fileState.refreshed || {};
        const statusText = fileState.error
            ? 'index unavailable'
            : `${count} document${count === 1 ? '' : 's'}${refreshed.workspace || refreshed.artifacts ? ' refreshed' : ''}`;
        this.setTextContent('companyFileManagerStatus', statusText);

        if (!results.length) {
            const message = fileState.error
                ? 'The file manager could not reach the document index.'
                : 'No documents matched this search yet.';
            container.innerHTML = `<p class="empty-state">${this.escapeHtml(message)}</p>`;
            return;
        }

        container.innerHTML = results.map((file) => {
            const sourceLabel = {
                artifact: 'Artifact',
                workspace: 'Workspace',
                'research-bucket': 'Research',
            }[file.sourceType] || file.sourceType || 'File';
            const location = file.relativePath || file.filename || file.artifactId || file.id || '';
            const preview = String(file.contentPreview || '').trim();
            return `
                <div class="company-file-item">
                    <div class="company-file-main">
                        <div class="company-file-title-row">
                            <strong>${this.escapeHtml(file.title || file.filename || 'Document')}</strong>
                            <span class="company-file-source">${this.escapeHtml(sourceLabel)}</span>
                        </div>
                        <span class="company-file-location">${this.escapeHtml(location)}</span>
                        ${preview ? `<p>${this.escapeHtml(this.truncate(preview, 220))}</p>` : ''}
                    </div>
                    <div class="company-file-actions">
                        ${file.downloadUrl ? `<a class="btn btn-sm btn-secondary" href="${this.escapeHtml(file.downloadUrl)}" target="_blank" rel="noopener">Download</a>` : ''}
                        ${file.inlineUrl ? `<a class="btn btn-sm btn-ghost" href="${this.escapeHtml(file.inlineUrl)}" target="_blank" rel="noopener">Open</a>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    renderCompanyImprovementLoop(loop = null) {
        const phaseContainer = document.getElementById('companyImprovementLoopPhases');
        const summary = document.getElementById('companyImprovementLoopSummary');
        if (!phaseContainer) return;

        if (!loop || !Array.isArray(loop.phases)) {
            this.setTextContent('companyImprovementLoopStatus', 'loop unavailable');
            if (summary) {
                summary.textContent = 'Workspace evidence has not loaded yet.';
            }
            phaseContainer.innerHTML = '<p class="empty-state">No improvement loop state loaded yet.</p>';
            return;
        }

        const metrics = loop.metrics || {};
        const cadence = loop.cadence || {};
        const health = loop.health || 'forming';
        this.setTextContent('companyImprovementLoopStatus', health);
        if (summary) {
            const parts = [
                `${Number(metrics.workloads || 0)} workstreams`,
                `${Number(metrics.deliverables || 0)} files`,
                cadence.nextHeartbeat ? `heartbeat ${this.formatDate(cadence.nextHeartbeat)}` : null,
                cadence.dailyAlignment ? `alignment ${this.formatDate(cadence.dailyAlignment)}` : null,
            ].filter(Boolean);
            summary.textContent = parts.join(' | ') || 'No operating evidence yet.';
        }

        phaseContainer.innerHTML = loop.phases.map((phase) => `
            <div class="company-loop-phase company-loop-phase--${this.escapeHtml(phase.status || 'waiting')}">
                <div>
                    <strong>${this.escapeHtml(phase.label || phase.id || 'Loop phase')}</strong>
                    <span>${this.escapeHtml(phase.detail || '')}</span>
                </div>
                <span class="company-loop-phase-status">${this.escapeHtml(phase.status || 'waiting')}</span>
            </div>
        `).join('');
    }

    renderCompanyWorkloads(workloads = []) {
        const tbody = document.getElementById('companyWorkloadsTableBody');
        if (!tbody) return;

        if (!workloads.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-state">No company-managed workloads are persisted yet.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = workloads.map((workload) => {
            const metadata = this.getAgentCompanyMetadata(workload);
            return `
                <tr>
                    <td>
                        <div>${this.escapeHtml(workload.title || 'Company workload')}</div>
                        <div class="workload-trigger">${this.escapeHtml(this.truncate(workload.prompt || '', 72))}</div>
                    </td>
                    <td>${this.escapeHtml(metadata.roleName || metadata.roleId || '-')}</td>
                    <td><span class="workload-trigger">${this.escapeHtml(this.describeAdminTrigger(workload.trigger))}</span></td>
                    <td><span class="status-badge ${workload.enabled ? 'healthy' : 'warning'}">${workload.enabled ? 'active' : 'paused'}</span></td>
                    <td class="col-tokens">${Number(workload.workloadSummary?.queued || 0)}</td>
                    <td class="col-tokens">${Number(workload.workloadSummary?.running || 0)}</td>
                    <td>
                        <div class="workload-row-actions">
                            ${workload.enabled
                                ? `<button class="btn btn-sm btn-secondary" onclick="dashboard.pauseAdminWorkload(event, '${workload.id}')">Pause</button>`
                                : `<button class="btn btn-sm btn-ghost" onclick="dashboard.resumeAdminWorkload(event, '${workload.id}')">Resume</button>`}
                            <button class="btn btn-sm btn-secondary" onclick="dashboard.openAdminWorkloadModal(event, '${workload.id}')">Direct</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderCompanyRuns(runs = []) {
        const tbody = document.getElementById('companyRunsTableBody');
        if (!tbody) return;

        if (!runs.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-state">No company runs have been recorded yet.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = runs.map((run) => {
            const isSelected = this.state.selectedRun?.id === run.id;
            const isActionSelected = this.state.companyActionRunId === run.id;

            return `
            <tr class="workload-run-row ${isSelected ? 'selected' : ''} ${isActionSelected ? 'company-run-row--action-selected' : ''}"
                data-id="${this.escapeHtml(run.id)}"
                data-dashboard-list-action="admin-run"
                role="button"
                tabindex="0"
                aria-selected="${isSelected ? 'true' : 'false'}"
                onclick="dashboard.selectAdminRun(this.dataset.id, { source: 'table' })"
                onkeydown="dashboard.handleListItemKeydown(event)">
                <td>
                    <span>${this.escapeHtml(run.id)}</span>
                    ${isActionSelected ? '<span class="company-run-action-marker">CEO action</span>' : ''}
                </td>
                <td>${this.escapeHtml(run.workloadTitle || run.workloadId)}</td>
                <td><span class="status-badge ${this.getRunStatusClass(run.status)}">${this.escapeHtml(run.status)}</span></td>
                <td>${this.escapeHtml(run.reason || 'manual')}</td>
                <td>${this.escapeHtml(this.formatDate(run.scheduledFor))}</td>
                <td>${this.escapeHtml(this.formatDate(run.finishedAt))}</td>
                <td class="workload-run-export-cell">
                    <button
                        class="btn btn-secondary btn-sm"
                        onclick="dashboard.downloadAdminRunTraceJson(event, '${run.id}')"
                        title="Download this run trace as JSON"
                    >
                        JSON
                    </button>
                </td>
            </tr>
        `;
        }).join('');
    }

    renderCompanyAlignment(alignment = {}) {
        const container = document.getElementById('companyAlignmentPanel');
        if (!container) return;

        if (!alignment || !Object.keys(alignment).length || alignment.status === 'idle') {
            container.innerHTML = '<p class="empty-state">No daily alignment state has been recorded yet.</p>';
            return;
        }

        const evidence = alignment.evidence || {};
        const suggestions = evidence.suggestions || {};
        const logs = evidence.logs || {};
        const applied = Array.isArray(alignment.applied) ? alignment.applied : [];
        const rejected = Array.isArray(alignment.rejected) ? alignment.rejected : [];

        container.innerHTML = `
            <div class="company-alignment-grid">
                <div>
                    <span class="workload-detail-label">Status</span>
                    <strong>${this.escapeHtml(alignment.status || 'steady')}</strong>
                </div>
                <div>
                    <span class="workload-detail-label">Log Evidence</span>
                    <strong>${Number(logs.count || 0).toLocaleString()} events</strong>
                </div>
                <div>
                    <span class="workload-detail-label">Suggestions</span>
                    <strong>${Number(suggestions.count || 0).toLocaleString()} found</strong>
                </div>
                <div>
                    <span class="workload-detail-label">Safe Candidates</span>
                    <strong>${Number(suggestions.safeCandidates || 0).toLocaleString()}</strong>
                </div>
            </div>
            <div class="company-alignment-list">
                ${applied.length ? applied.map((item) => `
                    <span class="status-badge healthy">${this.escapeHtml(item.id || 'applied')}</span>
                `).join('') : '<span class="text-muted">No updates applied in the last alignment.</span>'}
                ${rejected.length ? rejected.map((item) => `
                    <span class="status-badge warning">${this.escapeHtml(item.id || 'rejected')}</span>
                `).join('') : ''}
            </div>
            ${evidence.collectionError ? `<p class="workload-edit-error">${this.escapeHtml(evidence.collectionError)}</p>` : ''}
        `;
    }
    
    /**
     * Render trace timeline
     */
    normalizeTraceDetails(details) {
        if (details && typeof details === 'object') {
            return details;
        }

        const text = String(details || '').trim();
        if (!text) {
            return {};
        }

        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed : { message: text };
        } catch (_error) {
            return { message: text };
        }
    }

    getTraceImageDiagnostics(details = {}) {
        return details?.diagnostics?.imageGeneration
            || details?.imageDiagnostics?.imageGeneration
            || details?.imageGeneration
            || null;
    }

    formatTraceDiagnosticSummary(details = {}) {
        if (details.diagnosticSummary) {
            return String(details.diagnosticSummary);
        }

        const diagnostics = this.getTraceImageDiagnostics(details);
        if (!diagnostics) {
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
                    ? 'Backend sent usable persisted image data; inspect frontend receive/parser path.'
                    : (diagnostics.likelyCause || '');

        return `${parts.join(' | ')}${likely ? ` | ${likely}` : ''}`;
    }

    renderTraceValue(value) {
        if (value == null || value === '') {
            return '<span class="trace-muted">none</span>';
        }
        if (Array.isArray(value)) {
            return this.escapeHtml(value.join(', '));
        }
        if (typeof value === 'object') {
            return `<code>${this.escapeHtml(JSON.stringify(value))}</code>`;
        }
        return this.escapeHtml(String(value));
    }

    renderTraceDetails(step = {}) {
        const details = this.normalizeTraceDetails(step.details);
        const diagnosticSummary = this.formatTraceDiagnosticSummary(details);
        const imageDiagnostics = this.getTraceImageDiagnostics(details) || {};
        const artifactAttempt = imageDiagnostics.artifactPersistence?.attempts?.[0] || null;
        const remoteDownload = artifactAttempt?.remoteDownload || null;
        const fields = [
            ['Phase', details.phase],
            ['Transport', details.transport],
            ['Route', details.route],
            ['Session', details.sessionId],
            ['Client', details.clientSurface],
            ['Requested', details.requestedCount],
            ['Reason', details.reason],
            ['Error', details.error],
            ['Response ID', details.responseId],
            ['Source tool', details.diagnosticSourceTool],
            ['Diagnostic code', imageDiagnostics.code],
            ['Diagnostic stage', imageDiagnostics.stage],
            ['Provider', imageDiagnostics.provider?.source],
            ['Provider URL', imageDiagnostics.provider?.baseUrl],
            ['Provider request ID', imageDiagnostics.provider?.requestId],
            ['Provider transport', imageDiagnostics.transport?.category],
            ['Artifact persistence', imageDiagnostics.artifactPersistence?.primaryReason],
            ['Artifact attempt', artifactAttempt?.reason],
            ['Remote download', remoteDownload?.reason],
            ['Remote status', remoteDownload?.status],
            ['Remote content type', remoteDownload?.contentType],
            ['Remote URL host', remoteDownload?.url?.host],
            ['Remote auth attached', remoteDownload?.authHeadersAttached],
            ['Remote timeout ms', remoteDownload?.timeoutMs],
            ['Remote redirected', remoteDownload?.redirected],
            ['Remote final host', remoteDownload?.finalUrl?.host],
            ['Remote body sniff', remoteDownload?.bodySniff?.detected],
            ['Params', details.paramKeys],
            ['State changed', details.stateChanged],
        ].filter(([, value]) => value != null && value !== '' && !(Array.isArray(value) && value.length === 0));
        const raw = this.stringifyAdminPayload(details);

        return `
            ${diagnosticSummary ? `
                <div class="trace-diagnostic">
                    <span class="trace-diagnostic-label">Diagnostics</span>
                    <span class="trace-diagnostic-text">${this.escapeHtml(diagnosticSummary)}</span>
                </div>
            ` : ''}
            ${fields.length > 0 ? `
                <div class="trace-detail-fields">
                    ${fields.map(([label, value]) => `
                        <div class="trace-detail-field">
                            <span class="trace-detail-label">${this.escapeHtml(label)}</span>
                            <span class="trace-detail-value">${this.renderTraceValue(value)}</span>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
            ${details.outputPreview ? `<div class="trace-output-preview">${this.escapeHtml(details.outputPreview)}</div>` : ''}
            <details class="trace-raw-details">
                <summary>Raw details</summary>
                <pre>${this.escapeHtml(raw)}</pre>
            </details>
        `;
    }

    renderTraceTimeline(trace) {
        const container = document.getElementById('traceTimeline');
        if (!container || !trace) return;
        
        container.innerHTML = (trace.steps || []).map((step, index) => {
            const status = ['success', 'error', 'info', 'running', 'completed'].includes(step.status)
                ? step.status
                : 'info';
            return `
            <div class="timeline-item ${status}">
                <span class="timeline-time">+${this.escapeHtml(String(step.offset || 0))}ms</span>
                <div class="timeline-content">
                    <div class="timeline-title">${this.escapeHtml(step.name || `Step ${index + 1}`)}</div>
                    <div class="timeline-details">${this.renderTraceDetails(step)}</div>
                </div>
            </div>
        `;
        }).join('');
        
        const detailsContainer = document.getElementById('traceDetails');
        if (detailsContainer) {
            detailsContainer.innerHTML = `
                <div class="log-detail-grid">
                    <div class="log-detail-item">
                        <span class="log-detail-label">Trace ID</span>
                        <span class="log-detail-value">${trace.id}</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Status</span>
                        <span class="log-detail-value">${trace.status}</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Duration</span>
                        <span class="log-detail-value">${trace.duration}ms</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Steps</span>
                        <span class="log-detail-value">${trace.steps?.length || 0}</span>
                    </div>
                </div>
            `;
        }
    }
    
    /**
     * Load recent activity
     */
    async loadRecentActivity() {
        const container = document.getElementById('recentActivity');
        if (!container) return;

        try {
            const response = await apiClient.get('/api/admin/activity', { limit: 12 });
            const activities = this.unwrapApiPayload(response, []).map(activity => this.normalizeActivity(activity));
            const items = activities.length > 0 ? activities : [
                { type: 'info', title: 'No recent dashboard activity', meta: 'Waiting for agent tasks' }
            ];

            container.innerHTML = items.map(activity => `
                <div class="activity-item">
                    <div class="activity-icon ${activity.type}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            ${activity.type === 'success' 
                                ? '<polyline points="20 6 9 17 4 12"/>'
                                : activity.type === 'error'
                                ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
                                : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
                            }
                        </svg>
                    </div>
                    <div class="activity-content">
                        <span class="activity-title">${activity.title}</span>
                        <span class="activity-meta">${activity.meta}</span>
                    </div>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error loading recent activity:', error);
            container.innerHTML = `
                <div class="activity-item">
                    <div class="activity-icon error">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </div>
                    <div class="activity-content">
                        <span class="activity-title">Failed to load recent activity</span>
                        <span class="activity-meta">${this.escapeHtml(error.message)}</span>
                    </div>
                </div>
            `;
        }
    }
    
    /**
     * Load model usage
     */
    async loadModelUsage() {
        const container = document.getElementById('modelUsage');
        if (!container) return;

        try {
            const response = await apiClient.get('/api/admin/models/usage/stats');
            const usage = this.unwrapApiPayload(response, []).map((model) => ({
                name: model.modelName || model.name || model.modelId || 'Unknown',
                requests: Number(model.requests || 0),
                percent: Number(model.successRate || 0),
            }));

            const items = usage.length > 0 ? usage : [
                { name: 'No usage yet', requests: 0, percent: 0 }
            ];

            container.innerHTML = items.map(model => `
                <div class="model-usage-item">
                    <div class="model-info">
                        <span class="model-name">${this.escapeHtml(model.name)}</span>
                        <span class="model-requests">${model.requests.toLocaleString()} requests</span>
                    </div>
                    <div class="model-bar">
                        <div class="model-fill" style="width: ${Math.max(0, Math.min(model.percent, 100))}%"></div>
                    </div>
                    <span class="model-percent">${Math.max(0, Math.min(model.percent, 100))}%</span>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error loading model usage:', error);
            container.innerHTML = '<div class="model-usage-item"><span class="model-name">Failed to load usage data</span></div>';
        }
    }

    async loadSystemHealth() {
        try {
            const startedAt = performance.now();
            const response = await apiClient.get('/api/admin/health');
            const latency = Math.round(performance.now() - startedAt);
            const health = this.unwrapApiPayload(response, {});
            this.applyDashboardCapabilities(health.capabilities || {});
            this.updateConnectionStatus(true);
            this.renderSystemHealth(health, latency);
        } catch (error) {
            console.error('Error loading system health:', error);
            this.updateConnectionStatus(false);
            this.renderSystemHealth(null, null, error);
        }
    }
    
    // ==================== ACTIONS ====================
    
    isMobileNavigation() {
        return window.matchMedia('(max-width: 992px)').matches;
    }

    syncMobileNavigationState(isOpen) {
        const sidebar = document.getElementById('sidebar');
        const backdrop = document.getElementById('sidebarBackdrop');
        const mobileToggle = document.getElementById('mobileMenuToggle');
        const sidebarToggle = document.getElementById('sidebarToggle');

        sidebar?.classList.toggle('open', isOpen);
        document.body.classList.toggle('admin-nav-open', isOpen);

        if (backdrop) {
            backdrop.hidden = !isOpen;
        }

        mobileToggle?.setAttribute('aria-expanded', String(isOpen));
        sidebarToggle?.setAttribute('aria-label', this.isMobileNavigation() ? 'Close admin navigation' : 'Collapse admin navigation');
        sidebarToggle?.setAttribute('aria-expanded', String(this.isMobileNavigation() ? isOpen : !this.state.sidebarCollapsed));
    }

    openMobileNavigation() {
        this.syncMobileNavigationState(true);
        const activeItem = document.querySelector('.nav-item.active');
        const firstItem = document.querySelector('.nav-item');
        (activeItem || firstItem)?.focus();
    }

    closeMobileNavigation() {
        const sidebar = document.getElementById('sidebar');
        const activeElement = document.activeElement;
        const focusWasInSidebar = Boolean(sidebar && activeElement && sidebar.contains(activeElement));

        this.syncMobileNavigationState(false);

        if (focusWasInSidebar) {
            document.getElementById('mobileMenuToggle')?.focus();
        }
    }

    toggleMobileNavigation() {
        const sidebar = document.getElementById('sidebar');
        if (sidebar?.classList.contains('open')) {
            this.closeMobileNavigation();
        } else {
            this.openMobileNavigation();
        }
    }

    toggleSidebar() {
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        document.getElementById('sidebar').classList.toggle('collapsed', this.state.sidebarCollapsed);
        document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(!this.state.sidebarCollapsed));
    }

    getStoredTheme() {
        try {
            return window.localStorage?.getItem('kimibuilt_admin_theme') || '';
        } catch (error) {
            return '';
        }
    }

    setStoredTheme(theme) {
        try {
            window.localStorage?.setItem('kimibuilt_admin_theme', theme);
        } catch (error) {
            // Theme persistence is a convenience; the active page state still updates.
        }
    }

    resolvePreferredTheme(theme = '') {
        if (theme === 'light' || theme === 'dark') {
            return theme;
        }

        return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
    }

    applyTheme(theme = '') {
        const resolvedTheme = this.resolvePreferredTheme(theme);
        document.body.dataset.adminTheme = resolvedTheme;

        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            const nextTheme = resolvedTheme === 'light' ? 'dark' : 'light';
            toggle.setAttribute('aria-label', `Switch to ${nextTheme} color theme`);
            toggle.setAttribute('aria-pressed', String(resolvedTheme === 'light'));
            toggle.title = `Switch to ${nextTheme} color theme`;
        }

        return resolvedTheme;
    }

    initializeTheme() {
        this.applyTheme(this.getStoredTheme());
    }

    toggleTheme() {
        const currentTheme = document.body.dataset.adminTheme || this.resolvePreferredTheme(this.getStoredTheme());
        const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setStoredTheme(nextTheme);
        return this.applyTheme(nextTheme);
    }
    
    selectPrompt(prompt) {
        this.state.selectedPrompt = prompt;
        this.promptEditorDirty = false;
        
        const promptNameInput = document.getElementById('promptName');
        const promptEditor = document.getElementById('promptEditor');
        const savePromptBtn = document.getElementById('savePromptBtn');
        const newPromptBtn = document.getElementById('newPromptBtn');

        promptNameInput.value = prompt.name;
        promptEditor.value = prompt.content || '';
        this.updatePromptEditor(prompt.content || '');
        const version = document.querySelector('.prompt-version');
        if (version) {
            version.textContent = prompt.assignment || 'live surface';
        }

        const readOnly = prompt.editable === false;
        promptNameInput.readOnly = readOnly;
        promptEditor.readOnly = readOnly;
        if (savePromptBtn) {
            savePromptBtn.disabled = readOnly;
            savePromptBtn.title = readOnly
                ? 'This prompt surface is generated from application code and cannot be edited here.'
                : 'Save changes to this managed prompt surface.';
        }
        if (newPromptBtn) {
            newPromptBtn.disabled = true;
            newPromptBtn.title = 'Prompt surfaces are fixed slots. Select a managed surface to edit it.';
        }
        
        // Update active state in list
        this.updatePromptListActiveState(prompt.id);
    }

    updatePromptListActiveState(id) {
        document.querySelectorAll('.prompt-item').forEach(item => {
            const active = item.dataset.id === id;
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
    
    selectPromptById(id) {
        const prompt = this.state.prompts.find(p => p.id === id);
        if (prompt) {
            this.selectPrompt(prompt);
        }
    }
    
    selectTrace(id) {
        const trace = this.state.traces.find(t => t.id === id);
        if (trace) {
            this.state.selectedTrace = trace;
            this.renderTraceTimeline(trace);
            
            // Update active state
            document.querySelectorAll('.trace-item').forEach(item => {
                const active = item.dataset.id === id;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', active ? 'true' : 'false');
            });
        }
    }

    async selectAdminRun(id, options = {}) {
        if (options?.source === 'company-action') {
            const actionContext = options.actionContext
                || this.state.companyActionContexts?.[id]
                || this.getPersistedCompanyActionContext(id)
                || {
                    label: 'Opened from CEO action queue',
                    detail: "Review this run's output evidence before continuing or packaging company work.",
                    outputPreview: '',
                };
            this.state.companyActionRunId = id;
            this.state.companyActionContext = actionContext;
            this.persistCompanyActionContext(id, actionContext);
            if (options.persistSelection !== false) {
                this.updateCompanyActionSelectionUrl(id, actionContext.actionKey || actionContext.id || '');
            }
        } else if (this.state.companyActionRunId) {
            this.state.companyActionRunId = null;
            this.state.companyActionContext = null;
            this.updateCompanyActionSelectionUrl('');
        }

        const existing = this.state.runs.find((run) => run.id === id) || null;
        this.state.selectedRun = existing;
        this.renderAdminRuns(this.state.runs);
        this.renderAgentCompanyDashboard();
        this.renderAdminRunDetails(existing);

        try {
            const response = await apiClient.getAdminRun(id);
            const detailedRun = this.normalizeAdminRun(this.unwrapApiPayload(response, existing || {}), this.state.workloads);
            this.replaceAdminRunInState(detailedRun);
            this.renderAdminRuns(this.state.runs);
            this.renderAgentCompanyDashboard();
            this.renderAdminRunDetails(detailedRun);
        } catch (error) {
            console.error('Error loading run details:', error);
            if (!existing) {
                this.renderAdminRunDetails(null, error);
            }
        }
    }

    async pauseAdminWorkload(event, id) {
        event?.stopPropagation?.();
        const workload = this.state.workloads.find((entry) => entry.id === id);
        const title = workload?.title || 'this workload';

        if (!confirm(`Pause "${title}" and cancel any queued runs?`)) {
            return;
        }

        try {
            await apiClient.pauseAdminWorkload(id);
            this.showToast(`Paused ${title}`, 'success');
            await this.loadWorkloads();
        } catch (error) {
            this.showToast(error.userMessage || error.message || 'Failed to pause workload', 'error');
        }
    }

    async resumeAdminWorkload(event, id) {
        event?.stopPropagation?.();
        const workload = this.state.workloads.find((entry) => entry.id === id);
        const title = workload?.title || 'this workload';

        try {
            await apiClient.resumeAdminWorkload(id);
            this.showToast(`Resumed ${title}`, 'success');
            await this.loadWorkloads();
        } catch (error) {
            this.showToast(error.userMessage || error.message || 'Failed to resume workload', 'error');
        }
    }

    async deleteAdminWorkload(event, id) {
        event?.stopPropagation?.();
        const workload = this.state.workloads.find((entry) => entry.id === id);
        const title = workload?.title || 'this workload';

        if (!confirm(`Delete "${title}"? This also removes queued runs.`)) {
            return;
        }

        try {
            await apiClient.deleteAdminWorkload(id);
            if (this.state.selectedRun?.workloadId === id) {
                this.state.selectedRun = null;
            }
            this.showToast(`Deleted ${title}`, 'success');
            await this.loadWorkloads();
        } catch (error) {
            this.showToast(error.userMessage || error.message || 'Failed to delete workload', 'error');
        }
    }

    openAdminWorkloadModal(event, id) {
        event?.stopPropagation?.();
        const workload = this.state.workloads.find((entry) => entry.id === id);
        const modal = document.getElementById('editWorkloadModal');
        if (!workload || !modal) {
            this.showToast('Workload not found', 'error');
            return;
        }

        this.state.editingWorkloadId = workload.id;
        this.clearAdminWorkloadError();
        this.setInputValue('editWorkloadTitle', workload.title || '');
        this.setInputValue('editWorkloadPrompt', workload.prompt || '');
        this.setInputValue('editWorkloadTriggerType', workload.trigger?.type || 'manual');
        this.setInputValue(
            'editWorkloadRunAt',
            workload.trigger?.type === 'once' ? this.toDatetimeLocal(workload.trigger?.runAt) : '',
        );
        this.setInputValue(
            'editWorkloadCronExpression',
            workload.trigger?.type === 'cron' ? (workload.trigger?.expression || '') : '',
        );
        this.setInputValue(
            'editWorkloadTimezone',
            workload.trigger?.type === 'cron'
                ? (workload.trigger?.timezone || 'UTC')
                : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
        );

        const enabledInput = document.getElementById('editWorkloadEnabled');
        if (enabledInput) {
            enabledInput.checked = workload.enabled !== false;
        }

        this.updateAdminWorkloadTriggerFields();
        modal.classList.add('active');
    }

    resetAdminWorkloadModal() {
        this.state.editingWorkloadId = null;
        this.clearAdminWorkloadError();
        this.setInputValue('editWorkloadTitle', '');
        this.setInputValue('editWorkloadPrompt', '');
        this.setInputValue('editWorkloadTriggerType', 'manual');
        this.setInputValue('editWorkloadRunAt', '');
        this.setInputValue('editWorkloadCronExpression', '');
        this.setInputValue('editWorkloadTimezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
        const enabledInput = document.getElementById('editWorkloadEnabled');
        if (enabledInput) {
            enabledInput.checked = true;
        }
        const saveButton = document.getElementById('saveWorkloadChangesBtn');
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Save Changes';
        }
        this.updateAdminWorkloadTriggerFields();
    }

    updateAdminWorkloadTriggerFields() {
        const triggerType = document.getElementById('editWorkloadTriggerType')?.value || 'manual';
        const onceFields = document.getElementById('editWorkloadOnceFields');
        const cronFields = document.getElementById('editWorkloadCronFields');
        if (onceFields) {
            onceFields.hidden = triggerType !== 'once';
        }
        if (cronFields) {
            cronFields.hidden = triggerType !== 'cron';
        }
    }

    showAdminWorkloadError(message) {
        const errorEl = document.getElementById('editWorkloadError');
        if (!errorEl) {
            return;
        }

        errorEl.textContent = message;
        errorEl.hidden = !message;
    }

    clearAdminWorkloadError() {
        this.showAdminWorkloadError('');
    }

    readAdminWorkloadForm() {
        const title = String(document.getElementById('editWorkloadTitle')?.value || '').trim();
        const prompt = String(document.getElementById('editWorkloadPrompt')?.value || '').trim();
        const triggerType = String(document.getElementById('editWorkloadTriggerType')?.value || 'manual').trim();
        const enabled = document.getElementById('editWorkloadEnabled')?.checked !== false;

        if (!title) {
            throw new Error('Title is required');
        }
        if (!prompt) {
            throw new Error('Prompt is required');
        }

        const payload = {
            title,
            prompt,
            enabled,
            trigger: { type: triggerType },
        };

        if (triggerType === 'once') {
            const runAt = String(document.getElementById('editWorkloadRunAt')?.value || '').trim();
            if (!runAt) {
                throw new Error('Run time is required for one-time workloads');
            }
            payload.trigger.runAt = new Date(runAt).toISOString();
        } else if (triggerType === 'cron') {
            const expression = String(document.getElementById('editWorkloadCronExpression')?.value || '').trim();
            const timezone = String(document.getElementById('editWorkloadTimezone')?.value || '').trim()
                || Intl.DateTimeFormat().resolvedOptions().timeZone
                || 'UTC';
            if (!expression) {
                throw new Error('Cron expression is required for recurring workloads');
            }
            payload.trigger.expression = expression;
            payload.trigger.timezone = timezone;
        }

        return payload;
    }

    async saveAdminWorkload() {
        const id = this.state.editingWorkloadId;
        const saveButton = document.getElementById('saveWorkloadChangesBtn');
        if (!id) {
            this.showToast('Select a workload before saving', 'warning');
            return;
        }

        try {
            this.clearAdminWorkloadError();
            if (saveButton) {
                saveButton.disabled = true;
                saveButton.textContent = 'Saving...';
            }

            const payload = this.readAdminWorkloadForm();
            await apiClient.updateAdminWorkload(id, payload);
            this.closeModal('editWorkloadModal');
            this.showToast('Workload updated', 'success');
            await this.loadWorkloads();
        } catch (error) {
            console.error('Failed to update workload:', error);
            this.showAdminWorkloadError(error.userMessage || error.message || 'Failed to update workload');
            this.showToast(error.userMessage || error.message || 'Failed to update workload', 'error');
            if (saveButton) {
                saveButton.disabled = false;
                saveButton.textContent = 'Save Changes';
            }
        }
    }
    
    updatePromptEditor(content) {
        const charCount = document.getElementById('charCount');
        if (charCount) {
            charCount.textContent = `${content.length} chars`;
        }
        
        // Update preview
        const preview = document.getElementById('promptPreview');
        if (preview) {
            preview.innerHTML = content 
                ? `<pre><code>${this.escapeHtml(content)}</code></pre>`
                : '<p class="preview-placeholder">Preview will appear here...</p>';
        }
    }
    
    async savePrompt() {
        const name = document.getElementById('promptName').value;
        const content = document.getElementById('promptEditor').value;
        
        if (!name || !content) {
            this.showToast('Please provide a name and content', 'warning');
            return;
        }
        
        try {
            const prompt = {
                name,
                content,
                updatedAt: new Date().toISOString()
            };

            if (this.state.selectedPrompt?.id) {
                await apiClient.put(`/api/admin/prompts/${this.state.selectedPrompt.id}`, prompt);
            } else {
                await apiClient.post('/api/admin/prompts', prompt);
            }
            
            this.showToast('Prompt saved successfully', 'success');
            this.loadPrompts();
        } catch (error) {
            this.showToast('Failed to save prompt', 'error');
        }
    }

    async saveDefaultConfig() {
        try {
            const settings = {
                models: {
                    defaultModel: document.getElementById('defaultModel').value,
                    temperature: parseFloat(document.getElementById('defaultTemperature').value),
                    maxTokens: parseInt(document.getElementById('defaultMaxTokens').value, 10),
                    topP: parseFloat(document.getElementById('defaultTopP').value),
                    frequencyPenalty: parseFloat(document.getElementById('defaultFrequencyPenalty').value),
                    presencePenalty: parseFloat(document.getElementById('defaultPresencePenalty').value),
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            this.showToast('Configuration saved', 'success');
        } catch (error) {
            console.error('Error saving default config:', error);
            this.showToast('Failed to save configuration', 'error');
        }
    }
    
    createNewPrompt() {
        this.showToast('This page edits fixed live runtime prompt slots. Select an existing slot to change it.', 'info');
    }
    
    switchPromptTab(tab) {
        document.querySelectorAll('.editor-tabs .tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tab}Tab`);
        });
    }
    
    insertVariable(variable) {
        const editor = document.getElementById('promptEditor');
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const value = editor.value;
        
        editor.value = value.substring(0, start) + variable + value.substring(end);
        editor.focus();
        editor.setSelectionRange(start + variable.length, start + variable.length);
        
        this.updatePromptEditor(editor.value);
    }
    
    openTestPromptModal() {
        const modal = document.getElementById('testPromptModal');
        if (modal) {
            modal.classList.add('active');
        }
    }
    
    async openHistoryModal() {
        const modal = document.getElementById('historyModal');
        const container = document.getElementById('historyList');
        if (!modal || !container) {
            return;
        }

        const prompt = this.state.selectedPrompt;
        if (!prompt?.id) {
            container.innerHTML = '<div class="history-item"><span class="history-version">No prompt selected</span></div>';
            modal.classList.add('active');
            return;
        }

        container.innerHTML = '<div class="history-item"><span class="history-version">Loading history...</span></div>';
        modal.classList.add('active');

        try {
            const response = await apiClient.getPromptHistory(prompt.id);
            const history = this.unwrapApiPayload(response, []);

            container.innerHTML = history.length > 0
                ? history.map((entry) => `
                    <div class="history-item">
                        <span class="history-version">${this.escapeHtml(entry.version || entry.type || 'entry')}</span>
                        <span class="history-date">${this.formatDate(entry.timestamp || entry.date)}</span>
                        <span class="history-author">${this.escapeHtml(entry.author || entry.details || 'runtime')}</span>
                    </div>
                    ${entry.preview ? `<div class="history-item"><span class="history-author">${this.escapeHtml(entry.preview)}</span></div>` : ''}
                `).join('')
                : '<div class="history-item"><span class="history-version">No history recorded yet</span></div>';
        } catch (error) {
            console.error('Error loading prompt history:', error);
            container.innerHTML = `<div class="history-item"><span class="history-version">Failed to load history</span><span class="history-author">${this.escapeHtml(error.message || 'Unknown error')}</span></div>`;
        }
    }
    
    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
        }
        if (modalId === 'editWorkloadModal') {
            this.resetAdminWorkloadModal();
        }
    }
    
    async runPromptTest() {
        const input = document.getElementById('testInput').value;
        const output = document.querySelector('#testOutput .output-content');
        
        if (!this.state.selectedPrompt?.id) {
            this.showToast('Save or select a prompt before testing it', 'warning');
            return;
        }

        if (!input) {
            this.showToast('Please enter test variables as JSON', 'warning');
            return;
        }
        
        output.innerHTML = '<p class="placeholder">Running test...</p>';
        
        try {
            let variables = {};
            try {
                variables = JSON.parse(input);
            } catch {
                throw new Error('Test input must be valid JSON, for example {"language":"JavaScript"}');
            }

            const response = await apiClient.post(`/api/admin/prompts/${this.state.selectedPrompt.id}/test`, {
                variables
            });
            const result = this.unwrapApiPayload(response, {});
            output.innerHTML = `<pre>${this.escapeHtml(result.rendered || 'No rendered output')}</pre>`;
        } catch (error) {
            output.innerHTML = `<p class="error">Error: ${error.message}</p>`;
        }
    }
    
    async saveDefaultConfig() {
        try {
            const settings = {
                models: {
                    defaultModel: document.getElementById('defaultModel').value,
                    temperature: parseFloat(document.getElementById('defaultTemperature').value),
                    maxTokens: parseInt(document.getElementById('defaultMaxTokens').value, 10),
                    topP: parseFloat(document.getElementById('defaultTopP').value),
                    frequencyPenalty: parseFloat(document.getElementById('defaultFrequencyPenalty').value),
                    presencePenalty: parseFloat(document.getElementById('defaultPresencePenalty').value),
                }
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            this.showToast('Configuration saved', 'success');
        } catch (error) {
            this.showToast('Failed to save configuration', 'error');
        }
    }

    async saveOrchestrationConfig() {
        try {
            const settings = {
                orchestration: {
                    enabled: document.getElementById('orchestrationEnabled').value === 'true',
                    defaultModel: document.getElementById('orchestrationDefaultModel').value,
                    plannerModel: document.getElementById('orchestrationPlannerModel').value,
                    synthesisModel: document.getElementById('orchestrationSynthesisModel').value,
                    repairModel: document.getElementById('orchestrationRepairModel').value,
                    evaluatorModel: document.getElementById('orchestrationEvaluatorModel').value,
                    fallbackModels: this.getSelectedModelValues('orchestrationFallbackModels'),
                    plannerReasoningEffort: document.getElementById('orchestrationPlannerReasoning').value,
                    synthesisReasoningEffort: document.getElementById('orchestrationSynthesisReasoning').value,
                    repairReasoningEffort: document.getElementById('orchestrationRepairReasoning').value,
                    evaluatorReasoningEffort: document.getElementById('orchestrationEvaluatorReasoning').value,
                    enableAlignmentEvaluator: document.getElementById('orchestrationEnableAlignmentEvaluator').value === 'true',
                    applyAlignmentGuidance: document.getElementById('orchestrationApplyAlignmentGuidance').value === 'true',
                    agentDirectedRuntime: document.getElementById('orchestrationAgentDirectedRuntime').value === 'true',
                    neuralWaveResearchMode: document.getElementById('orchestrationNeuralWaveResearchMode').value === 'true',
                    perplexityResearchLevel: document.getElementById('orchestrationPerplexityResearchLevel').value || 'auto',
                    afterProcessAuditEnabled: document.getElementById('orchestrationAfterProcessAuditEnabled').value === 'true',
                    asyncRuntimeEnabled: document.getElementById('orchestrationAsyncRuntimeEnabled').value === 'true',
                    asyncRuntimeWebChatParallel: document.getElementById('orchestrationAsyncRuntimeWebChatParallel').value === 'true',
                    asyncRuntimeAllowLiveRemote: document.getElementById('orchestrationAsyncRuntimeAllowLiveRemote').value === 'true',
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            this.showToast('Orchestration settings saved', 'success');
        } catch (error) {
            console.error('Error saving orchestration settings:', error);
            this.showToast('Failed to save orchestration settings', 'error');
        }
    }

    async saveAgentRuntimeSettings() {
        try {
            const existing = this.state.settings?.orchestration || {};
            const settings = {
                orchestration: {
                    ...existing,
                    agentDirectedRuntime: document.getElementById('settingsAgentDirectedRuntime').checked,
                    neuralWaveResearchMode: document.getElementById('settingsNeuralWaveResearchMode').checked,
                    perplexityResearchLevel: document.getElementById('settingsPerplexityResearchLevel').value || 'auto',
                    afterProcessAuditEnabled: document.getElementById('settingsAfterProcessAuditEnabled').checked,
                    asyncRuntimeEnabled: document.getElementById('settingsAsyncRuntimeEnabled').checked,
                    asyncRuntimeWebChatParallel: document.getElementById('settingsAsyncRuntimeWebChatParallel').checked,
                    asyncRuntimeAllowLiveRemote: document.getElementById('settingsAsyncRuntimeAllowLiveRemote').checked,
                },
                agentCompany: {
                    ...(this.state.settings?.agentCompany || {}),
                    enabled: document.getElementById('settingsAgentCompanyEnabled')?.checked === true,
                    companyGoal: document.getElementById('settingsAgentCompanyGoal')?.value || '',
                    heartbeatMinutes: parseInt(document.getElementById('settingsAgentCompanyHeartbeatMinutes')?.value || '60', 10),
                    weeklyWorkloadLimit: parseInt(document.getElementById('settingsAgentCompanyWeeklyWorkloadLimit')?.value || '3', 10),
                    maxConcurrentWorkloads: parseInt(document.getElementById('settingsAgentCompanyMaxConcurrentWorkloads')?.value || '1', 10),
                    primaryModel: document.getElementById('settingsAgentCompanyPrimaryModel')?.value || '',
                    escalationModels: (document.getElementById('settingsAgentCompanyEscalationModels')?.value || '')
                        .split(',')
                        .map((model) => model.trim())
                        .filter(Boolean),
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            await this.loadAgentCompanyStatus();
            this.showToast('Runtime setting saved', 'success');
        } catch (error) {
            console.error('Error saving runtime setting:', error);
            this.showToast('Failed to save runtime setting', 'error');
        }
    }

    async loadAgentCompanyDashboard({ force = false } = {}) {
        await Promise.all([
            this.loadAgentCompanyWorkspace(),
            this.searchAgentCompanyFiles(),
            this.loadWorkloads(),
        ]);

        if (force) {
            this.showToast('Agent company console refreshed', 'success');
        }
    }

    async loadAgentCompanyWorkspace() {
        try {
            const response = typeof apiClient.getAgentCompanyWorkspace === 'function'
                ? await apiClient.getAgentCompanyWorkspace()
                : await apiClient.get('/api/admin/agent-company/workspace');
            const workspace = this.unwrapApiPayload(response, {});
            this.state.agentCompanyWorkspace = workspace;
            if (workspace.status) {
                this.state.agentCompanyStatus = workspace.status;
                this.renderAgentCompanyStatus(workspace.status);
            }
            if (Array.isArray(workspace.workloads) && Array.isArray(workspace.runs)) {
                const knownWorkloads = new Map(this.state.workloads.map((workload) => [workload.id, workload]));
                workspace.workloads.forEach((workload) => knownWorkloads.set(workload.id, this.normalizeAdminWorkload(workload)));
                this.state.workloads = Array.from(knownWorkloads.values());

                const knownRuns = new Map(this.state.runs.map((run) => [run.id, run]));
                workspace.runs.forEach((run) => knownRuns.set(run.id, this.normalizeAdminRun(run, this.state.workloads)));
                this.state.runs = Array.from(knownRuns.values());
            }
            this.renderAgentCompanyDashboard();
            await this.restoreCompanyActionSelectionFromUrl();
            return workspace;
        } catch (error) {
            console.warn('Error loading agent company workspace:', error.message || error);
            this.state.agentCompanyWorkspace = {
                deliverables: [],
                actionQueue: [],
                workspace: {
                    workloadAvailable: false,
                },
            };
            return this.loadAgentCompanyStatus();
        }
    }

    async loadCompanyActionHistory(limit = 24) {
        this.state.companyActionHistoryLoading = true;
        this.state.companyActionHistoryError = '';
        this.renderCompanyActionHistory(
            this.state.companyActionHistory
                || this.state.agentCompanyWorkspace?.actionHistory
                || [],
        );

        try {
            const client = window.apiClient || (typeof apiClient !== 'undefined' ? apiClient : null);
            if (!client?.get) {
                throw new Error('API client is unavailable');
            }
            const response = await client.get('/api/admin/agent-company/action-history', { limit });
            const payload = this.unwrapApiPayload(response, {});
            const actions = Array.isArray(payload.actions) ? payload.actions : [];
            this.state.companyActionHistorySummary = payload.summary || null;
            this.state.companyActionHistoryLoading = false;
            this.state.companyActionHistoryError = '';
            this.renderCompanyActionHistory(actions);
            return actions;
        } catch (error) {
            this.state.companyActionHistoryLoading = false;
            this.state.companyActionHistoryError = error.userMessage || error.message || 'Failed to load saved CEO actions.';
            this.renderCompanyActionHistory(
                this.state.companyActionHistory
                    || this.state.agentCompanyWorkspace?.actionHistory
                    || [],
            );
            console.warn('Error loading company action history:', error.message || error);
            return [];
        }
    }

    async searchAgentCompanyFiles({ refresh = false } = {}) {
        try {
            const params = {
                query: this.state.companyFileSearch || '',
                sourceType: this.state.companyFileSourceFilter || 'any',
                limit: 25,
                includeContent: true,
                ...(refresh ? { refresh: true } : {}),
            };
            const response = typeof apiClient.searchAgentCompanyFiles === 'function'
                ? await apiClient.searchAgentCompanyFiles(params)
                : await apiClient.get('/api/admin/agent-company/files', params);
            const payload = this.unwrapApiPayload(response, {});
            this.state.agentCompanyFiles = payload;
            this.renderCompanyFileManager(payload);
            if (refresh) {
                this.showToast('Company file index refreshed', 'success');
            }
            return payload;
        } catch (error) {
            console.warn('Error searching company files:', error.message || error);
            const fallback = {
                count: 0,
                results: [],
                error: error.message || 'file_search_failed',
            };
            this.state.agentCompanyFiles = fallback;
            this.renderCompanyFileManager(fallback);
            return fallback;
        }
    }

    async loadAgentCompanyStatus() {
        try {
            const response = await apiClient.get('/api/admin/agent-company');
            const status = this.unwrapApiPayload(response, null);
            this.state.agentCompanyStatus = status;
            this.renderAgentCompanyStatus(status);
            this.renderAgentCompanyDashboard();
            return status;
        } catch (error) {
            const fallback = {
                available: false,
                state: {
                    heartbeat: {
                        status: 'unavailable',
                        reason: error.message || 'status_failed',
                    },
                },
            };
            this.state.agentCompanyStatus = fallback;
            this.renderAgentCompanyStatus(fallback);
            this.renderAgentCompanyDashboard();
            return fallback;
        }
    }

    async runAgentCompanyHeartbeat({ source = 'admin' } = {}) {
        try {
            const response = await apiClient.post('/api/admin/agent-company/heartbeat', {
                reason: source,
            });
            const status = this.unwrapApiPayload(response, null);
            this.state.agentCompanyStatus = status;
            this.renderAgentCompanyStatus(status);
            this.renderAgentCompanyDashboard();
            const created = status?.createdWorkloads?.length || status?.state?.heartbeat?.createdWorkloads || 0;
            this.showToast(created > 0 ? `Heartbeat scheduled ${created} workload${created === 1 ? '' : 's'}` : 'Heartbeat checked current work', 'success');
            await this.loadAgentCompanyDashboard();
        } catch (error) {
            console.error('Error running agent company heartbeat:', error);
            this.showToast('Failed to run company heartbeat', 'error');
        }
    }

    async runAgentCompanyDailyAlignment() {
        try {
            const response = await apiClient.post('/api/admin/agent-company/daily-alignment', {
                reason: 'company-console-alignment',
            });
            const payload = this.unwrapApiPayload(response, {});
            const status = payload.status || payload;
            this.state.agentCompanyStatus = status;
            this.renderAgentCompanyStatus(status);
            this.renderAgentCompanyDashboard();
            const alignment = payload.dailyAlignment || status?.state?.dailyAlignment || {};
            this.showToast(`Daily alignment ${alignment.status || 'checked'}`, 'success');
            await this.loadAgentCompanyWorkspace();
        } catch (error) {
            console.error('Error running agent company alignment:', error);
            this.showToast(error.userMessage || error.message || 'Failed to run company alignment', 'error');
        }
    }

    async saveAgentCompanyDirection() {
        const goal = String(document.getElementById('companyCeoDirection')?.value || '').trim();
        if (!goal) {
            this.showToast('Add a company direction before saving', 'warning');
            return;
        }

        const current = this.state.settings?.agentCompany
            || this.state.agentCompanyStatus?.config
            || {};
        const settings = {
            agentCompany: {
                ...current,
                enabled: true,
                companyGoal: goal,
                heartbeatMinutes: Number(current.heartbeatMinutes || 60),
                weeklyWorkloadLimit: Number(current.weeklyWorkloadLimit || 3),
                maxConcurrentWorkloads: Number(current.maxConcurrentWorkloads || 1),
                sessionId: current.sessionId || 'agent-company',
                escalationModels: Array.isArray(current.escalationModels)
                    ? current.escalationModels
                    : String(current.escalationModels || '')
                        .split(',')
                        .map((model) => model.trim())
                        .filter(Boolean),
            },
        };

        try {
            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings), { preserveDirty: true });
            this.dirtyInputIds.delete('companyCeoDirection');
            await this.loadAgentCompanyDashboard({ force: true });
            this.showToast('Company direction saved', 'success');
        } catch (error) {
            console.error('Error saving company direction:', error);
            this.showToast(error.userMessage || error.message || 'Failed to save company direction', 'error');
        }
    }

    handleCompanyAction(target = '', runId = '', actionId = '') {
        switch (target) {
            case 'settings':
                this.configureAgentCompany();
                break;
            case 'heartbeat':
                this.runAgentCompanyHeartbeat({ source: 'company-action-queue' });
                break;
            case 'whiteboard-refresh':
                this.runAgentCompanyHeartbeat({ source: 'shared-whiteboard-refresh' });
                break;
            case 'runs':
                if (runId) {
                    this.selectAdminRun(runId, {
                        source: 'company-action',
                        actionContext: this.state.companyActionContextsById?.[actionId]
                            || this.state.companyActionContexts?.[runId]
                            || null,
                    });
                }
                document.getElementById('companyRunsTableBody')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                break;
            case 'deliverables':
                document.getElementById('companyDeliverableList')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                break;
            case 'alignment':
                document.getElementById('companyAlignmentPanel')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                break;
            default:
                document.getElementById('agentCompanyView')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                break;
        }
    }
    
    resetDefaultConfig() {
        document.getElementById('defaultTemperature').value = 0.7;
        document.getElementById('defaultMaxTokens').value = 4096;
        document.getElementById('defaultTopP').value = 1;
        document.getElementById('defaultFrequencyPenalty').value = 0;
        document.getElementById('defaultPresencePenalty').value = 0;
        
        // Update display values
        document.querySelectorAll('#defaultConfigForm .range-value').forEach(el => {
            const input = el.previousElementSibling;
            if (input) el.textContent = input.value;
        });
        
        this.showToast('Defaults reset', 'info');
    }
    
    toggleLogsPause() {
        this.state.logsPaused = !this.state.logsPaused;
        const btn = document.getElementById('pauseLogsBtn');
        if (btn) {
            btn.classList.toggle('active', !this.state.logsPaused);
            btn.innerHTML = this.state.logsPaused 
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        }
    }
    
    clearLogs() {
        apiClient.post('/api/admin/logs/clear')
            .then(() => {
                this.state.logs = [];
                this.state.pagination.logs.total = 0;
                this.renderLogs([]);
                this.updateLogsPagination();
            })
            .catch((error) => {
                console.error('Error clearing logs:', error);
                this.showToast('Failed to clear logs', 'error');
            });
    }
    
    exportLogs() {
        window.open('/api/admin/logs/export/csv', '_blank', 'noopener');
    }
    
    filterLogs() {
        const level = document.getElementById('logLevelFilter')?.value;
        const model = document.getElementById('logModelFilter')?.value;
        const search = document.getElementById('logSearch')?.value.toLowerCase();
        
        let filtered = [...this.state.logs];
        
        if (level && level !== 'all') {
            filtered = filtered.filter(l => l.level === level);
        }
        
        if (model && model !== 'all') {
            filtered = filtered.filter(l => l.model === model);
        }
        
        if (search) {
            filtered = filtered.filter(l => 
                l.prompt?.toLowerCase().includes(search) ||
                l.model?.toLowerCase().includes(search)
            );
        }
        
        this.renderLogs(filtered);
    }
    
    changeLogPage(direction) {
        const { page, total } = this.state.pagination.logs;
        const newPage = page + direction;
        
        if (newPage < 1 || newPage > total) return;
        
        this.state.pagination.logs.page = newPage;
        this.loadLogs();
    }
    
    updateLogsPagination() {
        const { page, limit, total } = this.state.pagination.logs;
        const pages = Math.ceil(total / limit) || 1;
        
        document.getElementById('logsShown').textContent = Math.min(this.state.logs.length, limit);
        document.getElementById('logsTotal').textContent = total;
        document.getElementById('currentPage').textContent = page;
        document.getElementById('totalPages').textContent = pages;
        
        document.getElementById('logsPrevPage').disabled = page <= 1;
        document.getElementById('logsNextPage').disabled = page >= pages;
    }
    
    showLogDetails(id) {
        const log = this.state.logs.find(l => l.id === id);
        if (!log) return;
        
        const modal = document.getElementById('logDetailsModal');
        const container = document.getElementById('logDetails');
        const diagnostics = this.stringifyAdminPayload(log.diagnostics);
        const diagnosticsSection = log.diagnostics
            ? `
                <div class="log-detail-section">
                    <h4>Diagnostics</h4>
                    <div class="log-detail-content">${this.escapeHtml(diagnostics)}</div>
                </div>
            `
            : '';
        
        if (container) {
            container.innerHTML = `
                <div class="log-detail-section">
                    <h4>Request</h4>
                    <div class="log-detail-content">${this.escapeHtml(log.prompt || 'N/A')}</div>
                </div>
                <div class="log-detail-section">
                    <h4>Response</h4>
                    <div class="log-detail-content">${this.escapeHtml(log.response || 'N/A')}</div>
                </div>
                ${diagnosticsSection}
                <div class="log-detail-grid">
                    <div class="log-detail-item">
                        <span class="log-detail-label">Model</span>
                        <span class="log-detail-value">${log.model}</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Tokens</span>
                        <span class="log-detail-value">${log.tokens || 0}</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Latency</span>
                        <span class="log-detail-value">${log.latency}ms</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Timestamp</span>
                        <span class="log-detail-value">${this.formatDate(log.timestamp)}</span>
                    </div>
                </div>
            `;
        }
        
        modal?.classList.add('active');
    }
    
    filterSkills(category) {
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === category);
        });

        this.renderSkills(this.getFilteredTools());
    }
    
    searchSkills(query) {
        this.renderSkills(this.getFilteredTools(query));
    }
    
    async toggleSkill(id) {
        try {
            const skill = this.state.skills.find(s => s.id === id);
            if (!skill) {
                throw new Error('Skill not found');
            }

            const endpoint = skill.enabled
                ? `/api/admin/skills/${id}/disable`
                : `/api/admin/skills/${id}/enable`;
            await apiClient.post(endpoint);
            this.loadSkills();
            this.showToast('Skill status updated', 'success');
        } catch (error) {
            console.error('Error toggling skill:', error);
            this.showToast('Failed to update skill status', 'error');
        }
    }
    
    discoverSkills() {
        this.loadSkills()
            .then(() => {
                this.showToast('Tool catalog refreshed', 'success');
            })
            .catch((error) => {
                console.error('Error refreshing tool catalog:', error);
                this.showToast('Failed to refresh tool catalog', 'error');
            });
    }
    
    filterTraces() {
        const status = document.getElementById('traceStatusFilter')?.value;
        const search = document.getElementById('traceSearch')?.value.toLowerCase();
        
        let filtered = [...this.state.traces];
        
        if (status && status !== 'all') {
            filtered = filtered.filter(t => t.status === status);
        }
        
        if (search) {
            filtered = filtered.filter(t => 
                t.name.toLowerCase().includes(search)
            );
        }
        
        this.renderTraces(filtered);
    }

    configureAgentCompany() {
        this.navigateTo('settings');
        this.switchSettingsSection('orchestration');
        const target = document.getElementById('settingsAgentCompanyGoal')
            || document.getElementById('settingsAgentCompanyEnabled')
            || document.getElementById('orchestrationSettings');
        target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        target?.focus?.();
    }

    setupSettingsNavigation() {
        document.querySelector('.settings-nav')?.setAttribute('role', 'tablist');
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            const section = item.dataset.settings;
            const panel = section ? document.getElementById(`${section}Settings`) : null;
            if (!section || !panel) {
                return;
            }

            if (!item.id) {
                item.id = `${section}SettingsTab`;
            }

            item.setAttribute('role', 'tab');
            item.setAttribute('aria-controls', panel.id);
            const active = item.classList.contains('active');
            item.setAttribute('aria-selected', active ? 'true' : 'false');
            item.setAttribute('tabindex', active ? '0' : '-1');
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', item.id);
            panel.hidden = !panel.classList.contains('active');
        });
    }

    handleSettingsNavKeydown(event) {
        const navigationKeys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
        if (!navigationKeys.includes(event.key)) {
            return;
        }

        const items = Array.from(document.querySelectorAll('.settings-nav-item[role="tab"]'))
            .filter(item => !item.disabled && item.dataset.settings);
        const currentIndex = items.indexOf(event.currentTarget);
        if (!items.length || currentIndex < 0) {
            return;
        }

        event.preventDefault();

        let nextIndex = currentIndex;
        if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = items.length - 1;
        } else {
            const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
            nextIndex = (currentIndex + direction + items.length) % items.length;
        }

        const nextItem = items[nextIndex];
        this.switchSettingsSection(nextItem.dataset.settings);
        nextItem.focus();
    }
    
    switchSettingsSection(section) {
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            const active = item.dataset.settings === section;
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
            item.setAttribute('tabindex', active ? '0' : '-1');
        });
        
        document.querySelectorAll('.settings-section').forEach(s => {
            const active = s.id === `${section}Settings`;
            s.classList.toggle('active', active);
            s.hidden = !active;
        });
    }
    
    async saveGeneralSettings() {
        try {
            const settings = {
                general: {
                    appName: document.getElementById('dashboardTitle').value,
                    timezone: document.getElementById('timezone').value,
                    dateFormat: document.getElementById('dateFormat').value
                }
            };
            
            await apiClient.put('/api/admin/settings', settings);
            this.showToast('Settings saved', 'success');
        } catch (error) {
            this.showToast('Failed to save settings', 'error');
        }
    }
    
    async saveApiSettings() {
        try {
            const settings = {
                api: {
                    baseURL: document.getElementById('apiEndpoint').value,
                    timeout: parseInt(document.getElementById('requestTimeout').value),
                    maxRetries: parseInt(document.getElementById('maxRetries').value)
                }
            };
            
            await apiClient.put('/api/admin/settings', settings);
            this.showToast('API settings saved', 'success');
        } catch (error) {
            this.showToast('Failed to save API settings', 'error');
        }
    }

    async uploadPodcastAudioTrack(track, file) {
        if (!track || !file) {
            return;
        }

        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch(`/api/admin/podcast-audio/${encodeURIComponent(track)}`, {
                method: 'POST',
                body: formData,
                headers: apiClient.apiKey ? { Authorization: `Bearer ${apiClient.apiKey}` } : {},
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.success === false) {
                throw new Error(payload.error || 'Upload failed');
            }
            this.renderPodcastAudioSettings(this.unwrapApiPayload(payload, null));
            this.showToast('Podcast audio uploaded', 'success');
        } catch (error) {
            console.error('Error uploading podcast audio:', error);
            this.showToast(error.message || 'Failed to upload podcast audio', 'error');
        }
    }

    async removePodcastAudioTrack(track) {
        if (!track || !confirm('Remove this podcast audio track?')) {
            return;
        }

        try {
            const response = await apiClient.delete(`/api/admin/podcast-audio/${encodeURIComponent(track)}`);
            this.renderPodcastAudioSettings(this.unwrapApiPayload(response, null));
            this.showToast('Podcast audio removed', 'success');
        } catch (error) {
            console.error('Error removing podcast audio:', error);
            this.showToast('Failed to remove podcast audio', 'error');
        }
    }

    renderPodcastAudioSettings(data = null) {
        if (!data) {
            return;
        }

        const folderLabel = document.getElementById('podcastAudioFolderLabel');
        if (folderLabel) {
            folderLabel.textContent = data.storageDirectory || 'Server state folder';
        }

        const tracks = data.tracks || (data.track ? { [data.track.track]: data.track } : {});
        const statusIds = {
            intro: 'podcastAudioIntroStatus',
            outro: 'podcastAudioOutroStatus',
            musicBed: 'podcastAudioMusicBedStatus',
        };

        Object.entries(statusIds).forEach(([track, id]) => {
            const status = document.getElementById(id);
            const removeButton = document.querySelector(`.podcast-audio-remove[data-track="${track}"]`);
            const asset = tracks[track];
            if (!status) {
                return;
            }

            if (asset?.configured) {
                const existsLabel = asset.exists === false ? 'missing on disk' : 'ready';
                const sizeLabel = asset.size ? `, ${this.formatBytes(asset.size)}` : '';
                status.textContent = `${asset.originalFilename || asset.filename || asset.path} (${existsLabel}${sizeLabel})`;
                removeButton?.removeAttribute('disabled');
            } else {
                status.textContent = 'No file uploaded';
                removeButton?.setAttribute('disabled', 'disabled');
            }
        });
    }

    renderStorageSettings(data = null) {
        if (!data) {
            return;
        }

        this.state.storage = data;
        const visibleKeys = new Set();
        this.setTextContent('storageTotalCount', Number(data.totalCount || 0).toLocaleString());
        this.setTextContent('storageTotalBytes', this.formatBytes(data.totalBytes || 0));
        this.setTextContent('storageDataDirectory', data.dataDirectory || 'Server state folder');

        const tableBody = document.getElementById('storageTableBody');
        if (!tableBody) {
            return;
        }

        const records = (Array.isArray(data.categories) ? data.categories : [])
            .flatMap((category) => (Array.isArray(category.records) ? category.records : [])
                .map((record) => ({
                    ...record,
                    categoryLabel: category.label || record.category,
                })))
            .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));

        records.slice(0, 150).forEach((record) => {
            visibleKeys.add(this.getStorageSelectionKey(record.category, record.id));
        });
        this.storageSelection = new Set([...this.storageSelection].filter((key) => visibleKeys.has(key)));

        if (records.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No managed artifacts found.</td></tr>';
            this.updateStorageSelectionControls();
            return;
        }

        tableBody.innerHTML = records.slice(0, 150).map((record) => {
            const selectionKey = this.getStorageSelectionKey(record.category, record.id);
            const selected = this.storageSelection.has(selectionKey);
            const downloadLink = record.downloadUrl
                ? `<a class="btn btn-ghost btn-sm storage-file-link" href="${this.escapeHtml(record.downloadUrl)}" target="_blank" rel="noopener">Download</a>`
                : '';
            const previewLink = record.previewUrl
                ? `<a class="btn btn-ghost btn-sm storage-file-link" href="${this.escapeHtml(record.previewUrl)}" target="_blank" rel="noopener">Preview</a>`
                : '';
            const metaParts = [
                record.sessionId,
                record.ownerId ? `owner ${record.ownerId}` : '',
                record.scopeKey ? `scope ${record.scopeKey}` : '',
                Number(record.messageCount || 0) ? `${Number(record.messageCount || 0).toLocaleString()} messages` : '',
                record.mimeType || record.format || '',
            ].filter(Boolean);
            const isChatSession = record.category === 'chatSessions';
            const deleteLabel = isChatSession ? 'Delete Chat' : 'Delete';
            const recordLabel = [
                record.filename || record.id,
                record.categoryLabel || record.category,
                record.updatedAt || record.createdAt ? `updated ${this.formatDate(record.updatedAt || record.createdAt)}` : '',
            ].filter(Boolean).join(', ');

            return `
                <tr class="${selected ? 'storage-row-selected' : ''}" data-storage-key="${this.escapeHtml(selectionKey)}">
                    <td class="storage-select-cell">
                        <input
                            type="checkbox"
                            class="storage-select-record"
                            aria-label="Select ${this.escapeHtml(recordLabel)}"
                            data-category="${this.escapeHtml(record.category)}"
                            data-id="${this.escapeHtml(record.id)}"
                            ${selected ? 'checked' : ''}
                        >
                    </td>
                    <td>
                        <div class="storage-file-name">${this.escapeHtml(record.filename || record.id)}</div>
                        <div class="storage-file-meta">${this.escapeHtml(metaParts.join(' | ') || record.id)}</div>
                    </td>
                    <td>${this.escapeHtml(record.categoryLabel || record.category)}</td>
                    <td>${this.escapeHtml(this.formatBytes(record.diskBytes || record.sizeBytes || 0))}</td>
                    <td>${this.escapeHtml(this.formatDate(record.updatedAt || record.createdAt))}</td>
                    <td>${this.escapeHtml(record.storage || 'local')}</td>
                    <td>
                        <div class="storage-row-actions">
                            ${previewLink}
                            ${downloadLink}
                            <button
                                type="button"
                                class="btn btn-ghost btn-sm storage-delete-file"
                                data-category="${this.escapeHtml(record.category)}"
                                data-id="${this.escapeHtml(record.id)}"
                                aria-label="${this.escapeHtml(`${deleteLabel} ${record.filename || record.id}`)}"
                            >${deleteLabel}</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        const selectAll = document.getElementById('storageSelectAll');
        if (selectAll) {
            selectAll.checked = visibleKeys.size > 0 && this.storageSelection.size === visibleKeys.size;
            selectAll.indeterminate = this.storageSelection.size > 0 && this.storageSelection.size < visibleKeys.size;
            selectAll.onchange = () => {
                if (selectAll.checked) {
                    this.storageSelection = new Set(visibleKeys);
                } else {
                    this.storageSelection.clear();
                }
                this.renderStorageSettings(this.state.storage);
            };
        }

        tableBody.querySelectorAll('.storage-select-record').forEach((checkbox) => {
            checkbox.addEventListener('change', () => {
                this.toggleStorageSelection(checkbox.dataset.category, checkbox.dataset.id, checkbox.checked);
            });
        });

        tableBody.querySelectorAll('tr[data-storage-key]').forEach((row) => {
            row.addEventListener('click', (event) => {
                if (event.target.closest('a, button, input')) {
                    return;
                }
                const checkbox = row.querySelector('.storage-select-record');
                if (!checkbox) {
                    return;
                }
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            });
        });

        tableBody.querySelectorAll('.storage-delete-file').forEach((button) => {
            button.addEventListener('click', () => {
                this.deleteStorageRecord(button.dataset.category, button.dataset.id);
            });
        });
        this.updateStorageSelectionControls();
    }

    getStorageSelectionKey(category, id) {
        return `${category || ''}::${id || ''}`;
    }

    parseStorageSelectionKey(key = '') {
        const divider = key.indexOf('::');
        if (divider < 0) {
            return null;
        }
        return {
            category: key.slice(0, divider),
            id: key.slice(divider + 2),
        };
    }

    toggleStorageSelection(category, id, selected) {
        const key = this.getStorageSelectionKey(category, id);
        if (selected) {
            this.storageSelection.add(key);
        } else {
            this.storageSelection.delete(key);
        }

        const row = document.querySelector(`tr[data-storage-key="${CSS.escape(key)}"]`);
        row?.classList.toggle('storage-row-selected', selected);
        this.updateStorageSelectionControls();
    }

    updateStorageSelectionControls() {
        const selectedCount = this.storageSelection.size;
        this.setTextContent('storageSelectionStatus', `${selectedCount.toLocaleString()} selected`);
        const deleteButton = document.getElementById('deleteSelectedStorageBtn');
        if (deleteButton) {
            deleteButton.disabled = selectedCount === 0;
            deleteButton.setAttribute(
                'aria-label',
                selectedCount === 0
                    ? 'Delete selected storage records'
                    : `Delete ${selectedCount.toLocaleString()} selected storage record${selectedCount === 1 ? '' : 's'}`,
            );
        }

        const visibleCheckboxes = Array.from(document.querySelectorAll('.storage-select-record'));
        const selectAll = document.getElementById('storageSelectAll');
        if (selectAll) {
            const checkedCount = visibleCheckboxes.filter((checkbox) => checkbox.checked).length;
            selectAll.checked = visibleCheckboxes.length > 0 && checkedCount === visibleCheckboxes.length;
            selectAll.indeterminate = checkedCount > 0 && checkedCount < visibleCheckboxes.length;
        }
    }

    async deleteSelectedStorageRecords() {
        const items = [...this.storageSelection]
            .map((key) => this.parseStorageSelectionKey(key))
            .filter(Boolean);

        if (items.length === 0) {
            this.showToast('Select chats or artifacts to delete first', 'info');
            return;
        }

        const chatCount = items.filter((item) => item.category === 'chatSessions').length;
        const artifactCount = items.length - chatCount;
        const warning = [
            `Delete ${items.length} selected item${items.length === 1 ? '' : 's'}?`,
            chatCount ? `${chatCount} chat${chatCount === 1 ? '' : 's'} will be permanently removed with messages, stored artifacts, and memory references.` : '',
            artifactCount ? `${artifactCount} artifact${artifactCount === 1 ? '' : 's'} or managed file${artifactCount === 1 ? '' : 's'} will be deleted.` : '',
            'Type yes to continue.',
        ].filter(Boolean).join('\n\n');

        if ((prompt(warning) || '').trim().toLowerCase() !== 'yes') {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/storage/bulk-delete', { items });
            const result = this.unwrapApiPayload(response, {});
            const deletedCount = Number(result.deletedCount || 0);
            const failedCount = Number(result.failedCount || 0);
            const deletedBytes = this.formatBytes(result.deletedBytes || 0);

            this.storageSelection.clear();
            if (failedCount > 0) {
                this.showToast(`Deleted ${deletedCount} selected items (${deletedBytes}); ${failedCount} failed`, 'warning', 7000);
            } else {
                this.showToast(`Deleted ${deletedCount} selected items (${deletedBytes})`, 'success');
            }
            await this.loadStorage();
        } catch (error) {
            console.error('Error deleting selected managed items:', error);
            this.showToast('Failed to delete selected items', 'error');
        }
    }

    async cleanupStorage({ dryRun = true } = {}) {
        const category = document.getElementById('storageCleanupCategory')?.value || '';
        const olderThanDays = Math.max(1, Number(document.getElementById('storageCleanupDays')?.value || 30));
        if (!dryRun && !confirm(`Delete managed artifacts older than ${olderThanDays} days?`)) {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/storage/cleanup', {
                category,
                olderThanDays,
                dryRun,
            });
            const result = this.unwrapApiPayload(response, {});
            const bytes = this.formatBytes(result.matchedBytes || 0);
            if (dryRun) {
                this.showToast(`Cleanup preview: ${result.matchedCount || 0} items, ${bytes}`, 'info', 6000);
            } else {
                this.showToast(`Deleted ${result.deletedCount || 0} items, ${bytes}`, 'success');
                await this.loadStorage();
            }
        } catch (error) {
            console.error('Error cleaning managed storage:', error);
            this.showToast('Storage cleanup failed', 'error');
        }
    }

    async clearAllStorage() {
        const warning = [
            'Clear all managed storage?',
            'This permanently deletes old chats, chat messages, stored documents, generated artifacts, generated audio, generated video, and memory references tied to those chats.',
            'Type yes to continue.',
        ].join('\n\n');
        if ((prompt(warning) || '').trim().toLowerCase() !== 'yes') {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/storage/cleanup', {
                clearAll: true,
                dryRun: false,
            });
            const result = this.unwrapApiPayload(response, {});
            this.storageSelection.clear();
            this.showToast(`Cleared ${result.deletedCount || 0} managed items`, 'success');
            await this.loadStorage();
        } catch (error) {
            console.error('Error clearing managed storage:', error);
            this.showToast('Failed to clear managed storage', 'error');
        }
    }

    async deleteStorageRecord(category, id) {
        const isChatSession = category === 'chatSessions';
        const message = isChatSession
            ? 'Permanently delete this old chat, its messages, stored artifacts, and memory references?'
            : 'Delete this managed artifact?';
        if (!category || !id || !confirm(message)) {
            return;
        }

        try {
            const response = await apiClient.delete(`/api/admin/storage/${encodeURIComponent(category)}/${encodeURIComponent(id)}`);
            const result = this.unwrapApiPayload(response, {});
            this.showToast(isChatSession ? 'Deleted old chat permanently' : `Deleted ${this.formatBytes(result.deletedBytes || 0)}`, 'success');
            await this.loadStorage();
        } catch (error) {
            console.error('Error deleting managed item:', error);
            this.showToast(isChatSession ? 'Failed to delete old chat' : 'Failed to delete managed artifact', 'error');
        }
    }
    
    async testConnection() {
        try {
            await apiClient.get('/api/admin/health');
            this.updateConnectionStatus(true);
            this.showToast('Connection successful', 'success');
        } catch (error) {
            this.updateConnectionStatus(false);
            this.showToast('Connection failed', 'error');
        }
    }
    
    togglePasswordVisibility(id) {
        const input = document.getElementById(id);
        if (input) {
            input.type = input.type === 'password' ? 'text' : 'password';
        }
    }
    
    confirmClearAllLogs() {
        if (confirm('Are you sure you want to clear all logs? This action cannot be undone.')) {
            this.clearLogs();
            this.showToast('All logs cleared', 'success');
        }
    }
    
    confirmResetConfig() {
        if (confirm('Are you sure you want to reset all settings to defaults?')) {
            apiClient.post('/api/admin/settings/reset')
                .then((response) => {
                    const settings = this.unwrapApiPayload(response, {});
                    this.applySettings(settings);
                    this.showToast('Settings reset to defaults', 'success');
                })
                .catch((error) => {
                    console.error('Error resetting settings:', error);
                    this.showToast('Failed to reset settings', 'error');
                });
        }
    }
    
    exportAllData() {
        const data = {
            settings: this.state.settings,
            prompts: this.state.prompts,
            logs: this.state.logs,
            exportedAt: new Date().toISOString()
        };
        
        this.downloadFile(
            JSON.stringify(data, null, 2),
            `dashboard-export-${Date.now()}.json`,
            'application/json'
        );
    }
    
    async updateFeatureToggle(featureId, enabled) {
        try {
            await apiClient.put('/api/admin/settings', {
                features: {
                    [featureId]: enabled
                }
            });
            this.showToast(`Feature ${enabled ? 'enabled' : 'disabled'}`, 'success');
        } catch (error) {
            this.showToast('Failed to update feature toggle', 'error');
        }
    }
    
    // ==================== HELPERS ====================
    
    updateConnectionStatus(connected) {
        const status = document.getElementById('connectionStatus');
        const dot = document.querySelector('#connectionStatus .status-dot');
        const text = document.querySelector('#connectionStatus .status-text');
        const label = connected ? 'Connected' : 'Disconnected';
        
        if (dot && text) {
            dot.classList.toggle('online', connected);
            dot.classList.toggle('offline', !connected);
            text.textContent = label;
        }

        if (status) {
            status.setAttribute('aria-label', `Dashboard connection status: ${label}`);
        }
    }

    unwrapApiPayload(response, fallback = null) {
        if (response == null) return fallback;
        if (typeof response === 'object' && 'success' in response && 'data' in response) {
            return response.data ?? fallback;
        }
        return response;
    }

    setInputValue(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.value = value;
        }
    }

    getApiPagination(response) {
        if (response && typeof response === 'object' && response.pagination) {
            return response.pagination;
        }
        return null;
    }

    normalizeOverviewStats(payload = {}) {
        const overview = payload.overview || {};
        const tokens = payload.tokens || {};
        const requestChart = payload.requests?.chart || {};
        return {
            totalTasks: Number(overview.totalTasks || payload.totalTasks || 0),
            successRate: Number(overview.successRate || payload.successRate || 0),
            activeSessions: Number(overview.activeSessions || payload.activeSessions || 0),
            skillsUsed: Number(overview.skillsUsed || overview.totalSkillUses || payload.skillsUsed || 0),
            skillsUsedThisWeek: Number(overview.skillsUsedThisWeek || payload.skillsUsedThisWeek || payload.skills?.thisWeek || 0),
            tokensTotal: Number(tokens.total || 0),
            tokensPrompt: Number(tokens.prompt || 0),
            tokensCompletion: Number(tokens.completion || 0),
            tokensRequests: Number(tokens.requests || 0),
            tokensInferredRequests: Number(tokens.inferredRequests || 0),
            tokensSource: String(tokens.source || 'runtime'),
            requestChart: {
                range: requestChart.range || '24h',
                labels: Array.isArray(requestChart.labels) ? requestChart.labels : [],
                values: Array.isArray(requestChart.values) ? requestChart.values : [],
            },
        };
    }

    renderOverviewTokenUsage(stats = {}) {
        const total = Number(stats.tokensTotal || 0);
        const prompt = Number(stats.tokensPrompt || 0);
        const completion = Number(stats.tokensCompletion || 0);
        const requests = Number(stats.tokensRequests || 0);
        const inferred = Number(stats.tokensInferredRequests || 0);
        const source = String(stats.tokensSource || 'runtime');

        const totalElement = document.getElementById('overviewTokenTotal');
        const promptElement = document.getElementById('overviewTokenPrompt');
        const completionElement = document.getElementById('overviewTokenCompletion');
        const metaElement = document.getElementById('overviewTokenMeta');
        const sourceElement = document.getElementById('tokenUsageSource');

        if (totalElement) totalElement.textContent = this.formatCompactNumber(total);
        if (promptElement) promptElement.textContent = prompt.toLocaleString();
        if (completionElement) completionElement.textContent = completion.toLocaleString();
        if (sourceElement) {
            sourceElement.textContent = source === 'logs' ? 'Persisted logs' : 'Runtime';
            sourceElement.className = `status-badge ${inferred > 0 ? 'warning' : 'neutral'}`;
        }
        if (metaElement) {
            metaElement.textContent = requests > 0
                ? `${requests.toLocaleString()} completed requests${inferred > 0 ? `, ${inferred.toLocaleString()} estimated` : ', exact gateway usage'}`
                : 'No completed requests yet.';
        }
    }

    normalizeAdminWorkload(workload = {}) {
        return {
            ...workload,
            enabled: workload.enabled !== false,
            workloadSummary: workload.workloadSummary || {
                queued: 0,
                running: 0,
                failed: 0,
            },
        };
    }

    normalizeAdminRun(run = {}, workloads = this.state.workloads) {
        const workloadMap = new Map((workloads || []).map((workload) => [workload.id, workload]));
        const linkedWorkload = run.workload || workloadMap.get(run.workloadId) || null;

        return {
            ...run,
            workloadTitle: linkedWorkload?.title || run.workloadTitle || '',
            workloadId: run.workloadId || linkedWorkload?.id || '',
            status: String(run.status || 'queued').toLowerCase(),
            reason: run.reason || 'manual',
            stageIndex: Number.isFinite(Number(run.stageIndex)) ? Number(run.stageIndex) : -1,
            metadata: run.metadata || {},
            error: run.error || null,
            trace: run.trace || null,
        };
    }

    describeAdminTrigger(trigger = {}) {
        if (!trigger || trigger.type === 'manual') {
            return 'manual';
        }
        if (trigger.type === 'once') {
            return `once @ ${this.formatDate(trigger.runAt)}`;
        }
        if (trigger.type === 'cron') {
            return `${trigger.expression || 'cron'} (${trigger.timezone || 'UTC'})`;
        }
        return trigger.type || 'manual';
    }

    getRunStatusClass(status = '') {
        switch (String(status || '').toLowerCase()) {
            case 'completed':
                return 'healthy';
            case 'running':
                return 'info';
            case 'queued':
                return 'warning';
            case 'failed':
            case 'cancelled':
                return 'error';
            default:
                return 'neutral';
        }
    }

    formatRunStageLabel(stageIndex) {
        const normalized = Number(stageIndex);
        if (!Number.isFinite(normalized) || normalized < 0) {
            return 'base run';
        }
        return `stage ${normalized + 1}`;
    }

    replaceAdminRunInState(run = null) {
        if (!run?.id) {
            return;
        }

        const index = this.state.runs.findIndex((entry) => entry.id === run.id);
        if (index >= 0) {
            this.state.runs[index] = run;
        } else {
            this.state.runs.unshift(run);
        }

        if (this.state.selectedRun?.id === run.id) {
            this.state.selectedRun = run;
        }
    }

    sanitizeFilenameSegment(value = '', fallback = 'run') {
        const normalized = String(value || '')
            .trim()
            .replace(/[^a-z0-9._-]+/gi, '-')
            .replace(/-+/g, '-')
            .replace(/^[-_.]+|[-_.]+$/g, '');

        return normalized || fallback;
    }

    buildAdminRunTraceExport(run = {}) {
        return {
            exportedAt: new Date().toISOString(),
            source: 'kimibuilt-admin-dashboard',
            run: {
                id: run.id || null,
                workloadId: run.workloadId || null,
                workloadTitle: run.workloadTitle || run.workload?.title || null,
                sessionId: run.sessionId || null,
                status: run.status || null,
                reason: run.reason || null,
                scheduledFor: run.scheduledFor || null,
                startedAt: run.startedAt || null,
                finishedAt: run.finishedAt || null,
                stageIndex: Number.isFinite(Number(run.stageIndex)) ? Number(run.stageIndex) : null,
                stageLabel: this.formatRunStageLabel(run.stageIndex),
                attempt: Number.isFinite(Number(run.attempt)) ? Number(run.attempt) : null,
                parentRunId: run.parentRunId || null,
                responseId: run.responseId || null,
                prompt: run.prompt || '',
            },
            error: run.error || null,
            metadata: run.metadata || {},
            trace: run.trace || null,
        };
    }

    async downloadAdminRunTraceJson(event, runId = null) {
        event?.stopPropagation?.();

        const targetRunId = String(runId || this.state.selectedRun?.id || '').trim();
        if (!targetRunId) {
            this.showToast('Select a run before downloading trace JSON', 'warning');
            return;
        }

        const existingRun = this.state.runs.find((run) => run.id === targetRunId)
            || (this.state.selectedRun?.id === targetRunId ? this.state.selectedRun : null);

        let run = existingRun;

        try {
            const response = await apiClient.getAdminRun(targetRunId);
            const detailedRun = this.normalizeAdminRun(this.unwrapApiPayload(response, existingRun || {}), this.state.workloads);
            this.replaceAdminRunInState(detailedRun);
            run = detailedRun;
            if (this.state.selectedRun?.id === targetRunId) {
                this.renderAdminRuns(this.state.runs);
                this.renderAdminRunDetails(detailedRun);
            }
        } catch (error) {
            console.error('Error loading trace export payload:', error);
            if (!run) {
                this.showToast(error.userMessage || error.message || 'Failed to load run details', 'error');
                return;
            }
        }

        if (!run?.trace) {
            this.showToast('Trace JSON is not available for this run yet', 'warning');
            return;
        }

        const exportPayload = this.buildAdminRunTraceExport(run);
        const filename = [
            this.sanitizeFilenameSegment(run.workloadTitle || run.workloadId || 'workload', 'workload'),
            this.sanitizeFilenameSegment(run.id || 'run', 'run'),
            'trace',
        ].join('-') + '.json';

        this.downloadFile(
            JSON.stringify(exportPayload, null, 2),
            filename,
            'application/json',
        );
        this.showToast(`Downloaded trace JSON for ${run.id}`, 'success');
    }

    stringifyAdminPayload(value) {
        if (value == null || value === '') {
            return '(none)';
        }

        if (typeof value === 'string') {
            return value;
        }

        try {
            return JSON.stringify(value, null, 2);
        } catch (_error) {
            return String(value);
        }
    }

    renderRequestChart(chart = {}) {
        if (!this.charts.requestVolume) {
            return;
        }

        this.charts.requestVolume.labels = Array.isArray(chart.labels) ? chart.labels : [];
        this.charts.requestVolume.values = Array.isArray(chart.values) ? chart.values : [];
        this.drawRequestVolumeChart();
    }

    drawRequestVolumeChart() {
        const chart = this.charts.requestVolume;
        const canvas = chart?.canvas;
        if (!canvas) {
            return;
        }

        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.max(320, Math.round(rect.width || canvas.clientWidth || 640));
        const cssHeight = Math.max(220, Math.round(rect.height || canvas.clientHeight || 320));
        const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);

        if (canvas.width !== Math.round(cssWidth * devicePixelRatio) || canvas.height !== Math.round(cssHeight * devicePixelRatio)) {
            canvas.width = Math.round(cssWidth * devicePixelRatio);
            canvas.height = Math.round(cssHeight * devicePixelRatio);
        }

        context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        context.clearRect(0, 0, cssWidth, cssHeight);

        const labels = Array.isArray(chart.labels) ? chart.labels : [];
        const values = Array.isArray(chart.values) ? chart.values.map((value) => Number(value) || 0) : [];
        const leftPad = 40;
        const rightPad = 16;
        const topPad = 16;
        const bottomPad = 28;
        const plotWidth = Math.max(1, cssWidth - leftPad - rightPad);
        const plotHeight = Math.max(1, cssHeight - topPad - bottomPad);
        const maxValue = Math.max(1, ...values);
        const gridLines = 4;

        context.strokeStyle = '#21262d';
        context.lineWidth = 1;
        for (let index = 0; index <= gridLines; index += 1) {
            const y = topPad + (plotHeight / gridLines) * index;
            context.beginPath();
            context.moveTo(leftPad, y);
            context.lineTo(cssWidth - rightPad, y);
            context.stroke();
        }

        context.fillStyle = '#6e7681';
        context.font = '11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        for (let index = 0; index <= gridLines; index += 1) {
            const value = Math.round(maxValue - (maxValue / gridLines) * index);
            const y = topPad + (plotHeight / gridLines) * index;
            context.fillText(String(value), leftPad - 8, y);
        }

        if (!values.length) {
            context.fillStyle = '#6e7681';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.font = '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            context.fillText('No request volume data yet.', cssWidth / 2, cssHeight / 2);
            return;
        }

        const stepX = values.length > 1 ? plotWidth / (values.length - 1) : 0;
        const points = values.map((value, index) => ({
            x: leftPad + (stepX * index),
            y: topPad + plotHeight - ((Math.max(0, value) / maxValue) * plotHeight),
        }));

        context.beginPath();
        points.forEach((point, index) => {
            if (index === 0) {
                context.moveTo(point.x, point.y);
            } else {
                context.lineTo(point.x, point.y);
            }
        });
        context.lineTo(leftPad + plotWidth, topPad + plotHeight);
        context.lineTo(leftPad, topPad + plotHeight);
        context.closePath();
        context.fillStyle = 'rgba(88, 166, 255, 0.12)';
        context.fill();

        context.beginPath();
        points.forEach((point, index) => {
            if (index === 0) {
                context.moveTo(point.x, point.y);
            } else {
                context.lineTo(point.x, point.y);
            }
        });
        context.strokeStyle = '#58a6ff';
        context.lineWidth = 2;
        context.stroke();

        context.fillStyle = '#58a6ff';
        points.forEach((point) => {
            context.beginPath();
            context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
            context.fill();
        });

        context.fillStyle = '#6e7681';
        context.textAlign = 'center';
        context.textBaseline = 'top';
        context.font = '11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const labelCount = Math.min(6, labels.length);
        if (labelCount === 1) {
            context.fillText(String(labels[0] || ''), leftPad + (plotWidth / 2), cssHeight - bottomPad + 8);
            return;
        }

        for (let index = 0; index < labelCount; index += 1) {
            const labelIndex = Math.round((index / (labelCount - 1)) * (labels.length - 1));
            const x = leftPad + ((labels.length > 1 ? labelIndex / (labels.length - 1) : 0.5) * plotWidth);
            context.fillText(String(labels[labelIndex] || ''), x, cssHeight - bottomPad + 8);
        }
    }

    normalizeModel(model = {}) {
        return {
            ...model,
            provider: model.provider || model.owned_by || 'unknown',
            active: Boolean(model.active ?? model.isActive ?? model.isDefault),
            requests: Number(model.requests || 0),
            avgLatency: Number(model.avgLatency || model.avgResponseTime || 0),
            inputTokens: Number(model.inputTokens ?? model.tokens?.input ?? 0),
            outputTokens: Number(model.outputTokens ?? model.tokens?.output ?? 0),
            totalTokens: Number(model.totalTokens ?? model.tokens?.total ?? 0)
                || (Number(model.inputTokens ?? model.tokens?.input ?? 0) + Number(model.outputTokens ?? model.tokens?.output ?? 0)),
        };
    }

    normalizeSkill(skill = {}) {
        const stats = skill.stats || {};
        return {
            ...skill,
            enabled: Boolean(skill.enabled ?? skill.isEnabled),
            usageCount: Number(stats.usageCount ?? stats.invocations ?? skill.usageCount ?? 0),
            successRate: Number(stats.successRate ?? skill.successRate ?? 0),
            avgDuration: Number(stats.avgDuration || 0),
            lastUsed: stats.lastUsed || null,
            recentUsage: Array.isArray(stats.recentUsage) ? stats.recentUsage : [],
            byRoute: stats.byRoute || {},
            byModel: stats.byModel || {},
            byExecutionProfile: stats.byExecutionProfile || {},
        };
    }

    normalizeTool(tool = {}, skill = null) {
        const supportMeta = tool.support && typeof tool.support === 'object'
            ? tool.support
            : { status: tool.support || 'unknown', notes: [] };

        return {
            ...tool,
            id: tool.id || tool.name || 'unknown-tool',
            name: tool.name || tool.id || 'Unknown Tool',
            description: tool.description || 'No description available.',
            category: (tool.category || 'uncategorized').toLowerCase(),
            support: String(supportMeta.status || 'unknown').toLowerCase(),
            supportNotes: Array.isArray(supportMeta.notes) ? supportMeta.notes : [],
            docAvailable: Boolean(tool.docAvailable),
            enabled: skill ? Boolean(skill.enabled) : null,
            usageCount: Number(skill?.usageCount || 0),
            successRate: Number(skill?.successRate || 0),
            avgDuration: Number(skill?.avgDuration || 0),
            lastUsed: skill?.lastUsed || null,
            recentUsage: Array.isArray(skill?.recentUsage) ? skill.recentUsage : [],
            byRoute: skill?.byRoute || {},
            byModel: skill?.byModel || {},
            byExecutionProfile: skill?.byExecutionProfile || {},
            triggerPatterns: skill?.triggerPatterns || [],
            requiresConfirmation: Boolean(skill?.requiresConfirmation),
        };
    }

    normalizeLog(log = {}) {
        return {
            ...log,
            level: log.level || 'info',
            model: log.model || '-',
            prompt: log.prompt || log.message || '-',
            latency: Number(log.latency || log.duration || 0),
            status: log.status || (log.error ? 'error' : 'success'),
        };
    }

    normalizeTrace(trace = {}) {
        const rawSteps = Array.isArray(trace.steps)
            ? trace.steps
            : Array.isArray(trace.timeline)
                ? trace.timeline
                : [];
        const steps = rawSteps.map((step, index) => ({
            name: step.name || step.type || `Step ${index + 1}`,
            offset: step.offset || step.duration || 0,
            status: step.status === 'completed' ? 'success' : (step.status || 'info'),
            details: this.normalizeTraceDetails(step.details),
        }));

        return {
            ...trace,
            name: trace.name || trace.objective || trace.input || trace.taskId || trace.id,
            startedAt: trace.startedAt || trace.startTime || trace.createdAt,
            duration: Number(trace.duration || 0),
            steps,
        };
    }

    normalizeActivity(activity = {}) {
        const typeMap = {
            task_completed: 'success',
            task_failed: 'error',
            task_cancelled: 'warning',
            task_created: 'info',
            session_cleared: 'info',
            tool_invoked: activity.metadata?.success === false ? 'warning' : 'info',
        };

        const metaParts = [this.formatDate(activity.timestamp)];
        if (activity.type === 'tool_invoked') {
            if (activity.metadata?.route) {
                metaParts.push(activity.metadata.route);
            }
            if (activity.metadata?.executionProfile) {
                metaParts.push(activity.metadata.executionProfile);
            }
        }

        return {
            type: typeMap[activity.type] || 'info',
            title: activity.description || activity.title || activity.type || 'Activity',
            meta: metaParts.filter(Boolean).join(' | '),
        };
    }

    renderSkillCategories(tools = []) {
        const container = document.getElementById('skillCategories');
        if (!container) return;

        const counts = tools.reduce((acc, tool) => {
            acc[tool.category] = (acc[tool.category] || 0) + 1;
            return acc;
        }, {});
        const activeCategory = document.querySelector('#skillCategories .category-btn.active')?.dataset.category || 'all';
        const categories = ['all', ...Object.keys(counts).sort()];

        container.innerHTML = categories.map((category) => {
            const count = category === 'all' ? tools.length : counts[category] || 0;
            const label = category === 'all'
                ? 'All'
                : category.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
            return `
                <button class="category-btn ${activeCategory === category ? 'active' : ''}" data-category="${this.escapeHtml(category)}">
                    ${this.escapeHtml(label)} <span class="category-count">${count}</span>
                </button>
            `;
        }).join('');
    }

    renderToolSummary(tools = []) {
        const container = document.getElementById('toolSummaryGrid');
        if (!container) return;

        const setup = tools.filter((tool) => tool.support === 'requires_setup').length;
        const docs = tools.filter((tool) => tool.docAvailable).length;
        const invokedTools = tools.filter((tool) => Number(tool.usageCount || 0) > 0).length;
        const totalCalls = tools.reduce((sum, tool) => sum + Number(tool.usageCount || 0), 0);

        container.innerHTML = [
            { label: 'Registered Tools', value: tools.length, tone: 'info' },
            { label: 'Invoked Tools', value: invokedTools, tone: 'success' },
            { label: 'Total Calls', value: totalCalls, tone: 'accent' },
            { label: 'Requires Setup', value: setup, tone: 'warning' },
            { label: 'Docs Ready', value: docs, tone: 'info' },
        ].map((item) => `
            <div class="tool-summary-card ${item.tone}">
                <span class="tool-summary-value">${item.value}</span>
                <span class="tool-summary-label">${item.label}</span>
            </div>
        `).join('');
    }

    getFilteredTools(query = null) {
        const searchValue = (query ?? document.getElementById('skillSearch')?.value ?? '').trim().toLowerCase();
        const category = document.querySelector('#skillCategories .category-btn.active')?.dataset.category || 'all';
        const support = document.getElementById('toolSupportFilter')?.value || 'all';

        return this.state.tools.filter((tool) => {
            if (category !== 'all' && tool.category !== category) {
                return false;
            }
            if (support !== 'all' && tool.support !== support) {
                return false;
            }
            if (!searchValue) {
                return true;
            }

            return [
                tool.name,
                tool.id,
                tool.description,
                tool.category,
                tool.support,
            ].some((value) => String(value || '').toLowerCase().includes(searchValue));
        });
    }

    selectTool(id) {
        const tool = this.state.tools.find((item) => item.id === id);
        if (!tool) {
            this.showToast('Tool not found', 'error');
            return;
        }

        this.state.selectedToolId = id;
        this.renderSkills(this.getFilteredTools());
        this.renderToolDetail(tool);
    }

    async loadToolDocumentation(id, forceReload = false) {
        const tool = this.state.tools.find((item) => item.id === id);
        if (!tool) {
            this.showToast('Tool not found', 'error');
            return;
        }

        this.state.selectedToolId = id;
        this.renderSkills(this.getFilteredTools());

        if (!tool.docAvailable) {
            this.renderToolDetail(tool);
            this.showToast('No tool documentation is available for this tool', 'info');
            return;
        }

        if (!forceReload && this.state.toolDocs[id]) {
            this.renderToolDetail(tool);
            return;
        }

        const detail = document.getElementById('toolDetail');
        if (detail) {
            detail.innerHTML = '<p class="empty-state">Loading tool documentation...</p>';
        }

        try {
            const response = await apiClient.getToolDocumentation(id);
            this.state.toolDocs[id] = this.unwrapApiPayload(response, {});
            this.renderToolDetail(tool);
        } catch (error) {
            console.error(`Error loading tool documentation for ${id}:`, error);
            this.showToast('Failed to load tool documentation', 'error');
            this.renderToolDetail(tool);
        }
    }

    renderToolDetail(tool) {
        const container = document.getElementById('toolDetail');
        if (!container) return;

        if (!tool) {
            container.innerHTML = '<p class="empty-state">Select a tool to inspect setup requirements, skill wiring, and docs.</p>';
            return;
        }

        const doc = this.state.toolDocs[tool.id];
        const supportText = this.formatSupportDescription(tool.support);
        const supportNotesMarkup = tool.supportNotes?.length
            ? `
                <div class="tool-detail-section">
                    <h4>Support Notes</h4>
                    <ul class="tool-note-list">
                        ${tool.supportNotes.map((note) => `<li>${this.escapeHtml(note)}</li>`).join('')}
                    </ul>
                </div>
            `
            : '';
        const triggerMarkup = tool.triggerPatterns?.length
            ? `<div class="tool-detail-section"><h4>Trigger Patterns</h4><p>${this.escapeHtml(tool.triggerPatterns.join(', '))}</p></div>`
            : '';
        const recentUsageMarkup = tool.recentUsage?.length
            ? `
                <div class="tool-detail-section">
                    <h4>Recent Usage</h4>
                    <div class="tool-usage-list">
                        ${tool.recentUsage.slice(0, 8).map((entry) => `
                            <div class="tool-usage-item">
                                <div class="tool-usage-meta">
                                    <span>${this.escapeHtml(this.formatDate(entry.timestamp))}</span>
                                    <span>${this.escapeHtml(entry.route || 'runtime')}</span>
                                    <span>${this.escapeHtml(entry.executionProfile || 'default')}</span>
                                    <span>${entry.success === false ? 'error' : 'success'}</span>
                                </div>
                                <div class="tool-usage-meta">
                                    <span>${entry.duration ? `${entry.duration}ms` : '0ms'}</span>
                                    <span>${this.escapeHtml((entry.paramKeys || []).join(', ') || 'no params')}</span>
                                </div>
                                ${entry.error ? `<div class="tool-usage-error">${this.escapeHtml(entry.error)}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `
            : '<div class="tool-detail-section"><h4>Recent Usage</h4><p class="tool-doc-placeholder">No invocations recorded yet.</p></div>';
        const docMarkup = doc?.content
            ? `<div class="tool-doc-content"><pre>${this.escapeHtml(doc.content)}</pre></div>`
            : `<p class="tool-doc-placeholder">${tool.docAvailable ? 'Docs are available on demand. Load them only when you need setup or usage detail.' : 'No tool doc file is registered for this tool.'}</p>`;

        container.innerHTML = `
            <div class="tool-detail-header">
                <div>
                    <h3>${this.escapeHtml(tool.name)}</h3>
                    <p class="tool-detail-subtitle">${this.escapeHtml(tool.id)} - ${this.escapeHtml(tool.category)}</p>
                </div>
                <span class="support-badge ${this.escapeHtml(tool.support)}">${this.escapeHtml(this.formatSupportLabel(tool.support))}</span>
            </div>
            <p class="tool-detail-description">${this.escapeHtml(tool.description)}</p>
            <div class="tool-detail-meta">
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Skill State</span>
                    <span class="tool-detail-value">${tool.enabled === null ? 'Registry only' : (tool.enabled ? 'Enabled' : 'Disabled')}</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Support</span>
                    <span class="tool-detail-value">${this.escapeHtml(supportText)}</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Docs</span>
                    <span class="tool-detail-value">${tool.docAvailable ? 'Available' : 'Not published'}</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Requires Confirmation</span>
                    <span class="tool-detail-value">${tool.requiresConfirmation ? 'Yes' : 'No'}</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Invocations</span>
                    <span class="tool-detail-value">${(tool.usageCount || 0).toLocaleString()}</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Average Duration</span>
                    <span class="tool-detail-value">${tool.avgDuration || 0}ms</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Success Rate</span>
                    <span class="tool-detail-value">${tool.successRate || 0}%</span>
                </div>
                <div class="tool-detail-item">
                    <span class="tool-detail-label">Last Used</span>
                    <span class="tool-detail-value">${tool.lastUsed ? this.escapeHtml(this.formatDate(tool.lastUsed)) : 'Never'}</span>
                </div>
            </div>
            ${triggerMarkup}
            ${supportNotesMarkup}
            ${recentUsageMarkup}
            <div class="tool-detail-section">
                <h4>Documentation</h4>
                ${docMarkup}
            </div>
            <div class="tool-detail-actions">
                ${tool.docAvailable ? `<button class="btn btn-sm btn-secondary" onclick="dashboard.loadToolDocumentation('${tool.id}', true)">${doc?.content ? 'Reload Docs' : 'Load Docs'}</button>` : ''}
                ${tool.enabled === null ? '' : `<button class="btn btn-sm btn-ghost" onclick="dashboard.toggleSkill('${tool.id}')">${tool.enabled ? 'Disable Skill' : 'Enable Skill'}</button>`}
            </div>
        `;
    }

    formatSupportLabel(support) {
        return String(support || 'unknown')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    formatSupportDescription(support) {
        switch (support) {
            case 'stable':
                return 'Ready for normal agent use';
            case 'requires_setup':
                return 'Needs secrets, host config, or runtime prerequisites';
            case 'experimental':
                return 'Available but not production-ready';
            default:
                return 'Support level has not been classified';
        }
    }

    getToolCategoryIcon(category) {
        const icons = {
            web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 010 20"/><path d="M12 2a15 15 0 000 20"/></svg>',
            ssh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
            sandbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
            database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>',
            design: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
            system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
        };

        return icons[category] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4-1.4l7-7a1 1 0 011.4 0z"/><path d="M17 7h.01"/><path d="M12 3l9 9-9 9-9-9 9-9z"/></svg>';
    }

    renderSystemHealth(health, latency, error = null) {
        const statusEl = document.getElementById('systemHealthStatus');
        const apiLatencyFill = document.getElementById('healthApiLatencyFill');
        const apiLatencyValue = document.getElementById('healthApiLatencyValue');
        const sdkFill = document.getElementById('healthSdkFill');
        const sdkValue = document.getElementById('healthSdkValue');
        const memoryFill = document.getElementById('healthMemoryFill');
        const memoryValue = document.getElementById('healthMemoryValue');
        const vectorFill = document.getElementById('healthVectorFill');
        const vectorValue = document.getElementById('healthVectorValue');

        if (!statusEl || !apiLatencyFill || !apiLatencyValue || !sdkFill || !sdkValue || !memoryFill || !memoryValue || !vectorFill || !vectorValue) {
            return;
        }

        if (error || !health) {
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'status-badge error';
            apiLatencyFill.style.width = '0%';
            apiLatencyValue.textContent = '--';
            sdkFill.style.width = '0%';
            sdkValue.textContent = 'offline';
            memoryFill.style.width = '0%';
            memoryValue.textContent = '--';
            vectorFill.style.width = '0%';
            vectorValue.textContent = 'offline';
            return;
        }

        const status = health.status || 'unknown';
        statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
        statusEl.className = `status-badge ${status === 'healthy' ? 'healthy' : (status === 'degraded' ? 'warning' : 'error')}`;

        const memoryBytes = Number(health.memory?.heapUsed || 0);
        const memoryMb = Math.round(memoryBytes / (1024 * 1024));
        const memoryPercent = Math.max(0, Math.min(100, Math.round((memoryBytes / Math.max(Number(health.memory?.heapTotal || 1), 1)) * 100)));
        const apiPercent = Math.max(5, Math.min(100, Math.round((Number(latency || 0) / 500) * 100)));
        const sdkConnected = health.services?.sdk === 'connected';
        const vectorConnected = health.services?.vectorStore === 'connected';

        apiLatencyFill.style.width = `${apiPercent}%`;
        apiLatencyValue.textContent = `${Number(latency || 0)}ms`;
        sdkFill.style.width = sdkConnected ? '100%' : '20%';
        sdkValue.textContent = health.services?.sdk || 'unknown';
        memoryFill.style.width = `${memoryPercent}%`;
        memoryValue.textContent = `${memoryMb} MB`;
        vectorFill.style.width = vectorConnected ? '100%' : '20%';
        vectorValue.textContent = health.services?.vectorStore || 'unknown';
    }
    
    addRealtimeLog(log) {
        if (this.state.logsPaused) return;
        
        this.state.logs.unshift(log);
        if (this.state.logs.length > 1000) {
            this.state.logs.pop();
        }
        
        if (this.state.currentView === 'logs') {
            this.renderLogs(this.state.logs);
        }
        
        // Update badge
        const badge = document.getElementById('logsBadge');
        if (badge) {
            badge.textContent = parseInt(badge.textContent || 0) + 1;
            badge.style.display = 'inline';
        }
    }
    
    updateStats(stats) {
        this.state.stats = { ...this.state.stats, ...stats };
        this.loadStats();
    }
    
    updateTrace(trace) {
        const index = this.state.traces.findIndex(t => t.id === trace.id);
        if (index !== -1) {
            this.state.traces[index] = trace;
        } else {
            this.state.traces.unshift(trace);
        }
        
        if (this.state.currentView === 'traces') {
            this.renderTraces(this.state.traces);
        }
    }
    
    updateChartTimeRange(range) {
        this.loadStats();
    }
    
    handleGlobalSearch(query) {
        if (!query) return;
        
        // Search across all data
        const results = {
            prompts: this.state.prompts.filter(p => 
                p.name.toLowerCase().includes(query.toLowerCase())
            ),
            skills: this.state.tools.filter(s => 
                s.name.toLowerCase().includes(query.toLowerCase()) ||
                s.id.toLowerCase().includes(query.toLowerCase())
            ),
            logs: this.state.logs.filter(l => 
                l.prompt?.toLowerCase().includes(query.toLowerCase())
            )
        };
        
        // Show results count in toast
        const total = Object.values(results).reduce((a, b) => a + b.length, 0);
        if (total > 0) {
            this.showToast(`Found ${total} results`, 'info');
        }
    }
    
    handleResize() {
        if (!this.isMobileNavigation()) {
            this.closeMobileNavigation();
            document.getElementById('sidebarToggle')?.setAttribute('aria-label', 'Collapse admin navigation');
            document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(!this.state.sidebarCollapsed));
        }

        // Resize charts
        Object.values(this.charts).forEach(chart => {
            chart?.resize();
        });
    }
    
    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
        toast.setAttribute('aria-atomic', 'true');
        
        const icons = {
            success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
            error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };
        
        toast.innerHTML = `
            <div class="toast-icon">${icons[type]}</div>
            <div class="toast-content">
                <span class="toast-title"></span>
            </div>
            <button class="toast-close" type="button" aria-label="Dismiss ${this.escapeHtml(type)} notification">&times;</button>
        `;

        toast.querySelector('.toast-title').textContent = message;

        let dismissTimer = null;
        const dismissToast = () => {
            if (!toast.isConnected || toast.classList.contains('hiding')) {
                return;
            }
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        };
        const startDismissTimer = () => {
            if (duration <= 0) {
                return;
            }
            dismissTimer = setTimeout(dismissToast, duration);
        };

        toast.querySelector('.toast-close').addEventListener('click', dismissToast);
        toast.querySelector('.toast-close').addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                dismissToast();
            }
        });
        toast.addEventListener('focusin', () => {
            if (dismissTimer) {
                clearTimeout(dismissTimer);
                dismissTimer = null;
            }
        });
        toast.addEventListener('focusout', startDismissTimer);
        
        container.appendChild(toast);
        startDismissTimer();
    }
    
    // ==================== UTILITY METHODS ====================
    
    formatDate(date) {
        if (!date) return 'Unknown';
        const d = new Date(date);
        if (Number.isNaN(d.getTime())) {
            return String(date);
        }
        const now = new Date();
        const diff = now - d;
        const futureDiff = d - now;

        if (futureDiff > 0) {
            if (futureDiff < 60000) return 'in under 1m';
            if (futureDiff < 3600000) return `in ${Math.ceil(futureDiff / 60000)}m`;
            if (futureDiff < 86400000) return `in ${Math.ceil(futureDiff / 3600000)}h`;
            return d.toLocaleString();
        }
        
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        
        return d.toLocaleDateString();
    }

    toDatetimeLocal(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '';
        }

        const offsetMs = date.getTimezoneOffset() * 60 * 1000;
        return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
    }
    
    formatTime(date) {
        if (!date) return '--:--';
        return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    
    truncate(str, length) {
        if (!str) return '';
        return str.length > length ? str.substring(0, length) + '...' : str;
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatCompanyActionHandler(target = '', runId = '', actionKey = '') {
        const args = [target, runId, actionKey].map((value) => JSON.stringify(String(value || '')));
        return this.escapeAttribute(`dashboard.handleCompanyAction(${args.join(', ')})`);
    }

    escapeAttribute(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    handleListItemKeydown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        if (event.target !== event.currentTarget) {
            return;
        }

        const item = event.currentTarget;
        const id = item.dataset.id;
        event.preventDefault();

        switch (item.dataset.dashboardListAction) {
            case 'prompt':
                this.selectPromptById(id);
                break;
            case 'trace':
                this.selectTrace(id);
                break;
            case 'admin-run':
                this.selectAdminRun(id);
                break;
            default:
                break;
        }
    }

    setTextContent(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    }
    
    generateTimeLabels(count) {
        const labels = [];
        const now = new Date();
        for (let i = count - 1; i >= 0; i--) {
            const d = new Date(now - i * 3600000);
            labels.push(d.getHours() + ':00');
        }
        return labels;
    }
    
    generateRandomData(count, min, max) {
        return Array.from({ length: count }, () => 
            Math.floor(Math.random() * (max - min + 1)) + min
        );
    }
    
    convertToCSV(data) {
        if (!data.length) return '';
        const headers = Object.keys(data[0]);
        const rows = data.map(row => 
            headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(',')
        );
        return [headers.join(','), ...rows].join('\n');
    }
    
    downloadFile(content, filename, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) {
            return `${value} B`;
        }
        const units = ['KB', 'MB', 'GB'];
        let size = value / 1024;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex += 1;
        }
        return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
    }
    
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    renderTraces(traces) {
        const container = document.getElementById('tracesList');
        if (!container) return;

        container.innerHTML = traces.map((trace) => `
            <div class="trace-item ${this.state.selectedTrace?.id === trace.id ? 'active' : ''}"
                 data-id="${this.escapeHtml(trace.id)}"
                 data-dashboard-list-action="trace"
                 role="button"
                 tabindex="0"
                 aria-selected="${this.state.selectedTrace?.id === trace.id ? 'true' : 'false'}"
                 onclick="dashboard.selectTrace(this.dataset.id)"
                 onkeydown="dashboard.handleListItemKeydown(event)">
                <div class="trace-header">
                    <span class="trace-name">${trace.name}</span>
                    <span class="trace-status ${trace.status}"></span>
                </div>
                <div class="trace-meta">
                    ${this.formatDate(trace.startedAt)} &middot; ${trace.duration}ms &middot; ${(trace.steps || []).length} steps
                </div>
            </div>
        `).join('');

        if (traces.length > 0 && !this.state.selectedTrace) {
            this.selectTrace(traces[0].id);
        }
    }

    async loadModelUsage() {
        const container = document.getElementById('modelUsage');
        if (!container) return;

        try {
            const response = await apiClient.get('/api/admin/models/usage/stats');
            const usage = this.unwrapApiPayload(response, []).map((model) => ({
                name: model.modelName || model.name || model.modelId || 'Unknown',
                requests: Number(model.requests || 0),
                avgLatency: Number(model.avgResponseTime || 0),
                inputTokens: Number(model.tokens?.input || 0),
                outputTokens: Number(model.tokens?.output || 0),
            }));
            const totalRequests = usage.reduce((sum, model) => sum + model.requests, 0);
            const items = usage.length > 0
                ? usage.map((model) => ({
                    ...model,
                    percent: totalRequests > 0 ? Math.round((model.requests / totalRequests) * 100) : 0,
                }))
                : [{ name: 'No usage yet', requests: 0, avgLatency: 0, percent: 0 }];

            container.innerHTML = items.map((model) => `
                <div class="model-usage-item">
                    <div class="model-info">
                        <span class="model-name">${this.escapeHtml(model.name)}</span>
                        <span class="model-requests">${model.requests.toLocaleString()} requests${model.avgLatency ? ` | ${model.avgLatency}ms avg` : ''}${(model.inputTokens || model.outputTokens) ? ` | ${(model.inputTokens + model.outputTokens).toLocaleString()} tokens` : ''}</span>
                    </div>
                    <div class="model-bar">
                        <div class="model-fill" style="width: ${Math.max(0, Math.min(model.percent, 100))}%"></div>
                    </div>
                    <span class="model-percent">${Math.max(0, Math.min(model.percent, 100))}%</span>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error loading model usage:', error);
            container.innerHTML = '<div class="model-usage-item"><span class="model-name">Failed to load usage data</span></div>';
        }
    }

    async loadTokenAnalyzer() {
        const rowsContainer = document.getElementById('tokenAnalyzerRows');
        const providerContainer = document.getElementById('providerTokenTotals');
        const insightsContainer = document.getElementById('tokenInsights');
        if (!rowsContainer || !providerContainer || !insightsContainer) return;

        try {
            const response = await apiClient.get('/api/admin/models/usage/stats');
            const payload = this.unwrapApiPayload(response, []);
            const meta = response?.meta || response?.data?.meta || {};
            const models = payload.map((entry) => ({
                modelId: entry.modelId || '',
                modelName: entry.modelName || entry.modelId || 'Unknown',
                provider: entry.provider || 'unknown',
                requests: Number(entry.requests || 0),
                inputTokens: Number(entry.tokens?.input || 0),
                outputTokens: Number(entry.tokens?.output || 0),
                totalTokens: Number(entry.tokens?.total || 0) || (Number(entry.tokens?.input || 0) + Number(entry.tokens?.output || 0)),
                avgResponseTime: Number(entry.avgResponseTime || 0),
            }))
                .filter((entry) => entry.requests > 0 || entry.totalTokens > 0)
                .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.modelName.localeCompare(b.modelName));

            const summary = meta.summary || this.buildTokenAnalyzerSummary(models);
            const providerTotals = Array.isArray(meta.providerTotals) && meta.providerTotals.length > 0
                ? meta.providerTotals
                : this.buildTokenAnalyzerProviderTotals(models);

            this.state.tokenAnalysis = { models, summary, providerTotals };

            document.getElementById('tokenAnalyzerTotal').textContent = this.formatCompactNumber(summary.totalTokens || 0);
            document.getElementById('tokenAnalyzerPrompt').textContent = this.formatCompactNumber(summary.totalInputTokens || 0);
            document.getElementById('tokenAnalyzerCompletion').textContent = this.formatCompactNumber(summary.totalOutputTokens || 0);
            document.getElementById('tokenAnalyzerProviders').textContent = String((summary.providerTotals || providerTotals).length || 0);

            providerContainer.innerHTML = providerTotals.length > 0
                ? providerTotals.map((provider) => {
                    const totalTokens = Number(provider.totalTokens || 0);
                    const percent = summary.totalTokens > 0 ? Math.round((totalTokens / summary.totalTokens) * 100) : 0;
                    return `
                        <div class="provider-token-item">
                            <div class="provider-token-header">
                                <span class="provider-token-name">${this.escapeHtml(provider.provider || 'unknown')}</span>
                                <span class="provider-token-total">${totalTokens.toLocaleString()} tokens</span>
                            </div>
                            <div class="provider-token-meta">${Number(provider.requests || 0).toLocaleString()} requests${provider.modelCount ? ` | ${provider.modelCount} models` : ''}</div>
                            <div class="model-bar">
                                <div class="model-fill" style="width: ${Math.max(0, Math.min(percent, 100))}%"></div>
                            </div>
                        </div>
                    `;
                }).join('')
                : '<p class="empty-state">No provider token usage yet.</p>';

            const topModel = models[0] || null;
            const topProvider = providerTotals[0] || null;
            insightsContainer.innerHTML = `
                <div class="token-insight-item">
                    <span class="token-insight-label">Total Requests</span>
                    <span class="token-insight-value">${Number(summary.totalRequests || 0).toLocaleString()}</span>
                </div>
                <div class="token-insight-item">
                    <span class="token-insight-label">Top Provider</span>
                    <span class="token-insight-value">${this.escapeHtml(topProvider?.provider || 'None')}</span>
                </div>
                <div class="token-insight-item">
                    <span class="token-insight-label">Top Model</span>
                    <span class="token-insight-value">${this.escapeHtml(topModel?.modelName || 'None')}</span>
                </div>
                <div class="token-insight-item">
                    <span class="token-insight-label">Prompt / Completion Split</span>
                    <span class="token-insight-value">${this.formatTokenSplit(summary.totalInputTokens || 0, summary.totalOutputTokens || 0)}</span>
                </div>
            `;

            rowsContainer.innerHTML = models.length > 0
                ? models.map((model) => `
                    <tr>
                        <td>${this.escapeHtml(model.modelName)}</td>
                        <td>${this.escapeHtml(model.provider)}</td>
                        <td class="col-tokens">${model.requests.toLocaleString()}</td>
                        <td class="col-tokens">${model.inputTokens.toLocaleString()}</td>
                        <td class="col-tokens">${model.outputTokens.toLocaleString()}</td>
                        <td class="col-tokens"><strong>${model.totalTokens.toLocaleString()}</strong></td>
                        <td class="col-latency">${model.avgResponseTime ? `${model.avgResponseTime}ms` : '-'}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="7" class="token-analyzer-empty">No token usage data yet.</td></tr>';
        } catch (error) {
            console.error('Error loading token analyzer:', error);
            providerContainer.innerHTML = '<p class="empty-state">Failed to load provider token totals.</p>';
            insightsContainer.innerHTML = '<p class="empty-state">Failed to load token summary.</p>';
            rowsContainer.innerHTML = '<tr><td colspan="7" class="token-analyzer-empty">Failed to load token usage data.</td></tr>';
        }
    }

    buildTokenAnalyzerSummary(models = []) {
        const providerTotals = this.buildTokenAnalyzerProviderTotals(models);
        return {
            totalRequests: models.reduce((sum, model) => sum + Number(model.requests || 0), 0),
            totalInputTokens: models.reduce((sum, model) => sum + Number(model.inputTokens || 0), 0),
            totalOutputTokens: models.reduce((sum, model) => sum + Number(model.outputTokens || 0), 0),
            totalTokens: models.reduce((sum, model) => sum + Number(model.totalTokens || 0), 0),
            providerTotals,
        };
    }

    buildTokenAnalyzerProviderTotals(models = []) {
        const providerMap = new Map();
        models.forEach((model) => {
            const provider = String(model.provider || 'unknown');
            const current = providerMap.get(provider) || {
                provider,
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                modelCount: 0,
            };
            current.requests += Number(model.requests || 0);
            current.inputTokens += Number(model.inputTokens || 0);
            current.outputTokens += Number(model.outputTokens || 0);
            current.totalTokens += Number(model.totalTokens || 0);
            current.modelCount += 1;
            providerMap.set(provider, current);
        });

        return Array.from(providerMap.values())
            .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.provider.localeCompare(b.provider));
    }

    formatCompactNumber(value = 0) {
        return new Intl.NumberFormat('en-US', {
            notation: 'compact',
            maximumFractionDigits: 1,
        }).format(Number(value || 0));
    }

    formatTokenSplit(promptTokens = 0, completionTokens = 0) {
        const total = Number(promptTokens || 0) + Number(completionTokens || 0);
        if (!total) {
            return '0% / 0%';
        }

        const promptPercent = Math.round((Number(promptTokens || 0) / total) * 100);
        const completionPercent = Math.max(0, 100 - promptPercent);
        return `${promptPercent}% / ${completionPercent}%`;
    }

    async savePrompt() {
        const name = document.getElementById('promptName').value;
        const content = document.getElementById('promptEditor').value;

        if (!name || !content) {
            this.showToast('Please provide a name and content', 'warning');
            return;
        }

        if (!this.state.selectedPrompt?.id) {
            this.showToast('Select a live prompt slot before saving', 'warning');
            return;
        }

        try {
            const prompt = {
                name,
                content,
                updatedAt: new Date().toISOString(),
            };

            const response = await apiClient.put(`/api/admin/prompts/${this.state.selectedPrompt.id}`, prompt);
            const savedPrompt = this.unwrapApiPayload(response, null);

            this.showToast('Prompt saved successfully', 'success');
            await this.loadPrompts();
            if (savedPrompt?.id) {
                this.selectPromptById(savedPrompt.id);
            }
        } catch (error) {
            console.error('Error saving prompt:', error);
            this.showToast(error.userMessage || error.message || 'Failed to save prompt', 'error');
        }
    }

    async runPromptTest() {
        const input = document.getElementById('testInput').value;
        const output = document.querySelector('#testOutput .output-content');

        if (!this.state.selectedPrompt?.id) {
            this.showToast('Save or select a prompt before testing it', 'warning');
            return;
        }

        if (!input) {
            this.showToast('Please enter test variables as JSON', 'warning');
            return;
        }

        output.innerHTML = '<p class="placeholder">Running test...</p>';

        try {
            let variables = {};
            try {
                variables = JSON.parse(input);
            } catch {
                throw new Error('Test input must be valid JSON, for example {"language":"JavaScript"}');
            }

            const response = await apiClient.post(`/api/admin/prompts/${this.state.selectedPrompt.id}/test`, {
                variables,
            });
            const result = this.unwrapApiPayload(response, {});
            output.innerHTML = `
                <pre>${this.escapeHtml(result.rendered || 'No rendered output')}</pre>
                <div class="log-detail-grid">
                    <div class="log-detail-item">
                        <span class="log-detail-label">Characters</span>
                        <span class="log-detail-value">${result.stats?.characters || 0}</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Estimated Tokens</span>
                        <span class="log-detail-value">${result.stats?.tokens || 0}</span>
                    </div>
                    <div class="log-detail-item">
                        <span class="log-detail-label">Missing Variables</span>
                        <span class="log-detail-value">${(result.missing || []).join(', ') || 'None'}</span>
                    </div>
                </div>
            `;
        } catch (error) {
            output.innerHTML = `<p class="error">Error: ${error.message}</p>`;
        }
    }

    async clearLogs() {
        try {
            await apiClient.post('/api/admin/logs/clear');
            this.state.logs = [];
            this.state.pagination.logs.total = 0;
            this.renderLogs([]);
            this.updateLogsPagination();
            this.showToast('All logs cleared', 'success');
        } catch (error) {
            console.error('Error clearing logs:', error);
            this.showToast('Failed to clear logs', 'error');
        }
    }

    changeLogPage(direction) {
        const { page, total, limit } = this.state.pagination.logs;
        const newPage = page + direction;
        const totalPages = Math.ceil(total / Math.max(limit, 1)) || 1;

        if (newPage < 1 || newPage > totalPages) return;

        this.state.pagination.logs.page = newPage;
        this.loadLogs();
    }

    discoverSkills() {
        this.loadSkills()
            .then(() => {
                this.showToast('Tool catalog refreshed', 'success');
            })
            .catch((error) => {
                console.error('Error refreshing tool catalog:', error);
                this.showToast('Failed to refresh tool catalog', 'error');
            });
    }

    async saveGeneralSettings() {
        try {
            const settings = {
                general: {
                    appName: document.getElementById('dashboardTitle').value,
                    timezone: document.getElementById('timezone').value,
                    dateFormat: document.getElementById('dateFormat').value,
                },
                personality: {
                    enabled: document.getElementById('personalityEnabled').checked,
                    displayName: document.getElementById('personalityName').value.trim(),
                    content: document.getElementById('soulContent').value,
                },
                userProfile: {
                    enabled: document.getElementById('userProfileEnabled').checked,
                    displayName: document.getElementById('userProfileName').value.trim(),
                    content: document.getElementById('userProfileContent').value,
                },
                agentNotes: {
                    enabled: document.getElementById('agentNotesEnabled').checked,
                    displayName: document.getElementById('agentNotesName').value.trim(),
                    content: document.getElementById('agentNotesContent').value,
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.clearDurablePromptDirtyState();
            this.applySettings(this.unwrapApiPayload(response, settings), { preserveDirty: false });
            this.showToast('Settings saved', 'success');
        } catch (error) {
            console.error('Error saving general settings:', error);
            this.showToast('Failed to save settings', 'error');
        }
    }

    async saveApiSettings() {
        try {
            apiClient.apiKey = document.getElementById('apiKey').value.trim();
            apiClient.persistApiKey(apiClient.apiKey);

            const settings = {
                api: {
                    baseURL: document.getElementById('apiEndpoint').value,
                    timeout: parseInt(document.getElementById('requestTimeout').value, 10),
                    maxRetries: parseInt(document.getElementById('maxRetries').value, 10),
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            this.showToast('API settings saved', 'success');
        } catch (error) {
            console.error('Error saving API settings:', error);
            this.showToast('Failed to save API settings', 'error');
        }
    }

    async saveSshSettings() {
        try {
            const sshPassword = document.getElementById('sshPassword').value;
            const clearSshPassword = document.getElementById('clearSshPassword').checked;
            const settings = {
                integrations: {
                    ssh: {
                        enabled: document.getElementById('sshEnabled').value === 'true',
                        host: document.getElementById('sshHost').value.trim(),
                        port: parseInt(document.getElementById('sshPort').value, 10) || 22,
                        username: document.getElementById('sshUsername').value.trim(),
                        privateKeyPath: document.getElementById('sshPrivateKeyPath').value.trim(),
                        password: sshPassword,
                        clearPassword: clearSshPassword,
                    },
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            this.showToast('SSH defaults saved', 'success');
        } catch (error) {
            console.error('Error saving SSH defaults:', error);
            this.showToast('Failed to save SSH defaults', 'error');
        }
    }

    async saveDeploySettings() {
        try {
            const settings = {
                integrations: {
                    deploy: {
                        repositoryUrl: document.getElementById('deployRepositoryUrl').value.trim(),
                        branch: document.getElementById('deployBranch').value.trim(),
                        targetDirectory: document.getElementById('deployTargetDirectory').value.trim(),
                        manifestsPath: document.getElementById('deployManifestsPath').value.trim(),
                        namespace: document.getElementById('deployNamespace').value.trim(),
                        deployment: document.getElementById('deployDeployment').value.trim(),
                        container: document.getElementById('deployContainer').value.trim(),
                        publicDomain: document.getElementById('deployPublicDomain').value.trim(),
                        ingressClassName: document.getElementById('deployIngressClassName').value.trim(),
                        tlsClusterIssuer: document.getElementById('deployTlsClusterIssuer').value.trim(),
                    },
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
            this.showToast('Deploy defaults saved', 'success');
        } catch (error) {
            console.error('Error saving deploy defaults:', error);
            this.showToast('Failed to save deploy defaults', 'error');
        }
    }

    parseDelimitedList(value = '') {
        return String(value || '')
            .split(/\r?\n|,/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    joinListForTextarea(values = []) {
        return Array.isArray(values) ? values.join('\n') : '';
    }

    getPrivacyAuditDefaults(profile = 'baseline') {
        const profiles = {
            baseline: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress'],
            strict: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'postalCode', 'personName', 'organization', 'medicalRecordNumber', 'patientIdentifier', 'healthCardNumber', 'socialInsuranceNumber'],
            custom: [],
        };
        return profiles[profile] || profiles.baseline;
    }

    renderPrivacyPiiSettings(settings = this.state.settings?.privacyPii || {}) {
        const privacyPii = {
            defaultsVersion: 6,
            enabled: true,
            webChatEnabled: true,
            highlightRestored: true,
            allowUserOverride: false,
            placeholderMode: 'opaque-random',
            reintroductionMode: 'trusted-view',
            failClosed: true,
            detectors: ['email', 'phone', 'ssn', 'creditCard', 'dateOfBirth', 'address', 'ipAddress', 'postalCode', 'personName', 'organization', 'medicalRecordNumber', 'patientIdentifier', 'healthCardNumber', 'socialInsuranceNumber'],
            detectorActions: {},
            customPatterns: [],
            dictionary: [],
            auditProfile: 'strict',
            auditCriteria: { requiredDetectors: this.getPrivacyAuditDefaults('strict') },
            relationshipCalculations: {
                enabled: true,
                autoDetect: true,
                allowExplicitRequest: true,
                maxRows: 1000,
                maxCells: 20000,
            },
            ...settings,
        };
        const relationshipCalculations = {
            enabled: true,
            autoDetect: true,
            allowExplicitRequest: true,
            maxRows: 1000,
            maxCells: 20000,
            ...(privacyPii.relationshipCalculations || {}),
        };

        this.setCheckboxValue('piiEnabled', Boolean(privacyPii.enabled));
        this.setCheckboxValue('piiWebChatEnabled', privacyPii.webChatEnabled !== false);
        this.setCheckboxValue('piiFailClosed', privacyPii.failClosed !== false);
        this.setCheckboxValue('piiHighlightRestored', privacyPii.highlightRestored !== false);
        this.setCheckboxValue('piiAllowUserOverride', privacyPii.allowUserOverride === true);
        this.setInputValue('piiAuditProfile', privacyPii.auditProfile || 'baseline');
        this.setInputValue('piiPlaceholderMode', privacyPii.placeholderMode || 'opaque-random');
        this.setInputValue('piiReintroductionMode', privacyPii.reintroductionMode || 'trusted-view');
        this.setCheckboxValue('piiRelationshipCalculationsEnabled', relationshipCalculations.enabled !== false);
        this.setCheckboxValue('piiRelationshipCalculationsAutoDetect', relationshipCalculations.autoDetect !== false);
        this.setCheckboxValue('piiRelationshipCalculationsAllowExplicit', relationshipCalculations.allowExplicitRequest !== false);
        this.setInputValue('piiRelationshipCalculationsMaxRows', relationshipCalculations.maxRows || 1000);
        this.setInputValue('piiRelationshipCalculationsMaxCells', relationshipCalculations.maxCells || 20000);
        this.setInputValue('piiRequiredDetectors', this.joinListForTextarea(privacyPii.auditCriteria?.requiredDetectors || []));
        this.setInputValue('piiDictionary', this.formatPrivacyDictionary(privacyPii.dictionary || []));
        this.setInputValue('piiCustomPatterns', this.formatPrivacyCustomPatterns(privacyPii.customPatterns || []));
        this.renderPrivacyDetectorGrid(privacyPii);
        this.renderPrivacyAuditStatus(privacyPii);
    }

    renderPrivacyDetectorGrid(settings = {}) {
        const grid = document.getElementById('piiDetectorGrid');
        if (!grid) return;

        const enabled = new Set((settings.detectors || []).map((entry) => String(entry || '').trim()));
        if (settings.enablePersonNames === true) {
            enabled.add('personName');
        }
        const actions = settings.detectorActions || {};

        grid.innerHTML = this.piiDetectorDefinitions.map((detector) => {
            const checked = enabled.has(detector.id);
            const action = actions[detector.id] || 'vault-placeholder';
            return `
                <div class="pii-detector-row">
                    <label class="pii-detector-toggle">
                        <input type="checkbox" class="pii-detector-enabled" data-detector="${this.escapeHtml(detector.id)}" ${checked ? 'checked' : ''}>
                        <span>${this.escapeHtml(detector.label)}</span>
                    </label>
                    <select class="form-control pii-detector-action" data-detector="${this.escapeHtml(detector.id)}">
                        <option value="vault-placeholder" ${action === 'vault-placeholder' ? 'selected' : ''}>Vault</option>
                        <option value="mask" ${action === 'mask' ? 'selected' : ''}>Mask only</option>
                        <option value="remove" ${action === 'remove' ? 'selected' : ''}>Remove</option>
                        <option value="ignore" ${action === 'ignore' ? 'selected' : ''}>Ignore</option>
                    </select>
                </div>
            `;
        }).join('');
    }

    renderPrivacyAuditStatus(settings = {}) {
        const status = settings.auditStatus || {};
        this.setTextContent('piiAuditProfileStatus', this.formatPrivacyProfile(settings.auditProfile || status.profile || 'baseline'));
        this.setTextContent('piiAuditPassStatus', status.pass ? 'Pass' : 'Needs work');
        this.setTextContent('piiVaultStatus', settings.vaultConfigured ? 'Configured' : 'Missing');
    }

    formatPrivacyProfile(profile = '') {
        if (profile === 'strict') return 'Strict';
        if (profile === 'custom') return 'Custom';
        return 'Baseline';
    }

    formatPrivacyDictionary(entries = []) {
        return (Array.isArray(entries) ? entries : [])
            .map((entry) => {
                if (typeof entry === 'string') return entry;
                return `${entry.type || entry.label || 'custom'}: ${entry.value || ''}${entry.action ? ` | ${entry.action}` : ''}`;
            })
            .join('\n');
    }

    formatPrivacyCustomPatterns(entries = []) {
        return (Array.isArray(entries) ? entries : [])
            .map((entry) => `${entry.type || entry.label || 'custom'}|${entry.pattern || ''}${entry.flags ? `|${entry.flags}` : ''}${entry.action ? `|${entry.action}` : ''}`)
            .join('\n');
    }

    parsePrivacyDictionary(value = '') {
        return String(value || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const divider = line.indexOf(':');
                if (divider > 0) {
                    const rawValue = line.slice(divider + 1).trim();
                    const [value, action] = rawValue.split('|').map((part) => part.trim());
                    return {
                        type: line.slice(0, divider).trim() || 'custom',
                        value,
                        ...(action ? { action } : {}),
                    };
                }
                return { type: 'custom', value: line };
            })
            .filter((entry) => entry.value);
    }

    parsePrivacyCustomPatterns(value = '') {
        return String(value || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                if (line.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(line);
                        return {
                            type: String(parsed.type || parsed.label || 'custom').trim() || 'custom',
                            pattern: String(parsed.pattern || '').trim(),
                            flags: String(parsed.flags || 'gi').trim() || 'gi',
                            action: String(parsed.action || '').trim(),
                        };
                    } catch (_error) {
                        return null;
                    }
                }
                const [type, pattern, flags, action] = line.split('|');
                return {
                    type: String(type || 'custom').trim() || 'custom',
                    pattern: String(pattern || '').trim(),
                    flags: String(flags || 'gi').trim() || 'gi',
                    ...(action ? { action: String(action || '').trim() } : {}),
                };
            })
            .filter((entry) => entry?.pattern);
    }

    collectPrivacyPiiSettings() {
        const detectorActions = {};
        document.querySelectorAll('.pii-detector-action').forEach((select) => {
            const detector = select.dataset.detector;
            if (detector) {
                detectorActions[detector] = select.value || 'vault-placeholder';
            }
        });

        const checkedDetectors = Array.from(document.querySelectorAll('.pii-detector-enabled:checked'))
            .map((checkbox) => checkbox.dataset.detector)
            .filter(Boolean);
        const detectors = checkedDetectors.filter((detector) => detector !== 'personName');
        const enablePersonNames = checkedDetectors.includes('personName');

        return {
            defaultsVersion: 6,
            enabled: document.getElementById('piiEnabled')?.checked === true,
            webChatEnabled: document.getElementById('piiWebChatEnabled')?.checked !== false,
            failClosed: document.getElementById('piiFailClosed')?.checked !== false,
            highlightRestored: document.getElementById('piiHighlightRestored')?.checked !== false,
            allowUserOverride: document.getElementById('piiAllowUserOverride')?.checked === true,
            auditProfile: document.getElementById('piiAuditProfile')?.value || 'baseline',
            placeholderMode: document.getElementById('piiPlaceholderMode')?.value || 'opaque-random',
            reintroductionMode: document.getElementById('piiReintroductionMode')?.value || 'trusted-view',
            detectors: detectors.length > 0 ? detectors : ['email'],
            enablePersonNames,
            detectorActions,
            dictionary: this.parsePrivacyDictionary(document.getElementById('piiDictionary')?.value || ''),
            customPatterns: this.parsePrivacyCustomPatterns(document.getElementById('piiCustomPatterns')?.value || ''),
            relationshipCalculations: {
                enabled: document.getElementById('piiRelationshipCalculationsEnabled')?.checked !== false,
                autoDetect: document.getElementById('piiRelationshipCalculationsAutoDetect')?.checked !== false,
                allowExplicitRequest: document.getElementById('piiRelationshipCalculationsAllowExplicit')?.checked !== false,
                maxRows: Number(document.getElementById('piiRelationshipCalculationsMaxRows')?.value || 1000),
                maxCells: Number(document.getElementById('piiRelationshipCalculationsMaxCells')?.value || 20000),
            },
            auditCriteria: {
                requiredDetectors: this.parseDelimitedList(document.getElementById('piiRequiredDetectors')?.value || ''),
                requireVaultKey: true,
                requireFailClosed: true,
                requireRestoreHighlight: true,
            },
        };
    }

    syncPrivacyAuditProfileDefaults() {
        const profile = document.getElementById('piiAuditProfile')?.value || 'baseline';
        if (profile !== 'custom') {
            this.setInputValue('piiRequiredDetectors', this.joinListForTextarea(this.getPrivacyAuditDefaults(profile)));
        }
    }

    async savePrivacyPiiSettings() {
        try {
            const privacyPii = this.collectPrivacyPiiSettings();
            const response = await apiClient.put('/api/admin/settings', { privacyPii });
            const settings = this.unwrapApiPayload(response, this.state.settings);
            this.applySettings(settings);
            this.showToast('PII workflow saved', 'success');
        } catch (error) {
            console.error('Error saving PII workflow:', error);
            this.showToast('Failed to save PII workflow', 'error');
        }
    }

    async previewPrivacyPiiPolicy() {
        const output = document.getElementById('piiPreviewOutput');
        const sampleText = document.getElementById('piiPreviewInput')?.value || '';
        if (!sampleText.trim()) {
            this.showToast('Add sample text before previewing', 'info');
            return;
        }
        if (output) {
            output.innerHTML = '<span class="text-muted">Running preview...</span>';
        }

        try {
            const response = await apiClient.post('/api/admin/settings/privacy-pii/preview', {
                sampleText,
                settings: this.collectPrivacyPiiSettings(),
            });
            const result = this.unwrapApiPayload(response, {});
            this.renderPrivacyPreview(result);
        } catch (error) {
            console.error('Error previewing PII workflow:', error);
            if (output) {
                output.innerHTML = `<span class="error">Preview failed: ${this.escapeHtml(error.message || 'unknown error')}</span>`;
            }
        }
    }

    renderPrivacyPreview(result = {}) {
        const output = document.getElementById('piiPreviewOutput');
        if (!output) return;
        const matches = Array.isArray(result.matches) ? result.matches : [];
        const summary = `${Number(result.matchCount || 0).toLocaleString()} match${Number(result.matchCount || 0) === 1 ? '' : 'es'} found`;
        const exposeTypeContext = result.exposesTypeContext === true;
        output.innerHTML = `
            <div class="pii-preview-summary">
                <span class="status-badge ${result.auditStatus?.pass ? 'healthy' : 'warning'}">${this.escapeHtml(result.auditStatus?.pass ? 'Audit checks pass' : 'Audit checks need work')}</span>
                <span>${this.escapeHtml(summary)}</span>
            </div>
            <pre>${this.escapeHtml(result.sanitizedText || '')}</pre>
            <div class="pii-preview-matches">
                ${matches.length > 0 ? matches.map((match, index) => `
                    <span>${this.escapeHtml(exposeTypeContext ? match.type : `Match ${index + 1}`)} -> ${this.escapeHtml(match.action)} (${Number(match.length || 0)} chars)</span>
                `).join('') : '<span>No configured PII found.</span>'}
            </div>
        `;
    }

    async resetPersonality() {
        if (!confirm('Reset soul.md to the default personality?')) {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/settings/reset', {
                section: 'personality',
            });
            this.dirtyInputIds.delete('soulContent');
            this.applySettings(this.unwrapApiPayload(response, this.state.settings), { preserveDirty: false });
            this.showToast('soul.md reset to default', 'success');
        } catch (error) {
            console.error('Error resetting soul.md:', error);
            this.showToast('Failed to reset soul.md', 'error');
        }
    }

    async resetUserProfile() {
        if (!confirm('Reset user.md to the default user profile?')) {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/settings/reset', {
                section: 'userProfile',
            });
            this.dirtyInputIds.delete('userProfileContent');
            this.applySettings(this.unwrapApiPayload(response, this.state.settings), { preserveDirty: false });
            this.showToast('user.md reset to default', 'success');
        } catch (error) {
            console.error('Error resetting user.md:', error);
            this.showToast('Failed to reset user.md', 'error');
        }
    }

    async resetAgentNotes() {
        if (!confirm('Reset agent-notes.md to the default carryover notes template?')) {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/settings/reset', {
                section: 'agentNotes',
            });
            this.dirtyInputIds.delete('agentNotesContent');
            this.applySettings(this.unwrapApiPayload(response, this.state.settings), { preserveDirty: false });
            this.showToast('agent-notes.md reset to default', 'success');
        } catch (error) {
            console.error('Error resetting agent-notes.md:', error);
            this.showToast('Failed to reset agent-notes.md', 'error');
        }
    }

    async testConnection() {
        try {
            const response = await apiClient.get('/api/admin/health');
            const health = this.unwrapApiPayload(response, {});
            this.updateConnectionStatus(true);
            this.showToast(`Connection successful (${health.status || 'unknown'})`, 'success');
        } catch (error) {
            this.updateConnectionStatus(false);
            this.showToast(`Connection failed: ${error.message}`, 'error');
        }
    }

    confirmClearAllLogs() {
        if (confirm('Are you sure you want to clear all logs? This action cannot be undone.')) {
            this.clearLogs();
        }
    }

    confirmResetConfig() {
        if (!confirm('Are you sure you want to reset all settings to defaults?')) {
            return;
        }

        apiClient.post('/api/admin/settings/reset')
            .then((response) => {
                const settings = this.unwrapApiPayload(response, {});
                this.applySettings(settings);
                this.showToast('Settings reset to defaults', 'success');
            })
            .catch((error) => {
                console.error('Error resetting settings:', error);
                this.showToast('Failed to reset settings', 'error');
            });
    }

    async updateFeatureToggle(featureId, enabled) {
        try {
            const response = await apiClient.put('/api/admin/settings', this.getFeatureSettingsPatch(featureId, enabled));
            this.applySettings(this.unwrapApiPayload(response, this.state.settings));
            this.showToast(`Feature ${enabled ? 'enabled' : 'disabled'}`, 'success');
        } catch (error) {
            console.error('Error updating feature toggle:', error);
            this.showToast('Failed to update feature toggle', 'error');
        }
    }

    editModel(id) {
        const model = this.state.models.find((item) => item.id === id);
        if (!model) {
            this.showToast('Model not found', 'error');
            return;
        }

        this.navigateTo('models');
        this.setInputValue('defaultModel', model.id);
        this.showToast(`Loaded ${model.name} into the default config editor`, 'info');
    }

    testModel(id) {
        const model = this.state.models.find((item) => item.id === id);
        if (!model) {
            this.showToast('Model not found', 'error');
            return;
        }

        this.showToast(`${model.name} is configured in the dashboard`, 'info');
    }

    editSkill(id) {
        const tool = this.state.tools.find((item) => item.id === id);
        if (!tool) {
            this.showToast('Tool not found', 'error');
            return;
        }

        this.navigateTo('skills');
        this.selectTool(id);
        this.showToast(`${tool.name}: ${tool.description}`, 'info', 5000);
    }

    restoreVersion(version) {
        this.showToast(`Prompt history restore is not available yet (${version})`, 'info');
    }

    normalizeModel(model = {}) {
        return {
            ...model,
            provider: model.provider || model.owned_by || 'unknown',
            active: Boolean(model.active ?? model.isActive ?? model.isDefault),
            requests: Number(model.requests ?? model.usageCount ?? 0),
            avgLatency: Number(model.avgLatency ?? model.avgResponseTime ?? 0),
            inputTokens: Number(model.inputTokens ?? model.tokens?.input ?? 0),
            outputTokens: Number(model.outputTokens ?? model.tokens?.output ?? 0),
            totalTokens: Number(model.totalTokens ?? model.tokens?.total ?? 0)
                || (Number(model.inputTokens ?? model.tokens?.input ?? 0) + Number(model.outputTokens ?? model.tokens?.output ?? 0)),
        };
    }

    mergeModelsWithUsage(liveModels = [], usageRows = []) {
        const merged = new Map();

        (Array.isArray(liveModels) ? liveModels : []).forEach((model) => {
            if (!model?.id) return;
            merged.set(model.id, this.normalizeModel(model));
        });

        (Array.isArray(usageRows) ? usageRows : []).forEach((usage) => {
            const modelId = String(usage?.modelId || '').trim();
            if (!modelId) return;

            const existing = merged.get(modelId) || {};
            merged.set(modelId, this.normalizeModel({
                id: modelId,
                name: usage.modelName || existing.name || modelId,
                provider: usage.provider || existing.provider || 'unknown',
                capabilities: existing.capabilities || [],
                isActive: existing.isActive ?? false,
                usageOnly: !existing.id,
                ...existing,
                requests: usage.requests ?? existing.requests ?? 0,
                avgResponseTime: usage.avgResponseTime ?? existing.avgResponseTime ?? 0,
                inputTokens: usage.tokens?.input ?? existing.inputTokens ?? 0,
                outputTokens: usage.tokens?.output ?? existing.outputTokens ?? 0,
                totalTokens: usage.tokens?.total ?? existing.totalTokens ?? 0,
            }));
        });

        return Array.from(merged.values())
            .sort((a, b) => (
                Number(b.totalTokens || 0) - Number(a.totalTokens || 0)
                || Number(b.requests || 0) - Number(a.requests || 0)
                || String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''))
            ));
    }

    getFeatureSettingsPatch(featureId, enabled) {
        const featureMap = {
            featureWebsocket: 'realTimeUpdates',
            featureSkillDiscovery: 'enableSkills',
            featureValidation: 'enableTracing',
            featureDebug: 'enableDebug',
        };
        const key = featureMap[featureId] || featureId;

        if (featureId === 'featureRetry') {
            return {
                api: {
                    maxRetries: enabled ? Math.max(Number(this.state.settings?.api?.maxRetries || 3), 1) : 0,
                },
            };
        }

        if (featureId === 'featurePiiCleansing') {
            const existing = this.state.settings?.privacyPii || {};
            return {
                privacyPii: {
                    ...existing,
                    defaultsVersion: 6,
                    enabled,
                    webChatEnabled: existing.webChatEnabled !== false,
                    highlightRestored: existing.highlightRestored !== false,
                    placeholderMode: existing.placeholderMode || 'opaque-random',
                    reintroductionMode: existing.reintroductionMode || 'trusted-view',
                    failClosed: existing.failClosed !== false,
                    detectors: existing.detectors || this.getPrivacyAuditDefaults('strict'),
                    detectorActions: existing.detectorActions || {},
                    auditProfile: existing.auditProfile || 'strict',
                    auditCriteria: existing.auditCriteria || { requiredDetectors: this.getPrivacyAuditDefaults('strict') },
                },
            };
        }

        return {
            features: {
                [key]: enabled,
            },
        };
    }

    syncModelOptions(models = this.state.models) {
        const select = document.getElementById('defaultModel');
        const selectableModels = this.getSelectableModels(models);

        if (select) {
            this.syncModelSelect(select, selectableModels, {
                selectedValues: [this.state.settings?.models?.defaultModel || select.value].filter(Boolean),
                keepExisting: true,
            });
        }

        const orchestration = this.state.settings?.orchestration || {};
        const orchestrationSelections = {
            orchestrationDefaultModel: [orchestration.defaultModel || 'gpt-5.5'],
            orchestrationPlannerModel: [orchestration.plannerModel || orchestration.defaultModel || 'gpt-5.5'],
            orchestrationSynthesisModel: [orchestration.synthesisModel || orchestration.defaultModel || 'gpt-5.5'],
            orchestrationRepairModel: [orchestration.repairModel || orchestration.defaultModel || 'gpt-5.5'],
            orchestrationEvaluatorModel: [orchestration.evaluatorModel || orchestration.defaultModel || 'gpt-5.5'],
            orchestrationFallbackModels: orchestration.fallbackModels || ['gemini-3.1-pro', 'groq-compound'],
        };

        Object.entries(orchestrationSelections).forEach(([id, selectedValues]) => {
            const modelSelect = document.getElementById(id);
            if (!modelSelect) return;
            this.syncModelSelect(modelSelect, selectableModels, {
                selectedValues,
                allowMultiple: modelSelect.multiple,
            });
        });
    }

    getSelectableModels(models = []) {
        const byId = new Map();
        (Array.isArray(models) ? models : []).forEach((model) => {
            const id = String(model?.id || '').trim();
            if (!id || model.usageOnly) return;
            byId.set(id, {
                id,
                name: model.name || this.humanizeModelId(id),
                provider: model.provider || model.raw?.owned_by || 'unknown',
            });
        });
        return Array.from(byId.values())
            .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    }

    syncModelSelect(select, models = [], { selectedValues = [], allowMultiple = false, keepExisting = false } = {}) {
        const normalizedSelected = Array.from(new Set(
            (Array.isArray(selectedValues) ? selectedValues : [selectedValues])
                .map((value) => String(value || '').trim())
                .filter(Boolean),
        ));
        const liveIds = new Set(models.map((model) => model.id));
        const selectedIds = new Set(normalizedSelected);
        const existingOptions = keepExisting
            ? Array.from(select.options)
                .map((option) => ({
                    id: option.value,
                    name: option.textContent || option.value,
                    provider: option.dataset.provider || '',
                }))
                .filter((model) => model.id && !liveIds.has(model.id))
            : [];
        const optionModels = [...models, ...existingOptions].filter((model, index, list) =>
            list.findIndex((candidate) => candidate.id === model.id) === index,
        );

        select.innerHTML = '';

        optionModels.forEach((model) => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = this.formatModelOptionLabel(model);
            option.dataset.provider = model.provider || '';
            option.selected = selectedIds.has(model.id);
            select.appendChild(option);
        });

        normalizedSelected
            .filter((id) => !liveIds.has(id) && !optionModels.some((model) => model.id === id))
            .forEach((id) => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = `Unavailable: ${id}`;
                option.disabled = true;
                option.selected = true;
                select.appendChild(option);
            });

        if (!allowMultiple && !select.value && select.options.length > 0) {
            select.selectedIndex = 0;
        }
    }

    formatModelOptionLabel(model = {}) {
        const name = model.name || this.humanizeModelId(model.id);
        const provider = String(model.provider || '').trim();
        return provider && provider !== 'unknown' ? `${name} (${provider})` : name;
    }

    humanizeModelId(id = '') {
        return String(id)
            .replace(/[-_]+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    getSelectedModelValues(id) {
        const select = document.getElementById(id);
        if (!select) return [];
        return Array.from(select.selectedOptions)
            .map((option) => option.value)
            .filter(Boolean);
    }

    populateLogModelFilter(logs = []) {
        const select = document.getElementById('logModelFilter');
        if (!select) return;

        const currentValue = select.value || 'all';
        const models = Array.from(new Set((logs || []).map((log) => log.model).filter(Boolean)));

        select.innerHTML = '<option value="all">All Models</option>' + models.map((model) =>
            `<option value="${this.escapeHtml(model)}">${this.escapeHtml(model)}</option>`
        ).join('');
        select.value = models.includes(currentValue) || currentValue === 'all' ? currentValue : 'all';
    }

    renderAgentCompanyStatus(status = null) {
        this.state.agentCompanyStatus = status;
        const label = document.getElementById('settingsAgentCompanyStatus');
        this.renderAgentCompanyDashboard();
        if (!label) return;

        const heartbeat = status?.state?.heartbeat || {};
        const running = status?.state?.runningWork || {};
        const available = status?.available === true;
        const statusText = heartbeat.status || (available ? 'ready' : 'standby');
        const nextAt = heartbeat.nextAt ? this.formatDate(heartbeat.nextAt) : 'not scheduled';
        const workText = `${Number(running.running || 0)} running, ${Number(running.queued || 0)} queued`;
        const failedText = Number(heartbeat.failedWorkloads || 0) > 0
            ? `; ${Number(heartbeat.failedWorkloads || 0)} failed`
            : '';
        const reason = heartbeat.reason ? `; ${heartbeat.reason}` : '';

        label.textContent = `Heartbeat ${statusText}; next ${nextAt}; ${workText}${failedText}${reason}.`;
    }

    applySettings(settings = {}, { preserveDirty = false } = {}) {
        this.state.settings = settings;

        const general = settings.general || {};
        const models = settings.models || {};
        const api = settings.api || {};
        const features = settings.features || {};
        const orchestration = settings.orchestration || {};
        const asyncRuntime = settings.asyncRuntime || {};
        const agentCompany = settings.agentCompany || {};
        const personality = settings.personality || {};
        const userProfile = settings.userProfile || {};
        const agentNotes = settings.agentNotes || {};
        const ssh = settings.integrations?.ssh || {};
        const privacyPii = settings.privacyPii || {};

        this.setInputValue('dashboardTitle', general.appName || 'Agent SDK Admin');
        this.setInputValue('timezone', general.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
        this.setInputValue('dateFormat', general.dateFormat || 'YYYY-MM-DD');
        this.setInputValue('apiEndpoint', api.baseURL || window.location.origin);
        this.setInputValue('apiKey', apiClient.apiKey || '');
        this.setInputValue('requestTimeout', api.timeout ?? 30000);
        this.setInputValue('maxRetries', api.maxRetries ?? 3);
        this.setInputValue('defaultTemperature', models.temperature ?? 0.7);
        this.setInputValue('defaultMaxTokens', models.maxTokens ?? 4096);
        this.setInputValue('defaultTopP', models.topP ?? 1);
        this.setInputValue('defaultFrequencyPenalty', models.frequencyPenalty ?? 0);
        this.setInputValue('defaultPresencePenalty', models.presencePenalty ?? 0);
        this.setInputValue('sshEnabled', String(ssh.enabled !== false));
        this.setInputValue('sshHost', ssh.host || '');
        this.setInputValue('sshPort', ssh.port ?? 22);
        this.setInputValue('sshUsername', ssh.username || '');
        this.setInputValue('sshPrivateKeyPath', ssh.privateKeyPath || '');
        this.setInputValue('sshCredentialSource', ssh.source || 'dashboard');
        this.setInputValue('sshPassword', '');
        this.setCheckboxValue('clearSshPassword', false);
        this.setCheckboxValue('personalityEnabled', personality.enabled !== false);
        this.setInputValue('personalityName', personality.displayName || 'Agent Soul');
        this.setInputValue('soulContent', personality.content || '', { preserveDirty });
        this.setInputValue(
            'personalityUpdatedAt',
            personality.updatedAt ? this.formatDate(personality.updatedAt) : 'Default content',
        );
        const soulFilePathLabel = document.getElementById('soulFilePathLabel');
        if (soulFilePathLabel) {
            soulFilePathLabel.textContent = personality.filePath || 'soul.md';
        }
        const soulCharacterLimit = document.getElementById('soulCharacterLimit');
        if (soulCharacterLimit) {
            soulCharacterLimit.textContent = String(personality.characterLimit || 3700);
        }
        this.syncSoulCharacterCount();

        this.setCheckboxValue('userProfileEnabled', userProfile.enabled !== false);
        this.setInputValue('userProfileName', userProfile.displayName || 'User Profile');
        this.setInputValue('userProfileContent', userProfile.content || '', { preserveDirty });
        this.setInputValue(
            'userProfileUpdatedAt',
            userProfile.updatedAt ? this.formatDate(userProfile.updatedAt) : 'Default content',
        );
        const userProfileFilePathLabel = document.getElementById('userProfileFilePathLabel');
        if (userProfileFilePathLabel) {
            userProfileFilePathLabel.textContent = userProfile.filePath || 'user.md';
        }
        const userProfileCharacterLimit = document.getElementById('userProfileCharacterLimit');
        if (userProfileCharacterLimit) {
            userProfileCharacterLimit.textContent = String(userProfile.characterLimit || 3700);
        }
        this.syncUserProfileCharacterCount();

        this.setCheckboxValue('agentNotesEnabled', agentNotes.enabled !== false);
        this.setInputValue('agentNotesName', agentNotes.displayName || 'Carryover Notes');
        this.setInputValue('agentNotesContent', agentNotes.content || '', { preserveDirty });
        this.setInputValue(
            'agentNotesUpdatedAt',
            agentNotes.updatedAt ? this.formatDate(agentNotes.updatedAt) : 'Default content',
        );
        const agentNotesFilePathLabel = document.getElementById('agentNotesFilePathLabel');
        if (agentNotesFilePathLabel) {
            agentNotesFilePathLabel.textContent = agentNotes.filePath || 'agent-notes.md';
        }
        const agentNotesCharacterLimit = document.getElementById('agentNotesCharacterLimit');
        if (agentNotesCharacterLimit) {
            agentNotesCharacterLimit.textContent = String(agentNotes.characterLimit || 4000);
        }
        this.syncAgentNotesCharacterCount();
        if (settings.audioProcessing?.podcastAssets) {
            this.renderPodcastAudioSettings({
                storageDirectory: settings.audioProcessing.storageDirectory || 'Server state folder',
                tracks: settings.audioProcessing.podcastAssets,
            });
        }

        this.syncModelOptions();
        this.setInputValue('defaultModel', models.defaultModel || 'gpt-4o');
        this.setInputValue('orchestrationEnabled', String(orchestration.enabled !== false));
        this.setInputValue('orchestrationPlannerReasoning', orchestration.plannerReasoningEffort || 'high');
        this.setInputValue('orchestrationSynthesisReasoning', orchestration.synthesisReasoningEffort || 'medium');
        this.setInputValue('orchestrationRepairReasoning', orchestration.repairReasoningEffort || 'high');
        this.setInputValue('orchestrationEvaluatorReasoning', orchestration.evaluatorReasoningEffort || 'medium');
        this.setInputValue('orchestrationEnableAlignmentEvaluator', String(orchestration.enableAlignmentEvaluator !== false));
        this.setInputValue('orchestrationApplyAlignmentGuidance', String(orchestration.applyAlignmentGuidance !== false));
        this.setInputValue('orchestrationAgentDirectedRuntime', String(orchestration.agentDirectedRuntime === true));
        this.setCheckboxValue('settingsAgentDirectedRuntime', orchestration.agentDirectedRuntime === true);
        this.setInputValue('orchestrationNeuralWaveResearchMode', String(orchestration.neuralWaveResearchMode === true));
        this.setCheckboxValue('settingsNeuralWaveResearchMode', orchestration.neuralWaveResearchMode === true);
        this.setInputValue('orchestrationPerplexityResearchLevel', orchestration.perplexityResearchLevel || 'auto');
        this.setInputValue('settingsPerplexityResearchLevel', orchestration.perplexityResearchLevel || 'auto');
        this.setInputValue('orchestrationAfterProcessAuditEnabled', String(orchestration.afterProcessAuditEnabled !== false));
        this.setCheckboxValue('settingsAfterProcessAuditEnabled', orchestration.afterProcessAuditEnabled !== false);
        this.setInputValue('orchestrationAsyncRuntimeEnabled', String(asyncRuntime.requestedEnabled === true || asyncRuntime.enabled === true));
        this.setCheckboxValue('settingsAsyncRuntimeEnabled', asyncRuntime.requestedEnabled === true || asyncRuntime.enabled === true);
        this.setInputValue('orchestrationAsyncRuntimeWebChatParallel', String(asyncRuntime.webChatParallelEnabled === true));
        this.setCheckboxValue('settingsAsyncRuntimeWebChatParallel', asyncRuntime.webChatParallelEnabled === true);
        this.setInputValue('orchestrationAsyncRuntimeAllowLiveRemote', String(asyncRuntime.liveRemoteRequested === true || asyncRuntime.allowLiveRemote === true));
        this.setCheckboxValue('settingsAsyncRuntimeAllowLiveRemote', asyncRuntime.liveRemoteRequested === true || asyncRuntime.allowLiveRemote === true);
        this.setCheckboxValue('settingsAgentCompanyEnabled', agentCompany.enabled === true);
        this.setInputValue('settingsAgentCompanyGoal', agentCompany.companyGoal || '', { preserveDirty });
        this.setInputValue('settingsAgentCompanyHeartbeatMinutes', agentCompany.heartbeatMinutes || 60);
        this.setInputValue('settingsAgentCompanyWeeklyWorkloadLimit', agentCompany.weeklyWorkloadLimit || 3);
        this.setInputValue('settingsAgentCompanyMaxConcurrentWorkloads', agentCompany.maxConcurrentWorkloads || 1);
        this.setInputValue('settingsAgentCompanyPrimaryModel', agentCompany.primaryModel || '', { preserveDirty });
        this.setInputValue('settingsAgentCompanyEscalationModels', (agentCompany.escalationModels || []).join(', '), { preserveDirty });
        const asyncRuntimeStatus = document.getElementById('settingsAsyncRuntimeStatus');
        if (asyncRuntimeStatus) {
            const availability = asyncRuntime.adminToggleAllowed
                ? (asyncRuntime.valkeyConfigured ? 'Valkey configured' : 'Valkey not configured')
                : 'Deployment toggle disabled';
            const mode = asyncRuntime.enabled ? 'active' : (asyncRuntime.requestedEnabled ? 'requested' : 'standby');
            const remoteMode = asyncRuntime.allowLiveRemote ? 'live remote allowed' : 'dry-run remote mode';
            asyncRuntimeStatus.textContent = `${availability}; ${mode}; ${remoteMode}.`;
        }
        apiClient.baseUrl = window.location.origin;

        this.setCheckboxValue('featureWebsocket', Boolean(features.realTimeUpdates));
        this.setCheckboxValue('featureCaching', Boolean(features.featureCaching));
        this.setCheckboxValue('featureRetry', Number(api.maxRetries ?? 0) > 0);
        this.setCheckboxValue('featureSkillDiscovery', Boolean(features.enableSkills));
        this.setCheckboxValue('featureValidation', Boolean(features.enableTracing));
        this.setCheckboxValue('featurePiiCleansing', Boolean(privacyPii.enabled));
        this.setCheckboxValue('featureDebug', Boolean(features.enableDebug));
        this.renderPrivacyPiiSettings(privacyPii);

        ['defaultTemperature', 'defaultTopP', 'defaultFrequencyPenalty', 'defaultPresencePenalty'].forEach((id) => {
            this.syncRangeValue(id);
        });

        const sshSummary = document.getElementById('sshConfigSummary');
        if (sshSummary) {
            const summary = ssh.enabled === false
                ? 'SSH defaults are disabled.'
                : ssh.configured
                ? `SSH defaults active from ${ssh.source || 'dashboard'} for ${ssh.username || 'user'}@${ssh.host || 'host'}:${ssh.port || 22}${ssh.hasPassword ? ' with a stored password' : (ssh.privateKeyPath ? ' with a private key' : '')}.`
                : 'No complete SSH credential set is configured yet.';
            sshSummary.textContent = summary;
        }

        const deploy = settings.integrations?.deploy || {};

        this.setInputValue('deployRepositoryUrl', deploy.repositoryUrl || '');
        this.setInputValue('deployBranch', deploy.branch || 'master');
        this.setInputValue('deployTargetDirectory', deploy.targetDirectory || '');
        this.setInputValue('deployManifestsPath', deploy.manifestsPath || 'k8s');
        this.setInputValue('deployNamespace', deploy.namespace || 'kimibuilt');
        this.setInputValue('deployDeployment', deploy.deployment || 'backend');
        this.setInputValue('deployContainer', deploy.container || 'backend');
        this.setInputValue('deployPublicDomain', deploy.publicDomain || 'demoserver2.buzz');
        this.setInputValue('deployIngressClassName', deploy.ingressClassName || 'traefik');
        this.setInputValue('deployTlsClusterIssuer', deploy.tlsClusterIssuer || 'letsencrypt-prod');
    }

    setStatusBadge(element, tone = 'neutral', label = '') {
        if (!element) {
            return;
        }

        element.className = `status-badge ${tone}`;
        element.textContent = label;
    }

    setInputValue(id, value, { preserveDirty = false } = {}) {
        const element = document.getElementById(id);
        if (!element || value === undefined || value === null) return;
        const nextValue = String(value);

        if (preserveDirty && this.isInputDirty(id)) {
            return false;
        }

        if (element.tagName === 'SELECT') {
            const exists = Array.from(element.options).some((option) => option.value === nextValue);
            if (!exists) {
                const option = document.createElement('option');
                option.value = nextValue;
                option.textContent = nextValue;
                element.appendChild(option);
            }
        }

        element.value = nextValue;
        element.dataset.lastAppliedValue = nextValue;
        this.dirtyInputIds?.delete(id);
        return true;
    }

    markInputDirty(id) {
        const element = document.getElementById(id);
        if (!element) return;
        const lastApplied = element.dataset.lastAppliedValue;
        if (lastApplied === undefined || element.value !== lastApplied) {
            this.dirtyInputIds.add(id);
        } else {
            this.dirtyInputIds.delete(id);
        }
    }

    isInputDirty(id) {
        return this.dirtyInputIds?.has(id) === true;
    }

    clearDurablePromptDirtyState() {
        ['soulContent', 'userProfileContent', 'agentNotesContent'].forEach((id) => {
            this.dirtyInputIds.delete(id);
        });
    }

    setCheckboxValue(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.checked = Boolean(value);
        }
    }

    syncRangeValue(id) {
        const input = document.getElementById(id);
        if (!input) return;

        const display = input.parentElement?.querySelector('.range-value');
        if (display) {
            display.textContent = input.value;
        }
    }

    syncAgentNotesCharacterCount() {
        const input = document.getElementById('agentNotesContent');
        const display = document.getElementById('agentNotesCharacterCount');
        if (!input || !display) return;

        display.textContent = String(input.value.length);
    }

    syncSoulCharacterCount() {
        const input = document.getElementById('soulContent');
        const display = document.getElementById('soulCharacterCount');
        if (!input || !display) return;

        display.textContent = String(input.value.length);
    }

    syncUserProfileCharacterCount() {
        const input = document.getElementById('userProfileContent');
        const display = document.getElementById('userProfileCharacterCount');
        if (!input || !display) return;

        display.textContent = String(input.value.length);
    }
    
    // ==================== MOCK DATA ====================
    
    getMockModels() {
        return [
            { id: '1', name: 'GPT-4o', provider: 'OpenAI', active: true, requests: 842, avgLatency: 145, capabilities: ['vision', 'function-calling', 'json-mode'] },
            { id: '2', name: 'GPT-4o Mini', provider: 'OpenAI', active: true, requests: 312, avgLatency: 89, capabilities: ['function-calling', 'json-mode'] },
            { id: '3', name: 'GPT-4 Turbo', provider: 'OpenAI', active: true, requests: 156, avgLatency: 234, capabilities: ['vision', 'function-calling'] },
            { id: '4', name: 'GPT-3.5 Turbo', provider: 'OpenAI', active: false, requests: 93, avgLatency: 67, capabilities: ['function-calling'] }
        ];
    }
    
    getMockPrompts() {
        return [
            { id: '1', name: 'Default Assistant', content: 'You are a helpful AI assistant.', updatedAt: new Date().toISOString() },
            { id: '2', name: 'Code Reviewer', content: 'You are an expert code reviewer. Analyze the provided code for bugs, performance issues, and best practices.', updatedAt: new Date(Date.now() - 86400000).toISOString() },
            { id: '3', name: 'Documentation Writer', content: 'Create clear, comprehensive documentation for the given topic or code.', updatedAt: new Date(Date.now() - 172800000).toISOString() }
        ];
    }
    
    getMockSkills() {
        return [
            { id: '1', name: 'File Parser', category: 'builtin', description: 'Parse and extract content from various file formats', enabled: true, usageCount: 456, successRate: 98 },
            { id: '2', name: 'Web Search', category: 'builtin', description: 'Search the web for current information', enabled: true, usageCount: 234, successRate: 95 },
            { id: '3', name: 'Code Executor', category: 'custom', description: 'Execute code in various languages safely', enabled: true, usageCount: 123, successRate: 92 },
            { id: '4', name: 'Database Query', category: 'custom', description: 'Query connected databases using natural language', enabled: false, usageCount: 89, successRate: 88 }
        ];
    }
    
    getMockLogs() {
        const logs = [];
        const levels = ['info', 'warn', 'error', 'debug'];
        const models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
        const statuses = ['success', 'success', 'success', 'error'];
        
        for (let i = 0; i < 50; i++) {
            logs.push({
                id: `log-${i}`,
                timestamp: new Date(Date.now() - i * 60000).toISOString(),
                level: levels[Math.floor(Math.random() * levels.length)],
                model: models[Math.floor(Math.random() * models.length)],
                prompt: `Sample prompt request ${i}`,
                response: `Sample response ${i}`,
                tokens: Math.floor(Math.random() * 2000) + 100,
                latency: Math.floor(Math.random() * 500) + 50,
                status: statuses[Math.floor(Math.random() * statuses.length)]
            });
        }
        
        return logs;
    }
    
    getMockTraces() {
        return [
            {
                id: 'trace-1',
                name: 'Document Processing',
                status: 'completed',
                startedAt: new Date().toISOString(),
                duration: 2345,
                steps: 5,
                steps: [
                    { name: 'Parse Request', offset: 0, status: 'success', details: 'Request parsed successfully' },
                    { name: 'Load Document', offset: 234, status: 'success', details: 'Document loaded from storage' },
                    { name: 'Extract Text', offset: 567, status: 'success', details: 'Text extracted using OCR' },
                    { name: 'Process Content', offset: 1234, status: 'success', details: 'Content processed by AI' },
                    { name: 'Generate Response', offset: 2345, status: 'success', details: 'Response generated' }
                ]
            },
            {
                id: 'trace-2',
                name: 'Code Analysis',
                status: 'running',
                startedAt: new Date(Date.now() - 30000).toISOString(),
                duration: 1234,
                steps: 3,
                steps: [
                    { name: 'Parse Request', offset: 0, status: 'success', details: 'Request parsed successfully' },
                    { name: 'Load Files', offset: 345, status: 'success', details: 'Files loaded from repository' },
                    { name: 'Analyze Code', offset: 1234, status: 'running', details: 'Analyzing code structure...' }
                ]
            },
            {
                id: 'trace-3',
                name: 'Data Transformation',
                status: 'failed',
                startedAt: new Date(Date.now() - 3600000).toISOString(),
                duration: 890,
                steps: 4,
                steps: [
                    { name: 'Parse Request', offset: 0, status: 'success', details: 'Request parsed successfully' },
                    { name: 'Load Data', offset: 234, status: 'success', details: 'Data loaded from database' },
                    { name: 'Transform', offset: 567, status: 'error', details: 'Transformation failed: Invalid schema' },
                    { name: 'Save Results', offset: 890, status: 'error', details: 'Skipped due to previous error' }
                ]
            }
        ];
    }
}

// ==================== INITIALIZATION ====================

let dashboard;

document.addEventListener('DOMContentLoaded', () => {
    dashboard = new Dashboard();
    window.dashboard = dashboard; // Expose for debugging
});
