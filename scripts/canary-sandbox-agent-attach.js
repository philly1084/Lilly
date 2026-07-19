#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');

const CANARY_VERSION = 'SandboxAgentAttachCanary/v1';
const PROGRESS_VERSION = 'SandboxAgentAttachProgress/v1';
const ALLOWED_MODES = new Set(['codex', 'kimi', 'all']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SUCCESS_COMPLETION_STATUSES = new Set(['complete', 'completed', 'success', 'succeeded']);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

const LANE_DEFAULTS = Object.freeze({
    codex: Object.freeze({
        modelEnv: 'KIMIBUILT_CANARY_CODEX_MODEL',
        model: 'gpt-5.6-sol',
        transport: 'provider-agent',
        provider: '',
        providerModel: '',
    }),
    kimi: Object.freeze({
        modelEnv: 'KIMIBUILT_CANARY_KIMI_MODEL',
        model: 'kimi-k3',
        transport: 'provider-agent',
        provider: 'kimi-code-cli',
        providerModel: 'k3',
    }),
});

const SURFACES = Object.freeze({
    canvas: Object.freeze({
        key: 'canvas',
        mode: 'canvas',
        taskType: 'canvas',
        clientSurface: 'canvas-excalidraw',
    }),
    notes: Object.freeze({
        key: 'notes',
        mode: 'notes',
        taskType: 'notes',
        clientSurface: 'notes',
    }),
});

const FIXTURE_DEFINITIONS = Object.freeze([
    Object.freeze({
        path: 'index.html',
        mimeType: 'text/html',
        language: 'html',
        purpose: 'Deterministic sandbox entry document.',
        content: [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="utf-8">',
            '  <meta name="viewport" content="width=device-width, initial-scale=1">',
            `  <meta name="sandbox-agent-attach-canary" content="${CANARY_VERSION}">`,
            '  <title>Sandbox agent attach canary</title>',
            '  <link rel="stylesheet" href="./styles.css">',
            '</head>',
            '<body>',
            '  <main>',
            '    <h1>Exact artifact handoff</h1>',
            '    <p>The sandbox bundle crosses two CLI lanes and two editing surfaces without byte drift.</p>',
            '    <img src="./design/design.svg" alt="Connected sandbox, CLI, Canvas, and Notes nodes">',
            '    <a href="./design/design.xml">Open the design contract</a>',
            '  </main>',
            '</body>',
            '</html>',
        ].join('\n'),
    }),
    Object.freeze({
        path: 'styles.css',
        mimeType: 'text/css',
        language: 'css',
        purpose: 'Deterministic responsive presentation.',
        content: [
            `/* ${CANARY_VERSION} */`,
            ':root { color-scheme: light; --paper: #f5f8ff; --ink: #14213d; --accent: #174ea6; }',
            '* { box-sizing: border-box; }',
            'body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--paper); color: var(--ink); font: 16px/1.6 system-ui, sans-serif; }',
            'main { width: min(44rem, calc(100% - 2rem)); padding: 2rem; border: 2px solid var(--accent); border-radius: 1rem; background: #fff; }',
            'img { display: block; width: 100%; height: auto; margin: 1.25rem 0; }',
            'a { color: #0b47b7; font-weight: 700; }',
            'a:focus-visible { outline: 3px solid #b45309; outline-offset: 3px; }',
            '@media (max-width: 520px) { main { padding: 1rem; } }',
            '',
        ].join('\n'),
    }),
    Object.freeze({
        path: 'design/design.xml',
        mimeType: 'application/xml',
        language: 'xml',
        purpose: 'Machine-readable design handoff contract.',
        content: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<sandbox-agent-attach-canary version="1" contract="${CANARY_VERSION}">`,
            '  <source kind="code-sandbox" mode="project"/>',
            '  <lanes><lane>codex</lane><lane>kimi</lane></lanes>',
            '  <surfaces><surface>canvas-excalidraw</surface><surface>notes</surface></surfaces>',
            '</sandbox-agent-attach-canary>',
            '',
        ].join('\n'),
    }),
    Object.freeze({
        path: 'design/design.svg',
        mimeType: 'image/svg+xml',
        language: 'svg',
        purpose: 'Portable vector design context.',
        content: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 240" role="img" aria-labelledby="title desc" data-canary-version="${CANARY_VERSION}">`,
            '  <title id="title">Sandbox artifact handoff</title>',
            '  <desc id="desc">A sandbox node connects to the Codex and Kimi CLI lanes and then to Canvas and Notes.</desc>',
            '  <rect width="720" height="240" rx="28" fill="#14213d"/>',
            '  <path d="M105 120H615" stroke="#7dd3fc" stroke-width="10" stroke-linecap="round"/>',
            '  <g fill="#fff" stroke="#174ea6" stroke-width="5">',
            '    <circle cx="105" cy="120" r="52"/><circle cx="290" cy="120" r="42"/><circle cx="430" cy="120" r="42"/><circle cx="615" cy="120" r="52"/>',
            '  </g>',
            '  <g fill="#14213d" font-family="system-ui, sans-serif" font-size="18" font-weight="700" text-anchor="middle">',
            '    <text x="105" y="126">Sandbox</text><text x="290" y="126">Codex</text><text x="430" y="126">Kimi</text><text x="615" y="126">Editors</text>',
            '  </g>',
            '</svg>',
            '',
        ].join('\n'),
    }),
]);

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

