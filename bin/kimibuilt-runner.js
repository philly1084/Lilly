#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const { sanitizeConfigValue } = require('../src/config-placeholders');

const {
  isApproved,
  isDangerousCommand,
  normalizeCommandJob,
  normalizeContextDirectory,
  normalizeText,
  truncateText,
} = require('../src/remote-runner/protocol');

const backendUrl = normalizeText(process.env.KIMIBUILT_BACKEND_URL || process.env.API_BASE_URL || 'http://localhost:3000');
const token = sanitizeConfigValue(process.env.KIMIBUILT_REMOTE_RUNNER_TOKEN || '');
const tlsInsecure = /^(?:1|true|yes)$/i.test(normalizeText(process.env.KIMIBUILT_RUNNER_TLS_INSECURE || ''));
const runnerId = normalizeText(process.env.KIMIBUILT_RUNNER_ID || `${os.hostname()}-${process.platform}-${process.arch}`);
const displayName = normalizeText(process.env.KIMIBUILT_RUNNER_NAME || `KimiBuilt Runner ${os.hostname()}`);
const allowedRoots = String(process.env.KIMIBUILT_RUNNER_ALLOWED_ROOTS || '/opt,/srv,/var/www,/tmp')
  .split(',')
  .map((entry) => normalizeText(entry))
  .filter(Boolean);
const capabilities = String(process.env.KIMIBUILT_RUNNER_CAPABILITIES || 'inspect,deploy,build')
  .split(',')
  .map((entry) => normalizeText(entry))
  .filter(Boolean);
const heartbeatMs = Math.max(5000, Number(process.env.KIMIBUILT_RUNNER_HEARTBEAT_MS) || 15000);
const maxOutputChars = Math.max(1000, Number(process.env.KIMIBUILT_RUNNER_MAX_OUTPUT_CHARS) || 120000);
const defaultCwd = normalizeText(process.env.KIMIBUILT_RUNNER_DEFAULT_CWD || process.env.DIRECT_CLI_WORKSPACE || '');
const workspaceRoot = normalizeText(process.env.DIRECT_CLI_WORKSPACE || defaultCwd);
const configuredShell = normalizeText(process.env.KIMIBUILT_RUNNER_SHELL || '');
const cliToolNames = String(process.env.KIMIBUILT_RUNNER_CLI_TOOLS || [
  'bash',
  'sh',
  'node',
  'npm',
  'npx',
  'playwright-core',
  'git',
  'kubectl',
  'k3s',
  'helm',
  'docker',
  'buildctl',
  'curl',
  'wget',
  'jq',
  'yq',
  'python3',
  'python',
  'tar',
  'gzip',
  'unzip',
  'rsync',
  'ssh',
  'scp',
  'systemctl',
  'journalctl',
  'ss',
  'ip',
  'getent',
  'dig',
  'nslookup',
  'openssl',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
].join(','))
  .split(',')
  .map((entry) => normalizeText(entry))
  .filter(Boolean);

if (!token) {
  console.error('[Runner] KIMIBUILT_REMOTE_RUNNER_TOKEN is required');
  process.exit(1);
}

function buildRunnerWsUrl() {
  const base = new URL(backendUrl.replace(/^http/i, 'ws').replace(/\/+$/, ''));
  base.pathname = '/ws/runners';
  return base.toString();
}

