const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAgent(overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
    const windowObject = {
        location: { origin: 'http://localhost:3000' },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
        ImportExport: {
            importFromMarkdown: jest.fn(() => null),
        },
        ...overrides,
    };

    const context = {
        window: windowObject,
        document: {
            readyState: 'loading',
            addEventListener: jest.fn(),
            querySelector: jest.fn(() => null),
            querySelectorAll: jest.fn(() => []),
        },
        localStorage: {
            getItem: jest.fn(() => null),
            setItem: jest.fn(),
            removeItem: jest.fn(),
        },
        console,
        URL,
        setTimeout,
        clearTimeout,
        CustomEvent: function CustomEvent(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        },
        fetch: jest.fn(),
        Blocks: windowObject.Blocks || {
            createBlock: jest.fn((type, content, options = {}) => ({
                id: `generated_${Math.random().toString(36).slice(2)}`,
                type,
                content,
                children: options.children || [],
                formatting: options.formatting || {},
                color: options.color || null,
                textColor: options.textColor || null,
                fontFamily: options.fontFamily || null,
                fontSize: options.fontSize || null,
                icon: options.icon,
            })),
        },
    };

    context.global = context;
    context.globalThis = context;

    vm.runInNewContext(source, context, { filename: 'agent.js' });
    return context.window.Agent;
}