function createFixtureFiles() {
    return FIXTURE_DEFINITIONS.map((definition) => {
        const buffer = Buffer.from(definition.content, 'utf8');
        return {
            ...definition,
            buffer,
            sizeBytes: buffer.length,
            sha256: sha256(buffer),
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
        throw new Error('Mode must be one of: codex, kimi, all.');
    }
    return { run, mode, help };
}

function selectedLanes(mode = 'all') {
    return mode === 'all' ? ['codex', 'kimi'] : [mode];
}

function createSandboxToolPayload(sessionId, fixtures = createFixtureFiles()) {
    return {
        sessionId,
        mode: 'project',
        language: 'html',
        projectName: 'sandbox-agent-attach-canary',
        entry: 'index.html',
        network: false,
        files: fixtures.map((fixture) => ({
            path: fixture.path,
            content: fixture.content,
            language: fixture.language,
            purpose: fixture.purpose,
        })),
        metadata: {
            source: 'sandbox-agent-attach-canary',
            canaryVersion: CANARY_VERSION,
            clientSurface: 'sandbox-agent-attach',
            taskType: 'sandbox-agent-attach-canary',
        },
    };
}

function buildAgentTask(plan) {
    const sourceLabel = plan.scenario === 'sandbox-origin'
        ? 'the exact project ZIP persisted by code-sandbox project mode'
        : `the exact artifact attached into the ${plan.surface.clientSurface} session`;
    return [
        `Run ${plan.scenario} for ${CANARY_VERSION} on the ${plan.lane} CLI lane.`,
        'Read the gateway-provided RemoteAgentHandoff/v1 input manifest before any file work.',
        `The manifest must contain exactly one selected source artifact with artifactId ${plan.sourceArtifactId}.`,
        `Its authoritative expected size is ${plan.expectedSizeBytes} bytes and SHA-256 is ${plan.expectedSha256}.`,
        `Treat it as ${sourceLabel}.`,
        `Copy the staged input byte-for-byte to ${plan.outputRelativePath} under the handoff output files directory.`,
        'Do not unpack, recompress, rename internal ZIP members, normalize line endings, or regenerate any content.',
        `Write RemoteAgentResultFiles/v1 at the exact result manifest path with exactly one file: filename=${plan.outputFilename}, role=${plan.outputRole}, mimeType=application/zip, and its exact byte size and SHA-256.`,
        'Verify the copied output locally with byte count and SHA-256 before finishing.',
        'This is a non-admin artifact transfer canary. Do not deploy, publish, install packages, use git, access public services, run kubectl, or mutate an application workspace.',
        'Do not include file contents, credentials, cookies, tokens, or environment values in the final response.',
        'Finish only with RESULT_FILES_MANIFEST at the required path and a concise pass or blocker summary.',
    ].join('\n');
}

function buildAgentPlan({
    lane,
    scenario,
    surface = null,
    sessionId,
    sourceArtifactId,
    expectedSha256,
    expectedSizeBytes,
    env = process.env,
}) {
    const defaults = LANE_DEFAULTS[lane];
    if (!defaults) {
        throw new Error(`Unsupported canary lane: ${lane}`);
    }
    const normalizedScenario = scenario === 'surface-return' ? 'surface-return' : 'sandbox-origin';
    const normalizedSurface = normalizedScenario === 'surface-return' ? SURFACES[surface?.key || surface] : null;
    if (normalizedScenario === 'surface-return' && !normalizedSurface) {
        throw new Error('Surface-return plans require Canvas or Notes.');
    }
    const outputFilename = normalizedScenario === 'sandbox-origin'
        ? 'sandbox-origin.zip'
        : 'attached-bundle.zip';
    const outputRole = normalizedScenario === 'sandbox-origin'
        ? 'sandbox-source-bundle'
        : `${normalizedSurface.key}-attached-bundle`;
    const outputRelativePath = normalizedScenario === 'sandbox-origin'
        ? `sandbox-agent-attach/${lane}/origin/${outputFilename}`
        : `sandbox-agent-attach/${lane}/${normalizedSurface.key}/${outputFilename}`;
    const plan = {
        lane,
        scenario: normalizedScenario,
        surface: normalizedSurface,
        sessionId: String(sessionId || '').trim(),
        sourceArtifactId: String(sourceArtifactId || '').trim(),
        expectedSha256: String(expectedSha256 || '').trim().toLowerCase(),
        expectedSizeBytes: Number(expectedSizeBytes || 0),
        model: String(env[defaults.modelEnv] || defaults.model).trim(),
        transport: defaults.transport,
        provider: defaults.provider,
        providerModel: defaults.providerModel,
        targetId: String(env.KIMIBUILT_CANARY_TARGET_ID || 'k3s-prod').trim(),
        cwd: String(env.KIMIBUILT_CANARY_CWD || '/opt/kimibuilt').trim(),
        outputFilename,
        outputRole,
        outputRelativePath,
    };
    plan.task = buildAgentTask(plan);
    plan.toolParams = {
        task: plan.task,
        targetId: plan.targetId,
        cwd: plan.cwd,
        model: plan.model,
        transport: plan.transport,
        adminMode: false,
        collectResultFiles: true,
        artifactIds: [plan.sourceArtifactId],
        waitMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_AGENT_WAIT_MS, 120000, {
            min: 1000,
            max: 300000,
        }),
    };
    validateAgentPlan(plan);
    return plan;
}

function validateAgentPlan(plan = {}) {
    if (!LANE_DEFAULTS[plan.lane]
        || !['sandbox-origin', 'surface-return'].includes(plan.scenario)
        || !plan.sessionId
        || !plan.sourceArtifactId
        || !/^[a-f0-9]{64}$/.test(plan.expectedSha256)
        || !Number.isInteger(plan.expectedSizeBytes)
        || plan.expectedSizeBytes <= 0
        || plan.expectedSizeBytes > MAX_BUNDLE_BYTES) {
        throw new Error('Remote agent plan is missing safe identity or exact-byte evidence.');
    }
    if (plan.scenario === 'surface-return' && !SURFACES[plan.surface?.key]) {
        throw new Error('Surface-return plan has an invalid destination surface.');
    }
    if (plan.toolParams?.adminMode !== false
        || plan.toolParams?.collectResultFiles !== true
        || plan.toolParams?.transport !== plan.transport
        || plan.toolParams?.artifactIds?.length !== 1
        || plan.toolParams.artifactIds[0] !== plan.sourceArtifactId
        || Object.hasOwn(plan.toolParams, 'contextFiles')
        || Object.hasOwn(plan.toolParams, 'resultFileGlobs')) {
        throw new Error('Remote agent plan must use one real artifact ID in a non-admin manifest-driven run.');
    }
    if (!plan.task.includes('RemoteAgentHandoff/v1')
        || !plan.task.includes('byte-for-byte')
        || !plan.task.includes(plan.expectedSha256)
        || !plan.task.includes('Do not deploy, publish, install packages, use git, access public services, run kubectl')) {
        throw new Error('Remote agent task is missing transfer evidence or safety constraints.');
    }
    return true;
}

function buildAsyncRunPayload(plan) {
    const scenarioKey = plan.surface ? `${plan.scenario}:${plan.surface.key}` : plan.scenario;
    return {
        task: plan.task,
        adapter: 'remote-cli-agent',
        targetKey: plan.targetId,
        liveRemote: true,
        sessionId: plan.sessionId,
        idempotencyKey: `sandbox-agent-attach:${plan.sessionId}:${plan.lane}:${scenarioKey}:${plan.expectedSha256.slice(0, 20)}`,
        metadata: {
            source: 'sandbox-agent-attach-canary',
            canaryVersion: CANARY_VERSION,
            lane: plan.lane,
            scenario: plan.scenario,
            ...(plan.surface ? { surface: plan.surface.key } : {}),
            sourceArtifactId: plan.sourceArtifactId,
            expectedSha256: plan.expectedSha256,
            expectedSizeBytes: plan.expectedSizeBytes,
            expectedOutputPath: plan.outputRelativePath,
            toolParams: plan.toolParams,
        },
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
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
        throw new Error('Live canary base URL must not contain credentials, query parameters, or fragments.');
    }
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/g, '') || '/';
    return {
        baseUrl,
        apiKey,
        pollIntervalMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_POLL_INTERVAL_MS, 2000, {
            min: 100,
            max: 30000,
        }),
        timeoutMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_TIMEOUT_MS, 20 * 60 * 1000, {
            min: 10000,
            max: 60 * 60 * 1000,
        }),
        requestTimeoutMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_REQUEST_TIMEOUT_MS, 30000, {
            min: 1000,
            max: 120000,
        }),
        progressIntervalMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_PROGRESS_INTERVAL_MS, 15000, {
            min: 5000,
            max: 60000,
        }),
    };
}

