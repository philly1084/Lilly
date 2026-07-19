/**
 * File Handler Module
 * Import/Export functionality for business file formats
 * Supports: DOCX, PDF, HTML, Markdown, TXT, JSON, and script files
 */

class FileHandler {
    constructor(app) {
        this.app = app;
        this.importedContentById = new Map();
        this.nextImportedContentId = 1;
        this.supportedImportFormats = {
            // Documents
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'application/msword': 'doc',
            'application/pdf': 'pdf',
            'text/html': 'html',
            'text/markdown': 'markdown',
            'text/x-markdown': 'markdown',
            'text/plain': 'txt',
            'application/json': 'json',
            // Scripts
            'text/javascript': 'javascript',
            'application/javascript': 'javascript',
            'text/x-python': 'python',
            'application/x-python-code': 'python',
            'text/x-shellscript': 'bash',
            'application/x-sh': 'bash',
            'text/css': 'css',
            'text/xml': 'xml',
        };
        
        this.extensionMap = {
            '.docx': 'docx',
            '.doc': 'doc',
            '.pdf': 'pdf',
            '.html': 'html',
            '.htm': 'html',
            '.md': 'markdown',
            '.markdown': 'markdown',
            '.txt': 'txt',
            '.json': 'json',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.sh': 'bash',
            '.bash': 'bash',
            '.zsh': 'bash',
            '.css': 'css',
            '.scss': 'scss',
            '.sass': 'sass',
            '.less': 'less',
            '.xml': 'xml',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.sql': 'sql',
            '.php': 'php',
            '.rb': 'ruby',
            '.go': 'go',
            '.rs': 'rust',
            '.java': 'java',
            '.c': 'c',
            '.cpp': 'cpp',
            '.h': 'c',
            '.cs': 'csharp',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.r': 'r',
            '.m': 'objectivec',
            '.pl': 'perl',
            '.lua': 'lua',
        };
        
        this.initLibraries();
    }

    /**
     * Initialize external libraries
     */
    initLibraries() {
        this.mammothLib = typeof mammoth !== 'undefined' ? mammoth : null;
        this.pdfjsLib = typeof pdfjsLib !== 'undefined' ? pdfjsLib : null;
        this.librariesLoaded = {
            mammoth: Boolean(this.mammothLib),
            pdfjs: Boolean(this.pdfjsLib),
            hljs: typeof hljs !== 'undefined',
        };
    }

