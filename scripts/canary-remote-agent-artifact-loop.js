#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');

const CANARY_VERSION = 'RemoteAgentArtifactLoopCanary/v1';
const ALLOWED_MODES = new Set(['codex', 'kimi', 'grok', 'all']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SUCCESS_COMPLETION_STATUSES = new Set(['complete', 'completed', 'success', 'succeeded']);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

const FIXTURE_DEFINITIONS = Object.freeze([
    Object.freeze({
        filename: 'index.html',
        outputPath: 'index.html',
        role: 'site-entry',
        mimeType: 'text/html',
        content: [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="utf-8">',
            '  <meta name="viewport" content="width=device-width, initial-scale=1">',
            '  <meta name="artifact-loop-canary" content="artifact-loop-canary-v1">',
            '  <title>Remote Agent Artifact Loop Canary</title>',
            '  <link rel="stylesheet" href="./assets/styles.css">',
            '</head>',
            '<body>',
            '  <main class="canary-card">',
            '    <h1>Artifact loop verified</h1>',
            '    <p>Deterministic HTML, CSS, XML, and SVG crossed the remote agent boundary.</p>',
            '    <img src="./design/design.svg" alt="Four connected artifact nodes">',
            '    <a href="./design/design.xml">Open the design manifest</a>',
            '  </main>',
            '</body>',
            '</html>',
            '',
        ].join('\n'),
    }),
    Object.freeze({
        filename: 'styles.css',
        outputPath: 'assets/styles.css',
        role: 'site-file',
        mimeType: 'text/css',
        content: [
            ':root { color-scheme: light; --ink: #10233f; --paper: #f7fbff; --accent: #155eef; }',
            '* { box-sizing: border-box; }',
            'body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }',
            '.canary-card { width: min(42rem, calc(100% - 2rem)); padding: 2rem; border: 2px solid var(--accent); border-radius: 1rem; background: #ffffff; box-shadow: 0 1rem 3rem rgba(16, 35, 63, 0.12); }',
            '.canary-card img { display: block; width: min(100%, 32rem); height: auto; margin: 1.5rem 0; }',
            '.canary-card a { color: #0b47b7; font-weight: 700; }',
            '',
        ].join('\n'),
    }),
    Object.freeze({
        filename: 'design.xml',
        outputPath: 'design/design.xml',
        role: 'site-file',
        mimeType: 'application/xml',
        content: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<artifact-loop version="1">',
            '  <fixture name="remote-agent-canary" deterministic="true"/>',
            '  <files count="4">',
            '    <file path="index.html" role="site-entry"/>',
            '    <file path="assets/styles.css" role="site-file"/>',
            '    <file path="design/design.xml" role="site-file"/>',
            '    <file path="design/design.svg" role="site-file"/>',
            '  </files>',
            '</artifact-loop>',
            '',
        ].join('\n'),
    }),
    Object.freeze({
        filename: 'design.svg',
        outputPath: 'design/design.svg',
        role: 'site-file',
        mimeType: 'image/svg+xml',
        content: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 180" role="img" aria-labelledby="title description">',
            '  <title id="title">Remote agent artifact loop</title>',
            '  <desc id="description">Four connected nodes labeled HTML, CSS, XML, and SVG.</desc>',
            '  <rect width="640" height="180" rx="24" fill="#10233f"/>',
            '  <path d="M118 90H522" stroke="#7dd3fc" stroke-width="8" stroke-linecap="round"/>',
            '  <g fill="#f7fbff" stroke="#155eef" stroke-width="4" font-family="system-ui, sans-serif" font-size="18" font-weight="700" text-anchor="middle">',
            '    <g><circle cx="118" cy="90" r="46"/><text x="118" y="97" fill="#10233f" stroke="none">HTML</text></g>',
            '    <g><circle cx="253" cy="90" r="46"/><text x="253" y="97" fill="#10233f" stroke="none">CSS</text></g>',
            '    <g><circle cx="387" cy="90" r="46"/><text x="387" y="97" fill="#10233f" stroke="none">XML</text></g>',
            '    <g><circle cx="522" cy="90" r="46"/><text x="522" y="97" fill="#10233f" stroke="none">SVG</text></g>',
            '  </g>',
            '</svg>',
            '',
        ].join('\n'),
    }),
]);

const LANE_DEFAULTS = Object.freeze({
    codex: Object.freeze({
        modelEnv: 'KIMIBUILT_CANARY_CODEX_MODEL',
        model: 'gpt-5.5',
        transport: 'codex-agent',
    }),
    kimi: Object.freeze({
        modelEnv: 'KIMIBUILT_CANARY_KIMI_MODEL',
        model: 'kimi-k3',
        transport: 'provider-agent',
    }),
    grok: Object.freeze({
        modelEnv: 'KIMIBUILT_CANARY_GROK_MODEL',
        model: 'grok',
        transport: 'provider-agent',
    }),
});

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function createFixtures() {
    return FIXTURE_DEFINITIONS.map((definition) => {
        const buffer = Buffer.from(definition.content, 'utf8');
        return {
            filename: definition.filename,
            outputPath: definition.outputPath,
            role: definition.role,
            mimeType: definition.mimeType,
            sizeBytes: buffer.length,
            sha256: sha256(buffer),
            content: definition.content,
            buffer,
        };
    });
}

