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
});
