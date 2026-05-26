const path = require('path');
const { spawn } = require('child_process');

function parseBoolean(value, fallback = false) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function splitArgs(value = '') {
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
}

function resolveDefaultScriptPath() {
    return path.resolve(__dirname, '../../scripts/kokoro_g2p_bridge.py');
}

class KokoroG2pBridge {
    constructor(options = {}) {
        this.enabled = options.enabled ?? process.env.KOKORO_G2P_ENABLED !== 'false';
        this.required = options.required ?? parseBoolean(process.env.KOKORO_G2P_REQUIRED, false);
        this.command = String(options.command || process.env.KOKORO_G2P_COMMAND || 'python3').trim();
        this.scriptPath = String(options.scriptPath || process.env.KOKORO_G2P_SCRIPT_PATH || resolveDefaultScriptPath()).trim();
        this.args = Array.isArray(options.args)
            ? options.args.slice()
            : splitArgs(process.env.KOKORO_G2P_ARGS);
        if (this.args.length === 0 && this.scriptPath) {
            this.args = [this.scriptPath];
        }
        this.timeoutMs = Math.max(250, Number(options.timeoutMs || process.env.KOKORO_G2P_TIMEOUT_MS) || 3000);
        this.child = null;
        this.pending = new Map();
        this.nextId = 1;
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        this.warnedUnavailable = false;
    }

    isEnabled() {
        return this.enabled !== false && Boolean(this.command);
    }

    phonemize(text = '', language = 'en-us') {
        if (!this.isEnabled()) {
            return Promise.reject(new Error('Kokoro G2P bridge is disabled.'));
        }

        return new Promise((resolve, reject) => {
            const child = this.ensureChild();
            const id = String(this.nextId++);
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Kokoro G2P bridge timed out after ${this.timeoutMs}ms.`));
            }, this.timeoutMs);
            timer.unref?.();

            this.pending.set(id, { resolve, reject, timer });

            const payload = JSON.stringify({
                id,
                text: String(text || ''),
                language,
            });

            child.stdin.write(`${payload}\n`, 'utf8', (error) => {
                if (!error) {
                    return;
                }
                const pending = this.pending.get(id);
                if (!pending) {
                    return;
                }
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(error);
            });
        });
    }

    ensureChild() {
        if (this.child && !this.child.killed) {
            return this.child;
        }

        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        this.child = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
                PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || '1',
            },
        });

        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));

        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (chunk) => {
            this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
        });

        this.child.on('error', (error) => this.rejectAll(error));
        this.child.on('close', (code) => {
            const message = this.stderrBuffer.trim()
                || `Kokoro G2P bridge exited with code ${code}.`;
            this.rejectAll(new Error(message));
            this.child = null;
        });

        return this.child;
    }

    handleStdout(chunk = '') {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (line) {
                this.handleLine(line);
            }
            newlineIndex = this.stdoutBuffer.indexOf('\n');
        }
    }

    handleLine(line = '') {
        let payload;
        try {
            payload = JSON.parse(line);
        } catch (error) {
            this.rejectAll(new Error(`Kokoro G2P bridge returned invalid JSON: ${error.message}`));
            return;
        }

        const pending = this.pending.get(String(payload.id || ''));
        if (!pending) {
            return;
        }

        this.pending.delete(String(payload.id));
        clearTimeout(pending.timer);

        if (payload.ok === false) {
            pending.reject(new Error(payload.error || 'Kokoro G2P bridge failed.'));
            return;
        }

        pending.resolve(payload);
    }

    rejectAll(error) {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }

    close() {
        if (!this.child) {
            return;
        }
        const child = this.child;
        this.child = null;
        this.rejectAll(new Error('Kokoro G2P bridge closed.'));
        child.stdin.destroy();
        child.kill();
    }
}

module.exports = {
    KokoroG2pBridge,
};
