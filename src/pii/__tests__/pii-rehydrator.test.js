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

  test('splits HTML text nodes without scripts, styles, or attributes', () => {
    const html = '<div data-email="[[PII:EMAIL:abc]]">Hello [[PII:EMAIL:abc]]</div><script>[[PII:EMAIL:abc]]</script><style>[[PII:EMAIL:abc]]</style>';
    const segments = splitHtmlTextSegments(html).map(([start, end]) => html.slice(start, end));
    expect(segments).toContain('Hello [[PII:EMAIL:abc]]');
    expect(segments.join('\n')).not.toContain('data-email');
    expect(segments.join('\n')).not.toContain('<script>');
    expect(segments.join('\n')).not.toContain('<style>');
  });
});
