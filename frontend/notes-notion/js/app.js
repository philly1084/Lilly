/**
 * App Module - Main application controller
 */

(function() {
    'use strict';
    
    // App state
    const state = {
        initialized: false,
        backendConnected: false,
        currentView: 'editor' // editor, trash, settings
    };
    
    /**
     * Initialize the application
     */
    async function init() {
        if (state.initialized) return;
        
        console.log('[Notes] Initializing Notes - Lilly Style');
        
        // Initialize connection status UI
        updateConnectionStatus('checking');
        
        // Check backend connection
        const health = await API.checkHealth();
        state.backendConnected = health.connected;
        console.log(state.backendConnected ? '[Notes] Backend connected' : '[Notes] Backend offline - using local mode');

        if (state.backendConnected && typeof Storage.initializeRemote === 'function') {
            await Storage.initializeRemote();
        }
        
        // Update connection status UI
        updateConnectionStatus(state.backendConnected ? 'connected' : 'disconnected');
        
        // Start periodic health checks
        startHealthCheckInterval();
        
        // Initialize modules
        initModules();
        
        // Load initial page
        loadInitialPage();
        
        // Setup global shortcuts
        setupGlobalShortcuts();
        
        state.initialized = true;
        
        // Show welcome toast
        setTimeout(() => {
            const mode = state.backendConnected ? 'connected' : 'offline';
            Sidebar.showToast(`Welcome! (${mode} mode) Press "/" for commands or ✨ for AI`, 'info');
        }, 1000);
    }
    
    /**
     * Update connection status UI
     */
    function updateConnectionStatus(status) {
        const indicator = document.getElementById('connection-indicator');
        const text = document.getElementById('connection-text');
        
        if (!indicator || !text) return;
        
        indicator.className = 'connection-indicator';
        
        switch (status) {
            case 'connected':
                indicator.classList.add('connected');
                text.textContent = 'AI Connected';
                break;
            case 'disconnected':
                indicator.classList.add('disconnected');
                text.textContent = 'Offline Mode';
                break;
            case 'checking':
            default:
                indicator.classList.add('checking');
                text.textContent = 'Connecting...';
                break;
        }
    }
    
    /**
     * Start periodic health check
     */
    function startHealthCheckInterval() {
        // Check every 30 seconds
        setInterval(async () => {
            const health = await API.checkHealth();
            const wasConnected = state.backendConnected;
            state.backendConnected = health.connected;
            
            // Update UI
            updateConnectionStatus(health.connected ? 'connected' : 'disconnected');
            
            // Show toast if status changed
            if (wasConnected !== health.connected) {
                if (health.connected) {
                    const storageStatus = Storage.getStorageStatus?.() || {};
                    if (typeof Storage.initializeRemote === 'function' && storageStatus.remoteAvailable !== true) {
                        await Storage.initializeRemote();
                    }
                    Sidebar.showToast('Backend connected!', 'success');
                } else {
                    Sidebar.showToast('Backend disconnected - using offline mode', 'warning');
                }
            }
        }, 30000);
    }
    
    /**
     * Initialize all modules
     */
    function initModules() {
        // Initialize blocks
        console.log('[Notes] Initializing blocks...');
        
        // Initialize Mermaid
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
                securityLevel: 'loose'
            });
            console.log('[Notes] Mermaid diagrams ready');
        }
        
        // Setup Mermaid lazy loading observer
        setupMermaidLazyLoading();
        
        // Initialize storage
        console.log('[Notes] Storage ready');
        
        // Initialize AI Agent
        if (typeof Agent !== 'undefined') {
            console.log('[Notes] Initializing AI Agent...');
            Agent.init();
        }
        
        // Initialize Agent UI
        if (typeof AgentUI !== 'undefined') {
            console.log('[Notes] Initializing Agent UI...');
            AgentUI.init();
        }
        
        // Initialize selection
        console.log('[Notes] Initializing selection...');
        Selection.init({
            onSelect: (blockId) => {
                // Block selected
            },
            onDeselect: (blockId) => {
                // Block deselected
            },
            onDelete: (blockId) => {
                Editor.deleteBlock(blockId);
            },
            onDuplicate: (blockId) => {
                Editor.duplicateBlock(blockId);
            },
            onMoveUp: (blockId) => {
                Editor.moveBlockUp(blockId);
            },
            onMoveDown: (blockId) => {
                Editor.moveBlockDown(blockId);
            },
            onDrop: (draggedId, targetId, position) => {
                Editor.reorderBlocks(draggedId, targetId, position);
            },
            onIndent: (blockId) => {
                Editor.indentBlock(blockId);
            },
            onUnindent: (blockId) => {
                Editor.unindentBlock(blockId);
            },
            onColorChange: (blockId, color) => {
                Editor.setBlockColor(blockId, color);
            },
            onTextColorChange: (blockId, color) => {
                Editor.setTextColor(blockId, color);
            },
            onFontFamilyChange: (blockId, fontFamily) => {
                Editor.setBlockFontFamily(blockId, fontFamily);
            },
            onFontSizeChange: (blockId, fontSize) => {
                Editor.setBlockFontSize(blockId, fontSize);
            },
            onFontWeightChange: (blockId, fontWeight) => {
                Editor.setBlockFontWeight(blockId, fontWeight);
            },
            onTextAlignChange: (blockId, textAlign) => {
                Editor.setBlockTextAlign(blockId, textAlign);
            },
            onTurnInto: (blockId, type) => {
                const conversionInfo = Editor.getBlockConversionInfo?.(blockId, type);
                if (conversionInfo?.requiresConfirmation) {
                    const confirmed = window.confirm(conversionInfo.message || 'Convert this block and drop unsupported content?');
                    if (!confirmed) {
                        return;
                    }
                }

                Editor.convertBlockType(blockId, type);
            },
            onSwapBlank: (blockId, type) => {
                const typeName = Blocks.getBlockTypes?.()?.[type]?.name || type;
                const confirmed = window.confirm(`Swap this block to a blank ${typeName} block? Current content and block-specific settings will be cleared.`);
                if (!confirmed) {
                    return;
                }

                Editor.swapBlockType(blockId, type);
                Sidebar.showToast(`Swapped to blank ${typeName}`, 'success');
            },
            onWipeBlock: (blockId) => {
                const block = Editor.getBlock?.(blockId);
                const typeName = Blocks.getBlockTypes?.()?.[block?.type]?.name || 'block';
                const confirmed = window.confirm(`Wipe this ${typeName} block? Current content and block-specific settings will be cleared.`);
                if (!confirmed) {
                    return;
                }

                Editor.wipeBlock(blockId);
                Sidebar.showToast(`Wiped ${typeName}`, 'success');
            },
            onDeleteSection: (blockId) => {
                const block = Editor.getBlock?.(blockId);
                const title = typeof block?.content === 'string'
                    ? block.content
                    : (block?.content?.text || 'this section');
                const confirmed = window.confirm(`Delete "${title}" and every block under that heading?`);
                if (!confirmed) {
                    return;
                }

                if (Editor.deleteSectionFromHeading?.(blockId)) {
                    Sidebar.showToast('Section deleted', 'success');
                }
            }
        });
        
        // Initialize slash menu
        console.log('[Notes] Initializing slash menu...');
        SlashMenu.init();
        
        // Initialize editor
        console.log('[Notes] Initializing editor...');
        Editor.init();
        
        // Initialize sidebar
        console.log('[Notes] Initializing sidebar...');
        Sidebar.init();

        if (window.NotesTts?.init) {
            console.log('[Notes] Initializing realtime TTS...');
            window.NotesTts.init();
        }
    }
    
    /**
     * Load initial page
     */
    function loadInitialPage() {
        const currentId = Storage.getCurrentPageId();
        
        if (currentId) {
            const page = Storage.getPage(currentId);
            if (page) {
                Sidebar.loadPage(currentId);
                return;
            }
        }
        
        // Load first page or create new
        const pages = Storage.getPages();
        if (pages.length > 0) {
            Sidebar.loadPage(pages[0].id);
        } else {
            Sidebar.createNewPage();
        }
    }
    
    /**
     * Setup global keyboard shortcuts
     */
    function setupGlobalShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Escape key closes all modals and pickers
            if (e.key === 'Escape') {
                // Close emoji picker
                const emojiPicker = document.getElementById('emoji-picker');
                if (emojiPicker && emojiPicker.style.display !== 'none') {
                    e.preventDefault();
                    emojiPicker.style.display = 'none';
                    return;
                }
                
                // Close color picker
                const colorPicker = document.getElementById('color-picker');
                if (colorPicker && colorPicker.style.display !== 'none') {
                    e.preventDefault();
                    colorPicker.style.display = 'none';
                    return;
                }
                
                // Close block context menu
                const contextMenu = document.getElementById('block-context-menu');
                if (contextMenu && contextMenu.style.display !== 'none') {
                    e.preventDefault();
                    contextMenu.style.display = 'none';
                    return;
                }
                
                // Close slash menu
                if (SlashMenu.isOpen()) {
                    e.preventDefault();
                    SlashMenu.hide();
                    return;
                }
            }
            
            // Cmd/Ctrl + P: New page
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                Sidebar.createNewPage();
            }
            
            // Cmd/Ctrl + S: Save
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                Editor.savePage();
                Sidebar.showToast('Page saved', 'success');
            }
            
            // Cmd/Ctrl + E: Export
            if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
                e.preventDefault();
                const markdown = Editor.exportToMarkdown();
                const page = Editor.getCurrentPage();
                downloadFile(markdown, `${page?.title || 'page'}.md`, 'text/markdown');
                Sidebar.showToast('Exported to Markdown', 'success');
            }
            
            // Cmd/Ctrl + B: Toggle sidebar
            if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                e.preventDefault();
                document.getElementById('sidebar-toggle')?.click();
            }
            
            // Cmd/Ctrl + K: Command Palette
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                openCommandPalette();
            }
            
            // Cmd/Ctrl + /: Help
            if ((e.metaKey || e.ctrlKey) && e.key === '/') {
                e.preventDefault();
                showHelp();
            }
        });
    }
    
    /**
     * Show help modal
     */
    function showHelp() {
        const existingModal = document.querySelector('.ai-modal[data-help-modal="true"]');
        if (existingModal) {
            existingModal.querySelector('[data-help-close]')?.focus();
            return existingModal;
        }

        const previouslyFocusedElement = document.activeElement;
        const helpContent = `
            <div class="notes-help-grid">
                <section aria-labelledby="notes-help-general">
                    <h3 id="notes-help-general">General</h3>
                    <dl class="notes-shortcut-list">
                        <div><dt><kbd>Ctrl/⌘ P</kbd></dt><dd>New page</dd></div>
                        <div><dt><kbd>Ctrl/⌘ S</kbd></dt><dd>Save page</dd></div>
                        <div><dt><kbd>Ctrl/⌘ E</kbd></dt><dd>Export to Markdown</dd></div>
                        <div><dt><kbd>Ctrl/⌘ B</kbd></dt><dd>Toggle sidebar</dd></div>
                        <div><dt><kbd>Ctrl/⌘ K</kbd></dt><dd>AI Assistant</dd></div>
                        <div><dt><kbd>Ctrl/⌘ /</kbd></dt><dd>This help</dd></div>
                    </dl>
                </section>
                <section aria-labelledby="notes-help-editor">
                    <h3 id="notes-help-editor">Editor</h3>
                    <dl class="notes-shortcut-list">
                        <div><dt><kbd>/</kbd></dt><dd>Show slash menu</dd></div>
                        <div><dt><kbd>Enter</kbd></dt><dd>New block</dd></div>
                        <div><dt><kbd>Shift Enter</kbd></dt><dd>New line in the same block</dd></div>
                        <div><dt><kbd>Tab</kbd></dt><dd>Indent block</dd></div>
                        <div><dt><kbd>Shift Tab</kbd></dt><dd>Unindent block</dd></div>
                        <div><dt><kbd>Backspace</kbd></dt><dd>Delete an empty block</dd></div>
                    </dl>
                </section>
                <section aria-labelledby="notes-help-markdown">
                    <h3 id="notes-help-markdown">Markdown shortcuts</h3>
                    <dl class="notes-shortcut-list">
                        <div><dt><kbd>#</kbd></dt><dd>Heading 1</dd></div>
                        <div><dt><kbd>##</kbd></dt><dd>Heading 2</dd></div>
                        <div><dt><kbd>###</kbd></dt><dd>Heading 3</dd></div>
                        <div><dt><kbd>-</kbd></dt><dd>Bulleted list</dd></div>
                        <div><dt><kbd>1.</kbd></dt><dd>Numbered list</dd></div>
                        <div><dt><kbd>[]</kbd></dt><dd>To-do</dd></div>
                        <div><dt><kbd>&gt;</kbd></dt><dd>Quote</dd></div>
                        <div><dt><kbd>---</kbd></dt><dd>Divider</dd></div>
                        <div><dt><kbd>\`\`\`</kbd></dt><dd>Code block</dd></div>
                    </dl>
                </section>
                <section aria-labelledby="notes-help-selection">
                    <h3 id="notes-help-selection">Selection</h3>
                    <ul>
                        <li>Select text to show the Ask AI toolbar.</li>
                        <li>Drag the block handle to reorder blocks.</li>
                        <li>Click the block handle for the block menu.</li>
                    </ul>
                </section>
                <section aria-labelledby="notes-help-agent">
                    <h3 id="notes-help-agent">AI Agent</h3>
                    <p><kbd>Ctrl/⌘ Shift A</kbd> opens AI Agent chat.</p>
                    <ul>
                        <li>Ask questions about your page.</li>
                        <li>Request edits, summaries, or new content.</li>
                        <li>The agent can see your entire page content.</li>
                    </ul>
                </section>
            </div>
        `;
        
        const modal = document.createElement('div');
        modal.className = 'ai-modal';
        modal.dataset.helpModal = 'true';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'notes-help-modal-title');
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="ai-modal-content notes-help-dialog" tabindex="-1">
                <div class="ai-modal-header">
                    <span aria-hidden="true">Keys</span>
                    <span id="notes-help-modal-title">Keyboard Shortcuts</span>
                    <button class="icon-btn notes-help-close" type="button" data-help-close aria-label="Close keyboard shortcuts"><span aria-hidden="true">×</span></button>
                </div>
                <div class="notes-help-body">
                    ${helpContent}
                </div>
            </div>
        `;

        const restoreFocus = () => {
            if (previouslyFocusedElement && typeof previouslyFocusedElement.focus === 'function' && document.contains(previouslyFocusedElement)) {
                previouslyFocusedElement.focus();
            }
        };

        const closeHelp = () => {
            document.removeEventListener('keydown', handleHelpKeydown);
            modal.remove();
            restoreFocus();
        };

        function handleHelpKeydown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                closeHelp();
            }
        }
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('[data-help-close]')) {
                closeHelp();
            }
        });
        
        document.body.appendChild(modal);
        document.addEventListener('keydown', handleHelpKeydown);
        modal.querySelector('[data-help-close]')?.focus();

        return modal;
    }
    
    /**
     * Download a file
     */
    function downloadFile(content, filename, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    /**
     * Show emoji categories in picker
     */
    function setupEmojiPicker() {
        const picker = document.getElementById('emoji-picker');
        if (!picker) return;
        
        const categories = picker.querySelectorAll('.emoji-category');
        categories.forEach(cat => {
            cat.addEventListener('click', () => {
                categories.forEach(c => c.classList.remove('active'));
                cat.classList.add('active');
                renderEmojiGrid(cat.dataset.category);
            });
        });
        
        // Search
        const searchInput = document.getElementById('emoji-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const query = searchInput.value.toLowerCase();
                filterEmojis(query);
            });
        }
    }
    
    /**
     * Render emoji grid for category
     */
    function renderEmojiGrid(category) {
        const grid = document.getElementById('emoji-grid');
        if (!grid) return;
        
        const emojis = Blocks.getEmojis(category);
        grid.innerHTML = '';
        
        emojis.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.addEventListener('click', () => {
                // Handle emoji selection
                const picker = document.getElementById('emoji-picker');
                if (picker) {
                    picker.style.display = 'none';
                }
            });
            grid.appendChild(span);
        });
    }
    
    /**
     * Filter emojis by search
     */
    function filterEmojis(query) {
        const grid = document.getElementById('emoji-grid');
        if (!grid) return;
        
        if (!query) {
            renderEmojiGrid('recent');
            return;
        }
        
        // Search all categories
        const allCategories = Blocks.getEmojiCategories();
        const results = [];
        
        // This is a simple search - in production you'd want proper emoji metadata
        allCategories.forEach(cat => {
            const emojis = Blocks.getEmojis(cat);
            results.push(...emojis);
        });
        
        // Remove duplicates and limit
        const unique = [...new Set(results)].slice(0, 64);
        
        grid.innerHTML = '';
        unique.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            grid.appendChild(span);
        });
    }
    
    /**
     * Handle window resize
     */
    function handleResize() {
        // Close slash menu if open
        if (SlashMenu.isOpen()) {
            SlashMenu.hide();
        }
    }
    
    /**
     * Handle before unload
     */
    function handleBeforeUnload(e) {
        // Save any pending changes
        Editor.savePage();
    }
    
    // ===== Command Palette =====
    
    let commandPaletteOpen = false;
    let commandPaletteSelectedIndex = 0;
    let commandPaletteItems = [];
    
    const commandPaletteCommands = [
        { id: 'new-page', name: 'New page', icon: '📄', shortcut: 'Ctrl+P', action: () => Sidebar.createNewPage() },
        { id: 'save', name: 'Save page', icon: '💾', shortcut: 'Ctrl+S', action: () => { Editor.savePage(); Sidebar.showToast('Page saved', 'success'); } },
        { id: 'export-markdown', name: 'Export to Markdown', icon: '📝', shortcut: 'Ctrl+E', action: () => {
            const markdown = Editor.exportToMarkdown();
            const page = Editor.getCurrentPage();
            downloadFile(markdown, `${page?.title || 'page'}.md`, 'text/markdown');
            Sidebar.showToast('Exported to Markdown', 'success');
        }},
        { id: 'toggle-sidebar', name: 'Toggle sidebar', icon: '◫', shortcut: 'Ctrl+B', action: () => document.getElementById('sidebar-toggle')?.click() },
        { id: 'help', name: 'Keyboard shortcuts', icon: '⌨️', shortcut: 'Ctrl+/', action: showHelp },
        { id: 'focus-title', name: 'Focus title', icon: 'T', action: () => document.getElementById('page-title')?.focus() },
        { id: 'new-block', name: 'New block below', icon: '➕', action: () => {
            const page = Editor.getCurrentPage();
            if (page?.blocks?.length > 0) {
                const lastBlock = page.blocks[page.blocks.length - 1];
                const newBlock = Editor.insertBlockAfter(lastBlock.id, 'text');
                if (newBlock) Editor.focusBlock(newBlock.id);
            }
        }},
        { 
            id: 'ai-agent', 
            name: 'Ask AI Agent', 
            icon: '✨', 
            shortcut: 'Ctrl+Shift+A', 
            action: () => {
                if (window.AgentUI) {
                    window.AgentUI.openChat();
                }
            }
        }
    ];
    
    function openCommandPalette() {
        const palette = document.getElementById('command-palette');
        if (!palette) return;
        
        commandPaletteOpen = true;
        commandPaletteSelectedIndex = 0;
        palette.classList.remove('is-hidden');
        palette.classList.add('is-open');
        palette.style.display = 'flex';
        
        const input = document.getElementById('command-palette-input');
        if (input) {
            input.value = '';
            input.setAttribute('aria-expanded', 'true');
            input.focus();
        }
        
        renderCommandPaletteResults('');
    }
    
    function closeCommandPalette() {
        const palette = document.getElementById('command-palette');
        if (palette) {
            palette.classList.remove('is-open');
            palette.classList.add('is-hidden');
            palette.style.display = 'none';
        }
        const input = document.getElementById('command-palette-input');
        if (input) {
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }
        commandPaletteOpen = false;
    }
    
    function renderCommandPaletteResults(query) {
        const resultsContainer = document.getElementById('command-palette-results');
        if (!resultsContainer) return;
        
        const filtered = commandPaletteCommands.filter(cmd => 
            cmd.name.toLowerCase().includes(query.toLowerCase())
        );
        
        commandPaletteItems = filtered;
        
        if (filtered.length === 0) {
            resultsContainer.innerHTML = '<div class="command-palette-section"><div class="command-palette-section-title">No results</div></div>';
            document.getElementById('command-palette-input')?.removeAttribute('aria-activedescendant');
            return;
        }
        
        const html = filtered.map((cmd, index) => `
            <div id="command-palette-option-${index}" class="command-palette-item ${index === commandPaletteSelectedIndex ? 'selected' : ''}" data-index="${index}" role="option" aria-selected="${index === commandPaletteSelectedIndex}">
                <div class="command-palette-item-icon">${cmd.icon}</div>
                <div class="command-palette-item-info">
                    <div class="command-palette-item-name">${cmd.name}</div>
                </div>
                ${cmd.shortcut ? `<span class="command-palette-item-shortcut">${cmd.shortcut}</span>` : ''}
            </div>
        `).join('');
        
        resultsContainer.innerHTML = `<div class="command-palette-section">${html}</div>`;
        renderCommandPaletteSelection();
        
        // Add click handlers
        resultsContainer.querySelectorAll('.command-palette-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                executeCommand(index);
            });
            item.addEventListener('mouseenter', () => {
                commandPaletteSelectedIndex = parseInt(item.dataset.index);
                renderCommandPaletteSelection();
            });
        });
    }
    
    function renderCommandPaletteSelection() {
        const items = document.querySelectorAll('.command-palette-item');
        items.forEach((item, index) => {
            const isSelected = index === commandPaletteSelectedIndex;
            item.classList.toggle('selected', isSelected);
            item.setAttribute('aria-selected', String(isSelected));
        });
        const input = document.getElementById('command-palette-input');
        const activeItem = items[commandPaletteSelectedIndex];
        if (activeItem) {
            input?.setAttribute('aria-activedescendant', activeItem.id);
        } else {
            input?.removeAttribute('aria-activedescendant');
        }
    }
    
    function executeCommand(index) {
        const cmd = commandPaletteItems[index];
        if (cmd && cmd.action) {
            closeCommandPalette();
            cmd.action();
        }
    }
    
    // Command palette event listeners
    document.addEventListener('DOMContentLoaded', () => {
        const input = document.getElementById('command-palette-input');
        if (input) {
            input.addEventListener('input', (e) => {
                commandPaletteSelectedIndex = 0;
                renderCommandPaletteResults(e.target.value);
            });
            
            input.addEventListener('keydown', (e) => {
                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        commandPaletteSelectedIndex = Math.min(commandPaletteSelectedIndex + 1, commandPaletteItems.length - 1);
                        renderCommandPaletteSelection();
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        commandPaletteSelectedIndex = Math.max(commandPaletteSelectedIndex - 1, 0);
                        renderCommandPaletteSelection();
                        break;
                    case 'Enter':
                        e.preventDefault();
                        executeCommand(commandPaletteSelectedIndex);
                        break;
                    case 'Escape':
                        e.preventDefault();
                        closeCommandPalette();
                        break;
                }
            });
        }
    });
    
    // Event listeners
    window.addEventListener('DOMContentLoaded', init);
    window.addEventListener('resize', debounce(handleResize, 100));
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    // Handle visibility change (tab switch)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            Editor.savePage();
        }
    });
    
    /**
     * Debounce utility
     */
    function debounce(fn, delay) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), delay);
        };
    }
    
    // Expose app to window
    window.NotesApp = {
        state,
        showHelp,
        downloadFile,
        openCommandPalette,
        closeCommandPalette
    };
    
    // Expose closeCommandPalette globally for the onclick handler
    window.closeCommandPalette = closeCommandPalette;
    
    /**
     * Setup Mermaid lazy loading - only render diagrams when they come into view
     */
    function setupMermaidLazyLoading() {
        if (typeof IntersectionObserver === 'undefined') return;
        
        // Create a single observer for all mermaid diagrams
        const mermaidObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const mermaidEl = entry.target;
                    
                    // Skip if already rendered
                    if (mermaidEl.dataset.rendered === 'true') return;
                    mermaidEl.dataset.rendered = 'true';
                    
                    // Stop observing this element
                    mermaidObserver.unobserve(mermaidEl);
                    
                    // Render this specific diagram
                    if (typeof mermaid !== 'undefined') {
                        try {
                            mermaid.run({ querySelector: '#' + mermaidEl.id });
                        } catch (err) {
                            console.warn('Failed to render mermaid diagram:', err);
                        }
                    }
                }
            });
        }, {
            rootMargin: '100px', // Start rendering 100px before coming into view
            threshold: 0.1
        });
        
        // Expose function to observe new mermaid elements
        window.observeMermaidElement = (element) => {
            if (element && element.classList.contains('mermaid')) {
                mermaidObserver.observe(element);
            }
        };
    }
    
})();
