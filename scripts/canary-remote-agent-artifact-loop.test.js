'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const {
    AUTHORING_CANARY_VERSION,
    buildAuthoringPlan,
    buildLanePlan,
    createHttpClient,
    createFixtures,
    runBrowserQa,
    runPublicBrowserQa,
    runCanary,
    validateAuthoredArtifactSet,
    validateAuthoredPreview,
    validateCompactToolResult,
    validatePreflight,
    validateRunExecutionEvidence,
    validateRunIdentity,
} = require('./canary-remote-agent-artifact-loop');

const OCI_DIGEST = `sha256:${'a'.repeat(64)}`;
const CONFLICTING_OCI_DIGEST = `sha256:${'b'.repeat(64)}`;
const MANAGED_APP_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const MANAGED_APP_PIPELINE_URL = 'https://gitlab.demoserver2.buzz/agent-apps/remote-agent-canary/-/pipelines/42';

function jsonResponse(payload, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
    });
}

function bufferResponse(buffer, contentType = 'application/octet-stream') {
    return new Response(buffer, { status: 200, headers: { 'Content-Type': contentType } });
}

function buildCompactResult(plan, prefix) {
    const provider = plan.lane === 'kimi'
        ? 'kimi-code-cli'
        : (plan.lane === 'grok' ? 'grok-build-cli' : null);
    const providerModel = plan.lane === 'kimi'
        ? 'k3'
        : (plan.lane === 'grok' ? 'grok-build' : null);
    const resultFiles = plan.fixtures.map((fixture, index) => ({
        artifactId: `artifact-${prefix}-component-${index + 1}`,
        filename: fixture.filename,
        relativePath: `${plan.outputRoot}/${fixture.outputPath}`,
        mimeType: fixture.mimeType,
        role: fixture.role,
        sizeBytes: fixture.sizeBytes,
        sha256: fixture.sha256,
    }));
    const siteBundleArtifactId = `artifact-${prefix}-site-bundle`;
    return {
        adapter: 'remote-cli-agent',
        success: true,
        completionStatus: 'completed',
        ...(provider ? { provider } : {}),
        ...(providerModel ? { providerModel } : {}),
        model: plan.model,
        transport: plan.transport,
        artifactIds: [...resultFiles.map((file) => file.artifactId), siteBundleArtifactId],
        resultFiles,
        siteBundleArtifactId,
        artifactQuality: {
            version: 'ArtifactStructuralQuality/v1',
            status: 'passed',
            blockers: [],
            site: { enabled: true, entries: [`${plan.outputRoot}/index.html`], checkedReferences: 3 },
        },
        artifacts: [
            ...resultFiles.map((file) => ({
                id: file.artifactId,
                filename: file.filename,
                mimeType: file.mimeType,
                downloadUrl: `/api/artifacts/${file.artifactId}/download`,
            })),
            {
                id: siteBundleArtifactId,
                filename: 'remote-agent-site.zip',
                mimeType: 'application/zip',
                downloadUrl: `/api/artifacts/${siteBundleArtifactId}/download`,
                bundleDownloadUrl: `/api/artifacts/${siteBundleArtifactId}/bundle`,
                previewUrl: `/api/artifacts/${siteBundleArtifactId}/preview`,
            },
        ],
    };
}

function createAuthoredFiles(plan) {
    const contentByPath = {
        'index.html': [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="utf-8">',
            '  <meta name="viewport" content="width=device-width, initial-scale=1">',
            `  <meta name="remote-agent-authoring-canary" content="${AUTHORING_CANARY_VERSION}">`,
            `  <title>${plan.lane} Original Authoring Canary</title>`,
            '  <link rel="stylesheet" href="./styles.css">',
            '</head>',
            `<body data-canary-lane="${plan.lane}" data-canary-scenario="authoring">`,
            '  <main>',
            `    <h1>${plan.lane} original static site</h1>`,
            '    <p>A locally authored responsive artifact with XML and SVG design context.</p>',
            '    <img src="./design/design.svg" alt="Layered geometric authoring illustration">',
            '    <a href="./design/design.xml">Read the design contract</a>',
            '  </main>',
            '</body>',
            '</html>',
            '',
        ].join('\n'),
        'styles.css': [
            `/* ${AUTHORING_CANARY_VERSION} */`,
            `/* canary-lane: ${plan.lane} */`,
            '/* canary-scenario: authoring */',
            ':root { --paper: #f8fafc; --ink: #172033; --accent: #1649a5; }',
            '* { box-sizing: border-box; }',
            'body { margin: 0; background-color: var(--paper); color: var(--ink); font: 16px/1.6 system-ui, sans-serif; }',
            'main { width: min(100% - 2rem, 58rem); max-width: 58rem; margin: 3rem auto; padding: 2rem; background: #ffffff; }',
            'img { display: block; width: 100%; height: auto; }',
            'a { color: var(--accent); }',
            'a:focus-visible { outline: 3px solid #d97706; outline-offset: 3px; }',
            '@media (max-width: 600px) { main { margin: 1rem auto; padding: 1rem; } }',
            '',
        ].join('\n'),
        'design/design.xml': [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<remote-agent-authoring-canary version="1" lane="${plan.lane}" scenario="authoring">`,
            `  <contract>${AUTHORING_CANARY_VERSION}</contract>`,
            '  <design><layout>responsive-card</layout><artwork>layered-geometry</artwork></design>',
            '</remote-agent-authoring-canary>',
            '',
        ].join('\n'),
        'design/design.svg': [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" role="img" aria-labelledby="title desc" data-canary-version="${AUTHORING_CANARY_VERSION}" data-canary-lane="${plan.lane}" data-canary-scenario="authoring">`,
            `  <title id="title">${plan.lane} authoring layers</title>`,
            '  <desc id="desc">Three offset geometric panels connected by a bright path.</desc>',
            '  <rect width="640" height="320" rx="32" fill="#172033"/>',
            '  <path d="M80 240L240 80L400 240L560 80" fill="none" stroke="#7dd3fc" stroke-width="18"/>',
            '</svg>',
            '',
        ].join('\n'),
    };
    return plan.files.map((definition) => {
        const buffer = Buffer.from(contentByPath[definition.outputPath], 'utf8');
        return {
            definition,
            buffer,
            descriptor: {
                filename: definition.filename,
                relativePath: `${plan.outputRoot}/${definition.outputPath}`,
                mimeType: definition.mimeType,
                role: definition.role,
                sizeBytes: buffer.length,
                sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            },
        };
    });
}

function buildAuthoredCompactResult(plan, prefix, authoredFiles) {
    const provider = plan.lane === 'kimi'
        ? 'kimi-code-cli'
        : (plan.lane === 'grok' ? 'grok-build-cli' : null);
    const providerModel = plan.lane === 'kimi'
        ? 'k3'
        : (plan.lane === 'grok' ? 'grok-build' : null);
    const resultFiles = authoredFiles.map((file, index) => ({
        ...file.descriptor,
        artifactId: `artifact-${prefix}-component-${index + 1}`,
    }));
    const siteBundleArtifactId = `artifact-${prefix}-site-bundle`;
    return {
        adapter: 'remote-cli-agent',
        success: true,
        completionStatus: 'completed',
        ...(provider ? { provider } : {}),
        ...(providerModel ? { providerModel } : {}),
        model: plan.model,
        transport: plan.transport,
        artifactIds: [...resultFiles.map((file) => file.artifactId), siteBundleArtifactId],
        resultFiles,
        siteBundleArtifactId,
        artifactQuality: {
            version: 'ArtifactStructuralQuality/v1',
            status: 'passed',
            blockers: [],
            site: { enabled: true, entries: [`${plan.outputRoot}/index.html`], checkedReferences: 3 },
        },
        artifacts: [
            ...resultFiles.map((file) => ({
                id: file.artifactId,
                filename: file.filename,
                mimeType: file.mimeType,
                downloadUrl: `/api/artifacts/${file.artifactId}/download`,
            })),
            {
                id: siteBundleArtifactId,
                filename: 'remote-agent-authored-site.zip',
                mimeType: 'application/zip',
                bundleDownloadUrl: `/api/artifacts/${siteBundleArtifactId}/bundle`,
                previewUrl: `/api/artifacts/${siteBundleArtifactId}/preview`,
            },
        ],
    };
}

function managedAppFingerprintFromRequest(body, artifactId) {
    return {
        artifactId,
        contentEligible: true,
        controlPlaneAvailable: true,
        pushToWebEligible: true,
        sourceType: 'native-site-archive',
        fileCount: body.expectedFiles.length,
        sizeBytes: body.expectedFiles.reduce((total, file) => total + file.sizeBytes, 0),
        sha256: body.expectedSourceSha256,
        files: body.expectedFiles.map((file) => ({
            path: `public/${file.path}`,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
        })).sort((left, right) => left.path.localeCompare(right.path)),
        blockers: [],
    };
}

function managedAppFingerprintFromAuthoredFiles(authoredFiles) {
    const files = authoredFiles.map((file) => ({
        path: `public/${file.definition.outputPath}`,
        buffer: file.buffer,
    })).sort((left, right) => left.path.localeCompare(right.path));
    const aggregateHash = crypto.createHash('sha256');
    files.forEach((file) => {
        const pathBuffer = Buffer.from(file.path, 'utf8');
        aggregateHash.update(Buffer.from(`${pathBuffer.length}:`, 'utf8'));
        aggregateHash.update(pathBuffer);
        aggregateHash.update(Buffer.from(`:${file.buffer.length}:`, 'utf8'));
        aggregateHash.update(file.buffer);
    });
    return {
        sha256: aggregateHash.digest('hex'),
        sizeBytes: files.reduce((total, file) => total + file.buffer.length, 0),
        fileCount: files.length,
        paths: files.map((file) => file.path),
    };
}

