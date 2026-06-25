const {
    buildCompactToolRegistryContext,
    collectCandidateToolIds,
} = require('./agent-directed-runtime');

describe('agent-directed-runtime', () => {
    test('collects direct and user-selected tool hints for compact registry context', () => {
        const metadata = {
            directToolId: 'web-fetch',
            plannedTools: 'web-search',
            requestFrame: {
                userSelectedToolIds: ['web-scrape', 'docker-exec'],
            },
            tools: [{ toolId: 'tool-doc-read' }],
        };

        expect(collectCandidateToolIds({ metadata })).toEqual([
            'web-fetch',
            'web-search',
            'web-scrape',
            'tool-doc-read',
        ]);
    });

    test('builds compact registry entries from frontend-selected tools', () => {
        const toolManager = {
            getTool: jest.fn((toolId) => ({
                id: toolId,
                description: `${toolId} description`,
            })),
            getToolReadinessSummary: jest.fn(() => [{ status: 'ready' }]),
        };

        const context = buildCompactToolRegistryContext({
            toolManager,
            metadata: {
                requestFrame: {
                    directToolId: 'web-fetch',
                    userSelectedToolIds: ['web-scrape'],
                },
            },
        });

        expect(context).toContain('- web-fetch: web-fetch description readiness=ready');
        expect(context).toContain('- web-scrape: web-scrape description readiness=ready');
        expect(context).toContain('Use these as hints, not a script.');
    });
});
