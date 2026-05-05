const {
    DEFAULT_EXECUTION_PROFILE,
    NOTES_EXECUTION_PROFILE,
    NOTES_ALLOWED_TOOL_IDS,
    REMOTE_BUILD_EXECUTION_PROFILE,
    PODCAST_EXECUTION_PROFILE,
    PODCAST_VIDEO_EXECUTION_PROFILE,
    HIDDEN_FRONTEND_TOOL_IDS,
    getAllowedToolIdsForProfile,
} = require('./tool-execution-profiles');

describe('tool execution profiles', () => {
    test('promoted local tools are available in the default profile', () => {
        const toolIds = getAllowedToolIdsForProfile(DEFAULT_EXECUTION_PROFILE);

        expect(toolIds).toEqual(expect.arrayContaining([
            'git-safe',
            'agent-workload',
            'asset-search',
            'speech-generate',
            'podcast',
            'deep-research-presentation',
            'design-resource-search',
            'code-sandbox',
            'security-scan',
            'architecture-design',
            'uml-generate',
            'api-design',
            'schema-generate',
            'migration-create',
            'remote-command',
        ]));
    });

    test('notes profile is restricted to web research tools only', () => {
        const toolIds = getAllowedToolIdsForProfile(NOTES_EXECUTION_PROFILE);

        expect(toolIds).toEqual([...NOTES_ALLOWED_TOOL_IDS]);
        expect(toolIds).not.toContain('remote-command');
        expect(toolIds).not.toContain('document-workflow');
        expect(toolIds).not.toContain('file-write');
        expect(toolIds).not.toContain('ssh-execute');
    });

    test('remote-build profile exposes GitLab managed-app and remote fallback lanes without opencode', () => {
        const toolIds = getAllowedToolIdsForProfile(REMOTE_BUILD_EXECUTION_PROFILE);

        expect(toolIds).toContain('remote-command');
        expect(toolIds).toContain('managed-app');
        expect(toolIds).toContain('remote-cli-agent');
        expect(toolIds).toContain('k3s-deploy');
        expect(toolIds).toContain('git-safe');
        expect(toolIds).toContain('tool-doc-read');
        expect(toolIds).toContain('web-search');
        expect(toolIds).toContain('web-fetch');
        expect(toolIds).toContain('web-scrape');
        expect(toolIds).toContain('design-resource-search');
        expect(toolIds).toContain('code-sandbox');
        expect(toolIds).not.toContain('opencode-run');
        expect(toolIds).not.toContain('code-execute');
        expect(HIDDEN_FRONTEND_TOOL_IDS).toContain('code-execute');
    });

    test('podcast profiles expose research and media tools without remote execution', () => {
        const podcastToolIds = getAllowedToolIdsForProfile(PODCAST_EXECUTION_PROFILE);
        const podcastVideoToolIds = getAllowedToolIdsForProfile(PODCAST_VIDEO_EXECUTION_PROFILE);

        for (const toolIds of [podcastToolIds, podcastVideoToolIds]) {
            expect(toolIds).toEqual(expect.arrayContaining([
                'web-search',
                'web-fetch',
                'web-scrape',
                'image-generate',
                'asset-search',
                'research-bucket-search',
                'public-source-search',
            ]));
            expect(toolIds).not.toContain('remote-command');
            expect(toolIds).not.toContain('remote-cli-agent');
            expect(toolIds).not.toContain('k3s-deploy');
            expect(toolIds).not.toContain('code-sandbox');
        }
    });
});
