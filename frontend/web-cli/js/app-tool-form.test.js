const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadWebCliToolFormHelpers(overrides = {}) {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(
            /const app = new CodeCLIApp\(\);\s*window\.app = app;\s*$/,
            'module.exports = { CodeCLIApp };'
        );
    const sandbox = {
        module: { exports: {} },
        exports: {},
        ...overrides,
    };

    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return sandbox.module.exports;
}

function createToolFormHarness() {
    const { CodeCLIApp } = loadWebCliToolFormHelpers();
    const app = Object.create(CodeCLIApp.prototype);
    app.escapeHtml = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    app.escapeHtmlAttr = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return app;
}

function createSandboxCommandHarness({ api = { invokeTool: jest.fn() } } = {}) {
    const { CodeCLIApp } = loadWebCliToolFormHelpers({ api });
    const app = Object.create(CodeCLIApp.prototype);
    app.setActiveVoxelTool = jest.fn();
    app.setStatus = jest.fn();
    app.reactVoxelPet = jest.fn();
    app.recordVoxelToolUse = jest.fn();
    app.collectArtifactsFromValue = jest.fn(() => []);
    app.syncArtifactsToSessionFiles = jest.fn(() => []);
    app.printAI = jest.fn();
    app.printError = jest.fn();
    app.handlePetAction = jest.fn();
    app.formatFileSize = (size) => `${size} B`;
    return { app, api };
}

