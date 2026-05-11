const { Router } = require('express');
const { config } = require('../config');
const { transcriptionService } = require('../audio/transcription-service');
const { parseMultipartRequest } = require('../utils/multipart');

const router = Router();
const TRANSCRIPTION_CONTAINER_MIME_TYPES = new Set([
    'video/webm',
    'video/mp4',
    'video/ogg',
]);
const TRANSCRIPTION_EXTENSION_MIME_TYPES = Object.freeze({
    webm: 'audio/webm',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    mpga: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    mp4: 'audio/mp4',
    m4a: 'audio/mp4',
});

function getBaseMimeType(mimeType = '') {
    return String(mimeType || '').trim().toLowerCase().split(';')[0].trim();
}

function createRouteError(statusCode, message, code = 'audio_error') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

function inferMimeTypeFromFilename(filename = '') {
    const extension = String(filename || '').trim().toLowerCase().split('.').pop() || '';
    return TRANSCRIPTION_EXTENSION_MIME_TYPES[extension] || '';
}

function normalizeTranscriptionMimeType(mimeType = '', filename = '') {
    const normalizedMimeType = getBaseMimeType(mimeType);
    if (normalizedMimeType.startsWith('audio/')) {
        return normalizedMimeType;
    }

    if (TRANSCRIPTION_CONTAINER_MIME_TYPES.has(normalizedMimeType)) {
        return normalizedMimeType.replace(/^video\//, 'audio/');
    }

    return inferMimeTypeFromFilename(filename) || normalizedMimeType;
}

function isSupportedTranscriptionUpload(mimeType = '', filename = '') {
    const normalizedMimeType = getBaseMimeType(mimeType);
    if (normalizedMimeType.startsWith('audio/')) {
        return true;
    }

    if (TRANSCRIPTION_CONTAINER_MIME_TYPES.has(normalizedMimeType)) {
        return true;
    }

    return Boolean(inferMimeTypeFromFilename(filename));
}

router.post('/transcribe', async (req, res, next) => {
    try {
        const { fields, file } = await parseMultipartRequest(req, {
            maxBytes: config.audio.maxUploadBytes,
        });

        if (!file?.buffer?.length) {
            throw createRouteError(400, 'An audio file upload is required.', 'audio_upload_required');
        }

        const mimeType = String(file.mimeType || '').trim().toLowerCase();
        if (!isSupportedTranscriptionUpload(mimeType, file.filename || '')) {
            throw createRouteError(400, `Unsupported audio upload type: ${file.mimeType}`, 'unsupported_audio_type');
        }

        const normalizedMimeType = normalizeTranscriptionMimeType(mimeType, file.filename || '');

        const transcript = await transcriptionService.transcribe({
            audioBuffer: file.buffer,
            filename: file.filename || 'recording.webm',
            mimeType: normalizedMimeType || 'audio/webm',
            language: fields.language || '',
            prompt: fields.prompt || '',
        });

        res.setHeader('Cache-Control', 'no-store');
        res.json({
            text: transcript.text,
            model: transcript.model,
            language: transcript.language,
            duration: transcript.duration,
            provider: transcript.provider,
        });
    } catch (error) {
        if (error?.statusCode) {
            return res.status(error.statusCode).json({
                error: {
                    type: error.code || 'audio_error',
                    message: error.message,
                },
            });
        }

        return next(error);
    }
});

module.exports = router;
