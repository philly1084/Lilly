'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { SSHExecuteTool } = require('../agent-sdk/tools/categories/ssh/SSHExecuteTool');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

class OpenCodeLocalClient {
    constructor({ baseURL, username = 'opencode', password = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
        this.baseURL = String(baseURL || '').replace(/\/+$/, '');
        this.username = username || 'opencode';
        this.password = password || '';
        this.timeoutMs = timeoutMs;
    }

    async request(method, pathname, body = null, options = {}) {
        const response = await fetch(`${this.baseURL}${pathname}`, {
            method,
            headers: buildHeaders(this.username, this.password, body),
            body: body == null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(options.timeoutMs || this.timeoutMs),
        });

        return parseResponse(response);
    }

    async waitForHealth() {
        return this.request('GET', '/global/health');
    }

    async createSession(body = {}) {
        return this.request('POST', '/session', body);
    }

    async getSession(sessionId) {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}`);
    }

    async sendMessage(sessionId, body = {}) {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/message`, body);
    }

    async sendMessageAsync(sessionId, body = {}) {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
    }

    async abortSession(sessionId) {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`);
    }

    async respondToPermission(sessionId, permissionId, body = {}) {
        return this.request(
            'POST',
            `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
            body,
        );
    }

    async getSessionDiff(sessionId) {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/diff`);
    }

    async listMessages(sessionId, limit = 20) {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/message?limit=${Math.max(1, Number(limit) || 20)}`);
    }

    async openGlobalEventStream(onEvent, { signal } = {}) {
        const response = await fetch(`${this.baseURL}/global/event`, {
            method: 'GET',
            headers: buildHeaders(this.username, this.password),
            signal,
        });

        if (!response.ok || !response.body) {
            const error = new Error(`OpenCode event stream failed with HTTP ${response.status}`);
            error.statusCode = response.status;
            throw error;
        }

        return consumeSseStream(response.body, onEvent, { signal });
    }
}

class OpenCodeRemoteClient {
    constructor({
        port,
        username = 'opencode',
        password = '',
        sshConfig = {},
        timeoutMs = DEFAULT_TIMEOUT_MS,
        sshTool = new SSHExecuteTool({ id: 'opencode-ssh-bridge' }),
        commandTransport = null,
    }) {
        this.port = port;
        this.username = username || 'opencode';
        this.password = password || '';
        this.timeoutMs = timeoutMs;
        this.sshConfig = {
            host: sshConfig.host || '',
            port: Number(sshConfig.port) || 22,
            username: sshConfig.username || '',
            password: sshConfig.password || '',
            privateKeyPath: sshConfig.privateKeyPath || '',
        };
        this.sshTool = sshTool;
        this.commandTransport = commandTransport;
    }

    async request(method, pathname, body = null, options = {}) {
        const script = buildRemoteCurlScript({
            method,
            pathname,
            port: this.port,
            username: this.username,
            password: this.password,
            body,
            shell: this.sshTool,
        });
        const result = await this.executeRemoteScript(script, options.timeoutMs || this.timeoutMs, {
            originalCommand: `curl ${pathname}`,
        });

        return parseRemoteCurlOutput(result.stdout);
    }

    async executeRemoteScript(script = '', timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
        if (this.commandTransport?.isAvailable?.()) {
            return this.commandTransport.execute({
                command: script,
                timeout: timeoutMs,
                profile: 'build',
                metadata: {
                    originalCommand: options.originalCommand || '',
                },
            }, {
                toolId: 'opencode-run',
            });
        }

        const connection = await this.resolveConnection();
        return this.sshTool.executeSSH(
            connection,
            script,
            timeoutMs,
            options,
        );
    }

    async waitForHealth() {
        return this.request('GET', '/global/health');
    }

    async createSession(body = {}) {
        return this.request('POST', '/session', body);
    }