function emitProgress(runtime = {}, event = '', details = {}) {
    if (typeof runtime.onProgress !== 'function') {
        return;
    }
    try {
        runtime.onProgress({
            version: PROGRESS_VERSION,
            canaryVersion: CANARY_VERSION,
            event,
            ...details,
        });
    } catch (_error) {
        // Progress reporting is observability only and must not change canary behavior.
    }
}

function sanitizeErrorMessage(value = '', secrets = []) {
    let normalized = String(value || 'Unknown canary failure')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/((?:authorization|cookie|api[-_ ]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
        .slice(0, 1600);
    for (const secret of secrets) {
        if (secret) {
            normalized = normalized.split(secret).join('[redacted]');
        }
    }
    return normalized;
}

function normalizeDiagnosticCode(value = '') {
    return String(value || '')
        .trim()
        .replace(/[^a-z0-9_.-]+/gi, '')
        .slice(0, 96) || 'unknown';
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
        if (candidate.origin !== baseUrl.origin
            || candidate.username
            || candidate.password
            || candidate.hash
            || !candidate.pathname.startsWith('/api/')) {
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
                finish();
                throw new Error(`Canary refused an HTTP redirect from ${url.pathname}.`);
            }
            return { response, url, finish };
        } catch (error) {
            finish();
            throw new Error(sanitizeErrorMessage(error.message, [apiKey]));
        }
    }

    async function requestJsonResult(pathname, options = {}) {
        const { response, url, finish } = await request(pathname, options);
        try {
            const buffer = await readBoundedBuffer(response, MAX_JSON_BYTES);
            let payload = null;
            if (buffer.length > 0) {
                try {
                    payload = JSON.parse(buffer.toString('utf8'));
                } catch (_error) {
                    throw new Error(`KimiBuilt returned invalid JSON for ${url.pathname}.`);
                }
            }
            return { status: response.status, ok: response.ok, payload, pathname: url.pathname };
        } finally {
            finish();
        }
    }

    async function requestJson(pathname, options = {}) {
        const result = await requestJsonResult(pathname, options);
        if (!result.ok) {
            const message = result.payload?.error?.message || result.payload?.message || `HTTP ${result.status}`;
            throw new Error(sanitizeErrorMessage(`${result.pathname} failed: ${message}`, [apiKey]));
        }
        return result.payload;
    }

    async function requestStatusResult(pathname, options = {}) {
        const { response, url, finish } = await request(pathname, options);
        try {
            await readBoundedBuffer(response, MAX_JSON_BYTES);
            return { status: response.status, ok: response.ok, pathname: url.pathname };
        } finally {
            finish();
        }
    }

    async function requestBuffer(pathname, options = {}) {
        const { response, url, finish } = await request(pathname, {
            ...options,
            accept: options.accept || 'application/octet-stream',
        });
        try {
            if (!response.ok) {
                const buffer = await readBoundedBuffer(response, MAX_JSON_BYTES);
                let message = `HTTP ${response.status}`;
                try {
                    const payload = JSON.parse(buffer.toString('utf8'));
                    message = payload?.error?.message || payload?.message || message;
                } catch (_error) {
                    // Keep status-only text; never echo an arbitrary binary response.
                }
                throw new Error(sanitizeErrorMessage(`${url.pathname} failed: ${message}`, [apiKey]));
            }
            return await readBoundedBuffer(response, options.maxBytes || MAX_BUNDLE_BYTES);
        } finally {
            finish();
        }
    }

    return {
        requestJson,
        requestJsonResult,
        requestStatusResult,
        requestBuffer,
        get networkRequestsMade() {
            return networkRequestsMade;
        },
    };
}

function artifactApiPath(value, fallbackPath, baseUrl, suffixPattern = null) {
    const candidate = new URL(String(value || fallbackPath), baseUrl);
    if (candidate.origin !== baseUrl.origin
        || candidate.username
        || candidate.password
        || candidate.hash
        || !candidate.pathname.startsWith('/api/artifacts/')
        || (suffixPattern && !suffixPattern.test(candidate.pathname))) {
        throw new Error('Canary refused an unsafe artifact URL.');
    }
    return `${candidate.pathname}${candidate.search}`;
}

function sandboxWorkspacePreviewApiPath(value, workspaceId, baseUrl) {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    const expectedPath = `/api/sandbox-workspaces/${encodeURIComponent(normalizedWorkspaceId)}/preview/`;
    const candidate = new URL(String(value || expectedPath), baseUrl);
    if (!/^[a-z0-9._-]{1,140}$/i.test(normalizedWorkspaceId)
        || candidate.origin !== baseUrl.origin
        || candidate.username
        || candidate.password
        || candidate.hash
        || candidate.search
        || (candidate.pathname !== expectedPath && candidate.pathname !== expectedPath.slice(0, -1))) {
        throw new Error('Canary refused an unsafe sandbox workspace preview URL.');
    }
    return candidate.pathname;
}