    /**
     * Dynamically load a script
     */
    async loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => {
                // Update library status after loading
                if (src.includes('mammoth')) {
                    this.mammothLib = typeof mammoth !== 'undefined' ? mammoth : null;
                    this.librariesLoaded.mammoth = Boolean(this.mammothLib);
                } else if (src.includes('highlight')) {
                    this.librariesLoaded.hljs = typeof hljs !== 'undefined';
                }
                resolve();
            };
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
    }

    async loadModule(src) {
        return import(src);
    }

    /**
     * Check if a file type is supported for import
     */
    isSupported(file) {
        const mimeType = file.type;
        const extension = this.getExtension(file.name).toLowerCase();
        
        return this.supportedImportFormats[mimeType] !== undefined || 
               this.extensionMap[extension] !== undefined;
    }

    /**
     * Get file extension
     */
    getExtension(filename) {
        const lastDot = filename.lastIndexOf('.');
        return lastDot === -1 ? '' : filename.slice(lastDot);
    }

    /**
     * Get file type from file object
     */
    getFileType(file) {
        const mimeType = file.type;
        const extension = this.getExtension(file.name).toLowerCase();
        
        return this.supportedImportFormats[mimeType] || 
               this.extensionMap[extension] || 
               'unknown';
    }

    /**
     * Import a file and display its contents
     */
    async importFile(file) {
        const fileType = this.getFileType(file);
        const fileName = file.name;
        
        this.app.printSystem(`📄 Importing: ${fileName} (${this.formatBytes(file.size)})`);
        
        try {
            switch (fileType) {
                case 'docx':
                case 'doc':
                    return await this.importDocx(file);
                case 'pdf':
                    return await this.importPdf(file);
                case 'html':
                case 'htm':
                    return await this.importHtml(file);
                case 'markdown':
                    return await this.importMarkdown(file);
                case 'txt':
                    return await this.importTxt(file);
                case 'json':
                    return await this.importJson(file);
                case 'javascript':
                case 'typescript':
                case 'python':
                case 'bash':
                case 'css':
                case 'scss':
                case 'xml':
                case 'yaml':
                case 'sql':
                case 'php':
                case 'ruby':
                case 'go':
                case 'rust':
                case 'java':
                case 'c':
                case 'cpp':
                case 'csharp':
                case 'swift':
                case 'kotlin':
                case 'r':
                case 'perl':
                case 'lua':
                    return await this.importCodeFile(file, fileType);
                default:
                    // Try to detect if it's a text file
                    return await this.importAsText(file);
            }
        } catch (error) {
            this.app.printError(`Failed to import ${fileName}: ${error.message}`);
            return null;
        }
    }

    /**
     * Import DOCX file
     */
    async importDocx(file) {
        if (!this.librariesLoaded.mammoth) {
            this.app.printSystem('📦 Loading DOCX library...');
            try {
                await this.loadScript('/api/sandbox-libraries/mammoth/mammoth.browser.min.js');
            } catch (error) {
                this.app.printError('Failed to load DOCX library: ' + error.message);
                return null;
            }
        }
        
        try {
            const mammothParser = this.mammothLib || (typeof mammoth !== 'undefined' ? mammoth : null);
            if (!mammothParser) {
                throw new Error('DOCX parser did not initialize');
            }
            const arrayBuffer = await file.arrayBuffer();
            const result = await mammothParser.extractRawText({ arrayBuffer });
            
            this.displayImportedContent(file.name, result.value, 'document', {
                messages: result.messages,
                wordCount: result.value.split(/\s+/).length
            });
            
            return result.value;
        } catch (error) {
            throw new Error(`DOCX parsing failed: ${error.message}`);
        }
    }

    /**
     * Import PDF file
     */
    async importPdf(file) {
        if (!this.librariesLoaded.pdfjs) {
            this.app.printSystem('📦 Loading PDF library...');
            try {
                this.pdfjsLib = await this.loadModule('/api/sandbox-libraries/pdfjs/pdf.min.mjs');
                this.pdfjsLib.GlobalWorkerOptions.workerSrc = '/api/sandbox-libraries/pdfjs/pdf.worker.min.mjs';
                this.librariesLoaded.pdfjs = true;
            } catch (error) {
                this.app.printError('Failed to load PDF library: ' + error.message);
                return null;
            }
        }
        
        try {
            const pdfParser = this.pdfjsLib || (typeof pdfjsLib !== 'undefined' ? pdfjsLib : null);
            if (!pdfParser) {
                throw new Error('PDF parser did not initialize');
            }
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfParser.getDocument({ data: arrayBuffer }).promise;
            
            let fullText = '';
            const pageCount = pdf.numPages;
            
            this.app.printSystem(`📑 PDF has ${pageCount} page(s). Extracting text...`);
            
            for (let i = 1; i <= Math.min(pageCount, 50); i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += `\n--- Page ${i} ---\n${pageText}`;
            }
            
            if (pageCount > 50) {
                fullText += '\n\n[Note: Only first 50 pages extracted]';
            }
            
            this.displayImportedContent(file.name, fullText.trim(), 'pdf', {
                pages: pageCount,
                wordCount: fullText.split(/\s+/).length
            });
            
            return fullText.trim();
        } catch (error) {
            throw new Error(`PDF parsing failed: ${error.message}`);
        }
    }

    /**
     * Import HTML file
     */
    async importHtml(file) {
        try {
            const text = await file.text();
            
            // Create a temporary element to parse HTML
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            
            // Remove script and style elements
            const scripts = doc.querySelectorAll('script, style, nav, footer, header');
            scripts.forEach(el => el.remove());
            
            // Get text content
            const textContent = doc.body.innerText || doc.body.textContent || '';
            
            this.displayImportedContent(file.name, textContent.trim(), 'html', {
                title: doc.title,
                wordCount: textContent.split(/\s+/).length
            });
            
            return textContent.trim();
        } catch (error) {
            throw new Error(`HTML parsing failed: ${error.message}`);
        }
    }

    /**
     * Import Markdown file
     */
    async importMarkdown(file) {
        try {
            const text = await file.text();
            
            this.displayImportedContent(file.name, text, 'markdown', {
                wordCount: text.split(/\s+/).length,
                lineCount: text.split('\n').length
            });
            
            return text;
        } catch (error) {
            throw new Error(`Markdown parsing failed: ${error.message}`);
        }
    }

    /**
     * Import plain text file
     */
    async importTxt(file) {
        try {
            const text = await file.text();
            
            this.displayImportedContent(file.name, text, 'text', {
                wordCount: text.split(/\s+/).length,
                lineCount: text.split('\n').length
            });
            
            return text;
        } catch (error) {
            throw new Error(`Text file parsing failed: ${error.message}`);
        }
    }

    /**
     * Import JSON file
     */
    async importJson(file) {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const formatted = JSON.stringify(parsed, null, 2);
            
            this.displayImportedContent(file.name, formatted, 'json', {
                keys: Object.keys(parsed).length,
                size: formatted.length
            });
            
            return formatted;
        } catch (error) {
            // If JSON parsing fails, display as text
            const text = await file.text();
            this.displayImportedContent(file.name, text, 'text', { error: 'Invalid JSON' });
            return text;
        }
    }

    /**
     * Import code file with syntax highlighting
     */
    async importCodeFile(file, language) {
        try {
            const text = await file.text();
            
            this.displayImportedContent(file.name, text, 'code', {
                language: language,
                lineCount: text.split('\n').length,
                size: text.length
            });
            
            return text;
        } catch (error) {
            throw new Error(`Code file parsing failed: ${error.message}`);
        }
    }

    /**
     * Try to import unknown file as text
     */
    async importAsText(file) {
        try {
            // Check if file might be binary
            const slice = file.slice(0, 1024);
            const buffer = await slice.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            
            // Check for null bytes (common in binary files)
            const hasNullBytes = bytes.some(b => b === 0);
            
            if (hasNullBytes) {
                // Show hex dump for binary files
                const hexDump = this.generateHexDump(buffer);
                this.displayImportedContent(file.name, hexDump, 'binary', {
                    size: file.size,
                    mimeType: file.type
                });
                return hexDump;
            }
            
            // Try to read as text
            const text = await file.text();
            
            this.displayImportedContent(file.name, text, 'text', {
                wordCount: text.split(/\s+/).length,
                lineCount: text.split('\n').length,
                detected: true
            });
            
            return text;
        } catch (error) {
            throw new Error(`Cannot read file: ${error.message}`);
        }
    }

    /**
     * Generate hex dump for binary files
     */
    generateHexDump(buffer, maxBytes = 1024) {
        const bytes = new Uint8Array(buffer.slice(0, maxBytes));
        let dump = 'Binary file detected. Hex dump (first 1KB):\n\n';
        
        for (let i = 0; i < bytes.length; i += 16) {
            const hex = [];
            const ascii = [];
            
            for (let j = 0; j < 16 && i + j < bytes.length; j++) {
                const byte = bytes[i + j];
                hex.push(byte.toString(16).padStart(2, '0'));
                ascii.push(byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.');
            }
            
            dump += `${i.toString(16).padStart(8, '0')}  ${hex.join(' ').padEnd(48)}  ${ascii.join('')}\n`;
        }
        
        if (buffer.byteLength > maxBytes) {
            dump += `\n... (${(buffer.byteLength - maxBytes).toLocaleString()} more bytes)`;
        }
        
        return dump;
    }

    /**
     * Display imported content in terminal
     */
    displayImportedContent(filename, content, type, metadata = {}) {
        // Create container
        const container = document.createElement('div');
        container.className = 'imported-file mb-4';
        
        // Header
        const header = document.createElement('div');
        header.className = 'file-import-header';
        header.innerHTML = `
            <span class="file-icon">${this.getFileIcon(type)}</span>
            <span class="file-name">${this.app.escapeHtml(filename)}</span>
            <span class="file-type">${type.toUpperCase()}</span>
            ${metadata.wordCount ? `<span class="file-meta">${metadata.wordCount.toLocaleString()} words</span>` : ''}
            ${metadata.lineCount ? `<span class="file-meta">${metadata.lineCount} lines</span>` : ''}
            ${metadata.pages ? `<span class="file-meta">${metadata.pages} pages</span>` : ''}
        `;
        container.appendChild(header);
        
        // Content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'file-import-content';
        
        if (type === 'code') {
            // Use highlight.js for code
            const codeBlock = document.createElement('div');
            codeBlock.className = 'code-block';
            codeBlock.innerHTML = `
                <div class="code-header">${metadata.language || 'code'}</div>
                <pre><code class="language-${metadata.language}">${this.app.escapeHtml(content)}</code></pre>
            `;
            contentDiv.appendChild(codeBlock);
            
            // Apply syntax highlighting if available
            if (this.librariesLoaded.hljs && typeof hljs !== 'undefined') {
                setTimeout(() => {
                    codeBlock.querySelectorAll('pre code').forEach((block) => {
                        hljs.highlightElement(block);
                    });
                }, 0);
            }
        } else if (type === 'markdown') {
            // Render markdown
            contentDiv.innerHTML = this.app.renderMarkdown(content);
        } else if (type === 'json') {
            // JSON with syntax highlighting
            const codeBlock = document.createElement('div');
            codeBlock.className = 'code-block';
            codeBlock.innerHTML = `
                <div class="code-header">json</div>
                <pre><code class="language-json">${this.app.escapeHtml(content)}</code></pre>
            `;
            contentDiv.appendChild(codeBlock);
            
            if (this.librariesLoaded.hljs && typeof hljs !== 'undefined') {
                setTimeout(() => {
                    codeBlock.querySelectorAll('pre code').forEach((block) => {
                        hljs.highlightElement(block);
                    });
                }, 0);
            }
        } else {
            // Plain text with preserved formatting
            const pre = document.createElement('pre');
            pre.className = 'file-text-content';
            pre.textContent = content;
            contentDiv.appendChild(pre);
        }
        
        container.appendChild(contentDiv);
        
        const importId = String(this.nextImportedContentId++);
        this.importedContentById.set(importId, { content, filename });

        // Actions
        const actions = document.createElement('div');
        actions.className = 'file-import-actions';

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'toolbar-btn';
        copyButton.dataset.importId = importId;
        copyButton.setAttribute('aria-label', `Copy imported file ${filename}`);
        copyButton.title = `Copy ${filename}`;
        copyButton.textContent = 'Copy';
        copyButton.addEventListener('click', () => this.copyContent(copyButton));
        actions.appendChild(copyButton);

        const sendButton = document.createElement('button');
        sendButton.type = 'button';
        sendButton.className = 'toolbar-btn';
        sendButton.dataset.importId = importId;
        sendButton.setAttribute('aria-label', `Send imported file ${filename} to AI`);
        sendButton.title = `Send ${filename} to AI`;
        sendButton.textContent = 'Send to AI';
        sendButton.addEventListener('click', () => this.sendToAI(filename, importId));
        actions.appendChild(sendButton);
        container.appendChild(actions);
        
        this.app.terminalOutput.appendChild(container);
        this.app.scrollToBottom();
        
        // Store for later use
        this.lastImportedContent = content;
        this.lastImportedFilename = filename;
        
        this.app.printSystem(`✓ Imported ${filename} successfully`);
    }

    /**
     * Get file icon based on type
     */
    getFileIcon(type) {
        const icons = {
            docx: '📘',
            doc: '📘',
            pdf: '📕',
            html: '🌐',
            markdown: '📝',
            text: '📄',
            json: '📋',
            code: '💻',
            binary: '🔢',
            document: '📄',
        };
        return icons[type] || '📄';
    }

    /**
     * Copy content to clipboard
     */
    async copyContent(button) {
        const record = this.getImportedContentRecord(button?.dataset?.importId);
        const content = record?.content ?? button?.getAttribute?.('data-content') ?? '';
        try {
            await this.app.writeClipboardText(content);
            const originalText = button.textContent;
            button.textContent = '✓ Copied!';
            setTimeout(() => button.textContent = originalText, 2000);
        } catch (err) {
            this.app.printError('Failed to copy: ' + err.message);
        }
    }

    /**
     * Send imported content to AI
     */
    sendToAI(filename, importId = '') {
        const record = this.getImportedContentRecord(importId);
        const importedContent = record?.content || this.lastImportedContent;
        const importedFilename = record?.filename || filename;
        if (!importedContent) {
            this.app.printError('No content to send');
            return;
        }
        
        // Truncate if too long
        const maxLength = 8000;
        let content = importedContent;
        if (content.length > maxLength) {
            content = content.slice(0, maxLength) + '\n\n[Content truncated...]';
        }
        
        const message = `Here's the content of "${importedFilename}":\n\n\`\`\`\n${content}\n\`\`\`\n\nPlease analyze this file.`;
        this.app.commandInput.value = message;
        this.app.commandInput.focus();
        this.app.printSystem('Content loaded into input. Press Enter to send to AI.');
    }

    getImportedContentRecord(importId = '') {
        const normalizedId = String(importId || '').trim();
        if (!normalizedId || !this.importedContentById?.has(normalizedId)) {
            return null;
        }
        return this.importedContentById.get(normalizedId);
    }

    /**
     * Export session to various formats
     */
    async exportSession(format = 'txt') {
        const session = {
            timestamp: new Date().toISOString(),
            sessionId: this.app.api?.sessionId || 'none',
            mode: this.app.mode,
            history: this.app.history,
            conversationHistory: this.app.conversationHistory,
        };
        
        const terminalOutput = document.getElementById('terminalOutput');
        const content = terminalOutput.innerText;
        
        switch (format.toLowerCase()) {
            case 'txt':
            case 'text':
                return this.exportAsTxt(session, content);
            case 'json':
                return this.exportAsJson(session);
            case 'md':
            case 'markdown':
                return this.exportAsMarkdown(session, content);
            case 'html':
                return this.exportAsHtml(session, content);
            case 'docx':
                return this.exportAsDocx(session, content);
            case 'pdf':
                return this.exportAsPdf(session, content);
            default:
                throw new Error(`Unsupported export format: ${format}`);
        }
    }

    /**
     * Export as plain text
     */
    exportAsTxt(session, content) {
        const timestamp = new Date().toLocaleString();
        const output = `LillyBuilt Session Export
========================
Exported: ${timestamp}
Session ID: ${session.sessionId}
Mode: ${session.mode}
Messages: ${session.history?.length || 0}

${content}`;
        
        this.downloadFile(output, `lillybuilt-session-${this.getDateStamp()}.txt`, 'text/plain');
        return true;
    }

    /**
     * Export as JSON
     */
    exportAsJson(session) {
        const output = JSON.stringify(session, null, 2);
        this.downloadFile(output, `lillybuilt-session-${this.getDateStamp()}.json`, 'application/json');
        return true;
    }

    /**
     * Export as Markdown
     */
    exportAsMarkdown(session, content) {
        const timestamp = new Date().toLocaleString();
        let md = `# LillyBuilt Session Export

**Exported:** ${timestamp}  
**Session ID:** ${session.sessionId}  
**Mode:** ${session.mode}  
**Messages:** ${session.history?.length || 0}

---

`;
        
        // Convert conversation history to markdown
        if (session.conversationHistory) {
            session.conversationHistory.forEach(msg => {
                if (msg.role === 'user') {
                    md += `## User\n\n${msg.content}\n\n`;
                } else if (msg.role === 'assistant') {
                    md += `## Assistant\n\n${msg.content}\n\n`;
                }
            });
        }
        
        this.downloadFile(md, `lillybuilt-session-${this.getDateStamp()}.md`, 'text/markdown');
        return true;
    }

    /**
     * Export as HTML
     */
    exportAsHtml(session, content) {
        const timestamp = new Date().toLocaleString();
        const terminalOutput = document.getElementById('terminalOutput');
        
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LillyBuilt Session Export</title>
    <style>
        body {
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            background: #0d1117;
            color: #c9d1d9;
            line-height: 1.6;
        }
        .header {
            border-bottom: 1px solid #30363d;
            padding-bottom: 20px;
            margin-bottom: 20px;
        }
        .header h1 {
            color: #58a6ff;
            margin: 0 0 10px 0;
        }
        .meta {
            color: #8b949e;
            font-size: 0.9em;
        }
        .timestamp {
            color: #6e7681;
            font-size: 0.8em;
        }
        .user-input {
            color: #c9d1d9;
            margin: 10px 0;
            padding: 10px;
            background: #161b22;
            border-left: 3px solid #58a6ff;
        }
        .ai-response {
            color: #7ee787;
            margin: 10px 0;
            padding: 10px;
            background: #161b22;
            border-left: 3px solid #7ee787;
        }
        .system {
            color: #8b949e;
            margin: 10px 0;
        }
        .error {
            color: #f85149;
            margin: 10px 0;
        }
        pre {
            background: #21262d;
            padding: 15px;
            border-radius: 6px;
            overflow-x: auto;
        }
        code {
            font-family: inherit;
            background: #21262d;
            padding: 2px 6px;
            border-radius: 3px;
        }
        @media print {
            body {
                background: white;
                color: black;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>LillyBuilt Session Export</h1>
        <div class="meta">
            <div>Exported: ${timestamp}</div>
            <div>Session ID: ${session.sessionId}</div>
            <div>Mode: ${session.mode}</div>
            <div>Messages: ${session.history?.length || 0}</div>
        </div>
    </div>
    <div class="content">
        ${terminalOutput.innerHTML}
    </div>
</body>
</html>`;
        
        this.downloadFile(html, `lillybuilt-session-${this.getDateStamp()}.html`, 'text/html');
        return true;
    }

    /**
     * Export as DOCX (using HTML conversion via mammoth if available)
     * Falls back to creating a simple Word-compatible HTML
     */
    exportAsDocx(session, content) {
        // Since we can't generate true DOCX in browser easily,
        // we'll create a Word-compatible HTML file with .doc extension
        const timestamp = new Date().toLocaleString();
        
        const wordHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
    <meta charset="utf-8">
    <title>LillyBuilt Session</title>
    <style>
        body { font-family: Calibri, Arial, sans-serif; }
        .header { margin-bottom: 20px; }
        .user { color: #0066cc; margin: 10px 0; }
        .assistant { color: #006600; margin: 10px 0; }
        .timestamp { color: #666; font-size: 0.8em; }
        pre { background: #f5f5f5; padding: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>LillyBuilt Session Export</h1>
        <p><strong>Exported:</strong> ${timestamp}</p>
        <p><strong>Session ID:</strong> ${session.sessionId}</p>
        <p><strong>Mode:</strong> ${session.mode}</p>
        <p><strong>Messages:</strong> ${session.history?.length || 0}</p>
    </div>
    <hr>
    <div class="content">
        ${content.replace(/\n/g, '<br>')}
    </div>
</body>
</html>`;
        
        this.downloadFile(wordHtml, `lillybuilt-session-${this.getDateStamp()}.doc`, 'application/msword');
        return true;
    }

    /**
     * Export as PDF (using browser print)
     */
    exportAsPdf(session, content) {
        // Open a new window with formatted content for printing to PDF
        const timestamp = new Date().toLocaleString();
        const terminalOutput = document.getElementById('terminalOutput');
        
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
    <title>LillyBuilt Session Export</title>
    <style>
        @page { size: A4; margin: 20mm; }
        body {
            font-family: 'Courier New', monospace;
            font-size: 11pt;
            line-height: 1.5;
            color: #333;
        }
        .header {
            border-bottom: 2px solid #333;
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        .header h1 {
            font-size: 18pt;
            margin: 0 0 10px 0;
        }
        .meta {
            font-size: 10pt;
            color: #666;
        }
        .content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .timestamp {
            color: #999;
            font-size: 9pt;
        }
        @media print {
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>LillyBuilt Session Export</h1>
        <div class="meta">
            <div>Exported: ${timestamp}</div>
            <div>Session ID: ${session.sessionId}</div>
            <div>Mode: ${session.mode}</div>
            <div>Messages: ${session.history?.length || 0}</div>
        </div>
    </div>
    <div class="content no-print">
        <p><em>Click print and select "Save as PDF" to download.</em></p>
        <button onclick="window.print()" style="padding: 10px 20px; font-size: 14px;">🖨️ Print / Save as PDF</button>
        <hr style="margin: 20px 0;">
    </div>
    <div class="content">
        ${terminalOutput.innerText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
    </div>
</body>
</html>`);
        printWindow.document.close();
        
        this.app.printSystem('✓ PDF export window opened. Use Print → Save as PDF to download.');
        return true;
    }

    /**
     * Helper: Download file
     */
    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
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
     * Helper: Format bytes
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Helper: Get date stamp
     */
    getDateStamp() {
        return new Date().toISOString().slice(0, 10);
    }

    /**
     * Batch import multiple files
     */
    async importBatch(files) {
        this.app.printSystem(`📁 Batch importing ${files.length} file(s)...`);
        
        const results = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            this.app.printSystem(`  (${i + 1}/${files.length}) Processing: ${file.name}`);
            
            try {
                const content = await this.importFile(file);
                results.push({ file: file.name, success: true, content });
            } catch (error) {
                results.push({ file: file.name, success: false, error: error.message });
            }
        }
        
        const successCount = results.filter(r => r.success).length;
        this.app.printSystem(`✓ Batch import complete: ${successCount}/${files.length} successful`);
        
        return results;
    }

    /**
     * Show supported formats
     */
    showSupportedFormats() {
        const formats = {
            'Documents': ['DOCX', 'PDF', 'HTML', 'Markdown (MD)', 'Plain Text (TXT)'],
            'Data': ['JSON'],
            'Code Files': ['JavaScript', 'TypeScript', 'Python', 'Bash/Shell', 'CSS/SCSS', 'SQL', 'PHP', 'Ruby', 'Go', 'Rust', 'Java', 'C/C++', 'C#', 'Swift', 'Kotlin', 'R', 'Perl', 'Lua'],
        };
        
        let output = '**Supported Import Formats:**\n\n';
        for (const [category, items] of Object.entries(formats)) {
            output += `**${category}:**\n`;
            items.forEach(item => output += `  • ${item}\n`);
            output += '\n';
        }
        
        output += '**Supported Export Formats:**\n';
        output += '  • TXT (Plain text with timestamps)\n';
        output += '  • JSON (Full session data)\n';
        output += '  • Markdown (Clean markdown)\n';
        output += '  • HTML (Styled web page)\n';
        output += '  • DOC (Word-compatible document)\n';
        output += '  • PDF (via browser print)\n';
        
        return output;
    }
}

// Create global instance (will be initialized by app.js)
let fileHandler = null;