function parseArguments(argv = []) {
    let run = false;
    let mode = 'all';
    let help = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index] || '').trim();
        if (argument === '--run') {
            run = true;
            continue;
        }
        if (argument === '--help' || argument === '-h') {
            help = true;
            continue;
        }
        if (argument === '--mode') {
            mode = String(argv[index + 1] || '').trim().toLowerCase();
            index += 1;
            continue;
        }
        if (argument.startsWith('--mode=')) {
            mode = argument.slice('--mode='.length).trim().toLowerCase();
            continue;
        }
        throw new Error(`Unsupported argument: ${argument || '(empty)'}`);
    }

    if (!ALLOWED_MODES.has(mode)) {
        throw new Error('Mode must be one of: codex, kimi, grok, all.');
    }

    return { run, mode, help };
}

function selectedLanes(mode = 'all') {
    return mode === 'all' ? ['codex', 'kimi', 'grok'] : [mode];
}

function buildLaneTask(lane, fixtures, options = {}) {
    const hop = Number(options.hop) === 2 ? 2 : 1;
    const sourceArtifacts = Array.isArray(options.sourceArtifacts) ? options.sourceArtifacts : [];
    const outputRoot = `artifact-loop-canary/${lane}/hop-${hop}/site`;
    const fileLines = fixtures.map((fixture, index) => {
        const sourceArtifactId = sourceArtifacts[index]?.artifactId;
        return `- ${fixture.filename}${sourceArtifactId ? ` (source artifactId=${sourceArtifactId})` : ''} -> ${outputRoot}/${fixture.outputPath}; role=${fixture.role}; sha256=${fixture.sha256}`;
    });
    return [
        `Run hop ${hop} of the deterministic ${CANARY_VERSION} for the ${lane} CLI lane.`,
        'Read the gateway-provided RemoteAgentHandoff/v1 input manifest before doing any file work.',
        hop === 2
            ? 'Match every staged input to the source artifactId listed below; stored filenames may differ from the original relative paths.'
            : 'Match every staged input by its exact fixture filename.',
        `Inside the handoff output files directory, create the nested directory ${outputRoot}.`,
        'Copy each staged input byte-for-byte to the exact destination below. Do not reformat, regenerate, normalize line endings, or alter encoding:',
        ...fileLines,
        'Write the RemoteAgentResultFiles/v1 manifest at the exact handoff result manifest path.',
        'The manifest must attest the exact byte size and SHA-256 for every file, use one site-entry plus three site-file roles, and include no other returned files.',
        'Verify every copied file locally by SHA-256 before finishing.',
        'This is artifact transfer verification only. Do not deploy, publish, install packages, use git, run kubectl, mutate an application workspace, or call public services.',
        'Do not include file contents, credentials, tokens, cookies, or environment values in the final response.',
        'Finish only with the required result-manifest marker and a concise pass or blocker summary.',
    ].join('\n');
}

function buildLanePlan(lane, env = process.env, options = {}) {
    const defaults = LANE_DEFAULTS[lane];
    if (!defaults) {
        throw new Error(`Unsupported canary lane: ${lane}`);
    }
    const fixtures = createFixtures();
    const hop = Number(options.hop) === 2 ? 2 : 1;
    const sourceArtifacts = Array.isArray(options.sourceArtifacts) ? options.sourceArtifacts : [];
    const outputRoot = `artifact-loop-canary/${lane}/hop-${hop}/site`;
    const task = buildLaneTask(lane, fixtures, { hop, sourceArtifacts });
    const model = String(env[defaults.modelEnv] || defaults.model).trim();
    const targetId = String(env.KIMIBUILT_CANARY_TARGET_ID || 'k3s-prod').trim();
    const cwd = String(env.KIMIBUILT_CANARY_CWD || '/opt/kimibuilt').trim();

    const toolParams = {
        task,
        targetId,
        cwd,
        model,
        transport: defaults.transport,
        adminMode: false,
        collectResultFiles: true,
        ...(hop === 1 ? {
            contextFiles: fixtures.map((fixture) => ({
                filename: fixture.filename,
                mimeType: fixture.mimeType,
                content: fixture.content,
                sha256: fixture.sha256,
                source: 'canary-fixture',
                description: `${CANARY_VERSION} deterministic ${fixture.filename} input`,
            })),
        } : {
            artifactIds: sourceArtifacts.map((entry) => String(entry?.artifactId || '').trim()).filter(Boolean),
        }),
        waitMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_AGENT_WAIT_MS, 120000, {
            min: 1000,
            max: 300000,
        }),
    };

    return {
        lane,
        hop,
        inputMode: hop === 1 ? 'inline-fixtures' : 'session-artifacts',
        sourceArtifacts,
        model,
        transport: defaults.transport,
        targetId,
        cwd,
        outputRoot,
        task,
        toolParams,
        fixtures,
    };
}