async function validateSandboxBundle(buffer, fixtures = createFixtureFiles()) {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > MAX_BUNDLE_BYTES) {
        throw new Error('Sandbox bundle is empty or exceeds the attachment limit.');
    }
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    } catch (_error) {
        throw new Error('Sandbox artifact is not a valid CRC-checked ZIP bundle.');
    }
    const paths = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
    const expectedPaths = [
        ...fixtures.map((fixture) => fixture.path),
        'README.md',
        'assets/images.json',
    ].sort();
    if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
        throw new Error('Sandbox bundle did not contain the exact project and support file set.');
    }
    const fixtureBuffers = new Map();
    for (const fixture of fixtures) {
        const entry = zip.file(fixture.path);
        const entryBuffer = entry ? await entry.async('nodebuffer') : null;
        if (!entryBuffer
            || entryBuffer.length !== fixture.sizeBytes
            || sha256(entryBuffer) !== fixture.sha256
            || !entryBuffer.equals(fixture.buffer)) {
            throw new Error(`Sandbox bundle changed ${fixture.path}.`);
        }
        fixtureBuffers.set(fixture.path, entryBuffer);
    }
    const html = fixtureBuffers.get('index.html')?.toString('utf8') || '';
    const css = fixtureBuffers.get('styles.css')?.toString('utf8') || '';
    const xml = fixtureBuffers.get('design/design.xml')?.toString('utf8') || '';
    const svg = fixtureBuffers.get('design/design.svg')?.toString('utf8') || '';
    const htmlDocument = new JSDOM(html).window.document;
    const localReferences = [...htmlDocument.querySelectorAll('[src], [href]')]
        .flatMap((element) => ['src', 'href']
            .map((name) => element.getAttribute(name))
            .filter(Boolean));
    if (htmlDocument.querySelector('meta[name="sandbox-agent-attach-canary"]')?.getAttribute('content') !== CANARY_VERSION
        || htmlDocument.querySelectorAll('main').length !== 1
        || htmlDocument.querySelectorAll('h1').length !== 1
        || !localReferences.includes('./styles.css')
        || !localReferences.includes('./design/design.xml')
        || !localReferences.includes('./design/design.svg')
        || localReferences.some((reference) => /^(?:https?:)?\/\//i.test(reference))
        || htmlDocument.querySelector('script, iframe, object, embed')) {
        throw new Error('Sandbox HTML failed deterministic, local-only design semantics.');
    }
    if (!css.includes(CANARY_VERSION)
        || !/:focus-visible\b/i.test(css)
        || !/@media\b/i.test(css)
        || !/\bcolor\s*:/i.test(css)
        || !/\bbackground\s*:/i.test(css)) {
        throw new Error('Sandbox CSS failed marker, responsive, focus, or color semantics.');
    }
    let xmlDocument;
    let svgDocument;
    try {
        xmlDocument = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
        svgDocument = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
    } catch (_error) {
        throw new Error('Sandbox XML or SVG is not well formed.');
    }
    const xmlRoot = xmlDocument.documentElement;
    const svgRoot = svgDocument.documentElement;
    const xmlLanes = [...xmlDocument.querySelectorAll('lane')]
        .map((element) => String(element.textContent || '').trim());
    if (xmlRoot?.localName !== 'sandbox-agent-attach-canary'
        || xmlRoot.getAttribute('contract') !== CANARY_VERSION
        || xmlLanes.join(',') !== 'codex,kimi'
        || xmlDocument.querySelectorAll('surface').length !== 2
        || svgRoot?.localName !== 'svg'
        || svgRoot.getAttribute('data-canary-version') !== CANARY_VERSION
        || !svgRoot.getAttribute('viewBox')
        || svgRoot.getAttribute('role') !== 'img'
        || !svgRoot.getAttribute('aria-labelledby')
        || svgDocument.querySelectorAll('title').length !== 1
        || svgDocument.querySelectorAll('desc').length !== 1) {
        throw new Error('Sandbox XML or SVG failed the structured design contract.');
    }
    const readme = await zip.file('README.md').async('string');
    let imageManifest;
    try {
        imageManifest = JSON.parse(await zip.file('assets/images.json').async('string'));
    } catch (_error) {
        throw new Error('Sandbox bundle image manifest is invalid.');
    }
    if (!/sandbox(?:-| )agent(?:-| )attach(?:-| )canary/i.test(readme)
        || !Array.isArray(imageManifest?.images)
        || !imageManifest.images.some((entry) => String(entry?.src || '').endsWith('design/design.svg'))) {
        throw new Error('Sandbox bundle support files do not describe the deterministic project.');
    }
    return {
        sha256: sha256(buffer),
        sizeBytes: buffer.length,
        paths,
    };
}

function findCompactToolResult(run = {}, events = []) {
    if (run?.metadata?.toolResult && typeof run.metadata.toolResult === 'object') {
        return run.metadata.toolResult;
    }
    for (const event of [...(Array.isArray(events) ? events : [])].reverse()) {
        const candidate = event?.payload?.result || event?.result;
        if (candidate && typeof candidate === 'object') {
            return candidate;
        }
    }
    return null;
}

function assertNoRawResultBytes(value, currentPath = 'toolResult') {
    if (!value || typeof value !== 'object') {
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase();
        if (['contentbase64', 'database64', 'buffer', 'authorization', 'apikey', 'password', 'secret', 'token'].includes(normalizedKey)) {
            throw new Error(`Compact result exposed forbidden field ${currentPath}.${key}.`);
        }
        assertNoRawResultBytes(nested, `${currentPath}.${key}`);
    }
}

function validateCompactAgentResult(plan, toolResult) {
    if (!toolResult || typeof toolResult !== 'object') {
        throw new Error(`${plan.lane} ${plan.scenario} completed without a compact result.`);
    }
    assertNoRawResultBytes(toolResult);
    if (toolResult.success !== true
        || toolResult.blocker
        || toolResult.error
        || !SUCCESS_COMPLETION_STATUSES.has(String(toolResult.completionStatus || '').trim().toLowerCase())
        || String(toolResult.adapter || '').trim() !== 'remote-cli-agent'
        || String(toolResult.transport || '').trim() !== plan.transport
        || String(toolResult.model || '').trim() !== plan.model
        || toolResult.artifactQuality?.status !== 'passed') {
        throw new Error(`${plan.lane} ${plan.scenario} compact result failed execution identity or quality evidence.`);
    }
    if (plan.provider && String(toolResult.provider || '').trim().toLowerCase() !== plan.provider) {
        throw new Error(`${plan.lane} result used an unexpected provider.`);
    }
    if (plan.providerModel && String(toolResult.providerModel || '').trim() !== plan.providerModel) {
        throw new Error(`${plan.lane} result used an unexpected provider model.`);
    }
    const resultFiles = Array.isArray(toolResult.resultFiles) ? toolResult.resultFiles : [];
    if (resultFiles.length !== 1) {
        throw new Error(`${plan.lane} ${plan.scenario} must return exactly one file.`);
    }
    const descriptor = resultFiles[0];
    const relativePath = String(descriptor?.relativePath || descriptor?.path || '').replace(/\\/g, '/');
    const artifactId = String(descriptor?.artifactId || '').trim();
    if (descriptor?.filename !== plan.outputFilename
        || descriptor?.role !== plan.outputRole
        || String(descriptor?.mimeType || '').split(';')[0].trim().toLowerCase() !== 'application/zip'
        || Number(descriptor?.sizeBytes || 0) !== plan.expectedSizeBytes
        || String(descriptor?.sha256 || '').trim().toLowerCase() !== plan.expectedSha256
        || (descriptor?.persistedSha256 && String(descriptor.persistedSha256).trim().toLowerCase() !== plan.expectedSha256)
        || relativePath !== plan.outputRelativePath
        || !artifactId
        || !Array.isArray(toolResult.artifactIds)
        || !toolResult.artifactIds.includes(artifactId)) {
        throw new Error(`${plan.lane} ${plan.scenario} descriptor failed exact-byte or artifact identity evidence.`);
    }
    if (toolResult.siteBundleArtifactId) {
        throw new Error(`${plan.lane} ${plan.scenario} unexpectedly repacked the opaque ZIP as a site bundle.`);
    }
    return { descriptor, artifactId };
}

