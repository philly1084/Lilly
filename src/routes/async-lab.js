'use strict';

const { Router } = require('express');
const { normalizeCursor, normalizeText } = require('../async-lab/valkey-live-bus');

const router = Router();

function getOwnerId(req) {
    return normalizeText(req.user?.username) || null;
}

function getService(req) {
    return req.app.locals.asyncLabService;
}

function respondDisabled(res) {
    return res.status(404).json({
        error: {
            message: 'Async runtime lab is disabled',
        },
    });
}

function shouldStream(req) {
    return req.query.stream === 'true'
        || String(req.get('accept') || '').includes('text/event-stream');
}

router.get('/status', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return respondDisabled(res);
        }
        res.json({
            status: service.getStatus(),
        });
    } catch (error) {
        next(error);
    }
});

router.get('/runs', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return respondDisabled(res);
        }

        const runs = await service.listRuns(getOwnerId(req), req.query.limit || 50);
        res.json({
            runs,
            count: runs.length,
        });
    } catch (error) {
        next(error);
    }
});

router.post('/runs', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return respondDisabled(res);
        }

        const result = await service.createRun({
            ...(req.body || {}),
            idempotencyKey: req.body?.idempotencyKey
                || req.body?.idempotency_key
                || req.get('x-idempotency-key')
                || '',
        }, getOwnerId(req));
        res.status(result.duplicate ? 200 : 202).json(result);
    } catch (error) {
        next(error);
    }
});

router.get('/runs/:runId', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return respondDisabled(res);
        }

        const run = await service.getRun(req.params.runId, getOwnerId(req));
        if (!run) {
            return res.status(404).json({ error: { message: 'Async lab run not found' } });
        }
        const events = await service.listEvents(run.id, req.query.after || 0);
        res.json({
            run,
            events,
        });
    } catch (error) {
        next(error);
    }
});

router.get('/runs/:runId/events', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return respondDisabled(res);
        }

        const run = await service.getRun(req.params.runId, getOwnerId(req));
        if (!run) {
            return res.status(404).json({ error: { message: 'Async lab run not found' } });
        }

        const after = normalizeCursor(req.query.after);
        if (!shouldStream(req)) {
            const events = await service.listEvents(run.id, after);
            return res.json({
                runId: run.id,
                after,
                events,
            });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const sentKeys = new Set();
        const writeEvent = (event = {}) => {
            const cursor = normalizeCursor(event.cursor);
            if (cursor <= after) {
                return;
            }
            const key = normalizeText(event.eventId) || `${cursor}:${event.type || 'message'}`;
            if (sentKeys.has(key)) {
                return;
            }
            sentKeys.add(key);
            res.write(formatSseEvent(event));
        };

        const existingEvents = await service.listEvents(run.id, after);
        existingEvents.forEach(writeEvent);

        const unsubscribe = service.subscribeToRun(run.id, writeEvent);
        const keepAlive = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(keepAlive);
            unsubscribe?.();
            res.end();
        });
    } catch (error) {
        next(error);
    }
});

router.post('/runs/:runId/cancel', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return respondDisabled(res);
        }

        const result = await service.cancelRun(req.params.runId, getOwnerId(req));
        if (!result) {
            return res.status(404).json({ error: { message: 'Async lab run not found' } });
        }
        res.json(result);
    } catch (error) {
        next(error);
    }
});

function formatSseEvent(event = {}) {
    return [
        `id: ${normalizeCursor(event.cursor)}`,
        `event: ${event.type || 'message'}`,
        `data: ${JSON.stringify(event)}`,
        '',
        '',
    ].join('\n');
}

module.exports = router;
