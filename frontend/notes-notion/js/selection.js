/**
 * Selection Module - Block selection, drag & drop, and keyboard navigation
 */

const Selection = (function() {
    let selectedBlockId = null;
    let draggedBlockId = null;
    let dragOverBlockId = null;
    let dragOverPosition = 'after';
    let isDragging = false;
    let dragPreview = null;
    let dropIndicator = null;
    
    // Event callbacks
    const callbacks = {
        onSelect: null,
        onDeselect: null,
        onDragStart: null,
        onDragEnd: null,
        onDrop: null,
        onDelete: null,
        onDuplicate: null,
        onMoveUp: null,
        onMoveDown: null,
        onDeleteSection: null,
        onNavigate: null
    };
    
    /**
     * Initialize selection module
     */
    function init(options = {}) {
        Object.assign(callbacks, options);
        setupGlobalListeners();
    }
    
    /**
     * Setup global event listeners
     */
    function setupGlobalListeners() {
        // Deselect when clicking outside blocks
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.block') && 
                !e.target.closest('.block-context-menu') &&
                !e.target.closest('.slash-menu') &&
                !e.target.closest('.inline-toolbar')) {
                deselectAll();
            }
        });

        document.addEventListener('contextmenu', (e) => {
            const handle = e.target.closest?.('.block-handle');
            const block = handle?.closest?.('.block');
            const blockId = block?.dataset?.blockId;
            if (!handle || !blockId) {
                return;
            }

            if (typeof e.stopImmediatePropagation === 'function') {
                e.stopImmediatePropagation();
            }
            e.stopPropagation();
            e.preventDefault();
            selectBlock(blockId);
            showTurnIntoMenu(blockId, e);
        }, true);
        
        // Keyboard navigation
        document.addEventListener('keydown', handleKeyDown);
    }
    
    /**
     * Handle keyboard events
     */
    function handleKeyDown(e) {
        // Don't handle if in input/textarea (unless specific shortcuts)
        const target = e.target;
        const isEditable = target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
        
        if (isEditable) {
            // Handle specific shortcuts even in editable elements
            if (e.key === 'Escape') {
                target.blur();
                hideAllPopups();
                if (selectedBlockId) {
                    const block = document.querySelector(`.block[data-block-id="${selectedBlockId}"]`);
                    if (block) block.focus();
                }
                return;
            }
            
            // Handle navigation in editable
            if (selectedBlockId && !e.shiftKey) {
                const selection = window.getSelection();
                const range = selection.getRangeAt(0);
                
                if (e.key === 'ArrowUp' && isAtStart(range, target)) {
                    e.preventDefault();
                    navigateToPrevious(selectedBlockId);
                } else if (e.key === 'ArrowDown' && isAtEnd(range, target)) {
                    e.preventDefault();
                    navigateToNext(selectedBlockId);
                }
            }
            
            // Handle tab for indent
            if (e.key === 'Tab' && selectedBlockId) {
                e.preventDefault();
                if (e.shiftKey) {
                    unindentBlock(selectedBlockId);
                } else {
                    indentBlock(selectedBlockId);
                }
            }
            
            return;
        }
        
        // Handle non-editable shortcuts
        if (!selectedBlockId) return;
        
        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                navigateToPrevious(selectedBlockId);
                break;
            case 'ArrowDown':
                e.preventDefault();
                navigateToNext(selectedBlockId);
                break;
            case 'Delete':
            case 'Backspace':
                if (!isEditable) {
                    e.preventDefault();
                    if (callbacks.onDelete) {
                        callbacks.onDelete(selectedBlockId);
                    }
                }
                break;
            case 'd':
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    if (callbacks.onDuplicate) {
                        callbacks.onDuplicate(selectedBlockId);
                    }
                }
                break;
            case 'Escape':
                deselectAll();
                hideAllPopups();
                break;
        }
    }
    
    /**
     * Hide all popups
     */
    function hideAllPopups() {
        // Hide context menu
        const contextMenu = document.getElementById('block-context-menu');
        if (contextMenu) contextMenu.style.display = 'none';
        
        // Hide color picker
        const colorPicker = document.getElementById('color-picker');
        if (colorPicker) colorPicker.style.display = 'none';
        
        // Hide slash menu
        if (window.SlashMenu) {
            window.SlashMenu.hide();
        }
        
        // Hide inline toolbar
        if (window.Editor) {
            window.Editor.hideInlineToolbar();
        }
    }
    
    /**
     * Check if cursor is at the start of an element
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
     * Check if cursor is at the end of an element
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
     * Select a block
     */
    function selectBlock(blockId, focus = true) {
        // Deselect current
        deselectAll();
        
        selectedBlockId = blockId;
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        
        if (block) {
            block.classList.add('selected');
            
            if (focus) {
                const input = block.querySelector(
                    '.block-input, textarea, input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]'
                );
                if (input) {
                    input.focus();
                    if (typeof input.setSelectionRange === 'function') {
                        const value = input.value || '';
                        input.setSelectionRange(value.length, value.length);
                    } else if (input.isContentEditable) {
                        const range = document.createRange();
                        const sel = window.getSelection();
                        range.selectNodeContents(input);
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                } else {
                    block.focus();
                }
            }
            
            if (callbacks.onSelect) {
                callbacks.onSelect(blockId);
            }
        }
    }
    
    /**
     * Deselect all blocks
     */
    function deselectAll() {
        if (selectedBlockId) {
            const block = document.querySelector(`.block[data-block-id="${selectedBlockId}"]`);
            if (block) {
                block.classList.remove('selected');
            }
            
            if (callbacks.onDeselect) {
                callbacks.onDeselect(selectedBlockId);
            }
            
            selectedBlockId = null;
        }
    }

    function resetState() {
        deselectAll();
        hideAllPopups();
        endDrag();
    }
    
    /**
     * Get currently selected block ID
     */
    function getSelectedBlockId() {
        return selectedBlockId;
    }
    
    /**
     * Navigate to previous block
     */
    function navigateToPrevious(blockId) {
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (!block) return;
        
        let prev = block.previousElementSibling;
        
        // Skip non-block elements
        while (prev && !prev.classList.contains('block')) {
            prev = prev.previousElementSibling;
        }
        
        if (prev) {
            const prevId = prev.dataset.blockId;
            selectBlock(prevId);
        }
        
        if (callbacks.onNavigate) {
            callbacks.onNavigate('up', blockId);
        }
    }
    
    /**
     * Navigate to next block
     */
    function navigateToNext(blockId) {
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (!block) return;
        
        let next = block.nextElementSibling;
        
        // Skip non-block elements
        while (next && !next.classList.contains('block')) {
            next = next.nextElementSibling;
        }
        
        if (next) {
            const nextId = next.dataset.blockId;
            selectBlock(nextId);
        }
        
        if (callbacks.onNavigate) {
            callbacks.onNavigate('down', blockId);
        }
    }
    
    /**
     * Indent a block (make it a child of previous)
     */
    function indentBlock(blockId) {
        if (callbacks.onIndent) {
            callbacks.onIndent(blockId);
        }
    }
    
    /**
     * Unindent a block (move out of parent)
     */
    function unindentBlock(blockId) {
        if (callbacks.onUnindent) {
            callbacks.onUnindent(blockId);
        }
    }
    
    /**
     * Setup drag and drop for a block
     */
    function setupDragAndDrop(blockElement, blockId) {
        const handle = blockElement.querySelector('.block-handle');
        if (!handle) return;
        
        // Mouse events for custom drag
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            e.preventDefault();
            startDrag(blockId, e);
        });
        
        // Also support click for context menu
        handle.addEventListener('click', (e) => {
            if (!isDragging) {
                e.stopPropagation();
                e.preventDefault();
                selectBlock(blockId);
                showContextMenu(blockId, e);
            }
        });

        // Explicit right-click support on the handle itself so the block menu
        // is available even when the editable content area is too small.
        handle.addEventListener('contextmenu', (e) => {
            if (typeof e.stopImmediatePropagation === 'function') {
                e.stopImmediatePropagation();
            }
            e.stopPropagation();
            e.preventDefault();
            selectBlock(blockId);
            showTurnIntoMenu(blockId, e);
        });
        
        // Right-click on block to show context menu
        blockElement.addEventListener('contextmenu', (e) => {
            // Don't show if clicking on input
            if (e.target.closest('.block-input, [contenteditable="true"]')) return;
            
            e.preventDefault();
            selectBlock(blockId);
            showContextMenu(blockId, e);
        });
        
        // Native drag events as fallback
        blockElement.addEventListener('dragstart', (e) => {
            draggedBlockId = blockId;
            blockElement.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', blockId);
        });
        
        blockElement.addEventListener('dragend', () => {
            endDrag();
        });
        
        blockElement.addEventListener('dragenter', (e) => {
            e.preventDefault();
            if (draggedBlockId && draggedBlockId !== blockId) {
                dragOverBlockId = blockId;
                showDropIndicator(blockElement, e);
            }
        });
        
        blockElement.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        
        blockElement.addEventListener('dragleave', (e) => {
            if (e.target === blockElement) {
                hideDropIndicator();
            }
        });
        
        blockElement.addEventListener('drop', (e) => {
            e.preventDefault();
            dragOverBlockId = blockId;
            showDropIndicator(blockElement, e);
            hideDropIndicator();
            
            if (draggedBlockId && draggedBlockId !== blockId) {
                if (callbacks.onDrop) {
                    callbacks.onDrop(draggedBlockId, blockId, dragOverPosition);
                }
            }
            
            endDrag();
        });
    }
    
    /**
     * Start drag operation
     */
    function startDrag(blockId, e) {
        isDragging = true;
        draggedBlockId = blockId;
        
        if (callbacks.onDragStart) {
            callbacks.onDragStart(blockId);
        }
        
        // Create drag preview
        createDragPreview(blockId, e);
        
        // Add global drag listeners
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        
        // Visual feedback
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (block) {
            block.style.opacity = '0.4';
        }
    }
    
    /**
     * Create drag preview element
     */
    function createDragPreview(blockId, e) {
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (!block) return;
        
        const preview = document.createElement('div');
        preview.className = 'drag-preview';
        
        // Get block content for preview
        const content = block.querySelector('.block-input');
        const text = content ? content.textContent.substring(0, 100) : 'Block';
        
        preview.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="color: var(--text-muted);">⋮⋮</span>
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${text || 'Empty block'}
                </span>
            </div>
        `;
        
        preview.style.left = `${e.clientX + 10}px`;
        preview.style.top = `${e.clientY + 10}px`;
        
        document.body.appendChild(preview);
        dragPreview = preview;
    }
    
    /**
     * Show drop indicator
     */
    function showDropIndicator(targetBlock, e) {
        hideDropIndicator();
        
        const indicator = document.createElement('div');
        indicator.className = 'drag-drop-indicator';
        
        const rect = targetBlock.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        // Determine if dropping above or below
        if (e.clientY < midpoint) {
            dragOverPosition = 'before';
            indicator.style.top = `${rect.top - 2}px`;
        } else {
            dragOverPosition = 'after';
            indicator.style.top = `${rect.bottom - 2}px`;
        }
        
        indicator.style.left = `${rect.left}px`;
        indicator.style.width = `${rect.width}px`;
        
        document.body.appendChild(indicator);
        dropIndicator = indicator;
        
        // Highlight target
        targetBlock.classList.add('drag-over');
    }
    
    /**
     * Hide drop indicator
     */
    function hideDropIndicator() {
        if (dropIndicator) {
            dropIndicator.remove();
            dropIndicator = null;
        }
        // Remove drag-over class from all blocks
        document.querySelectorAll('.block.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
    }
    
    /**
     * Handle drag move
     */
    function onDragMove(e) {
        if (dragPreview) {
            dragPreview.style.left = `${e.clientX + 10}px`;
            dragPreview.style.top = `${e.clientY + 10}px`;
        }
        
        // Find block under cursor
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        const targetBlock = elements.find(el => el.classList.contains('block') && el.dataset.blockId !== draggedBlockId);
        
        if (targetBlock) {
            dragOverBlockId = targetBlock.dataset.blockId;
            showDropIndicator(targetBlock, e);
        } else {
            hideDropIndicator();
        }
    }
    
    /**
     * Handle drag end
     */
    function onDragEnd(e) {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        
        // Handle drop
        if (draggedBlockId && dragOverBlockId && draggedBlockId !== dragOverBlockId) {
            if (callbacks.onDrop) {
                callbacks.onDrop(draggedBlockId, dragOverBlockId, dragOverPosition);
            }
        }
        
        endDrag();
    }
    
    /**
     * End drag operation
     */
    function endDrag() {
        hideDropIndicator();
        
        if (dragPreview) {
            dragPreview.remove();
            dragPreview = null;
        }
        
        if (draggedBlockId) {
            const block = document.querySelector(`.block[data-block-id="${draggedBlockId}"]`);
            if (block) {
                block.style.opacity = '';
                block.classList.remove('dragging');
            }
        }
        
        draggedBlockId = null;
        dragOverBlockId = null;
        dragOverPosition = 'after';
        
        setTimeout(() => {
            isDragging = false;
        }, 50);
        
        if (callbacks.onDragEnd) {
            callbacks.onDragEnd();
        }
    }
    
    /**
     * Show context menu for a block
     */
    function showContextMenu(blockId, e) {
        e.preventDefault();
        
        const menu = document.getElementById('block-context-menu');
        if (!menu) return;
        
        // Position menu
        const x = e.clientX;
        const y = e.clientY;
        
        // Keep menu on screen
        const menuWidth = 220;
        const menuHeight = 380;
        
        let posX = x;
        let posY = y;
        
        if (posX + menuWidth > window.innerWidth) {
            posX = window.innerWidth - menuWidth - 10;
        }
        if (posY + menuHeight > window.innerHeight) {
            posY = window.innerHeight - menuHeight - 10;
        }
        
        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;
        menu.style.display = 'block';
        menu.dataset.blockId = blockId;

        const block = window.Editor?.getBlock?.(blockId);
        const blockElement = document.querySelector(`.block[data-block-id="${blockId}"]`);
        const blockType = block?.type || blockElement?.dataset.blockType || '';
        const isHeading = /^heading_\d+$/.test(String(blockType));
        menu.querySelectorAll('[data-heading-only="true"]').forEach((item) => {
            item.style.display = isHeading ? '' : 'none';
        });

        // Select the block
        selectBlock(blockId, false);
        
        // Close menu on click outside
        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.style.display = 'none';
                document.removeEventListener('click', closeMenu);
            }
        };
        
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }
    
    /**
     * Setup context menu actions
     */
    function setupContextMenu() {
        const menu = document.getElementById('block-context-menu');
        if (!menu) return;
        
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;
            
            const action = item.dataset.action;
            const blockId = menu.dataset.blockId;
            
            menu.style.display = 'none';
            
            switch (action) {
                case 'ask-ai':
                    showBlockAIModal(blockId);
                    break;
                case 'duplicate':
                    if (callbacks.onDuplicate) callbacks.onDuplicate(blockId);
                    break;
                case 'move-up':
                    if (callbacks.onMoveUp) callbacks.onMoveUp(blockId);
                    break;
                case 'move-down':
                    if (callbacks.onMoveDown) callbacks.onMoveDown(blockId);
                    break;
                case 'delete':
                    if (callbacks.onDelete) callbacks.onDelete(blockId);
                    break;
                case 'delete-section':
                    if (callbacks.onDeleteSection) callbacks.onDeleteSection(blockId);
                    break;
                case 'turn-into':
                    showTurnIntoMenu(blockId);
                    break;
                case 'swap-blank':
                    showSwapBlankMenu(blockId);
                    break;
                case 'wipe-block':
                    if (callbacks.onWipeBlock) callbacks.onWipeBlock(blockId);
                    break;
                case 'color':
                    showColorPicker(blockId);
                    break;
            }
        });
    }
    
    /**
     * Show turn into menu (block type selector)
     */
    function showTurnIntoMenu(blockId, eventOrPoint = {}) {
        // Could show a simplified slash menu
        if (window.SlashMenu) {
            const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
            if (block) {
                const rect = block.getBoundingClientRect();
                const left = eventOrPoint.clientX || rect.left + 100;
                const top = eventOrPoint.clientY || rect.top;
                window.SlashMenu.show(left, top, blockId);
                window.SlashMenu.setCallback((type) => {
                    if (callbacks.onTurnInto) {
                        callbacks.onTurnInto(blockId, type);
                    }
                });
            }
        }
    }

    /**
     * Show a block selector for destructive blank swaps.
     */
    function showSwapBlankMenu(blockId) {
        if (window.SlashMenu) {
            const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
            if (block) {
                const rect = block.getBoundingClientRect();
                window.SlashMenu.show(rect.left + 100, rect.top);
                window.SlashMenu.setCallback((type) => {
                    if (callbacks.onSwapBlank) {
                        callbacks.onSwapBlank(blockId, type);
                    }
                });
            }
        }
    }
    
    /**
     * Show color picker
     */
    function showColorPicker(blockId) {
        const picker = document.getElementById('color-picker');
        if (!picker) return;
        
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (!block) return;
        
        const rect = block.getBoundingClientRect();
        
        // Position to right of block
        let left = rect.right + 10;
        let top = rect.top;
        
        // Keep on screen
        const pickerWidth = picker.offsetWidth || 220;
        const pickerHeight = Math.min(picker.scrollHeight || 520, window.innerHeight - 24);
        
        if (left + pickerWidth > window.innerWidth) {
            left = rect.left - pickerWidth - 10;
        }
        if (top + pickerHeight > window.innerHeight) {
            top = window.innerHeight - pickerHeight - 10;
        }
        
        picker.style.left = `${left}px`;
        picker.style.top = `${top}px`;
        picker.style.display = 'block';
        picker.dataset.blockId = blockId;
        
        // Close on outside click
        const closePicker = (e) => {
            if (!picker.contains(e.target)) {
                picker.style.display = 'none';
                document.removeEventListener('click', closePicker);
            }
        };
        
        setTimeout(() => {
            document.addEventListener('click', closePicker);
        }, 0);
    }
    
    /**
     * Setup color picker
     */
    function setupColorPicker() {
        const picker = document.getElementById('color-picker');
        if (!picker) return;
        
        picker.addEventListener('click', (e) => {
            const option = e.target.closest('.color-option, .style-option');
            if (!option) return;
            
            const blockId = picker.dataset.blockId;
            
            // Handle text color selection
            const textColor = option.dataset.textColor;
            if (textColor !== undefined && blockId) {
                if (callbacks.onTextColorChange) {
                    callbacks.onTextColorChange(blockId, textColor === 'default' ? null : textColor);
                }
                picker.style.display = 'none';
                return;
            }

            const fontFamily = option.dataset.fontFamily;
            if (fontFamily !== undefined && blockId) {
                if (callbacks.onFontFamilyChange) {
                    callbacks.onFontFamilyChange(blockId, fontFamily === 'default' ? null : fontFamily);
                }
                picker.style.display = 'none';
                return;
            }

            const fontSize = option.dataset.fontSize;
            if (fontSize !== undefined && blockId) {
                if (callbacks.onFontSizeChange) {
                    callbacks.onFontSizeChange(blockId, fontSize === 'default' ? null : fontSize);
                }
                picker.style.display = 'none';
                return;
            }

            const fontWeight = option.dataset.fontWeight;
            if (fontWeight !== undefined && blockId) {
                if (callbacks.onFontWeightChange) {
                    callbacks.onFontWeightChange(blockId, fontWeight === 'default' ? null : fontWeight);
                }
                picker.style.display = 'none';
                return;
            }

            const textAlign = option.dataset.textAlign;
            if (textAlign !== undefined && blockId) {
                if (callbacks.onTextAlignChange) {
                    callbacks.onTextAlignChange(blockId, textAlign === 'default' ? null : textAlign);
                }
                picker.style.display = 'none';
                return;
            }

            // Handle background color selection
            const bgColor = option.dataset.bgColor;
            if (bgColor !== undefined && blockId) {
                if (callbacks.onColorChange) {
                    callbacks.onColorChange(blockId, bgColor === 'default' ? null : bgColor);
                }
                picker.style.display = 'none';
                return;
            }
            
            // Legacy fallback for old data-color attribute
            const color = option.dataset.color;
            if (color !== undefined && blockId && callbacks.onColorChange) {
                callbacks.onColorChange(blockId, color === 'default' ? null : color);
                picker.style.display = 'none';
            }
        });
    }
    
    /**
     * Select all text in a block
     */
    function selectAllInBlock(blockId) {
        const block = document.querySelector(`.block[data-block-id="${blockId}"] .block-input`);
        if (!block) return;
        
        const range = document.createRange();
        range.selectNodeContents(block);
        
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    
    /**
     * Get selected text
     */
    function getSelectedText() {
        const sel = window.getSelection();
        return sel.toString();
    }
    
    /**
     * Replace selected text
     */
    function replaceSelectedText(replacement) {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
        
        // Collapse selection to end
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
    
    /**
     * Show AI modal for a specific block
     */
    function showBlockAIModal(blockId) {
        const block = document.querySelector(`.block[data-block-id="${blockId}"]`);
        if (!block) return;

        const blockInput = block.querySelector('.block-input, [contenteditable="true"]');
        const blockContent = blockInput ? blockInput.textContent : '';

        const promptText = [
            `Help me edit block ${blockId}.`,
            'Use the current page context and suggest or draft improved content for this block.',
            `Current block content: ${blockContent || '(empty)'}`
        ].join('\n\n');

        if (window.AgentUI?.openWithPrompt) {
            window.AgentUI.openWithPrompt(promptText);
            return;
        }

        if (window.Agent?.ask) {
            window.Agent.ask(promptText).catch((error) => {
                console.error('Block AI request failed:', error);
            });
            return;
        }

        alert('AI assistant is not available right now.');
    }
    
    // Initialize context menus
    setupContextMenu();
    setupColorPicker();
    
    return {
        init,
        selectBlock,
        deselectAll,
        resetState,
        getSelectedBlockId,
        setupDragAndDrop,
        showContextMenu,
        selectAllInBlock,
        getSelectedText,
        replaceSelectedText,
        navigateToPrevious,
        navigateToNext,
        // Expose callbacks for external setup
        setCallbacks: (newCallbacks) => Object.assign(callbacks, newCallbacks)
    };
})();

window.Selection = Selection;