function validateLanePlan(plan = {}) {
    if (!LANE_DEFAULTS[plan.lane]) {
        throw new Error('Canary lane plan is missing a supported lane.');
    }
    if (!plan.model || !plan.targetId || !plan.cwd) {
        throw new Error(`Canary ${plan.lane} lane is missing model, target, or workspace configuration.`);
    }
    if (plan.toolParams?.adminMode !== false || plan.toolParams?.collectResultFiles !== true) {
        throw new Error(`Canary ${plan.lane} lane must be non-admin with result collection enabled.`);
    }
    if (plan.toolParams?.transport !== plan.transport) {
        throw new Error(`Canary ${plan.lane} lane transport is inconsistent.`);
    }
    if (!Array.isArray(plan.fixtures) || plan.fixtures.length !== 4) {
        throw new Error(`Canary ${plan.lane} lane must contain exactly four fixtures.`);
    }
    const filenames = new Set();
    const outputPaths = new Set();
    let siteEntryCount = 0;
    for (const fixture of plan.fixtures) {
        if (filenames.has(fixture.filename) || outputPaths.has(fixture.outputPath)) {
            throw new Error(`Canary ${plan.lane} lane contains a duplicate fixture path.`);
        }
        filenames.add(fixture.filename);
        outputPaths.add(fixture.outputPath);
        if (fixture.role === 'site-entry') {
            siteEntryCount += 1;
        } else if (fixture.role !== 'site-file') {
            throw new Error(`Canary fixture ${fixture.filename} has an invalid site role.`);
        }
        if (sha256(fixture.buffer) !== fixture.sha256 || fixture.buffer.length !== fixture.sizeBytes) {
            throw new Error(`Canary fixture ${fixture.filename} failed its deterministic checksum.`);
        }
        if (plan.hop === 1) {
            const staged = plan.toolParams.contextFiles.find((entry) => entry.filename === fixture.filename);
            if (!staged || staged.sha256 !== fixture.sha256 || staged.content !== fixture.content) {
                throw new Error(`Canary ${plan.lane} staged payload differs from ${fixture.filename}.`);
            }
        }
    }
    if (siteEntryCount !== 1 || plan.fixtures[0].filename !== 'index.html') {
        throw new Error(`Canary ${plan.lane} lane must have one index.html site entry.`);
    }
    if (plan.hop === 2) {
        if (!Array.isArray(plan.toolParams.artifactIds)
            || plan.toolParams.artifactIds.length !== plan.fixtures.length
            || new Set(plan.toolParams.artifactIds).size !== plan.fixtures.length
            || Object.hasOwn(plan.toolParams, 'contextFiles')) {
            throw new Error(`Canary ${plan.lane} second hop must use exactly four unique session artifacts.`);
        }
    } else if (Object.hasOwn(plan.toolParams, 'artifactIds')) {
        throw new Error(`Canary ${plan.lane} first hop must use inline fixtures only.`);
    }
    if (!plan.task.includes('byte-for-byte')
        || !plan.task.includes('Do not deploy, publish, install packages, use git, run kubectl')
        || !plan.task.includes('RemoteAgentResultFiles/v1')) {
        throw new Error(`Canary ${plan.lane} task is missing required transfer or safety instructions.`);
    }
    if (Object.hasOwn(plan.toolParams, 'resultFileGlobs')) {
        throw new Error(`Canary ${plan.lane} must use its authoritative result manifest, not discovery globs.`);
    }
    return true;
}

function describePlan(plan) {
    return {
        lane: plan.lane,
        hop: plan.hop,
        inputMode: plan.inputMode,
        model: plan.model,
        transport: plan.transport,
        targetId: plan.targetId,
        cwd: plan.cwd,
        adminMode: false,
        outputRoot: plan.outputRoot,
        fixtureCount: plan.fixtures.length,
        fixtures: plan.fixtures.map((fixture) => ({
            filename: fixture.filename,
            outputPath: fixture.outputPath,
            role: fixture.role,
            mimeType: fixture.mimeType,
            sizeBytes: fixture.sizeBytes,
            sha256: fixture.sha256,
        })),
        payloadValid: true,
    };
}

function buildLiveConfiguration(env = process.env) {
    const baseUrlValue = String(env.KIMIBUILT_CANARY_BASE_URL || '').trim();
    const apiKey = String(env.KIMIBUILT_FRONTEND_API_KEY || '').trim();
    if (!baseUrlValue) {
        throw new Error('Live canary requires KIMIBUILT_CANARY_BASE_URL.');
    }
    if (!apiKey) {
        throw new Error('Live canary requires KIMIBUILT_FRONTEND_API_KEY.');
    }

    let baseUrl;
    try {
        baseUrl = new URL(baseUrlValue);
    } catch (_error) {
        throw new Error('KIMIBUILT_CANARY_BASE_URL must be a valid HTTP(S) URL.');
    }
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
    if (baseUrl.protocol !== 'https:' && !(localHost && baseUrl.protocol === 'http:')) {
        throw new Error('Live canary requires HTTPS except for an explicit localhost URL.');
    }
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/g, '') || '/';
    baseUrl.search = '';
    baseUrl.hash = '';

    return {
        baseUrl,
        apiKey,
        pollIntervalMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_POLL_INTERVAL_MS, 2000, {
            min: 100,
            max: 30000,
        }),
        timeoutMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_TIMEOUT_MS, 15 * 60 * 1000, {
            min: 10000,
            max: 60 * 60 * 1000,
        }),
        requestTimeoutMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_REQUEST_TIMEOUT_MS, 30000, {
            min: 1000,
            max: 120000,
        }),
    };
}

