const { JSDOM } = require('jsdom');
const {
  MISSION_TEMPLATES,
  buildMissionHref,
  hydrateLaunchpad,
} = require('./launchpad');

describe('Lilly launchpad', () => {
  test.each(Object.keys(MISSION_TEMPLATES))('builds a prefilled, non-submitting mission URL for %s', (templateId) => {
    const href = buildMissionHref(templateId);
    const parsed = new URL(href, 'http://localhost');

    expect(parsed.pathname).toBe('/web-chat/app.html');
    expect(parsed.searchParams.get('mission')).toBe(templateId);
    expect(parsed.searchParams.get('starter')).toBe(MISSION_TEMPLATES[templateId].starter);
    expect(parsed.searchParams.has('submit')).toBe(false);
    expect(parsed.searchParams.has('autorun')).toBe(false);
  });

  test('hydrates cards with accessible labels and leaves the Agent Company route direct', () => {
    const dom = new JSDOM(`
      <a data-mission-link="build-launch"></a>
      <a data-mission-link="research-publish"></a>
      <a data-mission-link="create-refine"></a>
      <a data-agent-company href="/admin/?view=agentCompany"></a>
    `);

    expect(hydrateLaunchpad(dom.window.document)).toBe(3);
    const cards = [...dom.window.document.querySelectorAll('[data-mission-link]')];
    expect(cards.every((card) => card.href.includes('/web-chat/app.html?mission='))).toBe(true);
    expect(cards.every((card) => /with Lilly$/.test(card.getAttribute('aria-label')))).toBe(true);
    expect(dom.window.document.querySelector('[data-agent-company]').getAttribute('href')).toBe('/admin/?view=agentCompany');
  });

  test('falls back to Web Chat for an unknown mission template', () => {
    expect(buildMissionHref('unknown')).toBe('/web-chat/app.html');
  });
});