function validateRunIdentity(run, plan, expectedRunId, phase = 'completed') {
    if (String(run?.id || '').trim() !== expectedRunId
        || String(run?.sessionId || '').trim() !== plan.sessionId
        || String(run?.adapter || '').trim() !== 'remote-cli-agent'
        || run?.liveRemoteAllowed !== true
        || run?.metadata?.remoteAdapter !== true
        || run?.metadata?.dryRun !== false) {
        throw new Error(`${plan.lane} ${plan.scenario} ${phase} run identity is invalid.`);
    }
}

function validateRunExecutionEvidence(run, events, plan, expectedRunId) {
    validateRunIdentity(run, plan, expectedRunId);
    const eventTypes = new Set((Array.isArray(events) ? events : [])
        .map((event) => String(event?.type || '').trim().toLowerCase())
        .filter(Boolean));
    if (!eventTypes.has('tool_started')
        || !eventTypes.has('tool_completed')
        || eventTypes.has('tool_skipped')) {
        throw new Error(`${plan.lane} ${plan.scenario} lacks executed-tool evidence.`);
    }
}

async function pollRun(client, runId, options, progressContext = {}) {
    const startedAt = options.now();
    let lastProgressAt = startedAt;
    let lastStatus = '';
    let firstPoll = true;
    let after = 0;
    const collectedEvents = [];
    const eventKeys = new Set();
    while (options.now() - startedAt <= options.timeoutMs) {
        const payload = await client.requestJson(`/api/async-lab/runs/${encodeURIComponent(runId)}?after=${after}`);
        const run = payload?.run;
        const events = Array.isArray(payload?.events) ? payload.events : [];
        const newEventTypes = [];
        for (const event of events) {
            const key = String(event?.eventId || `${event?.cursor || 0}:${event?.type || ''}`);
            if (!eventKeys.has(key)) {
                eventKeys.add(key);
                collectedEvents.push(event);
                const eventType = String(event?.type || '')
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9_.-]+/g, '')
                    .slice(0, 64);
                if (eventType && !newEventTypes.includes(eventType) && newEventTypes.length < 12) {
                    newEventTypes.push(eventType);
                }
            }
        }
        after = Math.max(after, ...events.map((event) => Number(event?.cursor || 0) || 0));
        const status = String(run?.status || '').trim().toLowerCase();
        const observedAt = options.now();
        if (firstPoll
            || status !== lastStatus
            || newEventTypes.length > 0
            || observedAt - lastProgressAt >= options.progressIntervalMs) {
            emitProgress(options, 'run_progress', {
                ...progressContext,
                runId,
                status: status || 'unknown',
                elapsedMs: Math.max(0, observedAt - startedAt),
                cursor: after,
                newEventTypes,
            });
            firstPoll = false;
            lastProgressAt = observedAt;
            lastStatus = status;
        }
        if (TERMINAL_RUN_STATUSES.has(status)) {
            return { run, events: collectedEvents, status };
        }
        await options.sleep(options.pollIntervalMs);
    }
    throw new Error(`Async run ${runId} exceeded the canary timeout.`);
}

async function executeAgentRun(plan, client, runtime) {
    runtime.runStartUncertain = true;
    const created = await client.requestJson('/api/async-lab/runs', {
        method: 'POST',
        body: buildAsyncRunPayload(plan),
    });
    const runId = String(created?.run?.id || '').trim();
    if (!runId) {
        throw new Error(`${plan.lane} ${plan.scenario} was accepted without a trackable run ID.`);
    }
    runtime.activeRunIds.add(runId);
    runtime.runStartUncertain = false;
    validateRunIdentity(created.run, plan, runId, 'accepted');
    const progressContext = {
        lane: plan.lane,
        scenario: plan.scenario,
        ...(plan.surface ? { surface: plan.surface.key } : {}),
    };
    emitProgress(runtime, 'run_started', { ...progressContext, runId });
    const completed = await pollRun(client, runId, runtime, progressContext);
    if (TERMINAL_RUN_STATUSES.has(completed.status)) {
        runtime.activeRunIds.delete(runId);
    }
    if (completed.status !== 'completed') {
        throw new Error(`${plan.lane} ${plan.scenario} ended with status ${completed.status || 'unknown'}.`);
    }
    validateRunExecutionEvidence(completed.run, completed.events, plan, runId);
    const toolResult = findCompactToolResult(completed.run, completed.events);
    const compact = validateCompactAgentResult(plan, toolResult);
    const artifact = await client.requestJson(`/api/artifacts/${encodeURIComponent(compact.artifactId)}`);
    const sourceIds = artifact?.metadata?.remoteAgentHandoff?.sourceArtifactIds;
    if (artifact?.id !== compact.artifactId
        || artifact?.sessionId !== plan.sessionId
        || artifact?.parentArtifactId !== plan.sourceArtifactId
        || !Array.isArray(sourceIds)
        || !sourceIds.includes(plan.sourceArtifactId)) {
        throw new Error(`${plan.lane} ${plan.scenario} artifact lacks session-bound source lineage.`);
    }
    const downloadPath = artifactApiPath(
        artifact.downloadUrl,
        `/api/artifacts/${encodeURIComponent(compact.artifactId)}/download`,
        runtime.baseUrl,
        /\/download$/,
    );
    const buffer = await client.requestBuffer(downloadPath, { maxBytes: MAX_BUNDLE_BYTES });
    if (buffer.length !== plan.expectedSizeBytes || sha256(buffer) !== plan.expectedSha256) {
        throw new Error(`${plan.lane} ${plan.scenario} returned artifact changed the source bytes.`);
    }
    emitProgress(runtime, 'run_completed', {
        ...progressContext,
        runId,
        status: completed.status,
        artifactId: compact.artifactId,
    });
    return {
        lane: plan.lane,
        scenario: plan.scenario,
        ...(plan.surface ? { surface: plan.surface.key } : {}),
        runId,
        artifactId: compact.artifactId,
        sourceArtifactId: plan.sourceArtifactId,
        sha256: plan.expectedSha256,
        sizeBytes: plan.expectedSizeBytes,
        provider: toolResult.provider || null,
        providerModel: toolResult.providerModel || null,
    };
}

function buildSessionRequest(surface, lanes) {
    if (surface === 'source') {
        return {
            clientSurface: 'sandbox-agent-attach',
            taskType: 'sandbox-agent-attach-canary',
            mode: 'sandbox',
            metadata: {
                ephemeral: true,
                canaryVersion: CANARY_VERSION,
                canaryRole: 'sandbox-source',
                lanes,
            },
        };
    }
    const target = SURFACES[surface];
    return {
        clientSurface: target.clientSurface,
        taskType: target.taskType,
        mode: target.mode,
        metadata: {
            ephemeral: true,
            canaryVersion: CANARY_VERSION,
            canaryRole: `${surface}-target`,
            lanes,
        },
    };
}