function sanitizeErrorMessage(value = '', secrets = []) {
    let normalized = String(value || 'Unknown canary failure')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/((?:authorization|cookie|api[-_ ]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
        .slice(0, 1200);
    for (const secret of secrets) {
        if (secret) {
            normalized = normalized.split(secret).join('[redacted]');
        }
    }
    return normalized;
}

async function readBoundedBuffer(response, maxBytes) {
    const declared = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`Response exceeded the ${maxBytes}-byte canary limit.`);
    }
    if (!response.body?.getReader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
            throw new Error(`Response exceeded the ${maxBytes}-byte canary limit.`);
        }
        return buffer;
    }

    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`Response exceeded the ${maxBytes}-byte canary limit.`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

function createHttpClient({ baseUrl, apiKey, requestTimeoutMs, fetchImpl = global.fetch }) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('This canary requires a fetch implementation.');
    }
    let networkRequestsMade = 0;

    function resolveApiUrl(pathname) {
        const candidate = new URL(String(pathname || ''), baseUrl);
        if (candidate.origin !== baseUrl.origin || !candidate.pathname.startsWith('/api/')) {
            throw new Error('Canary refused a non-KimiBuilt or non-API URL.');
        }
        return candidate;
    }

    async function request(pathname, options = {}) {
        const url = resolveApiUrl(pathname);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        timeout.unref?.();
        let finished = false;
        const finish = () => {
            if (!finished) {
                finished = true;
                clearTimeout(timeout);
            }
        };
        networkRequestsMade += 1;
        try {
            const response = await fetchImpl(url.toString(), {
                method: options.method || 'GET',
                headers: {
                    Accept: options.accept || 'application/json',
                    'X-API-Key': apiKey,
                    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    ...(options.headers || {}),
                },
                ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
                redirect: 'manual',
                signal: controller.signal,
            });
            if (response.status >= 300 && response.status < 400) {
                throw new Error(`Canary refused an HTTP redirect from ${url.pathname}.`);
            }
            return { response, finish };
        } catch (error) {
            finish();
            throw new Error(sanitizeErrorMessage(error.message, [apiKey]));
        }
    }

    async function requestJson(pathname, options = {}) {
        const { response, finish } = await request(pathname, options);
        try {
            const buffer = await readBoundedBuffer(response, MAX_JSON_BYTES);
            let payload = null;
            if (buffer.length > 0) {
                try {
                    payload = JSON.parse(buffer.toString('utf8'));
                } catch (_error) {
                    throw new Error(`KimiBuilt returned invalid JSON for ${new URL(pathname, baseUrl).pathname}.`);
                }
            }
            if (!response.ok) {
                const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
                throw new Error(sanitizeErrorMessage(
                    `${new URL(pathname, baseUrl).pathname} failed: ${message}`,
                    [apiKey],
                ));
            }
            return payload;
        } finally {
            finish();
        }
    }

    async function requestBuffer(pathname, options = {}) {
        const { response, finish } = await request(pathname, {
            ...options,
            accept: options.accept || 'application/octet-stream',
        });
        try {
            if (!response.ok) {
                const buffer = await readBoundedBuffer(response, Math.min(MAX_JSON_BYTES, MAX_DOWNLOAD_BYTES));
                let message = `HTTP ${response.status}`;
                try {
                    const payload = JSON.parse(buffer.toString('utf8'));
                    message = payload?.error?.message || payload?.message || message;
                } catch (_error) {
                    // Keep the status-only error; never echo arbitrary response content.
                }
                throw new Error(sanitizeErrorMessage(
                    `${new URL(pathname, baseUrl).pathname} failed: ${message}`,
                    [apiKey],
                ));
            }
            return await readBoundedBuffer(response, options.maxBytes || MAX_DOWNLOAD_BYTES);
        } finally {
            finish();
        }
    }

    return {
        requestJson,
        requestBuffer,
        get networkRequestsMade() {
            return networkRequestsMade;
        },
    };
}

function buildRunPayload(plan, sessionId) {
    return {
        task: plan.task,
        adapter: 'remote-cli-agent',
        targetKey: plan.targetId,
        liveRemote: true,
        sessionId,
        idempotencyKey: `artifact-loop-canary:${sessionId}:${plan.lane}:hop-${plan.hop}:${sha256(
            Buffer.from(plan.fixtures.map((fixture) => fixture.sha256).join(':'), 'utf8'),
        ).slice(0, 20)}`,
        metadata: {
            source: 'remote-agent-artifact-loop-canary',
            canaryVersion: CANARY_VERSION,
            lane: plan.lane,
            hop: plan.hop,
            expectedOutputRoot: plan.outputRoot,
            toolParams: plan.toolParams,
        },
    };
}

function findCompactToolResult(run = {}, events = []) {
    if (run?.metadata?.toolResult && typeof run.metadata.toolResult === 'object') {
        return run.metadata.toolResult;
    }
    for (const event of [...events].reverse()) {
        const candidate = event?.payload?.result || event?.result;
        if (candidate && typeof candidate === 'object') {
            return candidate;
        }
    }
    return null;
}

function assertNoRawResultFields(value, currentPath = 'toolResult') {
    if (!value || typeof value !== 'object') {
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase();
        if (['content', 'contentbase64', 'buffer', 'password', 'secret', 'token', 'authorization', 'apikey'].includes(normalizedKey)) {
            throw new Error(`Compact async tool result exposed forbidden field ${currentPath}.${key}.`);
        }
        assertNoRawResultFields(nested, `${currentPath}.${key}`);
    }
}