async function createLiveAuthoringHarness(env) {
    const firstPlan = buildLanePlan('codex', env, { hop: 1 });
    const firstResult = buildCompactResult(firstPlan, 'author-hop-1');
    const secondPlan = buildLanePlan('codex', env, {
        hop: 2,
        sourceArtifacts: firstResult.resultFiles,
    });
    const secondResult = buildCompactResult(secondPlan, 'author-hop-2');
    const authoringPlan = buildAuthoringPlan('codex', env);
    const authoredFiles = createAuthoredFiles(authoringPlan);
    const authoringResult = buildAuthoredCompactResult(
        authoringPlan,
        'authoring',
        authoredFiles,
    );
    const runs = [
        { id: 'run-author-hop-1', plan: firstPlan, result: firstResult },
        { id: 'run-author-hop-2', plan: secondPlan, result: secondResult },
        { id: 'run-authoring', plan: authoringPlan, result: authoringResult },
    ];
    const componentById = new Map();
    runs.slice(0, 2).forEach(({ plan, result }) => {
        result.resultFiles.forEach((descriptor, index) => componentById.set(descriptor.artifactId, {
            descriptor,
            buffer: plan.fixtures[index].buffer,
        }));
    });
    authoringResult.resultFiles.forEach((descriptor, index) => componentById.set(descriptor.artifactId, {
        descriptor,
        buffer: authoredFiles[index].buffer,
    }));

    const transferZip = new JSZip();
    firstPlan.fixtures.forEach((fixture) => transferZip.file(fixture.outputPath, fixture.buffer));
    const transferZipBuffer = await transferZip.generateAsync({ type: 'nodebuffer' });
    const authoringZip = new JSZip();
    authoredFiles.forEach((file) => authoringZip.file(file.definition.outputPath, file.buffer));
    const authoringZipBuffer = await authoringZip.generateAsync({ type: 'nodebuffer' });
    const bundleById = new Map([
        [firstResult.siteBundleArtifactId, {
            zipBuffer: transferZipBuffer,
            preview: firstPlan.fixtures[0].content,
        }],
        [secondResult.siteBundleArtifactId, {
            zipBuffer: transferZipBuffer,
            preview: secondPlan.fixtures[0].content,
        }],
        [authoringResult.siteBundleArtifactId, {
            zipBuffer: authoringZipBuffer,
            preview: authoredFiles.find((file) => file.definition.outputPath === 'index.html').buffer.toString('utf8'),
        }],
    ]);
    const calls = [];
    let runPostCount = 0;
    const fetchImpl = jest.fn(async (url, options = {}) => {
        const parsed = new URL(url);
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: `${parsed.pathname}${parsed.search}`, body });
        if (method === 'GET' && parsed.pathname === '/api/auth/protected-check') {
            return jsonResponse({ success: true });
        }
        if (method === 'GET' && parsed.pathname === '/api/async-lab/status') {
            return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
        }
        if (method === 'POST' && parsed.pathname === '/api/sessions') {
            return jsonResponse({ id: 'session-authoring-canary' }, 201);
        }
        if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
            const run = runs[runPostCount];
            runPostCount += 1;
            return jsonResponse({
                run: {
                    id: run.id,
                    sessionId: 'session-authoring-canary',
                    adapter: 'remote-cli-agent',
                    status: 'queued',
                    liveRemoteAllowed: true,
                    metadata: { remoteAdapter: true, dryRun: false },
                },
                events: [],
            }, 202);
        }
        const runRecord = runs.find((run) => parsed.pathname === `/api/async-lab/runs/${run.id}`);
        if (method === 'GET' && runRecord) {
            return jsonResponse({
                run: {
                    id: runRecord.id,
                    sessionId: 'session-authoring-canary',
                    adapter: 'remote-cli-agent',
                    status: 'completed',
                    liveRemoteAllowed: true,
                    metadata: { remoteAdapter: true, dryRun: false, toolResult: runRecord.result },
                },
                events: [
                    { eventId: `${runRecord.id}-started`, cursor: 1, type: 'tool_started' },
                    { eventId: `${runRecord.id}-tool`, cursor: 2, type: 'tool_completed' },
                    { eventId: `${runRecord.id}-done`, cursor: 3, type: 'completed' },
                ],
            });
        }
        const artifactMatch = parsed.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
        if (method === 'GET' && artifactMatch) {
            const id = artifactMatch[1];
            if (!componentById.has(id) && !bundleById.has(id)) {
                throw new Error(`Unknown artifact lookup: ${id}`);
            }
            return jsonResponse({
                id,
                sessionId: 'session-authoring-canary',
                ...(componentById.has(id) ? {
                    downloadUrl: `/api/artifacts/${id}/download`,
                } : {
                    bundleDownloadUrl: `/api/artifacts/${id}/bundle`,
                    previewUrl: `/api/artifacts/${id}/preview`,
                }),
            });
        }
        const componentMatch = parsed.pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
        if (method === 'GET' && componentMatch && componentById.has(componentMatch[1])) {
            const component = componentById.get(componentMatch[1]);
            return bufferResponse(component.buffer, component.descriptor.mimeType);
        }
        const bundleMatch = parsed.pathname.match(/^\/api\/artifacts\/([^/]+)\/bundle$/);
        if (method === 'GET' && bundleMatch && bundleById.has(bundleMatch[1])) {
            return bufferResponse(bundleById.get(bundleMatch[1]).zipBuffer, 'application/zip');
        }
        const previewMatch = parsed.pathname.match(/^\/api\/artifacts\/([^/]+)\/preview$/);
        if (method === 'GET' && previewMatch && bundleById.has(previewMatch[1])) {
            const preview = bundleById.get(previewMatch[1]).preview.replace(
                '<head>',
                `<head><base href="/api/artifacts/${previewMatch[1]}/preview/">`,
            );
            return bufferResponse(Buffer.from(preview), 'text/html');
        }
        if (method === 'POST' && /\/managed-app\/preflight$/.test(parsed.pathname)) {
            const artifactId = parsed.pathname.split('/').at(-3);
            return jsonResponse(managedAppFingerprintFromRequest(body, artifactId));
        }
        if (method === 'DELETE' && parsed.pathname === '/api/sessions/session-authoring-canary') {
            return jsonResponse(null, 204);
        }
        throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
    });
    return {
        firstPlan,
        firstResult,
        secondPlan,
        secondResult,
        authoringPlan,
        authoredFiles,
        authoringResult,
        calls,
        fetchImpl,
    };
}

function buildPushToWebEnv(overrides = {}) {
    const hostTemplate = 'remote-agent-{lane}-authoring-canary.demoserver2.buzz';
    return {
        KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
        KIMIBUILT_FRONTEND_API_KEY: 'push-to-web-api-key',
        KIMIBUILT_CANARY_CODEX_MODEL: 'codex-push-to-web-canary',
        KIMIBUILT_CANARY_POLL_INTERVAL_MS: '100',
        ALLOW_PROD_WRITE: 'yes',
        HUMAN_APPROVED: 'yes',
        CHANGE_TICKET: 'CHG-REMOTE-AGENT-CANARY-1',
        KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE: hostTemplate,
        KIMIBUILT_CANARY_APPROVED_HOST_TEMPLATE: hostTemplate,
        ...overrides,
    };
}

