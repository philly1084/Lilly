/**
 * Sidebar Resizable Module
 * Adds a draggable handle to resize and collapse the sidebar
 */

class SidebarResizer {
  constructor() {
    this.sidebar = document.getElementById('sidebar');
    this.app = document.getElementById('app');
    this.resizeHandle = null;
    this.isResizing = false;
    this.isCollapsed = false;
    
    // Default and constraints
    this.minWidth = 200;
    this.maxWidth = 500;
    this.defaultWidth = 300;
    this.collapsedWidth = 60; // Width when collapsed (just icons)
    this.storageAvailable = this.checkStorageAvailability();
    
    // Load saved width
    this.currentWidth = this.loadWidth();
    this.isCollapsed = this.loadCollapsedState();
    
    this.init();
  }

  checkStorageAvailability() {
    if (typeof window.__webChatStorageAvailable === 'boolean') {
      return window.__webChatStorageAvailable === true;
    }

    if (window.sessionManager?.storageAvailable != null) {
      return window.sessionManager.storageAvailable === true;
    }

    return false;
  }

  storageGet(key) {
    if (window.sessionManager?.safeStorageGet) return window.sessionManager.safeStorageGet(key);
    this.storageAvailable = false;
    return null;
  }

  storageSet(key, value) {
    if (window.sessionManager?.safeStorageSet) return window.sessionManager.safeStorageSet(key, value);
    this.storageAvailable = false;
    return false;
  }
  
  init() {
    if (!this.sidebar || !this.app) return;
    
    this.createResizeHandle();
    this.applyInitialState();
    this.setupEventListeners();
    this.injectStyles();
  }
  
