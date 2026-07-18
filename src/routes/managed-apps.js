'use strict';

const { Router } = require('express');

const router = Router();

function getOwnerId(req) {
    return String(req.user?.username || '').trim() || null;
}

function getService(req) {
    return req.app.locals.managedAppService;
}

function handleUnavailable(res) {
    return res.status(503).json({
        error: {
            message: 'Managed apps require an active Postgres-backed session store',
        },
    });
}

router.get('/managed-apps', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const apps = await service.listApps(
            getOwnerId(req),
            Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50,
        );
        res.json({
            apps,
            count: apps.length,
        });
    } catch (error) {
        next(error);
    }
});

router.get('/managed-apps/readiness', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service || typeof service.inspectPushToWebReadiness !== 'function') {
            return res.status(503).json({
                error: {
                    code: 'MANAGED_APP_READINESS_UNAVAILABLE',
                    message: 'Managed-app Push-to-Web readiness inspection is unavailable.',
                },
            });
        }

        res.json(await service.inspectPushToWebReadiness());
    } catch (error) {
        next(error);
    }
});

router.post('/managed-apps', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const result = await service.createApp(req.body || {}, getOwnerId(req), {
            sessionId: req.body?.sessionId || null,
        });
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
});

router.get('/managed-apps/:ref', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const result = await service.inspectApp(req.params.ref, getOwnerId(req));
        if (!result) {
            return res.status(404).json({ error: { message: 'Managed app not found' } });
        }

        res.json(result);
    } catch (error) {
        next(error);
    }
});

router.get('/managed-apps/:ref/progress', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const result = await service.getAppProgress(req.params.ref, getOwnerId(req));
        if (!result) {
            return res.status(404).json({ error: { message: 'Managed app not found' } });
        }

        res.json(result);
    } catch (error) {
        next(error);
    }
});

router.patch('/managed-apps/:ref', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const result = await service.updateApp(req.params.ref, req.body || {}, getOwnerId(req), {
            sessionId: req.body?.sessionId || null,
        });
        if (!result) {
            return res.status(404).json({ error: { message: 'Managed app not found' } });
        }

        res.json(result);
    } catch (error) {
        next(error);
    }
});

router.post('/managed-apps/:ref/iterations', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const result = await service.iterateApp(req.params.ref, req.body || {}, getOwnerId(req), {
            sessionId: req.body?.sessionId || null,
        });
        if (!result) {
            return res.status(404).json({ error: { message: 'Managed app not found' } });
        }

        res.status(202).json(result);
    } catch (error) {
        next(error);
    }
});

router.post('/managed-apps/:ref/deploy', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const result = await service.deployApp(req.params.ref, req.body || {}, getOwnerId(req), {
            sessionId: req.body?.sessionId || null,
        });
        if (!result) {
            return res.status(404).json({ error: { message: 'Managed app not found' } });
        }

        res.status(202).json(result);
    } catch (error) {
        next(error);
    }
});

router.get('/managed-apps/:ref/build-runs', async (req, res, next) => {
    try {
        const service = getService(req);
        if (!service?.isAvailable()) {
            return handleUnavailable(res);
        }

        const runs = await service.listBuildRuns(
            req.params.ref,
            getOwnerId(req),
            Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 20,
        );
        res.json({
            runs,
            count: runs.length,
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
