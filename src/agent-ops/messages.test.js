'use strict';

const { buildAgentMessages, extractLinks, safeLink } = require('./messages');

describe('Agent user handoffs', () => {
  const workloads = [{ id: 'w1', title: 'Build the site', metadata: { agentCompany: { roleId: 'production', roleName: 'Production Lead' } } }];

  test('exposes the actual reply with links and separate attachments, not a lifecycle label', () => {
    const result = buildAgentMessages(workloads, [{
      id: 'r1', workloadId: 'w1', status: 'completed', finishedAt: '2026-09-02T12:00:00Z',
      metadata: { output: { text: 'Website is ready.\n[Open website](https://canada.demoserver2.buzz/).\nBrowser check passed.', artifactMessage: 'HTML generated.', artifacts: [{ id: 'file1', filename: 'source.zip' }] } },
    }]);
    expect(result[0]).toMatchObject({ from: 'Production Lead', agentId: 'production', message: expect.stringContaining('Website is ready.'), links: [{ url: 'https://canada.demoserver2.buzz/', label: 'canada.demoserver2.buzz' }], attachments: [{ id: 'file1', label: 'source.zip', url: '/api/artifacts/file1/download' }] });
  });

  test('keeps run boundaries, failed replies, newest-first order, and full long messages', () => {
    const longMessage = 'Full result '.repeat(500) + ' https://example.test/final';
    const result = buildAgentMessages(workloads, [
      { id: 'old', workloadId: 'w1', finishedAt: '2026-09-01', metadata: { output: { text: longMessage } } },
      { id: 'new', workloadId: 'w1', finishedAt: '2026-09-02', status: 'failed', error: { message: 'Permission denied' } },
      { id: 'other', workloadId: 'unrelated', metadata: { output: { text: 'Private other project' } } },
      { id: 'empty', workloadId: 'w1', status: 'running' },
    ]);
    expect(result.map((item) => item.id)).toEqual(['handoff:new', 'handoff:old']);
    expect(result[0]).toMatchObject({ status: 'failed', message: 'Permission denied' });
    expect(result[1].message).toBe(longMessage);
  });

  test('allows only safe web/file URLs and deduplicates links', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,test', '//evil.test', '/\\evil.test', 'https://secret:password@example.test']) expect(safeLink(url)).toBeNull();
    expect(safeLink('/api/artifacts/123/download')).toBe('/api/artifacts/123/download');
    expect(extractLinks('https://example.test/. Again https://example.test/.')).toEqual([{ url: 'https://example.test/', label: 'example.test' }]);
  });

  test('separates a finished scheduler run from pending remote execution', () => {
    const result = buildAgentMessages(workloads, [{
      id: 'pending', workloadId: 'w1', status: 'completed', metadata: { output: {
        text: 'Overall goal complete.', remoteExecution: { completionStatus: 'running', remoteCodeJobId: 'job1' },
      } },
    }]);
    expect(result[0]).toMatchObject({ status: 'running', runStatus: 'completed', goalComplete: false, remoteExecution: { remoteCodeJobId: 'job1' } });
    expect(result[0].message).toMatch(/^At this stage, remote execution was still pending; this update is not a completed goal\./);
  });

  test('historical handoffs use only their own observations, never a newer workload cursor', () => {
    const changedWorkloads = [{ ...workloads[0], metadata: { ...workloads[0].metadata,
      companyRemoteExecution: { state: { completionStatus: 'running', remoteCodeJobId: 'different-goal-job' } },
    } }];
    const result = buildAgentMessages(changedWorkloads, [{
      id: 'old', workloadId: 'w1', status: 'completed', metadata: { output: {
        text: 'Verified and ready.', remoteExecution: { completionStatus: 'complete', remoteCodeJobId: 'old-job' },
      } },
    }, {
      id: 'legacy', workloadId: 'w1', status: 'completed', metadata: { output: { text: 'Historical handoff.' } },
    }]);
    expect(result.find((item) => item.runId === 'old')).toMatchObject({ status: 'completed', message: 'Verified and ready.', remoteExecution: { remoteCodeJobId: 'old-job' } });
    expect(result.find((item) => item.runId === 'legacy')).toMatchObject({ status: 'completed', message: 'Historical handoff.' });
  });

  test.each([
    [{ requested: 'high', applied: 'high', status: 'applied', appliedTo: 'cli-invocation' }, 'high effort applied to CLI invocation.'],
    [{ requested: 'high', status: 'forwarded' }, 'high requested; application unconfirmed.'],
  ])('shows the same-run runtime receipt honestly', (reasoningEffortReceipt, label) => {
    const result = buildAgentMessages(workloads, [{
      id: 'receipt', workloadId: 'w1', status: 'completed', metadata: { output: {
        text: 'Files verified.', remoteExecution: { completionStatus: 'complete', providerModel: 'gpt-5.6-luna', reasoningEffortReceipt },
      } },
    }]);
    expect(result[0].message).toBe(`Files verified.\n\nRuntime: gpt-5.6-luna · ${label}`);
  });

  test('does not infer applied effort from model prose, requested settings, or a receipt for another stage', () => {
    const changedWorkloads = [{ ...workloads[0], metadata: { ...workloads[0].metadata,
      reasoningEffort: 'high', companyRemoteExecution: { state: { providerModel: 'gpt-5.6-luna', reasoningEffortReceipt: {
        requested: 'high', applied: 'high', status: 'applied', appliedTo: 'cli-invocation',
      } } },
    } }];
    const result = buildAgentMessages(changedWorkloads, [{
      id: 'no-receipt', workloadId: 'w1', status: 'completed', metadata: { output: { text: 'I used high effort.' } },
    }, {
      id: 'invalid-receipt', workloadId: 'w1', status: 'completed', metadata: { output: { text: 'Verified.', remoteExecution: {
        providerModel: 'gpt-5.6-luna', reasoningEffortReceipt: { requested: 'high', applied: 'high', status: 'applied', appliedTo: 'planner' },
      } } },
    }]);
    expect(result.every((item) => !item.message.includes('Runtime:'))).toBe(true);
  });
});