    async getSession(sessionId) {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}`);
    }

    async sendMessage(sessionId, body = {}) {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/message`, body);
    }

    async sendMessageAsync(sessionId, body = {}) {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
    }

    async abortSession(sessionId) {
        return this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`);
    }

    async respondToPermission(sessionId, permissionId, body = {}) {
        return this.request(
            'POST',
            `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
            body,
        );
    }

    async getSessionDiff(sessionId) {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/diff`);
    }

    async listMessages(sessionId, limit = 20) {
        return this.request('GET', `/session/${encodeURIComponent(sessionId)}/message?limit=${Math.max(1, Number(limit) || 20)}`);
    }

    async openGlobalEventStream(onEvent, options = {}) {
        if (this.commandTransport?.isAvailable?.()) {
            throw new Error('Remote OpenCode event stream over runner transport is not supported yet');
        }
        const connection = await this.resolveConnection();
        const childProcess = await spawnRemoteSseProcess({
            connection,
            port: this.port,
            username: this.username,
            password: this.password,
            sshTool: this.sshTool,
        });

        return consumeChildProcessSse(childProcess, onEvent, options);
    }

    async resolveConnection() {
        const connection = await this.sshTool.getConnectionConfig({
            host: this.sshConfig.host,
            port: this.sshConfig.port,
            username: this.sshConfig.username,
            context: {
                sshCredentials: {
                    default: this.sshConfig,
                },
            },
        });

        if (!connection.host || !connection.username || (!connection.password && !connection.privateKeyPath)) {
            const error = new Error('Remote OpenCode access requires configured SSH credentials');
            error.statusCode = 503;
            throw error;
        }

        return connection;
    }
}

function buildHeaders(username = 'opencode', password = '', body = null) {
    const headers = {
        Accept: 'application/json',
    };

    if (body != null) {
        headers['Content-Type'] = 'application/json';
    }

    if (password) {
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    return headers;
}

async function parseResponse(response) {
    const text = await response.text();
    if (!response.ok) {
        const error = new Error(text || `OpenCode request failed with HTTP ${response.status}`);
        error.statusCode = response.status;
        error.body = text;
        throw error;
    }

    if (!text) {
        return true;
    }

    return parseJsonOrScalar(text);
}

function parseJsonOrScalar(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        return true;
    }

    if (trimmed === 'true') {
        return true;
    }
    if (trimmed === 'false') {
        return false;
    }

    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        return trimmed;
    }
}

function buildRemoteCurlScript({
    method,
    pathname,
    port,
    username,
    password,
    body = null,
    shell,
}) {
    const quotedAuth = shell.quoteShellArg(`${username}:${password}`);
    const quotedUrl = shell.quoteShellArg(`http://127.0.0.1:${port}${pathname}`);
    const marker = '__KIMIBUILT_HTTP__';
    const lines = [
        'tmp_body=""',
    ];

    if (body != null) {
        const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
        lines.push(`tmp_body="/tmp/kimibuilt-opencode-body-$$.json"`);
        lines.push(`printf '%s' ${shell.quoteShellArg(encoded)} | base64 -d > "$tmp_body"`);
    }

    const curlArgs = [
        'curl',
        '-sS',
        '-u',
        quotedAuth,
        '-H',
        shell.quoteShellArg('Accept: application/json'),
        '-X',
        shell.quoteShellArg(method.toUpperCase()),
    ];

    if (body != null) {
        curlArgs.push(
            '-H',
            shell.quoteShellArg('Content-Type: application/json'),
            '--data',
            '"@$tmp_body"',
        );
    }

    curlArgs.push(
        '-w',
        shell.quoteShellArg(`\\n${marker}%{http_code}`),
        quotedUrl,
    );
    lines.push(`response=$(${curlArgs.join(' ')})`);
    lines.push('status=$?');
    lines.push('if [ -n "$tmp_body" ]; then rm -f "$tmp_body"; fi');
    lines.push('if [ "$status" -ne 0 ]; then exit "$status"; fi');
    lines.push('printf "%s" "$response"');
    lines.push('');

    return lines.join('\n');
}

function parseRemoteCurlOutput(stdout = '') {
    const marker = '__KIMIBUILT_HTTP__';
    const text = String(stdout || '');
    const index = text.lastIndexOf(marker);
    if (index === -1) {
        return parseJsonOrScalar(text);
    }

    const body = text.slice(0, index);
    const statusText = text.slice(index + marker.length).trim();
    const status = Number(statusText);
    if (!Number.isFinite(status)) {
        return parseJsonOrScalar(body);
    }

    if (status >= 400) {
        const error = new Error(body.trim() || `OpenCode request failed with HTTP ${status}`);
        error.statusCode = status;
        error.body = body;
        throw error;
    }

    return parseJsonOrScalar(body);
}

