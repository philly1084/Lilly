'use strict';

const { imageUrls, discoveredToolName } = require('../../bin/lilly-grok-browser-proof');

test('browser proof requires actual typed pixels, not a textual mention', () => {
  expect(imageUrls([{ type: 'input_text', text: 'data:image/png;base64,AAA=' }])).toEqual([]);
  expect(imageUrls([{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA=' }] }])).toEqual(['data:image/png;base64,AAA=']);
});

test('browser tool names come from the actual Grok discovery output', () => {
  expect(discoveredToolName({ text: 'mcp__lilly__lilly_browser_observe' }, 'observe')).toBe('mcp__lilly__lilly_browser_observe');
  expect(() => discoveredToolName({ text: 'not_found' }, 'act')).toThrow();
  expect(() => discoveredToolName({ text: 'one__lilly_browser_act two__lilly_browser_act' }, 'act')).toThrow();
  expect(() => discoveredToolName({}, '.*')).toThrow();
});
