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
            setTimeout,
            clearTimeout,
        },
        document: {
            getElementById: () => null,
            addEventListener: () => {},
        },
        setTimeout,
        clearTimeout,
        URL,
        console,
    };

    vm.createContext(context);
    vm.runInContext(source, context);
    return context.ChatApp.prototype;
}

describe('web-chat stream stability', () => {
    test('keeps accepted interrupted streams in resync mode instead of retry fallback', () => {
        const app = Object.create(loadChatAppPrototype());
        app.getTrackedStreamRequest = () => ({ acceptedByServer: true });
        app.isAppBackgrounded = () => false;
        app.pageWasHidden = false;
        app.connectionStatus = 'connected';

        expect(app.shouldResyncAfterDisconnect({ code: 'stream_incomplete' }, {
            hidden: false,
            online: true,
        })).toBe(true);
    });

    test('buffers streaming message renders to reduce frontend flashing', () => {
        const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

        expect(source).toContain('const STREAM_RENDER_BUFFER_MS = 90;');
        expect(source).toContain('scheduleBufferedStreamingRender(sessionId, savedMessage, options);');
        expect(source).toContain('reconcileVisibleMessages(previousMessages, messages);');
    });
});
