/**
 * Import/Export Module - Business File Format Support
 * Handles: PDF, SVG, PNG, JPEG, HTML, PPTX, JSON, CSV, Excel, MindMap, Draw.io
 */

class ImportExportManager {
    constructor() {
        this.exportOptions = {
            padding: 20,
            transparent: false,
            quality: 0.9,
            scale: 2,
            backgroundColor: null
        };
        this.importBatchSize = 50;
        this.supportedImportFormats = {
            'image': ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/gif', 'image/webp'],
            'data': ['application/json', 'text/json'],
            'spreadsheet': ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
            'pdf': ['application/pdf'],
            'mindmap': ['application/x-freemind', 'text/x-opml+xml', 'application/x-opml'],
            'diagram': ['application/xml', 'text/xml']
        };
    }

    // ==================== EXPORT METHODS ====================

    /**
     * Export canvas to multiple formats
     */
    async export(format, options = {}) {
        const canvas = window.infiniteCanvas;
        if (!canvas || canvas.elements.length === 0) {
            window.app?.showToast('Canvas is empty');
            return;
        }

        const mergedOptions = { ...this.exportOptions, ...options };
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `canvas-${timestamp}`;

        window.app?.showLoading(`Exporting to ${format.toUpperCase()}...`);

        try {
            switch (format) {
                case 'png':
                    await this.exportPNG(filename, mergedOptions);
                    break;
                case 'jpeg':
                    await this.exportJPEG(filename, mergedOptions);
                    break;
                case 'svg':
                    await this.exportSVG(filename, mergedOptions);
                    break;
                case 'pdf':
                    await this.exportPDF(filename, mergedOptions);
                    break;
                case 'html':
                    await this.exportHTML(filename, mergedOptions);
                    break;
                case 'pptx':
                    await this.exportPPTX(filename, mergedOptions);
                    break;
                case 'json':
                    await this.exportJSON(filename, mergedOptions);
                    break;
                default:
                    throw new Error(`Unsupported export format: ${format}`);
            }
            window.app?.showToast(`Exported to ${format.toUpperCase()}`);
        } catch (error) {
            console.error('Export error:', error);
            window.app?.showToast(`Export failed: ${error.message}`);
        } finally {
            window.app?.hideLoading();
        }
    }

    /**
     * Export as PNG with advanced options
     */
    async exportPNG(filename, options) {
        const dataURL = this.generateImageDataURL('image/png', options);
        this.downloadFile(dataURL, `${filename}.png`);
    }

    /**
     * Export as JPEG with quality settings
     */
    async exportJPEG(filename, options) {
        const jpegOptions = { ...options, transparent: false };
        const dataURL = this.generateImageDataURL('image/jpeg', jpegOptions, options.quality);
        this.downloadFile(dataURL, `${filename}.jpg`);
    }

    /**
     * Export as SVG
     */
    async exportSVG(filename, options) {
        const svgData = this.generateSVG(options);
        const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        this.downloadFile(url, `${filename}.svg`);
    }