describe('web-cli tool form rendering', () => {
    test('renders enum parameters as selectable controls', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('mode', {
            type: 'string',
            enum: ['preview', 'content', 'base64'],
            description: 'Read mode.',
        }, true);

        expect(markup).toContain('<select');
        expect(markup).toContain('data-tool-param="mode"');
        expect(markup).toContain('<option value="preview" selected>preview</option>');
        expect(markup).toContain('<option value="base64">base64</option>');
        expect(markup).not.toContain('<input type="text"');
    });

    test('allows optional enum parameters to stay unset', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('category', {
            type: 'string',
            enum: ['images', 'docs'],
        }, false);

        expect(markup).toContain('<option value="">Optional</option>');
        expect(markup).not.toContain('value="images" selected');
    });

    test('defaults required enum parameters to the first choice', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('format', {
            type: 'string',
            enum: ['html', 'pdf', 'pptx'],
        }, true);

        expect(markup).toContain('<option value="html" selected>html</option>');
        expect(markup).not.toContain('<option value="">Optional</option>');
    });

    test('marks required select and text-like fields for native browser validation', () => {
        const app = createToolFormHarness();

        const selectMarkup = app.renderToolField('format', {
            type: 'string',
            enum: ['html', 'pdf'],
        }, true);
        const inputMarkup = app.renderToolField('url', {
            type: 'string',
        }, true);
        const textareaMarkup = app.renderToolField('prompt', {
            type: 'string',
        }, true);

        expect(selectMarkup).toContain('data-tool-required="true" required>');
        expect(inputMarkup).toContain('data-tool-required="true" placeholder="string" required>');
        expect(textareaMarkup).toContain('data-tool-required="true" placeholder="Describe the result you want..." required>');
    });

    test('does not force optional text-like fields through native required validation', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('url', {
            type: 'string',
        }, false);

        expect(markup).toContain('data-tool-required="false"');
        expect(markup).not.toContain(' required');
    });

    test('renders string and number defaults as submitted control values', () => {
        const app = createToolFormHarness();

        const inputMarkup = app.renderToolField('limit', {
            type: 'number',
            default: 25,
        }, false);
        const textareaMarkup = app.renderToolField('query', {
            type: 'string',
            default: 'status:open',
        }, false);

        expect(inputMarkup).toContain('placeholder="number" value="25"');
        expect(textareaMarkup).toContain('>status:open</textarea>');
    });

    test('hints integer parameters with whole-number browser stepping', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('maxRetries', {
            type: 'integer',
            default: 3,
        }, false);

        expect(markup).toContain('type="number"');
        expect(markup).toContain('placeholder="integer" step="1" value="3"');
    });

    test('normalizes nullable schema types before rendering controls', () => {
        const app = createToolFormHarness();

        const objectMarkup = app.renderToolField('sitePolicy', {
            type: ['object', 'null'],
            description: 'Optional crawl policy.',
        }, false);
        const integerMarkup = app.renderToolField('limit', {
            type: ['null', 'integer'],
            default: 5,
        }, false);

        expect(objectMarkup).toContain('data-tool-type="object"');
        expect(objectMarkup).toContain('placeholder="{&quot;key&quot;:&quot;value&quot;}"');
        expect(integerMarkup).toContain('type="number"');
        expect(integerMarkup).toContain('data-tool-type="integer"');
        expect(integerMarkup).toContain('placeholder="integer" step="1" value="5"');
    });

    test('renders mixed string and object parameters as flexible body textareas', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('body', {
            type: ['string', 'object'],
            default: { prompt: 'Hello' },
            description: 'Request body.',
        }, false);

        expect(markup).toContain('<textarea rows="4"');
        expect(markup).toContain('data-tool-type="json-or-string"');
        expect(markup).toContain('placeholder="string or {&quot;key&quot;:&quot;value&quot;}"');
        expect(markup).toContain('"prompt": "Hello"');
        expect(markup).not.toContain('[object Object]');
    });

    test('unwraps simple oneOf schemas for tool form rendering', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('choice', {
            oneOf: [
                { type: 'string' },
                { type: 'object', properties: { id: { type: 'string' } } },
            ],
            description: 'Choice value.',
        }, true);

        expect(markup).toContain('data-tool-type="string"');
        expect(markup).toContain('placeholder="string" required>');
        expect(markup).toContain('Choice value.');
    });

    test('renders object and array parameters as JSON textareas', () => {
        const app = createToolFormHarness();

        const objectMarkup = app.renderToolField('payload', {
            type: 'object',
            default: { mode: 'preview', limit: 2 },
            description: 'Tool payload.',
        }, true);
        const arrayMarkup = app.renderToolField('items', {
            type: 'array',
            default: ['alpha', 'beta'],
        }, false);

        expect(objectMarkup).toContain('<textarea rows="4"');
        expect(objectMarkup).toContain('placeholder="{&quot;key&quot;:&quot;value&quot;}" required>');
        expect(objectMarkup).toContain('"mode": "preview"');
        expect(objectMarkup).toContain('"limit": 2');
        expect(objectMarkup).toContain('Tool payload.');
        expect(arrayMarkup).toContain('placeholder="[&quot;value&quot;]"');
        expect(arrayMarkup).toContain('"alpha"');
        expect(arrayMarkup).not.toContain('[object Object]');
    });

    test('renders boolean true defaults as checked controls', () => {
        const app = createToolFormHarness();

        const checkedMarkup = app.renderToolField('includeArchived', {
            type: 'boolean',
            default: true,
        }, false);
        const uncheckedMarkup = app.renderToolField('dryRun', {
            type: 'boolean',
            default: false,
        }, false);

        expect(checkedMarkup).toContain('data-tool-required="false" checked>');
        expect(uncheckedMarkup).not.toContain(' checked');
    });

    test('marks the active tool category chip for assistive technology', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolCategoryChips([
            { id: 'web-fetch', category: 'Research' },
            { id: 'remote-command', category: 'Remote' },
        ], 'Research');
        const dom = new JSDOM(markup);
        const buttons = Array.from(dom.window.document.querySelectorAll('button'));
        const byLabel = Object.fromEntries(buttons.map((button) => [button.textContent.trim(), button]));

        expect(byLabel.All.classList.contains('is-active')).toBe(false);
        expect(byLabel.All.getAttribute('aria-pressed')).toBe('false');
        expect(byLabel.Research.classList.contains('is-active')).toBe(true);
        expect(byLabel.Research.getAttribute('aria-pressed')).toBe('true');
        expect(byLabel.Remote.getAttribute('aria-pressed')).toBe('false');
    });

    test('collects selected enum parameters through the normal tool JSON path', () => {
        const app = createToolFormHarness();
        const fields = [
            { dataset: { toolParam: 'mode', toolType: 'string' }, type: 'select-one', value: 'content' },
            { dataset: { toolParam: 'category', toolType: 'string' }, type: 'select-one', value: '' },
        ];
        const form = {
            querySelector: () => null,
            querySelectorAll: () => fields,
        };

        expect(app.collectToolMenuFormParams(form)).toEqual({ mode: 'content' });
    });

    test('collects object and array JSON parameters through the normal tool JSON path', () => {
        const app = createToolFormHarness();
        const fields = [
            { dataset: { toolParam: 'payload', toolType: 'object' }, type: 'textarea', value: '{"mode":"preview","limit":2}' },
            { dataset: { toolParam: 'items', toolType: 'array' }, type: 'textarea', value: '["alpha","beta"]' },
            { dataset: { toolParam: 'emptyOptional', toolType: 'object' }, type: 'textarea', value: '' },
        ];
        const form = {
            querySelector: () => null,
            querySelectorAll: () => fields,
        };

        expect(app.collectToolMenuFormParams(form)).toEqual({
            payload: { mode: 'preview', limit: 2 },
            items: ['alpha', 'beta'],
        });
    });

    test('collects mixed string and object parameters as text or parsed JSON', () => {
        const app = createToolFormHarness();
        const textForm = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'body', toolType: 'json-or-string' }, type: 'textarea', value: 'plain request body' },
            ],
        };
        const jsonForm = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'body', toolType: 'json-or-string' }, type: 'textarea', value: '{"prompt":"Hello"}' },
            ],
        };

        expect(app.collectToolMenuFormParams(textForm)).toEqual({ body: 'plain request body' });
        expect(app.collectToolMenuFormParams(jsonForm)).toEqual({ body: { prompt: 'Hello' } });
    });

    test('rejects wrong JSON shapes for mixed string and object parameters', () => {
        const app = createToolFormHarness();
        const form = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'body', toolType: 'json-or-string' }, type: 'textarea', value: '["not","object"]' },
            ],
        };

        expect(() => app.collectToolMenuFormParams(form)).toThrow('body must be plain text or a JSON object');
    });

    test('rejects structured JSON parameters with the wrong schema shape', () => {
        const app = createToolFormHarness();
        const arrayAsObjectForm = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'items', toolType: 'array' }, type: 'textarea', value: '{"alpha":true}' },
            ],
        };
        const objectAsArrayForm = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'payload', toolType: 'object' }, type: 'textarea', value: '["alpha"]' },
            ],
        };

        expect(() => app.collectToolMenuFormParams(arrayAsObjectForm)).toThrow('items must be a JSON array');
        expect(() => app.collectToolMenuFormParams(objectAsArrayForm)).toThrow('payload must be a JSON object');
    });

    test('rejects invalid numeric values before staging tool parameters', () => {
        const app = createToolFormHarness();
        const invalidNumberForm = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'limit', toolType: 'number' }, type: 'number', value: 'not-a-number' },
            ],
        };
        const fractionalIntegerForm = {
            querySelector: () => null,
            querySelectorAll: () => [
                { dataset: { toolParam: 'count', toolType: 'integer' }, type: 'number', value: '1.5' },
            ],
        };

        expect(() => app.collectToolMenuFormParams(invalidNumberForm)).toThrow('limit must be a valid number');
        expect(() => app.collectToolMenuFormParams(fractionalIntegerForm)).toThrow('count must be an integer');
    });

    test('marks boolean fields as required-aware controls', () => {
        const app = createToolFormHarness();

        const markup = app.renderToolField('force', {
            type: 'boolean',
        }, true);

        expect(markup).toContain('type="checkbox"');
        expect(markup).toContain('data-tool-param="force"');
        expect(markup).toContain('data-tool-required="true"');
    });

    test('omits unchecked optional boolean parameters from staged tool JSON', () => {
        const app = createToolFormHarness();
        const fields = [
            { dataset: { toolParam: 'dryRun', toolType: 'boolean', toolRequired: 'false' }, type: 'checkbox', checked: false },
            { dataset: { toolParam: 'verbose', toolType: 'boolean', toolRequired: 'false' }, type: 'checkbox', checked: true },
            { dataset: { toolParam: 'confirm', toolType: 'boolean', toolRequired: 'true' }, type: 'checkbox', checked: false },
        ];
        const form = {
            querySelector: () => null,
            querySelectorAll: () => fields,
        };

        expect(app.collectToolMenuFormParams(form)).toEqual({
            verbose: true,
            confirm: false,
        });
    });
});