function validateCompactToolResult(plan, toolResult) {
    if (!toolResult || typeof toolResult !== 'object') {
        throw new Error(`The ${plan.lane} run completed without a compact tool result.`);
    }
    assertNoRawResultFields(toolResult);
    if (toolResult.success !== true || toolResult.blocker || toolResult.error) {
        throw new Error(`The ${plan.lane} compact tool result reported a failure or blocker.`);
    }
    if (!SUCCESS_COMPLETION_STATUSES.has(String(toolResult.completionStatus || '').trim().toLowerCase())) {
        throw new Error(`The ${plan.lane} compact tool result did not attest completion.`);
    }
    if (String(toolResult.transport || '').trim() !== plan.transport) {
        throw new Error(`The ${plan.lane} run used an unexpected transport.`);
    }
    if (String(toolResult.model || '').trim() !== plan.model) {
        throw new Error(`The ${plan.lane} run did not preserve the requested model in its compact result.`);
    }
    const provider = String(toolResult.provider || '').trim().toLowerCase();
    if (plan.lane === 'kimi' && !provider.includes('kimi')) {
        throw new Error('The Kimi canary did not return Kimi provider evidence.');
    }
    if (plan.lane === 'kimi' && String(toolResult.providerModel || '').trim() !== 'k3') {
        throw new Error('The Kimi canary did not attest the resolved K3 provider model.');
    }
    if (plan.lane === 'grok' && !provider.includes('grok')) {
        throw new Error('The Grok canary did not return Grok provider evidence.');
    }
    if (plan.lane === 'grok' && String(toolResult.providerModel || '').trim() !== 'grok-build') {
        throw new Error('The Grok canary did not attest the resolved Grok Build provider model.');
    }
    if (toolResult.artifactQuality?.status !== 'passed') {
        throw new Error(`The ${plan.lane} artifact quality gate did not pass.`);
    }

    const resultFiles = Array.isArray(toolResult.resultFiles) ? toolResult.resultFiles : [];
    if (resultFiles.length !== plan.fixtures.length) {
        throw new Error(`The ${plan.lane} compact result did not contain four component descriptors.`);
    }
    const componentArtifacts = [];
    for (const fixture of plan.fixtures) {
        const descriptor = resultFiles.find((file) => file?.filename === fixture.filename);
        if (!descriptor
            || descriptor.role !== fixture.role
            || descriptor.sha256 !== fixture.sha256
            || descriptor.sizeBytes !== fixture.sizeBytes
            || !descriptor.artifactId) {
            throw new Error(`The ${plan.lane} result descriptor for ${fixture.filename} failed byte or role attestation.`);
        }
        const relativePath = String(descriptor.relativePath || descriptor.path || '').replace(/\\/g, '/');
        const expectedSuffix = `${plan.outputRoot}/${fixture.outputPath}`;
        if (!relativePath.endsWith(expectedSuffix)) {
            throw new Error(`The ${plan.lane} result descriptor for ${fixture.filename} is outside the expected nested site.`);
        }
        componentArtifacts.push({ fixture, descriptor });
    }

    const siteBundleArtifactId = String(toolResult.siteBundleArtifactId || '').trim();
    if (!siteBundleArtifactId) {
        throw new Error(`The ${plan.lane} compact result did not include a native site bundle artifact.`);
    }
    const artifacts = Array.isArray(toolResult.artifacts) ? toolResult.artifacts : [];
    const siteBundleArtifact = artifacts.find((artifact) => artifact?.id === siteBundleArtifactId) || {
        id: siteBundleArtifactId,
    };

    return {
        componentArtifacts,
        siteBundleArtifactId,
        siteBundleArtifact,
        provider: toolResult.provider || null,
        providerModel: toolResult.providerModel || null,
        model: toolResult.model || plan.model,
    };
}

function validateRunExecutionEvidence(run, events, plan) {
    if (run?.liveRemoteAllowed !== true
        || run?.metadata?.remoteAdapter !== true
        || run?.metadata?.dryRun !== false) {
        throw new Error(`The ${plan.lane} hop ${plan.hop} run did not attest an allowed non-dry remote adapter execution.`);
    }
    const eventTypes = new Set((Array.isArray(events) ? events : [])
        .map((event) => String(event?.type || '').trim().toLowerCase())
        .filter(Boolean));
    if (!eventTypes.has('tool_started')
        || !eventTypes.has('tool_completed')
        || eventTypes.has('tool_skipped')) {
        throw new Error(`The ${plan.lane} hop ${plan.hop} run lacks required tool execution evidence.`);
    }
    return true;
}

async function pollRun(client, runId, options = {}) {
    const startedAt = options.now();
    let after = 0;
    const collectedEvents = [];
    const eventKeys = new Set();
    while (options.now() - startedAt <= options.timeoutMs) {
        const payload = await client.requestJson(
            `/api/async-lab/runs/${encodeURIComponent(runId)}?after=${encodeURIComponent(after)}`,
        );
        const run = payload?.run;
        const events = Array.isArray(payload?.events) ? payload.events : [];
        for (const event of events) {
            const key = String(event?.eventId || `${event?.cursor || 0}:${event?.type || ''}`);
            if (!eventKeys.has(key)) {
                eventKeys.add(key);
                collectedEvents.push(event);
            }
        }
        after = Math.max(after, ...events.map((event) => Number(event?.cursor || 0) || 0));
        const status = String(run?.status || '').trim().toLowerCase();
        if (TERMINAL_RUN_STATUSES.has(status)) {
            return { run, events: collectedEvents, status };
        }
        await options.sleep(options.pollIntervalMs);
    }
    throw new Error(`Async run ${runId} exceeded the canary timeout.`);
}