function isPathAllowed(candidate = '') {
  const normalized = normalizeText(candidate);
  if (!normalized) {
    return true;
  }
  const resolved = path.resolve(normalized);
  return allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

function resolveRunnerShell() {
  if (process.platform === 'win32') {
    return configuredShell || 'powershell.exe';
  }

  const candidates = [
    configuredShell,
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
  ].filter(Boolean);

  return candidates.find((candidate) => {
    if (candidate.includes('/')) {
      return fs.existsSync(candidate);
    }
    return true;
  }) || '/bin/sh';
}

const runnerShell = resolveRunnerShell();

function isExecutable(filePath = '') {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function findExecutable(binaryName = '') {
  const normalized = normalizeText(binaryName);
  if (!normalized) {
    return '';
  }

  if (normalized.includes(path.sep) || (process.platform === 'win32' && /[\\/]/.test(normalized))) {
    return isExecutable(normalized) ? normalized : '';
  }

  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
  const localBin = path.resolve(__dirname, '..', 'node_modules', '.bin');
  if (!pathEntries.some((entry) => path.resolve(entry) === localBin)) {
    pathEntries.push(localBin);
  }
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT')
      .split(';')
      .map((entry) => normalizeText(entry).toLowerCase())
      .filter(Boolean)
    : [''];

  for (const pathEntry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(pathEntry, process.platform === 'win32' && extension && !normalized.toLowerCase().endsWith(extension)
        ? `${normalized}${extension}`
        : normalized);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return '';
}

function buildCliToolInventory() {
  const seen = new Set();
  const nodeModuleToolNames = new Set(['playwright', 'playwright-core']);
  return cliToolNames
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((name) => {
      const toolPath = findExecutable(name);
      const modulePath = nodeModuleToolNames.has(name.toLowerCase()) && hasNodeModule(name)
        ? `node:${name}`
        : '';
      return {
        name,
        available: Boolean(toolPath || modulePath),
        path: toolPath || modulePath,
      };
    });
}

function resolvePackageVersion(moduleName = '') {
  try {
    return require(`${moduleName}/package.json`).version || '';
  } catch (_error) {
    return '';
  }
}

function hasNodeModule(moduleName = '') {
  try {
    require.resolve(moduleName);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveBrowserExecutablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.ARTIFACT_BROWSER_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.platform === 'win32' ? '' : '/usr/bin/chromium',
    process.platform === 'win32' ? '' : '/usr/bin/chromium-browser',
    process.platform === 'win32' ? '' : '/usr/bin/google-chrome',
    process.platform === 'win32' ? '' : '/usr/bin/google-chrome-stable',
    process.platform === 'win32' ? '' : '/snap/bin/chromium',
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ].map((entry) => normalizeText(entry)).filter(Boolean);

  for (const candidate of candidates) {
    const executable = findExecutable(candidate);
    if (executable) {
      return executable;
    }
  }

  return '';
}

function buildBrowserAutomationMetadata() {
  const playwrightPackage = hasNodeModule('playwright')
    ? 'playwright'
    : (hasNodeModule('playwright-core') ? 'playwright-core' : '');
  const browserExecutablePath = resolveBrowserExecutablePath();
  const uiCheckScript = path.resolve(__dirname, 'kimibuilt-ui-check.js');
  const uiCheckAvailable = fs.existsSync(uiCheckScript);

  return {
    playwrightPackage,
    playwrightVersion: playwrightPackage ? resolvePackageVersion(playwrightPackage) : '',
    browserExecutablePath,
    screenshotReady: Boolean(playwrightPackage && browserExecutablePath && uiCheckAvailable),
    uiCheckCommand: uiCheckAvailable ? `node ${uiCheckScript}` : '',
    defaultViewports: [
      { name: 'desktop', width: 1440, height: 960 },
      { name: 'mobile', width: 390, height: 844 },
    ],
  };
}

function resolveJobCwd(requestedCwd = '') {
  const candidate = normalizeText(requestedCwd || defaultCwd);
  if (!candidate) {
    return process.cwd();
  }
  if (!isPathAllowed(candidate)) {
    return null;
  }
  return path.resolve(candidate);
}

function isPathInside(parentPath = '', candidatePath = '') {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function materializeJobContext(job = {}, resolvedCwd = '') {
  const contextFiles = Array.isArray(job.metadata?.contextFiles) ? job.metadata.contextFiles : [];
  if (contextFiles.length === 0) {
    return null;
  }

  const relativeDirectory = normalizeContextDirectory(
    job.metadata?.contextDirectory || `.kimibuilt/context/${job.id || 'job'}`,
  );
  const targetDirectory = path.resolve(resolvedCwd, relativeDirectory);
  if (!isPathInside(resolvedCwd, targetDirectory)) {
    throw new Error(`Context directory is outside working directory: ${relativeDirectory}`);
  }

  fs.mkdirSync(targetDirectory, { recursive: true });
  const manifest = [];

  for (let index = 0; index < contextFiles.length; index += 1) {
    const file = contextFiles[index] || {};
    const filename = normalizeText(file.filename) || `context-${index + 1}.bin`;
    const targetPath = path.resolve(targetDirectory, filename);
    if (!isPathInside(targetDirectory, targetPath)) {
      throw new Error(`Context file is outside context directory: ${filename}`);
    }

    const buffer = Buffer.from(normalizeText(file.contentBase64), 'base64');
    fs.writeFileSync(targetPath, buffer);
    manifest.push({
      filename,
      path: targetPath,
      relativePath: path.relative(resolvedCwd, targetPath),
      mimeType: normalizeText(file.mimeType) || 'application/octet-stream',
      sizeBytes: buffer.length,
      source: normalizeText(file.source),
      sourceUrl: normalizeText(file.sourceUrl),
      artifactId: normalizeText(file.artifactId),
      sha256: normalizeText(file.sha256),
      description: normalizeText(file.description),
    });
  }

  const manifestPath = path.join(targetDirectory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    jobId: job.id,
    directory: targetDirectory,
    files: manifest,
  }, null, 2));

  return {
    directory: targetDirectory,
    manifestPath,
    files: manifest,
  };
}

function buildHostIdentity() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    user: os.userInfo().username,
    pid: process.pid,
  };
}