function buildManagedAppProgressPayload(harness, host, options = {}) {
    const publicUrl = `https://${host}`;
    const committedPaths = harness.authoredFiles.map((file) => `public/${file.definition.outputPath}`);
    const fingerprint = managedAppFingerprintFromAuthoredFiles(harness.authoredFiles);
    const sourceSha256 = options.sourceSha256 || fingerprint.sha256;
    const commitSha = options.commitSha || MANAGED_APP_COMMIT_SHA;
    const buildRunId = options.buildRunId || 'build-push-canary';
    const pipelineUrl = options.pipelineUrl || MANAGED_APP_PIPELINE_URL;
    const pipelineId = options.pipelineId || '42';
    const observedDigest = options.observedDigest || OCI_DIGEST;
    const buildDigest = options.buildDigest || OCI_DIGEST;
    const deployedDigest = options.deployedDigest || OCI_DIGEST;
    const deployedImage = options.deployedImage
        || `registry.demoserver2.buzz/agent-apps/remote-agent-canary@${deployedDigest}`;
    const requestedImage = 'registry.demoserver2.buzz/agent-apps/remote-agent-canary:sha-abcdef123456';
    const terminal = options.terminal !== false;
    const live = terminal && options.phase !== 'deploy_failed';
    const rollout = options.rollout !== false;
    const https = options.https !== false;
    const requiredProof = {
        sourceChanged: true,
        gitlabPipelineObserved: true,
        imageAvailable: true,
        deploymentObserved: true,
        publicVerificationObserved: live && https,
        ...(options.requiredProof || {}),
    };
    const phase = options.phase || (terminal ? 'live' : 'deploying');
    const evidence = {
        commitSha,
        committedPaths,
        pipelineUrl,
        pipelineStatus: live ? 'success' : 'running',
        imageTag: 'sha-abcdef123456',
        imageDigest: buildDigest,
        observedImageDigest: observedDigest,
        requestedImage,
        deployedImage,
        observedDeploymentImage: deployedImage,
        observedPodImage: deployedImage,
        deployStatus: live ? 'succeeded' : 'pending',
        verificationStatus: live && https ? 'live' : 'pending',
        targetPublicHost: host,
        publicUrl: live && https ? publicUrl : '',
        livePublicUrl: live && https ? publicUrl : '',
        requiredProof,
    };
    return {
        app: {
            id: 'managed-app-push-canary',
            slug: 'remote-agent-codex-authoring-canary',
            repoOwner: 'agent-apps',
            repoName: 'remote-agent-canary',
            repoUrl: 'https://gitlab.demoserver2.buzz/agent-apps/remote-agent-canary.git',
            publicHost: host,
            status: live ? 'live' : phase,
            metadata: {
                sourceArtifact: {
                    id: 'artifact-authoring-site-bundle',
                    sha256: sourceSha256,
                    sizeBytes: fingerprint.sizeBytes,
                    fileCount: fingerprint.fileCount,
                },
                liveDeploy: {
                    imageDigest: deployedDigest,
                    observedImageDigest: observedDigest,
                    requestedImage,
                    lastImage: requestedImage,
                    deployedImage,
                    observedDeploymentImage: deployedImage,
                    observedPodImage: deployedImage,
                    rollout: live && rollout,
                    https: live && https,
                },
            },
        },
        latestBuildRun: {
            id: buildRunId,
            commitSha,
            imageTag: 'sha-abcdef123456',
            imageDigest: buildDigest,
            buildStatus: live ? 'success' : 'running',
            deployStatus: live ? 'succeeded' : 'pending',
            verificationStatus: live && https ? 'live' : 'pending',
            externalRunId: pipelineId,
            externalRunUrl: pipelineUrl,
            metadata: {
                committedPaths,
                deployment: {
                    imageDigest: deployedDigest,
                    image: deployedImage,
                    deployedImage,
                    deploymentImage: deployedImage,
                    podImage: deployedImage,
                    verification: {
                        rollout: live && rollout,
                        https: live && https,
                    },
                },
            },
        },
        project: {
            phase,
            publicHost: host,
            targetPublicHost: host,
            publicUrl: live && https ? publicUrl : '',
            livePublicUrl: live && https ? publicUrl : '',
            publicVerificationObserved: live && https,
        },
        progress: {
            phase,
            terminal,
            evidence,
        },
    };
}

async function createPushToWebHarness(env, options = {}) {
    const harness = await createLiveAuthoringHarness(env);
    const fingerprint = managedAppFingerprintFromAuthoredFiles(harness.authoredFiles);
    const publicHost = String(env.KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE)
        .replace('{lane}', 'codex');
    const progressPayloads = options.progressPayloads || [
        buildManagedAppProgressPayload(harness, publicHost, {
            terminal: false,
            sourceSha256: fingerprint.sha256,
        }),
        buildManagedAppProgressPayload(harness, publicHost, {
            sourceSha256: fingerprint.sha256,
        }),
    ];
    let progressIndex = 0;
    const fetchImpl = jest.fn(async (url, requestOptions = {}) => {
        const parsed = new URL(url);
        const method = requestOptions.method || 'GET';
        const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
        if (method === 'POST'
            && parsed.pathname === '/api/artifacts/artifact-authoring-site-bundle/managed-app') {
            harness.calls.push({ method, path: parsed.pathname, body });
            const acceptedSourceSha256 = options.deploymentSourceSha256 || body.expectedSourceSha256;
            return jsonResponse({
                artifactId: 'artifact-authoring-site-bundle',
                fileCount: harness.authoredFiles.length,
                files: harness.authoredFiles.map((file) => `public/${file.definition.outputPath}`),
                sourceSha256: acceptedSourceSha256,
                sourceSizeBytes: fingerprint.sizeBytes,
                publicHost: body.publicHost,
                app: {
                    id: 'managed-app-push-canary',
                    slug: 'remote-agent-codex-authoring-canary',
                    repoOwner: 'agent-apps',
                    repoName: 'remote-agent-canary',
                    repoUrl: 'https://gitlab.demoserver2.buzz/agent-apps/remote-agent-canary.git',
                    publicHost: body.publicHost,
                    metadata: {
                        sourceArtifact: {
                            id: 'artifact-authoring-site-bundle',
                            sha256: acceptedSourceSha256,
                            sizeBytes: fingerprint.sizeBytes,
                            fileCount: fingerprint.fileCount,
                        },
                    },
                },
                buildRun: {
                    id: 'build-push-canary',
                    commitSha: MANAGED_APP_COMMIT_SHA,
                    imageTag: 'sha-abcdef123456',
                    buildStatus: 'queued',
                    metadata: { committedPaths: fingerprint.paths },
                },
                deploymentLifecycle: {
                    mode: 'build-webhook',
                    status: 'queued',
                    buildRunId: 'build-push-canary',
                    commitSha: MANAGED_APP_COMMIT_SHA,
                    deployRequested: true,
                    digestRequired: true,
                },
                ...(options.includePrematureAsyncRun ? {
                    asyncRuntime: {
                        run: { id: 'run-managed-app-push-canary' },
                    },
                } : {}),
            }, 202);
        }
        if (method === 'GET'
            && parsed.pathname === '/api/managed-apps/managed-app-push-canary/progress') {
            harness.calls.push({ method, path: parsed.pathname, body });
            const payload = progressPayloads[Math.min(progressIndex, progressPayloads.length - 1)];
            progressIndex += 1;
            return jsonResponse(payload);
        }
        return harness.fetchImpl(url, requestOptions);
    });
    return {
        ...harness,
        fetchImpl,
        publicHost,
        progressPayloads,
    };
}

