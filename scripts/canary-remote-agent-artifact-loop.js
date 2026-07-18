#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');
const { validateResultArtifactSet } = require('../src/artifacts/artifact-quality-gate');

const CANARY_VERSION = 'RemoteAgentArtifactLoopCanary/v1';
const AUTHORING_CANARY_VERSION = 'RemoteAgentAuthoringCanary/v1';
const ALLOWED_MODES = new Set(['codex', 'kimi', 'grok', 'all']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SUCCESS_COMPLETION_STATUSES = new Set(['complete', 'completed', 'success', 'succeeded']);
const SUCCESS_BUILD_STATUSES = new Set(['complete', 'completed', 'passed', 'success', 'succeeded']);
const SUCCESS_DEPLOY_STATUSES = new Set(['deployed', 'live', 'success', 'succeeded']);
const MANAGED_APP_TERMINAL_PHASES = new Set(['live', 'build_failed', 'deploy_failed']);
const PUSH_TO_WEB_LANE_TOKEN = '{lane}';
const CHANGE_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORING_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AUTHORING_TOTAL_BYTES = 6 * 1024 * 1024;
const ALLOWED_AUTHORED_HTML_ELEMENTS = new Set([
    'a',
    'abbr',
    'address',
    'article',
    'aside',
    'b',
    'base',
    'blockquote',
    'body',
    'br',
    'caption',
    'cite',
    'code',
    'col',
    'colgroup',
    'dd',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'head',
    'header',
    'hr',
    'html',
    'i',
    'img',
    'kbd',
    'li',
    'link',
    'main',
    'mark',
    'meta',
    'nav',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'samp',
    'section',
    'small',
    'span',
    'strong',
    'style',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'time',
    'title',
    'tr',
    'u',
    'ul',
    'var',
]);
const URL_BEARING_ATTRIBUTE_NAMES = new Set([
    'action',
    'archive',
    'attributionsrc',
    'background',
    'cite',
    'classid',
    'code',
    'codebase',
    'data',
    'dynsrc',
    'formaction',
    'href',
    'icon',
    'imagesrcset',
    'longdesc',
    'lowsrc',
    'manifest',
    'ping',
    'poster',
    'profile',
    'src',
    'srcset',
    'usemap',
    'xml:base',
]);

const AUTHORING_FILE_DEFINITIONS = Object.freeze([
    Object.freeze({
        filename: 'index.html',
        outputPath: 'index.html',
        role: 'site-entry',
        mimeType: 'text/html',
    }),
    Object.freeze({
        filename: 'styles.css',
        outputPath: 'styles.css',
        role: 'site-file',
        mimeType: 'text/css',
    }),
    Object.freeze({
        filename: 'design.xml',
        outputPath: 'design/design.xml',
        role: 'site-file',
        mimeType: 'application/xml',
    }),
    Object.freeze({
        filename: 'design.svg',
        outputPath: 'design/design.svg',
        role: 'site-file',
        mimeType: 'image/svg+xml',
    }),
]);

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
        model: 'gpt-5.6-sol',
        transport: 'provider-agent',
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
    let authoring = false;
    let browserQa = false;
    let pushToWeb = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index] || '').trim();
        if (argument === '--run') {
            run = true;
            continue;
        }
        if (argument === '--authoring') {
            authoring = true;
            continue;
        }
        if (argument === '--browser-qa') {
            browserQa = true;
            continue;
        }
        if (argument === '--push-to-web') {
            pushToWeb = true;
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
    if (pushToWeb && (!run || !authoring || !browserQa)) {
        throw new Error('--push-to-web requires --run --authoring --browser-qa.');
    }
    if (browserQa && !authoring) {
        throw new Error('--browser-qa requires --authoring.');
    }

    return { run, mode, help, authoring, browserQa, pushToWeb };
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

function buildAuthoringTask(lane, outputRoot) {
    return [
        `Run the output-only ${AUTHORING_CANARY_VERSION} for the ${lane} CLI lane.`,
        'No input artifacts or context files are supplied. Author an original, self-contained static site from this semantic brief.',
        'Read the gateway-provided RemoteAgentHandoff/v1 output contract before doing any file work.',
        `Inside its output files directory, create the nested directory ${outputRoot}.`,
        `Write exactly four returned files below ${outputRoot}:`,
        `- ${outputRoot}/index.html; role=site-entry; MIME=text/html`,
        `- ${outputRoot}/styles.css; role=site-file; MIME=text/css`,
        `- ${outputRoot}/design/design.xml; role=site-file; MIME=application/xml`,
        `- ${outputRoot}/design/design.svg; role=site-file; MIME=image/svg+xml`,
        `Every file must carry the exact version marker ${AUTHORING_CANARY_VERSION}, lane marker ${lane}, and scenario marker authoring in syntax appropriate to that format.`,
        'index.html must be valid accessible HTML: lang, UTF-8 charset, viewport, a non-empty title, one main landmark, one h1, a linked styles.css, an image using design/design.svg with useful alt text, and a link to design/design.xml.',
        'Use body data-canary-lane and data-canary-scenario attributes plus a meta remote-agent-authoring-canary version marker.',
        'styles.css must include the three markers in comments, explicit readable foreground/background colors, box-sizing, a responsive max-width layout, a focus-visible rule, and at least one @media rule.',
        'design/design.xml must have a remote-agent-authoring-canary root carrying version, lane, and scenario attributes and a contract element containing the exact version marker.',
        'design/design.svg must have a viewBox, role=img, title and desc wired through aria-labelledby, plus data-canary-version, data-canary-lane, and data-canary-scenario attributes.',
        'All HTML references must be local and resolve within these four files. Do not use external URLs, remote fonts, CDNs, data URLs, inline scripts, or inline event handlers.',
        'Choose original copy, layout, colors, and SVG artwork suitable for the lane while keeping normal text at WCAG AA contrast and the layout usable at 390px and 1440px widths.',
        'Write the RemoteAgentResultFiles/v1 manifest at the exact handoff result manifest path with one site-entry and three site-file roles. Attest the exact byte size and SHA-256 of each file and include no other returned files.',
        'Run only local syntax and checksum checks. Do not deploy, publish, install packages, use git, access the network, run kubectl, or mutate an application workspace.',
        'Do not include file contents, credentials, tokens, cookies, or environment values in the final response.',
        'Finish only with the required result-manifest marker and a concise pass or blocker summary.',
    ].join('\n');
}

function buildAuthoringPlan(lane, env = process.env) {
    const defaults = LANE_DEFAULTS[lane];
    if (!defaults) {
        throw new Error(`Unsupported canary lane: ${lane}`);
    }
    const outputRoot = `artifact-loop-canary/${lane}/authoring/site`;
    const model = String(env[defaults.modelEnv] || defaults.model).trim();
    const targetId = String(env.KIMIBUILT_CANARY_TARGET_ID || 'k3s-prod').trim();
    const cwd = String(env.KIMIBUILT_CANARY_CWD || '/opt/kimibuilt').trim();
    const task = buildAuthoringTask(lane, outputRoot);
    return {
        lane,
        scenario: 'authoring',
        inputMode: 'none-output-only',
        model,
        transport: defaults.transport,
        targetId,
        cwd,
        outputRoot,
        task,
        files: AUTHORING_FILE_DEFINITIONS.map((definition) => ({ ...definition })),
        toolParams: {
            task,
            targetId,
            cwd,
            model,
            transport: defaults.transport,
            adminMode: false,
            collectResultFiles: true,
            waitMs: normalizePositiveInteger(env.KIMIBUILT_CANARY_AGENT_WAIT_MS, 120000, {
                min: 1000,
                max: 300000,
            }),
        },
    };
}

function validateAuthoringPlan(plan = {}) {
    if (!LANE_DEFAULTS[plan.lane] || plan.scenario !== 'authoring') {
        throw new Error('Authoring canary plan is missing a supported lane or scenario.');
    }
    if (!plan.model || !plan.targetId || !plan.cwd || !plan.outputRoot) {
        throw new Error(`Authoring canary ${plan.lane} is missing model, target, workspace, or output configuration.`);
    }
    if (plan.inputMode !== 'none-output-only'
        || plan.toolParams?.adminMode !== false
        || plan.toolParams?.collectResultFiles !== true
        || plan.toolParams?.transport !== plan.transport) {
        throw new Error(`Authoring canary ${plan.lane} must be output-only, non-admin, and collect result files.`);
    }
    for (const forbidden of ['contextFiles', 'artifactIds', 'resultFileGlobs', 'sessionId']) {
        if (Object.hasOwn(plan.toolParams, forbidden)) {
            throw new Error(`Authoring canary ${plan.lane} must not supply ${forbidden}.`);
        }
    }
    if (!Array.isArray(plan.files)
        || plan.files.length !== 4
        || plan.files.filter((file) => file.role === 'site-entry').length !== 1
        || plan.files.filter((file) => file.role === 'site-file').length !== 3
        || new Set(plan.files.map((file) => file.outputPath)).size !== 4) {
        throw new Error(`Authoring canary ${plan.lane} must request exactly one site entry and three unique site files.`);
    }
    if (!plan.task.includes('No input artifacts or context files are supplied')
        || !plan.task.includes('RemoteAgentHandoff/v1 output contract')
        || !plan.task.includes(AUTHORING_CANARY_VERSION)
        || !plan.task.includes(`lane marker ${plan.lane}`)
        || !plan.task.includes('scenario marker authoring')
        || !plan.task.includes('Do not deploy, publish, install packages, use git, access the network, run kubectl')) {
        throw new Error(`Authoring canary ${plan.lane} task is missing its semantic or safety contract.`);
    }
    return true;
}

function describeAuthoringPlan(plan, options = {}) {
    return {
        lane: plan.lane,
        scenario: plan.scenario,
        version: AUTHORING_CANARY_VERSION,
        inputMode: plan.inputMode,
        inputArtifactCount: 0,
        model: plan.model,
        transport: plan.transport,
        targetId: plan.targetId,
        cwd: plan.cwd,
        adminMode: false,
        outputRoot: plan.outputRoot,
        resultFileCount: plan.files.length,
        files: plan.files.map((file) => ({ ...file })),
        browserQaPlanned: options.browserQa === true,
        payloadValid: true,
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

function normalizeExactPublicHost(value = '') {
    const host = String(value || '').trim();
    if (!host || host !== host.toLowerCase() || host.includes('://') || host.includes('*')) {
        return '';
    }
    let parsed;
    try {
        parsed = new URL(`https://${host}`);
    } catch (_error) {
        return '';
    }
    if (parsed.protocol !== 'https:'
        || parsed.hostname !== host
        || parsed.host !== host
        || parsed.port
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash) {
        return '';
    }
    const labels = host.split('.');
    if (labels.length < 2
        || host.length > 253
        || /^\d+(?:\.\d+){3}$/.test(host)
        || labels.some((label) => label.length > 63
            || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
        return '';
    }
    return host;
}

function buildPushToWebConfiguration(env = process.env, lanes = []) {
    if (String(env.ALLOW_PROD_WRITE || '') !== 'yes') {
        throw new Error('Push-to-Web canary requires ALLOW_PROD_WRITE=yes.');
    }
    if (String(env.HUMAN_APPROVED || '') !== 'yes') {
        throw new Error('Push-to-Web canary requires HUMAN_APPROVED=yes.');
    }
    const changeTicket = String(env.CHANGE_TICKET || '').trim();
    if (!CHANGE_TICKET_PATTERN.test(changeTicket)) {
        throw new Error('Push-to-Web canary requires a valid CHANGE_TICKET.');
    }

    const hostTemplate = String(env.KIMIBUILT_CANARY_PUSH_TO_WEB_HOST_TEMPLATE || '');
    const approvedHostTemplate = String(env.KIMIBUILT_CANARY_APPROVED_HOST_TEMPLATE || '');
    if (!hostTemplate
        || !approvedHostTemplate
        || hostTemplate !== hostTemplate.trim()
        || approvedHostTemplate !== approvedHostTemplate.trim()
        || hostTemplate !== approvedHostTemplate) {
        throw new Error('Push-to-Web canary requires an exact approved host template match.');
    }
    if (hostTemplate !== hostTemplate.toLowerCase()
        || (hostTemplate.match(/\{lane\}/g) || []).length !== 1
        || /[{}]/.test(hostTemplate.replace(PUSH_TO_WEB_LANE_TOKEN, ''))) {
        throw new Error(`Push-to-Web host template must contain exactly one ${PUSH_TO_WEB_LANE_TOKEN} token.`);
    }

    const selected = Array.isArray(lanes) ? lanes : [];
    if (selected.length === 0 || selected.some((lane) => !LANE_DEFAULTS[lane])) {
        throw new Error('Push-to-Web canary requires at least one supported lane.');
    }
    const hosts = {};
    const publicOrigins = {};
    for (const lane of selected) {
        const host = normalizeExactPublicHost(hostTemplate.replace(PUSH_TO_WEB_LANE_TOKEN, lane));
        if (!host) {
            throw new Error(`Push-to-Web host template produced an invalid ${lane} hostname.`);
        }
        hosts[lane] = host;
        publicOrigins[lane] = `https://${host}`;
    }
    if (new Set(Object.values(hosts)).size !== selected.length) {
        throw new Error('Push-to-Web host template must produce one unique hostname per lane.');
    }

    return {
        changeTicket,
        hostTemplate,
        approvedHostTemplate,
        hosts,
        publicOrigins,
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
    const scenario = plan.scenario === 'authoring' ? 'authoring' : `hop-${plan.hop}`;
    const planFingerprint = plan.scenario === 'authoring'
        ? sha256(Buffer.from(`${AUTHORING_CANARY_VERSION}:${plan.lane}:${plan.outputRoot}`, 'utf8'))
        : sha256(Buffer.from(plan.fixtures.map((fixture) => fixture.sha256).join(':'), 'utf8'));
    return {
        task: plan.task,
        adapter: 'remote-cli-agent',
        targetKey: plan.targetId,
        liveRemote: true,
        sessionId,
        idempotencyKey: `artifact-loop-canary:${sessionId}:${plan.lane}:${scenario}:${planFingerprint.slice(0, 20)}`,
        metadata: {
            source: 'remote-agent-artifact-loop-canary',
            canaryVersion: CANARY_VERSION,
            lane: plan.lane,
            scenario,
            ...(plan.scenario === 'authoring'
                ? { authoringCanaryVersion: AUTHORING_CANARY_VERSION }
                : { hop: plan.hop }),
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
    const runLabel = plan.scenario === 'authoring' ? 'authoring' : `hop ${plan.hop}`;
    if (!toolResult || typeof toolResult !== 'object') {
        throw new Error(`The ${plan.lane} ${runLabel} run completed without a compact tool result.`);
    }
    assertNoRawResultFields(toolResult);
    if (toolResult.success !== true || toolResult.blocker || toolResult.error) {
        throw new Error(`The ${plan.lane} compact tool result reported a failure or blocker.`);
    }
    if (!SUCCESS_COMPLETION_STATUSES.has(String(toolResult.completionStatus || '').trim().toLowerCase())) {
        throw new Error(`The ${plan.lane} compact tool result did not attest completion.`);
    }
    if (String(toolResult.adapter || '').trim() !== 'remote-cli-agent') {
        throw new Error(`The ${plan.lane} compact result came from an unexpected adapter.`);
    }
    if (String(toolResult.transport || '').trim() !== plan.transport) {
        throw new Error(`The ${plan.lane} run used an unexpected transport.`);
    }
    if (String(toolResult.model || '').trim() !== plan.model) {
        throw new Error(`The ${plan.lane} run did not preserve the requested model in its compact result.`);
    }
    const provider = String(toolResult.provider || '').trim().toLowerCase();
    if (plan.lane === 'kimi' && provider !== 'kimi-code-cli') {
        throw new Error('The Kimi canary did not return exact Kimi provider evidence.');
    }
    if (plan.lane === 'kimi' && String(toolResult.providerModel || '').trim() !== 'k3') {
        throw new Error('The Kimi canary did not attest the resolved K3 provider model.');
    }
    if (plan.lane === 'grok' && provider !== 'grok-build-cli') {
        throw new Error('The Grok canary did not return exact Grok provider evidence.');
    }
    if (plan.lane === 'grok' && String(toolResult.providerModel || '').trim() !== 'grok-build') {
        throw new Error('The Grok canary did not attest the resolved Grok Build provider model.');
    }
    if (toolResult.artifactQuality?.status !== 'passed') {
        throw new Error(`The ${plan.lane} artifact quality gate did not pass.`);
    }

    const expectedFiles = plan.scenario === 'authoring' ? plan.files : plan.fixtures;
    const resultFiles = Array.isArray(toolResult.resultFiles) ? toolResult.resultFiles : [];
    if (resultFiles.length !== expectedFiles.length) {
        throw new Error(`The ${plan.lane} compact result did not contain four component descriptors.`);
    }
    const componentArtifacts = [];
    const artifactIds = new Set();
    let totalSizeBytes = 0;
    for (const expected of expectedFiles) {
        const descriptor = resultFiles.find((file) => file?.filename === expected.filename);
        const validDynamicBytes = plan.scenario === 'authoring'
            ? Number.isInteger(descriptor?.sizeBytes)
                && descriptor.sizeBytes > 0
                && descriptor.sizeBytes <= MAX_AUTHORING_FILE_BYTES
                && /^[a-f0-9]{64}$/.test(String(descriptor?.sha256 || ''))
            : descriptor?.sha256 === expected.sha256 && descriptor?.sizeBytes === expected.sizeBytes;
        const validMimeType = plan.scenario !== 'authoring'
            || String(descriptor?.mimeType || '').split(';')[0].trim().toLowerCase() === expected.mimeType;
        if (!descriptor
            || descriptor.role !== expected.role
            || !validMimeType
            || !validDynamicBytes
            || !descriptor.artifactId
            || artifactIds.has(descriptor.artifactId)) {
            throw new Error(`The ${plan.lane} result descriptor for ${expected.filename} failed byte, MIME, identity, or role attestation.`);
        }
        artifactIds.add(descriptor.artifactId);
        totalSizeBytes += descriptor.sizeBytes;
        const relativePath = String(descriptor.relativePath || descriptor.path || '').replace(/\\/g, '/');
        const expectedPath = `${plan.outputRoot}/${expected.outputPath}`;
        if (relativePath !== expectedPath) {
            throw new Error(`The ${plan.lane} result descriptor for ${expected.filename} is outside the expected nested site.`);
        }
        componentArtifacts.push({ fixture: expected, descriptor });
    }
    if (plan.scenario === 'authoring' && totalSizeBytes > MAX_AUTHORING_TOTAL_BYTES) {
        throw new Error(`The ${plan.lane} authored result descriptors exceeded the aggregate byte limit.`);
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

function validateRunIdentity(run, plan, options = {}) {
    const runLabel = plan.scenario === 'authoring' ? 'authoring' : `hop ${plan.hop}`;
    const phase = options.phase === 'accepted' ? 'accepted' : 'completed';
    if (String(run?.id || '').trim() !== String(options.expectedRunId || '').trim()
        || String(run?.sessionId || '').trim() !== String(options.expectedSessionId || '').trim()
        || String(run?.adapter || '').trim() !== 'remote-cli-agent') {
        throw new Error(`The ${plan.lane} ${runLabel} ${phase} run did not match the expected run, session, and adapter identity.`);
    }
    return true;
}

function validateRunExecutionEvidence(run, events, plan, options = {}) {
    const runLabel = plan.scenario === 'authoring' ? 'authoring' : `hop ${plan.hop}`;
    validateRunIdentity(run, plan, {
        ...options,
        phase: 'completed',
    });
    if (run?.liveRemoteAllowed !== true
        || run?.metadata?.remoteAdapter !== true
        || run?.metadata?.dryRun !== false) {
        throw new Error(`The ${plan.lane} ${runLabel} run did not attest an allowed non-dry remote adapter execution.`);
    }
    const eventTypes = new Set((Array.isArray(events) ? events : [])
        .map((event) => String(event?.type || '').trim().toLowerCase())
        .filter(Boolean));
    if (!eventTypes.has('tool_started')
        || !eventTypes.has('tool_completed')
        || eventTypes.has('tool_skipped')) {
        throw new Error(`The ${plan.lane} ${runLabel} run lacks required tool execution evidence.`);
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

function isAllowedAuthoredReference(element, attributeName, value) {
    const tagName = String(element?.localName || '').toLowerCase();
    const normalizedAttributeName = String(attributeName || '').toLowerCase();
    const normalized = String(value || '').trim();
    if ((normalizedAttributeName === 'href' || normalizedAttributeName.endsWith(':href'))
        && normalized.startsWith('#')
        && normalized.length > 1) {
        return true;
    }
    if (tagName === 'link' && normalizedAttributeName === 'href') {
        return /^(?:\.\/)?styles\.css$/.test(normalized);
    }
    if (tagName === 'img' && normalizedAttributeName === 'src') {
        return /^(?:\.\/)?design\/design\.svg$/.test(normalized);
    }
    if (tagName === 'a' && normalizedAttributeName === 'href') {
        return /^(?:\.\/)?design\/design\.xml$/.test(normalized);
    }
    return false;
}

function assertAllowedAuthoredCssReferences(plan, css, label = 'CSS') {
    const text = String(css || '');
    if (text.includes('\\')) {
        throw new Error(`The ${plan.lane} authored ${label} included a CSS escape that could conceal a reference.`);
    }
    const parsedText = text.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/@import\b/i.test(parsedText)) {
        throw new Error(`The ${plan.lane} authored ${label} included an imported stylesheet.`);
    }
    if (/(?:^|[^a-z0-9_-])(?:-webkit-)?(?:image-set|image|cross-fade|src)\s*\(/i.test(parsedText)) {
        throw new Error(`The ${plan.lane} authored ${label} included an image function that could conceal a reference.`);
    }
    const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let match;
    while ((match = urlPattern.exec(parsedText)) !== null) {
        const reference = String(match[1] ?? match[2] ?? match[3] ?? '').trim();
        if (!reference
            || (reference.startsWith('#') && reference.length > 1)
            || /^(?:\.\/)?design\/design\.svg$/.test(reference)) {
            continue;
        }
        throw new Error(`The ${plan.lane} authored ${label} included a reference outside the four-file site.`);
    }
}

function canonicalizeAuthoredHtml(html, options = {}) {
    const dom = new JSDOM(String(html || ''));
    const document = dom.window.document;
    if (options.removePreviewBase === true) {
        document.querySelector('base')?.remove();
    }
    const serialize = (node) => {
        if (node.nodeType === 1) {
            const attributes = [...node.attributes]
                .map((attribute) => [attribute.name.toLowerCase(), attribute.value])
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
                .join(';');
            return `<${node.localName}|${attributes}>${[...node.childNodes].map(serialize).join('')}</${node.localName}>`;
        }
        if (node.nodeType === 3) {
            return String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
        }
        if (node.nodeType === 8) {
            return `<!--${String(node.nodeValue || '').trim()}-->`;
        }
        return '';
    };
    return serialize(document.documentElement);
}

function assertAuthoredHtmlSemantics(plan, html, options = {}) {
    if (String(html || '').includes('\ufffd')) {
        throw new Error(`The ${plan.lane} authored HTML contains an invalid UTF-8 replacement character.`);
    }
    const dom = new JSDOM(String(html || ''));
    const document = dom.window.document;
    const root = document.documentElement;
    const body = document.body;
    const title = document.querySelector('title')?.textContent?.trim() || '';
    const charset = document.querySelector('meta[charset]')?.getAttribute('charset')?.trim().toLowerCase() || '';
    const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
    const version = document.querySelector('meta[name="remote-agent-authoring-canary"]')?.getAttribute('content') || '';
    const stylesheet = [...document.querySelectorAll('link[rel]')]
        .find((element) => element.relList?.contains('stylesheet'));
    const image = [...document.querySelectorAll('img[src]')]
        .find((element) => /^(?:\.\/)?design\/design\.svg$/.test(element.getAttribute('src') || ''));
    const xmlLink = [...document.querySelectorAll('a[href]')]
        .find((element) => /^(?:\.\/)?design\/design\.xml$/.test(element.getAttribute('href') || ''));

    if (root?.getAttribute('lang')?.trim().toLowerCase() !== 'en'
        || charset !== 'utf-8'
        || !/\bwidth\s*=\s*device-width\b/i.test(viewport)
        || !title
        || version !== AUTHORING_CANARY_VERSION
        || body?.dataset?.canaryLane !== plan.lane
        || body?.dataset?.canaryScenario !== 'authoring'
        || document.querySelectorAll('main').length !== 1
        || document.querySelectorAll('h1').length !== 1
        || !stylesheet
        || !/^(?:\.\/)?styles\.css$/.test(stylesheet.getAttribute('href') || '')
        || !image
        || !(image.getAttribute('alt') || '').trim()
        || !xmlLink) {
        throw new Error(`The ${plan.lane} authored HTML failed required accessible, linked, or canary semantics.`);
    }

    const previewBase = document.querySelectorAll('base');
    const expectedPreviewBaseHref = String(options.expectedPreviewBaseHref || '').trim();
    if (document.querySelector('script, iframe, frame, frameset, object, embed, form')
        || document.querySelector('meta[http-equiv="refresh" i]')
        || (!options.preview && previewBase.length > 0)
        || (options.preview && (previewBase.length !== 1
            || previewBase[0].getAttribute('href') !== expectedPreviewBaseHref))) {
        throw new Error(`The ${plan.lane} authored HTML included an active element, redirect, or unexpected base element.`);
    }
    for (const element of document.querySelectorAll('*')) {
        if (!ALLOWED_AUTHORED_HTML_ELEMENTS.has(String(element.localName || '').toLowerCase())) {
            throw new Error(`The ${plan.lane} authored HTML included an unsupported or active element.`);
        }
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim();
            if (name.startsWith('on') || name === 'srcdoc') {
                throw new Error(`The ${plan.lane} authored HTML included an inline event handler.`);
            }
            if (name === 'http-equiv') {
                throw new Error(`The ${plan.lane} authored HTML included an unsupported HTTP-equivalent directive.`);
            }
            if (element.localName === 'base' && name === 'href' && options.preview) {
                continue;
            }
            if ((URL_BEARING_ATTRIBUTE_NAMES.has(name)
                || name.endsWith(':href')
                || name.endsWith(':base'))
                && !isAllowedAuthoredReference(element, name, value)) {
                throw new Error(`The ${plan.lane} authored HTML included a reference outside the four-file site.`);
            }
        }
    }
    for (const inlineCss of [
        ...[...document.querySelectorAll('[style]')].map((element) => element.getAttribute('style') || ''),
        ...[...document.querySelectorAll('style')].map((element) => element.textContent || ''),
    ]) {
        assertAllowedAuthoredCssReferences(plan, inlineCss, 'inline CSS');
    }
    return {
        title,
        mainLandmarks: 1,
        headings: 1,
        localSvg: true,
        localXml: true,
    };
}

function assertAuthoredCssSemantics(plan, css) {
    const text = String(css || '');
    const rules = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const requiredMarkers = [
        AUTHORING_CANARY_VERSION,
        `canary-lane: ${plan.lane}`,
        'canary-scenario: authoring',
    ];
    if (requiredMarkers.some((marker) => !text.includes(marker))
        || !/\bbox-sizing\s*:/i.test(rules)
        || !/\bmax-width\s*:/i.test(rules)
        || !/:focus-visible\b/i.test(rules)
        || !/@media\b/i.test(rules)
        || !/(?:^|[;{])\s*color\s*:/im.test(rules)
        || !/(?:background|background-color)\s*:/i.test(rules)) {
        throw new Error(`The ${plan.lane} authored CSS failed marker, responsive, focus, or color semantics.`);
    }
    assertAllowedAuthoredCssReferences(plan, rules);
    return { responsive: true, focusVisible: true, explicitColors: true };
}

function validateAuthoredPreview(plan, sourceHtml, previewHtml, options = {}) {
    assertAuthoredHtmlSemantics(plan, sourceHtml);
    assertAuthoredHtmlSemantics(plan, previewHtml, {
        preview: true,
        expectedPreviewBaseHref: options.expectedPreviewBaseHref,
    });
    const sourceCanonical = canonicalizeAuthoredHtml(sourceHtml);
    const previewCanonical = canonicalizeAuthoredHtml(previewHtml, { removePreviewBase: true });
    if (sourceCanonical !== previewCanonical) {
        throw new Error(`The ${plan.lane} authored preview did not render the verified index document.`);
    }
    return { sourceSha256: sha256(Buffer.from(sourceCanonical, 'utf8')) };
}

function parseXmlForCanary(plan, text, contentType, expectedRoot) {
    let document;
    try {
        document = new JSDOM(String(text || ''), { contentType }).window.document;
    } catch (_error) {
        throw new Error(`The ${plan.lane} authored ${expectedRoot} could not be parsed.`);
    }
    const root = document.documentElement;
    if (!root || root.localName.toLowerCase() !== expectedRoot) {
        throw new Error(`The ${plan.lane} authored ${expectedRoot} used an unexpected root element.`);
    }
    return { document, root };
}

function assertAuthoredXmlSafety(plan, source, label) {
    const text = String(source || '');
    const lexicalBody = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^\uFEFF?\s*<\?xml(?:\s+[^?]*)?\?>/i, '');
    if (/<!DOCTYPE\b/i.test(lexicalBody) || /<\?/.test(lexicalBody)) {
        throw new Error(`The ${plan.lane} authored ${label} included a processing instruction or document type.`);
    }

    const { document } = parseXmlForCanary(
        plan,
        text,
        label === 'SVG' ? 'image/svg+xml' : 'text/xml',
        label === 'SVG' ? 'svg' : 'remote-agent-authoring-canary',
    );
    for (const element of document.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            const name = String(attribute.name || '').toLowerCase();
            if (name === 'xmlns' || name.startsWith('xmlns:')) {
                if (label === 'SVG'
                    && name === 'xmlns'
                    && attribute.value === 'http://www.w3.org/2000/svg') {
                    continue;
                }
                throw new Error(`The ${plan.lane} authored ${label} included an unsupported namespace declaration.`);
            }
            if (URL_BEARING_ATTRIBUTE_NAMES.has(name)
                || name.endsWith(':href')
                || name.endsWith(':base')
                || name.endsWith('schemalocation')) {
                throw new Error(`The ${plan.lane} authored ${label} included an external-reference attribute.`);
            }
        }
    }
    return document;
}

function assertAuthoredXmlSemantics(plan, xml) {
    const document = assertAuthoredXmlSafety(plan, xml, 'XML');
    const root = document.documentElement;
    const contract = [...root.getElementsByTagName('contract')][0]?.textContent?.trim() || '';
    if (root.namespaceURI
        || document.querySelector('style, [style]')
        || root.getAttribute('version') !== '1'
        || root.getAttribute('lane') !== plan.lane
        || root.getAttribute('scenario') !== 'authoring'
        || contract !== AUTHORING_CANARY_VERSION) {
        throw new Error(`The ${plan.lane} authored XML failed version, lane, scenario, or contract semantics.`);
    }
    return { root: 'remote-agent-authoring-canary', contract };
}

function assertAuthoredSvgSemantics(plan, svg) {
    const document = assertAuthoredXmlSafety(plan, svg, 'SVG');
    const root = document.documentElement;
    if (document.querySelector('script, foreignObject, animate, animateMotion, animateTransform, set, discard')) {
        throw new Error(`The ${plan.lane} authored SVG included an active element.`);
    }
    for (const inlineCss of [
        ...[...document.querySelectorAll('[style]')].map((element) => element.getAttribute('style') || ''),
        ...[...document.querySelectorAll('style')].map((element) => element.textContent || ''),
    ]) {
        assertAllowedAuthoredCssReferences(plan, inlineCss, 'SVG CSS');
    }
    const labelledBy = new Set(String(root.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean));
    const title = [...root.getElementsByTagName('title')][0];
    const description = [...root.getElementsByTagName('desc')][0];
    if (root.namespaceURI !== 'http://www.w3.org/2000/svg'
        || !root.getAttribute('viewBox')
        || root.getAttribute('role') !== 'img'
        || root.getAttribute('data-canary-version') !== AUTHORING_CANARY_VERSION
        || root.getAttribute('data-canary-lane') !== plan.lane
        || root.getAttribute('data-canary-scenario') !== 'authoring'
        || !title?.id
        || !description?.id
        || !(title.textContent || '').trim()
        || !(description.textContent || '').trim()
        || !labelledBy.has(title.id)
        || !labelledBy.has(description.id)) {
        throw new Error(`The ${plan.lane} authored SVG failed accessible image or canary semantics.`);
    }
    return { accessibleImage: true, viewBox: root.getAttribute('viewBox') };
}

function validateAuthoredArtifactSet(plan, authoredFiles = []) {
    if (plan.scenario !== 'authoring'
        || authoredFiles.length !== plan.files.length
        || new Set(authoredFiles.map((file) => file.definition?.outputPath)).size !== plan.files.length) {
        throw new Error(`The ${plan.lane} authored result set did not contain exactly four unique expected files.`);
    }
    const quality = validateResultArtifactSet({
        files: authoredFiles.map(({ definition, buffer }) => ({
            relativePath: definition.outputPath,
            filename: definition.filename,
            role: definition.role,
            mimeType: definition.mimeType,
            buffer,
        })),
    });
    if (quality.status !== 'passed'
        || quality.blockers.length > 0
        || quality.site?.enabled !== true
        || quality.site.entries.length !== 1
        || !quality.site.entries[0].endsWith('index.html')) {
        const blocker = quality.blockers[0]?.code || 'unknown-structural-blocker';
        throw new Error(`The ${plan.lane} authored files failed the local structural gate: ${blocker}.`);
    }

    const byPath = new Map(authoredFiles.map((file) => [file.definition.outputPath, file]));
    const texts = Object.fromEntries([...byPath].map(([filePath, file]) => [filePath, file.buffer.toString('utf8')]));
    if (Object.values(texts).some((text) => text.includes('artifact-loop-canary-v1'))) {
        throw new Error(`The ${plan.lane} authoring scenario copied the deterministic transfer fixture marker.`);
    }
    const semantics = {
        html: assertAuthoredHtmlSemantics(plan, texts['index.html']),
        css: assertAuthoredCssSemantics(plan, texts['styles.css']),
        xml: assertAuthoredXmlSemantics(plan, texts['design/design.xml']),
        svg: assertAuthoredSvgSemantics(plan, texts['design/design.svg']),
    };
    return { quality, semantics };
}

async function validateAuthoredSiteZip(zipBuffer, plan, authoredFiles) {
    let zip;
    try {
        zip = await JSZip.loadAsync(zipBuffer, { checkCRC32: true });
    } catch (_error) {
        throw new Error(`The ${plan.lane} authored site bundle is not a valid ZIP archive.`);
    }
    const archivePaths = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
    const expectedPaths = authoredFiles.map((file) => file.definition.outputPath).sort();
    if (JSON.stringify(archivePaths) !== JSON.stringify(expectedPaths)) {
        throw new Error(`The ${plan.lane} authored site ZIP did not contain exactly the four expected paths.`);
    }
    for (const file of authoredFiles) {
        const entry = zip.file(file.definition.outputPath);
        const buffer = entry ? await entry.async('nodebuffer') : null;
        if (!buffer || buffer.length !== file.buffer.length || sha256(buffer) !== sha256(file.buffer)) {
            throw new Error(`The ${plan.lane} authored site ZIP changed ${file.definition.outputPath}.`);
        }
    }
    return archivePaths;
}

function execFileAsync(execFileImpl, executable, args, options) {
    return new Promise((resolve, reject) => {
        execFileImpl(executable, args, options, (error, stdout = '', stderr = '') => {
            if (error) {
                error.message = `${error.message}${stderr ? `: ${String(stderr).slice(0, 800)}` : ''}`;
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

async function runBrowserQa(options = {}) {
    const previewUrl = new URL(String(options.previewUrl || ''));
    if (!['http:', 'https:'].includes(previewUrl.protocol)
        || previewUrl.username
        || previewUrl.password
        || previewUrl.search
        || !/^\/api\/artifacts\/[^/]+\/preview\/?$/.test(previewUrl.pathname)) {
        throw new Error('Browser QA requires a credential-free canonical artifact preview URL.');
    }
    const lane = String(options.lane || '').trim().toLowerCase();
    if (!LANE_DEFAULTS[lane]) {
        throw new Error('Browser QA requires a supported canary lane.');
    }
    const inheritedEnv = { ...process.env, ...(options.env || {}) };
    inheritedEnv.API_BASE_URL = previewUrl.origin;
    const outDir = path.resolve(
        String(inheritedEnv.KIMIBUILT_CANARY_UI_CHECK_OUT_DIR || path.join(
            process.cwd(),
            'ui-checks',
            'remote-agent-authoring',
            `${lane}-${Date.now()}`,
        )),
    );
    const scriptPath = path.resolve(__dirname, '..', 'bin', 'kimibuilt-ui-check.js');
    const args = [scriptPath, previewUrl.toString(), '--out', outDir, '--same-origin-only'];
    const { stdout } = await execFileAsync(
        options.execFileImpl || execFile,
        process.execPath,
        args,
        {
            cwd: process.cwd(),
            env: inheritedEnv,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
        },
    );
    const resultLine = stdout.split(/\r?\n/)
        .find((line) => line.startsWith('KIMIBUILT_UI_CHECK_RESULT='));
    if (!resultLine) {
        throw new Error(`The ${lane} browser QA did not return a UI-check summary.`);
    }
    let summary;
    try {
        summary = JSON.parse(resultLine.slice('KIMIBUILT_UI_CHECK_RESULT='.length));
    } catch (_error) {
        throw new Error(`The ${lane} browser QA returned an invalid UI-check summary.`);
    }
    if (summary?.ok !== true
        || Number(summary?.checkedViewports || 0) < 2
        || !Array.isArray(summary?.issues)
        || summary.issues.length > 0) {
        throw new Error(`The ${lane} browser QA reported a visual release blocker.`);
    }
    return {
        ok: true,
        checkedViewports: summary.checkedViewports,
        issues: [],
        outDir,
    };
}

async function runPublicBrowserQa(options = {}) {
    const publicUrl = new URL(String(options.publicUrl || ''));
    const expectedOrigin = new URL(String(options.expectedOrigin || ''));
    if (publicUrl.protocol !== 'https:'
        || expectedOrigin.protocol !== 'https:'
        || publicUrl.origin !== expectedOrigin.origin
        || publicUrl.username
        || publicUrl.password
        || publicUrl.search
        || publicUrl.hash
        || !['', '/'].includes(publicUrl.pathname)
        || expectedOrigin.pathname !== '/'
        || expectedOrigin.search
        || expectedOrigin.hash) {
        throw new Error('Public browser QA requires the exact approved credential-free HTTPS origin.');
    }
    const lane = String(options.lane || '').trim().toLowerCase();
    if (!LANE_DEFAULTS[lane]) {
        throw new Error('Public browser QA requires a supported canary lane.');
    }
    const inheritedEnv = { ...process.env, ...(options.env || {}) };
    inheritedEnv.API_BASE_URL = publicUrl.origin;
    [
        'KIMIBUILT_FRONTEND_API_KEY',
        'FRONTEND_API_KEY',
        'GATEWAY_API_KEY',
        'N8N_API_KEY',
    ].forEach((name) => delete inheritedEnv[name]);
    const outDir = path.resolve(
        String(inheritedEnv.KIMIBUILT_CANARY_LIVE_UI_CHECK_OUT_DIR || path.join(
            process.cwd(),
            'ui-checks',
            'remote-agent-authoring-live',
            `${lane}-${Date.now()}`,
        )),
    );
    const scriptPath = path.resolve(__dirname, '..', 'bin', 'kimibuilt-ui-check.js');
    const args = [scriptPath, `${publicUrl.origin}/`, '--out', outDir, '--same-origin-only'];
    const { stdout } = await execFileAsync(
        options.execFileImpl || execFile,
        process.execPath,
        args,
        {
            cwd: process.cwd(),
            env: inheritedEnv,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
        },
    );
    const resultLine = stdout.split(/\r?\n/)
        .find((line) => line.startsWith('KIMIBUILT_UI_CHECK_RESULT='));
    if (!resultLine) {
        throw new Error(`The ${lane} public browser QA did not return a UI-check summary.`);
    }
    let summary;
    try {
        summary = JSON.parse(resultLine.slice('KIMIBUILT_UI_CHECK_RESULT='.length));
    } catch (_error) {
        throw new Error(`The ${lane} public browser QA returned an invalid UI-check summary.`);
    }
    if (summary?.ok !== true
        || Number(summary?.checkedViewports || 0) < 2
        || !Array.isArray(summary?.issues)
        || summary.issues.length > 0) {
        throw new Error(`The ${lane} public browser QA reported a visual release blocker.`);
    }
    return {
        ok: true,
        checkedViewports: summary.checkedViewports,
        issues: [],
        outDir,
        publicUrl: `${publicUrl.origin}/`,
    };
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
        sizeBytes: files.reduce((total, file) => total + file.buffer.length, 0),
        files: files.map((file) => ({
            path: file.path,
            sizeBytes: file.buffer.length,
            sha256: sha256(file.buffer),
        })),
    };
}

function validatePreflight(payload, plan, expectedFingerprint, expectedArtifactId) {
    const status = String(payload?.status || payload?.preflight?.status || '').trim().toLowerCase();
    const blockers = payload?.blockers || payload?.preflight?.blockers || [];
    if (payload?.ok === false
        || payload?.eligible === false
        || payload?.preflight?.eligible === false
        || payload?.contentEligible !== true
        || payload?.controlPlaneAvailable !== true
        || payload?.pushToWebEligible !== true
        || String(payload?.artifactId || '').trim() !== expectedArtifactId
        || String(payload?.sourceType || '').trim() !== 'native-site-archive'
        || ['blocked', 'failed', 'error'].includes(status)
        || (Array.isArray(blockers) && blockers.length > 0)) {
        throw new Error(`The ${plan.lane} managed-app preflight reported a deployment blocker.`);
    }
    if (payload?.sha256 !== expectedFingerprint.sha256
        || payload?.sizeBytes !== expectedFingerprint.sizeBytes
        || payload?.fileCount !== expectedFingerprint.files.length) {
        throw new Error(`The ${plan.lane} managed-app preflight source fingerprint did not match the verified site ZIP.`);
    }
    const returnedFiles = Array.isArray(payload?.files) ? payload.files : [];
    const expectedPaths = expectedFingerprint.files.map((file) => file.path).sort();
    const returnedPaths = returnedFiles.map((file) => String(file?.path || '')).sort();
    if (returnedFiles.length !== expectedFingerprint.files.length
        || new Set(returnedPaths).size !== returnedPaths.length
        || JSON.stringify(returnedPaths) !== JSON.stringify(expectedPaths)) {
        throw new Error(`The ${plan.lane} managed-app preflight returned an unexpected file set.`);
    }
    for (const expected of expectedFingerprint.files) {
        const returned = returnedFiles.find((file) => file?.path === expected.path);
        if (!returned || returned.sizeBytes !== expected.sizeBytes || returned.sha256 !== expected.sha256) {
            throw new Error(`The ${plan.lane} managed-app preflight changed ${expected.path}.`);
        }
    }
    return true;
}

function resolveManagedAppRepoIdentity(app = {}, lane = '', phase = 'response') {
    const repoOwner = String(app.repoOwner || '').trim();
    const repoName = String(app.repoName || '').trim();
    const repoUrlValue = String(app.repoUrl || app.repoCloneUrl || '').trim();
    let repoUrl;
    try {
        repoUrl = new URL(repoUrlValue);
    } catch (_error) {
        repoUrl = null;
    }
    const repoPath = repoUrl
        ? decodeURIComponent(repoUrl.pathname).replace(/\/+$/, '').replace(/\.git$/i, '')
        : '';
    const expectedRepoPath = repoOwner && repoName ? `/${repoOwner}/${repoName}` : '';
    if (!repoUrl
        || repoUrl.protocol !== 'https:'
        || repoUrl.username
        || repoUrl.password
        || repoUrl.search
        || repoUrl.hash
        || !expectedRepoPath
        || repoPath !== expectedRepoPath) {
        throw new Error(`The ${lane} Push-to-Web ${phase} did not bind the managed app to a canonical GitLab repository.`);
    }
    return {
        repoOwner,
        repoName,
        repoOrigin: repoUrl.origin,
        repoPath,
    };
}

function validateManagedAppDeploymentAccepted(payload, plan, options = {}) {
    const expectedArtifactId = String(options.artifactId || '').trim();
    const expectedHost = String(options.deploymentPlan?.publicHost || '').trim();
    const expectedSha256 = String(options.preflight?.sha256 || '').trim();
    const app = payload?.app && typeof payload.app === 'object' ? payload.app : {};
    const buildRun = payload?.buildRun && typeof payload.buildRun === 'object' ? payload.buildRun : {};
    const returnedHost = String(payload?.publicHost || app.publicHost || '').trim().toLowerCase();
    if (String(payload?.artifactId || '').trim() !== expectedArtifactId) {
        throw new Error(`The ${plan.lane} Push-to-Web response belongs to a different artifact.`);
    }
    if (!expectedSha256 || String(payload?.sourceSha256 || '').trim() !== expectedSha256) {
        throw new Error(`The ${plan.lane} Push-to-Web response did not attest the accepted preflight SHA-256.`);
    }
    if (Number(payload?.sourceSizeBytes) !== Number(options.expectedFingerprint?.sizeBytes)
        || Number(payload?.fileCount) !== Number(options.expectedFingerprint?.files?.length)) {
        throw new Error(`The ${plan.lane} Push-to-Web response changed the accepted source size or file count.`);
    }
    if (!expectedHost || returnedHost !== expectedHost) {
        throw new Error(`The ${plan.lane} Push-to-Web response did not preserve the exact approved public host.`);
    }
    const appRef = String(app.id || app.slug || '').trim();
    if (!appRef) {
        throw new Error(`The ${plan.lane} Push-to-Web response did not include a managed-app reference.`);
    }
    const repoIdentity = resolveManagedAppRepoIdentity(app, plan.lane, 'response');
    const buildRunId = String(buildRun.id || '').trim();
    const commitSha = String(buildRun.commitSha || '').trim();
    const committedPaths = Array.isArray(buildRun?.metadata?.committedPaths)
        ? buildRun.metadata.committedPaths.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const expectedPaths = (options.expectedFingerprint?.files || [])
        .map((file) => String(file?.path || '').trim())
        .filter(Boolean);
    if (!buildRunId
        || !/^[a-f0-9]{7,64}$/i.test(commitSha)
        || expectedPaths.length === 0
        || expectedPaths.some((expectedPath) => !committedPaths.includes(expectedPath))) {
        throw new Error(`The ${plan.lane} Push-to-Web response did not bind the accepted source to a build run and commit.`);
    }
    const sourceArtifact = app?.metadata?.sourceArtifact && typeof app.metadata.sourceArtifact === 'object'
        ? app.metadata.sourceArtifact
        : {};
    if (String(sourceArtifact.id || '').trim() !== expectedArtifactId
        || String(sourceArtifact.sha256 || '').trim() !== expectedSha256
        || Number(sourceArtifact.sizeBytes) !== Number(options.expectedFingerprint?.sizeBytes)
        || Number(sourceArtifact.fileCount) !== Number(options.expectedFingerprint?.files?.length)) {
        throw new Error(`The ${plan.lane} Push-to-Web response did not persist the exact preflight source fingerprint.`);
    }
    const lifecycle = payload?.deploymentLifecycle && typeof payload.deploymentLifecycle === 'object'
        ? payload.deploymentLifecycle
        : null;
    if (!lifecycle
        || String(lifecycle.mode || '').trim() !== 'build-webhook'
        || String(lifecycle.buildRunId || '').trim() !== buildRunId
        || String(lifecycle.commitSha || '').trim() !== commitSha
        || lifecycle.deployRequested !== true
        || lifecycle.digestRequired !== true) {
        throw new Error(`The ${plan.lane} Push-to-Web response did not bind deployment to the digest-attested build webhook lifecycle.`);
    }
    if (payload?.asyncRuntime?.run) {
        throw new Error(`The ${plan.lane} Push-to-Web response started a premature async deploy before its build completed.`);
    }
    return {
        appRef,
        appId: String(app.id || '').trim(),
        appSlug: String(app.slug || '').trim(),
        buildRunId,
        commitSha,
        committedPaths,
        acceptedPipelineId: String(buildRun.externalRunId || '').trim(),
        acceptedPipelineUrl: String(buildRun.externalRunUrl || '').trim(),
        ...repoIdentity,
        deploymentLifecycle: lifecycle,
        sourceSha256: expectedSha256,
        publicHost: expectedHost,
    };
}

function collectManagedAppProgressHosts(payload = {}) {
    const progress = payload?.progress && typeof payload.progress === 'object'
        ? payload.progress
        : (payload?.project?.progress && typeof payload.project.progress === 'object'
            ? payload.project.progress
            : {});
    const evidence = progress?.evidence && typeof progress.evidence === 'object'
        ? progress.evidence
        : {};
    return [
        payload?.app?.publicHost,
        payload?.project?.publicHost,
        payload?.project?.targetPublicHost,
        evidence.targetPublicHost,
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function validateManagedAppPublicUrl(value, expectedOrigin, lane) {
    let publicUrl;
    try {
        publicUrl = new URL(String(value || ''));
    } catch (_error) {
        throw new Error(`The ${lane} managed-app progress did not include a valid public HTTPS URL.`);
    }
    if (publicUrl.protocol !== 'https:'
        || publicUrl.origin !== expectedOrigin
        || publicUrl.username
        || publicUrl.password
        || publicUrl.search
        || publicUrl.hash
        || !['', '/'].includes(publicUrl.pathname)) {
        throw new Error(`The ${lane} managed-app progress did not preserve the exact approved public origin.`);
    }
    return `${publicUrl.origin}/`;
}

function extractExactOciDigest(value = '') {
    const image = String(value || '');
    if (!image || image !== image.trim()) {
        return '';
    }
    if (/^sha256:[a-f0-9]{64}$/.test(image)) {
        return image;
    }
    const digestMatch = image.match(/@(?<digest>sha256:[a-f0-9]{64})$/);
    const imageName = digestMatch ? image.slice(0, digestMatch.index) : '';
    if (!digestMatch
        || !imageName
        || imageName.includes('@')
        || /[\s?#]/.test(imageName)) {
        return '';
    }
    return digestMatch.groups.digest;
}

function resolveExactManagedAppDigest(payload, evidence, buildRun) {
    const deployment = buildRun?.metadata?.deployment && typeof buildRun.metadata.deployment === 'object'
        ? buildRun.metadata.deployment
        : {};
    const liveDeploy = payload?.app?.metadata?.liveDeploy && typeof payload.app.metadata.liveDeploy === 'object'
        ? payload.app.metadata.liveDeploy
        : {};
    const proofGroups = [
        {
            label: 'observed',
            values: [evidence.observedImageDigest, liveDeploy.observedImageDigest],
        },
        {
            label: 'build',
            values: [evidence.imageDigest, buildRun?.imageDigest],
        },
        {
            label: 'deployed',
            values: [deployment.imageDigest, liveDeploy.imageDigest],
        },
    ];
    const digests = [];
    for (const group of proofGroups) {
        const values = group.values.map((value) => String(value || '')).filter(Boolean);
        if (values.length === 0) {
            throw new Error(`Managed-app progress is missing ${group.label} OCI digest evidence.`);
        }
        for (const value of values) {
            const digest = extractExactOciDigest(value);
            if (!digest) {
                throw new Error(`Managed-app progress reported non-digest ${group.label} image evidence.`);
            }
            digests.push(digest);
        }
    }
    const pinnedReferenceGroups = [
        {
            label: 'deployed',
            values: [evidence.deployedImage, deployment.deployedImage, liveDeploy.deployedImage],
        },
        {
            label: 'observed Deployment',
            values: [evidence.observedDeploymentImage, deployment.deploymentImage, liveDeploy.observedDeploymentImage],
        },
        {
            label: 'observed pod',
            values: [evidence.observedPodImage, deployment.podImage, liveDeploy.observedPodImage],
        },
    ];
    for (const group of pinnedReferenceGroups) {
        const values = group.values.map((value) => String(value || '')).filter(Boolean);
        if (values.length === 0) {
            throw new Error(`Managed-app progress is missing the ${group.label} digest-pinned image reference.`);
        }
        for (const value of values) {
            const digest = extractExactOciDigest(value);
            if (!digest) {
                throw new Error(`Managed-app progress reported a non-digest ${group.label} image reference.`);
            }
            digests.push(digest);
        }
    }
    if (new Set(digests).size !== 1) {
        throw new Error('Managed-app progress reported conflicting OCI image digests.');
    }
    return digests[0];
}

function validateManagedAppTerminalProgress(payload, plan, options = {}) {
    const progress = payload?.progress && typeof payload.progress === 'object'
        ? payload.progress
        : (payload?.project?.progress && typeof payload.project.progress === 'object'
            ? payload.project.progress
            : null);
    const phase = String(progress?.phase || payload?.project?.phase || '').trim().toLowerCase();
    if (!progress || progress.terminal !== true || phase !== 'live') {
        throw new Error(`The ${plan.lane} managed-app progress was not terminal and live.`);
    }
    const evidence = progress.evidence && typeof progress.evidence === 'object'
        ? progress.evidence
        : {};
    const accepted = options.accepted && typeof options.accepted === 'object'
        ? options.accepted
        : null;
    const buildRun = payload?.latestBuildRun && typeof payload.latestBuildRun === 'object'
        ? payload.latestBuildRun
        : null;
    if (!accepted
        || !buildRun
        || String(buildRun.id || '').trim() !== accepted.buildRunId) {
        throw new Error(`The ${plan.lane} managed-app progress did not preserve the accepted build-run identity.`);
    }
    const terminalRepoIdentity = resolveManagedAppRepoIdentity(payload?.app || {}, plan.lane, 'terminal progress');
    if (terminalRepoIdentity.repoOwner !== accepted.repoOwner
        || terminalRepoIdentity.repoName !== accepted.repoName
        || terminalRepoIdentity.repoOrigin !== accepted.repoOrigin
        || terminalRepoIdentity.repoPath !== accepted.repoPath) {
        throw new Error(`The ${plan.lane} managed-app progress changed the accepted GitLab repository identity.`);
    }
    const sourceArtifact = payload?.app?.metadata?.sourceArtifact;
    if (!sourceArtifact
        || String(sourceArtifact.sha256 || '').trim() !== accepted.sourceSha256
        || String(sourceArtifact.id || '').trim() !== String(options.artifactId || '').trim()) {
        throw new Error(`The ${plan.lane} managed-app progress did not preserve the accepted preflight source SHA-256.`);
    }
    const requiredProof = evidence.requiredProof && typeof evidence.requiredProof === 'object'
        ? evidence.requiredProof
        : {};
    for (const proofName of [
        'sourceChanged',
        'gitlabPipelineObserved',
        'imageAvailable',
        'deploymentObserved',
        'publicVerificationObserved',
    ]) {
        if (requiredProof[proofName] !== true) {
            throw new Error(`The ${plan.lane} managed-app progress is missing required ${proofName} evidence.`);
        }
    }

    const commitSha = String(evidence.commitSha || '').trim();
    const buildCommitSha = String(buildRun.commitSha || '').trim();
    const committedPaths = Array.isArray(evidence.committedPaths)
        ? evidence.committedPaths.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const buildCommittedPaths = Array.isArray(buildRun?.metadata?.committedPaths)
        ? buildRun.metadata.committedPaths.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const expectedPaths = (options.expectedFingerprint?.files || [])
        .map((file) => String(file?.path || '').trim())
        .filter(Boolean);
    if (!/^[a-f0-9]{7,64}$/i.test(commitSha)
        || commitSha !== accepted.commitSha
        || buildCommitSha !== accepted.commitSha
        || expectedPaths.length === 0
        || expectedPaths.some((expectedPath) => !committedPaths.includes(expectedPath))
        || JSON.stringify([...committedPaths].sort()) !== JSON.stringify([...accepted.committedPaths].sort())
        || JSON.stringify([...buildCommittedPaths].sort()) !== JSON.stringify([...accepted.committedPaths].sort())) {
        throw new Error(`The ${plan.lane} managed-app progress did not preserve the accepted commit and source paths.`);
    }

    const buildStatus = String(buildRun.buildStatus || '').trim().toLowerCase();
    const pipelineStatus = String(evidence.pipelineStatus || '').trim().toLowerCase();
    const pipelineUrl = String(evidence.pipelineUrl || '').trim();
    const buildPipelineUrl = String(buildRun.externalRunUrl || '').trim();
    const buildPipelineId = String(buildRun.externalRunId || '').trim();
    let parsedPipelineUrl;
    try {
        parsedPipelineUrl = new URL(pipelineUrl);
    } catch (_error) {
        parsedPipelineUrl = null;
    }
    const pipelinePathId = parsedPipelineUrl
        ? decodeURIComponent(parsedPipelineUrl.pathname.split('/').filter(Boolean).at(-1) || '')
        : '';
    const expectedPipelinePath = `${accepted.repoPath}/-/pipelines/${encodeURIComponent(buildPipelineId)}`;
    if (!SUCCESS_BUILD_STATUSES.has(buildStatus)
        || !SUCCESS_BUILD_STATUSES.has(pipelineStatus)
        || !parsedPipelineUrl
        || parsedPipelineUrl.protocol !== 'https:'
        || parsedPipelineUrl.username
        || parsedPipelineUrl.password
        || parsedPipelineUrl.search
        || parsedPipelineUrl.hash
        || parsedPipelineUrl.origin !== accepted.repoOrigin
        || parsedPipelineUrl.pathname !== expectedPipelinePath
        || pipelineUrl !== buildPipelineUrl
        || !buildPipelineId
        || pipelinePathId !== buildPipelineId
        || (accepted.acceptedPipelineId && accepted.acceptedPipelineId !== buildPipelineId)
        || (accepted.acceptedPipelineUrl && accepted.acceptedPipelineUrl !== pipelineUrl)) {
        throw new Error(`The ${plan.lane} managed-app progress did not preserve the accepted commit-to-pipeline chain.`);
    }

    const image = resolveExactManagedAppDigest(payload, evidence, buildRun);

    const deployment = buildRun?.metadata?.deployment;
    const liveDeploy = payload?.app?.metadata?.liveDeploy;
    const rolloutObserved = liveDeploy?.rollout === true
        || deployment?.verification?.rollout === true;
    const httpsObserved = liveDeploy?.https === true
        || deployment?.verification?.https === true;
    const deployStatus = String(
        evidence.deployStatus
        || payload?.latestBuildRun?.deployStatus
        || payload?.project?.deployStatus
        || '',
    ).trim().toLowerCase();
    const verificationStatus = String(
        evidence.verificationStatus
        || payload?.latestBuildRun?.verificationStatus
        || payload?.project?.verificationStatus
        || '',
    ).trim().toLowerCase();
    if (!rolloutObserved || !SUCCESS_DEPLOY_STATUSES.has(deployStatus)) {
        throw new Error(`The ${plan.lane} managed-app progress did not prove a successful k3s rollout.`);
    }
    if (!httpsObserved || !SUCCESS_DEPLOY_STATUSES.has(verificationStatus)) {
        throw new Error(`The ${plan.lane} managed-app progress did not prove successful public HTTPS verification.`);
    }

    const expectedHost = String(options.deploymentPlan?.publicHost || '').trim();
    const expectedOrigin = String(options.deploymentPlan?.publicOrigin || '').trim();
    const observedHosts = collectManagedAppProgressHosts(payload);
    if (!expectedHost
        || observedHosts.length === 0
        || observedHosts.some((host) => host !== expectedHost)) {
        throw new Error(`The ${plan.lane} managed-app progress did not preserve the exact approved public host.`);
    }
    const publicUrlCandidates = [
        evidence.livePublicUrl,
        evidence.publicUrl,
        payload?.project?.livePublicUrl,
        payload?.project?.publicUrl,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (publicUrlCandidates.length === 0) {
        throw new Error(`The ${plan.lane} managed-app progress did not expose a verified public URL.`);
    }
    const publicUrls = publicUrlCandidates
        .map((value) => validateManagedAppPublicUrl(value, expectedOrigin, plan.lane));
    if (new Set(publicUrls).size !== 1) {
        throw new Error(`The ${plan.lane} managed-app progress reported conflicting public URLs.`);
    }

    return {
        phase,
        commitSha,
        committedPaths,
        pipelineUrl,
        buildStatus,
        image,
        deployStatus,
        verificationStatus,
        rolloutObserved: true,
        httpsObserved: true,
        publicHost: expectedHost,
        publicUrl: publicUrls[0],
    };
}

async function pollManagedAppProgress(client, appRef, plan, options = {}) {
    const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const now = options.now || (() => Date.now());
    const startedAt = now();
    const pollIntervalMs = Number(options.pollIntervalMs) || 2000;
    const timeoutMs = Number(options.timeoutMs) || 15 * 60 * 1000;
    const maximumPolls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollIntervalMs)) + 1);
    for (let pollCount = 1; pollCount <= maximumPolls; pollCount += 1) {
        const payload = await client.requestJson(
            `/api/managed-apps/${encodeURIComponent(appRef)}/progress`,
        );
        const observedHosts = collectManagedAppProgressHosts(payload);
        const expectedHost = String(options.deploymentPlan?.publicHost || '').trim();
        if (observedHosts.some((host) => host !== expectedHost)) {
            throw new Error(`The ${plan.lane} managed-app progress switched away from the approved public host.`);
        }
        const progress = payload?.progress && typeof payload.progress === 'object'
            ? payload.progress
            : payload?.project?.progress;
        const phase = String(progress?.phase || payload?.project?.phase || '').trim().toLowerCase();
        const terminal = progress?.terminal === true || MANAGED_APP_TERMINAL_PHASES.has(phase);
        if (terminal) {
            if (phase !== 'live') {
                throw new Error(`The ${plan.lane} managed-app deployment ended with phase ${phase || 'unknown'}.`);
            }
            return {
                polls: pollCount,
                payload,
                proof: validateManagedAppTerminalProgress(payload, plan, options),
            };
        }
        if ((now() - startedAt) >= timeoutMs || pollCount === maximumPolls) {
            throw new Error(`The ${plan.lane} managed-app deployment did not reach terminal proof before timeout.`);
        }
        await sleep(pollIntervalMs);
    }
    throw new Error(`The ${plan.lane} managed-app deployment progress loop ended unexpectedly.`);
}

async function executePushToWebScenario(plan, sessionId, client, options = {}) {
    const deploymentPlan = options.deploymentPlan || {};
    const artifactId = String(options.siteBundleArtifactId || '').trim();
    if (!artifactId || !deploymentPlan.publicHost || !deploymentPlan.publicOrigin) {
        throw new Error(`The ${plan.lane} Push-to-Web plan is incomplete.`);
    }
    if (options.browserQaPassed !== true) {
        throw new Error(`The ${plan.lane} Push-to-Web canary requires completed artifact browser QA.`);
    }
    const preflightSha256 = String(options.preflight?.sha256 || '').trim();
    if (!/^[a-f0-9]{64}$/.test(preflightSha256)
        || preflightSha256 !== options.expectedFingerprint?.sha256) {
        throw new Error(`The ${plan.lane} Push-to-Web canary requires the exact accepted preflight SHA-256.`);
    }

    const slug = deploymentPlan.publicHost.split('.')[0];
    const created = await client.requestJson(
        `/api/artifacts/${encodeURIComponent(artifactId)}/managed-app`,
        {
            method: 'POST',
            body: {
                sessionId,
                requestedAction: 'deploy',
                deployRequested: true,
                queueAsyncDeploy: false,
                expectedSourceSha256: preflightSha256,
                appName: `Remote Agent ${plan.lane} Authoring Canary`,
                name: slug,
                slug,
                dnsName: deploymentPlan.publicHost,
                publicHost: deploymentPlan.publicHost,
                sourcePrompt: `Publish the verified ${plan.lane} ${AUTHORING_CANARY_VERSION} site bundle without changing its accepted bytes.`,
                metadata: {
                    source: 'remote-agent-authoring-push-to-web-canary',
                    canaryVersion: CANARY_VERSION,
                    authoringCanaryVersion: AUTHORING_CANARY_VERSION,
                    lane: plan.lane,
                    changeTicket: deploymentPlan.changeTicket,
                    approvedHostTemplate: deploymentPlan.hostTemplate,
                    expectedPublicOrigin: deploymentPlan.publicOrigin,
                    expectedSourceSha256: preflightSha256,
                },
            },
        },
    );
    const accepted = validateManagedAppDeploymentAccepted(created, plan, {
        artifactId,
        deploymentPlan,
        expectedFingerprint: options.expectedFingerprint,
        preflight: options.preflight,
    });
    const terminal = await pollManagedAppProgress(client, accepted.appRef, plan, {
        ...options,
        accepted,
        artifactId,
        deploymentPlan,
    });
    const publicBrowserQaRunner = options.publicBrowserQaRunner || runPublicBrowserQa;
    const browserQa = await publicBrowserQaRunner({
        publicUrl: terminal.proof.publicUrl,
        expectedOrigin: deploymentPlan.publicOrigin,
        lane: plan.lane,
        sessionId,
        appRef: accepted.appRef,
        env: options.env,
    });
    if (browserQa?.ok !== true
        || Number(browserQa?.checkedViewports || 0) < 2
        || !Array.isArray(browserQa?.issues)
        || browserQa.issues.length > 0) {
        throw new Error(`The ${plan.lane} public browser QA did not attest two clean viewports.`);
    }
    return {
        status: 'passed',
        appRef: accepted.appRef,
        ...(accepted.appId ? { appId: accepted.appId } : {}),
        ...(accepted.appSlug ? { appSlug: accepted.appSlug } : {}),
        ...(accepted.buildRunId ? { buildRunId: accepted.buildRunId } : {}),
        sourceSha256: accepted.sourceSha256,
        deploymentLifecycle: accepted.deploymentLifecycle.mode,
        publicHost: terminal.proof.publicHost,
        publicUrl: terminal.proof.publicUrl,
        progressPolls: terminal.polls,
        sourceCommit: terminal.proof.commitSha,
        buildStatus: terminal.proof.buildStatus,
        pipelineUrl: terminal.proof.pipelineUrl,
        image: terminal.proof.image,
        rollout: 'passed',
        https: 'passed',
        browserQa: {
            status: 'passed',
            checkedViewports: browserQa.checkedViewports,
            issues: [],
            ...(browserQa.outDir ? { outDir: browserQa.outDir } : {}),
        },
    };
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
    validateRunIdentity(created.run, plan, {
        expectedRunId: runId,
        expectedSessionId: sessionId,
        phase: 'accepted',
    });
    if (created.run?.liveRemoteAllowed !== true
        || created.run?.metadata?.remoteAdapter !== true
        || created.run?.metadata?.dryRun !== false) {
        throw new Error(`The ${plan.lane} hop ${plan.hop} was not accepted as an allowed live remote run.`);
    }
    const completed = await pollRun(client, runId, runtimeOptions);
    validateRunIdentity(completed.run, plan, {
        expectedRunId: runId,
        expectedSessionId: sessionId,
        phase: 'completed',
    });
    if (TERMINAL_RUN_STATUSES.has(completed.status)) {
        runtimeOptions.activeRunIds.delete(runId);
    }
    if (completed.status !== 'completed') {
        throw new Error(`The ${plan.lane} hop ${plan.hop} run ended with status ${completed.status || 'unknown'}.`);
    }
    validateRunExecutionEvidence(completed.run, completed.events, plan, {
        expectedRunId: runId,
        expectedSessionId: sessionId,
    });

    const toolResult = findCompactToolResult(completed.run, completed.events);
    const inspected = validateCompactToolResult(plan, toolResult);
    for (const { fixture, descriptor } of inspected.componentArtifacts) {
        const compactArtifact = (Array.isArray(toolResult.artifacts) ? toolResult.artifacts : [])
            .find((candidate) => candidate?.id === descriptor.artifactId);
        const artifact = await client.requestJson(`/api/artifacts/${encodeURIComponent(descriptor.artifactId)}`);
        if (artifact?.id !== descriptor.artifactId
            || artifact?.sessionId !== sessionId) {
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
        || siteArtifact?.sessionId !== sessionId) {
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
        validatePreflight(preflight, plan, expectedFingerprint, inspected.siteBundleArtifactId);
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

async function executeAuthoringScenario(plan, sessionId, client, runtimeOptions) {
    const created = await client.requestJson('/api/async-lab/runs', {
        method: 'POST',
        body: buildRunPayload(plan, sessionId),
    });
    const runId = String(created?.run?.id || '').trim();
    if (!runId) {
        throw new Error(`The ${plan.lane} authoring response did not include a run ID.`);
    }
    runtimeOptions.activeRunIds.add(runId);
    validateRunIdentity(created.run, plan, {
        expectedRunId: runId,
        expectedSessionId: sessionId,
        phase: 'accepted',
    });
    if (created.run?.liveRemoteAllowed !== true
        || created.run?.metadata?.remoteAdapter !== true
        || created.run?.metadata?.dryRun !== false) {
        throw new Error(`The ${plan.lane} authoring scenario was not accepted as an allowed live remote run.`);
    }
    const completed = await pollRun(client, runId, runtimeOptions);
    validateRunIdentity(completed.run, plan, {
        expectedRunId: runId,
        expectedSessionId: sessionId,
        phase: 'completed',
    });
    if (TERMINAL_RUN_STATUSES.has(completed.status)) {
        runtimeOptions.activeRunIds.delete(runId);
    }
    if (completed.status !== 'completed') {
        throw new Error(`The ${plan.lane} authoring run ended with status ${completed.status || 'unknown'}.`);
    }
    validateRunExecutionEvidence(completed.run, completed.events, plan, {
        expectedRunId: runId,
        expectedSessionId: sessionId,
    });

    const toolResult = findCompactToolResult(completed.run, completed.events);
    const inspected = validateCompactToolResult(plan, toolResult);
    const authoredFiles = [];
    for (const { fixture: definition, descriptor } of inspected.componentArtifacts) {
        const compactArtifact = (Array.isArray(toolResult.artifacts) ? toolResult.artifacts : [])
            .find((candidate) => candidate?.id === descriptor.artifactId);
        const artifact = await client.requestJson(`/api/artifacts/${encodeURIComponent(descriptor.artifactId)}`);
        if (artifact?.id !== descriptor.artifactId
            || artifact?.sessionId !== sessionId) {
            throw new Error(`The ${plan.lane} authored artifact lookup for ${definition.filename} failed session ownership proof.`);
        }
        const downloadPath = artifactApiPath(
            artifact?.downloadUrl || compactArtifact?.downloadUrl,
            `/api/artifacts/${encodeURIComponent(descriptor.artifactId)}/download`,
            runtimeOptions.baseUrl,
        );
        const buffer = await client.requestBuffer(downloadPath, {
            maxBytes: Math.min(MAX_DOWNLOAD_BYTES, descriptor.sizeBytes + 1),
        });
        if (buffer.length !== descriptor.sizeBytes || sha256(buffer) !== descriptor.sha256) {
            throw new Error(`The ${plan.lane} authored component download changed ${definition.filename}.`);
        }
        authoredFiles.push({ definition, descriptor, buffer });
    }

    const localValidation = validateAuthoredArtifactSet(plan, authoredFiles);
    const siteArtifact = await client.requestJson(
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}`,
    );
    if (siteArtifact?.id !== inspected.siteBundleArtifactId
        || siteArtifact?.sessionId !== sessionId) {
        throw new Error(`The ${plan.lane} authored site bundle lookup failed session ownership proof.`);
    }
    const bundlePath = artifactApiPath(
        siteArtifact?.bundleDownloadUrl || inspected.siteBundleArtifact.bundleDownloadUrl,
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/bundle`,
        runtimeOptions.baseUrl,
    );
    const zipBuffer = await client.requestBuffer(bundlePath, { maxBytes: MAX_DOWNLOAD_BYTES });
    const archivePaths = await validateAuthoredSiteZip(zipBuffer, plan, authoredFiles);

    const previewPath = artifactApiPath(
        siteArtifact?.previewUrl || inspected.siteBundleArtifact.previewUrl,
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/preview`,
        runtimeOptions.baseUrl,
    );
    const preview = await client.requestBuffer(previewPath, { maxBytes: MAX_DOWNLOAD_BYTES });
    const sourceHtml = authoredFiles
        .find((file) => file.definition.outputPath === 'index.html')
        ?.buffer.toString('utf8') || '';
    validateAuthoredPreview(plan, sourceHtml, preview.toString('utf8'), {
        expectedPreviewBaseHref: `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/preview/`,
    });

    const expectedFingerprint = buildExpectedManagedAppFingerprint(authoredFiles.map(({ definition, buffer }) => ({
        ...definition,
        buffer,
    })));
    const preflight = await client.requestJson(
        `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/managed-app/preflight`,
        {
            method: 'POST',
            body: {
                source: 'remote-agent-authoring-canary',
                canaryVersion: AUTHORING_CANARY_VERSION,
                validateOnly: true,
                expectedSourceSha256: expectedFingerprint.sha256,
                expectedEntry: 'index.html',
                expectedFiles: authoredFiles.map(({ definition, descriptor }) => ({
                    path: definition.outputPath,
                    role: definition.role,
                    sizeBytes: descriptor.sizeBytes,
                    sha256: descriptor.sha256,
                })),
            },
        },
    );
    validatePreflight(preflight, plan, expectedFingerprint, inspected.siteBundleArtifactId);

    let browserQa = null;
    if (runtimeOptions.browserQa === true) {
        const previewUrl = new URL(
            `/api/artifacts/${encodeURIComponent(inspected.siteBundleArtifactId)}/preview`,
            runtimeOptions.baseUrl,
        ).toString();
        const browserQaRunner = runtimeOptions.browserQaRunner || runBrowserQa;
        browserQa = await browserQaRunner({
            previewUrl,
            lane: plan.lane,
            sessionId,
            siteBundleArtifactId: inspected.siteBundleArtifactId,
            env: runtimeOptions.env,
        });
        if (browserQa?.ok !== true
            || Number(browserQa?.checkedViewports || 0) < 2
            || !Array.isArray(browserQa?.issues)
            || browserQa.issues.length > 0) {
            throw new Error(`The ${plan.lane} browser QA did not attest two clean viewports.`);
        }
    }

    let pushToWeb = null;
    if (runtimeOptions.pushToWebPlan) {
        pushToWeb = await executePushToWebScenario(plan, sessionId, client, {
            ...runtimeOptions,
            deploymentPlan: runtimeOptions.pushToWebPlan,
            siteBundleArtifactId: inspected.siteBundleArtifactId,
            expectedFingerprint,
            preflight,
            browserQaPassed: browserQa?.ok === true,
        });
    }

    return {
        scenario: 'authoring',
        runId,
        provider: inspected.provider,
        providerModel: inspected.providerModel,
        model: inspected.model,
        transport: plan.transport,
        liveRemoteExecutionProved: true,
        inputArtifactCount: 0,
        componentMetadataVerified: inspected.componentArtifacts.length,
        componentDownloadsVerified: authoredFiles.length,
        localStructuralGate: localValidation.quality.status,
        semanticBriefVerified: true,
        siteBundleArtifactId: inspected.siteBundleArtifactId,
        siteZipFilesVerified: archivePaths.length,
        previewVerified: true,
        managedAppPreflight: 'passed',
        browserQa: browserQa ? {
            status: 'passed',
            checkedViewports: browserQa.checkedViewports,
            issues: [],
            ...(browserQa.outDir ? { outDir: browserQa.outDir } : {}),
        } : { status: 'not-requested' },
        ...(pushToWeb ? { pushToWeb } : {}),
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
                    scenarios: options.pushToWeb === true
                        ? ['transfer', 'authoring', 'push-to-web']
                        : (options.authoring === true ? ['transfer', 'authoring'] : ['transfer']),
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
            let authoring = null;
            if (options.authoring === true) {
                const authoringPlan = buildAuthoringPlan(firstHopPlan.lane, options.env);
                validateAuthoringPlan(authoringPlan);
                const pushToWebPlan = options.pushToWeb === true ? {
                    publicHost: options.pushToWebConfiguration?.hosts?.[firstHopPlan.lane],
                    publicOrigin: options.pushToWebConfiguration?.publicOrigins?.[firstHopPlan.lane],
                    hostTemplate: options.pushToWebConfiguration?.hostTemplate,
                    changeTicket: options.pushToWebConfiguration?.changeTicket,
                } : null;
                authoring = await executeAuthoringScenario(authoringPlan, sessionId, client, {
                    ...configuration,
                    sleep,
                    now,
                    activeRunIds,
                    browserQa: options.browserQa === true,
                    browserQaRunner: options.browserQaRunner,
                    pushToWebPlan,
                    publicBrowserQaRunner: options.publicBrowserQaRunner,
                    env: options.env,
                });
            }
            laneResults.push({
                lane: firstHopPlan.lane,
                bidirectionalRoundTrip: true,
                fixtureCount: firstHopPlan.fixtures.length,
                hops: [firstHop.summary, secondHop.summary],
                managedAppPreflight: 'passed',
                ...(authoring ? { authoring } : {}),
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
        authoringScenario: options.authoring === true ? 'passed' : 'not-requested',
        pushToWebScenario: options.pushToWeb === true ? 'passed' : 'not-requested',
        lanes: laneResults,
    };
}

async function runCanary(options = {}) {
    const parsed = parseArguments(options.argv || []);
    if (parsed.help) {
        return {
            help: 'Usage: npm run canary:remote-agent-artifact-loop -- [--mode codex|kimi|grok|all] [--authoring [--browser-qa [--push-to-web]]] [--run]',
        };
    }
    const env = options.env || process.env;
    const plans = selectedLanes(parsed.mode).map((lane) => buildLanePlan(lane, env, { hop: 1 }));
    plans.forEach(validateLanePlan);

    let pushToWebConfiguration = null;
    if (parsed.pushToWeb) {
        if (!parsed.run || !parsed.authoring || !parsed.browserQa) {
            throw new Error('--push-to-web requires --run --authoring --browser-qa.');
        }
        pushToWebConfiguration = buildPushToWebConfiguration(
            env,
            plans.map((plan) => plan.lane),
        );
    }

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
            let authoring = null;
            if (parsed.authoring) {
                const authoringPlan = buildAuthoringPlan(firstHopPlan.lane, env);
                validateAuthoringPlan(authoringPlan);
                authoring = describeAuthoringPlan(authoringPlan, { browserQa: parsed.browserQa });
            }
            return {
                lane: firstHopPlan.lane,
                bidirectionalRoundTripPlanned: true,
                hops: [describePlan(firstHopPlan), describePlan(secondHopPlan)],
                ...(authoring ? { authoring } : {}),
            };
        });
        return {
            version: CANARY_VERSION,
            mode: parsed.mode,
            execution: 'dry-run',
            passed: true,
            networkRequestsMade: 0,
            authoringScenario: parsed.authoring ? 'planned' : 'not-requested',
            pushToWebScenario: 'not-requested',
            note: 'Transfer and optional authoring payloads were validated locally. No HTTP request, remote agent run, or browser QA was attempted.',
            lanes,
        };
    }

    return runLive(plans, {
        ...options,
        authoring: parsed.authoring,
        browserQa: parsed.browserQa,
        pushToWeb: parsed.pushToWeb,
        pushToWebConfiguration,
    });
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
    AUTHORING_CANARY_VERSION,
    CANARY_VERSION,
    buildAuthoringPlan,
    buildLanePlan,
    buildPushToWebConfiguration,
    buildRunPayload,
    createFixtures,
    createHttpClient,
    parseArguments,
    pollManagedAppProgress,
    runBrowserQa,
    runPublicBrowserQa,
    runCanary,
    validateAuthoredArtifactSet,
    validateAuthoredPreview,
    validateAuthoringPlan,
    validateCompactToolResult,
    validateLanePlan,
    validateManagedAppTerminalProgress,
    validatePreflight,
    validateRunExecutionEvidence,
    validateRunIdentity,
    validateSiteZip,
};
