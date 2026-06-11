const fs = require('fs');
const path = require('path');
const {
    PROJECT_ROOT,
    resolvePreferredWritableFile,
} = require('./runtime-state-paths');
const { truncateToCharacterLimit } = require('./bounded-content');

const REPO_AGENT_NOTES_FILE = path.join(PROJECT_ROOT, 'agent-notes.md');
const AGENT_NOTES_CHAR_LIMIT = 4000;
const DEFAULT_AGENT_NOTES_MARKDOWN = `# Carryover Notes

## Project
- Primary remote infra target is an Ubuntu Linux ARM64 server running k3s.
- Default remote workflow is: baseline -> inspect -> fix -> verify. Keep command batches small and purposeful.
- Use \`k3s-deploy\` for standard deploy actions such as repo sync, manifest apply, image update, and rollout status.
- Use \`remote-command\` for kubectl inspection, logs, service status, network checks, package installs, one-off repairs, and post-deploy verification.
- Use \`remote-cli-agent\` with \`adminMode: true\` for most remote software author/build/deploy/verify loops where an app, website, service, dashboard, or frontend must be changed and put live through the configured CLI runner.
- If the remote CLI agent needs a user decision, forward its concise request and continue the same session with the answer. Stop retrying after the same blocked command or root error happens twice without a materially different strategy.
- Assume \`kubectl\` should talk to k3s. If context is missing, prefer \`export KUBECONFIG=/etc/rancher/k3s/k3s.yaml\` or \`k3s kubectl\`.
- Prefer non-interactive commands. Avoid editors, interactive shells, \`watch\`, or anything that needs a TTY.
- Do not assume \`rg\`, Docker, \`docker-compose\`, \`ifconfig\`, or \`netstat\` exist on the server. Prefer \`find\` and \`grep -R\`, \`kubectl\` or \`k3s kubectl\`, \`ip addr\`, and \`ss -tulpn\`.
- For k3s triage, a common sequence is \`kubectl get pods -A -o wide\`, \`kubectl describe ...\`, \`kubectl logs ... --previous\`, \`kubectl rollout status ...\`, then \`systemctl status k3s\` and \`journalctl -u k3s --no-pager -n 200\` if control-plane health is suspect.

## Phil
- Wants the assistant to feel like a personal agent and collaborative partner, not just a generic task executor.
- Prefer a little more niceness, friendliness, and partner energy while staying grounded and useful.
- Learn stable preferences over time and carry them across sessions when they are genuinely durable.
- For remote work, prefer concrete command outputs over vague status summaries.
- Keep server commands safe and minimal; do not mutate live resources until the diagnosis points to a specific fix.
`;

let cachedAgentNotes = null;

function getAgentNotesFilePath() {
    const configured = String(process.env.KIMIBUILT_AGENT_NOTES_PATH || '').trim();
    if (configured) {
        return path.resolve(PROJECT_ROOT, configured);
    }

    return resolvePreferredWritableFile(REPO_AGENT_NOTES_FILE, ['agent-notes.md']);
}

function toDisplayPath(filePath = '') {
    const relative = path.relative(PROJECT_ROOT, filePath);
    return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : filePath;
}

function normalizeComparablePath(filePath = '') {
    const normalized = path.resolve(String(filePath || '')).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeAgentNotesMarkdown(value = '') {
    const normalized = String(value || '').replace(/\r\n/g, '\n').trimEnd();
    return normalized ? `${normalized}\n` : '';
}

function createAgentNotesLimitError(actualLength = 0) {
    const error = new Error(`agent-notes.md cannot exceed ${AGENT_NOTES_CHAR_LIMIT} characters (received ${actualLength}).`);
    error.code = 'AGENT_NOTES_LIMIT_EXCEEDED';
    error.statusCode = 400;
    error.details = {
        actualLength,
        limit: AGENT_NOTES_CHAR_LIMIT,
    };
    return error;
}

function validateAgentNotesContent(content = '') {
    const normalized = normalizeAgentNotesMarkdown(content);
    if (normalized.length > AGENT_NOTES_CHAR_LIMIT) {
        throw createAgentNotesLimitError(normalized.length);
    }

    return normalized;
}

function readAgentNotesFile() {
    const absoluteFilePath = getAgentNotesFilePath();

    try {
        const stat = fs.statSync(absoluteFilePath);
        if (cachedAgentNotes && cachedAgentNotes.absoluteFilePath === absoluteFilePath && cachedAgentNotes.mtimeMs === stat.mtimeMs) {
            return cachedAgentNotes.data;
        }

        const rawContent = fs.readFileSync(absoluteFilePath, 'utf8');
        const bounded = truncateToCharacterLimit(rawContent, AGENT_NOTES_CHAR_LIMIT, 'agent-notes.md');
        const data = {
            content: bounded.content,
            absoluteFilePath,
            filePath: toDisplayPath(absoluteFilePath),
            updatedAt: stat.mtime.toISOString(),
            source: bounded.truncated ? 'file-truncated' : 'file',
            limitExceeded: bounded.truncated,
            originalCharacterCount: bounded.originalCharacterCount,
        };

        cachedAgentNotes = {
            absoluteFilePath,
            mtimeMs: stat.mtimeMs,
            data,
        };

        return data;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }

        return {
            content: DEFAULT_AGENT_NOTES_MARKDOWN,
            absoluteFilePath,
            filePath: toDisplayPath(absoluteFilePath),
            updatedAt: null,
            source: 'default',
            limitExceeded: false,
            originalCharacterCount: DEFAULT_AGENT_NOTES_MARKDOWN.length,
        };
    }
}

