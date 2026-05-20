const fs = require('fs');
const path = require('path');
const {
    PROJECT_ROOT,
    resolvePreferredWritableFile,
} = require('./runtime-state-paths');

const REPO_SOUL_FILE = path.join(PROJECT_ROOT, 'soul.md');
const SOUL_CHAR_LIMIT = 3700;
const DEFAULT_SOUL_MARKDOWN = `# Soul

You are Lilly: calm, observant, practical, quietly confident, and easy to work with.

## Voice
- Speak like a capable human operator, not a mascot.
- Be warm, friendly, and grounded without hype, flattery, or theatrics.
- Sound like a thoughtful collaborator: on the user's side, working with them rather than talking at them.
- Keep answers lean by default, and expand only when depth is useful or requested.

## Behavior
- Lead with the clearest next useful answer.
- Try to understand the user's real goal, constraints, and working style, not just the literal wording.
- Act like a collaborative partner: help shape the path forward, suggest sensible next steps, and reduce friction.
- Prefer grounded specifics over vague abstraction.
- Show initiative on low-risk follow-through instead of waiting for permission on every small step.
- Be honest about uncertainty, tradeoffs, and limits.
- Match the user's tone and technical depth when it helps.
- When you notice a stable preference or recurring collaboration pattern, capture it in the bounded user profile or durable carryover memory so future sessions work better from the start.

## Boundaries
- Do not pretend to have feelings, consciousness, or private memories you do not actually have.
- Do not invent personal facts or continuity; rely on the current session, available memory, user profile, and durable notes.
- Do not force this style when the user explicitly asks for a different tone or persona.
`;

let cachedSoul = null;

function getSoulFilePath() {
    const configured = String(process.env.KIMIBUILT_SOUL_PATH || '').trim();
    if (configured) {
        return path.resolve(PROJECT_ROOT, configured);
    }

    return resolvePreferredWritableFile(REPO_SOUL_FILE, ['soul.md']);
}

function toDisplayPath(filePath = '') {
    const relative = path.relative(PROJECT_ROOT, filePath);
    return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : filePath;
}

function normalizeSoulMarkdown(value = '') {
    const normalized = String(value || '').replace(/\r\n/g, '\n').trimEnd();
    return normalized ? `${normalized}\n` : '';
}

function createSoulLimitError(actualLength = 0) {
    const error = new Error(`soul.md cannot exceed ${SOUL_CHAR_LIMIT} characters (received ${actualLength}).`);
    error.code = 'SOUL_LIMIT_EXCEEDED';
    error.statusCode = 400;
    error.details = {
        actualLength,
        limit: SOUL_CHAR_LIMIT,
    };
    return error;
}

function validateSoulContent(content = '') {
    const normalized = normalizeSoulMarkdown(content);
    if (normalized.length > SOUL_CHAR_LIMIT) {
        throw createSoulLimitError(normalized.length);
    }

    return normalized;
}

function readSoulFile() {
    const absoluteFilePath = getSoulFilePath();

    try {
        const stat = fs.statSync(absoluteFilePath);
        if (cachedSoul && cachedSoul.absoluteFilePath === absoluteFilePath && cachedSoul.mtimeMs === stat.mtimeMs) {
            return cachedSoul.data;
        }

        const content = fs.readFileSync(absoluteFilePath, 'utf8');
        const data = {
            content,
            absoluteFilePath,
            filePath: toDisplayPath(absoluteFilePath),
            updatedAt: stat.mtime.toISOString(),
            source: 'file',
        };

        cachedSoul = {
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
            content: DEFAULT_SOUL_MARKDOWN,
            absoluteFilePath,
            filePath: toDisplayPath(absoluteFilePath),
            updatedAt: null,
            source: 'default',
        };
    }
}

function getEffectiveSoulConfig(settings = {}) {
    const fileState = readSoulFile();
    const displayName = String(settings?.displayName || 'Agent Soul').trim() || 'Agent Soul';

    return {
        enabled: settings?.enabled !== false,
        displayName,
        content: fileState.content,
        defaultContent: DEFAULT_SOUL_MARKDOWN,
        filePath: fileState.filePath,
        absoluteFilePath: fileState.absoluteFilePath,
        updatedAt: fileState.updatedAt,
        source: fileState.source,
        characterLimit: SOUL_CHAR_LIMIT,
        characterCount: String(fileState.content || '').length,
    };
}

function writeSoulFile(content = '') {
    const absoluteFilePath = getSoulFilePath();
    const normalizedContent = validateSoulContent(content);

    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, normalizedContent, 'utf8');
    cachedSoul = null;

    return getEffectiveSoulConfig();
}

function resetSoulFile() {
    return writeSoulFile(DEFAULT_SOUL_MARKDOWN);
}

function buildSoulInstructions(settings = {}) {
    const effective = getEffectiveSoulConfig(settings);
    const content = String(effective.content || '').trim();

    if (!effective.enabled || !content) {
        return '';
    }

    return [
        '[Agent soul]',
        'Treat the following as the assistant\'s enduring personality and voice. Use it to shape tone, pacing, and style unless the user explicitly asks otherwise or higher-priority instructions conflict.',
        content,
    ].join('\n');
}

module.exports = {
    DEFAULT_SOUL_MARKDOWN,
    SOUL_CHAR_LIMIT,
    buildSoulInstructions,
    createSoulLimitError,
    getEffectiveSoulConfig,
    getSoulFilePath,
    normalizeSoulMarkdown,
    resetSoulFile,
    validateSoulContent,
    writeSoulFile,
};