describe('remote agent artifact-loop canary', () => {
    test('defaults to a deterministic two-hop, three-lane dry run with zero network requests', async () => {
        const fetchImpl = jest.fn(() => {
            throw new Error('dry-run must not call fetch');
        });
        const result = await runCanary({ argv: [], env: {}, fetchImpl });

        expect(result).toEqual(expect.objectContaining({
            version: 'RemoteAgentArtifactLoopCanary/v1',
            mode: 'all',
            execution: 'dry-run',
            passed: true,
            networkRequestsMade: 0,
        }));
        expect(result.lanes.map((lane) => lane.lane)).toEqual(['codex', 'kimi', 'grok']);
        expect(result.lanes.every((lane) => lane.bidirectionalRoundTripPlanned && lane.hops.length === 2)).toBe(true);
        expect(result.lanes.every((lane) => lane.hops.every((hop) => hop.payloadValid && hop.adminMode === false))).toBe(true);
        expect(result.lanes.every((lane) => lane.hops.every((hop) => hop.fixtureCount === 4))).toBe(true);
        expect(result.lanes[0].hops[0].inputMode).toBe('inline-fixtures');
        expect(result.lanes[0].hops[1].inputMode).toBe('session-artifacts');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('<!doctype html>');
    });

    test('plans the explicit output-only authoring and optional browser QA scenario without network access', async () => {
        const fetchImpl = jest.fn(() => {
            throw new Error('authoring dry-run must not call fetch');
        });
        const result = await runCanary({
            argv: ['--mode=kimi', '--authoring', '--browser-qa'],
            env: {},
            fetchImpl,
        });

        expect(result).toEqual(expect.objectContaining({
            mode: 'kimi',
            execution: 'dry-run',
            networkRequestsMade: 0,
            authoringScenario: 'planned',
        }));
        expect(result.lanes[0].authoring).toEqual(expect.objectContaining({
            lane: 'kimi',
            scenario: 'authoring',
            version: AUTHORING_CANARY_VERSION,
            inputMode: 'none-output-only',
            inputArtifactCount: 0,
            resultFileCount: 4,
            browserQaPlanned: true,
            payloadValid: true,
        }));
        expect(result.lanes[0].authoring.files.map((file) => file.outputPath)).toEqual([
            'index.html',
            'styles.css',
            'design/design.xml',
            'design/design.svg',
        ]);
        expect(result.lanes[0].authoring.files.map((file) => file.role)).toEqual([
            'site-entry',
            'site-file',
            'site-file',
            'site-file',
        ]);
        expect(fetchImpl).not.toHaveBeenCalled();
        await expect(runCanary({ argv: ['--browser-qa'], env: {}, fetchImpl })).rejects.toThrow(
            '--browser-qa requires --authoring.',
        );
    });

    test('fails closed before network unless every Push-to-Web execution and approval gate is exact', async () => {
        const completeArgs = ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'];
        const completeEnv = buildPushToWebEnv();
        const cases = [
            {
                name: 'missing run',
                argv: ['--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
                env: completeEnv,
                error: '--push-to-web requires --run --authoring --browser-qa.',
            },
            {
                name: 'missing authoring',
                argv: ['--run', '--mode=codex', '--browser-qa', '--push-to-web'],
                env: completeEnv,
                error: '--push-to-web requires --run --authoring --browser-qa.',
            },
            {
                name: 'missing browser QA',
                argv: ['--run', '--mode=codex', '--authoring', '--push-to-web'],
                env: completeEnv,
                error: '--push-to-web requires --run --authoring --browser-qa.',
            },
            {
                name: 'missing production write gate',
                argv: completeArgs,
                env: { ...completeEnv, ALLOW_PROD_WRITE: '' },
                error: 'Push-to-Web canary requires ALLOW_PROD_WRITE=yes.',
            },
            {
                name: 'missing human approval',
                argv: completeArgs,
                env: { ...completeEnv, HUMAN_APPROVED: '' },
                error: 'Push-to-Web canary requires HUMAN_APPROVED=yes.',
            },
            {
                name: 'invalid change ticket',
                argv: completeArgs,
                env: { ...completeEnv, CHANGE_TICKET: 'bad ticket' },
                error: 'Push-to-Web canary requires a valid CHANGE_TICKET.',
            },
            {
                name: 'mismatched host approval',
                argv: completeArgs,
                env: {
                    ...completeEnv,
                    KIMIBUILT_CANARY_APPROVED_HOST_TEMPLATE: 'different-{lane}.demoserver2.buzz',
                },
                error: 'Push-to-Web canary requires an exact approved host template match.',
            },
            {
                name: 'whitespace-normalized host approval',
                argv: completeArgs,
                env: {
                    ...completeEnv,
                    KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE: ` ${completeEnv.KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE}`,
                },
                error: 'Push-to-Web canary requires an exact approved host template match.',
            },
            {
                name: 'non-templated host',
                argv: completeArgs,
                env: {
                    ...completeEnv,
                    KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE: 'single-host.demoserver2.buzz',
                    KIMIBUILT_CANARY_APPROVED_HOST_TEMPLATE: 'single-host.demoserver2.buzz',
                },
                error: 'Push-to-Web host template must contain exactly one {lane} token.',
            },
        ];

        for (const testCase of cases) {
            const fetchImpl = jest.fn(() => {
                throw new Error(`${testCase.name} must fail before fetch`);
            });
            await expect(runCanary({
                argv: testCase.argv,
                env: testCase.env,
                fetchImpl,
            })).rejects.toThrow(testCase.error);
            expect(fetchImpl).not.toHaveBeenCalled();
        }
    });

    test('rejects bad authoring semantics and missing resolved provider-model evidence', () => {
        const plan = buildAuthoringPlan('kimi', {});
        const authoredFiles = createAuthoredFiles(plan);
        const compactResult = buildAuthoredCompactResult(plan, 'authoring-proof', authoredFiles);

        expect(validateCompactToolResult(plan, compactResult)).toEqual(expect.objectContaining({
            provider: 'kimi-code-cli',
            providerModel: 'k3',
            model: 'kimi-k3',
        }));
        expect(validateAuthoredArtifactSet(plan, authoredFiles)).toEqual(expect.objectContaining({
            quality: expect.objectContaining({ status: 'passed' }),
        }));

        expect(() => validateCompactToolResult(plan, {
            ...compactResult,
            provider: 'not-kimi-code-cli',
        })).toThrow('The Kimi canary did not return exact Kimi provider evidence.');
        expect(() => validateCompactToolResult(plan, {
            ...compactResult,
            adapter: 'remote-command',
        })).toThrow('The kimi compact result came from an unexpected adapter.');

        const prefixedPathResult = JSON.parse(JSON.stringify(compactResult));
        prefixedPathResult.resultFiles[0].relativePath = `unexpected-prefix/${prefixedPathResult.resultFiles[0].relativePath}`;
        expect(() => validateCompactToolResult(plan, prefixedPathResult)).toThrow(
            'The kimi result descriptor for index.html is outside the expected nested site.',
        );

        delete compactResult.providerModel;
        expect(() => validateCompactToolResult(plan, compactResult)).toThrow(
            'The Kimi canary did not attest the resolved K3 provider model.',
        );

        const badSemantics = createAuthoredFiles(plan);
        const css = badSemantics.find((file) => file.definition.outputPath === 'styles.css');
        css.buffer = Buffer.from(css.buffer.toString('utf8').replace('@media', '@supports'), 'utf8');
        expect(() => validateAuthoredArtifactSet(plan, badSemantics)).toThrow(
            'The kimi authored CSS failed marker, responsive, focus, or color semantics.',
        );

        const badNavigation = createAuthoredFiles(plan);
        const badNavigationHtml = badNavigation.find((file) => file.definition.outputPath === 'index.html');
        badNavigationHtml.buffer = Buffer.from(
            badNavigationHtml.buffer.toString('utf8').replace(
                '</main>',
                '<a href="../outside">Leave the verified site</a></main>',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badNavigation)).toThrow(
            'The kimi authored HTML included a reference outside the four-file site.',
        );

        const badActiveContent = createAuthoredFiles(plan);
        const badActiveHtml = badActiveContent.find((file) => file.definition.outputPath === 'index.html');
        badActiveHtml.buffer = Buffer.from(
            badActiveHtml.buffer.toString('utf8').replace(
                '</main>',
                '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe></main>',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badActiveContent)).toThrow(
            'The kimi authored HTML included an active element, redirect, or unexpected base element.',
        );

        const badPing = createAuthoredFiles(plan);
        const badPingHtml = badPing.find((file) => file.definition.outputPath === 'index.html');
        badPingHtml.buffer = Buffer.from(
            badPingHtml.buffer.toString('utf8').replace(
                '</main>',
                '<a href="#safe" ping="https://outside.example.test/track">Unsafe ping</a></main>',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badPing)).toThrow(
            'The kimi authored HTML included a reference outside the four-file site.',
        );

        const badAttribution = createAuthoredFiles(plan);
        const badAttributionHtml = badAttribution.find((file) => file.definition.outputPath === 'index.html');
        badAttributionHtml.buffer = Buffer.from(
            badAttributionHtml.buffer.toString('utf8').replace(
                '<img src="./design/design.svg"',
                '<img src="./design/design.svg" attributionsrc="https://outside.example.test/attrib"',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badAttribution)).toThrow(
            'The kimi authored HTML included a reference outside the four-file site.',
        );

        const badXlink = createAuthoredFiles(plan);
        const badXlinkHtml = badXlink.find((file) => file.definition.outputPath === 'index.html');
        badXlinkHtml.buffer = Buffer.from(
            badXlinkHtml.buffer.toString('utf8').replace(
                '</main>',
                '<a href="#safe" xlink:href="https://outside.example.test/image.svg">Unsafe namespaced link</a></main>',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badXlink)).toThrow(
            'The kimi authored HTML included a reference outside the four-file site.',
        );

        const badEscapedCss = createAuthoredFiles(plan);
        const badEscapedCssFile = badEscapedCss.find((file) => file.definition.outputPath === 'styles.css');
        badEscapedCssFile.buffer = Buffer.from(
            `${badEscapedCssFile.buffer.toString('utf8')}body { background-image: u\\72l(https://outside.example.test/leak.png); }\n`,
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badEscapedCss)).toThrow(
            'The kimi authored CSS included a CSS escape that could conceal a reference.',
        );

        const badImageSetCss = createAuthoredFiles(plan);
        const badImageSetCssFile = badImageSetCss.find((file) => file.definition.outputPath === 'styles.css');
        badImageSetCssFile.buffer = Buffer.from(
            `${badImageSetCssFile.buffer.toString('utf8')}body { background-image: image-set("https://outside.example.test/leak.png" 1x); }\n`,
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badImageSetCss)).toThrow(
            'The kimi authored CSS included an image function that could conceal a reference.',
        );

        const badXmlBase = createAuthoredFiles(plan);
        const badXmlBaseHtml = badXmlBase.find((file) => file.definition.outputPath === 'index.html');
        badXmlBaseHtml.buffer = Buffer.from(
            badXmlBaseHtml.buffer.toString('utf8').replace(
                '</main>',
                '<a href="#safe" xml:base="https://outside.example.test/">Unsafe base</a></main>',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badXmlBase)).toThrow(
            'The kimi authored HTML included a reference outside the four-file site.',
        );

        const badXmlStylesheet = createAuthoredFiles(plan);
        const badXmlStylesheetFile = badXmlStylesheet.find((file) => file.definition.outputPath === 'design/design.xml');
        badXmlStylesheetFile.buffer = Buffer.from(
            badXmlStylesheetFile.buffer.toString('utf8').replace(
                '?>',
                '?>\n<?xml-stylesheet href="https://outside.example.test/leak.css" type="text/css"?>',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badXmlStylesheet)).toThrow(
            'The kimi authored XML included a processing instruction or document type.',
        );

        const badXhtmlXml = createAuthoredFiles(plan);
        const badXhtmlXmlFile = badXhtmlXml.find((file) => file.definition.outputPath === 'design/design.xml');
        badXhtmlXmlFile.buffer = Buffer.from(
            badXhtmlXmlFile.buffer.toString('utf8')
                .replace(
                    '<remote-agent-authoring-canary ',
                    '<remote-agent-authoring-canary xmlns="http://www.w3.org/1999/xhtml" ',
                )
                .replace(
                    '<contract>',
                    '<style>@import url("https://outside.example.test/leak.css");</style>\n  <contract>',
                ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badXhtmlXml)).toThrow(
            'The kimi authored XML included an unsupported namespace declaration.',
        );

        const badSvgDoctype = createAuthoredFiles(plan);
        const badSvgDoctypeFile = badSvgDoctype.find((file) => file.definition.outputPath === 'design/design.svg');
        badSvgDoctypeFile.buffer = Buffer.from(
            badSvgDoctypeFile.buffer.toString('utf8').replace(
                '?>',
                '?>\n<!DOCTYPE svg SYSTEM "https://outside.example.test/leak.dtd">',
            ),
            'utf8',
        );
        expect(() => validateAuthoredArtifactSet(plan, badSvgDoctype)).toThrow(
            'The kimi authored files failed the local structural gate: REMOTE_AGENT_ARTIFACT_XML_DTD_FORBIDDEN.',
        );
    });

    test('binds accepted and completed remote runs to the exact run, session, and adapter identity', () => {
        const plan = buildLanePlan('codex', {}, { hop: 1 });
        const run = {
            id: 'run-identity-1',
            sessionId: 'session-identity-1',
            adapter: 'remote-cli-agent',
            liveRemoteAllowed: true,
            metadata: { remoteAdapter: true, dryRun: false },
        };
        const expectedIdentity = {
            expectedRunId: 'run-identity-1',
            expectedSessionId: 'session-identity-1',
        };
        const events = [
            { type: 'tool_started' },
            { type: 'tool_completed' },
        ];

        expect(validateRunIdentity(run, plan, {
            ...expectedIdentity,
            phase: 'accepted',
        })).toBe(true);
        expect(validateRunExecutionEvidence(run, events, plan, expectedIdentity)).toBe(true);
        expect(() => validateRunIdentity({ ...run, sessionId: 'session-other' }, plan, {
            ...expectedIdentity,
            phase: 'accepted',
        })).toThrow('The codex hop 1 accepted run did not match the expected run, session, and adapter identity.');
        expect(() => validateRunExecutionEvidence(
            { ...run, id: 'run-other' },
            events,
            plan,
            expectedIdentity,
        )).toThrow('The codex hop 1 completed run did not match the expected run, session, and adapter identity.');
        expect(() => validateRunExecutionEvidence(
            { ...run, adapter: 'remote-command' },
            events,
            plan,
            expectedIdentity,
        )).toThrow('The codex hop 1 completed run did not match the expected run, session, and adapter identity.');
    });

    test('routes the default Codex artifact loop through the shared provider-agent lane', () => {
        const plan = buildLanePlan('codex', {}, { hop: 1 });

        expect(plan).toEqual(expect.objectContaining({
            model: 'gpt-5.6-sol',
            transport: 'provider-agent',
        }));
    });

    test('binds authored preview and managed-app preflight to the verified bundle', () => {
        const plan = buildAuthoringPlan('codex', {});
        const authoredFiles = createAuthoredFiles(plan);
        const sourceHtml = authoredFiles.find((file) => file.definition.outputPath === 'index.html').buffer.toString('utf8');
        const expectedBase = '/api/artifacts/artifact-authoring-site-bundle/preview/';
        const previewHtml = sourceHtml.replace('<head>', `<head><base href="${expectedBase}">`);

        expect(validateAuthoredPreview(plan, sourceHtml, previewHtml, {
            expectedPreviewBaseHref: expectedBase,
        })).toEqual(expect.objectContaining({ sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
        expect(() => validateAuthoredPreview(
            plan,
            sourceHtml,
            previewHtml.replace('original static site', 'stale static site'),
            { expectedPreviewBaseHref: expectedBase },
        )).toThrow('The codex authored preview did not render the verified index document.');

        const expectedFingerprint = {
            sha256: 'a'.repeat(64),
            sizeBytes: 12,
            files: [{ path: 'public/index.html', sizeBytes: 12, sha256: 'b'.repeat(64) }],
        };
        const preflight = {
            artifactId: 'artifact-authoring-site-bundle',
            sourceType: 'native-site-archive',
            contentEligible: true,
            controlPlaneAvailable: true,
            pushToWebEligible: true,
            fileCount: 1,
            sizeBytes: 12,
            sha256: 'a'.repeat(64),
            files: [{ path: 'public/index.html', sizeBytes: 12, sha256: 'b'.repeat(64) }],
            blockers: [],
        };
        expect(validatePreflight(
            preflight,
            plan,
            expectedFingerprint,
            'artifact-authoring-site-bundle',
        )).toBe(true);
        expect(() => validatePreflight(
            { ...preflight, artifactId: 'artifact-stale-site-bundle' },
            plan,
            expectedFingerprint,
            'artifact-authoring-site-bundle',
        )).toThrow('The codex managed-app preflight reported a deployment blocker.');
        expect(() => validatePreflight(
            {
                ...preflight,
                fileCount: 2,
                files: [...preflight.files, { ...preflight.files[0], path: 'public/extra.html' }],
            },
            plan,
            expectedFingerprint,
            'artifact-authoring-site-bundle',
        )).toThrow('The codex managed-app preflight source fingerprint did not match the verified site ZIP.');
    });

    test('requires resolved provider-model evidence for the Kimi K3 lane', () => {
        const plan = buildLanePlan('kimi', {}, { hop: 1 });
        const result = buildCompactResult(plan, 'kimi-proof');

        expect(validateCompactToolResult(plan, result)).toEqual(expect.objectContaining({
            provider: 'kimi-code-cli',
            providerModel: 'k3',
            model: 'kimi-k3',
        }));
        delete result.providerModel;
        expect(() => validateCompactToolResult(plan, result)).toThrow(
            'The Kimi canary did not attest the resolved K3 provider model.',
        );
    });

    test('keeps the request abort deadline active while a response body is still streaming', async () => {
        let bodyAbortObserved = false;
        const fetchImpl = jest.fn(async (_url, options = {}) => new Response(new ReadableStream({
            start(controller) {
                options.signal.addEventListener('abort', () => {
                    bodyAbortObserved = true;
                    controller.error(new Error('body stream aborted'));
                }, { once: true });
                setTimeout(() => {
                    if (!options.signal.aborted) {
                        controller.enqueue(new TextEncoder().encode('{"success":true}'));
                        controller.close();
                    }
                }, 50);
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const client = createHttpClient({
            baseUrl: new URL('https://kimibuilt.example.test'),
            apiKey: 'body-timeout-key',
            requestTimeoutMs: 10,
            fetchImpl,
        });

        await expect(client.requestJson('/api/auth/protected-check')).rejects.toThrow('body stream aborted');
        expect(bodyAbortObserved).toBe(true);
    });

    test('passes browser QA credentials only through inherited environment variables', async () => {
        const apiKey = 'browser-qa-secret-not-for-argv';
        const execFileImpl = jest.fn((_executable, _args, _options, callback) => {
            callback(null, [
                'UI_CHECK_REPORT=C:\\checks\\ui-check-report.json',
                'KIMIBUILT_UI_CHECK_RESULT={"ok":true,"checkedViewports":2,"issues":[]}',
                '',
            ].join('\n'), '');
        });
        const result = await runBrowserQa({
            previewUrl: 'https://kimibuilt.example.test/api/artifacts/site-1/preview',
            lane: 'codex',
            env: {
                KIMIBUILT_FRONTEND_API_KEY: apiKey,
                KIMIBUILT_CANARY_UI_CHECK_OUT_DIR: 'C:\\tmp\\authoring-ui-check',
            },
            execFileImpl,
        });

        expect(result).toEqual(expect.objectContaining({ ok: true, checkedViewports: 2, issues: [] }));
        const [, args, options] = execFileImpl.mock.calls[0];
        expect(args[0]).toMatch(/bin[\\/]kimibuilt-ui-check\.js$/);
        expect(args[1]).toBe('https://kimibuilt.example.test/api/artifacts/site-1/preview');
        expect(args).toContain('--same-origin-only');
        expect(JSON.stringify(args)).not.toContain(apiKey);
        expect(options.env.KIMIBUILT_FRONTEND_API_KEY).toBe(apiKey);
        expect(options.env.API_BASE_URL).toBe('https://kimibuilt.example.test');
    });

    test('runs public browser QA only at the exact approved HTTPS origin and strips API credentials', async () => {
        const execFileImpl = jest.fn((_executable, _args, _options, callback) => {
            callback(null, [
                'UI_CHECK_REPORT=C:\\checks\\public-ui-check-report.json',
                'KIMIBUILT_UI_CHECK_RESULT={"ok":true,"checkedViewports":2,"issues":[]}',
                '',
            ].join('\n'), '');
        });
        const result = await runPublicBrowserQa({
            publicUrl: 'https://remote-agent-codex-authoring-canary.demoserver2.buzz/',
            expectedOrigin: 'https://remote-agent-codex-authoring-canary.demoserver2.buzz',
            lane: 'codex',
            env: {
                KIMIBUILT_FRONTEND_API_KEY: 'must-not-reach-public-browser',
                KIMIBUILT_CANARY_LIVE_UI_CHECK_OUT_DIR: 'C:\\tmp\\public-authoring-ui-check',
            },
            execFileImpl,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            checkedViewports: 2,
            publicUrl: 'https://remote-agent-codex-authoring-canary.demoserver2.buzz/',
        }));
        const [, args, options] = execFileImpl.mock.calls[0];
        expect(args[1]).toBe('https://remote-agent-codex-authoring-canary.demoserver2.buzz/');
        expect(args).toContain('--same-origin-only');
        expect(options.env.KIMIBUILT_FRONTEND_API_KEY).toBeUndefined();
        expect(options.env.API_BASE_URL).toBe('https://remote-agent-codex-authoring-canary.demoserver2.buzz');
        await expect(runPublicBrowserQa({
            publicUrl: 'https://other.demoserver2.buzz/',
            expectedOrigin: 'https://remote-agent-codex-authoring-canary.demoserver2.buzz',
            lane: 'codex',
            execFileImpl,
        })).rejects.toThrow('exact approved credential-free HTTPS origin');
        expect(execFileImpl).toHaveBeenCalledTimes(1);
    });

    test('proves an authenticated two-hop live lane, final bytes, preview, preflight, and cleanup', async () => {
        const apiKey = 'frontend-api-key-for-test';
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: apiKey,
            KIMIBUILT_CANARY_CODEX_MODEL: 'codex-canary',
            KIMIBUILT_CANARY_POLL_INTERVAL_MS: '100',
        };
        const firstPlan = buildLanePlan('codex', env, { hop: 1 });
        const firstResult = buildCompactResult(firstPlan, 'hop-1');
        const secondPlan = buildLanePlan('codex', env, {
            hop: 2,
            sourceArtifacts: firstResult.resultFiles,
        });
        const secondResult = buildCompactResult(secondPlan, 'hop-2');
        const resultsByRun = new Map([
            ['run-hop-1', { plan: firstPlan, result: firstResult }],
            ['run-hop-2', { plan: secondPlan, result: secondResult }],
        ]);
        const fixtureByArtifactId = new Map();
        for (const { plan, result } of resultsByRun.values()) {
            result.resultFiles.forEach((file, index) => fixtureByArtifactId.set(file.artifactId, plan.fixtures[index]));
        }
        const zip = new JSZip();
        firstPlan.fixtures.forEach((fixture) => zip.file(fixture.outputPath, fixture.buffer));
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const calls = [];
        let runPostCount = 0;

        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url);
            const method = options.method || 'GET';
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({
                method,
                path: `${parsed.pathname}${parsed.search}`,
                headers: new Headers(options.headers),
                body,
                redirect: options.redirect,
            });
            if (method === 'GET' && parsed.pathname === '/api/auth/protected-check') {
                return jsonResponse({ success: true, user: { username: 'canary' } });
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/status') {
                return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
            }
            if (method === 'POST' && parsed.pathname === '/api/sessions') {
                return jsonResponse({ id: 'session-canary-1' }, 201);
            }
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
                runPostCount += 1;
                const id = `run-hop-${runPostCount}`;
                return jsonResponse({
                    run: {
                        id,
                        sessionId: 'session-canary-1',
                        adapter: 'remote-cli-agent',
                        status: 'queued',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false },
                    },
                    events: [],
                }, 202);
            }
            const runMatch = parsed.pathname.match(/^\/api\/async-lab\/runs\/(run-hop-[12])$/);
            if (method === 'GET' && runMatch) {
                const record = resultsByRun.get(runMatch[1]);
                return jsonResponse({
                    run: {
                        id: runMatch[1],
                        sessionId: 'session-canary-1',
                        adapter: 'remote-cli-agent',
                        status: 'completed',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false, toolResult: record.result },
                    },
                    events: [
                        { eventId: `${runMatch[1]}-started`, cursor: 1, type: 'tool_started', status: 'running' },
                        { eventId: `${runMatch[1]}-tool`, cursor: 2, type: 'tool_completed', status: 'running' },
                        { eventId: `${runMatch[1]}-done`, cursor: 3, type: 'completed', status: 'completed' },
                    ],
                });
            }
            const artifactLookup = parsed.pathname.match(/^\/api\/artifacts\/(artifact-hop-[12]-(?:component-\d+|site-bundle))$/);
            if (method === 'GET' && artifactLookup) {
                const id = artifactLookup[1];
                const isBundle = id.endsWith('site-bundle');
                return jsonResponse({
                    id,
                    sessionId: 'session-canary-1',
                    downloadUrl: `/api/artifacts/${id}/download`,
                    ...(isBundle ? {
                        bundleDownloadUrl: `/api/artifacts/${id}/bundle`,
                        previewUrl: `/api/artifacts/${id}/preview`,
                    } : {}),
                });
            }
            const componentDownload = parsed.pathname.match(/^\/api\/artifacts\/(artifact-hop-[12]-component-\d+)\/download$/);
            if (method === 'GET' && componentDownload) {
                const fixture = fixtureByArtifactId.get(componentDownload[1]);
                return bufferResponse(fixture.buffer, fixture.mimeType);
            }
            if (method === 'GET' && /^\/api\/artifacts\/artifact-hop-[12]-site-bundle\/bundle$/.test(parsed.pathname)) {
                return bufferResponse(zipBuffer, 'application/zip');
            }
            if (method === 'GET' && /^\/api\/artifacts\/artifact-hop-[12]-site-bundle\/preview$/.test(parsed.pathname)) {
                const rewrittenPreview = firstPlan.fixtures[0].content.replace(
                    '<head>',
                    '<head><base href="/api/artifacts/preview/">',
                );
                return bufferResponse(Buffer.from(rewrittenPreview), 'text/html');
            }
            if (method === 'POST' && parsed.pathname === '/api/artifacts/artifact-hop-2-site-bundle/managed-app/preflight') {
                return jsonResponse(managedAppFingerprintFromRequest(body, 'artifact-hop-2-site-bundle'));
            }
            if (method === 'DELETE' && parsed.pathname === '/api/sessions/session-canary-1') {
                return jsonResponse(null, 204);
            }
            throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
        });

        const result = await runCanary({
            argv: ['--run', '--mode', 'codex'],
            env,
            fetchImpl,
            sleep: jest.fn(),
        });

        expect(result).toEqual(expect.objectContaining({
            mode: 'codex',
            execution: 'live',
            passed: true,
            networkRequestsMade: 31,
            ephemeralSessionDeleted: true,
            bidirectionalRoundTrip: true,
        }));
        expect(result.lanes).toEqual([expect.objectContaining({
            lane: 'codex',
            bidirectionalRoundTrip: true,
            fixtureCount: 4,
            managedAppPreflight: 'passed',
            hops: [
                expect.objectContaining({ hop: 1, liveRemoteExecutionProved: true, componentDownloadsVerified: 4 }),
                expect.objectContaining({ hop: 2, liveRemoteExecutionProved: true, componentDownloadsVerified: 4, managedAppPreflight: 'passed' }),
            ],
        })]);
        expect(calls.every((call) => call.headers.get('X-API-Key') === apiKey)).toBe(true);
        expect(calls.every((call) => call.headers.get('Authorization') === null)).toBe(true);
        expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
        const runCalls = calls.filter((call) => call.method === 'POST' && call.path === '/api/async-lab/runs');
        expect(runCalls).toHaveLength(2);
        expect(runCalls.every((call) => call.body.targetKey === 'k3s-prod')).toBe(true);
        expect(runCalls.every((call) => call.body.metadata.toolParams.adminMode === false)).toBe(true);
        expect(runCalls.every((call) => !Object.hasOwn(call.body.metadata.toolParams, 'sessionId'))).toBe(true);
        expect(runCalls.every((call) => !Object.hasOwn(call.body.metadata.toolParams, 'resultFileGlobs'))).toBe(true);
        expect(runCalls[0].body.metadata.toolParams.contextFiles).toHaveLength(4);
        expect(runCalls[1].body.metadata.toolParams.artifactIds).toEqual(firstResult.resultFiles.map((file) => file.artifactId));
        const preflightCall = calls.find((call) => call.path.endsWith('/managed-app/preflight'));
        expect(preflightCall.body.expectedSourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(preflightCall.body.expectedFiles).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'design/design.xml', role: 'site-file' }),
            expect.objectContaining({ path: 'design/design.svg', role: 'site-file' }),
        ]));
        expect(calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-canary-1',
        }));
        expect(calls.some((call) => call.path === '/api/artifacts/artifact-hop-2-site-bundle/managed-app')).toBe(false);
    });

    test('proves mocked live authoring, local semantics, exact bundle bytes, browser QA, preflight, and cleanup', async () => {
        const apiKey = 'authoring-live-api-key';
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: apiKey,
            KIMIBUILT_CANARY_CODEX_MODEL: 'codex-authoring-canary',
            KIMIBUILT_CANARY_POLL_INTERVAL_MS: '100',
        };
        const harness = await createLiveAuthoringHarness(env);
        const browserQaRunner = jest.fn(async (input) => {
            harness.calls.push({ method: 'BROWSER_QA', path: new URL(input.previewUrl).pathname });
            return { ok: true, checkedViewports: 2, issues: [], outDir: 'ui-checks/test-authoring' };
        });

        const result = await runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            sleep: jest.fn(),
        });

        expect(result).toEqual(expect.objectContaining({
            execution: 'live',
            passed: true,
            networkRequestsMade: 45,
            ephemeralSessionDeleted: true,
            bidirectionalRoundTrip: true,
            authoringScenario: 'passed',
        }));
        expect(result.lanes[0].authoring).toEqual(expect.objectContaining({
            scenario: 'authoring',
            provider: null,
            model: 'codex-authoring-canary',
            inputArtifactCount: 0,
            componentMetadataVerified: 4,
            componentDownloadsVerified: 4,
            localStructuralGate: 'passed',
            semanticBriefVerified: true,
            siteZipFilesVerified: 4,
            previewVerified: true,
            managedAppPreflight: 'passed',
            browserQa: expect.objectContaining({ status: 'passed', checkedViewports: 2, issues: [] }),
        }));
        const runCalls = harness.calls.filter((call) => call.method === 'POST' && call.path === '/api/async-lab/runs');
        expect(runCalls).toHaveLength(3);
        const authoringPayload = runCalls[2].body;
        expect(authoringPayload.metadata).toEqual(expect.objectContaining({
            scenario: 'authoring',
            authoringCanaryVersion: AUTHORING_CANARY_VERSION,
        }));
        expect(authoringPayload.metadata.toolParams).toEqual(expect.objectContaining({
            adminMode: false,
            collectResultFiles: true,
        }));
        expect(authoringPayload.metadata.toolParams).not.toHaveProperty('contextFiles');
        expect(authoringPayload.metadata.toolParams).not.toHaveProperty('artifactIds');
        expect(authoringPayload.metadata.toolParams).not.toHaveProperty('resultFileGlobs');
        expect(browserQaRunner).toHaveBeenCalledWith(expect.objectContaining({
            previewUrl: 'https://kimibuilt.example.test/api/artifacts/artifact-authoring-site-bundle/preview',
            lane: 'codex',
            sessionId: 'session-authoring-canary',
        }));
        expect(browserQaRunner.mock.calls[0][0].previewUrl).not.toContain(apiKey);
        const browserIndex = harness.calls.findIndex((call) => call.method === 'BROWSER_QA');
        const deleteIndex = harness.calls.findIndex((call) => call.method === 'DELETE');
        expect(browserIndex).toBeGreaterThan(-1);
        expect(deleteIndex).toBeGreaterThan(browserIndex);
    });

    test('pushes the exact preflight SHA, observes terminal source/build/image/rollout/HTTPS proof, and checks the approved public origin', async () => {
        const env = buildPushToWebEnv();
        const harness = await createPushToWebHarness(env);
        const browserQaRunner = jest.fn(async (input) => {
            harness.calls.push({ method: 'BROWSER_QA', path: new URL(input.previewUrl).pathname });
            return { ok: true, checkedViewports: 2, issues: [], outDir: 'ui-checks/push-preview' };
        });
        const publicBrowserQaRunner = jest.fn(async (input) => {
            harness.calls.push({ method: 'PUBLIC_BROWSER_QA', path: input.publicUrl });
            return { ok: true, checkedViewports: 2, issues: [], outDir: 'ui-checks/push-live' };
        });

        const result = await runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
        });

        expect(result).toEqual(expect.objectContaining({
            execution: 'live',
            passed: true,
            ephemeralSessionDeleted: true,
            authoringScenario: 'passed',
            pushToWebScenario: 'passed',
        }));
        const pushed = result.lanes[0].authoring.pushToWeb;
        expect(pushed).toEqual(expect.objectContaining({
            status: 'passed',
            appRef: 'managed-app-push-canary',
            sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            publicHost: harness.publicHost,
            publicUrl: `https://${harness.publicHost}/`,
            progressPolls: 2,
            sourceCommit: MANAGED_APP_COMMIT_SHA,
            buildStatus: 'success',
            image: OCI_DIGEST,
            deploymentLifecycle: 'build-webhook',
            rollout: 'passed',
            https: 'passed',
            browserQa: expect.objectContaining({ status: 'passed', checkedViewports: 2 }),
        }));

        const preflightCall = harness.calls.find((call) => (
            call.method === 'POST'
            && call.path === '/api/artifacts/artifact-authoring-site-bundle/managed-app/preflight'
        ));
        const deployCall = harness.calls.find((call) => (
            call.method === 'POST'
            && call.path === '/api/artifacts/artifact-authoring-site-bundle/managed-app'
        ));
        expect(deployCall.body).toEqual(expect.objectContaining({
            sessionId: 'session-authoring-canary',
            requestedAction: 'deploy',
            deployRequested: true,
            queueAsyncDeploy: false,
            expectedSourceSha256: preflightCall.body.expectedSourceSha256,
            publicHost: harness.publicHost,
        }));
        expect(deployCall.body.metadata).toEqual(expect.objectContaining({
            changeTicket: env.CHANGE_TICKET,
            approvedHostTemplate: env.KIMIBUILT_CANARY_APPROVED_HOST_TEMPLATE,
            expectedPublicOrigin: `https://${harness.publicHost}`,
            expectedSourceSha256: preflightCall.body.expectedSourceSha256,
        }));
        expect(harness.calls.filter((call) => call.path === '/api/managed-apps/managed-app-push-canary/progress')).toHaveLength(2);
        expect(harness.calls.filter((call) => call.path.includes('run-managed-app-push-canary'))).toHaveLength(0);
        expect(publicBrowserQaRunner).toHaveBeenCalledWith(expect.objectContaining({
            publicUrl: `https://${harness.publicHost}/`,
            expectedOrigin: `https://${harness.publicHost}`,
            lane: 'codex',
        }));
        const publicQaIndex = harness.calls.findIndex((call) => call.method === 'PUBLIC_BROWSER_QA');
        const managedProgressIndex = harness.calls.findIndex((call) => call.path === '/api/managed-apps/managed-app-push-canary/progress');
        const deleteIndex = harness.calls.findIndex((call) => call.method === 'DELETE');
        expect(managedProgressIndex).toBeGreaterThan(-1);
        expect(publicQaIndex).toBeGreaterThan(-1);
        expect(deleteIndex).toBeGreaterThan(publicQaIndex);
    });

    test('rejects a Push-to-Web response whose source hash differs from preflight and still cleans up', async () => {
        const env = buildPushToWebEnv();
        const harness = await createPushToWebHarness(env, {
            deploymentSourceSha256: '0'.repeat(64),
        });
        const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
        const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
        })).rejects.toThrow('Push-to-Web response did not attest the accepted preflight SHA-256.');

        expect(harness.calls.some((call) => call.path === '/api/managed-apps/managed-app-push-canary/progress')).toBe(false);
        expect(publicBrowserQaRunner).not.toHaveBeenCalled();
        expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-authoring-canary',
        }));
    });

    test('fails closed on terminal progress without explicit HTTPS proof and cleans up before public browser QA', async () => {
        const env = buildPushToWebEnv();
        const harness = await createPushToWebHarness(env);
        const terminal = harness.progressPayloads.at(-1);
        terminal.app.metadata.liveDeploy.https = false;
        terminal.latestBuildRun.metadata.deployment.verification.https = false;
        const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
        const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
        })).rejects.toThrow('managed-app progress did not prove successful public HTTPS verification.');

        expect(publicBrowserQaRunner).not.toHaveBeenCalled();
        expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-authoring-canary',
        }));
    });

    test('rejects sha-* tags and bare hashes as managed-app image proof', async () => {
        for (const mutableReference of ['sha-abcdef123456', 'a'.repeat(64)]) {
            const env = buildPushToWebEnv();
            const harness = await createPushToWebHarness(env);
            const terminal = harness.progressPayloads.at(-1);
            terminal.progress.evidence.imageDigest = mutableReference;
            terminal.progress.evidence.observedImageDigest = mutableReference;
            terminal.latestBuildRun.imageDigest = mutableReference;
            terminal.latestBuildRun.metadata.deployment.imageDigest = mutableReference;
            terminal.app.metadata.liveDeploy.imageDigest = mutableReference;
            terminal.app.metadata.liveDeploy.observedImageDigest = mutableReference;
            const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
            const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

            await expect(runCanary({
                argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
                env,
                fetchImpl: harness.fetchImpl,
                browserQaRunner,
                publicBrowserQaRunner,
                sleep: jest.fn(),
            })).rejects.toThrow('Managed-app progress reported non-digest observed image evidence.');

            expect(publicBrowserQaRunner).not.toHaveBeenCalled();
            expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
                method: 'DELETE',
                path: '/api/sessions/session-authoring-canary',
            }));
        }
    });

    test('rejects tag-pinned deployment specs even when repeated digest scalars agree', async () => {
        const env = buildPushToWebEnv();
        const harness = await createPushToWebHarness(env);
        const terminal = harness.progressPayloads.at(-1);
        const mutableImage = 'registry.demoserver2.buzz/agent-apps/remote-agent-canary:sha-abcdef123456';
        terminal.progress.evidence.deployedImage = mutableImage;
        terminal.latestBuildRun.metadata.deployment.deployedImage = mutableImage;
        terminal.app.metadata.liveDeploy.deployedImage = mutableImage;
        const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
        const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
        })).rejects.toThrow('Managed-app progress reported a non-digest deployed image reference.');

        expect(publicBrowserQaRunner).not.toHaveBeenCalled();
        expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-authoring-canary',
        }));
    });

    test('rejects conflicting observed, build, and deployed OCI digests', async () => {
        const env = buildPushToWebEnv();
        const harness = await createPushToWebHarness(env);
        harness.progressPayloads.at(-1).latestBuildRun.imageDigest = CONFLICTING_OCI_DIGEST;
        const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
        const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
        })).rejects.toThrow('Managed-app progress reported conflicting OCI image digests.');

        expect(publicBrowserQaRunner).not.toHaveBeenCalled();
        expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-authoring-canary',
        }));
    });

    test('rejects terminal progress that breaks the accepted build, source, commit, or pipeline chain', async () => {
        const cases = [
            {
                mutate: (terminal) => { terminal.latestBuildRun.id = 'stale-build-run'; },
                error: 'managed-app progress did not preserve the accepted build-run identity.',
            },
            {
                mutate: (terminal) => { terminal.app.metadata.sourceArtifact.sha256 = '0'.repeat(64); },
                error: 'managed-app progress did not preserve the accepted preflight source SHA-256.',
            },
            {
                mutate: (terminal) => { terminal.progress.evidence.commitSha = '1234567890abcdef1234567890abcdef12345678'; },
                error: 'managed-app progress did not preserve the accepted commit and source paths.',
            },
            {
                mutate: (terminal) => {
                    terminal.progress.evidence.pipelineUrl = 'https://gitlab.demoserver2.buzz/agent-apps/remote-agent-canary/-/pipelines/99';
                },
                error: 'managed-app progress did not preserve the accepted commit-to-pipeline chain.',
            },
            {
                mutate: (terminal) => { terminal.latestBuildRun.externalRunId = '99'; },
                error: 'managed-app progress did not preserve the accepted commit-to-pipeline chain.',
            },
            {
                mutate: (terminal) => {
                    const foreignUrl = 'https://evil.example/agent-apps/remote-agent-canary/-/pipelines/42';
                    terminal.progress.evidence.pipelineUrl = foreignUrl;
                    terminal.latestBuildRun.externalRunUrl = foreignUrl;
                },
                error: 'managed-app progress did not preserve the accepted commit-to-pipeline chain.',
            },
            {
                mutate: (terminal) => {
                    const foreignUrl = 'https://gitlab.demoserver2.buzz/other/repository/-/pipelines/42';
                    terminal.progress.evidence.pipelineUrl = foreignUrl;
                    terminal.latestBuildRun.externalRunUrl = foreignUrl;
                },
                error: 'managed-app progress did not preserve the accepted commit-to-pipeline chain.',
            },
            {
                mutate: (terminal) => {
                    terminal.app.repoName = 'renamed-repository';
                    terminal.app.repoUrl = 'https://gitlab.demoserver2.buzz/agent-apps/renamed-repository.git';
                },
                error: 'managed-app progress changed the accepted GitLab repository identity.',
            },
        ];

        for (const testCase of cases) {
            const env = buildPushToWebEnv();
            const harness = await createPushToWebHarness(env);
            testCase.mutate(harness.progressPayloads.at(-1));
            const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
            const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

            await expect(runCanary({
                argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
                env,
                fetchImpl: harness.fetchImpl,
                browserQaRunner,
                publicBrowserQaRunner,
                sleep: jest.fn(),
            })).rejects.toThrow(testCase.error);

            expect(publicBrowserQaRunner).not.toHaveBeenCalled();
            expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
                method: 'DELETE',
                path: '/api/sessions/session-authoring-canary',
            }));
        }
    });

    test('rejects a premature managed-app async deploy and deletes the session before polling progress', async () => {
        const env = buildPushToWebEnv();
        const harness = await createPushToWebHarness(env, {
            includePrematureAsyncRun: true,
        });
        const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
        const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
        })).rejects.toThrow('started a premature async deploy before its build completed.');

        expect(harness.calls.some((call) => call.path === '/api/managed-apps/managed-app-push-canary/progress')).toBe(false);
        expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-authoring-canary',
        }));
    });

    test('times out a non-terminal webhook-driven deployment before deleting the session', async () => {
        const env = buildPushToWebEnv({ KIMIBUILT_CANARY_TIMEOUT_MS: '10000' });
        const pendingHost = env.KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE.replace('{lane}', 'codex');
        const pendingProgress = buildManagedAppProgressPayload(
            await createLiveAuthoringHarness(env),
            pendingHost,
            { terminal: false },
        );
        const harness = await createPushToWebHarness(env, {
            progressPayloads: [pendingProgress],
        });
        let clock = 0;
        const now = jest.fn(() => {
            clock += 6000;
            return clock;
        });
        const browserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));
        const publicBrowserQaRunner = jest.fn(async () => ({ ok: true, checkedViewports: 2, issues: [] }));

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa', '--push-to-web'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            publicBrowserQaRunner,
            sleep: jest.fn(),
            now,
        })).rejects.toThrow('managed-app deployment did not reach terminal proof before timeout.');

        const progressIndex = harness.calls.findIndex((call) => call.path === '/api/managed-apps/managed-app-push-canary/progress');
        const deleteIndex = harness.calls.findIndex((call) => call.path === '/api/sessions/session-authoring-canary');
        expect(progressIndex).toBeGreaterThan(-1);
        expect(deleteIndex).toBeGreaterThan(progressIndex);
        expect(publicBrowserQaRunner).not.toHaveBeenCalled();
    });

    test('deletes the ephemeral session when optional authoring browser QA fails after terminal runs', async () => {
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: 'authoring-cleanup-key',
            KIMIBUILT_CANARY_POLL_INTERVAL_MS: '100',
        };
        const harness = await createLiveAuthoringHarness(env);
        const browserQaRunner = jest.fn(async () => {
            throw new Error('mocked browser QA blocker');
        });

        await expect(runCanary({
            argv: ['--run', '--mode=codex', '--authoring', '--browser-qa'],
            env,
            fetchImpl: harness.fetchImpl,
            browserQaRunner,
            sleep: jest.fn(),
        })).rejects.toThrow('mocked browser QA blocker');

        expect(harness.calls.at(-1)).toEqual(expect.objectContaining({
            method: 'DELETE',
            path: '/api/sessions/session-authoring-canary',
        }));
        expect(harness.calls.some((call) => /\/cancel$/.test(call.path))).toBe(false);
    });

    test('cancels, polls terminal, then deletes the ephemeral session after a run polling error', async () => {
        const apiKey = 'cleanup-api-key-for-test';
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: apiKey,
        };
        const calls = [];
        let runGetCount = 0;
        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url);
            const method = options.method || 'GET';
            calls.push(`${method} ${parsed.pathname}`);
            if (method === 'GET' && parsed.pathname === '/api/auth/protected-check') {
                return jsonResponse({ success: true });
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/status') {
                return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
            }
            if (method === 'POST' && parsed.pathname === '/api/sessions') {
                return jsonResponse({ id: 'session-cleanup-1' }, 201);
            }
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
                return jsonResponse({
                    run: {
                        id: 'run-cleanup-1',
                        sessionId: 'session-cleanup-1',
                        adapter: 'remote-cli-agent',
                        status: 'queued',
                        liveRemoteAllowed: true,
                        metadata: { remoteAdapter: true, dryRun: false },
                    },
                    events: [],
                }, 202);
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/runs/run-cleanup-1') {
                runGetCount += 1;
                if (runGetCount === 1) {
                    throw new Error(`poll socket failed with token=${apiKey}`);
                }
                return jsonResponse({ run: { id: 'run-cleanup-1', status: 'cancelled' }, events: [] });
            }
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs/run-cleanup-1/cancel') {
                return jsonResponse({ run: { id: 'run-cleanup-1', status: 'running' }, changed: true });
            }
            if (method === 'DELETE' && parsed.pathname === '/api/sessions/session-cleanup-1') {
                return jsonResponse(null, 204);
            }
            throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
        });

        await expect(runCanary({
            argv: ['--run', '--mode=grok'],
            env,
            fetchImpl,
            sleep: jest.fn(),
        })).rejects.toThrow(/poll socket failed with token=\[redacted\]/);

        expect(calls).toEqual([
            'GET /api/auth/protected-check',
            'GET /api/async-lab/status',
            'POST /api/sessions',
            'POST /api/async-lab/runs',
            'GET /api/async-lab/runs/run-cleanup-1',
            'POST /api/async-lab/runs/run-cleanup-1/cancel',
            'GET /api/async-lab/runs/run-cleanup-1',
            'DELETE /api/sessions/session-cleanup-1',
        ]);
        expect(JSON.stringify(calls)).not.toContain(apiKey);
    });

    test('retains the session when cancellation cannot be proven terminal', async () => {
        const env = {
            KIMIBUILT_CANARY_BASE_URL: 'https://kimibuilt.example.test',
            KIMIBUILT_FRONTEND_API_KEY: 'retain-api-key',
        };
        const calls = [];
        const fetchImpl = jest.fn(async (url, options = {}) => {
            const parsed = new URL(url);
            const method = options.method || 'GET';
            calls.push(`${method} ${parsed.pathname}`);
            if (parsed.pathname === '/api/auth/protected-check') return jsonResponse({ success: true });
            if (parsed.pathname === '/api/async-lab/status') return jsonResponse({ status: { enabled: true, allowLiveRemote: true } });
            if (method === 'POST' && parsed.pathname === '/api/sessions') return jsonResponse({ id: 'session-retain-1' }, 201);
            if (method === 'POST' && parsed.pathname === '/api/async-lab/runs') {
                return jsonResponse({
                    run: { id: 'run-retain-1', sessionId: 'session-retain-1', adapter: 'remote-cli-agent', liveRemoteAllowed: true, metadata: { remoteAdapter: true, dryRun: false } },
                    events: [],
                }, 202);
            }
            if (method === 'POST' && parsed.pathname.endsWith('/cancel')) {
                return jsonResponse({ run: { id: 'run-retain-1', status: 'running' }, changed: true });
            }
            if (method === 'GET' && parsed.pathname === '/api/async-lab/runs/run-retain-1') {
                throw new Error('run state unavailable');
            }
            throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
        });

        await expect(runCanary({
            argv: ['--run', '--mode=codex'],
            env,
            fetchImpl,
            sleep: jest.fn(),
        })).rejects.toThrow(/session session-retain-1 was retained/i);
        expect(calls).not.toContain('DELETE /api/sessions/session-retain-1');
    });

    test('keeps fixture bytes stable across repeated construction', () => {
        const first = createFixtures();
        const second = createFixtures();
        expect(second.map((fixture) => fixture.sha256)).toEqual(first.map((fixture) => fixture.sha256));
        expect(second.every((fixture, index) => fixture.buffer.equals(first[index].buffer))).toBe(true);
        expect(second.every((fixture) => crypto.createHash('sha256').update(fixture.buffer).digest('hex') === fixture.sha256)).toBe(true);
    });
});