describe('web-cli agent companion dialog focus', () => {
    test('returns focus to the invoking control when the dialog closes', () => {
        const dom = new JSDOM(`
            <button id="opener" type="button">Open companion</button>
            <aside id="voxelDock" class="hidden"></aside>
            <input id="voxelPetPrompt">
        `, { pretendToBeVisual: true });
        const { document } = dom.window;
        const { CodeCLIApp } = loadWebCliToolFormHelpers({
            document,
            window: dom.window,
        });
        const app = Object.create(CodeCLIApp.prototype);
        app.voxelDock = document.getElementById('voxelDock');
        app.voxelPetPrompt = document.getElementById('voxelPetPrompt');
        app.setVoxelPetHidden = jest.fn();
        app.renderVoxelPet = jest.fn();
        app.roamVoxelPet = jest.fn();
        app.printSystem = jest.fn();
        const opener = document.getElementById('opener');
        opener.focus();

        app.focusVoxelCreator({ silent: true });
        expect(app.voxelCreatorReturnFocus).toBe(opener);
        expect(app.voxelDock.classList.contains('hidden')).toBe(false);

        app.closeVoxelCreator();
        expect(document.activeElement).toBe(opener);
        expect(app.voxelCreatorReturnFocus).toBeNull();
        expect(app.voxelDock.classList.contains('hidden')).toBe(true);
    });
});

