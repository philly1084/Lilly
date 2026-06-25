/**
 * Slash Menu Module - Command palette triggered by "/"
 */

const SlashMenu = (function() {
    let menu = null;
    let filterInput = '';
    let selectedIndex = 0;
    let isVisible = false;
    let currentBlockId = null;
    let onSelectCallback = null;
    
    // Block type ordering
    const BLOCK_ORDER = [
        'text', 'heading_1', 'heading_2', 'heading_3',
        'todo', 'bulleted_list', 'numbered_list', 'toggle', 'quote',
        'divider', 'callout', 'code', 'math', 'mermaid', 'chart', 'image', 'ai_image', 'bookmark', 'database', 'ai'
    ];
    
    /**
     * Initialize the slash menu
     */
    function init() {
        menu = document.getElementById('slash-menu');
        if (!menu) return;
        
        setupEventListeners();
    }
    
    /**
     * Setup event listeners
     */
    function setupEventListeners() {
        // Menu item click
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.slash-item');
            if (item) {
                selectItem(item.dataset.type);
            }
        });
        
        // Keyboard navigation for menu items
        menu.addEventListener('keydown', (e) => {
            const item = e.target.closest('.slash-item');
            if (!item) return;
            
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectItem(item.dataset.type);
            }
        });
        
        // Prevent menu from closing when clicking inside
        menu.addEventListener('mousedown', (e) => {
            e.preventDefault();
        });
    }
    
    /**
     * Show the slash menu
     */
    function show(x, y, blockId = null) {
        if (!menu) return;
        
        currentBlockId = blockId;
        filterInput = '';
        selectedIndex = 0;
        isVisible = true;
        
        // Position menu within the visible viewport, including narrow mobile screens.
        const viewportPadding = 16;
        const menuWidth = Math.max(0, Math.min(324, window.innerWidth - (viewportPadding * 2)));
        const menuHeight = Math.max(0, Math.min(420, window.innerHeight - (viewportPadding * 2)));
        
        // Calculate position relative to viewport
        let posX = x;
        let posY = y + 20; // Add some offset below cursor
        
        // Ensure menu stays on screen horizontally
        if (posX + menuWidth > window.innerWidth - viewportPadding) {
            posX = window.innerWidth - menuWidth - viewportPadding;
        }
        if (posX < viewportPadding) {
            posX = viewportPadding;
        }
        
        // Ensure menu stays on screen vertically
        if (posY + menuHeight > window.innerHeight - viewportPadding) {
            // Show above cursor if not enough space below
            posY = y - menuHeight - 10;
        }
        if (posY < viewportPadding) {
            posY = viewportPadding;
        }
        
        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;
        menu.style.width = `${menuWidth}px`;
        menu.style.maxHeight = `${menuHeight}px`;
        menu.style.display = 'block';
        
        // Filter and render items
        filterItems('');
        
        // Add global listeners
        setTimeout(() => {
            document.addEventListener('keydown', handleKeyDown);
            document.addEventListener('click', handleClickOutside);
        }, 0);
    }
    
    /**
     * Hide the slash menu
     */
    function hide() {
        if (!menu) return;
        
        isVisible = false;
        menu.style.display = 'none';
        filterInput = '';
        selectedIndex = 0;
        currentBlockId = null;
        onSelectCallback = null;
        
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('click', handleClickOutside);
    }
    
    /**
     * Handle keyboard input
     */
    function handleKeyDown(e) {
        if (!isVisible) return;
        
        const items = menu.querySelectorAll('.slash-item:not(.hidden)');
        
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedIndex = (selectedIndex + 1) % items.length;
                updateSelection(items);
                scrollIntoView(items[selectedIndex]);
                break;
                
            case 'ArrowUp':
                e.preventDefault();
                selectedIndex = (selectedIndex - 1 + items.length) % items.length;
                updateSelection(items);
                scrollIntoView(items[selectedIndex]);
                break;
                
            case 'Enter':
                e.preventDefault();
                if (items[selectedIndex]) {
                    selectItem(items[selectedIndex].dataset.type);
                }
                break;
                
            case 'Escape':
                e.preventDefault();
                hide();
                break;
                
            case 'Backspace':
                if (filterInput.length === 0) {
                    hide();
                } else {
                    filterInput = filterInput.slice(0, -1);
                    filterItems(filterInput);
                }
                break;
                
            default:
                // Handle character input
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    filterInput += e.key.toLowerCase();
                    filterItems(filterInput);
                    e.preventDefault();
                }
                break;
        }
    }
    
    /**
     * Handle click outside to close
     */
    function handleClickOutside(e) {
        if (!menu.contains(e.target)) {
            hide();
        }
    }
    
    /**
     * Filter menu items
     */
    function filterItems(query) {
        const items = menu.querySelectorAll('.slash-item');
        const blockTypes = Blocks.getBlockTypes();
        
        let visibleCount = 0;
        
        items.forEach((item, index) => {
            const type = item.dataset.type;
            const blockType = blockTypes[type];
            if (!blockType) {
                item.classList.add('hidden');
                return;
            }
            
            const searchText = `${blockType.name} ${blockType.hint || ''}`.toLowerCase();
            
            if (!query || searchText.includes(query.toLowerCase())) {
                item.classList.remove('hidden');
                if (visibleCount === selectedIndex) {
                    item.classList.add('selected');
                } else {
                    item.classList.remove('selected');
                }
                visibleCount++;
            } else {
                item.classList.add('hidden');
                item.classList.remove('selected');
            }
        });
        
        // Reset selection if out of bounds
        if (selectedIndex >= visibleCount) {
            selectedIndex = 0;
            updateSelection(menu.querySelectorAll('.slash-item:not(.hidden)'));
        }
    }
    
    /**
     * Update visual selection and ARIA attributes
     */
    function updateSelection(items) {
        items.forEach((item, index) => {
            if (index === selectedIndex) {
                item.classList.add('selected');
                item.setAttribute('aria-selected', 'true');
                // Focus the selected item for screen readers
                item.setAttribute('tabindex', '0');
            } else {
                item.classList.remove('selected');
                item.setAttribute('aria-selected', 'false');
                item.setAttribute('tabindex', '-1');
            }
        });
    }
    
    /**
     * Scroll item into view
     */
    function scrollIntoView(item) {
        if (item) {
            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
    
    /**
     * Select an item
     */
    function selectItem(type) {
        const blockId = currentBlockId;
        const callback = onSelectCallback;
        hide();
        
        if (callback) {
            callback(type, blockId);
            return;
        }
        
        // Dispatch event for editor
        const event = new CustomEvent('slash-command', {
            detail: { type, blockId }
        });
        document.dispatchEvent(event);
    }
    
    /**
     * Set callback for selection
     */
    function setCallback(callback) {
        onSelectCallback = callback;
    }
    
    /**
     * Check if menu is visible
     */
    function isOpen() {
        return isVisible;
    }
    
    /**
     * Get current block ID
     */
    function getCurrentBlockId() {
        return currentBlockId;
    }
    
    return {
        init,
        show,
        hide,
        isOpen,
        setCallback,
        getCurrentBlockId
    };
})();

window.SlashMenu = SlashMenu;
