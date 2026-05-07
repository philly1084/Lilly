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
            workloadsAvailable: true,
            workloadsSupported: null,
            workloadErrorMessage: '',
            editingWorkloadId: null,
            settings: {},
            storage: null,
            tokenAnalysis: null,
            lillyHistory: null,
            stats: {
                totalTasks: 0,
                successRate: 0,
                activeSessions: 0,
                skillsLearned: 0
            },
            pagination: {
                logs: { page: 1, limit: 50, total: 0 },
                traces: { page: 1, limit: 20, total: 0 }
            }
        };
        
        this.charts = {};
        this.ws = null;
        this.reconnectInterval = null;
        this.refreshInterval = null;
        
        this.init();
    }
    
    /**
     * Initialize the dashboard
     */
    async init() {
        this.setupEventListeners();
        this.setupNavigation();
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
        
        const connected = document.querySelector('#connectionStatus .status-dot')?.classList.contains('online');
        this.showToast(connected ? 'Dashboard connected' : 'Dashboard loaded in degraded mode', connected ? 'success' : 'warning');
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
        });
        
        // Prompt editor toolbar
        document.querySelectorAll('.toolbar-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.insertVariable(btn.dataset.insert);
            });
        });
        
        // Prompt editor input
        document.getElementById('promptEditor')?.addEventListener('input', (e) => {
            this.updatePromptEditor(e.target.value);
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
                this.switchSettingsSection(e.target.dataset.settings);
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

        document.getElementById('resetAgentNotesBtn')?.addEventListener('click', () => {
            this.resetAgentNotes();
        });

        document.getElementById('agentNotesContent')?.addEventListener('input', () => {
            this.syncAgentNotesCharacterCount();
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
            item.addEventListener('click', () => {
                const view = item.dataset.view;
                if (view) {
                    this.navigateTo(view);
                    this.closeMobileNavigation();
                }
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
            item.classList.toggle('active', item.dataset.view === view);
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

    renderLillyHistory(history = {}) {
        const statsContainer = document.getElementById('lillyWikiStats');
        const phaseContainer = document.getElementById('lillyPhaseMap');
        const collageContainer = document.getElementById('lillyPrCollage');
        const threadsContainer = document.getElementById('lillyGrowthThreads');
        const timelineContainer = document.getElementById('lillyTimeline');

        if (!statsContainer || !phaseContainer || !collageContainer || !threadsContainer || !timelineContainer) {
            return;
        }

        const totalPulls = Number(history.totalPulls || 0);
        const codexSessionCount = Number(history.codexSessions?.count || 0);

        statsContainer.innerHTML = [
            { label: 'Repo pulls', value: totalPulls.toLocaleString(), detail: `${this.escapeHtml(history.firstDate || 'start')} to ${this.escapeHtml(history.lastDate || 'now')}` },
            { label: 'Repair pulls', value: Number(history.repairPulls || 0).toLocaleString(), detail: 'fix, harden, restore, stabilize' },
            { label: 'Growth pulls', value: Number(history.growthPulls || 0).toLocaleString(), detail: 'add, enable, support, expand' },
            { label: 'Codex logs', value: codexSessionCount ? codexSessionCount.toLocaleString() : 'optional', detail: history.codexSessions?.available ? 'session traces visible' : 'not visible here' },
        ].map((item) => `
            <div class="lilly-stat">
                <span class="lilly-stat-value">${item.value}</span>
                <span class="lilly-stat-label">${item.label}</span>
                <span class="lilly-stat-detail">${item.detail}</span>
            </div>
        `).join('');

        const maxPhaseCount = Math.max(1, ...(history.phases || []).map((phase) => Number(phase.count || 0)));
        phaseContainer.innerHTML = (history.phases || []).map((phase) => {
            const width = Math.max(8, Math.round((Number(phase.count || 0) / maxPhaseCount) * 100));
            const tagText = (phase.tagCounts || [])
                .slice(0, 4)
                .map((tag) => `${this.escapeHtml(tag.label)} ${Number(tag.count || 0).toLocaleString()}`)
                .join(' | ');

            return `
                <article class="lilly-phase-card lilly-phase-${this.escapeHtml(phase.id)}">
                    <div class="lilly-phase-topline">
                        <span class="lilly-phase-label">${this.escapeHtml(phase.label)}</span>
                        <span class="lilly-phase-count">${Number(phase.count || 0).toLocaleString()} pulls</span>
                    </div>
                    <div class="lilly-phase-range">${this.escapeHtml(phase.from)} to ${phase.to === '2099-12-31' ? 'now' : this.escapeHtml(phase.to)}</div>
                    <p>${this.escapeHtml(phase.summary || '')}</p>
                    <div class="lilly-phase-meter"><span style="width: ${width}%"></span></div>
                    <div class="lilly-phase-tags">${tagText || 'mixed work'}</div>
                </article>
            `;
        }).join('');

        const tiles = Array.isArray(history.tiles) ? history.tiles : [];
        collageContainer.innerHTML = `
            <div class="lilly-collage-summary">
                <div>
                    <strong>${totalPulls.toLocaleString()}</strong>
                    <span>dots, one for each repo pull in local history</span>
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
                    <a class="lilly-recent-pull lilly-tag-border-${this.escapeHtml(commit.primaryTag || 'maintenance')}" href="https://github.com/philly1084/KimiBuilt/commit/${this.escapeHtml(commit.hash || '')}" target="_blank" rel="noopener">
                        <span>${this.escapeHtml(commit.shortHash || '')}</span>
                        <strong>${this.escapeHtml(commit.subject || '')}</strong>
                        <em>${this.escapeHtml(commit.date || '')}</em>
                    </a>
                `).join('')}
            </div>
        `;

        threadsContainer.innerHTML = (history.categories || []).map((category) => {
            const percent = totalPulls ? Math.round((Number(category.count || 0) / totalPulls) * 100) : 0;
            return `
                <div class="lilly-thread">
                    <div class="lilly-thread-header">
                        <span class="lilly-thread-name lilly-tag-text-${this.escapeHtml(category.id)}">${this.escapeHtml(category.label)}</span>
                        <span>${Number(category.count || 0).toLocaleString()} pulls</span>
                    </div>
                    <div class="lilly-thread-meter">
                        <span class="lilly-tag-bg-${this.escapeHtml(category.id)}" style="width: ${Math.max(3, percent)}%"></span>
                    </div>
                    <p>${this.escapeHtml(this.describeLillyThread(category.id))}</p>
                </div>
            `;
        }).join('');

        timelineContainer.innerHTML = (history.phases || []).map((phase) => `
            <article class="lilly-timeline-step">
                <div class="lilly-timeline-marker"></div>
                <div>
                    <div class="lilly-timeline-heading">
                        <span>${this.escapeHtml(phase.label)}</span>
                        <span>${Number(phase.count || 0).toLocaleString()} pulls</span>
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
            repair: 'The repair lane is the proof of pressure: crash loops, fallbacks, regressions, CORS, PDF, storage, and routing fixes that kept Lilly usable while it grew.',
            growth: 'The growth lane is where new surfaces appeared: tools, routes, workflows, documents, remote runners, podcast/video paths, skills, and orchestration abilities.',
            interface: 'The interface lane tracks the visible shape of Lilly across web chat, notes, canvas, CLI, admin, voxel polish, and dashboard diagnostics.',
            ops: 'The operations lane made Lilly deployable: k3s, Rancher, Docker, GitLab, ingress, secrets, runners, and live-cluster proof loops.',
            media: 'The media and document lane covers PDFs, generated docs, images, podcasts, audio, video, templates, and the asset flows around them.',
            intelligence: 'The intelligence lane is the system learning to plan: memory, tools, models, prompts, skills, Symphony, and agent orchestration.',
        };

        return descriptions[categoryId] || 'Mixed maintenance and build work that does not fit cleanly into one lane.';
    }

    getLillyHistoryFallback() {
        return {
            generatedAt: new Date().toISOString(),
            source: 'fallback static wiki seed',
            totalPulls: 774,
            mergedPullRequests: 11,
            repairPulls: 308,
            growthPulls: 246,
            firstDate: '2026-03-04',
            lastDate: '2026-05-03',
            codexSessions: { available: false, count: 0 },
            categories: [
                { id: 'repair', label: 'Repair', count: 308 },
                { id: 'growth', label: 'Growth', count: 246 },
                { id: 'interface', label: 'Interface', count: 214 },
                { id: 'ops', label: 'Ops', count: 150 },
                { id: 'media', label: 'Media + Docs', count: 170 },
                { id: 'intelligence', label: 'Intelligence', count: 220 },
            ],
            phases: [
                { id: 'ignition', label: 'Ignition', from: '2026-03-04', to: '2026-03-11', count: 74, summary: 'The first backend, frontend, deployment, and document pieces came online.', tagCounts: [], highlights: [] },
                { id: 'notes-admin', label: 'Notes + Admin Spine', from: '2026-03-12', to: '2026-03-18', count: 112, summary: 'Notes, admin, auth, PDFs, and crash recovery started becoming a working product surface.', tagCounts: [], highlights: [] },
                { id: 'runtime', label: 'Agent Runtime', from: '2026-03-19', to: '2026-03-25', count: 138, summary: 'Tool calls, memory, artifacts, and remote command routing became core platform behavior.', tagCounts: [], highlights: [] },
                { id: 'remote-builds', label: 'Remote Builds', from: '2026-03-26', to: '2026-04-18', count: 120, summary: 'Build, deploy, repair, and generated artifact paths expanded across the system.', tagCounts: [], highlights: [] },
                { id: 'polish-pipeline', label: 'Polish Pipeline', from: '2026-04-19', to: '2026-04-25', count: 126, summary: 'Session polish, document workflows, remote runners, and artifact handling tightened up.', tagCounts: [], highlights: [] },
                { id: 'media-symphony', label: 'Media + Symphony', from: '2026-04-26', to: '2026-05-01', count: 126, summary: 'Podcast, video, image gateways, Symphony, GitLab, and diagnostics became major branches.', tagCounts: [], highlights: [] },
                { id: 'live-learning', label: 'Live Learning', from: '2026-05-02', to: 'now', count: 78, summary: 'Kokoro, k3s proof loops, skills, frontend standards, and prompt state machines made Lilly sturdier.', tagCounts: [], highlights: [] },
            ],
            tiles: Array.from({ length: 774 }, (_, index) => ({
                index: index + 1,
                date: '',
                subject: 'Lilly build pull',
                primaryTag: ['repair', 'growth', 'interface', 'ops', 'media', 'intelligence'][index % 6],
            })),
            recent: [],
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
            document.getElementById('skillsLearned').textContent = stats.skillsLearned;
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
    async loadPrompts() {
        try {
            const response = await apiClient.get('/api/admin/prompts');
            const prompts = this.unwrapApiPayload(response, []);
            this.state.prompts = prompts;
            this.renderPromptList(prompts);
            
            if (prompts.length > 0 && !this.state.selectedPrompt) {
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
    
    /**
     * Load settings
     */
    async loadSettings() {
        try {
            const [settingsResponse, podcastAudioResponse, storageResponse] = await Promise.allSettled([
                apiClient.get('/api/admin/settings'),
                apiClient.get('/api/admin/podcast-audio'),
                apiClient.get('/api/admin/storage'),
            ]);

            if (settingsResponse.status === 'fulfilled') {
                const settings = this.unwrapApiPayload(settingsResponse.value, null);
                if (settings) {
                    this.state.settings = settings;
                    this.applySettings(settings);
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
                 data-id="${prompt.id}" onclick="dashboard.selectPromptById('${prompt.id}')">
                <span class="prompt-item-name">${this.escapeHtml(prompt.name)}</span>
                <span class="prompt-item-meta">${this.escapeHtml(prompt.assignment || prompt.category || 'runtime slot')}</span>
            </div>
        `).join('');
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
                 onclick="dashboard.selectTrace('${trace.id}')">
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
            <tr class="workload-run-row ${this.state.selectedRun?.id === run.id ? 'selected' : ''}" onclick="dashboard.selectAdminRun('${run.id}')">
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
        const container = document.getElementById('adminRunDetails');
        if (!container) return;

        if (error) {
            container.innerHTML = `<p class="empty-state">Failed to load run details: ${this.escapeHtml(error.message || 'unknown error')}</p>`;
            return;
        }

        if (!run) {
            container.innerHTML = `<p class="empty-state">${this.escapeHtml(emptyMessage)}</p>`;
            return;
        }

        const metadata = this.stringifyAdminPayload(run.metadata);
        const errorPayload = this.stringifyAdminPayload(run.error);
        const tracePayload = this.stringifyAdminPayload(run.trace);

        container.innerHTML = `
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
                <div class="workload-detail-code">${this.escapeHtml(run.prompt || '')}</div>
            </div>
            <div class="workload-detail-block">
                <h4>Metadata</h4>
                <div class="workload-detail-code">${this.escapeHtml(metadata)}</div>
            </div>
            <div class="workload-detail-block">
                <h4>Error</h4>
                <div class="workload-detail-code">${this.escapeHtml(errorPayload)}</div>
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
                <div class="workload-detail-code">${this.escapeHtml(tracePayload)}</div>
            </div>
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
    }

    closeMobileNavigation() {
        this.syncMobileNavigationState(false);
    }

    toggleMobileNavigation() {
        const sidebar = document.getElementById('sidebar');
        this.syncMobileNavigationState(!sidebar?.classList.contains('open'));
    }

    toggleSidebar() {
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        document.getElementById('sidebar').classList.toggle('collapsed', this.state.sidebarCollapsed);
        document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(!this.state.sidebarCollapsed));
    }
    
    selectPrompt(prompt) {
        this.state.selectedPrompt = prompt;
        
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
        document.querySelectorAll('.prompt-item').forEach(item => {
            item.classList.toggle('active', item.dataset.id === prompt.id);
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
                item.classList.toggle('active', item.dataset.id === id);
            });
        }
    }

    async selectAdminRun(id) {
        const existing = this.state.runs.find((run) => run.id === id) || null;
        this.state.selectedRun = existing;
        this.renderAdminRuns(this.state.runs);
        this.renderAdminRunDetails(existing);

        try {
            const response = await apiClient.getAdminRun(id);
            const detailedRun = this.normalizeAdminRun(this.unwrapApiPayload(response, existing || {}), this.state.workloads);
            this.replaceAdminRunInState(detailedRun);
            this.renderAdminRuns(this.state.runs);
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
                    defaultModel: document.getElementById('orchestrationDefaultModel').value.trim(),
                    plannerModel: document.getElementById('orchestrationPlannerModel').value.trim(),
                    synthesisModel: document.getElementById('orchestrationSynthesisModel').value.trim(),
                    repairModel: document.getElementById('orchestrationRepairModel').value.trim(),
                    fallbackModels: this.parseDelimitedList(document.getElementById('orchestrationFallbackModels').value),
                    plannerReasoningEffort: document.getElementById('orchestrationPlannerReasoning').value,
                    synthesisReasoningEffort: document.getElementById('orchestrationSynthesisReasoning').value,
                    repairReasoningEffort: document.getElementById('orchestrationRepairReasoning').value,
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
    
    switchSettingsSection(section) {
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.settings === section);
        });
        
        document.querySelectorAll('.settings-section').forEach(s => {
            s.classList.toggle('active', s.id === `${section}Settings`);
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

        if (records.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No managed artifacts found.</td></tr>';
            return;
        }

        tableBody.innerHTML = records.slice(0, 150).map((record) => {
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

            return `
                <tr>
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
                            >${deleteLabel}</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tableBody.querySelectorAll('.storage-delete-file').forEach((button) => {
            button.addEventListener('click', () => {
                this.deleteStorageRecord(button.dataset.category, button.dataset.id);
            });
        });
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
        const dot = document.querySelector('#connectionStatus .status-dot');
        const text = document.querySelector('#connectionStatus .status-text');
        
        if (dot && text) {
            dot.classList.toggle('online', connected);
            dot.classList.toggle('offline', !connected);
            text.textContent = connected ? 'Connected' : 'Disconnected';
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
            skillsLearned: Number(overview.totalSkills || payload.skillsLearned || 0),
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
        
        const icons = {
            success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
            error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };
        
        toast.innerHTML = `
            <div class="toast-icon">${icons[type]}</div>
            <div class="toast-content">
                <span class="toast-title">${message}</span>
            </div>
            <button class="toast-close">&times;</button>
        `;
        
        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        });
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        }, duration);
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
            <div class="trace-item ${this.state.selectedTrace?.id === trace.id ? 'active' : ''}" data-id="${trace.id}"
                 onclick="dashboard.selectTrace('${trace.id}')">
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
                agentNotes: {
                    enabled: document.getElementById('agentNotesEnabled').checked,
                    displayName: document.getElementById('agentNotesName').value.trim(),
                    content: document.getElementById('agentNotesContent').value,
                },
            };

            const response = await apiClient.put('/api/admin/settings', settings);
            this.applySettings(this.unwrapApiPayload(response, settings));
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

    async resetPersonality() {
        if (!confirm('Reset soul.md to the default personality?')) {
            return;
        }

        try {
            const response = await apiClient.post('/api/admin/settings/reset', {
                section: 'personality',
            });
            this.applySettings(this.unwrapApiPayload(response, this.state.settings));
            this.showToast('soul.md reset to default', 'success');
        } catch (error) {
            console.error('Error resetting soul.md:', error);
            this.showToast('Failed to reset soul.md', 'error');
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
            this.applySettings(this.unwrapApiPayload(response, this.state.settings));
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

        return {
            features: {
                [key]: enabled,
            },
        };
    }

    syncModelOptions(models = this.state.models) {
        const select = document.getElementById('defaultModel');
        if (!select) return;

        const existing = new Set(Array.from(select.options).map((option) => option.value));
        (models || []).forEach((model) => {
            if (existing.has(model.id)) return;
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            select.appendChild(option);
        });

        if (this.state.settings?.models?.defaultModel) {
            select.value = this.state.settings.models.defaultModel;
        }
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

    applySettings(settings = {}) {
        this.state.settings = settings;

        const general = settings.general || {};
        const models = settings.models || {};
        const api = settings.api || {};
        const features = settings.features || {};
        const orchestration = settings.orchestration || {};
        const personality = settings.personality || {};
        const agentNotes = settings.agentNotes || {};
        const ssh = settings.integrations?.ssh || {};

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
        this.setInputValue('soulContent', personality.content || '');
        this.setInputValue(
            'personalityUpdatedAt',
            personality.updatedAt ? this.formatDate(personality.updatedAt) : 'Default content',
        );
        const soulFilePathLabel = document.getElementById('soulFilePathLabel');
        if (soulFilePathLabel) {
            soulFilePathLabel.textContent = personality.filePath || 'soul.md';
        }

        this.setCheckboxValue('agentNotesEnabled', agentNotes.enabled !== false);
        this.setInputValue('agentNotesName', agentNotes.displayName || 'Carryover Notes');
        this.setInputValue('agentNotesContent', agentNotes.content || '');
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
        this.setInputValue('orchestrationDefaultModel', orchestration.defaultModel || 'gpt-5.5');
        this.setInputValue('orchestrationPlannerModel', orchestration.plannerModel || orchestration.defaultModel || 'gpt-5.5');
        this.setInputValue('orchestrationSynthesisModel', orchestration.synthesisModel || orchestration.defaultModel || 'gpt-5.5');
        this.setInputValue('orchestrationRepairModel', orchestration.repairModel || orchestration.defaultModel || 'gpt-5.5');
        this.setInputValue('orchestrationFallbackModels', this.joinListForTextarea(orchestration.fallbackModels || ['gemini-3.1-pro', 'groq-compound']));
        this.setInputValue('orchestrationPlannerReasoning', orchestration.plannerReasoningEffort || 'high');
        this.setInputValue('orchestrationSynthesisReasoning', orchestration.synthesisReasoningEffort || 'medium');
        this.setInputValue('orchestrationRepairReasoning', orchestration.repairReasoningEffort || 'high');
        apiClient.baseUrl = window.location.origin;

        this.setCheckboxValue('featureWebsocket', Boolean(features.realTimeUpdates));
        this.setCheckboxValue('featureCaching', Boolean(features.featureCaching));
        this.setCheckboxValue('featureRetry', Number(api.maxRetries ?? 0) > 0);
        this.setCheckboxValue('featureSkillDiscovery', Boolean(features.enableSkills));
        this.setCheckboxValue('featureValidation', Boolean(features.enableTracing));
        this.setCheckboxValue('featureDebug', Boolean(features.enableDebug));

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

    setInputValue(id, value) {
        const element = document.getElementById(id);
        if (!element || value === undefined || value === null) return;

        if (element.tagName === 'SELECT') {
            const exists = Array.from(element.options).some((option) => option.value === String(value));
            if (!exists) {
                const option = document.createElement('option');
                option.value = String(value);
                option.textContent = String(value);
                element.appendChild(option);
            }
        }

        element.value = String(value);
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