async function createOwnedSession(client, surface, lanes) {
    const request = buildSessionRequest(surface, lanes);
    const session = await client.requestJson('/api/sessions', {
        method: 'POST',
        body: request,
    });
    const id = String(session?.id || '').trim();
    const ownerId = String(session?.metadata?.ownerId || '').trim();
    if (!id
        || !ownerId
        || String(session?.metadata?.clientSurface || '').trim() !== request.clientSurface
        || String(session?.metadata?.taskType || '').trim() !== request.taskType) {
        throw new Error(`Canary could not create an explicit owner-scoped ${surface} session.`);
    }
    return { id, ownerId, request, session };
}

async function createSandboxSource(client, sourceSession, runtime) {
    const fixtures = createFixtureFiles();
    const response = await client.requestJson('/api/tools/invoke/code-sandbox', {
        method: 'POST',
        body: createSandboxToolPayload(sourceSession.id, fixtures),
    });
    const toolEnvelope = response?.data;
    const result = toolEnvelope?.success === true && toolEnvelope?.data
        ? toolEnvelope.data
        : toolEnvelope;
    const artifactId = String(result?.artifact?.id || '').trim();
    const workspaceId = String(result?.workspaceId || '').trim();
    if (/^[a-z0-9._-]{1,140}$/i.test(workspaceId) && !runtime.workspaceIds.includes(workspaceId)) {
        runtime.workspaceIds.push(workspaceId);
    }
    const failureReasons = [
        ...(response?.success !== true ? ['route-not-successful'] : []),
        ...(toolEnvelope?.success === false
            ? [`tool-failed:${normalizeDiagnosticCode(toolEnvelope.errorCode || toolEnvelope.errorType)}`]
            : []),
        ...(response?.sessionId !== sourceSession.id ? ['route-session-mismatch'] : []),
        ...(result?.mode !== 'project' ? ['project-mode-missing'] : []),
        ...(result?.exitCode !== 0 ? ['project-exit-not-zero'] : []),
        ...(result?.artifactError ? ['artifact-persistence-error'] : []),
        ...(!artifactId ? ['artifact-id-missing'] : []),
        ...(!workspaceId ? ['workspace-id-missing'] : []),
        ...(artifactId && result?.artifact?.sessionId !== sourceSession.id ? ['artifact-session-mismatch'] : []),
        ...(workspaceId && result?.artifact?.metadata?.sandboxWorkspaceId !== workspaceId
            ? ['artifact-workspace-mismatch']
            : []),
    ];
    if (failureReasons.length > 0) {
        throw new Error(
            `code-sandbox did not persist a successful session-bound project artifact (${failureReasons.join(', ')}).`,
        );
    }
    const artifact = await client.requestJson(`/api/artifacts/${encodeURIComponent(artifactId)}`);
    if (artifact?.id !== artifactId
        || artifact?.sessionId !== sourceSession.id
        || String(artifact?.format || '').trim().toLowerCase() !== 'zip'
        || String(artifact?.mimeType || '').split(';')[0].trim().toLowerCase() !== 'application/zip'
        || !artifact?.bundleDownloadUrl
        || artifact?.metadata?.sandboxWorkspaceId !== workspaceId) {
        throw new Error('Sandbox artifact serialization did not expose a native ZIP bundle.');
    }
    const workspacePreviewPath = sandboxWorkspacePreviewApiPath(
        result.workspacePreviewUrl,
        workspaceId,
        runtime.baseUrl,
    );
    const workspacePreview = await client.requestBuffer(workspacePreviewPath, {
        accept: 'text/html',
        maxBytes: MAX_JSON_BYTES,
    });
    const previewDocument = new JSDOM(workspacePreview.toString('utf8')).window.document;
    if (previewDocument.querySelector('meta[name="sandbox-agent-attach-canary"]')?.getAttribute('content') !== CANARY_VERSION) {
        throw new Error('Sandbox workspace preview did not serve the canary project entry file.');
    }
    const downloadPath = artifactApiPath(
        artifact.downloadUrl,
        `/api/artifacts/${encodeURIComponent(artifactId)}/download`,
        runtime.baseUrl,
        /\/download$/,
    );
    const bundlePath = artifactApiPath(
        artifact.bundleDownloadUrl,
        `/api/artifacts/${encodeURIComponent(artifactId)}/bundle`,
        runtime.baseUrl,
        /\/bundle$/,
    );
    const storedBuffer = await client.requestBuffer(downloadPath, { maxBytes: MAX_BUNDLE_BYTES });
    const bundleBuffer = await client.requestBuffer(bundlePath, { maxBytes: MAX_BUNDLE_BYTES });
    const storedEvidence = await validateSandboxBundle(storedBuffer, fixtures);
    const bundleEvidence = await validateSandboxBundle(bundleBuffer, fixtures);
    if (storedEvidence.sha256 !== bundleEvidence.sha256
        || storedEvidence.sizeBytes !== bundleEvidence.sizeBytes
        || !storedBuffer.equals(bundleBuffer)
        || Number(artifact.sizeBytes || 0) !== storedEvidence.sizeBytes) {
        throw new Error('Sandbox stored download and bundle download are not the same deterministic ZIP.');
    }
    return {
        artifactId,
        workspaceId,
        workspacePreviewVerified: true,
        sha256: storedEvidence.sha256,
        sizeBytes: storedEvidence.sizeBytes,
        paths: storedEvidence.paths,
    };
}

async function expectAttachFailure(client, sourceArtifactId, targetSessionId, requestedSurface, expectedCode) {
    const result = await client.requestJsonResult(
        `/api/artifacts/${encodeURIComponent(sourceArtifactId)}/attach`,
        {
            method: 'POST',
            body: {
                targetSessionId,
                mode: requestedSurface.mode,
                taskType: requestedSurface.taskType,
                clientSurface: requestedSurface.clientSurface,
            },
        },
    );
    if (result.status !== 409
        || result.payload?.error?.code !== expectedCode
        || result.payload?.artifact) {
        throw new Error(`Cross-surface attachment did not fail closed with ${expectedCode}.`);
    }
    return { status: result.status, code: result.payload.error.code };
}

