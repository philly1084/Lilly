/**
 * Editor Manager - CodeMirror 6 initialization and management
 */

class EditorManager {
    constructor() {
        this.editor = null;
        this.container = document.getElementById('editor');
        this.currentMode = 'javascript';
        this.onChangeCallbacks = [];
        this.onCursorActivityCallbacks = [];
        this.isDirty = false;
    }

    /**
     * Initialize the CodeMirror editor
     * @param {Object} options 
     */
    initialize(options = {}) {
        if (this.editor) {
            this.destroy();
        }

        const theme = document.documentElement.getAttribute('data-theme') === 'dark' 
            ? 'dracula' 
            : 'eclipse';

        // Detect touch device
        const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

        const config = {
            mode: options.mode || this.currentMode,
            theme: theme,
            lineNumbers: true,
            lineWrapping: options.lineWrapping || false,
            autoCloseBrackets: true,
            matchBrackets: true,
            styleActiveLine: true,
            indentUnit: options.indentUnit || 2,
            tabSize: options.tabSize || 2,
            indentWithTabs: false,
            electricChars: true,
            // Touch optimizations
            dragDrop: !isTouchDevice, // Disable drag-drop on touch
            inputStyle: isTouchDevice ? 'contenteditable' : 'textarea',
            // Wider gutter on touch devices
            ...(isTouchDevice && {
                lineNumberFormatter: (line) => line,
                gutters: ['CodeMirror-linenumbers'],
            }),
            extraKeys: {
                'Ctrl-S': () => this._triggerSave(),
                'Cmd-S': () => this._triggerSave(),
                'Ctrl-/': 'toggleComment',
                'Cmd-/': 'toggleComment',
                'Tab': (cm) => {
                    if (cm.somethingSelected()) {
                        cm.indentSelection('add');
                    } else {
                        cm.replaceSelection('  ');
                    }
                },
                'Shift-Tab': (cm) => {
                    cm.indentSelection('subtract');
                }
            },
            ...options
        };

        this.editor = CodeMirror.fromTextArea(this.container, config);

        // Set initial content
        if (options.value) {
            this.setValue(options.value);
        }

        // Bind events
        this.editor.on('change', () => {
            this.isDirty = true;
            this._notifyChange();
        });

        this.editor.on('cursorActivity', () => {
            this._notifyCursorActivity();
        });

        // Enable touch scroll for CodeMirror
        this.enableTouchScroll();

        // Refresh after a short delay to ensure proper sizing
        setTimeout(() => {
            this.editor.refresh();
        }, 100);

        return this.editor;
    }

    /**
     * Enable touch scroll for CodeMirror
     */
    enableTouchScroll() {
        const cm = this.editor;
        if (!cm) return;

        const scroller = cm.getWrapperElement().querySelector('.CodeMirror-scroll');
        if (scroller) {
            scroller.style.overflow = 'auto';
            scroller.style.webkitOverflowScrolling = 'touch';
        }
    }

    /**
     * Set gutter markers for syntax errors (diagram mode)
     * @param {Array} errors - Array of {line, message} objects
     */
    setErrorMarkers(errors) {
        if (!this.editor) return;

        // Clear existing markers
        this.editor.clearGutter('error-gutter');

        if (!errors || errors.length === 0) return;

        // Add gutter if not exists
        if (!this.editor.getOption('gutters').includes('error-gutter')) {
            this.editor.setOption('gutters', ['CodeMirror-linenumbers', 'error-gutter']);
        }

        errors.forEach(error => {
            const marker = document.createElement('div');
            marker.className = 'error-marker';
            marker.style.cssText = 'color: var(--accent-error); font-weight: bold; padding: 0 4px;';
            marker.innerHTML = '⚠';
            marker.title = error.message;
            this.editor.setGutterMarker(error.line - 1, 'error-gutter', marker);
        });
    }

    /**
     * Clear all error markers
     */
    clearErrorMarkers() {
        if (!this.editor) return;
        this.editor.clearGutter('error-gutter');
    }

    /**
     * Get current editor value
     * @returns {string}
     */
    getValue() {
        return this.editor ? this.editor.getValue() : '';
    }

