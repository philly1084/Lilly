/**
 * Blocks Module - Block type definitions and rendering
 */

const Blocks = (function() {
    
    // Block type definitions
    const BLOCK_TYPES = {
        text: {
            name: 'Text',
            icon: 'Txt',
            placeholder: "Type '/' for commands",
            render: renderTextBlock
        },
        heading_1: {
            name: 'Heading 1',
            icon: 'H1',
            placeholder: 'Heading 1',
            render: renderTextBlock
        },
        heading_2: {
            name: 'Heading 2',
            icon: 'H2',
            placeholder: 'Heading 2',
            render: renderTextBlock
        },
        heading_3: {
            name: 'Heading 3',
            icon: 'H3',
            placeholder: 'Heading 3',
            render: renderTextBlock
        },
        bulleted_list: {
            name: 'Bulleted List',
            icon: '-',
            placeholder: 'List item',
            render: renderListBlock
        },
        numbered_list: {
            name: 'Numbered List',
            icon: '1.',
            placeholder: 'List item',
            render: renderListBlock
        },
        todo: {
            name: 'To-do',
            icon: '[ ]',
            placeholder: 'To-do',
            render: renderTodoBlock
        },
        toggle: {
            name: 'Toggle',
            icon: '"',
            placeholder: 'Toggle',
            render: renderToggleBlock
        },
        quote: {
            name: 'Quote',
            icon: '"',
            placeholder: 'Empty quote',
            render: renderTextBlock
        },
        divider: {
            name: 'Divider',
            icon: '---',
            placeholder: '',
            render: renderDividerBlock
        },
        callout: {
            name: 'Callout',
            icon: '!',
            placeholder: "Type '/' for commands",
            render: renderCalloutBlock
        },
        code: {
            name: 'Code',
            icon: '</>',
            placeholder: "Type '/' for commands",
            render: renderCodeBlock
        },
        image: {
            name: 'Image',
            icon: 'IMG',
            placeholder: '',
            render: renderImageBlock
        },
        ai_image: {
            name: 'AI Image',
            icon: 'AI',
            placeholder: 'Generate an image with AI',
            render: renderAIImageBlock
        },
        bookmark: {
            name: 'Bookmark',
            icon: 'Link',
            placeholder: 'Paste link or search...',
            render: renderBookmarkBlock
        },
        database: {
            name: 'Database',
            icon: 'DB',
            placeholder: '',
            render: renderDatabaseBlock
        },
        chart: {
            name: 'Chart',
            icon: 'Chart',
            placeholder: '',
            render: renderChartBlock
        },
        math: {
            name: 'Math Equation',
            icon: 'Math',
            placeholder: 'Type LaTeX equation...',
            render: renderMathBlock
        },
        mermaid: {
            name: 'Mermaid Diagram',
            icon: 'Flow',
            placeholder: 'graph TD;\n    A-->B;\n    A-->C;',
            render: renderMermaidBlock
        },
        ai: {
            name: 'AI Assistant',
            icon: 'AI',
            placeholder: 'Ask AI...',
            render: renderAIBlock
        }
    };
    
    // ASCII-safe icon list for the callout picker. The previous emoji blob was
    // mojibake-corrupted and rendered garbage characters throughout Notes.
    const EMOJIS = {
        recent: ['*', '!', '?', '+'],
        smileys: [':)', ':D', ';)', ':P', ':|', ':('],
        gestures: ['+1', '-1', 'OK', 'HI'],
        objects: ['*', '#', '@', '&', '%', '$'],
        symbols: ['!', '?', '+', '-', '=', '~'],
    };
    
    // Default model configuration
    const DEFAULT_MODEL = 'gpt-4o';
    const DEFAULT_IMAGE_MODEL = '';
    const DEFAULT_IMAGE_SIZE = 'auto';
    const DEFAULT_IMAGE_QUALITY = 'auto';
    const DEFAULT_IMAGE_STYLE = null;
    const FALLBACK_IMAGE_MODELS = [
        {
            id: 'gpt-image-2',
            name: 'GPT Image 2',
            sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
            qualities: ['auto', 'low', 'medium', 'high'],
            styles: [],
        },
        {
            id: 'gpt-image-1.5',
            name: 'GPT Image 1.5',
            sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
            qualities: ['auto', 'low', 'medium', 'high'],
            styles: [],
        },
    ];
    
    /**
     * Create a new block
     */
    function createBlock(type = 'text', content = '', options = {}) {
        const id = Storage.generateBlockId();
        const blockOptions = { ...options };
        let normalizedContent = content;

        if (type === 'callout') {
            const normalizedCallout = normalizeCalloutContent(content, blockOptions.icon || '!');
            normalizedContent = normalizedCallout;
            blockOptions.icon = normalizedCallout.icon;
        }

        return {
            id,
            type,
            content: normalizedContent,
            children: blockOptions.children || [],
            formatting: blockOptions.formatting || {},
            color: blockOptions.color || null,
            createdAt: Date.now(),
            ...blockOptions
        };
    }
    
    /**
     * Get default model for AI operations
     */
    function getDefaultModel() {
        return DEFAULT_MODEL;
    }
    
    /**
     * Get default image model
     */
    function getDefaultImageModel() {
        return DEFAULT_IMAGE_MODEL;
    }
    
    /**
     * Helper: Safely extract text from API response
     * This fixes the [object Object] display issue
     */
    function extractResponseText(result) {
        if (result === null || result === undefined) {
            return '';
        }
        
        if (typeof result === 'string') {
            const trimmed = result.trim();
            if (!trimmed) {
                return '';
            }

            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    const parsed = JSON.parse(trimmed);
                    const extracted = extractResponseText(parsed);
                    if (extracted) {
                        return extracted;
                    }
                } catch (_error) {
                    // Ignore parse failures and fall back to the raw string.
                }
            }

            return trimmed;
        }
        
        if (typeof result === 'object') {
            // Try common response formats
            if (result.output_text && typeof result.output_text === 'string') {
                return extractResponseText(result.output_text);
            }
            if (result.response && typeof result.response === 'string') {
                return extractResponseText(result.response);
            }
            if (result.text && typeof result.text === 'string') {
                return extractResponseText(result.text);
            }
            if (result.content && typeof result.content === 'string') {
                return extractResponseText(result.content);
            }
            if (result.message && typeof result.message === 'string') {
                return extractResponseText(result.message);
            }
            if (result.output && typeof result.output === 'string') {
                return extractResponseText(result.output);
            }
            if (result.role === 'assistant' && Array.isArray(result.content)) {
                const text = result.content.map((entry) => extractResponseText(entry)).filter(Boolean).join('');
                if (text) return text;
            }
            if (Array.isArray(result.content)) {
                const text = result.content.map((entry) => extractResponseText(entry)).filter(Boolean).join('');
                if (text) return text;
            }
            // Deep extraction for nested objects
            const text = findTextInObject(result);
            if (text) return text;
        }
        
        // Fallback: convert to string but avoid [object Object]
        try {
            const str = JSON.stringify(result);
            if (str !== '{}' && str !== '[]') {
                return str;
            }
        } catch (e) {
            // Ignore JSON stringify errors
        }
        
        return '';
    }
    
    /**
     * Recursively search for text content in an object
     */
    function findTextInObject(obj, depth = 0) {
        if (depth > 5) return null; // Prevent infinite recursion
        
        if (typeof obj === 'string' && obj.length > 0) {
            return extractResponseText(obj);
        }
        
        if (typeof obj === 'object' && obj !== null) {
            // Check common text keys first
            const textKeys = ['output_text', 'text', 'content', 'response', 'message', 'output', 'value', 'data'];
            for (const key of textKeys) {
                if (obj[key] && typeof obj[key] === 'string' && obj[key].length > 0) {
                    return extractResponseText(obj[key]);
                }
            }
            
            // Deep search in nested objects
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    const found = findTextInObject(obj[key], depth + 1);
                    if (found) return found;
                }
            }
        }
        
        return null;
    }

    function isGenericDatabaseColumnLabel(label = '') {
        return /^(?:output|output text|output_text|content|value|data|text|result|response)$/i.test(String(label || '').trim());
    }

    function normalizeDatabaseLabelText(value = '') {
        const text = String(value == null ? '' : value).trim();
        if (!text) return '';
        return text
            .replace(/[_-]+/g, ' ')
            .replace(/\s{2,}/g, ' ');
    }

    function extractDatabaseObjectText(value, keys = []) {
        if (value == null) return '';
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value).trim();
        }
        if (Array.isArray(value)) {
            return value.map((entry) => extractDatabaseObjectText(entry, keys)).filter(Boolean).join(' ').trim();
        }
        if (typeof value !== 'object') return '';

        const keyList = keys.length ? keys : [
            'header',
            'label',
            'name',
            'title',
            'displayName',
            'display_name',
            'columnName',
            'column_name',
            'column',
            'fieldName',
            'field_name',
            'field',
            'key',
            'id',
            'text',
            'value',
            'content',
            'output_text',
            'output',
            'result',
            'response',
        ];
        for (const key of keyList) {
            const candidate = Object.prototype.hasOwnProperty.call(value, key)
                ? extractDatabaseObjectText(value[key], [])
                : '';
            if (candidate) {
                return candidate;
            }
        }
        return '';
    }

    function normalizeDatabaseCellValue(cell) {
        if (cell == null) return '';
        if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
            return String(cell);
        }
        if (Array.isArray(cell)) {
            return cell.map(normalizeDatabaseCellValue).filter(Boolean).join(' ');
        }
        if (typeof cell === 'object') {
            return extractDatabaseObjectText(cell, [
                'value',
                'text',
                'content',
                'output_text',
                'output',
                'result',
                'response',
                'label',
                'name',
                'title',
            ]);
        }
        return String(cell);
    }

    function normalizeDatabaseColumnDescriptors(source = {}, objectRowKeys = []) {
        const columnSource = Array.isArray(source.columns) && source.columns.length > 0
            ? source.columns
            : (Array.isArray(source.headers) ? source.headers : []);

        const descriptors = columnSource.map((column, index) => {
            const rowKeys = [];
            let label = '';

            if (column && typeof column === 'object' && !Array.isArray(column)) {
                [
                    'id',
                    'key',
                    'field',
                    'fieldName',
                    'field_name',
                    'columnId',
                    'column_id',
                    'column',
                    'header',
                    'label',
                    'name',
                    'title',
                    'text',
                    'value',
                    'output_text',
                    'output',
                ].forEach((key) => {
                    const value = Object.prototype.hasOwnProperty.call(column, key)
                        ? extractDatabaseObjectText(column[key], [])
                        : '';
                    if (value && !rowKeys.includes(value)) {
                        rowKeys.push(value);
                    }
                });
                if (Number.isInteger(column.columnIndex)) {
                    rowKeys.push(String(column.columnIndex));
                }

                const preferredKeys = [
                    'header',
                    'label',
                    'name',
                    'title',
                    'displayName',
                    'display_name',
                    'columnName',
                    'column_name',
                    'fieldName',
                    'field_name',
                    'column',
                    'field',
                    'key',
                    'text',
                    'value',
                    'output_text',
                    'output',
                    'id',
                ];
                for (const key of preferredKeys) {
                    const candidate = Object.prototype.hasOwnProperty.call(column, key)
                        ? extractDatabaseObjectText(column[key], [])
                        : '';
                    if (!candidate) continue;
                    if (!label || (isGenericDatabaseColumnLabel(label) && !isGenericDatabaseColumnLabel(candidate))) {
                        label = candidate;
                    }
                    if (label && !isGenericDatabaseColumnLabel(label)) break;
                }
            } else {
                label = extractDatabaseObjectText(column, []);
                if (label) rowKeys.push(label);
            }

            if (isGenericDatabaseColumnLabel(label) && objectRowKeys[index] && !isGenericDatabaseColumnLabel(objectRowKeys[index])) {
                label = objectRowKeys[index];
            }

            return {
                label: String(label || '').trim(),
                keys: rowKeys,
            };
        });

        const labelCounts = descriptors.reduce((counts, descriptor) => {
            const key = descriptor.label.trim().toLowerCase();
            if (key) counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, {});

        descriptors.forEach((descriptor, index) => {
            const labelKey = descriptor.label.trim().toLowerCase();
            const duplicated = labelKey && labelCounts[labelKey] > 1;
            if (!descriptor.label || (duplicated && isGenericDatabaseColumnLabel(descriptor.label))) {
                descriptor.label = objectRowKeys[index] && !isGenericDatabaseColumnLabel(objectRowKeys[index])
                    ? objectRowKeys[index]
                    : `Column ${index + 1}`;
            } else {
                descriptor.label = normalizeDatabaseLabelText(descriptor.label);
            }
            if (!descriptor.keys.includes(descriptor.label)) {
                descriptor.keys.push(descriptor.label);
            }
        });

        return descriptors;
    }

    function normalizeDatabaseContent(content) {
        const source = (content && typeof content === 'object') ? content : {};
        const sourceRows = Array.isArray(source.rows) ? source.rows : [];
        const hasDeclaredColumns = (Array.isArray(source.columns) && source.columns.length > 0)
            || (Array.isArray(source.headers) && source.headers.length > 0);
        const objectRowKeys = [];
        sourceRows.forEach((row) => {
            if (!row || Array.isArray(row) || typeof row !== 'object') return;
            const rowSource = Array.isArray(row.cells)
                ? null
                : (Array.isArray(row.values) ? null : row);
            if (!rowSource) return;
            Object.keys(rowSource).forEach((key) => {
                const label = String(key || '').trim();
                if (label && !objectRowKeys.includes(label)) {
                    objectRowKeys.push(label);
                }
            });
        });
        const maxRowWidth = sourceRows.reduce((maxWidth, row) => {
            if (Array.isArray(row)) return Math.max(maxWidth, row.length);
            if (Array.isArray(row?.cells)) return Math.max(maxWidth, row.cells.length);
            if (Array.isArray(row?.values)) return Math.max(maxWidth, row.values.length);
            if (row && typeof row === 'object') {
                return hasDeclaredColumns
                    ? maxWidth
                    : Math.max(maxWidth, objectRowKeys.length || Object.keys(row).length);
            }
            return Math.max(maxWidth, 1);
        }, 0);
        const columnDescriptors = hasDeclaredColumns
            ? normalizeDatabaseColumnDescriptors(source, objectRowKeys)
            : (objectRowKeys.length > 0
                ? objectRowKeys.map((key) => ({ label: key, keys: [key] }))
                : ['Name', 'Status', 'Notes'].map((key) => ({ label: key, keys: [key] })));
        const columns = columnDescriptors.map((descriptor, index) => descriptor.label || `Column ${index + 1}`);
        while (columns.length < maxRowWidth) {
            columns.push(`Column ${columns.length + 1}`);
            columnDescriptors.push({
                label: columns[columns.length - 1],
                keys: [columns[columns.length - 1]],
            });
        }

        const rows = sourceRows
            .map((row) => {
                let cells;
                if (Array.isArray(row)) {
                    cells = row.slice();
                } else if (Array.isArray(row?.cells)) {
                    cells = row.cells.map(normalizeDatabaseCellValue);
                } else if (Array.isArray(row?.values)) {
                    cells = row.values.map(normalizeDatabaseCellValue);
                } else if (row && typeof row === 'object') {
                    const mapped = columnDescriptors.map((descriptor) => {
                        const candidateKeys = Array.from(new Set([
                            ...(descriptor.keys || []),
                            descriptor.label,
                        ].filter(Boolean)));
                        for (const key of candidateKeys) {
                            if (Object.prototype.hasOwnProperty.call(row, key)) {
                                return row[key];
                            }
                        }
                        const matchedKey = Object.keys(row).find((key) => candidateKeys.some((candidate) =>
                            String(key).trim().toLowerCase() === String(candidate).trim().toLowerCase()
                        ));
                        return matchedKey ? row[matchedKey] : undefined;
                    });
                    cells = mapped.some((cell) => cell !== undefined)
                        ? mapped
                        : Object.keys(row).map((key) => row[key]);
                } else {
                    cells = [row];
                }
                while (cells.length < columns.length) {
                    cells.push('');
                }
                if (cells.length > columns.length) {
                    cells.length = columns.length;
                }
                return cells.map(normalizeDatabaseCellValue);
            });

        return {
            columns,
            rows,
            sortColumn: Number.isInteger(source.sortColumn) ? source.sortColumn : null,
            sortDirection: source.sortDirection === 'desc' ? 'desc' : 'asc'
        };
    }

    function replaceDatabaseBlockContent(wrapper, block, isEditable) {
        const newContent = renderDatabaseBlock(block, isEditable);
        wrapper.replaceWith(newContent);
        return newContent;
    }

    function estimateDatabaseColumnWidth(data, columnIndex) {
        const headerLength = String(data.columns?.[columnIndex] || '').trim().length;
        const maxCellLength = (Array.isArray(data.rows) ? data.rows : []).reduce((maxLength, row) => {
            const value = Array.isArray(row) ? row[columnIndex] : '';
            return Math.max(maxLength, String(value || '').trim().length);
        }, 0);
        const contentLength = Math.max(headerLength, maxCellLength);
        const preferredWidth = 132 + (contentLength * 4);
        return Math.max(160, Math.min(360, preferredWidth));
    }

    function parseChartNumber(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        const normalized = String(value ?? '').replace(/[$,%]/g, '').replace(/,/g, '').trim();
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeChartContent(content) {
        const source = (content && typeof content === 'object') ? content : {};
        let labels = [];
        let values = [];

        if (Array.isArray(source.labels) && Array.isArray(source.values)) {
            labels = source.labels.map((label, index) => String(label || `Item ${index + 1}`));
            values = source.values.map(parseChartNumber).map((value) => value ?? 0);
        } else if (Array.isArray(source.data)) {
            source.data.forEach((item, index) => {
                if (Array.isArray(item)) {
                    labels.push(String(item[0] || `Item ${index + 1}`));
                    values.push(parseChartNumber(item[1]) ?? 0);
                    return;
                }

                if (item && typeof item === 'object') {
                    labels.push(String(item.label || item.name || item.category || `Item ${index + 1}`));
                    values.push(parseChartNumber(item.value ?? item.count ?? item.total ?? item.amount) ?? 0);
                }
            });
        } else if (Array.isArray(source.rows)) {
            const columns = Array.isArray(source.columns) ? source.columns : [];
            const numericColumnIndex = Math.max(1, columns.findIndex((_, index) =>
                index > 0 && source.rows.some((row) => parseChartNumber(Array.isArray(row) ? row[index] : null) !== null)
            ));

            source.rows.forEach((row, index) => {
                const cells = Array.isArray(row) ? row : [row];
                labels.push(String(cells[0] || `Item ${index + 1}`));
                values.push(parseChartNumber(cells[numericColumnIndex]) ?? 0);
            });
        }

        const hasData = labels.length > 0 && values.some((value) => value !== 0);
        if (!labels.length) {
            labels = ['Item 1', 'Item 2', 'Item 3'];
            values = [3, 5, 2];
        }

        return {
            title: String(source.title || source.name || (typeof content === 'string' ? content : '') || 'Chart'),
            chartType: ['bar', 'line', 'pie'].includes(String(source.chartType || source.type || '').toLowerCase())
                ? String(source.chartType || source.type).toLowerCase()
                : 'bar',
            labels,
            values: values.slice(0, labels.length),
            unit: String(source.unit || ''),
            hasData,
        };
    }

    function normalizeCalloutContent(content, fallbackIcon = '!') {
        const icon = typeof fallbackIcon === 'string' && fallbackIcon.trim()
            ? fallbackIcon.trim()
            : '!';

        if (typeof content === 'string') {
            return {
                text: content,
                icon
            };
        }

        if (!content || typeof content !== 'object') {
            return {
                text: '',
                icon
            };
        }

        const text = extractResponseText(
            Object.prototype.hasOwnProperty.call(content, 'text')
                ? content.text
                : content.content ?? content.message ?? content.response ?? content.result ?? content.prompt ?? content
        );

        return {
            ...content,
            text,
            icon: typeof content.icon === 'string' && content.icon.trim()
                ? content.icon.trim()
                : icon
        };
    }
    
    /**
     * Render a text-based block (text, headings, quote)
     */
    function renderTextBlock(block, isEditable = true) {
        const type = BLOCK_TYPES[block.type];
        const input = document.createElement('div');
        input.className = 'block-input';
        input.contentEditable = isEditable;
        input.dataset.blockId = block.id;
        
        if (block.content) {
            input.innerHTML = formatContent(block.content, block.formatting);
        }
        
        // Always set placeholder for empty blocks
        input.dataset.placeholder = type.placeholder;
        
        return input;
    }
    
    /**
     * Render a list block (bulleted, numbered)
     */
    function renderListBlock(block, index = 0, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const bullet = document.createElement('span');
        bullet.className = block.type === 'bulleted_list' ? 'list-bullet' : 'list-number';
        bullet.textContent = block.type === 'bulleted_list' ? '-' : (index + 1) + '.';
        
        const input = document.createElement('div');
        input.className = 'block-input';
        input.contentEditable = isEditable;
        input.dataset.blockId = block.id;
        input.innerHTML = formatContent(block.content, block.formatting) || '';
        
        const type = BLOCK_TYPES[block.type];
        input.dataset.placeholder = type.placeholder;
        
        wrapper.appendChild(bullet);
        wrapper.appendChild(input);
        
        return wrapper;
    }
    
    /**
     * Render a todo block
     */
    function renderTodoBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const checkbox = document.createElement('div');
        checkbox.className = 'todo-checkbox';
        
        const content = typeof block.content === 'object' ? block.content : { text: block.content, checked: false };
        
        if (content.checked) {
            checkbox.classList.add('checked');
        }
        
        checkbox.addEventListener('click', () => {
            checkbox.classList.toggle('checked');
            const nextChecked = checkbox.classList.contains('checked');
            block.content = {
                ...content,
                text: (block.content && typeof block.content === 'object' ? block.content.text : content.text) || '',
                checked: nextChecked
            };
            wrapper.closest('.block')?.classList.toggle('checked', nextChecked);
            
            // Trigger save
            if (window.Editor) {
                window.Editor.savePage();
            }
        });
        
        const input = document.createElement('div');
        input.className = 'block-input';
        input.contentEditable = isEditable;
        input.dataset.blockId = block.id;
        input.innerHTML = formatContent(content.text, block.formatting) || '';
        
        const type = BLOCK_TYPES[block.type];
        input.dataset.placeholder = type.placeholder;
        
        if (content.checked) {
            wrapper.closest('.block')?.classList.add('checked');
        }
        
        wrapper.appendChild(checkbox);
        wrapper.appendChild(input);
        
        return wrapper;
    }
    
    /**
     * Render a toggle block
     */
    function renderToggleBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const arrow = document.createElement('div');
        arrow.className = 'toggle-arrow';
        arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
        
        if (block.expanded !== false) {
            arrow.classList.add('expanded');
        }
        
        arrow.addEventListener('click', () => {
            arrow.classList.toggle('expanded');
            const children = wrapper.nextElementSibling;
            if (children && children.classList.contains('toggle-children')) {
                children.classList.toggle('collapsed', !arrow.classList.contains('expanded'));
            }
            block.expanded = arrow.classList.contains('expanded');
        });
        
        const input = document.createElement('div');
        input.className = 'block-input';
        input.contentEditable = isEditable;
        input.dataset.blockId = block.id;
        input.innerHTML = formatContent(block.content, block.formatting) || '';
        
        const type = BLOCK_TYPES[block.type];
        input.dataset.placeholder = type.placeholder;
        
        wrapper.appendChild(arrow);
        wrapper.appendChild(input);
        
        return wrapper;
    }
    
    /**
     * Render a divider block
     */
    function renderDividerBlock(block) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const line = document.createElement('div');
        line.className = 'divider-line';
        
        wrapper.appendChild(line);
        return wrapper;
    }
    
    /**
     * Render a callout block
     */
    function renderCalloutBlock(block, isEditable = true) {
        const content = normalizeCalloutContent(block.content, block.icon || '!');
        block.content = content;
        block.icon = content.icon;

        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const icon = document.createElement('span');
        icon.className = 'callout-icon';
        icon.textContent = content.icon;
        icon.title = 'Click to change icon';
        
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            // Trigger emoji picker for callout icon
            if (window.Sidebar) {
                // Create a temporary picker
                const picker = document.getElementById('emoji-picker');
                if (picker) {
                    const rect = icon.getBoundingClientRect();
                    picker.style.left = `${rect.left}px`;
                    picker.style.top = `${rect.bottom + 8}px`;
                    picker.style.display = 'block';
                    
                    // Handle selection
                    const handleEmojiClick = (e) => {
                        const span = e.target.closest('.emoji-grid span');
                        if (span) {
                            block.icon = span.textContent;
                            block.content = {
                                ...normalizeCalloutContent(block.content, span.textContent),
                                icon: span.textContent
                            };
                            icon.textContent = span.textContent;
                            picker.style.display = 'none';
                            document.removeEventListener('click', handleOutsideClick);
                            if (window.Editor) window.Editor.savePage();
                        }
                    };
                    
                    const handleOutsideClick = (e) => {
                        if (!picker.contains(e.target) && e.target !== icon) {
                            picker.style.display = 'none';
                            document.removeEventListener('click', handleOutsideClick);
                        }
                    };
                    
                    setTimeout(() => {
                        document.addEventListener('click', handleOutsideClick);
                    }, 0);
                }
            }
        });
        
        const input = document.createElement('div');
        input.className = 'block-input';
        input.contentEditable = isEditable;
        input.dataset.blockId = block.id;
        input.innerHTML = formatContent(content.text, block.formatting) || '';
        
        const type = BLOCK_TYPES[block.type];
        input.dataset.placeholder = type.placeholder;
        
        wrapper.appendChild(icon);
        wrapper.appendChild(input);
        
        return wrapper;
    }

    async function writeClipboardText(text) {
        const value = String(text == null ? '' : text);
        if (window.navigator?.clipboard?.writeText) {
            await window.navigator.clipboard.writeText(value);
            return;
        }

        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.left = '-1000px';
        document.body.appendChild(textarea);
        textarea.select();

        try {
            if (!document.execCommand || !document.execCommand('copy')) {
                throw new Error('Copy command unavailable');
            }
        } finally {
            textarea.remove();
        }
    }

    /**
     * Render a code block
     */
    function renderCodeBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const header = document.createElement('div');
        header.className = 'code-header';
        
        const langSelect = document.createElement('select');
        langSelect.className = 'code-language';
        const languages = ['plain', 'javascript', 'typescript', 'python', 'html', 'css', 'json', 'sql', 'bash', 'markdown', 'java', 'cpp', 'rust', 'go', 'ruby', 'php', 'swift', 'kotlin'];
        languages.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            langSelect.appendChild(option);
        });
        
        const content = typeof block.content === 'object' ? block.content : { language: 'plain', text: block.content || '' };
        langSelect.value = content.language || 'plain';
        
        langSelect.addEventListener('change', () => {
            block.content = { ...content, language: langSelect.value };
            // Re-highlight
            const codeEl = wrapper.querySelector('code');
            if (codeEl && window.hljs) {
                codeEl.className = `language-${langSelect.value}`;
                codeEl.textContent = content.text || '';
                window.hljs.highlightElement(codeEl);
            }
        });
        
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', async () => {
            await writeClipboardText(content.text || '');
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = 'Copy', 2000);
        });
        
        header.appendChild(langSelect);
        header.appendChild(copyBtn);
        
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = `language-${content.language || 'plain'}`;
        code.textContent = content.text || '';
        
        if (isEditable) {
            code.contentEditable = true;
            code.addEventListener('blur', () => {
                block.content = { ...content, text: code.textContent };
                // Re-highlight
                if (window.hljs) {
                    window.hljs.highlightElement(code);
                }
            });
        }
        
        pre.appendChild(code);
        wrapper.appendChild(header);
        wrapper.appendChild(pre);
        
        // Apply syntax highlighting
        setTimeout(() => {
            if (window.hljs) {
                window.hljs.highlightElement(code);
            }
        }, 0);
        
        return wrapper;
    }
    
    /**
     * Render a math block (KaTeX)
     */
    function renderMathBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';

        const content = typeof block.content === 'object' ? block.content : { text: block.content || '', displayMode: true };

        if (isEditable && (!content.text || !String(content.text).trim())) {
            const input = document.createElement('textarea');
            input.className = 'math-input input';
            input.placeholder = 'Type LaTeX equation... (e.g., E = mc^2)';
            input.value = content.text || '';

            const renderBtn = document.createElement('button');
            renderBtn.className = 'btn btn-primary math-action-btn';
            renderBtn.textContent = 'Render Equation';
            renderBtn.addEventListener('click', () => {
                const latex = input.value.trim();
                if (!latex) return;
                block.content = { text: latex, displayMode: true };
                wrapper.innerHTML = '';
                wrapper.appendChild(renderMathBlock(block, isEditable));
                if (window.Editor) window.Editor.savePage();
            });

            wrapper.appendChild(input);
            wrapper.appendChild(renderBtn);
            setTimeout(() => input.focus(), 0);
            return wrapper;
        }

        const mathContainer = document.createElement('div');
        mathContainer.className = 'math-container';

        if (typeof katex !== 'undefined') {
            try {
                katex.render(content.text || '', mathContainer, {
                    displayMode: content.displayMode !== false,
                    throwOnError: false
                });
            } catch (err) {
                mathContainer.innerHTML = `<span class="math-error">Error: ${escapeHtml(err.message)}</span>`;
            }
        } else {
            mathContainer.innerHTML = `<code class="math-preview math-code">${escapeHtml(content.text || '')}</code>`;
        }

        wrapper.appendChild(mathContainer);

        if (isEditable) {
            const editBtn = document.createElement('button');
            editBtn.className = 'btn btn-ghost math-action-btn';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => {
                block.content = { ...content, text: '' };
                wrapper.innerHTML = '';
                wrapper.appendChild(renderMathBlock(block, isEditable));
            });
            wrapper.appendChild(editBtn);
        }

        return wrapper;
    }
    /**
     * Render a Mermaid diagram block with AI integration
     */
    function renderMermaidBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content mermaid-block';
        
        const content = typeof block.content === 'object' ? block.content : { text: block.content || '', diagramType: 'flowchart' };
        
        if (isEditable && (!content.text || content.text.trim() === '')) {
            // ===== EMPTY STATE: Show creation options =====
            const container = document.createElement('div');
            container.className = 'mermaid-empty-state';
            container.style.cssText = 'border: 2px dashed var(--border-color); border-radius: var(--radius-lg); padding: 24px; text-align: center; background: var(--bg-secondary);';
            
            // Header
            const header = document.createElement('div');
            header.innerHTML = 'Flow <strong>Create Diagram</strong>';
            header.style.cssText = 'font-size: 16px; margin-bottom: 16px; color: var(--text-primary);';
            container.appendChild(header);
            
            // AI Generation option
            const aiBtn = document.createElement('button');
            aiBtn.className = 'mermaid-ai-btn';
            aiBtn.innerHTML = 'AI Generate with AI';
            aiBtn.style.cssText = 'width: 100%; padding: 12px; margin-bottom: 12px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; border: none; border-radius: var(--radius-md); font-size: 14px; cursor: pointer; font-weight: 500;';
            aiBtn.addEventListener('click', () => {
                // Open AI assistant and add a reference to this diagram block
                askAIFromDiagram(block, typeSelect.value);
            });
            container.appendChild(aiBtn);
            
            // Divider
            const divider = document.createElement('div');
            divider.style.cssText = 'display: flex; align-items: center; gap: 12px; margin: 16px 0; color: var(--text-muted); font-size: 12px;';
            divider.innerHTML = '<span style="flex: 1; height: 1px; background: var(--border-color);"></span>or<span style="flex: 1; height: 1px; background: var(--border-color);"></span>';
            container.appendChild(divider);
            
            // Manual creation
            const typeSelect = document.createElement('select');
            typeSelect.className = 'mermaid-type-select';
            typeSelect.innerHTML = `
                <option value="flowchart">Flowchart</option>
                <option value="sequence">Sequence Diagram</option>
                <option value="class">Class Diagram</option>
                <option value="state">State Diagram</option>
                <option value="er">ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Entity Relationship</option>
                <option value="gantt">ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Gantt Chart</option>
                <option value="pie">ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¥ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ Pie Chart</option>
                <option value="mindmap">ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  Mindmap</option>
                <option value="gitgraph">ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ Git Graph</option>
            `;
            typeSelect.style.cssText = 'width: 100%; padding: 8px; margin-bottom: 8px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-primary);';
            container.appendChild(typeSelect);
            
            const manualBtn = document.createElement('button');
            manualBtn.className = 'ai-image-btn';
            manualBtn.textContent = 'Write Code Manually';
            manualBtn.style.cssText = 'width: 100%;';
            manualBtn.addEventListener('click', () => {
                block.content = { text: '', diagramType: typeSelect.value, _showEditor: true };
                wrapper.innerHTML = '';
                wrapper.appendChild(renderMermaidBlock(block, isEditable));
            });
            container.appendChild(manualBtn);
            
            wrapper.appendChild(container);
            
        } else if (isEditable && content._showEditor) {
            // ===== EDITOR STATE: Manual code editing =====
            delete content._showEditor;
            
            const header = document.createElement('div');
            header.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px;';
            
            const typeSelect = document.createElement('select');
            typeSelect.innerHTML = `
                <option value="flowchart" ${content.diagramType === 'flowchart' ? 'selected' : ''}>Flowchart</option>
                <option value="sequence" ${content.diagramType === 'sequence' ? 'selected' : ''}>Sequence</option>
                <option value="class" ${content.diagramType === 'class' ? 'selected' : ''}>Class</option>
                <option value="state" ${content.diagramType === 'state' ? 'selected' : ''}>State</option>
                <option value="er" ${content.diagramType === 'er' ? 'selected' : ''}>ER</option>
                <option value="gantt" ${content.diagramType === 'gantt' ? 'selected' : ''}>Gantt</option>
                <option value="pie" ${content.diagramType === 'pie' ? 'selected' : ''}>Pie</option>
                <option value="mindmap" ${content.diagramType === 'mindmap' ? 'selected' : ''}>Mindmap</option>
                <option value="gitgraph" ${content.diagramType === 'gitgraph' ? 'selected' : ''}>Git Graph</option>
            `;
            typeSelect.style.cssText = 'padding: 6px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-primary);';
            header.appendChild(typeSelect);
            
            const aiHelpBtn = document.createElement('button');
            aiHelpBtn.className = 'ai-image-btn';
            aiHelpBtn.innerHTML = 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨ Ask AI';
            aiHelpBtn.addEventListener('click', () => {
                askAIFromDiagram(block, typeSelect.value, input.value);
            });
            header.appendChild(aiHelpBtn);
            
            wrapper.appendChild(header);
            
            const input = document.createElement('textarea');
            input.className = 'mermaid-input';
            input.placeholder = `Describe your ${content.diagramType || 'diagram'} here, or type Mermaid code...\n\nTip: Use ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨ Ask AI to generate code from a description!`;
            input.value = content.text || '';
            input.style.cssText = 'width: 100%; min-height: 150px; padding: 12px; font-family: monospace; font-size: 13px; border: 1px solid var(--border-color); border-radius: var(--radius-md); resize: vertical; background: var(--bg-secondary);';
            wrapper.appendChild(input);
            
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';
            
            const renderBtn = document.createElement('button');
            renderBtn.className = 'ai-image-btn primary';
            renderBtn.textContent = 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ Render Diagram';
            renderBtn.addEventListener('click', () => {
                const diagramText = input.value.trim();
                if (diagramText) {
                    block.content = { text: diagramText, diagramType: typeSelect.value };
                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderMermaidBlock(block, isEditable));
                    if (window.Editor) window.Editor.savePage();
                }
            });
            
            const templateBtn = document.createElement('button');
            templateBtn.className = 'ai-image-btn';
            templateBtn.textContent = 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹ Template';
            templateBtn.addEventListener('click', () => {
                input.value = getMermaidTemplate(typeSelect.value);
            });
            
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'ai-image-btn';
            cancelBtn.textContent = 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Cancel';
            cancelBtn.addEventListener('click', () => {
                if (!content.text) {
                    // Delete empty block
                    const blockEl = wrapper.closest('.block');
                    if (blockEl && window.Editor) {
                        window.Editor.deleteBlock?.(block.id);
                    }
                } else {
                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderMermaidBlock(block, isEditable));
                }
            });
            
            btnRow.appendChild(renderBtn);
            btnRow.appendChild(templateBtn);
            btnRow.appendChild(cancelBtn);
            wrapper.appendChild(btnRow);
            
            setTimeout(() => input.focus(), 0);
            
        } else {
            // ===== RENDERED STATE: Show diagram with AI actions =====
            const toolbar = document.createElement('div');
            toolbar.className = 'mermaid-toolbar';
            toolbar.style.cssText = 'display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;';
            
            // AI Actions
            const aiActionsLabel = document.createElement('span');
            aiActionsLabel.textContent = 'AI:';
            aiActionsLabel.style.cssText = 'color: var(--text-muted); font-size: 12px; display: flex; align-items: center;';
            toolbar.appendChild(aiActionsLabel);
            
            const actions = [
                { label: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨ Improve', prompt: 'Improve this diagram by making it clearer and more professional:' },
                { label: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ Fix', prompt: 'Fix any syntax errors in this diagram:' },
                { label: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Explain', prompt: 'Explain what this diagram shows:' },
                { label: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Expand', prompt: 'Expand this diagram with more detail:' }
            ];
            
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = 'mermaid-action-btn';
                btn.textContent = action.label;
                btn.style.cssText = 'padding: 4px 10px; font-size: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); cursor: pointer; color: var(--text-secondary);';
                btn.addEventListener('click', () => {
                    askAIFromDiagram(block, content.diagramType, content.text, action.prompt);
                });
                btn.addEventListener('mouseenter', () => btn.style.background = 'var(--bg-hover)');
                btn.addEventListener('mouseleave', () => btn.style.background = 'var(--bg-tertiary)');
                toolbar.appendChild(btn);
            });
            
            const spacer = document.createElement('div');
            spacer.style.flex = '1';
            toolbar.appendChild(spacer);
            
            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'ai-image-btn';
            editBtn.textContent = 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ Edit';
            editBtn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
            editBtn.addEventListener('click', () => {
                block.content = { ...content, _showEditor: true };
                wrapper.innerHTML = '';
                wrapper.appendChild(renderMermaidBlock(block, isEditable));
            });
            toolbar.appendChild(editBtn);
            
            wrapper.appendChild(toolbar);
            
            // Render the diagram
            const diagramContainer = document.createElement('div');
            diagramContainer.className = 'mermaid-diagram-container';
            diagramContainer.style.cssText = 'background: var(--bg-secondary); padding: 16px; border-radius: var(--radius-md); overflow-x: auto;';
            
            const diagramId = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            
            const mermaidDiv = document.createElement('div');
            mermaidDiv.className = 'mermaid';
            mermaidDiv.id = diagramId;
            mermaidDiv.textContent = content.text || '';
            
            diagramContainer.appendChild(mermaidDiv);
            wrapper.appendChild(diagramContainer);
            
            // Render using Mermaid
            if (typeof mermaid !== 'undefined') {
                setTimeout(() => {
                    try {
                        mermaid.run({ querySelector: '#' + diagramId });
                    } catch (err) {
                        diagramContainer.innerHTML = `
                            <div style="color: red; padding: 16px;">
                                ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Error rendering diagram: ${err.message}
                                <br><br>
                                <button class="ai-image-btn" onclick="this.closest('.mermaid-block').querySelector('button[data-action=&quot;fix-diagram&quot;]')?.click()">
                                    Ask AI to Fix
                                </button>
                            </div>
                            <pre style="background: var(--bg-tertiary); padding: 12px; border-radius: 4px; overflow-x: auto;">${escapeHtml(content.text || '')}</pre>
                        `;
                    }
                }, 100);
            } else {
                diagramContainer.innerHTML = `<pre style="background: var(--bg-tertiary); padding: 12px; border-radius: 4px; overflow-x: auto;">${escapeHtml(content.text || '')}</pre><div style="color: var(--text-muted); margin-top: 8px; font-size: 12px;">Mermaid library not loaded</div>`;
            }
        }
        
        return wrapper;
    }
    
    /**
     * Helper: Open AI assistant with diagram context
     */
    function askAIFromDiagram(block, diagramType, currentCode = '', customPrompt = '') {
        if (typeof AIAssistant === 'undefined') {
            alert('AI Assistant not loaded. Please try again in a moment.');
            return;
        }
        
        // Add diagram as reference
        const ref = {
            type: 'section',
            id: block.id || 'diagram-' + Date.now(),
            title: `${diagramType} diagram`,
            blockType: 'mermaid',
            preview: `${diagramType}: ${currentCode.substring(0, 50)}...`
        };
        
        AIAssistant.addReference(ref);
        
        // If there's custom prompt, send it directly
        if (customPrompt) {
            const fullPrompt = customPrompt + '\n\n```mermaid\n' + (currentCode || `[Create a ${diagramType} diagram]`) + '\n```';
            AIAssistant.setPrompt(fullPrompt);
            AIAssistant.send();
        } else {
            // Just open the assistant with the diagram as context
            AIAssistant.setPrompt(`Create a ${diagramType} diagram for: `);
        }
    }
    
    /**
     * Helper: Get template for diagram type
     */
    function getMermaidTemplate(type) {
        const templates = {
            flowchart: `graph TD
    A[Start] --> B{Is it valid?}
    B -->|Yes| C[Process Data]
    B -->|No| D[Show Error]
    C --> E[Save Result]
    D --> F[Log Error]
    E --> G[End]
    F --> G`,
            sequence: `sequenceDiagram
    actor User
    participant App
    participant API
    participant DB
    
    User->>App: Submit request
    App->>API: Validate data
    API->>DB: Query records
    DB-->>API: Return results
    API-->>App: Send response
    App-->>User: Display result`,
            class: `classDiagram
    class User {
        +String id
        +String email
        +login()
        +logout()
    }
    class Order {
        +String orderId
        +Date date
        +calculateTotal()
    }
    User "1" --> "*" Order : places`,
            state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : start
    Processing --> Success : complete
    Processing --> Error : fail
    Success --> [*]
    Error --> Idle : retry`,
            er: `erDiagram
    USER ||--o{ ORDER : places
    USER {
        string id PK
        string email
        string name
    }
    ORDER {
        int id PK
        string user_id FK
        date created_at
        float total
    }`,
            gantt: `gantt
    title Project Timeline
    dateFormat YYYY-MM-DD
    section Planning
    Requirements   :a1, 2024-01-01, 7d
    Design         :a2, after a1, 5d
    section Development
    Coding         :a3, after a2, 14d
    Testing        :a4, after a3, 7d`,
            pie: `pie title Distribution
    "Category A" : 40
    "Category B" : 30
    "Category C" : 20
    "Category D" : 10`,
            mindmap: `mindmap
  root((Main Topic))
    Subtopic 1
      Detail A
      Detail B
    Subtopic 2
      Detail C
    Subtopic 3`,
            gitgraph: `gitGraph
    commit id: "Initial"
    branch feature-a
    checkout feature-a
    commit id: "Add feature A"
    commit id: "Fix bug"
    checkout main
    merge feature-a id: "Merge A"
    branch feature-b
    checkout feature-b
    commit id: "Add feature B"
    checkout main
    merge feature-b id: "Merge B"`
        };
        return templates[type] || templates.flowchart;
    }
    
    /**
     * Render an image block
     */
    function renderImageBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const imageUrl = String(
            block.content?.url
            || block.content?.imageUrl
            || block.content?.image_url
            || block.content?.normalizedUrl
            || block.content?.downloadUrl
            || ''
        ).trim();
        if (block.content && imageUrl) {
            if (!block.content.url) {
                block.content.url = imageUrl;
            }
            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'image-wrapper';

            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = block.content.caption || block.content.alt || '';
            img.draggable = false;

            // Handle image load errors
            img.addEventListener('error', () => {
                imgWrapper.innerHTML = `
                    <div style="padding: 48px; background: var(--bg-secondary); text-align: center; color: var(--text-muted);">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 12px;">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5"></circle>
                            <polyline points="21 15 16 10 5 21"></polyline>
                        </svg>
                        <div>Image failed to load</div>
                    </div>
                `;
            });
            
            imgWrapper.appendChild(img);
            wrapper.appendChild(imgWrapper);
            
            if (isEditable) {
                const caption = document.createElement('input');
                caption.className = 'image-caption';
                caption.placeholder = 'Write a caption...';
                caption.value = block.content.caption || '';
                caption.addEventListener('input', () => {
                    block.content = { ...block.content, caption: caption.value };
                });
                wrapper.appendChild(caption);
            }
        } else if (isEditable) {
            const placeholder = document.createElement('div');
            placeholder.className = 'image-upload-placeholder';
            placeholder.innerHTML = `
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
                <div>Click to upload or paste image URL</div>
            `;
            
            placeholder.addEventListener('click', () => {
                // Show options: URL input or file upload
                const option = confirm('Click OK to enter URL, Cancel to upload file');
                if (option) {
                    const url = prompt('Enter image URL:');
                    if (url) {
                        block.content = { url, caption: '' };
                        window.Editor?.savePage?.();
                        // Re-render
                        wrapper.innerHTML = '';
                        const newContent = renderImageBlock(block, isEditable);
                        wrapper.appendChild(newContent);
                    }
                } else {
                    // Create hidden file input
                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.accept = 'image/*';
                    fileInput.style.display = 'none';
                    fileInput.addEventListener('change', (e) => {
                        const file = e.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = (event) => {
                                block.content = { url: event.target.result, caption: '' };
                                wrapper.innerHTML = '';
                                const newContent = renderImageBlock(block, isEditable);
                                wrapper.appendChild(newContent);
                            };
                            reader.readAsDataURL(file);
                        }
                    });
                    document.body.appendChild(fileInput);
                    fileInput.click();
                    document.body.removeChild(fileInput);
                }
            });
            
            wrapper.appendChild(placeholder);
        }
        
        return wrapper;
    }
    
    /**
     * Render an AI Image block
     */
    function buildAIImageArtifactInlinePath(artifactId) {
        const normalizedId = String(artifactId || '').trim();
        return normalizedId ? `/api/artifacts/${encodeURIComponent(normalizedId)}/download?inline=1` : null;
    }

    function isRenderableAIImageUrl(value = '') {
        const imageUrl = String(value || '').trim();
        if (!imageUrl) return false;
        if (/^(data:image\/|blob:)/i.test(imageUrl)) return true;
        if (/^\/api\/artifacts\/[^/]+\/download\b/i.test(imageUrl)) return true;

        try {
            const parsed = new URL(imageUrl, window.location?.origin || 'http://localhost');
            const hostname = parsed.hostname.toLowerCase();
            if (!/^https?:$/i.test(parsed.protocol)) return false;
            if (/^\/api\/artifacts\/[^/]+\/download\b/i.test(parsed.pathname)) return true;
            if (/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i.test(parsed.pathname)) return true;
            return /(?:^|\.)images\.unsplash\.com$/.test(hostname) ||
                /(?:^|\.)source\.unsplash\.com$/.test(hostname) ||
                /(?:^|\.)oaiusercontent\.com$/.test(hostname) ||
                /(?:^|\.)openai\.com$/.test(hostname) ||
                /blob\.core\.windows\.net$/.test(hostname);
        } catch (_error) {
            return false;
        }
    }

    function getAIImageFallbackUrl(content = {}) {
        const directCandidates = [
            content.inlineUrl,
            content.absoluteInlineUrl,
            content.imageUrl,
            content.url,
            content.absoluteUrl,
            content.downloadUrl,
        ];
        const directUrl = directCandidates
            .map((candidate) => String(candidate || '').trim())
            .find((candidate) => isRenderableAIImageUrl(candidate));
        if (directUrl) return directUrl;

        const generatedImages = Array.isArray(content.generatedImages) ? content.generatedImages : [];
        for (const image of generatedImages) {
            const imageUrl = [
                image?.inlineUrl,
                image?.imageUrl,
                image?.url,
                image?.downloadUrl,
                image?.absoluteInlineUrl,
                image?.absoluteUrl,
            ]
                .map((candidate) => String(candidate || '').trim())
                .find((candidate) => isRenderableAIImageUrl(candidate));
            if (imageUrl) return imageUrl;

            const artifactPath = buildAIImageArtifactInlinePath(image?.artifactId || image?.artifact_id);
            if (artifactPath) return artifactPath;
        }

        return buildAIImageArtifactInlinePath(content.artifactId || content.selectedArtifactId);
    }

    function renderAIImageBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content ai-image-block';
        
        const content = typeof block.content === 'object' ? block.content : {
            prompt: '',
            imageUrl: null,
            model: DEFAULT_IMAGE_MODEL,
            size: DEFAULT_IMAGE_SIZE,
            quality: DEFAULT_IMAGE_QUALITY,
            style: DEFAULT_IMAGE_STYLE,
            source: 'ai',
            status: 'pending',
            unsplashResults: null,
            artifactResults: null,
            selectedUnsplashId: null,
            selectedArtifactId: null,
            imageAssetId: null,
            artifactId: null,
            downloadUrl: null,
            sourceHost: null,
        };
        
        if (typeof block.content !== 'object') {
            block.content = content;
        }

        const hasUnsplashResults = Array.isArray(content.unsplashResults) && content.unsplashResults.length > 0;
        const hasArtifactResults = Array.isArray(content.artifactResults) && content.artifactResults.length > 0;
        if (!content.imageAssetId && typeof content.imageUrl === 'string' && content.imageUrl.startsWith('asset://')) {
            content.imageAssetId = content.imageUrl.slice('asset://'.length) || null;
        }
        const hasAssetRef = Boolean(content.imageAssetId);
        const hasDirectImageUrl = Boolean(content.imageUrl);
        const fallbackImageUrl = getAIImageFallbackUrl(content);
        const hasFallbackImageUrl = Boolean(fallbackImageUrl);
        const hasRenderableImage = hasAssetRef || hasDirectImageUrl || hasFallbackImageUrl;
        let normalizedStatus = content.status
            || ((hasUnsplashResults || hasArtifactResults) ? 'search_results' : (hasRenderableImage ? 'done' : 'pending'));
        if (normalizedStatus === 'generating' && !content._activeGeneration) {
            normalizedStatus = hasRenderableImage ? 'done' : 'pending';
        } else if (normalizedStatus === 'done' && !hasRenderableImage) {
            normalizedStatus = 'pending';
        } else if (normalizedStatus === 'search_results' && !hasUnsplashResults && !hasArtifactResults) {
            normalizedStatus = hasRenderableImage ? 'done' : 'pending';
        }
        if (content.status !== normalizedStatus) {
            content.status = normalizedStatus;
        }

        const assetRef = content.imageAssetId ? `asset://${content.imageAssetId}` : content.imageUrl;
        const displayImageUrl = content._resolvedImageUrl
            || (assetRef && !String(assetRef).startsWith('asset://') ? assetRef : null)
            || fallbackImageUrl;

        if (content.status === 'done'
            && !hasAssetRef
            && hasDirectImageUrl
            && /^https?:\/\//i.test(String(content.imageUrl || ''))
            && !content._assetPersisting
            && window.Storage?.saveImageAsset) {
            content._assetPersisting = true;
            persistAIImageSelection(content, content.imageUrl)
                .then((persistedImage) => {
                    content._assetPersisting = false;
                    if (!persistedImage.imageAssetId) {
                        return;
                    }

                    content.imageUrl = persistedImage.imageUrl;
                    content.imageAssetId = persistedImage.imageAssetId;
                    content._resolvedImageUrl = persistedImage.resolvedImageUrl;
                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderAIImageBlock(block, isEditable));
                    window.Editor?.savePage?.();
                })
                .catch((error) => {
                    content._assetPersisting = false;
                    console.warn('Failed to persist AI image asset:', error.message);
                });
        }

        if (content.source === 'unsplash'
            && content.prompt
            && !hasRenderableImage
            && !hasUnsplashResults
            && !content._unsplashAutoRequested
            && window.API?.searchUnsplash) {
            content._unsplashAutoRequested = true;
            content.status = 'generating';

            window.API.searchUnsplash(content.prompt, { perPage: 1 })
                .then(async (result) => {
                    const firstPhoto = Array.isArray(result?.results) ? result.results[0] : null;
                    if (!firstPhoto?.urls?.regular) {
                        content.status = 'error';
                        content.errorMessage = `No Unsplash images found for "${content.prompt}".`;
                    } else {
                        const persistedImage = await persistAIImageSelection(content, firstPhoto.urls.regular);
                        content.imageUrl = persistedImage.imageUrl;
                        content.imageAssetId = persistedImage.imageAssetId;
                        content._resolvedImageUrl = persistedImage.resolvedImageUrl;
                        content.downloadUrl = firstPhoto.links?.download || firstPhoto.links?.html || firstPhoto.urls.regular;
                        content.status = 'done';
                        content.source = 'unsplash';
                        content.selectedUnsplashId = firstPhoto.id || null;
                        content.unsplashPhotographer = firstPhoto.user?.name || null;
                        content.unsplashPhotographerUrl = firstPhoto.user?.links?.html || firstPhoto.user?.portfolio_url || null;
                        content.unsplashResults = null;
                        content.errorMessage = null;
                    }

                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderAIImageBlock(block, isEditable));
                    window.Editor?.savePage?.();
                })
                .catch((error) => {
                    console.error('Unsplash auto-search error:', error);
                    content.status = 'error';
                    content.errorMessage = 'Failed to load Unsplash image. Please try again.';
                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderAIImageBlock(block, isEditable));
                });
        }

        if (content.status === 'done' && !displayImageUrl && assetRef && String(assetRef).startsWith('asset://') && !content._assetLoading && window.Storage?.resolveImageAsset) {
            content._assetLoading = true;
            window.Storage.resolveImageAsset(assetRef)
                .then((resolvedUrl) => {
                    content._assetLoading = false;
                    if (!resolvedUrl) {
                        if (fallbackImageUrl) {
                            block.content._resolvedImageUrl = fallbackImageUrl;
                            wrapper.innerHTML = '';
                            wrapper.appendChild(renderAIImageBlock(block, isEditable));
                        }
                        return;
                    }
                    block.content._resolvedImageUrl = resolvedUrl;
                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderAIImageBlock(block, isEditable));
                })
                .catch((error) => {
                    content._assetLoading = false;
                    console.warn('Failed to restore AI image asset:', error.message);
                });
        }
        
        if (content.status === 'done') {
            if (!displayImageUrl) {
                const loading = document.createElement('div');
                loading.className = 'ai-image-loading';
                loading.innerHTML = '<div class="ai-image-spinner"></div><div class="ai-image-loading-text">Loading image...</div>';
                wrapper.appendChild(loading);
                return wrapper;
            }

            const imgContainer = document.createElement('div');
            imgContainer.className = 'ai-image-container';
            
            const imgWrapper = document.createElement('div');
            imgWrapper.className = 'ai-image-wrapper';
            
            const img = document.createElement('img');
            img.src = displayImageUrl;
            img.alt = content.caption || content.prompt || 'Image';
            img.className = 'ai-image';
            
            img.addEventListener('error', () => {
                imgWrapper.innerHTML = `
                    <div class="ai-image-error">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5"></circle>
                            <polyline points="21 15 16 10 5 21"></polyline>
                        </svg>
                        <div>Image failed to load</div>
                    </div>
                `;
            });
            
            imgWrapper.appendChild(img);
            imgContainer.appendChild(imgWrapper);
            wrapper.appendChild(imgContainer);
            
            if (isEditable) {
                const caption = document.createElement('input');
                caption.className = 'image-caption';
                caption.placeholder = 'Write a caption...';
                caption.value = content.caption || '';
                caption.addEventListener('input', () => {
                    block.content.caption = caption.value;
                });
                wrapper.appendChild(caption);
            }
        } else if (content.status === 'generating') {
            const loading = document.createElement('div');
            loading.className = 'ai-image-loading';
            loading.innerHTML = `
                <div class="ai-image-spinner"></div>
                <div class="ai-image-loading-text">${content.source === 'unsplash' ? 'Searching Unsplash...' : 'Generating image...'}</div>
                <div class="ai-image-loading-subtext">"${escapeHtml(content.prompt)}"</div>
            `;
            wrapper.appendChild(loading);
        } else if (content.status === 'search_results') {
            const resultsContainer = document.createElement('div');
            resultsContainer.className = 'unsplash-results-container';
            
            const header = document.createElement('div');
            header.className = 'unsplash-results-header';
            header.innerHTML = `
                <span>Search results for "${escapeHtml(content.prompt)}"</span>
                <button class="ai-image-btn close-results">Close</button>
            `;
            header.querySelector('.close-results').addEventListener('click', () => {
                content.status = 'pending';
                content.unsplashResults = null;
                content.artifactResults = null;
                wrapper.innerHTML = '';
                wrapper.appendChild(renderAIImageBlock(block, isEditable));
            });
            resultsContainer.appendChild(header);

            if (content.source === 'artifact' && hasArtifactResults) {
                const grid = document.createElement('div');
                grid.className = 'unsplash-results-grid';

                content.artifactResults.forEach((item, index) => {
                    const previewUrl = item.inlineUrl || item.imageUrl || item.downloadUrl || '';
                    if (!previewUrl) {
                        return;
                    }

                    const card = document.createElement('div');
                    card.className = 'unsplash-result-item';
                    card.style.backgroundImage = `url(${previewUrl})`;
                    card.title = item.filename || `Captured image ${index + 1}`;

                    const overlay = document.createElement('div');
                    overlay.className = 'unsplash-result-overlay';
                    overlay.innerHTML = `
                        <span class="unsplash-photographer">${escapeHtml(item.sourceHost || item.filename || `Image ${index + 1}`)}</span>
                        <button class="unsplash-select-btn">Select</button>
                    `;

                    overlay.querySelector('.unsplash-select-btn').addEventListener('click', async () => {
                        const persistedImage = await persistAIImageSelection(content, previewUrl);
                        content.imageUrl = persistedImage.imageUrl;
                        content.imageAssetId = persistedImage.imageAssetId;
                        content._resolvedImageUrl = persistedImage.resolvedImageUrl;
                        content.downloadUrl = item.downloadUrl || previewUrl;
                        content.status = 'done';
                        content.source = 'artifact';
                        content.selectedArtifactId = item.artifactId || null;
                        content.artifactId = item.artifactId || null;
                        content.sourceHost = item.sourceHost || content.sourceHost || null;
                        content.caption = content.caption || item.filename || '';
                        content.artifactResults = null;
                        wrapper.innerHTML = '';
                        wrapper.appendChild(renderAIImageBlock(block, isEditable));
                        if (window.Editor) {
                            window.Editor.savePage();
                        }
                    });

                    card.appendChild(overlay);
                    grid.appendChild(card);
                });

                if (grid.children.length > 0) {
                    resultsContainer.appendChild(grid);
                }
            } else if (content.unsplashResults && content.unsplashResults.length > 0) {
                const grid = document.createElement('div');
                grid.className = 'unsplash-results-grid';

                content.unsplashResults.forEach((photo) => {
                    const item = document.createElement('div');
                    item.className = 'unsplash-result-item';
                    item.style.backgroundImage = `url(${photo.urls.small})`;
                    item.title = `Photo by ${photo.user.name}`;

                    const overlay = document.createElement('div');
                    overlay.className = 'unsplash-result-overlay';
                    overlay.innerHTML = `
                        <span class="unsplash-photographer">${escapeHtml(photo.user.name)}</span>
                        <button class="unsplash-select-btn">Select</button>
                    `;

                    overlay.querySelector('.unsplash-select-btn').addEventListener('click', async () => {
                        const persistedImage = await persistAIImageSelection(content, photo.urls.regular);
                        content.imageUrl = persistedImage.imageUrl;
                        content.imageAssetId = persistedImage.imageAssetId;
                        content._resolvedImageUrl = persistedImage.resolvedImageUrl;
                        content.downloadUrl = photo.links?.download || photo.links?.html || photo.urls.regular;
                        content.status = 'done';
                        content.source = 'unsplash';
                        content.selectedUnsplashId = photo.id;
                        content.unsplashPhotographer = photo.user.name;
                        content.unsplashPhotographerUrl = photo.user.links?.html || photo.user.portfolio_url || '#';
                        wrapper.innerHTML = '';
                        wrapper.appendChild(renderAIImageBlock(block, isEditable));
                        if (window.Editor) {
                            window.Editor.savePage();
                        }
                    });

                    item.appendChild(overlay);
                    grid.appendChild(item);
                });

                resultsContainer.appendChild(grid);
            } else {
                const noResults = document.createElement('div');
                noResults.className = 'unsplash-no-results';
                noResults.innerHTML = `
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="11" cy="11" r="8"></circle>
                        <path d="m21 21-4.35-4.35"></path>
                    </svg>
                    <div>No images found for "${escapeHtml(content.prompt)}"</div>
                    <button class="ai-image-btn" style="margin-top: 12px;">Try Another Search</button>
                `;
                noResults.querySelector('.ai-image-btn').addEventListener('click', () => {
                    content.status = 'pending';
                    content.unsplashResults = null;
                    content.artifactResults = null;
                    wrapper.innerHTML = '';
                    wrapper.appendChild(renderAIImageBlock(block, isEditable));
                });
                resultsContainer.appendChild(noResults);
            }
            
            wrapper.appendChild(resultsContainer);
        } else if (content.status === 'error') {
            const error = document.createElement('div');
            error.className = 'ai-image-error-state';
            error.innerHTML = `
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <div>${escapeHtml(content.errorMessage || 'Failed to generate image')}</div>
                <button class="ai-image-btn retry-btn">Try Again</button>
            `;
            error.querySelector('.retry-btn').addEventListener('click', () => {
                content.status = 'pending';
                content.errorMessage = null;
                wrapper.innerHTML = '';
                wrapper.appendChild(renderAIImageBlock(block, isEditable));
            });
            wrapper.appendChild(error);
        } else {
            const form = document.createElement('div');
            form.className = 'ai-image-form';
            
            const sourceTabs = document.createElement('div');
            sourceTabs.className = 'ai-image-source-tabs';
            sourceTabs.innerHTML = `
                <button class="ai-image-tab ${content.source !== 'unsplash' ? 'active' : ''}" data-source="ai">
                    AI Generate
                </button>
                <button class="ai-image-tab ${content.source === 'unsplash' ? 'active' : ''}" data-source="unsplash">
                    Unsplash Search
                </button>
            `;
            
            const promptInput = document.createElement('textarea');
            promptInput.className = 'ai-image-prompt-input';
            promptInput.placeholder = content.source === 'unsplash'
                ? 'Search for photos (e.g., nature, architecture, people)...'
                : 'Describe the image you want to generate...';
            promptInput.value = content.prompt || '';
            promptInput.rows = 3;

            const aiOptionsRow = document.createElement('div');
            aiOptionsRow.className = 'ai-image-options';
            aiOptionsRow.style.display = content.source === 'unsplash' ? 'none' : 'flex';

            const modelSelect = document.createElement('select');
            modelSelect.className = 'ai-image-select';
            modelSelect.setAttribute('aria-label', 'Image model');

            const sizeSelect = document.createElement('select');
            sizeSelect.className = 'ai-image-select';
            sizeSelect.setAttribute('aria-label', 'Image size');

            const qualitySelect = document.createElement('select');
            qualitySelect.className = 'ai-image-select';
            qualitySelect.setAttribute('aria-label', 'Image quality');

            const styleSelect = document.createElement('select');
            styleSelect.className = 'ai-image-select';
            styleSelect.setAttribute('aria-label', 'Image style');

            const formatSizeLabel = (value = '') => {
                const normalized = String(value || '').trim();
                if (!normalized) {
                    return 'Auto';
                }
                if (normalized === 'auto') {
                    return 'Auto';
                }

                const sizeMatch = normalized.match(/^(\d+)x(\d+)$/);
                if (!sizeMatch) {
                    return normalized;
                }

                const width = Number(sizeMatch[1]);
                const height = Number(sizeMatch[2]);
                const aspectLabel = width === height
                    ? 'Square'
                    : (width > height ? 'Landscape' : 'Portrait');
                return `${normalized} (${aspectLabel})`;
            };

            const resolveImageModels = (models = []) => {
                const normalizedModels = Array.isArray(models)
                    ? models.filter((model) => model && typeof model === 'object' && String(model.id || '').trim())
                    : [];
                return normalizedModels.length > 0 ? normalizedModels : FALLBACK_IMAGE_MODELS;
            };

            const syncSelectOptions = (select, values = [], preferredValue = '', labelFormatter = (value) => value) => {
                const normalizedValues = (Array.isArray(values) ? values : [])
                    .map((value) => {
                        if (value && typeof value === 'object') {
                            const optionValue = String(value.value ?? value.id ?? '').trim();
                            if (!optionValue) {
                                return null;
                            }
                            return {
                                value: optionValue,
                                label: String(value.label ?? value.name ?? optionValue).trim() || optionValue,
                            };
                        }

                        const optionValue = String(value || '').trim();
                        if (!optionValue) {
                            return null;
                        }
                        return {
                            value: optionValue,
                            label: optionValue,
                        };
                    })
                    .filter(Boolean);

                select.innerHTML = '';
                normalizedValues.forEach((entry) => {
                    const option = document.createElement('option');
                    option.value = entry.value;
                    option.textContent = labelFormatter(entry.label, entry.value);
                    select.appendChild(option);
                });

                if (normalizedValues.length === 0) {
                    select.value = '';
                    return;
                }

                const normalizedPreferredValue = String(preferredValue || '').trim();
                const matchingOption = normalizedValues.find((entry) => entry.value === normalizedPreferredValue);
                select.value = matchingOption ? matchingOption.value : normalizedValues[0].value;
            };

            let availableImageModels = resolveImageModels();

            const getSelectedImageModel = () => {
                const preferredModelId = String(
                    modelSelect.value
                    || content.model
                    || DEFAULT_IMAGE_MODEL
                    || availableImageModels[0]?.id
                    || ''
                ).trim();

                return availableImageModels.find((model) => String(model.id || '').trim() === preferredModelId)
                    || availableImageModels[0]
                    || {
                        id: '',
                        sizes: [DEFAULT_IMAGE_SIZE],
                        qualities: [DEFAULT_IMAGE_QUALITY],
                        styles: [],
                    };
            };

            const syncModelDrivenOptions = () => {
                const selectedModel = getSelectedImageModel();
                const sizes = Array.isArray(selectedModel.sizes) && selectedModel.sizes.length > 0
                    ? selectedModel.sizes
                    : [DEFAULT_IMAGE_SIZE];
                const qualities = Array.isArray(selectedModel.qualities) ? selectedModel.qualities : [];
                const styles = Array.isArray(selectedModel.styles) ? selectedModel.styles : [];

                syncSelectOptions(sizeSelect, sizes, content.size || DEFAULT_IMAGE_SIZE, (_label, value) => formatSizeLabel(value));
                syncSelectOptions(qualitySelect, qualities, content.quality || DEFAULT_IMAGE_QUALITY, (label) => label === 'auto' ? 'Auto' : label);
                syncSelectOptions(styleSelect, styles, content.style || DEFAULT_IMAGE_STYLE || '');

                qualitySelect.style.display = qualities.length > 0 ? '' : 'none';
                qualitySelect.disabled = qualities.length === 0;
                styleSelect.style.display = styles.length > 0 ? '' : 'none';
                styleSelect.disabled = styles.length === 0;
            };

            const syncModelSelect = (models = []) => {
                availableImageModels = resolveImageModels(models);
                syncSelectOptions(
                    modelSelect,
                    availableImageModels.map((model) => ({
                        value: String(model.id || '').trim(),
                        label: String(model.name || model.id || '').trim() || String(model.id || '').trim(),
                    })),
                    content.model || DEFAULT_IMAGE_MODEL || availableImageModels[0]?.id || '',
                );
                syncModelDrivenOptions();
            };

            modelSelect.addEventListener('change', () => {
                syncModelDrivenOptions();
            });
            syncModelSelect();

            if (window.API && typeof window.API.getImageModels === 'function') {
                window.API.getImageModels()
                    .then((models) => {
                        syncModelSelect(models);
                    })
                    .catch((error) => {
                        console.warn('Failed to load image models for AI image block:', error.message);
                    });
            }

            aiOptionsRow.appendChild(modelSelect);
            aiOptionsRow.appendChild(sizeSelect);
            aiOptionsRow.appendChild(qualitySelect);
            aiOptionsRow.appendChild(styleSelect);

            const buttons = document.createElement('div');
            buttons.className = 'ai-image-form-actions';
            
            const generateBtn = document.createElement('button');
            generateBtn.className = 'ai-image-btn primary';
            generateBtn.textContent = content.source === 'unsplash' ? 'Search Unsplash' : 'Generate Image';
            
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'ai-image-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                if (window.Editor && window.Editor.deleteBlock) {
                    window.Editor.deleteBlock(block.id);
                }
            });
            
            sourceTabs.querySelectorAll('.ai-image-tab').forEach((tab) => {
                tab.addEventListener('click', () => {
                    sourceTabs.querySelectorAll('.ai-image-tab').forEach((t) => t.classList.remove('active'));
                    tab.classList.add('active');
                    content.source = tab.dataset.source;
                    promptInput.placeholder = content.source === 'unsplash'
                        ? 'Search for photos (e.g., nature, architecture, people)...'
                        : 'Describe the image you want to generate...';
                    if (content.source === 'unsplash') {
                        aiOptionsRow.style.display = 'none';
                        generateBtn.textContent = 'Search Unsplash';
                    } else {
                        aiOptionsRow.style.display = 'flex';
                        generateBtn.textContent = 'Generate Image';
                    }
                });
            });
            
            generateBtn.addEventListener('click', async () => {
                const prompt = promptInput.value.trim();
                if (!prompt) return;
                
                const currentSource = content.source === 'unsplash' ? 'unsplash' : 'ai';
                block.content = {
                    ...block.content,
                    prompt,
                    source: currentSource,
                    model: modelSelect.value,
                    size: sizeSelect.value || DEFAULT_IMAGE_SIZE,
                    quality: qualitySelect.disabled ? null : (qualitySelect.value || DEFAULT_IMAGE_QUALITY),
                    style: styleSelect.disabled ? null : (styleSelect.value || null),
                    status: 'generating',
                    _activeGeneration: true,
                    imageUrl: null,
                    unsplashResults: null,
                    errorMessage: null,
                };
                
                wrapper.innerHTML = '';
                wrapper.appendChild(renderAIImageBlock(block, isEditable));
                
                if (currentSource === 'unsplash') {
                    try {
                        const result = await API.searchUnsplash(prompt, { perPage: 9 });
                        block.content.unsplashResults = result.results;
                        block.content.status = 'search_results';
                        block.content.totalResults = result.total;
                        delete block.content._activeGeneration;
                        wrapper.innerHTML = '';
                        wrapper.appendChild(renderAIImageBlock(block, isEditable));
                    } catch (err) {
                        console.error('Unsplash search error:', err);
                        block.content.status = 'error';
                        block.content.errorMessage = 'Failed to search Unsplash. Please try again.';
                        delete block.content._activeGeneration;
                        wrapper.innerHTML = '';
                        wrapper.appendChild(renderAIImageBlock(block, isEditable));
                    }
                } else {
                    try {
                        const result = await API.generateImage({
                            prompt,
                            model: block.content.model,
                            size: block.content.size,
                            quality: block.content.quality,
                            style: block.content.style,
                        });

                        const generatedImages = Array.isArray(result.images)
                            ? result.images
                            : (Array.isArray(result.data) ? result.data : []);
                        const primaryImage = generatedImages[0] || null;
                        let storedImageUrl = result.imageUrl
                            || result.url
                            || primaryImage?.imageUrl
                            || primaryImage?.inlineUrl
                            || primaryImage?.url
                            || null;
                        const persistedImage = storedImageUrl
                            ? await persistAIImageSelection(block.content, storedImageUrl)
                            : {
                                imageUrl: null,
                                imageAssetId: block.content.imageAssetId || null,
                                resolvedImageUrl: null,
                            };
                        storedImageUrl = persistedImage.imageUrl;
                        
                        if (!storedImageUrl) {
                            block.content.status = 'error';
                            block.content.errorMessage = 'Image generation returned no renderable image.';
                        } else {
                            block.content.imageUrl = storedImageUrl;
                            block.content.generatedImages = generatedImages;
                            block.content.imageAssetId = persistedImage.imageAssetId;
                            block.content._resolvedImageUrl = persistedImage.resolvedImageUrl;
                            block.content.downloadUrl = result.downloadUrl || primaryImage?.downloadUrl || storedImageUrl || null;
                            block.content.artifactId = result.artifactId || primaryImage?.artifactId || null;
                            block.content.selectedArtifactId = result.artifactId || primaryImage?.artifactId || null;
                            block.content.status = 'done';
                            block.content.revisedPrompt = result.revised_prompt;
                        }
                        delete block.content._activeGeneration;
                        wrapper.innerHTML = '';
                        wrapper.appendChild(renderAIImageBlock(block, isEditable));
                        
                        if (window.Editor) {
                            window.Editor.savePage();
                        }
                    } catch (err) {
                        console.error('Image generation error:', err);
                        block.content.status = 'error';
                        block.content.errorMessage = err.message || 'Failed to generate image';
                        delete block.content._activeGeneration;
                        wrapper.innerHTML = '';
                        wrapper.appendChild(renderAIImageBlock(block, isEditable));
                    }
                }
            });
            
            buttons.appendChild(generateBtn);
            buttons.appendChild(cancelBtn);
            
            form.appendChild(sourceTabs);
            form.appendChild(promptInput);
            form.appendChild(aiOptionsRow);
            form.appendChild(buttons);
            wrapper.appendChild(form);
            
            setTimeout(() => promptInput.focus(), 0);
        }
        
        return wrapper;
    }
    
    /**
     * Render a bookmark block
     */
    function renderBookmarkBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        if (block.content && block.content.url) {
            const card = document.createElement('a');
            card.className = 'bookmark-card';
            card.href = block.content.url;
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
            
            const info = document.createElement('div');
            info.className = 'bookmark-info';
            
            const title = document.createElement('div');
            title.className = 'bookmark-title';
            title.textContent = block.content.title || block.content.url;
            
            const desc = document.createElement('div');
            desc.className = 'bookmark-description';
            desc.textContent = block.content.description || '';
            
            const urlDiv = document.createElement('div');
            urlDiv.className = 'bookmark-url';
            
            if (block.content.favicon) {
                const favicon = document.createElement('img');
                favicon.src = block.content.favicon;
                favicon.alt = '';
                favicon.onerror = () => favicon.style.display = 'none';
                urlDiv.appendChild(favicon);
            }
            
            const urlText = document.createElement('span');
            try {
                urlText.textContent = new URL(block.content.url).hostname;
            } catch {
                urlText.textContent = block.content.url;
            }
            urlDiv.appendChild(urlText);
            
            info.appendChild(title);
            info.appendChild(desc);
            info.appendChild(urlDiv);
            card.appendChild(info);
            
            if (block.content.image) {
                const imgDiv = document.createElement('div');
                imgDiv.className = 'bookmark-image';
                const img = document.createElement('img');
                img.src = block.content.image;
                img.alt = '';
                img.onerror = () => imgDiv.style.display = 'none';
                imgDiv.appendChild(img);
                card.appendChild(imgDiv);
            }
            
            wrapper.appendChild(card);
        } else if (isEditable) {
            const input = document.createElement('input');
            input.className = 'bookmark-input';
            input.placeholder = 'Paste link and press Enter...';
            
            input.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const url = input.value.trim();
                    if (url) {
                        input.placeholder = 'Loading...';
                        input.disabled = true;
                        
                        try {
                            const data = await API.fetchBookmarkData(url);
                            block.content = data;
                            // Re-render
                            wrapper.innerHTML = '';
                            const newContent = renderBookmarkBlock(block, isEditable);
                            wrapper.appendChild(newContent);
                        } catch (err) {
                            input.placeholder = 'Error loading bookmark';
                            input.disabled = false;
                        }
                    }
                }
            });
            
            wrapper.appendChild(input);
        }
        
        return wrapper;
    }
    
    /**
     * Render an AI block
     */
    function renderAIBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const content = typeof block.content === 'object' ? block.content : {
            prompt: block.content || '',
            result: null,
            model: null
        };
        
        // Ensure block content is object
        if (typeof block.content !== 'object') {
            block.content = content;
        }

        const rerenderAIBlock = () => {
            const fresh = renderAIBlock(block, isEditable);
            if (wrapper.isConnected) {
                wrapper.replaceWith(fresh);
            }
            return fresh;
        };

        const resetAIBlockPreview = () => {
            block.content = {
                prompt: content.prompt || '',
                result: null,
                model: content.model || null
            };
        };
        
        if (content.result) {
            // Show result
            const resultContainer = document.createElement('div');
            resultContainer.className = 'ai-block-result-container';
            
            // Model badge if available
            if (content.model) {
                const modelBadge = document.createElement('div');
                modelBadge.className = 'ai-block-model-badge';
                modelBadge.textContent = `Generated with ${content.model}`;
                resultContainer.appendChild(modelBadge);
            }
            
            const result = document.createElement('div');
            result.className = 'ai-block-result';
            // FIX: Use safe text extraction to avoid [object Object]
            const resultText = extractResponseText(content.result);
            result.textContent = resultText;
            resultContainer.appendChild(result);
            
            const actions = document.createElement('div');
            actions.className = 'ai-block-actions';
            
            const regenerateBtn = document.createElement('button');
            regenerateBtn.className = 'ai-block-btn';
            regenerateBtn.textContent = 'Regenerate';
            regenerateBtn.addEventListener('click', async () => {
                content.result = null;
                wrapper.innerHTML = '';
                
                // Show loading
                const loading = document.createElement('div');
                loading.className = 'ai-block-loading';
                loading.innerHTML = '<div class="spinner"></div><span>Generating...</span>';
                wrapper.appendChild(loading);
                
                try {
                    // Get page's default model or use global default
                    const page = window.Editor?.getCurrentPage?.();
                    const model = content.model || page?.defaultModel || DEFAULT_MODEL;
                    
                    const result = await API.generate(content.prompt, model);
                    // FIX: Use safe text extraction
                    const responseText = extractResponseText(result);
                    content.result = responseText;
                    content.model = model;
                    
                    // Re-render with result
                    rerenderAIBlock();
                    
                    if (window.Editor) window.Editor.savePage();
                } catch (err) {
                    content.result = 'Error: ' + err.message;
                    rerenderAIBlock();
                }
            });
            
            const replaceBtn = document.createElement('button');
            replaceBtn.className = 'ai-block-btn primary';
            replaceBtn.textContent = 'Replace block';
            replaceBtn.addEventListener('click', () => {
                const resultText = extractResponseText(content.result);
                if (!resultText.trim() || !window.Editor?.convertBlockType) {
                    return;
                }

                window.Editor.convertBlockType(
                    block.id,
                    'text',
                    resultText
                );
            });

            const insertBtn = document.createElement('button');
            insertBtn.className = 'ai-block-btn';
            insertBtn.textContent = 'Add below';
            insertBtn.addEventListener('click', () => {
                if (window.Editor && window.Editor.insertBlockAfter) {
                    const resultText = extractResponseText(content.result);
                    if (!resultText.trim()) {
                        return;
                    }
                    resetAIBlockPreview();
                    window.Editor.insertBlockAfter(block.id, 'text', resultText);
                    if (window.Editor.savePage) {
                        window.Editor.savePage();
                    }
                }
            });
            
            actions.appendChild(regenerateBtn);
            actions.appendChild(replaceBtn);
            actions.appendChild(insertBtn);
            resultContainer.appendChild(actions);
            wrapper.appendChild(resultContainer);
        } else {
            // Show input
            const formContainer = document.createElement('div');
            formContainer.className = 'ai-block-form';
            
            const promptInput = document.createElement('textarea');
            promptInput.className = 'ai-block-prompt';
            promptInput.placeholder = 'Ask AI to write something...';
            promptInput.rows = 2;
            promptInput.value = content.prompt || '';
            
            // Model selector
            const modelRow = document.createElement('div');
            modelRow.className = 'ai-block-model-row';
            
            const modelLabel = document.createElement('span');
            modelLabel.textContent = 'Model:';
            
            const modelSelect = document.createElement('select');
            modelSelect.className = 'ai-block-model-select';
            
            // Populate models (async)
            API.getModels().then(models => {
                const page = window.Editor?.getCurrentPage?.();
                const defaultModel = content.model || page?.defaultModel || DEFAULT_MODEL;
                
                models.forEach(m => {
                    const option = document.createElement('option');
                    option.value = m.id;
                    option.textContent = m.name;
                    modelSelect.appendChild(option);
                });
                
                modelSelect.value = defaultModel;
            });
            
            modelRow.appendChild(modelLabel);
            modelRow.appendChild(modelSelect);
            
            const actions = document.createElement('div');
            actions.className = 'ai-block-actions';
            
            const generateBtn = document.createElement('button');
            generateBtn.className = 'ai-block-btn primary';
            generateBtn.innerHTML = 'Generate';
            
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'ai-block-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                if (window.Editor && window.Editor.deleteBlock) {
                    window.Editor.deleteBlock(block.id);
                }
            });
            
            generateBtn.addEventListener('click', async () => {
                const prompt = promptInput.value.trim();
                if (!prompt) return;
                
                const selectedModel = modelSelect.value;
                block.content = { prompt, model: selectedModel };
                
                // Show loading
                wrapper.innerHTML = '';
                const loading = document.createElement('div');
                loading.className = 'ai-block-loading';
                loading.innerHTML = '<div class="spinner"></div><span>Generating...</span>';
                wrapper.appendChild(loading);
                
                try {
                    const result = await API.generate(prompt, selectedModel);
                    // FIX: Use safe text extraction to avoid [object Object]
                    const responseText = extractResponseText(result);
                    block.content.result = responseText;
                    block.content.model = selectedModel;
                    
                    // Re-render with result
                    rerenderAIBlock();
                    
                    if (window.Editor) window.Editor.savePage();
                } catch (err) {
                    block.content.result = 'Error: ' + err.message;
                    rerenderAIBlock();
                }
            });
            
            actions.appendChild(generateBtn);
            actions.appendChild(cancelBtn);
            
            formContainer.appendChild(promptInput);
            formContainer.appendChild(modelRow);
            formContainer.appendChild(actions);
            wrapper.appendChild(formContainer);
            
            // Auto-focus
            setTimeout(() => promptInput.focus(), 0);
        }
        
        return wrapper;
    }
    
    /**
     * Render a database block
     */
    function renderDatabaseBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';
        
        const data = normalizeDatabaseContent(block.content);
        block.content = data;
        
        const table = document.createElement('div');
        table.className = 'database-table';
        const columnWidths = data.columns.map((_, index) => estimateDatabaseColumnWidth(data, index));
        const totalColumnWidth = columnWidths.reduce((total, width) => total + width, isEditable ? 36 : 0);
        table.style.setProperty('--database-table-min-width', `${Math.max(totalColumnWidth, 480)}px`);
        
        // Header with editable labels and sorting
        const header = document.createElement('div');
        header.className = 'database-header';
        data.columns.forEach((col, index) => {
            const cell = document.createElement('div');
            cell.className = 'database-cell database-header-cell';
            cell.style.setProperty('--database-column-width', `${columnWidths[index]}px`);

            const label = document.createElement('span');
            label.className = 'database-header-label';
            label.textContent = col;
            if (isEditable) {
                label.contentEditable = true;
                label.spellcheck = false;
                label.tabIndex = 0;
                label.setAttribute('role', 'textbox');
                label.setAttribute('aria-label', `Column ${index + 1} label`);
                label.addEventListener('click', (event) => {
                    event.stopPropagation();
                });
                label.addEventListener('keydown', (event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        label.blur();
                    }
                });
                label.addEventListener('blur', () => {
                    const nextLabel = label.textContent.trim() || `Column ${index + 1}`;
                    data.columns[index] = nextLabel;
                    label.textContent = nextLabel;
                    block.content = data;
                    if (window.Editor) window.Editor.savePage();
                });
            }

            const sortIndicator = document.createElement('span');
            sortIndicator.className = 'database-sort-indicator';
            sortIndicator.setAttribute('aria-hidden', 'true');
            if (data.sortColumn === index) {
                sortIndicator.textContent = data.sortDirection === 'asc' ? 'up' : 'down';
                cell.style.fontWeight = '700';
            }
            cell.appendChild(label);

            const sortColumn = () => {
                // Toggle sort
                if (data.sortColumn === index) {
                    data.sortDirection = data.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    data.sortColumn = index;
                    data.sortDirection = 'asc';
                }
                
                // Sort rows
                if (data.rows && data.rows.length > 0) {
                    data.rows.sort((a, b) => {
                        const aVal = String(a[index] || '').toLowerCase();
                        const bVal = String(b[index] || '').toLowerCase();
                        if (aVal < bVal) return data.sortDirection === 'asc' ? -1 : 1;
                        if (aVal > bVal) return data.sortDirection === 'asc' ? 1 : -1;
                        return 0;
                    });
                }

                block.content = data;
                // Re-render
                replaceDatabaseBlockContent(wrapper, block, isEditable);
                if (window.Editor) window.Editor.savePage();
            };

            const sortButton = document.createElement('button');
            sortButton.type = 'button';
            sortButton.className = 'database-sort-button';
            sortButton.title = `Sort by ${col}`;
            sortButton.setAttribute('aria-label', `Sort by ${col}`);
            sortButton.appendChild(sortIndicator);
            sortButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                sortColumn();
            });
            sortButton.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    sortColumn();
                }
            });
            cell.appendChild(sortButton);

            header.appendChild(cell);
        });
        if (isEditable) {
            const actionSpacer = document.createElement('div');
            actionSpacer.className = 'database-cell database-action-cell database-header-action-cell';
            actionSpacer.setAttribute('aria-hidden', 'true');
            header.appendChild(actionSpacer);
        }
        table.appendChild(header);
        
        // Rows (editable)
        const rowsContainer = document.createElement('div');
        rowsContainer.className = 'database-rows';

        if (data.rows.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'database-empty-state';
            emptyState.textContent = 'No rows yet. Add one to start tracking information.';
            emptyState.style.cssText = 'padding: 16px 12px; color: var(--text-muted); font-size: 13px;';
            rowsContainer.appendChild(emptyState);
        }
        
        data.rows.forEach((row, rowIndex) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'database-row';
            
            row.forEach((cellData, colIndex) => {
                const cellEl = document.createElement('div');
                cellEl.className = 'database-cell';
                cellEl.style.setProperty('--database-column-width', `${columnWidths[colIndex] || 160}px`);
                
                if (isEditable) {
                    cellEl.contentEditable = true;
                    cellEl.textContent = cellData;
                    cellEl.addEventListener('blur', () => {
                        data.rows[rowIndex][colIndex] = cellEl.textContent;
                        block.content = data;
                        if (window.Editor) window.Editor.savePage();
                    });
                } else {
                    cellEl.textContent = cellData;
                }
                
                rowEl.appendChild(cellEl);
            });
            
            // Delete row button
            if (isEditable) {
                const deleteCell = document.createElement('div');
                deleteCell.className = 'database-cell database-action-cell';
                deleteCell.innerHTML = 'X';
                deleteCell.style.cursor = 'pointer';
                deleteCell.style.color = 'var(--text-muted)';
                deleteCell.style.width = '30px';
                deleteCell.style.textAlign = 'center';
                deleteCell.title = 'Delete row';
                deleteCell.addEventListener('click', () => {
                    data.rows.splice(rowIndex, 1);
                    block.content = data;
                    replaceDatabaseBlockContent(wrapper, block, isEditable);
                    if (window.Editor) window.Editor.savePage();
                });
                rowEl.appendChild(deleteCell);
            }
            
            rowsContainer.appendChild(rowEl);
        });
        
        table.appendChild(rowsContainer);
        
        // Add row button
        if (isEditable) {
            const addRow = document.createElement('div');
            addRow.className = 'database-add-row';
            addRow.textContent = '+ New';
            addRow.addEventListener('click', () => {
                data.rows.push(Array(data.columns.length).fill(''));
                block.content = data;
                // Re-render
                replaceDatabaseBlockContent(wrapper, block, isEditable);
                if (window.Editor) window.Editor.savePage();
            });
            table.appendChild(addRow);
            
            // Add column button
            const addCol = document.createElement('div');
            addCol.className = 'database-add-column';
            addCol.textContent = '+ Add Column';
            addCol.style.cssText = 'padding: 8px 12px; text-align: left; color: var(--text-muted); font-size: 13px; cursor: pointer; border-top: 1px solid var(--border-color);';
            addCol.addEventListener('click', () => {
                const colName = prompt('Column name:');
                if (colName) {
                    data.columns.push(colName);
                    // Add empty cell to each row
                    data.rows.forEach(row => row.push(''));
                    block.content = data;
                    replaceDatabaseBlockContent(wrapper, block, isEditable);
                    if (window.Editor) window.Editor.savePage();
                }
            });
            table.appendChild(addCol);
        }
        
        wrapper.appendChild(table);
        return wrapper;
    }

    function renderChartBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content';

        const data = normalizeChartContent(block.content);
        block.content = data;

        const chart = document.createElement('div');
        chart.className = 'chart-block';

        const header = document.createElement('div');
        header.className = 'chart-header';

        const title = document.createElement('div');
        title.className = 'chart-title';
        title.textContent = data.title || 'Chart';
        header.appendChild(title);

        if (isEditable) {
            const typeSelect = document.createElement('select');
            typeSelect.className = 'chart-type-select';
            typeSelect.setAttribute('aria-label', 'Chart type');
            ['bar', 'line', 'pie'].forEach((type) => {
                const option = document.createElement('option');
                option.value = type;
                option.textContent = type.charAt(0).toUpperCase() + type.slice(1);
                option.selected = data.chartType === type;
                typeSelect.appendChild(option);
            });
            typeSelect.addEventListener('change', () => {
                data.chartType = typeSelect.value;
                block.content = data;
                replaceChartBlockContent(wrapper, block, isEditable);
                if (window.Editor) window.Editor.savePage();
            });
            header.appendChild(typeSelect);
        }

        chart.appendChild(header);

        const body = document.createElement('div');
        body.className = `chart-body chart-${data.chartType}`;

        if (!data.hasData) {
            const empty = document.createElement('div');
            empty.className = 'chart-empty';
            empty.textContent = 'Add labels and values to fill this chart.';
            body.appendChild(empty);
        }

        if (data.chartType === 'pie') {
            body.appendChild(renderPieChart(data));
        } else {
            body.appendChild(renderCartesianChart(data));
        }

        chart.appendChild(body);

        if (isEditable) {
            const editor = document.createElement('textarea');
            editor.className = 'chart-data-input';
            editor.rows = Math.min(6, Math.max(3, data.labels.length));
            editor.value = data.labels.map((label, index) => `${label}, ${data.values[index] ?? 0}`).join('\n');
            editor.setAttribute('aria-label', 'Chart data as label, value rows');
            editor.addEventListener('blur', () => {
                const rows = editor.value.split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line, index) => {
                        const parts = line.split(',');
                        const value = parseChartNumber(parts.pop());
                        return {
                            label: parts.join(',').trim() || `Item ${index + 1}`,
                            value: value ?? 0,
                        };
                    });

                if (!rows.length) {
                    return;
                }

                data.labels = rows.map((row) => row.label);
                data.values = rows.map((row) => row.value);
                data.hasData = true;
                block.content = data;
                replaceChartBlockContent(wrapper, block, isEditable);
                if (window.Editor) window.Editor.savePage();
            });
            chart.appendChild(editor);
        }

        wrapper.appendChild(chart);
        return wrapper;
    }

    function replaceChartBlockContent(wrapper, block, isEditable) {
        const newContent = renderChartBlock(block, isEditable);
        wrapper.replaceWith(newContent);
        return newContent;
    }

    function renderCartesianChart(data) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'chart-svg');
        svg.setAttribute('viewBox', '0 0 520 260');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${data.title || 'Chart'} ${data.chartType} chart`);

        const values = data.values.map((value) => Math.max(0, Number(value) || 0));
        const maxValue = Math.max(...values, 1);
        const plot = { left: 44, top: 18, width: 452, height: 178 };

        const axis = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        axis.setAttribute('d', `M ${plot.left} ${plot.top} V ${plot.top + plot.height} H ${plot.left + plot.width}`);
        axis.setAttribute('class', 'chart-axis');
        svg.appendChild(axis);

        if (data.chartType === 'line') {
            const points = values.map((value, index) => {
                const x = plot.left + (values.length === 1 ? plot.width / 2 : (index / (values.length - 1)) * plot.width);
                const y = plot.top + plot.height - ((value / maxValue) * plot.height);
                return { x, y, value };
            });

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            line.setAttribute('points', points.map((point) => `${point.x},${point.y}`).join(' '));
            line.setAttribute('class', 'chart-line');
            svg.appendChild(line);

            points.forEach((point, index) => {
                const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot.setAttribute('cx', point.x);
                dot.setAttribute('cy', point.y);
                dot.setAttribute('r', '5');
                dot.setAttribute('class', 'chart-point');
                svg.appendChild(dot);
                appendChartValueLabel(svg, point.x, point.y - 10, point.value, data.unit);
                appendChartAxisLabel(svg, point.x, 230, data.labels[index]);
            });
        } else {
            const barWidth = Math.max(18, Math.min(58, plot.width / Math.max(values.length, 1) - 16));
            values.forEach((value, index) => {
                const slotWidth = plot.width / Math.max(values.length, 1);
                const x = plot.left + index * slotWidth + (slotWidth - barWidth) / 2;
                const height = (value / maxValue) * plot.height;
                const y = plot.top + plot.height - height;

                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', x);
                rect.setAttribute('y', y);
                rect.setAttribute('width', barWidth);
                rect.setAttribute('height', Math.max(2, height));
                rect.setAttribute('rx', '5');
                rect.setAttribute('class', 'chart-bar');
                svg.appendChild(rect);

                appendChartValueLabel(svg, x + barWidth / 2, y - 8, value, data.unit);
                appendChartAxisLabel(svg, x + barWidth / 2, 230, data.labels[index]);
            });
        }

        return svg;
    }

    function appendChartValueLabel(svg, x, y, value, unit) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', Math.max(12, y));
        text.setAttribute('class', 'chart-value-label');
        text.textContent = `${value}${unit || ''}`;
        svg.appendChild(text);
    }

    function appendChartAxisLabel(svg, x, y, label) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y);
        text.setAttribute('class', 'chart-axis-label');
        text.textContent = String(label || '').slice(0, 16);
        svg.appendChild(text);
    }

    function renderPieChart(data) {
        const total = data.values.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0) || 1;
        const pie = document.createElement('div');
        pie.className = 'chart-pie-wrap';

        let cursor = 0;
        const segments = data.values.map((value, index) => {
            const amount = Math.max(0, Number(value) || 0);
            const start = (cursor / total) * 360;
            cursor += amount;
            const end = (cursor / total) * 360;
            const color = `var(--chart-color-${(index % 6) + 1})`;
            return `${color} ${start}deg ${end}deg`;
        });

        const disk = document.createElement('div');
        disk.className = 'chart-pie';
        disk.style.background = `conic-gradient(${segments.join(', ')})`;
        pie.appendChild(disk);

        const legend = document.createElement('div');
        legend.className = 'chart-legend';
        data.labels.forEach((label, index) => {
            const item = document.createElement('div');
            item.className = 'chart-legend-item';
            item.innerHTML = `<span class="chart-legend-swatch chart-swatch-${(index % 6) + 1}"></span><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(data.values[index] ?? 0))}${escapeHtml(data.unit || '')}</strong>`;
            legend.appendChild(item);
        });
        pie.appendChild(legend);

        return pie;
    }
    
    function normalizeMermaidContentV2(content) {
        const normalized = (content && typeof content === 'object')
            ? { ...content }
            : { text: typeof content === 'string' ? content : '', diagramType: 'flowchart' };

        normalized.text = typeof normalized.text === 'string' ? normalized.text : '';
        normalized.diagramType = normalized.diagramType || detectMermaidDiagramTypeV2(normalized.text);
        normalized._showEditor = Boolean(normalized._showEditor);
        return normalized;
    }

    function detectMermaidDiagramTypeV2(text = '') {
        const firstLine = String(text || '').trim().split('\n')[0]?.toLowerCase() || '';
        if (firstLine.startsWith('sequencediagram')) return 'sequence';
        if (firstLine.startsWith('classdiagram')) return 'class';
        if (firstLine.startsWith('statediagram')) return 'state';
        if (firstLine.startsWith('erdiagram')) return 'er';
        if (firstLine.startsWith('gantt')) return 'gantt';
        if (firstLine.startsWith('pie')) return 'pie';
        if (firstLine.startsWith('mindmap')) return 'mindmap';
        if (firstLine.startsWith('gitgraph')) return 'gitgraph';
        return 'flowchart';
    }

    function extractMermaidCodeV2(responseText, fallback = '') {
        const text = extractResponseText(responseText).trim();
        if (!text) return fallback;

        const mermaidFence = text.match(/```mermaid\s*([\s\S]*?)```/i);
        if (mermaidFence?.[1]) {
            return mermaidFence[1].trim();
        }

        const genericFence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
        if (genericFence?.[1]) {
            return genericFence[1].trim();
        }

        return text;
    }

    function showBlocksToastV2(message, type = 'info') {
        if (window.Sidebar?.showToast) {
            window.Sidebar.showToast(message, type);
            return;
        }

        console.log(`[Blocks:${type}] ${message}`);
    }

    function getMermaidFilenameV2(baseName = 'diagram', extension = 'mmd') {
        return `${String(baseName || 'diagram').replace(/\.[a-z0-9]+$/i, '')}.${extension}`;
    }

    function downloadBlobV2(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async function svgMarkupToImageV2(svgMarkup) {
        const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);

        try {
            const image = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Failed to load Mermaid SVG'));
                img.src = svgUrl;
            });
            return image;
        } finally {
            URL.revokeObjectURL(svgUrl);
        }
    }

    async function createMermaidPdfBlobV2(diagramCode) {
        if (!window.PDFLib?.PDFDocument) {
            throw new Error('PDF export library is not available');
        }
        if (typeof mermaid === 'undefined') {
            throw new Error('Mermaid is not available');
        }

        const renderId = `mermaid-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await mermaid.render(renderId, String(diagramCode || '').trim());
        const image = await svgMarkupToImageV2(result.svg);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(image.naturalWidth || image.width || 1200));
        canvas.height = Math.max(1, Math.ceil(image.naturalHeight || image.height || 800));

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        const pngDataUrl = canvas.toDataURL('image/png');
        const pngBytes = await fetch(pngDataUrl).then((response) => response.arrayBuffer());

        const pdfDoc = await window.PDFLib.PDFDocument.create();
        const pngImage = await pdfDoc.embedPng(pngBytes);
        const margin = 36;
        const pageWidth = Math.max(612, canvas.width + margin * 2);
        const pageHeight = Math.max(792, canvas.height + margin * 2);
        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const scale = Math.min(
            (pageWidth - margin * 2) / pngImage.width,
            (pageHeight - margin * 2) / pngImage.height,
            1,
        );

        page.drawImage(pngImage, {
            x: (pageWidth - (pngImage.width * scale)) / 2,
            y: (pageHeight - (pngImage.height * scale)) / 2,
            width: pngImage.width * scale,
            height: pngImage.height * scale,
        });

        const pdfBytes = await pdfDoc.save({
            updateFieldAppearances: false,
            useObjectStreams: false,
        });

        return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    async function downloadMermaidSourceV2(content, filenameBase = 'diagram') {
        const source = String(content || '').trim();
        if (!source) {
            showBlocksToastV2('Add Mermaid code before downloading.', 'error');
            return;
        }

        downloadBlobV2(
            new Blob([source], { type: 'text/plain;charset=utf-8' }),
            getMermaidFilenameV2(filenameBase, 'mmd'),
        );
        showBlocksToastV2('Mermaid source downloaded', 'success');
    }

    async function downloadMermaidPdfV2(content, filenameBase = 'diagram') {
        const source = String(content || '').trim();
        if (!source) {
            showBlocksToastV2('Add Mermaid code before exporting.', 'error');
            return;
        }

        try {
            const pdfBlob = await createMermaidPdfBlobV2(source);
            downloadBlobV2(pdfBlob, getMermaidFilenameV2(filenameBase, 'pdf'));
            showBlocksToastV2('Mermaid PDF downloaded', 'success');
        } catch (error) {
            console.error('Mermaid PDF export failed:', error);
            showBlocksToastV2(`Failed to export Mermaid PDF: ${error.message}`, 'error');
        }
    }

    function replaceMermaidWrapperV2(wrapper, block, isEditable) {
        const nextWrapper = renderMermaidBlock(block, isEditable);
        wrapper.replaceWith(nextWrapper);
        if (window.Editor?.savePage) {
            window.Editor.savePage();
        }
        return nextWrapper;
    }

    function showMermaidStatusV2(wrapper, message) {
        wrapper.innerHTML = `
            <div class="ai-block-loading">
                <div class="spinner"></div>
                <span>${escapeHtml(message)}</span>
            </div>
        `;
    }

    function buildMermaidPromptV2({ diagramType, request, currentCode = '' }) {
        const codeContext = currentCode.trim()
            ? `Current Mermaid code:\n\`\`\`mermaid\n${currentCode.trim()}\n\`\`\``
            : 'There is no current Mermaid code yet.';

        return [
            `You are editing a ${diagramType} Mermaid diagram in a block-based notes app.`,
            request,
            codeContext,
            'Return only Mermaid code in a single ```mermaid fenced block.',
            'Do not include explanation outside the code block unless the request explicitly asks for explanation.'
        ].join('\n\n');
    }

    async function requestMermaidDiagramV2(block, wrapper, isEditable, options = {}) {
        const { diagramType, request, currentCode = '' } = options;
        if (!window.Agent?.ask) {
            showBlocksToastV2('AI assistant is not available yet.', 'error');
            return;
        }

        showMermaidStatusV2(wrapper, 'Generating Mermaid diagram...');

        try {
            const response = await window.Agent.ask(buildMermaidPromptV2({
                diagramType,
                request,
                currentCode
            }), {
                hiddenUserMessage: true,
                hiddenAssistantMessage: true
            });
            const diagramCode = extractMermaidCodeV2(response, currentCode).trim();

            if (!diagramCode) {
                throw new Error('The AI response did not include Mermaid code.');
            }

            block.content = {
                ...normalizeMermaidContentV2(block.content),
                text: diagramCode,
                diagramType,
                _showEditor: false
            };

            replaceMermaidWrapperV2(wrapper, block, isEditable);
            window.AgentUI?.renderMessages?.();
            showBlocksToastV2('Diagram updated', 'success');
        } catch (error) {
            console.error('Mermaid AI request failed:', error);
            block.content = {
                ...normalizeMermaidContentV2(block.content),
                diagramType,
                _showEditor: true
            };
            const nextWrapper = replaceMermaidWrapperV2(wrapper, block, isEditable);
            const errorEl = document.createElement('div');
            errorEl.className = 'mermaid-error';
            errorEl.textContent = `Failed to generate Mermaid diagram: ${error.message}`;
            nextWrapper.appendChild(errorEl);
            showBlocksToastV2('Failed to generate Mermaid diagram', 'error');
        }
    }

    async function renderMermaidPreviewV2(container, content) {
        const diagramCode = String(content || '').trim();
        if (!diagramCode) {
            container.innerHTML = '<div class="mermaid-error">Add Mermaid code to preview the diagram.</div>';
            return;
        }

        if (typeof mermaid === 'undefined') {
            container.innerHTML = `
                <pre style="background: var(--bg-tertiary); padding: 12px; border-radius: 4px; overflow-x: auto;">${escapeHtml(diagramCode)}</pre>
                <div style="color: var(--text-muted); margin-top: 8px; font-size: 12px;">Mermaid library not loaded.</div>
            `;
            return;
        }

        const renderId = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        try {
            const result = await mermaid.render(renderId, diagramCode);
            container.innerHTML = result.svg;
            if (typeof result.bindFunctions === 'function') {
                result.bindFunctions(container);
            }
        } catch (error) {
            container.innerHTML = `
                <div class="mermaid-error">Error rendering diagram: ${escapeHtml(error.message)}</div>
                <pre style="background: var(--bg-tertiary); padding: 12px; border-radius: 4px; overflow-x: auto;">${escapeHtml(diagramCode)}</pre>
            `;
        }
    }

    function renderMermaidBlock(block, isEditable = true) {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-content mermaid-block';

        const content = normalizeMermaidContentV2(block.content);
        block.content = content;

        const diagramText = String(content.text || '');
        const isEditing = isEditable && (content._showEditor || !diagramText.trim());

        if (isEditing) {
            const editorCard = document.createElement('div');
            editorCard.className = 'mermaid-card mermaid-empty-state';

            const header = document.createElement('div');
            header.className = 'mermaid-editor-header';
            header.innerHTML = '<strong>Create Mermaid Diagram</strong>';

            const typeSelect = document.createElement('select');
            typeSelect.className = 'mermaid-type-select mermaid-editor-type input';
            typeSelect.innerHTML = `
                <option value="flowchart">Flowchart</option>
                <option value="sequence">Sequence Diagram</option>
                <option value="class">Class Diagram</option>
                <option value="state">State Diagram</option>
                <option value="er">ER Diagram</option>
                <option value="gantt">Gantt</option>
                <option value="pie">Pie</option>
                <option value="mindmap">Mindmap</option>
                <option value="gitgraph">Git Graph</option>
            `;
            typeSelect.value = content.diagramType || 'flowchart';
            header.appendChild(typeSelect);
            editorCard.appendChild(header);

            const input = document.createElement('textarea');
            input.className = 'mermaid-input mermaid-editor input';
            input.value = diagramText;
            input.rows = Math.max(8, Math.min(18, diagramText.split('\n').length + 2));
            input.placeholder = `Describe your ${typeSelect.value} or paste Mermaid code here.\n\nTip: Ask AI to generate Mermaid code directly for this block.`;
            editorCard.appendChild(input);

            const actions = document.createElement('div');
            actions.className = 'mermaid-editor-row';

            const aiBtn = document.createElement('button');
            aiBtn.className = 'btn btn-primary mermaid-cta mermaid-ai-btn';
            aiBtn.textContent = 'AI Generate';
            aiBtn.addEventListener('click', async () => {
                const description = prompt('Describe the diagram you want to generate:', '');
                if (!description) return;

                await requestMermaidDiagramV2(block, wrapper, isEditable, {
                    diagramType: typeSelect.value,
                    currentCode: input.value,
                    request: `Create a ${typeSelect.value} Mermaid diagram for this request: ${description}`
                });
            });

            const templateBtn = document.createElement('button');
            templateBtn.className = 'btn btn-ghost mermaid-action mermaid-action-btn';
            templateBtn.textContent = 'Use Template';
            templateBtn.addEventListener('click', () => {
                input.value = getMermaidTemplate(typeSelect.value);
                input.focus();
            });

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn btn-primary mermaid-action-btn';
            saveBtn.textContent = 'Save Diagram';
            saveBtn.addEventListener('click', () => {
                block.content = {
                    ...content,
                    text: input.value.trim(),
                    diagramType: typeSelect.value,
                    _showEditor: false
                };
                replaceMermaidWrapperV2(wrapper, block, isEditable);
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn btn-ghost mermaid-action mermaid-action-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                block.content = {
                    ...content,
                    diagramType: typeSelect.value,
                    _showEditor: false
                };
                replaceMermaidWrapperV2(wrapper, block, isEditable);
            });

            actions.appendChild(aiBtn);
            actions.appendChild(templateBtn);
            actions.appendChild(saveBtn);
            actions.appendChild(cancelBtn);
            editorCard.appendChild(actions);
            wrapper.appendChild(editorCard);

            setTimeout(() => input.focus(), 0);
            return wrapper;
        }

        const makeToolbarButton = (label, handler) => {
            const button = document.createElement('button');
            button.className = 'btn btn-ghost mermaid-action mermaid-action-btn';
            button.textContent = label;
            button.addEventListener('click', handler);
            return button;
        };

        const toolbar = document.createElement('div');
        toolbar.className = 'mermaid-toolbar mermaid-editor-toolbar';

        const diagramLabel = document.createElement('span');
        diagramLabel.className = 'chip';
        diagramLabel.textContent = `${content.diagramType} diagram`;
        toolbar.appendChild(diagramLabel);

        toolbar.appendChild(makeToolbarButton('Improve', async () => {
            await requestMermaidDiagramV2(block, wrapper, isEditable, {
                diagramType: content.diagramType,
                currentCode: content.text,
                request: 'Improve this Mermaid diagram so it is clearer, cleaner, and more professional.'
            });
        }));

        toolbar.appendChild(makeToolbarButton('Fix', async () => {
            await requestMermaidDiagramV2(block, wrapper, isEditable, {
                diagramType: content.diagramType,
                currentCode: content.text,
                request: 'Fix any Mermaid syntax or structural issues in this diagram.'
            });
        }));

        toolbar.appendChild(makeToolbarButton('Expand', async () => {
            await requestMermaidDiagramV2(block, wrapper, isEditable, {
                diagramType: content.diagramType,
                currentCode: content.text,
                request: 'Expand this Mermaid diagram with more detail while keeping it valid and readable.'
            });
        }));

        toolbar.appendChild(makeToolbarButton('Explain', async () => {
            await askAIFromDiagram(
                block,
                content.diagramType,
                content.text,
                'Explain what this Mermaid diagram shows and how the flow is structured.'
            );
        }));

        toolbar.appendChild(makeToolbarButton('Download .mmd', async () => {
            await downloadMermaidSourceV2(content.text, `${content.diagramType}-diagram-${Date.now()}`);
        }));

        toolbar.appendChild(makeToolbarButton('Download PDF', async () => {
            await downloadMermaidPdfV2(content.text, `${content.diagramType}-diagram-${Date.now()}`);
        }));

        if (isEditable) {
            toolbar.appendChild(makeToolbarButton('Edit', () => {
                block.content = { ...content, _showEditor: true };
                replaceMermaidWrapperV2(wrapper, block, isEditable);
            }));
        }

        wrapper.appendChild(toolbar);

        const diagramContainer = document.createElement('div');
        diagramContainer.className = 'mermaid-diagram-container mermaid-preview';
        diagramContainer.innerHTML = '<div class="ai-block-loading"><div class="spinner"></div><span>Rendering diagram...</span></div>';
        wrapper.appendChild(diagramContainer);

        setTimeout(() => {
            renderMermaidPreviewV2(diagramContainer, content.text);
        }, 0);

        return wrapper;
    }
    async function persistAIImageSelection(content = {}, sourceUrl = '') {
        const normalizedSourceUrl = String(sourceUrl || '').trim();
        if (!normalizedSourceUrl) {
            return {
                imageUrl: null,
                imageAssetId: null,
                resolvedImageUrl: null,
            };
        }

        if (!window.Storage?.saveImageAsset) {
            return {
                imageUrl: normalizedSourceUrl,
                imageAssetId: content.imageAssetId || null,
                resolvedImageUrl: normalizedSourceUrl,
            };
        }

        const assetUrl = await window.Storage.saveImageAsset(normalizedSourceUrl);
        const storedImageUrl = assetUrl || normalizedSourceUrl;
        const isStoredAsset = String(storedImageUrl).startsWith('asset://');

        return {
            imageUrl: storedImageUrl,
            imageAssetId: isStoredAsset
                ? String(storedImageUrl).slice('asset://'.length)
                : (content.imageAssetId || null),
            resolvedImageUrl: isStoredAsset ? normalizedSourceUrl : storedImageUrl,
        };
    }

    function askAIFromDiagram(block, diagramType, currentCode = '', customPrompt = '') {
        const promptText = customPrompt
            ? [
                customPrompt,
                'Use the current Mermaid diagram and page context in your answer.',
                `Diagram type: ${diagramType}`,
                `\`\`\`mermaid\n${currentCode || `[empty ${diagramType} diagram]`}\n\`\`\``
            ].join('\n\n')
            : `Help me create a ${diagramType} Mermaid diagram for this page. Return Mermaid code in a single \`\`\`mermaid block.`;

        if (window.AgentUI?.openWithPrompt) {
            window.AgentUI.openWithPrompt(promptText, { send: Boolean(customPrompt) });
            return;
        }

        if (window.Agent?.ask) {
            window.Agent.ask(promptText).then(() => {
                window.AgentUI?.renderMessages?.();
            });
            return;
        }

        alert('AI assistant is not available right now.');
    }

    /**
     * Format content with inline formatting
     */
    function formatContent(text, formatting = {}) {
        // Handle non-string inputs
        if (typeof text !== 'string') {
            if (text === null || text === undefined) return '';
            text = extractResponseText(text);
            if (typeof text !== 'string') {
                text = String(text);
            }
        }
        
        // Escape HTML
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        if (formatting.highlights && Array.isArray(formatting.highlights)) {
            formatting.highlights.forEach((highlight) => {
                const needle = typeof highlight === 'string' ? highlight : highlight?.text;
                if (!needle) return;

                const escapedNeedle = String(needle)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                if (!escapedNeedle) return;

                const color = String(highlight?.color || 'yellow').replace(/[^a-z0-9_-]/gi, '') || 'yellow';
                const pattern = new RegExp(escapedNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                html = html.replace(pattern, `<mark class="inline-highlight inline-highlight-${color}">${escapedNeedle}</mark>`);
            });
        }

        // Apply formatting
        if (formatting.bold) {
            html = `<strong>${html}</strong>`;
        }
        if (formatting.italic) {
            html = `<em>${html}</em>`;
        }
        if (formatting.underline) {
            html = `<u>${html}</u>`;
        }
        if (formatting.strikethrough) {
            html = `<s>${html}</s>`;
        }
        if (formatting.code) {
            html = `<code>${html}</code>`;
        }
        
        // Convert URLs to links
        html = html.replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
        );
        
        return html;
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
     * Get all available block types
     */
    function getBlockTypes() {
        return BLOCK_TYPES;
    }
    
    /**
     * Get emojis for picker
     */
    function getEmojis(category = 'recent') {
        return EMOJIS[category] || EMOJIS.recent;
    }
    
    /**
     * Get emoji categories
     */
    function getEmojiCategories() {
        return Object.keys(EMOJIS);
    }
    
    /**
     * Parse markdown-style shortcuts
     */
    function parseMarkdown(text) {
        const shortcuts = [
            { pattern: /^#\s+(.+)$/, type: 'heading_1' },
            { pattern: /^##\s+(.+)$/, type: 'heading_2' },
            { pattern: /^###\s+(.+)$/, type: 'heading_3' },
            { pattern: /^[-*]\s+(.+)$/, type: 'bulleted_list' },
            { pattern: /^\d+\.\s+(.+)$/, type: 'numbered_list' },
            { pattern: /^\[([ x])\]\s*(.*)$/i, type: 'todo', parse: (m) => ({ text: m[2], checked: m[1].toLowerCase() === 'x' }) },
            { pattern: /^>\s+(.+)$/, type: 'quote' },
            { pattern: /^---+/, type: 'divider' },
            { pattern: /^```(.*)/, type: 'code', parse: (m) => ({ text: '', language: m[1] || 'plain' }) },
            { pattern: /^\$\$\s*$/, type: 'math', parse: () => ({ text: '', displayMode: true }) }
        ];
        
        for (const shortcut of shortcuts) {
            const match = text.match(shortcut.pattern);
            if (match) {
                if (shortcut.parse) {
                    return { type: shortcut.type, content: shortcut.parse(match) };
                }
                return { type: shortcut.type, content: match[1] };
            }
        }
        
        return null;
    }
    
    return {
        createBlock,
        getBlockTypes,
        getEmojis,
        getEmojiCategories,
        parseMarkdown,
        formatContent,
        getDefaultModel,
        getDefaultImageModel,
        extractResponseText,
        normalizeCalloutContent,
        normalizeDatabaseContent,
        // Expose render functions for direct use
        render: {
            text: renderTextBlock,
            heading_1: renderTextBlock,
            heading_2: renderTextBlock,
            heading_3: renderTextBlock,
            bulleted_list: renderListBlock,
            numbered_list: renderListBlock,
            todo: renderTodoBlock,
            toggle: renderToggleBlock,
            quote: renderTextBlock,
            divider: renderDividerBlock,
            callout: renderCalloutBlock,
            code: renderCodeBlock,
            math: renderMathBlock,
            mermaid: renderMermaidBlock,
            image: renderImageBlock,
            ai_image: renderAIImageBlock,
            bookmark: renderBookmarkBlock,
            database: renderDatabaseBlock,
            chart: renderChartBlock,
            ai: renderAIBlock
        }
    };
})();

window.Blocks = Blocks;
