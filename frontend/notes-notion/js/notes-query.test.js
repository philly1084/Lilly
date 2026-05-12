const NotesQuery = require('./notes-query');

function samplePage() {
    return {
        id: 'page-1',
        title: 'Launch Notes',
        icon: 'note',
        updatedAt: 1710000000000,
        blocks: [
            {
                id: 'h1',
                type: 'heading_1',
                content: 'Launch Plan',
                color: null,
                textColor: null,
                children: [],
            },
            {
                id: 'intro',
                type: 'text',
                content: 'The launch needs a careful review before Friday.',
                color: null,
                textColor: null,
                children: [],
            },
            {
                id: 'risks',
                type: 'heading_2',
                content: 'Risks',
                color: null,
                textColor: 'red',
                children: [],
            },
            {
                id: 'risk-body',
                type: 'callout',
                content: { text: 'Budget approval is the main blocker.', icon: '!' },
                color: 'yellow',
                textColor: null,
                children: [],
            },
            {
                id: 'tasks',
                type: 'heading_2',
                content: 'Tasks',
                color: null,
                textColor: null,
                children: [
                    {
                        id: 'task-1',
                        type: 'todo',
                        content: { text: 'Send release notes', checked: false },
                        color: null,
                        textColor: null,
                        children: [],
                    },
                ],
            },
        ],
    };
}

describe('NotesQuery', () => {
    test('builds agent page context with section metadata', () => {
        const context = NotesQuery.buildPageContext(samplePage());

        expect(context.blockCount).toBe(6);
        expect(context.outline.map((heading) => heading.id)).toEqual(['h1', 'risks', 'tasks']);
        expect(context.blocks.find((block) => block.id === 'risk-body')).toEqual(expect.objectContaining({
            sectionHeadingId: 'risks',
            sectionHeadingText: 'Risks',
            color: 'yellow',
            content: 'Budget approval is the main blocker.',
        }));
    });

    test('greps by word, type, section, and color filters', () => {
        const page = samplePage();

        expect(NotesQuery.grep(page, 'budget').map((entry) => entry.id)).toEqual(['risk-body']);
        expect(NotesQuery.grep(page, 'type:heading_2').map((entry) => entry.id)).toEqual(['risks', 'tasks']);
        expect(NotesQuery.grep(page, 'section:Risks').map((entry) => entry.id)).toEqual(['risks', 'risk-body']);
        expect(NotesQuery.grep(page, 'color:yellow').map((entry) => entry.id)).toEqual(['risk-body']);
    });

    test('creates style and flat text projections without raw block objects', () => {
        const page = samplePage();
        const styles = NotesQuery.createProjection(page, { mode: 'styles' });
        const flatText = NotesQuery.createProjection(page, { mode: 'flat_text' });

        expect(styles.find((entry) => entry.id === 'risks')).toEqual(expect.objectContaining({
            type: 'heading_2',
            textColor: 'red',
        }));
        expect(styles[0]).not.toHaveProperty('source');
        expect(flatText).toContain('Launch Plan');
        expect(flatText).toContain('Send release notes');
    });

    test('plans bulk heading type and color updates as ordinary notes actions', () => {
        const page = samplePage();

        expect(NotesQuery.createHeadingLevelActions(page, 2, 3)).toEqual([
            expect.objectContaining({ op: 'update_block', blockId: 'risks', type: 'heading_3', content: 'Risks' }),
            expect.objectContaining({ op: 'update_block', blockId: 'tasks', type: 'heading_3', content: 'Tasks' }),
        ]);

        expect(NotesQuery.createHeaderColorActions(page, { textColor: 'blue' })).toEqual([
            expect.objectContaining({ blockId: 'h1', textColor: 'blue' }),
            expect.objectContaining({ blockId: 'risks', textColor: 'blue' }),
            expect.objectContaining({ blockId: 'tasks', textColor: 'blue' }),
        ]);
        expect(NotesQuery.createHeaderColorActions(page, { textColor: 'blue' })[0]).not.toHaveProperty('content');
    });
});