function buildRunnerMetadata() {
  const cliTools = buildCliToolInventory();
  return {
    defaultCwd: defaultCwd || '',
    workspace: workspaceRoot || '',
    shell: runnerShell,
    cliTools,
    availableCliTools: cliTools.filter((tool) => tool.available).map((tool) => tool.name),
    buildkitHostConfigured: Boolean(normalizeText(process.env.BUILDKIT_HOST || '')),
    dockerConfigConfigured: Boolean(normalizeText(process.env.DOCKER_CONFIG || '')),
    kubernetesConfigured: Boolean(normalizeText(process.env.KUBECONFIG || process.env.KUBERNETES_SERVICE_HOST || '')),
    imagePrefix: normalizeText(process.env.DIRECT_CLI_IMAGE_PREFIX || ''),
    browserAutomation: buildBrowserAutomationMetadata(),
    nodeVersion: process.version,
  };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function runCommand(job = {}) {
  const normalized = normalizeCommandJob(job);
  const resolvedCwd = resolveJobCwd(normalized.cwd);
  if (!resolvedCwd) {
    return Promise.resolve({
      jobId: normalized.id,
      stdout: '',
      stderr: `Working directory is outside allowed roots: ${normalized.cwd || defaultCwd}`,
      exitCode: 126,
      duration: 0,
      host: os.hostname(),
      error: 'Disallowed working directory',
    });
  }

  if (isDangerousCommand(normalized.command) && !isApproved(normalized)) {
    return Promise.resolve({
      jobId: normalized.id,
      stdout: '',
      stderr: 'Command requires explicit approval by runner policy.',
      exitCode: 126,
      duration: 0,
      host: os.hostname(),
      error: 'Command requires explicit approval by runner policy',
    });
  }

  let contextInfo = null;
  try {
    contextInfo = materializeJobContext(normalized, resolvedCwd);
  } catch (error) {
    return Promise.resolve({
      jobId: normalized.id,
      stdout: '',
      stderr: error.message,
      exitCode: 126,
      duration: 0,
      host: os.hostname(),
      error: error.message,
    });
  }

  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const child = spawn(normalized.command, [], {
      cwd: resolvedCwd,
      env: {
        ...process.env,
        ...normalized.environment,
        ...(contextInfo ? {
          KIMIBUILT_CONTEXT_DIR: contextInfo.directory,
          KIMIBUILT_CONTEXT_MANIFEST: contextInfo.manifestPath,
        } : {}),
      },
      shell: runnerShell,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill('SIGTERM');
      settled = true;
      resolve({
        jobId: normalized.id,
        stdout: truncateText(stdout, maxOutputChars),
        stderr: truncateText(`${stderr}\nCommand timed out after ${normalized.timeout}ms`, maxOutputChars),
        exitCode: 124,
        duration: Date.now() - started,
        host: os.hostname(),
        startedAt,
        finishedAt: new Date().toISOString(),
        error: `Command timed out after ${normalized.timeout}ms`,
        metadata: contextInfo ? { context: contextInfo } : {},
      });
    }, normalized.timeout);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        jobId: normalized.id,
        stdout: truncateText(stdout, maxOutputChars),
        stderr: truncateText(stderr, maxOutputChars),
        exitCode: 127,
        duration: Date.now() - started,
        host: os.hostname(),
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error.message,
        metadata: contextInfo ? { context: contextInfo } : {},
      });
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        jobId: normalized.id,
        stdout: truncateText(stdout, maxOutputChars),
        stderr: truncateText(stderr, maxOutputChars),
        exitCode: Number(exitCode || 0),
        duration: Date.now() - started,
        host: os.hostname(),
        startedAt,
        finishedAt: new Date().toISOString(),
        metadata: contextInfo ? { context: contextInfo } : {},
      });
    });
  });
}

function connect() {
  const ws = new WebSocket(buildRunnerWsUrl(), {
    ...(tlsInsecure ? { rejectUnauthorized: false } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  let heartbeatTimer = null;

  ws.on('open', () => {
    console.log(`[Runner] Connected as ${runnerId}`);
    send(ws, {
      type: 'register',
      runner: {
        runnerId,
        displayName,
        hostIdentity: buildHostIdentity(),
        capabilities,
        allowedRoots,
        metadata: buildRunnerMetadata(),
      },
    });
    heartbeatTimer = setInterval(() => {
      send(ws, {
        type: 'heartbeat',
        runnerId,
        payload: {
          hostIdentity: buildHostIdentity(),
          metadata: {
            ...buildRunnerMetadata(),
            uptimeSeconds: Math.floor(process.uptime()),
          },
        },
      });
    }, heartbeatMs);
  });

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.warn('[Runner] Invalid message:', error.message);
      return;
    }

    if (message.type !== 'job') {
      return;
    }

    const job = message.job || {};
    const result = await runCommand(job);
    send(ws, {
      type: 'job_result',
      result,
    });
  });

  ws.on('close', () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    console.warn('[Runner] Disconnected; reconnecting in 5s');
    setTimeout(connect, 5000);
  });

  ws.on('error', (error) => {
    console.warn('[Runner] WebSocket error:', error.message);
  });
}

connect();
