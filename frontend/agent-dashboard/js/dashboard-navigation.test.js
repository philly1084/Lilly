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

function createNavigationHarness() {
    const dom = new JSDOM(`
        <button id="mobileMenuToggle" type="button" aria-expanded="false">Menu</button>
        <aside id="sidebar">
        <nav>
            <ul>
                <li><button class="nav-item active" data-view="overview" type="button"><span>Overview</span></button></li>
                <li><button class="nav-item" data-view="logs" type="button"><span>Logs</span></button></li>
            </ul>
        </nav>
        </aside>
        <button id="sidebarToggle" type="button"></button>
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
    dom.window.matchMedia = jest.fn().mockReturnValue({ matches: true });

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

function createPromptTabHarness() {
    const dom = new JSDOM(`
        <div class="editor-tabs">
            <button class="tab-btn active" data-tab="editor">Editor</button>
            <button class="tab-btn" data-tab="preview">Preview</button>
        </div>
    `, { url: 'http://localhost:3000/admin/?view=prompts' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    dashboard.switchPromptTab = jest.fn();
    dashboard.setupEventListeners();

    return { dom, dashboard };
}

function createRuntimeListHarness() {
    const dom = new JSDOM(`
        <div id="promptList"></div>
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
        expect(dom.window.document.getElementById('notificationsBtn').getAttribute('aria-label')).toBe('Show notifications');
        expect(dom.window.document.getElementById('notificationsBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('toastContainer').getAttribute('aria-live')).toBe('polite');
        expect(dom.window.document.getElementById('toastContainer').getAttribute('aria-atomic')).toBe('false');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('aria-label')).toBe('Toggle color theme');
        expect(dom.window.document.getElementById('themeToggle').getAttribute('type')).toBe('button');
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
        expect(document.activeElement).toBe(overview);

        dashboard.closeMobileNavigation();

        expect(sidebar.classList.contains('open')).toBe(false);
        expect(mobileToggle.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(mobileToggle);
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

    test('makes runtime list items keyboard-selectable with selected state', () => {
        const { dom, dashboard } = createRuntimeListHarness();
        dashboard.selectPromptById = jest.fn();
        dashboard.selectTrace = jest.fn();
        dashboard.selectAdminRun = jest.fn();

        dashboard.renderPromptList(dashboard.state.prompts);
        dashboard.renderTraces([
            { id: 'trace-a', name: 'Trace A', status: 'success', startedAt: 'now', duration: 24, steps: [] },
            { id: 'trace-b', name: 'Trace B', status: 'running', startedAt: 'later', duration: 12, steps: [] },
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

    test('routes shared whiteboard CEO actions through a focused heartbeat reason', () => {
        const { dashboard } = createAgentCompanyHarness();
        dashboard.runAgentCompanyHeartbeat = jest.fn();

        dashboard.handleCompanyAction('whiteboard-refresh');

        expect(dashboard.runAgentCompanyHeartbeat).toHaveBeenCalledWith({
            source: 'shared-whiteboard-refresh',
        });
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
        expect(history.textContent).toContain('Review saved output <script>alert("x")</script>');
        expect(history.textContent).toContain('Reviewable run');
        expect(history.textContent).toContain('Reference only');
        expect(history.querySelector('script')).toBeNull();
        expect(history.querySelectorAll('button')).toHaveLength(1);
        expect(history.querySelector('button').getAttribute('onclick'))
            .toBe('dashboard.handleCompanyAction("runs", "historical-run", "review-completed-output:historical-run")');
        expect(dashboard.state.companyActionContexts['historical-run']).toEqual(expect.objectContaining({
            label: 'Review saved output <script>alert("x")</script>',
            detail: 'Saved run context from a previous company cycle.',
            outputPreview: 'Saved output preview.',
            contextSource: 'saved-history',
            snapshotAt: '2026-06-28T05:12:00.000Z',
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
});
