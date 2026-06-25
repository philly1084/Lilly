const fs = require('fs');
const path = require('path');
const vm = require('vm');

function runIndexRedirect(search = '') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    const replace = jest.fn();
    const context = {
        URL,
        window: {
            location: {
                href: `http://localhost:3000/web-chat/${search}`,
                replace,
            },
        },
    };

    vm.runInNewContext(script, context, { filename: 'index.html' });
    return replace.mock.calls[0]?.[0] || '';
}

describe('web-chat index redirect', () => {
    test('preserves explicit workspace query while removing embedded host flags', () => {
        const target = runIndexRedirect('?workspace=workspace-2&workspaceLabel=Workspace%202&embedded=1&foo=bar');
        const parsed = new URL(target);

        expect(parsed.pathname).toBe('/web-chat/app.html');
        expect(parsed.searchParams.get('workspace')).toBe('workspace-2');
        expect(parsed.searchParams.get('workspaceLabel')).toBe('Workspace 2');
        expect(parsed.searchParams.get('foo')).toBe('bar');
        expect(parsed.searchParams.has('embedded')).toBe(false);
    });

    test('composer tool menu exposes the IDE source-edit lane', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

        expect(html).toContain('data-tool-intent-checkbox value="ide"');
        expect(html).toContain('<span class="tool-menu-choice__label">IDE</span>');
        expect(html).toContain('<span class="tool-menu-choice__hint">Patch source</span>');
    });

    test('mobile chat controls expose dialog ownership and open-close labels', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="mobile-chat-menu-btn"');
        expect(html).toContain('aria-controls="mobile-chat-menu"');
        expect(html).toContain('aria-label="Open chat controls"');
        expect(html).toContain('js/ui.js?v=20260625a');
        expect(uiSource).toContain("trigger?.setAttribute('aria-label', 'Close chat controls')");
        expect(uiSource).toContain("trigger?.setAttribute('aria-label', 'Open chat controls')");
    });
});
