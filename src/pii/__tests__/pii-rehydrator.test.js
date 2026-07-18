const {
  rehydrateWithMap,
  splitHtmlTextSegments,
} = require('../pii-rehydrator');

describe('PII rehydrator', () => {
  test('restores placeholders with highlight markup', () => {
    const entryMap = new Map([
      ['[[PII:EMAIL:abc]]', { value: 'jane@example.com', type: 'email' }],
    ]);

    const result = rehydrateWithMap('Contact [[PII:EMAIL:abc]].', entryMap, { highlight: true });
    expect(result.text).toContain('<mark class="kb-pii-restored"');
    expect(result.text).toContain('jane@example.com');
    expect(result.restorations).toHaveLength(1);
  });

  test('escapes restored values when markup-free HTML output is requested', () => {
    const entryMap = new Map([
      ['[[PII:NAME:unsafe]]', { value: '<img src=x onerror="alert(1)">', type: 'person' }],
    ]);

    const result = rehydrateWithMap('Hello [[PII:NAME:unsafe]].', entryMap, {
      highlight: false,
      escapeValues: true,
    });

    expect(result.text).toBe('Hello &lt;img src=x onerror=&quot;alert(1)&quot;&gt;.');
    expect(result.text).not.toContain('<img');
    expect(result.restorations).toHaveLength(1);
  });

  test('splits HTML text nodes without scripts, styles, or attributes', () => {
    const html = '<div data-email="[[PII:EMAIL:abc]]">Hello [[PII:EMAIL:abc]]</div><script>[[PII:EMAIL:abc]]</script><style>[[PII:EMAIL:abc]]</style>';
    const segments = splitHtmlTextSegments(html).map(([start, end]) => html.slice(start, end));
    expect(segments).toContain('Hello [[PII:EMAIL:abc]]');
    expect(segments.join('\n')).not.toContain('data-email');
    expect(segments.join('\n')).not.toContain('<script>');
    expect(segments.join('\n')).not.toContain('<style>');
  });
});