    /**
     * Export as multi-page PDF
     */
    async exportPDF(filename, options) {
        // Wait for library to be available
        if (typeof window.jspdf === 'undefined') {
            const loaded = await this.waitForLibrary(() => typeof window.jspdf !== 'undefined', 3000);
            if (!loaded) {
                await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
            }
        }

        const { jsPDF } = window.jspdf;
        const canvas = window.infiniteCanvas;
        const bounds = canvas.getBounds();
        
        // Page size (A4 in points: 595.28 x 841.89)
        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 40;
        
        // Calculate scale to fit content
        const contentWidth = pageWidth - margin * 2;
        const contentHeight = pageHeight - margin * 2;
        
        // Determine if we need multiple pages
        const scaleX = contentWidth / bounds.width;
        const scaleY = contentHeight / bounds.height;
        const scale = Math.min(scaleX, scaleY, 1);
        
        // Calculate pages needed
        const scaledWidth = bounds.width * scale;
        const scaledHeight = bounds.height * scale;
        const cols = Math.ceil(scaledWidth / contentWidth);
        const rows = Math.ceil(scaledHeight / contentHeight);
        const totalPages = cols * rows;
        
        const pdf = new jsPDF({
            orientation: scaledWidth > scaledHeight ? 'landscape' : 'portrait',
            unit: 'pt',
            format: 'a4'
        });

        // Export canvas as image for each page
        const exportCanvas = document.createElement('canvas');
        const ctx = exportCanvas.getContext('2d');
        
        // High resolution export
        const exportScale = Math.max(2, options.scale || 2);
        const tileWidth = bounds.width / cols;
        const tileHeight = bounds.height / rows;
        
        exportCanvas.width = tileWidth * exportScale;
        exportCanvas.height = tileHeight * exportScale;

        let currentPage = 0;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                currentPage++;
                
                // Update progress
                const progress = Math.round((currentPage / totalPages) * 100);
                window.app?.updateExportProgress?.(progress, `Page ${currentPage} of ${totalPages}`);
                
                if (row > 0 || col > 0) {
                    pdf.addPage();
                }

                // Clear canvas
                ctx.fillStyle = options.transparent ? 'transparent' : (options.backgroundColor || '#ffffff');
                ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

                // Calculate tile bounds
                const tileX = bounds.x + col * tileWidth;
                const tileY = bounds.y + row * tileHeight;

                // Render elements in this tile
                ctx.save();
                ctx.scale(exportScale, exportScale);
                ctx.translate(-tileX, -tileY);

                for (const element of canvas.elements) {
                    // Check if element is in this tile
                    const elBounds = this.getElementBounds(element);
                    if (elBounds.x + elBounds.width >= tileX && 
                        elBounds.x <= tileX + tileWidth &&
                        elBounds.y + elBounds.height >= tileY &&
                        elBounds.y <= tileY + tileHeight) {
                        window.renderer?.drawElement(ctx, element);
                    }
                }

                ctx.restore();

                // Add to PDF
                const imgData = exportCanvas.toDataURL('image/png');
                const imgWidth = Math.min(tileWidth * scale, contentWidth);
                const imgHeight = Math.min(tileHeight * scale, contentHeight);
                
                pdf.addImage(imgData, 'PNG', margin, margin, imgWidth, imgHeight);
            }
        }

        // Final progress update
        window.app?.updateExportProgress?.(100, 'Finalizing...');
        
        pdf.save(`${filename}.pdf`);
    }

    /**
     * Export as interactive HTML presentation
     */
    async exportHTML(filename, options) {
        const canvas = window.infiniteCanvas;
        const svgData = this.generateSVG({ ...options, transparent: false });
        const elements = JSON.stringify(canvas.elements);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lilly Canvas Export</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: ${options.backgroundColor || '#f8f9fa'};
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .toolbar {
            background: #fff;
            border-bottom: 1px solid #e0e0e0;
            padding: 12px 20px;
            display: flex;
            gap: 12px;
            align-items: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .toolbar h1 {
            font-size: 16px;
            font-weight: 600;
            margin-right: auto;
        }
        .toolbar button {
            padding: 8px 16px;
            border: 1px solid #e0e0e0;
            background: #fff;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        }
        .toolbar button:hover {
            background: #f5f5f5;
            border-color: #a8a5ff;
        }
        .toolbar button.primary {
            background: #a8a5ff;
            color: white;
            border-color: #a8a5ff;
        }
        .toolbar button.primary:hover {
            background: #9693e8;
        }
        .canvas-container {
            flex: 1;
            overflow: auto;
            padding: 40px;
            display: flex;
            justify-content: center;
            align-items: flex-start;
        }
        .canvas-wrapper {
            background: white;
            box-shadow: 0 4px 24px rgba(0,0,0,0.15);
            border-radius: 8px;
            padding: 20px;
        }
        .canvas-wrapper svg {
            max-width: 100%;
            height: auto;
        }
        .info-panel {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: white;
            padding: 16px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-size: 13px;
            max-width: 280px;
        }
        .info-panel h3 {
            font-size: 14px;
            margin-bottom: 8px;
            color: #333;
        }
        .info-panel p {
            color: #666;
            line-height: 1.5;
        }
        .element-count {
            display: inline-block;
            background: #a8a5ff;
            color: white;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            margin-left: 8px;
        }
        @media print {
            .toolbar, .info-panel { display: none; }
            .canvas-container { padding: 0; }
            .canvas-wrapper { box-shadow: none; }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <h1>📋 Lilly Canvas Export</h1>
        <button onclick="downloadSVG()">Download SVG</button>
        <button onclick="downloadJSON()">Download JSON</button>
        <button class="primary" onclick="window.print()">Print</button>
    </div>
    <div class="canvas-container">
        <div class="canvas-wrapper" id="canvasWrapper">
            ${svgData}
        </div>
    </div>
    <div class="info-panel">
        <h3>Canvas Information</h3>
        <p>Elements: <span class="element-count">${canvas.elements.length}</span></p>
        <p style="margin-top: 8px;">Exported on ${new Date().toLocaleString()}</p>
        <p style="margin-top: 8px; font-size: 12px; color: #999;">
            Tip: Use Ctrl+P to print or save as PDF
        </p>
    </div>
    <script>
        const canvasData = ${elements};
        
        function downloadSVG() {
            const svg = document.querySelector('#canvasWrapper svg');
            const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'canvas-export.svg';
            a.click();
            URL.revokeObjectURL(url);
        }
        
        function downloadJSON() {
            const blob = new Blob([JSON.stringify(canvasData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'canvas-export.json';
            a.click();
            URL.revokeObjectURL(url);
        }
        
        // Make elements clickable to show info
        document.querySelectorAll('svg [data-element-id]').forEach(el => {
            el.style.cursor = 'pointer';
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('Element:', el.dataset.elementId);
            });
        });
    </script>
</body>
</html>`;

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        this.downloadFile(url, `${filename}.html`);
    }

    /**
     * Export as PowerPoint (PPTX)
     */
    async exportPPTX(filename, options) {
        // Wait for library to be available
        if (typeof window.PptxGenJS === 'undefined') {
            const loaded = await this.waitForLibrary(() => typeof window.PptxGenJS !== 'undefined', 3000);
            if (!loaded) {
                await this.loadScript('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.min.js');
            }
        }

        const canvas = window.infiniteCanvas;
        const PptxGenJS = window.PptxGenJS;
        const pptx = new PptxGenJS();
        
        // Set presentation properties
        pptx.title = 'Lilly Canvas Export';
        pptx.author = 'Lilly Canvas';
        pptx.company = 'LillyBuilt';
        pptx.subject = 'Canvas Export';
        
        // Get canvas bounds
        const bounds = canvas.getBounds();
        const padding = options.padding || 20;
        
        // Define slide dimensions (16:9)
        const slideWidth = 10;
        const slideHeight = 5.625;
        
        // Group elements into slides based on position
        const slides = this.groupElementsIntoSlides(canvas.elements, bounds, slideWidth, slideHeight);
        
        for (let i = 0; i < slides.length; i++) {
            const slide = pptx.addSlide();
            const slideElements = slides[i];
            
            // Calculate bounds for this slide
            let slideMinX = Infinity, slideMinY = Infinity;
            let slideMaxX = -Infinity, slideMaxY = -Infinity;
            
            for (const el of slideElements) {
                const elBounds = this.getElementBounds(el);
                slideMinX = Math.min(slideMinX, elBounds.x);
                slideMinY = Math.min(slideMinY, elBounds.y);
                slideMaxX = Math.max(slideMaxX, elBounds.x + elBounds.width);
                slideMaxY = Math.max(slideMaxY, elBounds.y + elBounds.height);
            }
            
            const slideContentWidth = slideMaxX - slideMinX;
            const slideContentHeight = slideMaxY - slideMinY;
            
            // Scale to fit slide
            const scaleX = (slideWidth - 1) / slideContentWidth;
            const scaleY = (slideHeight - 1) / slideContentHeight;
            const scale = Math.min(scaleX, scaleY);
            
            // Render each element
            for (const el of slideElements) {
                this.addElementToSlide(slide, el, slideMinX, slideMinY, scale);
            }
        }

        await pptx.writeFile({ fileName: `${filename}.pptx` });
    }

    /**
     * Export as JSON
     */
    async exportJSON(filename, options) {
        const canvas = window.infiniteCanvas;
        
        // Create serializable export
        const exportData = {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            canvas: {
                elements: canvas.elements.map(el => ({
                    ...el,
                    imageElement: undefined // Remove non-serializable objects
                })),
                bounds: canvas.getBounds()
            },
            metadata: {
                elementCount: canvas.elements.length,
                exportOptions: options
            }
        };

        const jsonData = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        this.downloadFile(url, `${filename}.json`);
    }

    // ==================== IMPORT METHODS ====================

    /**
     * Import files from drop or file input
     */
    async importFiles(files) {
        const results = [];
        window.app?.showLoading(`Importing ${files.length} file(s)...`);
        
        for (const file of files) {
            try {
                const result = await this.importFile(file);
                results.push({ file: file.name, success: true, result });
            } catch (error) {
                results.push({ file: file.name, success: false, error: error.message });
            }
        }

        // Show summary
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        
        if (successCount > 0) {
            window.app?.showToast(`Imported ${successCount} file(s)`);
        }
        if (failCount > 0) {
            console.error('Import errors:', results.filter(r => !r.success));
            window.app?.showToast(`${failCount} file(s) failed to import`);
        }

        window.app?.hideLoading();
        return results;
    }

    /**
     * Import a single file
     */
    async importFile(file) {
        const fileType = file.type;
        const fileName = file.name.toLowerCase();
        const extension = fileName.split('.').pop();

        // Determine import method based on type
        if (this.supportedImportFormats.image.includes(fileType) || 
            ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) {
            return await this.importImage(file);
        } else if (this.supportedImportFormats.data.includes(fileType) || extension === 'json') {
            return await this.importJSON(file);
        } else if (this.supportedImportFormats.spreadsheet.includes(fileType) || 
                   ['csv', 'xls', 'xlsx'].includes(extension)) {
            return await this.importSpreadsheet(file);
        } else if (this.supportedImportFormats.pdf.includes(fileType) || extension === 'pdf') {
            return await this.importPDF(file);
        } else if (this.supportedImportFormats.mindmap.includes(fileType) || 
                   ['mm', 'opml'].includes(extension)) {
            return await this.importMindMap(file);
        } else if (this.supportedImportFormats.diagram.includes(fileType) || 
                   (extension === 'drawio' || extension === 'xml')) {
            return await this.importDrawIO(file);
        } else {
            throw new Error(`Unsupported file type: ${fileType || extension}`);
        }
    }

    /**
     * Import image file
     */
    async importImage(file, position = null) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = async (event) => {
                try {
                    if (file.name.toLowerCase().endsWith('.svg')) {
                        // Import SVG as elements
                        const elements = await this.parseSVG(event.target.result);
                        this.addImportedElements(elements, position);
                        resolve({ type: 'svg', elements: elements.length });
                    } else {
                        // Import as image element
                        const img = new Image();
                        img.onload = () => {
                            const element = this.createImageElement(img, file.name, position);
                            window.infiniteCanvas?.addElement(element);
                            window.historyManager?.pushState(window.infiniteCanvas.elements);
                            resolve({ type: 'image', element });
                        };
                        img.onerror = () => reject(new Error('Failed to load image'));
                        img.src = event.target.result;
                    }
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Import JSON file
     */
    async importJSON(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    const elements = data.canvas?.elements || data.elements || data;
                    
                    if (Array.isArray(elements)) {
                        this.addImportedElements(elements);
                        resolve({ type: 'json', elements: elements.length });
                    } else {
                        reject(new Error('Invalid JSON format'));
                    }
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    /**
     * Import spreadsheet (CSV/Excel)
     */
    async importSpreadsheet(file) {
        // Wait for library to be available
        if (typeof window.XLSX === 'undefined') {
            const loaded = await this.waitForLibrary(() => typeof window.XLSX !== 'undefined', 3000);
            if (!loaded) {
                await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
                await this.waitForLibrary(() => typeof window.XLSX !== 'undefined', 3000);
            }
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                try {
                    const data = new Uint8Array(event.target.result);
                    const workbook = window.XLSX.read(data, { type: 'array' });
                    
                    // Convert first sheet to data
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
                    
                    // Create table element from data
                    const elements = this.createTableFromData(jsonData);
                    this.addImportedElements(elements);
                    
                    resolve({ type: 'spreadsheet', rows: jsonData.length, elements: elements.length });
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Import PDF file
     */
    async importPDF(file) {
        // Wait for library to be available
        if (typeof window.pdfjsLib === 'undefined') {
            const loaded = await this.waitForLibrary(() => typeof window.pdfjsLib !== 'undefined', 3000);
            if (!loaded) {
                await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
                await this.waitForLibrary(() => typeof window.pdfjsLib !== 'undefined', 3000);
            }
            if (window.pdfjsLib?.GlobalWorkerOptions) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            }
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = async (event) => {
                try {
                    const typedArray = new Uint8Array(event.target.result);
                    const pdf = await window.pdfjsLib.getDocument({ data: typedArray }).promise;
                    
                    const elements = [];
                    const canvas = window.infiniteCanvas;
                    let yOffset = 0;
                    
                    // Render each page as image
                    for (let pageNum = 1; pageNum <= Math.min(pdf.numPages, 10); pageNum++) {
                        const page = await pdf.getPage(pageNum);
                        const viewport = page.getViewport({ scale: 1.5 });
                        
                        const pageCanvas = document.createElement('canvas');
                        const ctx = pageCanvas.getContext('2d');
                        pageCanvas.width = viewport.width;
                        pageCanvas.height = viewport.height;
                        
                        await page.render({ canvasContext: ctx, viewport }).promise;
                        
                        // Add as image element
                        const img = new Image();
                        img.src = pageCanvas.toDataURL();
                        await new Promise(r => img.onload = r);
                        
                        const element = this.createImageElement(img, `PDF Page ${pageNum}`, {
                            x: canvas.offsetX,
                            y: canvas.offsetY + yOffset
                        });
                        elements.push(element);
                        yOffset += viewport.height + 10;
                    }
                    
                    this.addImportedElements(elements);
                    resolve({ type: 'pdf', pages: elements.length });
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Import MindMap files (FreeMind/MM, OPML)
     */
    async importMindMap(file) {
        const isOPML = file.name.toLowerCase().endsWith('.opml');
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                try {
                    let elements = [];
                    
                    if (isOPML) {
                        elements = this.parseOPML(event.target.result);
                    } else {
                        elements = this.parseFreeMind(event.target.result);
                    }
                    
                    this.addImportedElements(elements);
                    resolve({ type: 'mindmap', elements: elements.length });
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    /**
     * Import Draw.io files
     */
    async importDrawIO(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                try {
                    const xmlText = event.target.result;
                    const elements = this.parseDrawIO(xmlText);
                    this.addImportedElements(elements);
                    resolve({ type: 'drawio', elements: elements.length });
                } catch (error) {
                    reject(error);
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    // ==================== HELPER METHODS ====================

    /**
     * Generate image data URL from canvas
     */
    generateImageDataURL(type, options, quality = 0.9) {
        const canvas = window.infiniteCanvas;
        const exportCanvas = document.createElement('canvas');
        const ctx = exportCanvas.getContext('2d');
        
        // Get bounds
        const bounds = canvas.getBounds();
        const padding = options.padding !== undefined ? options.padding : 20;
        
        exportCanvas.width = (bounds.width + padding * 2) * (options.scale || 1);
        exportCanvas.height = (bounds.height + padding * 2) * (options.scale || 1);
        
        // Fill background
        if (!options.transparent) {
            ctx.fillStyle = options.backgroundColor || 
                (document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e1e1e' : '#ffffff');
            ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        }
        
        // Render elements
        ctx.save();
        ctx.scale(options.scale || 1, options.scale || 1);
        ctx.translate(-bounds.x + padding, -bounds.y + padding);
        
        for (const element of canvas.elements) {
            window.renderer?.drawElement(ctx, element);
        }
        
        ctx.restore();
        
        return exportCanvas.toDataURL(type, quality);
    }

    /**
     * Generate SVG from canvas elements
     */
    generateSVG(options = {}) {
        const canvas = window.infiniteCanvas;
        const bounds = canvas.getBounds();
        const padding = options.padding !== undefined ? options.padding : 20;
        
        const width = bounds.width + padding * 2;
        const height = bounds.height + padding * 2;
        const offsetX = -bounds.x + padding;
        const offsetY = -bounds.y + padding;
        
        let svg = `<?xml version="1.0" encoding="UTF-8"?>`;
        svg += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
        
        // Add styles
        svg += `<style>`;
        svg += `text { font-family: Virgil, cursive, sans-serif; }`;
        svg += `</style>`;
        
        // Background
        if (!options.transparent) {
            const bgColor = options.backgroundColor || 
                (document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e1e1e' : '#ffffff');
            svg += `<rect width="100%" height="100%" fill="${bgColor}"/>`;
        }
        
        // Elements
        for (const el of canvas.elements) {
            svg += this.elementToSVG(el, offsetX, offsetY);
        }
        
        svg += '</svg>';
        return svg;
    }

    /**
     * Convert single element to SVG
     */
    elementToSVG(el, offsetX, offsetY) {
        const x = (el.x || 0) + offsetX;
        const y = (el.y || 0) + offsetY;
        const hw = (el.width || 0) / 2;
        const hh = (el.height || 0) / 2;
        const stroke = el.strokeColor || '#000000';
        const fill = el.backgroundColor || 'none';
        const strokeWidth = el.strokeWidth || 2;
        const opacity = el.opacity ?? 1;
        
        let svg = '';
        
        switch (el.type) {
            case 'rectangle':
                svg = `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}"`;
                svg += ` fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"`;
                if (el.edgeType === 'round') {
                    const r = Math.min(el.width, el.height) * 0.1;
                    svg += ` rx="${r}" ry="${r}"`;
                }
                svg += '/>';
                if (el.text) {
                    svg += this.textToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'diamond':
                const points = `${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}`;
                svg = `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                if (el.text) {
                    svg += this.textToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'ellipse':
                svg = `<ellipse cx="${x}" cy="${y}" rx="${hw}" ry="${hh}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                if (el.text) {
                    svg += this.textToSVG(el, x, y, hw, hh, opacity);
                }
                break;
                
            case 'text':
                if (el.text) {
                    const lines = el.text.split('\n');
                    const lineHeight = (el.fontSize || 20) * 1.4;
                    const startY = y - (lines.length - 1) * lineHeight / 2;
                    
                    svg += `<g opacity="${opacity}">`;
                    lines.forEach((line, i) => {
                        const lineY = startY + i * lineHeight;
                        svg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${stroke}" font-size="${el.fontSize || 20}">${this.escapeXml(line)}</text>`;
                    });
                    svg += '</g>';
                }
                break;
                
            case 'sticky':
                svg = `<rect x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}"`;
                svg += ` fill="${el.backgroundColor || '#ffec99'}" stroke="${el.strokeColor || '#e6b800'}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                if (el.text) {
                    svg += `<text x="${x - hw + 12}" y="${y - hh + 24}" fill="${el.strokeColor || '#5c4b00'}" font-size="16">${this.escapeXml(el.text)}</text>`;
                }
                break;
                
            case 'line':
            case 'arrow':
                if (el.points && el.points.length >= 2) {
                    const p1 = el.points[0];
                    const p2 = el.points[1];
                    svg = `<line x1="${p1.x + offsetX}" y1="${p1.y + offsetY}" x2="${p2.x + offsetX}" y2="${p2.y + offsetY}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
                    
                    if (el.type === 'arrow') {
                        const arrowSize = Math.max(10, strokeWidth * 4);
                        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                        const arrowAngle1 = angle + Math.PI * 0.85;
                        const arrowAngle2 = angle - Math.PI * 0.85;
                        
                        const ax1 = p2.x + Math.cos(arrowAngle1) * arrowSize;
                        const ay1 = p2.y + Math.sin(arrowAngle1) * arrowSize;
                        const ax2 = p2.x + Math.cos(arrowAngle2) * arrowSize;
                        const ay2 = p2.y + Math.sin(arrowAngle2) * arrowSize;
                        
                        svg += `<polygon points="${p2.x + offsetX},${p2.y + offsetY} ${ax1 + offsetX},${ay1 + offsetY} ${ax2 + offsetX},${ay2 + offsetY}" fill="${stroke}" opacity="${opacity}"/>`;
                    }
                }
                break;
                
            case 'freedraw':
                if (el.points && el.points.length >= 2) {
                    let path = `M ${el.points[0].x + offsetX} ${el.points[0].y + offsetY}`;
                    for (let i = 1; i < el.points.length - 1; i++) {
                        const xc = (el.points[i].x + el.points[i + 1].x) / 2;
                        const yc = (el.points[i].y + el.points[i + 1].y) / 2;
                        path += ` Q ${el.points[i].x + offsetX} ${el.points[i].y + offsetY}, ${xc + offsetX} ${yc + offsetY}`;
                    }
                    if (el.points.length > 1) {
                        const last = el.points[el.points.length - 1];
                        path += ` L ${last.x + offsetX} ${last.y + offsetY}`;
                    }
                    
                    let strokeDash = '';
                    if (el.strokeStyle === 'dashed') {
                        strokeDash = ' stroke-dasharray="8,8"';
                    } else if (el.strokeStyle === 'dotted') {
                        strokeDash = ' stroke-dasharray="2,4"';
                    }
                    
                    svg = `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" opacity="${opacity}"${strokeDash}/>`;
                }
                break;
                
            case 'image':
                if (el.imageElement && el.imageElement.src) {
                    svg += `<image x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" href="${el.imageElement.src}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
                } else if (el.imageUrl) {
                    svg += `<image x="${x - hw}" y="${y - hh}" width="${el.width}" height="${el.height}" href="${el.imageUrl}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet"/>`;
                }
                break;
        }
        
        return svg;
    }

    /**
     * Convert text to SVG
     */
    textToSVG(el, x, y, hw, hh, opacity) {
        if (!el.text) return '';
        
        const lines = el.text.split('\n');
        const fontSize = el.fontSize || 20;
        const lineHeight = fontSize * 1.4;
        const totalHeight = lines.length * lineHeight;
        
        let svg = `<g opacity="${opacity}">`;
        
        lines.forEach((line, index) => {
            if (index < 5) {
                const lineY = y - totalHeight / 2 + lineHeight / 2 + index * lineHeight;
                svg += `<text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle" fill="${el.strokeColor || '#000000'}" font-size="${fontSize}">${this.escapeXml(line)}</text>`;
            }
        });
        
        svg += '</g>';
        return svg;
    }

    /**
     * Parse SVG and convert to canvas elements
     */
    async parseSVG(svgText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement;
        
        const elements = [];
        const viewBox = svg.getAttribute('viewBox')?.split(' ').map(Number) || [0, 0, 800, 600];
        
        // Convert basic shapes
        svg.querySelectorAll('rect').forEach(rect => {
            elements.push({
                id: this.generateId(),
                type: 'rectangle',
                x: parseFloat(rect.getAttribute('x') || 0) + parseFloat(rect.getAttribute('width') || 0) / 2,
                y: parseFloat(rect.getAttribute('y') || 0) + parseFloat(rect.getAttribute('height') || 0) / 2,
                width: parseFloat(rect.getAttribute('width') || 100),
                height: parseFloat(rect.getAttribute('height') || 100),
                strokeColor: rect.getAttribute('stroke') || '#000000',
                backgroundColor: rect.getAttribute('fill') || 'transparent',
                strokeWidth: parseFloat(rect.getAttribute('stroke-width') || 2),
                ...window.toolManager?.defaultProperties
            });
        });
        
        svg.querySelectorAll('circle, ellipse').forEach(ellipse => {
            const isCircle = ellipse.tagName === 'circle';
            elements.push({
                id: this.generateId(),
                type: 'ellipse',
                x: parseFloat(ellipse.getAttribute('cx') || 0),
                y: parseFloat(ellipse.getAttribute('cy') || 0),
                width: parseFloat(ellipse.getAttribute(isCircle ? 'r' : 'rx') || 50) * 2,
                height: parseFloat(ellipse.getAttribute(isCircle ? 'r' : 'ry') || 50) * 2,
                strokeColor: ellipse.getAttribute('stroke') || '#000000',
                backgroundColor: ellipse.getAttribute('fill') || 'transparent',
                strokeWidth: parseFloat(ellipse.getAttribute('stroke-width') || 2),
                ...window.toolManager?.defaultProperties
            });
        });
        
        svg.querySelectorAll('text').forEach(text => {
            elements.push({
                id: this.generateId(),
                type: 'text',
                x: parseFloat(text.getAttribute('x') || 0),
                y: parseFloat(text.getAttribute('y') || 0),
                text: text.textContent,
                fontSize: parseFloat(text.getAttribute('font-size') || 20),
                strokeColor: text.getAttribute('fill') || '#000000',
                ...window.toolManager?.defaultProperties
            });
        });
        
        return elements;
    }

    /**
     * Parse OPML (Outline Processor Markup Language)
     */
    parseOPML(xmlText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        
        const elements = [];
        const outlineElements = doc.querySelectorAll('outline');
        
        outlineElements.forEach((outline, index) => {
            const text = outline.getAttribute('text') || 'Untitled';
            const level = this.getOutlineLevel(outline);
            
            elements.push({
                id: this.generateId(),
                type: 'rectangle',
                x: 200 + level * 250,
                y: 100 + index * 80,
                width: 200,
                height: 60,
                text: text,
                strokeColor: '#1971c2',
                backgroundColor: '#a5d8ff',
                strokeWidth: 2,
                ...window.toolManager?.defaultProperties
            });
        });
        
        return elements;
    }

    /**
     * Parse FreeMind/MindMap format
     */
    parseFreeMind(xmlText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        
        const elements = [];
        const nodes = doc.querySelectorAll('node');
        
        nodes.forEach((node, index) => {
            const text = node.getAttribute('TEXT') || 'Untitled';
            const position = node.getAttribute('POSITION') || 'right';
            
            elements.push({
                id: this.generateId(),
                type: position === 'root' ? 'ellipse' : 'rectangle',
                x: position === 'left' ? -200 : (position === 'root' ? 0 : 300),
                y: index * 100,
                width: 180,
                height: position === 'root' ? 80 : 50,
                text: text,
                strokeColor: position === 'root' ? '#9c36b5' : '#2f9e44',
                backgroundColor: position === 'root' ? '#eebefa' : '#b2f2bb',
                strokeWidth: 2,
                ...window.toolManager?.defaultProperties
            });
        });
        
        return elements;
    }

    /**
     * Parse Draw.io XML
     */
    parseDrawIO(xmlText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        
        const elements = [];
        const mxCells = doc.querySelectorAll('mxCell[vertex="1"]');
        
        mxCells.forEach(cell => {
            const geometry = cell.querySelector('mxGeometry');
            if (!geometry) return;
            
            const x = parseFloat(geometry.getAttribute('x') || 0);
            const y = parseFloat(geometry.getAttribute('y') || 0);
            const width = parseFloat(geometry.getAttribute('width') || 100);
            const height = parseFloat(geometry.getAttribute('height') || 60);
            const style = cell.getAttribute('style') || '';
            
            let type = 'rectangle';
            if (style.includes('ellipse')) type = 'ellipse';
            if (style.includes('rhombus')) type = 'diamond';
            
            elements.push({
                id: this.generateId(),
                type: type,
                x: x + width / 2,
                y: y + height / 2,
                width: width,
                height: height,
                text: cell.getAttribute('value') || '',
                strokeColor: '#000000',
                backgroundColor: 'transparent',
                strokeWidth: 2,
                ...window.toolManager?.defaultProperties
            });
        });
        
        return elements;
    }

    /**
     * Create table elements from spreadsheet data
     */
    createTableFromData(data) {
        const elements = [];
        const cellWidth = 120;
        const cellHeight = 30;
        const startX = 100;
        const startY = 100;
        
        data.forEach((row, rowIndex) => {
            if (!Array.isArray(row)) return;
            
            row.forEach((cell, colIndex) => {
                elements.push({
                    id: this.generateId(),
                    type: 'rectangle',
                    x: startX + colIndex * cellWidth + cellWidth / 2,
                    y: startY + rowIndex * cellHeight + cellHeight / 2,
                    width: cellWidth - 4,
                    height: cellHeight - 4,
                    text: String(cell || ''),
                    strokeColor: '#666666',
                    backgroundColor: rowIndex === 0 ? '#e9ecef' : '#ffffff',
                    strokeWidth: 1,
                    fontSize: 12,
                    ...window.toolManager?.defaultProperties
                });
            });
        });
        
        return elements;
    }

    /**
     * Create image element
     */
    createImageElement(img, filename, position = null) {
        const canvas = window.infiniteCanvas;
        
        // Calculate size
        const maxWidth = 400;
        const maxHeight = 300;
        let width = img.width;
        let height = img.height;
        
        if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
        }
        if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
        }
        
        // Position
        const viewportCenter = canvas.getViewportCenter?.() || {
            x: (canvas.canvas.clientWidth || canvas.canvas.width) / 2,
            y: (canvas.canvas.clientHeight || canvas.canvas.height) / 2,
        };
        const centerWorld = canvas.screenToWorld(viewportCenter.x, viewportCenter.y);
        const x = position?.x || centerWorld.x;
        const y = position?.y || centerWorld.y;
        
        return {
            id: this.generateId(),
            type: 'image',
            x: x,
            y: y,
            width: width,
            height: height,
            imageElement: img,
            ...window.toolManager?.defaultProperties
        };
    }

    /**
     * Add imported elements to canvas
     */
    addImportedElements(elements, position = null) {
        const canvas = window.infiniteCanvas;
        
        // Calculate offset if position specified
        let offsetX = 0, offsetY = 0;
        if (position && elements.length > 0) {
            const firstEl = elements[0];
            offsetX = position.x - (firstEl.x || 0);
            offsetY = position.y - (firstEl.y || 0);
        }
        
        // Add elements with new IDs
        const newElements = elements.map(el => ({
            ...el,
            id: this.generateId(),
            x: (el.x || 0) + offsetX,
            y: (el.y || 0) + offsetY,
            imageElement: el.imageElement || undefined
        }));
        
        for (const el of newElements) {
            canvas.addElement(el);
        }
        
        // Select imported elements
        canvas.deselectAll();
        for (const el of newElements) {
            canvas.selectElement(el, true);
        }
        
        window.historyManager?.pushState(canvas.elements);
        
        return newElements;
    }

    /**
     * Group elements into slides for PPTX export
     */
    groupElementsIntoSlides(elements, bounds, slideWidth, slideHeight) {
        // Simple grid-based grouping
        const groups = [];
        const cols = Math.max(1, Math.ceil(bounds.width / (slideWidth * 50)));
        const rows = Math.max(1, Math.ceil(bounds.height / (slideHeight * 50)));
        
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const cellX = bounds.x + col * (bounds.width / cols);
                const cellY = bounds.y + row * (bounds.height / rows);
                const cellWidth = bounds.width / cols;
                const cellHeight = bounds.height / rows;
                
                const cellElements = elements.filter(el => {
                    const elBounds = this.getElementBounds(el);
                    return elBounds.x >= cellX && 
                           elBounds.x < cellX + cellWidth &&
                           elBounds.y >= cellY && 
                           elBounds.y < cellY + cellHeight;
                });
                
                if (cellElements.length > 0) {
                    groups.push(cellElements);
                }
            }
        }
        
        return groups.length > 0 ? groups : [elements];
    }

    /**
     * Add element to PPTX slide
     */
    addElementToSlide(slide, el, minX, minY, scale) {
        const x = (el.x - (el.width || 0) / 2 - minX) * scale + 0.5;
        const y = (el.y - (el.height || 0) / 2 - minY) * scale + 0.5;
        const w = (el.width || 100) * scale;
        const h = (el.height || 60) * scale;
        
        const options = {
            x: x,
            y: y,
            w: w,
            h: h,
            fill: el.backgroundColor && el.backgroundColor !== 'transparent' ? { color: el.backgroundColor.replace('#', '') } : undefined,
            line: { color: (el.strokeColor || '#000000').replace('#', ''), width: el.strokeWidth || 1 }
        };
        
        switch (el.type) {
            case 'rectangle':
                slide.addShape('rect', options);
                break;
            case 'ellipse':
                slide.addShape('ellipse', options);
                break;
            case 'diamond':
                slide.addShape('diamond', options);
                break;
            case 'text':
            case 'sticky':
                slide.addText(el.text || '', {
                    x: x,
                    y: y,
                    w: w,
                    h: h,
                    fontSize: (el.fontSize || 20) * 0.75,
                    color: (el.strokeColor || '#000000').replace('#', ''),
                    align: 'center',
                    valign: 'middle'
                });
                break;
        }
    }

    /**
     * Get bounds of a single element
     */
    getElementBounds(el) {
        if (el.type === 'line' || el.type === 'arrow') {
            if (el.points && el.points.length >= 2) {
                const p1 = el.points[0];
                const p2 = el.points[1];
                return {
                    x: Math.min(p1.x, p2.x),
                    y: Math.min(p1.y, p2.y),
                    width: Math.abs(p2.x - p1.x),
                    height: Math.abs(p2.y - p1.y)
                };
            }
        } else if (el.type === 'freedraw' && el.points) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of el.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        }
        
        return {
            x: el.x - (el.width || 0) / 2,
            y: el.y - (el.height || 0) / 2,
            width: el.width || 0,
            height: el.height || 0
        };
    }

    /**
     * Get outline level from DOM element
     */
    getOutlineLevel(element) {
        let level = 0;
        let parent = element.parentElement;
        while (parent) {
            if (parent.tagName === 'outline') level++;
            parent = parent.parentElement;
        }
        return level;
    }

    /**
     * Load external script
     */
    loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if script is already loaded or pending
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                // Wait a bit for deferred scripts
                setTimeout(resolve, 100);
                return;
            }
            
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => {
                // Give library time to initialize
                setTimeout(resolve, 50);
            };
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * Wait for a library to be available (for deferred scripts)
     */
    async waitForLibrary(checkFn, timeout = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (checkFn()) return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }

    /**
     * Download file
     */
    downloadFile(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    }

    /**
     * Generate unique ID
     */
    generateId() {
        return 'el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Escape XML special characters
     */
    escapeXml(text) {
        if (!text) return '';
        return text.replace(/[<>&'"]/g, c => ({
            '<': '&lt;',
            '>': '&gt;',
            '&': '&amp;',
            "'": '&apos;',
            '"': '&quot;'
        })[c]);
    }

    /**
     * Show export options dialog
     */
    showExportDialog() {
        const dialog = document.createElement('div');
        dialog.className = 'modal active';
        dialog.id = 'exportDialog';
        dialog.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>Export Canvas</h3>
                    <button class="close-btn" id="closeExportDialog">
                        <svg viewBox="0 0 24 24" width="18" height="18">
                            <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="export-grid">
                        <button class="export-btn-large" data-format="png">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
                            <span>PNG Image</span>
                            <small>High quality raster</small>
                        </button>
                        <button class="export-btn-large" data-format="jpeg">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
                            <span>JPEG</span>
                            <small>Compressed photo</small>
                        </button>
                        <button class="export-btn-large" data-format="svg">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
                            <span>SVG Vector</span>
                            <small>Scalable graphics</small>
                        </button>
                        <button class="export-btn-large" data-format="pdf">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>
                            <span>PDF Document</span>
                            <small>Multi-page PDF</small>
                        </button>
                        <button class="export-btn-large" data-format="html">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
                            <span>HTML Page</span>
                            <small>Interactive web</small>
                        </button>
                        <button class="export-btn-large" data-format="pptx">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
                            <span>PowerPoint</span>
                            <small>PPTX slides</small>
                        </button>
                        <button class="export-btn-large" data-format="json">
                            <svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>
                            <span>JSON Data</span>
                            <small>Full data export</small>
                        </button>
                    </div>
                    
                    <div class="export-options-panel">
                        <h4>Options</h4>
                        <div class="export-option-row">
                            <label>
                                <input type="checkbox" id="exportTransparent"> Transparent background
                            </label>
                        </div>
                        <div class="export-option-row">
                            <label>Scale: <input type="range" id="exportScale" min="1" max="4" step="0.5" value="2"></label>
                            <span id="exportScaleValue">2x</span>
                        </div>
                        <div class="export-option-row">
                            <label>Padding: <input type="range" id="exportPadding" min="0" max="100" value="20"></label>
                            <span id="exportPaddingValue">20px</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(dialog);
        
        // Setup event listeners
        dialog.querySelector('#closeExportDialog').addEventListener('click', () => {
            dialog.remove();
        });
        
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.remove();
        });
        
        // Scale slider
        const scaleSlider = dialog.querySelector('#exportScale');
        const scaleValue = dialog.querySelector('#exportScaleValue');
        scaleSlider.addEventListener('input', () => {
            scaleValue.textContent = scaleSlider.value + 'x';
        });
        
        // Padding slider
        const paddingSlider = dialog.querySelector('#exportPadding');
        const paddingValue = dialog.querySelector('#exportPaddingValue');
        paddingSlider.addEventListener('input', () => {
            paddingValue.textContent = paddingSlider.value + 'px';
        });
        
        // Export buttons
        dialog.querySelectorAll('.export-btn-large').forEach(btn => {
            btn.addEventListener('click', () => {
                const format = btn.dataset.format;
                const options = {
                    transparent: dialog.querySelector('#exportTransparent').checked,
                    scale: parseFloat(scaleSlider.value),
                    padding: parseInt(paddingSlider.value)
                };
                this.export(format, options);
                dialog.remove();
            });
        });
    }

    /**
     * Show import dialog
     */
    showImportDialog() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = [
            'image/*',
            'application/json',
            '.json',
            'text/csv',
            '.csv',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.xls',
            '.xlsx',
            'application/pdf',
            '.pdf',
            '.mm',
            '.opml',
            '.drawio'
        ].join(',');
        
        input.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                await this.importFiles(files);
            }
        };
        
        input.click();
    }
}

// Create global instance
window.importExportManager = new ImportExportManager();