describe('web-cli sandbox command routing', () => {
    test('routes prompt-only project sandbox requests through document-workflow generation', async () => {
        const api = {
            invokeTool: jest.fn().mockResolvedValue({
                result: {
                    data: {
                        sandboxBuild: {
                            mode: 'project',
                            artifact: {
                                id: 'artifact-1',
                                filename: 'gallery.zip',
                                sandboxUrl: '/sandbox/gallery',
                                bundleDownloadUrl: '/download/gallery.zip',
                            },
                        },
                    },
                },
            }),
        };
        const { app } = createSandboxCommandHarness({ api });

        await app.invokeSandboxCommand([
            'project',
            JSON.stringify({
                projectName: 'Gallery',
                prompt: 'Build a playable React art gallery.',
            }),
        ]);

        expect(api.invokeTool).toHaveBeenCalledWith('document-workflow', expect.objectContaining({
            action: 'generate-suite',
            prompt: 'Build a playable React art gallery.',
            formats: ['html'],
            buildMode: 'sandbox',
            useSandbox: true,
            includeContent: true,
            title: 'Gallery',
            documentType: 'website',
        }));
        expect(app.printError).not.toHaveBeenCalled();
        expect(app.printAI.mock.calls[0][0]).toContain('Tool: `document-workflow`');
    });

    test('keeps concrete project files on the code-sandbox persistence path', async () => {
        const api = {
            invokeTool: jest.fn().mockResolvedValue({
                result: {
                    data: {
                        exitCode: 0,
                        files: [{ path: 'index.html', sizeBytes: 14 }],
                        stdout: 'Project workspace created',
                    },
                },
            }),
        };
        const { app } = createSandboxCommandHarness({ api });

        await app.invokeSandboxCommand([
            'project',
            JSON.stringify({
                language: 'html',
                projectName: 'Concrete',
                files: [{ path: 'index.html', content: '<h1>Hi</h1>' }],
            }),
        ]);

        expect(api.invokeTool).toHaveBeenCalledWith('code-sandbox', expect.objectContaining({
            mode: 'project',
            language: 'html',
            projectName: 'Concrete',
            files: [{ path: 'index.html', content: '<h1>Hi</h1>' }],
        }));
        expect(app.printError).not.toHaveBeenCalled();
        expect(app.printAI.mock.calls[0][0]).toContain('Tool: `code-sandbox`');
    });
});

