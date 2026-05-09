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
});

function createFakeElement(id = 'element') {
    const classes = new Set();
    const attributes = {};
    const element = {
        id,
        dataset: {},
        classList: {
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
