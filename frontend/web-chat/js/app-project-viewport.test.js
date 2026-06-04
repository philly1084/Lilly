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
            setTimeout,
            clearTimeout,
        },
        document: {
            getElementById: () => null,
            addEventListener: () => {},
        },
        setTimeout,
        clearTimeout,
        uiHelpers: {
            isMinimalistMode: () => false,
            normalizeSurveyDefinition: (value) => {
                if (!value || typeof value !== 'object') {
                    return null;
                }
                const question = String(value.question || '').trim();
                const options = Array.isArray(value.options) ? value.options : [];
                if (!question || options.length < 2) {
                    return null;
                }
                return {
                    id: String(value.id || 'checkpoint-test').trim(),
                    question,
                    options,
                    steps: [{
                        id: 'step-1',
                        question,
                        inputType: value.inputType || 'choice',
                        options,
                    }],
                    inputType: value.inputType || 'choice',
                };
            },
            extractSurveyDefinitionFromContent: () => null,
            reinitializeIcons: () => {},
            renderSessionsList: () => {},
        },
        sessionManager: {
            currentSessionId: 'session-1',
            sessions: [],
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
    test('persists research helper cards as transcript-excluded session UI state', () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        app.upsertSessionMessage = jest.fn((_sessionId, message) => message);
        app.persistSessionMessageIfNeeded = jest.fn();
        app.isVisibleSession = () => false;

        app.appendToolSelectionMessages('assistant-1', [
            {
                toolCall: {
                    function: {
                        name: 'web-search',
                        arguments: JSON.stringify({ query: 'agent research' }),
                    },
                },
                result: {
                    success: true,
                    data: {
                        query: 'agent research',
                        results: [{
                            title: 'Agent article',
                            url: 'https://example.com/agent',
                            snippet: 'Useful article summary.',
                            source: 'Example',
                        }],
                    },
                },
            },
            {
                toolCall: {
                    function: {
                        name: 'web-fetch',
                        arguments: JSON.stringify({ url: 'https://example.com/agent' }),
                    },
                },
                result: {
                    success: true,
                    data: {
                        url: 'https://example.com/agent',
                        title: 'Agent article',
                        body: '<article>Verified article excerpt with enough detail.</article>',
                    },
                },
            },
        ], { sessionId: 'session-1' });

        expect(app.upsertSessionMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            id: 'assistant-1-research-sources',
            type: 'research-sources',
            clientOnly: true,
            excludeFromTranscript: true,
            syncExcludedToBackend: true,
        }));
        expect(app.persistSessionMessageIfNeeded).toHaveBeenCalledWith('session-1', expect.objectContaining({
            id: 'assistant-1-research-sources',
            type: 'research-sources',
            syncExcludedToBackend: true,
        }));
    });

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

    test('promotes managed app viewport from stale preview fields to the live public host', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.buildProjectViewportUrl({
            type: 'managed-app',
            phase: 'live',
            url: '/api/artifacts/minascraft-hook/preview',
            previewUrl: '/api/sandbox-workspaces/minascraft-hook/preview',
            sandboxUrl: '/api/artifacts/minascraft-hook/sandbox',
            artifactPreviewUrl: '/api/artifacts/minascraft-hook',
            publicHost: 'minascraft.demoserver2.buzz',
        })).toBe('https://minascraft.demoserver2.buzz');
    });

    test('withholds managed app slug and sandbox URLs until the public endpoint is verified', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.buildProjectViewportUrl({
            type: 'managed-app',
            phase: 'created',
            publicHost: 'generated-slug.demoserver2.buzz',
            publicUrl: 'https://generated-slug.demoserver2.buzz',
            previewUrl: '/api/sandbox-workspaces/generated-slug/preview',
            sandboxUrl: '/api/artifacts/generated-slug/sandbox',
        })).toBe('');

        expect(app.buildProjectViewportUrl({
            type: 'managed-app',
            phase: 'deploying',
            publicHost: 'requested-site.demoserver2.buzz',
            publicUrl: 'https://requested-site.demoserver2.buzz',
            progress: {
                evidence: {
                    requiredProof: {
                        publicVerificationObserved: false,
                    },
                },
            },
        })).toBe('');
    });

    test('uses the deployed managed app URL once public verification is observed', () => {
        const app = Object.create(loadChatAppPrototype());

        expect(app.buildProjectViewportUrl({
            type: 'managed-app',
            phase: 'live',
            publicHost: 'requested-site.demoserver2.buzz',
            publicUrl: 'https://requested-site.demoserver2.buzz',
        })).toBe('https://requested-site.demoserver2.buzz');

        expect(app.buildProjectViewportUrl({
            type: 'managed-app',
            phase: 'deploying',
            targetPublicHost: 'generated-slug.demoserver2.buzz',
            livePublicUrl: 'https://requested-site.demoserver2.buzz',
            progress: {
                evidence: {
                    requiredProof: {
                        publicVerificationObserved: true,
                    },
                },
            },
        })).toBe('https://requested-site.demoserver2.buzz');
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

    test('keeps managed app viewport empty while GitLab and k3s deployment are pending', () => {
        const context = loadChatAppContext();
        const app = Object.create(context.ChatApp.prototype);
        const projectViewport = createFakeElement('project-viewport');
        const appShell = createFakeElement('app');
        const frame = createFakeElement('project-viewport-frame');
        const label = createFakeElement('project-viewport-label');
        const link = createFakeElement('project-viewport-link');
        const stateLabel = createFakeElement('project-viewport-state-label');
        const stateDetail = createFakeElement('project-viewport-state-detail');
        projectViewport.querySelectorAll = () => [];

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
        app.projectViewportStateLabel = stateLabel;
        app.projectViewportStateDetail = stateDetail;
        app.getCurrentProjectViewportState = () => ({
            project: {
                type: 'managed-app',
                title: 'Generated site',
                publicHost: 'generated-slug.demoserver2.buzz',
                publicUrl: 'https://generated-slug.demoserver2.buzz',
                phase: 'created',
            },
            url: '',
            size: 'wide',
        });

        app.renderProjectViewport();

        expect(projectViewport.classList.contains('hidden')).toBe(false);
        expect(projectViewport.classList.contains('is-empty')).toBe(true);
        expect(frame.dataset.projectUrl).toBe('');
        expect(frame.src).toBeUndefined();
        expect(label.textContent).toBe('Generated site');
        expect(link.textContent).toBe('Waiting for deployed site');
        expect(link.href).toBe('#');
        expect(link.getAttribute('aria-disabled')).toBe('true');
        expect(stateLabel.textContent).toBe('Waiting for deployment');
        expect(stateDetail.textContent).toContain('website preview appears after public verification');
    });

    test('coalesces managed app hook progress into one buffered project status card', () => {
        jest.useFakeTimers();
        try {
            const context = loadChatAppContext();
            const { app, messages, renderedElements } = createManagedAppProgressHarness(context);

            app.applyManagedAppProgressEvent('session-1', buildManagedAppEvent({
                phase: 'updated',
                summary: 'Demo Site was updated in GitLab. Build and deploy are queued.',
            }));

            expect(messages.filter((message) => message.id === 'managed-project:app-1')).toHaveLength(1);
            expect(messages.some((message) => message.id === 'managed-app:app-1')).toBe(false);
            expect(context.uiHelpers.renderMessage).toHaveBeenCalledTimes(1);
            expect(renderedElements.has('managed-project:app-1')).toBe(true);

            app.applyManagedAppProgressEvent('session-1', buildManagedAppEvent({
                phase: 'built',
                summary: 'Demo Site finished building in GitLab.',
            }));

            expect(messages.filter((message) => message.id === 'managed-project:app-1')).toHaveLength(1);
            expect(context.uiHelpers.renderMessage).toHaveBeenCalledTimes(1);
            expect(context.uiHelpers.updateMessageContent).not.toHaveBeenCalled();

            jest.runOnlyPendingTimers();

            expect(context.uiHelpers.renderMessage).toHaveBeenCalledTimes(1);
            expect(context.uiHelpers.updateMessageContent).toHaveBeenCalledWith(
                'managed-project:app-1',
                expect.objectContaining({
                    id: 'managed-project:app-1',
                    metadata: expect.objectContaining({
                        managedAppProjectSummary: true,
                        managedAppPhase: 'built',
                    }),
                }),
                false,
            );
        } finally {
            jest.useRealTimers();
        }
    });

    test('handles managed app hook progress without refreshing the whole transcript', async () => {
        jest.useFakeTimers();
        try {
            const context = loadChatAppContext();
            const { app, messages } = createManagedAppProgressHarness(context);
            messages.push({
                id: 'user-1',
                role: 'user',
                content: 'Deploy the demo site.',
                timestamp: '2026-06-03T10:00:00.000Z',
            });
            app.refreshSessionSummaries = jest.fn(async () => {});
            app.loadSessionMessages = jest.fn(async () => []);

            await app.handleManagedAppEvent(buildManagedAppEvent({
                phase: 'updated',
                summary: 'Demo Site was updated in GitLab. Build and deploy are queued.',
            }));

            expect(app.refreshSessionSummaries).toHaveBeenCalled();
            expect(app.loadSessionMessages).not.toHaveBeenCalled();
            expect(messages.filter((message) => message.id === 'managed-project:app-1')).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
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

function buildManagedAppEvent(overrides = {}) {
    const phase = overrides.phase || 'updated';
    return {
        type: 'managed-app',
        sessionId: 'session-1',
        phase,
        summary: overrides.summary || 'Demo Site status changed.',
        timestamp: overrides.timestamp || '2026-06-03T10:00:00.000Z',
        app: {
            id: 'app-1',
            slug: 'demo-site',
            appName: 'Demo Site',
            sessionId: 'session-1',
            publicHost: 'demo-site.demoserver2.buzz',
        },
        progressState: {
            phase,
            phaseLabel: phase === 'built' ? 'Build complete' : 'Build queued',
            summary: overrides.summary || 'Demo Site status changed.',
            detail: 'Waiting for the managed-app deployment loop.',
            live: true,
            terminal: false,
            totalSteps: 4,
            completedSteps: phase === 'built' ? 2 : 1,
            steps: [
                { id: 'prepare', title: 'Prepare app record', status: 'completed' },
                { id: 'build', title: 'Build and publish image', status: phase === 'built' ? 'completed' : 'in_progress' },
                { id: 'deploy', title: 'Roll out deployment', status: 'pending' },
                { id: 'verify', title: 'Verify public endpoint', status: 'pending' },
            ],
        },
    };
}

function createManagedAppProgressHarness(context) {
    const messages = [];
    const renderedElements = new Map();
    const session = {
        id: 'session-1',
        metadata: {},
    };

    const upsertMessage = jest.fn((_sessionId, message) => {
        const index = messages.findIndex((entry) => entry.id === message.id);
        if (index === -1) {
            messages.push({
                ...message,
                timestamp: message.timestamp || '2026-06-03T10:00:00.000Z',
            });
            return messages[messages.length - 1];
        }

        messages[index] = {
            ...messages[index],
            ...message,
            metadata: {
                ...(messages[index].metadata || {}),
                ...(message.metadata || {}),
            },
        };
        return messages[index];
    });

    context.sessionManager = {
        currentSessionId: 'session-1',
        sessions: [session],
        getMessages: jest.fn(() => messages),
        getMessage: jest.fn((_sessionId, messageId) => messages.find((message) => message.id === messageId) || null),
        upsertMessage,
        saveToStorage: jest.fn(),
        mergeSessionMetadataLocally: jest.fn((_sessionId, metadataPatch) => {
            session.metadata = {
                ...(session.metadata || {}),
                ...metadataPatch,
                activeProject: metadataPatch.activeProject
                    ? {
                        ...(session.metadata?.activeProject || {}),
                        ...metadataPatch.activeProject,
                    }
                    : session.metadata?.activeProject,
            };
            return session;
        }),
        isLocalSession: jest.fn(() => false),
        syncMessageToBackend: jest.fn(async () => true),
    };

    const normalizeSurveyDefinition = context.uiHelpers.normalizeSurveyDefinition;
    context.uiHelpers = {
        ...context.uiHelpers,
        normalizeSurveyDefinition,
        renderMessage: jest.fn((message) => {
            const element = createFakeElement(message.id);
            element.dataset.messageId = message.id;
            element.remove = jest.fn(() => {
                renderedElements.delete(message.id);
            });
            element.replaceWith = jest.fn((nextElement) => {
                renderedElements.delete(message.id);
                renderedElements.set(nextElement.id, nextElement);
            });
            return element;
        }),
        updateMessageContent: jest.fn(),
        reinitializeIcons: jest.fn(),
        markMessageSettled: jest.fn(),
        showToast: jest.fn(),
    };
    context.document = {
        getElementById: (id) => renderedElements.get(id) || null,
        addEventListener: () => {},
    };

    const app = Object.create(context.ChatApp.prototype);
    app.managedAppProgressByKey = new Map();
    app.managedAppHostMessageByKey = new Map();
    app.pendingManagedAppProgressRenders = new Map();
    app.currentStreamingMessageId = '';
    app.projectViewport = null;
    app.messagesContainer = {
        appendChild: jest.fn((element) => {
            renderedElements.set(element.id, element);
        }),
    };
    app.updateAudioControls = jest.fn();
    app.isVisibleSession = (sessionId) => sessionId === 'session-1';

    return {
        app,
        messages,
        renderedElements,
    };
}
