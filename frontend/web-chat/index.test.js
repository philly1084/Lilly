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

    test('uses adaptive reasoning by default while preserving fixed overrides', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('<option value="">Reasoning: Auto</option>');
        expect(html).toContain('<option value="low">Reasoning: Low</option>');
        expect(html).toContain('<option value="xhigh">Reasoning: XHigh</option>');
        expect(html).toContain('aria-label="Reasoning effort" autocomplete="off"');
        expect(html).toContain('<span id="input-reasoning-label">Reasoning: Auto</span>');
        expect(appSource).toContain("mode: 'auto'");
        expect(appSource).toContain("mode: 'manual'");
        expect(uiSource).toContain('this.updateReasoningUI();\n        this.updateAssistantModelSelect();');
    });

    test('keeps one card-based chat workflow without a separate mission mode', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

        expect(html).toContain('id="messages-container"');
        expect(html).toContain('id="message-input"');
        expect(html).toContain('id="input-meta-actions"');
        expect(html).toContain('id="input-model-indicator"');
        expect(html).not.toContain('execution-mode-switch');
        expect(html).not.toContain('data-execution-mode');
        expect(html).not.toContain('id="mission-mode"');
        expect(html).not.toContain('data-mission-action');
        expect(html).not.toContain('id="mission-timeline"');
    });

    test('uses quiet navigation rows and a lightweight artifact toolbar', () => {
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');
        const artifactsSource = fs.readFileSync(path.join(__dirname, 'js', 'artifacts.js'), 'utf8');

        expect(css).toContain('/* Quieter conversation navigation: list rows, not a stack of competing cards. */');
        expect(css).toContain('.session-item:hover {\n    border-color: color-mix');
        expect(css).toContain('transform: none;');
        expect(artifactsSource).toContain('class="toolbar-btn" type="button" title="Upload file"');
        expect(artifactsSource).toContain('class="toolbar-btn primary" type="button" title="Open files"');
        expect(artifactsSource).toContain('id="artifact-selected-count" class="selected-count" role="status" aria-live="polite" aria-atomic="true">0 files selected</span>');
        expect(artifactsSource).toContain("selectedCount === 1 ? 'file' : 'files'");
        expect(artifactsSource).toContain('background: transparent;\n                border: 0;');
    });

    test('conversation navigation keeps row actions outside the select button', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(uiSource).toContain('class="session-select-btn" type="button"');
        expect(uiSource).toContain('aria-label="Open conversation: ${this.escapeHtmlAttr(session.title || \'New Chat\')}"');
        expect(uiSource).toContain("${isActive ? ' aria-current=\"true\"' : ''}");
        expect(uiSource).toContain("this.sessionsList.querySelectorAll('.session-select-btn')");
        expect(uiSource).not.toContain('role="${isEditing ? \'group\' : \'button\'}"');
        expect(css).toContain('.session-select-btn:focus-visible');
        expect(css).toContain('.session-item:focus-within .session-actions');
        expect(html).toContain('css/styles.css?v=20260824c');
        expect(html).toContain('js/ui.js?v=20260824a');
    });

    test('keeps the default shell readable on desktop and mobile', () => {
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(css).toContain('--text-tertiary: #8192aa;');
        expect(css).toContain('background: linear-gradient(135deg, #2563eb, #1d4ed8);');
        expect(css).toContain('background-color: #1d4ed8;');
        expect(css).toContain('background: linear-gradient(135deg, #1d4ed8, #1e40af);');
        expect(css).toContain('min-height: auto;\n        justify-content: flex-start;');
        expect(css).toContain('#current-session-info {\n        max-width: 8.5rem;');
        expect(css).toContain('white-space: normal;\n        display: -webkit-box;');
        expect(css).toContain('-webkit-line-clamp: 2;');
    });

    test('keeps all starter actions compact on phone-sized screens', () => {
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.welcome-suggestion-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*gap: 0\.65rem;/);
        expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.suggestion-chip \{\s*min-height: 96px;\s*padding: 0\.75rem !important;/);
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

    test('composer tool picker keeps a light shell independent of dark chat presets', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');
        const lightTheme = css.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] || '';

        expect(html).toContain('css/styles.css?v=20260824c');
        expect(lightTheme).toContain('--tool-picker-panel-background: linear-gradient(180deg, rgba(255, 255, 255, 0.98)');
        expect(lightTheme).toContain('--tool-picker-panel-border: rgba(215, 226, 239, 0.96);');
        expect(lightTheme).not.toContain('--tool-picker-panel-background: var(--theme-dialog-background);');
        expect(lightTheme).not.toContain('--tool-picker-panel-border: var(--theme-dialog-border);');
        expect(css).toContain('[data-theme="light"] .tool-menu-panel {');
        expect(css).toContain('background: #f8fbff;');
    });

    test('composer tool trigger announces selected tool summary', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');

        expect(html).toContain('js/app.js?v=20260824a');
        expect(appSource).toContain("const triggerLabel = selectedCount > 0");
        expect(appSource).toContain("this.toolMenuBtn.setAttribute('aria-label', triggerLabel);");
        expect(appSource).toContain('this.toolMenuBtn.title = triggerLabel;');
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
        expect(html).toContain('<button type="button" class="mobile-chat-menu__action mobile-chat-menu__action--danger" data-mobile-menu-action="clear" aria-label="No messages to clear" title="No messages to clear" disabled>');
        expect(html).toContain('id="mobile-chat-menu-clear-value" class="mobile-chat-menu__action-value">No messages to clear</span>');
        expect(html).toContain('id="clear-chat-btn"');
        expect(html).toContain('aria-label="No messages to clear" disabled');
        expect(html).toContain('css/styles.css?v=20260824c');
        expect(html).toContain('js/tts-manager.js?v=20260628b');
        expect(html).toContain('js/ui.js?v=20260824a');
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
        expect(html).toContain('id="export-btn"');
        expect(html).toContain('id="export-chat-btn"');
        expect(html.match(/aria-haspopup="dialog" aria-expanded="false" aria-controls="export-modal"/g)).toHaveLength(2);
        expect(html).toContain('id="export-description"');
        expect(html).toContain('id="export-progress-bar"');
        expect(html).toContain('role="progressbar"');
        expect(html).toContain('aria-labelledby="export-progress-text"');
        expect(html).toContain('aria-describedby="export-progress-percent"');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain('this.lastFocusedElement = document.activeElement;');
        expect(uiSource).toContain("progressBar.setAttribute('aria-valuenow', String(normalizedPercent));");
        expect(uiSource).toContain("progressBar.setAttribute('aria-valuetext', `${normalizedMessage}, ${normalizedPercent} percent`);");
        expect(uiSource).toContain('this.closeExportModal();');
        expect(uiSource).toContain("document.querySelectorAll('[aria-controls=\"export-modal\"]')");
        expect(uiSource).toContain('this.syncExportModalTriggers(true);');
        expect(uiSource).toContain('this.syncExportModalTriggers(false);');
        expect(uiSource).toContain("if (!modal || modal.classList.contains('hidden'))");
        expect(uiSource).toContain('this.lastFocusedElement.focus();');
    });

    test('mobile sidebar trigger exposes its controlled region and open state', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="sidebar-toggle"');
        expect(html).toContain('aria-label="Open conversation sidebar"');
        expect(html).toContain('aria-controls="sidebar"');
        expect(html).toContain('aria-expanded="false"');
        expect(uiSource).toContain("const trigger = document.getElementById('sidebar-toggle')");
        expect(uiSource).toContain("const label = isExpanded ? 'Close conversation sidebar' : 'Open conversation sidebar'");
        expect(uiSource).toContain("trigger.setAttribute('aria-expanded', isExpanded ? 'true' : 'false')");
        expect(uiSource).toContain("trigger.setAttribute('aria-label', label)");
        expect(uiSource).toContain("trigger.setAttribute('title', label)");
    });

    test('conversation search triggers expose their dialog ownership and open state', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="search-toggle"');
        expect(html).toContain('id="search-btn"');
        expect(html.match(/aria-controls="search-bar"/g)).toHaveLength(2);
        expect(html.match(/aria-haspopup="dialog" aria-expanded="false" aria-controls="search-bar"/g)).toHaveLength(2);
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain("document.querySelectorAll('[aria-controls=\"search-bar\"]')");
        expect(uiSource).toContain('this.updateSearchTriggerState(true);');
        expect(uiSource).toContain('this.updateSearchTriggerState(false);');
    });

    test('import modal exposes instructions, status progress, and focus return hooks', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('aria-describedby="import-description"');
        expect(html).toContain('id="import-description"');
        expect(html).toContain('<button type="button" id="import-dropzone" class="import-dropzone w-full">');
        expect(html).not.toContain('<div id="import-dropzone" class="import-dropzone">');
        expect(html).toContain('id="import-progress" class="import-progress hidden mt-4" role="status"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('aria-busy="false"');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain('this.closeImportModal({ restoreFocus: false });');
        expect(uiSource).toContain("progress?.setAttribute('aria-busy', 'true');");
        expect(uiSource).toContain("progress?.setAttribute('aria-busy', 'false');");
        expect(uiSource).toContain('restoreFocus && this.lastFocusedElement');
        expect(uiSource).toContain('this.lastFocusedElement.focus();');
    });

    test('workload modal exposes dialog semantics and restores launcher focus', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');

        expect(html).toContain('id="workload-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="workload-modal-title" aria-hidden="true"');
        expect(html).toContain('data-close-workload-modal="true" aria-hidden="true"');
        expect(html).toContain('type="button" class="btn-icon" id="close-workload-modal-btn"');
        expect(appSource).toContain('this.workloadModalReturnFocus = document.activeElement;');
        expect(appSource).toContain("this.workloadModal.setAttribute('aria-hidden', 'false');");
        expect(appSource).toContain('if (returnFocus?.isConnected && typeof returnFocus.focus === \'function\')');
        expect(appSource).toContain('returnFocus.focus();');
        expect(html).toContain('js/app.js?v=20260824a');
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

    test('assistant settings trigger identifies the dialog it opens', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="model-selector-dropdown" class="model-selector-dropdown hidden" role="dialog"');
        expect(html).toContain('id="model-selector-btn"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-controls="model-selector-dropdown"');
        expect(uiSource).toContain("dropdown.setAttribute('aria-hidden', 'false');");
        expect(uiSource).toContain('this.updateModelSelectorAria(true);');
        expect(uiSource).toContain("dropdown.setAttribute('aria-hidden', 'true');");
        expect(uiSource).toContain('this.updateModelSelectorAria(false);');
    });

    test('compact model indicator names its current model and assistant settings dialog', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="input-model-indicator"');
        expect(html).toContain('aria-label="Current model: GPT-5.4 Mini. Open assistant settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="model-selector-dropdown"');
        expect(uiSource).toContain("['model-selector-btn', 'input-model-indicator'].forEach((buttonId) => {");
        expect(uiSource).toContain("inputIndicator.setAttribute('aria-label', `Current model: ${displayName}. Open assistant settings`);");
        expect(html).toContain('js/ui.js?v=20260824a');
    });

    test('media source selector exposes roving keyboard radio behavior', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('class="image-source-selector" role="radiogroup" aria-label="Content type"');
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

        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain("modal.setAttribute('aria-describedby', 'shortcuts-description');");
        expect(uiSource).toContain('<div class="modal-overlay" aria-hidden="true" onclick="uiHelpers.closeShortcutsModal()"></div>');
        expect(uiSource).toContain('<button type="button" class="btn-icon" onclick="uiHelpers.closeShortcutsModal()" aria-label="Close keyboard shortcuts help">');
        expect(uiSource).toContain('id="shortcuts-description"');
        expect(uiSource).toContain('Common workspace shortcuts and slash commands for the current chat.');
        expect(uiSource).toContain('if (!modal) {\n            return;\n        }');
    });

    test('toast notifications expose keyboard-safe dismissal and reduced motion handling', () => {
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(uiSource).toContain("toast.setAttribute('aria-atomic', 'true');");
        expect(uiSource).toContain('<button type="button" class="toast-close" aria-label="Dismiss notification">');
        expect(uiSource).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches");
        expect(css).toContain('.toast-close:focus-visible');
        expect(css).toContain('box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 34%, transparent);');
        expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n    .toast {');
    });

    test('header connection status announces visible state changes', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');

        expect(html).toContain('id="connection-status" class="connection-status full-shell-control connecting"');
        expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('aria-label="Backend connection status: Connecting"');
        expect(html).toContain('id="connection-indicator" class="connection-indicator checking" aria-hidden="true"');
        expect(html).toContain('js/app.js?v=20260824a');
        expect(appSource).toContain("statusEl.classList.remove('connected', 'connecting', 'disconnected');");
        expect(appSource).toContain("indicator.setAttribute('aria-hidden', 'true');");
        expect(appSource).toContain("statusEl.setAttribute('aria-label', `Backend connection status: ${statusLabel}`);");
        expect(appSource).toContain("statusEl.setAttribute('title', `Backend connection status: ${statusLabel}`);");
    });

    test('workloads panel trigger announces the current open-close action', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');

        expect(html).toContain('id="workloads-btn"');
        expect(html).toContain('title="Open agent workloads"');
        expect(html).toContain('aria-label="Open agent workloads"');
        expect(html).toContain('aria-controls="workloads-panel"');
        expect(html).toContain('js/app.js?v=20260824a');
        expect(appSource).toContain("const label = isOpen ? 'Close agent workloads' : 'Open agent workloads';");
        expect(appSource).toContain("this.workloadsBtn?.setAttribute('aria-label', label);");
        expect(appSource).toContain("this.workloadsBtn?.setAttribute('title', label);");
    });

    test('command palette exposes active listbox option while searching', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="command-input"');
        expect(html).toContain('role="combobox"');
        expect(html).toContain('aria-controls="command-results"');
        expect(html).toContain('aria-autocomplete="list"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain("input.setAttribute('aria-expanded', 'true');");
        expect(uiSource).toContain("input?.setAttribute('aria-expanded', 'false');");
        expect(uiSource).toContain('syncCommandResultAccessibility()');
        expect(uiSource).toContain("commandInput.setAttribute('aria-activedescendant', selectedItem.id);");
        expect(uiSource).toContain("item.setAttribute('aria-selected', item === selectedItem ? 'true' : 'false');");
        expect(uiSource).toContain("commandInput.removeAttribute('aria-activedescendant');");
    });

    test('message search exposes empty results and disables dead navigation', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(html).toContain('id="search-previous-btn"');
        expect(html).toContain('id="search-next-btn"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain("hasQuery ? 'No matches' : ''");
        expect(uiSource).toContain('const navigationDisabled = resultCount < 2;');
        expect(uiSource).toContain("previousButton?.toggleAttribute('disabled', navigationDisabled);");
        expect(uiSource).toContain("nextButton?.toggleAttribute('disabled', navigationDisabled);");
        expect(uiSource).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true");
        expect(uiSource).toContain("behavior: prefersReducedMotion ? 'auto' : 'smooth'");
        expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n    .scroll-smooth { scroll-behavior: auto; }');
    });

    test('composer input toggle exposes its controlled expanded state', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="input-toggle-btn"');
        expect(html).toContain('aria-controls="input-area"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('aria-label="Hide input area"');
        expect(html).toContain('<span class="input-toggle-tooltip">Hide Input</span>');
        expect(html).toContain('css/styles.css?v=20260824c');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain('syncInputAreaToggleState(isHidden)');
        expect(uiSource).toContain("toggleBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');");
        expect(uiSource).toContain("toggleBtn.setAttribute('aria-label', label);");
        expect(uiSource).toContain('toggleTooltip.textContent = tooltip;');
    });

    test('composer input toggle tooltip is visible for keyboard focus', () => {
        const css = fs.readFileSync(path.join(__dirname, 'css', 'styles.css'), 'utf8');

        expect(css).toContain('.input-toggle-btn:focus-visible');
        expect(css).toContain('outline: 2px solid var(--accent);');
        expect(css).toContain('.input-toggle-btn:hover .input-toggle-tooltip,\n.input-toggle-btn:focus-visible .input-toggle-tooltip');
        expect(css).toContain('visibility: visible;');
    });

    test('sound volume slider exposes readable range text', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="sound-volume-range"');
        expect(html).toContain('aria-describedby="sound-volume-hint"');
        expect(html).toContain('aria-valuetext="68 percent"');
        expect(html).toContain('id="sound-volume-hint"');
        expect(uiSource).toContain("range.setAttribute('aria-valuetext', `${percent} percent`);");
    });

    test('assistant sound toggles announce current on-off action', () => {
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(uiSource).toContain("'Robot sound cues on. Press to turn off.'");
        expect(uiSource).toContain("'Robot sound cues off. Press to turn on.'");
        expect(uiSource).toContain("'Menu motion sounds on. Press to turn off.'");
        expect(uiSource).toContain("'Menu motion sounds off. Press to turn on.'");
        expect(uiSource).toContain("button.setAttribute('aria-label', stateLabel);");
        expect(uiSource).toContain('button.title = stateLabel;');
    });

    test('voice autoplay toggle announces the current on-off action', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="tts-autoplay-btn"');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain("'Read replies aloud on. Press to turn off.'");
        expect(uiSource).toContain("'Read replies aloud off. Press to turn on.'");
        expect(uiSource).toContain("button.setAttribute('aria-label', stateLabel);");
    });

    test('theme gallery trigger exposes dialog ownership and open state', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="theme-toggle"');
        expect(html).toContain('aria-controls="theme-gallery-modal"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(uiSource).toContain('isThemeGalleryOpen()');
        expect(uiSource).toContain('setThemeGalleryTriggerExpanded(expanded)');
        expect(uiSource).toContain('this.setThemeGalleryTriggerExpanded(true);');
        expect(uiSource).toContain('this.setThemeGalleryTriggerExpanded(false);');
    });

    test('both focus mode controls expose their synchronized toggle state', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');

        expect(html).toContain('id="minimalist-toggle-sidebar" class="btn-secondary w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-medium transition-all" aria-label="Enter minimalist mode" title="Toggle minimalist mode" aria-pressed="false"');
        expect(html).toContain('id="minimalist-toggle-btn" class="btn-icon minimalist-toggle-btn px-3 rounded-lg" title="Enter minimalist mode" aria-label="Enter minimalist mode" aria-pressed="false"');
        expect(uiSource).toContain("sidebarButton.setAttribute('aria-pressed', isMinimal ? 'true' : 'false');");
        expect(uiSource).toContain("button.setAttribute('aria-pressed', isMinimal ? 'true' : 'false');");
    });

    test('content studio exposes a plan-first podcast launch kit workflow', () => {
        const html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
        const uiSource = fs.readFileSync(path.join(__dirname, 'js', 'ui.js'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
        const apiSource = fs.readFileSync(path.join(__dirname, 'js', 'api.js'), 'utf8');

        expect(html).toContain('<h3 id="image-modal-title">Content Studio</h3>');
        expect(html).toContain('Podcast launch kit');
        expect(html).toContain('data-studio-step="brief"');
        expect(html).toContain('id="podcast-brand-kit-select"');
        expect(html).toContain('id="podcast-review-panel"');
        expect(html).toContain('js/api.js?v=20260717a');
        expect(html).toContain('js/ui.js?v=20260824a');
        expect(html).toContain('js/app.js?v=20260824a');
        expect(uiSource).toContain('renderPodcastLaunchKitReview(campaign)');
        expect(uiSource).toContain('renderContentStudioCampaignMessage(message)');
        expect(uiSource).toContain("'Building the production plan'");
        expect(uiSource).toContain("app.approvePodcastLaunchKit('${this.escapeHtmlAttr(campaign.id)}')");
        expect(appSource).toContain("approvePodcastLaunchKit(campaignId = '')");
        expect(appSource).toContain("status: 'planning'");
        expect(appSource).toContain('startPodcastLaunchKitProgressPolling(campaignId, sessionId, messageId)');
        expect(appSource).toContain('uiHelpers.closeImageModal();');
        expect(appSource).toContain('retryPodcastLaunchKitStage(campaignId, stage)');
        expect(apiSource).toContain("requestContentStudio('/launch-kits/plan'");
        expect(apiSource).toContain('requestContentStudio(`/campaigns/${encodeURIComponent(id)}`)');
    });
});
