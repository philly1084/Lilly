const DEFAULT_EXECUTION_PROFILE = 'default';
const NOTES_EXECUTION_PROFILE = 'notes';
const REMOTE_BUILD_EXECUTION_PROFILE = 'remote-build';
const PODCAST_EXECUTION_PROFILE = 'podcast';
const PODCAST_VIDEO_EXECUTION_PROFILE = 'podcast-video';
const NOTES_ALLOWED_TOOL_IDS = Object.freeze([
    'web-search',
    'web-fetch',
    'web-scrape',
]);

const PROMOTED_LOCAL_TOOL_IDS = Object.freeze([
    'security-scan',
    'architecture-design',
    'uml-generate',
    'api-design',
    'graph-diagram',
    'schema-generate',
    'migration-create',
]);

const BASE_SHARED_TOOL_IDS = Object.freeze([
    'web-search',
    'web-fetch',
    'web-scrape',
    'news-scraper',
    'image-generate',
    'image-search-unsplash',
    'image-from-url',
    'speech-generate',
    'podcast',
    'asset-search',
    'research-bucket-list',
    'research-bucket-search',
    'research-bucket-read',
    'research-bucket-write',
    'research-bucket-mkdir',
    'public-source-list',
    'public-source-search',
    'public-source-get',
    'public-source-add',
    'public-source-refresh',
    'file-read',
    'file-write',
    'file-search',
    'file-mkdir',
    'agent-notes-write',
    'self-reflection-update',
    'agent-delegate',
    'agent-workload',
    'document-workflow',
    'deep-research-presentation',
    'pii-relationship-calculate',
    'design-resource-search',
    'user-checkpoint',
    'git-safe',
    'tool-doc-read',
    'skill-list',
    'skill-read',
    'skill-context',
    'skill-create',
    'skill-update',
    'code-sandbox',
    ...PROMOTED_LOCAL_TOOL_IDS,
]);

const PROFILE_TOOL_ALLOWLISTS = Object.freeze({
    [DEFAULT_EXECUTION_PROFILE]: Object.freeze([
        'remote-command',
        'remote-cli-agent',
        'remote-workbench',
        'k3s-deploy',
        ...BASE_SHARED_TOOL_IDS,
    ]),
    [NOTES_EXECUTION_PROFILE]: Object.freeze([
        ...NOTES_ALLOWED_TOOL_IDS,
    ]),
    [PODCAST_EXECUTION_PROFILE]: Object.freeze([
        'web-search',
        'web-fetch',
        'web-scrape',
        'image-generate',
        'image-search-unsplash',
        'image-from-url',
        'speech-generate',
        'asset-search',
        'research-bucket-list',
        'research-bucket-search',
        'research-bucket-read',
        'public-source-list',
        'public-source-search',
        'public-source-get',
        'tool-doc-read',
    ]),
    [PODCAST_VIDEO_EXECUTION_PROFILE]: Object.freeze([
        'web-search',
        'web-fetch',
        'web-scrape',
        'image-generate',
        'image-search-unsplash',
        'image-from-url',
        'asset-search',
        'research-bucket-list',
        'research-bucket-search',
        'research-bucket-read',
        'public-source-list',
        'public-source-search',
        'public-source-get',
        'tool-doc-read',
    ]),
    [REMOTE_BUILD_EXECUTION_PROFILE]: Object.freeze([
        'managed-app',
        'remote-command',
        'remote-workbench',
        'remote-cli-agent',
        'k3s-deploy',
        ...BASE_SHARED_TOOL_IDS,
    ]),
});

const HIDDEN_FRONTEND_TOOL_IDS = Object.freeze([
    'code-execute',
    'pii-relationship-calculate',
]);

function getAllowedToolIdsForProfile(profile = DEFAULT_EXECUTION_PROFILE) {
    return PROFILE_TOOL_ALLOWLISTS[profile] || PROFILE_TOOL_ALLOWLISTS[DEFAULT_EXECUTION_PROFILE];
}

module.exports = {
    DEFAULT_EXECUTION_PROFILE,
    NOTES_EXECUTION_PROFILE,
    REMOTE_BUILD_EXECUTION_PROFILE,
    PODCAST_EXECUTION_PROFILE,
    PODCAST_VIDEO_EXECUTION_PROFILE,
    NOTES_ALLOWED_TOOL_IDS,
    PROMOTED_LOCAL_TOOL_IDS,
    PROFILE_TOOL_ALLOWLISTS,
    HIDDEN_FRONTEND_TOOL_IDS,
    getAllowedToolIdsForProfile,
};
