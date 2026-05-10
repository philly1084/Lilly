/**
 * Notation Helper - Output Module
 * Handles output rendering, formatting, and export
 */

const OutputManager = {
    // State
    currentResult: '',
    currentMode: 'expand',
    annotations: [],
    suggestions: [],
    issues: [],
    correctedNotation: '',
    assumptions: [],
    ambiguities: [],
    structure: null,

    // DOM references
    elements: {
        container: null,
        empty: null,
        content: null,
        rendered: null,
        suggestionsPanel: null,
        suggestionsList: null,
        modeBadge: null
    },

    /**
     * Initialize the output manager
     * @param {Object} elements - DOM element references
     */
    init(elements) {
        this.elements = {
            container: elements.container || document.getElementById('outputContent'),
            empty: elements.empty || document.getElementById('outputEmpty'),
            content: elements.content || document.getElementById('outputContent'),
            rendered: elements.rendered || document.getElementById('outputRendered'),
            suggestionsPanel: elements.suggestionsPanel || document.getElementById('suggestionsPanel'),
            suggestionsList: elements.suggestionsList || document.getElementById('suggestionsList'),
            modeBadge: elements.modeBadge || document.getElementById('modeBadge')
        };

        return this;
    },

    /**
     * Display result in the output pane
     * @param {Object} data - Response data
     * @param {string} data.result - Result text
     * @param {string} data.mode - Helper mode
     * @param {Array} data.annotations - Annotations
     * @param {Array} data.suggestions - Suggestions
     */
    display(data) {
        this.currentResult = window.KimiBuiltModelOutputParser?.normalizeModelOutputMarkdown
            ? window.KimiBuiltModelOutputParser.normalizeModelOutputMarkdown(data.result || data)
            : (data.result || '');
        this.currentMode = data.mode || 'expand';
        this.issues = Array.isArray(data.issues) ? data.issues : [];
        this.correctedNotation = typeof data.correctedNotation === 'string' ? data.correctedNotation.trim() : '';
        this.assumptions = Array.isArray(data.assumptions) ? data.assumptions : [];
        this.ambiguities = Array.isArray(data.ambiguities) ? data.ambiguities : [];
        this.structure = data.structure || null;
        this.annotations = this._normalizeAnnotationsFromData(data);
        this.suggestions = data.suggestions || [];
        this.reasoningSummary = String(data.reasoningSummary || '').trim();

        // Hide empty state, show content
        if (this.elements.empty) {
            this.elements.empty.classList.add('hidden');
        }
        if (this.elements.content) {
            this.elements.content.classList.remove('hidden');
        }

        // Update mode badge
        if (this.elements.modeBadge) {
            this.elements.modeBadge.textContent = this.currentMode;
            this.elements.modeBadge.className = `mode-badge mode-${this.currentMode}`;
        }

        // Render result
        this.renderResult();

        // Render suggestions
        this.renderSuggestions();

        // Update annotations
        if (window.AnnotationsManager) {
            AnnotationsManager.setAnnotations(this.annotations);
        }
    },

    /**
     * Render the result with appropriate formatting
     */
    renderResult() {
        if (!this.elements.rendered) return;

        let html = '';

        // Try to parse as markdown first
        if (this._looksLikeMarkdown(this.currentResult)) {
            html = this._renderMarkdown(this.currentResult);
        } else {
            // Render as plain text with line numbers
            html = this._renderPlainText(this.currentResult);
        }

        this.elements.rendered.innerHTML = `${this._renderReasoningSummary()}${this._renderStructuredDetails()}${html}`;

        // Add line numbers and annotations
        this._addLineAnnotations();
    },

    /**
     * Render suggestions
     */
    renderSuggestions() {
        if (!this.elements.suggestionsList || !this.elements.suggestionsPanel) return;

        if (this.suggestions.length === 0) {
            this.elements.suggestionsPanel.classList.add('hidden');
            return;
        }

        this.elements.suggestionsPanel.classList.remove('hidden');

        this.elements.suggestionsList.innerHTML = this.suggestions.map((suggestion, index) => `
            <div class="suggestion-chip" data-index="${index}" title="${this.escapeHtml(suggestion)}">
                <span>${this.escapeHtml(this._truncate(suggestion, 40))}</span>
                <button class="apply-btn" data-index="${index}" title="Apply suggestion">
                    <i class="fas fa-check"></i>
                </button>
            </div>
        `).join('');

        // Bind apply buttons
        this.elements.suggestionsList.querySelectorAll('.apply-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                this.applySuggestion(index);
            });
        });

        // Bind hover preview
        this.elements.suggestionsList.querySelectorAll('.suggestion-chip').forEach(chip => {
            chip.addEventListener('mouseenter', () => {
                const index = parseInt(chip.dataset.index);
                this.previewSuggestion(index);
            });
            chip.addEventListener('mouseleave', () => {
                this.clearPreview();
            });
        });
    },

    _renderReasoningSummary() {
        if (!this.reasoningSummary) {
            return '';
        }

        const preview = this._truncate(this.reasoningSummary.replace(/\s+/g, ' '), 110);
        const body = this.escapeHtml(this.reasoningSummary).replace(/\n/g, '<br>');

        return `
            <details class="reasoning-history-card">
                <summary>
                    <span class="reasoning-history-title">
                        <i class="fas fa-brain"></i>
                        Reasoning history
                    </span>
                    <span class="reasoning-history-preview">${this.escapeHtml(preview)}</span>
                </summary>
                <div class="reasoning-history-body">${body}</div>
            </details>
        `;
    },

    _renderStructuredDetails() {
        const sections = [];

        if (this.issues.length > 0) {
            const issueItems = this.issues.map(issue => {
                const severity = this._normalizeIssueSeverity(issue.severity);
                const line = issue.line ? `Line ${this.escapeHtml(String(issue.line))}: ` : '';
                const fix = issue.fix ? `<div class="notation-detail-fix">Fix: ${this.escapeHtml(issue.fix)}</div>` : '';
                return `<li class="notation-issue notation-issue-${severity}">
                    <strong>${severity.toUpperCase()}</strong>
                    <span>${line}${this.escapeHtml(issue.message || '')}</span>
                    ${fix}
                </li>`;
            }).join('');
            sections.push(`<details class="notation-detail-card" open>
                <summary>Validation issues</summary>
                <ul>${issueItems}</ul>
            </details>`);
        }

        if (this.correctedNotation) {
            sections.push(`<details class="notation-detail-card" open>
                <summary>Corrected notation</summary>
                <pre>${this.escapeHtml(this.correctedNotation)}</pre>
            </details>`);
        }

        const assumptionsHtml = this._renderListDetail('Assumptions', this.assumptions);
        if (assumptionsHtml) sections.push(assumptionsHtml);

        const ambiguitiesHtml = this._renderListDetail('Ambiguities', this.ambiguities);
        if (ambiguitiesHtml) sections.push(ambiguitiesHtml);

        if (this.structure) {
            const structureText = typeof this.structure === 'string'
                ? this.structure
                : JSON.stringify(this.structure, null, 2);
            sections.push(`<details class="notation-detail-card">
                <summary>Structure</summary>
                <pre>${this.escapeHtml(structureText)}</pre>
            </details>`);
        }

        return sections.length ? `<div class="notation-detail-stack">${sections.join('')}</div>` : '';
    },

    _renderListDetail(title, items) {
        if (!Array.isArray(items) || items.length === 0) {
            return '';
        }
        const list = items.map(item => `<li>${this.escapeHtml(String(item))}</li>`).join('');
        return `<details class="notation-detail-card">
            <summary>${this.escapeHtml(title)}</summary>
            <ul>${list}</ul>
        </details>`;
    },

    _normalizeAnnotationsFromData(data) {
        const annotations = Array.isArray(data.annotations) ? [...data.annotations] : [];
        const seen = new Set(annotations.map(annotation => `${annotation.line}:${annotation.note || annotation.message || ''}`));

        this.issues.forEach(issue => {
            if (!issue || !issue.line || !issue.message) return;
            const note = issue.fix ? `${issue.message} Fix: ${issue.fix}` : issue.message;
            const key = `${issue.line}:${note}`;
            if (seen.has(key)) return;
            seen.add(key);
            annotations.push({
                line: issue.line,
                note,
                type: issue.severity === 'error' ? 'error' : (issue.severity || 'warning')
            });
        });

        return annotations;
    },

    _normalizeIssueSeverity(severity) {
        const normalized = String(severity || '').trim().toLowerCase();
        return ['error', 'warning', 'info'].includes(normalized) ? normalized : 'warning';
    },

    /**
     * Apply a suggestion to the input
     * @param {number} index - Suggestion index
     */
    applySuggestion(index) {
        const suggestion = this.suggestions[index];
        if (!suggestion) return;

        // Dispatch event for the editor to handle
        const event = new CustomEvent('applySuggestion', {
            detail: { suggestion, index }
        });
        document.dispatchEvent(event);
    },

    /**
     * Preview a suggestion (highlight in output)
     * @param {number} index - Suggestion index
     */
    previewSuggestion(index) {
        // Could implement visual preview in output
        const event = new CustomEvent('previewSuggestion', {
            detail: { suggestion: this.suggestions[index], index }
        });
        document.dispatchEvent(event);
    },

    /**
     * Clear suggestion preview
     */
    clearPreview() {
        const event = new CustomEvent('clearSuggestionPreview');
        document.dispatchEvent(event);
    },

    /**
     * Clear output and show empty state
     */
    clear() {
        this.currentResult = '';
        this.annotations = [];
        this.suggestions = [];
        this.reasoningSummary = '';
        this.issues = [];
        this.correctedNotation = '';
        this.assumptions = [];
        this.ambiguities = [];
        this.structure = null;

        if (this.elements.empty) {
            this.elements.empty.classList.remove('hidden');
        }
        if (this.elements.content) {
            this.elements.content.classList.add('hidden');
        }
        if (this.elements.suggestionsPanel) {
            this.elements.suggestionsPanel.classList.add('hidden');
        }

        if (window.AnnotationsManager) {
            AnnotationsManager.clear();
        }
    },

    /**
     * Copy result to clipboard
     * @returns {Promise<boolean>} Success status
     */
    async copyToClipboard() {
        try {
            await navigator.clipboard.writeText(this.currentResult);
            return true;
        } catch (error) {
            console.error('Failed to copy:', error);
            return false;
        }
    },

    /**
     * Export as Markdown file
     */
    exportAsMarkdown() {
        const markdown = this._generateMarkdownExport();
        this._downloadFile(markdown, 'notation-result.md', 'text/markdown');
    },

    /**
     * Export with annotations as comments
     */
    exportWithAnnotations() {
        let content = this.currentResult;
        
        // Add annotations as comments
        if (this.annotations.length > 0) {
            const annotationComments = this.annotations.map(a => 
                `<!-- Line ${a.line}: ${a.note} -->`
            ).join('\n');
            content = annotationComments + '\n\n' + content;
        }

        this._downloadFile(content, 'notation-with-annotations.md', 'text/markdown');
    },

    /**
     * Get current result
     * @returns {string} Current result text
     */
    getResult() {
        return this.currentResult;
    },

    /**
     * Get current mode
     * @returns {string} Current helper mode
     */
    getMode() {
        return this.currentMode;
    },

    /**
     * Get annotations
     * @returns {Array} Current annotations
     */
    getAnnotations() {
        return this.annotations;
    },

    /**
     * Get suggestions
     * @returns {Array} Current suggestions
     */
    getSuggestions() {
        return this.suggestions;
    },

    // Private methods

    /**
     * Check if text looks like markdown
     * @param {string} text - Text to check
     * @returns {boolean}
     * @private
     */
    _looksLikeMarkdown(text) {
        const normalizedText = window.KimiBuiltModelOutputParser?.normalizeModelOutputMarkdown
            ? window.KimiBuiltModelOutputParser.normalizeModelOutputMarkdown(text)
            : text;
        const markdownPatterns = [
            /^#{1,6}\s/m,           // Headers
            /\*\*|__/,              // Bold
            /\*|_/,                 // Italic
            /^\s*[-*+]\s/m,         // Lists
            /^\s*\d+\.\s/m,         // Numbered lists
            /`{1,3}/,               // Code
            /^\s*>\s/m,             // Blockquote
            /^\s*```/m,             // Code blocks
            /\[.+\]\(.+\)/,         // Links
            /^\|[-:|\s]+\|/m,       // Tables
            /^---$/m                // Horizontal rules
        ];

        return markdownPatterns.some(pattern => pattern.test(normalizedText));
    },

    /**
     * Render markdown text
     * @param {string} text - Markdown text
     * @returns {string} HTML
     * @private
     */
    _renderMarkdown(text) {
        const normalizedText = window.KimiBuiltModelOutputParser?.normalizeModelOutputMarkdown
            ? window.KimiBuiltModelOutputParser.normalizeModelOutputMarkdown(text)
            : text;
        if (typeof marked !== 'undefined') {
            // Configure marked options
            marked.setOptions({
                gfm: true,
                breaks: true,
                headerIds: true,
                mangle: false
            });
            return marked.parse(normalizedText);
        }
        
        // Fallback: simple formatting
        return this._renderPlainText(normalizedText);
    },

    /**
     * Render plain text with line numbers
     * @param {string} text - Plain text
     * @returns {string} HTML
     * @private
     */
    _renderPlainText(text) {
        if (!text) return '';

        const lines = text.split('\n');
        
        return lines.map((line, index) => {
            const lineNumber = index + 1;
            const hasAnnotation = this.annotations.some(a => a.line === lineNumber);
            const annotationClass = hasAnnotation ? 'has-annotation' : '';
            const escapedLine = this.escapeHtml(line);
            
            return `<div class="output-line ${annotationClass}" data-line="${lineNumber}">
                <span class="line-number">${lineNumber}</span>
                <span class="line-content">${escapedLine || '&nbsp;'}</span>
            </div>`;
        }).join('');
    },

    /**
     * Add line annotation highlights
     * @private
     */
    _addLineAnnotations() {
        // Add click handlers to annotated lines
        if (!this.elements.rendered) return;

        this.elements.rendered.querySelectorAll('.output-line.has-annotation').forEach(lineEl => {
            lineEl.addEventListener('click', () => {
                const lineNumber = parseInt(lineEl.dataset.line);
                
                // Find and highlight corresponding annotation
                if (window.AnnotationsManager) {
                    AnnotationsManager.navigateToLine(lineNumber);
                }
            });
        });
    },

    /**
     * Generate markdown export
     * @returns {string} Markdown content
     * @private
     */
    _generateMarkdownExport() {
        const timestamp = new Date().toISOString();
        
        return `# Notation Result

**Mode:** ${this.currentMode}  
**Generated:** ${timestamp}

---

${this.currentResult}

---

${this.annotations.length > 0 ? `
## Annotations

${this.annotations.map(a => `- **Line ${a.line}:** ${a.note}`).join('\n')}
` : ''}

${this.suggestions.length > 0 ? `
## Suggestions

${this.suggestions.map(s => `- ${s}`).join('\n')}
` : ''}
`;
    },

    /**
     * Download file helper
     * @param {string} content - File content
     * @param {string} filename - File name
     * @param {string} mimeType - MIME type
     * @private
     */
    _downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
    },

    /**
     * Escape HTML special characters
     * @param {string} text - Text to escape
     * @returns {string} Escaped text
     */
    escapeHtml(text) {
        if (!text) return '';
        
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Truncate text
     * @param {string} text - Text to truncate
     * @param {number} length - Max length
     * @returns {string} Truncated text
     * @private
     */
    _truncate(text, length) {
        if (!text || text.length <= length) return text;
        return text.substring(0, length - 3) + '...';
    }
};

// Export for module systems or make available globally
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OutputManager;
}