function getEffectiveAgentNotesConfig(settings = {}) {
    const fileState = readAgentNotesFile();
    const displayName = String(settings?.displayName || 'Carryover Notes').trim() || 'Carryover Notes';
    const content = String(fileState.content || '');

    return {
        enabled: settings?.enabled !== false,
        displayName,
        content,
        defaultContent: DEFAULT_AGENT_NOTES_MARKDOWN,
        filePath: fileState.filePath,
        absoluteFilePath: fileState.absoluteFilePath,
        updatedAt: fileState.updatedAt,
        source: fileState.source,
        limitExceeded: fileState.limitExceeded === true,
        originalCharacterCount: fileState.originalCharacterCount || content.length,
        characterLimit: AGENT_NOTES_CHAR_LIMIT,
        characterCount: content.length,
    };
}

function isAgentNotesFilePath(filePath = '') {
    if (!filePath) {
        return false;
    }

    return normalizeComparablePath(filePath) === normalizeComparablePath(getAgentNotesFilePath());
}

function writeAgentNotesFile(content = '') {
    const absoluteFilePath = getAgentNotesFilePath();
    const normalizedContent = validateAgentNotesContent(content);

    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, normalizedContent, 'utf8');
    cachedAgentNotes = null;

    return getEffectiveAgentNotesConfig();
}

function resetAgentNotesFile() {
    return writeAgentNotesFile(DEFAULT_AGENT_NOTES_MARKDOWN);
}

function buildAgentNotesInstructions(settings = {}) {
    const effective = getEffectiveAgentNotesConfig(settings);

    if (!effective.enabled || effective.source === 'default') {
        return '';
    }

    const currentNotes = String(effective.content || '').trim() || '(empty)';

    return [
        '[Carryover notes memory]',
        'Treat this as durable user-wide carryover memory for stable preferences, collaboration details, tone and working-style patterns, and longer-term defaults that should apply across sessions and projects.',
        'Use these notes to make the assistant feel more personal, consistent, and easier to work with over time.',
        `The notes file lives at ${effective.filePath} and has a hard limit of ${AGENT_NOTES_CHAR_LIMIT} characters.`,
        'The rolling agent journal is automatic turn-level orientation. This carryover notes file is not a journal; update it only for durable lessons that should survive across sessions.',
        'When the `agent-notes-write` tool is available, do a brief before-finish review: if the turn revealed a genuinely useful durable preference or collaboration pattern, update these notes without a separate confirmation; otherwise do not write filler.',
        'Keep the notes compact and factual. Prefer distilled bullets over prose.',
        'Good candidates: recurring preferences, facts about working with Phil, stable tone or collaboration preferences, and long-lived tool or workflow defaults.',
        'Do not use this file for project-specific working memory, current task state, transient research, or frontend-specific continuity. Keep those in project/session memory instead.',
        'Do not store secrets, credentials, temporary scratch notes, verbose logs, or code dumps.',
        'Rewrite the full notes file when you update it, preserving useful existing context while removing stale noise.',
        'Current notes:',
        currentNotes,
    ].join('\n');
}

module.exports = {
    AGENT_NOTES_CHAR_LIMIT,
    DEFAULT_AGENT_NOTES_MARKDOWN,
    buildAgentNotesInstructions,
    createAgentNotesLimitError,
    getAgentNotesFilePath,
    getEffectiveAgentNotesConfig,
    isAgentNotesFilePath,
    normalizeAgentNotesMarkdown,
    resetAgentNotesFile,
    validateAgentNotesContent,
    writeAgentNotesFile,
};
