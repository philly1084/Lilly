const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadDashboardClass(dom, dependencies = {}) {
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
        ...dependencies,
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
                <li><a class="nav-item" href="/agent-ops/"><span>Agent Command Center</span></a></li>
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

function createPrivacyDetectorHarness() {
    const dom = new JSDOM('<div id="piiDetectorGrid"></div>', {
        url: 'http://localhost:3000/admin/?view=settings',
    });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    dashboard.piiDetectorDefinitions = [
        { id: 'email', label: 'Email' },
        { id: 'creditCard', label: 'Credit card' },
    ];

    return { dom, dashboard };
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

    test('identifies the current page in the admin breadcrumb', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const breadcrumbs = dom.window.document.getElementById('breadcrumbs');
        const current = breadcrumbs.querySelector('.current');

        expect(breadcrumbs.getAttribute('aria-label')).toBe('Breadcrumb');
        expect(current.getAttribute('aria-current')).toBe('page');
        expect(current.textContent).toBe('Overview');
    });

    test('labels overview card controls with their data context', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);

        const range = dom.window.document.getElementById('chartTimeRange');
        const heading = dom.window.document.getElementById('requestVolumeHeading');
        const canvas = dom.window.document.getElementById('requestVolumeCanvas');
        const summary = dom.window.document.getElementById('requestVolumeSummary');
        const recentActivityButton = dom.window.document.querySelector('#overviewView [data-view="logs"]');

        expect(range.getAttribute('aria-label')).toBe('Request volume time range');
        expect(canvas.getAttribute('role')).toBe('img');
        expect(canvas.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(canvas.getAttribute('aria-describedby')).toBe(summary.id);
        expect(summary.textContent).toBe('No request volume data for Last 24 Hours.');
        expect(recentActivityButton.getAttribute('type')).toBe('button');
        expect(recentActivityButton.getAttribute('aria-label')).toBe('View all recent activity logs');
    });

    test('uses a decorative task-list symbol for the total tasks metric', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const totalTasks = dom.window.document.getElementById('totalTasks').closest('.stat-card');
        const icon = totalTasks.querySelector('.task-list-icon');

        expect(icon).not.toBeNull();
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(icon.getAttribute('focusable')).toBe('false');
        expect(icon.querySelector('rect')).not.toBeNull();
        expect(icon.textContent).not.toContain('$');
    });

    test('names advanced settings actions by their full outcome', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);

        const actions = [
            ['clearAllLogsBtn', 'Clear all request logs'],
            ['resetConfigBtn', 'Reset configuration to defaults'],
            ['exportDataBtn', 'Export all configuration and logs'],
        ];

        actions.forEach(([id, label]) => {
            const button = dom.window.document.getElementById(id);
            expect(button.getAttribute('type')).toBe('button');
            expect(button.getAttribute('aria-label')).toBe(label);
        });
    });

    test('summarizes request chart data for non-visual users', () => {
        const dom = new JSDOM(`
            <select id="chartTimeRange"><option selected>Last 24 Hours</option></select>
            <p id="requestVolumeSummary"></p>
        `);
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        dashboard.updateRequestChartSummary({
            labels: ['9 a.m.', '10 a.m.', '11 a.m.'],
            values: [1, 4, 2],
        });

        expect(dom.window.document.getElementById('requestVolumeSummary').textContent).toBe(
            'Request volume for Last 24 Hours: 3 data points, 7 total requests. Peak 4 requests at 10 a.m. Latest 2 requests at 11 a.m.'
        );

        dashboard.updateRequestChartSummary({ labels: [], values: [] });
        expect(dom.window.document.getElementById('requestVolumeSummary').textContent).toBe(
            'No request volume data for Last 24 Hours.'
        );
    });

    test('limits request chart labels to the available plot width', () => {
        const dom = new JSDOM('<canvas id="requestVolumeCanvas"></canvas>');
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);
        const labels = Array.from({ length: 24 }, (_, index) => `Hour ${index + 1}`);

        expect(dashboard.getRequestChartLabelCount(labels, 238)).toBe(2);
        expect(dashboard.getRequestChartLabelCount(labels, 640)).toBe(6);
        expect(dashboard.getRequestChartLabelCount(['Now'], 238)).toBe(1);
    });

    test('labels tool catalog search and support filters', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const search = dom.window.document.getElementById('skillSearch');
        const supportFilter = dom.window.document.getElementById('toolSupportFilter');

        expect(search.getAttribute('type')).toBe('search');
        expect(search.labels[0].textContent.trim()).toBe('Search tool catalog');
        expect(supportFilter.labels[0].textContent.trim()).toBe('Filter tools by support level');
        expect(dom.window.document.getElementById('discoverSkillsBtn').getAttribute('type')).toBe('button');
    });

    test('associates the Perplexity research setting with its label and guidance', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const select = dom.window.document.getElementById('settingsPerplexityResearchLevel');

        expect(select.labels[0].textContent.trim()).toBe('Perplexity research level');
        expect(select.getAttribute('aria-describedby')).toBe('settingsPerplexityResearchLevelDescription');
        expect(dom.window.document.getElementById('settingsPerplexityResearchLevelDescription').textContent.trim())
            .toContain('Choose how aggressively agents use Perplexity');
    });

    test('labels prompt editor fields and insertion controls', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);

        expect(dom.window.document.getElementById('newPromptBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('promptSearch').getAttribute('aria-label')).toBe('Search prompt library');
        expect(dom.window.document.getElementById('promptName').getAttribute('aria-label')).toBe('Prompt name');
        expect(dom.window.document.getElementById('promptEditor').getAttribute('aria-label')).toBe('Prompt editor content');
        expect(dom.window.document.getElementById('testPromptBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('savePromptBtn').getAttribute('type')).toBe('button');
        expect(dom.window.document.getElementById('promptHistoryBtn').getAttribute('type')).toBe('button');

        const toolbarButtons = Array.from(dom.window.document.querySelectorAll('#editorTab .toolbar-btn'));
        expect(toolbarButtons.map((button) => button.getAttribute('type'))).toEqual(['button', 'button', 'button']);
        expect(toolbarButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Insert variable placeholder',
            'Insert context placeholder',
            'Insert user input placeholder',
        ]);
        expect(toolbarButtons.map((button) => button.getAttribute('title'))).toEqual([
            'Insert variable placeholder',
            'Insert context placeholder',
            'Insert user input placeholder',
        ]);
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

    test('links to the standalone Agent Command Center without exposing the retired company console', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const commandCenter = dom.window.document.querySelector('.sidebar-nav a[href="/agent-ops/"]');

        expect(commandCenter).not.toBeNull();
        expect(commandCenter.textContent.trim()).toBe('Agent Command Center');
        expect(commandCenter.hasAttribute('data-view')).toBe(false);
        expect(dom.window.document.getElementById('agentCompanyView')).toBeNull();
        expect(dom.window.document.getElementById('settingsAgentCompanyEnabled')).toBeNull();
        expect(html).not.toContain('Agent Business Console');
    });


    test('keeps dashboard focus and reduced-motion affordances in CSS', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('--focus-ring: rgba(121, 192, 255, 0.38)');
        expect(css).toContain('.btn:focus-visible');
        expect(css).toContain('.search-box input:focus-visible');
        expect(css).toContain('body[data-ui-surface="admin"] .sidebar-toggle:focus-visible');
        expect(css).toContain('body[data-ui-surface="admin"] .modal-close:focus-visible');
        expect(css).toContain('.modal-header .modal-close {');
        expect(css).not.toMatch(/\n\.modal-close \{\n/);
        expect(css).toContain('body[data-ui-surface="admin"] .toast-close:focus-visible');
        expect(css).toContain('.toast:focus-within');
        expect(css).toContain('.tab-btn:focus-visible');
        expect(css).toContain('.toolbar-btn:focus-visible');
        expect(css).toContain('.toggle input:focus-visible + .toggle-slider');
        expect(css).toContain('.range-input input[type="range"]:focus-visible');
        expect(css).toContain('.prompt-item.active .prompt-item-meta {\n    color: var(--bg-primary);');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    });

    test('keeps live system health values readable without clipping', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(css).toContain('.metric-value {\n    width: max-content;\n    min-width: 50px;\n    flex-shrink: 0;');
        expect(html).toContain('css/dashboard.css?v=admin-token-table-focus-v3');
    });

    test('associates each memory editor with its own character limit and current count', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const document = dom.window.document;

        for (const [editorId, prefix] of [
            ['soulContent', 'soul'],
            ['userProfileContent', 'userProfile'],
            ['agentNotesContent', 'agentNotes'],
        ]) {
            const editor = document.getElementById(editorId);
            const helpId = editor.getAttribute('aria-describedby');
            expect(helpId).toBe(`${prefix}CharacterHelp`);
            expect(document.querySelectorAll(`#${helpId}`)).toHaveLength(1);
            const help = document.getElementById(helpId);
            expect(help.textContent).toMatch(/Hard limit: \d+ characters\. Current: 0\./);
            expect(help.querySelector(`#${prefix}CharacterLimit`)).not.toBeNull();
            const count = help.querySelector(`#${prefix}CharacterCount`);
            count.textContent = '42';
            expect(document.getElementById(editor.getAttribute('aria-describedby')).textContent)
                .toContain('Current: 42.');
        }
        dom.window.close();
    });

    test('separates recent activity titles from supporting context', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.activity-content {\n    display: flex;\n    flex-direction: column;\n    gap: 2px;');
    });

    test('keeps the self-reflection header readable on narrow screens', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(css).toContain('@media (max-width: 480px)');
        expect(css).toContain('.self-reflection-header {\n        align-items: stretch;\n        flex-direction: column;');
        expect(css).toContain('.self-reflection-header .card-actions {\n        justify-content: space-between;');
        expect(css).toContain('.self-reflection-header .status-badge {\n        white-space: nowrap;');
        expect(html).toContain('class="card-header self-reflection-header"');
        expect(html).toContain('css/dashboard.css?v=admin-token-table-focus-v3');
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

    test('keeps setup-required tool badges readable in the light theme', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('body[data-ui-surface="admin"][data-admin-theme="light"] .support-badge.requires_setup');
        expect(css).toContain('color: #6b4300;');
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

    test('keeps informational log badges readable in the light theme', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(css).toContain('body[data-ui-surface="admin"][data-admin-theme="light"]');
        expect(css).toContain('--info-light: #164ea6;');
        expect(css).toContain('.log-level.info');
        expect(css).toContain('color: var(--info-light);');
        expect(html).toContain('css/dashboard.css?v=admin-token-table-focus-v3');
    });

    test('associates trace toolbar labels with every filter', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html, { url: 'http://localhost:3000/admin/?view=traces' });
        const document = dom.window.document;

        expect(document.getElementById('traceSessionFilter').labels[0].textContent.trim()).toBe('Session');
        expect(document.getElementById('traceStatusFilter').labels[0].textContent.trim()).toBe('Status');
        expect(document.getElementById('traceSearch').labels[0].textContent.trim()).toBe('Search traces');
        expect(document.getElementById('traceSearch').labels[0].classList.contains('sr-only')).toBe(true);
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

    test('exposes self-reflection refresh progress and prevents duplicate requests', async () => {
        const dom = new JSDOM(`
            <body>
                <button id="refreshSelfReflectionBtn" type="button" aria-controls="selfReflectionUpdates" aria-label="Refresh self-reflection updates">Refresh</button>
                <div id="selfReflectionUpdates"></div>
                <span id="selfReflectionStatus"></span>
            </body>
        `);
        let resolveUpdates;
        const apiClient = {
            getSelfReflectionUpdates: jest.fn(() => new Promise(resolve => {
                resolveUpdates = resolve;
            })),
            getSelfReflectionSuggestions: jest.fn(async () => ({ suggestions: [] })),
        };
        const Dashboard = loadDashboardClass(dom, { apiClient });
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.state = {
            selfReflectionSupported: null,
            selfReflectionUpdates: [],
            selfReflectionSuggestions: [],
            selfReflectionMeta: {},
            selfReflectionSuggestionMeta: {},
        };
        dashboard.unwrapApiPayload = Dashboard.prototype.unwrapApiPayload.bind(dashboard);
        dashboard.normalizeSelfReflectionUpdate = Dashboard.prototype.normalizeSelfReflectionUpdate.bind(dashboard);
        dashboard.normalizeSelfReflectionSuggestion = Dashboard.prototype.normalizeSelfReflectionSuggestion.bind(dashboard);
        dashboard.renderSelfReflectionUpdates = jest.fn();

        const loading = dashboard.loadSelfReflectionUpdates({ force: true });
        const refreshButton = dom.window.document.getElementById('refreshSelfReflectionBtn');

        expect(refreshButton.disabled).toBe(true);
        expect(refreshButton.getAttribute('aria-busy')).toBe('true');
        expect(refreshButton.getAttribute('aria-label')).toBe('Refreshing self-reflection updates');
        expect(refreshButton.textContent).toBe('Refreshing...');

        resolveUpdates({ updates: [] });
        await loading;

        expect(refreshButton.disabled).toBe(false);
        expect(refreshButton.hasAttribute('aria-busy')).toBe(false);
        expect(refreshButton.getAttribute('aria-label')).toBe('Refresh self-reflection updates');
        expect(refreshButton.textContent).toBe('Refresh');
    });

    test('exposes workload refresh progress and prevents duplicate requests', async () => {
        const dom = new JSDOM(`
            <button id="refreshWorkloadsBtn" type="button" aria-label="Refresh workloads">
                <span id="refreshWorkloadsLabel">Refresh Workloads</span>
            </button>
        `);
        let resolveWorkloads;
        const apiClient = {
            getAdminWorkloads: jest.fn(() => new Promise(resolve => {
                resolveWorkloads = resolve;
            })),
            getAdminRuns: jest.fn(async () => []),
        };
        const Dashboard = loadDashboardClass(dom, { apiClient });
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.state = {
            workloadsSupported: true,
            workloads: [],
            runs: [],
            selectedRun: null,
        };
        dashboard.unwrapApiPayload = Dashboard.prototype.unwrapApiPayload.bind(dashboard);
        dashboard.normalizeAdminWorkload = jest.fn(value => value);
        dashboard.normalizeAdminRun = jest.fn(value => value);
        dashboard.renderWorkloadSummary = jest.fn();
        dashboard.renderAdminWorkloads = jest.fn();
        dashboard.renderAdminRuns = jest.fn();
        dashboard.renderAdminRunDetails = jest.fn();

        const loading = dashboard.loadWorkloads();
        const refreshButton = dom.window.document.getElementById('refreshWorkloadsBtn');

        expect(refreshButton.disabled).toBe(true);
        expect(refreshButton.getAttribute('aria-busy')).toBe('true');
        expect(refreshButton.getAttribute('aria-label')).toBe('Refreshing workloads');
        expect(dom.window.document.getElementById('refreshWorkloadsLabel').textContent).toBe('Refreshing...');

        resolveWorkloads([]);
        await loading;

        expect(refreshButton.disabled).toBe(false);
        expect(refreshButton.hasAttribute('aria-busy')).toBe(false);
        expect(refreshButton.getAttribute('aria-label')).toBe('Refresh workloads');
        expect(dom.window.document.getElementById('refreshWorkloadsLabel').textContent).toBe('Refresh Workloads');
    });

    test('keeps password reveal labels synchronized after toggles', () => {
        const dom = new JSDOM(`
            <input type="password" id="apiKey">
            <button id="showApiKey" type="button" aria-label="Show API key" aria-controls="apiKey" aria-pressed="false"></button>
        `);
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        dashboard.setupEventListeners();
        document.getElementById('showApiKey').click();

        expect(document.getElementById('apiKey').type).toBe('text');
        expect(document.getElementById('showApiKey').getAttribute('aria-label')).toBe('Hide API key');
        expect(document.getElementById('showApiKey').getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById('showApiKey').getAttribute('title')).toBe('Hide API key');

        document.getElementById('showApiKey').click();

        expect(document.getElementById('apiKey').type).toBe('password');
        expect(document.getElementById('showApiKey').getAttribute('aria-label')).toBe('Show API key');
        expect(document.getElementById('showApiKey').getAttribute('aria-pressed')).toBe('false');
        expect(document.getElementById('showApiKey').getAttribute('title')).toBe('Show API key');
    });

    test('keeps workload run JSON previews scroll-contained', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.workload-detail-code--json');
        expect(css).toContain('max-height: min(42vh, 420px);');
        expect(css).toContain('overflow: auto;');
        expect(css).toContain('overscroll-behavior: contain;');
    });

    test('contains wide workload tables inside the admin content column', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.main-content {\n    flex: 1;\n    min-width: 0;');
        expect(css).toContain('.table-wrapper {\n    overflow-x: auto;');
    });

    test('makes the per-model token table keyboard-scrollable', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const region = dom.window.document.getElementById('tokenUsageTableRegion');

        expect(region.getAttribute('role')).toBe('region');
        expect(region.getAttribute('aria-labelledby')).toBe('tokenUsageTableHeading');
        expect(region.getAttribute('tabindex')).toBe('0');
        expect(css).toMatch(/body\[data-ui-surface="admin"\] \.token-usage-table-region:focus\s*\{[^}]*outline:\s*2px solid var\(--accent-primary\);/s);
    });


    test('keeps global search focus from shifting header controls', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.header-right {\n    display: flex;\n    align-items: center;\n    gap: var(--space-md);\n    min-width: 0;');
        expect(css).toContain('.search-box {\n    position: relative;\n    display: flex;\n    align-items: center;\n    flex: 0 1 320px;\n    min-width: 0;');
        expect(css).toContain('width: clamp(180px, 24vw, 320px);');
        expect(css).toContain('width: clamp(120px, 28vw, 180px);');
        expect(css).not.toContain('.search-box input:focus {\n    outline: none;\n    border-color: var(--accent-primary);\n    width:');
    });

    test('keeps prompt editor actions visible on narrow screens', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(css).toContain('@media (max-width: 768px)');
        expect(css).toContain('.editor-header {\n        align-items: stretch;\n        flex-direction: column;');
        expect(css).toContain('.editor-actions {\n        flex-wrap: wrap;');
        expect(css).toContain('.prompt-name-input {\n        min-width: 0;\n        width: 100%;');
        expect(html).toContain('css/dashboard.css?v=admin-token-table-focus-v3');
    });

    test('wraps tool card actions before they clip narrow cards', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toMatch(/\.skill-footer\s*\{[^}]*flex-wrap:\s*wrap;/s);
        expect(css).toMatch(/\.skill-footer\s*\{[^}]*gap:\s*var\(--space-sm\);/s);
        expect(css).toMatch(/\.skill-actions\s*\{[^}]*margin-left:\s*auto;/s);
    });

    test('makes sidebar items native buttons with active page state', () => {
        createNavigationHarness();
        const overview = document.querySelector('[data-view="overview"]');
        const logs = document.querySelector('[data-view="logs"]');
        const commandCenter = document.querySelector('a[href="/agent-ops/"]');

        expect(overview.tagName).toBe('BUTTON');
        expect(overview.getAttribute('type')).toBe('button');
        expect(overview.hasAttribute('role')).toBe(false);
        expect(overview.getAttribute('aria-current')).toBe('page');
        expect(logs.tagName).toBe('BUTTON');
        expect(logs.getAttribute('type')).toBe('button');
        expect(logs.hasAttribute('role')).toBe(false);
        expect(logs.getAttribute('aria-current')).toBe('false');
        expect(commandCenter.getAttribute('href')).toBe('/agent-ops/');
        expect(commandCenter.hasAttribute('role')).toBe(false);
        expect(commandCenter.hasAttribute('tabindex')).toBe(false);
        expect(commandCenter.hasAttribute('aria-current')).toBe(false);
    });

    test('ships initial sidebar current-page state in the static markup', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const navItems = Array.from(dom.window.document.querySelectorAll('.sidebar-nav .nav-item[data-view]'));
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

    test('names podcast audio controls for their track', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const tracks = [
            ['intro', 'intro'],
            ['outro', 'outro'],
            ['musicBed', 'music bed'],
        ];

        tracks.forEach(([track, label]) => {
            const input = dom.window.document.querySelector(`.podcast-audio-input[data-track="${track}"]`);
            const upload = dom.window.document.querySelector(`.podcast-audio-upload[data-track="${track}"]`);
            const remove = dom.window.document.querySelector(`.podcast-audio-remove[data-track="${track}"]`);

            expect(input.getAttribute('aria-label')).toBe(`Choose ${label} audio file`);
            expect(upload.getAttribute('aria-label')).toBe(`Upload ${label} audio`);
            expect(remove.getAttribute('aria-label')).toBe(`Remove ${label} audio`);
        });
    });

    test('labels settings password reveal controls with field state', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const controls = [
            ['showApiKey', 'apiKey', 'Show API key'],
            ['showOpenaiKey', 'openaiKey', 'Show OpenAI API key'],
            ['showSshPassword', 'sshPassword', 'Show SSH password'],
        ];

        controls.forEach(([buttonId, inputId, label]) => {
            const button = dom.window.document.getElementById(buttonId);
            const icon = button.querySelector('svg');

            expect(button.getAttribute('type')).toBe('button');
            expect(button.getAttribute('aria-label')).toBe(label);
            expect(button.getAttribute('aria-controls')).toBe(inputId);
            expect(button.getAttribute('aria-pressed')).toBe('false');
            expect(button.getAttribute('title')).toBe(label);
            expect(icon.getAttribute('aria-hidden')).toBe('true');
        });
    });

    test('associates Privacy and PII feature toggles with their visible names', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const controls = [
            ['piiEnabled', 'Enable PII cleansing gateway'],
            ['piiWebChatEnabled', 'Apply to web chat'],
            ['piiFailClosed', 'Fail closed'],
            ['piiHighlightRestored', 'Highlight restored values'],
            ['piiAllowUserOverride', 'Allow user override'],
            ['piiRelationshipCalculationsEnabled', 'Privacy-aware spreadsheet calculations'],
            ['piiRelationshipCalculationsAutoDetect', 'Auto-detect spreadsheet math'],
            ['piiRelationshipCalculationsAllowExplicit', 'Allow explicit calculation request'],
        ];

        controls.forEach(([controlId, label]) => {
            const control = dom.window.document.getElementById(controlId);
            const labelElement = dom.window.document.getElementById(control.getAttribute('aria-labelledby'));

            expect(labelElement?.textContent.trim()).toBe(label);
        });
    });

    test('associates durable context toggles with their visible names and descriptions', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const controls = [
            ['personalityEnabled', 'Enable soul.md', 'Turn the persistent personality layer on or off without deleting the file.'],
            ['userProfileEnabled', 'Enable user.md', 'Keep the bounded user profile available without mixing it into the soul or project notes.'],
            ['agentNotesEnabled', 'Enable carryover notes', 'Keep a compact, durable notes layer available to the model without mixing it into the personality file.'],
        ];

        controls.forEach(([controlId, label, description]) => {
            const control = dom.window.document.getElementById(controlId);
            const labelElement = dom.window.document.getElementById(control.getAttribute('aria-labelledby'));
            const descriptionElement = dom.window.document.getElementById(control.getAttribute('aria-describedby'));

            expect(labelElement?.textContent.trim()).toBe(label);
            expect(descriptionElement?.textContent.trim()).toBe(description);
        });
    });

    test('associates notification toggles with their visible names and descriptions', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const controls = [
            ['notifyEmail', 'Email Notifications', 'Receive email alerts for system events'],
            ['notifyErrors', 'Error Alerts', 'Get notified when errors occur'],
            ['notifyDaily', 'Daily Summary', 'Receive daily usage summary'],
        ];

        controls.forEach(([controlId, label, description]) => {
            const control = dom.window.document.getElementById(controlId);
            const labelElement = dom.window.document.getElementById(control.getAttribute('aria-labelledby'));
            const descriptionElement = dom.window.document.getElementById(control.getAttribute('aria-describedby'));

            expect(labelElement?.textContent.trim()).toBe(label);
            expect(descriptionElement?.textContent.trim()).toBe(description);
        });
    });

    test('labels Privacy and PII detector action dropdowns by detector', () => {
        const { dom, dashboard } = createPrivacyDetectorHarness();

        dashboard.renderPrivacyDetectorGrid({
            detectors: ['email'],
            detectorActions: { email: 'mask' },
        });

        const selects = Array.from(dom.window.document.querySelectorAll('.pii-detector-action'));
        expect(selects).toHaveLength(2);
        expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
            'Email action',
            'Credit card action',
        ]);
        expect(selects[0].value).toBe('mask');
        expect(selects[1].value).toBe('vault-placeholder');
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

    test('associates Test Prompt dialog controls with their visible labels', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html);
        const modal = dom.window.document.getElementById('testPromptModal');
        const controls = [
            ['testModel', 'Model'],
            ['testTemperature', 'Temperature'],
            ['testInput', 'Test Input'],
        ];

        controls.forEach(([controlId, label]) => {
            const control = modal.querySelector(`#${controlId}`);

            expect(control.labels).toHaveLength(1);
            expect(control.labels[0].textContent.trim()).toBe(label);
        });
    });

    test('moves focus into admin dialogs and returns it to the invoking control', () => {
        const dom = new JSDOM(`
            <button id="openDialog" type="button">Open dialog</button>
            <div class="modal" id="exampleModal" role="dialog" aria-modal="true">
                <div class="modal-container">
                    <button class="modal-close" type="button">Close</button>
                    <input id="dialogInput" type="text">
                </div>
            </div>
        `, { url: 'http://localhost:3000/admin/' });
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);
        const trigger = dom.window.document.getElementById('openDialog');
        const modal = dom.window.document.getElementById('exampleModal');
        const closeButton = modal.querySelector('.modal-close');
        const dialogInput = dom.window.document.getElementById('dialogInput');

        global.document = dom.window.document;
        global.window = dom.window;
        dashboard.modalReturnFocus = new Map();
        trigger.focus();

        dashboard.openModal('exampleModal', trigger);

        expect(modal.classList.contains('active')).toBe(true);
        expect(dom.window.document.activeElement).toBe(closeButton);

        closeButton.focus();
        const backwardTab = { shiftKey: true, preventDefault: jest.fn() };
        dashboard.containModalFocus(modal, backwardTab);
        expect(backwardTab.preventDefault).toHaveBeenCalledTimes(1);
        expect(dom.window.document.activeElement).toBe(dialogInput);

        const forwardTab = { shiftKey: false, preventDefault: jest.fn() };
        dashboard.containModalFocus(modal, forwardTab);
        expect(forwardTab.preventDefault).toHaveBeenCalledTimes(1);
        expect(dom.window.document.activeElement).toBe(closeButton);

        dashboard.closeModal('exampleModal');

        expect(modal.classList.contains('active')).toBe(false);
        expect(dom.window.document.activeElement).toBe(trigger);
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
        expect(html).toContain('dashboard.js?v=admin-model-usage-progress-v1');
        expect(html).toContain('css/dashboard.css?v=admin-token-table-focus-v3');
        expect(html).toContain('id="traceQualitySummary"');
        expect(html).toContain('id="traceEvalSummary"');
        expect(html).toContain('<title>Lilly Mission Control</title>');
        expect(html).not.toContain('vs last hour');
    });

    test('announces system health changes with a specific status label', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(html, { url: 'http://localhost:3000/admin/' });
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;

        const status = dom.window.document.getElementById('systemHealthStatus');
        expect(status.getAttribute('role')).toBe('status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
        expect(status.getAttribute('aria-label')).toBe('System health: Healthy');

        dashboard.renderSystemHealth({
            status: 'degraded',
            memory: { heapUsed: 50, heapTotal: 100 },
            services: { sdk: 'connected', vectorStore: 'disconnected' },
        }, 240);
        expect(status.textContent).toBe('Degraded');
        expect(status.getAttribute('aria-label')).toBe('System health: Degraded');

        dashboard.renderSystemHealth(null, 0, new Error('offline'));
        expect(status.textContent).toBe('Disconnected');
        expect(status.getAttribute('aria-label')).toBe('System health: Disconnected');
    });

    test('names model request-share bars as progress indicators', async () => {
        const dom = new JSDOM('<div id="modelUsage"></div>', {
            url: 'http://localhost:3000/admin/',
        });
        const apiClient = {
            get: jest.fn().mockResolvedValue({
                success: true,
                data: [
                    { modelName: 'Auto', requests: 20, successRate: 95 },
                    { modelName: 'Gpt Image 2', requests: 1, successRate: 5 },
                ],
            }),
        };
        const Dashboard = loadDashboardClass(dom, { apiClient });
        const dashboard = Object.create(Dashboard.prototype);

        global.document = dom.window.document;
        global.window = dom.window;
        dashboard.unwrapApiPayload = Dashboard.prototype.unwrapApiPayload.bind(dashboard);
        dashboard.escapeHtml = Dashboard.prototype.escapeHtml.bind(dashboard);

        await dashboard.loadModelUsage();

        const bars = [...dom.window.document.querySelectorAll('[role="progressbar"]')];
        expect(bars).toHaveLength(2);
        expect(bars[0].getAttribute('aria-label')).toBe('Auto request share');
        expect(bars[0].getAttribute('aria-valuemin')).toBe('0');
        expect(bars[0].getAttribute('aria-valuemax')).toBe('100');
        expect(bars[0].getAttribute('aria-valuenow')).toBe('95');
        expect(bars[0].getAttribute('aria-valuetext')).toBe('95% of requests');
        expect(bars[0].querySelector('.model-fill').style.width).toBe('95%');
        expect(dom.window.document.querySelector('.model-percent').getAttribute('aria-hidden')).toBe('true');
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

    test('keeps long trace names inside a concise wrapping preview', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toMatch(/\.trace-header\s*\{[^}]*min-width:\s*0;/s);
        expect(css).toMatch(/\.trace-name\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*-webkit-line-clamp:\s*3;/s);
        expect(css).toMatch(/\.trace-status\s*\{[^}]*flex:\s*0 0 auto;/s);
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

    test('renders selected run details and quality gates only in the workload pane', () => {
        const dom = new JSDOM('<div id="adminRunDetails"></div>');
        const Dashboard = loadDashboardClass(dom);
        const dashboard = Object.create(Dashboard.prototype);
        global.document = dom.window.document;
        global.window = dom.window;
        dashboard.formatDate = jest.fn((value) => value || '-');

        dashboard.renderAdminRunDetails({
            id: 'run-quality',
            workloadId: 'workload-a',
            workloadTitle: 'Coordinate a verified release',
            status: 'completed',
            reason: 'manual',
            prompt: 'Ship with evidence.',
            metadata: {
                remoteCliAgent: {
                    agentQuality: {
                        status: 'partial',
                        score: 0.55,
                        requiredMissing: ['public_or_preview_url', 'browser_proof'],
                        surfaces: [
                            { id: 'remote-deployment', label: 'Remote CLI deployment quality', score: 0.6, requiredMissing: [] },
                        ],
                    },
                },
            },
            error: null,
            trace: { steps: [] },
        });

        const details = document.getElementById('adminRunDetails');
        expect(details.querySelectorAll('.workload-detail-code--json')).toHaveLength(3);
        expect(details.textContent).toContain('run-quality');
        expect(details.textContent).toContain('Agent Quality Gates');
        expect(details.textContent).toContain('55%');
        expect(document.getElementById('companyRunDetails')).toBeNull();
    });


    test('labels storage cleanup selections and destructive row actions', () => {
        const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const indexDom = new JSDOM(indexHtml);
        const storageCaption = indexDom.window.document.querySelector('.storage-table caption');

        expect(storageCaption.classList.contains('sr-only')).toBe(true);
        expect(storageCaption.textContent.trim()).toBe('Managed storage records');

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
        expect(html).toContain('dashboard.css?v=admin-token-table-focus-v3');
    });

    test('keeps Lilly Wiki text readable across fixed and themed surfaces', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('body[data-ui-surface="admin"][data-admin-theme="light"] .lilly-kicker');
        expect(css).toMatch(/\.lilly-stat-label\s*{[^}]*color: #f0f6fc;/s);
        expect(css).toMatch(/\.lilly-stat-detail\s*{[^}]*color: #c9d1d9;/s);
        expect(css).toMatch(/\.lilly-legend-item\s*{[^}]*color: #0d1117;/s);
    });

});
