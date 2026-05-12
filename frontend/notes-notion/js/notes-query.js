/**
 * NotesQuery - agent-friendly projections and patch plans for the block editor.
 *
 * The editor keeps the page as nested blocks. This module gives agents smaller
 * views over that tree so they can read or edit only the layer they need.
 */
(function(root) {
    const TEXT_BLOCK_TYPES = new Set([
        'text',
        'heading_1',
        'heading_2',
        'heading_3',
        'bulleted_list',
        'numbered_list',
        'todo',
        'toggle',
        'quote',
        'callout',
        'code',
        'math',
        'mermaid',
        'ai',
    ]);

    const STYLE_KEYS = ['color', 'textColor', 'fontFamily', 'fontSize'];

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function truncateText(value, limit = 120) {
        const text = normalizeText(value);
        if (!limit || text.length <= limit) return text;
        return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function getHeadingLevel(block) {
        const match = String(block?.type || '').match(/^heading_(\d)$/);
        return match ? Number(match[1]) : null;
    }

    function extractText(block) {
        if (!block) return '';
        const content = block.content;

        if (typeof content === 'string') {
            return content;
        }

        if (!content || typeof content !== 'object') {
            return '';
        }

        if (block.type === 'todo') return content.text || '';
        if (block.type === 'callout') return content.text || '';
        if (block.type === 'code') return content.text || content.code || '';
        if (block.type === 'math') return content.text || content.latex || '';
        if (block.type === 'mermaid') return content.text || content.diagram || '';
        if (block.type === 'ai') return content.prompt || content.result || '';
        if (block.type === 'image' || block.type === 'ai_image') {
            return content.caption || content.prompt || content.url || content.imageUrl || content.downloadUrl || '';
        }
        if (block.type === 'bookmark') {
            return content.title || content.description || content.url || '';
        }
        if (block.type === 'database') {
            const columns = Array.isArray(content.columns) ? content.columns : [];
            const rows = Array.isArray(content.rows) ? content.rows.flat() : [];
            return [...columns, ...rows].join(' ');
        }
        if (block.type === 'chart') {
            const labels = Array.isArray(content.labels) ? content.labels : [];
            const values = Array.isArray(content.values) ? content.values : [];
            return [
                content.title || '',
                ...labels.map((label, index) => `${label} ${values[index] ?? ''}`),
            ].join(' ');
        }

        const candidates = [
            content.text,
            content.prompt,
            content.result,
            content.title,
            content.description,
            content.caption,
            content.url,
        ];

        return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim()) || '';
    }

    function flattenBlocks(blocks = [], options = {}) {
        const entries = [];
        let order = 0;

        function walk(blockList = [], state = {}) {
            let headingStack = Array.isArray(state.headingStack) ? state.headingStack.slice() : [];
            blockList.forEach((block, siblingIndex) => {
                if (!block || typeof block !== 'object') return;

                const headingLevel = getHeadingLevel(block);
                const text = extractText(block);

                if (headingLevel) {
                    headingStack = headingStack.filter((heading) => heading.level < headingLevel);
                    headingStack.push({
                        id: block.id,
                        type: block.type,
                        level: headingLevel,
                        text: normalizeText(text),
                    });
                }

                const sectionStack = headingStack.slice();
                const entry = {
                    id: block.id,
                    type: block.type || 'text',
                    text,
                    textPreview: truncateText(text, options.previewLength || 140),
                    depth: state.depth || 0,
                    parentId: state.parentId || null,
                    siblingIndex,
                    order: order++,
                    path: [...(state.path || []), block.id],
                    hasChildren: Array.isArray(block.children) && block.children.length > 0,
                    childCount: Array.isArray(block.children) ? block.children.length : 0,
                    color: block.color || null,
                    textColor: block.textColor || null,
                    fontFamily: block.fontFamily || null,
                    fontSize: block.fontSize || null,
                    headingLevel,
                    sectionIds: sectionStack.map((heading) => heading.id),
                    sectionPath: sectionStack.map((heading) => heading.text).filter(Boolean),
                    sectionHeadingId: sectionStack.length ? sectionStack[sectionStack.length - 1].id : null,
                    sectionHeadingText: sectionStack.length ? sectionStack[sectionStack.length - 1].text : '',
                    source: block,
                };

                entries.push(entry);

                if (Array.isArray(block.children) && block.children.length > 0) {
                    walk(block.children, {
                        depth: (state.depth || 0) + 1,
                        parentId: block.id,
                        path: entry.path,
                        headingStack: sectionStack,
                    });
                }
            });
        }

        walk(blocks, { depth: 0, parentId: null, path: [], headingStack: [] });
        return entries;
    }

    function buildIndex(page = null, options = {}) {
        const blocks = flattenBlocks(page?.blocks || [], options);
        const blockById = {};
        blocks.forEach((entry) => {
            blockById[entry.id] = entry;
        });

        const outline = blocks.filter((entry) => entry.headingLevel);
        const sections = outline.map((heading) => {
            const sectionBlocks = blocks.filter((entry) => entry.sectionIds.includes(heading.id));
            return {
                id: heading.id,
                type: heading.type,
                level: heading.headingLevel,
                text: heading.text,
                blockIds: sectionBlocks.map((entry) => entry.id),
                blockCount: sectionBlocks.length,
                wordCount: countWords(sectionBlocks.map((entry) => entry.text).join(' ')),
            };
        });
        const textBlocks = blocks.filter((entry) => TEXT_BLOCK_TYPES.has(entry.type) && normalizeText(entry.text));
        const fullText = textBlocks.map((entry) => entry.text).join('\n');

        return {
            pageId: page?.id || null,
            title: page?.title || 'Untitled',
            icon: page?.icon || '',
            updatedAt: page?.updatedAt || null,
            defaultModel: page?.defaultModel || null,
            hasCover: Boolean(page?.cover),
            properties: Array.isArray(page?.properties) ? page.properties : [],
            blocks,
            blockById,
            outline,
            sections,
            textBlocks,
            fullText,
            blockCount: blocks.length,
            wordCount: countWords(fullText),
            readingTime: Math.max(1, Math.ceil(countWords(fullText) / 200)),
        };
    }

    function countWords(value = '') {
        return normalizeText(value).split(/\s+/).filter(Boolean).length;
    }

    function matchesText(entry, needle) {
        const normalizedNeedle = normalizeText(needle).toLowerCase();
        if (!normalizedNeedle) return true;
        return normalizeText(entry.text).toLowerCase().includes(normalizedNeedle);
    }

    function parseGrepQuery(input = '') {
        const query = {
            words: [],
        };
        const pattern = /(\w+):"([^"]+)"|(\w+):(\S+)|"([^"]+)"|(\S+)/g;
        let match;

        while ((match = pattern.exec(String(input || '')))) {
            const key = match[1] || match[3] || null;
            const value = match[2] || match[4] || match[5] || match[6] || '';
            if (!value) continue;

            if (!key) {
                query.words.push(value);
                continue;
            }

            const normalizedKey = key.toLowerCase();
            if (normalizedKey === 'type') query.type = value;
            else if (normalizedKey === 'color') query.color = value;
            else if (normalizedKey === 'textcolor' || normalizedKey === 'text_color') query.textColor = value;
            else if (normalizedKey === 'section') query.sectionHeading = value;
            else if (normalizedKey === 'id' || normalizedKey === 'block') query.blockIds = [value];
            else query.words.push(value);
        }

        return query;
    }

    function query(pageOrIndex = null, spec = {}) {
        const index = pageOrIndex?.blocks?.[0]?.source ? pageOrIndex : buildIndex(pageOrIndex);
        const parsedGrep = spec.grep || spec.query ? parseGrepQuery(spec.grep || spec.query) : {};
        const where = {
            ...parsedGrep,
            ...(spec.where || {}),
        };
        let entries = index.blocks.slice();

        const typeFilter = where.type || spec.type;
        const types = where.types || spec.types || (typeFilter ? [typeFilter] : null);
        if (Array.isArray(types) && types.length > 0) {
            const normalizedTypes = types.map((type) => String(type).toLowerCase());
            entries = entries.filter((entry) => normalizedTypes.includes(String(entry.type).toLowerCase()));
        }

        if (Array.isArray(where.blockIds) && where.blockIds.length > 0) {
            const ids = new Set(where.blockIds.map(String));
            entries = entries.filter((entry) => ids.has(String(entry.id)));
        }

        if (where.textIncludes) {
            entries = entries.filter((entry) => matchesText(entry, where.textIncludes));
        }

        const words = Array.isArray(where.words) ? where.words : [];
        if (words.length > 0) {
            entries = entries.filter((entry) => words.every((word) => matchesText(entry, word)));
        }

        if (where.textMatches) {
            const regexp = where.textMatches instanceof RegExp
                ? where.textMatches
                : new RegExp(escapeRegExp(where.textMatches), 'i');
            entries = entries.filter((entry) => regexp.test(entry.text));
        }

        if (where.color !== undefined) {
            entries = entries.filter((entry) => String(entry.color || '').toLowerCase() === String(where.color || '').toLowerCase());
        }

        if (where.textColor !== undefined) {
            entries = entries.filter((entry) => String(entry.textColor || '').toLowerCase() === String(where.textColor || '').toLowerCase());
        }

        if (where.headingLevel) {
            entries = entries.filter((entry) => Number(entry.headingLevel) === Number(where.headingLevel));
        }

        if (where.sectionBlockId || where.sectionHeadingId) {
            const sectionId = where.sectionBlockId || where.sectionHeadingId;
            entries = entries.filter((entry) => entry.sectionIds.includes(sectionId));
        }

        if (where.sectionHeading) {
            const sectionNeedle = normalizeText(where.sectionHeading).toLowerCase();
            entries = entries.filter((entry) =>
                entry.sectionPath.some((heading) => heading.toLowerCase().includes(sectionNeedle))
            );
        }

        if (where.hasText === true) {
            entries = entries.filter((entry) => normalizeText(entry.text));
        }

        const limit = Number(spec.limit || where.limit || 0);
        if (limit > 0) {
            entries = entries.slice(0, limit);
        }

        return selectFields(entries, spec.select);
    }

    function selectFields(entries, select = null) {
        if (!Array.isArray(select) || select.length === 0 || select.includes('*')) {
            return entries;
        }

        return entries.map((entry) => {
            const selected = {};
            select.forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(entry, key)) {
                    selected[key] = entry[key];
                }
            });
            return selected;
        });
    }

    function createProjection(pageOrIndex = null, options = {}) {
        const index = pageOrIndex?.blocks?.[0]?.source ? pageOrIndex : buildIndex(pageOrIndex);
        const mode = String(options.mode || 'agent_context').toLowerCase();

        if (mode === 'flat_text') {
            return index.textBlocks.map((entry) => entry.text).join('\n');
        }

        if (mode === 'outline') {
            return index.outline.map((entry) => ({
                id: entry.id,
                type: entry.type,
                level: entry.headingLevel,
                text: entry.text,
                depth: entry.depth,
            }));
        }

        if (mode === 'styles' || mode === 'style_table') {
            return index.blocks.map((entry) => ({
                id: entry.id,
                type: entry.type,
                text: entry.textPreview,
                color: entry.color,
                textColor: entry.textColor,
                fontFamily: entry.fontFamily,
                fontSize: entry.fontSize,
            }));
        }

        if (mode === 'sections') {
            return index.sections;
        }

        if (mode === 'grep') {
            return query(index, {
                grep: options.grep || options.query || '',
                select: options.select || ['id', 'type', 'textPreview', 'sectionHeadingText', 'color', 'textColor'],
                limit: options.limit || 50,
            });
        }

        const maxBlocks = Number(options.maxBlocks || 80);
        return {
            title: index.title,
            pageId: index.pageId,
            blockCount: index.blockCount,
            wordCount: index.wordCount,
            readingTime: index.readingTime,
            outline: createProjection(index, { mode: 'outline' }),
            sections: index.sections.map((section) => ({
                id: section.id,
                level: section.level,
                text: section.text,
                blockCount: section.blockCount,
                wordCount: section.wordCount,
            })),
            blocks: index.blocks.slice(0, maxBlocks).map((entry) => ({
                id: entry.id,
                type: entry.type,
                text: entry.textPreview,
                depth: entry.depth,
                parentId: entry.parentId,
                sectionHeadingId: entry.sectionHeadingId,
                sectionHeadingText: entry.sectionHeadingText,
                color: entry.color,
                textColor: entry.textColor,
                fontFamily: entry.fontFamily,
                fontSize: entry.fontSize,
            })),
        };
    }

    function buildPageContext(page = null, options = {}) {
        const index = buildIndex(page, options);
        return {
            title: index.title,
            icon: index.icon,
            pageId: index.pageId,
            blocks: index.blocks.map((entry) => ({
                id: entry.id,
                type: entry.type,
                content: entry.text,
                depth: entry.depth,
                hasChildren: entry.hasChildren,
                color: entry.color,
                textColor: entry.textColor,
                fontFamily: entry.fontFamily,
                fontSize: entry.fontSize,
                sectionHeadingId: entry.sectionHeadingId,
                sectionHeadingText: entry.sectionHeadingText,
            })),
            outline: index.outline.map((entry) => ({
                id: entry.id,
                type: entry.type,
                content: entry.text,
                depth: entry.depth,
                hasChildren: entry.hasChildren,
                color: entry.color,
                textColor: entry.textColor,
            })),
            sections: index.sections,
            blockCount: index.blockCount,
            wordCount: index.wordCount,
            readingTime: index.readingTime,
            lastUpdated: index.updatedAt,
            defaultModel: index.defaultModel,
            hasCover: index.hasCover,
            properties: index.properties,
            projections: {
                agentContext: createProjection(index, { mode: 'agent_context' }),
                styles: createProjection(index, { mode: 'styles' }),
            },
        };
    }

    function createBulkUpdateActions(pageOrIndex = null, spec = {}, updates = {}) {
        const entries = query(pageOrIndex, {
            ...spec,
            select: ['id', 'type', 'text', 'color', 'textColor', 'fontFamily', 'fontSize'],
        });

        return entries.map((entry) => {
            const action = {
                op: 'update_block',
                blockId: entry.id,
            };

            if (Object.prototype.hasOwnProperty.call(updates, 'type')) {
                action.type = updates.type;
                action.content = Object.prototype.hasOwnProperty.call(updates, 'content')
                    ? updates.content
                    : entry.text;
            } else if (Object.prototype.hasOwnProperty.call(updates, 'content')) {
                action.content = updates.content;
            }

            return {
                ...action,
                ...STYLE_KEYS.reduce((acc, key) => {
                    if (Object.prototype.hasOwnProperty.call(updates, key)) {
                        acc[key] = updates[key];
                    }
                    return acc;
                }, {}),
            };
        });
    }

    function createHeadingLevelActions(pageOrIndex = null, fromLevel, toLevel) {
        return createBulkUpdateActions(
            pageOrIndex,
            { where: { headingLevel: fromLevel } },
            { type: `heading_${toLevel}` },
        );
    }

    function createHeaderColorActions(pageOrIndex = null, updates = {}) {
        const headingTypes = ['heading_1', 'heading_2', 'heading_3'];
        return createBulkUpdateActions(pageOrIndex, { types: headingTypes }, updates);
    }

    function createSectionStyleActions(pageOrIndex = null, sectionHeading, updates = {}) {
        return createBulkUpdateActions(
            pageOrIndex,
            { where: { sectionHeading } },
            updates,
        );
    }

    const api = {
        buildIndex,
        buildPageContext,
        createProjection,
        query,
        grep: (pageOrIndex, input = '', options = {}) => query(pageOrIndex, { ...options, grep: input }),
        parseGrepQuery,
        flattenBlocks,
        extractText,
        getHeadingLevel,
        createBulkUpdateActions,
        createHeadingLevelActions,
        createHeaderColorActions,
        createSectionStyleActions,
    };

    root.NotesQuery = api;
    root.NotesPatches = {
        bulkUpdate: createBulkUpdateActions,
        headingLevel: createHeadingLevelActions,
        headerColor: createHeaderColorActions,
        sectionStyle: createSectionStyleActions,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