describe('notes agent parsing', () => {
    test('normalizes legacy notes-actions replace-content payloads into rebuild_page actions', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            'notes-actions': [
                {
                    action: 'replace-content',
                    content: '# Paris: A Little City of Art\n\n![Paris art hero](https://images.unsplash.com/photo-12345)',
                },
            ],
        });

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.actions).toHaveLength(1);
        expect(parsed.actions[0].op).toBe('rebuild_page');
        expect(parsed.actions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: 'Paris: A Little City of Art' }),
            expect.objectContaining({
                type: 'ai_image',
                content: expect.objectContaining({
                    imageUrl: 'https://images.unsplash.com/photo-12345',
                    source: 'unsplash',
                }),
            }),
        ]));
    });

    test('recovers shorthand direct block payloads for ai_image blocks', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify([
            {
                type: 'ai_image',
                prompt: 'Paris watercolor street scene',
                imageUrl: 'https://images.unsplash.com/photo-98765',
                source: 'unsplash',
            },
            {
                type: 'text',
                text: 'A soft Paris street scene for the page hero.',
            },
        ]);

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.actions).toHaveLength(1);
        expect(parsed.actions[0].op).toBe('append_to_page');
        expect(parsed.actions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'ai_image',
                prompt: 'Paris watercolor street scene',
                imageUrl: 'https://images.unsplash.com/photo-98765',
            }),
            expect.objectContaining({
                type: 'text',
                text: 'A soft Paris street scene for the page hero.',
            }),
        ]));
    });

    test('rebuilds the page from assistant reply plus top-level markdown content when actions are omitted', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            assistant_reply: 'I turned this into a page draft.',
            content: '# Paris Art Guide\n\n![Paris hero](https://images.unsplash.com/photo-44444)\n\nMontmartre is still one of the city\'s best-known art neighborhoods.',
        });

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('I turned this into a page draft.');
        expect(parsed.actions).toHaveLength(1);
        expect(parsed.actions[0].op).toBe('rebuild_page');
        expect(parsed.actions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: 'Paris Art Guide' }),
            expect.objectContaining({
                type: 'ai_image',
                content: expect.objectContaining({
                    imageUrl: 'https://images.unsplash.com/photo-44444',
                    source: 'unsplash',
                }),
            }),
            expect.objectContaining({
                type: 'text',
                content: 'Montmartre is still one of the city\'s best-known art neighborhoods.',
            }),
        ]));
    });

    test('turns Unsplash photo-page links into pending ai_image blocks instead of broken image embeds', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            assistant_reply: 'Added a penguin visual.',
            content: '# Penguins\n\n![Penguins during daytime](https://unsplash.com/photos/penguins-during-daytime-_FRAYdYmQCM)',
        });

        const parsed = agent._extractNotesActionPlan(responseText);
        const imageBlock = parsed.actions[0].blocks.find((block) => block.type === 'ai_image');

        expect(imageBlock).toEqual(expect.objectContaining({
            type: 'ai_image',
            content: expect.objectContaining({
                imageUrl: null,
                status: 'pending',
                source: 'unsplash',
                downloadUrl: 'https://unsplash.com/photos/penguins-during-daytime-_FRAYdYmQCM',
            }),
        }));
    });

    test('unwraps nested assistant content arrays and stringified output_text payloads', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            role: 'assistant',
            content: [
                {
                    type: 'think',
                    think: 'Internal reasoning that should stay hidden.',
                    encrypted: null,
                },
                {
                    type: 'text',
                    text: JSON.stringify({
                        output_text: 'Hey there! How can I help you today?',
                        finish_reason: 'stop',
                    }),
                },
            ],
        });

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Hey there! How can I help you today?');
        expect(parsed.actions).toEqual([]);
    });

    test('unwraps raw function payloads into visible assistant text instead of showing the tool wrapper', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            type: 'function',
            name: 'update_notes_page',
            parameters: {
                notes_page_update: 'It is going well, thanks for asking. How can I help?'
            }
        });

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('It is going well, thanks for asking. How can I help?');
        expect(parsed.actions).toEqual([]);
    });

    test('suppresses placeholder-only assistant replies', () => {
        const agent = loadAgent();
        const responseText = '<assistant reply>';

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('');
        expect(parsed.actions).toEqual([]);
    });

    test('suppresses leaked internal notes planning scaffolds instead of showing them in chat', () => {
        const agent = loadAgent();
        const responseText = `Original request:
read the different block options and build this page to cool

Interpret "page" as the current notes page shown in this editor.

Approved page plan:
{
  "title": "Cool Page",
  "sections": [
    { "heading": "Intro", "goal": "Open strong", "blockTypes": ["heading_1", "text"] }
  ]
}`;

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('');
        expect(parsed.actions).toEqual([]);
    });

    test('strips Kimi DSML tool-call markup from visible assistant text', () => {
        const agent = loadAgent();
        const responseText = [
            'Let me gather current info on recursive training with the OpenAI Agents SDK before building the page.',
            '<｜DSML｜tool_calls>',
            '<｜DSML｜invoke name="web-search">',
            '<｜DSML｜parameter name="query" string="true">recursive training OpenAI Agents SDK 2025 2026 patterns</｜DSML｜parameter>',
            '</｜DSML｜invoke>',
            '</｜DSML｜tool_calls>',
        ].join(' ');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Let me gather current info on recursive training with the OpenAI Agents SDK before building the page.');
        expect(parsed.displayText).not.toContain('DSML');
        expect(parsed.displayText).not.toContain('web-search');
        expect(parsed.actions).toEqual([]);
    });

    test('strips orphan DSML invoke markup from visible assistant text', () => {
        const agent = loadAgent();
        const responseText = [
            'I will look up the current source first.',
            '<｜DSML｜invoke name="web-fetch">',
            '<｜DSML｜parameter name="url" string="true">https://example.com</｜DSML｜parameter>',
            '</｜DSML｜invoke>',
        ].join(' ');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('I will look up the current source first.');
        expect(parsed.displayText).not.toContain('DSML');
        expect(parsed.displayText).not.toContain('web-fetch');
        expect(parsed.actions).toEqual([]);
    });

    test('suppresses raw notes action JSON instead of exposing block operation markup', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            assistant_reply: '<assistant reply>',
            actions: [
                {
                    op: 'append_to_page',
                    blocks: [
                        { type: 'heading_2', content: 'Clean Section' },
                    ],
                },
            ],
        });

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('');
        expect(parsed.actions).toHaveLength(1);
    });

    test('parses malformed kimi-style notes-actions fences and spaced keys', () => {
        const agent = loadAgent();
        const responseText = [
            '``` notes -actions',
            '{',
            '  " assistant _reply ": "Built a richer pig page.",',
            '  " actions ": [',
            '    {',
            '      " action ": " replace _content ",',
            '      " content ": "# Pigs\\n\\n## Quick Facts\\nPigs are smart, social mammals with strong memories."',
            '    }',
            '  ]',
            '}',
            '```',
        ].join('\n');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Built a richer pig page.');
        expect(parsed.actions).toHaveLength(1);
        expect(parsed.actions[0].op).toBe('rebuild_page');
        expect(parsed.actions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: 'Pigs' }),
            expect.objectContaining({ type: 'heading_2', content: 'Quick Facts' }),
            expect.objectContaining({
                type: 'text',
                content: 'Pigs are smart, social mammals with strong memories.',
            }),
        ]));
    });

    test('repairs notes-actions payloads missing their outer object braces', () => {
        const agent = loadAgent();
        const responseText = [
            '"assistant_reply":"Built the Halifax weekend guide.",',
            '"actions":[',
            '  {"op":"update_page","title":"Halifax Weekend Fun - May 2026","icon":"wave"},',
            '  {"op":"rebuild_page","blocks":[',
            '    {"type":"heading_1","content":"Halifax Weekend Fun - May 2026","color":"blue_background","textColor":"blue"},',
            '    {"type":"callout","content":"A weekend and evening planner for Halifax, Nova Scotia this May.","icon":"wave","color":"blue_background","textColor":"blue"},',
            '    {"type":"database","content":"Best Weekend and Evening Ideas","columns":["Plan Type","Best For"],"rows":[["Waterfront Night","Low-cost evening"],["Arts and Exhibitions","Rainy day"]]}',
            '  ]}',
            ']',
        ].join('\n');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Built the Halifax weekend guide.');
        expect(parsed.actions).toHaveLength(2);
        expect(parsed.actions[0]).toEqual(expect.objectContaining({
            op: 'update_page',
            title: 'Halifax Weekend Fun - May 2026',
        }));
        expect(parsed.actions[1]).toEqual(expect.objectContaining({
            op: 'rebuild_page',
        }));
        expect(parsed.actions[1].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: 'Halifax Weekend Fun - May 2026' }),
            expect.objectContaining({
                type: 'database',
                content: 'Best Weekend and Evening Ideas',
                columns: ['Plan Type', 'Best For'],
                rows: [['Waterfront Night', 'Low-cost evening'], ['Arts and Exhibitions', 'Rainy day']],
            }),
        ]));
    });

    test('applies database and chart blocks with structured data intact', () => {
        jest.useFakeTimers();
        const editor = {
            getCurrentPage: jest.fn(() => ({ id: 'page_a', blocks: [{ id: 'block_a', type: 'text', content: 'Anchor' }] })),
            importBlocks: jest.fn((blocks) => blocks),
            insertBlocksAfter: jest.fn((blockId, blocks) => blocks),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });

        agent._applyNotesActions([
            {
                op: 'rebuild_page',
                blocks: [
                    {
                        type: 'database',
                        content: 'Best Weekend and Evening Ideas',
                        columns: ['Plan Type', 'Best For'],
                        rows: [['Waterfront Night', 'Low-cost evening'], ['Arts and Exhibitions', 'Rainy day']],
                    },
                ],
            },
            {
                op: 'append_to_page',
                blocks: [
                    {
                        type: 'bar_chart',
                        title: 'Weekly Leads',
                        labels: ['Mon', 'Tue', 'Wed'],
                        values: [4, 7, 5],
                        unit: '',
                    },
                ],
            },
        ]);

        expect(editor.importBlocks).toHaveBeenCalledWith([
            expect.objectContaining({
                type: 'database',
                content: expect.objectContaining({
                    columns: ['Plan Type', 'Best For'],
                    rows: [['Waterfront Night', 'Low-cost evening'], ['Arts and Exhibitions', 'Rainy day']],
                }),
            }),
        ], { replace: true });
        expect(editor.insertBlocksAfter).toHaveBeenCalledWith('block_a', [
            expect.objectContaining({
                type: 'chart',
                content: expect.objectContaining({
                    title: 'Weekly Leads',
                    chartType: 'bar',
                    labels: ['Mon', 'Tue', 'Wed'],
                    values: [4, 7, 5],
                }),
            }),
        ]);
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('repairs notes-actions payloads that start with a bare reply string', () => {
        const agent = loadAgent();
        const responseText = [
            '"Halifax weekend and evening guide using verified Halifax, Nova Scotia event research.",',
            '"actions":[',
            '  {"op":"update_page","title":"Halifax Weekend Fun - May 2026"},',
            '  {"op":"rebuild_page","blocks":[{"type":"heading_1","content":"Halifax Weekend Fun - May 2026"}]}',
            ']',
        ].join('\n');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Halifax weekend and evening guide using verified Halifax, Nova Scotia event research.');
        expect(parsed.actions).toHaveLength(2);
        expect(parsed.actions[1].blocks).toEqual([
            expect.objectContaining({ type: 'heading_1', content: 'Halifax Weekend Fun - May 2026' }),
        ]);
    });

    test('repairs spaced notes-actions with raw newlines inside strings and missing key quotes', () => {
        const agent = loadAgent();
        const responseText = [
            '``` notes -actions',
            '{',
            '  " assistant _reply ": "Built the Halifax after-work guide.",',
            '  " actions ": [',
            '    { " op ": " update_page ", " title ": " After - Work Guide : 3 Months ", " icon ": "anchor" },',
            '    { " op ": " re build _page ", " blocks ": [',
            '      { " type ": " call out ", " text ": "A detailed planner for 3 months." },',
            '      { " type ": " heading _ 1 ", " text ": "Where to Explore" },',
            '      { " type ": " toggle ", " text ": "Casual, Pub & Share',
            '- Style", " children ": [',
            '        { " type ": " bul leted _list ", text ": "Good Robot Brewing Co. - North End favourite." }',
            '      ] }',
            '    ] }',
            '  ]',
            '}',
            '```',
        ].join('\n');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Built the Halifax after-work guide.');
        expect(parsed.actions).toHaveLength(2);
        expect(parsed.actions[1]).toEqual(expect.objectContaining({ op: 'rebuild_page' }));
        const normalized = agent._normalizeStructuredPageActions(parsed.actions, 'Build a Halifax after-work guide.', {
            blockCount: 0,
            outline: [],
            blocks: [],
        });
        expect(normalized[1].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'callout' }),
            expect.objectContaining({ type: 'heading_1', content: 'Where to Explore' }),
            expect.objectContaining({
                type: 'toggle',
                children: expect.arrayContaining([
                    expect.objectContaining({ type: 'bulleted_list' }),
                ]),
            }),
        ]));
    });

    test('does not salvage a one-word inner block fragment from a broken structured payload', () => {
        const agent = loadAgent();
        const responseText = [
            '``` notes -actions',
            '{',
            '  " assistant _reply ": "Built a fresh pig page.",',
            '  " actions ": [',
            '    { " type ": " heading _2 ", " content ": " FACT " }',
            '  ]',
            '```',
        ].join('\n');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('');
        expect(parsed.actions).toEqual([]);
        expect(parsed.parseFailed).toBe(true);
    });

    test('strips null bytes from wrapped function payload text', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            type: 'function',
            name: 'update_notes_page',
            parameters: {
                notes_page_update: 'Hello\u0000 world'
            }
        });

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.displayText).toBe('Hello world');
        expect(parsed.actions).toEqual([]);
    });

    test('treats explicit website review prompts as non-page runtime work', () => {
        const agent = loadAgent();
        const question = 'Can you continue to look over the site https://bicyclethief.ca and continue researching what is new?';
        const context = {
            blockCount: 8,
            outline: [{ id: 'h1' }],
        };

        expect(agent._hasNonPageRuntimeIntent(question, {})).toBe(true);
        expect(agent._shouldForcePageEditActions(question, context, {})).toBe(false);
    });

    test('still forces page actions for direct current-page writing requests', () => {
        const agent = loadAgent();
        const question = 'Continue this page and turn it into a cleaner summary with better structure.';
        const context = {
            blockCount: 8,
            outline: [{ id: 'h1' }],
        };

        expect(agent._hasNonPageRuntimeIntent(question, {})).toBe(false);
        expect(agent._shouldForcePageEditActions(question, context, {})).toBe(true);
    });

    test('classifies substantial notes requests as Symphony page drafts with page design context', () => {
        const agent = loadAgent();
        const understanding = agent._buildRequestUnderstanding(
            'Build this page into a polished research brief with better section flow and sources.',
            {
                title: 'Penguin Notes',
                blockCount: 8,
                outline: [{ id: 'h1', content: 'Penguins' }, { id: 'h2', content: 'Habitat' }],
                blocks: [
                    { id: 'b1', type: 'heading_1', content: 'Penguin Notes' },
                    { id: 'b2', type: 'text', content: 'Penguins are strong swimmers.' },
                ],
            },
            {},
        );

        expect(understanding.route).toBe('symphony_page_draft');
        expect(understanding.label).toBe('Symphony page draft');
        expect(understanding.template.name).toBe('Research Page');
        expect(understanding.layout.name).toBe('Research Hub');
        expect(understanding.signals).toEqual(expect.arrayContaining([
            'multi-pass page build',
            'notes-actions likely',
        ]));
    });

    test('does not route explicit website review requests into notes Symphony drafts', () => {
        const agent = loadAgent();
        const understanding = agent._buildRequestUnderstanding(
            'Review this website https://example.com and tell me what changed.',
            {
                blockCount: 8,
                outline: [{ id: 'h1', content: 'Site Notes' }],
            },
            {},
        );

        expect(understanding.route).toBe('external_runtime');
        expect(understanding.strategy).toContain('Do not force notes-actions');
    });

    test('keeps research-backed page builds on the notes page-edit path', () => {
        const agent = loadAgent();
        const question = 'Create a research brief about penguins with sources and key findings.';
        const context = {
            blockCount: 5,
            outline: [{ id: 'h1' }],
        };

        expect(agent._hasNonPageRuntimeIntent(question, {})).toBe(false);
        expect(agent._shouldForcePageEditActions(question, context, {})).toBe(true);
    });

    test('includes page content and design criteria in the system prompt', () => {
        const agent = loadAgent();
        const prompt = agent._buildSystemPrompt({
            title: 'Penguin Notes',
            pageId: 'page_penguins',
            blockCount: 5,
            wordCount: 180,
            readingTime: 1,
            defaultModel: 'gpt-4o',
            properties: [],
            lastUpdated: '2026-04-05T10:00:00.000Z',
            outline: [
                { id: 'block_h1', content: 'Overview' },
            ],
            blocks: [
                { id: 'block_1', type: 'heading_1', content: 'Penguin Notes', depth: 0 },
                { id: 'block_2', type: 'text', content: 'Penguins are flightless birds adapted to life in cold oceans.', depth: 0 },
                { id: 'block_3', type: 'heading_2', content: 'Overview', depth: 0 },
                { id: 'block_4', type: 'text', content: 'They swim efficiently and live in large colonies.', depth: 0 },
                { id: 'block_5', type: 'text', content: 'Their diet includes fish, squid, and krill.', depth: 0 },
            ],
        }, {
            question: 'Create a research brief about penguins with sources and key findings.',
        });

        expect(prompt).toContain('CURRENT PAGE CONTENT (excerpt):');
        expect(prompt).toContain('ROUTING PRIORITY:');
        expect(prompt).toContain('SYMPHONY REQUEST UNDERSTANDING:');
        expect(prompt).toContain('Route: Symphony page draft [symphony_page_draft]');
        expect(prompt).toContain('Indexed layout: #3 Research Hub');
        expect(prompt).toContain('PAGE DESIGN CRITERIA:');
        expect(prompt).toContain('SECTION EDIT MAP:');
        expect(prompt).toContain('PAGE EDIT WORKFLOW:');
        expect(prompt).toContain('EDIT RESPONSE PATTERNS:');
        expect(prompt).toContain('CURRENT VISUAL ANCHORS:');
        expect(prompt).toContain('BEST-FIT PAGE TEMPLATES:');
        expect(prompt).toContain('VISUAL PAGE RECIPES:');
        expect(prompt).toContain('DESIGN SCHEMES:');
        expect(prompt).toContain('LIVE BLOCK DESIGN PATTERNS:');
        expect(prompt).toContain('PAGE DESIGN MANUAL:');
        expect(prompt).toContain('BLOCK OPPORTUNITIES FOR THIS REQUEST:');
        expect(prompt).toContain('TEMPLATE EXECUTION CHECKLIST:');
        expect(prompt).toContain('VISUAL DESIGN CHECKLIST:');
        expect(prompt).toContain('DESIGN SCHEME CHECKLIST:');
        expect(prompt).toContain('BLOCK PATTERN CHECKLIST:');
        expect(prompt).toContain('Top-level flow');
        expect(prompt).toContain('Do not return a single giant text block');
        expect(prompt).toContain('Think in page roles, not just paragraphs');
        expect(prompt).toContain('Treat style as part of the page system');
        expect(prompt).toContain('Editorial Explainer [editorial-explainer]');
        expect(prompt).toContain('Cool Knowledge [cool-knowledge]');
        expect(prompt).toContain('Research Evidence Ladder [research-evidence-ladder]');
        expect(prompt).toContain('Avoid more than two plain text blocks in a row');
        expect(prompt).toContain('Lead focal blocks');
        expect(prompt).toContain('prefer notes-actions that update the page blocks instead of artifact, file, or export output');
        expect(prompt).toContain('VALID OPERATIONS:');
        expect(prompt).toContain('replace_section');
        expect(prompt).toContain('move_section');
        expect(prompt).toContain('insert_after_section');
        expect(prompt).toContain('delete_section');
        expect(prompt).toContain('heading-based chunks');
        expect(prompt).toContain('from its heading down');
        expect(prompt).toContain('BLOCK TYPES:');
        expect(prompt).toContain('BLOCK DESIGN HEURISTICS:');
        expect(prompt).toContain('Recommended metadata: Evidence: Source-linked');
        expect(prompt).not.toContain('Recommended metadata: Type: Research');
        expect(prompt).not.toContain('Audience: General reader');
        expect(prompt).not.toContain('Mode: Knowledge hub');
        expect(prompt).toContain('Required palette: callout + hero image/ai_image + bookmark source cluster + toggle for deep detail');
        expect(prompt).toContain('Executive Brief [brief]');
        expect(prompt).toContain('Research Page [research]');
        expect(prompt).toContain('think in three silent passes');
    });

    test('expands section replacement text into native block definitions', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'replace_section',
                headingBlockId: 'heading_1',
                blocks: [{
                    type: 'text',
                    content: '## Evidence\nPenguins are strong swimmers.\n\n- Dense feathers\n- Streamlined bodies',
                }],
            },
        ], 'Rewrite this section with cleaner structure.', {
            blockCount: 8,
            outline: [{ id: 'heading_1', content: 'Evidence' }],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].op).toBe('replace_section');
        expect(normalizedActions[0].headingBlockId).toBe('heading_1');
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_2', content: 'Evidence' }),
            expect.objectContaining({ type: 'text', content: 'Penguins are strong swimmers.' }),
            expect.objectContaining({ type: 'bulleted_list', content: 'Dense feathers' }),
        ]));
    });

    test('applies section-level actions through editor section APIs', () => {
        jest.useFakeTimers();
        const editor = {
            replaceSectionFromHeading: jest.fn(() => [{ id: 'new_heading' }]),
            insertBlocksAfterSection: jest.fn(() => [{ id: 'inserted' }]),
            moveSection: jest.fn(() => true),
            deleteSectionFromHeading: jest.fn(() => true),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });

        const result = agent._applyNotesActions([
            {
                op: 'replace_section',
                headingBlockId: 'heading_a',
                blocks: [{ type: 'heading_2', content: 'Updated' }],
            },
            {
                op: 'insert_after_section',
                headingBlockId: 'heading_a',
                blocks: [{ type: 'text', content: 'Follow-up' }],
            },
            {
                op: 'move_section',
                headingBlockId: 'heading_a',
                targetHeadingBlockId: 'heading_b',
                position: 'before',
            },
            {
                op: 'delete_section',
                headingBlockId: 'heading_old',
            },
        ]);

        expect(result.appliedCount).toBe(4);
        expect(editor.replaceSectionFromHeading).toHaveBeenCalledWith('heading_a', expect.arrayContaining([
            expect.objectContaining({ type: 'heading_2', content: 'Updated' }),
        ]));
        expect(editor.insertBlocksAfterSection).toHaveBeenCalledWith('heading_a', expect.arrayContaining([
            expect.objectContaining({ type: 'text', content: 'Follow-up' }),
        ]));
        expect(editor.moveSection).toHaveBeenCalledWith('heading_a', 'heading_b', 'before');
        expect(editor.deleteSectionFromHeading).toHaveBeenCalledWith('heading_old');
        expect(editor.savePage).toHaveBeenCalled();
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('parses natural section-slice aliases for multi-round notes edits', () => {
        const agent = loadAgent();
        const responseText = [
            '```notes-actions',
            '{',
            '  "assistant_reply": "Done",',
            '  "actions": [',
            '    { "op": "insert between sections", "after heading block id": "heading_a", "before heading block id": "heading_b", "blocks": [{ "type": "heading_2", "content": "New Middle Section" }] },',
            '    { "op": "insert here", "block id": "block_c", "position": "before", "blocks": [{ "type": "text", "content": "Inserted at the local cursor." }] },',
            '    { "op": "delete here", "heading block id": "heading_old", "scope": "section" }',
            '  ]',
            '}',
            '```',
        ].join('\n');

        const parsed = agent._extractNotesActionPlan(responseText);

        expect(parsed.actions).toEqual([
            expect.objectContaining({
                op: 'insert_between_sections',
                afterHeadingBlockId: 'heading_a',
                beforeHeadingBlockId: 'heading_b',
            }),
            expect.objectContaining({
                op: 'insert_here',
                blockId: 'block_c',
                position: 'before',
            }),
            expect.objectContaining({
                op: 'delete_here',
                headingBlockId: 'heading_old',
                scope: 'section',
            }),
        ]);
    });

    test('applies section-slice aliases without rebuilding the page', () => {
        jest.useFakeTimers();
        const editor = {
            insertBlocksAfterSection: jest.fn(() => [{ id: 'middle_heading' }]),
            insertBlocksBefore: jest.fn(() => [{ id: 'local_insert' }]),
            deleteSectionFromHeading: jest.fn(() => true),
            importBlocks: jest.fn(() => [{ id: 'should_not_use' }]),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });

        const result = agent._applyNotesActions([
            {
                op: 'insert_between_sections',
                afterHeadingBlockId: 'heading_a',
                beforeHeadingBlockId: 'heading_b',
                blocks: [{ type: 'heading_2', content: 'New Middle Section' }],
            },
            {
                op: 'insert_here',
                blockId: 'block_c',
                position: 'before',
                blocks: [{ type: 'text', content: 'Inserted at the local cursor.' }],
            },
            {
                op: 'delete_here',
                headingBlockId: 'heading_old',
                scope: 'section',
            },
        ]);

        expect(result.appliedCount).toBe(3);
        expect(editor.insertBlocksAfterSection).toHaveBeenCalledWith('heading_a', expect.arrayContaining([
            expect.objectContaining({ type: 'heading_2', content: 'New Middle Section' }),
        ]));
        expect(editor.insertBlocksBefore).toHaveBeenCalledWith('block_c', expect.arrayContaining([
            expect.objectContaining({ type: 'text', content: 'Inserted at the local cursor.' }),
        ]));
        expect(editor.deleteSectionFromHeading).toHaveBeenCalledWith('heading_old');
        expect(editor.importBlocks).not.toHaveBeenCalled();
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('keeps block identity when changing a block type in place', () => {
        jest.useFakeTimers();
        const blocks = {
            block_a: {
                id: 'block_a',
                type: 'text',
                content: 'Keep this wording but make it a callout.',
                children: [],
                formatting: {},
            },
        };
        const editor = {
            getBlock: jest.fn((blockId) => blocks[blockId]),
            updateBlockFields: jest.fn((blockId, updates) => {
                blocks[blockId] = { ...blocks[blockId], ...updates, id: blockId };
                return blocks[blockId];
            }),
            replaceBlockWithBlocks: jest.fn(() => [{ id: 'fresh_id' }]),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });

        const result = agent._applyNotesActions([
            {
                op: 'change_block_type',
                blockId: 'block_a',
                type: 'callout',
            },
        ]);

        expect(result.appliedCount).toBe(1);
        expect(editor.updateBlockFields).toHaveBeenCalledWith('block_a', expect.objectContaining({
            id: 'block_a',
            type: 'callout',
            content: expect.objectContaining({
                text: 'Keep this wording but make it a callout.',
            }),
        }));
        expect(editor.replaceBlockWithBlocks).not.toHaveBeenCalled();
        expect(blocks.block_a.id).toBe('block_a');
        expect(blocks.block_a.type).toBe('callout');
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('applies agent block appearance aliases through the same update path as manual styling', () => {
        jest.useFakeTimers();
        const blocks = {
            block_a: {
                id: 'block_a',
                type: 'text',
                content: 'Make this feel like a designed note.',
                children: [],
                formatting: {},
                color: null,
                textColor: null,
                fontFamily: null,
                fontSize: null,
            },
        };
        const editor = {
            getBlock: jest.fn((blockId) => blocks[blockId]),
            updateBlockFields: jest.fn((blockId, updates) => {
                blocks[blockId] = { ...blocks[blockId], ...updates, id: blockId };
                return blocks[blockId];
            }),
            replaceBlockWithBlocks: jest.fn(() => [{ id: 'fresh_id' }]),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });
        const parsed = agent._extractNotesActionPlan(JSON.stringify({
            actions: [
                {
                    op: 'update_block',
                    block_id: 'block_a',
                    content: 'Make this feel like a designed note.',
                    color: 'blue_background',
                    text_color: 'green text',
                    font_family: 'Georgia',
                    font_size: 'extra large',
                },
            ],
        }));

        const result = agent._applyNotesActions(parsed.actions);

        expect(result.appliedCount).toBe(1);
        expect(editor.updateBlockFields).toHaveBeenCalledWith('block_a', expect.objectContaining({
            id: 'block_a',
            color: 'blue',
            textColor: 'green',
            fontFamily: 'serif',
            fontSize: 'xlarge',
        }));
        expect(editor.replaceBlockWithBlocks).not.toHaveBeenCalled();
        expect(blocks.block_a).toEqual(expect.objectContaining({
            color: 'blue',
            textColor: 'green',
            fontFamily: 'serif',
            fontSize: 'xlarge',
        }));
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('does not rebuild an existing page for second-round additional content fallback', () => {
        const editor = {
            getCurrentPage: jest.fn(() => ({
                id: 'page_existing',
                title: 'Launch Notes',
                blocks: [
                    { id: 'h1', type: 'heading_1', content: 'Launch Notes' },
                    { id: 'intro', type: 'text', content: 'Existing intro stays.' },
                    { id: 'h2', type: 'heading_2', content: 'Timeline' },
                    { id: 'timeline', type: 'text', content: 'Existing timeline stays.' },
                ],
            })),
        };
        const agent = loadAgent({ Editor: editor });

        const actions = agent._buildFallbackNotesActionsFromText(
            'Add additional risks and mitigation content to the page.',
            '# Risks\n\n## Mitigations\n- Add rollout owner\n- Add fallback window\n- Add monitoring check',
            {
                blockCount: 4,
                outline: [{ id: 'h1', content: 'Launch Notes' }, { id: 'h2', content: 'Timeline' }],
            }
        );

        expect(actions).toHaveLength(1);
        expect(actions[0].op).toBe('append_to_page');
        expect(actions[0].op).not.toBe('rebuild_page');
    });

    test('applies exact text replacement and highlight actions without rebuilding a whole page', () => {
        jest.useFakeTimers();
        const blocks = {
            block_a: {
                id: 'block_a',
                type: 'text',
                content: 'The launch date is Monday. Keep this line important.',
                children: [],
                formatting: {},
            },
        };
        const editor = {
            getBlock: jest.fn((blockId) => blocks[blockId]),
            replaceBlockWithBlocks: jest.fn((blockId, replacements) => {
                blocks[blockId] = replacements[0];
                return replacements;
            }),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });

        const result = agent._applyNotesActions([
            {
                op: 'replace_text',
                blockId: 'block_a',
                findText: 'Monday',
                replaceWith: 'Tuesday',
            },
            {
                op: 'highlight_text',
                blockId: 'block_a',
                text: 'important',
                color: 'yellow',
            },
        ]);

        expect(result.appliedCount).toBe(2);
        expect(blocks.block_a.content).toBe('The launch date is Tuesday. Keep this line important.');
        expect(blocks.block_a.formatting.highlights).toEqual(expect.arrayContaining([
            expect.objectContaining({ text: 'important', color: 'yellow' }),
        ]));
        expect(editor.replaceBlockWithBlocks).toHaveBeenCalledTimes(2);
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('only reports page rebuild actions when imported blocks are actually applied', () => {
        jest.useFakeTimers();
        const editor = {
            getCurrentPage: jest.fn(() => ({ id: 'page_a', blocks: [] })),
            importBlocks: jest.fn(() => []),
            savePage: jest.fn(),
            focusBlock: jest.fn(),
        };
        const agent = loadAgent({ Editor: editor });

        const result = agent._applyNotesActions([
            {
                op: 'rebuild_page',
                blocks: [
                    { type: 'heading_1', content: 'Draft' },
                    { type: 'text', content: 'Body' },
                ],
            },
        ]);

        expect(result.appliedCount).toBe(0);
        expect(editor.savePage).not.toHaveBeenCalled();
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    test('uses multi-pass drafting for research-backed notes pages instead of treating "research" as a non-page task', () => {
        const agent = loadAgent();

        expect(agent._shouldUseMultiPassNotesDraft(
            'Create a research brief about penguins with sources, key findings, and a stronger page layout.',
            {
                blockCount: 5,
                outline: [{ id: 'block_h1', content: 'Overview' }],
            },
            {}
        )).toBe(true);
    });

    test('selects a project-oriented template for project planning requests', () => {
        const agent = loadAgent();
        const templates = agent._selectNotesPageTemplates(
            'Create a project plan for launching the new notes agent with milestones, owners, and a timeline.',
            {
                title: 'Launch Planning',
                blockCount: 0,
                blocks: [],
                outline: [],
            }
        );

        expect(Array.isArray(templates)).toBe(true);
        expect(templates[0].id).toBe('project');
    });

    test('selects a sales-oriented template for pitch requests', () => {
        const agent = loadAgent();
        const templates = agent._selectNotesPageTemplates(
            'Create a sales pitch for an AI notes agent with ROI, customer proof, objections, and a next-step CTA.',
            {
                title: 'AI Notes Pitch',
                blockCount: 0,
                blocks: [],
                outline: [],
            }
        );

        expect(Array.isArray(templates)).toBe(true);
        expect(templates[0].id).toBe('sales');
    });

    test('selects a sales proof block pattern for pitch requests', () => {
        const agent = loadAgent();
        const patterns = agent._selectNotesBlockDesignPatterns(
            'Create a sales pitch for an AI notes agent with ROI, customer proof, objections, and a next-step CTA.',
            {
                title: 'AI Notes Pitch',
                blockCount: 0,
                blocks: [],
                outline: [],
            },
            [{ id: 'sales' }]
        );

        expect(Array.isArray(patterns)).toBe(true);
        expect(patterns[0].id).toBe('sales-proof-stack');
    });

    test('selects an explainer-oriented template for educational topic pages', () => {
        const agent = loadAgent();
        const templates = agent._selectNotesPageTemplates(
            'Create a polished page about penguins with science facts, habitat notes, and quick facts.',
            {
                title: 'Penguins',
                blockCount: 0,
                blocks: [],
                outline: [],
            }
        );

        expect(Array.isArray(templates)).toBe(true);
        expect(templates[0].id).toBe('explainer');
    });

    test('selects a field-guide design scheme for educational nature pages', () => {
        const agent = loadAgent();
        const schemes = agent._selectNotesDesignSchemes(
            'Create a polished page about penguins with science facts, habitat notes, and quick facts.',
            {
                title: 'Penguins',
                blockCount: 0,
                blocks: [],
                outline: [],
            },
            [{ id: 'explainer' }]
        );

        expect(Array.isArray(schemes)).toBe(true);
        expect(schemes[0].id).toBe('field-guide');
    });

    test('expands oversized single-block rebuild actions into multiple page blocks', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [{
                    type: 'text',
                    content: '# Penguins\n\n## Habitat\nPenguins live in cold climates and gather in large colonies.\n\n- Antarctica\n- Southern Ocean\n- Rocky coastal islands'
                }],
            },
        ], 'Create a page about penguins with sections and supporting bullets.', {
            blockCount: 0,
            outline: [],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: 'Penguins' }),
            expect.objectContaining({ type: 'heading_2', content: 'Habitat' }),
            expect.objectContaining({ type: 'bulleted_list', content: 'Antarctica' }),
        ]));
        expect(normalizedActions[0].blocks.length).toBeGreaterThan(1);
    });

    test('preserves raw html documents as html code blocks instead of prose blocks', () => {
        const agent = loadAgent();
        const html = [
            'Signal City HTML Document',
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8" />',
            '<title>Signal City | Editorial Infographic Website</title>',
            '<style>',
            ':root {',
            '--ink: #111318;',
            '--muted: #5f6675;',
            '}',
            '</style>',
            '</head>',
            '<body><main><h1>Signal City</h1></main></body>',
            '</html>',
        ].join('\n');

        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [{
                    type: 'text',
                    content: html,
                }],
            },
        ], 'Put this HTML document on the page without losing code.', {
            blockCount: 0,
            outline: [],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual([
            expect.objectContaining({ type: 'heading_1', content: 'Signal City' }),
            expect.objectContaining({
                type: 'code',
                content: expect.objectContaining({
                    language: 'html',
                    text: expect.stringContaining('<!doctype html>'),
                }),
            }),
        ]);
        expect(normalizedActions[0].blocks[1].content.text).toContain('<style>');
        expect(normalizedActions[0].blocks[1].content.text).toContain('--muted: #5f6675;');
        expect(normalizedActions[0].blocks).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'callout' }),
            expect.objectContaining({ type: 'ai_image' }),
        ]));
    });

    test('rehydrates collapsed one-line markdown into structured notes blocks', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [{
                    type: 'text',
                    content: '☀️ Suns and the Science of Suns > Big idea: The Sun is a star that gives Earth light and heat. ## What Is a Sun? A sun is a star. - light for daytime - heat for life ## Stay Safe > Never look directly at the Sun with your eyes.',
                }],
            },
        ], 'Create a researched page about suns with sections, solar safety, and key facts.', {
            blockCount: 0,
            outline: [],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: '☀️ Suns and the Science of Suns' }),
            expect.objectContaining({
                type: 'callout',
                content: expect.objectContaining({
                    text: expect.stringContaining('The Sun is a star'),
                }),
            }),
            expect.objectContaining({ type: 'heading_2', content: 'What Is a Sun?' }),
            expect.objectContaining({ type: 'bulleted_list', content: 'light for daytime' }),
            expect.objectContaining({ type: 'heading_2', content: 'Stay Safe' }),
        ]));
        expect(normalizedActions[0].blocks.length).toBeGreaterThan(4);
    });

    test('upgrades plain research rebuilds with richer support blocks and source bookmarks', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [
                    { type: 'heading_1', content: 'Penguins: Built for Water, Pressed by Change' },
                    { type: 'quote', content: 'Shoutout to emperor penguins for surviving brutal Antarctic cold with patience, teamwork, and elite-level parenting.' },
                    { type: 'heading_2', content: 'Why Penguins Stand Out' },
                    { type: 'text', content: 'Penguins are flightless seabirds engineered for life in the ocean. On land they can look awkward and almost comic, but in the water they become fast, controlled, and highly efficient swimmers.' },
                    { type: 'heading_2', content: 'Source Note' },
                    { type: 'text', content: 'This page is based on verified research already established in the session, including Nat Geo Kids and ScienceDaily notes about penguin habitats across the Southern Hemisphere.' },
                ],
            },
        ], 'Create a researched page about penguins with verified sources and a polished layout.', {
            title: 'Untitled',
            blockCount: 0,
            outline: [],
            blocks: [],
        }, [
            {
                toolCall: { function: { name: 'web-search', arguments: '{}' } },
                result: {
                    success: true,
                    toolId: 'web-search',
                    data: {
                        results: [
                            {
                                title: 'National Geographic Kids: Penguins',
                                url: 'https://kids.nationalgeographic.com/animals/birds/facts/penguin',
                                snippet: 'Penguins are flightless birds that live across the Southern Hemisphere.',
                            },
                            {
                                title: 'ScienceDaily: Penguins',
                                url: 'https://www.sciencedaily.com/releases/2024/01/240101123456.htm',
                                snippet: 'Research overview on penguin habitats and climate pressure.',
                            },
                        ],
                    },
                },
            },
        ]);

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].icon).toBe('🔎');
        expect(normalizedActions[0].title).toBe('Penguins: Built for Water, Pressed by Change');
        expect(normalizedActions[0].properties).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'Evidence', value: 'Source-linked' }),
        ]));
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'callout',
                content: expect.objectContaining({
                    icon: '🧭',
                }),
                color: 'blue',
            }),
            expect.objectContaining({ type: 'divider' }),
            expect.objectContaining({ type: 'toggle', color: 'gray' }),
            expect.objectContaining({
                type: 'bookmark',
                content: expect.objectContaining({
                    url: 'https://kids.nationalgeographic.com/animals/birds/facts/penguin',
                }),
            }),
        ]));
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'ai_image',
                content: expect.objectContaining({
                    source: 'unsplash',
                    prompt: expect.stringMatching(/penguins/i),
                }),
            }),
            expect.objectContaining({
                type: 'heading_2',
                content: 'Why Penguins Stand Out',
                textColor: 'blue',
            }),
            expect.objectContaining({
                type: 'heading_2',
                content: 'Source Note',
                textColor: 'gray',
            }),
        ]));
    });

    test('turns markdown task lists into todo blocks during fallback expansion', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [{
                    type: 'text',
                    content: '# Penguin Tasks\n\n- [ ] Find habitat sources\n- [x] Add hero image\n- [ ] Verify colony facts',
                }],
            },
        ], 'Build a notes page with penguin research tasks and clean structure.', {
            blockCount: 0,
            outline: [],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_1', content: 'Penguin Tasks' }),
            expect.objectContaining({
                type: 'todo',
                content: expect.objectContaining({ text: 'Find habitat sources', checked: false }),
            }),
            expect.objectContaining({
                type: 'todo',
                content: expect.objectContaining({ text: 'Add hero image', checked: true }),
            }),
        ]));
    });

    test('converts quick facts lists into a richer explainer layout cluster', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [
                    { type: 'heading_1', content: 'Suns and the Science of Suns' },
                    { type: 'text', content: 'The Sun is a star and gives Earth light and heat.' },
                    { type: 'heading_2', content: 'Quick Facts' },
                    { type: 'bulleted_list', content: 'The Sun is a star.' },
                    { type: 'bulleted_list', content: 'It gives Earth light and heat.' },
                    { type: 'bulleted_list', content: 'Many stars in the night sky are other suns.' },
                    { type: 'heading_2', content: 'Stay Safe' },
                    { type: 'text', content: 'Never look directly at the Sun with your eyes. It can damage your vision.' },
                ],
            },
        ], 'Build a polished explainer page about suns with quick facts and a safety note.', {
            title: 'Untitled',
            blockCount: 0,
            outline: [],
            blocks: [],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].icon).toBe('💡');
        expect(normalizedActions[0].properties).toBeUndefined();
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'ai_image' }),
            expect.objectContaining({
                type: 'database',
                content: expect.objectContaining({
                    columns: expect.arrayContaining(['Quick fact']),
                }),
            }),
            expect.objectContaining({
                type: 'callout',
                color: 'orange',
            }),
            expect.objectContaining({ type: 'divider' }),
        ]));
    });

    test('preserves existing accent colors when upgrading a page redesign', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [
                    { type: 'heading_1', content: 'Penguins' },
                    { type: 'text', content: 'Penguins are flightless seabirds adapted for life in the ocean.' },
                    { type: 'heading_2', content: 'Habitat' },
                    { type: 'text', content: 'They live across the Southern Hemisphere and depend on productive marine ecosystems.' },
                    { type: 'heading_2', content: 'Quick Facts' },
                    { type: 'bulleted_list', content: 'They are expert swimmers.' },
                    { type: 'bulleted_list', content: 'Many species live in colonies.' },
                    { type: 'bulleted_list', content: 'Not all penguins live in Antarctica.' },
                ],
            },
        ], 'Refresh this page about penguins but keep the current green accent and make it feel more polished.', {
            title: 'Penguins',
            blockCount: 6,
            outline: [{ id: 'h1', content: 'Penguins' }],
            blocks: [
                { id: 'b1', type: 'callout', content: { text: 'Existing lead' }, color: 'green' },
                { id: 'b2', type: 'heading_2', content: 'Habitat', textColor: 'green' },
            ],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'callout', color: 'green' }),
            expect.objectContaining({ type: 'heading_2', textColor: 'green' }),
        ]));
    });

    test('promotes compact inline section labels into heading_3 blocks for stronger page rhythm', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'rebuild_page',
                blocks: [
                    { type: 'heading_1', content: 'Penguins' },
                    { type: 'text', content: 'Penguins are flightless seabirds adapted for life in the ocean.' },
                    { type: 'text', content: 'Why It Matters' },
                    { type: 'text', content: 'Penguins help show how evolution shapes animals for a specific environment.' },
                    { type: 'text', content: 'Habitat Snapshot: Southern Hemisphere coasts, islands, and cold ocean ecosystems.' },
                ],
            },
        ], 'Make this penguin page feel more designed and notion-like.', {
            title: 'Penguins',
            blockCount: 5,
            outline: [{ id: 'h1', content: 'Penguins' }],
            blocks: [],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'heading_3', content: 'Why It Matters' }),
            expect.objectContaining({ type: 'heading_3', content: 'Habitat Snapshot' }),
            expect.objectContaining({
                type: 'text',
                content: 'Southern Hemisphere coasts, islands, and cold ocean ecosystems.',
            }),
        ]));
    });

    test('normalizes markdown-like single-line block definitions into native block types', () => {
        const agent = loadAgent();
        const normalizedActions = agent._normalizeStructuredPageActions([
            {
                op: 'append_to_page',
                blocks: [
                    { type: 'text', content: '## Habitat' },
                    { type: 'text', content: '-- Ice shelves and rocky coasts' },
                    { type: 'text', content: '[ ] Add conservation section' },
                    { type: 'text', content: '**Big idea:** Penguins are built for water.' },
                ],
            },
        ], 'Add cleaner native blocks to this penguin page.', {
            blockCount: 4,
            outline: [{ id: 'h1', content: 'Penguins' }],
        });

        expect(normalizedActions).toHaveLength(1);
        expect(normalizedActions[0].blocks).toEqual([
            expect.objectContaining({ type: 'heading_2', content: 'Habitat' }),
            expect.objectContaining({ type: 'bulleted_list', content: 'Ice shelves and rocky coasts' }),
            expect.objectContaining({
                type: 'todo',
                content: expect.objectContaining({ text: 'Add conservation section', checked: false }),
            }),
            expect.objectContaining({
                type: 'callout',
                content: expect.objectContaining({ text: 'Big idea: Penguins are built for water.' }),
            }),
        ]);
    });

    test('converts fenced Mermaid markdown into native mermaid blocks', () => {
        const agent = loadAgent();
        const responseText = JSON.stringify({
            assistant_reply: 'Added the flow.',
            content: [
                '# Auth Flow',
                '',
                '```mermaid',
                'flowchart TD',
                '    User --> Login',
                '    Login --> Dashboard',
                '```',
            ].join('\n'),
        });

        const parsed = agent._extractNotesActionPlan(responseText);
        const mermaidBlock = parsed.actions[0].blocks.find((block) => block.type === 'mermaid');

        expect(mermaidBlock).toEqual(expect.objectContaining({
            type: 'mermaid',
            content: expect.objectContaining({
                diagramType: 'flowchart',
                text: expect.stringContaining('flowchart TD'),
            }),
        }));
    });

    test('normalizes drawing-style block aliases into ai_image blocks', () => {
        const agent = loadAgent();
        const parsed = agent._extractNotesActionPlan(JSON.stringify([
            {
                type: 'drawing',
                prompt: 'A clean dashboard sketch',
                source: 'ai',
            },
        ]));

        expect(parsed.actions[0].blocks[0]).toEqual(expect.objectContaining({
            type: 'drawing',
            prompt: 'A clean dashboard sketch',
        }));

        const normalizedActions = agent._normalizeStructuredPageActions(parsed.actions, 'Add this drawing to the page.', {
            blockCount: 0,
            outline: [],
        });

        expect(normalizedActions[0].blocks[0]).toEqual(expect.objectContaining({
            type: 'ai_image',
            prompt: 'A clean dashboard sketch',
        }));
    });

    test('suppresses inferred html artifacts for notes page build requests unless file delivery is explicit', () => {
        const agent = loadAgent();
        const context = {
            blockCount: 8,
            outline: [{ id: 'h1' }],
        };

        expect(agent._shouldSuppressRequestedArtifactFormat(
            'Can you make me an HTML page about tropical fish with sections for habitat and care?',
            context,
            'html',
        )).toBe(true);

        expect(agent._shouldSuppressRequestedArtifactFormat(
            'Create an HTML file I can download for a tropical fish landing page.',
            context,
            'html',
        )).toBe(false);
    });
});
