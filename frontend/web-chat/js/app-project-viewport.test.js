const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatAppContext() {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/\/\/ Initialize app when DOM is ready[\s\S]*$/, 'globalThis.ChatApp = ChatApp;');

    const context = {
        window: {
            location: { origin: 'https://chat.example.test' },
            KimiBuiltWebChatWorkspace: null,
            KimiBuiltWebChatWorkspaceEmbed: null,
        },
        document: {
            getElementById: () => null,
            addEventListener: () => {},
        },
        uiHelpers: {
            isMinimalistMode: () => false,
            reinitializeIcons: () => {},
        },
        URL,
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context;
}

function loadChatAppPrototype() {
    return loadChatAppContext().ChatApp.prototype;
}

describe('web-chat project viewport helpers', () => {
    test('normalizes managed app public hosts into live HTTPS preview URLs', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.buildProjectViewportUrl({
            publicHost: 'demo-app.demoserver2.buzz',
        })).toBe('https://demo-app.demoserver2.buzz');
        expect(app.buildProjectViewportUrl({
            publicUrl: 'https://demo-app.demoserver2.buzz/live',
            publicHost: 'ignored.example.test',
        })).toBe('https://demo-app.demoserver2.buzz/live');
    });

    test('uses preview URLs before sandbox wrappers as viewport project targets', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.buildProjectViewportUrl({
            type: 'sandbox',
            sandboxUrl: '/api/artifacts/artifact-site-1/sandbox',
        })).toBe('/api/artifacts/artifact-site-1/sandbox');
        expect(app.buildProjectViewportUrl({
            type: 'sandbox',
            previewUrl: '/api/sandbox-workspaces/workspace-1/preview',
        })).toBe('/api/sandbox-workspaces/workspace-1/preview');
        expect(app.buildProjectViewportUrl({
            type: 'sandbox',
            sandboxUrl: '/api/artifacts/artifact-site-1/sandbox',
            previewUrl: '/api/artifacts/artifact-site-1/preview',
        })).toBe('/api/artifacts/artifact-site-1/preview');
    });

    test('tokenizes sandbox preview URLs before embedding them', async () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        app.projectPreviewTokenCache = null;
        context.window.location = {
            hostname: 'chat.example.test',
            protocol: 'https:',
            host: 'chat.example.test',
            href: 'https://chat.example.test/web-chat/app.html',
            origin: 'https://chat.example.test',
        };
        context.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                token: 'signed-preview-token',
                expiresAt: Math.floor(Date.now() / 1000) + 600,
            }),
        }));

        await expect(app.resolveProjectViewportUrl({
            type: 'sandbox',
            sandboxUrl: '/api/artifacts/artifact-site-1/sandbox',
        })).resolves.toBe('https://chat.example.test/api/artifacts/artifact-site-1/sandbox-access/signed-preview-token');
        expect(context.fetch).toHaveBeenCalledWith(
            'https://chat.example.test/api/auth/ws-token',
            expect.objectContaining({
                credentials: 'same-origin',
                cache: 'no-store',
            }),
        );
    });

    test('keeps viewport sizing to the supported persistent choices', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.normalizeProjectViewportSize('compact')).toBe('compact');
        expect(app.normalizeProjectViewportSize('wide')).toBe('wide');
        expect(app.normalizeProjectViewportSize('full')).toBe('full');
        expect(app.normalizeProjectViewportSize('collapsed')).toBe('collapsed');
        expect(app.normalizeProjectViewportSize('giant')).toBe('wide');
    });

    test('unloads the project iframe when collapsed without dropping active project metadata', () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        const projectViewport = createFakeElement('project-viewport');
        const appShell = createFakeElement('app');
        const frame = createFakeElement('project-viewport-frame');
        const label = createFakeElement('project-viewport-label');
        const link = createFakeElement('project-viewport-link');
        const collapseButton = createFakeElement('collapse-button');
        collapseButton.dataset.projectViewportSize = 'collapsed';
        const wideButton = createFakeElement('wide-button');
        wideButton.dataset.projectViewportSize = 'wide';
        projectViewport.querySelectorAll = (selector) => selector === '[data-project-viewport-size]'
            ? [collapseButton, wideButton]
            : [];

        context.uiHelpers = {
            isMinimalistMode: () => false,
            reinitializeIcons: () => {},
        };
        context.document = {
            getElementById: (id) => ({
                app: appShell,
            }[id] || null),
        };

        app.projectViewport = projectViewport;
        app.projectViewportFrame = frame;
        app.projectViewportLabel = label;
        app.projectViewportLink = link;
        app.getCurrentProjectViewportState = () => ({
            project: {
                title: 'Demo app',
                publicHost: 'demo-app.demoserver2.buzz',
            },
            url: 'https://demo-app.demoserver2.buzz',
            size: 'collapsed',
        });

        app.renderProjectViewport();

        expect(projectViewport.classList.contains('hidden')).toBe(false);
        expect(projectViewport.classList.contains('is-collapsed')).toBe(true);
        expect(projectViewport.classList.contains('is-suspended')).toBe(true);
        expect(appShell.classList.contains('has-project-viewport')).toBe(true);
        expect(frame.dataset.projectUrl).toBe('');
        expect(frame.dataset.suspendedProjectUrl).toBe('https://demo-app.demoserver2.buzz');
        expect(frame.src).toBeUndefined();
        expect(label.textContent).toBe('Demo app');
    });

    test('minimal layout fully removes the viewport and unloads the iframe', () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        const projectViewport = createFakeElement('project-viewport');
        const appShell = createFakeElement('app');
        const frame = createFakeElement('project-viewport-frame');
        projectViewport.querySelectorAll = () => [];

        context.uiHelpers = {
            isMinimalistMode: () => true,
            reinitializeIcons: () => {},
        };
        context.document = {
            getElementById: (id) => ({
                app: appShell,
            }[id] || null),
        };

        app.projectViewport = projectViewport;
        app.projectViewportFrame = frame;
        app.projectViewportLabel = createFakeElement('project-viewport-label');
        app.projectViewportLink = createFakeElement('project-viewport-link');
        app.getCurrentProjectViewportState = () => ({
            project: {
                title: 'Demo app',
                publicHost: 'demo-app.demoserver2.buzz',
            },
            url: 'https://demo-app.demoserver2.buzz',
            size: 'wide',
        });

        app.renderProjectViewport();

        expect(projectViewport.classList.contains('hidden')).toBe(true);
        expect(projectViewport.getAttribute('aria-hidden')).toBe('true');
        expect(appShell.classList.contains('has-project-viewport')).toBe(false);
        expect(frame.dataset.projectUrl).toBe('');
        expect(frame.dataset.suspendedProjectUrl).toBe('https://demo-app.demoserver2.buzz');
        expect(frame.src).toBeUndefined();
    });

    test('uses a lightweight placeholder while deferred session details load', () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        const projectViewport = createFakeElement('project-viewport');
        const appShell = createFakeElement('app');
        const frame = createFakeElement('project-viewport-frame');
        const stateLabel = createFakeElement('project-viewport-state-label');
        const stateDetail = createFakeElement('project-viewport-state-detail');

        context.sessionManager = { currentSessionId: 'session-new' };
        context.document = {
            getElementById: (id) => ({
                app: appShell,
            }[id] || null),
        };

        app.projectViewport = projectViewport;
        app.projectViewportFrame = frame;
        app.projectViewportStateLabel = stateLabel;
        app.projectViewportStateDetail = stateDetail;
        app.currentSessionWorkloads = [{ id: 'old-workload' }];
        app.workloadRunsById = new Map([['old-workload', []]]);
        app.hiddenCompletedWorkloadCount = 2;
        app.renderWorkloadsPanel = jest.fn();

        app.hideDeferredSessionSurfaces('session-new');

        expect(projectViewport.classList.contains('hidden')).toBe(true);
        expect(projectViewport.classList.contains('is-suspended')).toBe(true);
        expect(projectViewport.getAttribute('aria-hidden')).toBe('true');
        expect(appShell.classList.contains('has-project-viewport')).toBe(false);
        expect(frame.dataset.projectUrl).toBe('');
        expect(frame.src).toBeUndefined();
        expect(stateLabel.textContent).toBe('Loading preview');
        expect(app.currentSessionWorkloads).toEqual([]);
        expect(app.hiddenCompletedWorkloadCount).toBe(0);
        expect(app.renderWorkloadsPanel).toHaveBeenCalled();
    });

    test('ignores stale workload responses from sessions that are no longer visible', async () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        const existingRuns = new Map([['current-workload', []]]);

        context.sessionManager = {
            currentSessionId: 'session-current',
            isLocalSession: () => false,
        };
        context.apiClient = {
            getSessionWorkloads: jest.fn(async () => ({
                available: true,
                workloads: [{ id: 'old-workload' }],
            })),
            getWorkloadRuns: jest.fn(async () => [{ id: 'old-run' }]),
        };

        app.isLoadingWorkloads = false;
        app.loadingWorkloadsSessionId = null;
        app.workloadsAvailable = true;
        app.currentSessionWorkloads = [{ id: 'current-workload' }];
        app.workloadRunsById = existingRuns;
        app.hiddenCompletedWorkloadCount = 0;
        app.shouldHideCompletedWorkload = () => false;
        app.renderWorkloadsPanel = jest.fn();
        app.pauseWorkloadSocket = jest.fn();
        app.subscribeToSessionUpdates = jest.fn();

        const result = await app.loadSessionWorkloads('session-old');

        expect(result).toEqual([{ id: 'old-workload' }]);
        expect(app.currentSessionWorkloads).toEqual([{ id: 'current-workload' }]);
        expect(app.workloadRunsById).toBe(existingRuns);
        expect(app.renderWorkloadsPanel).not.toHaveBeenCalled();
        expect(app.subscribeToSessionUpdates).not.toHaveBeenCalled();
        expect(app.loadingWorkloadsSessionId).toBeNull();
        expect(app.isLoadingWorkloads).toBe(false);
    });
});

function createFakeElement(id = 'element') {
    const classes = new Set();
    const attributes = {};
    const element = {
        id,
        dataset: {},
        classList: {
            add: (...classNames) => {
                classNames.forEach((className) => classes.add(className));
            },
            remove: (...classNames) => {
                classNames.forEach((className) => classes.delete(className));
            },
            toggle: (className, force) => {
                const shouldAdd = typeof force === 'boolean' ? force : !classes.has(className);
                if (shouldAdd) {
                    classes.add(className);
                } else {
                    classes.delete(className);
                }
                return shouldAdd;
            },
            contains: (className) => classes.has(className),
        },
        setAttribute: (name, value) => {
            attributes[name] = String(value);
        },
        getAttribute: (name) => attributes[name],
        removeAttribute: (name) => {
            delete attributes[name];
            if (name === 'src') {
                delete element.src;
            }
        },
        querySelectorAll: () => [],
        textContent: '',
        href: '',
    };
    return element;
}
