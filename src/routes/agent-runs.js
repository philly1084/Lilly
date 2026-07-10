'use strict';

const { Router } = require('express');
const { normalizeCursor, normalizeText } = require('../async-lab/valkey-live-bus');

const router = Router();

function getOwnerId(req) {
  return normalizeText(req.user?.username) || null;
}

function getService(req) {
  return req.app.locals.agentRunService;
}

function respondUnavailable(res) {
  return res.status(503).json({
    error: {
      type: 'agent_run_unavailable',
      message: 'AgentRun runtime is unavailable.',
    },
  });
}

function respondNotFound(res) {
  return res.status(404).json({
    error: {
      type: 'agent_run_not_found',
      message: 'AgentRun not found.',
    },
  });
}

function wantsEventStream(req) {
  return String(req.query.stream || '').trim().toLowerCase() === 'true'
    || String(req.get('accept') || '').toLowerCase().includes('text/event-stream');
}

function getReplayCursor(req) {
  const queryCursor = req.query.after;
  const headerCursor = req.get('last-event-id');
  return normalizeCursor(queryCursor === undefined ? headerCursor : queryCursor);
}

function writeEventStream(res, replay = {}) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Agent-Run-Event-Cursor': String(replay.eventCursor || 0),
  });
  res.flushHeaders?.();
  (replay.events || []).forEach((event) => {
    res.write(`id: ${event.cursor}\n`);
    res.write(`event: ${event.type || 'run.event'}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  res.write(`event: replay.complete\ndata: ${JSON.stringify({
    runId: replay.run.id,
    eventCursor: replay.eventCursor,
  })}\n\n`);
  return res.end();
}

router.post('/', async (req, res, next) => {
  try {
    const service = getService(req);
    if (!service?.createRun) {
      return respondUnavailable(res);
    }

    const result = await service.createRun({
      ...(req.body || {}),
      idempotencyKey: req.body?.idempotencyKey
        || req.body?.idempotency_key
        || req.get('x-idempotency-key')
        || '',
    }, getOwnerId(req));

    return res.status(result.duplicate ? 200 : 201).json({
      run: result.run,
      duplicate: result.duplicate === true,
      events: result.events || [],
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:runId/events', async (req, res, next) => {
  try {
    const service = getService(req);
    if (!service?.replayRun) {
      return respondUnavailable(res);
    }

    const after = getReplayCursor(req);
    const replay = await service.replayRun(req.params.runId, after, getOwnerId(req));
    if (!replay) {
      return respondNotFound(res);
    }

    if (wantsEventStream(req)) {
      return writeEventStream(res, replay);
    }

    return res.json({
      runId: replay.run.id,
      after,
      eventCursor: replay.eventCursor,
      events: replay.events,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:runId', async (req, res, next) => {
  try {
    const service = getService(req);
    if (!service?.getRun) {
      return respondUnavailable(res);
    }

    const run = await service.getRun(req.params.runId, getOwnerId(req));
    if (!run) {
      return respondNotFound(res);
    }
    return res.json({ run });
  } catch (error) {
    return next(error);
  }
});

router.post('/:runId/actions', async (req, res, next) => {
  try {
    const service = getService(req);
    if (!service?.performAction) {
      return respondUnavailable(res);
    }

    const result = await service.performAction(req.params.runId, {
      ...(req.body || {}),
      idempotencyKey: req.body?.idempotencyKey
        || req.body?.idempotency_key
        || req.get('x-idempotency-key')
        || '',
    }, getOwnerId(req));
    if (!result) {
      return respondNotFound(res);
    }

    return res.json({
      action: result.action,
      run: result.run,
      duplicate: result.duplicate === true,
      event: result.event || null,
      ...(result.forkedRun ? { forkedRun: result.forkedRun } : {}),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.getReplayCursor = getReplayCursor;
module.exports.wantsEventStream = wantsEventStream;
module.exports.writeEventStream = writeEventStream;