describe('web-cli command drawer keyboard navigation', () => {
    test('matches menu semantics in the rendered toolbar markup', () => {
        const indexMarkup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(indexMarkup);
        const modelSelect = dom.window.document.getElementById('modelSelect');
        const commandInput = dom.window.document.getElementById('commandInput');
        const commandAssist = dom.window.document.getElementById('commandAssist');
        const cancelRequestButton = dom.window.document.getElementById('cancelRequestButton');
        const statusIndicator = dom.window.document.querySelector('.status-indicator');
        const statusDot = dom.window.document.getElementById('statusDot');
        const drawer = dom.window.document.getElementById('commandDrawer');
        const items = Array.from(drawer.querySelectorAll('button, a[href]'));

        expect(statusIndicator.getAttribute('role')).toBe('status');
        expect(statusIndicator.getAttribute('aria-live')).toBe('polite');
        expect(statusIndicator.getAttribute('aria-atomic')).toBe('true');
        expect(statusIndicator.textContent).toContain('Connection status:');
        expect(statusDot.getAttribute('aria-hidden')).toBe('true');
        expect(modelSelect.getAttribute('aria-label')).toBe('Current AI model');
        expect(modelSelect.classList.contains('header-model-select')).toBe(true);
        expect(indexMarkup).toMatch(/\.header-model-select option\s*{[^}]*color:\s*var\(--text-primary\);[^}]*background-color:\s*var\(--bg-secondary\);/s);
        expect(commandInput.getAttribute('aria-label')).toBe('Web CLI command input');
        expect(commandInput.getAttribute('aria-describedby')).toBe('commandAssist');
        expect(commandInput.getAttribute('role')).toBe('combobox');
        expect(commandInput.getAttribute('aria-autocomplete')).toBe('list');
        expect(commandInput.getAttribute('aria-controls')).toBe('autocomplete');
        expect(commandInput.getAttribute('aria-expanded')).toBe('false');
        expect(dom.window.document.getElementById('autocomplete').getAttribute('role')).toBe('listbox');
        expect(commandAssist.getAttribute('role')).toBe('status');
        expect(commandAssist.getAttribute('aria-live')).toBe('polite');
        expect(cancelRequestButton.hidden).toBe(true);
        expect(cancelRequestButton.getAttribute('aria-label')).toBe('Stop current AI request');
        expect(indexMarkup).toContain('js/api.js?v=20260715a');
        expect(indexMarkup).toContain('js/app.js?v=20260715a');
        expect(drawer.getAttribute('role')).toBe('menu');
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((item) => item.getAttribute('role') === 'menuitem')).toBe(true);
    });

    test('stops the active AI request and exposes pending cancellation state', () => {
        const app = createToolFormHarness();
        const dom = new JSDOM('<button id="cancelRequestButton" hidden>Stop</button>');
        app.cancelRequestButton = dom.window.document.getElementById('cancelRequestButton');
        app.currentRequestController = new AbortController();

        app.setRequestCancellationState(true);

        expect(app.cancelRequestButton.hidden).toBe(false);
        expect(app.cancelCurrentRequest()).toBe(true);
        expect(app.currentRequestController.signal.aborted).toBe(true);
        expect(app.cancelRequestButton.disabled).toBe(true);
        expect(app.cancelRequestButton.textContent).toBe('Stopping...');
        expect(app.cancelRequestButton.getAttribute('aria-label')).toBe('Stopping current AI request');
        expect(app.cancelCurrentRequest()).toBe(false);
    });

    function createDrawerHarness() {
        const app = createToolFormHarness();
        const dom = new JSDOM(`
            <button id="commandDrawerToggle" type="button"></button>
            <div id="commandDrawer">
                <button type="button" id="sessions">Sessions</button>
                <button type="button" id="clear">Clear</button>
                <button type="button" id="voice" disabled>Voice</button>
                <button type="button" id="agent" style="display: none;">Agent</button>
                <a id="home" href="/">Home</a>
            </div>
        `);
        global.window = dom.window;
        global.document = dom.window.document;
        app.commandDrawerToggle = document.getElementById('commandDrawerToggle');
        app.commandDrawer = document.getElementById('commandDrawer');
        app.commandDrawer.hidden = false;
        return app;
    }

    afterEach(() => {
        delete global.window;
        delete global.document;
    });

    test('moves focus through drawer actions with arrow, Home, and End keys', () => {
        const app = createDrawerHarness();
        const sessions = document.getElementById('sessions');
        const clear = document.getElementById('clear');
        const home = document.getElementById('home');

        expect(app.getCommandDrawerItems()).toEqual([sessions, clear, home]);

        sessions.focus();
        app.handleCommandDrawerKeydown({
            key: 'ArrowDown',
            target: sessions,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
        });
        expect(document.activeElement).toBe(clear);

        app.handleCommandDrawerKeydown({
            key: 'ArrowDown',
            target: clear,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
        });
        expect(document.activeElement).toBe(home);

        app.handleCommandDrawerKeydown({
            key: 'ArrowDown',
            target: home,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
        });
        expect(document.activeElement).toBe(sessions);

        app.handleCommandDrawerKeydown({
            key: 'End',
            target: sessions,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
        });
        expect(document.activeElement).toBe(home);

        app.handleCommandDrawerKeydown({
            key: 'Home',
            target: home,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
        });
        expect(document.activeElement).toBe(sessions);
    });

    test('updates the drawer trigger label for open and closed states', () => {
        const app = createDrawerHarness();
        app.commandDrawer.hidden = true;

        app.toggleCommandDrawer(true);

        expect(app.commandDrawerToggle.getAttribute('aria-expanded')).toBe('true');
        expect(app.commandDrawerToggle.getAttribute('aria-label')).toBe('Close command actions');
        expect(app.commandDrawerToggle.getAttribute('title')).toBe('Close command actions');

        app.toggleCommandDrawer(false);

        expect(app.commandDrawerToggle.getAttribute('aria-expanded')).toBe('false');
        expect(app.commandDrawerToggle.getAttribute('aria-label')).toBe('Open command actions');
        expect(app.commandDrawerToggle.getAttribute('title')).toBe('Open command actions');
    });

    test('opens the drawer from the trigger with arrow keys and focuses the expected action', () => {
        const app = createDrawerHarness();
        const preventDefault = jest.fn();
        const stopPropagation = jest.fn();
        app.commandDrawer.hidden = true;

        app.handleCommandDrawerToggleKeydown({
            key: 'ArrowDown',
            preventDefault,
            stopPropagation,
        });

        expect(app.commandDrawer.hidden).toBe(false);
        expect(app.commandDrawerToggle.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(document.getElementById('sessions'));
        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();

        app.commandDrawer.hidden = true;
        app.handleCommandDrawerToggleKeydown({
            key: 'ArrowUp',
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
        });

        expect(document.activeElement).toBe(document.getElementById('home'));
    });

    test('closes the drawer and restores trigger focus on Escape', () => {
        const app = createDrawerHarness();
        const preventDefault = jest.fn();
        const stopPropagation = jest.fn();

        app.handleCommandDrawerKeydown({
            key: 'Escape',
            target: document.getElementById('sessions'),
            preventDefault,
            stopPropagation,
        });

        expect(app.commandDrawer.hidden).toBe(true);
        expect(app.commandDrawerToggle.getAttribute('aria-expanded')).toBe('false');
        expect(app.commandDrawerToggle.getAttribute('aria-label')).toBe('Open command actions');
        expect(document.activeElement).toBe(app.commandDrawerToggle);
        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();
    });

    test('exposes autocomplete active suggestion state to the command input', () => {
        const app = createToolFormHarness();
        const dom = new JSDOM(`
            <input id="commandInput" aria-expanded="false">
            <div id="autocomplete" class="autocomplete hidden" role="listbox"></div>
        `);
        global.window = dom.window;
        global.document = dom.window.document;
        app.commandInput = document.getElementById('commandInput');
        app.autocompleteEl = document.getElementById('autocomplete');
        app.commandCatalog = [
            { command: '/tools', label: 'Tools', description: 'Inspect available actions' },
            { command: '/workflows', label: 'Workflows', description: 'Stage common task starters' },
        ];
        app.isCurrentHelpCommand = jest.fn(() => true);
        app.activateCommandEntry = jest.fn();

        app.commandInput.value = '/';
        app.updateAutocomplete();

        const items = Array.from(app.autocompleteEl.querySelectorAll('[role="option"]'));
        expect(app.autocompleteEl.classList.contains('hidden')).toBe(false);
        expect(app.commandInput.getAttribute('aria-expanded')).toBe('true');
        expect(app.commandInput.getAttribute('aria-activedescendant')).toBe('autocomplete-option-0');
        expect(items[0].getAttribute('aria-selected')).toBe('true');
        expect(items[1].getAttribute('aria-selected')).toBe('false');

        app.navigateAutocomplete(1);

        expect(app.commandInput.getAttribute('aria-activedescendant')).toBe('autocomplete-option-1');
        expect(items[0].getAttribute('aria-selected')).toBe('false');
        expect(items[1].getAttribute('aria-selected')).toBe('true');

        app.hideAutocomplete();

        expect(app.autocompleteEl.classList.contains('hidden')).toBe(true);
        expect(app.commandInput.getAttribute('aria-expanded')).toBe('false');
        expect(app.commandInput.hasAttribute('aria-activedescendant')).toBe(false);
    });

    test('keeps connection status text synchronized with health results', async () => {
        const api = {
            healthCheck: jest.fn()
                .mockResolvedValueOnce({ connected: true })
                .mockResolvedValueOnce({ connected: false })
                .mockRejectedValueOnce(new Error('offline')),
        };
        const { CodeCLIApp } = loadWebCliToolFormHelpers({ api });
        const app = Object.create(CodeCLIApp.prototype);
        const dom = new JSDOM(`
            <div class="status-indicator" role="status" aria-live="polite" aria-atomic="true">
                <span class="sr-only">Connection status: </span>
                <span id="statusDot" class="status-dot connecting" aria-hidden="true"></span>
                <span id="statusText">Connecting...</span>
            </div>
        `);
        app.statusDot = dom.window.document.getElementById('statusDot');
        app.statusText = dom.window.document.getElementById('statusText');
        app.roamVoxelPet = jest.fn();

        await app.checkConnection();

        expect(app.statusDot.className).toBe('status-dot online');
        expect(app.statusText.textContent).toBe('Connected');

        await app.checkConnection();

        expect(app.statusDot.className).toBe('status-dot offline');
        expect(app.statusText.textContent).toBe('Disconnected');
        expect(app.roamVoxelPet).toHaveBeenCalledWith('alert', 'guard', 1200);

        await app.checkConnection();

        expect(app.statusDot.className).toBe('status-dot offline');
        expect(app.statusText.textContent).toBe('Offline');
    });
});

