const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadAppClass(overrides = {}) {
    const sourcePath = path.join(__dirname, 'app.js');
    const source = fs.readFileSync(sourcePath, 'utf8').replace(
        /const app = new CodeCLIApp\(\);\s*window\.app = app;\s*$/,
        'module.exports = { CodeCLIApp };',
    );
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://cli.example.test/web-cli/',
    });
    const sandbox = {
        module: { exports: {} },
        exports: {},
        window: dom.window,
        document: dom.window.document,
        setTimeout,
        clearTimeout,
        ...overrides,
    };
    vm.runInNewContext(source, sandbox, { filename: sourcePath });
    return { CodeCLIApp: sandbox.module.exports.CodeCLIApp, dom, sandbox };
}

function createHarness({ api = {}, windowOverrides = {} } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://cli.example.test/web-cli/',
    });
    Object.assign(dom.window, windowOverrides);
    const { CodeCLIApp } = loadAppClass({
        api,
        window: dom.window,
        document: dom.window.document,
    });
    const app = Object.create(CodeCLIApp.prototype);
    app.sessionFiles = [];
    app.nextFileId = 1;
    app.selectedRemoteArtifactIds = new Set();
    app.printSystem = jest.fn();
    app.printError = jest.fn();
    app.printAI = jest.fn();
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
    app.getFileIcon = () => 'FILE';
    app.formatFileSize = (size) => `${size || 0} B`;
    app.closeFileManager = jest.fn(() => dom.window.document.getElementById('file-manager-modal')?.remove());
    return { app, api, dom };
}