async function attachArtifact(client, source, targetSession, surface, runtime) {
    const result = await client.requestJsonResult(
        `/api/artifacts/${encodeURIComponent(source.artifactId)}/attach`,
        {
            method: 'POST',
            body: {
                targetSessionId: targetSession.id,
                mode: surface.mode,
                taskType: surface.taskType,
                clientSurface: surface.clientSurface,
            },
        },
    );
    const payload = result.payload;
    const artifactId = String(payload?.artifact?.id || '').trim();
    if (![200, 201].includes(result.status)
        || payload?.targetSessionId !== targetSession.id
        || payload?.sourceArtifactId !== source.artifactId
        || payload?.sha256 !== source.sha256
        || !artifactId
        || payload?.artifact?.sessionId !== targetSession.id
        || payload?.importCapability?.surface !== surface.clientSurface) {
        throw new Error(`${surface.key} attachment failed exact target, source, checksum, or surface evidence.`);
    }
    const artifact = await client.requestJson(`/api/artifacts/${encodeURIComponent(artifactId)}`);
    const metadata = artifact?.metadata || {};
    if (artifact?.id !== artifactId
        || artifact?.sessionId !== targetSession.id
        || metadata.handoffSourceArtifactId !== source.artifactId
        || metadata.handoffSourceSha256 !== source.sha256) {
        throw new Error(`${surface.key} attached artifact lacks exact handoff lineage.`);
    }
    const downloadPath = artifactApiPath(
        artifact.downloadUrl,
        `/api/artifacts/${encodeURIComponent(artifactId)}/download`,
        runtime.baseUrl,
        /\/download$/,
    );
    const buffer = await client.requestBuffer(downloadPath, { maxBytes: MAX_BUNDLE_BYTES });
    if (buffer.length !== source.sizeBytes || sha256(buffer) !== source.sha256) {
        throw new Error(`${surface.key} attached artifact changed the source bytes.`);
    }
    emitProgress(runtime, 'attachment_completed', {
        surface: surface.key,
        sourceArtifactId: source.artifactId,
        artifactId,
    });
    return {
        artifactId,
        sourceArtifactId: source.artifactId,
        targetSessionId: targetSession.id,
        surface: surface.key,
        sha256: source.sha256,
        sizeBytes: source.sizeBytes,
        reused: payload.reused === true,
        importDisposition: payload.importCapability?.disposition || null,
    };
}

