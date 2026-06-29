/**
 * Notes realtime TTS reader.
 * Reuses the shared KimiBuilt realtime manager used by web-chat and web-cli.
 */

const NotesTts = (function() {
    'use strict';

    const MESSAGE_PREFIX = 'notes-page-tts';
    const HIGHLIGHT_CLASS = 'tts-reading-highlight';
    const BLOCK_PLAYING_CLASS = 'is-voice-playing';
    const BLOCK_LOOKAHEAD_CLASS = 'is-voice-up-next';
    const READABLE_TEXT_SELECTOR = '.block-input, .image-caption, .bookmark-title, .bookmark-description, .ai-block-result';

    let initialized = false;
    let manager = null;
    let activeMessageId = '';
    let activeReadRequest = null;
    let lastSelectionReadRequest = null;
    let lastReadAnchorBlockId = '';
    let controlsUpdateFrame = 0;
    let messageCounter = 0;
    let speechHighlightState = {
        messageId: '',
        lastSearchOffset: 0,
        lastChunkIndex: -1,
    };

    function getButton() {
        return document.getElementById('notes-tts-btn');
    }

    function getButtonLabel() {
        return document.getElementById('notes-tts-label');
    }

    function getEditorRoot() {
        return document.getElementById('editor');
    }

    function escapeSelectorValue(value = '') {
        const normalized = String(value || '');
        return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(normalized)
            : normalized.replace(/["\\]/g, '\\$&');
    }

    function createMessageId() {
        messageCounter += 1;
        const pageId = String(window.Editor?.getCurrentPage?.()?.id || 'page').trim() || 'page';
        return `${MESSAGE_PREFIX}:${pageId}:${Date.now()}:${messageCounter}`;
    }

    function extractBlockText(block = {}) {
        if (!block || typeof block !== 'object') {
            return '';
        }

        let text = '';
        if (typeof block.content === 'string') {
            text = block.content;
        } else if (block.content && typeof block.content === 'object') {
            if (block.type === 'todo' || block.type === 'callout' || block.type === 'code' || block.type === 'math' || block.type === 'mermaid') {
                text = block.content.text || '';
            } else if (block.type === 'ai') {
                text = block.content.result || block.content.prompt || '';
            } else if (block.type === 'image' || block.type === 'ai_image') {
                text = block.content.caption || block.content.prompt || block.content.url || '';
            } else if (block.type === 'bookmark') {
                text = [block.content.title, block.content.description, block.content.url].filter(Boolean).join('. ');
            } else if (block.type === 'database' && Array.isArray(block.content.rows)) {
                text = block.content.rows.flat().filter(Boolean).join(' ');
            } else if (block.type === 'chart') {
                const labels = Array.isArray(block.content.labels) ? block.content.labels : [];
                const values = Array.isArray(block.content.values) ? block.content.values : [];
                text = labels.map((label, index) => `${label} ${values[index] ?? ''}`.trim()).filter(Boolean).join('. ');
            } else {
                text = block.content.text || block.content.result || block.content.prompt || block.content.url || '';
            }
        }

        const childText = Array.isArray(block.children)
            ? block.children.map(extractBlockText).filter(Boolean).join('\n')
            : '';

        return [text, childText].filter(Boolean).join('\n').trim();
    }

    function getVisibleEditorText() {
        const editor = getEditorRoot();
        if (!editor) {
            return '';
        }

        return Array.from(editor.querySelectorAll(READABLE_TEXT_SELECTOR))
            .map((element) => String(element.innerText || element.textContent || '').trim())
            .filter(Boolean)
            .join('\n');
    }

    function getReadablePageText() {
        const renderedText = getVisibleEditorText();
        if (renderedText) {
            return renderedText;
        }

        const page = window.Editor?.getCurrentPage?.();
        const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
        return blocks.map(extractBlockText).filter(Boolean).join('\n').trim();
    }

    function getElementFromNode(node = null) {
        if (!node) {
            return null;
        }
        if (typeof Node !== 'undefined' && node.nodeType === Node.ELEMENT_NODE) {
            return node;
        }
        return node.parentElement || null;
    }

    function isNodeInsideEditor(node = null, editor = getEditorRoot()) {
        const element = getElementFromNode(node);
        return Boolean(editor && element && editor.contains(element));
    }

    function getBlockElementFromNode(node = null) {
        return getElementFromNode(node)?.closest?.('.block') || null;
    }

    function getSelectionRangeInsideEditor() {
        const editor = getEditorRoot();
        const selection = window.getSelection?.();
        if (!editor || !selection || selection.rangeCount === 0) {
            return null;
        }

        const range = selection.getRangeAt(0);
        const selectedText = String(selection.toString?.() || '').trim();
        if (range.collapsed || !selectedText) {
            return null;
        }

        if (!isNodeInsideEditor(range.startContainer, editor) || !isNodeInsideEditor(range.endContainer, editor)) {
            return null;
        }

        return {
            editor,
            range,
            selectedText,
            anchorBlock: getBlockElementFromNode(range.startContainer),
        };
    }

    function getReadableBlockText(blockElement = null) {
        if (!blockElement) {
            return '';
        }

        return Array.from(blockElement.querySelectorAll(READABLE_TEXT_SELECTOR))
            .filter((element) => element.closest?.('.block') === blockElement)
            .map((element) => String(element.innerText || element.textContent || '').trim())
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    function getReadableBlockEntries(editor = getEditorRoot()) {
        if (!editor) {
            return [];
        }

        return Array.from(editor.querySelectorAll('.block'))
            .map((element) => ({
                element,
                text: getReadableBlockText(element),
            }))
            .filter((entry) => entry.text);
    }

    function getReadableTextFromBlock(blockElement = null) {
        const entries = getReadableBlockEntries();
        const startIndex = entries.findIndex((entry) => entry.element === blockElement);
        if (startIndex < 0) {
            return '';
        }

        return entries
            .slice(startIndex)
            .map((entry) => entry.text)
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    function rememberReadAnchorFromDom(node = null) {
        const editor = getEditorRoot();
        if (!editor) {
            return;
        }

        const sourceNode = node || document.activeElement;
        const block = isNodeInsideEditor(sourceNode, editor)
            ? getBlockElementFromNode(sourceNode)
            : null;
        const blockId = String(block?.dataset?.blockId || '').trim();
        if (blockId) {
            lastReadAnchorBlockId = blockId;
        }
    }

    function getReadAnchorBlockElement() {
        const selectionInfo = getSelectionRangeInsideEditor();
        if (selectionInfo?.anchorBlock) {
            rememberReadAnchorFromDom(selectionInfo.range.startContainer);
            return selectionInfo.anchorBlock;
        }

        const editor = getEditorRoot();
        const activeBlock = isNodeInsideEditor(document.activeElement, editor)
            ? document.activeElement.closest?.('.block')
            : null;
        if (activeBlock?.dataset?.blockId) {
            rememberReadAnchorFromDom(activeBlock);
            return activeBlock;
        }

        const selectedBlockId = String(window.Selection?.getSelectedBlockId?.() || '').trim();
        const selectedBlock = selectedBlockId
            ? document.querySelector(`.block[data-block-id="${escapeSelectorValue(selectedBlockId)}"]`)
            : null;
        if (selectedBlock) {
            lastReadAnchorBlockId = selectedBlockId;
            return selectedBlock;
        }

        return lastReadAnchorBlockId
            ? document.querySelector(`.block[data-block-id="${escapeSelectorValue(lastReadAnchorBlockId)}"]`)
            : null;
    }

    function trimSpeechUrlToken(value = '') {
        const token = String(value || '');
        const trailing = token.match(/[),.;:!?]+$/)?.[0] || '';
        return trailing ? token.slice(0, -trailing.length) : token;
    }

    function normalizeSpeechUrlToken(value = '') {
        const normalizer = window.KimiBuiltRealtimeTts?.normalizeUrlForSpeech;
        if (typeof normalizer === 'function') {
            return normalizer(value);
        }
        return trimSpeechUrlToken(value);
    }

    function appendComparableSpeechChar(output, char = '', position = null) {
        const normalized = String(char || '').toLowerCase();
        if (/^[a-z0-9]$/.test(normalized)) {
            output.text += normalized;
            output.positions.push(position);
            return;
        }

        if (output.text && !output.text.endsWith(' ')) {
            output.text += ' ';
            output.positions.push(position);
        }
    }

    function isComparableSpeechContentChar(char = '') {
        return /^[a-z0-9]$/.test(String(char || ''));
    }

    function findComparableSpeechContentIndex(textMap = {}, startIndex = 0, endIndex = 0, direction = 1) {
        const text = String(textMap.text || '');
        const positions = Array.isArray(textMap.positions) ? textMap.positions : [];
        if (!text || positions.length === 0) {
            return -1;
        }

        const step = direction < 0 ? -1 : 1;
        const min = Math.max(0, Math.min(Number(startIndex) || 0, Number(endIndex) || 0));
        const max = Math.min(text.length - 1, Math.max(Number(startIndex) || 0, Number(endIndex) || 0));
        let index = step < 0 ? max : min;
        while (index >= min && index <= max) {
            if (isComparableSpeechContentChar(text[index]) && positions[index]?.node) {
                return index;
            }
            index += step;
        }
        return -1;
    }

    function createSpeechRangeFromComparableIndexes(textMap = {}, startIndex = 0, endIndex = 0) {
        const start = textMap.positions?.[startIndex];
        const end = textMap.positions?.[endIndex];
        if (!start?.node || !end?.node) {
            return null;
        }

        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset + 1);
        return range;
    }

    function createCollapsedRangeAt(node = null, offset = 0) {
        if (!node || typeof document === 'undefined' || typeof document.createRange !== 'function') {
            return null;
        }

        try {
            const range = document.createRange();
            range.setStart(node, Math.max(0, Number(offset) || 0));
            range.collapse(true);
            return range;
        } catch (_error) {
            return null;
        }
    }

    function compareDomPoint(position = null, node = null, offset = 0) {
        const positionRange = createCollapsedRangeAt(position?.node, position?.offset);
        const targetRange = createCollapsedRangeAt(node, offset);
        if (!positionRange || !targetRange || typeof Range === 'undefined') {
            return 0;
        }

        try {
            return positionRange.compareBoundaryPoints(Range.START_TO_START, targetRange);
        } catch (_error) {
            return 0;
        } finally {
            positionRange.detach?.();
            targetRange.detach?.();
        }
    }

    function findComparableSpeechIndexForDomPoint(textMap = {}, node = null, offset = 0, direction = 1) {
        const text = String(textMap.text || '');
        const positions = Array.isArray(textMap.positions) ? textMap.positions : [];
        if (!text || positions.length === 0 || !node) {
            return 0;
        }

        const forward = direction >= 0;
        let fallbackIndex = forward ? 0 : Math.max(0, positions.length - 1);
        for (
            let index = forward ? 0 : positions.length - 1;
            forward ? index < positions.length : index >= 0;
            index += forward ? 1 : -1
        ) {
            if (!isComparableSpeechContentChar(text[index]) || !positions[index]?.node) {
                continue;
            }

            fallbackIndex = index;
            const comparison = compareDomPoint(positions[index], node, offset);
            if ((forward && comparison >= 0) || (!forward && comparison <= 0)) {
                return index;
            }
        }

        return fallbackIndex;
    }

    function getDomPointBeforeElement(element = null) {
        const parent = element?.parentNode || null;
        if (!parent) {
            return null;
        }

        return {
            node: parent,
            offset: Array.prototype.indexOf.call(parent.childNodes, element),
        };
    }

    function getComparableStartOffsetForBlock(blockElement = null) {
        const editor = getEditorRoot();
        const point = getDomPointBeforeElement(blockElement);
        if (!editor || !point) {
            return 0;
        }

        const textMap = buildSpeechTextMap(editor);
        return findComparableSpeechIndexForDomPoint(textMap, point.node, point.offset, 1);
    }

    function getComparableStartOffsetForRange(range = null, editor = getEditorRoot()) {
        if (!range || !editor) {
            return 0;
        }

        const textMap = buildSpeechTextMap(editor);
        return findComparableSpeechIndexForDomPoint(textMap, range.startContainer, range.startOffset, 1);
    }

    function appendComparablePlainText(text = '', output, node = null, baseOffset = 0) {
        String(text || '').split('').forEach((char, index) => {
            appendComparableSpeechChar(output, char, node ? { node, offset: baseOffset + index } : null);
        });
    }

    function appendComparableUrlText(text = '', output, node = null, baseOffset = 0, sourceLength = 0) {
        const speechText = normalizeSpeechUrlToken(text);
        const comparableLength = Math.max(1, speechText.length);
        const normalizedSourceLength = Math.max(1, Number(sourceLength) || String(text || '').length || 1);

        speechText.split('').forEach((char, index) => {
            const sourceOffset = baseOffset + Math.min(
                normalizedSourceLength - 1,
                Math.floor((index / comparableLength) * normalizedSourceLength),
            );
            appendComparableSpeechChar(output, char, node ? { node, offset: sourceOffset } : null);
        });
    }

    function appendComparableSpeechText(text = '', output, node = null, baseOffset = 0) {
        const value = String(text || '');
        const tokenPattern = /\b(?:https?:\/\/|www\.)[^\s<>)\]]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|ai|dev|app|edu|gov|ca|co|us|uk|help|buzz|cloud|site|online|xyz|info|biz)(?:\/[^\s<>)\]]*)?/gi;
        let cursor = 0;
        let match = tokenPattern.exec(value);

        while (match) {
            if (match.index > cursor) {
                appendComparablePlainText(value.slice(cursor, match.index), output, node, baseOffset + cursor);
            }

            const rawToken = match[0] || '';
            const token = trimSpeechUrlToken(rawToken);
            appendComparableUrlText(token, output, node, baseOffset + match.index, token.length);
            cursor = match.index + rawToken.length;
            match = tokenPattern.exec(value);
        }

        if (cursor < value.length) {
            appendComparablePlainText(value.slice(cursor), output, node, baseOffset + cursor);
        }
    }

    function trimComparableSpeechOutput(output) {
        while (output.text.endsWith(' ')) {
            output.text = output.text.slice(0, -1);
            output.positions.pop();
        }
    }

    function normalizeSpeechHighlightText(text = '') {
        const output = {
            text: '',
            positions: [],
        };
        appendComparableSpeechText(String(text || ''), output);
        trimComparableSpeechOutput(output);
        return output.text;
    }

    function shouldSkipSpeechNode(node = null) {
        const parentElement = node?.parentElement || null;
        if (!parentElement) {
            return true;
        }

        return Boolean(parentElement.closest(
            'pre, code, kbd, samp, script, style, textarea, input, button, select, svg, .block-actions, .block-handle, .block-add-btn, .add-block-btn, .tts-reading-highlight',
        ));
    }

    function getSpeechSectionElement(node = null) {
        return node?.parentElement?.closest?.('.block') || node?.parentElement || null;
    }

    function buildSpeechTextMap(root = null) {
        if (!root || typeof document === 'undefined' || typeof document.createTreeWalker !== 'function' || typeof NodeFilter === 'undefined') {
            return {
                text: '',
                positions: [],
                sections: [],
            };
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (
                shouldSkipSpeechNode(node) || !String(node.nodeValue || '').trim()
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT
            ),
        });
        const output = {
            text: '',
            positions: [],
            sections: [],
        };
        let lastSectionElement = null;

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const sectionElement = getSpeechSectionElement(node);
            if (lastSectionElement && sectionElement !== lastSectionElement && output.text && !output.text.endsWith(' ')) {
                output.text += ' ';
                output.positions.push({ node, offset: 0 });
                const previousSection = output.sections[output.sections.length - 1];
                if (previousSection && typeof previousSection.endIndex !== 'number') {
                    previousSection.endIndex = Math.max(previousSection.startIndex, output.text.length - 1);
                }
            }

            if (sectionElement !== lastSectionElement) {
                output.sections.push({
                    element: sectionElement,
                    startIndex: output.text.length,
                });
                lastSectionElement = sectionElement;
            }

            appendComparableSpeechText(String(node.nodeValue || ''), output, node, 0);
        }

        trimComparableSpeechOutput(output);
        const finalSection = output.sections[output.sections.length - 1];
        if (finalSection && typeof finalSection.endIndex !== 'number') {
            finalSection.endIndex = Math.max(finalSection.startIndex, output.text.length);
        }

        return output;
    }

    function createSelectionReadRequest(selectionInfo = null) {
        if (selectionInfo?.selectedText) {
            rememberReadAnchorFromDom(selectionInfo.range.startContainer);
            return {
                mode: 'selection',
                label: 'Read selection',
                title: `Read selected text aloud with ${manager?.getVoiceLabel?.() || 'Voice'}`,
                text: selectionInfo.selectedText,
                startSearchOffset: getComparableStartOffsetForRange(selectionInfo.range, selectionInfo.editor),
                anchorBlockId: selectionInfo.anchorBlock?.dataset?.blockId || '',
            };
        }

        return null;
    }

    function createReadRequest() {
        const selectionRequest = createSelectionReadRequest(getSelectionRangeInsideEditor());
        if (selectionRequest) {
            lastSelectionReadRequest = selectionRequest;
            return selectionRequest;
        }

        if (lastSelectionReadRequest && document.activeElement?.closest?.('#notes-tts-btn')) {
            return lastSelectionReadRequest;
        }

        const editor = getEditorRoot();
        const anchorBlock = getReadAnchorBlockElement();
        const readableEntries = getReadableBlockEntries(editor);
        const firstReadableBlock = readableEntries[0]?.element || null;
        if (anchorBlock && anchorBlock !== firstReadableBlock) {
            const anchorText = getReadableTextFromBlock(anchorBlock);
            if (anchorText) {
                return {
                    mode: 'from-here',
                    label: 'Read from here',
                    title: `Read from the current block with ${manager?.getVoiceLabel?.() || 'Voice'}`,
                    text: anchorText,
                    startSearchOffset: getComparableStartOffsetForBlock(anchorBlock),
                    anchorBlockId: anchorBlock.dataset?.blockId || '',
                };
            }
        }

        return {
            mode: 'page',
            label: 'Read',
            title: `Read page aloud with ${manager?.getVoiceLabel?.() || 'Voice'}`,
            text: getReadablePageText(),
            startSearchOffset: 0,
            anchorBlockId: '',
        };
    }

    function getStopNarrationTitle(readRequest = null) {
        if (readRequest?.mode === 'selection') {
            return 'Stop selected text narration';
        }
        if (readRequest?.mode === 'from-here') {
            return 'Stop current block narration';
        }
        return 'Stop page narration';
    }

    function getActiveReadStartOffset() {
        return Math.max(0, Number(activeReadRequest?.startSearchOffset) || 0);
    }

    function findSpeechHighlightRange(root = null, chunkText = '', options = {}) {
        const normalizedChunk = normalizeSpeechHighlightText(chunkText).toLowerCase();
        if (!root || !normalizedChunk) {
            return null;
        }

        const textMap = buildSpeechTextMap(root);
        if (!textMap.text || textMap.positions.length === 0) {
            return null;
        }

        const preferredStartIndex = Math.max(0, Number(options.startIndex) || 0);
        const searchStartIndex = Math.max(0, preferredStartIndex - 12);
        const candidates = [
            normalizedChunk,
            normalizedChunk.length > 96 ? normalizedChunk.slice(0, 96).trim() : '',
            normalizedChunk.split(' ').slice(0, 10).join(' '),
        ]
            .map((candidate) => candidate.trim())
            .filter((candidate, index, list) => (
                candidate.length >= 3 && list.indexOf(candidate) === index
            ));

        for (const candidate of candidates) {
            const matchIndex = textMap.text.indexOf(candidate, searchStartIndex);
            if (matchIndex < 0) {
                continue;
            }

            const rawEndIndex = Math.min(textMap.positions.length - 1, matchIndex + candidate.length - 1);
            const startIndex = findComparableSpeechContentIndex(textMap, matchIndex, rawEndIndex, 1);
            const endIndex = findComparableSpeechContentIndex(textMap, rawEndIndex, matchIndex, -1);
            if (startIndex < 0 || endIndex < startIndex) {
                continue;
            }

            const range = createSpeechRangeFromComparableIndexes(textMap, startIndex, endIndex);
            if (!range) {
                continue;
            }
            return {
                range,
                endIndex: endIndex + 1,
            };
        }

        return null;
    }

    function clearBlockPlayingState() {
        document
            .querySelectorAll(`.block.${BLOCK_PLAYING_CLASS}, .block.${BLOCK_LOOKAHEAD_CLASS}`)
            .forEach((block) => block.classList.remove(BLOCK_PLAYING_CLASS, BLOCK_LOOKAHEAD_CLASS));
    }

    function getNextReadableBlockElement(blockElement = null) {
        if (!blockElement) {
            return null;
        }

        const entries = getReadableBlockEntries();
        const currentIndex = entries.findIndex((entry) => entry.element === blockElement);
        return currentIndex >= 0
            ? entries[currentIndex + 1]?.element || null
            : null;
    }

    function markUpcomingSpeechBlock(blockElement = null) {
        const nextBlock = getNextReadableBlockElement(blockElement);
        if (nextBlock) {
            nextBlock.classList.add(BLOCK_LOOKAHEAD_CLASS);
        }
        return nextBlock;
    }

    function scrollSpeechHighlightIntoView(highlight = null, blockElement = null) {
        const target = blockElement || highlight;
        if (!target?.scrollIntoView) {
            return;
        }

        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
        requestAnimationFrame(() => {
            target.scrollIntoView({
                block: 'center',
                inline: 'nearest',
                behavior: reduceMotion ? 'auto' : 'smooth',
            });
        });
    }

    function clearSpeechHighlights(options = {}) {
        document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((highlight) => {
            const parent = highlight.parentNode;
            if (!parent) {
                return;
            }
            Array.from(highlight.childNodes).forEach((child) => parent.insertBefore(child, highlight));
            parent.removeChild(highlight);
            parent.normalize?.();
        });

        if (options.preserveState !== true) {
            speechHighlightState = {
                messageId: '',
                lastSearchOffset: getActiveReadStartOffset(),
                lastChunkIndex: -1,
            };
        }
    }

    function queueControlsUpdate() {
        if (!initialized || controlsUpdateFrame) {
            return;
        }

        controlsUpdateFrame = requestAnimationFrame(() => {
            controlsUpdateFrame = 0;
            updateControls();
        });
    }

    function updateReadAnchorFromEvent(event = null) {
        const target = event?.target || document.activeElement;
        const editor = getEditorRoot();
        if (isNodeInsideEditor(target, editor)) {
            rememberReadAnchorFromDom(target);
            queueControlsUpdate();
            return;
        }

        if (!target?.closest?.('#notes-tts-btn')) {
            lastReadAnchorBlockId = '';
            lastSelectionReadRequest = null;
        }
        queueControlsUpdate();
    }

    function highlightSpeechChunk(messageId = '', chunkText = '', options = {}) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || normalizedMessageId !== activeMessageId) {
            return false;
        }

        const root = document.getElementById('editor');
        if (!root) {
            return false;
        }

        const chunkIndex = Number(options.chunkIndex);
        if (
            speechHighlightState.messageId !== normalizedMessageId
            || chunkIndex === 0
            || chunkIndex <= speechHighlightState.lastChunkIndex
        ) {
            speechHighlightState = {
                messageId: normalizedMessageId,
                lastSearchOffset: getActiveReadStartOffset(),
                lastChunkIndex: -1,
            };
        }

        clearSpeechHighlights({ preserveState: true });
        clearBlockPlayingState();

        const match = findSpeechHighlightRange(root, chunkText, {
            startIndex: speechHighlightState.lastSearchOffset,
        });
        if (!match?.range) {
            return false;
        }

        const highlight = document.createElement('span');
        highlight.className = HIGHLIGHT_CLASS;
        highlight.dataset.ttsReading = 'true';

        try {
            const contents = match.range.extractContents();
            highlight.appendChild(contents);
            match.range.insertNode(highlight);
            const activeBlock = highlight.closest?.('.block') || null;
            activeBlock?.classList.add(BLOCK_PLAYING_CLASS);
            markUpcomingSpeechBlock(activeBlock);
            speechHighlightState = {
                messageId: normalizedMessageId,
                lastSearchOffset: Math.max(speechHighlightState.lastSearchOffset, Number(match.endIndex) || 0),
                lastChunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : speechHighlightState.lastChunkIndex,
            };
            scrollSpeechHighlightIntoView(highlight, activeBlock);
            return true;
        } catch (error) {
            console.warn('[NotesTTS] Failed to highlight spoken text:', error);
            clearSpeechHighlights();
            clearBlockPlayingState();
            return false;
        }
    }

    function updateControls() {
        const button = getButton();
        if (!button) {
            return;
        }

        const label = getButtonLabel();
        const readRequest = activeReadRequest || createReadRequest();
        const text = readRequest.text;
        const available = manager?.isAvailable?.() === true;
        const loading = activeMessageId && manager?.isLoadingMessage?.(activeMessageId) === true;
        const playing = activeMessageId && manager?.isPlayingMessage?.(activeMessageId) === true;
        const diagnostics = manager?.getDiagnostics?.() || {};
        const disabled = !manager || !available || !text || loading;

        button.disabled = disabled;
        button.classList.toggle('is-active', Boolean(playing));
        button.classList.toggle('is-loading', Boolean(loading));
        button.dataset.readMode = readRequest.mode || 'page';
        button.setAttribute('aria-pressed', playing ? 'true' : 'false');

        const title = !text
            ? 'No readable page text'
            : (!available
                ? String(diagnostics.message || 'Voice playback is unavailable.')
                : (playing ? getStopNarrationTitle(readRequest) : readRequest.title));
        button.title = title;
        button.setAttribute('aria-label', title);
        if (label) {
            label.textContent = loading ? 'Loading' : (playing ? 'Stop' : readRequest.label);
        }
    }

    async function togglePageSpeech() {
        if (!manager) {
            window.Sidebar?.showToast?.('Voice playback is not loaded in this browser.', 'warning');
            return;
        }

        if (activeMessageId && manager.isPlayingMessage?.(activeMessageId)) {
            manager.stop?.();
            return;
        }

        const readRequest = createReadRequest();
        if (!readRequest.text) {
            window.Sidebar?.showToast?.('There is no readable page text yet.', 'warning');
            return;
        }

        try {
            await manager.ensureConfigLoaded({ quiet: true });
            if (!manager.isAvailable?.()) {
                const diagnostics = manager.getDiagnostics?.() || {};
                window.Sidebar?.showToast?.(String(diagnostics.message || 'Voice playback is unavailable.'), 'warning');
                updateControls();
                return;
            }

            activeMessageId = createMessageId();
            activeReadRequest = readRequest;
            speechHighlightState = {
                messageId: activeMessageId,
                lastSearchOffset: getActiveReadStartOffset(),
                lastChunkIndex: -1,
            };
            updateControls();
            await manager.speakMessage({
                messageId: activeMessageId,
                text: readRequest.text,
            });
        } catch (error) {
            console.warn('[NotesTTS] Page narration failed:', error);
            window.Sidebar?.showToast?.(error.message || 'Failed to generate page narration.', 'warning');
        } finally {
            activeReadRequest = null;
            updateControls();
        }
    }

    function init() {
        if (initialized) {
            updateControls();
            return;
        }

        const ManagerCtor = window.KimiBuiltRealtimeTtsManager || window.WebChatTtsManager;
        if (!ManagerCtor) {
            updateControls();
            return;
        }

        initialized = true;
        manager = new ManagerCtor();
        manager.addEventListener('statechange', updateControls);
        manager.addEventListener('configchange', updateControls);
        manager.addEventListener('chunkstart', (event) => {
            highlightSpeechChunk(event.detail?.messageId || '', event.detail?.chunkText || '', {
                chunkIndex: event.detail?.chunkIndex,
            });
            updateControls();
        });
        manager.addEventListener('chunkend', (event) => {
            const chunkIndex = Number(event.detail?.chunkIndex);
            const chunkCount = Number(event.detail?.chunkCount);
            if (Number.isFinite(chunkIndex) && Number.isFinite(chunkCount) && chunkIndex >= chunkCount - 1) {
                setTimeout(() => {
                    clearSpeechHighlights();
                    clearBlockPlayingState();
                }, 160);
            }
            updateControls();
        });
        manager.addEventListener('playbackstop', () => {
            activeReadRequest = null;
            activeMessageId = '';
            clearSpeechHighlights();
            clearBlockPlayingState();
            updateControls();
        });

        getButton()?.addEventListener('click', () => {
            void togglePageSpeech();
        });
        document.addEventListener('selectionchange', () => {
            const selectionInfo = getSelectionRangeInsideEditor();
            if (selectionInfo?.range) {
                lastSelectionReadRequest = createSelectionReadRequest(selectionInfo);
                rememberReadAnchorFromDom(selectionInfo.range.startContainer);
            } else if (!document.activeElement?.closest?.('#notes-tts-btn')) {
                lastSelectionReadRequest = null;
            }
            queueControlsUpdate();
        });
        document.addEventListener('keyup', updateReadAnchorFromEvent);
        document.addEventListener('focusin', updateReadAnchorFromEvent);
        document.addEventListener('pointerup', updateReadAnchorFromEvent);

        void manager.ensureConfigLoaded({ quiet: true })
            .catch((error) => {
                console.warn('[NotesTTS] Voice config unavailable:', error);
            })
            .finally(updateControls);
    }

    return {
        init,
        togglePageSpeech,
        getReadablePageText,
        getReadRequest: createReadRequest,
        highlightSpeechChunk,
        clearSpeechHighlights,
    };
})();

if (typeof window !== 'undefined') {
    window.NotesTts = NotesTts;
}