function artifactApiPath(value, fallbackPath, baseUrl) {
    if (!value) {
        return fallbackPath;
    }
    const candidate = new URL(String(value), baseUrl);
    if (candidate.origin !== baseUrl.origin || !candidate.pathname.startsWith('/api/artifacts/')) {
        throw new Error('Canary refused an unsafe artifact URL from the compact result.');
    }
    return `${candidate.pathname}${candidate.search}`;
}

async function validateSiteZip(zipBuffer, plan) {
    let zip;
    try {
        zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: true });
    } catch (_error) {
        throw new Error(`The ${plan.lane} site bundle is not a valid ZIP archive.`);
    }
    const archivePaths = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
    const expectedPaths = plan.fixtures.map((fixture) => fixture.outputPath).sort();
    if (JSON.stringify(archivePaths) !== JSON.stringify(expectedPaths)) {
        throw new Error(`The ${plan.lane} site ZIP did not contain exactly the four expected paths.`);
    }
    for (const fixture of plan.fixtures) {
        const entry = zip.file(fixture.outputPath);
        const buffer = entry ? await entry.async('nodebuffer') : null;
        if (!buffer || sha256(buffer) !== fixture.sha256 || buffer.length !== fixture.sizeBytes) {
            throw new Error(`The ${plan.lane} site ZIP changed ${fixture.outputPath}.`);
        }
    }
    return archivePaths;
}

