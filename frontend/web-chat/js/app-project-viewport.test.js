const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatAppPrototype() {
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
        URL,
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context.ChatApp.prototype;
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
});
