const { JSDOM } = require('jsdom');
const { normalizeOverview, matchesAgent, escapeHtml } = require('./agent-ops');

describe('Agent Command Center data boundary', () => {
  test('normalizes missing groups and null runtime metrics without inventing values', () => {
    const overview = normalizeOverview({
      project: { name: 'Runtime truth' },
      groups: { working: [{ agentId: 'a1', displayName: 'Ada', metrics: { cpu: null, memory: null } }] },
    });

    expect(overview.groups.needsInput).toEqual([]);
    expect(overview.groups.idle).toEqual([]);
    expect(overview.groups.working[0]).toMatchObject({ id: 'a1', name: 'Ada', cpu: null, memory: null });
  });

  test('filters across operational agent fields case-insensitively', () => {
    const agent = normalizeOverview({ groups: { working: [{ id: 'mira', name: 'Mira', role: 'Test investigator', task: 'Investigate CI flake', currentAction: 'Re-running spec', model: 'gpt-5' }] } }).groups.working[0];

    expect(matchesAgent(agent, 'ci FLAKE')).toBe(true);
    expect(matchesAgent(agent, 'gpt-5')).toBe(true);
    expect(matchesAgent(agent, 'billing')).toBe(false);
  });

  test('escapes server-provided content before HTML rendering', () => {
    const dom = new JSDOM(`<div>${escapeHtml('<img src=x onerror=alert(1)>')}</div>`);

    expect(dom.window.document.querySelector('img')).toBeNull();
    expect(dom.window.document.querySelector('div').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
