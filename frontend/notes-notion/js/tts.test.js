const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadNotesTts() {
    const source = fs.readFileSync(path.join(__dirname, 'tts.js'), 'utf8');
    const dom = new JSDOM(`<!doctype html><html><body>
        <button id="notes-tts-btn" aria-pressed="false" disabled>
            <span id="notes-tts-label">Read</span>
        </button>
        <span id="notes-tts-status" role="status" aria-live="polite" aria-atomic="true">Read aloud unavailable until the page has readable text.</span>
        <main id="editor">
            <section class="block" data-block-id="block-1">
                <div class="block-input">Read the selected launch note aloud.</div>
            </section>
        </main>
    </body></html>`, {
        url: 'http://localhost:3000/notes/',
        pretendToBeVisual: true,
    });
    const listeners = new Map();
    class FakeTtsManager {
        addEventListener(type, listener) {
            listeners.set(type, listener);
        }
        getVoiceLabel() {
            return 'Test Voice';
        }
        isAvailable() {
            return true;
        }
        getDiagnostics() {
            return {};
        }
        isLoadingMessage() {
            return false;
        }
        isPlayingMessage(messageId) {
            return Boolean(messageId);
        }
        ensureConfigLoaded() {
            return Promise.resolve();
        }
        speakMessage() {
            return new Promise(() => {});
        }
    }
    const context = {
        console,
        window: dom.window,
        document: dom.window.document,
        CSS: dom.window.CSS,
        Node: dom.window.Node,
        Date,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback) => callback(),
        cancelAnimationFrame: jest.fn(),
    };
    dom.window.KimiBuiltRealtimeTtsManager = FakeTtsManager;
    dom.window.Sidebar = { showToast: jest.fn() };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: 'tts.js' });
    return { dom, NotesTts: dom.window.NotesTts, listeners };
}

describe('Notes TTS controls', () => {
    test('uses the active selection label while selected text is playing', async () => {
        const { dom, NotesTts } = loadNotesTts();
        const textNode = dom.window.document.querySelector('.block-input').firstChild;
        const range = dom.window.document.createRange();
        range.setStart(textNode, 9);
        range.setEnd(textNode, 17);
        const selection = dom.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        NotesTts.init();
        NotesTts.togglePageSpeech();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const button = dom.window.document.getElementById('notes-tts-btn');
        expect(button.disabled).toBe(false);
        expect(button.dataset.readMode).toBe('selection');
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Stop selected text narration');
        expect(dom.window.document.getElementById('notes-tts-label').textContent).toBe('Stop');
        const status = dom.window.document.getElementById('notes-tts-status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
        expect(status.textContent).toBe('Reading selected text aloud.');
    });
});
