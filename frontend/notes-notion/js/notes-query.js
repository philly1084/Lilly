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

    const SENTENCE_BLOCK_TYPES = new Set(
        Array.from(TEXT_BLOCK_TYPES).filter((type) => !['code', 'math', 'mermaid'].includes(type))
    );

    const STYLE_KEYS = ['color', 'textColor', 'fontFamily', 'fontSize', 'fontWeight', 'textAlign', 'formatting'];
    const PAGE_SEQUENCE_COLORS = ['blue', 'teal', 'green', 'amber', 'orange', 'rose', 'purple', 'indigo'];
    const CONCEPT_STOP_WORDS = new Set([
        'about',
        'after',
        'again',
        'against',
        'also',
        'because',
        'before',
        'being',
        'between',
        'block',
        'blocks',
        'chart',
        'could',
        'detail',
        'details',
        'diagram',
        'each',
        'else',
        'from',
        'have',
        'into',
        'main',
        'make',
        'mermaid',
        'more',
        'note',
        'notes',
        'only',
        'other',
        'page',
        'part',
        'phase',
        'process',
        'section',
        'sections',
        'should',
        'step',
        'steps',
        'that',
        'their',
        'there',
        'these',
        'this',
        'through',
        'when',
        'where',
        'which',
        'with',
        'would',
    ]);

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeConceptKey(value) {
        return normalizeText(value)
            .toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function truncateText(value, limit = 120) {
        const text = normalizeText(value);
        if (!limit || text.length <= limit) return text;
        return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function uniqueStrings(values = []) {
        return Array.from(new Set(values.filter(Boolean).map(String)));
    }

    function splitSentences(value = '') {
        const source = String(value || '');
        const sentences = [];
        const pattern = /[^.!?\n]+(?:[.!?]+["')\]]*|(?=\n|$))/g;
        let match;

        while ((match = pattern.exec(source))) {
            const raw = match[0];
            const exactText = raw.trim();
            if (!exactText) continue;

            const leadingOffset = raw.search(/\S/);
            const start = match.index + (leadingOffset >= 0 ? leadingOffset : 0);
            sentences.push({
                sentenceIndex: sentences.length,
                text: normalizeText(exactText),
                exactText,
                start,
                end: start + exactText.length,
            });
        }

        if (!sentences.length) {
            const exactText = source.trim();
            if (exactText) {
                sentences.push({
                    sentenceIndex: 0,
                    text: normalizeText(exactText),
                    exactText,
                    start: source.search(/\S/),
                    end: source.search(/\S/) + exactText.length,
                });
            }
        }

        return sentences;
    }

    function summarizeCounts(values = [], limit = 6) {
        const counts = {};
        values.forEach((value) => {
            const key = String(value || '').trim().toLowerCase();
            if (!key || key === 'default') return;
            counts[key] = (counts[key] || 0) + 1;
        });

        return Object.entries(counts)
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, limit)
            .map(([value, count]) => ({ value, count }));
    }

    function extractConcepts(value = '', options = {}) {
        const words = normalizeConceptKey(value)
            .split(/\s+/)
            .filter((word) =>
                word
                && word.length >= 3
                && !CONCEPT_STOP_WORDS.has(word)
                && !/^\d+$/.test(word)
            );

        const concepts = [];
        if (options.includePhrase && words.length >= 2 && words.length <= 7) {
            concepts.push(words.join(' '));
        }

        words.forEach((word) => {
            if (word.length >= 4) concepts.push(word);
        });

        for (let index = 0; index < words.length - 1; index += 1) {
            const left = words[index];
            const right = words[index + 1];
            if (left.length >= 4 && right.length >= 4) {
                concepts.push(`${left} ${right}`);
            }
        }

        return uniqueStrings(concepts).slice(0, options.limit || 10);
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

    function getHighlights(block) {
        const highlights = block?.formatting?.highlights;
        if (!Array.isArray(highlights)) return [];
        return highlights
            .map((highlight) => {
                if (typeof highlight === 'string') {
                    return { text: highlight, color: 'yellow' };
                }
                if (!highlight || typeof highlight !== 'object') return null;
                return {
                    text: normalizeText(highlight.text || highlight.targetText || highlight.findText || ''),
                    color: normalizeText(highlight.color || highlight.highlightColor || 'yellow').toLowerCase() || 'yellow',
                };
            })
            .filter((highlight) => highlight && highlight.text);
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
                    fontWeight: block.fontWeight || null,
                    textAlign: block.textAlign || null,
                    highlights: getHighlights(block),
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
            else if (normalizedKey === 'font' || normalizedKey === 'fontfamily' || normalizedKey === 'font_family') query.fontFamily = value;
            else if (normalizedKey === 'size' || normalizedKey === 'fontsize' || normalizedKey === 'font_size') query.fontSize = value;
            else if (normalizedKey === 'weight' || normalizedKey === 'fontweight' || normalizedKey === 'font_weight') query.fontWeight = value;
            else if (normalizedKey === 'align' || normalizedKey === 'textalign' || normalizedKey === 'text_align') query.textAlign = value;
            else if (normalizedKey === 'highlight' || normalizedKey === 'highlightcolor' || normalizedKey === 'highlight_color') query.highlightColor = value;
            else if (normalizedKey === 'sentence' || normalizedKey === 'sentencetext' || normalizedKey === 'sentence_text') query.sentenceIncludes = value;
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

        if (where.fontFamily !== undefined) {
            entries = entries.filter((entry) => String(entry.fontFamily || '').toLowerCase() === String(where.fontFamily || '').toLowerCase());
        }

        if (where.fontSize !== undefined) {
            entries = entries.filter((entry) => String(entry.fontSize || '').toLowerCase() === String(where.fontSize || '').toLowerCase());
        }

        if (where.fontWeight !== undefined) {
            entries = entries.filter((entry) => String(entry.fontWeight || '').toLowerCase() === String(where.fontWeight || '').toLowerCase());
        }

        if (where.textAlign !== undefined) {
            entries = entries.filter((entry) => String(entry.textAlign || '').toLowerCase() === String(where.textAlign || '').toLowerCase());
        }

        if (where.hasHighlight === true) {
            entries = entries.filter((entry) => entry.highlights.length > 0);
        }

        if (where.highlightColor !== undefined) {
            entries = entries.filter((entry) =>
                entry.highlights.some((highlight) =>
                    String(highlight.color || '').toLowerCase() === String(where.highlightColor || '').toLowerCase()
                )
            );
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

    function buildSentenceIndex(pageOrIndex = null, options = {}) {
        const index = pageOrIndex?.blocks?.[0]?.source ? pageOrIndex : buildIndex(pageOrIndex, options);
        const allowedTypes = options.includeTechnical ? TEXT_BLOCK_TYPES : SENTENCE_BLOCK_TYPES;
        const maxSentencesPerBlock = Number(options.maxSentencesPerBlock || 0);
        const sentences = [];

        index.blocks.forEach((entry) => {
            if (!allowedTypes.has(entry.type) || !normalizeText(entry.text)) return;
            let blockSentences = splitSentences(entry.text);
            if (maxSentencesPerBlock > 0) {
                blockSentences = blockSentences.slice(0, maxSentencesPerBlock);
            }

            blockSentences.forEach((sentence) => {
                sentences.push({
                    id: `${entry.id}:s${sentence.sentenceIndex + 1}`,
                    blockId: entry.id,
                    type: entry.type,
                    sentenceIndex: sentence.sentenceIndex,
                    text: sentence.text,
                    exactText: sentence.exactText,
                    textPreview: truncateText(sentence.text, options.previewLength || 180),
                    start: sentence.start,
                    end: sentence.end,
                    order: entry.order,
                    depth: entry.depth,
                    sectionHeadingId: entry.sectionHeadingId,
                    sectionHeadingText: entry.sectionHeadingText,
                    sectionPath: entry.sectionPath,
                    highlights: entry.highlights,
                });
            });
        });

        return sentences;
    }

    function findSentences(pageOrIndex = null, spec = {}) {
        const index = pageOrIndex?.blocks?.[0]?.source ? pageOrIndex : buildIndex(pageOrIndex);
        const normalizedSpec = typeof spec === 'string' ? { query: spec } : { ...(spec || {}) };
        const parsedGrep = normalizedSpec.grep || normalizedSpec.query
            ? parseGrepQuery(normalizedSpec.grep || normalizedSpec.query)
            : {};
        const where = {
            ...parsedGrep,
            ...(normalizedSpec.where || {}),
        };
        const blockEntries = query(index, {
            ...normalizedSpec,
            where,
            limit: 0,
            select: ['id'],
        });
        const allowedBlockIds = new Set(blockEntries.map((entry) => entry.id));
        const caseSensitive = Boolean(normalizedSpec.caseSensitive || where.caseSensitive);
        const sentenceNeedles = [
            ...(Array.isArray(parsedGrep.words) ? parsedGrep.words : []),
            parsedGrep.sentenceIncludes,
            where.sentenceIncludes,
            normalizedSpec.sentenceIncludes,
            normalizedSpec.sentenceText,
            normalizedSpec.sentence,
            normalizedSpec.text,
            normalizedSpec.textIncludes,
            where.textIncludes,
        ].filter(Boolean).map((needle) => normalizeText(needle));
        const minWords = Number(normalizedSpec.minWords || where.minWords || 0);
        const maxWords = Number(normalizedSpec.maxWords || where.maxWords || 0);
        const sentenceIndex = Number.isInteger(where.sentenceIndex)
            ? where.sentenceIndex
            : (Number.isInteger(normalizedSpec.sentenceIndex) ? normalizedSpec.sentenceIndex : null);
        const textMatches = normalizedSpec.textMatches || where.textMatches || null;
        const regexp = textMatches
            ? (textMatches instanceof RegExp ? textMatches : new RegExp(escapeRegExp(textMatches), caseSensitive ? '' : 'i'))
            : null;

        let sentences = buildSentenceIndex(index, normalizedSpec)
            .filter((sentence) => allowedBlockIds.has(sentence.blockId));

        if (sentenceNeedles.length > 0) {
            sentences = sentences.filter((sentence) => {
                const haystack = caseSensitive ? sentence.text : sentence.text.toLowerCase();
                return sentenceNeedles.every((needle) => {
                    const normalizedNeedle = caseSensitive ? needle : needle.toLowerCase();
                    return !normalizedNeedle || haystack.includes(normalizedNeedle);
                });
            });
        }

        if (regexp) {
            sentences = sentences.filter((sentence) => regexp.test(sentence.text));
        }

        if (Number.isInteger(sentenceIndex)) {
            sentences = sentences.filter((sentence) => sentence.sentenceIndex === sentenceIndex);
        }

        if (minWords > 0) {
            sentences = sentences.filter((sentence) => countWords(sentence.text) >= minWords);
        }

        if (maxWords > 0) {
            sentences = sentences.filter((sentence) => countWords(sentence.text) <= maxWords);
        }

        const limit = Number(normalizedSpec.limit || where.limit || 0);
        if (limit > 0) {
            sentences = sentences.slice(0, limit);
        }

        return selectFields(sentences, normalizedSpec.select);
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

    function detectMermaidDiagramType(source = '') {
        const normalized = String(source || '').replace(/\s+/g, '').toLowerCase();
        if (normalized.startsWith('sequencediagram')) return 'sequence';
        if (normalized.startsWith('flowchart') || normalized.startsWith('graph')) return 'flowchart';
        if (normalized.startsWith('statediagram')) return 'state';
        if (normalized.startsWith('classdiagram')) return 'class';
        if (normalized.startsWith('erdiagram')) return 'er';
        if (normalized.startsWith('gantt')) return 'gantt';
        if (normalized.startsWith('mindmap')) return 'mindmap';
        if (normalized.startsWith('gitgraph')) return 'gitgraph';
        return 'mermaid';
    }

    function cleanMermaidNodeId(value = '') {
        return String(value || '')
            .trim()
            .replace(/^["']|["']$/g, '')
            .replace(/[^A-Za-z0-9_.:-]+/g, '')
            .trim();
    }

    function cleanMermaidLabel(value = '') {
        return normalizeText(String(value || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/^["']|["']$/g, ''));
    }

    function parseMermaidNodeToken(token = '') {
        const trimmed = String(token || '').trim().replace(/[;,]+$/g, '');
        const shapedMatch = trimmed.match(/^([A-Za-z][\w.:-]*)\s*(?:\[\[?|\(\(?|\{)\s*["']?(.+?)["']?\s*(?:\]\]?|\)\)?|\})$/);
        if (shapedMatch) {
            return {
                id: cleanMermaidNodeId(shapedMatch[1]),
                label: cleanMermaidLabel(shapedMatch[2]) || cleanMermaidNodeId(shapedMatch[1]),
            };
        }

        const simpleMatch = trimmed.match(/^([A-Za-z][\w.:-]*)/);
        const id = simpleMatch ? cleanMermaidNodeId(simpleMatch[1]) : cleanMermaidNodeId(trimmed);
        return {
            id,
            label: id,
        };
    }

    function parseSequenceParticipant(line = '') {
        const match = String(line || '').trim().match(/^(?:participant|actor)\s+([A-Za-z][\w.:-]*)(?:\s+as\s+(.+))?$/i);
        if (!match) return null;
        const id = cleanMermaidNodeId(match[1]);
        return {
            id,
            label: cleanMermaidLabel(match[2] || id),
        };
    }

    function parseSequenceMessage(line = '', stepIndex = 0) {
        const match = String(line || '').trim().match(/^([A-Za-z][\w.:-]*)\s*(?:-+>>\+?|-+x|-+\)|-+>|=+>>?|-+)\s*([A-Za-z][\w.:-]*)\s*:?\s*(.*)$/);
        if (!match) return null;
        const sourceId = cleanMermaidNodeId(match[1]);
        const targetId = cleanMermaidNodeId(match[2]);
        const label = cleanMermaidLabel(match[3] || `${sourceId} to ${targetId}`);
        return {
            stepIndex: stepIndex + 1,
            type: 'message',
            sourceId,
            targetId,
            label,
            color: PAGE_SEQUENCE_COLORS[stepIndex % PAGE_SEQUENCE_COLORS.length],
        };
    }

    function parseFlowchartStep(line = '', stepIndex = 0) {
        const cleaned = String(line || '').trim();
        if (!cleaned || /^(flowchart|graph)\b/i.test(cleaned)) return null;
        if (/^(classDef|class|style|linkStyle|subgraph|end)\b/i.test(cleaned)) return null;

        const edgeMatch = cleaned.match(/^(.+?)\s*(?:--[^>]*-->|-->|---|==>|-\.->|--x|--o)\s*(.+?)\s*$/);
        if (edgeMatch) {
            const source = parseMermaidNodeToken(edgeMatch[1]);
            const target = parseMermaidNodeToken(edgeMatch[2]);
            if (!source.id || !target.id) return null;
            return {
                stepIndex: stepIndex + 1,
                type: 'edge',
                sourceId: source.id,
                sourceLabel: source.label,
                targetId: target.id,
                targetLabel: target.label,
                label: source.label === target.label ? source.label : `${source.label} -> ${target.label}`,
                color: PAGE_SEQUENCE_COLORS[stepIndex % PAGE_SEQUENCE_COLORS.length],
            };
        }

        const node = parseMermaidNodeToken(cleaned);
        if (!node.id) return null;
        return {
            stepIndex: stepIndex + 1,
            type: 'node',
            sourceId: node.id,
            sourceLabel: node.label,
            label: node.label,
            color: PAGE_SEQUENCE_COLORS[stepIndex % PAGE_SEQUENCE_COLORS.length],
        };
    }

    function buildMermaidMapForEntry(entry) {
        const source = String(entry?.text || '').trim();
        if (!source) return null;

        const lines = source
            .replace(/\r/g, '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const diagramType = detectMermaidDiagramType(source);
        const participants = {};
        const steps = [];

        lines.forEach((line) => {
            const participant = parseSequenceParticipant(line);
            if (participant?.id) {
                participants[participant.id] = participant;
                return;
            }

            if (diagramType === 'sequence') {
                const step = parseSequenceMessage(line, steps.length);
                if (step) steps.push(step);
                return;
            }

            if (diagramType === 'flowchart') {
                const step = parseFlowchartStep(line, steps.length);
                if (step) steps.push(step);
            }
        });

        steps.forEach((step) => {
            if (step.sourceId && !participants[step.sourceId]) {
                participants[step.sourceId] = { id: step.sourceId, label: step.sourceLabel || step.sourceId };
            }
            if (step.targetId && !participants[step.targetId]) {
                participants[step.targetId] = { id: step.targetId, label: step.targetLabel || step.targetId };
            }
        });

        return {
            blockId: entry.id,
            sectionHeadingId: entry.sectionHeadingId,
            sectionHeadingText: entry.sectionHeadingText,
            diagramType,
            participantCount: Object.keys(participants).length,
            participants: Object.values(participants),
            stepCount: steps.length,
            steps,
        };
    }

    function buildEntrySearchText(entry) {
        return normalizeConceptKey([
            entry?.text || '',
            entry?.sectionHeadingText || '',
            ...(Array.isArray(entry?.sectionPath) ? entry.sectionPath : []),
        ].join(' '));
    }

    function scoreEntryForLabel(entry, label = '') {
        const searchText = buildEntrySearchText(entry);
        if (!searchText) return 0;

        const labelKey = normalizeConceptKey(label);
        const labelConcepts = extractConcepts(label, { includePhrase: true, limit: 8 });
        let score = 0;

        if (labelKey && labelKey.length >= 4 && searchText.includes(labelKey)) {
            score += 4;
        }

        labelConcepts.forEach((concept) => {
            if (concept.length >= 3 && searchText.includes(concept)) {
                score += concept.includes(' ') ? 2 : 1;
            }
        });

        if (entry.headingLevel && score > 0) score += 0.5;
        if (String(entry.type || '') === 'callout' && score > 0) score += 0.25;
        return score;
    }

    function findRelatedBlocksForLabels(index, labels = [], excludeIds = []) {
        const excluded = new Set(excludeIds.filter(Boolean).map(String));
        const candidates = [];

        index.blocks.forEach((entry) => {
            if (!entry?.id || excluded.has(String(entry.id)) || entry.type === 'mermaid') return;
            const score = labels.reduce((total, label) => total + scoreEntryForLabel(entry, label), 0);
            if (score > 0) {
                candidates.push({
                    id: entry.id,
                    type: entry.type,
                    sectionHeadingId: entry.sectionHeadingId,
                    sectionHeadingText: entry.sectionHeadingText,
                    text: entry.textPreview,
                    score,
                });
            }
        });

        return candidates
            .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
            .slice(0, 6);
    }

    function attachMermaidPageRelations(index, mermaidMap) {
        if (!mermaidMap) return null;

        const steps = mermaidMap.steps.map((step) => {
            const participantLabels = [step.sourceId, step.sourceLabel, step.targetId, step.targetLabel]
                .map((idOrLabel) => {
                    const participant = mermaidMap.participants.find((entry) => entry.id === idOrLabel || entry.label === idOrLabel);
                    return participant?.label || idOrLabel;
                });
            const labels = uniqueStrings([
                step.label,
                ...participantLabels,
            ]).filter((label) => normalizeConceptKey(label).length >= 3);
            const relatedBlocks = findRelatedBlocksForLabels(index, labels, [mermaidMap.blockId]);

            return {
                ...step,
                relatedBlockIds: relatedBlocks.map((entry) => entry.id),
                relatedBlocks,
            };
        });

        return {
            ...mermaidMap,
            steps,
        };
    }

    function extractExplicitBlockReferences(index) {
        const references = [];
        const blockIds = new Set(index.blocks.map((entry) => String(entry.id || '')));
        const pattern = /\[([A-Za-z0-9_.:-]+)\]/g;

        index.blocks.forEach((entry) => {
            let match;
            while ((match = pattern.exec(String(entry.text || '')))) {
                const targetId = match[1];
                if (!blockIds.has(targetId) || targetId === entry.id) continue;
                references.push({
                    type: 'explicit_block_reference',
                    sourceBlockId: entry.id,
                    targetBlockIds: [targetId],
                    evidence: `[${targetId}]`,
                    sectionHeadingId: entry.sectionHeadingId,
                    sectionHeadingText: entry.sectionHeadingText,
                });
            }
        });

        return references;
    }

    function buildConceptRelations(index, options = {}) {
        const conceptMap = {};

        index.blocks.forEach((entry) => {
            if (!entry?.id || !normalizeText(entry.text)) return;
            const concepts = extractConcepts(entry.text, {
                includePhrase: Boolean(entry.headingLevel),
                limit: 12,
            });

            concepts.forEach((concept) => {
                if (!conceptMap[concept]) {
                    conceptMap[concept] = {
                        concept,
                        blockIds: new Set(),
                        sectionHeadingIds: new Set(),
                        sectionHeadingTexts: new Set(),
                        types: new Set(),
                    };
                }

                conceptMap[concept].blockIds.add(entry.id);
                if (entry.sectionHeadingId) conceptMap[concept].sectionHeadingIds.add(entry.sectionHeadingId);
                if (entry.sectionHeadingText) conceptMap[concept].sectionHeadingTexts.add(entry.sectionHeadingText);
                if (entry.type) conceptMap[concept].types.add(entry.type);
            });
        });

        return Object.values(conceptMap)
            .map((relation) => ({
                type: 'shared_concept',
                concept: relation.concept,
                blockIds: Array.from(relation.blockIds),
                sectionHeadingIds: Array.from(relation.sectionHeadingIds),
                sectionHeadingTexts: Array.from(relation.sectionHeadingTexts),
                blockTypes: Array.from(relation.types),
                strength: relation.blockIds.size + relation.sectionHeadingIds.size,
            }))
            .filter((relation) => relation.blockIds.length >= 2)
            .sort((left, right) => right.strength - left.strength || left.concept.localeCompare(right.concept))
            .slice(0, options.limit || 30);
    }

    function buildLayoutRegions(index, options = {}) {
        const maxRegions = Number(options.maxRegions || 30);
        const regions = [];
        let currentRegion = null;

        function summarizeRegion(region) {
            if (!region) return null;
            const sectionBlocks = region.blockIds.map((id) => index.blockById[id]).filter(Boolean);
            const supportTypes = uniqueStrings(sectionBlocks
                .map((entry) => entry.type)
                .filter((type) => type && !/^heading_/.test(type) && type !== 'text'));
            const orders = sectionBlocks.map((entry) => entry.order);

            return {
                label: region.label,
                headingBlockId: region.headingBlockId,
                level: region.level,
                blockIds: region.blockIds.slice(0, 24),
                blockCount: sectionBlocks.length,
                wordCount: countWords(sectionBlocks.map((entry) => entry.text).join(' ')),
                orderStart: orders.length ? Math.min(...orders) : 0,
                orderEnd: orders.length ? Math.max(...orders) : 0,
                supportTypes,
                colors: summarizeCounts(sectionBlocks.flatMap((entry) => [entry.color, entry.textColor])),
                preview: sectionBlocks.slice(0, 4).map((entry) => `[${entry.id}] ${entry.type}: ${entry.textPreview || '(empty)'}`),
            };
        }

        function commitRegion() {
            const summarized = summarizeRegion(currentRegion);
            if (summarized) regions.push(summarized);
            currentRegion = null;
        }

        index.blocks.forEach((entry) => {
            if (entry.headingLevel) {
                commitRegion();
                currentRegion = {
                    label: entry.text || 'Untitled section',
                    headingBlockId: entry.id,
                    level: `heading_${entry.headingLevel}`,
                    blockIds: [entry.id],
                };
                return;
            }

            if (!currentRegion) {
                currentRegion = {
                    label: 'Lead cluster',
                    headingBlockId: null,
                    level: 'lead',
                    blockIds: [],
                };
            }

            currentRegion.blockIds.push(entry.id);
        });
        commitRegion();

        if (!regions.length) {
            return [{
                label: 'Lead cluster',
                headingBlockId: null,
                level: 'lead',
                blockIds: index.blocks.slice(0, 12).map((entry) => entry.id),
                blockCount: index.blocks.length,
                orderStart: index.blocks[0]?.order ?? 0,
                orderEnd: index.blocks[index.blocks.length - 1]?.order ?? 0,
                supportTypes: uniqueStrings(index.blocks.map((entry) => entry.type).filter((type) => !/^heading_/.test(type))),
                colors: summarizeCounts(index.blocks.flatMap((entry) => [entry.color, entry.textColor])),
                preview: index.blocks.slice(0, 4).map((entry) => `[${entry.id}] ${entry.type}: ${entry.textPreview || '(empty)'}`),
            }];
        }

        return regions.slice(0, maxRegions);
    }

    function buildMermaidCrossReferences(mermaidMaps = []) {
        const references = [];

        mermaidMaps.forEach((map) => {
            map.steps.forEach((step) => {
                if (!Array.isArray(step.relatedBlockIds) || step.relatedBlockIds.length === 0) return;
                references.push({
                    type: 'mermaid_step_match',
                    sourceBlockId: map.blockId,
                    targetBlockIds: step.relatedBlockIds,
                    mermaidBlockId: map.blockId,
                    stepIndex: step.stepIndex,
                    label: step.label,
                    suggestedColor: step.color,
                    evidence: `Mermaid step ${step.stepIndex}: ${step.label}`,
                    sectionHeadingId: map.sectionHeadingId,
                    sectionHeadingText: map.sectionHeadingText,
                });
            });
        });

        return references;
    }

    function buildColorCodingHints(layoutRegions = [], mermaidMaps = []) {
        const hints = [];

        mermaidMaps.forEach((map) => {
            map.steps.slice(0, 16).forEach((step) => {
                hints.push({
                    target: 'mermaid_step',
                    mermaidBlockId: map.blockId,
                    stepIndex: step.stepIndex,
                    label: step.label,
                    suggestedColor: step.color,
                    relatedBlockIds: step.relatedBlockIds || [],
                    reason: 'Use this when the user asks to make Mermaid sequence steps visually trackable across the page.',
                });
            });
        });

        layoutRegions.slice(0, 12).forEach((region, index) => {
            hints.push({
                target: 'section_sequence',
                sequenceIndex: index + 1,
                headingBlockId: region.headingBlockId,
                label: region.label,
                suggestedColor: PAGE_SEQUENCE_COLORS[index % PAGE_SEQUENCE_COLORS.length],
                relatedBlockIds: region.blockIds || [],
                reason: 'Use this when the user asks to color-code page sections or process stages by order.',
            });
        });

        return hints;
    }

    function buildPageReasoningMap(pageOrIndex = null, options = {}) {
        const index = pageOrIndex?.blocks?.[0]?.source ? pageOrIndex : buildIndex(pageOrIndex, options);
        const layoutRegions = buildLayoutRegions(index, options);
        const mermaidMaps = index.blocks
            .filter((entry) => entry.type === 'mermaid')
            .map((entry) => buildMermaidMapForEntry(entry))
            .filter(Boolean)
            .map((map) => attachMermaidPageRelations(index, map));
        const conceptRelations = buildConceptRelations(index, { limit: options.maxConcepts || 30 });
        const explicitReferences = extractExplicitBlockReferences(index);
        const mermaidReferences = buildMermaidCrossReferences(mermaidMaps);
        const crossReferences = [
            ...mermaidReferences,
            ...explicitReferences,
            ...conceptRelations.map((relation) => ({
                type: relation.type,
                concept: relation.concept,
                targetBlockIds: relation.blockIds,
                sectionHeadingIds: relation.sectionHeadingIds,
                sectionHeadingTexts: relation.sectionHeadingTexts,
                evidence: `Shared concept: ${relation.concept}`,
                strength: relation.strength,
            })),
        ].slice(0, options.maxReferences || 60);
        const relatedClusters = conceptRelations.slice(0, options.maxClusters || 20).map((relation) => ({
            concept: relation.concept,
            blockIds: relation.blockIds.slice(0, 10),
            sectionHeadingIds: relation.sectionHeadingIds,
            sectionHeadingTexts: relation.sectionHeadingTexts,
            blockTypes: relation.blockTypes,
            strength: relation.strength,
        }));

        return {
            summary: {
                title: index.title,
                blockCount: index.blockCount,
                sectionCount: layoutRegions.length,
                mermaidCount: mermaidMaps.length,
                mermaidStepCount: mermaidMaps.reduce((count, map) => count + map.stepCount, 0),
                crossReferenceCount: crossReferences.length,
                relatedClusterCount: relatedClusters.length,
            },
            layoutRegions,
            mermaid: mermaidMaps,
            crossReferences,
            relatedClusters,
            colorCodingHints: buildColorCodingHints(layoutRegions, mermaidMaps),
        };
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
                fontWeight: entry.fontWeight,
                textAlign: entry.textAlign,
                highlights: entry.highlights,
            }));
        }

        if (mode === 'sections') {
            return index.sections;
        }

        if (mode === 'page_map' || mode === 'relationships' || mode === 'relationship_graph') {
            return buildPageReasoningMap(index, options);
        }

        if (mode === 'mermaid_sequences' || mode === 'mermaid') {
            return buildPageReasoningMap(index, options).mermaid;
        }

        if (mode === 'grep') {
            return query(index, {
                grep: options.grep || options.query || '',
                select: options.select || ['id', 'type', 'textPreview', 'sectionHeadingText', 'color', 'textColor'],
                limit: options.limit || 50,
            });
        }

        if (mode === 'sentences' || mode === 'sentence_index' || mode === 'sentence_search') {
            return findSentences(index, {
                ...options,
                select: options.select || ['id', 'blockId', 'type', 'sentenceIndex', 'text', 'exactText', 'sectionHeadingId', 'sectionHeadingText', 'highlights'],
                limit: options.limit || 80,
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
                fontWeight: entry.fontWeight,
                textAlign: entry.textAlign,
                highlights: entry.highlights,
            })),
        };
    }

    function buildPageContext(page = null, options = {}) {
        const index = buildIndex(page, options);
        const pageMap = createProjection(index, {
            mode: 'page_map',
            maxReferences: options.maxReferences || 60,
            maxClusters: options.maxClusters || 20,
        });
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
                fontWeight: entry.fontWeight,
                textAlign: entry.textAlign,
                highlights: entry.highlights,
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
                fontFamily: entry.fontFamily,
                fontSize: entry.fontSize,
                fontWeight: entry.fontWeight,
                textAlign: entry.textAlign,
                highlights: entry.highlights,
            })),
            sections: index.sections,
            blockCount: index.blockCount,
            wordCount: index.wordCount,
            readingTime: index.readingTime,
            lastUpdated: index.updatedAt,
            defaultModel: index.defaultModel,
            hasCover: index.hasCover,
            properties: index.properties,
            reasoningMap: pageMap,
            projections: {
                agentContext: createProjection(index, { mode: 'agent_context' }),
                styles: createProjection(index, { mode: 'styles' }),
                sentences: createProjection(index, { mode: 'sentence_index', limit: options.maxSentences || 80 }),
                pageMap,
                mermaidSequences: pageMap.mermaid,
                relationships: pageMap.crossReferences,
            },
        };
    }

    function createBulkUpdateActions(pageOrIndex = null, spec = {}, updates = {}) {
        const entries = query(pageOrIndex, {
            ...spec,
            select: ['id', 'type', 'text', 'color', 'textColor', 'fontFamily', 'fontSize', 'fontWeight', 'textAlign'],
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

    function createHighlightActions(pageOrIndex = null, spec = {}, highlight = {}) {
        const targetText = normalizeText(
            highlight.text
            || highlight.targetText
            || highlight.findText
            || spec.textIncludes
            || spec?.where?.textIncludes
            || ''
        );
        if (!targetText) return [];

        const entries = query(pageOrIndex, {
            ...spec,
            where: {
                ...(spec.where || {}),
                textIncludes: spec?.where?.textIncludes || spec.textIncludes || targetText,
            },
            select: ['id', 'text'],
        });

        return entries.map((entry) => ({
            op: 'highlight_text',
            blockId: entry.id,
            text: targetText,
            color: highlight.color || highlight.highlightColor || 'yellow',
            caseSensitive: Boolean(highlight.caseSensitive),
        }));
    }

    function createSentenceHighlightActions(pageOrIndex = null, spec = {}, highlight = {}) {
        return findSentences(pageOrIndex, spec).map((sentence) => ({
            op: 'highlight_text',
            blockId: sentence.blockId,
            text: sentence.exactText || sentence.text,
            color: highlight.color || highlight.highlightColor || 'yellow',
            scope: 'sentence',
            caseSensitive: true,
        }));
    }

    function createDatabaseUpdateAction(blockId, updates = {}) {
        if (!blockId) return null;
        const action = {
            op: 'update_database',
            blockId,
        };
        ['columns', 'rows', 'appendRows', 'sortColumn', 'sortDirection'].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(updates, key)) {
                action[key] = updates[key];
            }
        });
        return action;
    }

    function createDatabaseFillAction(blockId, column, fill = {}) {
        if (!blockId || column === undefined || column === null || column === '') return null;
        return {
            op: 'fill_database_column',
            blockId,
            column,
            ...fill,
        };
    }

    const api = {
        buildIndex,
        buildPageContext,
        createProjection,
        query,
        grep: (pageOrIndex, input = '', options = {}) => query(pageOrIndex, { ...options, grep: input }),
        parseGrepQuery,
        flattenBlocks,
        splitSentences,
        buildSentenceIndex,
        findSentences,
        extractText,
        getHeadingLevel,
        createBulkUpdateActions,
        createHeadingLevelActions,
        createHeaderColorActions,
        createSectionStyleActions,
        createHighlightActions,
        createSentenceHighlightActions,
        createDatabaseUpdateAction,
        createDatabaseFillAction,
        buildPageReasoningMap,
    };

    root.NotesQuery = api;
    root.NotesPatches = {
        bulkUpdate: createBulkUpdateActions,
        headingLevel: createHeadingLevelActions,
        headerColor: createHeaderColorActions,
        sectionStyle: createSectionStyleActions,
        highlight: createHighlightActions,
        highlightSentences: createSentenceHighlightActions,
        databaseUpdate: createDatabaseUpdateAction,
        databaseFill: createDatabaseFillAction,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