function buildExpectedManagedAppFingerprint(fixtures = []) {
    const files = fixtures.map((fixture) => ({
        path: `public/${fixture.outputPath}`,
        buffer: fixture.buffer,
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
        files: files.map((file) => ({
            path: file.path,
            sizeBytes: file.buffer.length,
            sha256: sha256(file.buffer),
        })),
    };
}

function validatePreflight(payload, plan, expectedFingerprint) {
    const status = String(payload?.status || payload?.preflight?.status || '').trim().toLowerCase();
    const blockers = payload?.blockers || payload?.preflight?.blockers || [];
    if (payload?.ok === false
        || payload?.eligible === false
        || payload?.preflight?.eligible === false
        || payload?.contentEligible !== true
        || payload?.controlPlaneAvailable !== true
        || payload?.pushToWebEligible !== true
        || ['blocked', 'failed', 'error'].includes(status)
        || (Array.isArray(blockers) && blockers.length > 0)) {
        throw new Error(`The ${plan.lane} managed-app preflight reported a deployment blocker.`);
    }
    if (payload?.sha256 !== expectedFingerprint.sha256
        || payload?.fileCount !== expectedFingerprint.files.length) {
        throw new Error(`The ${plan.lane} managed-app preflight source fingerprint did not match the verified site ZIP.`);
    }
    const returnedFiles = Array.isArray(payload?.files) ? payload.files : [];
    for (const expected of expectedFingerprint.files) {
        const returned = returnedFiles.find((file) => file?.path === expected.path);
        if (!returned || returned.sizeBytes !== expected.sizeBytes || returned.sha256 !== expected.sha256) {
            throw new Error(`The ${plan.lane} managed-app preflight changed ${expected.path}.`);
        }
    }
    return true;
}

async function executeLiveHop(plan, sessionId, client, runtimeOptions) {
    const created = await client.requestJson('/api/async-lab/runs', {
        method: 'POST',
        body: buildRunPayload(plan, sessionId),
    });
    const runId = String(created?.run?.id || '').trim();
    if (!runId) {
        throw new Error(`The ${plan.lane} hop ${plan.hop} async response did not include a run ID.`);
    }
    runtimeOptions.activeRunIds.add(runId);
    if (created.run?.liveRemoteAllowed !== true
        || created.run?.metadata?.remoteAdapter !== true
        || created.run?.metadata?.dryRun !== false) {
        throw new Error(`The ${plan.lane} hop ${plan.hop} was not accepted as an allowed live remote run.`);
    }
    const completed = await pollRun(client, runId, runtimeOptions);
    if (TERMINAL_RUN_STATUSES.has(completed.status)) {
        runtimeOptions.activeRunIds.delete(runId);
    }
    if (completed.status !== 'completed') {
        throw new Error(`The ${plan.lane} hop ${plan.hop} run ended with status ${completed.status || 'unknown'}.`);
    }
    validateRunExecutionEvidence(completed.run, completed.events, plan);

    const toolResult = findCompactToolResult(completed.run, completed.events);
    const inspected = validateCompactToolResult(plan, toolResult);
    for (const { fixture, descriptor } of inspected.componentArtifacts) {
        const compactArtifact = (Array.isArray(toolResult.artifacts) ? toolResult.artifacts : [])
            .find((candidate) => candidate?.id === descriptor.artifactId);
        const artifact = await client.requestJson(`/api/artifacts/${encodeURIComponent(descriptor.artifactId)}`);
        if (artifact?.id !== descriptor.artifactId
            || (artifact?.sessionId && artifact.sessionId !== sessionId)) {
            throw new Error(`The ${plan.lane} artifact lookup for ${fixture.filename} failed session ownership proof.`);
        }
        const downloadPath = artifactApiPath(
            artifact?.downloadUrl || compactArtifact?.downloadUrl,
            `/api/artifacts/${encodeURIComponent(descriptor.artifactId)}/download`,
            runtimeOptions.baseUrl,
        );
        const downloaded = await client.requestBuffer(downloadPath, {
            maxBytes: Math.max(1024, fixture.sizeBytes + 1),
        });
        if (downloaded.length !== fixture.sizeBytes || sha256(downloaded) !== fixture.sha256) {
            throw new Error(`The ${plan.lane} hop ${plan.hop} component download changed ${fixture.filename}.`);
        }
    }

    const siteArtifact = await client.requestJson(
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}`,
    );
    if (siteArtifact?.id !== inspected.siteBundleArtifactId
        || (siteArtifact?.sessionId && siteArtifact.sessionId !== sessionId)) {
        throw new Error(`The ${plan.lane} site bundle lookup failed session ownership proof.`);
    }
    const bundlePath = artifactApiPath(
        siteArtifact?.bundleDownloadUrl || inspected.siteBundleArtifact.bundleDownloadUrl,
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/bundle`,
        runtimeOptions.baseUrl,
    );
    const zipBuffer = await client.requestBuffer(bundlePath, { maxBytes: MAX_DOWNLOAD_BYTES });
    const archivePaths = await validateSiteZip(zipBuffer, plan);

    const previewPath = artifactApiPath(
        siteArtifact?.previewUrl || inspected.siteBundleArtifact.previewUrl,
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/preview`,
        runtimeOptions.baseUrl,
    );
    const preview = await client.requestBuffer(previewPath, { maxBytes: MAX_DOWNLOAD_BYTES });
    const previewHtml = preview.toString('utf8');
    if (previewHtml.includes('\ufffd')
        || !previewHtml.includes('<title>Remote Agent Artifact Loop Canary</title>')
        || !previewHtml.includes('artifact-loop-canary-v1')
        || !previewHtml.includes('Artifact loop verified')
        || !previewHtml.includes('assets/styles.css')
        || !previewHtml.includes('design/design.xml')
        || !previewHtml.includes('design/design.svg')) {
        throw new Error(`The ${plan.lane} hop ${plan.hop} preview did not preserve the deterministic site semantics.`);
    }

    if (runtimeOptions.preflight === true) {
        const expectedFingerprint = buildExpectedManagedAppFingerprint(plan.fixtures);
        const preflight = await client.requestJson(
            `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/managed-app/preflight`,
            {
                method: 'POST',
                body: {
                    source: 'remote-agent-artifact-loop-canary',
                    canaryVersion: CANARY_VERSION,
                    validateOnly: true,
                    expectedSourceSha256: expectedFingerprint.sha256,
                    expectedEntry: 'index.html',
                    expectedFiles: plan.fixtures.map((fixture) => ({
                        path: fixture.outputPath,
                        role: fixture.role,
                        sizeBytes: fixture.sizeBytes,
                        sha256: fixture.sha256,
                    })),
                },
            },
        );
        validatePreflight(preflight, plan, expectedFingerprint);
    }

    return {
        sourceArtifacts: inspected.componentArtifacts.map(({ fixture, descriptor }) => ({
            artifactId: descriptor.artifactId,
            filename: fixture.filename,
            outputPath: fixture.outputPath,
            role: fixture.role,
            sizeBytes: fixture.sizeBytes,
            sha256: fixture.sha256,
        })),
        summary: {
            hop: plan.hop,
            runId,
            provider: inspected.provider,
            providerModel: inspected.providerModel,
            model: inspected.model,
            transport: plan.transport,
            liveRemoteExecutionProved: true,
            componentMetadataVerified: inspected.componentArtifacts.length,
            componentDownloadsVerified: inspected.componentArtifacts.length,
            siteBundleArtifactId: inspected.siteBundleArtifactId,
            siteZipFilesVerified: archivePaths.length,
            previewVerified: true,
            ...(runtimeOptions.preflight === true ? { managedAppPreflight: 'passed' } : {}),
        },
    };
}

async function cancelAndConfirmTerminal(client, runId, runtimeOptions) {
    const cancelled = await client.requestJson(`/api/async-lab/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        body: {},
    });
    const cancelStatus = String(cancelled?.run?.status || '').trim().toLowerCase();
    if (TERMINAL_RUN_STATUSES.has(cancelStatus)) {
        return cancelStatus;
    }
    const terminal = await pollRun(client, runId, runtimeOptions);
    if (!TERMINAL_RUN_STATUSES.has(terminal.status)) {
        throw new Error(`Cancelled run ${runId} did not reach a terminal state.`);
    }
    return terminal.status;
}

