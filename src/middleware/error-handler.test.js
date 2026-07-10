'use strict';

const { errorHandler } = require('./error-handler');

function createResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('global error handler', () => {
  test('reports AgentRun conflicts as agent_run_error rather than OpenAI failures', () => {
    const error = Object.assign(new Error('Cannot resume from completed.'), {
      code: 'AGENT_RUN_NOT_RESUMABLE',
      status: 409,
    });
    const response = createResponse();

    errorHandler(error, { path: '/api/agent-runs/run-1/actions' }, response, jest.fn());

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        type: 'agent_run_error',
        message: 'Cannot resume from completed.',
        code: 'AGENT_RUN_NOT_RESUMABLE',
      },
    });
  });
});
