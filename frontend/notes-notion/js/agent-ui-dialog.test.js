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
        <button
            id="model-selector-btn"
            type="button"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-controls="model-list"
        >
            <span id="current-model-label">GPT-5.1</span>
        </button>
        <div id="model-selector-dropdown" style="display: none;">
            <div id="model-selector-heading">Select Model</div>
            <div id="model-list" role="listbox" aria-labelledby="model-selector-heading"></div>
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
                    <div id="agent-reference-panel" class="agent-reference-panel">
                        <button
                            id="agent-reference-btn"
                            type="button"
                            aria-haspopup="dialog"
                            aria-expanded="false"
                            aria-controls="agent-reference-popover"
                        >+ Reference</button>
                        <div id="agent-reference-popover" role="dialog" hidden>
                            <input
                                id="agent-reference-search"
                                type="search"
                                role="combobox"
                                aria-label="Search reference pages and chats"
                                aria-autocomplete="list"
                                aria-expanded="false"
                                aria-controls="agent-reference-results"
                            >
                            <button id="agent-reference-close" type="button"></button>
                            <div id="agent-reference-results" role="listbox" hidden></div>
                        </div>
                        <div id="agent-reference-chips" aria-live="polite"></div>
                    </div>
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
        getModelsAsync: jest.fn(() => Promise.resolve([])),
        getModel: jest.fn((id = 'gpt-5.1') => ({ id, name: id === 'gpt-5.2' ? 'GPT-5.2' : 'GPT-5.1' })),
        getSelectedModel: jest.fn(() => 'gpt-5.1'),
        setSelectedModel: jest.fn(() => true),
        getCurrentModel: jest.fn(() => 'gpt-5.1'),
        getSelectedAgentProfile: jest.fn(() => ({ id: 'builder-buddy', name: 'Builder Buddy' })),
        getAgentProfiles: jest.fn(() => []),
        getConversationContext: jest.fn(() => ({ mode: 'page', pageTitle: 'Untitled' })),
    };
    windowObject.NotesStorage = {
        loadAll: jest.fn(() => ({
            currentSpaceId: 'private',
            spaces: [{ id: 'private', name: 'Private' }],
            pages: [{
                id: 'page-1',
                title: 'Launch checklist',
                icon: 'L',
                blocks: [{ type: 'text', content: 'Release readiness and rollout notes' }],
                updatedAt: '2026-06-29T12:00:00.000Z',
            }],
        })),
        getPages: jest.fn(() => []),
    };
    windowObject.Editor = {
        getCurrentPage: jest.fn(() => null),
    };

    const timers = [];
    const context = {
        console,
        window: windowObject,
        document: windowObject.document,
        HTMLElement: windowObject.HTMLElement,
        CustomEvent: windowObject.CustomEvent,
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
    test('keeps notifications clear of the persistent AI launcher', () => {
        const styles = fs.readFileSync(path.join(__dirname, '..', 'css', 'notion-refinements.css'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

        expect(styles).toMatch(/\.toast-container\s*{[^}]*bottom: 94px;/);
        expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*\.toast-container\s*{[^}]*bottom: calc\(72px \+ env\(safe-area-inset-bottom, 0px\)\);/);
        expect(html).toContain('css/notion-refinements.css?v=20260826-toast-clearance');
    });

    test('keeps the compact mobile launcher visibly identifiable as AI', () => {
        const styles = fs.readFileSync(path.join(__dirname, '..', 'css', 'notion-refinements.css'), 'utf8');

        expect(styles).toMatch(/@media \(max-width: 430px\)[\s\S]*\.agent-widget-btn\s*{[^}]*width: 48px;/);
        expect(styles).toMatch(/@media \(max-width: 430px\)[\s\S]*\.agent-avatar::before\s*{[^}]*content: 'AI';/);
    });

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

    test('wires the reference picker search as a combobox listbox', () => {
        const { dom, AgentUI, timers } = loadAgentUI();
        const referenceBtn = dom.window.document.getElementById('agent-reference-btn');
        const search = dom.window.document.getElementById('agent-reference-search');
        const results = dom.window.document.getElementById('agent-reference-results');

        AgentUI.init();
        AgentUI.openChat();
        timers.shift()?.();

        referenceBtn.click();
        timers.shift()?.();

        expect(referenceBtn.getAttribute('aria-expanded')).toBe('true');
        expect(search.getAttribute('role')).toBe('combobox');
        expect(search.getAttribute('aria-controls')).toBe('agent-reference-results');
        expect(search.getAttribute('aria-expanded')).toBe('false');
        expect(results.getAttribute('role')).toBe('listbox');
        expect(dom.window.document.activeElement).toBe(search);

        search.value = 'launch';
        search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

        const option = results.querySelector('[role="option"]');
        expect(results.hidden).toBe(false);
        expect(search.getAttribute('aria-expanded')).toBe('true');
        expect(search.getAttribute('aria-activedescendant')).toBe(option.id);
        expect(option.getAttribute('aria-selected')).toBe('false');
        expect(option.getAttribute('aria-label')).toBe('Add Launch checklist reference');
    });

    test('opens the model selector as a labelled listbox with keyboard-selectable options', async () => {
        const { dom, AgentUI } = loadAgentUI();
        const { document, KeyboardEvent } = dom.window;
        const modelBtn = document.getElementById('model-selector-btn');
        const dropdown = document.getElementById('model-selector-dropdown');
        const modelList = document.getElementById('model-list');
        const models = [
            {
                id: 'gpt-5.1',
                name: 'GPT-5.1',
                description: 'Balanced reasoning',
                provider: 'openai',
            },
            {
                id: 'gpt-5.2',
                name: 'GPT-5.2',
                description: 'Deeper document work',
                provider: 'openai',
            },
        ];

        dom.window.Agent.getModels.mockReturnValue(models);
        dom.window.Agent.getModelsAsync.mockResolvedValue(models);

        AgentUI.init();
        await AgentUI.toggleModelSelector();

        expect(modelBtn.getAttribute('aria-controls')).toBe('model-list');
        expect(modelBtn.getAttribute('aria-expanded')).toBe('true');
        expect(dropdown.style.display).toBe('flex');
        expect(modelList.getAttribute('role')).toBe('listbox');
        expect(modelList.getAttribute('aria-labelledby')).toBe('model-selector-heading');

        const options = modelList.querySelectorAll('[role="option"]');
        expect(options).toHaveLength(2);
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        expect(options[0].getAttribute('aria-label')).toBe('GPT-5.1. Balanced reasoning');
        expect(options[0].getAttribute('tabindex')).toBe('0');

        options[1].dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
        }));

        expect(dom.window.Agent.setSelectedModel).toHaveBeenCalledWith('gpt-5.2');
        expect(modelBtn.getAttribute('aria-expanded')).toBe('false');
        expect(dropdown.style.display).toBe('none');
    });
});
