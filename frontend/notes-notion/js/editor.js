/**
 * Editor Module - Core block-based editor
 * Enhanced with undo/redo, improved drag-and-drop, and better features
 */

const Editor = (function() {
    let currentPage = null;
    let editorContainer = null;
    let isComposing = false;
    let saveTimeout = null;
    let inlineToolbar = null;
    let mentionPopup = null;
    
    // Page history for undo/redo
    const history = {
        stack: [],
        index: -1,
        maxSize: 50,
        isUndoing: false
    };

    function normalizeBlocks(blocks = []) {
        return blocks.map((block) => ({
            ...block,
            ...(block.type === 'callout'
                ? (() => {
                    const normalizedCallout = window.Blocks?.normalizeCalloutContent?.(block.content, block.icon || '!');
                    return normalizedCallout ? {
                        content: normalizedCallout,
                        icon: normalizedCallout.icon
                    } : {};
                })()
                : {}),
            ...(block.type === 'database' && window.Blocks?.normalizeDatabaseContent
                ? { content: window.Blocks.normalizeDatabaseContent(block.content || {}) }
                : {}),
            children: normalizeBlocks(Array.isArray(block.children) ? block.children : []),
            formatting: block.formatting || {},
        }));
    }

    function extractBlockText(block) {
        if (!block) return '';

        if (typeof block.content === 'string') {
            return block.content;
        }

        if (block.content && typeof block.content === 'object') {
            if (block.type === 'todo') return block.content.text || '';
            if (block.type === 'callout') return block.content.text || '';
            if (block.type === 'ai') return block.content.prompt || block.content.result || '';
            if (block.type === 'image' || block.type === 'ai_image') {
                return block.content.caption || block.content.prompt || block.content.url || '';
            }
            if (block.type === 'bookmark') {
                return block.content.title || block.content.description || block.content.url || '';
            }
            if (block.type === 'database') {
                const database = window.Blocks?.normalizeDatabaseContent
                    ? window.Blocks.normalizeDatabaseContent(block.content)
                    : block.content;
                return Array.isArray(database?.rows) ? database.rows.flat().join(' ') : '';
            }
            if (block.type === 'chart') {
                if (Array.isArray(block.content.labels) && Array.isArray(block.content.values)) {
                    return block.content.labels.map((label, index) =>
                        `${label} ${block.content.values[index] ?? ''}`
                    ).join(' ');
                }
                return block.content.title || '';
            }
            if (typeof block.content.text === 'string') return block.content.text;
            if (typeof block.content.prompt === 'string') return block.content.prompt;
            if (typeof block.content.result === 'string') return block.content.result;
            if (typeof block.content.url === 'string') return block.content.url;
        }

        return '';
    }

    function isLikelyUrl(value) {
        return /^https?:\/\//i.test(String(value || '').trim());
    }

    function createContentForType(type, sourceText = '', existingContent = null) {
        const text = typeof sourceText === 'string' ? sourceText : '';
        const existing = existingContent && typeof existingContent === 'object' ? existingContent : null;

        switch (type) {
            case 'todo':
                return {
                    text,
                    checked: Boolean(existing?.checked)
                };
            case 'callout':
                return window.Blocks?.normalizeCalloutContent?.({
                    ...existing,
                    text
                }, existing?.icon || '!')
                    || {
                        text,
                        icon: existing?.icon || '!'
                    };
            case 'code':
                return {
                    language: existing?.language || 'plain',
                    text
                };
            case 'math':
                return {
                    text,
                    displayMode: existing?.displayMode !== false
                };
            case 'mermaid':
                return {
                    text,
                    diagramType: existing?.diagramType || 'flowchart',
                    _showEditor: !text.trim()
                };
            case 'ai':
                return {
                    prompt: text,
                    result: existing?.result || null,
                    model: existing?.model || null
                };
            case 'image':
                return {
                    url: existing?.url || existing?.imageUrl || existing?._resolvedImageUrl || existing?.downloadUrl || (isLikelyUrl(text) ? text : ''),
                    caption: existing?.caption || existing?.prompt || (isLikelyUrl(text) ? '' : text)
                };
            case 'ai_image':
                return {
                    ...existing,
                    prompt: text || existing?.prompt || '',
                    imageUrl: existing?.imageUrl || existing?.url || null,
                    model: existing?.model || null,
                    size: existing?.size || 'auto',
                    quality: existing?.quality || 'auto',
                    style: existing?.style || null,
                    status: existing?.status || ((existing?.imageUrl || existing?.url) ? 'done' : 'pending'),
                    source: existing?.source || (existing?.url ? 'upload' : 'ai'),
                    _resolvedImageUrl: existing?._resolvedImageUrl || (existing?.url && !String(existing.url).startsWith('asset://') ? existing.url : null),
                    imageAssetId: existing?.imageAssetId || null,
                    artifactId: existing?.artifactId || null,
                    downloadUrl: existing?.downloadUrl || existing?.imageUrl || existing?.url || null,
                };
            case 'bookmark':
                return {
                    url: existing?.url || existing?.imageUrl || existing?.downloadUrl || text,
                    title: existing?.title || '',
                    description: existing?.description || '',
                    favicon: existing?.favicon || '',
                    image: existing?.image || ''
                };
            case 'database':
                return (Array.isArray(existing?.columns) || Array.isArray(existing?.rows)) ? existing : {
                    columns: ['Name', 'Status', 'Notes'],
                    rows: text.trim() ? [[text.trim(), '', '']] : [],
                    sortColumn: null,
                    sortDirection: 'asc'
                };
            case 'chart':
                return (Array.isArray(existing?.labels) || Array.isArray(existing?.values) || Array.isArray(existing?.data) || Array.isArray(existing?.rows)) ? existing : {
                    title: text.trim() || 'Chart',
                    chartType: 'bar',
                    labels: ['Item 1', 'Item 2', 'Item 3'],
                    values: [3, 5, 2],
                    unit: ''
                };
            case 'divider':
                return '';
            default:
                return text;
        }
    }

    function getBlockTypeLabel(type) {
        const typeMeta = window.Blocks?.getBlockTypes?.()?.[type];
        if (typeMeta?.name) {
            return typeMeta.name;
        }

        return String(type || '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    function createBlockActionButton({ action, title, svg, className = '' }) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `block-action ${className}`.trim();
        button.dataset.action = action;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.innerHTML = svg;
        return button;
    }

    function openBlockTypeMenu(blockId, eventOrPoint = {}) {
        if (!window.SlashMenu) {
            return;
        }

        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        const rect = blockEl?.getBoundingClientRect?.();
        const point = {
            x: eventOrPoint.clientX || (rect ? rect.left + 40 : 24),
            y: eventOrPoint.clientY || (rect ? rect.bottom : 80),
        };

        window.SlashMenu.show(point.x, point.y, blockId);
        window.SlashMenu.setCallback((type) => {
            const conversionInfo = getBlockConversionInfo(blockId, type);
            if (conversionInfo?.requiresConfirmation) {
                const confirmed = window.confirm(conversionInfo.message || 'Convert this block and drop unsupported content?');
                if (!confirmed) {
                    return;
                }
            }
            convertBlockType(blockId, type);
        });
    }

    function createBlockActions(block) {
        const actions = document.createElement('div');
        actions.className = 'block-actions';

        const icons = {
            edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
            type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/><path d="m16 15 2 2 3-4"/></svg>',
            up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
            down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
            delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>',
        };

        [
            { action: 'edit', title: 'Edit block', svg: icons.edit },
            { action: 'turn-into', title: 'Change block type', svg: icons.type },
            { action: 'move-up', title: 'Move block up', svg: icons.up },
            { action: 'move-down', title: 'Move block down', svg: icons.down },
            { action: 'delete', title: 'Delete block', svg: icons.delete, className: 'block-action-danger' },
        ].forEach((definition) => {
            actions.appendChild(createBlockActionButton(definition));
        });

        actions.addEventListener('click', (event) => {
            const button = event.target.closest('.block-action');
            if (!button) return;

            event.preventDefault();
            event.stopPropagation();

            switch (button.dataset.action) {
                case 'edit':
                    focusBlock(block.id);
                    break;
                case 'turn-into': {
                    openBlockTypeMenu(block.id, event);
                    break;
                }
                case 'move-up':
                    moveBlockUp(block.id);
                    break;
                case 'move-down':
                    moveBlockDown(block.id);
                    break;
                case 'delete':
                    deleteBlock(block.id);
                    break;
                default:
                    break;
            }
        });

        return actions;
    }

    function getBlockConversionInfo(blockId, newType, newContent = null) {
        const block = getBlock(blockId);
        if (!block || block.type === newType) {
            return {
                requiresConfirmation: false,
                warnings: [],
                message: ''
            };
        }

        const sourceText = typeof newContent === 'string'
            ? newContent
            : extractBlockText(block);
        const existing = block.content && typeof block.content === 'object' ? block.content : null;
        const warnings = [];

        if (newType === 'divider' && sourceText.trim()) {
            warnings.push('the current text content');
        }

        switch (block.type) {
            case 'todo':
                if (newType !== 'todo' && existing?.checked) {
                    warnings.push('the checkbox state');
                }
                break;
            case 'code':
                if (newType !== 'code' && existing?.language && existing.language !== 'plain') {
                    warnings.push('the code language');
                }
                break;
            case 'math':
                if (newType !== 'math') {
                    warnings.push('math formatting');
                }
                break;
            case 'mermaid':
                if (newType !== 'mermaid') {
                    warnings.push('the diagram configuration');
                }
                break;
            case 'ai':
                if (newType !== 'ai') {
                    if (existing?.prompt) warnings.push('the AI prompt');
                    if (existing?.result) warnings.push('the generated result history');
                }
                break;
            case 'image':
                if (newType !== 'image') {
                    if (existing?.url) warnings.push('the image source');
                    if (existing?.caption) warnings.push('the image caption formatting');
                }
                break;
            case 'ai_image':
                if (newType !== 'ai_image') {
                    warnings.push('the generated image asset and settings');
                }
                break;
            case 'bookmark':
                if (newType !== 'bookmark') {
                    warnings.push('the bookmark metadata');
                }
                break;
            case 'database':
                if (newType !== 'database') {
                    warnings.push('the database rows and columns');
                }
                break;
            case 'chart':
                if (newType !== 'chart') {
                    warnings.push('the chart data and configuration');
                }
                break;
            default:
                break;
        }

        const uniqueWarnings = [...new Set(warnings)];
        const targetLabel = getBlockTypeLabel(newType);

        return {
            requiresConfirmation: uniqueWarnings.length > 0,
            warnings: uniqueWarnings,
            message: uniqueWarnings.length
                ? `Turn this block into ${targetLabel}? This will drop ${uniqueWarnings.join(', ')}. Plain text content will be kept where possible.`
                : ''
        };
    }

    function findBlockLocation(blockId, blocks = currentPage?.blocks || [], parent = null) {
        for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index];
            if (block.id === blockId) {
                return { block, index, siblings: blocks, parent };
            }

            if (block.children?.length) {
                const found = findBlockLocation(blockId, block.children, block);
                if (found) return found;
            }
        }

        return null;
    }

    function getFlattenedBlocks(options = {}) {
        const { includeCollapsed = false } = options;
        const entries = [];

        function walk(blocks, parent = null, depth = 0) {
            blocks.forEach((block) => {
                entries.push({ block, parent, depth });

                if (!block.children?.length) {
                    return;
                }

                if (!includeCollapsed && block.type === 'toggle' && block.expanded === false) {
                    return;
                }

                walk(block.children, block, depth + 1);
            });
        }

        if (currentPage?.blocks?.length) {
            walk(currentPage.blocks);
        }

        return entries;
    }

    function blockContainsDescendant(block, targetId) {
        if (!block?.children?.length) return false;

        return block.children.some((child) => {
            if (child.id === targetId) return true;
            return blockContainsDescendant(child, targetId);
        });
    }

    function getHeadingLevel(block) {
        const match = String(block?.type || '').match(/^heading_(\d+)$/);
        return match ? Number(match[1]) : null;
    }

    function getOutlineHeadings() {
        const entries = getFlattenedBlocks({ includeCollapsed: true });
        return entries.filter((entry) => entry.block.type.startsWith('heading_'));
    }

    function getEditableBlockInput(blockEl) {
        if (!blockEl) return null;
        return blockEl.querySelector('.block-input, [contenteditable="true"]');
    }

    function getBlockFocusTarget(blockEl) {
        if (!blockEl) return null;

        return blockEl.querySelector(
            '.block-input, textarea, input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]'
        );
    }

    function focusEditableElement(target, position = 'end') {
        if (!target) return;

        target.focus();

        if (typeof target.setSelectionRange === 'function') {
            const value = target.value || '';
            const offset = position === 'start' ? 0 : value.length;
            target.setSelectionRange(offset, offset);
            return;
        }

        if (!target.isContentEditable) {
            return;
        }

        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(target);
        range.collapse(position === 'start');
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function syncBlockInput(blockId, input, options = {}) {
        if (!input || !input.isConnected) return;

        const blockEl = input.closest('.block');
        if (!blockEl || blockEl.dataset.blockId !== blockId) return;

        updateBlockContent(blockId, input, options);
    }

    function flushActiveBlockContent(options = {}) {
        const activeElement = document.activeElement;
        if (!activeElement) return;

        const blockEl = activeElement.closest?.('.block');
        const input = getEditableBlockInput(blockEl);
        const blockId = blockEl?.dataset?.blockId;

        if (!blockId || !input) return;
        syncBlockInput(blockId, input, options);
    }

    function updateWorkspacePanel() {
        const outlineEl = document.getElementById('page-outline-list');
        const outlineCountEl = document.getElementById('page-outline-count');
        if (!outlineEl) return;

        const headings = getOutlineHeadings();
        if (outlineCountEl) {
            outlineCountEl.textContent = String(headings.length);
        }

        if (headings.length === 0) {
            outlineEl.innerHTML = '<div class="outline-empty">Add headings to see an outline.</div>';
            return;
        }

        outlineEl.innerHTML = '';
        headings.forEach((entry) => {
            const level = parseInt(entry.block.type.split('_')[1] || '1', 10);
            const headingText = extractBlockText(entry.block) || 'Untitled section';
            const leadLabel = getOutlineLeadLabel(headingText);
            const button = document.createElement('button');
            button.className = `outline-item outline-item-level-${level}`;
            button.dataset.blockId = entry.block.id;
            button.innerHTML = `
                <span class="outline-item-badge" aria-hidden="true">${escapeHtml(leadLabel)}</span>
                <span class="outline-item-text">${escapeHtml(headingText)}</span>
            `;
            button.addEventListener('click', () => {
                const blockEl = document.querySelector(`.block[data-block-id="${entry.block.id}"]`);
                if (blockEl) {
                    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
                    blockEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
                }
                focusBlock(entry.block.id, 'start');
            });
            outlineEl.appendChild(button);
        });
    }

    function getOutlineLeadLabel(text = '') {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';

        const explicitLead = normalized.match(/^([A-Za-z0-9][A-Za-z0-9 .]{0,13}?)(?:[:\-–—|])/);
        if (explicitLead?.[1]) {
            return explicitLead[1].trim();
        }

        const numberedLead = normalized.match(/^(\d+(?:\.\d+)*\.?)/);
        if (numberedLead?.[1]) {
            return numberedLead[1].replace(/\.$/, '');
        }

        const firstWord = normalized.split(/\s+/)[0] || '';
        return firstWord.length > 10 ? firstWord.slice(0, 9) + '.' : firstWord;
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function looksLikeStructuredMarkdownPaste(text = '') {
        const normalized = String(text || '').trim();
        if (!normalized) {
            return false;
        }

        if (/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i.test(normalized)) {
            return true;
        }

        if (normalized.includes('\n') && (
            /^#{1,3}\s+/m.test(normalized) ||
            /^[>*-]\s+/m.test(normalized) ||
            /^\d+\.\s+/m.test(normalized) ||
            /^```/m.test(normalized)
        )) {
            return true;
        }

        return false;
    }

    function normalizeStructuredPasteText(text = '') {
        return String(text || '')
            .replace(/\r\n/g, '\n')
            .split('\n')
            .filter((line) => !/^\s*\+\s*$/.test(line))
            .join('\n')
            .trim();
    }

    function isReplaceableEmptyBlock(block = null) {
        if (!block || block.type !== 'text') {
            return false;
        }

        if (Array.isArray(block.children) && block.children.length > 0) {
            return false;
        }

        return !extractBlockText(block).trim();
    }

    function getPasteTargetBlockId() {
        const selectedBlockId = window.Selection?.getSelectedBlockId?.();
        if (selectedBlockId) {
            return selectedBlockId;
        }

        const activeElement = document.activeElement;
        const blockEl = activeElement?.closest?.('.block');
        return blockEl?.dataset?.blockId || null;
    }

    function applyStructuredMarkdownPaste(text = '') {
        const normalizedText = normalizeStructuredPasteText(text);
        if (!normalizedText || !window.ImportExport?.importFromMarkdown) {
            return false;
        }

        const importedPage = window.ImportExport.importFromMarkdown(normalizedText);
        const importedBlocks = Array.isArray(importedPage?.blocks)
            ? importedPage.blocks.filter((block) => {
                if (!block || !block.type) {
                    return false;
                }

                if (block.type === 'divider') {
                    return true;
                }

                return Boolean(extractBlockText(block).trim())
                    || ['image', 'ai_image', 'bookmark', 'database'].includes(block.type);
            })
            : [];

        if (importedBlocks.length === 0) {
            return false;
        }

        const targetBlockId = getPasteTargetBlockId();
        const targetBlock = targetBlockId ? getBlock(targetBlockId) : null;
        const inserted = isReplaceableEmptyBlock(targetBlock)
            ? replaceBlockWithBlocks(targetBlockId, importedBlocks)
            : insertBlocksAfter(targetBlockId, importedBlocks);

        if (!inserted.length) {
            return false;
        }

        const focusBlockId = inserted[0]?.id || targetBlockId;
        if (focusBlockId) {
            focusBlock(focusBlockId);
        }

        return true;
    }
    
    /**
     * Initialize the editor
     */
    function init() {
        editorContainer = document.getElementById('editor');
        if (!editorContainer) return;
        
        setupEventListeners();
        setupInlineToolbar();
        setupMentions();
        setupUndoRedo();
    }
    
    /**
     * Setup undo/redo keyboard shortcuts
     */
    function setupUndoRedo() {
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    redo();
                } else {
                    undo();
                }
            }
            
            if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
                e.preventDefault();
                redo();
            }
        });
    }
    
    /**
     * Save current state to history
     */
    function saveToHistory() {
        if (history.isUndoing || !currentPage) return;
        
        const state = JSON.stringify(currentPage);
        
        // Don't save if same as last state
        if (history.index >= 0 && history.stack[history.index] === state) {
            return;
        }
        
        // Remove any redo states
        history.stack = history.stack.slice(0, history.index + 1);
        
        // Add new state
        history.stack.push(state);
        
        // Limit history size
        if (history.stack.length > history.maxSize) {
            history.stack.shift();
        } else {
            history.index++;
        }
    }
    
    /**
     * Undo last change
     */
    function undo() {
        if (history.index <= 0) {
            showToast('Nothing to undo', 'info');
            return;
        }
        
        history.isUndoing = true;
        history.index--;
        
        const state = JSON.parse(history.stack[history.index]);
        currentPage = state;
        
        // Update storage without triggering history
        Storage.updatePage(currentPage.id, currentPage);
        
        // Refresh editor
        refreshEditor();
        
        showToast('Undo', 'info');
        history.isUndoing = false;
    }
    
    /**
     * Redo last undone change
     */
    function redo() {
        if (history.index >= history.stack.length - 1) {
            showToast('Nothing to redo', 'info');
            return;
        }
        
        history.isUndoing = true;
        history.index++;
        
        const state = JSON.parse(history.stack[history.index]);
        currentPage = state;
        
        // Update storage without triggering history
        Storage.updatePage(currentPage.id, currentPage);
        
        // Refresh editor
        refreshEditor();
        
        showToast('Redo', 'info');
        history.isUndoing = false;
    }
    
    /**
     * Setup global event listeners
     */
    function setupEventListeners() {
        // Handle slash commands
        document.addEventListener('slash-command', (e) => {
            const { type, blockId } = e.detail;
            saveToHistory();
            convertBlockType(blockId, type);
        });
        
        // Handle paste
        editorContainer.addEventListener('paste', handlePaste);
        
        // Handle composition (for IME input)
        editorContainer.addEventListener('compositionstart', () => {
            isComposing = true;
        });
        
        editorContainer.addEventListener('compositionend', () => {
            isComposing = false;
        });
        
        // Global click to hide inline toolbar
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.inline-toolbar') && !e.target.closest('.block-input')) {
                hideInlineToolbar();
            }
            if (!e.target.closest('.mention-popup')) {
                hideMentionPopup();
            }
        });
    }
    
    /**
     * Setup inline formatting toolbar
     */
    function setupInlineToolbar() {
        // Toolbar is created dynamically when text is selected
    }
    
    /**
     * Show inline formatting toolbar
     */
    function showInlineToolbar(range) {
        hideInlineToolbar();
        
        const rect = range.getBoundingClientRect();
        const toolbar = document.createElement('div');
        toolbar.className = 'inline-toolbar';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Inline text formatting');
        toolbar.innerHTML = `
            <button type="button" class="inline-toolbar-btn" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold" aria-keyshortcuts="Control+B">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>
                    <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>
                </svg>
            </button>
            <button type="button" class="inline-toolbar-btn" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic" aria-keyshortcuts="Control+I">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="19" y1="4" x2="10" y2="4"></line>
                    <line x1="14" y1="20" x2="5" y2="20"></line>
                    <line x1="15" y1="4" x2="9" y2="20"></line>
                </svg>
            </button>
            <button type="button" class="inline-toolbar-btn" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline" aria-keyshortcuts="Control+U">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"></path>
                    <line x1="4" y1="21" x2="20" y2="21"></line>
                </svg>
            </button>
            <button type="button" class="inline-toolbar-btn" data-cmd="strikethrough" title="Strikethrough" aria-label="Strikethrough">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17.3 4.9c-2.3-.6-4.4-1-6.2-.9-2.7.1-5.3.8-5.3 3.2 0 1.5 1.1 2.4 3 3.1"></path>
                    <path d="M12 21c3.4 0 6-1.2 6-3.5 0-1.6-.8-2.6-2.4-3.3"></path>
                    <line x1="4" y1="11" x2="20" y2="11"></line>
                </svg>
            </button>
            <button type="button" class="inline-toolbar-btn" data-cmd="hiliteColor" data-value="#fef08a" title="Highlight" aria-label="Yellow highlight">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="m9 11-6 6v3h3l6-6"></path>
                    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0L7.4 9.4a2 2 0 0 1 0-2.8L12 2"></path>
                    <path d="m14 4 6 6"></path>
                </svg>
            </button>
            <button type="button" class="inline-toolbar-swatch" data-cmd="hiliteColor" data-value="#bbf7d0" title="Green highlight" aria-label="Green highlight" style="--swatch-color: #bbf7d0;"></button>
            <button type="button" class="inline-toolbar-swatch" data-cmd="hiliteColor" data-value="#bfdbfe" title="Blue highlight" aria-label="Blue highlight" style="--swatch-color: #bfdbfe;"></button>
            <button type="button" class="inline-toolbar-swatch" data-cmd="hiliteColor" data-value="#ddd6fe" title="Purple highlight" aria-label="Purple highlight" style="--swatch-color: #ddd6fe;"></button>
            <button type="button" class="inline-toolbar-swatch" data-cmd="hiliteColor" data-value="#fbcfe8" title="Pink highlight" aria-label="Pink highlight" style="--swatch-color: #fbcfe8;"></button>
            <div class="inline-toolbar-divider"></div>
            <button type="button" class="inline-toolbar-btn" data-cmd="createLink" title="Link (Ctrl+K)" aria-label="Create link" aria-keyshortcuts="Control+K">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
            </button>
            <button type="button" class="inline-toolbar-btn" data-cmd="removeFormat" title="Clear Formatting" aria-label="Clear formatting">
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 7v4a1 1 0 0 0 1 1h3"></path>
                    <path d="M7 7v10"></path>
                    <path d="M10 8v8a1 1 0 0 0 1 1h2"></path>
                    <path d="M14 8v8"></path>
                    <path d="M17 7v4a1 1 0 0 0 1 1h3"></path>
                    <path d="M21 7v10"></path>
                    <line x1="3" y1="21" x2="21" y2="3"></line>
                </svg>
            </button>
        `;
        
        // Position toolbar above selection
        const toolbarHeight = 40;
        const toolbarWidth = 300;
        let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);
        let top = rect.top - toolbarHeight - 8;
        
        // Keep on screen
        if (left < 10) left = 10;
        if (left + toolbarWidth > window.innerWidth - 10) {
            left = window.innerWidth - toolbarWidth - 10;
        }
        if (top < 10) {
            top = rect.bottom + 8;
        }
        
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
        
        // Handle button clicks
        toolbar.querySelectorAll('.inline-toolbar-btn, .inline-toolbar-swatch').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const cmd = btn.dataset.cmd;
                applyInlineFormat(cmd, btn.dataset.value || null);
            });
        });
        
        document.body.appendChild(toolbar);
        inlineToolbar = toolbar;
    }
    
    /**
     * Hide inline toolbar
     */
    function hideInlineToolbar() {
        if (inlineToolbar) {
            inlineToolbar.remove();
            inlineToolbar = null;
        }
    }
    
    /**
     * Apply inline formatting
     */
    function applyInlineFormat(cmd, value = null) {
        if (cmd === 'hiliteColor') {
            document.execCommand('styleWithCSS', false, false);
        }
        document.execCommand(cmd, false, value);
        
        // Update button states
        if (inlineToolbar) {
            inlineToolbar.querySelectorAll('.inline-toolbar-btn').forEach(btn => {
                const command = btn.dataset.cmd;
                if (command !== 'createLink' && command !== 'removeFormat') {
                    btn.classList.toggle('active', document.queryCommandState(command));
                }
            });
        }
        
        // Trigger save
        autoSave();
    }
    
    /**
     * Setup @ mentions
     */
    function setupMentions() {
        // Handled in block input keyup
    }
    
    /**
     * Show mention popup
     */
    function showMentionPopup(query, x, y, blockId) {
        hideMentionPopup();
        
        const popup = document.createElement('div');
        popup.className = 'mention-popup';
        
        // Get pages and users as mention targets
        const pages = Storage.getPages().slice(0, 5);
        const mentions = [
            { type: 'date', name: 'Today', icon: '📅', hint: new Date().toLocaleDateString() },
            { type: 'date', name: 'Tomorrow', icon: '📅', hint: new Date(Date.now() + 86400000).toLocaleDateString() },
            ...pages.map(p => ({ type: 'page', name: p.title || 'Untitled', icon: p.icon || '📄', hint: 'Page', id: p.id }))
        ];
        
        // Filter by query
        const filtered = query 
            ? mentions.filter(m => m.name.toLowerCase().includes(query.toLowerCase()))
            : mentions;
        
        if (filtered.length === 0) {
            popup.innerHTML = `
                <div class="mention-popup-header">No results</div>
                <div style="padding: 12px; color: var(--text-muted); font-size: 14px;">
                    Try typing a page name
                </div>
            `;
        } else {
            popup.innerHTML = `
                <div class="mention-popup-header">Mention</div>
                ${filtered.map((m, i) => `
                    <div class="mention-item ${i === 0 ? 'selected' : ''}" data-type="${m.type}" data-id="${m.id || ''}" data-name="${m.name}">
                        <div class="mention-item-icon">${m.icon}</div>
                        <div class="mention-item-info">
                            <div class="mention-item-name">${m.name}</div>
                            <div class="mention-item-hint">${m.hint}</div>
                        </div>
                    </div>
                `).join('')}
            `;
        }
        
        // Position popup
        popup.style.left = `${Math.max(10, x)}px`;
        popup.style.top = `${Math.min(window.innerHeight - 200, y + 20)}px`;
        
        document.body.appendChild(popup);
        mentionPopup = popup;
        
        // Handle selection
        popup.querySelectorAll('.mention-item').forEach(item => {
            item.addEventListener('click', () => {
                insertMention(item.dataset.name, item.dataset.type, item.dataset.id);
            });
        });
    }
    
    /**
     * Hide mention popup
     */
    function hideMentionPopup() {
        if (mentionPopup) {
            mentionPopup.remove();
            mentionPopup = null;
        }
    }
    
    /**
     * Insert mention at cursor
     */
    function insertMention(name, type, id) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        
        const range = sel.getRangeAt(0);
        const textNode = range.startContainer;
        
        if (textNode.nodeType === Node.TEXT_NODE) {
            const text = textNode.textContent;
            const beforeAt = text.lastIndexOf('@', range.startOffset);
            
            if (beforeAt !== -1) {
                const before = text.substring(0, beforeAt);
                const after = text.substring(range.startOffset);
                
                textNode.textContent = before;
                
                const mentionSpan = document.createElement('span');
                mentionSpan.className = 'mention-highlight';
                mentionSpan.textContent = `@${name}`;
                mentionSpan.dataset.type = type;
                if (id) mentionSpan.dataset.id = id;
                mentionSpan.contentEditable = 'false';
                
                const afterNode = document.createTextNode(after + ' ');
                
                const parent = textNode.parentNode;
                parent.insertBefore(mentionSpan, textNode.nextSibling);
                parent.insertBefore(afterNode, mentionSpan.nextSibling);
                
                // Place cursor after mention
                range.setStart(afterNode, 1);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        
        hideMentionPopup();
        autoSave();
    }
    
    /**
     * Load a page into the editor
     */
    function loadPage(page) {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }

        if (currentPage && currentPage.id !== page?.id) {
            flushActiveBlockContent({ scheduleSave: false });
            savePage();
        }

        currentPage = {
            ...page,
            blocks: normalizeBlocks(page.blocks || []),
        };
        window.Selection?.resetState?.();
        editorContainer.innerHTML = '';
        
        // Save initial state to history
        history.stack = [JSON.stringify(currentPage)];
        history.index = 0;
        
        if (!currentPage.blocks || currentPage.blocks.length === 0) {
            // Create initial block
            const block = Blocks.createBlock('text', '');
            currentPage.blocks = [block];
        }
        
        currentPage.blocks.forEach((block, index) => {
            renderBlock(block, editorContainer, 0, index);
        });
        
        // Update empty state visibility
        updateEmptyState();
        updateWorkspacePanel();
        
        // Scroll to top
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            mainContent.scrollTop = 0;
        }
    }
    
    /**
     * Render a single block
     */
    function renderBlock(block, container = editorContainer, depth = 0, index = 0) {
        const blockEl = document.createElement('div');
        blockEl.className = 'block';
        blockEl.dataset.blockId = block.id;
        blockEl.dataset.blockType = block.type;
        blockEl.dataset.type = block.type;
        blockEl.dataset.depth = String(depth);
        blockEl.draggable = true;
        blockEl.tabIndex = -1;
        
        if (block.color) {
            blockEl.classList.add(`color-${block.color}`);
        }
        
        // Add block button (+) on row - Click to add below
        const rowAddBtn = document.createElement('button');
        rowAddBtn.className = 'block-add-btn';
        rowAddBtn.type = 'button';
        rowAddBtn.setAttribute('aria-label', 'Add block below');
        rowAddBtn.innerHTML = '+';
        rowAddBtn.title = 'Add block below (click) / Drag to move';
        rowAddBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newBlock = insertBlockAfter(block.id, 'text');
            if (newBlock) {
                setTimeout(() => focusBlock(newBlock.id), 0);
            }
        });
        blockEl.appendChild(rowAddBtn);
        
        // Drag handle
        const handle = document.createElement('div');
        handle.className = 'block-handle';
        handle.title = 'Drag to move, right-click to change type';
        handle.addEventListener('contextmenu', (event) => {
            if (typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            }
            event.preventDefault();
            event.stopPropagation();
            Selection.selectBlock(block.id);
            openBlockTypeMenu(block.id, event);
        });
        blockEl.appendChild(handle);

        blockEl.appendChild(createBlockActions(block));
        
        // Block content based on type
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'block-content-wrapper';
        
        const renderFn = Blocks.render[block.type] || Blocks.render.text;
        const content = block.type === 'bulleted_list' || block.type === 'numbered_list'
            ? renderFn(block, index, true)
            : renderFn(block, true);

        if (block.textColor) {
            const textInput = content.querySelector('.block-input, [contenteditable="true"]');
            if (textInput) {
                textInput.classList.add(`text-color-${block.textColor}`);
            }
        }

        if (block.fontFamily || block.fontSize || block.fontWeight || block.textAlign) {
            const textInput = content.querySelector('.block-input, [contenteditable="true"]');
            if (textInput) {
                if (block.fontFamily) {
                    textInput.classList.add(`font-family-${block.fontFamily}`);
                }
                if (block.fontSize) {
                    textInput.classList.add(`font-size-${block.fontSize}`);
                }
                if (block.fontWeight) {
                    textInput.classList.add(`font-weight-${block.fontWeight}`);
                }
                if (block.textAlign) {
                    textInput.classList.add(`text-align-${block.textAlign}`);
                }
            }
        }
        
        contentWrapper.appendChild(content);
        blockEl.appendChild(contentWrapper);
        
        // Add block button (between blocks)
        const addBtn = document.createElement('button');
        addBtn.className = 'add-block-btn';
        addBtn.type = 'button';
        addBtn.setAttribute('aria-label', 'Choose block type to add below');
        addBtn.innerHTML = '+';
        addBtn.title = 'Add block';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const buttonRect = addBtn.getBoundingClientRect();
            const menuX = e.detail === 0 ? buttonRect.left : e.clientX;
            const menuY = e.detail === 0 ? buttonRect.bottom : e.clientY;
            SlashMenu.show(menuX, menuY, block.id);
            SlashMenu.setCallback((type) => {
                insertBlockAfter(block.id, type);
            });
        });
        
        container.appendChild(blockEl);

        if (block.children && block.children.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = block.type === 'toggle' ? 'toggle-children block-children' : 'block-children';
            if (block.type === 'toggle' && block.expanded === false) {
                childrenContainer.classList.add('collapsed');
            }

            container.appendChild(childrenContainer);
            block.children.forEach((child, childIndex) => {
                renderBlock(child, childrenContainer, depth + 1, childIndex);
            });
        }

        container.appendChild(addBtn);
        
        // Setup block interactions
        setupBlockInteractions(blockEl, block);
        
        return blockEl;
    }
    
    /**
     * Setup interactions for a block
     */
    function setupBlockInteractions(blockEl, block) {
        Selection.setupDragAndDrop(blockEl, block.id);

        blockEl.addEventListener('click', (e) => {
            if (e.target === blockEl || e.target.classList.contains('block-handle')) {
                Selection.selectBlock(block.id);
            }
        });

        const input = blockEl.querySelector('.block-input, [contenteditable="true"]');
        if (!input) return;
        
        // Set placeholder
        const blockType = Blocks.getBlockTypes()[block.type];
        if (blockType && blockType.placeholder && !block.content) {
            input.dataset.placeholder = blockType.placeholder;
        }
        
        // Focus - select block
        input.addEventListener('focus', () => {
            Selection.selectBlock(block.id, false);
            hideInlineToolbar();
        });
        
        // Blur - save content
        input.addEventListener('blur', () => {
            syncBlockInput(block.id, input);
            // Don't hide toolbar immediately to allow clicking it
            setTimeout(() => {
                if (!document.activeElement?.closest('.inline-toolbar')) {
                    hideInlineToolbar();
                }
            }, 200);
        });
        
        // Input - auto-save and update placeholder visibility
        input.addEventListener('input', () => {
            syncBlockInput(block.id, input);
            
            // Update placeholder visibility
            if (input.textContent.trim()) {
                input.classList.add('has-content');
            } else {
                input.classList.remove('has-content');
            }
            
            // Hide inline toolbar on input
            hideInlineToolbar();
        });
        
        // Selection change - show inline toolbar
        const showToolbarOnSelection = () => {
            setTimeout(() => {
                const sel = window.getSelection();
                const text = sel.toString().trim();
                if (text.length > 0) {
                    // Don't show toolbar for AI placeholder text
                    if (!text.startsWith('?? ')) {
                        showInlineToolbar(sel.getRangeAt(0));
                    }
                } else {
                    hideInlineToolbar();
                }
            }, 10);
        };
        
        input.addEventListener('mouseup', showToolbarOnSelection);
        input.addEventListener('keyup', (e) => {
            // Show toolbar on selection keys (Shift+Arrow, Ctrl+A, etc.)
            if (e.shiftKey || e.key === 'Select' || e.ctrlKey || e.metaKey) {
                showToolbarOnSelection();
            }
        });
        
        // Keydown - navigation and shortcuts
        input.addEventListener('keydown', (e) => {
            if (isComposing) return;
            
            // Handle inline formatting shortcuts
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
                switch (e.key.toLowerCase()) {
                    case 'b':
                        e.preventDefault();
                        document.execCommand('bold', false, null);
                        return;
                    case 'i':
                        e.preventDefault();
                        document.execCommand('italic', false, null);
                        return;
                    case 'u':
                        e.preventDefault();
                        document.execCommand('underline', false, null);
                        return;
                    case 'k':
                        e.preventDefault();
                        const url = prompt('Enter link URL:');
                        if (url) {
                            document.execCommand('createLink', false, url);
                        }
                        return;
                }
            }
            
            handleBlockKeydown(e, block, input);
        });
        
        // Keyup - slash and mention detection
        input.addEventListener('keyup', (e) => {
            if (isComposing) return;
            handleBlockKeyup(e, block, input);
        });
    }
    
    /**
     * Handle keydown events in a block
     */
    function handleBlockKeydown(e, block, input) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        
        switch (e.key) {
            case 'Enter':
                if (!e.shiftKey) {
                    e.preventDefault();
                    saveToHistory();
                    
                    // Split content at cursor
                    let beforeText, afterText;
                    
                    if (range.startContainer.nodeType === Node.TEXT_NODE) {
                        const text = range.startContainer.textContent;
                        beforeText = text.substring(0, range.startOffset);
                        afterText = text.substring(range.startOffset);
                    } else {
                        beforeText = input.textContent;
                        afterText = '';
                    }
                    
                    // Check for markdown conversion on current block
                    const markdownMatch = Blocks.parseMarkdown(beforeText);
                    if (markdownMatch && block.type === 'text') {
                        // Convert current block
                        convertBlockType(block.id, markdownMatch.type, markdownMatch.content);
                        
                        // Create new block with remaining text
                        if (afterText.trim()) {
                            setTimeout(() => {
                                const newBlock = insertBlockAfter(block.id, 'text', afterText, { skipHistory: true });
                                focusBlock(newBlock.id);
                            }, 0);
                        }
                    } else {
                        // Update current block
                        input.textContent = beforeText;
                        updateBlockContent(block.id, input);
                        
                        // Create new block
                        const newBlockType = (block.type === 'heading_1' || 
                            block.type === 'heading_2' || block.type === 'heading_3') ? 'text' : block.type;
                        const newBlock = insertBlockAfter(block.id, newBlockType, afterText, { skipHistory: true });
                        focusBlock(newBlock.id);
                    }
                }
                break;
                
            case 'Backspace':
                // Check if at start of empty block
                if (input.textContent === '' || (range.startOffset === 0 && 
                    (!range.startContainer.previousSibling || 
                     (range.startContainer === input && !input.textContent)))) {
                    e.preventDefault();
                    saveToHistory();
                    mergeWithPrevious(block.id);
                }
                break;
                
            case 'Delete':
                if (shouldDeleteCurrentBlock(input, range)) {
                    e.preventDefault();
                    deleteBlock(block.id);
                }
                break;
                
            case 'Tab':
                e.preventDefault();
                saveToHistory();
                if (e.shiftKey) {
                    unindentBlock(block.id);
                } else {
                    indentBlock(block.id);
                }
                break;
                
            case 'ArrowUp':
                if (isAtStart(range, input)) {
                    e.preventDefault();
                    const prevBlock = getPreviousBlock(block.id);
                    if (prevBlock) {
                        focusBlock(prevBlock.id, 'end');
                    }
                }
                break;
                
            case 'ArrowDown':
                if (isAtEnd(range, input)) {
                    e.preventDefault();
                    const nextBlock = getNextBlock(block.id);
                    if (nextBlock) {
                        focusBlock(nextBlock.id, 'start');
                    }
                }
                break;
                
            case 'Escape':
                hideInlineToolbar();
                hideMentionPopup();
                input.blur();
                break;
        }
    }
    
    function shouldDeleteCurrentBlock(input, range) {
        if (!range.collapsed) {
            const selectedText = range.toString().trim();
            return selectedText === input.textContent.trim();
        }

        if (!input.textContent.trim()) {
            return true;
        }

        return isAtStart(range, input) && isAtEnd(range, input);
    }

    /**
     * Handle keyup events (for slash command and mention detection)
     */
    function handleBlockKeyup(e, block, input) {
        const text = input.textContent;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        
        // Check for slash at start
        if (text === '/' && !SlashMenu.isOpen()) {
            const rect = input.getBoundingClientRect();
            SlashMenu.show(rect.left, rect.bottom, block.id);
            SlashMenu.setCallback((type) => {
                convertBlockType(block.id, type);
            });
        }
        
        // Check for @ mention
        const cursorPos = range.startOffset;
        const beforeCursor = text.substring(0, cursorPos);
        const atMatch = beforeCursor.match(/@([\w]*)$/);
        
        if (atMatch && !mentionPopup) {
            const rect = range.getBoundingClientRect();
            showMentionPopup(atMatch[1], rect.left, rect.bottom, block.id);
        } else if (!atMatch && mentionPopup) {
            hideMentionPopup();
        }
    }
    
    /**
     * Check if cursor is at start
     */
    function isAtStart(range, element) {
        if (range.startOffset !== 0) return false;
        
        let node = range.startContainer;
        while (node && node !== element) {
            if (node.previousSibling) return false;
            node = node.parentNode;
        }
        return true;
    }
    
    /**
     * Check if cursor is at end
     */
    function isAtEnd(range, element) {
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
            const text = range.startContainer.textContent;
            if (range.startOffset < text.length) return false;
        }
        
        let node = range.startContainer;
        while (node && node !== element) {
            if (node.nextSibling) return false;
            node = node.parentNode;
        }
        return true;
    }
    
    /**
     * Insert a new block after specified block
     */
    function insertBlockAfter(blockId, type = 'text', content = '', options = {}) {
        if (!currentPage) return null;

        const { skipHistory = false } = options;
        const location = blockId ? findBlockLocation(blockId) : null;
        if (blockId && !location) return null;
        if (!skipHistory) {
            saveToHistory();
        }

        const newBlock = Blocks.createBlock(type, content);
        if (!location) {
            currentPage.blocks.push(newBlock);
        } else {
            location.siblings.splice(location.index + 1, 0, newBlock);
        }
        
        refreshEditor();
        autoSave();
        
        return newBlock;
    }
    
    /**
     * Insert a block before specified block
     */
    function insertBlockBefore(blockId, type = 'text', content = '', options = {}) {
        if (!currentPage) return null;

        const { skipHistory = false } = options;
        const location = findBlockLocation(blockId);
        if (!location) return null;
        if (!skipHistory) {
            saveToHistory();
        }

        const newBlock = Blocks.createBlock(type, content);
        location.siblings.splice(location.index, 0, newBlock);
        
        refreshEditor();
        autoSave();
        
        return newBlock;
    }
    
    /**
     * Insert a block at specific index
     */
    function insertBlockAtIndex(index, type = 'text', content = '') {
        if (!currentPage) return null;
        
        saveToHistory();
        
        const newBlock = Blocks.createBlock(type, content);
        
        // Ensure index is valid
        if (index < 0) index = 0;
        if (index > currentPage.blocks.length) index = currentPage.blocks.length;
        
        currentPage.blocks.splice(index, 0, newBlock);
        
        refreshEditor();
        autoSave();
        
        return newBlock;
    }
    
    /**
     * Delete a block with undo support
     */
    function deleteBlock(blockId) {
        if (!currentPage) return;
        
        const location = findBlockLocation(blockId);
        if (!location) return;
        
        const visibleBlocks = getFlattenedBlocks();
        const visibleIndex = visibleBlocks.findIndex((entry) => entry.block.id === blockId);
        const deletedBlock = location.block;
        const blockContent = extractBlockText(deletedBlock) || deletedBlock.type;
        
        // Save to history for undo
        saveToHistory();
        
        // Don't delete the last block, convert to empty text instead
        if (visibleBlocks.length === 1) {
            currentPage.blocks[0] = Blocks.createBlock('text', '');
        } else {
            location.siblings.splice(location.index, 1);
        }
        
        refreshEditor();
        autoSave();
        
        // Focus previous or next block
        const updatedVisibleBlocks = getFlattenedBlocks();
        const focusIndex = Math.min(visibleIndex, updatedVisibleBlocks.length - 1);
        if (updatedVisibleBlocks[focusIndex]) {
            focusBlock(updatedVisibleBlocks[focusIndex].block.id);
        }
        
        // Show undo toast
        if (window.Sidebar?.showUndoToast) {
            window.Sidebar.showUndoToast(`Deleted "${blockContent.substring(0, 30)}${blockContent.length > 30 ? '...' : ''}"`, () => {
                // Undo callback - restore the block
                restoreDeletedBlock(deletedBlock, location);
            });
        }
    }

    function moveBlockWithinSiblings(blockId, direction) {
        if (!currentPage) return false;

        const location = findBlockLocation(blockId);
        if (!location) return false;

        const offset = direction === 'up' ? -1 : 1;
        const nextIndex = location.index + offset;
        if (nextIndex < 0 || nextIndex >= location.siblings.length) {
            return false;
        }

        saveToHistory();

        const [block] = location.siblings.splice(location.index, 1);
        location.siblings.splice(nextIndex, 0, block);

        refreshEditor();
        autoSave();
        focusBlock(blockId);

        return true;
    }

    function moveBlockUp(blockId) {
        return moveBlockWithinSiblings(blockId, 'up');
    }

    function moveBlockDown(blockId) {
        return moveBlockWithinSiblings(blockId, 'down');
    }
    
    /**
     * Restore a deleted block
     */
    function restoreDeletedBlock(block, originalLocation) {
        if (!currentPage) return;
        
        saveToHistory();
        
        // Restore the block at its original position
        originalLocation.siblings.splice(originalLocation.index, 0, block);
        
        refreshEditor();
        autoSave();
        
        // Focus the restored block
        focusBlock(block.id);
        
        showToast('Block restored', 'success');
    }
    
    /**
     * Duplicate a block
     */
    function duplicateBlock(blockId) {
        if (!currentPage) return;
        
        saveToHistory();
        
        const location = findBlockLocation(blockId);
        if (!location) return;

        const [newBlock] = Storage.cloneBlocksWithFreshIds([location.block]);
        if (!newBlock) return;
        
        location.siblings.splice(location.index + 1, 0, newBlock);
        
        refreshEditor();
        autoSave();
        
        focusBlock(newBlock.id);
    }
    
    /**
     * Convert block to different type
     */
    function convertBlockType(blockId, newType, newContent = null) {
        if (!currentPage) return;

        const location = findBlockLocation(blockId);
        if (!location) return;

        saveToHistory();
        const block = location.block;

        const sourceText = newContent !== null ? newContent : extractBlockText(block);
        const sourceContent = newContent !== null ? newContent : block.content;
        block.content = createContentForType(newType, sourceText, sourceContent);
        block.type = newType;
        if (newType === 'callout' && block.content && typeof block.content === 'object' && block.content.icon) {
            block.icon = block.content.icon;
        }

        refreshEditor();
        autoSave();

        focusBlock(blockId);
    }

    /**
     * Swap a block shell to a new type and wipe content/type-specific state.
     * Keeps the existing block ID so agents can keep targeting the same block.
     */
    function swapBlockType(blockId, newType = 'text') {
        if (!currentPage) return null;

        const location = findBlockLocation(blockId);
        if (!location) return null;

        const blockTypes = window.Blocks?.getBlockTypes?.() || {};
        const targetType = blockTypes[newType] ? newType : 'text';
        const previousCreatedAt = location.block.createdAt || Date.now();
        const freshBlock = Blocks.createBlock(targetType, '');

        flushActiveBlockContent({ scheduleSave: false, updateWorkspace: false });
        saveToHistory();

        Object.keys(location.block).forEach((key) => {
            if (key !== 'id') {
                delete location.block[key];
            }
        });

        Object.assign(location.block, {
            ...freshBlock,
            id: blockId,
            type: targetType,
            createdAt: previousCreatedAt,
            children: [],
            formatting: {},
            color: null,
            textColor: null,
            updatedAt: Date.now(),
        });

        if (document.activeElement?.closest?.('.block')) {
            document.activeElement.blur();
        }

        refreshEditor();
        autoSave();
        focusBlock(blockId, 'start');

        return location.block;
    }

    function wipeBlock(blockId) {
        const block = getBlock(blockId);
        return swapBlockType(blockId, block?.type || 'text');
    }
    
    /**
     * Update block content from DOM
     */
    function updateBlockContent(blockId, inputOrContent, options = {}) {
        if (!currentPage) return;
        
        const location = findBlockLocation(blockId);
        if (!location) return;

        const block = location.block;
        const nextContent = inputOrContent && typeof inputOrContent === 'object' && 'textContent' in inputOrContent
            ? inputOrContent.textContent || ''
            : inputOrContent;

        if (block.type === 'todo' && typeof block.content === 'object') {
            block.content.text = typeof nextContent === 'string' ? nextContent : '';
        } else if (block.type === 'callout' && typeof block.content === 'object') {
            block.content.text = typeof nextContent === 'string' ? nextContent : '';
        } else if (block.type === 'code' && typeof block.content === 'object') {
            block.content.text = typeof nextContent === 'string' ? nextContent : '';
        } else if (typeof nextContent === 'string' || typeof nextContent === 'object') {
            block.content = nextContent;
        }

        if (options.scheduleSave !== false) {
            autoSave();
        }

        if (options.updateWorkspace !== false) {
            updateWorkspacePanel();
        }
    }

    function updateBlockFields(blockId, updates = {}) {
        if (!currentPage || !blockId || !updates || typeof updates !== 'object') return null;

        const location = findBlockLocation(blockId);
        if (!location) return null;

        saveToHistory();

        const mergedBlock = normalizeBlocks([{
            ...location.block,
            ...updates,
            id: blockId,
            children: Object.prototype.hasOwnProperty.call(updates, 'children')
                ? updates.children
                : (location.block.children || []),
            formatting: Object.prototype.hasOwnProperty.call(updates, 'formatting')
                ? updates.formatting
                : (location.block.formatting || {}),
        }])[0];

        location.siblings.splice(location.index, 1, mergedBlock);

        refreshEditor();
        autoSave();

        return mergedBlock;
    }

    function updateBlocksFields(updatesById = {}) {
        if (!currentPage || !updatesById || typeof updatesById !== 'object') return [];
        const entries = Object.entries(updatesById).filter(([blockId, updates]) => (
            blockId && updates && typeof updates === 'object'
        ));
        if (!entries.length) return [];

        const pending = entries
            .map(([blockId, updates]) => ({ blockId, updates, location: findBlockLocation(blockId) }))
            .filter((item) => item.location);
        if (!pending.length) return [];

        saveToHistory();
        const updatedBlocks = pending.map(({ blockId, updates, location }) => {
            const mergedBlock = normalizeBlocks([{
                ...location.block,
                ...updates,
                id: blockId,
                children: Object.prototype.hasOwnProperty.call(updates, 'children')
                    ? updates.children
                    : (location.block.children || []),
                formatting: Object.prototype.hasOwnProperty.call(updates, 'formatting')
                    ? updates.formatting
                    : (location.block.formatting || {}),
            }])[0];
            location.siblings.splice(location.index, 1, mergedBlock);
            return mergedBlock;
        });

        refreshEditor();
        autoSave();
        return updatedBlocks;
    }
    
    /**
     * Indent a block (make child of previous)
     */
    function indentBlock(blockId) {
        if (!currentPage) return;

        const visibleBlocks = getFlattenedBlocks();
        const currentIndex = visibleBlocks.findIndex((entry) => entry.block.id === blockId);
        if (currentIndex <= 0) return;

        const location = findBlockLocation(blockId);
        const previousEntry = visibleBlocks[currentIndex - 1];
        if (!location || !previousEntry) return;

        saveToHistory();

        const [block] = location.siblings.splice(location.index, 1);
        previousEntry.block.children = previousEntry.block.children || [];
        if (blockContainsDescendant(block, previousEntry.block.id)) {
            location.siblings.splice(location.index, 0, block);
            return;
        }
        previousEntry.block.children.push(block);

        if (previousEntry.block.type === 'toggle') {
            previousEntry.block.expanded = true;
        }

        refreshEditor();
        autoSave();
        focusBlock(blockId);
    }
    
    /**
     * Unindent a block (move out of parent)
     */
    function unindentBlock(blockId) {
        if (!currentPage) return;

        const location = findBlockLocation(blockId);
        if (!location || !location.parent) return;

        const parentLocation = findBlockLocation(location.parent.id);
        if (!parentLocation) return;

        saveToHistory();

        const [block] = location.siblings.splice(location.index, 1);
        parentLocation.siblings.splice(parentLocation.index + 1, 0, block);

        refreshEditor();
        autoSave();
        focusBlock(blockId);
    }
    
    /**
     * Merge block with previous
     */
    function mergeWithPrevious(blockId) {
        if (!currentPage) return;
        
        const visibleBlocks = getFlattenedBlocks();
        const visibleIndex = visibleBlocks.findIndex((entry) => entry.block.id === blockId);
        if (visibleIndex <= 0) return;

        const currentLocation = findBlockLocation(blockId);
        const current = currentLocation?.block;
        const previous = visibleBlocks[visibleIndex - 1]?.block;
        if (!currentLocation || !current || !previous) return;
        
        // Get content
        let currentText = typeof current.content === 'object' ? current.content.text : current.content;
        let prevText = typeof previous.content === 'object' ? previous.content.text : previous.content;
        
        // Merge
        const mergedText = prevText + currentText;
        
        if (typeof previous.content === 'object') {
            previous.content.text = mergedText;
        } else {
            previous.content = mergedText;
        }
        
        // Remove current
        currentLocation.siblings.splice(currentLocation.index, 1);
        
        refreshEditor();
        autoSave();
        
        // Focus previous at merged position
        focusBlock(previous.id, 'end');
    }
    
    /**
     * Get previous block
     */
    function getPreviousBlock(blockId) {
        if (!currentPage) return null;

        const visibleBlocks = getFlattenedBlocks();
        const index = visibleBlocks.findIndex((entry) => entry.block.id === blockId);
        if (index <= 0) return null;

        return visibleBlocks[index - 1].block;
    }
    
    /**
     * Get next block
     */
    function getNextBlock(blockId) {
        if (!currentPage) return null;

        const visibleBlocks = getFlattenedBlocks();
        const index = visibleBlocks.findIndex((entry) => entry.block.id === blockId);
        if (index === -1 || index >= visibleBlocks.length - 1) return null;

        return visibleBlocks[index + 1].block;
    }
    
    /**
     * Focus a block
     */
    function focusBlock(blockId, position = 'end') {
        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (!blockEl) return;
        
        const target = getBlockFocusTarget(blockEl);
        if (target) {
            focusEditableElement(target, position);
            return;
        }

        blockEl.focus();
    }
    
    /**
     * Refresh the entire editor
     */
    function refreshEditor() {
        if (!currentPage) return;

        flushActiveBlockContent({ scheduleSave: false });
        
        // Remember focused block
        const focusedBlockId = document.activeElement?.closest('.block')?.dataset.blockId;
        
        editorContainer.innerHTML = '';
        currentPage.blocks.forEach((block, index) => {
            renderBlock(block, editorContainer, 0, index);
        });
        
        // Restore focus
        if (focusedBlockId) {
            focusBlock(focusedBlockId);
        }
        
        updateEmptyState();
        updateWorkspacePanel();
    }
    
    /**
     * Handle paste
     */
    function handlePaste(e) {
        const text = e.clipboardData.getData('text/plain');
        if (looksLikeStructuredMarkdownPaste(text) && applyStructuredMarkdownPaste(text)) {
            e.preventDefault();
            return;
        }

        e.preventDefault();

        // Simple paste - insert as text
        document.execCommand('insertText', false, text);
    }
    
    /**
     * Auto-save page
     */
    function autoSave() {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
        
        saveTimeout = setTimeout(() => {
            savePage();
        }, 1000);
    }
    
    /**
     * Save current page
     */
    function savePage() {
        if (!currentPage) return;

        flushActiveBlockContent({ scheduleSave: false });
        
        // Update page title from input
        const titleInput = document.getElementById('page-title');
        if (titleInput) {
            currentPage.title = titleInput.value;
        }
        
        // Update icon
        const iconEl = document.getElementById('page-icon');
        if (iconEl) {
            currentPage.icon = iconEl.textContent;
        }
        
        currentPage.updatedAt = Date.now();
        
        Storage.updatePage(currentPage.id, currentPage);
        updateWorkspacePanel();
        
        // Update sidebar
        if (window.Sidebar) {
            window.Sidebar.refreshPageTree();
        }
    }

    function updatePageMetadata(updates = {}) {
        if (!currentPage || !updates || typeof updates !== 'object') return;

        saveToHistory();

        if (Object.prototype.hasOwnProperty.call(updates, 'title')) {
            currentPage.title = String(updates.title || '').trim() || 'Untitled';
            const titleInput = document.getElementById('page-title');
            if (titleInput) {
                titleInput.value = currentPage.title;
            }
            const breadcrumbCurrent = document.getElementById('breadcrumb-current');
            if (breadcrumbCurrent) {
                breadcrumbCurrent.textContent = currentPage.title;
            }
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'icon')) {
            currentPage.icon = String(updates.icon || '').trim();
            const iconEl = document.getElementById('page-icon');
            const addIconHint = document.querySelector('.add-icon-hint');
            if (iconEl) {
                iconEl.textContent = currentPage.icon;
                iconEl.style.display = currentPage.icon ? 'inline' : 'none';
            }
            if (addIconHint) {
                addIconHint.style.display = currentPage.icon ? 'none' : 'inline';
            }
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'cover')) {
            currentPage.cover = updates.cover ? String(updates.cover).trim() : null;
            const coverArea = document.getElementById('cover-area');
            const coverImage = document.getElementById('cover-image');
            const addCoverBtn = document.getElementById('add-cover-btn');
            if (coverArea && coverImage) {
                if (currentPage.cover) {
                    coverArea.style.display = 'block';
                    coverImage.style.backgroundImage = formatCoverBackground(currentPage.cover);
                    if (addCoverBtn) addCoverBtn.style.display = 'none';
                } else {
                    coverArea.style.display = 'none';
                    coverImage.style.backgroundImage = '';
                    if (addCoverBtn) addCoverBtn.style.display = 'flex';
                }
            }
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'properties')) {
            currentPage.properties = Array.isArray(updates.properties)
                ? updates.properties
                    .map((prop) => ({
                        key: String(prop?.key || '').trim(),
                        value: String(prop?.value || '').trim()
                    }))
                    .filter((prop) => prop.key)
                : [];

            const propertiesArea = document.getElementById('properties-area');
            if (propertiesArea) {
                propertiesArea.innerHTML = '';
                currentPage.properties.forEach((prop) => {
                    const row = document.createElement('div');
                    row.className = 'property-row';
                    row.innerHTML = `
                        <span class="property-key">${escapeHtml(prop.key)}:</span>
                        <span class="property-value">${escapeHtml(prop.value)}</span>
                    `;
                    propertiesArea.appendChild(row);
                });
            }
        }

        if (Object.prototype.hasOwnProperty.call(updates, 'defaultModel')) {
            currentPage.defaultModel = updates.defaultModel ? String(updates.defaultModel).trim() : null;
            const pageModelDropdown = document.getElementById('page-model-dropdown');
            if (pageModelDropdown) {
                pageModelDropdown.value = currentPage.defaultModel || '';
            }
        }

        document.title = currentPage.title ? `${currentPage.title} - Notes` : 'Notes - Lilly Style';
        savePage();
    }

    function formatCoverBackground(cover) {
        const value = String(cover || '').trim();
        if (!value) return '';
        if (/^(linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/i.test(value) || /^url\(/i.test(value)) {
            return value;
        }
        return `url("${value.replace(/"/g, '\\"')}")`;
    }

    function getBlock(blockId) {
        return findBlockLocation(blockId)?.block || null;
    }

    function replaceBlockWithBlocks(blockId, blocks = []) {
        if (!currentPage) return [];

        const location = findBlockLocation(blockId);
        if (!location) return [];

        saveToHistory();

        const normalizedBlocks = normalizeBlocks(Storage.cloneBlocksWithFreshIds(blocks));

        location.siblings.splice(location.index, 1, ...normalizedBlocks);

        refreshEditor();
        autoSave();

        return normalizedBlocks;
    }

    function insertBlocksAfter(blockId, blocks = []) {
        if (!currentPage || !Array.isArray(blocks) || blocks.length === 0) return [];

        const location = blockId ? findBlockLocation(blockId) : null;
        if (blockId && !location) return [];

        saveToHistory();

        const normalizedBlocks = normalizeBlocks(Storage.cloneBlocksWithFreshIds(blocks));

        const siblings = location ? location.siblings : currentPage.blocks;
        const index = location ? location.index + 1 : siblings.length;
        siblings.splice(index, 0, ...normalizedBlocks);

        refreshEditor();
        autoSave();

        return normalizedBlocks;
    }

    function insertBlocksBefore(blockId, blocks = []) {
        if (!currentPage || !Array.isArray(blocks) || blocks.length === 0) return [];

        const location = blockId ? findBlockLocation(blockId) : null;
        if (blockId && !location) return [];

        saveToHistory();

        const normalizedBlocks = normalizeBlocks(Storage.cloneBlocksWithFreshIds(blocks));

        const siblings = location ? location.siblings : currentPage.blocks;
        const index = location ? location.index : 0;
        siblings.splice(index, 0, ...normalizedBlocks);

        refreshEditor();
        autoSave();

        return normalizedBlocks;
    }

    function getSectionRangeFromHeading(headingBlockId) {
        if (!currentPage || !headingBlockId) return null;

        const location = findBlockLocation(headingBlockId);
        const headingLevel = getHeadingLevel(location?.block);
        if (!location || !headingLevel) return null;

        let endIndex = location.index;
        for (let index = location.index + 1; index < location.siblings.length; index += 1) {
            const nextLevel = getHeadingLevel(location.siblings[index]);
            if (nextLevel && nextLevel <= headingLevel) {
                break;
            }
            endIndex = index;
        }

        return {
            heading: location.block,
            siblings: location.siblings,
            parent: location.parent,
            startIndex: location.index,
            endIndex,
            blocks: location.siblings.slice(location.index, endIndex + 1),
        };
    }

    function replaceSectionFromHeading(headingBlockId, blocks = []) {
        if (!currentPage || !Array.isArray(blocks) || blocks.length === 0) return [];

        const section = getSectionRangeFromHeading(headingBlockId);
        if (!section) return [];

        saveToHistory();

        const normalizedBlocks = normalizeBlocks(Storage.cloneBlocksWithFreshIds(blocks));
        section.siblings.splice(
            section.startIndex,
            section.endIndex - section.startIndex + 1,
            ...normalizedBlocks
        );

        refreshEditor();
        autoSave();

        return normalizedBlocks;
    }

    function insertBlocksAfterSection(headingBlockId, blocks = []) {
        if (!currentPage || !Array.isArray(blocks) || blocks.length === 0) return [];

        const section = getSectionRangeFromHeading(headingBlockId);
        if (!section) return [];

        saveToHistory();

        const normalizedBlocks = normalizeBlocks(Storage.cloneBlocksWithFreshIds(blocks));
        section.siblings.splice(section.endIndex + 1, 0, ...normalizedBlocks);

        refreshEditor();
        autoSave();

        return normalizedBlocks;
    }

    function insertBlocksBeforeSection(headingBlockId, blocks = []) {
        if (!currentPage || !Array.isArray(blocks) || blocks.length === 0) return [];

        const section = getSectionRangeFromHeading(headingBlockId);
        if (!section) return [];

        saveToHistory();

        const normalizedBlocks = normalizeBlocks(Storage.cloneBlocksWithFreshIds(blocks));
        section.siblings.splice(section.startIndex, 0, ...normalizedBlocks);

        refreshEditor();
        autoSave();

        return normalizedBlocks;
    }

    function deleteSectionFromHeading(headingBlockId) {
        if (!currentPage) return false;

        const section = getSectionRangeFromHeading(headingBlockId);
        if (!section) return false;

        const removedCount = section.endIndex - section.startIndex + 1;
        const focusFallback = section.siblings[section.endIndex + 1]?.id
            || section.siblings[section.startIndex - 1]?.id
            || null;

        saveToHistory();
        section.siblings.splice(section.startIndex, removedCount);

        if (!currentPage.blocks.length) {
            currentPage.blocks = [Blocks.createBlock('text', '')];
        }

        refreshEditor();
        autoSave();

        const nextFocusId = focusFallback || currentPage.blocks[0]?.id;
        if (nextFocusId) {
            focusBlock(nextFocusId);
        }

        return true;
    }

    function moveSection(headingBlockId, targetHeadingBlockId, position = 'after') {
        if (!currentPage || !headingBlockId || !targetHeadingBlockId || headingBlockId === targetHeadingBlockId) {
            return false;
        }

        const source = getSectionRangeFromHeading(headingBlockId);
        const target = getSectionRangeFromHeading(targetHeadingBlockId);
        if (!source || !target || source.siblings !== target.siblings) {
            return false;
        }

        if (target.startIndex >= source.startIndex && target.startIndex <= source.endIndex) {
            return false;
        }

        saveToHistory();

        const count = source.endIndex - source.startIndex + 1;
        const movingBlocks = source.siblings.splice(source.startIndex, count);
        const refreshedTarget = getSectionRangeFromHeading(targetHeadingBlockId);
        if (!refreshedTarget) {
            source.siblings.splice(source.startIndex, 0, ...movingBlocks);
            return false;
        }

        const insertIndex = String(position).toLowerCase() === 'before'
            ? refreshedTarget.startIndex
            : refreshedTarget.endIndex + 1;

        refreshedTarget.siblings.splice(insertIndex, 0, ...movingBlocks);

        refreshEditor();
        autoSave();
        focusBlock(headingBlockId);

        return true;
    }

    function getAdjacentSectionHeadingId(headingBlockId, direction = 'next') {
        const section = getSectionRangeFromHeading(headingBlockId);
        if (!section) return null;

        const headingLevel = getHeadingLevel(section.heading);
        if (!headingLevel) return null;

        if (direction === 'previous') {
            for (let index = section.startIndex - 1; index >= 0; index -= 1) {
                const level = getHeadingLevel(section.siblings[index]);
                if (level && level <= headingLevel) {
                    return section.siblings[index].id;
                }
            }
            return null;
        }

        for (let index = section.endIndex + 1; index < section.siblings.length; index += 1) {
            const level = getHeadingLevel(section.siblings[index]);
            if (level && level <= headingLevel) {
                return section.siblings[index].id;
            }
        }

        return null;
    }

    function moveSectionUp(headingBlockId) {
        const previousHeadingId = getAdjacentSectionHeadingId(headingBlockId, 'previous');
        return previousHeadingId ? moveSection(headingBlockId, previousHeadingId, 'before') : false;
    }

    function moveSectionDown(headingBlockId) {
        const nextHeadingId = getAdjacentSectionHeadingId(headingBlockId, 'next');
        return nextHeadingId ? moveSection(headingBlockId, nextHeadingId, 'after') : false;
    }
    
    /**
     * Update empty state visibility
     */
    function updateEmptyState() {
        const emptyState = document.getElementById('empty-state');
        if (!emptyState) return;
        
        if (!currentPage?.blocks?.length || 
            (currentPage.blocks.length === 1 && !currentPage.blocks[0].content)) {
            emptyState.style.display = 'block';
        } else {
            emptyState.style.display = 'none';
        }
    }
    
    /**
     * Change block color (background)
     */
    function setBlockColor(blockId, color) {
        if (!currentPage) return;
        
        saveToHistory();
        
        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block) return;
        
        block.color = color;
        
        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (blockEl) {
            // Remove existing background color classes
            blockEl.classList.forEach(cls => {
                if (cls.startsWith('color-') && !cls.startsWith('color-text-')) {
                    blockEl.classList.remove(cls);
                }
            });
            
            if (color) {
                blockEl.classList.add(`color-${color}`);
            }
        }
        
        autoSave();
    }
    
    /**
     * Change text color
     */
    function setTextColor(blockId, color) {
        if (!currentPage) return;
        
        saveToHistory();
        
        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block) return;
        
        block.textColor = color;
        
        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (blockEl) {
            const input = blockEl.querySelector('.block-input');
            if (input) {
                // Remove existing text color classes
                input.classList.forEach(cls => {
                    if (cls.startsWith('text-color-')) {
                        input.classList.remove(cls);
                    }
                });
                
                if (color) {
                    input.classList.add(`text-color-${color}`);
                }
            }
        }
        
        autoSave();
    }

    function setBlockFontFamily(blockId, fontFamily) {
        if (!currentPage) return;

        saveToHistory();

        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block) return;

        block.fontFamily = fontFamily;

        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        const input = blockEl?.querySelector?.('.block-input, [contenteditable="true"]');
        if (input) {
            input.classList.forEach((cls) => {
                if (cls.startsWith('font-family-')) {
                    input.classList.remove(cls);
                }
            });
            if (fontFamily) {
                input.classList.add(`font-family-${fontFamily}`);
            }
        }

        autoSave();
    }

    function setBlockFontSize(blockId, fontSize) {
        if (!currentPage) return;

        saveToHistory();

        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block) return;

        block.fontSize = fontSize;

        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        const input = blockEl?.querySelector?.('.block-input, [contenteditable="true"]');
        if (input) {
            input.classList.forEach((cls) => {
                if (cls.startsWith('font-size-')) {
                    input.classList.remove(cls);
                }
            });
            if (fontSize) {
                input.classList.add(`font-size-${fontSize}`);
            }
        }

        autoSave();
    }

    function setBlockFontWeight(blockId, fontWeight) {
        if (!currentPage) return;

        saveToHistory();

        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block) return;

        block.fontWeight = fontWeight;

        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        const input = blockEl?.querySelector?.('.block-input, [contenteditable="true"]');
        if (input) {
            input.classList.forEach((cls) => {
                if (cls.startsWith('font-weight-')) {
                    input.classList.remove(cls);
                }
            });
            if (fontWeight) {
                input.classList.add(`font-weight-${fontWeight}`);
            }
        }

        autoSave();
    }

    function setBlockTextAlign(blockId, textAlign) {
        if (!currentPage) return;

        saveToHistory();

        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block) return;

        block.textAlign = textAlign;

        const blockEl = document.querySelector(`.block[data-block-id="${blockId}"]`);
        const input = blockEl?.querySelector?.('.block-input, [contenteditable="true"]');
        if (input) {
            input.classList.forEach((cls) => {
                if (cls.startsWith('text-align-')) {
                    input.classList.remove(cls);
                }
            });
            if (textAlign) {
                input.classList.add(`text-align-${textAlign}`);
            }
        }

        autoSave();
    }

    function updateDatabaseContent(blockId, updates = {}) {
        if (!currentPage || !blockId || !updates || typeof updates !== 'object') return null;

        const location = findBlockLocation(blockId);
        const block = location?.block;
        if (!block || block.type !== 'database') return null;

        const normalizeDatabase = window.Blocks?.normalizeDatabaseContent || ((content) => content);
        const existing = normalizeDatabase(block.content || {});
        const nextRows = Array.isArray(updates.appendRows)
            ? [
                ...(Array.isArray(existing.rows) ? existing.rows : []),
                ...updates.appendRows,
            ]
            : (Array.isArray(updates.rows) ? updates.rows : existing.rows);
        const nextContent = normalizeDatabase({
            ...existing,
            ...updates,
            columns: Array.isArray(updates.columns) ? updates.columns : existing.columns,
            rows: nextRows,
            sortColumn: Object.prototype.hasOwnProperty.call(updates, 'sortColumn')
                ? updates.sortColumn
                : existing.sortColumn,
            sortDirection: updates.sortDirection || existing.sortDirection,
        });

        return updateBlockFields(blockId, {
            content: nextContent,
        });
    }
    
    /**
     * Reorder blocks (drag and drop)
     */
    function reorderBlocks(draggedId, targetId, position = 'after') {
        if (!currentPage || draggedId === targetId) return;

        saveToHistory();

        const draggedLocation = findBlockLocation(draggedId);
        const targetLocation = findBlockLocation(targetId);
        if (!draggedLocation || !targetLocation) return;
        if (blockContainsDescendant(draggedLocation.block, targetId)) return;

        const [draggedBlock] = draggedLocation.siblings.splice(draggedLocation.index, 1);
        if (!draggedBlock) return;

        const refreshedTarget = findBlockLocation(targetId);
        if (!refreshedTarget) return;

        const insertIndex = position === 'before'
            ? refreshedTarget.index
            : refreshedTarget.index + 1;
        refreshedTarget.siblings.splice(insertIndex, 0, draggedBlock);

        refreshEditor();
        autoSave();
    }
    
    /**
     * Get current page
     */
    function getCurrentPage() {
        return currentPage;
    }
    
    /**
     * Export current page as markdown
     */
    function exportToMarkdown() {
        if (!currentPage) return '';
        return ImportExport.exportToMarkdown(currentPage);
    }
    
    /**
     * Export current page as HTML
     */
    function exportToHTML() {
        if (!currentPage) return '';
        return ImportExport.exportToHTML(currentPage);
    }
    
    /**
     * Export current page as JSON
     */
    function exportToJSON() {
        if (!currentPage) return '';
        return ImportExport.exportToJSON(currentPage);
    }
    
    /**
     * Import blocks to current page
     */
    function importBlocks(blocks, options = {}) {
        if (!currentPage) return [];
        
        saveToHistory();
        const normalizedBlocks = blocks.map(b => ({
            ...b,
            id: Storage.generateBlockId(),
            createdAt: Date.now()
        }));
        
        if (options.replace) {
            currentPage.blocks = normalizedBlocks;
        } else {
            currentPage.blocks.push(...normalizedBlocks);
        }
        
        refreshEditor();
        autoSave();
        return normalizedBlocks;
    }
    
    /**
     * Insert a database block
     */
    function insertDatabaseBlock(blockId) {
        return insertBlockAfter(blockId, 'database', {
            columns: ['Name', 'Status', 'Due Date'],
            rows: [
                ['Task 1', 'In Progress', 'Today'],
                ['Task 2', 'Not Started', 'Tomorrow']
            ],
            sortColumn: null,
            sortDirection: 'asc'
        });
    }
    
    /**
     * Show toast notification helper
     */
    function showToast(message, type = 'info') {
        if (window.Sidebar?.showToast) {
            window.Sidebar.showToast(message, type);
        }
    }
    
    /**
     * Add a block at the end of the document
     */
    function addBlockAtEnd(type = 'text', content = '') {
        if (!currentPage) return null;
        
        saveToHistory();
        
        const newBlock = Blocks.createBlock(type, content);
        currentPage.blocks.push(newBlock);
        
        refreshEditor();
        
        // Update empty state (will show hint again since we have blocks)
        updateEmptyState();
        
        // Focus the new block
        setTimeout(() => focusBlock(newBlock.id), 0);
        
        // Auto-save
        savePage();
        
        return newBlock;
    }
    
    /**
     * Get the current model for AI operations
     */
    function getCurrentModel() {
        return currentPage?.defaultModel || Blocks.getDefaultModel?.() || 'gpt-4o';
    }
    
    /**
     * Update empty state visibility
     */
    function updateEmptyState() {
        const emptyState = document.getElementById('empty-state');
        
        const isEmpty = !currentPage?.blocks?.length || 
            (currentPage.blocks.length === 1 && !currentPage.blocks[0].content);
        
        if (emptyState) {
            emptyState.style.display = isEmpty ? 'block' : 'none';
        }
        
        // Note: add-block-hint disabled - users can use the + button on blocks instead
    }
    
    // Expose to window for access from other modules
    window.Editor = {
        init,
        loadPage,
        insertBlockAfter,
        insertBlockBefore,
        insertBlockAtIndex,
        deleteBlock,
        duplicateBlock,
        moveBlockUp,
        moveBlockDown,
        convertBlockType,
        swapBlockType,
        wipeBlock,
        indentBlock,
        unindentBlock,
        setBlockColor,
        setTextColor,
        setBlockFontFamily,
        setBlockFontSize,
        setBlockFontWeight,
        setBlockTextAlign,
        updateDatabaseContent,
        reorderBlocks,
        focusBlock,
        savePage,
        undo,
        redo,
        getCurrentPage,
        getBlock,
        exportToMarkdown,
        exportToHTML,
        exportToJSON,
        importBlocks,
        insertDatabaseBlock,
        showInlineToolbar,
        hideInlineToolbar,
        updateBlockContent,
        updateBlockFields,
        updateBlocksFields,
        replaceBlockWithBlocks,
        insertBlocksAfter,
        insertBlocksBefore,
        getSectionRangeFromHeading,
        replaceSectionFromHeading,
        insertBlocksAfterSection,
        insertBlocksBeforeSection,
        deleteSectionFromHeading,
        moveSection,
        moveSectionUp,
        moveSectionDown,
        addBlockAtEnd,
        updatePageMetadata,
        getCurrentModel,
        refreshEditor,
        getBlockConversionInfo
    };
    
    return window.Editor;
})();
