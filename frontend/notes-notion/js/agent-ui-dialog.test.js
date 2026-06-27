const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadAgentUI() {
    const source = fs.readFileSync(path.join(__dirname, 'agent-ui.js'), 'utf8');
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="agent-widget" class="agent-widget">
            <button id="agent-widget-btn" class="agent-widget-btn" title="Ask AI about this page">
                <span class="agent-avatar" aria-hidden="true"></span>
                <span class="agent-label">Ask AI</span>
            </button>
        </div>
        <div id="agent-chat-modal" class="agent-chat-modal" role="dialog" aria-modal="true" aria-labelledby="agent-chat-model-name" aria-hidden="true" style="display: none;">
            <div class="agent-chat-overlay"></div>
            <div class="agent-chat-container">
                <div class="agent-chat-header">
                    <div class="agent-chat-title">
                        <span class="agent-avatar" aria-hidden="true"></span>
                        <span id="agent-chat-model-name">AI Assistant</span>
                    </div>
                    <button class="agent-chat-close" type="button" aria-label="Close AI assistant"></button>
                </div>
                <div id="agent-chat-messages" class="agent-chat-messages"></div>
                <div class="agent-chat-input-area">
                    <div id="agent-profile-picker"></div>
                    <textarea id="agent-chat-input"></textarea>
                    <button id="agent-chat-send" type="button"></button>
                    <div id="agent-composer-insights"></div>
                </div>
            </div>
        </div>
    </body></html>`, {
        url: 'http://localhost:3000/notes/',
        pretendToBeVisual: true,
    });
    const windowObject = dom.window;
    windowObject.Agent = {
        getMessages: jest.fn(() => []),
        getModels: jest.fn(() => []),
        getModel: jest.fn(() => ({ id: 'gpt-5.1', name: 'GPT-5.1' })),
        getSelectedModel: jest.fn(() => 'gpt-5.1'),
        getCurrentModel: jest.fn(() => 'gpt-5.1'),
        getSelectedAgentProfile: jest.fn(() => ({ id: 'builder-buddy', name: 'Builder Buddy' })),
        getAgentProfiles: jest.fn(() => []),
        getConversationContext: jest.fn(() => ({ mode: 'page', pageTitle: 'Untitled' })),
    };

    const timers = [];
    const context = {
        console,
        window: windowObject,
        document: windowObject.document,
        HTMLElement: windowObject.HTMLElement,
        requestAnimationFrame: (callback) => callback(),
        setTimeout: jest.fn((callback) => {
            timers.push(callback);
            return timers.length;
        }),
        clearTimeout: jest.fn(),
    };
    context.global = context;
    context.globalThis = context;

    vm.runInNewContext(source, context, { filename: 'agent-ui.js' });
    return { dom, AgentUI: windowObject.AgentUI, timers };
}

describe('Notes AgentUI dialog accessibility', () => {
    test('opens as a controlled dialog, closes on Escape, and restores focus', () => {
        const { dom, AgentUI, timers } = loadAgentUI();
        const widgetBtn = dom.window.document.getElementById('agent-widget-btn');
        const modal = dom.window.document.getElementById('agent-chat-modal');
        const input = dom.window.document.getElementById('agent-chat-input');

        AgentUI.init();
        widgetBtn.focus();
        AgentUI.openChat();
        timers.shift()?.();

        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(modal.getAttribute('aria-labelledby')).toBe('agent-chat-model-name');
        expect(modal.getAttribute('aria-hidden')).toBe('false');
        expect(widgetBtn.getAttribute('aria-controls')).toBe('agent-chat-modal');
        expect(widgetBtn.getAttribute('aria-expanded')).toBe('true');
        expect(dom.window.document.activeElement).toBe(input);

        modal.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
        }));
        timers.shift()?.();

        expect(modal.getAttribute('aria-hidden')).toBe('true');
        expect(modal.style.display).toBe('none');
        expect(widgetBtn.getAttribute('aria-expanded')).toBe('false');
        expect(dom.window.document.activeElement).toBe(widgetBtn);
    });
});
