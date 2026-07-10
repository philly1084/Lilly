const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadDashboardClass(dom) {
    const sourcePath = path.join(__dirname, 'dashboard.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /let dashboard;\s*document\.addEventListener\('DOMContentLoaded', \(\) => \{\s*dashboard = new Dashboard\(\);\s*window\.dashboard = dashboard; \/\/ Expose for debugging\s*\}\);\s*$/,
            'module.exports = { Dashboard };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        document: dom.window.document,
        window: dom.window,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports.Dashboard;
}

function createNavigationHarness({ isMobile = true } = {}) {
    const dom = new JSDOM(`
        <button id="mobileMenuToggle" type="button" aria-controls="sidebar" aria-expanded="false">Menu</button>
        <aside id="sidebar">
        <nav>
            <ul>
                <li><button class="nav-item active" data-view="overview" type="button"><span>Overview</span></button></li>
                <li><button class="nav-item" data-view="logs" type="button"><span>Logs</span></button></li>
            </ul>
        </nav>
        </aside>
        <button id="sidebarToggle" type="button" aria-controls="sidebar" aria-label="Collapse admin navigation" aria-expanded="true"></button>
        <div id="sidebarBackdrop" hidden></div>
        <section id="overviewView" class="view active"></section>
        <section id="logsView" class="view"></section>
        <h1 id="pageTitle">Overview</h1>
        <div class="breadcrumbs"><span class="current">Overview</span></div>
    `, { url: 'http://localhost:3000/admin/' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    dom.window.matchMedia = jest.fn().mockReturnValue({ matches: isMobile });

    dashboard.state = { currentView: 'overview', sidebarCollapsed: false };
    dashboard.loadViewData = jest.fn();
    dashboard.setupNavigation();

    return { dom, dashboard };
}

function createSettingsHarness() {
    const dom = new JSDOM(`
        <div class="settings-nav">
            <button class="settings-nav-item active" data-settings="general">General</button>
            <button class="settings-nav-item" data-settings="api">API</button>
        </div>
        <div class="settings-section active" id="generalSettings"></div>
        <div class="settings-section" id="apiSettings"></div>
    `, { url: 'http://localhost:3000/admin/?view=settings' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    dashboard.setupEventListeners();
    dashboard.setupSettingsNavigation();

    return { dashboard };
}

function createThemeHarness({ prefersLight = false, storedTheme = '' } = {}) {
    const dom = new JSDOM(`
        <body data-ui-surface="admin">
            <button id="themeToggle" type="button" aria-label="Toggle color theme"></button>
        </body>
    `, { url: 'http://localhost:3000/admin/' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    dom.window.matchMedia = jest.fn().mockReturnValue({ matches: prefersLight });

    if (storedTheme) {
        dom.window.localStorage.setItem('kimibuilt_admin_theme', storedTheme);
    }

    return { dom, dashboard };
}

function createPromptTabHarness({ mockSwitch = true } = {}) {
    const dom = new JSDOM(`
        <div class="editor-tabs">
            <button class="tab-btn active" data-tab="editor" aria-selected="true" tabindex="0">Editor</button>
            <button class="tab-btn" data-tab="preview" aria-selected="false" tabindex="-1">Preview</button>
        </div>
        <div class="tab-content active" id="editorTab"></div>
        <div class="tab-content" id="previewTab" hidden></div>
    `, { url: 'http://localhost:3000/admin/?view=prompts' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    if (mockSwitch) {
        dashboard.switchPromptTab = jest.fn();
    }
    dashboard.setupEventListeners();

    return { dom, dashboard };
}

function createRuntimeListHarness() {
    const dom = new JSDOM(`
        <div id="promptList"></div>
        <div id="traceQualitySummary"></div>
        <div id="traceEvalSummary"></div>
        <div id="tracesList"></div>
        <table><tbody id="adminRunsTableBody"></tbody></table>
    `, { url: 'http://localhost:3000/admin/?view=workloads' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    dom.window.dashboard = dashboard;

    dashboard.state = {
        prompts: [
            { id: 'prompt-a', name: 'Default prompt', assignment: 'chat' },
            { id: 'prompt-b', name: 'Research prompt', assignment: 'research' },
        ],
        selectedPrompt: { id: 'prompt-a' },
        selectedTrace: { id: 'trace-a' },
        selectedRun: { id: 'run-a' },
    };
    dashboard.formatPromptSurfaceMeta = Dashboard.prototype.formatPromptSurfaceMeta.bind(dashboard);
    dashboard.formatDate = jest.fn((value) => value || '-');
    dashboard.getRunStatusClass = jest.fn(() => 'healthy');

    return { dom, dashboard };
}

function createAgentCompanyHarness(options = {}) {
    const url = options.url || 'http://localhost:3000/admin/?view=agentCompany';
    const dom = new JSDOM(`
        <p id="agentCompanyGoalSummary"></p>
        <span id="companyHeartbeatStatus"></span>
        <span id="companyNextHeartbeat"></span>
        <span id="companyRunningCount"></span>
        <span id="companyQueuedCount"></span>
        <span id="companyWorkloadCount"></span>
        <span id="companyWeeklyLimit"></span>
        <span id="companyFailedCount"></span>
        <span id="companyAlignmentStatus"></span>
        <span id="agentCompanyBadge"></span>
        <span id="companyScheduleStatus"></span>
        <span id="companyRunStatus"></span>
        <span id="companyAlignmentNext"></span>
        <span id="companyModelPolicy"></span>
        <span id="companyWorkspaceStatus"></span>
        <span id="companyDeliverableStatus"></span>
        <span id="companyFileManagerStatus"></span>
        <span id="companyImprovementLoopStatus"></span>
        <textarea id="companyCeoDirection"></textarea>
        <input id="companyWorkSearch" type="search">
        <select id="companyWorkStatusFilter">
            <option value="all">All states</option>
            <option value="active">Active work</option>
            <option value="paused">Paused work</option>
            <option value="queued">Queued runs</option>
            <option value="running">Running runs</option>
            <option value="failed">Failed runs</option>
            <option value="completed">Completed runs</option>
        </select>
        <select id="companyRoleFilter">
            <option value="all">All roles</option>
        </select>
        <div id="companyActionQueue"></div>
        <div id="companyActionHistory"></div>
        <div id="companyDeliverableList"></div>
        <div id="companyFileList"></div>
        <div id="companyImprovementLoopSummary"></div>
        <div id="companyImprovementLoopPhases"></div>
        <div id="companySharedWhiteboard"></div>
        <div id="companyRoleList"></div>
        <div id="companyScheduleList"></div>
        <table><tbody id="companyWorkloadsTableBody"></tbody></table>
        <table><tbody id="companyRunsTableBody"></tbody></table>
        <div id="companyAlignmentPanel"></div>
        <div id="adminRunDetails"></div>
        <div id="companyRunDetails"></div>
    `, { url });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;
    dom.window.dashboard = dashboard;

    dashboard.state = {
        settings: {},
        agentCompanyStatus: {
            available: true,
            config: {
                companyGoal: 'Run a research studio that ships weekly outputs.',
                weeklyWorkloadLimit: 3,
                primaryModel: 'gpt-5.5',
                escalationModels: ['codex-latest'],
                sessionId: 'agent-company',
            },
            state: {
                companyGoalHash: 'goal-hash',
                heartbeat: {
                    status: 'scheduled',
                    nextAt: '2026-06-26T15:00:00.000Z',
                    failedWorkloads: 1,
                },
                runningWork: {
                    running: 1,
                    queued: 1,
                    companyWorkloads: 1,
                },
                roles: [
                    { id: 'strategy', name: 'Strategy Lead', mission: 'Plan the week.' },
                ],
                shortTermSchedule: [
                    {
                        title: 'Company weekly plan',
                        objective: 'Set operating priorities.',
                        roleName: 'Strategy Lead',
                        plannedFor: '2026-06-26T16:00:00.000Z',
                    },
                ],
                dailyAlignment: {
                    status: 'applied',
                    nextAt: '2026-06-27T15:00:00.000Z',
                    applied: [{ id: 'daily-proof-note' }],
                    evidence: {
                        logs: { count: 2 },
                        suggestions: { count: 1, safeCandidates: 1 },
                    },
                },
            },
        },
        workloads: [
            {
                id: 'company-workload',
                title: 'Strategy Lead: Company weekly plan',
                sessionId: 'agent-company',
                prompt: 'Plan the operating week.',
                enabled: true,
                trigger: { type: 'once', runAt: '2026-06-26T16:00:00.000Z' },
                metadata: {
                    agentCompany: {
                        enabled: true,
                        companyGoalHash: 'goal-hash',
                        roleName: 'Strategy Lead',
                        weekKey: '2026-06-22',
                        planItemId: 'plan-1',
                        sharedWhiteboard: {
                            path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                            sections: ['Claims checked', 'Decisions made', 'Next agent task'],
                        },
                    },
                },
                workloadSummary: { queued: 1, running: 1, failed: 0 },
            },
            {
                id: 'other-workload',
                title: 'Unrelated job',
                sessionId: 'general',
                prompt: 'Ignore me.',
                enabled: true,
                trigger: { type: 'manual' },
                metadata: {},
                workloadSummary: { queued: 0, running: 0, failed: 0 },
            },
        ],
        runs: [
            {
                id: 'company-run',
                workloadId: 'company-workload',
                workloadTitle: 'Strategy Lead: Company weekly plan',
                status: 'running',
                reason: 'heartbeat',
                scheduledFor: '2026-06-26T16:00:00.000Z',
            },
            {
                id: 'other-run',
                workloadId: 'other-workload',
                workloadTitle: 'Unrelated job',
                status: 'queued',
                reason: 'manual',
            },
        ],
        selectedRun: null,
        agentCompanyWorkspace: {
            workspace: {
                workloadAvailable: true,
                workloadCount: 1,
            },
            deliverables: [
                {
                    id: 'artifact-plan',
                    title: 'Weekly Plan',
                    filename: 'weekly-plan.pdf',
                    roleName: 'Strategy Lead',
                    workloadTitle: 'Strategy Lead: Company weekly plan',
                    updatedAt: '2026-06-26T18:00:00.000Z',
                    sizeBytes: 2048,
                    format: 'pdf',
                    formatLabel: 'PDF',
                    previewText: 'Executive plan with priorities, proof targets, and next review decisions.',
                    downloadUrl: '/api/artifacts/artifact-plan/download',
                    previewUrl: '/api/artifacts/artifact-plan/preview',
                },
            ],
            actionQueue: [
                {
                    id: 'review-deliverables',
                    label: 'Review business outputs',
                    detail: '1 deliverable ready for preview or download.',
                    target: 'deliverables',
                    priority: 'medium',
                },
            ],
            actionHistory: [
                {
                    id: 'review-completed-output',
                    actionKey: 'review-completed-output:historical-run',
                    label: 'Review saved output <script>alert("x")</script>',
                    detail: 'Saved run context from a previous company cycle.',
                    target: 'runs',
                    runId: 'historical-run',
                    outputPreview: 'Saved output preview.',
                    snapshotAt: '2026-06-28T05:12:00.000Z',
                },
            ],
            improvementLoop: {
                health: 'looping',
                cadence: {
                    nextHeartbeat: '2026-06-26T15:00:00.000Z',
                    dailyAlignment: '2026-06-27T15:00:00.000Z',
                },
                metrics: {
                    workloads: 1,
                    runs: 1,
                    running: 1,
                    queued: 1,
                    failed: 0,
                    deliverables: 1,
                    appliedLearning: 1,
                },
                phases: [
                    { id: 'sense', label: 'Sense', status: 'ready', detail: '1 company file available for review.' },
                    { id: 'plan', label: 'Plan', status: 'ready', detail: '1 planned work item in the current horizon.' },
                    { id: 'act', label: 'Act', status: 'ready', detail: '1 running and 1 queued company runs.' },
                    { id: 'verify', label: 'Verify', status: 'ready', detail: '1 deliverable ready for review.' },
                    { id: 'learn', label: 'Learn', status: 'ready', detail: '1 alignment update applied from recent evidence.' },
                ],
            },
            sharedWhiteboard: {
                status: 'ready',
                detail: '1 workload carrying the shared whiteboard contract.',
                current: {
                    path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                    purpose: 'agent-to-agent weekly coordination',
                    weekKey: '2026-06-22',
                    workloadCount: 1,
                    roleNames: ['Strategy Lead'],
                    sections: ['Claims checked', 'Decisions made', 'Next agent task'],
                    filePreview: {
                        status: 'ready',
                        detail: 'Indexed whiteboard preview is available.',
                        relativePath: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                        updatedAt: '2026-06-26T14:00:00.000Z',
                        sizeBytes: 512,
                        preview: 'Claims checked: public route works. Decisions made: keep DNS stable. Next agent task: verify deploy proof <script>alert("x")</script>.',
                    },
                },
            },
        },
        agentCompanyFiles: null,
        companyWorkSearch: '',
        companyWorkStatusFilter: 'all',
        companyRoleFilter: 'all',
        companyFileSearch: '',
        companyFileSourceFilter: 'any',
    };
    dashboard.formatDate = jest.fn((value) => value || '-');
    dashboard.getRunStatusClass = jest.fn(() => 'healthy');

    return { dom, dashboard };
}

describe('agent dashboard navigation accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
    });

    test('labels global header icon controls for assistive tech', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);

        expect(dom.window.document.getElementById('globalSearch').getAttribute('aria-label')).toBe('Search admin dashboard');
        const notificationsButton = dom.window.document.getElementById('notificationsBtn');
        const notificationsStatus = dom.window.document.getElementById('notificationsStatus');
        expect(notificationsButton.getAttribute('aria-label')).toBe('Check notifications');
        expect(notificationsButton.getAttribute('aria-describedby')).toBe('notificationsStatus');
        expect(notificationsButton.getAttribute('type')).toBe('button');
        expect(notificationsButton.querySelector('.notification-dot').getAttribute('aria-hidden')).toBe('true');
        expect(notificationsStatus.getAttribute('role')).toBe('status');
        expect(notificationsStatus.getAttribute('aria-live')).toBe('polite');
        expect(notificationsStatus.textContent).toBe('Notifications have not been checked yet.');
        expect(dom.window.document.getElementById('toastContainer').getAttribute('aria-live')).toBe('polite');
        expect(dom.window.document.getElementById('toastContainer').getAttribute('aria-atomic')).toBe('false');
        expect(dom.window.document.getElementById('connectionStatus').getAttribute('role')).toBe('status');
        expect(dom.window.document.getElementById('connectionStatus').getAttribute('aria-live')).toBe('polite');
        expect(dom.window.document.getElementById('connectionStatus').getAttribute('aria-atomic')).toBe('true');
        expect(dom.window.document.getElementById('connectionStatus').getAttribute('aria-label')).toBe('Dashboard connection status: Connected');
        expect(dom.window.document.querySelector('#connectionStatus .status-dot').getAttribute('aria-hidden')).toBe('true');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('aria-label')).toBe('Toggle color theme');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('type')).toBe('button');
    });

    test('labels overview card controls with their data context', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);

        const range = dom.window.document.getElementById('chartTimeRange');
        const recentActivityButton = dom.window.document.querySelector('#overviewView [data-view="logs"]');

        expect(range.getAttribute('aria-label')).toBe('Request volume time range');
        expect(recentActivityButton.getAttribute('type')).toBe('button');
        expect(recentActivityButton.getAttribute('aria-label')).toBe('View all recent activity logs');
    });

    test('exposes tool category filter state to assistive tech', () => {
        const dom = new JSDOM('<div id="skillCategories"></div><div id="skillsGrid"></div>');
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.state = {
            tools: [
                { id: 'tool-a', name: 'Tool A', category: 'builtin' },
                { id: 'tool-b', name: 'Tool B', category: 'custom_tool' },
            ],
        };
        dashboard.escapeHtml = Dashboard.prototype.escapeHtml.bind(dashboard);
        dashboard.renderSkills = jest.fn();
        dashboard.getFilteredTools = Dashboard.prototype.getFilteredTools.bind(dashboard);

        dashboard.renderSkillCategories(dashboard.state.tools);

        const allButton = document.querySelector('[data-category="all"]');
        const customButton = document.querySelector('[data-category="custom_tool"]');

        expect(allButton.getAttribute('type')).toBe('button');
        expect(allButton.getAttribute('aria-pressed')).toBe('true');
        expect(customButton.getAttribute('aria-pressed')).toBe('false');

        dashboard.filterSkills('custom_tool');

        expect(allButton.classList.contains('active')).toBe(false);
        expect(allButton.getAttribute('aria-pressed')).toBe('false');
        expect(customButton.classList.contains('active')).toBe(true);
        expect(customButton.getAttribute('aria-pressed')).toBe('true');
        expect(dashboard.renderSkills).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'tool-b' }),
        ]);
    });

    test('keeps the admin connection status label synchronized', () => {
        const dom = new JSDOM(`
            <div class="connection-status" id="connectionStatus" role="status" aria-live="polite" aria-atomic="true" aria-label="Dashboard connection status: Connected">
                <span class="status-dot online" aria-hidden="true"></span>
                <span class="status-text">Connected</span>
            </div>
        `);
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.updateConnectionStatus(false);

        expect(document.querySelector('#connectionStatus .status-dot').classList.contains('offline')).toBe(true);
        expect(document.querySelector('#connectionStatus .status-text').textContent).toBe('Disconnected');
        expect(document.getElementById('connectionStatus').getAttribute('aria-label')).toBe('Dashboard connection status: Disconnected');

        dashboard.updateConnectionStatus(true);

        expect(document.querySelector('#connectionStatus .status-dot').classList.contains('online')).toBe(true);
        expect(document.querySelector('#connectionStatus .status-text').textContent).toBe('Connected');
        expect(document.getElementById('connectionStatus').getAttribute('aria-label')).toBe('Dashboard connection status: Connected');
    });

    test('exposes the agent company operations console in navigation and markup', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);

        expect(dom.window.document.querySelector('[data-view="agentCompany"] span').textContent).toBe('Agent Company');
        expect(dom.window.document.getElementById('agentCompanyView')).not.toBeNull();
        expect(dom.window.document.getElementById('companyHeartbeatBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('companyDailyAlignmentBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('configureAgentCompanyBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('companyWorkSearch').getAttribute('type')).toBe('search');
        expect(dom.window.document.getElementById('companyWorkStatusFilter')).not.toBeNull();
        expect(dom.window.document.getElementById('companyRoleFilter')).not.toBeNull();
        expect(dom.window.document.getElementById('companyCeoDirection')).not.toBeNull();
        expect(dom.window.document.getElementById('companyFileSearch').getAttribute('type')).toBe('search');
        expect(dom.window.document.getElementById('companyFileSourceFilter')).not.toBeNull();
        expect(dom.window.document.getElementById('companySharedWhiteboard')).not.toBeNull();
        expect(dom.window.document.getElementById('companyRunDetails')).not.toBeNull();
    });

    test('keeps dashboard focus and reduced-motion affordances in CSS', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('--focus-ring: rgba(121, 192, 255, 0.38)');
        expect(css).toContain('.btn:focus-visible');
        expect(css).toContain('.search-box input:focus-visible');
        expect(css).toContain('body[data-ui-surface="admin"] .sidebar-toggle:focus-visible');
        expect(css).toContain('body[data-ui-surface="admin"] .modal-close:focus-visible');
        expect(css).toContain('body[data-ui-surface="admin"] .toast-close:focus-visible');
        expect(css).toContain('.toast:focus-within');
        expect(css).toContain('.tab-btn:focus-visible');
        expect(css).toContain('.toolbar-btn:focus-visible');
        expect(css).toContain('.toggle input:focus-visible + .toggle-slider');
        expect(css).toContain('.range-input input[type="range"]:focus-visible');
        expect(css).toContain('.prompt-item.active .prompt-item-meta {\n    color: var(--bg-primary);');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    });

    test('keeps admin select menus themed instead of browser-white', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('body[data-ui-surface="admin"][data-admin-theme="light"]');
        expect(css).toContain('--admin-menu-bg: #dbeafe');
        expect(css).toContain('--admin-menu-option-bg: #cfe0f7');
        expect(css).toContain('body[data-ui-surface="admin"] select.form-control option');
        expect(css).toContain('background-color: var(--admin-menu-bg)');
        expect(css).toContain('--danger-light: #9b1c1c');
    });

    test('labels logs icon controls with their live state and target', () => {
        const dom = new JSDOM(`
            <button class="btn btn-sm btn-icon active" id="pauseLogsBtn" type="button" aria-label="Pause live log updates" aria-pressed="false" title="Pause live log updates"></button>
            <table><tbody id="logsTableBody"></tbody></table>
        `, { url: 'http://localhost:3000/admin/?view=logs' });
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;
        dom.window.dashboard = dashboard;

        dashboard.state = { logsPaused: false };
        dashboard.formatTime = jest.fn(() => '12:00');
        dashboard.truncate = Dashboard.prototype.truncate.bind(dashboard);
        dashboard.escapeHtml = Dashboard.prototype.escapeHtml.bind(dashboard);

        dashboard.toggleLogsPause();

        const pauseButton = document.getElementById('pauseLogsBtn');
        expect(pauseButton.getAttribute('aria-label')).toBe('Resume live log updates');
        expect(pauseButton.getAttribute('aria-pressed')).toBe('true');
        expect(pauseButton.getAttribute('title')).toBe('Resume live log updates');

        dashboard.renderLogs([{
            id: 'log-123',
            timestamp: '2026-06-30T05:00:00.000Z',
            level: 'info',
            model: 'gpt-5',
            prompt: 'Inspect the latest run',
            tokens: 1280,
            latency: 42,
            status: 'success',
        }]);

        expect(document.querySelector('#logsTableBody .btn-icon').getAttribute('aria-label')).toBe('View details for log-123');
    });

    test('associates logs filters with stable accessible names', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html, { url: 'http://localhost:3000/admin/?view=logs' });
        const document = dom.window.document;

        expect(document.querySelector('label[for="logLevelFilter"]').textContent.trim()).toBe('Level');
        expect(document.querySelector('label[for="logModelFilter"]').textContent.trim()).toBe('Model');
        expect(document.querySelector('label[for="logTimeFilter"]').textContent.trim()).toBe('Time Range');
        expect(document.getElementById('logLevelFilter').labels[0].textContent.trim()).toBe('Level');
        expect(document.getElementById('logModelFilter').labels[0].textContent.trim()).toBe('Model');
        expect(document.getElementById('logTimeFilter').labels[0].textContent.trim()).toBe('Time Range');
        expect(document.getElementById('logSearch').labels[0].textContent.trim()).toBe('Filter logs by prompt, model, or status');
        expect(document.querySelector('#logsTable .col-actions').getAttribute('aria-label')).toBe('Log actions');
    });

    test('toggles and persists the admin light and dark theme state', () => {
        const { dom, dashboard } = createThemeHarness({ prefersLight: true });

        dashboard.initializeTheme();

        expect(dom.window.document.body.dataset.adminTheme).toBe('light');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('aria-label')).toBe('Switch to dark color theme');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('aria-pressed')).toBe('true');

        expect(dashboard.toggleTheme()).toBe('dark');
        expect(dom.window.document.body.dataset.adminTheme).toBe('dark');
        expect(dom.window.localStorage.getItem('kimibuilt_admin_theme')).toBe('dark');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('aria-label')).toBe('Switch to light color theme');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('aria-pressed')).toBe('false');
    });

    test('announces notification checks through the header status text', () => {
        const dom = new JSDOM(`
            <button id="notificationsBtn" type="button" aria-describedby="notificationsStatus"></button>
            <span id="notificationsStatus" role="status" aria-live="polite" aria-atomic="true">Notifications have not been checked yet.</span>
            <div id="toastContainer" aria-live="polite" aria-atomic="false"></div>
        `);
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.escapeHtml = Dashboard.prototype.escapeHtml.bind(dashboard);
        dashboard.showToast = jest.fn();

        dashboard.setupEventListeners();
        dom.window.document.getElementById('notificationsBtn').click();

        expect(dom.window.document.getElementById('notificationsStatus').textContent).toBe('No new notifications.');
        expect(dashboard.showToast).toHaveBeenCalledWith('No new notifications', 'info');
    });

    test('keeps workload run JSON previews scroll-contained', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.workload-detail-code--json');
        expect(css).toContain('max-height: min(42vh, 420px);');
        expect(css).toContain('overflow: auto;');
        expect(css).toContain('overscroll-behavior: contain;');
    });

    test('keeps shared whiteboard previews readable', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.company-whiteboard-preview');
        expect(css).toContain('.company-whiteboard-preview--ready');
        expect(css).toContain('.company-whiteboard-preview p');
        expect(css).toContain('overflow-wrap: anywhere;');
    });

    test('keeps global search focus from shifting header controls', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.header-right {\n    display: flex;\n    align-items: center;\n    gap: var(--space-md);\n    min-width: 0;');
        expect(css).toContain('.search-box {\n    position: relative;\n    display: flex;\n    align-items: center;\n    flex: 0 1 320px;\n    min-width: 0;');
        expect(css).toContain('width: clamp(180px, 24vw, 320px);');
        expect(css).toContain('width: clamp(120px, 28vw, 180px);');
        expect(css).not.toContain('.search-box input:focus {\n    outline: none;\n    border-color: var(--accent-primary);\n    width:');
    });

    test('makes sidebar items native buttons with active page state', () => {
        createNavigationHarness();
        const overview = document.querySelector('[data-view="overview"]');
        const logs = document.querySelector('[data-view="logs"]');

        expect(overview.tagName).toBe('BUTTON');
        expect(overview.getAttribute('type')).toBe('button');
        expect(overview.hasAttribute('role')).toBe(false);
        expect(overview.getAttribute('aria-current')).toBe('page');
        expect(logs.tagName).toBe('BUTTON');
        expect(logs.getAttribute('type')).toBe('button');
        expect(logs.hasAttribute('role')).toBe(false);
        expect(logs.getAttribute('aria-current')).toBe('false');
    });

    test('ships initial sidebar current-page state in the static markup', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const navItems = Array.from(dom.window.document.querySelectorAll('.sidebar-nav .nav-item'));
        const overview = dom.window.document.querySelector('.sidebar-nav [data-view="overview"]');
        const currentItems = navItems.filter(item => item.getAttribute('aria-current') === 'page');

        expect(currentItems).toEqual([overview]);
        expect(navItems.filter(item => item !== overview).every(item => item.getAttribute('aria-current') === 'false')).toBe(true);
    });

    test('keeps the persistent sidebar toggle label in sync with collapse state', () => {
        const { dashboard } = createNavigationHarness({ isMobile: false });
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('sidebarToggle');

        expect(toggle.getAttribute('aria-controls')).toBe('sidebar');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-label')).toBe('Collapse admin navigation');

        dashboard.toggleSidebar();

        expect(sidebar.classList.contains('collapsed')).toBe(true);
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.getAttribute('aria-label')).toBe('Expand admin navigation');
        expect(toggle.getAttribute('title')).toBe('Expand admin navigation');

        dashboard.toggleSidebar();

        expect(sidebar.classList.contains('collapsed')).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-label')).toBe('Collapse admin navigation');
        expect(toggle.getAttribute('title')).toBe('Collapse admin navigation');
    });

    test('activates dashboard sections with Enter and Space', () => {
        const { dom, dashboard } = createNavigationHarness();
        const overview = document.querySelector('[data-view="overview"]');
        const logs = document.querySelector('[data-view="logs"]');

        dashboard.openMobileNavigation();
        logs.focus();
        logs.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(dashboard.state.currentView).toBe('logs');
        expect(logs.classList.contains('active')).toBe(true);
        expect(logs.getAttribute('aria-current')).toBe('page');
        expect(document.getElementById('logsView').classList.contains('active')).toBe(true);
        expect(document.getElementById('sidebar').classList.contains('open')).toBe(false);
        expect(document.activeElement).toBe(document.getElementById('mobileMenuToggle'));

        dashboard.openMobileNavigation();
        overview.focus();
        overview.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
        }));

        expect(dashboard.state.currentView).toBe('overview');
        expect(overview.classList.contains('active')).toBe(true);
        expect(overview.getAttribute('aria-current')).toBe('page');
        expect(logs.getAttribute('aria-current')).toBe('false');
        expect(document.getElementById('sidebar').classList.contains('open')).toBe(false);
    });

    test('moves focus into the mobile sidebar and restores it on close', () => {
        const { dashboard } = createNavigationHarness();
        const sidebar = document.getElementById('sidebar');
        const mobileToggle = document.getElementById('mobileMenuToggle');
        const overview = document.querySelector('[data-view="overview"]');

        mobileToggle.focus();
        dashboard.openMobileNavigation();

        expect(sidebar.classList.contains('open')).toBe(true);
        expect(mobileToggle.getAttribute('aria-expanded')).toBe('true');
        expect(mobileToggle.getAttribute('aria-label')).toBe('Close admin navigation');
        expect(mobileToggle.getAttribute('title')).toBe('Close admin navigation');
        expect(document.activeElement).toBe(overview);

        dashboard.closeMobileNavigation();

        expect(sidebar.classList.contains('open')).toBe(false);
        expect(mobileToggle.getAttribute('aria-expanded')).toBe('false');
        expect(mobileToggle.getAttribute('aria-label')).toBe('Open admin navigation');
        expect(mobileToggle.getAttribute('title')).toBe('Open admin navigation');
        expect(document.activeElement).toBe(mobileToggle);
    });

    test('ships settings tab semantics in the initial admin markup', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const settingsNav = dom.window.document.querySelector('.settings-nav');
        const tabs = Array.from(dom.window.document.querySelectorAll('.settings-nav-item'));
        const panels = Array.from(dom.window.document.querySelectorAll('.settings-section'));

        expect(settingsNav.getAttribute('role')).toBe('tablist');
        expect(settingsNav.getAttribute('aria-label')).toBe('Settings sections');
        expect(tabs).toHaveLength(9);
        expect(panels).toHaveLength(9);

        tabs.forEach((tab, index) => {
            const panel = dom.window.document.getElementById(tab.getAttribute('aria-controls'));
            expect(tab.getAttribute('type')).toBe('button');
            expect(tab.getAttribute('role')).toBe('tab');
            expect(tab.id).toBe(`${tab.dataset.settings}SettingsTab`);
            expect(tab.getAttribute('aria-selected')).toBe(index === 0 ? 'true' : 'false');
            expect(tab.getAttribute('tabindex')).toBe(index === 0 ? '0' : '-1');
            expect(panel.getAttribute('role')).toBe('tabpanel');
            expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
            expect(panel.hidden).toBe(index !== 0);
        });
    });

    test('ships admin modals as labelled dialogs with safe button types', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const modalExpectations = [
            ['testPromptModal', 'Test Prompt', 'Close test prompt dialog'],
            ['editWorkloadModal', 'Edit Workload', 'Close edit workload dialog'],
            ['historyModal', 'Prompt History', 'Close prompt history dialog'],
            ['logDetailsModal', 'Log Details', 'Close log details dialog'],
        ];

        modalExpectations.forEach(([modalId, title, closeLabel]) => {
            const modal = dom.window.document.getElementById(modalId);
            const titleEl = dom.window.document.getElementById(modal.getAttribute('aria-labelledby'));
            const closeButton = modal.querySelector('.modal-header .modal-close');
            const buttons = Array.from(modal.querySelectorAll('button'));

            expect(modal.getAttribute('role')).toBe('dialog');
            expect(modal.getAttribute('aria-modal')).toBe('true');
            expect(titleEl?.textContent.trim()).toBe(title);
            expect(closeButton.getAttribute('type')).toBe('button');
            expect(closeButton.getAttribute('aria-label')).toBe(closeLabel);
            buttons.forEach(button => {
                expect(button.getAttribute('type')).toBe('button');
            });
        });
    });

    test('exposes settings sections as selectable tabs', () => {
        const { dashboard } = createSettingsHarness();
        const generalTab = document.querySelector('[data-settings="general"]');
        const apiTab = document.querySelector('[data-settings="api"]');
        const generalPanel = document.getElementById('generalSettings');
        const apiPanel = document.getElementById('apiSettings');

        expect(document.querySelector('.settings-nav').getAttribute('role')).toBe('tablist');
        expect(generalTab.getAttribute('role')).toBe('tab');
        expect(generalTab.getAttribute('aria-selected')).toBe('true');
        expect(generalTab.getAttribute('tabindex')).toBe('0');
        expect(generalTab.getAttribute('aria-controls')).toBe('generalSettings');
        expect(generalPanel.getAttribute('role')).toBe('tabpanel');
        expect(generalPanel.getAttribute('aria-labelledby')).toBe(generalTab.id);
        expect(apiPanel.hidden).toBe(true);

        dashboard.switchSettingsSection('api');

        expect(generalTab.getAttribute('aria-selected')).toBe('false');
        expect(generalTab.getAttribute('tabindex')).toBe('-1');
        expect(apiTab.getAttribute('aria-selected')).toBe('true');
        expect(apiTab.getAttribute('tabindex')).toBe('0');
        expect(generalPanel.hidden).toBe(true);
        expect(apiPanel.hidden).toBe(false);
    });

    test('moves through settings tabs with arrow and edge keys', () => {
        createSettingsHarness();
        const generalTab = document.querySelector('[data-settings="general"]');
        const apiTab = document.querySelector('[data-settings="api"]');

        generalTab.focus();
        generalTab.dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        expect(document.activeElement).toBe(apiTab);
        expect(apiTab.getAttribute('aria-selected')).toBe('true');
        expect(apiTab.getAttribute('tabindex')).toBe('0');

        apiTab.dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'Home',
            bubbles: true,
            cancelable: true,
        }));

        expect(document.activeElement).toBe(generalTab);
        expect(generalTab.getAttribute('aria-selected')).toBe('true');

        generalTab.dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'End',
            bubbles: true,
            cancelable: true,
        }));

        expect(document.activeElement).toBe(apiTab);
        expect(apiTab.getAttribute('aria-selected')).toBe('true');
    });

    test('activates prompt editor tabs with keyboard commands', () => {
        const { dom, dashboard } = createPromptTabHarness();
        const previewTab = document.querySelector('[data-tab="preview"]');

        previewTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));
        previewTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
        }));

        expect(dashboard.switchPromptTab).toHaveBeenNthCalledWith(1, 'preview');
        expect(dashboard.switchPromptTab).toHaveBeenNthCalledWith(2, 'preview');
    });

    test('exposes prompt editor tabs as a synchronized tablist', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const tablist = dom.window.document.querySelector('.editor-tabs');
        const editorTab = dom.window.document.getElementById('prompt-editor-tab');
        const previewTab = dom.window.document.getElementById('prompt-preview-tab');
        const previewPanel = dom.window.document.getElementById('previewTab');

        expect(tablist.getAttribute('role')).toBe('tablist');
        expect(tablist.getAttribute('aria-label')).toBe('Prompt editor views');
        expect(editorTab.getAttribute('role')).toBe('tab');
        expect(editorTab.getAttribute('aria-controls')).toBe('editorTab');
        expect(editorTab.getAttribute('aria-selected')).toBe('true');
        expect(previewTab.getAttribute('aria-controls')).toBe('previewTab');
        expect(previewTab.getAttribute('aria-selected')).toBe('false');
        expect(previewPanel.getAttribute('role')).toBe('tabpanel');
        expect(previewPanel.getAttribute('aria-labelledby')).toBe('prompt-preview-tab');
        expect(previewPanel.hasAttribute('hidden')).toBe(true);
        expect(html).toContain('dashboard.js?v=admin-trustworthy-mission-v1');
        expect(html).toContain('css/dashboard.css?v=admin-trustworthy-mission-v1');
        expect(html).toContain('id="traceQualitySummary"');
        expect(html).toContain('id="traceEvalSummary"');
        expect(html).toContain('<title>Lilly Mission Control</title>');
        expect(html).not.toContain('vs last hour');
    });

    test('keeps prompt tab selection and panel visibility synchronized', () => {
        const { dashboard } = createPromptTabHarness({ mockSwitch: false });

        dashboard.switchPromptTab('preview');

        const editorTab = document.querySelector('[data-tab="editor"]');
        const previewTab = document.querySelector('[data-tab="preview"]');
        const editorPanel = document.getElementById('editorTab');
        const previewPanel = document.getElementById('previewTab');

        expect(editorTab.getAttribute('aria-selected')).toBe('false');
        expect(editorTab.getAttribute('tabindex')).toBe('-1');
        expect(previewTab.getAttribute('aria-selected')).toBe('true');
        expect(previewTab.getAttribute('tabindex')).toBe('0');
        expect(editorPanel.hasAttribute('hidden')).toBe(true);
        expect(previewPanel.hasAttribute('hidden')).toBe(false);
    });

    test('makes runtime list items keyboard-selectable with selected state', () => {
        const { dom, dashboard } = createRuntimeListHarness();
        dashboard.selectPromptById = jest.fn();
        dashboard.selectTrace = jest.fn();
        dashboard.selectAdminRun = jest.fn();

        dashboard.renderPromptList(dashboard.state.prompts);
        dashboard.renderTraces([
            { id: 'trace-a', name: 'Trace A', status: 'success', startedAt: 'now', duration: 24, steps: [] },
            { id: 'trace-b', name: 'Trace B', status: 'running', startedAt: 'later', duration: 12, steps: [] },
            { id: 'trace-xss', name: '<img src=x onerror=alert(1)>', status: 'success', startedAt: 'later', duration: 1, steps: [] },
        ]);
        dashboard.renderAdminRuns([
            { id: 'run-a', workloadTitle: 'Morning job', status: 'completed', reason: 'manual' },
            { id: 'run-b', workloadTitle: 'Noon job', status: 'queued', reason: 'schedule' },
        ]);

        const prompt = document.querySelector('.prompt-item[data-id="prompt-b"]');
        const trace = document.querySelector('.trace-item[data-id="trace-b"]');
        const run = document.querySelector('.workload-run-row[data-id="run-b"]');
        [prompt, trace, run].forEach((item) => {
            item.addEventListener('keydown', (event) => dashboard.handleListItemKeydown(event));
            expect(item.getAttribute('role')).toBe('button');
            expect(item.getAttribute('tabindex')).toBe('0');
            expect(item.getAttribute('aria-selected')).toBe('false');
        });

        prompt.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        trace.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        run.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        expect(dashboard.selectPromptById).toHaveBeenCalledWith('prompt-b');
        expect(dashboard.selectTrace).toHaveBeenCalledWith('trace-b');
        expect(dashboard.selectAdminRun).toHaveBeenCalledWith('run-b');
        expect(document.querySelector('.trace-item[data-id="trace-xss"] img')).toBeNull();
        expect(document.querySelector('.trace-item[data-id="trace-xss"] .trace-name').textContent)
            .toBe('<img src=x onerror=alert(1)>');
    });

    test('populates and applies the trace session filter', () => {
        const { dashboard } = createRuntimeListHarness();
        document.body.insertAdjacentHTML('beforeend', `
            <select id="traceSessionFilter"><option value="all">All Sessions</option></select>
            <select id="traceStatusFilter"><option value="all">All Statuses</option></select>
            <input id="traceSearch" value="">
        `);
        dashboard.state.traces = [
            { id: 'trace-a', sessionId: 'session-a', name: 'Trace A', status: 'success', steps: [] },
            { id: 'trace-b', sessionId: 'session-b', name: 'Trace B', status: 'success', steps: [] },
        ];

        dashboard.populateTraceSessionFilter(dashboard.state.traces);
        document.getElementById('traceSessionFilter').value = 'session-b';
        dashboard.filterTraces();

        expect(Array.from(document.querySelectorAll('.trace-item')).map((item) => item.dataset.id))
            .toEqual(['trace-b']);
    });

    test('renders agent quality gate fields in the trace timeline', () => {
        const { dashboard } = createRuntimeListHarness();
        document.body.insertAdjacentHTML('beforeend', '<div id="traceTimeline"></div><div id="traceDetails"></div>');

        const trace = dashboard.normalizeTrace({
            id: 'trace-quality',
            status: 'completed',
            duration: 18,
            timeline: [{
                name: 'Agent quality gates',
                type: 'quality_gate',
                status: 'info',
                details: {
                    qualityStatus: 'partial',
                    qualityScore: '55%',
                    requiredMissing: ['browser_proof', 'public_or_preview_url'],
                },
            }],
        });

        dashboard.renderTraceTimeline(trace);

        const timelineText = document.getElementById('traceTimeline').textContent;
        expect(timelineText).toContain('Agent quality gates');
        expect(timelineText).toContain('Quality status');
        expect(timelineText).toContain('partial');
        expect(timelineText).toContain('Quality score');
        expect(timelineText).toContain('55%');
        expect(timelineText).toContain('browser_proof, public_or_preview_url');
    });

    test('renders aggregate agent quality metrics above traces', () => {
        const { dashboard } = createRuntimeListHarness();

        dashboard.renderTraceQualitySummary({
            total: 3,
            averageScore: 0.56,
            statusCounts: {
                partial: 2,
                passed: 1,
            },
            topMissingGates: [
                { id: 'browser_proof', count: 2 },
                { id: 'verification_commands', count: 1 },
            ],
            surfaces: [
                { id: 'website-experience', label: 'Website and frontend experience quality', averageScore: 0.5 },
                { id: 'remote-deployment', label: 'Remote CLI deployment quality', averageScore: 0.62 },
            ],
        });

        const summaryText = document.getElementById('traceQualitySummary').textContent;
        expect(summaryText).toContain('Agent quality');
        expect(summaryText).toContain('56%');
        expect(summaryText).toContain('3 traces');
        expect(summaryText).toContain('partial 2');
        expect(summaryText).toContain('passed 1');
        expect(summaryText).toContain('browser_proof 2');
        expect(summaryText).toContain('Website and frontend experience quality 50%');
    });

    test('renders recorded eval metrics and never invents fallback scores', () => {
        const { dashboard } = createRuntimeListHarness();

        dashboard.renderTraceEvalSummary(null);
        expect(document.getElementById('traceEvalSummary').textContent).toContain('Synthetic fallback metrics are not shown');

        dashboard.renderTraceEvalSummary({
            totalRuns: 2,
            totalCases: 60,
            passedCases: 57,
            passRate: 0.95,
            status: 'passed',
            criticalRegressions: 0,
            evidenceCoverage: 0.92,
            toolPrecision: 0.88,
            averageCostUsd: 0.24,
            averageLatencyMs: 1234,
        });

        const summary = document.getElementById('traceEvalSummary');
        expect(summary.dataset.status).toBe('passed');
        expect(summary.textContent).toContain('95%');
        expect(summary.textContent).toContain('57 / 60 cases');
        expect(summary.textContent).toContain('92%');
        expect(summary.textContent).toContain('$0.24');
        expect(summary.textContent).toContain('1234ms');
    });

    test('renders backend-shaped agent company status, work, and output filters', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.renderAgentCompanyDashboard();

        expect(document.getElementById('agentCompanyGoalSummary').textContent).toBe('Run a research studio that ships weekly outputs.');
        expect(document.getElementById('companyHeartbeatStatus').textContent).toBe('scheduled');
        expect(document.getElementById('companyRunningCount').textContent).toBe('1');
        expect(document.getElementById('companyQueuedCount').textContent).toBe('1 queued');
        expect(document.getElementById('agentCompanyBadge').textContent).toBe('1');
        expect(document.getElementById('companyRoleList').textContent).toContain('Strategy Lead');
        expect(document.getElementById('companyRoleList').textContent).toContain('1 work');
        expect(document.getElementById('companyRoleList').textContent).toContain('1 running');
        expect(document.getElementById('companyScheduleList').textContent).toContain('Company weekly plan');
        expect(document.getElementById('companyWorkloadsTableBody').textContent).toContain('Strategy Lead: Company weekly plan');
        expect(document.getElementById('companyWorkloadsTableBody').textContent).not.toContain('Unrelated job');
        expect(document.getElementById('companyRunsTableBody').textContent).toContain('company-run');
        expect(document.getElementById('companyRunsTableBody').textContent).not.toContain('other-run');
        expect(document.getElementById('companyAlignmentPanel').textContent).toContain('daily-proof-note');
        expect(document.getElementById('companyCeoDirection').value).toBe('Run a research studio that ships weekly outputs.');
        expect(document.getElementById('companyDeliverableStatus').textContent).toBe('1 file');
        expect(document.getElementById('companyDeliverableList').textContent).toContain('Weekly Plan');
        expect(document.getElementById('companyDeliverableList').textContent).toContain('1 document');
        expect(document.getElementById('companyDeliverableList').textContent).toContain('1 previewable');
        expect(document.getElementById('companyDeliverableList').textContent).toContain('Executive plan with priorities');
        expect(document.getElementById('companyDeliverableList').querySelector('.company-deliverable-card')).not.toBeNull();
        expect(document.getElementById('companyDeliverableList').querySelector('.company-deliverable-format').textContent).toBe('PDF');
        expect(document.getElementById('companyActionQueue').textContent).toContain('Review business outputs');
        expect(document.getElementById('companyActionHistory').textContent).toContain('Recent saved CEO actions');
        expect(document.getElementById('companyActionHistory').textContent).toContain('Review saved output <script>alert("x")</script>');
        expect(document.getElementById('companyActionHistory').querySelector('script')).toBeNull();
        expect(document.getElementById('companyWorkspaceStatus').textContent).toBe('1 workstream');
        expect(document.getElementById('companyImprovementLoopStatus').textContent).toBe('looping');
        expect(document.getElementById('companyImprovementLoopSummary').textContent).toContain('1 workstreams');
        expect(document.getElementById('companyImprovementLoopPhases').textContent).toContain('Sense');
        expect(document.getElementById('companyImprovementLoopPhases').textContent).toContain('Learn');
        expect(document.getElementById('companySharedWhiteboard').textContent).toContain('.kimibuilt/agent-company/2026-06-22-whiteboard.md');
        expect(document.getElementById('companySharedWhiteboard').textContent).toContain('Week 2026-06-22');
        expect(document.getElementById('companySharedWhiteboard').textContent).toContain('Strategy Lead');
        expect(document.getElementById('companySharedWhiteboard').textContent).toContain('Next agent task');
        expect(document.getElementById('companySharedWhiteboard').textContent).toContain('Whiteboard preview');
        expect(document.getElementById('companySharedWhiteboard').textContent).toContain('Claims checked: public route works.');
        expect(document.getElementById('companySharedWhiteboard').querySelector('script')).toBeNull();
        expect(document.getElementById('companySharedWhiteboard').querySelector('.company-whiteboard-preview--ready')).not.toBeNull();
    });

    test('renders escaped output previews in company action cards', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.renderCompanyActionQueue([
            {
                id: 'review-completed-output',
                actionKey: 'review-completed-output:company-run',
                label: 'Review completed work',
                detail: '1 completed run produced text output but no packaged file yet.',
                target: 'runs',
                priority: 'medium',
                runId: 'company-run',
                outputPreview: 'Verified cycle <script>alert("x")</script> and found the next packaging step.',
            },
        ]);

        const queue = document.getElementById('companyActionQueue');
        expect(queue.textContent).toContain('Verified cycle <script>alert("x")</script> and found the next packaging step.');
        expect(queue.querySelector('script')).toBeNull();
        expect(queue.querySelector('.company-action-preview')).not.toBeNull();
        expect(queue.querySelector('button').getAttribute('onclick')).toBe('dashboard.handleCompanyAction("runs", "company-run", "review-completed-output:company-run")');
        expect(dashboard.state.companyActionContexts['company-run']).toEqual(expect.objectContaining({
            label: 'Review completed work',
            detail: '1 completed run produced text output but no packaged file yet.',
            outputPreview: 'Verified cycle <script>alert("x")</script> and found the next packaging step.',
        }));
        expect(dashboard.state.companyActionContextsById['review-completed-output:company-run']).toEqual(expect.objectContaining({
            label: 'Review completed work',
            outputPreview: 'Verified cycle <script>alert("x")</script> and found the next packaging step.',
        }));
    });

    test('opens the referenced company run from CEO action cards', () => {
        const { dashboard } = createAgentCompanyHarness();
        const runsTable = document.getElementById('companyRunsTableBody');
        runsTable.scrollIntoView = jest.fn();
        dashboard.selectAdminRun = jest.fn();

        dashboard.handleCompanyAction('runs', 'company-run');

        expect(dashboard.selectAdminRun).toHaveBeenCalledWith('company-run', {
            source: 'company-action',
            actionContext: null,
        });
        expect(runsTable.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    });

    test('opens CEO deliverable actions on the review collage', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.renderCompanyDeliverables(dashboard.state.agentCompanyWorkspace.deliverables);
        const collage = document.getElementById('companyDeliverableCollage');
        const firstCard = document.querySelector('.company-deliverable-card');
        collage.scrollIntoView = jest.fn();
        firstCard.focus = jest.fn();

        dashboard.handleCompanyAction('deliverables');

        expect(collage.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
        expect(firstCard.focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('routes shared whiteboard CEO actions through a focused heartbeat reason', () => {
        const { dashboard } = createAgentCompanyHarness();
        dashboard.runAgentCompanyHeartbeat = jest.fn();

        dashboard.handleCompanyAction('whiteboard-refresh');

        expect(dashboard.runAgentCompanyHeartbeat).toHaveBeenCalledWith({
            source: 'shared-whiteboard-refresh',
        });
    });

    test('routes agent quality CEO actions to the traces view', () => {
        const { dashboard } = createAgentCompanyHarness();
        document.body.insertAdjacentHTML('beforeend', '<div id="traceQualitySummary"></div>');
        const summary = document.getElementById('traceQualitySummary');
        summary.scrollIntoView = jest.fn();
        dashboard.navigateTo = jest.fn();

        dashboard.handleCompanyAction('traces');

        expect(dashboard.navigateTo).toHaveBeenCalledWith('traces');
        expect(summary.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    });

    test('renders latest shared whiteboard repair status in action cards', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.renderCompanyActionQueue([
            {
                id: 'refresh-shared-whiteboard',
                actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard\'s.md',
                label: 'Refresh shared whiteboard',
                detail: 'Whiteboard needs current coordination notes.',
                target: 'whiteboard-refresh',
                priority: 'medium',
                refreshStatus: {
                    workloadId: 'whiteboard-refresh-workload',
                    title: 'Operations Lead: Refresh <script>alert("x")</script>',
                    status: 'queued',
                    runId: 'whiteboard-refresh-run\'s',
                    runStatus: 'running',
                },
            },
        ]);

        const queue = document.getElementById('companyActionQueue');
        expect(queue.textContent).toContain('Latest repair');
        expect(queue.textContent).toContain('running');
        expect(queue.textContent).toContain('Operations Lead: Refresh <script>alert("x")</script>');
        expect(queue.querySelector('script')).toBeNull();
        expect(queue.querySelector('.company-action-status')).not.toBeNull();
        const buttons = Array.from(queue.querySelectorAll('button'));
        expect(buttons.map((button) => button.textContent.trim())).toEqual(['Review repair', 'Open']);
        expect(buttons[0].getAttribute('onclick')).toBe('dashboard.handleCompanyAction("runs", "whiteboard-refresh-run\'s", "refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard\'s.md")');
        expect(buttons[1].getAttribute('onclick')).toBe('dashboard.handleCompanyAction("whiteboard-refresh", "", "refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard\'s.md")');
        expect(dashboard.state.companyActionContexts["whiteboard-refresh-run's"]).toEqual(expect.objectContaining({
            label: 'Refresh shared whiteboard',
            detail: 'Latest repair: Operations Lead: Refresh <script>alert("x")</script>',
            outputPreview: 'Whiteboard needs current coordination notes.',
        }));
        expect(dashboard.state.companyActionContextsById["refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard's.md"])
            .toEqual(expect.objectContaining({
                label: 'Refresh shared whiteboard',
                detail: 'Latest repair: Operations Lead: Refresh <script>alert("x")</script>',
            }));

        dashboard.selectAdminRun = jest.fn();
        document.getElementById('companyRunsTableBody').scrollIntoView = jest.fn();
        dashboard.handleCompanyAction(
            'runs',
            "whiteboard-refresh-run's",
            "refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard's.md",
        );
        expect(dashboard.selectAdminRun).toHaveBeenCalledWith("whiteboard-refresh-run's", {
            source: 'company-action',
            actionContext: expect.objectContaining({
                label: 'Refresh shared whiteboard',
                detail: 'Latest repair: Operations Lead: Refresh <script>alert("x")</script>',
            }),
        });
    });

    test('renders saved CEO action history with review handoff context', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.renderCompanyActionHistory([
            {
                id: 'review-completed-output',
                actionKey: 'review-completed-output:historical-run',
                label: 'Review saved output <script>alert("x")</script>',
                detail: 'Saved run context from a previous company cycle.',
                target: 'runs',
                runId: 'historical-run',
                outputPreview: 'Saved output preview.',
                snapshotAt: '2026-06-28T05:12:00.000Z',
                historical: true,
            },
            {
                id: 'review-deliverables',
                actionKey: 'review-deliverables:archive',
                label: 'Review archived deliverables',
                detail: 'Saved context without a specific run.',
                target: 'deliverables',
                snapshotAt: '2026-06-28T05:13:00.000Z',
            },
        ]);

        const history = document.getElementById('companyActionHistory');
        expect(history.textContent).toContain('Recent saved CEO actions');
        expect(history.textContent).toContain('1 reviewable | 1 reference');
        expect(history.textContent).toContain('Deliverables 1 | Saved history 1');
        expect(history.textContent).toContain('Review saved output <script>alert("x")</script>');
        expect(history.textContent).toContain('Reviewable run');
        expect(history.textContent).toContain('Reference only');
        expect(history.textContent).toContain('Saved history');
        expect(history.textContent).toContain('Deliverables');
        expect(history.querySelector('script')).toBeNull();
        expect(history.querySelectorAll('.company-action-history__filters .company-action-history__filter')).toHaveLength(3);
        expect(history.querySelector('.company-action-history__filter--active').textContent).toContain('All 2');
        expect(history.querySelector('.company-action-history__sort').textContent).toContain('Newest first');
        expect(history.querySelectorAll('.company-action-history__item')).toHaveLength(2);
        expect(history.querySelectorAll('.company-action-history__item')[0].textContent).toContain('Review archived deliverables');
        expect(history.querySelectorAll('.company-action-history__item button')).toHaveLength(1);
        expect(history.querySelector('.company-action-history__item button').getAttribute('onclick'))
            .toBe('dashboard.handleCompanyAction("runs", "historical-run", "review-completed-output:historical-run")');
        expect(dashboard.state.companyActionContexts['historical-run']).toEqual(expect.objectContaining({
            label: 'Review saved output <script>alert("x")</script>',
            detail: 'Saved run context from a previous company cycle.',
            outputPreview: 'Saved output preview.',
            contextSource: 'saved-history',
            snapshotAt: '2026-06-28T05:12:00.000Z',
        }));

        dashboard.setCompanyActionHistoryFilter('reviewable');
        expect(history.querySelector('.company-action-history__filter--active').textContent).toContain('Reviewable 1');
        expect(history.textContent).toContain('Review saved output <script>alert("x")</script>');
        expect(history.textContent).not.toContain('Review archived deliverables');
        expect(history.querySelectorAll('.company-action-history__item')).toHaveLength(1);

        dashboard.setCompanyActionHistoryFilter('reference');
        expect(history.querySelector('.company-action-history__filter--active').textContent).toContain('Reference 1');
        expect(history.textContent).not.toContain('Review saved output <script>alert("x")</script>');
        expect(history.textContent).toContain('Review archived deliverables');
        expect(history.querySelectorAll('.company-action-history__item')).toHaveLength(1);

        dashboard.setCompanyActionHistoryFilter('reviewable');
        dashboard.setCompanyActionHistoryFilter('unknown');
        expect(history.querySelector('.company-action-history__filter--active').textContent).toContain('All 2');

        dashboard.setCompanyActionHistorySort('oldest');
        expect(history.querySelector('.company-action-history__sort .company-action-history__filter--active').textContent)
            .toContain('Oldest first');
        expect(history.querySelectorAll('.company-action-history__item')[0].textContent).toContain('Review saved output <script>alert("x")</script>');

        dashboard.setCompanyActionHistorySort('unknown');
        expect(history.querySelector('.company-action-history__sort .company-action-history__filter--active').textContent)
            .toContain('Newest first');
    });

    test('loads more saved CEO action history from the action-history endpoint', async () => {
        const { dom, dashboard } = createAgentCompanyHarness();
        dom.window.apiClient = {
            get: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    actions: [
                        {
                            id: 'review-completed-output',
                            actionKey: 'review-completed-output:historical-run',
                            label: 'Review saved output',
                            detail: 'Saved run context from the workspace slice.',
                            target: 'runs',
                            runId: 'historical-run',
                            outputPreview: 'Saved output preview.',
                            snapshotAt: '2026-06-28T05:12:00.000Z',
                            historical: true,
                        },
                        {
                            id: 'review-completed-output',
                            actionKey: 'review-completed-output:older-run',
                            label: 'Review older saved output <script>alert("x")</script>',
                            detail: 'Older saved run context from the action-history endpoint.',
                            target: 'runs',
                            runId: 'older-run',
                            outputPreview: 'Older saved output preview.',
                            snapshotAt: '2026-06-28T04:12:00.000Z',
                            historical: true,
                        },
                    ],
                    summary: {
                        total: 2,
                        reviewable: 2,
                        referenceOnly: 0,
                        newestSnapshotAt: '2026-06-28T05:12:00.000Z',
                        oldestSnapshotAt: '2026-06-28T04:12:00.000Z',
                    },
                    limit: 24,
                    maxLimit: 24,
                },
            }),
        };

        dashboard.renderCompanyActionHistory(dashboard.state.agentCompanyWorkspace.actionHistory);
        expect(document.getElementById('companyActionHistory').textContent).toContain('All 1');

        await dashboard.loadCompanyActionHistory();

        const history = document.getElementById('companyActionHistory');
        expect(dom.window.apiClient.get).toHaveBeenCalledWith('/api/admin/agent-company/action-history', { limit: 24 });
        expect(history.textContent).toContain('All 2');
        expect(history.textContent).toContain('2 reviewable');
        expect(history.textContent).toContain('Saved history 2');
        expect(history.textContent).toContain('newest');
        expect(history.textContent).toContain('oldest');
        expect(history.textContent).toContain('Review older saved output <script>alert("x")</script>');
        expect(history.querySelector('script')).toBeNull();
        expect(dashboard.state.companyActionHistorySummary).toEqual(expect.objectContaining({
            total: 2,
            reviewable: 2,
            referenceOnly: 0,
            newestSnapshotAt: '2026-06-28T05:12:00.000Z',
            oldestSnapshotAt: '2026-06-28T04:12:00.000Z',
        }));
        expect(history.querySelector('[data-action-id="review-completed-output:older-run"] button').getAttribute('onclick'))
            .toBe('dashboard.handleCompanyAction("runs", "older-run", "review-completed-output:older-run")');
        expect(dashboard.state.companyActionContexts['older-run']).toEqual(expect.objectContaining({
            label: 'Review older saved output <script>alert("x")</script>',
            detail: 'Older saved run context from the action-history endpoint.',
            outputPreview: 'Older saved output preview.',
            contextSource: 'saved-history',
        }));
    });

    test('marks the company run opened from a CEO action', () => {
        const { dashboard } = createAgentCompanyHarness();
        dashboard.state.selectedRun = dashboard.state.runs[0];
        dashboard.state.companyActionRunId = 'company-run';

        dashboard.renderCompanyRuns(dashboard.state.runs);

        const rows = document.querySelectorAll('#companyRunsTableBody .workload-run-row');
        expect(rows[0].classList.contains('selected')).toBe(true);
        expect(rows[0].classList.contains('company-run-row--action-selected')).toBe(true);
        expect(rows[0].textContent).toContain('CEO action');
        expect(rows[1].classList.contains('company-run-row--action-selected')).toBe(false);
        expect(rows[1].textContent).not.toContain('CEO action');
    });

    test('shows CEO action context in the selected company run details', () => {
        const { dashboard } = createAgentCompanyHarness();
        dashboard.state.companyActionRunId = 'company-run';
        dashboard.state.companyActionContext = {
            label: 'Review completed work <script>alert("x")</script>',
            detail: '1 completed run produced text output but no packaged file yet.',
            outputPreview: 'Verified cycle <script>alert("x")</script> and found the next packaging step.',
            contextSource: 'saved-history',
            snapshotAt: '2026-06-28T05:12:00.000Z',
        };

        dashboard.renderAdminRunDetails(dashboard.state.runs[0]);

        const companyDetails = document.getElementById('companyRunDetails');
        expect(companyDetails.querySelector('.workload-action-context')).not.toBeNull();
        expect(companyDetails.textContent).toContain('Review completed work <script>alert("x")</script>');
        expect(companyDetails.textContent).toContain('Saved history');
        expect(companyDetails.textContent).toContain('Saved');
        expect(companyDetails.textContent).toContain('1 completed run produced text output but no packaged file yet.');
        expect(companyDetails.textContent).toContain('Verified cycle <script>alert("x")</script> and found the next packaging step.');
        expect(companyDetails.querySelector('script')).toBeNull();
        expect(companyDetails.querySelector('.workload-action-preview')).not.toBeNull();
        expect(companyDetails.querySelector('.workload-action-source').textContent).toBe('Saved history');
        expect(companyDetails.querySelector('.workload-action-snapshot')).not.toBeNull();

        dashboard.state.companyActionRunId = null;
        dashboard.state.companyActionContext = null;
        dashboard.renderAdminRunDetails(dashboard.state.runs[0]);

        expect(companyDetails.querySelector('.workload-action-context')).toBeNull();
    });

    test('shows remote agent quality gates in selected run details', () => {
        const { dashboard } = createAgentCompanyHarness();
        const run = {
            ...dashboard.state.runs[0],
            metadata: {
                remoteCliAgent: {
                    agentQuality: {
                        status: 'partial',
                        score: 0.55,
                        requiredMissing: ['public_or_preview_url', 'browser_proof'],
                        surfaces: [
                            { id: 'remote-deployment', label: 'Remote CLI deployment quality', score: 0.6, requiredMissing: [] },
                            { id: 'website-experience', label: 'Website and frontend experience quality', score: 0.5, requiredMissing: ['public_or_preview_url'] },
                        ],
                    },
                },
            },
        };

        dashboard.renderAdminRunDetails(run);

        const companyDetails = document.getElementById('companyRunDetails');
        const qualityBlock = companyDetails.querySelector('.workload-agent-quality');
        expect(qualityBlock).not.toBeNull();
        expect(qualityBlock.textContent).toContain('Agent Quality Gates');
        expect(qualityBlock.textContent).toContain('partial');
        expect(qualityBlock.textContent).toContain('55%');
        expect(qualityBlock.textContent).toContain('Remote CLI deployment quality 60%');
        expect(qualityBlock.textContent).toContain('Website and frontend experience quality 50%');
        expect(qualityBlock.textContent).toContain('public_or_preview_url, browser_proof');
    });

    test('persists CEO action run selection in the URL and session storage', async () => {
        const { dom, dashboard } = createAgentCompanyHarness();
        dashboard.showToast = jest.fn();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const actionContext = {
            id: 'review-completed-output',
            actionKey: 'review-completed-output:company-run',
            label: 'Review completed work',
            detail: 'Inspect the completed text-only output.',
            outputPreview: 'Found a weekly planning brief.',
        };

        try {
            await dashboard.selectAdminRun('company-run', {
                source: 'company-action',
                actionContext,
            });

            expect(dom.window.location.search).toContain('view=agentCompany');
            expect(dom.window.location.search).toContain('companyAction=1');
            expect(dom.window.location.search).toContain('companyRun=company-run');
            expect(dom.window.location.search).toContain('companyActionId=review-completed-output%3Acompany-run');
            expect(JSON.parse(dom.window.sessionStorage.getItem('kb.companyActionContext.company-run'))).toEqual(actionContext);

            await dashboard.selectAdminRun('other-run', { source: 'table' });

            expect(dom.window.location.search).not.toContain('companyAction=1');
            expect(dom.window.location.search).not.toContain('companyRun=');
            expect(dom.window.location.search).not.toContain('companyActionId=');
            expect(dashboard.state.companyActionRunId).toBeNull();
            expect(dashboard.state.companyActionContext).toBeNull();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    test('restores CEO action run selection from the URL and persisted context', async () => {
        const { dom, dashboard } = createAgentCompanyHarness({
            url: 'http://localhost:3000/admin/?view=agentCompany&companyAction=1&companyRun=company-run',
        });
        const persistedContext = {
            id: 'review-completed-output',
            actionKey: 'review-completed-output:company-run',
            label: 'Review completed work',
            detail: 'Inspect the completed text-only output.',
            outputPreview: 'Found a weekly planning brief.',
        };
        dom.window.sessionStorage.setItem('kb.companyActionContext.company-run', JSON.stringify(persistedContext));
        dashboard.selectAdminRun = jest.fn().mockResolvedValue(undefined);

        await dashboard.restoreCompanyActionSelectionFromUrl();

        expect(dashboard.selectAdminRun).toHaveBeenCalledWith('company-run', {
            source: 'company-action',
            actionContext: persistedContext,
            persistSelection: false,
        });
    });

    test('restores shared CEO action context from workspace action id', async () => {
        const { dashboard } = createAgentCompanyHarness({
            url: 'http://localhost:3000/admin/?view=agentCompany&companyAction=1&companyRun=company-run&companyActionId=review-completed-output%3Acompany-run',
        });
        const actionContext = {
            id: 'review-completed-output',
            actionKey: 'review-completed-output:company-run',
            label: 'Review completed work',
            detail: 'Inspect the completed text-only output.',
            outputPreview: 'Found a weekly planning brief.',
        };
        dashboard.state.companyActionContextsById = {
            'review-completed-output:company-run': actionContext,
        };
        dashboard.selectAdminRun = jest.fn().mockResolvedValue(undefined);

        await dashboard.restoreCompanyActionSelectionFromUrl();

        expect(dashboard.selectAdminRun).toHaveBeenCalledWith('company-run', {
            source: 'company-action',
            actionContext,
            persistSelection: false,
        });
    });

    test('restores CEO action context from the server action lookup', async () => {
        const { dom, dashboard } = createAgentCompanyHarness({
            url: 'http://localhost:3000/admin/?view=agentCompany&companyAction=1&companyRun=whiteboard-refresh-run&companyActionId=refresh-shared-whiteboard%3A.kimibuilt%2Fagent-company%2F2026-06-22-whiteboard.md',
        });
        dom.window.apiClient = {
            get: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    action: {
                        id: 'refresh-shared-whiteboard',
                        actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                        label: 'Refresh shared whiteboard',
                        detail: 'Whiteboard needs current coordination notes.',
                        target: 'whiteboard-refresh',
                        refreshStatus: {
                            title: 'Operations Lead: Refresh shared whiteboard',
                            status: 'queued',
                            runId: 'whiteboard-refresh-run',
                            runStatus: 'completed',
                        },
                        snapshotAt: '2026-06-28T05:12:00.000Z',
                    },
                    historical: true,
                },
            }),
        };
        dashboard.selectAdminRun = jest.fn().mockResolvedValue(undefined);

        await dashboard.restoreCompanyActionSelectionFromUrl();

        expect(dom.window.apiClient.get).toHaveBeenCalledWith('/api/admin/agent-company/action', {
            actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
        });
        expect(dashboard.selectAdminRun).toHaveBeenCalledWith('whiteboard-refresh-run', {
            source: 'company-action',
            actionContext: expect.objectContaining({
                actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                label: 'Refresh shared whiteboard',
                detail: 'Latest repair: Operations Lead: Refresh shared whiteboard',
                outputPreview: 'Whiteboard needs current coordination notes.',
                contextSource: 'saved-history',
                snapshotAt: '2026-06-28T05:12:00.000Z',
            }),
            persistSelection: false,
        });
    });

    test('re-applies restored repair run selection after action context renders', async () => {
        const { dashboard } = createAgentCompanyHarness({
            url: 'http://localhost:3000/admin/?view=agentCompany&companyAction=1&companyRun=whiteboard-refresh-run&companyActionId=refresh-shared-whiteboard%3A.kimibuilt%2Fagent-company%2F2026-06-22-whiteboard.md',
        });

        dashboard.selectAdminRun = jest.fn().mockImplementation(async (runId, options = {}) => {
            dashboard.state.companyActionRunId = runId;
            dashboard.state.companyActionContext = options.actionContext || {
                label: 'Opened from CEO action queue',
                detail: "Review this run's output evidence before continuing or packaging company work.",
                outputPreview: '',
            };
        });

        await dashboard.restoreCompanyActionSelectionFromUrl();
        expect(dashboard.state.companyActionContext.label).toBe('Opened from CEO action queue');

        dashboard.renderCompanyActionQueue([
            {
                id: 'refresh-shared-whiteboard',
                actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                label: 'Refresh shared whiteboard',
                detail: 'Whiteboard needs current coordination notes.',
                target: 'whiteboard-refresh',
                priority: 'medium',
                refreshStatus: {
                    title: 'Operations Lead: Refresh shared whiteboard',
                    status: 'queued',
                    runId: 'whiteboard-refresh-run',
                    runStatus: 'completed',
                },
            },
        ]);

        await dashboard.restoreCompanyActionSelectionFromUrl();

        expect(dashboard.selectAdminRun).toHaveBeenCalledTimes(2);
        expect(dashboard.selectAdminRun).toHaveBeenLastCalledWith('whiteboard-refresh-run', {
            source: 'company-action',
            actionContext: expect.objectContaining({
                actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                label: 'Refresh shared whiteboard',
                detail: 'Latest repair: Operations Lead: Refresh shared whiteboard',
                outputPreview: 'Whiteboard needs current coordination notes.',
            }),
            persistSelection: false,
        });
    });

    test('renders shared company file manager search results', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.renderCompanyFileManager({
            count: 2,
            refreshed: { workspace: true, artifacts: false },
            results: [
                {
                    id: 'artifact:weekly-plan',
                    sourceType: 'artifact',
                    title: 'Weekly Plan',
                    filename: 'weekly-plan.pdf',
                    artifactId: 'weekly-plan',
                    downloadUrl: '/api/artifacts/weekly-plan/download',
                    inlineUrl: '/api/artifacts/weekly-plan/download?inline=1',
                    contentPreview: 'Operating priorities and next steps.',
                },
                {
                    id: 'workspace:docs/plan.md',
                    sourceType: 'workspace',
                    title: 'Plan Notes',
                    filename: 'plan.md',
                    relativePath: 'docs/plan.md',
                    contentPreview: 'Workspace planning notes.',
                },
            ],
        });

        expect(document.getElementById('companyFileManagerStatus').textContent).toBe('2 documents refreshed');
        expect(document.getElementById('companyFileList').textContent).toContain('Weekly Plan');
        expect(document.getElementById('companyFileList').textContent).toContain('Artifact');
        expect(document.getElementById('companyFileList').textContent).toContain('docs/plan.md');
        expect(document.getElementById('companyFileList').textContent).toContain('Workspace planning notes.');
        expect(document.getElementById('companyFileList').querySelector('a[href="/api/artifacts/weekly-plan/download"]')).not.toBeNull();
    });

    test('filters agent company work and runs by search, state, and role', () => {
        const { dashboard } = createAgentCompanyHarness();

        dashboard.state.workloads.push({
            id: 'company-paused-workload',
            title: 'Editorial Lead: Draft site update',
            sessionId: 'agent-company',
            prompt: 'Write the public update.',
            enabled: false,
            trigger: { type: 'manual' },
            metadata: {
                agentCompany: {
                    enabled: true,
                    roleName: 'Editorial Lead',
                    roleId: 'editorial',
                    planItemId: 'plan-2',
                },
            },
            workloadSummary: { queued: 0, running: 0, failed: 0 },
        });
        dashboard.state.runs.push({
            id: 'editorial-run',
            workloadId: 'company-paused-workload',
            workloadTitle: 'Editorial Lead: Draft site update',
            status: 'failed',
            reason: 'heartbeat',
        });

        dashboard.renderAgentCompanyDashboard();
        expect(document.getElementById('companyRoleFilter').textContent).toContain('Editorial Lead');

        dashboard.state.companyWorkSearch = 'editorial';
        dashboard.state.companyWorkStatusFilter = 'failed';
        dashboard.state.companyRoleFilter = 'editorial';
        dashboard.renderAgentCompanyDashboard();

        expect(document.getElementById('companyWorkloadsTableBody').textContent).toContain('Editorial Lead: Draft site update');
        expect(document.getElementById('companyWorkloadsTableBody').textContent).not.toContain('Strategy Lead: Company weekly plan');
        expect(document.getElementById('companyRunsTableBody').textContent).toContain('editorial-run');
        expect(document.getElementById('companyRunsTableBody').textContent).not.toContain('company-run');
        expect(document.getElementById('companyRunStatus').textContent).toBe('1 of 2 runs');
    });

    test('jumps from agent company console to orchestration settings', () => {
        const dom = new JSDOM(`
            <textarea id="settingsAgentCompanyGoal"></textarea>
        `, { url: 'http://localhost:3000/admin/?view=agentCompany' });
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);
        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.navigateTo = jest.fn();
        dashboard.switchSettingsSection = jest.fn();
        document.getElementById('settingsAgentCompanyGoal').scrollIntoView = jest.fn();

        dashboard.configureAgentCompany();

        expect(dashboard.navigateTo).toHaveBeenCalledWith('settings');
        expect(dashboard.switchSettingsSection).toHaveBeenCalledWith('orchestration');
        expect(document.activeElement).toBe(document.getElementById('settingsAgentCompanyGoal'));
    });

    test('preserves typed agent company settings goal during background refresh', () => {
        const dom = new JSDOM(`
            <textarea id="settingsAgentCompanyGoal"></textarea>
        `, { url: 'http://localhost:3000/admin/?view=settings' });
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);
        global.document = dom.window.document;
        global.window = dom.window;
        dashboard.state = {};
        dashboard.dirtyInputIds = new Set();
        dashboard.setupEventListeners();

        const goal = document.getElementById('settingsAgentCompanyGoal');
        dashboard.setInputValue('settingsAgentCompanyGoal', '');
        goal.value = 'Build a self-sufficient research company';
        goal.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

        const changed = dashboard.setInputValue('settingsAgentCompanyGoal', '', { preserveDirty: true });

        expect(changed).toBe(false);
        expect(goal.value).toBe('Build a self-sufficient research company');
    });

    test('renders selected run details into workload and company output panes', () => {
        const { dashboard } = createAgentCompanyHarness();
        const run = {
            id: 'run-json',
            workloadId: 'company-workload',
            workloadTitle: 'Strategy Lead: Company weekly plan',
            status: 'completed',
            reason: 'heartbeat',
            metadata: { agentCompany: { enabled: true } },
            error: null,
            trace: { steps: Array.from({ length: 20 }, (_, index) => ({ index })) },
            prompt: 'Long prompt text',
        };

        dashboard.renderAdminRunDetails(run);

        expect(document.getElementById('adminRunDetails').querySelectorAll('.workload-detail-code--json')).toHaveLength(3);
        expect(document.getElementById('companyRunDetails').querySelectorAll('.workload-detail-code--json')).toHaveLength(3);
        expect(document.getElementById('companyRunDetails').textContent).toContain('run-json');
    });

    test('labels storage cleanup selections and destructive row actions', () => {
        const dom = new JSDOM(`
            <span id="storageTotalCount"></span>
            <span id="storageTotalBytes"></span>
            <span id="storageDataDirectory"></span>
            <span id="storageSelectionStatus" role="status" aria-live="polite" aria-atomic="true"></span>
            <button id="deleteSelectedStorageBtn" type="button" aria-describedby="storageSelectionStatus"></button>
            <input type="checkbox" id="storageSelectAll">
            <table><tbody id="storageTableBody"></tbody></table>
        `);
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.state = {};
        dashboard.storageSelection = new Set(['generatedArtifacts::artifact-1']);
        dashboard.setTextContent = Dashboard.prototype.setTextContent.bind(dashboard);
        dashboard.formatBytes = Dashboard.prototype.formatBytes.bind(dashboard);
        dashboard.formatDate = jest.fn((value) => `formatted ${value}`);
        dashboard.escapeHtml = Dashboard.prototype.escapeHtml.bind(dashboard);
        dashboard.getStorageSelectionKey = Dashboard.prototype.getStorageSelectionKey.bind(dashboard);
        dashboard.updateStorageSelectionControls = Dashboard.prototype.updateStorageSelectionControls.bind(dashboard);

        dashboard.renderStorageSettings({
            totalCount: 1,
            totalBytes: 1024,
            dataDirectory: 'C:/data',
            categories: [
                {
                    label: 'Generated artifacts',
                    records: [
                        {
                            id: 'artifact-1',
                            category: 'generatedArtifacts',
                            filename: 'quarterly-report.pdf',
                            diskBytes: 1024,
                            updatedAt: '2026-06-29T03:00:00.000Z',
                            storage: 'local',
                        },
                    ],
                },
            ],
        });

        const checkbox = document.querySelector('.storage-select-record');
        const deleteButton = document.getElementById('deleteSelectedStorageBtn');
        const rowDelete = document.querySelector('.storage-delete-file');

        expect(document.getElementById('storageSelectionStatus').getAttribute('role')).toBe('status');
        expect(checkbox.getAttribute('aria-label')).toBe('Select quarterly-report.pdf, Generated artifacts, updated formatted 2026-06-29T03:00:00.000Z');
        expect(checkbox.checked).toBe(true);
        expect(deleteButton.disabled).toBe(false);
        expect(deleteButton.getAttribute('aria-label')).toBe('Delete 1 selected storage record');
        expect(rowDelete.getAttribute('aria-label')).toBe('Delete quarterly-report.pdf');
    });

    test('announces and safely dismisses dashboard toasts', () => {
        jest.useFakeTimers();
        const dom = new JSDOM('<div id="toastContainer" aria-live="polite" aria-atomic="false"></div>');
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.showToast('No new <notifications>', 'info', 3000);

        const toast = document.querySelector('.toast');
        const close = toast.querySelector('.toast-close');
        expect(toast.getAttribute('role')).toBe('status');
        expect(toast.getAttribute('aria-live')).toBe('polite');
        expect(toast.textContent).toContain('No new <notifications>');
        expect(toast.querySelector('notifications')).toBeNull();
        expect(close.getAttribute('type')).toBe('button');
        expect(close.getAttribute('aria-label')).toBe('Dismiss info notification');

        close.focus();
        jest.advanceTimersByTime(3100);
        expect(document.querySelector('.toast')).not.toBeNull();

        close.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(toast.classList.contains('hiding')).toBe(true);
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('respects reduced motion preferences for dashboard toasts', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).toContain('.toast,\n    .toast.hiding');
        expect(css).toContain('animation: none;');
        expect(html).toContain('dashboard.css?v=admin-trustworthy-mission-v1');
    });
});
