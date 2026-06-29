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

    test('composer tool picker exposes visible keyboard focus styling', () => {
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(css).toContain('--tool-picker-focus-ring: color-mix(in srgb, var(--accent)');
        expect(css).toContain('.tool-menu-btn:focus-visible');
        expect(css).toContain('.tool-menu-choice:focus-within');
        expect(css).toContain('box-shadow: 0 0 0 3px var(--tool-picker-focus-ring);');
        expect(css).toContain('.tool-menu-actions button:focus-visible');
        expect(css).toContain('.tool-command-picker__search:focus-within');
        expect(css).toContain('.selected-tool-chip__clear:focus-visible');
        expect(css).not.toContain('var(--accent-rgb)');
    });

    test('mobile chat controls expose dialog ownership and open-close labels', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(html).toContain('id="mobile-chat-menu-btn"');
        expect(html).toContain('aria-controls="mobile-chat-menu"');
        expect(html).toContain('aria-label="Open chat controls"');
        expect(html).toContain('aria-describedby="mobile-chat-menu-description"');
        expect(html).toContain('id="mobile-chat-menu-description"');
        expect(html).toContain('<button type="button" class="btn-icon mobile-chat-menu__close"');
        expect(html).toContain('<button type="button" class="mobile-chat-menu__action" data-mobile-menu-action="search">');
        expect(html).toContain('<button type="button" class="mobile-chat-menu__action mobile-chat-menu__action--danger" data-mobile-menu-action="clear">');
        expect(html).toContain('css/styles.css?v=20260625b');
        expect(html).toContain('js/tts-manager.js?v=20260628b');
        expect(html).toContain('js/ui.js?v=20260629b');
        expect(uiSource).toContain("trigger?.setAttribute('aria-label', 'Close chat controls')");
        expect(uiSource).toContain("trigger?.setAttribute('aria-label', 'Open chat controls')");
        expect(uiSource).toContain("if (event.key === 'Escape')");
        expect(uiSource).toContain('this.closeMobileActionSheet();');
        expect(css).toContain('.mobile-chat-menu__header {\n    position: sticky;');
        expect(css).toContain('backdrop-filter: blur(12px);');
    });

    test('export modal exposes instructions, progress, and focus return hooks', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('aria-describedby="export-description"');
        expect(html).toContain('id="export-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="export-title" aria-describedby="export-description" aria-hidden="true"');
        expect(html).toContain('id="export-description"');
        expect(html).toContain('id="export-progress-bar"');
        expect(html).toContain('role="progressbar"');
        expect(html).toContain('aria-labelledby="export-progress-text"');
        expect(html).toContain('aria-describedby="export-progress-percent"');
        expect(html).toContain('js/ui.js?v=20260629b');
        expect(uiSource).toContain('this.lastFocusedElement = document.activeElement;');
        expect(uiSource).toContain("progressBar.setAttribute('aria-valuenow', String(normalizedPercent));");
        expect(uiSource).toContain("progressBar.setAttribute('aria-valuetext', `${normalizedMessage}, ${normalizedPercent} percent`);");
        expect(uiSource).toContain('this.closeExportModal();');
        expect(uiSource).toContain("if (!modal || modal.classList.contains('hidden'))");
        expect(uiSource).toContain('this.lastFocusedElement.focus();');
    });

    test('import modal exposes instructions, status progress, and focus return hooks', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('aria-describedby="import-description"');
        expect(html).toContain('id="import-description"');
        expect(html).toContain('id="import-progress" class="import-progress hidden mt-4" role="status"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('aria-busy="false"');
        expect(html).toContain('js/ui.js?v=20260629b');
        expect(uiSource).toContain('this.closeImportModal({ restoreFocus: false });');
        expect(uiSource).toContain("progress?.setAttribute('aria-busy', 'true');");
        expect(uiSource).toContain("progress?.setAttribute('aria-busy', 'false');");
        expect(uiSource).toContain('restoreFocus && this.lastFocusedElement');
        expect(uiSource).toContain('this.lastFocusedElement.focus();');
    });

    test('assistant model list exposes keyboard-operable options', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="model-list-label"');
        expect(html).toContain('id="model-list" class="model-list hidden" role="listbox" aria-labelledby="model-list-label"');
        expect(uiSource).toContain('tabindex="${isActive ? \'0\' : \'-1\'}"');
        expect(uiSource).toContain('handleModelListItemKeydown(event)');
        expect(uiSource).toContain("case 'ArrowDown':");
        expect(uiSource).toContain('this.selectModel(item.dataset.modelId);');
    });

    test('media source selector exposes roving keyboard radio behavior', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('class="image-source-selector" role="radiogroup" aria-label="Image source"');
        expect(html).toContain('onclick="uiHelpers.setImageSource(\'generate\')"');
        expect(html).toContain('onkeydown="uiHelpers.handleImageSourceKeydown(event)"');
        expect(html).toContain('aria-checked="true"\n                                tabindex="0"');
        expect(html).toContain('aria-checked="false"\n                                tabindex="-1"');
        expect(uiSource).toContain('handleImageSourceKeydown(event)');
        expect(uiSource).toContain("btn.setAttribute('tabindex', isActive ? '0' : '-1');");
        expect(uiSource).toContain("const handledKeys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];");
        expect(uiSource).toContain('this.setImageSource(nextButton.dataset.source || \'generate\');');
        expect(uiSource).toContain('nextButton.focus();');
        expect(uiSource).toContain('requestAnimationFrame(() => nextButton.focus());');
    });

    test('shortcuts help dialog exposes instructions without stealing unrelated modal focus', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('js/ui.js?v=20260629b');
        expect(uiSource).toContain("modal.setAttribute('aria-describedby', 'shortcuts-description');");
        expect(uiSource).toContain('<div class="modal-overlay" aria-hidden="true" onclick="uiHelpers.closeShortcutsModal()"></div>');
        expect(uiSource).toContain('<button type="button" class="btn-icon" onclick="uiHelpers.closeShortcutsModal()" aria-label="Close keyboard shortcuts help">');
        expect(uiSource).toContain('id="shortcuts-description"');
        expect(uiSource).toContain('Common workspace shortcuts and slash commands for the current chat.');
        expect(uiSource).toContain('if (!modal) {\n            return;\n        }');
    });
});
