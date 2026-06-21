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
        <nav>
            <ul>
                <li class="nav-item active" data-view="overview"><span>Overview</span></li>
                <li class="nav-item" data-view="logs"><span>Logs</span></li>
            </ul>
        </nav>
        <section id="overviewView" class="view active"></section>
        <section id="logsView" class="view"></section>
        <h1 id="pageTitle">Overview</h1>
        <div class="breadcrumbs"><span class="current">Overview</span></div>
    `, { url: 'http://localhost:3000/admin/' });
    const Dashboard = loadDashboardClass(dom);
    const dashboard = Object.create(Dashboard.prototype);

    global.document = dom.window.document;
    global.window = dom.window;

    dashboard.state = { currentView: 'overview' };
    dashboard.closeMobileNavigation = jest.fn();
    dashboard.loadViewData = jest.fn();
    dashboard.setupNavigation();

    return { dom, dashboard };
}

describe('agent dashboard navigation accessibility', () => {
    afterEach(() => {
        delete global.document;
        delete global.window;
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

        logs.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(dashboard.state.currentView).toBe('logs');
        expect(logs.classList.contains('active')).toBe(true);
        expect(logs.getAttribute('aria-current')).toBe('page');
        expect(document.getElementById('logsView').classList.contains('active')).toBe(true);
        expect(dashboard.closeMobileNavigation).toHaveBeenCalledTimes(1);

        overview.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: ' ',
            bubbles: true,
            cancelable: true,
        }));

        expect(dashboard.state.currentView).toBe('overview');
        expect(overview.classList.contains('active')).toBe(true);
        expect(overview.getAttribute('aria-current')).toBe('page');
        expect(logs.getAttribute('aria-current')).toBe('false');
        expect(dashboard.closeMobileNavigation).toHaveBeenCalledTimes(2);
    });
});