async function spawnRemoteSseProcess({
    connection,
    port,
    username,
    password,
    sshTool,
}) {
    const sshPath = await sshTool.findSshBinary();
    const askPassScript = connection.password ? await sshTool.createAskPassScript() : null;
    const sshArgs = [
        '-p',
        String(connection.port || 22),
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'LogLevel=ERROR',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
    ];

    if (connection.privateKeyPath) {
        sshArgs.push('-i', connection.privateKeyPath);
    }

    if (connection.password) {
        sshArgs.push(
            '-o',
            'PreferredAuthentications=password,keyboard-interactive',
            '-o',
            'PubkeyAuthentication=no',
        );
    }

    sshArgs.push(
        `${connection.username}@${connection.host}`,
        sshTool.buildRemoteLauncher(),
    );

    const env = {
        ...process.env,
        LC_ALL: 'C',
    };

    if (connection.password && askPassScript) {
        env.SSH_ASKPASS = askPassScript;
        env.SSH_ASKPASS_REQUIRE = 'force';
        env.DISPLAY = env.DISPLAY || 'kimibuilt:0';
        env.KIMIBUILT_SSH_PASSWORD = connection.password;
    }

    const child = spawn(sshPath, sshArgs, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const script = [
        `exec curl -sS -N -u ${sshTool.quoteShellArg(`${username}:${password}`)} ${sshTool.quoteShellArg(`http://127.0.0.1:${port}/global/event`)}`,
        '',
    ].join('\n');

    child.__kimibuiltCleanup = async () => {
        if (askPassScript) {
            const fs = require('fs').promises;
            await fs.rm(require('path').dirname(askPassScript), { recursive: true, force: true }).catch(() => {});
        }
    };
    child.stdin.write(script);
    child.stdin.end();
    return child;
}

async function consumeSseStream(stream, onEvent, { signal } = {}) {
    const reader = stream.getReader();
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    while (true) {
        if (signal?.aborted) {
            break;
        }

        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.write(Buffer.from(value));
        buffer = flushSseBuffer(buffer, onEvent);
    }

    buffer += decoder.end();
    if (buffer.trim()) {
        flushSseBuffer(`${buffer}\n\n`, onEvent);
    }
}

function consumeChildProcessSse(child, onEvent, { signal } = {}) {
    return new Promise((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        let stderr = '';
        let settled = false;

        const settle = async (fn, value) => {
            if (settled) {
                return;
            }
            settled = true;
            await child.__kimibuiltCleanup?.();
            fn(value);
        };

        child.stdout?.on('data', (chunk) => {
            buffer += decoder.write(chunk);
            buffer = flushSseBuffer(buffer, onEvent);
        });

        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });

        child.on('error', (error) => {
            settle(reject, error);
        });

        child.on('close', (code) => {
            buffer += decoder.end();
            if (buffer.trim()) {
                flushSseBuffer(`${buffer}\n\n`, onEvent);
            }

            if (signal?.aborted || code === 0 || code === null) {
                settle(resolve);
                return;
            }

            const error = new Error(stderr.trim() || `Remote OpenCode event stream exited with code ${code}`);
            error.exitCode = code;
            settle(reject, error);
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                try {
                    child.kill('SIGTERM');
                } catch (_error) {
                    // Ignore best-effort termination failures.
                }
            }, { once: true });
        }
    });
}

function flushSseBuffer(buffer, onEvent) {
    let next = String(buffer || '');
    let separatorIndex = next.indexOf('\n\n');

    while (separatorIndex !== -1) {
        const rawEvent = next.slice(0, separatorIndex);
        next = next.slice(separatorIndex + 2);
        separatorIndex = next.indexOf('\n\n');

        const parsed = parseSseEvent(rawEvent);
        if (parsed) {
            onEvent(parsed);
        }
    }

    return next;
}

function parseSseEvent(rawEvent = '') {
    const lines = String(rawEvent || '').split(/\r?\n/);
    let id = '';
    let event = 'message';
    const dataLines = [];

    for (const line of lines) {
        if (!line || line.startsWith(':')) {
            continue;
        }
        if (line.startsWith('id:')) {
            id = line.slice(3).trim();
            continue;
        }
        if (line.startsWith('event:')) {
            event = line.slice(6).trim() || 'message';
            continue;
        }
        if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
        }
    }

    if (dataLines.length === 0 && !id && !event) {
        return null;
    }

    const dataText = dataLines.join('\n');
    return {
        id: id || null,
        event: event || 'message',
        data: parseJsonOrScalar(dataText),
        raw: rawEvent,
    };
}

function extractMessageText(message = null) {
    const parts = Array.isArray(message?.parts)
        ? message.parts
        : Array.isArray(message)
            ? message
            : [];
    const collected = [];

    walkParts(parts, collected);
    return collected.join('\n').trim();
}

function walkParts(value, collected) {
    if (value == null) {
        return;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
            collected.push(trimmed);
        }
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((entry) => walkParts(entry, collected));
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    if (typeof value.text === 'string' && value.text.trim()) {
        collected.push(value.text.trim());
    }

    ['content', 'parts', 'children', 'value'].forEach((key) => {
        if (value[key] !== undefined) {
            walkParts(value[key], collected);
        }
    });
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    OpenCodeLocalClient,
    OpenCodeRemoteClient,
    extractMessageText,
    parseSseEvent,
};
