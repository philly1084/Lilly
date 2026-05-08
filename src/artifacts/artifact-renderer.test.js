jest.mock('./artifact-store', () => ({
    artifactStore: {
        get: jest.fn(),
    },
}));

const { artifactStore } = require('./artifact-store');
const {
    buildStyledPdfBufferFromHtml,
    normalizeMermaidSource,
    ensureHtmlDocument,
    extractCompositeDocumentParts,
    inferPdfPageOptionsFromHtml,
    injectHtmlStyleSafetyNet,
    inlineExternalImagesForPdf,
    inlineRenderableImagesForPdf,
    inlineInternalArtifactImagesForPdf,
} = require('./artifact-renderer');

let originalFetch;

beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
});

afterEach(() => {
    global.fetch = originalFetch;
});

describe('normalizeMermaidSource', () => {
    test('infers landscape PDF pages for slide-like HTML', () => {
        const options = inferPdfPageOptionsFromHtml(
            '<!DOCTYPE html><html><body><main class="presentation-deck"><section class="deck-slide">One</section></main></body></html>',
        );

        expect(options).toEqual(expect.objectContaining({
            landscape: true,
            width: '13.333in',
            height: '7.5in',
            preferCSSPageSize: true,
        }));
    });

    test('keeps normal documents on the default portrait PDF path', () => {
        const options = inferPdfPageOptionsFromHtml(
            '<!DOCTYPE html><html><body><main><h1>Executive Brief</h1><p>Normal report.</p></main></body></html>',
        );

        expect(options.landscape).toBeUndefined();
        expect(options.width).toBeUndefined();
        expect(options).toEqual(expect.objectContaining({
            printBackground: true,
            preferCSSPageSize: true,
        }));
    });

    test('splits collapsed flowchart statements onto separate lines', () => {
        const input = 'flowchart LR    A[Kitten<br/>0-6 months] --> B[Junior<br/>6 months - 2 years]    B --> C[Prime<br/>3-6 years]    C --> D[Mature<br/>7-10 years]    D --> E[Senior<br/>11-14 years]    E --> F[Geriatric<br/>15+ years]    style A fill:#FFB6C1    style B fill:#FFD700';

        expect(normalizeMermaidSource(input)).toBe([
            'flowchart LR',
            'A[Kitten<br/>0-6 months] --> B[Junior<br/>6 months - 2 years]',
            'B --> C[Prime<br/>3-6 years]',
            'C --> D[Mature<br/>7-10 years]',
            'D --> E[Senior<br/>11-14 years]',
            'E --> F[Geriatric<br/>15+ years]',
            'style A fill:#FFB6C1',
            'style B fill:#FFD700',
        ].join('\n'));
    });

    test('unwraps fenced mermaid blocks', () => {
        const input = '```mermaid\nflowchart TD\nA --> B\n```';

        expect(normalizeMermaidSource(input)).toBe('flowchart TD\nA --> B');
    });

    test('extracts collapsed mermaid from mixed mermaid and html content', () => {
        const input = [
            'flowchart TD Birth[Birth] Neonatal[Neonatal',
            '0-2 weeks] Transitional[Transitional',
            '2-4 weeks] Socialization[Socialization',
            '4-12 weeks] Juvenile[Juvenile',
            '3-6 months] Adult[Adult',
            '1-7 years] Birth --> Neonatal Neonatal --> Transitional Transitional --> Socialization Socialization --> Juvenile Juvenile --> Adult',
            '```html',
            '<h1>Dog Life Stages Assessment</h1>',
            '<p>This report outlines the typical life stages of a dog.</p>',
            '```',
        ].join('\n');

        const parts = extractCompositeDocumentParts(input);

        expect(parts.mermaidSource).toContain('flowchart TD');
        expect(parts.mermaidSource).toContain('Birth --> Neonatal');
        expect(parts.bodyContent).toContain('<h1>Dog Life Stages Assessment</h1>');
    });

    test('drops explanatory prose around fenced html blocks', () => {
        const parts = extractCompositeDocumentParts([
            'Below is a ready-to-use HTML file.',
            'Copy and paste it as-is.',
            '```html',
            '<!DOCTYPE html>',
            '<html><body><main>Ready</main></body></html>',
            '```',
            'Let me know if you want a cron version too.',
        ].join('\n'));

        expect(parts.bodyContent).toBe('<main>Ready</main>');
        expect(parts.bodyContent).not.toContain('Below is a ready-to-use HTML file.');
        expect(parts.bodyContent).not.toContain('cron version');
    });

    test('drops explanatory prose before standalone html fragments', () => {
        const parts = extractCompositeDocumentParts([
            'Here is the finished page:',
            '<section><h1>Ready</h1><p>Published.</p></section>',
        ].join('\n'));

        expect(parts.bodyContent).toBe('<section><h1>Ready</h1><p>Published.</p></section>');
        expect(parts.bodyContent).not.toContain('Here is the finished page:');
    });

    test('injects mermaid block into printable html documents', () => {
        const html = ensureHtmlDocument([
            'flowchart TD A[Birth] --> B[Adult]',
            '```html',
            '<h1>Dog Life Stages Assessment</h1>',
            '```',
        ].join('\n'), 'Dog Life Stages');

        expect(html).toContain('class="mermaid"');
        expect(html).toContain('Dog Life Stages Assessment');
        expect(html).toContain('cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js');
    });

    test('adds a reusable style safety net to generated html documents', () => {
        const html = ensureHtmlDocument(
            '<main data-dashboard-zone="hero"><h1>Support Ops</h1><button>Refresh</button></main>',
            'Support Ops',
        );

        expect(html).toContain('data-kimibuilt-style-safety-net');
        expect(html).toContain('[data-dashboard-zone]');
        expect(html).toContain('grid-template-columns: repeat(auto-fit');
    });

    test('does not inject duplicate fallback styles', () => {
        const html = '<!DOCTYPE html><html><head></head><body><main><h1>Ready</h1></main></body></html>';
        const once = injectHtmlStyleSafetyNet(html);
        const twice = injectHtmlStyleSafetyNet(once);

        expect(twice.match(/data-kimibuilt-style-safety-net/g)).toHaveLength(1);
    });

    test('builds a styled PDF fallback when browser rendering is unavailable', async () => {
        const buffer = await buildStyledPdfBufferFromHtml(
            '<!DOCTYPE html><html><body><main><h1>Support Ops</h1><h2>SLA Watch</h2><p>Queue pressure is elevated.</p></main></body></html>',
            'Support Ops',
        );

        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.toString('utf8', 0, 4)).toBe('%PDF');
        expect(buffer.length).toBeGreaterThan(1000);
    });

    test('inlines internal artifact image urls for PDF rendering', async () => {
        artifactStore.get.mockResolvedValue({
            id: 'image-artifact-1',
            mimeType: 'image/png',
            contentBuffer: Buffer.from('png-bytes'),
        });

        const html = await inlineInternalArtifactImagesForPdf(
            '<html><body><img src="/api/artifacts/image-artifact-1/download?inline=1" alt="Generated image"></body></html>',
        );

        expect(artifactStore.get).toHaveBeenCalledWith('image-artifact-1', { includeContent: true });
        expect(html).toContain('src="data:image/png;base64,');
        expect(html).not.toContain('/api/artifacts/image-artifact-1/download?inline=1');
    });

    test('inlines external image urls for PDF rendering when they can be fetched ahead of time', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            headers: {
                get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null),
            },
            arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        }));

        const html = await inlineExternalImagesForPdf(
            '<html><body><img src="https://images.example.com/cat.png" alt="External image"></body></html>',
        );

        expect(global.fetch).toHaveBeenCalledWith('https://images.example.com/cat.png', expect.objectContaining({
            method: 'GET',
        }));
        expect(html).toContain('src="data:image/png;base64,');
        expect(html).not.toContain('https://images.example.com/cat.png');
    });

    test('combined PDF inlining keeps working with both internal and external image sources', async () => {
        artifactStore.get.mockResolvedValue({
            id: 'image-artifact-1',
            mimeType: 'image/png',
            contentBuffer: Buffer.from('png-bytes'),
        });
        global.fetch = jest.fn(async () => ({
            ok: true,
            headers: {
                get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : null),
            },
            arrayBuffer: async () => Uint8Array.from([5, 6, 7, 8]).buffer,
        }));

        const html = await inlineRenderableImagesForPdf(
            '<html><body><img src="/api/artifacts/image-artifact-1/download?inline=1"><img src="https://images.example.com/cat.jpg"></body></html>',
        );

        expect(html.match(/src="data:image\//g)).toHaveLength(2);
    });
});
