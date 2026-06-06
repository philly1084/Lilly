'use strict';

const { Router } = require('express');
const { normalizeText } = require('../async-lab/valkey-live-bus');

const router = Router();

function getService(req) {
    return req.app.locals.asyncLabService;
}

function getProvidedSecret(req) {
    return normalizeText(
        req.get('x-kimibuilt-async-lab-secret')
        || req.get('x-gitlab-token')
        || req.get('x-gitea-webhook-secret')
        || '',
    );
}

router.post('/build-events', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isEnabled()) {
            return res.status(503).json({
                success: false,
                error: 'Async runtime lab is disabled',
            });
        }

        const expectedSecret = normalizeText(service.config?.webhookSecret);
        if (!expectedSecret) {
            return res.status(503).json({
                success: false,
                error: 'Async lab webhook secret is not configured',
            });
        }

        if (getProvidedSecret(req) !== expectedSecret) {
            return res.status(401).json({
                success: false,
                error: 'Invalid async lab webhook secret',
            });
        }

        const result = await service.handleBuildWebhook(req.body || {}, {
            ownerId: normalizeText(req.get('x-kimibuilt-owner-id')) || 'async-lab-webhook',
            idempotencyKey: normalizeText(req.get('x-idempotency-key')),
            externalRunId: normalizeText(req.get('x-gitlab-event-uuid')),
            followUp: normalizeText(req.get('x-kimibuilt-async-follow-up')),
        });
        res.status(result.duplicate ? 200 : 202).json({
            success: true,
            data: result,
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
