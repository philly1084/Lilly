'use strict';

const express = require('express');
const request = require('supertest');

const toolsRouter = require('./tools');
const { remoteRunnerService } = require('../remote-runner/service');
const { remoteCliAgentsSdkRunner } = require('../remote-cli/agents-sdk-runner');

describe('/api/tools routes', () => {
    let originalRemoteCliConfig;

    beforeEach(() => {
        originalRemoteCliConfig = remoteCliAgentsSdkRunner.config;
        remoteRunnerService.runners.clear();
    });

    afterEach(() => {
        remoteCliAgentsSdkRunner.config = originalRemoteCliConfig;
        remoteRunnerService.runners.clear();
    });

    function buildApp(options = {}) {
        const app = express();
        if (options.managedAppService) {
            app.locals.managedAppService = options.managedAppService;
        }
        app.use(express.json());
        app.use('/api/tools', toolsRouter);
        return app;
    }

    test('includeAll exposes managed-app with GitLab runtime context', async () => {
        const app = buildApp({
            managedAppService: {
                isAvailable: () => true,
            },
        });

        const response = await request(app).get('/api/tools/available?includeAll=true');

        expect(response.status).toBe(200);
        expect(response.body.meta.includeAllTools).toBe(true);
        expect(response.body.data.map((tool) => tool.id)).toContain('managed-app');
        expect(response.body.meta.runtime.managedApps).toBeDefined();
        expect(response.body.meta.runtime.remoteRunner).toBeDefined();
    });

    test('default frontend catalog keeps managed-app hidden from end-user surfaces', async () => {
        const app = buildApp();

        const response = await request(app).get('/api/tools/available');

        expect(response.status).toBe(200);
        expect(response.body.meta.includeAllTools).toBe(false);
        expect(response.body.data.map((tool) => tool.id)).not.toContain('managed-app');
    });

    test('podcast-video catalog excludes remote-build tools', async () => {
        const app = buildApp();

        const response = await request(app).get('/api/tools/available?taskType=podcast-video');

        expect(response.status).toBe(200);
        expect(response.body.meta.executionProfile).toBe('podcast-video');
        expect(response.body.data.map((tool) => tool.id)).toEqual(expect.arrayContaining([
            'web-fetch',
            'web-scrape',
            'image-generate',
        ]));
        expect(response.body.data.map((tool) => tool.id)).not.toContain('remote-command');
        expect(response.body.data.map((tool) => tool.id)).not.toContain('remote-workbench');
        expect(response.body.data.map((tool) => tool.id)).not.toContain('remote-cli-agent');
        expect(response.body.data.map((tool) => tool.id)).not.toContain('k3s-deploy');
    });

    test('image-generate tool details expose current path and artifact-check guidance', async () => {
        const app = buildApp();

        const response = await request(app).get('/api/tools/image-generate');

        expect(response.status).toBe(200);
        expect(response.body.data.docAvailable).toBe(true);
        expect(response.body.data.description).toContain('current OpenAI-compatible image path');
        expect(response.body.data.support.notes).toEqual(expect.arrayContaining([
            expect.stringContaining('gateway-first OpenAI-compatible image generation path'),
            expect.stringContaining('verify usableCount/artifacts/markdownImages'),
        ]));
        expect(response.body.data.runtime.requestTimeoutMs).toBeGreaterThanOrEqual(900000);
        expect(response.body.data.runtime.callerContract).toEqual(expect.arrayContaining([
            expect.stringContaining('websites, HTML, documents, PDFs, or presentations'),
            expect.stringContaining('several minutes'),
            expect.stringContaining('usableCount, artifacts/artifactIds, or markdownImages'),
        ]));
        expect(response.body.data.skill.triggerPatterns).toEqual(expect.arrayContaining([
            'website visual',
            'html visual',
            'document visual',
        ]));
    });

    test('remote-command tool details report runner target availability', async () => {
        const app = buildApp();

        const response = await request(app).get('/api/tools/remote-command');

        expect(response.status).toBe(200);
        expect(response.body.data.runtime.source).toBeDefined();
        expect(response.body.data.runtime.runnerAvailable).toBe(false);
        expect(response.body.data.runtime.commandCatalog).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'repo-map' }),
            expect.objectContaining({ id: 'changed-files' }),
            expect.objectContaining({ id: 'dependency-check' }),
            expect.objectContaining({ id: 'k8s-manifest-summary' }),
            expect.objectContaining({ id: 'focused-test' }),
            expect.objectContaining({ id: 'ui-visual-check' }),
            expect.objectContaining({ id: 'deploy-verify' }),
        ]));
    });

    test('remote-command tool details expose online runner CLI inventory', async () => {
        const app = buildApp();
        remoteRunnerService.registerRunner({
            runnerId: 'server-runner',
            capabilities: ['inspect', 'deploy'],
            metadata: {
                defaultCwd: '/srv/kimibuilt',
                shell: '/bin/bash',
                cliTools: [
                    { name: 'kubectl', available: true, path: '/usr/local/bin/kubectl' },
                    { name: 'git', available: true, path: '/usr/bin/git' },
                    { name: 'rg', available: false, path: '' },
                ],
                browserAutomation: {
                    playwrightPackage: 'playwright-core',
                    playwrightVersion: '1.53.0',
                    browserExecutablePath: '/usr/bin/chromium',
                    screenshotReady: true,
                    uiCheckCommand: 'node /app/bin/kimibuilt-ui-check.js',
                },
            },
        }, { readyState: 1, send: jest.fn() });

        const response = await request(app).get('/api/tools/remote-command');

        expect(response.status).toBe(200);
        expect(response.body.data.runtime.runnerAvailable).toBe(true);
        expect(response.body.data.runtime.availableCliTools).toEqual(expect.arrayContaining(['kubectl', 'git']));
        expect(response.body.data.runtime.cliTools).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'kubectl', path: '/usr/local/bin/kubectl' }),
            expect.objectContaining({ name: 'rg', available: false }),
        ]));
        expect(response.body.data.runtime.runner.browserAutomation).toEqual(expect.objectContaining({
            screenshotReady: true,
            uiCheckCommand: 'node /app/bin/kimibuilt-ui-check.js',
        }));
        expect(response.body.meta.runtime.remoteRunner.browserAutomation).toEqual(expect.objectContaining({
            screenshotReady: true,
        }));
        expect(response.body.meta.runtime.remoteRunner.availableCliTools).toEqual(expect.arrayContaining(['kubectl', 'git']));
    });

    test('remote-workbench tool details expose structured actions and runner inventory', async () => {
        const app = buildApp();
        remoteRunnerService.registerRunner({
            runnerId: 'server-runner',
            capabilities: ['inspect', 'build', 'deploy'],
            metadata: {
                defaultCwd: '/srv/kimibuilt',
                shell: '/bin/bash',
                availableCliTools: ['kubectl', 'git'],
            },
        }, { readyState: 1, send: jest.fn() });

        const response = await request(app).get('/api/tools/remote-workbench');

        expect(response.status).toBe(200);
        expect(response.body.data.support.status).toBe('stable');
        expect(response.body.data.support.notes.join('\n')).toContain('Remote workbench server-runner is online');
        expect(response.body.data.runtime.runnerAvailable).toBe(true);
        expect(response.body.data.runtime.structuredActions).toEqual(expect.arrayContaining([
            'grep',
            'git-prepare',
            'git-snapshot',
            'git-commit',
            'git-revert',
            'read-file',
            'write-file',
            'apply-patch',
            'build',
            'ui-visual-check',
            'deploy-verify',
        ]));
        expect(response.body.data.runtime.availableCliTools).toEqual(expect.arrayContaining(['kubectl', 'git']));
    });

    test('k3s-deploy tool details expose verification-oriented command catalog entries', async () => {
        const app = buildApp();

        const response = await request(app).get('/api/tools/k3s-deploy');

        expect(response.status).toBe(200);
        expect(response.body.data.runtime.commandCatalog).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'k8s-app-inventory' }),
            expect.objectContaining({ id: 'pod-debug' }),
            expect.objectContaining({ id: 'deploy-verify' }),
        ]));
    });

    test('remote-build catalog surfaces deploy runner feedback for remote-cli-agent and k3s-deploy', async () => {
        const app = buildApp();
        remoteRunnerService.registerRunner({
            runnerId: 'k3s-builder',
            capabilities: ['inspect', 'build', 'deploy', 'admin'],
            metadata: {
                defaultCwd: '/workspace',
                shell: '/bin/bash',
                buildkitHostConfigured: true,
                kubernetesConfigured: true,
                imagePrefix: 'registry.gitlab.demoserver2.buzz/agent-apps',
                cliTools: [
                    { name: 'git', available: true, path: '/usr/bin/git' },
                    { name: 'buildctl', available: true, path: '/usr/bin/buildctl' },
                    { name: 'kubectl', available: true, path: '/usr/bin/kubectl' },
                ],
            },
        }, { readyState: 1, send: jest.fn() });

        const response = await request(app).get('/api/tools/available?executionProfile=remote-build');

        expect(response.status).toBe(200);
        const remoteAgent = response.body.data.find((tool) => tool.id === 'remote-cli-agent');
        const k3sDeploy = response.body.data.find((tool) => tool.id === 'k3s-deploy');
        const managedApp = response.body.data.find((tool) => tool.id === 'managed-app');

        expect(managedApp).toBeDefined();
        expect(managedApp.runtime.observability).toBe('gitlab-repo-pipeline-build-events');
        expect(remoteAgent).toBeDefined();
        expect(k3sDeploy).toBeDefined();
        expect(remoteAgent.description).toContain('/api/codex-agent/run');
        expect(remoteAgent.support.notes.join('\n')).toContain('GIT_BRANCH');
        expect(remoteAgent.support.notes.join('\n')).toContain('/events SSE');
        expect(remoteAgent.runtime.runnerAvailable).toBe(true);
        expect(remoteAgent.runtime.k3sFeedback).toEqual(expect.objectContaining({
            runnerReady: true,
            buildkitReady: true,
            kubernetesReady: true,
            imagePushReady: true,
            buildToK3sReady: true,
            imagePrefix: 'registry.gitlab.demoserver2.buzz/agent-apps',
        }));
        expect(remoteAgent.runtime.k3sFeedback.availableCliTools).toEqual(expect.arrayContaining([
            'git',
            'buildctl',
            'kubectl',
        ]));
        expect(k3sDeploy.runtime.k3sFeedback.buildToK3sReady).toBe(true);
    });

    test('runner-backed remote service tools clear setup warning when live runtime support is ready', async () => {
        const app = buildApp();
        remoteCliAgentsSdkRunner.config = {
            ...originalRemoteCliConfig,
            enabled: true,
            transport: 'mcp',
            url: 'https://gateway.example.test/mcp',
            apiKey: 'test-token',
            defaultTargetId: 'prod',
            defaultCwd: '/workspace',
        };
        remoteRunnerService.registerRunner({
            runnerId: 'remote-service-runner',
            capabilities: ['inspect', 'build', 'deploy', 'admin'],
            metadata: {
                defaultCwd: '/workspace',
                shell: '/bin/bash',
                buildkitHostConfigured: true,
                kubernetesConfigured: true,
                imagePrefix: 'registry.gitlab.demoserver2.buzz/agent-apps',
                cliTools: [
                    { name: 'git', available: true, path: '/usr/bin/git' },
                    { name: 'buildctl', available: true, path: '/usr/bin/buildctl' },
                    { name: 'kubectl', available: true, path: '/usr/bin/kubectl' },
                ],
            },
        }, { readyState: 1, send: jest.fn() });

        const response = await request(app).get('/api/tools/available?includeAll=true');

        expect(response.status).toBe(200);
        const toolsById = new Map(response.body.data.map((tool) => [tool.id, tool]));
        [
            'remote-command',
            'remote-workbench',
            'remote-cli-agent',
            'k3s-deploy',
        ].forEach((toolId) => {
            const tool = toolsById.get(toolId);
            expect(tool).toBeDefined();
            expect(tool.requiresSetup).toBe(false);
            expect(tool.support.status).toBe('stable');
        });
        expect(toolsById.get('remote-command').support.notes.join('\n')).not.toContain('Requires SSH');
        expect(toolsById.get('k3s-deploy').support.notes.join('\n')).not.toContain('Requires SSH');
    });

    test('k3s feedback reports missing build and deploy prerequisites', async () => {
        const app = buildApp();
        remoteRunnerService.registerRunner({
            runnerId: 'inspect-only',
            capabilities: ['inspect', 'deploy'],
            metadata: {
                defaultCwd: '/workspace',
                shell: '/bin/bash',
                cliTools: [
                    { name: 'git', available: true, path: '/usr/bin/git' },
                    { name: 'kubectl', available: false, path: '' },
                ],
            },
        }, { readyState: 1, send: jest.fn() });

        const response = await request(app).get('/api/tools/k3s-deploy');

        expect(response.status).toBe(200);
        expect(response.body.data.runtime.k3sFeedback).toEqual(expect.objectContaining({
            runnerReady: true,
            buildkitReady: false,
            kubernetesReady: false,
            buildToK3sReady: false,
        }));
        expect(response.body.data.runtime.k3sFeedback.blockers).toEqual(expect.arrayContaining([
            'Runner did not report buildctl.',
            'Runner did not report BUILDKIT_HOST.',
            'Runner did not report kubectl.',
            'Runner did not report Kubernetes configuration.',
            'Runner did not report DIRECT_CLI_IMAGE_PREFIX.',
        ]));
    });

    test('managed-app details are available for the GitLab control plane', async () => {
        const app = buildApp();

        const details = await request(app).get('/api/tools/managed-app');
        expect(details.status).toBe(200);
        expect(details.body.data.id).toBe('managed-app');
        expect(details.body.data.runtime.observability).toBe('gitlab-repo-pipeline-build-events');
    });
});