    /**
     * Set editor value
     * @param {string} value 
     * @param {boolean} clearHistory 
     */
    setValue(value, clearHistory = false) {
        if (this.editor) {
            this.editor.setValue(value);
            this.isDirty = false;
            
            if (clearHistory) {
                this.editor.clearHistory();
            }
        }
    }

    /**
     * Set editor mode/language
     * @param {string} mode 
     */
    setMode(mode) {
        if (this.editor) {
            this.editor.setOption('mode', mode);
            this.currentMode = mode;
        }
    }

    /**
     * Get current mode
     * @returns {string}
     */
    getMode() {
        return this.currentMode;
    }

    /**
     * Set editor theme
     * @param {string} theme 
     */
    setTheme(theme) {
        if (this.editor) {
            this.editor.setOption('theme', theme);
        }
    }

    /**
     * Get cursor position
     * @returns {Object}
     */
    getCursorPosition() {
        if (!this.editor) return { line: 1, ch: 1 };
        
        const pos = this.editor.getCursor();
        return {
            line: pos.line + 1,
            ch: pos.ch + 1
        };
    }

    /**
     * Set cursor position
     * @param {number} line 
     * @param {number} ch 
     */
    setCursorPosition(line, ch) {
        if (this.editor) {
            this.editor.setCursor(line - 1, ch - 1);
            this.editor.focus();
        }
    }

    /**
     * Get selected text
     * @returns {string}
     */
    getSelection() {
        return this.editor ? this.editor.getSelection() : '';
    }

    /**
     * Get selected text plus stable editor coordinates.
     * @returns {Object|null}
     */
    getSelectionInfo() {
        if (!this.editor) return null;

        const text = this.editor.getSelection();
        if (!text) return null;

        const from = this.editor.getCursor('from');
        const to = this.editor.getCursor('to');

        return {
            text,
            from: { line: from.line, ch: from.ch },
            to: { line: to.line, ch: to.ch },
            startLine: from.line + 1,
            startColumn: from.ch + 1,
            endLine: to.line + 1,
            endColumn: to.ch + 1,
            characterCount: text.length,
        };
    }

    /**
     * Replace selection with text
     * @param {string} text 
     */
    replaceSelection(text) {
        if (this.editor) {
            this.editor.replaceSelection(text);
        }
    }

    /**
     * Replace a saved range with text.
     * @param {string} text
     * @param {Object} range
     */
    replaceRange(text, range) {
        if (!this.editor || !range?.from || !range?.to) return false;

        this.editor.replaceRange(
            text,
            { line: range.from.line, ch: range.from.ch },
            { line: range.to.line, ch: range.to.ch },
        );
        return true;
    }

    /**
     * Insert text at cursor
     * @param {string} text 
     */
    insertText(text) {
        if (this.editor) {
            const cursor = this.editor.getCursor();
            this.editor.replaceRange(text, cursor);
        }
    }

    /**
     * Focus the editor
     */
    focus() {
        if (this.editor) {
            this.editor.focus();
        }
    }

    /**
     * Blur the editor
     */
    blur() {
        if (this.editor) {
            this.editor.getInputField().blur();
        }
    }

    /**
     * Check if editor has focus
     * @returns {boolean}
     */
    hasFocus() {
        return this.editor ? this.editor.hasFocus() : false;
    }

    /**
     * Undo last change
     */
    undo() {
        if (this.editor) {
            this.editor.undo();
        }
    }

    /**
     * Redo last undone change
     */
    redo() {
        if (this.editor) {
            this.editor.redo();
        }
    }

    /**
     * Check if can undo
     * @returns {boolean}
     */
    canUndo() {
        return this.editor ? this.editor.historySize().undo > 0 : false;
    }

    /**
     * Check if can redo
     * @returns {boolean}
     */
    canRedo() {
        return this.editor ? this.editor.historySize().redo > 0 : false;
    }

    /**
     * Clear editor history
     */
    clearHistory() {
        if (this.editor) {
            this.editor.clearHistory();
        }
    }

    /**
     * Get word count
     * @returns {number}
     */
    getWordCount() {
        const content = this.getValue();
        if (!content.trim()) return 0;
        return content.trim().split(/\s+/).length;
    }

    /**
     * Get line count
     * @returns {number}
     */
    getLineCount() {
        return this.editor ? this.editor.lineCount() : 0;
    }