describe('web-cli file manager dialog', () => {
    let dom;

    function createFileManagerHarness(sessionFiles = []) {
        dom = new JSDOM('<button id="filesButton">Files</button><main></main>', {
            url: 'http://localhost/web-cli/index.html',
        });
        const { CodeCLIApp } = loadWebCliToolFormHelpers({
            window: dom.window,
            document: dom.window.document,
        });
        const app = Object.create(CodeCLIApp.prototype);
        app.escapeHtml = (value) => String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        app.escapeHtmlAttr = (value) => String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        global.window = dom.window;
        global.document = dom.window.document;
        global.app = app;
        app.sessionFiles = sessionFiles;
        app.fileManagerReturnFocus = null;
        app.downloadFileById = jest.fn();
        app.downloadAllFiles = jest.fn();
        app.closeFileManager = function closeFileManager() {
            const modal = document.getElementById('file-manager-modal');
            if (modal) modal.remove();
        };
        app.getFileIcon = () => 'file';
        app.formatFileSize = (size) => `${size} B`;
        return app;
    }

    afterEach(() => {
        delete global.window;
        delete global.document;
        delete global.app;
        dom = null;
    });

    test('disables bulk download when the session has no files', () => {
        const app = createFileManagerHarness();

        app.renderFileManager();

        const bulkDownload = Array.from(document.querySelectorAll('.file-manager-footer .btn'))
            .find((button) => button.textContent.trim() === 'Download All');
        expect(document.getElementById('file-manager-title').textContent).toBe('Session Files (0)');
        expect(document.querySelector('.file-manager-empty').textContent).toContain('No files yet');
        expect(bulkDownload.disabled).toBe(true);
        expect(bulkDownload.getAttribute('aria-label')).toBe('No session files to download');
    });

    test('labels bulk download with the active file count', () => {
        const app = createFileManagerHarness([
            { id: 'file-1', filename: 'diagram.mmd', size: 512, type: 'text/mermaid' },
            { id: 'file-2', filename: 'brief.md', size: 256, type: 'text/markdown' },
        ]);

        app.renderFileManager();

        const bulkDownload = Array.from(document.querySelectorAll('.file-manager-footer .btn'))
            .find((button) => button.textContent.trim() === 'Download All');
        expect(document.getElementById('file-manager-title').textContent).toBe('Session Files (2)');
        expect(document.querySelectorAll('.file-item')).toHaveLength(2);
        expect(bulkDownload.disabled).toBe(false);
        expect(bulkDownload.getAttribute('aria-label')).toBe('Download all 2 session files');
    });
});