async function cancelAndConfirmTerminal(client, runId, runtime) {
    const cancelled = await client.requestJson(`/api/async-lab/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        body: {},
    });
    const status = String(cancelled?.run?.status || '').trim().toLowerCase();
    if (TERMINAL_RUN_STATUSES.has(status)) {
        return status;
    }
    const terminal = await pollRun(client, runId, runtime);
    if (!TERMINAL_RUN_STATUSES.has(terminal.status)) {
        throw new Error(`Cancelled run ${runId} did not reach a terminal state.`);
    }
    return terminal.status;
}

async function cleanupRuntime(client, runtime) {
    emitProgress(runtime, 'cleanup_started', {
        activeRunCount: runtime.activeRunIds.size,
        sessionCount: runtime.sessionIds.length,
        workspaceCount: runtime.workspaceIds.length,
    });
    const errors = [];
    for (const runId of [...runtime.activeRunIds]) {
        try {
            await cancelAndConfirmTerminal(client, runId, runtime);
            runtime.activeRunIds.delete(runId);
        } catch (error) {
            errors.push(`run ${runId}: ${error.message}`);
        }
    }
    if (runtime.runStartUncertain || runtime.activeRunIds.size > 0) {
        const retainedCleanup = {
            deletedSessionIds: [],
            retainedSessionIds: [...runtime.sessionIds],
            deletedWorkspaceIds: [],
            retainedWorkspaceIds: [...runtime.workspaceIds],
            error: [
                ...errors,
                `Canary sessions retained because ${runtime.activeRunIds.size} run(s) remain non-terminal or a run start is untrackable.`,
            ].join(' '),
        };
        emitProgress(runtime, 'cleanup_completed', {
            deletedSessionCount: 0,
            retainedSessionCount: retainedCleanup.retainedSessionIds.length,
            deletedWorkspaceCount: 0,
            retainedWorkspaceCount: retainedCleanup.retainedWorkspaceIds.length,
            passed: false,
        });
        return retainedCleanup;
    }
    const deletedSessionIds = [];
    for (const sessionId of [...runtime.sessionIds].reverse()) {
        try {
            await client.requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
            deletedSessionIds.push(sessionId);
        } catch (error) {
            errors.push(`session ${sessionId}: ${error.message}`);
        }
    }
    const deletedWorkspaceIds = [];
    const retainedWorkspaceIds = [];
    for (const workspaceId of runtime.workspaceIds) {
        try {
            const previewPath = sandboxWorkspacePreviewApiPath('', workspaceId, runtime.baseUrl);
            const result = await client.requestStatusResult(previewPath);
            if (result.status === 404) {
                deletedWorkspaceIds.push(workspaceId);
            } else {
                retainedWorkspaceIds.push(workspaceId);
                errors.push(`workspace ${workspaceId}: preview remained available with HTTP ${result.status}`);
            }
        } catch (error) {
            retainedWorkspaceIds.push(workspaceId);
            errors.push(`workspace ${workspaceId}: ${error.message}`);
        }
    }
    const cleanup = {
        deletedSessionIds,
        retainedSessionIds: runtime.sessionIds.filter((id) => !deletedSessionIds.includes(id)),
        deletedWorkspaceIds,
        retainedWorkspaceIds,
        error: errors.join(' '),
    };
    emitProgress(runtime, 'cleanup_completed', {
        deletedSessionCount: cleanup.deletedSessionIds.length,
        retainedSessionCount: cleanup.retainedSessionIds.length,
        deletedWorkspaceCount: cleanup.deletedWorkspaceIds.length,
        retainedWorkspaceCount: cleanup.retainedWorkspaceIds.length,
        passed: !cleanup.error,
    });
    return cleanup;
}

async function runLive(lanes, options = {}) {
    const configuration = buildLiveConfiguration(options.env);
    const client = createHttpClient({
        ...configuration,
        fetchImpl: options.fetchImpl,
    });
    const runtime = {
        ...configuration,
        sleep: options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
        now: options.now || (() => Date.now()),
        activeRunIds: new Set(),
        runStartUncertain: false,
        sessionIds: [],
        workspaceIds: [],
        onProgress: options.onProgress,
    };
    let primaryError = null;
    let cleanup = null;
    let output = null;

    try {
        emitProgress(runtime, 'canary_started', {
            mode: lanes.length === 2 ? 'all' : lanes[0],
            lanes,
        });
        const auth = await client.requestJson('/api/auth/protected-check');
        if (auth?.success !== true) {
            throw new Error('KimiBuilt authentication probe did not confirm access.');
        }
        const statusPayload = await client.requestJson('/api/async-lab/status');
        if (statusPayload?.status?.enabled !== true || statusPayload?.status?.allowLiveRemote !== true) {
            throw new Error('Async runtime must allow live remote execution before --run can proceed.');
        }

        const sourceSession = await createOwnedSession(client, 'source', lanes);
        runtime.sessionIds.push(sourceSession.id);
        const sandboxSource = await createSandboxSource(client, sourceSession, runtime);
        emitProgress(runtime, 'sandbox_source_verified', {
            artifactId: sandboxSource.artifactId,
            workspaceId: sandboxSource.workspaceId,
            sizeBytes: sandboxSource.sizeBytes,
        });

        const originResults = [];
        for (const lane of lanes) {
            const plan = buildAgentPlan({
                lane,
                scenario: 'sandbox-origin',
                sessionId: sourceSession.id,
                sourceArtifactId: sandboxSource.artifactId,
                expectedSha256: sandboxSource.sha256,
                expectedSizeBytes: sandboxSource.sizeBytes,
                env: options.env,
            });
            originResults.push(await executeAgentRun(plan, client, runtime));
        }

        const canvasSession = await createOwnedSession(client, 'canvas', lanes);
        runtime.sessionIds.push(canvasSession.id);
        const notesSession = await createOwnedSession(client, 'notes', lanes);
        runtime.sessionIds.push(notesSession.id);
        if (new Set([sourceSession.id, canvasSession.id, notesSession.id]).size !== 3
            || new Set([sourceSession.ownerId, canvasSession.ownerId, notesSession.ownerId]).size !== 1) {
            throw new Error('Canary sessions are not distinct and owned by the same authenticated principal.');
        }

        const foreignSessionFailure = await expectAttachFailure(
            client,
            originResults[0].artifactId,
            sourceSession.id,
            SURFACES.notes,
            'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
        );
        const wrongSurfaceFailure = await expectAttachFailure(
            client,
            originResults[0].artifactId,
            notesSession.id,
            SURFACES.canvas,
            'ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
        );

        const lanesOutput = [];
        for (const origin of originResults) {
            const attached = {};
            const downstream = {};
            for (const surface of Object.values(SURFACES)) {
                const targetSession = surface.key === 'canvas' ? canvasSession : notesSession;
                attached[surface.key] = await attachArtifact(client, origin, targetSession, surface, runtime);
                const downstreamPlan = buildAgentPlan({
                    lane: origin.lane,
                    scenario: 'surface-return',
                    surface,
                    sessionId: targetSession.id,
                    sourceArtifactId: attached[surface.key].artifactId,
                    expectedSha256: origin.sha256,
                    expectedSizeBytes: origin.sizeBytes,
                    env: options.env,
                });
                downstream[surface.key] = await executeAgentRun(downstreamPlan, client, runtime);
            }
            lanesOutput.push({
                lane: origin.lane,
                sandboxOrigin: origin,
                attached,
                downstream,
            });
        }

        output = {
            version: CANARY_VERSION,
            mode: lanes.length === 2 ? 'all' : lanes[0],
            execution: 'live',
            passed: true,
            authenticated: true,
            sandboxSource,
            negativeAttachGates: {
                canaryOwnedForeignSession: foreignSessionFailure,
                canaryOwnedWrongSurface: wrongSurfaceFailure,
            },
            lanes: lanesOutput,
            asyncRunsTerminal: runtime.activeRunIds.size === 0 && runtime.runStartUncertain === false,
        };
    } catch (error) {
        primaryError = error;
    } finally {
        cleanup = await cleanupRuntime(client, runtime);
    }

    if (primaryError) {
        if (cleanup?.error) {
            primaryError.message = `${primaryError.message} Cleanup: ${cleanup.error}`;
        }
        throw primaryError;
    }
    if (cleanup?.error) {
        throw new Error(`Canary cleanup failed: ${cleanup.error}`);
    }
    const result = {
        ...output,
        networkRequestsMade: client.networkRequestsMade,
        ephemeralSessionsDeleted: cleanup.deletedSessionIds.length,
        retainedSessionIds: cleanup.retainedSessionIds,
        ephemeralWorkspacesDeleted: cleanup.deletedWorkspaceIds.length,
        retainedWorkspaceIds: cleanup.retainedWorkspaceIds,
    };
    emitProgress(runtime, 'canary_completed', {
        mode: result.mode,
        passed: result.passed === true,
        networkRequestsMade: result.networkRequestsMade,
    });
    return result;
}

function describeDryRun(lanes, env) {
    const fixtures = createFixtureFiles();
    const placeholderSha = sha256(Buffer.from(fixtures.map((fixture) => fixture.sha256).join(':'), 'utf8'));
    const placeholderSize = fixtures.reduce((total, fixture) => total + fixture.sizeBytes, 0) + 2048;
    const lanePlans = lanes.map((lane) => {
        const origin = buildAgentPlan({
            lane,
            scenario: 'sandbox-origin',
            sessionId: 'dry-run-source-session',
            sourceArtifactId: 'dry-run-sandbox-artifact',
            expectedSha256: placeholderSha,
            expectedSizeBytes: placeholderSize,
            env,
        });
        return {
            lane,
            origin: {
                model: origin.model,
                transport: origin.transport,
                adminMode: false,
                sourceArtifactCount: 1,
                outputRelativePath: origin.outputRelativePath,
            },
            downstream: Object.values(SURFACES).map((surface) => ({
                surface: surface.key,
                clientSurface: surface.clientSurface,
                adminMode: false,
                source: 'attached-destination-artifact-id',
            })),
        };
    });
    return {
        version: CANARY_VERSION,
        mode: lanes.length === 2 ? 'all' : lanes[0],
        execution: 'dry-run',
        passed: true,
        networkRequestsMade: 0,
        sandbox: {
            mode: 'project',
            language: 'html',
            network: false,
            requestedFiles: fixtures.map(({ path, mimeType, sizeBytes, sha256: checksum }) => ({
                path,
                mimeType,
                sizeBytes,
                sha256: checksum,
            })),
            persistedArtifactRequired: true,
            exactDownloadAndBundleValidationRequired: true,
        },
        sessions: ['sandbox-source', 'canvas-excalidraw-target', 'notes-target'],
        negativeAttachGates: [
            'canary-owned foreign-surface session must return ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
            'canary-owned Notes session requested as Canvas must return ARTIFACT_ATTACH_TARGET_SESSION_MISMATCH',
        ],
        plannedAsyncRuns: lanes.length * 3,
        cleanupGate: 'Delete ephemeral sessions and their exact artifact-linked sandbox workspaces only after every async run is terminal and every run start is trackable.',
        lanes: lanePlans,
        note: 'All payloads and exact-byte expectations were validated locally. No HTTP request, sandbox write, remote agent run, attachment, or deployment was attempted.',
    };
}

async function runCanary(options = {}) {
    const parsed = parseArguments(options.argv || []);
    if (parsed.help) {
        return {
            help: 'Usage: npm run canary:sandbox-agent-attach -- [--mode codex|kimi|all] [--run]',
        };
    }
    const env = options.env || process.env;
    const lanes = selectedLanes(parsed.mode);
    if (!parsed.run) {
        return describeDryRun(lanes, env);
    }
    return runLive(lanes, { ...options, env });
}

async function main() {
    try {
        const result = await runCanary({
            argv: process.argv.slice(2),
            env: process.env,
            onProgress: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
        });
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
    PROGRESS_VERSION,
    LANE_DEFAULTS,
    SURFACES,
    artifactApiPath,
    buildAgentPlan,
    buildAsyncRunPayload,
    buildLiveConfiguration,
    createFixtureFiles,
    createHttpClient,
    createSandboxToolPayload,
    describeDryRun,
    parseArguments,
    pollRun,
    runCanary,
    validateAgentPlan,
    validateCompactAgentResult,
    validateSandboxBundle,
};