    /**
     * Get editor statistics
     * @returns {Object}
     */
    getStats() {
        return {
            wordCount: this.getWordCount(),
            lineCount: this.getLineCount(),
            characterCount: this.getValue().length,
            isDirty: this.isDirty
        };
    }

    /**
     * Set dirty state
     * @param {boolean} dirty 
     */
    setDirty(dirty) {
        this.isDirty = dirty;
    }

    /**
     * Check if editor is dirty
     * @returns {boolean}
     */
    isDirtyState() {
        return this.isDirty;
    }

    /**
     * Refresh editor (useful after container resize)
     */
    refresh() {
        if (this.editor) {
            this.editor.refresh();
            this.enableTouchScroll();
        }
    }

    /**
     * Resize editor to container
     */
    resize() {
        this.refresh();
    }

    /**
     * Debounce helper function
     * @param {Function} func 
     * @param {number} wait 
     * @returns {Function}
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Destroy editor instance
     */
    destroy() {
        if (this.editor) {
            this.editor.toTextArea();
            this.editor = null;
        }
    }

    /**
     * Subscribe to change events
     * @param {Function} callback 
     * @returns {Function} Unsubscribe function
     */
    onChange(callback) {
        this.onChangeCallbacks.push(callback);
        return () => {
            const index = this.onChangeCallbacks.indexOf(callback);
            if (index > -1) {
                this.onChangeCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Subscribe to cursor activity events
     * @param {Function} callback 
     * @returns {Function} Unsubscribe function
     */
    onCursorActivity(callback) {
        this.onCursorActivityCallbacks.push(callback);
        return () => {
            const index = this.onCursorActivityCallbacks.indexOf(callback);
            if (index > -1) {
                this.onCursorActivityCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Notify change listeners
     */
    _notifyChange() {
        const value = this.getValue();
        this.onChangeCallbacks.forEach(callback => {
            try {
                callback(value);
            } catch (error) {
                console.error('Change callback error:', error);
            }
        });
    }

    /**
     * Notify cursor activity listeners
     */
    _notifyCursorActivity() {
        const position = this.getCursorPosition();
        this.onCursorActivityCallbacks.forEach(callback => {
            try {
                callback(position);
            } catch (error) {
                console.error('Cursor activity callback error:', error);
            }
        });
    }

    /**
     * Trigger save action
     */
    _triggerSave() {
        // Dispatch custom save event
        window.dispatchEvent(new CustomEvent('editor:save', {
            detail: { content: this.getValue() }
        }));
        
        this.isDirty = false;
        return true;
    }

    /**
     * Format/Beautify code (basic implementation)
     */
    formatCode() {
        const content = this.getValue();
        // Basic indentation formatting
        const lines = content.split('\n');
        let indentLevel = 0;
        const indentSize = 2;
        
        const formatted = lines.map(line => {
            const trimmed = line.trim();
            
            // Decrease indent for closing braces/tags
            if (/^[}\])]/.test(trimmed) || /^<\/\w+/.test(trimmed)) {
                indentLevel = Math.max(0, indentLevel - 1);
            }
            
            const indented = ' '.repeat(indentLevel * indentSize) + trimmed;
            
            // Increase indent for opening braces/tags
            if (/[\{\[(]$/.test(trimmed) || /<\w+[^/]*>$/.test(trimmed)) {
                indentLevel++;
            }
            
            return indented;
        }).join('\n');
        
        this.setValue(formatted);
    }

    /**
     * Search in editor
     * @param {string} query 
     * @param {Object} options 
     */
    search(query, options = {}) {
        if (!this.editor || !query) return;

        const cursor = this.editor.getSearchCursor(query, null, {
            caseFold: options.caseInsensitive || false
        });

        if (cursor.findNext()) {
            this.editor.setSelection(cursor.from(), cursor.to());
            this.editor.scrollIntoView(cursor.from());
        }
    }

    /**
     * Replace all occurrences
     * @param {string} find 
     * @param {string} replace 
     */
    replaceAll(find, replace) {
        if (!this.editor || !find) return;

        const cursor = this.editor.getSearchCursor(find);
        while (cursor.findNext()) {
            cursor.replace(replace);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EditorManager;
}
