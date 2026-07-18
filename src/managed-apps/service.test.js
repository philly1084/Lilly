'use strict';

jest.mock('../realtime-hub', () => ({
    broadcastToAdmins: jest.fn(),
    broadcastToSession: jest.fn(),
}));

jest.mock('../session-store', () => ({
    sessionStore: {
        upsertMessage: jest.fn(async () => null),
    },
}));

const settingsController = require('../routes/admin/settings.controller');
const { ManagedAppService } = require('./service');

const TEST_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const EXPECTED_BUILD_IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;

describe('ManagedAppService', () => {
    test('buildBuildEventsUrl strips a trailing /v1 from the configured API base URL', () => {
        const service = new ManagedAppService();
        const previousBaseUrl = settingsController.settings.api.baseURL;

        settingsController.settings.api.baseURL = 'https://kimibuilt.example.test/v1';
        service.getEffectiveManagedAppsConfig = () => ({
            webhookEndpointPath: '/api/integrations/gitlab/build-events',
        });

        try {
            expect(service.buildBuildEventsUrl()).toBe('https://kimibuilt.example.test/api/integrations/gitlab/build-events');
        } finally {
            settingsController.settings.api.baseURL = previousBaseUrl;
        }
    });

    test('buildBuildEventsUrl strips trailing /api and /v1 segments before appending the webhook path', () => {
        const service = new ManagedAppService();
        const previousBaseUrl = settingsController.settings.api.baseURL;

        settingsController.settings.api.baseURL = 'https://kimibuilt.example.test/control-plane/api/v1';
        service.getEffectiveManagedAppsConfig = () => ({
            webhookEndpointPath: '/api/integrations/gitlab/build-events',
        });

        try {
            expect(service.buildBuildEventsUrl()).toBe('https://kimibuilt.example.test/control-plane/api/integrations/gitlab/build-events');
        } finally {
            settingsController.settings.api.baseURL = previousBaseUrl;
        }
    });

    test('progress does not reinterpret legacy runtime digest metadata as build provenance', () => {
        const service = new ManagedAppService();
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            appName: 'Demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'deploy_failed',
            metadata: {
                imageDigest: TEST_IMAGE_DIGEST,
                liveDeploy: {
                    imageDigest: TEST_IMAGE_DIGEST,
                    observedImageDigest: TEST_IMAGE_DIGEST,
                    observedImageID: `containerd://${TEST_IMAGE_DIGEST}`,
                },
            },
        };

        const progress = service.buildAppProjectView(app, {
            id: 'run-1',
            buildStatus: 'success',
            imageTag: 'sha-abcdef123456',
            imageDigest: '',
        }).progress;

        expect(progress.evidence).toEqual(expect.objectContaining({
            imageDigest: '',
            observedImageDigest: TEST_IMAGE_DIGEST,
        }));
        expect(progress.evidence.requiredProof.imageAvailable).toBe(false);
    });

    test('remote-build blueprints default managed app deployment target to ssh', () => {
        const service = new ManagedAppService();

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const blueprint = service.buildAppBlueprint({
            prompt: 'Create and deploy a managed app called hello-stack.',
        }, 'user-1', 'session-1', {
            executionProfile: 'remote-build',
        });

        expect(blueprint.metadata.deploymentTarget).toBe('ssh');
    });

    test('iterateApp records stage and GitLab evidence metadata for edit runs', async () => {
        const appRecord = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'arcade-demo',
            appName: 'Arcade Demo',
            repoOwner: 'agent-apps',
            repoName: 'arcade-demo',
            repoUrl: 'https://gitlab.demoserver2.buzz/agent-apps/arcade-demo.git',
            repoCloneUrl: 'https://gitlab.demoserver2.buzz/agent-apps/arcade-demo.git',
            defaultBranch: 'main',
            imageRepo: 'registry.gitlab.demoserver2.buzz/agent-apps/arcade-demo',
            namespace: 'app-arcade-demo',
            publicHost: 'arcade-demo.demoserver2.buzz',
            sourcePrompt: 'Build an arcade demo.',
            status: 'building',
            metadata: {},
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            commitSha: 'abcdef1234567890',
            imageTag: 'sha-abcdef123456',
            buildStatus: 'queued',
            deployRequested: true,
            deployStatus: 'pending',
            verificationStatus: 'pending',
            externalRunUrl: 'https://gitlab.demoserver2.buzz/agent-apps/arcade-demo/-/pipelines/12',
            metadata: {},
        };
        let persistedBuildRun = null;
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppById: jest.fn(async () => appRecord),
            getAppBySlug: jest.fn(async () => null),
            updateBuildRun: jest.fn(async (_id, updates) => {
                persistedBuildRun = {
                    ...buildRun,
                    ...updates,
                };
                return persistedBuildRun;
            }),
        };
        const service = new ManagedAppService({ store });
        service.updateApp = jest.fn(async () => ({
            app: appRecord,
            buildRun,
            committedPaths: ['public/index.html', 'public/styles.css'],
            message: 'Queued a GitLab-backed edit iteration.',
        }));

        const result = await service.iterateApp('app-1', {
            action: 'edit',
            prompt: 'Make the arcade controls clearer.',
            deployRequested: true,
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(service.updateApp).toHaveBeenCalledWith('app-1', expect.objectContaining({
            requestedAction: 'deploy',
            sourcePrompt: 'Make the arcade controls clearer.',
        }), 'user-1', expect.objectContaining({
            sessionId: 'session-1',
        }));
        expect(store.updateBuildRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
            metadata: expect.objectContaining({
                iteration: expect.objectContaining({
                    action: 'edit',
                    sourceOfTruth: 'gitlab',
                    executor: 'managed-app-backend',
                    committedPaths: ['public/index.html', 'public/styles.css'],
                    commitSha: 'abcdef1234567890',
                    pipelineUrl: 'https://gitlab.demoserver2.buzz/agent-apps/arcade-demo/-/pipelines/12',
                    stages: expect.arrayContaining([
                        expect.objectContaining({ id: 'understand', status: 'completed' }),
                        expect.objectContaining({ id: 'commit', status: 'completed' }),
                        expect.objectContaining({ id: 'pipeline', status: 'in_progress' }),
                    ]),
                }),
            }),
        }));
        expect(result.iteration.evidence.requiredProof).toEqual(expect.objectContaining({
            sourceChanged: true,
            gitlabPipelineObserved: true,
            imageAvailable: false,
            deploymentObserved: true,
        }));
        expect(result.progress.steps).toEqual(persistedBuildRun.metadata.iteration.stages);
    });

    test('iterateApp can orchestrate remote-cli-agent as a managed backend CLI worker', async () => {
        const appRecord = {
            id: 'app-remote',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'remote-demo',
            appName: 'Remote Demo',
            repoOwner: 'agent-apps',
            repoName: 'remote-demo',
            repoUrl: 'https://gitlab.demoserver2.buzz/agent-apps/remote-demo.git',
            repoCloneUrl: 'https://gitlab.demoserver2.buzz/agent-apps/remote-demo.git',
            defaultBranch: 'main',
            imageRepo: 'registry.gitlab.demoserver2.buzz/agent-apps/remote-demo',
            namespace: 'app-remote-demo',
            publicHost: 'remote-demo.demoserver2.buzz',
            sourcePrompt: 'Build a remote demo.',
            status: 'building',
            metadata: {},
        };
        const remoteCliAgentRunner = {
            getPublicConfig: jest.fn(() => ({
                configured: true,
                defaultTargetId: 'prod',
                defaultCwd: '/srv/agent-apps/remote-demo',
            })),
            run: jest.fn(async () => ({
                finalOutput: [
                    'Implemented the requested managed app edit.',
                    'GIT_REPO=https://gitlab.demoserver2.buzz/agent-apps/remote-demo.git',
                    'GIT_COMMIT=1234567890abcdef',
                    'CHANGED_FILES=public/index.html,public/styles.css',
                    'DEPLOYMENT=app-remote-demo/remote-demo',
                    'PUBLIC_HOST=remote-demo.demoserver2.buzz',
                    'UI_CHECK_REPORT=ui-checks/remote-demo/report.json',
                    'UI_SCREENSHOTS=ui-checks/remote-demo/desktop.png,ui-checks/remote-demo/mobile.png',
                ].join('\n'),
                mcpSessionId: 'mcp-1',
                sessionId: 'remote-session-1',
                remoteCodeSessionId: 'remote-session-1',
                targetId: 'prod',
                cwd: '/srv/agent-apps/remote-demo',
                gitRepo: 'https://gitlab.demoserver2.buzz/agent-apps/remote-demo.git',
                gitCommit: '1234567890abcdef',
                deployment: 'app-remote-demo/remote-demo',
                publicHost: 'remote-demo.demoserver2.buzz',
                uiCheckReport: 'ui-checks/remote-demo/report.json',
                uiScreenshots: ['ui-checks/remote-demo/desktop.png', 'ui-checks/remote-demo/mobile.png'],
            })),
        };
        let updatedBuildRun = null;
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppById: jest.fn(async () => appRecord),
            getAppBySlug: jest.fn(async () => null),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...appRecord,
                ...updates,
            })),
            createBuildRun: jest.fn(async (input) => ({
                id: 'run-remote',
                appId: input.appId,
                ownerId: input.ownerId,
                sessionId: input.sessionId,
                source: input.source,
                requestedAction: input.requestedAction,
                commitSha: input.commitSha,
                imageTag: input.imageTag,
                buildStatus: input.buildStatus,
                deployRequested: input.deployRequested,
                deployStatus: input.deployStatus,
                verificationStatus: input.verificationStatus,
                externalRunUrl: input.externalRunUrl,
                metadata: input.metadata,
            })),
            updateBuildRun: jest.fn(async (_id, updates) => {
                updatedBuildRun = {
                    id: 'run-remote',
                    appId: 'app-remote',
                    ownerId: 'user-1',
                    sessionId: 'session-1',
                    source: 'remote-cli-agent',
                    requestedAction: 'deploy',
                    commitSha: '1234567890abcdef',
                    imageTag: 'sha-1234567890ab',
                    buildStatus: 'queued',
                    deployRequested: true,
                    deployStatus: 'pending',
                    verificationStatus: 'pending',
                    externalRunUrl: '',
                    metadata: updates.metadata,
                };
                return updatedBuildRun;
            }),
        };
        const service = new ManagedAppService({ store, remoteCliAgentRunner });

        const result = await service.iterateApp('app-remote', {
            action: 'edit',
            prompt: 'Use the backend CLI to make the status screen clearer.',
            deployRequested: true,
            executor: 'remote-cli-agent',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(remoteCliAgentRunner.run).toHaveBeenCalledWith(expect.objectContaining({
            adminMode: true,
            targetId: 'prod',
            cwd: '/srv/agent-apps/remote-demo',
            agentName: 'Managed app backend CLI worker',
            task: expect.stringContaining('Managed-app backend CLI iteration.'),
        }));
        expect(store.createBuildRun).toHaveBeenCalledWith(expect.objectContaining({
            source: 'remote-cli-agent',
            requestedAction: 'deploy',
            commitSha: '1234567890abcdef',
            imageTag: 'sha-1234567890ab',
            deployRequested: true,
        }));
        expect(updatedBuildRun.metadata.iteration).toEqual(expect.objectContaining({
            executor: 'remote-cli-agent',
            sourceOfTruth: 'gitlab',
            commitSha: '1234567890abcdef',
            committedPaths: ['public/index.html', 'public/styles.css'],
            remoteCli: expect.objectContaining({
                sessionId: 'remote-session-1',
                gitRepo: 'https://gitlab.demoserver2.buzz/agent-apps/remote-demo.git',
                uiCheckReport: 'ui-checks/remote-demo/report.json',
            }),
        }));
        expect(result.iteration.executor).toBe('remote-cli-agent');
        expect(result.iteration.evidence.remoteCli.uiScreenshots).toEqual([
            'ui-checks/remote-demo/desktop.png',
            'ui-checks/remote-demo/mobile.png',
        ]);
        expect(result.iteration.evidence.requiredProof.sourceChanged).toBe(true);
    });

    test('builds a managed app blueprint from the explicit app name in the prompt', () => {
        const service = new ManagedAppService();

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const blueprint = service.buildAppBlueprint({
            prompt: 'Create and deploy a managed app called hello-stack. Make it a simple one-page site that says the pipeline is working.',
        }, 'user-1', 'session-1');

        expect(blueprint.slug).toBe('hello-stack');
        expect(blueprint.appName).toBe('Hello Stack');
        expect(blueprint.repoName).toBe('hello-stack');
        expect(blueprint.namespace).toBe('app-hello-stack');
        expect(blueprint.publicHost).toBe('hello-stack.demoserver2.buzz');
    });

    test('derives a clean repo name from the prompt subject instead of the opening phrasing', () => {
        const service = new ManagedAppService();

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const blueprint = service.buildAppBlueprint({
            prompt: 'Can you make me an expense tracker app for our server?',
        }, 'user-1', 'session-1');

        expect(blueprint.slug).toBe('expense-tracker');
        expect(blueprint.appName).toBe('Expense Tracker');
        expect(blueprint.repoName).toBe('expense-tracker');
    });

    test('falls back to a generic managed app name when the prompt has no usable subject', () => {
        const service = new ManagedAppService();
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1713571200000);

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        try {
            const blueprint = service.buildAppBlueprint({
                prompt: 'Can you use on our server?',
            }, 'user-1', 'session-1');

            expect(blueprint.slug).toBe('managed-app-1713571200000');
            expect(blueprint.appName).toBe('Managed App 1713571200000');
            expect(blueprint.repoName).toBe('managed-app-1713571200000');
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('prefers ssh for new managed app blueprints when the remote deploy lane is available', () => {
        const service = new ManagedAppService({
            kubernetesClient: {
                isSshConfigured: jest.fn(() => true),
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            deployTarget: 'in-cluster',
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const blueprint = service.buildAppBlueprint({
            prompt: 'Create and deploy a managed app called remote-first.',
        }, 'user-1', 'session-1');

        expect(blueprint.metadata.deploymentTarget).toBe('ssh');
    });

    test('always uses ssh for new managed app blueprints even when legacy config says in-cluster', () => {
        const service = new ManagedAppService({
            kubernetesClient: {
                isSshConfigured: jest.fn(() => false),
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            deployTarget: 'in-cluster',
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const blueprint = service.buildAppBlueprint({
            prompt: 'Create and deploy a managed app called remote-only.',
        }, 'user-1', 'session-1');

        expect(blueprint.metadata.deploymentTarget).toBe('ssh');
    });

    test('caps long prompt-derived managed app names before repository creation', () => {
        const service = new ManagedAppService();

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const blueprint = service.buildAppBlueprint({
            prompt: 'Create and deploy a managed app called this is a very long managed application name that should be shortened before repository creation because Gitea rejects overly long repository names and Kubernetes resource names also need to stay bounded.',
        }, 'user-1', 'session-1');

        expect(blueprint.slug.length).toBeLessThanOrEqual(63);
        expect(blueprint.repoName).toBe(blueprint.slug);
        expect(blueprint.namespace.length).toBeLessThanOrEqual(63);
        expect(blueprint.publicHost).toBe(`${blueprint.slug}.demoserver2.buzz`);
    });

    test('resolves existing managed-app mutations by public host before an auto-filled task slug', async () => {
        const tetrisApp = {
            id: 'app-tetris',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'tetris-game',
            appName: 'Tetris Game',
            repoOwner: 'agent-apps',
            repoName: 'tetris-game',
            publicHost: 'awesome.demoserver2.buzz',
            namespace: 'app-tetris-game',
            metadata: {},
            status: 'live',
        };
        const store = {
            listApps: jest.fn(async () => [tetrisApp]),
            getAppBySlug: jest.fn(async () => null),
        };
        const service = new ManagedAppService({ store });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });

        const resolved = await service.resolveExistingAppForAction('', {
            slug: 'update-desktop-css-so-start-game',
            publicHost: 'awesome.demoserver2.buzz',
            prompt: 'Update the desktop CSS so the existing Tetris game at https://awesome.demoserver2.buzz starts correctly.',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(resolved).toEqual(expect.objectContaining({
            id: 'app-tetris',
            slug: 'tetris-game',
            publicHost: 'awesome.demoserver2.buzz',
        }));
        expect(store.getAppBySlug).not.toHaveBeenCalledWith('update-desktop-css-so-start-game', 'user-1');
    });

    test('heals missing repo coordinates on existing apps before creating the repository', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'hello-stack',
            appName: 'Hello Stack',
            repoOwner: '',
            repoName: '',
            repoUrl: '',
            repoCloneUrl: '',
            repoSshUrl: '',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/hello-stack',
            namespace: 'app-hello-stack',
            publicHost: 'hello-stack.demoserver2.buzz',
            sourcePrompt: 'Create and deploy a managed app called hello-stack.',
            metadata: {},
            status: 'draft',
        };

        const updatedExistingApp = {
            ...existingApp,
            repoOwner: 'agent-apps',
            repoName: 'hello-stack',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
            status: 'provisioning',
        };

        const finalApp = {
            ...updatedExistingApp,
            status: 'building',
            metadata: {
                lastSeededPaths: ['index.html'],
            },
        };

        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppBySlug: jest.fn(async () => existingApp),
            updateApp: jest.fn()
                .mockResolvedValueOnce(updatedExistingApp)
                .mockResolvedValueOnce(finalApp),
            createApp: jest.fn(),
            createBuildRun: jest.fn(async () => ({
                id: 'run-1',
                buildStatus: 'queued',
                deployStatus: 'pending',
                verificationStatus: 'pending',
                imageTag: 'sha-abcdef123456',
            })),
        };

        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['index.html'],
            })),
        };

        const service = new ManagedAppService({
            store,
            giteaClient,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });
        service.buildBuildEventsUrl = () => 'https://kimibuilt.demoserver2.buzz/api/integrations/gitea/build-events';

        const result = await service.createApp({
            slug: 'hello-stack',
            requestedAction: 'deploy',
            prompt: 'Create and deploy a managed app called hello-stack. Make it a simple one-page site.',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(store.updateApp).toHaveBeenNthCalledWith(1, 'app-1', 'user-1', expect.objectContaining({
            repoOwner: 'agent-apps',
            repoName: 'hello-stack',
            status: 'provisioning',
        }));
        expect(giteaClient.ensureRepository).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            name: 'hello-stack',
        }));
        expect(store.updateApp).toHaveBeenNthCalledWith(2, 'app-1', 'user-1', expect.objectContaining({
            repoOwner: 'agent-apps',
            repoName: 'hello-stack',
            status: 'building',
        }));
        expect(store.createBuildRun).toHaveBeenCalledWith(expect.objectContaining({
            appId: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
        }));
        expect(result.repository).toEqual(expect.objectContaining({
            owner: 'agent-apps',
            name: 'hello-stack',
        }));
    });

    test('generates app source files from the managed-app prompt before seeding the repo', async () => {
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppBySlug: jest.fn(async () => null),
            getAppByRepo: jest.fn(async () => null),
            createApp: jest.fn(async (input) => ({
                id: 'app-llm-1',
                ownerId: 'user-1',
                sessionId: 'session-1',
                ...input,
            })),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                id: 'app-llm-1',
                ownerId: 'user-1',
                sessionId: 'session-1',
                slug: 'launch-site',
                appName: 'Launch Site',
                repoOwner: 'agent-apps',
                repoName: 'launch-site',
                repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/launch-site.git',
                repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/launch-site.git',
                repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/launch-site.git',
                defaultBranch: 'main',
                imageRepo: 'gitea.demoserver2.buzz/agent-apps/launch-site',
                namespace: 'app-launch-site',
                publicHost: 'launch-site.demoserver2.buzz',
                sourcePrompt: 'Create and deploy a launch page.',
                metadata: {},
                ...updates,
            })),
            createBuildRun: jest.fn(async () => ({
                id: 'run-llm-1',
                buildStatus: 'queued',
                deployStatus: 'not_requested',
                verificationStatus: 'pending',
                imageTag: 'sha-abcdef123456',
            })),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/launch-site',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/launch-site.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/launch-site.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['public/index.html', 'public/styles.css', 'public/app.js'],
            })),
        };
        const llmClient = {
            complete: jest.fn(async () => JSON.stringify({
                files: [
                    {
                        path: 'public/index.html',
                        content: '<!DOCTYPE html><html><body><main><h1>Launch Site</h1></main><script src="./app.js"></script></body></html>',
                    },
                    {
                        path: 'public/styles.css',
                        content: 'body{margin:0;background:#111;color:#fff;}main{padding:48px;}',
                    },
                    {
                        path: 'public/app.js',
                        content: 'document.body.dataset.ready = "true";',
                    },
                ],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
            kubernetesClient: {
                isConfigured: () => true,
            },
            llmClient,
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });
        service.buildBuildEventsUrl = () => 'https://kimibuilt.demoserver2.buzz/api/integrations/gitea/build-events';

        await service.createApp({
            prompt: 'Create and deploy a managed app called launch-site with a sharp launch page and a CTA.',
        }, 'user-1', {
            sessionId: 'session-1',
            model: 'gpt-5.4-mini',
        });

        expect(llmClient.complete).toHaveBeenCalledTimes(1);
        expect(giteaClient.upsertFiles).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            repo: 'launch-site',
            files: expect.arrayContaining([
                expect.objectContaining({
                    path: 'public/index.html',
                    content: expect.stringContaining('<h1>Launch Site</h1>'),
                }),
                expect.objectContaining({
                    path: 'public/styles.css',
                    content: expect.stringContaining('background:#111'),
                }),
                expect.objectContaining({
                    path: 'public/app.js',
                    content: 'document.body.dataset.ready = "true";',
                }),
                expect.objectContaining({
                    path: '.gitlab-ci.yml',
                }),
            ]),
        }));
    });

    test('recovers the persisted app from the store before creating the build run', async () => {
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppBySlug: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null),
            createApp: jest.fn(async () => ({
                appName: 'Hello Stack',
                slug: 'hello-stack',
                repoOwner: 'agent-apps',
                repoName: 'hello-stack',
                repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                repoSshUrl: '',
                defaultBranch: 'main',
                imageRepo: 'gitea.demoserver2.buzz/agent-apps/hello-stack',
                namespace: 'app-hello-stack',
                publicHost: 'hello-stack.demoserver2.buzz',
                ownerId: 'user-1',
                sessionId: 'session-1',
                metadata: {},
            })),
            updateApp: jest.fn(async () => ({
                appName: 'Hello Stack',
                slug: 'hello-stack',
                repoOwner: 'agent-apps',
                repoName: 'hello-stack',
                repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                repoSshUrl: '',
                defaultBranch: 'main',
                imageRepo: 'gitea.demoserver2.buzz/agent-apps/hello-stack',
                namespace: 'app-hello-stack',
                publicHost: 'hello-stack.demoserver2.buzz',
                ownerId: 'user-1',
                sessionId: 'session-1',
                metadata: {},
            })),
            getAppByRepo: jest.fn(async () => ({
                id: 'app-1',
                ownerId: 'user-1',
                sessionId: 'session-1',
                slug: 'hello-stack',
                appName: 'Hello Stack',
                repoOwner: 'agent-apps',
                repoName: 'hello-stack',
                repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                repoSshUrl: '',
                defaultBranch: 'main',
                imageRepo: 'gitea.demoserver2.buzz/agent-apps/hello-stack',
                namespace: 'app-hello-stack',
                publicHost: 'hello-stack.demoserver2.buzz',
                status: 'building',
                sourcePrompt: '',
                metadata: {},
            })),
            createBuildRun: jest.fn(async () => ({
                id: 'run-1',
                appId: 'app-1',
                buildStatus: 'queued',
            })),
        };

        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/hello-stack.git',
                    ssh_url: '',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['index.html'],
            })),
        };

        const service = new ManagedAppService({
            store,
            giteaClient,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });
        service.buildBuildEventsUrl = () => 'https://kimibuilt.demoserver2.buzz/api/integrations/gitea/build-events';

        const result = await service.createApp({
            slug: 'hello-stack',
            requestedAction: 'deploy',
            prompt: 'Create and deploy a managed app called hello-stack.',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(store.getAppByRepo).toHaveBeenCalledWith('agent-apps', 'hello-stack');
        expect(store.createBuildRun).toHaveBeenCalledWith(expect.objectContaining({
            appId: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
        }));
        expect(result.app.id).toBe('app-1');
    });

    test('recreates the app record before repository seeding when the first persistence attempt returns no id', async () => {
        const firstCreate = {
            appName: 'First Demo',
            slug: 'first-demo',
            repoOwner: 'agent-apps',
            repoName: 'first-demo',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/first-demo.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/first-demo.git',
            repoSshUrl: '',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/first-demo',
            namespace: 'app-first-demo',
            publicHost: 'first-demo.demoserver2.buzz',
            ownerId: 'user-1',
            sessionId: 'session-1',
            metadata: {},
        };
        const recoveredApp = {
            ...firstCreate,
            id: 'app-1',
            status: 'provisioning',
        };
        const finalApp = {
            ...recoveredApp,
            status: 'building',
            metadata: {
                lastSeededPaths: ['index.html'],
            },
        };

        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppBySlug: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null),
            getAppByRepo: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null),
            createApp: jest.fn()
                .mockResolvedValueOnce(firstCreate)
                .mockResolvedValueOnce(recoveredApp),
            updateApp: jest.fn(async () => finalApp),
            createBuildRun: jest.fn(async () => ({
                id: 'run-1',
                appId: 'app-1',
                buildStatus: 'queued',
            })),
        };

        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/first-demo',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/first-demo.git',
                    ssh_url: '',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['index.html'],
            })),
        };

        const service = new ManagedAppService({
            store,
            giteaClient,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
        });
        service.buildBuildEventsUrl = () => 'https://kimibuilt.demoserver2.buzz/api/integrations/gitea/build-events';

        const result = await service.createApp({
            slug: 'first-demo',
            requestedAction: 'deploy',
            prompt: 'Create and deploy a managed app called first-demo.',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(store.createApp).toHaveBeenCalledTimes(2);
        expect(store.updateApp).toHaveBeenCalledWith('app-1', 'user-1', expect.objectContaining({
            repoOwner: 'agent-apps',
            repoName: 'first-demo',
            status: 'building',
        }));
        expect(store.createBuildRun).toHaveBeenCalledWith(expect.objectContaining({
            appId: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
        }));
        expect(result.app.id).toBe('app-1');
    });

    test('buildPromptSummary nudges the runtime to create the first managed app when the catalog is empty', async () => {
        const service = new ManagedAppService({
            store: {
                isAvailable: () => true,
                listApps: jest.fn(async () => ([])),
            },
        });

        await expect(service.buildPromptSummary({
            ownerId: 'user-1',
            maxApps: 4,
        })).resolves.toContain('create the first one directly');
    });

    test('createApp rejects missing owner context before writing managed app records', async () => {
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            createApp: jest.fn(),
        };
        const service = new ManagedAppService({
            store,
            giteaClient: {
                isConfigured: () => true,
            },
        });

        await expect(service.createApp({
            slug: 'upload-test',
            prompt: 'Create a managed app upload test.',
        }, null, {
            sessionId: 'session-1',
        })).rejects.toMatchObject({
            message: 'Managed app creation requires an authenticated owner context.',
            statusCode: 401,
        });
        expect(store.createApp).not.toHaveBeenCalled();
    });

    test('resolveApp accepts owner and repo references', async () => {
        const getAppByRepo = jest.fn(async () => ({
            id: 'app-1',
            slug: 'demo',
            repoOwner: 'agent-apps',
            repoName: 'demo',
        }));
        const service = new ManagedAppService({
            store: {
                isAvailable: () => true,
                getAppByRepo,
                getAppById: jest.fn(async () => null),
                getAppBySlug: jest.fn(async () => null),
            },
        });

        await expect(service.resolveApp('agent-apps/demo', 'user-1')).resolves.toEqual(expect.objectContaining({
            id: 'app-1',
            slug: 'demo',
        }));
        expect(getAppByRepo).toHaveBeenCalledWith('agent-apps', 'demo');
    });

    test('resolveApp ignores empty placeholder records from store misses', async () => {
        const service = new ManagedAppService({
            store: {
                isAvailable: () => true,
                getAppByRepo: jest.fn(async () => null),
                getAppById: jest.fn(async () => ({})),
                getAppBySlug: jest.fn(async () => ({
                    id: '',
                    slug: '',
                    status: 'draft',
                    metadata: {},
                })),
            },
        });

        await expect(service.resolveApp('missing-app', 'user-1')).resolves.toBeNull();
    });

    test('createApp reuses an existing app by public host and keeps repo identity stable', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            sourcePrompt: '',
            status: 'live',
            metadata: {},
        };
        const updatedApp = {
            ...existingApp,
            metadata: {
                project: {
                    summary: 'Demo App was resumed without repository changes.',
                },
            },
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppBySlug: jest.fn(async () => null),
            getAppByRepo: jest.fn(async () => null),
            listApps: jest.fn(async () => ([existingApp])),
            updateApp: jest.fn()
                .mockResolvedValueOnce(updatedApp)
                .mockResolvedValueOnce(updatedApp),
            createApp: jest.fn(),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/demo-app',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['public/index.html'],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });

        const result = await service.createApp({
            appName: 'Completely New Name',
            publicHost: 'demo-app.demoserver2.buzz',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(result.reusedExistingApp).toBe(true);
        expect(result.app.id).toBe('app-1');
        expect(result.app.repoName).toBe('demo-app');
        expect(result.app.namespace).toBe('app-demo-app');
        expect(store.createApp).not.toHaveBeenCalled();
        expect(giteaClient.upsertFiles).not.toHaveBeenCalled();
        expect(result.message).toContain('Resumed Demo App');
    });

    test('createApp reuses an existing app when the target public host only appears in the prompt', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'tetris-site',
            appName: 'Tetris Site',
            repoOwner: 'agent-apps',
            repoName: 'tetris-site',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/tetris-site.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/tetris-site.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/tetris-site.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/tetris-site',
            namespace: 'app-tetris-site',
            publicHost: 'awesome.demoserver2.buzz',
            sourcePrompt: 'Deploy the Tetris site.',
            status: 'live',
            metadata: {},
        };
        let currentApp = existingApp;
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppBySlug: jest.fn(async () => null),
            getAppByRepo: jest.fn(async () => null),
            listApps: jest.fn(async () => ([existingApp])),
            updateApp: jest.fn(async (_id, _ownerId, updates) => {
                currentApp = {
                    ...currentApp,
                    ...updates,
                    metadata: updates.metadata || currentApp.metadata,
                };
                return currentApp;
            }),
            createApp: jest.fn(),
            createBuildRun: jest.fn(async () => ({
                id: 'build-1',
                appId: 'app-1',
                commitSha: 'abcdef1234567890',
                buildStatus: 'queued',
                deployRequested: true,
                deployStatus: 'pending',
                verificationStatus: 'pending',
                metadata: {},
            })),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/tetris-site',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/tetris-site.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/tetris-site.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['public/index.html'],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
            llmClient: {
                complete: jest.fn(async () => JSON.stringify({ files: [] })),
            },
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });

        const result = await service.createApp({
            prompt: 'Just try again to fix the Tetris deployment to awesome.demoserver2.buzz',
            requestedAction: 'deploy',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(result.reusedExistingApp).toBe(true);
        expect(result.app.id).toBe('app-1');
        expect(result.app.slug).toBe('tetris-site');
        expect(result.app.publicHost).toBe('awesome.demoserver2.buzz');
        expect(store.createApp).not.toHaveBeenCalled();
        expect(giteaClient.ensureRepository).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            name: 'tetris-site',
        }));
        expect(result.app.metadata.project.summary).toContain('GitLab pipeline has not been observed yet.');
        expect(result.app.metadata.project.summary).not.toContain('Build and deploy are queued');
        expect(result.app.metadata.project.openItems).toEqual(expect.arrayContaining([
            'GitLab pipeline evidence is not observed yet.',
        ]));
        const project = service.buildAppProjectView(result.app, result.buildRun);
        expect(project.progress.steps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'build',
                status: 'pending',
            }),
        ]));
        expect(result.message).toContain('Resumed Tetris Site');
    });

    test('createApp reuses the session-linked managed app for unnamed follow-up prompts', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            sourcePrompt: 'Build the first version.',
            status: 'live',
            metadata: {},
        };
        const buildRun = {
            id: 'build-1',
            appId: 'app-1',
            buildStatus: 'queued',
            deployRequested: false,
        };
        const updatedApp = {
            ...existingApp,
            metadata: {
                project: {
                    summary: 'Demo App was resumed and updated in agent-apps/demo-app. Build and deploy are queued.',
                },
            },
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppById: jest.fn(async (id) => (id === 'app-1' ? existingApp : null)),
            getAppBySlug: jest.fn(async (slug) => (slug === 'demo-app' ? existingApp : null)),
            getAppByRepo: jest.fn(async () => null),
            listApps: jest.fn(async () => ([existingApp])),
            updateApp: jest.fn()
                .mockResolvedValueOnce(updatedApp)
                .mockResolvedValueOnce(updatedApp)
                .mockResolvedValueOnce(updatedApp),
            createApp: jest.fn(),
            createBuildRun: jest.fn(async () => buildRun),
        };
        const sessionStore = {
            listMessages: jest.fn(async () => ([
                {
                    id: 'msg-1',
                    role: 'assistant',
                    content: 'Demo App is live.',
                    timestamp: '2026-04-21T00:00:00.000Z',
                    metadata: {
                        managedAppLifecycle: true,
                        managedAppId: 'app-1',
                        managedAppSlug: 'demo-app',
                    },
                },
            ])),
            upsertMessage: jest.fn(async () => null),
            update: jest.fn(async () => null),
            getOwned: jest.fn(async () => ({
                id: 'session-1',
                metadata: {},
            })),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/demo-app',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['public/index.html'],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
            sessionStore,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });

        const result = await service.createApp({
            prompt: 'Make the hero section sharper and update the CTA copy.',
            sessionId: 'session-1',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(result.reusedExistingApp).toBe(true);
        expect(result.app.slug).toBe('demo-app');
        expect(store.createApp).not.toHaveBeenCalled();
        expect(giteaClient.ensureRepository).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            name: 'demo-app',
        }));
        expect(giteaClient.upsertFiles).toHaveBeenCalled();
        expect(result.message).toContain('Resumed Demo App');
    });

    test('resolveRecentSessionManagedApp reuses the session active project before transcript history', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            status: 'live',
            metadata: {},
        };
        const sessionStore = {
            getOwned: jest.fn(async () => ({
                id: 'session-1',
                metadata: {
                    activeProject: {
                        type: 'managed-app',
                        appId: 'app-1',
                        appSlug: 'demo-app',
                    },
                },
            })),
        };
        const store = {
            getAppById: jest.fn(async (id) => (id === 'app-1' ? existingApp : null)),
            getAppBySlug: jest.fn(async (slug) => (slug === 'demo-app' ? existingApp : null)),
            getAppByRepo: jest.fn(async () => null),
        };
        const service = new ManagedAppService({
            store,
            sessionStore,
        });

        const result = await service.resolveRecentSessionManagedApp('session-1', 'user-1');

        expect(result?.id).toBe('app-1');
        expect(sessionStore.getOwned).toHaveBeenCalledWith('session-1', 'user-1');
        expect(store.getAppById).toHaveBeenCalledWith('app-1', 'user-1');
    });

    test('broadcastLifecycleEvent persists the active project snapshot into the session metadata', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            status: 'live',
            metadata: {
                project: {
                    nextStep: '',
                    openItems: [],
                    decisions: [],
                    lastUserIntent: 'Continue the demo app.',
                },
                desiredDeploy: {
                    deploymentTarget: 'ssh',
                    namespace: 'app-demo-app',
                    publicHost: 'demo-app.demoserver2.buzz',
                    defaultBranch: 'main',
                },
                liveDeploy: {
                    lastVerifiedAt: '2026-04-22T12:00:00.000Z',
                },
            },
        };
        const buildRun = {
            id: 'build-1',
            buildStatus: 'success',
            deployStatus: 'succeeded',
            verificationStatus: 'live',
        };
        const sessionStore = {
            upsertMessage: jest.fn(async () => null),
            getOwned: jest.fn(async () => ({
                id: 'session-1',
                metadata: {
                    title: 'New Chat',
                },
            })),
            update: jest.fn(async () => null),
        };
        const service = new ManagedAppService({
            sessionStore,
        });

        await service.broadcastLifecycleEvent(app, buildRun, 'live');

        expect(sessionStore.upsertMessage).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                managedAppProgressState: expect.objectContaining({
                    phase: 'live',
                    phaseLabel: 'Live',
                    totalSteps: 4,
                    completedSteps: 4,
                }),
            }),
        }));
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                title: 'Demo App',
                activeProject: expect.objectContaining({
                    type: 'managed-app',
                    key: 'managed-app:app-1',
                    title: 'Demo App',
                    phase: 'live',
                    progress: expect.objectContaining({
                        phase: 'live',
                        phaseLabel: 'Live',
                        nextStep: '',
                        totalSteps: 4,
                        completedSteps: 4,
                    }),
                    appId: 'app-1',
                    appSlug: 'demo-app',
                    publicHost: 'demo-app.demoserver2.buzz',
                    targetPublicHost: 'demo-app.demoserver2.buzz',
                    targetPublicUrl: 'https://demo-app.demoserver2.buzz',
                    livePublicHost: 'demo-app.demoserver2.buzz',
                    livePublicUrl: 'https://demo-app.demoserver2.buzz',
                    publicUrl: 'https://demo-app.demoserver2.buzz',
                    publicVerificationObserved: true,
                }),
            }),
        }));
    });

    test('broadcastLifecycleEvent preserves managed app project viewport sizing', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            status: 'building',
            metadata: {
                desiredDeploy: {
                    deploymentTarget: 'ssh',
                    namespace: 'app-demo-app',
                    publicHost: 'demo-app.demoserver2.buzz',
                    defaultBranch: 'main',
                },
            },
        };
        const buildRun = {
            id: 'build-1',
            buildStatus: 'success',
            deployStatus: 'pending',
            verificationStatus: 'pending',
        };
        const sessionStore = {
            upsertMessage: jest.fn(async () => null),
            getOwned: jest.fn(async () => ({
                id: 'session-1',
                metadata: {
                    title: 'Demo App',
                    activeProject: {
                        type: 'managed-app',
                        appId: 'app-1',
                        appSlug: 'demo-app',
                        viewportSize: 'collapsed',
                        projectViewportSize: 'collapsed',
                        previousViewportSize: 'full',
                        previousProjectViewportSize: 'full',
                    },
                },
            })),
            update: jest.fn(async () => null),
        };
        const service = new ManagedAppService({
            sessionStore,
        });

        await service.broadcastLifecycleEvent(app, buildRun, 'built');

        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                activeProject: expect.objectContaining({
                    phase: 'built',
                    viewportSize: 'collapsed',
                    projectViewportSize: 'collapsed',
                    previousViewportSize: 'full',
                    previousProjectViewportSize: 'full',
                }),
            }),
        }));
    });

    test('broadcastLifecycleEvent withholds managed app publicUrl until the public endpoint is verified', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'generated-slug',
            appName: 'Generated Slug',
            repoOwner: 'agent-apps',
            repoName: 'generated-slug',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/generated-slug.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/generated-slug.git',
            defaultBranch: 'main',
            namespace: 'app-generated-slug',
            publicHost: 'generated-slug.demoserver2.buzz',
            status: 'building',
            metadata: {
                desiredDeploy: {
                    deploymentTarget: 'ssh',
                    namespace: 'app-generated-slug',
                    publicHost: 'generated-slug.demoserver2.buzz',
                    defaultBranch: 'main',
                },
            },
        };
        const buildRun = {
            id: 'build-1',
            buildStatus: 'queued',
            deployStatus: 'pending',
            verificationStatus: 'pending',
        };
        const sessionStore = {
            upsertMessage: jest.fn(async () => null),
            getOwned: jest.fn(async () => ({
                id: 'session-1',
                metadata: {
                    title: 'New Chat',
                },
            })),
            update: jest.fn(async () => null),
        };
        const service = new ManagedAppService({
            sessionStore,
        });

        await service.broadcastLifecycleEvent(app, buildRun, 'created');

        expect(sessionStore.update).toHaveBeenCalledWith('session-1', expect.objectContaining({
            metadata: expect.objectContaining({
                title: 'Generated Slug',
                activeProject: expect.objectContaining({
                    type: 'managed-app',
                    phase: 'created',
                    publicHost: 'generated-slug.demoserver2.buzz',
                    targetPublicHost: 'generated-slug.demoserver2.buzz',
                    targetPublicUrl: 'https://generated-slug.demoserver2.buzz',
                    publicUrl: '',
                    livePublicHost: '',
                    livePublicUrl: '',
                    publicVerificationObserved: false,
                    progress: expect.objectContaining({
                        evidence: expect.objectContaining({
                            publicUrl: '',
                            targetPublicUrl: 'https://generated-slug.demoserver2.buzz',
                            livePublicUrl: '',
                            requiredProof: expect.objectContaining({
                                publicVerificationObserved: false,
                            }),
                        }),
                    }),
                }),
            }),
        }));
    });

    test('createApp still creates a separate repo when the prompt explicitly asks for a new app', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            sourcePrompt: 'Build the first version.',
            status: 'live',
            metadata: {},
        };
        const createdApp = {
            id: 'app-2',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'expense-tracker',
            appName: 'Expense Tracker',
            repoOwner: 'agent-apps',
            repoName: 'expense-tracker',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/expense-tracker.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/expense-tracker.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/expense-tracker.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/expense-tracker',
            namespace: 'app-expense-tracker',
            publicHost: 'expense-tracker.demoserver2.buzz',
            sourcePrompt: 'Create a brand new expense tracker app from scratch.',
            status: 'provisioning',
            metadata: {},
        };
        const updatedApp = {
            ...createdApp,
            status: 'building',
            metadata: {
                project: {
                    summary: 'Expense Tracker was created in agent-apps/expense-tracker. Build and deploy are queued.',
                },
            },
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppById: jest.fn(async (id) => (id === 'app-1' ? existingApp : null)),
            getAppBySlug: jest.fn(async (slug) => {
                if (slug === 'demo-app') {
                    return existingApp;
                }
                return null;
            }),
            getAppByRepo: jest.fn(async () => null),
            listApps: jest.fn(async () => ([existingApp])),
            createApp: jest.fn()
                .mockResolvedValueOnce(createdApp)
                .mockResolvedValueOnce(createdApp),
            updateApp: jest.fn()
                .mockResolvedValueOnce(updatedApp)
                .mockResolvedValueOnce(updatedApp),
            createBuildRun: jest.fn(async () => ({
                id: 'build-2',
                appId: 'app-2',
                buildStatus: 'queued',
                deployRequested: false,
            })),
        };
        const sessionStore = {
            listMessages: jest.fn(async () => ([
                {
                    id: 'msg-1',
                    role: 'assistant',
                    content: 'Demo App is live.',
                    timestamp: '2026-04-21T00:00:00.000Z',
                    metadata: {
                        managedAppLifecycle: true,
                        managedAppId: 'app-1',
                        managedAppSlug: 'demo-app',
                    },
                },
            ])),
            upsertMessage: jest.fn(async () => null),
            update: jest.fn(async () => null),
            getOwned: jest.fn(async () => ({
                id: 'session-1',
                metadata: {},
            })),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/expense-tracker',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/expense-tracker.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/expense-tracker.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'fedcba0987654321',
                committedPaths: ['public/index.html'],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
            sessionStore,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });

        const result = await service.createApp({
            prompt: 'Create a brand new expense tracker app from scratch.',
            sessionId: 'session-1',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(result.reusedExistingApp).toBe(false);
        expect(result.app.slug).toBe('expense-tracker');
        expect(store.createApp).toHaveBeenCalled();
        expect(giteaClient.ensureRepository).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            name: 'expense-tracker',
        }));
    });

    test('updateApp preserves repo coordinates and deployment identity unless explicitly overridden', async () => {
        const existingApp = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            sourcePrompt: 'Original prompt',
            status: 'live',
            metadata: {},
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            isAvailable: jest.fn(() => true),
            getAppById: jest.fn(async () => existingApp),
            getAppBySlug: jest.fn(async () => existingApp),
            getAppByRepo: jest.fn(async () => existingApp),
            createBuildRun: jest.fn(async () => ({
                id: 'build-1',
                appId: 'app-1',
                status: 'pending',
            })),
            updateApp: jest.fn()
                .mockResolvedValueOnce(existingApp)
                .mockResolvedValueOnce({
                    ...existingApp,
                    metadata: {
                        project: {
                            summary: 'Demo App was resumed without repository changes.',
                        },
                    },
                }),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            ensureOrganization: jest.fn(async () => ({ created: false })),
            ensureRepository: jest.fn(async () => ({
                repository: {
                    html_url: 'https://gitea.demoserver2.buzz/agent-apps/demo-app',
                    clone_url: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
                    ssh_url: 'ssh://git@gitea.demoserver2.buzz/agent-apps/demo-app.git',
                },
            })),
            upsertFiles: jest.fn(async () => ({
                commitSha: 'abcdef1234567890',
                committedPaths: ['public/index.html'],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
            kubernetesClient: {
                isConfigured: () => true,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            appBaseDomain: 'demoserver2.buzz',
            namespacePrefix: 'app-',
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });

        await service.updateApp('app-1', {
            prompt: 'Refresh the copy and polish the page.',
        }, 'user-1', {
            sessionId: 'session-1',
        });

        expect(store.updateApp).toHaveBeenNthCalledWith(1, 'app-1', 'user-1', expect.objectContaining({
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
        }));
    });

    test('inspectApp returns normalized lifecycle metadata and a summary', async () => {
        const service = new ManagedAppService({
            store: {
                getAppById: jest.fn(async () => null),
                getAppBySlug: jest.fn(async () => ({
                    id: 'app-1',
                    ownerId: 'user-1',
                    slug: 'demo-app',
                    appName: 'Demo App',
                    repoOwner: 'agent-apps',
                    repoName: 'demo-app',
                    repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
                    repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
                    repoSshUrl: '',
                    defaultBranch: 'main',
                    imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
                    namespace: 'app-demo-app',
                    publicHost: 'demo-app.demoserver2.buzz',
                    status: 'live',
                    sourcePrompt: 'Ship the demo app.',
                    metadata: {
                        project: {
                            summary: 'Demo App is live.',
                            nextStep: '',
                        },
                    },
                })),
                listBuildRunsForApp: jest.fn(async () => ([{
                    id: 'run-1',
                    buildStatus: 'success',
                    deployStatus: 'succeeded',
                    verificationStatus: 'live',
                }])),
            },
        });

        service.getEffectiveDeployConfig = () => ({
            ingressClassName: 'traefik',
            tlsClusterIssuer: 'letsencrypt-prod',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });

        const result = await service.inspectApp('demo-app', 'user-1');

        expect(result.summary).toBe('Demo App is live.');
        expect(result.project).toEqual(expect.objectContaining({
            key: 'managed-app:app-1',
            phase: 'live',
            nextStep: '',
        }));
        expect(result.progress).toEqual(expect.objectContaining({
            phase: 'live',
            phaseLabel: 'Live',
            totalSteps: 4,
            completedSteps: 4,
        }));
        expect(result.app.metadata.project.summary).toBe('Demo App is live.');
        expect(result.app.metadata.desiredDeploy.namespace).toBe('app-demo-app');
        expect(result.app.metadata.liveDeploy.https).toBe(false);
    });

    test('getAppProgress waits for digest-attested webhook evidence after pipeline success', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            repoUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoCloneUrl: 'https://gitea.demoserver2.buzz/agent-apps/demo-app.git',
            repoSshUrl: '',
            defaultBranch: 'main',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            status: 'building',
            sourcePrompt: 'Ship the demo app.',
            metadata: {
                deploymentTarget: 'ssh',
                project: {
                    summary: 'Demo App was created in agent-apps/demo-app. Build and deploy are queued.',
                    nextStep: 'Wait for the remote GitLab pipeline to finish, then continue deployment through the managed-app control plane.',
                    openItems: ['Remote build is queued.'],
                },
            },
        };
        const queuedBuildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            requestedAction: 'deploy',
            commitSha: 'abcdef1234567890',
            imageTag: 'sha-abcdef123456',
            buildStatus: 'queued',
            deployRequested: true,
            deployStatus: 'pending',
            verificationStatus: 'pending',
            externalRunId: '42',
            externalRunUrl: 'https://gitlab.demoserver2.buzz/agent-apps/demo-app/-/pipelines/42',
            metadata: {},
        };
        const finalBuildRun = {
            ...queuedBuildRun,
            buildStatus: 'success',
            deployStatus: 'succeeded',
            verificationStatus: 'live',
            externalRunId: '42',
            externalRunUrl: 'https://gitlab.demoserver2.buzz/agent-apps/demo-app/-/pipelines/42',
        };
        const liveApp = {
            ...app,
            status: 'live',
            metadata: {
                deploymentTarget: 'ssh',
                project: {
                    summary: 'Demo App is live.',
                    nextStep: '',
                    openItems: [],
                },
                liveDeploy: {
                    lastImage: 'gitea.demoserver2.buzz/agent-apps/demo-app:sha-abcdef123456',
                    https: true,
                },
            },
        };

        const store = {
            getAppById: jest.fn(async () => null),
            getAppBySlug: jest.fn(async () => app),
            ensureAvailable: jest.fn(async () => {}),
            listBuildRunsForApp: jest.fn(async () => ([queuedBuildRun])),
            getAppByRepo: jest.fn(async () => app),
            getBuildRunByExternalRunId: jest.fn(async () => null),
            getBuildRunByCommitSha: jest.fn(async () => queuedBuildRun),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...queuedBuildRun,
                ...updates,
            })),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...app,
                ...updates,
                metadata: updates.metadata || app.metadata,
            })),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            listRepositoryWorkflowRuns: jest.fn(async () => ({
                totalCount: 1,
                workflowRuns: [{
                    id: 42,
                    head_sha: 'abcdef1234567890',
                    status: 'completed',
                    conclusion: 'success',
                    html_url: 'https://gitlab.demoserver2.buzz/agent-apps/demo-app/-/pipelines/42',
                    started_at: '2026-04-22T12:00:00Z',
                    completed_at: '2026-04-22T12:01:00Z',
                }],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.getEffectiveDeployConfig = () => ({
            ingressClassName: 'traefik',
            tlsClusterIssuer: 'letsencrypt-prod',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultBranch: 'main',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.broadcastLifecycleEvent = jest.fn();
        service.deployApp = jest.fn(async () => ({
            app: liveApp,
            buildRun: finalBuildRun,
            deployment: {
                verification: {
                    rollout: true,
                    ingress: true,
                    tls: true,
                    https: true,
                },
                rollout: {
                    ok: true,
                },
            },
        }));

        const result = await service.getAppProgress('demo-app', 'user-1');

        expect(giteaClient.listRepositoryWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            repo: 'demo-app',
            headSha: 'abcdef1234567890',
        }));
        expect(service.deployApp).not.toHaveBeenCalled();
        expect(result.app.status).toBe('building');
        expect(result.latestBuildRun).toEqual(expect.objectContaining({
            buildStatus: 'queued',
            externalRunId: '42',
            metadata: expect.objectContaining({
                gitlabPipeline: expect.objectContaining({
                    awaitingDigestWebhook: true,
                }),
            }),
        }));
        expect(result.progress.terminal).toBe(false);
    });

    test('getAppProgress records a failed GitLab pipeline when the webhook is missing', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo-app',
            appName: 'Demo App',
            repoOwner: 'agent-apps',
            repoName: 'demo-app',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo-app',
            namespace: 'app-demo-app',
            publicHost: 'demo-app.demoserver2.buzz',
            status: 'building',
            sourcePrompt: 'Ship the demo app.',
            metadata: {
                deploymentTarget: 'ssh',
                project: {
                    summary: 'Demo App build is queued.',
                    nextStep: 'Wait for the remote GitLab pipeline to finish.',
                    openItems: ['Remote build is queued.'],
                },
            },
        };
        const queuedBuildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            requestedAction: 'deploy',
            commitSha: 'abcdef1234567890',
            imageTag: 'sha-abcdef123456',
            buildStatus: 'queued',
            deployRequested: true,
            deployStatus: 'pending',
            verificationStatus: 'pending',
            metadata: {},
        };
        const failedBuildRun = {
            ...queuedBuildRun,
            buildStatus: 'failed',
            externalRunId: '43',
            externalRunUrl: 'https://gitlab.demoserver2.buzz/agent-apps/demo-app/-/pipelines/43',
            error: {
                message: 'GitLab pipeline concluded with failure.',
            },
        };
        const failedApp = {
            ...app,
            status: 'build_failed',
            metadata: {
                deploymentTarget: 'ssh',
                project: {
                    summary: 'Demo App build failed.',
                    nextStep: 'Open the GitLab pipeline and fix the failed build step.',
                    openItems: ['Remote build failed.'],
                },
                liveDeploy: {
                    lastError: 'GitLab pipeline concluded with failure.',
                },
            },
        };

        const store = {
            getAppById: jest.fn(async () => null),
            getAppBySlug: jest.fn(async () => app),
            ensureAvailable: jest.fn(async () => {}),
            listBuildRunsForApp: jest.fn(async () => ([queuedBuildRun])),
            getAppByRepo: jest.fn(async () => app),
            getBuildRunByExternalRunId: jest.fn(async () => null),
            getBuildRunByCommitSha: jest.fn(async () => queuedBuildRun),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...failedBuildRun,
                ...updates,
            })),
            updateApp: jest.fn(async () => failedApp),
        };
        const giteaClient = {
            isConfigured: jest.fn(() => true),
            listRepositoryWorkflowRuns: jest.fn(async () => ({
                totalCount: 1,
                workflowRuns: [{
                    id: 43,
                    head_sha: 'abcdef1234567890',
                    status: 'completed',
                    conclusion: 'failure',
                    html_url: 'https://gitlab.demoserver2.buzz/agent-apps/demo-app/-/pipelines/43',
                    started_at: '2026-04-22T12:00:00Z',
                    completed_at: '2026-04-22T12:01:00Z',
                }],
            })),
        };
        const service = new ManagedAppService({
            store,
            giteaClient,
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.broadcastLifecycleEvent = jest.fn();
        service.deployApp = jest.fn();

        const result = await service.getAppProgress('demo-app', 'user-1');

        expect(giteaClient.listRepositoryWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
            owner: 'agent-apps',
            repo: 'demo-app',
            headSha: 'abcdef1234567890',
        }));
        expect(store.updateBuildRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
            buildStatus: 'failed',
            externalRunId: '43',
            externalRunUrl: 'https://gitlab.demoserver2.buzz/agent-apps/demo-app/-/pipelines/43',
            error: expect.objectContaining({
                message: 'GitLab pipeline concluded with failure.',
            }),
        }));
        expect(service.deployApp).not.toHaveBeenCalled();
        expect(result.app.status).toBe('build_failed');
        expect(result.latestBuildRun.buildStatus).toBe('failed');
        expect(result.progress).toEqual(expect.objectContaining({
            phase: 'build_failed',
            phaseLabel: 'Build failed',
        }));
    });

    test('listApps returns canonical summary and progress fields', async () => {
        const service = new ManagedAppService({
            store: {
                ensureAvailable: jest.fn(async () => undefined),
                listApps: jest.fn(async () => ([{
                    id: 'app-1',
                    ownerId: 'user-1',
                    slug: 'demo-app',
                    appName: 'Demo App',
                    repoOwner: 'agent-apps',
                    repoName: 'demo-app',
                    publicHost: 'demo-app.demoserver2.buzz',
                    status: 'updated',
                    metadata: {
                        project: {
                            summary: 'Demo App was updated. Build and deploy are queued.',
                            nextStep: 'Wait for the remote GitLab pipeline to finish, then continue deployment through the managed-app control plane.',
                            openItems: ['Remote build is queued.'],
                        },
                    },
                }])),
            },
        });

        const result = await service.listApps('user-1', 50);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(expect.objectContaining({
            summary: 'Demo App was updated. Build and deploy are queued.',
            nextStep: expect.stringContaining('Wait for the remote GitLab pipeline to finish'),
            openItems: expect.arrayContaining(['Remote build is queued.']),
            progress: expect.objectContaining({
                phase: 'updated',
                phaseLabel: 'Build queued',
                totalSteps: 4,
            }),
        }));
    });

    test('doctorPlatform summarizes the remote GitLab runner stack through the SSH kubernetes client', async () => {
        const inspectManagedAppPlatform = jest.fn(async () => ({
            deploymentTarget: 'ssh',
            platformNamespace: 'agent-platform',
            namespaceExists: true,
            executionHost: 'deploy.example:22',
            deployments: {
                gitlab: {
                    name: 'gitlab',
                    present: true,
                    desiredReplicas: 1,
                    readyReplicas: 1,
                    availableReplicas: 1,
                    updatedReplicas: 1,
                    ready: true,
                },
                buildkitd: {
                    name: 'buildkitd',
                    present: true,
                    desiredReplicas: 1,
                    readyReplicas: 1,
                    availableReplicas: 1,
                    updatedReplicas: 1,
                    ready: true,
                },
                'gitlab-runner': {
                    name: 'gitlab-runner',
                    present: true,
                    desiredReplicas: 0,
                    readyReplicas: 0,
                    availableReplicas: 0,
                    updatedReplicas: 0,
                    ready: false,
                },
            },
            runnerTokenState: 'placeholder',
            runnerLabels: 'kimibuilt,buildkit',
            gitlabInstanceUrl: 'https://gitlab.demoserver2.buzz',
            runnerLogExcerpt: ['registration token invalid'],
            raw: {
                stdout: '',
                stderr: '',
                exitCode: 0,
            },
        }));
        const service = new ManagedAppService({
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                inspectManagedAppPlatform,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            provider: 'gitlab',
            baseURL: 'https://gitlab.demoserver2.buzz',
            registryHost: 'registry.gitlab.demoserver2.buzz',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            platformNamespace: 'agent-platform',
        });

        const result = await service.doctorPlatform({}, 'user-1', {
            executionProfile: 'remote-build',
        });

        expect(inspectManagedAppPlatform).toHaveBeenCalledWith({
            platformNamespace: 'agent-platform',
            deploymentTarget: 'ssh',
        });
        expect(result.healthy).toBe(false);
        expect(result.platform.expected.gitlabBaseURL).toBe('https://gitlab.demoserver2.buzz');
        expect(result.suggestions).toEqual(expect.arrayContaining([
            expect.stringContaining('`gitlab-runner` is scaled to `0`'),
            expect.stringContaining('placeholder value'),
        ]));
        expect(result.message).toContain('deploy.example:22');
        expect(result.message).toContain('platform needs attention');
    });

    test('reconcilePlatform repairs the remote runner stack through GitLab and SSH', async () => {
        const inspectManagedAppPlatform = jest.fn()
            .mockResolvedValueOnce({
                deploymentTarget: 'ssh',
                platformNamespace: 'agent-platform',
                namespaceExists: true,
                executionHost: 'deploy.example:22',
                deployments: {
                    gitlab: {
                        name: 'gitlab',
                        present: true,
                        desiredReplicas: 1,
                        readyReplicas: 1,
                        availableReplicas: 1,
                        updatedReplicas: 1,
                        ready: true,
                    },
                    buildkitd: {
                        name: 'buildkitd',
                        present: true,
                        desiredReplicas: 1,
                        readyReplicas: 1,
                        availableReplicas: 1,
                        updatedReplicas: 1,
                        ready: true,
                    },
                    'gitlab-runner': {
                        name: 'gitlab-runner',
                        present: true,
                        desiredReplicas: 0,
                        readyReplicas: 0,
                        availableReplicas: 0,
                        updatedReplicas: 0,
                        ready: false,
                    },
                },
                runnerTokenState: 'placeholder',
                runnerLabels: 'kimibuilt,buildkit',
                gitlabInstanceUrl: 'https://gitlab.demoserver2.buzz',
                runnerLogExcerpt: ['registration token invalid'],
                raw: {
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                },
            })
            .mockResolvedValueOnce({
                deploymentTarget: 'ssh',
                platformNamespace: 'agent-platform',
                namespaceExists: true,
                executionHost: 'deploy.example:22',
                deployments: {
                    gitlab: {
                        name: 'gitlab',
                        present: true,
                        desiredReplicas: 1,
                        readyReplicas: 1,
                        availableReplicas: 1,
                        updatedReplicas: 1,
                        ready: true,
                    },
                    buildkitd: {
                        name: 'buildkitd',
                        present: true,
                        desiredReplicas: 1,
                        readyReplicas: 1,
                        availableReplicas: 1,
                        updatedReplicas: 1,
                        ready: true,
                    },
                    'gitlab-runner': {
                        name: 'gitlab-runner',
                        present: true,
                        desiredReplicas: 1,
                        readyReplicas: 1,
                        availableReplicas: 1,
                        updatedReplicas: 1,
                        ready: true,
                    },
                },
                runnerTokenState: 'present',
                runnerLabels: 'kimibuilt,buildkit',
                gitlabInstanceUrl: 'https://gitlab.demoserver2.buzz',
                runnerLogExcerpt: [],
                raw: {
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                },
            });
        const reconcileManagedAppPlatform = jest.fn(async () => ({
            deploymentTarget: 'ssh',
            platformNamespace: 'agent-platform',
            executionHost: 'deploy.example:22',
            actions: [
                'gitlab-runner-secret-applied',
                'gitlab-runner-scaled-1',
                'gitlab-runner-restarted',
            ],
            raw: {
                stdout: '',
                stderr: '',
                exitCode: 0,
            },
        }));
        const listActionsRunners = jest.fn(async () => ({
            scope: 'gitlab',
            totalCount: 1,
            runners: [{
                id: 7,
                name: 'agent-platform-runner',
                status: 'online',
                disabled: false,
                busy: false,
                labels: [{ name: 'kimibuilt' }, { name: 'buildkit' }],
            }],
        }));

        const service = new ManagedAppService({
            giteaClient: {
                isConfigured: jest.fn(() => true),
                listActionsRunners,
            },
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                inspectManagedAppPlatform,
                reconcileManagedAppPlatform,
            },
        });

        service.getEffectiveGiteaConfig = () => ({
            provider: 'gitlab',
            baseURL: 'https://gitlab.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'registry.gitlab.demoserver2.buzz',
            runnerToken: 'runner-token-123',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            platformNamespace: 'agent-platform',
        });

        const result = await service.reconcilePlatform({}, 'user-1', {
            executionProfile: 'remote-build',
        });

        expect(reconcileManagedAppPlatform).toHaveBeenCalledWith(expect.objectContaining({
            platformNamespace: 'agent-platform',
            deploymentTarget: 'ssh',
            runnerRegistrationToken: 'runner-token-123',
            runnerLabels: 'kimibuilt,buildkit',
            gitlabInstanceUrl: 'https://gitlab.demoserver2.buzz',
        }));
        expect(listActionsRunners).toHaveBeenCalledWith(expect.objectContaining({
            scope: 'instance',
            org: 'agent-apps',
        }));
        expect(result.healthy).toBe(true);
        expect(result.gitlabRunners.onlineCount).toBe(1);
        expect(result.runnerToken.rotated).toBe(false);
        expect(result.message).toContain('gitlab-runner-restarted');
    });

    test('deployApp routes managed apps with ssh deployment targets through the remote kubernetes client', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: 'abcdef1234567890',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            deploymentImage: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            podImage: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            podImageID: `containerd://${TEST_IMAGE_DIGEST}`,
            verification: {
                imageDigest: true,
                rollout: true,
                ingress: true,
                tls: false,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const store = {
            isAvailable: () => true,
            getBuildRunById: jest.fn(async () => buildRun),
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...app,
                ...updates,
                metadata: updates.metadata,
            })),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {
            buildRunId: 'run-1',
            commitSha: 'abcdef1234567890',
            imageDigest: TEST_IMAGE_DIGEST,
        }, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            slug: 'demo',
            deploymentTarget: 'ssh',
            image: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
        }));
        expect(result.message).toContain('HTTPS is responding');
        expect(result.desiredDeploy).toEqual(expect.objectContaining({
            namespace: 'app-demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        }));
        expect(result.liveDeploy).toEqual(expect.objectContaining({
            lastImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
            requestedImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
            deployedImage: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            buildImageDigest: TEST_IMAGE_DIGEST,
            observedDeploymentImage: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            observedPodImage: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
            observedImageID: `containerd://${TEST_IMAGE_DIGEST}`,
            observedImageDigest: TEST_IMAGE_DIGEST,
            imageDigest: TEST_IMAGE_DIGEST,
            https: true,
        }));
        expect(result.buildRun.imageDigest).toBe(TEST_IMAGE_DIGEST);
        expect(service.buildAppProjectView(result.app, result.buildRun).progress.evidence).toEqual(expect.objectContaining({
            requestedImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
            observedImageID: `containerd://${TEST_IMAGE_DIGEST}`,
            observedImageDigest: TEST_IMAGE_DIGEST,
            imageDigest: TEST_IMAGE_DIGEST,
        }));
    });

    test('deployApp fails closed when the observed pod digest conflicts with single-platform ARM64 build proof', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: EXPECTED_BUILD_IMAGE_DIGEST,
            metadata: {},
        };
        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...app,
                ...updates,
                metadata: updates.metadata,
            })),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };
        const deployManagedApp = jest.fn(async () => ({
            imageDigest: TEST_IMAGE_DIGEST,
            deploymentImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
            podImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
            podImageID: `containerd://${TEST_IMAGE_DIGEST}`,
            verification: {
                rollout: true,
                ingress: true,
                tls: true,
                imageDigest: true,
                publicHttps: true,
                https: true,
            },
            rollout: { ok: true },
            https: { ok: true, status: 200 },
        }));
        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            image: `gitea.demoserver2.buzz/agent-apps/demo@${EXPECTED_BUILD_IMAGE_DIGEST}`,
        }));
        expect(result.app.status).toBe('deploy_failed');
        expect(result.liveDeploy).toEqual(expect.objectContaining({
            requestedImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
            deployedImage: `gitea.demoserver2.buzz/agent-apps/demo@${EXPECTED_BUILD_IMAGE_DIGEST}`,
            buildImageDigest: EXPECTED_BUILD_IMAGE_DIGEST,
            observedImageID: `containerd://${TEST_IMAGE_DIGEST}`,
            observedImageDigest: TEST_IMAGE_DIGEST,
            imageDigest: EXPECTED_BUILD_IMAGE_DIGEST,
            https: false,
            lastError: expect.stringContaining('build-attested digest'),
        }));
        expect(result.buildRun).toEqual(expect.objectContaining({
            imageDigest: EXPECTED_BUILD_IMAGE_DIGEST,
            deployStatus: 'failed',
            verificationStatus: 'failed',
        }));
        expect(result.deployment.verification).toEqual(expect.objectContaining({
            publicHttps: true,
            imageDigest: false,
            https: false,
        }));
        expect(result.deployment.imageEvidence).toEqual(expect.objectContaining({
            buildDigest: EXPECTED_BUILD_IMAGE_DIGEST,
            observedImageDigest: TEST_IMAGE_DIGEST,
            matchesBuildDigest: false,
            verified: false,
        }));
    });

    test('deployApp refuses to deploy while the latest build is still queued', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'building',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            buildStatus: 'queued',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            verification: {
                rollout: true,
                ingress: true,
                tls: true,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const service = new ManagedAppService({
            store: {
                isAvailable: () => true,
                listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            },
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
            giteaClient: {
                isConfigured: jest.fn(() => false),
            },
        });

        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {
            imageTag: 'sha-explicit-bypass',
        }, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        })).rejects.toThrow('latest build is still running or queued');
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp refuses a successful build that has only a mutable tag', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
            },
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            imageTag: 'sha-abcdef123456',
            imageDigest: '',
        };
        const deployManagedApp = jest.fn();
        const service = new ManagedAppService({
            store: {
                listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            },
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });
        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {}, 'user-1')).rejects.toMatchObject({
            code: 'MANAGED_APP_BUILD_DIGEST_REQUIRED',
            statusCode: 409,
        });
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp requires commit and digest identity with an explicit buildRunId', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: { deploymentTarget: 'ssh' },
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: 'abcdef1234567890',
            source: 'managed-app-service',
            buildStatus: 'success',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
        };
        const deployManagedApp = jest.fn();
        const service = new ManagedAppService({
            store: {
                getBuildRunById: jest.fn(async () => buildRun),
            },
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });
        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {
            buildRunId: 'run-1',
        }, 'user-1')).rejects.toMatchObject({
            code: 'MANAGED_APP_BUILD_IDENTITY_MISMATCH',
            statusCode: 409,
        });
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp does not substitute a prior app digest for the selected build run', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                lastSuccessfulBuild: {
                    commitSha: '1111111111111111',
                    imageTag: 'sha-111111111111',
                    imageDigest: TEST_IMAGE_DIGEST,
                },
            },
        };
        const buildRun = {
            id: 'run-2',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: '2222222222222222',
            buildStatus: 'success',
            imageTag: 'sha-222222222222',
            imageDigest: '',
        };
        const deployManagedApp = jest.fn();
        const service = new ManagedAppService({
            store: {
                getBuildRunById: jest.fn(async () => buildRun),
            },
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });
        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {
            buildRunId: 'run-2',
            commitSha: '2222222222222222',
            imageDigest: TEST_IMAGE_DIGEST,
        }, 'user-1')).rejects.toMatchObject({
            code: 'MANAGED_APP_BUILD_IDENTITY_MISMATCH',
            statusCode: 409,
        });
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp does not substitute lifecycle metadata for a missing build run', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                lastSuccessfulBuild: {
                    commitSha: '1111111111111111',
                    imageTag: 'sha-111111111111',
                    imageDigest: TEST_IMAGE_DIGEST,
                },
            },
        };
        const deployManagedApp = jest.fn();
        const service = new ManagedAppService({
            store: {
                listBuildRunsForApp: jest.fn(async () => ([])),
            },
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });
        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {}, 'user-1')).rejects.toMatchObject({
            statusCode: 409,
        });
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp rejects an observational webhook run that was not initiated by KimiBuilt', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: { deploymentTarget: 'ssh' },
        };
        const buildRun = {
            id: 'run-observed',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: 'abcdef1234567890',
            source: 'gitlab-webhook',
            buildStatus: 'success',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
        };
        const deployManagedApp = jest.fn();
        const service = new ManagedAppService({
            store: {
                listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            },
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });
        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {}, 'user-1')).rejects.toMatchObject({
            code: 'MANAGED_APP_DEPLOY_BUILD_RUN_UNTRUSTED',
            statusCode: 409,
        });
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp rejects an explicit tag that differs from the selected successful build', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: { deploymentTarget: 'ssh' },
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: 'abcdef1234567890',
            source: 'managed-app-service',
            buildStatus: 'success',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
        };
        const deployManagedApp = jest.fn();
        const service = new ManagedAppService({
            store: {
                listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            },
            kubernetesClient: {
                isConfigured: jest.fn(() => true),
                deployManagedApp,
            },
        });
        service.resolveApp = jest.fn(async () => app);

        await expect(service.deployApp('demo', {
            imageTag: 'sha-different1234',
        }, 'user-1')).rejects.toMatchObject({
            code: 'MANAGED_APP_BUILD_TAG_MISMATCH',
            statusCode: 409,
        });
        expect(deployManagedApp).not.toHaveBeenCalled();
    });

    test('deployApp derives the registry username from the Gitea token owner when settings omit it', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            verification: {
                imageDigest: true,
                rollout: true,
                ingress: true,
                tls: true,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const service = new ManagedAppService({
            store: {
                isAvailable: () => true,
                listBuildRunsForApp: jest.fn(async () => ([buildRun])),
                updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                    ...app,
                    ...updates,
                    metadata: updates.metadata,
                })),
                updateBuildRun: jest.fn(async (_id, updates) => ({
                    ...buildRun,
                    ...updates,
                })),
            },
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
            giteaClient: {
                isConfigured: jest.fn(() => true),
                getCurrentUser: jest.fn(async () => ({
                    login: 'builder',
                })),
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: '',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
            platformNamespace: 'agent-platform',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            registryUsername: 'builder',
            registryPassword: 'secret',
        }));
    });

    test('deployApp stores concrete deploy diagnostics when HTTPS verification fails after rollout', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            tlsSecretName: 'demo-tls',
            verification: {
                imageDigest: true,
                rollout: true,
                ingress: true,
                tls: true,
                https: false,
            },
            rollout: {
                ok: true,
            },
            https: {
                ok: false,
                status: 404,
                attemptsCompleted: true,
            },
            diagnostics: {
                expectedHost: 'demo.demoserver2.buzz',
                expectedService: 'demo',
                expectedServicePort: 80,
                expectedContainerPort: 80,
                deploymentPresent: true,
                servicePresent: true,
                ingressPresent: true,
                ingressHost: 'demo.demoserver2.buzz',
                ingressBackendService: 'demo',
                ingressBackendPort: 80,
                ingressHostMatches: true,
                ingressBackendMatches: true,
                serviceTargetMatches: true,
                tlsSecretPresent: true,
                certificateName: 'demo-cert',
                certificateReady: true,
                certificateReadyValue: 'true',
                certificateStatus: 'True',
                certificateMessage: '',
                challengeSummary: [],
                ingressEvents: [],
                traefikReady: true,
                traefikLogExcerpt: [],
                appProbe: {
                    attempted: true,
                    ok: true,
                    status: 200,
                    error: '',
                    bodyPreview: '',
                },
                httpsStatus: 404,
                httpsOk: false,
                httpsError: '',
            },
        }));

        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...app,
                ...updates,
                metadata: updates.metadata,
            })),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(result.message).toContain('404');
        expect(result.app.status).toBe('deploy_failed');
        expect(result.liveDeploy.lastError).toContain('404');
        expect(result.liveDeploy.lastDeployResult).toEqual(expect.objectContaining({
            diagnostics: expect.objectContaining({
                expectedHost: 'demo.demoserver2.buzz',
                httpsStatus: 404,
            }),
        }));
        expect(result.app.metadata.project.nextStep).toContain('Traefik ingress routing');
        expect(result.app.metadata.project.openItems).toEqual(expect.arrayContaining([
            expect.stringContaining('404'),
        ]));
        expect(result.buildRun.verificationStatus).toBe('failed');
    });

    test('deployApp heals a missing image repo from current Gitea settings before deployment', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: '',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const healedApp = {
            ...app,
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            verification: {
                imageDigest: true,
                rollout: true,
                tls: false,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn()
                .mockResolvedValueOnce({
                    ...healedApp,
                    metadata: {
                        ...healedApp.metadata,
                        deploymentTarget: 'ssh',
                    },
                })
                .mockResolvedValueOnce({
                    ...healedApp,
                    status: 'live',
                    metadata: {
                        ...healedApp.metadata,
                        deploymentTarget: 'ssh',
                        lastImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
                    },
                }),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(store.updateApp).toHaveBeenNthCalledWith(1, 'app-1', 'user-1', expect.objectContaining({
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        }));
        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            image: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
        }));
        expect(result.app.imageRepo).toBe('gitea.demoserver2.buzz/agent-apps/demo');
    });

    test('handleBuildEvent stores the resolved image repo from the webhook payload', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: '',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'building',
            metadata: {
                deploymentTarget: 'ssh',
            },
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: 'abcdef1234567890',
            source: 'managed-app-service',
            buildStatus: 'queued',
            deployRequested: true,
            deployStatus: 'pending',
            verificationStatus: 'pending',
            metadata: {},
        };
        const updatedApp = {
            ...app,
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                lastSuccessfulBuild: {
                    commitSha: 'abcdef1234567890',
                    imageTag: 'sha-abcdef123456',
                    imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
                    platforms: 'linux/amd64,linux/arm64',
                },
            },
        };

        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => app),
            getAppBySlug: jest.fn(async () => app),
            getBuildRunByExternalRunId: jest.fn(async () => buildRun),
            getBuildRunByCommitSha: jest.fn(async () => buildRun),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
            updateApp: jest.fn(async () => updatedApp),
        };

        const service = new ManagedAppService({
            store,
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.broadcastLifecycleEvent = jest.fn();
        service.deployApp = jest.fn(async () => ({
            app: updatedApp,
            buildRun: {
                ...buildRun,
                buildStatus: 'success',
                imageDigest: TEST_IMAGE_DIGEST,
            },
            deployment: {},
        }));

        const result = await service.handleBuildEvent({
            repoOwner: 'agent-apps',
            repoName: 'demo',
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            platforms: 'linux/amd64,linux/arm64',
            commitSha: 'abcdef1234567890',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
            runId: 'run-1',
        });

        expect(store.updateApp).toHaveBeenCalledWith('app-1', 'user-1', expect.objectContaining({
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            metadata: expect.objectContaining({
                lastSuccessfulBuild: expect.objectContaining({
                    imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
                    imageDigest: TEST_IMAGE_DIGEST,
                    platforms: 'linux/amd64,linux/arm64',
                }),
            }),
        }));
        expect(store.updateBuildRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
            imageDigest: TEST_IMAGE_DIGEST,
        }));
        expect(service.deployApp).toHaveBeenCalledWith('app-1', {
            buildRunId: 'run-1',
            commitSha: 'abcdef1234567890',
            imageDigest: TEST_IMAGE_DIGEST,
        }, 'user-1', {
            sessionId: 'session-1',
        });
        expect(result.app.imageRepo).toBe('gitea.demoserver2.buzz/agent-apps/demo');
    });

    test('handleBuildEvent rejects successful tag-only builds without pipeline digest attestation', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            metadata: {},
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => app),
            updateBuildRun: jest.fn(),
            updateApp: jest.fn(),
        };
        const service = new ManagedAppService({ store });
        service.getEffectiveGiteaConfig = () => ({
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });

        await expect(service.handleBuildEvent({
            repoOwner: 'agent-apps',
            repoName: 'demo',
            commitSha: 'abcdef1234567890',
            imageTag: 'sha-abcdef123456',
            buildStatus: 'success',
            runId: 'run-1',
        })).rejects.toMatchObject({
            code: 'MANAGED_APP_BUILD_DIGEST_REQUIRED',
            statusCode: 400,
        });
        expect(store.updateBuildRun).not.toHaveBeenCalled();
        expect(store.updateApp).not.toHaveBeenCalled();
    });

    test('handleBuildEvent rejects successful digest events without a valid commit SHA', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            metadata: {},
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => app),
            createBuildRun: jest.fn(),
            updateBuildRun: jest.fn(),
            updateApp: jest.fn(),
        };
        const service = new ManagedAppService({ store });
        service.getEffectiveGiteaConfig = () => ({
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });

        await expect(service.handleBuildEvent({
            repoOwner: 'agent-apps',
            repoName: 'demo',
            commitSha: 'not-a-commit',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
            runId: 'run-1',
        })).rejects.toMatchObject({
            code: 'MANAGED_APP_BUILD_COMMIT_REQUIRED',
            statusCode: 400,
        });
        expect(store.createBuildRun).not.toHaveBeenCalled();
        expect(store.updateBuildRun).not.toHaveBeenCalled();
        expect(store.updateApp).not.toHaveBeenCalled();
    });

    test('handleBuildEvent does not fall back to a same-slug app when full repo coordinates miss', async () => {
        const sameSlugApp = {
            id: 'app-foreign',
            ownerId: 'user-1',
            slug: 'demo',
            repoOwner: 'trusted-team',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/trusted-team/demo',
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => null),
            getAppBySlug: jest.fn(async () => sameSlugApp),
            createBuildRun: jest.fn(),
            updateBuildRun: jest.fn(),
            updateApp: jest.fn(),
        };
        const service = new ManagedAppService({ store });
        service.getEffectiveGiteaConfig = () => ({
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });

        await expect(service.handleBuildEvent({
            repoOwner: 'foreign-team',
            repoName: 'demo',
            slug: 'demo',
            commitSha: 'abcdef1234567890',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
        })).rejects.toMatchObject({ statusCode: 404 });
        expect(store.getAppBySlug).not.toHaveBeenCalled();
        expect(store.createBuildRun).not.toHaveBeenCalled();
        expect(store.updateApp).not.toHaveBeenCalled();
    });

    test('handleBuildEvent rejects an exact lookup result whose persisted repo identity differs', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            repoOwner: 'trusted-team',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/trusted-team/demo',
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => app),
            createBuildRun: jest.fn(),
            updateBuildRun: jest.fn(),
            updateApp: jest.fn(),
        };
        const service = new ManagedAppService({ store });
        service.getEffectiveGiteaConfig = () => ({
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });

        await expect(service.handleBuildEvent({
            repoOwner: 'foreign-team',
            repoName: 'demo',
            commitSha: 'abcdef1234567890',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
        })).rejects.toMatchObject({
            code: 'MANAGED_APP_REPOSITORY_IDENTITY_MISMATCH',
            statusCode: 409,
        });
        expect(store.createBuildRun).not.toHaveBeenCalled();
        expect(store.updateApp).not.toHaveBeenCalled();
    });

    test('handleBuildEvent rejects a foreign image repo before mutating build state', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            slug: 'demo',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => app),
            getBuildRunByExternalRunId: jest.fn(),
            createBuildRun: jest.fn(),
            updateBuildRun: jest.fn(),
            updateApp: jest.fn(),
        };
        const service = new ManagedAppService({ store });
        service.getEffectiveGiteaConfig = () => ({
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });

        await expect(service.handleBuildEvent({
            repoOwner: 'agent-apps',
            repoName: 'demo',
            commitSha: 'abcdef1234567890',
            imageRepo: 'evil-registry.example.test/foreign/demo',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
            runId: 'run-1',
        })).rejects.toMatchObject({
            code: 'MANAGED_APP_IMAGE_REPOSITORY_MISMATCH',
            statusCode: 409,
        });
        expect(store.getBuildRunByExternalRunId).not.toHaveBeenCalled();
        expect(store.createBuildRun).not.toHaveBeenCalled();
        expect(store.updateBuildRun).not.toHaveBeenCalled();
        expect(store.updateApp).not.toHaveBeenCalled();
    });

    test('handleBuildEvent rejects an orphan successful deploy event without mutating or deploying', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        };
        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => app),
            getBuildRunByExternalRunId: jest.fn(async () => null),
            getBuildRunByCommitSha: jest.fn(async () => null),
            createBuildRun: jest.fn(),
            updateBuildRun: jest.fn(),
            updateApp: jest.fn(),
        };
        const service = new ManagedAppService({ store });
        service.getEffectiveGiteaConfig = () => ({
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.deployApp = jest.fn();

        await expect(service.handleBuildEvent({
            repoOwner: 'agent-apps',
            repoName: 'demo',
            commitSha: 'abcdef1234567890',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
            deployRequested: true,
            requestedAction: 'deploy',
            runId: 'pipeline-42',
        })).rejects.toMatchObject({
            code: 'MANAGED_APP_DEPLOY_BUILD_RUN_REQUIRED',
            statusCode: 409,
        });
        expect(store.createBuildRun).not.toHaveBeenCalled();
        expect(store.updateBuildRun).not.toHaveBeenCalled();
        expect(store.updateApp).not.toHaveBeenCalled();
        expect(service.deployApp).not.toHaveBeenCalled();
    });

    test('handleBuildEvent falls back to slug lookup only when webhook repo coordinates are absent', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: '',
            repoOwner: '',
            repoName: '',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'building',
            metadata: {
                deploymentTarget: 'ssh',
            },
        };
        const buildRun = {
            id: 'run-1',
            appId: 'app-1',
            ownerId: 'user-1',
            commitSha: 'abcdef1234567890',
            buildStatus: 'queued',
            deployRequested: false,
            deployStatus: 'not_requested',
            verificationStatus: 'pending',
            metadata: {},
        };
        const updatedApp = {
            ...app,
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            repoOwner: 'agent-apps',
            repoName: 'demo',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                lastSuccessfulBuild: {
                    commitSha: 'abcdef1234567890',
                    imageTag: 'sha-abcdef123456',
                    imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
                },
            },
        };

        const store = {
            ensureAvailable: jest.fn(async () => {}),
            getAppByRepo: jest.fn(async () => null),
            getAppBySlug: jest.fn(async () => app),
            getBuildRunByExternalRunId: jest.fn(async () => buildRun),
            getBuildRunByCommitSha: jest.fn(async () => buildRun),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
            updateApp: jest.fn(async () => updatedApp),
        };

        const service = new ManagedAppService({
            store,
        });

        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            org: 'agent-apps',
            registryHost: 'gitea.demoserver2.buzz',
        });
        service.broadcastLifecycleEvent = jest.fn();

        await service.handleBuildEvent({
            slug: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            commitSha: 'abcdef1234567890',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            buildStatus: 'success',
            runId: 'run-1',
        });

        expect(store.getAppByRepo).not.toHaveBeenCalled();
        expect(store.getAppBySlug).toHaveBeenCalledWith('demo');
        expect(store.updateApp).toHaveBeenCalledWith('app-1', 'user-1', expect.objectContaining({
            repoOwner: 'agent-apps',
            repoName: 'demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        }));
    });

    test('deployApp falls back to lifecycle metadata when the imageRepo column is blank', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: '',
            repoOwner: '',
            repoName: '',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                desiredDeploy: {
                    imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
                },
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const healedApp = {
            ...app,
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            verification: {
                imageDigest: true,
                rollout: true,
                tls: false,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn()
                .mockResolvedValueOnce({
                    ...healedApp,
                    metadata: {
                        ...healedApp.metadata,
                        deploymentTarget: 'ssh',
                    },
                })
                .mockResolvedValueOnce({
                    ...healedApp,
                    status: 'live',
                    metadata: {
                        ...healedApp.metadata,
                        deploymentTarget: 'ssh',
                        lastImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
                    },
                }),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            baseURL: 'https://gitea.demoserver2.buzz',
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(store.updateApp).toHaveBeenNthCalledWith(1, 'app-1', 'user-1', expect.objectContaining({
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
        }));
        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            image: `gitea.demoserver2.buzz/agent-apps/demo@${TEST_IMAGE_DIGEST}`,
        }));
        expect(result.app.imageRepo).toBe('gitea.demoserver2.buzz/agent-apps/demo');
    });

    test('deployApp lets remote-build override legacy in-cluster metadata', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'in-cluster',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            verification: {
                imageDigest: true,
                rollout: true,
                tls: false,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...app,
                ...updates,
                metadata: updates.metadata,
            })),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            deploymentTarget: 'ssh',
        }));
        expect(result.message).toContain('HTTPS is responding');
    });

    test('deployApp uses the configured ssh lane for legacy in-cluster managed apps', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'app-demo',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'in-cluster',
                requestedContainerPort: 80,
            },
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            verification: {
                imageDigest: true,
                rollout: true,
                tls: false,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn(async (_id, _ownerId, updates) => ({
                ...app,
                ...updates,
                metadata: updates.metadata,
            })),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            deployTarget: 'ssh',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        await service.deployApp('demo', {}, 'user-1', {
            sessionId: 'session-1',
        });

        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            deploymentTarget: 'ssh',
        }));
    });

    test('deployApp heals legacy managed app namespaces before deployment', async () => {
        const app = {
            id: 'app-1',
            ownerId: 'user-1',
            sessionId: 'session-1',
            slug: 'demo',
            appName: 'Demo',
            imageRepo: 'gitea.demoserver2.buzz/agent-apps/demo',
            namespace: 'managed-app',
            publicHost: 'demo.demoserver2.buzz',
            status: 'built',
            metadata: {
                deploymentTarget: 'ssh',
                requestedContainerPort: 80,
            },
        };
        const healedApp = {
            ...app,
            namespace: 'app-demo',
        };
        const buildRun = {
            id: 'run-1',
            source: 'managed-app-service',
            buildStatus: 'success',
            deployStatus: 'pending',
            imageTag: 'sha-abcdef123456',
            imageDigest: TEST_IMAGE_DIGEST,
            metadata: {},
        };
        const deployManagedApp = jest.fn(async () => ({
            namespace: 'app-demo',
            deployment: 'demo',
            imageDigest: TEST_IMAGE_DIGEST,
            verification: {
                imageDigest: true,
                rollout: true,
                tls: false,
                https: true,
            },
            rollout: {
                ok: true,
            },
        }));

        const store = {
            isAvailable: () => true,
            listBuildRunsForApp: jest.fn(async () => ([buildRun])),
            updateApp: jest.fn()
                .mockResolvedValueOnce({
                    ...healedApp,
                    metadata: {
                        ...healedApp.metadata,
                        deploymentTarget: 'ssh',
                    },
                })
                .mockResolvedValueOnce({
                    ...healedApp,
                    status: 'live',
                    metadata: {
                        ...healedApp.metadata,
                        deploymentTarget: 'ssh',
                        lastImage: 'gitea.demoserver2.buzz/agent-apps/demo:sha-abcdef123456',
                    },
                }),
            updateBuildRun: jest.fn(async (_id, updates) => ({
                ...buildRun,
                ...updates,
            })),
        };

        const service = new ManagedAppService({
            store,
            kubernetesClient: {
                isConfigured: jest.fn((target) => target === 'ssh'),
                deployManagedApp,
            },
        });

        service.resolveApp = jest.fn(async () => app);
        service.getEffectiveGiteaConfig = () => ({
            registryHost: 'gitea.demoserver2.buzz',
            registryUsername: 'builder',
            registryPassword: 'secret',
        });
        service.getEffectiveManagedAppsConfig = () => ({
            namespacePrefix: 'app-',
            defaultContainerPort: 80,
            registryPullSecretName: 'gitea-registry-credentials',
        });
        service.recordClusterDeployment = jest.fn();
        service.broadcastLifecycleEvent = jest.fn();

        const result = await service.deployApp('demo', {}, 'user-1', {
            executionProfile: 'remote-build',
            sessionId: 'session-1',
        });

        expect(store.updateApp).toHaveBeenNthCalledWith(1, 'app-1', 'user-1', expect.objectContaining({
            namespace: 'app-demo',
        }));
        expect(deployManagedApp).toHaveBeenCalledWith(expect.objectContaining({
            namespace: 'app-demo',
            deploymentTarget: 'ssh',
        }));
        expect(result.app.namespace).toBe('app-demo');
    });
});