describe('web-cli remote artifact workflow', () => {
    test('uses stable persisted artifact ids for agent selection, never local file ids', () => {
        const { app } = createHarness();
        app.sessionFiles = [
            { id: 1, artifactId: 'artifact-design-123456789', filename: 'design.svg' },
            { id: 2, artifactId: null, filename: 'local.txt' },
        ];

        expect(app.toggleRemoteArtifact('1')).toBe(true);
        expect(app.getSelectedRemoteArtifactIds()).toEqual(['artifact-design-123456789']);
        expect(app.toggleRemoteArtifact('2')).toBe(false);
        expect(app.getSelectedRemoteArtifactIds()).toEqual(['artifact-design-123456789']);
    });

    test('preserves and enriches the authoritative artifact descriptor during hydration', () => {
        const { app } = createHarness();
        const [file] = app.syncArtifactsToSessionFiles([{
            id: 'artifact-site-123456789',
            filename: 'site.html',
            format: 'html',
            mimeType: 'text/html',
            sizeBytes: 120,
            downloadUrl: '/api/artifacts/artifact-site-123456789/download',
        }]);

        const added = app.syncArtifactsToSessionFiles([{
            id: 'artifact-site-123456789',
            filename: 'site.html',
            format: 'html',
            mimeType: 'text/html',
            sizeBytes: 240,
            previewUrl: '/api/artifacts/artifact-site-123456789/preview',
            metadata: { siteBundle: { entry: 'index.html', fileCount: 3 } },
        }]);

        expect(added).toEqual([]);
        expect(file.size).toBe(240);
        expect(file.artifact.metadata.siteBundle).toEqual(expect.objectContaining({ fileCount: 3 }));
        expect(app.isManagedAppCandidate(file)).toBe(true);
    });

    test('forwards selected artifacts and the chosen model, then exposes returned files', async () => {
        const api = {
            currentModel: 'kimi-k3',
            invokeRemoteCliAgent: jest.fn().mockResolvedValue({
                result: {
                    completionStatus: 'complete',
                    finalOutput: 'Built and checked.',
                    artifactIds: ['artifact-result-123456789'],
                },
            }),
        };
        const { app, dom } = createHarness({ api });
        dom.window.KimiBuiltRemoteArtifactWorkflow = {
            collectRemoteAgentArtifacts: jest.fn(() => ({ artifacts: [] })),
        };
        app.sessionFiles = [{ id: 1, artifactId: 'artifact-input-123456789', filename: 'input.svg' }];
        app.selectedRemoteArtifactIds.add('artifact-input-123456789');
        app.setActiveVoxelTool = jest.fn();
        app.setStatus = jest.fn();
        app.recordVoxelToolUse = jest.fn();
        app.normalizeProgressState = (value) => value;
        app.renderLiveProgressCard = jest.fn();
        app.finalizeLiveProgressCard = jest.fn();
        app.loadRemoteToolCatalog = jest.fn().mockResolvedValue({
            runtime: { remoteRunner: { defaultWorkspace: '/opt/project' } },
            tools: [{ id: 'remote-cli-agent', runtime: { defaultCwd: '/opt/project' } }],
        });
        app.syncStoredSessionArtifacts = jest.fn().mockImplementation(async () => {
            const returned = {
                id: 2,
                artifactId: 'artifact-result-123456789',
                filename: 'result.svg',
            };
            app.sessionFiles.push(returned);
            return [returned];
        });

        await app.handleRemoteCommand(['agent', 'polish', 'the', 'design']);

        expect(api.invokeRemoteCliAgent).toHaveBeenCalledWith('polish the design', expect.objectContaining({
            artifactIds: ['artifact-input-123456789'],
            model: 'kimi-k3',
            collectResultFiles: true,
            cwd: '/opt/project',
        }));
        expect(app.printAI).toHaveBeenCalledWith(expect.stringContaining('artifact-result-123456789'));
        expect(app.finalizeLiveProgressCard).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
    });

    test('treats returned-file collection errors as a blocked run', async () => {
        const result = {
            completionStatus: 'complete',
            finalOutput: 'Build finished.',
            resultFilesError: 'Result files failed checksum validation.',
        };
        const { app } = createHarness();

        const report = app.formatRemoteAgentResult(result);
        expect(report).toContain('Status: `blocked`');
        expect(report).not.toContain('Status: `complete`');
        expect(report).toContain('Blocker: Result files failed checksum validation.');
    });

    test('attributes only post-run artifact deltas when the agent returns no ids', async () => {
        const api = {
            currentModel: 'codex',
            invokeRemoteCliAgent: jest.fn().mockResolvedValue({
                result: {
                    completionStatus: 'complete',
                    finalOutput: 'Finished without an explicit artifact envelope.',
                },
            }),
        };
        const { app, dom } = createHarness({ api });
        dom.window.KimiBuiltRemoteArtifactWorkflow = {
            collectRemoteAgentArtifacts: jest.fn(() => ({ artifacts: [] })),
        };
        const oldFile = { id: 1, artifactId: 'artifact-old-123456789', filename: 'old.svg' };
        const newFile = { id: 2, artifactId: 'artifact-new-123456789', filename: 'new.svg' };
        let syncCount = 0;
        app.syncStoredSessionArtifacts = jest.fn(async () => {
            syncCount += 1;
            const added = syncCount === 1 ? oldFile : newFile;
            app.sessionFiles.push(added);
            return [added];
        });
        app.setActiveVoxelTool = jest.fn();
        app.setStatus = jest.fn();
        app.recordVoxelToolUse = jest.fn();
        app.normalizeProgressState = (value) => value;
        app.renderLiveProgressCard = jest.fn();
        app.finalizeLiveProgressCard = jest.fn();
        app.loadRemoteToolCatalog = jest.fn().mockResolvedValue({
            runtime: { remoteRunner: { defaultWorkspace: '/opt/project' } },
            tools: [{ id: 'remote-cli-agent', runtime: { defaultCwd: '/opt/project' } }],
        });

        await app.handleRemoteCommand(['agent', 'build', 'a', 'file']);

        const report = app.printAI.mock.calls.at(-1)[0];
        expect(report).toContain('### New Session Files Observed');
        expect(report).toContain('agent did not return IDs');
        expect(report).toContain('new.svg');
        expect(report).not.toContain('old.svg');
    });

    test('does not claim returned-file provenance when the pre-run baseline fails', async () => {
        const api = {
            currentModel: 'codex',
            invokeRemoteCliAgent: jest.fn().mockResolvedValue({
                result: {
                    completionStatus: 'complete',
                    finalOutput: 'Finished without an explicit artifact envelope.',
                },
            }),
        };
        const { app, dom } = createHarness({ api });
        dom.window.KimiBuiltRemoteArtifactWorkflow = {
            collectRemoteAgentArtifacts: jest.fn(() => ({ artifacts: [] })),
        };
        const observedFile = { id: 9, artifactId: 'artifact-unattributed-123456789', filename: 'unattributed.svg' };
        let syncCount = 0;
        app.syncStoredSessionArtifacts = jest.fn(async () => {
            syncCount += 1;
            if (syncCount === 1) throw new Error('transient baseline failure');
            app.sessionFiles.push(observedFile);
            return [observedFile];
        });
        app.setActiveVoxelTool = jest.fn();
        app.setStatus = jest.fn();
        app.recordVoxelToolUse = jest.fn();
        app.normalizeProgressState = (value) => value;
        app.renderLiveProgressCard = jest.fn();
        app.finalizeLiveProgressCard = jest.fn();
        app.loadRemoteToolCatalog = jest.fn().mockResolvedValue({
            runtime: { remoteRunner: { defaultWorkspace: '/opt/project' } },
            tools: [{ id: 'remote-cli-agent', runtime: { defaultCwd: '/opt/project' } }],
        });

        await app.handleRemoteCommand(['agent', 'build', 'a', 'file']);

        const report = app.printAI.mock.calls.at(-1)[0];
        expect(report).not.toContain('### Returned Files');
        expect(report).not.toContain('unattributed.svg');
    });

    test('preflights before prompting and deploys with the exact accepted SHA', async () => {
        const sourceSha256 = 'a'.repeat(64);
        const order = [];
        const api = {
            preflightManagedAppArtifact: jest.fn(async () => {
                order.push('preflight');
                return { pushToWebEligible: true, sha256: sourceSha256, blockers: [] };
            }),
            deployManagedAppArtifact: jest.fn(async (_id, payload) => {
                order.push('deploy');
                return { publicHost: payload.publicHost };
            }),
        };
        const { app } = createHarness({ api });
        app.sessionFiles = [{
            id: 7,
            artifactId: 'artifact-site-123456789',
            filename: 'site.html',
            mimeType: 'text/html',
            artifact: { id: 'artifact-site-123456789', format: 'html', metadata: {} },
        }];
        app.promptForManagedAppHost = jest.fn(() => {
            order.push('prompt');
            return { dnsName: 'design', publicHost: 'design.demoserver2.buzz', slug: 'design' };
        });

        await app.pushArtifactToWeb('7');

        expect(order).toEqual(['preflight', 'prompt', 'deploy']);
        expect(api.deployManagedAppArtifact).toHaveBeenCalledWith(
            'artifact-site-123456789',
            expect.objectContaining({ expectedSourceSha256: sourceSha256 }),
        );
    });

    test.each([
        ['blocked preflight', { pushToWebEligible: false, blockers: [{ message: 'Missing index.html.' }] }],
        ['invalid preflight hash', { pushToWebEligible: true, blockers: [], sha256: 'bad-hash' }],
    ])('never mutates after %s', async (_label, preflight) => {
        const api = {
            preflightManagedAppArtifact: jest.fn().mockResolvedValue(preflight),
            deployManagedAppArtifact: jest.fn(),
        };
        const { app } = createHarness({ api });
        app.sessionFiles = [{
            id: 7,
            artifactId: 'artifact-site-123456789',
            filename: 'site.html',
            mimeType: 'text/html',
            artifact: { format: 'html', metadata: {} },
        }];
        app.promptForManagedAppHost = jest.fn();

        await app.pushArtifactToWeb('7');

        expect(app.promptForManagedAppHost).not.toHaveBeenCalled();
        expect(api.deployManagedAppArtifact).not.toHaveBeenCalled();
        expect(app.printError).toHaveBeenCalled();
    });

    test('renders separate accessible select, download, and Push-to-Web controls', () => {
        const { app, dom } = createHarness();
        app.sessionFiles = [{
            id: 3,
            artifactId: 'artifact-site-123456789',
            filename: 'site.html',
            size: 300,
            type: 'artifact',
            mimeType: 'text/html',
            artifact: { format: 'html', metadata: {} },
        }];
        app.selectedRemoteArtifactIds.add('artifact-site-123456789');

        app.renderFileManager();

        const row = dom.window.document.querySelector('.file-item');
        expect(row.tagName).toBe('ARTICLE');
        expect(row.classList.contains('is-selected')).toBe(true);
        expect(row.querySelector('.file-use-btn').getAttribute('aria-pressed')).toBe('true');
        expect(row.querySelector('.file-download-btn').tagName).toBe('BUTTON');
        expect(row.querySelector('.file-push-btn').textContent).toBe('Push to Web');
        expect(dom.window.document.querySelector('.file-manager-footer .btn-primary').disabled).toBe(false);
    });

    test('preserves selection focus and traps Tab within the file manager', () => {
        const { app, dom } = createHarness();
        app.webPushInFlightArtifactIds = new Set();
        app.sessionFiles = [{
            id: 3,
            artifactId: 'artifact-site-123456789',
            filename: 'site.html',
            size: 300,
            type: 'artifact',
            mimeType: 'text/html',
            artifact: { format: 'html', metadata: {} },
        }];
        app.renderFileManager();
        const useButton = dom.window.document.querySelector('.file-use-btn');
        useButton.focus();

        app.toggleRemoteArtifact('3');

        const focusedToggle = dom.window.document.activeElement;
        expect(focusedToggle.classList.contains('file-use-btn')).toBe(true);
        expect(focusedToggle.dataset.fileId).toBe('3');
        expect(focusedToggle.getAttribute('aria-pressed')).toBe('true');

        const modal = dom.window.document.getElementById('file-manager-modal');
        const focusable = Array.from(modal.querySelectorAll('button:not([disabled])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        last.focus();
        last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(dom.window.document.activeElement).toBe(first);
        first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(dom.window.document.activeElement).toBe(last);
    });

    test('guards duplicate Push-to-Web requests and exposes the busy button state', async () => {
        const sourceSha256 = 'a'.repeat(64);
        let resolvePreflight;
        const preflightPending = new Promise((resolve) => {
            resolvePreflight = resolve;
        });
        const api = {
            preflightManagedAppArtifact: jest.fn(() => preflightPending),
            deployManagedAppArtifact: jest.fn().mockResolvedValue({ publicHost: 'design.demoserver2.buzz' }),
        };
        const { app, dom } = createHarness({ api });
        app.webPushInFlightArtifactIds = new Set();
        app.sessionFiles = [{
            id: 7,
            artifactId: 'artifact-site-123456789',
            filename: 'site.html',
            size: 300,
            type: 'artifact',
            mimeType: 'text/html',
            artifact: { format: 'html', metadata: {} },
        }];
        app.promptForManagedAppHost = jest.fn(() => ({
            dnsName: 'design',
            publicHost: 'design.demoserver2.buzz',
            slug: 'design',
        }));
        app.renderFileManager();

        const firstPush = app.pushArtifactToWeb('7');
        const duplicatePush = app.pushArtifactToWeb('7');
        expect(dom.window.document.querySelector('.file-push-btn').getAttribute('aria-busy')).toBe('true');
        expect(dom.window.document.querySelector('.file-push-btn').disabled).toBe(true);
        expect(api.preflightManagedAppArtifact).toHaveBeenCalledTimes(1);

        resolvePreflight({ pushToWebEligible: true, sha256: sourceSha256, blockers: [] });
        await Promise.all([firstPush, duplicatePush]);

        expect(api.deployManagedAppArtifact).toHaveBeenCalledTimes(1);
        expect(app.printSystem).toHaveBeenCalledWith(expect.stringContaining('already running'));
    });
});