async function runLive(plans, options = {}) {
    const configuration = buildLiveConfiguration(options.env);
    const client = createHttpClient({
        ...configuration,
        fetchImpl: options.fetchImpl,
    });
    const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const now = options.now || (() => Date.now());
    const activeRunIds = new Set();
    let sessionId = '';
    let primaryError = null;
    let cleanupError = null;
    const laneResults = [];

    try {
        const authProbe = await client.requestJson('/api/auth/protected-check');
        if (authProbe?.success !== true) {
            throw new Error('KimiBuilt authentication probe did not confirm access.');
        }
        const statusPayload = await client.requestJson('/api/async-lab/status');
        const status = statusPayload?.status || {};
        if (status.enabled !== true || status.allowLiveRemote !== true) {
            throw new Error('Async runtime must be enabled with live remote execution allowed before --run can proceed.');
        }

        const session = await client.requestJson('/api/sessions', {
            method: 'POST',
            body: {
                clientSurface: 'artifact-loop-canary',
                taskType: 'remote-agent-artifact-loop-canary',
                mode: 'chat',
                metadata: {
                    ephemeral: true,
                    canaryVersion: CANARY_VERSION,
                    lanes: plans.map((plan) => plan.lane),
                },
            },
        });
        sessionId = String(session?.id || '').trim();
        if (!sessionId) {
            throw new Error('The canary could not create an ephemeral session.');
        }

        for (const firstHopPlan of plans) {
            const firstHop = await executeLiveHop(firstHopPlan, sessionId, client, {
                ...configuration,
                sleep,
                now,
                activeRunIds,
                preflight: false,
            });
            const secondHopPlan = buildLanePlan(firstHopPlan.lane, options.env, {
                hop: 2,
                sourceArtifacts: firstHop.sourceArtifacts,
            });
            validateLanePlan(secondHopPlan);
            const secondHop = await executeLiveHop(secondHopPlan, sessionId, client, {
                ...configuration,
                sleep,
                now,
                activeRunIds,
                preflight: true,
            });
            laneResults.push({
                lane: firstHopPlan.lane,
                bidirectionalRoundTrip: true,
                fixtureCount: firstHopPlan.fixtures.length,
                hops: [firstHop.summary, secondHop.summary],
                managedAppPreflight: 'passed',
            });
        }
    } catch (error) {
        primaryError = error;
    } finally {
        for (const runId of [...activeRunIds]) {
            try {
                await cancelAndConfirmTerminal(client, runId, {
                    ...configuration,
                    sleep,
                    now,
                });
                activeRunIds.delete(runId);
            } catch (error) {
                cleanupError ||= new Error(`Run cancellation cleanup failed: ${error.message}`);
            }
        }
        if (sessionId && activeRunIds.size === 0) {
            try {
                await client.requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
                    method: 'DELETE',
                });
            } catch (error) {
                cleanupError ||= new Error(`Ephemeral session cleanup failed: ${error.message}`);
            }
        } else if (sessionId && activeRunIds.size > 0) {
            const retentionMessage = `Ephemeral session ${sessionId} was retained because ${activeRunIds.size} run(s) were not proven terminal.`;
            cleanupError = cleanupError
                ? new Error(`${cleanupError.message} ${retentionMessage}`)
                : new Error(retentionMessage);
        }
    }

    if (primaryError) {
        if (cleanupError) {
            primaryError.message = `${primaryError.message} ${cleanupError.message}`;
        }
        throw primaryError;
    }
    if (cleanupError) {
        throw cleanupError;
    }

    return {
        version: CANARY_VERSION,
        mode: plans.length === 3 ? 'all' : plans[0].lane,
        execution: 'live',
        passed: true,
        networkRequestsMade: client.networkRequestsMade,
        ephemeralSessionDeleted: true,
        bidirectionalRoundTrip: true,
        lanes: laneResults,
    };
}

async function runCanary(options = {}) {
    const parsed = parseArguments(options.argv || []);
    if (parsed.help) {
        return {
            help: 'Usage: npm run canary:remote-agent-artifact-loop -- [--mode codex|kimi|grok|all] [--run]',
        };
    }
    const env = options.env || process.env;
    const plans = selectedLanes(parsed.mode).map((lane) => buildLanePlan(lane, env, { hop: 1 }));
    plans.forEach(validateLanePlan);

    if (!parsed.run) {
        const lanes = plans.map((firstHopPlan) => {
            const placeholderArtifacts = firstHopPlan.fixtures.map((fixture, index) => ({
                artifactId: `dry-run-${firstHopPlan.lane}-artifact-${index + 1}`,
                filename: fixture.filename,
                sha256: fixture.sha256,
            }));
            const secondHopPlan = buildLanePlan(firstHopPlan.lane, env, {
                hop: 2,
                sourceArtifacts: placeholderArtifacts,
            });
            validateLanePlan(secondHopPlan);
            return {
                lane: firstHopPlan.lane,
                bidirectionalRoundTripPlanned: true,
                hops: [describePlan(firstHopPlan), describePlan(secondHopPlan)],
            };
        });
        return {
            version: CANARY_VERSION,
            mode: parsed.mode,
            execution: 'dry-run',
            passed: true,
            networkRequestsMade: 0,
            note: 'Payloads were validated locally. No HTTP request or remote agent run was attempted.',
            lanes,
        };
    }

    return runLive(plans, options);
}

async function main() {
    try {
        const result = await runCanary({ argv: process.argv.slice(2), env: process.env });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify({
            version: CANARY_VERSION,
            passed: false,
            error: sanitizeErrorMessage(error.message, [process.env.KIMIBUILT_FRONTEND_API_KEY]),
        }, null, 2)}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    void main();
}

module.exports = {
    CANARY_VERSION,
    buildLanePlan,
    buildRunPayload,
    createFixtures,
    createHttpClient,
    parseArguments,
    runCanary,
    validateCompactToolResult,
    validateLanePlan,
    validateSiteZip,
};
