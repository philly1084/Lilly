const { hasSelfReflectionUpdateIntentText } = require('./self-reflection-intent');

describe('self-reflection intent detection', () => {
  test('recognizes soul/user card growth requests as durable self-reflection intent', () => {
    expect(hasSelfReflectionUpdateIntentText(
      "the agent isn't updating the user card or soul card. can we make sure the agents are growing with our interactions",
    )).toBe(true);
    expect(hasSelfReflectionUpdateIntentText(
      'Please make Lilly learn from our conversations and update the user card when the lesson is stable.',
    )).toBe(true);
  });

  test('does not treat ordinary task wording as self-reflection intent', () => {
    expect(hasSelfReflectionUpdateIntentText('Summarize the latest product direction.')).toBe(false);
    expect(hasSelfReflectionUpdateIntentText('Help me learn React patterns for this dashboard.')).toBe(false);
  });
});
