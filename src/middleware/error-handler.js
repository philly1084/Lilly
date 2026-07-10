/**
 * Global error handler middleware.
 * Catches all unhandled errors and returns consistent JSON responses.
 */
function errorHandler(err, req, res, _next) {
    console.error(`[Error] ${err.message}`, err.stack);
    const isCompatApiRequest = typeof req?.path === 'string'
        && (req.path.startsWith('/v1/') || req.path.startsWith('/api/chat'));

    if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
            try {
                res.end();
            } catch (_error) {
                // Best-effort close for partially written streaming responses.
            }
        }
        return;
    }

    if (String(err.code || '').startsWith('AGENT_RUN_')
        || ['INVALID_AGENT_RUN_ACTION', 'INVALID_AGENT_RUN_STATE', 'ILLEGAL_AGENT_RUN_TRANSITION'].includes(err.code)) {
        return res.status(err.statusCode || err.status || 400).json({
            error: {
                type: 'agent_run_error',
                message: err.message,
                code: err.code || null,
            },
        });
    }

    // OpenAI API errors
    if (err.constructor?.name === 'APIError'
        || err.name === 'OpenAIError'
        || err.type === 'openai_error') {
        return res.status(err.status || 502).json({
            error: {
                type: 'openai_error',
                message: err.message,
                code: err.code || null,
            },
        });
    }

    // Validation errors
    if (err.type === 'validation') {
        return res.status(400).json({
            error: {
                type: 'validation_error',
                message: err.message,
                fields: err.fields || null,
            },
        });
    }

    // Generic errors
    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
        error: {
            type: 'internal_error',
            message:
                process.env.NODE_ENV === 'production' && !isCompatApiRequest
                    ? 'An internal error occurred'
                    : err.message,
        },
    });
}

module.exports = { errorHandler };