describe('web-cli agent quick tool state', () => {
    test('marks quick tools as a toolbar with an exposed active state', () => {
        const indexMarkup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const dom = new JSDOM(indexMarkup);
        const toolbelt = dom.window.document.getElementById('voxelToolbelt');
        const buttons = Array.from(toolbelt.querySelectorAll('.voxel-tool-chip'));
        const byTool = Object.fromEntries(buttons.map((button) => [button.dataset.tool, button]));

        expect(toolbelt.getAttribute('role')).toBe('toolbar');
        expect(toolbelt.getAttribute('aria-label')).toBe('Agent quick tools');
        expect(byTool.chat.classList.contains('active')).toBe(true);
        expect(byTool.chat.getAttribute('aria-pressed')).toBe('true');
        expect(byTool.chat.getAttribute('aria-label')).toBe('Ask Lilly with agent companion. Currently selected.');
        expect(byTool.chat.getAttribute('title')).toBe('Ask Lilly with agent companion. Currently selected.');
        expect(byTool.tools.getAttribute('aria-pressed')).toBe('false');
        expect(byTool.tools.getAttribute('aria-label')).toBe('List available agent tools. Press to select.');
        expect(byTool.files.getAttribute('aria-pressed')).toBe('false');
        expect(byTool.files.getAttribute('aria-label')).toBe('Open generated session files. Press to select.');
    });

    test('keeps quick tool pressed state synchronized with the visual active chip', () => {
        const app = createToolFormHarness();
        const dom = new JSDOM(`
            <div id="voxelToolbelt" role="toolbar" aria-label="Agent quick tools">
                <button type="button" class="voxel-tool-chip active" data-tool="chat" aria-pressed="true" aria-label="Ask Lilly with agent companion. Currently selected." title="Ask Lilly with agent companion. Currently selected.">Chat</button>
                <button type="button" class="voxel-tool-chip" data-tool="tools" aria-pressed="false" aria-label="List available agent tools. Press to select." title="List available agent tools. Press to select.">Tools</button>
                <button type="button" class="voxel-tool-chip" data-tool="files" aria-pressed="false" aria-label="Open generated session files. Press to select." title="Open generated session files. Press to select.">Files</button>
            </div>
        `);
        app.voxelToolbelt = dom.window.document.getElementById('voxelToolbelt');

        app.setActiveVoxelTool('files');

        const buttons = Array.from(app.voxelToolbelt.querySelectorAll('.voxel-tool-chip'));
        const byTool = Object.fromEntries(buttons.map((button) => [button.dataset.tool, button]));
        expect(byTool.chat.classList.contains('active')).toBe(false);
        expect(byTool.chat.getAttribute('aria-pressed')).toBe('false');
        expect(byTool.chat.getAttribute('aria-label')).toBe('Ask Lilly with agent companion. Press to select.');
        expect(byTool.chat.getAttribute('title')).toBe('Ask Lilly with agent companion. Press to select.');
        expect(byTool.tools.getAttribute('aria-pressed')).toBe('false');
        expect(byTool.files.classList.contains('active')).toBe(true);
        expect(byTool.files.getAttribute('aria-pressed')).toBe('true');
        expect(byTool.files.getAttribute('aria-label')).toBe('Open generated session files. Currently selected.');
        expect(byTool.files.getAttribute('title')).toBe('Open generated session files. Currently selected.');
    });
});

describe('web-cli theme control state', () => {
    test('keeps the visible theme label aligned with its accessible state', () => {
        const app = createToolFormHarness();
        const dom = new JSDOM('<button id="themeButton"><span>Theme</span></button>');
        app.theme = 'light';
        app.themeButton = dom.window.document.getElementById('themeButton');
        app.getThemeLabel = jest.fn(() => 'Light');

        app.updateThemeButton();

        expect(app.themeButton.querySelector('span').textContent).toBe('Light');
        expect(app.themeButton.getAttribute('title')).toBe('Theme: Light');
        expect(app.themeButton.getAttribute('aria-label')).toBe('Cycle theme. Current theme: Light');
    });
});

describe('web-cli startup command cards', () => {
    test('labels visible startup command cards by their activation result', () => {
        const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

        expect(source).toContain('aria-label="Focus the command input to ask Lilly"');
        expect(source).toContain('aria-label="Run /tools to inspect available actions"');
        expect(source).toContain('aria-label="Run /workflows to stage common task starters"');
        expect(source).toContain('aria-label="Run /files to review generated artifacts"');
        expect(source).toContain('aria-label="Run /remote status to check remote readiness"');
    });
});
