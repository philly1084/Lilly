const fs = require('fs');
const path = require('path');
const {
    PROJECT_ROOT,
    resolvePreferredWritableFile,
} = require('./runtime-state-paths');
const { truncateToCharacterLimit } = require('./bounded-content');

const REPO_USER_PROFILE_FILE = path.join(PROJECT_ROOT, 'user.md');
const USER_PROFILE_CHAR_LIMIT = 3700;
const DEFAULT_USER_PROFILE_MARKDOWN = `# User

## Phil
- Works with KimiBuilt as a hands-on implementation, debugging, live-ops, and product-building partner.
- Prefers concrete evidence, exact files/routes/commands, and verification of the real user-facing path.
- Likes the assistant to feel like a capable personal agent and collaborative partner while staying grounded and useful.

## Durable Collaboration Defaults
- Reproduce concrete failures before theorizing when a failing prompt, route, browser symptom, pod log, or endpoint is provided.
- Keep known-good baselines intact while isolating regressions.
- Continue through implementation and verification when the request implies action.
- Keep updates concise, warm, and evidence-backed.
`;

let cachedUserProfile = null;

function getUserProfileFilePath() {
    const configured = String(process.env.KIMIBUILT_USER_PROFILE_PATH || process.env.KIMIBUILT_USER_MD_PATH || '').trim();
    if (configured) {
        return path.resolve(PROJECT_ROOT, configured);
    }

    return resolvePreferredWritableFile(REPO_USER_PROFILE_FILE, ['user.md']);
}

function toDisplayPath(filePath = '') {
    const relative = path.relative(PROJECT_ROOT, filePath);
    return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : filePath;
}

function normalizeUserProfileMarkdown(value = '') {
    const normalized = String(value || '').replace(/\r\n/g, '\n').trimEnd();
    return normalized ? `${normalized}\n` : '';
}

function createUserProfileLimitError(actualLength = 0) {
    const error = new Error(`user.md cannot exceed ${USER_PROFILE_CHAR_LIMIT} characters (received ${actualLength}).`);
    error.code = 'USER_PROFILE_LIMIT_EXCEEDED';
    error.statusCode = 400;
    error.details = {
        actualLength,
        limit: USER_PROFILE_CHAR_LIMIT,
    };
    return error;
}

function validateUserProfileContent(content = '') {
    const normalized = normalizeUserProfileMarkdown(content);
    if (normalized.length > USER_PROFILE_CHAR_LIMIT) {
        throw createUserProfileLimitError(normalized.length);
    }

    return normalized;
}

function readUserProfileFile() {
    const absoluteFilePath = getUserProfileFilePath();

    try {
        const stat = fs.statSync(absoluteFilePath);
        if (cachedUserProfile && cachedUserProfile.absoluteFilePath === absoluteFilePath && cachedUserProfile.mtimeMs === stat.mtimeMs) {
            return cachedUserProfile.data;
        }

        const rawContent = fs.readFileSync(absoluteFilePath, 'utf8');
        const bounded = truncateToCharacterLimit(rawContent, USER_PROFILE_CHAR_LIMIT, 'user.md');
        const data = {
            content: bounded.content,
            absoluteFilePath,
            filePath: toDisplayPath(absoluteFilePath),
            updatedAt: stat.mtime.toISOString(),
            source: bounded.truncated ? 'file-truncated' : 'file',
            limitExceeded: bounded.truncated,
            originalCharacterCount: bounded.originalCharacterCount,
        };

        cachedUserProfile = {
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
            content: DEFAULT_USER_PROFILE_MARKDOWN,
            absoluteFilePath,
            filePath: toDisplayPath(absoluteFilePath),
            updatedAt: null,
            source: 'default',
            limitExceeded: false,
            originalCharacterCount: DEFAULT_USER_PROFILE_MARKDOWN.length,
        };
    }
}

function getEffectiveUserProfileConfig(settings = {}) {
    const fileState = readUserProfileFile();
    const displayName = String(settings?.displayName || 'User Profile').trim() || 'User Profile';
    const content = String(fileState.content || '');

    return {
        enabled: settings?.enabled !== false,
        displayName,
        content,
        defaultContent: DEFAULT_USER_PROFILE_MARKDOWN,
        filePath: fileState.filePath,
        absoluteFilePath: fileState.absoluteFilePath,
        updatedAt: fileState.updatedAt,
        source: fileState.source,
        limitExceeded: fileState.limitExceeded === true,
        originalCharacterCount: fileState.originalCharacterCount || content.length,
        characterLimit: USER_PROFILE_CHAR_LIMIT,
        characterCount: content.length,
    };
}

function writeUserProfileFile(content = '') {
    const absoluteFilePath = getUserProfileFilePath();
    const normalizedContent = validateUserProfileContent(content);

    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, normalizedContent, 'utf8');
    cachedUserProfile = null;

    return getEffectiveUserProfileConfig();
}

function resetUserProfileFile() {
    return writeUserProfileFile(DEFAULT_USER_PROFILE_MARKDOWN);
}

function buildUserProfileInstructions(settings = {}) {
    const effective = getEffectiveUserProfileConfig(settings);

    if (!effective.enabled) {
        return '';
    }

    const currentProfile = String(effective.content || '').trim() || '(empty)';

    return [
        '[User profile memory]',
        'Treat this as a Hermes-style USER.md profile: durable user-wide facts, stable preferences, and collaboration defaults that should help future sessions.',
        `The user profile file lives at ${effective.filePath} and has a hard limit of ${USER_PROFILE_CHAR_LIMIT} characters.`,
        'Use it to understand Phil and the working relationship, not to store current task state.',
        'Good candidates: stable collaboration preferences, recurring evidence standards, tone preferences, high-level product/workflow defaults, and user-wide expectations.',
        'Do not store secrets, credentials, raw logs, transcripts, sensitive personal data, or one-off project scratch notes.',
        'Current user profile:',
        currentProfile,
    ].join('\n');
}

module.exports = {
    DEFAULT_USER_PROFILE_MARKDOWN,
    USER_PROFILE_CHAR_LIMIT,
    buildUserProfileInstructions,
    createUserProfileLimitError,
    getEffectiveUserProfileConfig,
    getUserProfileFilePath,
    normalizeUserProfileMarkdown,
    resetUserProfileFile,
    validateUserProfileContent,
    writeUserProfileFile,
};
