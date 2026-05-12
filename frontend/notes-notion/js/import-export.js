/**
 * Import/Export Module - Comprehensive file format support
 * Handles DOCX, PDF, HTML, Markdown, JSON (Lilly), and TXT formats
 */

const ImportExport = (function() {
    
    // Supported formats configuration
    const FORMATS = {
        export: {
            docx: { name: 'Word Document', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            pdf: { name: 'PDF Document', ext: 'pdf', mime: 'application/pdf' },
            html: { name: 'HTML Document', ext: 'html', mime: 'text/html' },
            md: { name: 'Markdown', ext: 'md', mime: 'text/markdown' },
            json: { name: 'Lilly JSON', ext: 'json', mime: 'application/json' },
            txt: { name: 'Plain Text', ext: 'txt', mime: 'text/plain' }
        },
        import: {
            docx: { name: 'Word Document', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            pdf: { name: 'PDF Document', ext: 'pdf', mime: 'application/pdf' },
            html: { name: 'HTML Document', ext: 'html', mime: 'text/html' },
            md: { name: 'Markdown', ext: 'md', mime: 'text/markdown' },
            json: { name: 'Lilly JSON', ext: 'json', mime: 'application/json' },
            txt: { name: 'Plain Text', ext: 'txt', mime: 'text/plain' }
        }
    };

    function clonePageForExport(page) {
        try {
            return JSON.parse(JSON.stringify(page || {}));
        } catch (_error) {
            return {
                ...(page || {}),
                blocks: Array.isArray(page?.blocks) ? page.blocks.map(cloneBlockForExport) : []
            };
        }
    }

    function cloneBlockForExport(block) {
        if (!block || typeof block !== 'object') return block;
        return {
            ...block,
            content: block.content && typeof block.content === 'object'
                ? { ...block.content }
                : block.content,
            children: Array.isArray(block.children) ? block.children.map(cloneBlockForExport) : []
        };
    }

    function normalizeExportText(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function getImageSource(block) {
        if (!block?.content || typeof block.content !== 'object') return '';
        if (block.type === 'ai_image') {
            return block.content._exportImageUrl
                || block.content._resolvedImageUrl
                || block.content.inlineUrl
                || block.content.imageUrl
                || block.content.url
                || block.content.downloadUrl
                || '';
        }

        return block.content._exportImageUrl
            || block.content._resolvedImageUrl
            || block.content.url
            || block.content.imageUrl
            || '';
    }

    function getImageAltText(block) {
        if (!block?.content || typeof block.content !== 'object') return '';
        return normalizeExportText(
            block.content.alt
            || block.content.caption
            || block.content.prompt
            || block.content.title
            || (block.type === 'ai_image' ? 'AI generated image' : 'Image')
        );
    }

    function getImageCaption(block) {
        if (!block?.content || typeof block.content !== 'object') return '';
        return normalizeExportText(
            block.content.caption
            || block.content.title
            || (block.type === 'ai_image' ? block.content.prompt : '')
        );
    }

    function getImageSubtext(block) {
        if (!block?.content || typeof block.content !== 'object') return '';
        const parts = [];
        const content = block.content;

        if (block.type === 'ai_image' && content.caption && content.prompt && content.caption !== content.prompt) {
            parts.push(`Prompt: ${normalizeExportText(content.prompt)}`);
        }
        if (content.description || content.subtext || content.subtitle) {
            parts.push(normalizeExportText(content.description || content.subtext || content.subtitle));
        }
        if (content.unsplashPhotographer) {
            parts.push(`Photo: ${normalizeExportText(content.unsplashPhotographer)}`);
        }
        if (content.sourceHost) {
            parts.push(`Source: ${normalizeExportText(content.sourceHost)}`);
        }

        return parts.filter(Boolean).join(' | ');
    }

    function getImageLink(block) {
        if (!block?.content || typeof block.content !== 'object') return '';
        return normalizeExportText(
            block.content.downloadUrl
            || block.content.sourceUrl
            || block.content.unsplashPhotographerUrl
            || block.content.url
            || block.content.imageUrl
            || ''
        );
    }

    function getHostname(url) {
        try {
            return new URL(url).hostname;
        } catch (_error) {
            return url || '';
        }
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Failed to read image data'));
            reader.readAsDataURL(blob);
        });
    }

    async function resolveExportImageDataUrl(sourceUrl) {
        const source = String(sourceUrl || '').trim();
        if (!source) return '';
        if (/^data:image\//i.test(source)) return source;

        let fetchUrl = source;
        if (source.startsWith('asset://') && window.Storage?.resolveImageAsset) {
            fetchUrl = await window.Storage.resolveImageAsset(source);
        }

        if (!fetchUrl || /^asset:\/\//i.test(fetchUrl)) return '';

        try {
            const response = await fetch(fetchUrl, { credentials: 'include' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const blob = await response.blob();
            if (!/^image\//i.test(blob.type || '')) {
                return '';
            }
            return await blobToDataUrl(blob);
        } catch (error) {
            console.warn('Failed to prepare export image:', error.message);
            return '';
        }
    }

    async function prepareBlockForExport(block) {
        if (!block || typeof block !== 'object') return block;

        if ((block.type === 'image' || block.type === 'ai_image') && block.content && typeof block.content === 'object') {
            const sourceUrl = getImageSource(block);
            const dataUrl = await resolveExportImageDataUrl(sourceUrl);
            const fallbackUrl = String(sourceUrl || '').startsWith('asset://')
                ? getImageLink(block)
                : sourceUrl;
            block.content._exportImageUrl = dataUrl || fallbackUrl || sourceUrl;
            block.content._exportImageDataUrl = dataUrl || '';
            block.content._exportAlt = getImageAltText(block);
            block.content._exportCaption = getImageCaption(block);
            block.content._exportSubtext = getImageSubtext(block);
            block.content._exportLink = getImageLink(block);
        }

        if (Array.isArray(block.children) && block.children.length > 0) {
            for (const child of block.children) {
                await prepareBlockForExport(child);
            }
        }

        return block;
    }

    async function preparePageForExport(page) {
        const exportPageCopy = clonePageForExport(page);
        const blocks = Array.isArray(exportPageCopy.blocks) ? exportPageCopy.blocks : [];
        for (const block of blocks) {
            await prepareBlockForExport(block);
        }
        return exportPageCopy;
    }

    /**
     * Export page to various formats
     */
    async function exportPage(page, format) {
        if (!page) {
            throw new Error('No page provided for export');
        }

        const preparedPage = format === 'json'
            ? clonePageForExport(page)
            : await preparePageForExport(page);

        switch (format) {
            case 'docx':
                return await exportToDOCX(preparedPage);
            case 'pdf':
                return await exportToPDF(preparedPage, { alreadyPrepared: true });
            case 'html':
                return exportToHTML(preparedPage);
            case 'md':
                return exportToMarkdown(preparedPage);
            case 'json':
                return exportToJSON(preparedPage);
            case 'txt':
                return exportToTXT(preparedPage);
            default:
                throw new Error(`Unsupported export format: ${format}`);
        }
    }

    /**
     * Export to DOCX using docx.js
     */
    async function exportToDOCX(page) {
        if (typeof docx === 'undefined') {
            throw new Error('docx.js library not loaded');
        }

        const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = docx;

        const children = [];

        // Page icon and title
        const titleText = (page.icon ? page.icon + ' ' : '') + (page.title || 'Untitled');
        children.push(new Paragraph({
            text: titleText,
            heading: HeadingLevel.TITLE,
            spacing: { after: 400 }
        }));

        // Properties
        if (page.properties && page.properties.length > 0) {
            page.properties.forEach(prop => {
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: prop.key + ': ', bold: true }),
                        new TextRun({ text: prop.value })
                    ],
                    spacing: { after: 120 }
                }));
            });
            children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
        }

        // Process blocks
        page.blocks.forEach(block => {
            const paragraphs = blockToDocxParagraphs(block);
            children.push(...paragraphs);
        });

        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        margin: {
                            top: 1440, // 1 inch
                            right: 1440,
                            bottom: 1440,
                            left: 1440
                        }
                    }
                },
                children: children
            }]
        });

        const blob = await Packer.toBlob(doc);
        return blob;
    }

    /**
     * Convert block to DOCX paragraphs
     */
    function blockToDocxParagraphs(block) {
        const { Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = docx;
        const paragraphs = [];

        switch (block.type) {
            case 'heading_1':
                paragraphs.push(new Paragraph({
                    text: getBlockText(block),
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 400, after: 200 }
                }));
                break;

            case 'heading_2':
                paragraphs.push(new Paragraph({
                    text: getBlockText(block),
                    heading: HeadingLevel.HEADING_2,
                    spacing: { before: 300, after: 150 }
                }));
                break;

            case 'heading_3':
                paragraphs.push(new Paragraph({
                    text: getBlockText(block),
                    heading: HeadingLevel.HEADING_3,
                    spacing: { before: 200, after: 100 }
                }));
                break;

            case 'bulleted_list':
                paragraphs.push(new Paragraph({
                    text: getBlockText(block),
                    bullet: { level: 0 },
                    spacing: { after: 80 }
                }));
                break;

            case 'numbered_list':
                paragraphs.push(new Paragraph({
                    text: getBlockText(block),
                    numbering: { reference: 'my-numbering', level: 0 },
                    spacing: { after: 80 }
                }));
                break;

            case 'todo':
                const todoText = typeof block.content === 'object' 
                    ? (block.content.checked ? '☑ ' : '☐ ') + block.content.text 
                    : '☐ ' + block.content;
                paragraphs.push(new Paragraph({
                    text: todoText,
                    spacing: { after: 80 }
                }));
                break;

            case 'quote':
                paragraphs.push(new Paragraph({
                    text: getBlockText(block),
                    border: {
                        left: {
                            color: '2383E2',
                            space: 12,
                            style: BorderStyle.SINGLE,
                            size: 24
                        }
                    },
                    indent: { left: 720 },
                    spacing: { before: 200, after: 200 }
                }));
                break;

            case 'code':
                const codeText = typeof block.content === 'object' 
                    ? block.content.text 
                    : block.content;
                paragraphs.push(new Paragraph({
                    text: codeText,
                    shading: { fill: 'F5F5F5' },
                    font: { name: 'Courier New' },
                    spacing: { before: 200, after: 200 }
                }));
                break;

            case 'divider':
                paragraphs.push(new Paragraph({
                    text: '─────────────────',
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 200, after: 200 }
                }));
                break;

            case 'callout':
                const calloutIcon = block.icon || '💡';
                paragraphs.push(new Paragraph({
                    children: [
                        new TextRun({ text: calloutIcon + ' ' }),
                        new TextRun({ text: getBlockText(block) })
                    ],
                    shading: { fill: 'FFF8E1' },
                    spacing: { before: 200, after: 200 }
                }));
                break;

            case 'image':
                if (block.content && block.content.url) {
                    paragraphs.push(new Paragraph({
                        text: `[Image: ${block.content.caption || block.content.url}]`,
                        italics: true,
                        spacing: { before: 200, after: 200 }
                    }));
                }
                break;

            case 'ai_image':
                if (block.content && block.content.prompt) {
                    paragraphs.push(new Paragraph({
                        text: `[AI Image: ${block.content.prompt}]`,
                        italics: true,
                        spacing: { before: 200, after: 200 }
                    }));
                }
                break;

            case 'database':
                if (block.content && block.content.columns) {
                    // Simple table representation
                    paragraphs.push(new Paragraph({
                        text: `[Table: ${block.content.columns.join(', ')}]`,
                        italics: true,
                        spacing: { before: 200, after: 200 }
                    }));
                }
                break;

            default: // text and others
                if (getBlockText(block)) {
                    paragraphs.push(new Paragraph({
                        text: getBlockText(block),
                        spacing: { after: 120 }
                    }));
                }
        }

        return paragraphs;
    }

    /**
     * Export to a real PDF using the backend Notes PDF renderer
     */
    async function exportToPDF(page, options = {}) {
        const exportPageData = options.alreadyPrepared ? page : await preparePageForExport(page);
        const response = await fetch('/api/documents/export-notes-page-pdf', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                page: exportPageData,
                options: {
                    includeOutline: true,
                    includePageNumbers: true
                }
            })
        });

        if (!response.ok) {
            let message = 'Failed to generate PDF export';
            try {
                const error = await response.json();
                message = error?.error?.message || message;
            } catch (parseError) {
                // Keep the default message when the error payload is not JSON.
            }
            throw new Error(message);
        }

        const blob = await response.blob();
        const filename = response.headers.get('X-Document-Filename') ||
            `${String(exportPageData?.title || 'page').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'page'}.pdf`;

        return {
            blob,
            filename,
            mimeType: 'application/pdf'
        };
    }

    function openPrintFriendlyFallback(page) {
        const htmlContent = generatePDFHTML(page);
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            return false;
        }

        printWindow.document.write(htmlContent);
        printWindow.document.close();
        return true;
    }

    /**
     * Generate print-friendly HTML for PDF export
     */
    function generatePDFHTML(page) {
        const blocksHTML = page.blocks.map(block => blockToHTML(block)).join('');
        
        return `<!DOCTYPE html>
<html>
<head>
    <title>${escapeHtml(page.title || 'Untitled')}</title>
    <style>
        @page { margin: 2cm; }
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 11pt;
            line-height: 1.6;
            color: #333;
            max-width: 100%;
            margin: 0;
            padding: 0;
        }
        h1 { font-size: 24pt; margin: 0 0 16pt 0; font-weight: 700; page-break-after: avoid; }
        h2 { font-size: 18pt; margin: 20pt 0 12pt 0; font-weight: 600; page-break-after: avoid; }
        h3 { font-size: 14pt; margin: 16pt 0 8pt 0; font-weight: 600; page-break-after: avoid; }
        p { margin: 0 0 8pt 0; }
        ul, ol { margin: 8pt 0; padding-left: 24pt; }
        li { margin: 4pt 0; }
        blockquote {
            border-left: 4pt solid #2383e2;
            margin: 12pt 0;
            padding-left: 16pt;
            color: #666;
        }
        pre {
            background: #f5f5f5;
            padding: 12pt;
            border-radius: 6pt;
            overflow-x: auto;
            font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 9pt;
            margin: 12pt 0;
            page-break-inside: avoid;
        }
        code {
            font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 9pt;
            background: #f5f5f5;
            padding: 2pt 4pt;
            border-radius: 3pt;
        }
        .callout {
            background: #fff8e1;
            padding: 12pt;
            border-radius: 6pt;
            margin: 12pt 0;
            page-break-inside: avoid;
        }
        .todo { margin: 4pt 0; }
        .todo-checked { text-decoration: line-through; color: #999; }
        .divider {
            border: none;
            border-top: 1pt solid #ddd;
            margin: 16pt 0;
        }
        img { max-width: 100%; height: auto; page-break-inside: avoid; }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 12pt 0;
            page-break-inside: avoid;
        }
        th, td {
            border: 1pt solid #ddd;
            padding: 8pt;
            text-align: left;
        }
        th { background: #f5f5f5; font-weight: 600; }
        .page-info {
            margin-bottom: 24pt;
            padding-bottom: 12pt;
            border-bottom: 1pt solid #eee;
        }
        .page-icon { font-size: 32pt; margin-bottom: 8pt; }
        .properties { margin: 12pt 0; font-size: 10pt; color: #666; }
        .property { margin: 4pt 0; }
        @media print {
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="page-info">
        ${page.icon ? `<div class="page-icon">${page.icon}</div>` : ''}
        <h1>${escapeHtml(page.title || 'Untitled')}</h1>
        ${generatePropertiesHTML(page.properties)}
    </div>
    ${blocksHTML}
    <div class="no-print" style="margin-top: 40pt; padding-top: 12pt; border-top: 1pt solid #eee; color: #999; font-size: 9pt;">
        Exported from Notes - ${new Date().toLocaleString()}
    </div>
    <script>
        setTimeout(() => {
            if (confirm('Click OK to print/save as PDF')) {
                window.print();
            }
        }, 500);
    <\/script>
</body>
</html>`;
    }

    /**
     * Generate properties HTML
     */
    function generatePropertiesHTML(properties) {
        if (!properties || properties.length === 0) return '';
        const props = properties.map(p => 
            `<div class="property"><strong>${escapeHtml(p.key)}:</strong> ${escapeHtml(p.value)}</div>`
        ).join('');
        return `<div class="properties">${props}</div>`;
    }

    /**
     * Export to HTML
     */
    function exportToHTML(page) {
        const blocksHTML = page.blocks.map(block => blockToHTML(block)).join('');
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(page.title || 'Untitled')}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 16px;
            line-height: 1.6;
            color: #37352f;
            max-width: 900px;
            margin: 0 auto;
            padding: 40px 20px;
            background: #fff;
        }
        h1 { font-size: 40px; font-weight: 700; margin: 0 0 20px; line-height: 1.2; }
        h2 { font-size: 30px; font-weight: 600; margin: 32px 0 12px; }
        h3 { font-size: 24px; font-weight: 600; margin: 24px 0 8px; }
        p { margin: 0 0 12px; }
        ul, ol { margin: 12px 0; padding-left: 24px; }
        li { margin: 4px 0; }
        blockquote {
            border-left: 4px solid #2383e2;
            margin: 16px 0;
            padding-left: 16px;
            color: #6b6b6b;
        }
        pre {
            background: #f7f7f5;
            padding: 16px;
            border-radius: 8px;
            overflow-x: auto;
            font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 14px;
            margin: 16px 0;
        }
        code {
            font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 14px;
            background: #f7f7f5;
            padding: 2px 6px;
            border-radius: 4px;
        }
        .callout {
            background: #fbf3db;
            padding: 16px;
            border-radius: 8px;
            margin: 16px 0;
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }
        .callout-icon { font-size: 20px; }
        .callout-content { flex: 1; }
        .todo { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
        .todo-checkbox { font-size: 18px; }
        .todo-checked { text-decoration: line-through; color: #9ca3af; }
        .divider { border: none; border-top: 1px solid #e3e2e0; margin: 24px 0; }
        img { max-width: 100%; height: auto; border-radius: 8px; }
        figure { margin: 20px 0; }
        figcaption { text-align: center; color: #4b5563; font-size: 14px; margin-top: 8px; }
        .image-wrapper { margin: 20px 0; }
        .image-caption { text-align: center; color: #374151; font-size: 14px; margin-top: 8px; }
        .image-subtext { text-align: center; color: #6b7280; font-size: 12px; margin-top: 4px; }
        .image-source { text-align: center; font-size: 12px; margin-top: 4px; }
        .image-source a { color: #2563eb; }
        table { width: 100%; border-collapse: collapse; margin: 16px 0; }
        th, td { border: 1px solid #e3e2e0; padding: 12px; text-align: left; }
        th { background: #f7f7f5; font-weight: 600; }
        tr:nth-child(even) { background: #f7f7f5; }
        .page-icon { font-size: 78px; margin-bottom: 16px; }
        .properties { margin: 16px 0; padding: 16px 0; border-top: 1px solid #e3e2e0; border-bottom: 1px solid #e3e2e0; }
        .property { display: flex; gap: 12px; margin: 8px 0; }
        .property-key { color: #6b6b6b; min-width: 120px; }
        .bookmark {
            display: flex;
            border: 1px solid #e3e2e0;
            border-radius: 8px;
            overflow: hidden;
            margin: 16px 0;
            text-decoration: none;
            color: inherit;
        }
        .bookmark-info { padding: 16px; flex: 1; }
        .bookmark-title { font-weight: 600; margin-bottom: 4px; }
        .bookmark-desc { color: #6b6b6b; font-size: 14px; margin-bottom: 4px; }
        .bookmark-url { color: #9ca3af; font-size: 12px; }
        .bookmark-image { width: 200px; min-height: 132px; object-fit: cover; background: #f3f4f6; }
        .chart-summary { color: #4b5563; font-size: 14px; margin: -4px 0 10px; }
        footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #e3e2e0; color: #9ca3af; font-size: 12px; }
    </style>
</head>
<body>
    ${page.icon ? `<div class="page-icon">${page.icon}</div>` : ''}
    <h1>${escapeHtml(page.title || 'Untitled')}</h1>
    ${generatePropertiesHTMLFull(page.properties)}
    ${blocksHTML}
    <footer>
        Exported from Notes - ${new Date().toLocaleString()}
    </footer>
</body>
</html>`;
    }

    /**
     * Generate full properties HTML
     */
    function generatePropertiesHTMLFull(properties) {
        if (!properties || properties.length === 0) return '';
        const props = properties.map(p => 
            `<div class="property">
                <span class="property-key">${escapeHtml(p.key)}</span>
                <span class="property-value">${escapeHtml(p.value)}</span>
            </div>`
        ).join('');
        return `<div class="properties">${props}</div>`;
    }

    /**
     * Convert block to HTML
     */
    function blockToHTML(block) {
        const content = getBlockText(block);
        
        switch (block.type) {
            case 'heading_1':
                return `<h2>${escapeHtml(content)}</h2>`;
            case 'heading_2':
                return `<h3>${escapeHtml(content)}</h3>`;
            case 'heading_3':
                return `<h4>${escapeHtml(content)}</h4>`;
            case 'bulleted_list':
                return `<ul><li>${escapeHtml(content)}</li></ul>`;
            case 'numbered_list':
                return `<ol><li>${escapeHtml(content)}</li></ol>`;
            case 'todo':
                const todoData = typeof block.content === 'object' ? block.content : { text: content, checked: false };
                const checkedClass = todoData.checked ? ' todo-checked' : '';
                const checkbox = todoData.checked ? '☑' : '☐';
                return `<div class="todo"><span class="todo-checkbox">${checkbox}</span><span class="${checkedClass}">${escapeHtml(todoData.text)}</span></div>`;
            case 'quote':
                return `<blockquote>${escapeHtml(content)}</blockquote>`;
            case 'code':
                const codeData = typeof block.content === 'object' ? block.content : { text: content, language: 'plain' };
                return `<pre><code class="language-${codeData.language}">${escapeHtml(codeData.text)}</code></pre>`;
            case 'divider':
                return `<hr class="divider">`;
            case 'callout':
                const icon = block.icon || '💡';
                return `<div class="callout"><span class="callout-icon">${icon}</span><div class="callout-content">${escapeHtml(content)}</div></div>`;
            case 'image':
                if (block.content) {
                    const src = getImageSource(block);
                    if (!src) return '';
                    const caption = getImageCaption(block);
                    const subtext = getImageSubtext(block);
                    const link = getImageLink(block);
                    return `<figure class="image-wrapper">
                        <img src="${escapeHtml(src)}" alt="${escapeHtml(getImageAltText(block))}">
                        ${caption ? `<figcaption class="image-caption">${escapeHtml(caption)}</figcaption>` : ''}
                        ${subtext ? `<div class="image-subtext">${escapeHtml(subtext)}</div>` : ''}
                        ${link && link !== src ? `<div class="image-source"><a href="${escapeHtml(link)}" target="_blank" rel="noopener">Image source</a></div>` : ''}
                    </figure>`;
                }
                return '';
            case 'ai_image':
                if (block.content) {
                    const src = getImageSource(block);
                    const caption = getImageCaption(block);
                    const subtext = getImageSubtext(block);
                    const link = getImageLink(block);
                    if (src) {
                        return `<figure class="image-wrapper">
                            <img src="${escapeHtml(src)}" alt="${escapeHtml(getImageAltText(block))}">
                            ${caption ? `<figcaption class="image-caption">${escapeHtml(caption)}</figcaption>` : ''}
                            ${subtext ? `<div class="image-subtext">${escapeHtml(subtext)}</div>` : ''}
                            ${link && link !== src ? `<div class="image-source"><a href="${escapeHtml(link)}" target="_blank" rel="noopener">Image source</a></div>` : ''}
                        </figure>`;
                    }
                }
                return `<p><em>[AI Image: ${escapeHtml(block.content?.prompt || 'pending')}]</em></p>`;
            case 'bookmark':
                if (block.content && block.content.url) {
                    return `<a href="${escapeHtml(block.content.url)}" class="bookmark" target="_blank" rel="noopener">
                        <div class="bookmark-info">
                            <div class="bookmark-title">${escapeHtml(block.content.title || block.content.url)}</div>
                            ${block.content.description ? `<div class="bookmark-desc">${escapeHtml(block.content.description)}</div>` : ''}
                            <div class="bookmark-url">${escapeHtml(getHostname(block.content.url))}</div>
                        </div>
                        ${block.content.image ? `<img class="bookmark-image" src="${escapeHtml(block.content.image)}" alt="">` : ''}
                    </a>`;
                }
                return '';
            case 'database':
                if (block.content && block.content.columns) {
                    const headers = block.content.columns.map(col => `<th>${escapeHtml(col)}</th>`).join('');
                    const rows = (block.content.rows || []).map(row => 
                        `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
                    ).join('');
                    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
                }
                return '';
            case 'chart':
                if (block.content) {
                    const title = escapeHtml(block.content.title || 'Chart');
                    const labels = Array.isArray(block.content.labels) ? block.content.labels : [];
                    const values = Array.isArray(block.content.values) ? block.content.values : [];
                    const unit = block.content.unit || '';
                    const rows = labels.map((label, index) =>
                        `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(`${values[index] ?? ''}${unit}`)}</td></tr>`
                    ).join('');
                    return `<section class="chart-export">
                        <h4>${title}</h4>
                        ${block.content.summary ? `<p class="chart-summary">${escapeHtml(block.content.summary)}</p>` : ''}
                        <table><thead><tr><th>Label</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
                    </section>`;
                }
                return '';
            case 'math':
                const mathText = typeof block.content === 'object' ? block.content.text : content;
                return `<p style="text-align: center; font-family: 'Times New Roman', serif; font-style: italic;">${escapeHtml(mathText)}</p>`;
            case 'mermaid':
                return `<pre class="mermaid">${escapeHtml(content)}</pre>`;
            default:
                return content ? `<p>${escapeHtml(content)}</p>` : '';
        }
    }

    /**
     * Export to Markdown (enhanced with frontmatter)
     */
    function exportToMarkdown(page) {
        let markdown = '---\n';
        markdown += `title: "${escapeYaml(page.title || 'Untitled')}"\n`;
        if (page.icon) markdown += `icon: "${page.icon}"\n`;
        markdown += `created: ${new Date(page.createdAt || Date.now()).toISOString()}\n`;
        markdown += `updated: ${new Date(page.updatedAt || Date.now()).toISOString()}\n`;
        if (page.properties && page.properties.length > 0) {
            markdown += 'properties:\n';
            page.properties.forEach(prop => {
                markdown += `  ${prop.key}: "${escapeYaml(prop.value)}"\n`;
            });
        }
        markdown += '---\n\n';

        if (page.icon) {
            markdown += `${page.icon} `;
        }
        markdown += `# ${page.title || 'Untitled'}\n\n`;

        // Process blocks
        page.blocks.forEach(block => {
            markdown += blockToMarkdown(block);
        });

        return markdown;
    }

    function escapeMarkdownText(text) {
        return String(text || '').replace(/\|/g, '\\|').trim();
    }

    /**
     * Convert block to Markdown
     */
    function blockToMarkdown(block, indent = '') {
        const content = getBlockText(block);
        let md = '';

        switch (block.type) {
            case 'heading_1':
                md = `${indent}# ${content}\n\n`;
                break;
            case 'heading_2':
                md = `${indent}## ${content}\n\n`;
                break;
            case 'heading_3':
                md = `${indent}### ${content}\n\n`;
                break;
            case 'bulleted_list':
                md = `${indent}- ${content}\n`;
                break;
            case 'numbered_list':
                md = `${indent}1. ${content}\n`;
                break;
            case 'todo':
                const todoData = typeof block.content === 'object' ? block.content : { text: content, checked: false };
                const checkbox = todoData.checked ? '[x]' : '[ ]';
                md = `${indent}- ${checkbox} ${todoData.text}\n`;
                break;
            case 'quote':
                md = `${indent}> ${content}\n\n`;
                break;
            case 'code':
                const codeData = typeof block.content === 'object' ? block.content : { text: content, language: 'plain' };
                md = `${indent}\`\`\`${codeData.language}\n${codeData.text}\n\`\`\`\n\n`;
                break;
            case 'divider':
                md = `${indent}---\n\n`;
                break;
            case 'callout':
                const icon = block.icon || '💡';
                md = `${indent}> ${icon} **Note:** ${content}\n\n`;
                break;
            case 'image':
                if (block.content) {
                    const src = getImageSource(block);
                    if (src) {
                        const alt = escapeMarkdownText(getImageAltText(block));
                        const caption = getImageCaption(block);
                        const subtext = getImageSubtext(block);
                        const link = getImageLink(block);
                        md = `${indent}![${alt}](${src})\n`;
                        if (caption) md += `${indent}_${escapeMarkdownText(caption)}_\n`;
                        if (subtext) md += `${indent}${escapeMarkdownText(subtext)}\n`;
                        if (link && link !== src) md += `${indent}[Image source](${link})\n`;
                        md += '\n';
                    }
                }
                break;
            case 'ai_image':
                if (block.content && getImageSource(block)) {
                    const src = getImageSource(block);
                    const alt = escapeMarkdownText(getImageAltText(block));
                    const caption = getImageCaption(block);
                    const subtext = getImageSubtext(block);
                    const link = getImageLink(block);
                    md = `${indent}![${alt}](${src})\n`;
                    if (caption) md += `${indent}_${escapeMarkdownText(caption)}_\n`;
                    if (subtext) md += `${indent}${escapeMarkdownText(subtext)}\n`;
                    if (link && link !== src) md += `${indent}[Image source](${link})\n`;
                    md += '\n';
                } else if (block.content && block.content.prompt) {
                    md = `${indent}[AI Image: ${block.content.prompt}]\n\n`;
                }
                break;
            case 'bookmark':
                if (block.content && block.content.url) {
                    md = `${indent}[${block.content.title || block.content.url}](${block.content.url})\n`;
                    if (block.content.description) {
                        md += `${indent}${escapeMarkdownText(block.content.description)}\n`;
                    }
                    if (block.content.image) {
                        md += `${indent}![${escapeMarkdownText(block.content.title || 'Bookmark image')}](${block.content.image})\n`;
                    }
                    md += '\n';
                }
                break;
            case 'database':
                if (block.content && block.content.columns) {
                    md += `${indent}| ${block.content.columns.join(' | ')} |\n`;
                    md += `${indent}| ${block.content.columns.map(() => '---').join(' | ')} |\n`;
                    (block.content.rows || []).forEach(row => {
                        md += `${indent}| ${row.join(' | ')} |\n`;
                    });
                    md += '\n';
                }
                break;
            case 'chart':
                if (block.content) {
                    const labels = Array.isArray(block.content.labels) ? block.content.labels : [];
                    const values = Array.isArray(block.content.values) ? block.content.values : [];
                    const unit = block.content.unit || '';
                    md += `${indent}**${escapeMarkdownText(block.content.title || 'Chart')}**\n\n`;
                    if (block.content.summary) {
                        md += `${indent}${escapeMarkdownText(block.content.summary)}\n\n`;
                    }
                    md += `${indent}| Label | Value |\n`;
                    md += `${indent}| --- | --- |\n`;
                    labels.forEach((label, index) => {
                        md += `${indent}| ${escapeMarkdownText(label)} | ${escapeMarkdownText(`${values[index] ?? ''}${unit}`)} |\n`;
                    });
                    md += '\n';
                }
                break;
            case 'math':
                const mathText = typeof block.content === 'object' ? block.content.text : content;
                md = `${indent}$$\n${mathText}\n$$\n\n`;
                break;
            case 'mermaid':
                md = `${indent}\`\`\`mermaid\n${content}\n\`\`\`\n\n`;
                break;
            default:
                md = content ? `${indent}${content}\n\n` : '';
        }

        // Handle children for nested structures
        if (block.children && block.children.length > 0) {
            block.children.forEach(child => {
                md += blockToMarkdown(child, indent + '  ');
            });
        }

        return md;
    }

    /**
     * Export to Lilly-compatible JSON
     */
    function exportToJSON(page) {
        const notionFormat = {
            object: 'page',
            id: page.id,
            created_time: new Date(page.createdAt || Date.now()).toISOString(),
            last_edited_time: new Date(page.updatedAt || Date.now()).toISOString(),
            icon: page.icon ? { type: 'emoji', emoji: page.icon } : null,
            cover: page.cover ? { type: 'external', external: { url: page.cover } } : null,
            properties: {
                title: {
                    title: [{ text: { content: page.title || 'Untitled' } }]
                }
            },
            children: page.blocks.map(blockToNotionBlock)
        };

        return JSON.stringify(notionFormat, null, 2);
    }

    /**
     * Convert block to Notion format
     */
    function blockToNotionBlock(block) {
        const base = {
            object: 'block',
            id: block.id,
            type: block.type
        };

        switch (block.type) {
            case 'heading_1':
            case 'heading_2':
            case 'heading_3':
                base[block.type] = {
                    rich_text: [{ text: { content: getBlockText(block) } }]
                };
                break;
            case 'text':
                base.paragraph = {
                    rich_text: [{ text: { content: getBlockText(block) } }]
                };
                base.type = 'paragraph';
                break;
            case 'bulleted_list':
                base.bulleted_list_item = {
                    rich_text: [{ text: { content: getBlockText(block) } }]
                };
                break;
            case 'numbered_list':
                base.numbered_list_item = {
                    rich_text: [{ text: { content: getBlockText(block) } }]
                };
                break;
            case 'todo':
                const todoData = typeof block.content === 'object' ? block.content : { text: getBlockText(block), checked: false };
                base.to_do = {
                    rich_text: [{ text: { content: todoData.text } }],
                    checked: todoData.checked
                };
                break;
            case 'quote':
                base.quote = {
                    rich_text: [{ text: { content: getBlockText(block) } }]
                };
                break;
            case 'code':
                const codeData = typeof block.content === 'object' ? block.content : { text: getBlockText(block), language: 'plain' };
                base.code = {
                    rich_text: [{ text: { content: codeData.text } }],
                    language: codeData.language
                };
                break;
            case 'divider':
                base.divider = {};
                break;
            case 'callout':
                base.callout = {
                    rich_text: [{ text: { content: getBlockText(block) } }],
                    icon: { type: 'emoji', emoji: block.icon || '💡' }
                };
                break;
            case 'image':
                if (block.content && block.content.url) {
                    base.image = {
                        type: block.content.url.startsWith('data:') ? 'file' : 'external',
                        external: block.content.url.startsWith('data:') ? undefined : { url: block.content.url },
                        caption: block.content.caption ? [{ text: { content: block.content.caption } }] : []
                    };
                }
                break;
            default:
                base.paragraph = {
                    rich_text: [{ text: { content: getBlockText(block) } }]
                };
                base.type = 'paragraph';
        }

        if (block.children && block.children.length > 0) {
            base.children = block.children.map(blockToNotionBlock);
        }

        return base;
    }

    /**
     * Export to plain text
     */
    function exportToTXT(page) {
        let text = '';
        
        if (page.icon) text += page.icon + ' ';
        text += (page.title || 'Untitled') + '\n';
        text += '='.repeat(page.title?.length || 10) + '\n\n';

        if (page.properties && page.properties.length > 0) {
            page.properties.forEach(prop => {
                text += `${prop.key}: ${prop.value}\n`;
            });
            text += '\n';
        }

        page.blocks.forEach(block => {
            text += blockToText(block) + '\n';
        });

        return text;
    }

    /**
     * Convert block to plain text
     */
    function blockToText(block, indent = '') {
        const content = getBlockText(block);
        let text = '';

        switch (block.type) {
            case 'heading_1':
                text = indent + content.toUpperCase() + '\n' + indent + '='.repeat(content.length);
                break;
            case 'heading_2':
                text = indent + content + '\n' + indent + '-'.repeat(content.length);
                break;
            case 'heading_3':
                text = indent + '### ' + content;
                break;
            case 'bulleted_list':
            case 'numbered_list':
                text = indent + '• ' + content;
                break;
            case 'todo':
                const todoData = typeof block.content === 'object' ? block.content : { text: content, checked: false };
                const checkbox = todoData.checked ? '[x]' : '[ ]';
                text = indent + checkbox + ' ' + todoData.text;
                break;
            case 'quote':
                text = indent + '> ' + content;
                break;
            case 'code':
                const codeData = typeof block.content === 'object' ? block.content : { text: content, language: 'plain' };
                text = indent + '---\n' + codeData.text.split('\n').map(l => indent + l).join('\n') + '\n' + indent + '---';
                break;
            case 'divider':
                text = indent + '─'.repeat(40);
                break;
            case 'callout':
                const icon = block.icon || '💡';
                text = indent + '[' + icon + '] ' + content;
                break;
            case 'image':
                if (block.content) {
                    const caption = getImageCaption(block);
                    const subtext = getImageSubtext(block);
                    const link = getImageLink(block) || getImageSource(block);
                    text = indent + '[Image' + (caption ? ': ' + caption : '') + ']';
                    if (subtext) text += '\n' + indent + subtext;
                    if (link) text += '\n' + indent + 'Source: ' + link;
                }
                break;
            case 'ai_image':
                if (block.content) {
                    const caption = getImageCaption(block);
                    const subtext = getImageSubtext(block);
                    const link = getImageLink(block) || getImageSource(block);
                    text = indent + '[AI Image' + (caption ? ': ' + caption : '') + ']';
                    if (subtext) text += '\n' + indent + subtext;
                    if (link) text += '\n' + indent + 'Source: ' + link;
                }
                break;
            case 'bookmark':
                if (block.content && block.content.url) {
                    text = indent + (block.content.title || block.content.url);
                    if (block.content.description) text += '\n' + indent + block.content.description;
                    text += '\n' + indent + block.content.url;
                }
                break;
            case 'database':
                if (block.content && block.content.columns) {
                    const rows = [block.content.columns, ...(block.content.rows || [])];
                    text = rows.map(row => indent + row.join(' | ')).join('\n');
                }
                break;
            case 'chart':
                if (block.content) {
                    const labels = Array.isArray(block.content.labels) ? block.content.labels : [];
                    const values = Array.isArray(block.content.values) ? block.content.values : [];
                    const unit = block.content.unit || '';
                    text = indent + (block.content.title || 'Chart');
                    if (block.content.summary) text += '\n' + indent + block.content.summary;
                    labels.forEach((label, index) => {
                        text += '\n' + indent + '- ' + label + ': ' + ((values[index] ?? '') + unit);
                    });
                }
                break;
            default:
                text = indent + content;
        }

        // Handle children
        if (block.children && block.children.length > 0) {
            const childText = block.children.map(child => blockToText(child, indent + '  ')).join('\n');
            if (childText) text += '\n' + childText;
        }

        return text;
    }

    /**
     * Import from various formats
     */
    async function importFile(file, format) {
        if (!file) {
            throw new Error('No file provided for import');
        }

        // Auto-detect format if not specified
        if (!format) {
            const ext = file.name.split('.').pop().toLowerCase();
            format = ext;
        }

        const content = await readFile(file);

        switch (format) {
            case 'docx':
                return await importFromDOCX(content);
            case 'pdf':
                return await importFromPDF(content);
            case 'html':
                return importFromHTML(content);
            case 'md':
            case 'markdown':
                return importFromMarkdown(content);
            case 'json':
                return importFromJSON(content);
            case 'txt':
            case 'text':
                return importFromTXT(content);
            default:
                throw new Error(`Unsupported import format: ${format}`);
        }
    }

    /**
     * Read file content
     */
    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            
            if (file.name.endsWith('.docx') || file.name.endsWith('.pdf')) {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsText(file);
            }
        });
    }

    /**
     * Import from DOCX using mammoth.js
     */
    async function importFromDOCX(arrayBuffer) {
        if (typeof mammoth === 'undefined') {
            throw new Error('mammoth.js library not loaded');
        }

        const result = await mammoth.convertToHtml({ arrayBuffer });
        const html = result.value;
        
        // Convert HTML to blocks
        return importFromHTML(html);
    }

    /**
     * Import from PDF with enhanced support for mixed content
     * Uses PDFImport module for better text and image extraction
     */
    async function importFromPDF(arrayBuffer, options = {}) {
        // Try to use the enhanced PDFImport module if available
        if (typeof PDFImport !== 'undefined') {
            try {
                // Initialize PDFImport if needed
                if (!PDFImport.initialize || !PDFImport.initialize()) {
                    await PDFImport.loadPDFJS();
                }

                // Show progress UI if available
                const showProgress = options.showProgress !== false;
                let progressCallback = null;

                if (showProgress && typeof showPDFImportProgress === 'function') {
                    progressCallback = showPDFImportProgress;
                }

                // Import with enhanced functionality
                const page = await PDFImport.importPDF(arrayBuffer, options, progressCallback);
                
                // Store metadata for UI feedback
                if (page.metadata) {
                    window.lastPDFImportMetadata = page.metadata;
                }

                return page;
            } catch (error) {
                console.warn('Enhanced PDF import failed, falling back to basic:', error);
                // Fall through to basic implementation
            }
        }

        // Fallback to basic PDF.js implementation
        return importFromPDFBasic(arrayBuffer, options);
    }

    /**
     * Basic PDF import fallback using PDF.js directly
     */
    async function importFromPDFBasic(arrayBuffer, options = {}) {
        // Check for PDF.js
        let pdfjsLib = window.pdfjsLib;
        
        if (!pdfjsLib) {
            // Last resort: try simple byte extraction
            const text = extractTextFromPDFBytes(arrayBuffer);
            return importFromTXT(text);
        }

        // Set worker source if needed
        if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }

        try {
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            let fullText = '';

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + '\n\n';
                page.cleanup();
            }

            return importFromTXT(fullText);
        } catch (error) {
            console.warn('PDF.js basic import failed:', error);
            const text = extractTextFromPDFBytes(arrayBuffer);
            return importFromTXT(text);
        }
    }

    /**
     * Preview PDF before import
     * @param {ArrayBuffer} arrayBuffer - PDF file data
     * @param {Object} options - Preview options
     * @returns {Promise<Object>} - Preview data
     */
    async function previewPDF(arrayBuffer, options = {}) {
        if (typeof PDFImport !== 'undefined') {
            try {
                if (!PDFImport.initialize || !PDFImport.initialize()) {
                    await PDFImport.loadPDFJS();
                }
                return await PDFImport.previewPDF(arrayBuffer, options.maxPages || 5);
            } catch (error) {
                console.error('PDF preview failed:', error);
                throw error;
            }
        }
        throw new Error('PDF import module not available');
    }

    /**
     * Detect if PDF is scanned/image-based
     * @param {ArrayBuffer} arrayBuffer - PDF file data
     * @returns {Promise<Object>} - Detection result
     */
    async function detectScannedPDF(arrayBuffer) {
        if (typeof PDFImport !== 'undefined') {
            try {
                if (!PDFImport.initialize || !PDFImport.initialize()) {
                    await PDFImport.loadPDFJS();
                }
                return await PDFImport.detectScannedPDF(arrayBuffer);
            } catch (error) {
                console.error('PDF scan detection failed:', error);
                return { isScanned: false, hasText: true, confidence: 0 };
            }
        }
        return { isScanned: false, hasText: true, confidence: 0 };
    }

    /**
     * Simple PDF text extraction fallback (last resort)
     */
    function extractTextFromPDFBytes(arrayBuffer) {
        // This is a very basic PDF text extractor
        // It looks for text streams in the PDF
        const uint8Array = new Uint8Array(arrayBuffer);
        let text = '';
        let inText = false;
        let buffer = '';

        for (let i = 0; i < uint8Array.length; i++) {
            const byte = uint8Array[i];
            const char = String.fromCharCode(byte);

            if (char === '(') {
                inText = true;
                buffer = '';
            } else if (char === ')' && inText) {
                inText = false;
                text += buffer;
            } else if (inText) {
                // Handle escaped characters
                if (byte === 92) { // backslash
                    i++;
                    if (i < uint8Array.length) {
                        buffer += String.fromCharCode(uint8Array[i]);
                    }
                } else if (byte >= 32 && byte < 127) {
                    buffer += char;
                }
            }
        }

        // If we couldn't extract text, return a message
        if (!text.trim()) {
            return '[PDF content could not be extracted. The PDF may be scanned or image-based.]';
        }

        return text;
    }

    /**
     * Import from HTML
     */
    function importFromHTML(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const page = {
            title: '',
            icon: '',
            blocks: []
        };

        // Try to extract title
        const h1 = doc.querySelector('h1');
        if (h1) {
            page.title = h1.textContent.trim();
        } else {
            const title = doc.querySelector('title');
            if (title) page.title = title.textContent.trim();
        }

        // Process body content
        const body = doc.body;
        if (body) {
            processHTMLElement(body, page.blocks, { inList: false });
        }

        // If no blocks, create a text block with the body text
        if (page.blocks.length === 0 && body) {
            const text = body.textContent.trim();
            if (text) {
                page.blocks.push(Blocks.createBlock('text', text));
            }
        }

        // Ensure at least one block
        if (page.blocks.length === 0) {
            page.blocks.push(Blocks.createBlock('text', ''));
        }

        return page;
    }

    /**
     * Process HTML element recursively
     */
    function processHTMLElement(element, blocks, context) {
        const children = Array.from(element.childNodes);
        
        children.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent.trim();
                if (text && !context.inList) {
                    blocks.push(Blocks.createBlock('text', text));
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                
                switch (tag) {
                    case 'h1':
                        blocks.push(Blocks.createBlock('heading_1', node.textContent.trim()));
                        break;
                    case 'h2':
                        blocks.push(Blocks.createBlock('heading_2', node.textContent.trim()));
                        break;
                    case 'h3':
                    case 'h4':
                    case 'h5':
                    case 'h6':
                        blocks.push(Blocks.createBlock('heading_3', node.textContent.trim()));
                        break;
                    case 'p':
                        const pText = node.textContent.trim();
                        if (pText) {
                            blocks.push(Blocks.createBlock('text', pText));
                        }
                        break;
                    case 'ul':
                        processListItems(node, blocks, 'bulleted_list');
                        break;
                    case 'ol':
                        processListItems(node, blocks, 'numbered_list');
                        break;
                    case 'blockquote':
                        blocks.push(Blocks.createBlock('quote', node.textContent.trim()));
                        break;
                    case 'pre':
                        const code = node.querySelector('code');
                        const language = code ? detectLanguage(code.className) : 'plain';
                        const codeText = code ? code.textContent : node.textContent;
                        blocks.push(Blocks.createBlock('code', { text: codeText, language }));
                        break;
                    case 'code':
                        // Inline code, treat as text
                        break;
                    case 'hr':
                        blocks.push(Blocks.createBlock('divider', ''));
                        break;
                    case 'img':
                        const src = node.getAttribute('src') || '';
                        const alt = node.getAttribute('alt') || '';
                        blocks.push(Blocks.createBlock('image', { url: src, caption: alt }));
                        break;
                    case 'a':
                        const href = node.getAttribute('href') || '';
                        const linkText = node.textContent.trim();
                        if (href && !blocks.find(b => b.type === 'bookmark' && b.content?.url === href)) {
                            // Check if it looks like a bookmark
                            if (node.querySelector('img') || linkText.length > 50) {
                                blocks.push(Blocks.createBlock('bookmark', { 
                                    url: href, 
                                    title: linkText,
                                    description: ''
                                }));
                            }
                        }
                        break;
                    case 'table':
                        const tableData = processTable(node);
                        if (tableData) {
                            blocks.push(Blocks.createBlock('database', tableData));
                        }
                        break;
                    case 'br':
                        // Ignore line breaks
                        break;
                    case 'div':
                    case 'section':
                    case 'article':
                    case 'main':
                        // Recursively process container elements
                        processHTMLElement(node, blocks, context);
                        break;
                    default:
                        // For other elements, just extract text
                        const text = node.textContent.trim();
                        if (text) {
                            blocks.push(Blocks.createBlock('text', text));
                        }
                }
            }
        });
    }

    /**
     * Process list items
     */
    function processListItems(listElement, blocks, listType) {
        const items = listElement.querySelectorAll(':scope > li');
        items.forEach(item => {
            const text = item.textContent.trim();
            if (text) {
                blocks.push(Blocks.createBlock(listType, text));
            }
        });
    }

    /**
     * Process HTML table
     */
    function processTable(table) {
        const headers = [];
        const rows = [];

        // Get headers
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (headerRow) {
            headerRow.querySelectorAll('th, td').forEach(cell => {
                headers.push(cell.textContent.trim());
            });
        }

        // Get rows
        const dataRows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
        dataRows.forEach(row => {
            const rowData = [];
            row.querySelectorAll('td, th').forEach(cell => {
                rowData.push(cell.textContent.trim());
            });
            if (rowData.length > 0) {
                rows.push(rowData);
            }
        });

        if (headers.length === 0 && rows.length > 0) {
            // Generate headers
            for (let i = 0; i < rows[0].length; i++) {
                headers.push(`Column ${i + 1}`);
            }
        }

        return headers.length > 0 ? { columns: headers, rows } : null;
    }

    /**
     * Detect programming language from class name
     */
    function detectLanguage(className) {
        if (!className) return 'plain';
        const langMap = {
            'javascript': 'javascript', 'js': 'javascript',
            'typescript': 'typescript', 'ts': 'typescript',
            'python': 'python', 'py': 'python',
            'java': 'java',
            'html': 'html',
            'css': 'css',
            'json': 'json',
            'sql': 'sql',
            'bash': 'bash', 'sh': 'bash',
            'markdown': 'markdown', 'md': 'markdown',
            'cpp': 'cpp', 'c++': 'cpp',
            'rust': 'rust', 'rs': 'rust',
            'go': 'go', 'golang': 'go',
            'ruby': 'ruby', 'rb': 'ruby',
            'php': 'php',
            'swift': 'swift',
            'kotlin': 'kotlin'
        };
        
        const classes = className.split(' ');
        for (const cls of classes) {
            const lang = cls.replace('language-', '').toLowerCase();
            if (langMap[lang]) return langMap[lang];
        }
        return 'plain';
    }

    function parseMarkdownImageDestination(destination = '') {
        let value = String(destination || '').trim();
        if (!value) {
            return { url: '', title: '' };
        }

        if (/^<[^>]+>$/.test(value)) {
            value = value.slice(1, -1).trim();
        }

        let title = '';
        const titleMatch = value.match(/\s+(["'])(.*?)\1\s*$/);
        if (titleMatch) {
            title = titleMatch[2].trim();
            value = value.slice(0, titleMatch.index).trim();
        }

        return {
            url: value,
            title
        };
    }

    function buildBlockFromMarkdownImage(altText = '', destination = '') {
        const { url, title } = parseMarkdownImageDestination(destination);
        if (!/^https?:\/\//i.test(url)) {
            return null;
        }

        const normalizedAlt = String(altText || '').trim();
        const normalizedTitle = String(title || '').trim();
        const isExplicitAIImage = /^ai(?:\s+image)?:\s*/i.test(normalizedAlt);
        const promptText = normalizedAlt.replace(/^ai(?:\s+image)?:\s*/i, '').trim();
        const caption = promptText || normalizedAlt || normalizedTitle;
        let hostname = '';

        try {
            hostname = new URL(url).hostname;
        } catch (_error) {
            hostname = '';
        }

        if (isExplicitAIImage || /(?:^|\.)unsplash\.com$/i.test(hostname)) {
            return Blocks.createBlock('ai_image', {
                prompt: caption || (isExplicitAIImage ? 'AI image' : 'Unsplash image'),
                caption: normalizedTitle || caption || '',
                imageUrl: url,
                model: null,
                size: isExplicitAIImage ? 'auto' : '1536x1024',
                quality: isExplicitAIImage ? 'auto' : null,
                style: null,
                source: isExplicitAIImage ? 'ai' : 'unsplash',
                status: 'done',
                unsplashResults: null,
                selectedUnsplashId: null,
                unsplashPhotographer: null,
                unsplashPhotographerUrl: null,
                imageAssetId: null
            });
        }

        return Blocks.createBlock('image', {
            url,
            caption: normalizedAlt || normalizedTitle || ''
        });
    }

    function extractMarkdownImageBlocksFromLine(line = '') {
        const source = String(line || '').trim();
        if (!source.startsWith('![')) {
            return [];
        }

        const matches = [...source.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
        if (matches.length === 0) {
            return [];
        }

        let cursor = 0;
        const blocks = [];

        for (const match of matches) {
            if (source.slice(cursor, match.index).trim()) {
                return [];
            }

            const block = buildBlockFromMarkdownImage(match[1], match[2]);
            if (!block) {
                return [];
            }

            blocks.push(block);
            cursor = match.index + match[0].length;
        }

        if (source.slice(cursor).trim()) {
            return [];
        }

        return blocks;
    }

    /**
     * Import from Markdown
     */
    function importFromMarkdown(markdown) {
        const page = {
            title: '',
            icon: '',
            blocks: []
        };

        // Parse frontmatter
        let content = markdown;
        const frontmatterMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            content = frontmatterMatch[2];
            
            // Parse frontmatter properties
            const titleMatch = frontmatter.match(/title:\s*["']?(.+?)["']?\s*$/m);
            if (titleMatch) page.title = titleMatch[1].trim();
            
            const iconMatch = frontmatter.match(/icon:\s*["']?(.+?)["']?\s*$/m);
            if (iconMatch) page.icon = iconMatch[1].trim();
        }

        // Parse markdown blocks
        const lines = content.split('\n');
        let codeBlock = null;
        let inCodeBlock = false;
        let codeLanguage = 'plain';

        lines.forEach(line => {
            // Code blocks
            if (line.startsWith('```')) {
                if (inCodeBlock) {
                    // End code block
                    if (/^mermaid$/i.test(codeLanguage)) {
                        page.blocks.push(Blocks.createBlock('mermaid', {
                            text: codeBlock,
                            diagramType: detectMermaidDiagramType(codeBlock)
                        }));
                    } else {
                        page.blocks.push(Blocks.createBlock('code', { 
                            text: codeBlock, 
                            language: codeLanguage 
                        }));
                    }
                    codeBlock = null;
                    inCodeBlock = false;
                } else {
                    // Start code block
                    codeLanguage = line.slice(3).trim() || 'plain';
                    codeBlock = '';
                    inCodeBlock = true;
                }
                return;
            }

            if (inCodeBlock) {
                codeBlock += (codeBlock ? '\n' : '') + line;
                return;
            }

            const markdownImageBlocks = extractMarkdownImageBlocksFromLine(line);
            if (markdownImageBlocks.length > 0) {
                page.blocks.push(...markdownImageBlocks);
                return;
            }

            // Headings
            if (line.startsWith('# ')) {
                page.blocks.push(Blocks.createBlock('heading_1', line.slice(2).trim()));
                return;
            }
            if (line.startsWith('## ')) {
                page.blocks.push(Blocks.createBlock('heading_2', line.slice(3).trim()));
                return;
            }
            if (line.startsWith('### ')) {
                page.blocks.push(Blocks.createBlock('heading_3', line.slice(4).trim()));
                return;
            }

            // Divider
            if (line.match(/^---+$/)) {
                page.blocks.push(Blocks.createBlock('divider', ''));
                return;
            }

            // To-do
            const todoMatch = line.match(/^[\s]*-\s*\[([ x])\]\s*(.+)$/i);
            if (todoMatch) {
                page.blocks.push(Blocks.createBlock('todo', {
                    text: todoMatch[2].trim(),
                    checked: todoMatch[1].toLowerCase() === 'x'
                }));
                return;
            }

            // Bulleted list
            if (line.match(/^[\s]*[-*]\s+(.+)$/)) {
                const match = line.match(/^[\s]*[-*]\s+(.+)$/);
                page.blocks.push(Blocks.createBlock('bulleted_list', match[1].trim()));
                return;
            }

            // Numbered list
            if (line.match(/^[\s]*\d+\.\s+(.+)$/)) {
                const match = line.match(/^[\s]*\d+\.\s+(.+)$/);
                page.blocks.push(Blocks.createBlock('numbered_list', match[1].trim()));
                return;
            }

            // Quote
            if (line.startsWith('> ')) {
                page.blocks.push(Blocks.createBlock('quote', line.slice(2).trim()));
                return;
            }

            // Empty lines
            if (!line.trim()) {
                return;
            }

            // Default to text
            page.blocks.push(Blocks.createBlock('text', line.trim()));
        });

        // Handle pending code block
        if (inCodeBlock && codeBlock !== null) {
            if (/^mermaid$/i.test(codeLanguage)) {
                page.blocks.push(Blocks.createBlock('mermaid', {
                    text: codeBlock,
                    diagramType: detectMermaidDiagramType(codeBlock)
                }));
            } else {
                page.blocks.push(Blocks.createBlock('code', { 
                    text: codeBlock, 
                    language: codeLanguage 
                }));
            }
        }

        // Extract title from first heading if not set
        if (!page.title) {
            const firstHeading = page.blocks.find(b => b.type === 'heading_1');
            if (firstHeading) {
                page.title = getBlockText(firstHeading);
                // Remove the heading from blocks since it's now the title
                const index = page.blocks.indexOf(firstHeading);
                if (index > -1) page.blocks.splice(index, 1);
            }
        }

        // Ensure at least one block
        if (page.blocks.length === 0) {
            page.blocks.push(Blocks.createBlock('text', ''));
        }

        return page;
    }

    /**
     * Import from Lilly JSON
     */
    function importFromJSON(json) {
        let data;
        try {
            data = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (e) {
            throw new Error('Invalid JSON format');
        }

        const page = {
            title: '',
            icon: '',
            blocks: []
        };

        // Handle page-oriented JSON format
        if (data.object === 'page' || data.object === 'database') {
            // Extract title
            if (data.properties?.title?.title) {
                page.title = data.properties.title.title.map(t => t.text?.content || t.plain_text || '').join('');
            } else if (data.title) {
                page.title = Array.isArray(data.title) 
                    ? data.title.map(t => t.text?.content || t.plain_text || '').join('')
                    : data.title;
            }

            // Extract icon
            if (data.icon?.emoji) {
                page.icon = data.icon.emoji;
            }

            // Process children/blocks
            const children = data.children || data.results || [];
            children.forEach(child => {
                const block = notionBlockToBlock(child);
                if (block) page.blocks.push(block);
            });
        } else if (data.blocks && Array.isArray(data.blocks)) {
            // Our native format
            page.title = data.title || '';
            page.icon = data.icon || '';
            page.blocks = Storage.cloneBlocksWithFreshIds(data.blocks);
        } else if (Array.isArray(data)) {
            // Array of pages
            throw new Error('Array format not supported. Please import a single page.');
        }

        if (page.blocks.length === 0) {
            page.blocks.push(Blocks.createBlock('text', ''));
        }

        return page;
    }

    /**
     * Convert Notion block to our block format
     */
    function notionBlockToBlock(notionBlock) {
        const type = notionBlock.type;
        const content = notionBlock[type];

        if (!content) return null;

        const text = extractRichText(content.rich_text || content.text);

        switch (type) {
            case 'paragraph':
                return Blocks.createBlock('text', text);
            case 'heading_1':
                return Blocks.createBlock('heading_1', text);
            case 'heading_2':
                return Blocks.createBlock('heading_2', text);
            case 'heading_3':
                return Blocks.createBlock('heading_3', text);
            case 'bulleted_list_item':
                return Blocks.createBlock('bulleted_list', text);
            case 'numbered_list_item':
                return Blocks.createBlock('numbered_list', text);
            case 'to_do':
                return Blocks.createBlock('todo', { text, checked: content.checked || false });
            case 'quote':
                return Blocks.createBlock('quote', text);
            case 'code':
                return Blocks.createBlock('code', { text, language: content.language || 'plain' });
            case 'divider':
                return Blocks.createBlock('divider', '');
            case 'callout':
                const block = Blocks.createBlock('callout', text);
                if (content.icon?.emoji) block.icon = content.icon.emoji;
                return block;
            case 'image':
                const imageUrl = content.external?.url || content.file?.url || '';
                const caption = extractRichText(content.caption);
                return Blocks.createBlock('image', { url: imageUrl, caption });
            default:
                return Blocks.createBlock('text', text);
        }
    }

    /**
     * Extract text from Notion rich text format
     */
    function extractRichText(richText) {
        if (!richText) return '';
        if (typeof richText === 'string') return richText;
        if (Array.isArray(richText)) {
            return richText.map(t => t.text?.content || t.plain_text || '').join('');
        }
        return '';
    }

    /**
     * Import from plain text
     */
    function importFromTXT(text) {
        const page = {
            title: '',
            icon: '',
            blocks: []
        };

        // Try to extract title from first line
        const lines = text.split('\n');
        
        // Check for title underlines (=== or ---)
        if (lines.length >= 2 && lines[1].match(/^=+$/)) {
            page.title = lines[0].trim();
            lines.splice(0, 2);
        } else if (lines.length >= 2 && lines[1].match(/^-+$/)) {
            page.blocks.push(Blocks.createBlock('heading_2', lines[0].trim()));
            lines.splice(0, 2);
        } else {
            page.title = lines[0].trim();
            lines.shift();
        }

        // Process remaining lines into paragraphs
        let currentParagraph = '';
        
        lines.forEach(line => {
            const trimmed = line.trim();
            
            // Empty line indicates paragraph break
            if (!trimmed) {
                if (currentParagraph.trim()) {
                    page.blocks.push(Blocks.createBlock('text', currentParagraph.trim()));
                    currentParagraph = '';
                }
                return;
            }

            // Check for bullets
            if (line.match(/^[\s]*[•\-\*]\s*/)) {
                if (currentParagraph.trim()) {
                    page.blocks.push(Blocks.createBlock('text', currentParagraph.trim()));
                    currentParagraph = '';
                }
                page.blocks.push(Blocks.createBlock('bulleted_list', trimmed.replace(/^[•\-\*]\s*/, '')));
                return;
            }

            // Check for numbered items
            if (line.match(/^[\s]*\d+[\.\)]\s*/)) {
                if (currentParagraph.trim()) {
                    page.blocks.push(Blocks.createBlock('text', currentParagraph.trim()));
                    currentParagraph = '';
                }
                page.blocks.push(Blocks.createBlock('numbered_list', trimmed.replace(/^\d+[\.\)]\s*/, '')));
                return;
            }

            // Check for todos
            const todoMatch = line.match(/^[\s]*[\[\(]?([ x])[\]\)]?\s*/i);
            if (todoMatch) {
                if (currentParagraph.trim()) {
                    page.blocks.push(Blocks.createBlock('text', currentParagraph.trim()));
                    currentParagraph = '';
                }
                page.blocks.push(Blocks.createBlock('todo', {
                    text: trimmed.replace(/^[\[\(]?[ x][\]\)]?\s*/i, ''),
                    checked: todoMatch[1].toLowerCase() === 'x'
                }));
                return;
            }

            currentParagraph += (currentParagraph ? ' ' : '') + trimmed;
        });

        // Don't forget the last paragraph
        if (currentParagraph.trim()) {
            page.blocks.push(Blocks.createBlock('text', currentParagraph.trim()));
        }

        if (page.blocks.length === 0) {
            page.blocks.push(Blocks.createBlock('text', ''));
        }

        return page;
    }

    /**
     * Get text content from a block
     */
    function getBlockText(block) {
        if (!block) return '';
        
        if (typeof block.content === 'string') {
            return block.content;
        }
        
        if (typeof block.content === 'object' && block.content !== null) {
            return block.content.text
                || block.content.prompt
                || block.content.caption
                || block.content.title
                || block.content.description
                || block.content.subtext
                || block.content.subtitle
                || '';
        }
        
        return '';
    }

    function detectMermaidDiagramType(text) {
        const normalized = String(text || '').trim().toLowerCase();
        if (normalized.startsWith('sequencediagram')) return 'sequence';
        if (normalized.startsWith('classdiagram')) return 'class';
        if (normalized.startsWith('statediagram')) return 'state';
        if (normalized.startsWith('erdiagram')) return 'er';
        if (normalized.startsWith('gantt')) return 'gantt';
        if (normalized.startsWith('pie')) return 'pie';
        if (normalized.startsWith('mindmap')) return 'mindmap';
        if (normalized.startsWith('gitgraph')) return 'gitgraph';
        return 'flowchart';
    }

    /**
     * Escape HTML special characters
     */
    function escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Escape YAML special characters
     */
    function escapeYaml(text) {
        if (!text) return '';
        return text.replace(/"/g, '\\"');
    }

    /**
     * Download exported content as file
     */
    function download(content, filename, mimeType) {
        const blob = content instanceof Blob 
            ? content 
            : new Blob([content], { type: mimeType });
        
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
     * Get supported formats
     */
    function getFormats() {
        return FORMATS;
    }

    /**
     * Check if a format is supported
     */
    function isFormatSupported(format, type = 'export') {
        return format in FORMATS[type];
    }

    // Public API
    return {
        exportPage,
        importFile,
        download,
        openPrintFriendlyFallback,
        getFormats,
        isFormatSupported,
        // Individual export functions for direct use
        exportToDOCX,
        exportToPDF,
        exportToHTML,
        exportToMarkdown,
        exportToJSON,
        exportToTXT,
        // Individual import functions for direct use
        importFromDOCX,
        importFromPDF,
        importFromHTML,
        importFromMarkdown,
        importFromJSON,
        importFromTXT,
        // Enhanced PDF functions
        previewPDF,
        detectScannedPDF
    };
})();

// Expose to window
window.ImportExport = ImportExport;
