const parser = require('./model-output-parser');

describe('model-output-parser', () => {
    test('unwraps common model response envelopes before markdown repair', () => {
        const normalized = parser.normalizeModelOutputMarkdown({
            model: 'example-model',
            result: '```json\n{"content":"<final>Summary | Item | Value | |---|---| | A | B |</final>","metadata":{"provider":"example"}}\n```',
        });

        expect(normalized).toContain('### Summary');
        expect(normalized).toContain('| Item | Value |');
        expect(normalized).toContain('| A | B |');
    });

    test('extracts OpenAI-style content parts', () => {
        const normalized = parser.normalizeModelOutputMarkdown({
            content: [
                { type: 'output_text', text: 'Why it works Crispy outside. --- Ingredients | Item | Quantity | |---|---| | Potatoes | 2 lbs |' },
            ],
        });

        expect(normalized).toContain('### Why it works');
        expect(normalized).toContain('### Ingredients');
        expect(normalized).toContain('| Potatoes | 2 lbs |');
    });

    test('drops reasoning content parts before normalizing visible html output', () => {
        const normalized = parser.normalizeModelOutputMarkdown({
            content: [
                { type: 'reasoning', text: 'Reasoning: draft the sections and choose the layout.' },
                { type: 'output_text', text: '<!doctype html><html><head><title>Clean Artifact</title></head><body><main>Ready</main></body></html>' },
            ],
        });

        expect(normalized).toContain('```html\n<!doctype html>');
        expect(normalized).not.toContain('Reasoning: draft the sections');
    });

    test('extracts nested Responses output message parts without leaking reasoning summaries', () => {
        const normalized = parser.normalizeModelOutputMarkdown({
            output: [
                {
                    type: 'reasoning',
                    summary: [
                        { type: 'summary_text', text: 'Private plan: inspect hidden chain of thought.' },
                    ],
                },
                {
                    type: 'message',
                    content: [
                        { type: 'output_text', text: 'Short answer: Nested payloads now render.' },
                    ],
                },
            ],
        });

        expect(normalized).toContain('Short answer:');
        expect(normalized).toContain('Nested payloads now render.');
        expect(normalized).not.toContain('Private plan');
        expect(normalized).not.toContain('chain of thought');
    });

    test('keeps fenced code blocks intact while repairing surrounding prose', () => {
        const normalized = parser.normalizeModelOutputMarkdown('Summary: useful\n\n```js\nconst table = \"| not markdown |\";\n```\n\nIngredients | Item | Quantity | |---|---| | A | B |');

        expect(normalized).toContain('```js\nconst table = "| not markdown |";\n```');
        expect(normalized).toContain('### Ingredients');
        expect(normalized).toContain('| A | B |');
    });

    test('restores flattened html fences before preview rendering', () => {
        const normalized = parser.normalizeModelOutputMarkdown('Save this as `brief.html`.```html <!doctype html><html><head><title>Brief</title></head><body><main>Ready</main></body></html> ```');

        expect(normalized).toContain('```html\n<!doctype html>');
        expect(normalized).toContain('</html>\n```');
    });

    test('fences raw html documents with prose titles before markdown rendering', () => {
        const normalized = parser.normalizeModelOutputMarkdown([
            'Signal City HTML Document',
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8" />',
            '<style>',
            ':root {',
            '--ink: #111318;',
            '--muted: #5f6675;',
            '}',
            '</style>',
            '</head>',
            '<body><main>Ready</main></body>',
            '</html>',
        ].join('\n'));

        expect(normalized).toContain('Signal City HTML Document');
        expect(normalized).toContain('```html\n<!doctype html>');
        expect(normalized).toContain('<style>');
        expect(normalized).toContain('--muted: #5f6675;');
        expect(normalized).toContain('</html>\n```');
    });

    test('does not keep internal diagnostic prefaces before raw html documents', () => {
        const normalized = parser.normalizeModelOutputMarkdown([
            'Reasoning: I will build the page in three passes.',
            'Diagnostics',
            'provider_or_backend_error | stage=route_error',
            '<!doctype html>',
            '<html><head><title>Clean</title></head><body><main>Ready</main></body></html>',
        ].join('\n'));

        expect(normalized).toContain('```html\n<!doctype html>');
        expect(normalized).not.toContain('Reasoning: I will build');
        expect(normalized).not.toContain('provider_or_backend_error');
    });

    test('drops progress wrapper text before fenced full html documents', () => {
        const normalized = parser.normalizeModelOutputMarkdown([
            'Working in background...I\'ll rebuild this with fresh verification first, then return the page as clean HTML only.```html',
            '<!doctype html>',
            '<html><head><title>Clean</title></head><body><main>Ready</main></body></html>',
        ].join('\n'));

        expect(normalized).toContain('```html\n<!doctype html>');
        expect(normalized).not.toContain('Working in background');
        expect(normalized).not.toContain('clean HTML only');
    });

    test('strips compact DSML tool-call tags from visible output', () => {
        const normalized = parser.normalizeModelOutputMarkdown([
            'I will check that now.',
            '<dsmltoolcalls>',
            '<dsmlinvoke name="web-search">',
            '<dsmlparameter name="query" string="true">private tool request</dsmlparameter>',
            '</dsmlinvoke>',
            '</dsmltoolcalls>',
        ].join(' '));

        expect(normalized).toBe('I will check that now.');
        expect(normalized).not.toContain('dsml');
        expect(normalized).not.toContain('web-search');
        expect(normalized).not.toContain('private tool request');
    });

    test('normalizes lightweight presentation markup outside code fences', () => {
        const normalized = parser.normalizeModelOutputMarkdown('This is ==important== and ::warning[check this].\n\n```md\n==literal== ::warning[literal]\n```');

        expect(normalized).toContain('<mark class="kb-highlight">important</mark>');
        expect(normalized).toContain('<span class="kb-tone kb-tone--warning">check this</span>');
        expect(normalized).toContain('```md\n==literal== ::warning[literal]\n```');
    });

    test('detects leaked remote-command JSON payloads without normalizing them away', () => {
        const payload = parser.detectToolPayload(JSON.stringify({
            command: 'kubectl get pods -A',
            hostname: '162.55.163.199',
            port: 22,
            username: 'root',
        }));

        expect(payload).toEqual(expect.objectContaining({
            toolId: 'remote-command',
            command: 'kubectl get pods -A',
            host: '162.55.163.199',
            username: 'root',
            port: 22,
        }));
    });

    test('detects snake_case tool_call wrappers with remote command arguments', () => {
        const payload = parser.detectToolPayload(JSON.stringify({
            tool_call: {
                type: 'function_call',
                function: {
                    name: 'remote-command',
                    arguments: JSON.stringify({
                        command: 'kubectl rollout status deployment/kimibuilt',
                        host: 'primary.k3s.local',
                        username: 'root',
                    }),
                },
            },
        }));

        expect(payload).toEqual(expect.objectContaining({
            toolId: 'remote-command',
            command: 'kubectl rollout status deployment/kimibuilt',
            host: 'primary.k3s.local',
            username: 'root',
        }));
    });

    test('does not flag ordinary command examples as remote payloads', () => {
        expect(parser.detectToolPayload(JSON.stringify({
            command: 'npm test',
            description: 'Local package test command.',
        }))).toBeNull();
    });
});