  /**
   * Create the resize handle element
   */
  createResizeHandle() {
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'sidebar-resize-handle';
    this.resizeHandle.innerHTML = `
      <div class="sidebar-resize-line"></div>
      <button class="sidebar-collapse-btn" title="Collapse sidebar" aria-label="Collapse sidebar" aria-controls="sidebar" aria-expanded="true">
        <i data-lucide="panel-left-close" class="w-4 h-4 collapse-icon"></i>
        <i data-lucide="panel-left-open" class="w-4 h-4 expand-icon hidden"></i>
      </button>
    `;
    
    // Insert after sidebar
    this.sidebar.parentNode.insertBefore(this.resizeHandle, this.sidebar.nextSibling);
    
    // Reinitialize icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }
  
  /**
   * Inject required styles
   */
  injectStyles() {
    if (document.getElementById('sidebar-resize-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'sidebar-resize-styles';
    style.textContent = `
      .sidebar-resize-handle {
        position: relative;
        width: 16px;
        margin-left: -8px;
        cursor: col-resize;
        z-index: 45;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background-color 0.2s;
      }
      
      .sidebar-resize-handle:hover {
        background-color: rgba(56, 189, 248, 0.1);
      }
      
      .sidebar-resize-handle.resizing {
        background-color: rgba(56, 189, 248, 0.2);
        cursor: col-resize;
      }
      
      .sidebar-resize-line {
        width: 2px;
        height: 100%;
        background-color: var(--border);
        transition: background-color 0.2s;
      }
      
      .sidebar-resize-handle:hover .sidebar-resize-line,
      .sidebar-resize-handle.resizing .sidebar-resize-line {
        background-color: var(--accent);
        width: 3px;
      }
      
      .sidebar-collapse-btn {
        position: absolute;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        z-index: 46;
      }
      
      .sidebar-collapse-btn:hover {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
        transform: translateX(-50%) scale(1.1);
      }

      .sidebar-collapse-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
        color: var(--text-primary);
        border-color: var(--accent);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
      }
      
      .sidebar-collapse-btn:active {
        transform: translateX(-50%) scale(0.95);
      }
      
      /* Collapsed sidebar state */
      .sidebar.collapsed {
        width: 60px !important;
        min-width: 60px !important;
      }
      
      .sidebar.collapsed .sidebar-btn-text,
      .sidebar.collapsed .sidebar-session-info,
      .sidebar.collapsed .session-actions,
      .sidebar.collapsed .sidebar-brand-copy,
      .sidebar.collapsed .sidebar-footer-label,
      .sidebar.collapsed .empty-state p {
        display: none !important;
      }

      .sidebar.collapsed .sidebar-brand-shell,
      .sidebar.collapsed .sidebar-footer {
        gap: 8px;
      }

      .sidebar.collapsed .sidebar-brand-card {
        justify-content: center;
      }

      .sidebar.collapsed .sidebar-brand-mark {
        width: 40px;
        height: 40px;
        border-radius: 12px;
      }
      
      .sidebar.collapsed .sidebar-full {
        display: none !important;
      }
      
      .sidebar.collapsed .sidebar-icon-only {
        display: flex !important;
      }
      
      .sidebar.collapsed #new-chat-btn {
        padding: 12px;
        width: 44px;
        height: 44px;
        margin: 0 auto;
        min-height: 44px;
        gap: 0;
        overflow: hidden;
      }
      
      .sidebar.collapsed .session-item {
        padding: 12px 8px;
        justify-content: center;
        min-height: 44px;
        gap: 0;
      }
      
      .sidebar.collapsed .session-icon {
        margin-right: 0;
      }

      .sidebar.collapsed #sessions-list {
        padding: 8px;
        overflow-x: hidden;
      }

      .sidebar.collapsed .empty-state {
        padding: 8px 0;
      }

      .sidebar.collapsed .empty-state svg,
      .sidebar.collapsed .empty-state i {
        width: 28px;
        height: 28px;
        margin: 0;
      }
      
      .sidebar.collapsed .p-4 {
        padding: 12px 8px;
      }
      
      .sidebar.collapsed .grid {
        grid-template-columns: 1fr;
      }
      
      /* Icon-only mode for collapsed state */
      .sidebar-icon-only {
        display: none !important;
      }
      
      /* Show expand icon when collapsed */
      .sidebar.collapsed ~ .sidebar-resize-handle .collapse-icon,
      .sidebar-resize-handle.collapsed .collapse-icon {
        display: none;
      }
      
      .sidebar.collapsed ~ .sidebar-resize-handle .expand-icon,
      .sidebar-resize-handle.collapsed .expand-icon {
        display: block !important;
      }
      
      /* Resize cursor on body when dragging */
      body.resizing-sidebar {
        cursor: col-resize;
        user-select: none;
      }
      
      body.resizing-sidebar * {
        user-select: none;
      }
      
      /* Mobile adjustments */
      @media (max-width: 768px) {
        .sidebar-resize-handle {
          display: none;
        }
      }
      
      /* Hide collapse button on mobile */
      @media (max-width: 768px) {
        .sidebar-collapse-btn {
          display: none;
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Collapse button click
    const collapseBtn = this.resizeHandle.querySelector('.sidebar-collapse-btn');
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCollapse();
    });
    
    // Double click on handle to toggle collapse
    this.resizeHandle.addEventListener('dblclick', () => {
      this.toggleCollapse();
    });
    
    // Mouse down on handle to start resize
    this.resizeHandle.addEventListener('mousedown', (e) => {
      // Ignore if clicking the collapse button
      if (e.target.closest('.sidebar-collapse-btn')) return;
      
      this.startResize(e);
    });
    
    // Touch events for mobile
    this.resizeHandle.addEventListener('touchstart', (e) => {
      if (e.target.closest('.sidebar-collapse-btn')) return;
      this.startResize(e.touches[0]);
    }, { passive: false });
  }
  
  /**
   * Start resizing
   */
  startResize(e) {
    this.isResizing = true;
    this.startX = e.clientX;
    this.startWidth = this.sidebar.offsetWidth;
    
    this.resizeHandle.classList.add('resizing');
    document.body.classList.add('resizing-sidebar');
    
    // Add global mouse/touch events
    document.addEventListener('mousemove', this.handleResize);
    document.addEventListener('mouseup', this.stopResize);
    document.addEventListener('touchmove', this.handleTouchResize, { passive: false });
    document.addEventListener('touchend', this.stopResize);
  }
  
  /**
   * Handle resize movement
   */
  handleResize = (e) => {
    if (!this.isResizing) return;
    
    const delta = e.clientX - this.startX;
    let newWidth = this.startWidth + delta;
    
    // Apply constraints
    newWidth = Math.max(this.minWidth, Math.min(this.maxWidth, newWidth));
    
    // Auto-collapse if dragged below minimum
    if (newWidth < this.minWidth * 0.75) {
      this.collapse();
      return;
    }
    
    // Auto-expand if dragging while collapsed
    if (this.isCollapsed && newWidth > this.minWidth * 0.5) {
      this.expand();
    }
    
    this.setWidth(newWidth);
  }
  
  /**
   * Handle touch resize
   */
  handleTouchResize = (e) => {
    if (!this.isResizing) return;
    e.preventDefault();
    this.handleResize(e.touches[0]);
  }
  
  /**
   * Stop resizing
   */
  stopResize = () => {
    this.isResizing = false;
    this.resizeHandle.classList.remove('resizing');
    document.body.classList.remove('resizing-sidebar');
    
    // Remove global events
    document.removeEventListener('mousemove', this.handleResize);
    document.removeEventListener('mouseup', this.stopResize);
    document.removeEventListener('touchmove', this.handleTouchResize);
    document.removeEventListener('touchend', this.stopResize);
    
    // Save width
    if (!this.isCollapsed) {
      this.saveWidth(this.currentWidth);
    }
  }
  
  /**
   * Toggle collapse state
   */
  toggleCollapse() {
    if (this.isCollapsed) {
      this.expand();
    } else {
      this.collapse();
    }
  }
  
  /**
   * Collapse sidebar
   */
  collapse() {
    this.isCollapsed = true;
    this.sidebar.classList.add('collapsed');
    this.resizeHandle.classList.add('collapsed');
    this.updateCollapseControl();
    this.saveCollapsedState(true);
    
    // Reinitialize icons to show correct chevron
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }
  
  /**
   * Expand sidebar
   */
  expand() {
    this.isCollapsed = false;
    this.sidebar.classList.remove('collapsed');
    this.resizeHandle.classList.remove('collapsed');
    
    // Restore previous width
    const savedWidth = this.loadWidth();
    this.setWidth(savedWidth);
    this.updateCollapseControl();
    this.saveCollapsedState(false);
    
    // Reinitialize icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }
  
  /**
   * Set sidebar width
   */
  setWidth(width) {
    this.currentWidth = width;
    this.sidebar.style.width = `${width}px`;
    this.sidebar.style.minWidth = `${width}px`;
  }
  
  /**
   * Apply initial state on load
   */
  applyInitialState() {
    if (this.isCollapsed) {
      this.sidebar.classList.add('collapsed');
      this.resizeHandle.classList.add('collapsed');
      this.updateCollapseControl();
      return;
    }

    this.sidebar.classList.remove('collapsed');
    this.resizeHandle.classList.remove('collapsed');
    this.setWidth(this.currentWidth);
    this.updateCollapseControl();
  }

  updateCollapseControl() {
    const collapseBtn = this.resizeHandle?.querySelector('.sidebar-collapse-btn');
    if (!collapseBtn) return;

    const isExpanded = !this.isCollapsed;
    const label = isExpanded ? 'Collapse sidebar' : 'Expand sidebar';
    collapseBtn.setAttribute('aria-expanded', String(isExpanded));
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.setAttribute('title', label);
  }

  reloadFromStorage() {
    this.currentWidth = this.loadWidth();
    this.isCollapsed = this.loadCollapsedState();
    this.applyInitialState();
  }
  
  /**
   * Save width to localStorage
   */
  saveWidth(width) {
    this.storageSet('kimibuilt_sidebar_width', width.toString());
  }
  
  /**
   * Load width from localStorage
   */
  loadWidth() {
    const saved = this.storageGet('kimibuilt_sidebar_width');
    if (saved) {
      const width = parseInt(saved, 10);
      if (width >= this.minWidth && width <= this.maxWidth) {
        return width;
      }
    }
    return this.defaultWidth;
  }
  
  /**
   * Save collapsed state
   */
  saveCollapsedState(collapsed) {
    this.storageSet('kimibuilt_sidebar_collapsed', collapsed ? '1' : '0');
  }
  
  /**
   * Load collapsed state
   */
  loadCollapsedState() {
    return this.storageGet('kimibuilt_sidebar_collapsed') === '1';
  }
  
  /**
   * Public API: Check if sidebar is collapsed
   */
  get isSidebarCollapsed() {
    return this.isCollapsed;
  }
  
  /**
   * Public API: Get current width
   */
  get width() {
    return this.isCollapsed ? this.collapsedWidth : this.currentWidth;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.sidebarResizer = new SidebarResizer();
});
