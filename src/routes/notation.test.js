jest.mock('../middleware/validate', () => ({
    validate: () => (_req, _res, next) => next(),
}));

jest.mock('../session-store', () => ({
    sessionStore: {},
}));

jest.mock('../memory/memory-service', () => ({
    memoryService: {},
}));

jest.mock('../runtime-execution', () => ({
    executeConversationRuntime: jest.fn(),
    resolveConversationExecutorFlag: jest.fn(() => false),
}));

jest.mock('../ai-route-utils', () => ({
    buildInstructionsWithArtifacts: jest.fn(),
    maybeGenerateOutputArtifact: jest.fn(),
    resolveReasoningEffort: jest.fn(() => null),
}));

jest.mock('../admin/runtime-monitor', () => ({
    startRuntimeTask: jest.fn(() => ({ id: 'task-1' })),
    completeRuntimeTask: jest.fn(),
    failRuntimeTask: jest.fn(),
}));

const notationRouter = require('./notation');

const {
    buildNotationInstructions,
    parseNotationResponse,
    normalizeIssues,
} = notationRouter._private;

describe('/api/notation helpers', () => {
    test('buildNotationInstructions keeps legacy fields and adds validate issue contract', () => {
        const instructions = buildNotationInstructions('validate', 'Prefer UML-ish arrows.');

        expect(instructions).toContain('"result"');
        expect(instructions).toContain('"annotations"');
        expect(instructions).toContain('"suggestions"');
        expect(instructions).toContain('"structure"');
        expect(instructions).toContain('"assumptions"');
        expect(instructions).toContain('"ambiguities"');
        expect(instructions).toContain('"issues"');
        expect(instructions).toContain('"correctedNotation"');
        expect(instructions).toContain('Always include issues as an array');
        expect(instructions).toContain('severity, line, message, and fix');
        expect(instructions).toContain('Prefer UML-ish arrows.');
    });

    test('buildNotationInstructions discourages validation-only fields in expand mode', () => {
        const instructions = buildNotationInstructions('expand', '');

        expect(instructions).toContain('MODE: EXPAND');
        expect(instructions).toContain('do not add validate-only issues unless there is a real problem');
    });

    test('parseNotationResponse preserves optional contract fields and maps issues to annotations', () => {
        const parsed = parseNotationResponse(JSON.stringify({
            result: 'user authenticates, then sees dashboard',
            annotations: [{ line: 1, note: 'Entry point' }],
            suggestions: ['Name the auth provider'],
            structure: { actor: 'user', steps: ['auth', 'dashboard'] },
            assumptions: ['dashboard means signed-in landing page'],
            ambiguities: ['auth mechanism is unspecified'],
            issues: [
                {
                    severity: 'error',
                    line: 2,
                    message: 'Missing failure path',
                    fix: 'Add auth failure branch',
                },
            ],
            correctedNotation: 'user -> auth -> dashboard\nuser -> auth_failed -> retry',
        }), 'validate');

        expect(parsed).toMatchObject({
            result: 'user authenticates, then sees dashboard',
            suggestions: ['Name the auth provider'],
            structure: { actor: 'user', steps: ['auth', 'dashboard'] },
            assumptions: ['dashboard means signed-in landing page'],
            ambiguities: ['auth mechanism is unspecified'],
            correctedNotation: 'user -> auth -> dashboard\nuser -> auth_failed -> retry',
        });
        expect(parsed.issues).toEqual([
            {
                severity: 'error',
                line: 2,
                message: 'Missing failure path',
                fix: 'Add auth failure branch',
            },
        ]);
        expect(parsed.annotations).toEqual(expect.arrayContaining([
            { line: 1, note: 'Entry point' },
            {
                line: 2,
                note: 'Missing failure path Fix: Add auth failure branch',
                type: 'error',
            },
        ]));
    });

    test('parseNotationResponse keeps older clients working with original shape', () => {
        const parsed = parseNotationResponse(JSON.stringify({
            result: 'Expanded text',
            annotations: [{ line: 1, note: 'ok' }],
            suggestions: ['tighten this'],
        }), 'expand');

        expect(parsed).toEqual({
            result: 'Expanded text',
            annotations: [{ line: 1, note: 'ok' }],
            suggestions: ['tighten this'],
        });
    });

    test('normalizeIssues filters malformed issues and defaults severity', () => {
        expect(normalizeIssues([
            { line: '3', message: 'Needs a target', fix: 'Add target' },
            { line: 0, message: 'General issue' },
            { line: 5, fix: 'No message' },
        ])).toEqual([
            {
                severity: 'warning',
                line: 3,
                message: 'Needs a target',
                fix: 'Add target',
            },
            {
                severity: 'warning',
                line: null,
                message: 'General issue',
                fix: '',
            },
        ]);
    });
});
