/**
 * File Manager Module for Web-Chat
 * Provides a modal interface for managing session files/artifacts
 * Handles downloads with retry logic and connection recovery
 */

class FileManager {
  constructor() {
    this.files = [];
    this.filesBySession = new Map();
    this.activeSessionId = '';
    this.modalElement = null;
    this.isOpen = false;
    this.downloadQueue = new Map(); // Track ongoing downloads
    this.retryAttempts = new Map(); // Track retry counts
    this.maxRetries = 3;
    this.downloadTimeoutMs = 5 * 60 * 1000;
    this.isRefreshing = false;
    this.refreshPromise = null;
    this.lastFocusedElement = null;
    
    this.init();
  }

  init() {
    this.createModal();
    this.injectStyles();
    this.setupKeyboardShortcuts();
    this.setupSessionListeners();
    
    // Listen for connection status changes
    window.addEventListener('online', () => this.handleConnectionRestored());
    window.addEventListener('offline', () => this.handleConnectionLost());
    
    // Listen for visibility changes (browser sleep/wake)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isOpen) {
        void this.refreshFiles({ announce: false });
      }
    });
  }

  setupSessionListeners() {
    if (!window.sessionManager?.addEventListener) {
      return;
    }

    window.sessionManager.addEventListener('sessionCreated', () => {
      void this.refreshFiles({ announce: false });
    });

    window.sessionManager.addEventListener('sessionSwitched', () => {
      this.applySessionFiles(this.getSessionId());
      void this.refreshFiles({ announce: false });
    });

    window.sessionManager.addEventListener('sessionPromoted', () => {
      void this.refreshFiles({ announce: false });
    });

    window.sessionManager.addEventListener('sessionDeleted', () => {
      void this.refreshFiles({ announce: false });
    });
  }

  applySessionFiles(sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    this.activeSessionId = normalizedSessionId;
    if (!normalizedSessionId || window.sessionManager?.isLocalSession?.(normalizedSessionId)) {
      this.files = [];
    } else {
      this.files = (this.filesBySession.get(normalizedSessionId) || []).map(file => ({ ...file }));
    }
    if (this.isOpen) {
      this.renderFiles();
    }
  }

  /**
   * Create the file manager modal
   */
  createModal() {
    if (document.getElementById('file-manager-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'file-manager-modal';
    modal.className = 'modal hidden file-manager-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'file-manager-title');
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-overlay" onclick="fileManager.close()"></div>
      <div class="modal-content file-manager-content">
        <div class="modal-header file-manager-header">
          <div class="file-manager-title">
            <i data-lucide="folder-open" class="w-5 h-5 text-accent" aria-hidden="true"></i>
            <h3 id="file-manager-title">File Manager</h3>
            <span id="file-count-badge" class="file-count-badge">0</span>
          </div>
          <div class="file-manager-actions">
            <button id="file-manager-refresh-btn" class="btn-icon" onclick="fileManager.refreshFiles({ announce: true })" title="Refresh" aria-label="Refresh files">
              <i data-lucide="refresh-cw" class="w-4 h-4" aria-hidden="true"></i>
            </button>
            <button class="btn-icon" onclick="fileManager.close()" aria-label="Close file manager">
              <i data-lucide="x" class="w-5 h-5" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        
        <div class="file-manager-body">
          <!-- Connection Status Banner -->
          <div id="file-manager-connection-banner" class="connection-banner hidden">
            <i data-lucide="wifi-off" class="w-4 h-4"></i>
            <span>Connection lost. Downloads will resume when connection is restored.</span>
          </div>
          
          <!-- Upload Area -->
          <div class="file-upload-area" id="file-drop-zone">
            <input type="file" id="file-manager-upload" class="hidden" multiple>
            <div class="file-upload-content">
              <i data-lucide="upload-cloud" class="w-8 h-8 text-text-secondary"></i>
              <p class="text-sm">Drop files here or click to upload</p>
            </div>
          </div>
          
          <!-- Filter/Search -->
          <div class="file-manager-toolbar">
            <div class="file-search">
              <i data-lucide="search" class="w-4 h-4 text-text-secondary"></i>
              <input type="text" id="file-search-input" placeholder="Search files..." oninput="fileManager.filterFiles(this.value)">
            </div>
            <div class="file-filter-buttons">
              <button class="filter-btn active" data-filter="all" onclick="fileManager.setFilter('all')">All</button>
              <button class="filter-btn" data-filter="document" onclick="fileManager.setFilter('document')">Docs</button>
              <button class="filter-btn" data-filter="image" onclick="fileManager.setFilter('image')">Images</button>
              <button class="filter-btn" data-filter="generated" onclick="fileManager.setFilter('generated')">Generated</button>
            </div>
          </div>
          
          <!-- File List -->
          <div id="file-list-container" class="file-list-container">
            <div class="file-list-empty">
              <i data-lucide="folder" class="w-12 h-12 text-text-tertiary mb-3"></i>
              <p class="text-text-secondary">No files yet</p>
              <p class="text-text-tertiary text-sm">Upload files or generate documents to see them here</p>
            </div>
          </div>
        </div>
        
        <div class="modal-footer file-manager-footer">
          <div class="file-selection-info">
            <span id="file-selection-count">0 selected</span>
          </div>
          <div class="file-footer-actions">
            <button class="btn-secondary" onclick="fileManager.close()">Close</button>
            <button class="btn-primary flex items-center gap-2" id="file-download-selected-btn" onclick="fileManager.downloadSelected()" disabled>
              <i data-lucide="download" class="w-4 h-4"></i>
              <span>Download Selected</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modalElement = modal;
    
    this.setupDragAndDrop();
    this.setupUploadButton();
    
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }

  /**
   * Inject CSS styles
   */
  injectStyles() {
    if (document.getElementById('file-manager-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'file-manager-styles';
    style.textContent = `
      .file-manager-modal .modal-content {
        max-width: 800px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
      }
      
      .file-manager-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
      }
      
      .file-manager-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      
      .file-manager-title h3 {
        font-size: 16px;
        font-weight: 600;
      }
      
      .file-count-badge {
        background: var(--accent);
        color: white;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        font-weight: 600;
      }
      
      .file-manager-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .file-manager-modal.is-refreshing #file-manager-refresh-btn i,
      .file-manager-modal.is-refreshing #file-manager-refresh-btn svg {
        animation: file-manager-spin 0.85s linear infinite;
      }

      .file-manager-modal.is-refreshing .file-list-container {
        position: relative;
      }

      .file-manager-modal.is-refreshing .file-list-container::before {
        content: '';
        position: sticky;
        top: 0;
        z-index: 2;
        display: block;
        height: 2px;
        width: 100%;
        background: linear-gradient(90deg, transparent, var(--accent), transparent);
        animation: file-manager-refresh-sweep 1.1s ease-in-out infinite;
      }
      
      .file-manager-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
      }
      
      .connection-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 8px;
        margin-bottom: 16px;
        color: #ef4444;
        font-size: 13px;
      }
      
      .connection-banner.hidden {
        display: none;
      }
      
      .file-upload-area {
        border: 2px dashed var(--border);
        border-radius: 12px;
        padding: 24px;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s;
        margin-bottom: 16px;
      }
      
      .file-upload-area:hover,
      .file-upload-area.drag-over {
        border-color: var(--accent);
        background: rgba(56, 189, 248, 0.05);
      }
      
      .file-upload-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
      
      .file-manager-toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
        flex-wrap: wrap;
      }
      
      .file-search {
        flex: 1;
        min-width: 200px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      
      .file-search input {
        flex: 1;
        background: transparent;
        border: none;
        color: var(--text-primary);
        font-size: 14px;
      }
      
      .file-search input:focus {
        outline: none;
      }
      
      .file-filter-buttons {
        display: flex;
        gap: 6px;
      }
      
      .filter-btn {
        padding: 6px 12px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: 12px;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .filter-btn:hover,
      .filter-btn.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      
      .file-list-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .file-list-empty {
        text-align: center;
        padding: 40px 20px;
        color: var(--text-secondary);
      }
      
      .file-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .file-item:hover {
        border-color: var(--accent);
        background: var(--bg-tertiary);
      }
      
      .file-item.selected {
        border-color: var(--accent);
        background: rgba(56, 189, 248, 0.1);
      }

      .file-item.is-new {
        border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-tertiary));
        animation: file-manager-new-file 1.8s ease-out 1;
      }
      
      .file-item-checkbox {
        width: 20px;
        height: 20px;
        border: 2px solid var(--border);
        border-radius: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      
      .file-item-checkbox:hover {
        border-color: var(--accent);
        background: rgba(56, 189, 248, 0.1);
      }
      
      .file-item.selected .file-item-checkbox {
        background: var(--accent);
        border-color: var(--accent);
      }
      
      .file-item-checkbox i {
        width: 14px;
        height: 14px;
        color: white;
        display: none;
        stroke-width: 3;
      }
      
      .file-item.selected .file-item-checkbox i {
        display: block;
      }
      
      .file-item-icon {
        width: 40px;
        height: 40px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      
      .file-item-icon.document { background: rgba(59, 130, 246, 0.15); color: #3b82f6; }
      .file-item-icon.image { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
      .file-item-icon.code { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
      .file-item-icon.data { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
      .file-item-icon.archive { background: rgba(107, 114, 128, 0.15); color: #6b7280; }
      
      .file-item-info {
        flex: 1;
        min-width: 0;
      }
      
      .file-item-name {
        font-weight: 500;
        font-size: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      .file-item-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 2px;
      }
      
      .file-item-status {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .file-item-status.downloading {
        color: var(--accent);
      }
      
      .file-item-status.error {
        color: #ef4444;
      }
      
      .file-item-status.success {
        color: #22c55e;
      }
      
      .file-item-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.2s;
      }
      
      .file-item:hover .file-item-actions {
        opacity: 1;
      }
      
      .file-item-btn {
        padding: 6px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .file-item-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      
      .file-item-btn:hover {
        background: var(--bg-tertiary);
      }
      
      .file-manager-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 20px;
        border-top: 1px solid var(--border);
        gap: 16px;
      }
      
      .file-selection-info {
        font-size: 13px;
        color: var(--text-secondary);
      }
      
      .file-footer-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      
      .file-footer-actions .btn-primary {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
      }
      
      .file-progress-bar {
        width: 100%;
        height: 3px;
        background: var(--border);
        border-radius: 2px;
        overflow: hidden;
        margin-top: 6px;
      }
      
      .file-progress-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.3s;
      }

      @keyframes file-manager-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      @keyframes file-manager-refresh-sweep {
        0% { transform: translateX(-70%); opacity: 0.35; }
        50% { opacity: 1; }
        100% { transform: translateX(70%); opacity: 0.35; }
      }

      @keyframes file-manager-new-file {
        0% {
          box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 42%, transparent);
        }
        100% {
          box-shadow: 0 0 0 10px transparent;
        }
      }
      
      @media (max-width: 640px) {
        .file-manager-modal .modal-content {
          max-width: 100%;
          max-height: 100%;
          border-radius: 0;
        }
        
        .file-manager-toolbar {
          flex-direction: column;
          align-items: stretch;
        }
        
        .file-filter-buttons {
          overflow-x: auto;
          padding-bottom: 4px;
        }
        
        .file-item-actions {
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Setup drag and drop for file upload
   */
  setupDragAndDrop() {
    const dropZone = document.getElementById('file-drop-zone');
    const fileInput = document.getElementById('file-manager-upload');
    
    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('click', () => fileInput.click());
    
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      files.forEach(file => this.uploadFile(file));
    });
  }

  /**
   * Setup upload button
   */
  setupUploadButton() {
    const fileInput = document.getElementById('file-manager-upload');
    if (!fileInput) return;
    
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => this.uploadFile(file));
      e.target.value = ''; // Reset
    });
  }

  /**
   * Setup keyboard shortcuts
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + Shift + F to open file manager
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        this.open();
      }
      
      // Escape to close
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }

  /**
   * Get the file type category
   */
  getFileCategory(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
    const docExts = ['doc', 'docx', 'pdf', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'odt', 'html', 'htm'];
    const codeExts = ['js', 'ts', 'css', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'php', 'rb', 'json', 'xml', 'yaml', 'sql'];
    const dataExts = ['xls', 'xlsx', 'csv', 'json', 'xml', 'parquet'];
    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz'];
    
    if (imageExts.includes(ext)) return 'image';
    if (docExts.includes(ext)) return 'document';
    if (codeExts.includes(ext)) return 'code';
    if (dataExts.includes(ext)) return 'data';
    if (archiveExts.includes(ext)) return 'archive';
    return 'other';
  }

  /**
   * Get icon for file type
   */
  getFileIcon(category, filename) {
    const icons = {
      image: 'image',
      document: 'file-text',
      code: 'code',
      data: 'table',
      archive: 'archive',
      other: 'file'
    };
    return icons[category] || 'file';
  }

  /**
   * Format file size
   */
  formatSize(bytes) {
    if (!bytes || bytes === 0) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }

  /**
   * Format date
   */
  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    
    // Less than 1 hour
    if (diff < 3600000) {
      const mins = Math.floor(diff / 60000);
      return mins < 1 ? 'Just now' : `${mins}m ago`;
    }
    // Less than 24 hours
    if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)}h ago`;
    }
    // Less than 7 days
    if (diff < 604800000) {
      return `${Math.floor(diff / 86400000)}d ago`;
    }
    
    return date.toLocaleDateString();
  }

  triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();

    // Large downloads can fail in some browsers if the blob URL is revoked
    // immediately after click().
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 60 * 1000);
  }

  /**
   * Load files from API
   */
  setRefreshing(isRefreshing) {
    this.isRefreshing = isRefreshing === true;
    this.modalElement?.classList.toggle('is-refreshing', this.isRefreshing);

    const refreshBtn = document.getElementById('file-manager-refresh-btn');
    if (refreshBtn) {
      refreshBtn.disabled = this.isRefreshing;
      refreshBtn.setAttribute('aria-busy', this.isRefreshing ? 'true' : 'false');
      refreshBtn.setAttribute('title', this.isRefreshing ? 'Refreshing files' : 'Refresh');
    }
  }

  async loadFiles(options = {}) {
    const sessionId = this.getSessionId();
    this.activeSessionId = String(sessionId || '').trim();
    const previousFiles = Array.isArray(this.files) ? this.files : [];
    const previousIds = new Set(previousFiles.map(file => String(file.id || '').trim()).filter(Boolean));
    const selectedIds = new Set(previousFiles
      .filter(file => file.selected)
      .map(file => String(file.id || '').trim())
      .filter(Boolean));

    if (!sessionId || window.sessionManager?.isLocalSession?.(sessionId)) {
      this.files = [];
      this.renderFiles();
      return { count: 0, addedCount: 0 };
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`);
      if (response.status === 404 || response.status === 503) {
        if (this.getSessionId() !== sessionId) {
          return;
        }
        this.files = [];
        this.filesBySession.set(sessionId, []);
        this.renderFiles();
        return { count: 0, addedCount: 0 };
      }
      if (!response.ok) throw new Error('Failed to load files');
      
      const data = await response.json();
      if (this.getSessionId() !== sessionId) {
        return { count: this.files.length, addedCount: 0, stale: true };
      }
      const shouldHighlightNew = previousIds.size > 0 && options.highlightNew !== false;
      this.files = (data.artifacts || []).map(f => ({
        ...f,
        sessionId,
        category: this.getFileCategory(f.filename),
        selected: selectedIds.has(String(f.id || '').trim()),
        status: 'ready', // ready, downloading, error, success
        progress: 0,
        isNew: shouldHighlightNew && !previousIds.has(String(f.id || '').trim())
      }));
      this.filesBySession.set(sessionId, this.files.map(file => ({ ...file })));
      
      this.renderFiles();
      const addedCount = this.files.filter(file => file.isNew).length;
      if (addedCount > 0) {
        setTimeout(() => {
          const currentSessionId = this.getSessionId();
          if (currentSessionId !== sessionId) {
            return;
          }
          let changed = false;
          this.files = this.files.map(file => {
            if (!file.isNew) {
              return file;
            }
            changed = true;
            return { ...file, isNew: false };
          });
          if (changed) {
            this.filesBySession.set(sessionId, this.files.map(file => ({ ...file })));
            this.renderFiles(
              document.getElementById('file-search-input')?.value || '',
              document.querySelector('.filter-btn.active')?.dataset.filter || 'all'
            );
          }
        }, 2400);
      }

      return { count: this.files.length, addedCount };
    } catch (error) {
      if (this.getSessionId() !== sessionId) {
        return { count: this.files.length, addedCount: 0, stale: true };
      }
      console.error('[FileManager] Failed to load files:', error);
      this.showToast('Failed to load files', 'error');
      return { count: this.files.length, addedCount: 0, error };
    }
  }

  /**
   * Get current session ID
   */
  getSessionId() {
    return window.sessionManager?.currentSessionId || 
           window.apiClient?.currentSessionId ||
           window.chatApp?.currentSessionId;
  }

  /**
   * Render the file list
   */
  renderFiles(filterText = '', filterType = 'all') {
    const container = document.getElementById('file-list-container');
    const countBadge = document.getElementById('file-count-badge');
    
    if (!container) return;

    // Filter files
    let filtered = this.files;
    
    if (filterText) {
      const lower = filterText.toLowerCase();
      filtered = filtered.filter(f => f.filename.toLowerCase().includes(lower));
    }
    
    if (filterType !== 'all') {
      if (filterType === 'generated') {
        filtered = filtered.filter(f => f.aiGenerated || f.generated);
      } else {
        filtered = filtered.filter(f => f.category === filterType);
      }
    }

    // Update count
    if (countBadge) {
      countBadge.textContent = filtered.length;
    }

    // Update selection count
    this.updateSelectionInfo();

    // Empty state
    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="file-list-empty">
          <i data-lucide="folder" class="w-12 h-12 text-text-tertiary mb-3"></i>
          <p class="text-text-secondary">${filterText || filterType !== 'all' ? 'No matching files' : 'No files yet'}</p>
          <p class="text-text-tertiary text-sm">${filterText || filterType !== 'all' ? 'Try different filters' : 'Upload files or generate documents to see them here'}</p>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    // Render files
    container.innerHTML = filtered.map(file => this.renderFileItem(file)).join('');
    
    // Add click handlers to each file item
    container.querySelectorAll('.file-item').forEach(item => {
      const fileId = item.dataset.fileId;
      
      // Click on checkbox specifically
      const checkbox = item.querySelector('.file-item-checkbox');
      if (checkbox) {
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFileSelection(fileId);
        });
      }
      
      // Click on the row (but not on actions or checkbox)
      item.addEventListener('click', (e) => {
        // Don't toggle if clicking action buttons or checkbox
        if (e.target.closest('.file-item-actions') || 
            e.target.closest('.file-item-btn') ||
            e.target.closest('.file-item-checkbox')) {
          return;
        }
        this.toggleFileSelection(fileId);
      });
    });
    
    lucide.createIcons();
  }

  /**
   * Render a single file item
   */
  renderFileItem(file) {
    const icon = this.getFileIcon(file.category, file.filename);
    const openUrl = file.sandboxUrl || file.previewUrl || file.downloadUrl || '';
    const fileName = String(file.filename || 'file').trim() || 'file';
    const escapedFilename = this.escapeHtml(fileName);
    const downloadLabel = this.escapeAttribute(`Download ${fileName}`);
    const openAction = file.previewUrl ? 'Preview' : 'Open';
    const openLabel = this.escapeAttribute(`${openAction} ${fileName}`);
    const deleteLabel = this.escapeAttribute(`Delete ${fileName}`);
    const statusIcon = {
      ready: '',
      downloading: 'loader',
      error: 'alert-circle',
      success: 'check'
    }[file.status];
    
    const statusText = {
      ready: '',
      downloading: 'Downloading...',
      error: 'Failed - click to retry',
      success: 'Downloaded'
    }[file.status];

    return `
      <div class="file-item ${file.selected ? 'selected' : ''} ${file.isNew ? 'is-new' : ''}" data-file-id="${file.id}">
        <div class="file-item-checkbox">
          <i data-lucide="check" class="w-3 h-3"></i>
        </div>
        <div class="file-item-icon ${file.category}">
          <i data-lucide="${icon}" class="w-5 h-5"></i>
        </div>
        <div class="file-item-info">
          <div class="file-item-name" title="${this.escapeAttribute(fileName)}">${escapedFilename}</div>
          <div class="file-item-meta">
            <span>${this.formatSize(file.sizeBytes || file.size)}</span>
            <span>•</span>
            <span>${this.formatDate(file.createdAt)}</span>
            ${file.status !== 'ready' ? `
              <span>•</span>
              <span class="file-item-status ${file.status}">
                ${statusIcon ? `<i data-lucide="${statusIcon}" class="w-3 h-3 ${file.status === 'downloading' ? 'animate-spin' : ''}"></i>` : ''}
                ${statusText}
              </span>
            ` : ''}
          </div>
          ${file.status === 'downloading' ? `
            <div class="file-progress-bar">
              <div class="file-progress-fill" style="width: ${file.progress}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="file-item-actions">
          <button class="file-item-btn" onclick="fileManager.downloadFile('${file.id}')" title="${downloadLabel}" aria-label="${downloadLabel}" ${file.status === 'downloading' ? 'disabled' : ''}>
            <i data-lucide="download" class="w-4 h-4"></i>
          </button>
          ${openUrl ? `
            <a class="file-item-btn" href="${openUrl}" target="_blank" title="${openLabel}" aria-label="${openLabel}" onclick="event.stopPropagation()">
              <i data-lucide="external-link" class="w-4 h-4"></i>
            </a>
          ` : ''}
          <button class="file-item-btn" onclick="fileManager.deleteFile('${file.id}')" title="${deleteLabel}" aria-label="${deleteLabel}">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  escapeAttribute(text) {
    return this.escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Toggle file selection
   */
  toggleFileSelection(fileId) {
    const file = this.files.find(f => f.id === fileId);
    if (file) {
      file.selected = !file.selected;
      this.renderFiles(
        document.getElementById('file-search-input')?.value || '',
        document.querySelector('.filter-btn.active')?.dataset.filter || 'all'
      );
    }
  }

  /**
   * Update selection info
   */
  updateSelectionInfo() {
    const selected = this.files.filter(f => f.selected);
    const infoEl = document.getElementById('file-selection-count');
    const downloadBtn = document.getElementById('file-download-selected-btn');
    
    if (infoEl) {
      infoEl.textContent = `${selected.length} selected`;
    }
    if (downloadBtn) {
      downloadBtn.disabled = selected.length === 0;
      const selectedLabel = selected.length === 0
        ? 'No files selected to download'
        : selected.length === 1
          ? `Download selected file ${selected[0]?.filename || 'file'}`
          : `Download ${selected.length} selected files`;
      downloadBtn.setAttribute('aria-label', selectedLabel);
      downloadBtn.setAttribute('title', selectedLabel);
    }
  }

  getSelectedFiles(options = {}) {
    const category = String(options.category || '').trim();
    return this.files.filter((file) => (
      file?.selected
      && (!category || file.category === category)
      && String(file.id || '').trim()
    ));
  }

  getSelectedArtifactIds(options = {}) {
    return this.getSelectedFiles(options)
      .map((file) => String(file.id || '').trim())
      .filter(Boolean);
  }

  /**
   * Set filter type
   */
  setFilter(type) {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === type);
    });
    this.renderFiles(
      document.getElementById('file-search-input')?.value || '',
      type
    );
  }

  /**
   * Filter files by search text
   */
  filterFiles(text) {
    const activeFilter = document.querySelector('.filter-btn.active')?.dataset.filter || 'all';
    this.renderFiles(text, activeFilter);
  }

  /**
   * Download a single file with retry logic
   */
  async downloadFile(fileId, retryCount = 0) {
    const file = this.files.find(f => f.id === fileId);
    if (!file) return;

    // Check if already downloading
    if (this.downloadQueue.has(fileId)) return;

    // Update status
    file.status = 'downloading';
    file.progress = 0;
    this.renderFiles();

    const downloadKey = `${fileId}_${Date.now()}`;
    this.downloadQueue.set(fileId, downloadKey);

    try {
      // Simulate progress
      const progressInterval = setInterval(() => {
        if (file.progress < 90) {
          file.progress += Math.random() * 15;
          this.renderFiles();
        }
      }, 200);

      // Fetch with timeout and retry logic
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.downloadTimeoutMs);

      const downloadTarget = this.resolveApiUrl(file.downloadUrl || `/api/artifacts/${encodeURIComponent(fileId)}/download`);
      const response = await fetch(downloadTarget, {
        credentials: 'same-origin',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      clearInterval(progressInterval);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      
      // Complete progress
      file.progress = 100;
      this.renderFiles();

      // Trigger download
      this.triggerBlobDownload(blob, file.filename);

      // Success status
      file.status = 'success';
      this.renderFiles();
      
      // Clear success after 2 seconds
      setTimeout(() => {
        file.status = 'ready';
        this.renderFiles();
      }, 2000);

    } catch (error) {
      console.error('[FileManager] Download failed:', error);
      
      // Retry logic
      const attempts = this.retryAttempts.get(fileId) || 0;
      if (attempts < this.maxRetries && this.shouldRetry(error)) {
        this.retryAttempts.set(fileId, attempts + 1);
        file.status = 'ready';
        this.renderFiles();
        
        // Wait before retry with exponential backoff
        const delay = Math.pow(2, attempts) * 1000;
        await this.sleep(delay);
        
        if (!navigator.onLine) {
          // Will retry when connection is restored
          return;
        }
        
        return this.downloadFile(fileId, retryCount + 1);
      }

      // Final failure
      file.status = 'error';
      this.renderFiles();
      this.showToast(`Failed to download ${file.filename}`, 'error');
    } finally {
      this.downloadQueue.delete(fileId);
      if (file.status === 'error') {
        this.retryAttempts.delete(fileId);
      }
    }
  }

  /**
   * Download all selected files
   */
  async downloadSelected() {
    const selected = this.files.filter(f => f.selected);
    if (selected.length === 0) return;

    if (selected.length === 1) {
      await this.downloadFile(selected[0].id);
      return;
    }

    // Download multiple files as zip or sequentially
    this.showToast(`Downloading ${selected.length} files...`, 'info');
    
    for (const file of selected) {
      await this.downloadFile(file.id);
      // Small delay between downloads
      await this.sleep(500);
    }
  }

  /**
   * Check if error is retryable
   */
  shouldRetry(error) {
    // Network errors, timeouts, and 5xx errors are retryable
    if (error.name === 'TypeError' || error.name === 'AbortError') return true;
    if (error.message?.includes('network') || error.message?.includes('fetch')) return true;
    return false;
  }

  /**
   * Upload a file
   */
  async uploadFile(file) {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      this.showToast('No active session', 'error');
      return;
    }

    if (typeof window.artifactManager?.uploadFile === 'function') {
      try {
        await window.artifactManager.uploadFile(file);
        this.showToast(`Uploaded ${file.name}`, 'success');
        await this.refreshFiles({ announce: false });
        return;
      } catch (error) {
        console.error('[FileManager] Upload failed:', error);
        this.showToast(`Failed to upload ${file.name}`, 'error');
        return;
      }
    }

    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('mode', 'chat');
    formData.append('file', file);

    try {
      const response = await fetch('/api/artifacts/upload', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) throw new Error('Upload failed');

      this.showToast(`Uploaded ${file.name}`, 'success');
      await this.refreshFiles({ announce: false });
    } catch (error) {
      console.error('[FileManager] Upload failed:', error);
      this.showToast(`Failed to upload ${file.name}`, 'error');
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(fileId) {
    const file = this.files.find(f => f.id === fileId);
    if (!file) return;

    if (!confirm(`Delete "${file.filename}"?`)) return;

    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(fileId)}`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Delete failed');

      this.files = this.files.filter(f => f.id !== fileId);
      this.renderFiles();
      this.showToast('File deleted', 'success');
    } catch (error) {
      console.error('[FileManager] Delete failed:', error);
      this.showToast('Failed to delete file', 'error');
    }
  }

  /**
   * Handle connection lost
   */
  handleConnectionLost() {
    const banner = document.getElementById('file-manager-connection-banner');
    if (banner) {
      banner.classList.remove('hidden');
    }
  }

  /**
   * Handle connection restored
   */
  handleConnectionRestored() {
    const banner = document.getElementById('file-manager-connection-banner');
    if (banner) {
      banner.classList.add('hidden');
    }
    
    // Refresh files
    if (this.isOpen) {
      void this.refreshFiles({ announce: false });
    }
    
    // Retry any failed downloads
    this.files.forEach(file => {
      if (file.status === 'error') {
        this.retryAttempts.delete(file.id);
        this.downloadFile(file.id);
      }
    });
  }

  /**
   * Refresh the file list
   */
  async refreshFiles(options = {}) {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      this.setRefreshing(true);
      try {
        const result = await this.loadFiles({ highlightNew: true });
        if (options.announce === true && !result?.error && !result?.stale) {
          const addedCount = Number(result?.addedCount) || 0;
          this.showToast(
            addedCount > 0
              ? `${addedCount} new file${addedCount === 1 ? '' : 's'} added`
              : 'Files are up to date',
            'success'
          );
        }
        return result;
      } finally {
        this.setRefreshing(false);
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Open the file manager
   */
  async open() {
    if (!this.modalElement) {
      this.createModal();
    }

    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body && typeof activeElement.focus === 'function') {
      this.lastFocusedElement = activeElement;
    }

    this.isOpen = true;
    this.modalElement.classList.remove('hidden');
    this.modalElement.setAttribute('aria-hidden', 'false');
    document.getElementById('files-btn')?.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    this.applySessionFiles(this.getSessionId());

    document.getElementById('file-manager-refresh-btn')?.focus({ preventScroll: true });

    // Load files
    await this.loadFiles();
    
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }

  /**
   * Close the file manager
   */
  close() {
    this.isOpen = false;
    if (this.modalElement) {
      this.modalElement.classList.add('hidden');
      this.modalElement.setAttribute('aria-hidden', 'true');
    }
    document.getElementById('files-btn')?.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';

    if (this.lastFocusedElement?.isConnected) {
      this.lastFocusedElement.focus({ preventScroll: true });
    }
    this.lastFocusedElement = null;
  }

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    if (window.uiHelpers?.showToast) {
      uiHelpers.showToast(message, type);
    } else {
      console.log(`[${type}] ${message}`);
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Add a file to the list (for generated files)
   */
  addFile(file, options = {}) {
    const currentSessionId = String(this.getSessionId() || '').trim();
    const targetSessionId = String(options.sessionId || file?.sessionId || file?.session_id || currentSessionId).trim();
    if (targetSessionId && currentSessionId && targetSessionId !== currentSessionId) {
      const scopedFiles = this.filesBySession.get(targetSessionId) || [];
      const existingIndex = scopedFiles.findIndex(f => f.id === file.id);
      const enrichedFile = {
        ...file,
        sessionId: targetSessionId,
        category: this.getFileCategory(file.filename),
        selected: false,
        status: 'ready',
        progress: 0
      };
      if (existingIndex >= 0) {
        scopedFiles[existingIndex] = enrichedFile;
      } else {
        scopedFiles.unshift(enrichedFile);
      }
      this.filesBySession.set(targetSessionId, scopedFiles);
      return;
    }

    const existingIndex = this.files.findIndex(f => f.id === file.id);
    const enrichedFile = {
      ...file,
      sessionId: targetSessionId || currentSessionId,
      category: this.getFileCategory(file.filename),
      selected: false,
      status: 'ready',
      progress: 0
    };
    
    if (existingIndex >= 0) {
      this.files[existingIndex] = enrichedFile;
    } else {
      this.files.unshift(enrichedFile);
    }
    this.filesBySession.set(currentSessionId, this.files.map(entry => ({ ...entry })));
    
    if (this.isOpen) {
      this.renderFiles();
    }
  }

  resolveApiUrl(urlPath = '') {
    const normalized = String(urlPath || '').trim();
    if (!normalized) return '';
    if (/^https?:\/\//i.test(normalized) || normalized.startsWith('blob:') || normalized.startsWith('data:')) {
      return normalized;
    }
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }
}

// Create global instance
const fileManager = new FileManager();
