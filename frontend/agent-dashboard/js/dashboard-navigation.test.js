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
                <li class="nav-item active" data-view="overview"><span>Overview</span></li>
                <li class="nav-item" data-view="logs"><span>Logs</span></li>
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

function createAgentCompanyHarness() {
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
        <div id="companyRoleList"></div>
        <div id="companyScheduleList"></div>
        <table><tbody id="companyWorkloadsTableBody"></tbody></table>
        <table><tbody id="companyRunsTableBody"></tbody></table>
        <div id="companyAlignmentPanel"></div>
        <div id="adminRunDetails"></div>
        <div id="companyRunDetails"></div>
    `, { url: 'http://localhost:3000/admin/?view=agentCompany' });
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
                        planItemId: 'plan-1',
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
        expect(css).toContain('.tab-btn:focus-visible');
        expect(css).toContain('.toolbar-btn:focus-visible');
        expect(css).toContain('.toggle input:focus-visible + .toggle-slider');
        expect(css).toContain('.range-input input[type="range"]:focus-visible');
        expect(css).toContain('.prompt-item.active .prompt-item-meta {\n    color: var(--bg-primary);');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    });

    test('keeps workload run JSON previews scroll-contained', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.workload-detail-code--json');
        expect(css).toContain('max-height: min(42vh, 420px);');
        expect(css).toContain('overflow: auto;');
        expect(css).toContain('overscroll-behavior: contain;');
    });

    test('keeps global search focus from shifting header controls', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'dashboard.css'), 'utf8');

        expect(css).toContain('.header-right {\n    display: flex;\n    align-items: center;\n    gap: var(--space-md);\n    min-width: 0;');
        expect(css).toContain('.search-box {\n    position: relative;\n    display: flex;\n    align-items: center;\n    flex: 0 1 320px;\n    min-width: 0;');
        expect(css).toContain('width: clamp(180px, 24vw, 320px);');
        expect(css).toContain('width: clamp(120px, 28vw, 180px);');
        expect(css).not.toContain('.search-box input:focus {\n    outline: none;\n    border-color: var(--accent-primary);\n    width:');
    });

    test('makes sidebar items keyboard targets with active page state', () => {
        createNavigationHarness();
        const overview = document.querySelector('[data-view="overview"]');
        const logs = document.querySelector('[data-view="logs"]');

        expect(overview.getAttribute('role')).toBe('button');
        expect(overview.getAttribute('tabindex')).toBe('0');
        expect(overview.getAttribute('aria-current')).toBe('page');
        expect(logs.getAttribute('role')).toBe('button');
        expect(logs.getAttribute('tabindex')).toBe('0');
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
        expect(document.getElementById('companyScheduleList').textContent).toContain('Company weekly plan');
        expect(document.getElementById('companyWorkloadsTableBody').textContent).toContain('Strategy Lead: Company weekly plan');
        expect(document.getElementById('companyWorkloadsTableBody').textContent).not.toContain('Unrelated job');
        expect(document.getElementById('companyRunsTableBody').textContent).toContain('company-run');
        expect(document.getElementById('companyRunsTableBody').textContent).not.toContain('other-run');
        expect(document.getElementById('companyAlignmentPanel').textContent).toContain('daily-proof-note');
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
});
