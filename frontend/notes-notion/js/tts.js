/**
 * Notes realtime TTS reader.
 * Reuses the shared KimiBuilt realtime manager used by web-chat and web-cli.
 */

const NotesTts = (function() {
    'use strict';

    const MESSAGE_PREFIX = 'notes-page-tts';
    const HIGHLIGHT_CLASS = 'tts-reading-highlight';
    const BLOCK_PLAYING_CLASS = 'is-voice-playing';

    let initialized = false;
    let manager = null;
    let activeMessageId = '';
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
        const editor = document.getElementById('editor');
        if (!editor) {
            return '';
        }

        return Array.from(editor.querySelectorAll('.block-input, .image-caption, .bookmark-title, .bookmark-description, .ai-block-result'))
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
        if (!root || !document?.createTreeWalker || typeof NodeFilter === 'undefined') {
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
        ].filter((candidate, index, list) => (
            candidate.length >= 3 && list.indexOf(candidate) === index
        ));

        for (const candidate of candidates) {
            const matchIndex = textMap.text.indexOf(candidate, searchStartIndex);
            if (matchIndex < 0) {
                continue;
            }

            const start = textMap.positions[matchIndex];
            const end = textMap.positions[Math.min(textMap.positions.length - 1, matchIndex + candidate.length - 1)];
            if (!start?.node || !end?.node) {
                continue;
            }

            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset + 1);
            return {
                range,
                endIndex: matchIndex + candidate.length,
            };
        }

        return null;
    }

    function clearBlockPlayingState() {
        document
            .querySelectorAll(`.block.${BLOCK_PLAYING_CLASS}`)
            .forEach((block) => block.classList.remove(BLOCK_PLAYING_CLASS));
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
                lastSearchOffset: 0,
                lastChunkIndex: -1,
            };
        }
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
                lastSearchOffset: 0,
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
            highlight.closest?.('.block')?.classList.add(BLOCK_PLAYING_CLASS);
            speechHighlightState = {
                messageId: normalizedMessageId,
                lastSearchOffset: Math.max(speechHighlightState.lastSearchOffset, Number(match.endIndex) || 0),
                lastChunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : speechHighlightState.lastChunkIndex,
            };
            highlight.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
        const text = getReadablePageText();
        const available = manager?.isAvailable?.() === true;
        const loading = activeMessageId && manager?.isLoadingMessage?.(activeMessageId) === true;
        const playing = activeMessageId && manager?.isPlayingMessage?.(activeMessageId) === true;
        const diagnostics = manager?.getDiagnostics?.() || {};
        const voiceLabel = manager?.getVoiceLabel?.() || 'Voice';
        const disabled = !manager || !available || !text || loading;

        button.disabled = disabled;
        button.classList.toggle('is-active', Boolean(playing));
        button.classList.toggle('is-loading', Boolean(loading));
        button.setAttribute('aria-pressed', playing ? 'true' : 'false');

        const title = !text
            ? 'No readable page text'
            : (!available
                ? String(diagnostics.message || 'Voice playback is unavailable.')
                : (playing ? 'Stop page narration' : `Read page aloud with ${voiceLabel}`));
        button.title = title;
        button.setAttribute('aria-label', title);
        if (label) {
            label.textContent = loading ? 'Loading' : (playing ? 'Stop' : 'Read');
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

        const text = getReadablePageText();
        if (!text) {
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
            updateControls();
            await manager.speakMessage({
                messageId: activeMessageId,
                text,
            });
        } catch (error) {
            console.warn('[NotesTTS] Page narration failed:', error);
            window.Sidebar?.showToast?.(error.message || 'Failed to generate page narration.', 'warning');
        } finally {
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
            clearSpeechHighlights();
            clearBlockPlayingState();
            updateControls();
        });

        getButton()?.addEventListener('click', () => {
            void togglePageSpeech();
        });

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
        clearSpeechHighlights,
    };
})();

if (typeof window !== 'undefined') {
    window.NotesTts = NotesTts;
}
