const { parentPort } = require('worker_threads');
const { config } = require('../config');
const { KokoroTtsService } = require('./kokoro-tts-service');

const ipc = parentPort
    ? {
        postMessage: (message) => parentPort.postMessage(message),
        onMessage: (handler) => parentPort.on('message', handler),
    }
    : {
        postMessage: (message) => {
            if (typeof process.send === 'function') {
                process.send(message);
            }
        },
        onMessage: (handler) => process.on('message', handler),
    };

const service = new KokoroTtsService({
    ...(config.tts?.kokoro || {}),
    workerEnabled: false,
}, {
    workerEnabled: false,
});

function serializeError(error = {}) {
    return {
        statusCode: Number(error.statusCode || error.status) || 500,
        code: String(error.code || '').trim() || 'tts_failed',
        message: String(error.message || '').trim() || 'Kokoro synthesis worker failed.',
    };
}

async function handleMessage(message = {}) {
    const id = message.id;
    try {
        if (message.action === 'warm') {
            await service.getModel();
            ipc.postMessage({
                id,
                ok: true,
                result: {
                    warmed: true,
                    diagnostics: service.getPublicConfig().diagnostics,
                },
            });
            return;
        }

        if (message.action === 'synthesize') {
            const result = await service.synthesize(message.payload || {});
            ipc.postMessage({
                id,
                ok: true,
                result,
            });
            return;
        }

        const error = new Error(`Unknown Kokoro worker action "${message.action}".`);
        error.statusCode = 400;
        error.code = 'tts_worker_bad_action';
        throw error;
    } catch (error) {
        ipc.postMessage({
            id,
            ok: false,
            error: serializeError(error),
        });
    }
}

ipc.onMessage((message) => {
    handleMessage(message);
});
