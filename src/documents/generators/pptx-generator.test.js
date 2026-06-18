const { PptxGenerator } = require('./pptx-generator');

describe('PptxGenerator', () => {
  test('turns markdown slide outlines into real slides instead of one raw string', () => {
    const presentation = new PptxGenerator().normalizePresentationContent({
      title: 'Today News Casefile',
      content: [
        '# Today News Casefile',
        '## Main Signals',
        '- Diplomacy is moving fast',
        '- Technology investment remains intense',
        '## What To Watch',
        '- Policy windows',
        '- Market reactions',
      ].join('\n'),
    });

    expect(presentation.slides).toHaveLength(3);
    expect(presentation.slides[0]).toMatchObject({
      layout: 'title',
      title: 'Today News Casefile',
    });
    expect(presentation.slides[1]).toMatchObject({
      layout: 'content',
      title: 'Main Signals',
      bullets: ['Diplomacy is moving fast', 'Technology investment remains intense'],
    });
    expect(presentation.slides[2]).toMatchObject({
      layout: 'content',
      title: 'What To Watch',
      bullets: ['Policy windows', 'Market reactions'],
    });
    expect(JSON.stringify(presentation.slides)).not.toContain('# Today News Casefile');
    expect(JSON.stringify(presentation.slides)).not.toContain('## Main Signals');
  });

  test('extracts presentation slides from HTML-ish source', () => {
    const presentation = new PptxGenerator().normalizePresentationContent({
      title: 'Launch Brief',
      content: [
        '<!DOCTYPE html>',
        '<html><body>',
        '<h1>Launch Brief</h1>',
        '<h2>Audience Need</h2>',
        '<p>Buyers need a simpler migration story.</p>',
        '<ul><li>Reduce setup risk</li><li>Clarify support path</li></ul>',
        '<h2>Next Move</h2>',
        '<p>Package the proof points into a short executive deck.</p>',
        '</body></html>',
      ].join('\n'),
    });

    const allText = JSON.stringify(presentation.slides);

    expect(presentation.slides).toHaveLength(3);
    expect(allText).toContain('Launch Brief');
    expect(allText).toContain('Audience Need');
    expect(allText).toContain('Reduce setup risk');
    expect(allText).toContain('Next Move');
    expect(allText).not.toContain('<h1>');
    expect(allText).not.toContain('<!DOCTYPE html>');
  });

  test('accepts JSON slide specs provided as artifact text', () => {
    const source = JSON.stringify({
      title: 'Structured Deck',
      theme: 'executive',
      slides: [
        { layout: 'title', title: 'Structured Deck', subtitle: 'Artifact text' },
        { layout: 'content', title: 'Decision', bullets: ['Approve the pilot', 'Measure conversion'] },
      ],
    });

    const presentation = new PptxGenerator().normalizePresentationContent({
      title: 'Structured Deck',
      content: source,
    });

    const allText = JSON.stringify(presentation.slides);

    expect(presentation.slides).toHaveLength(2);
    expect(allText).toContain('Structured Deck');
    expect(allText).toContain('Approve the pilot');
    expect(allText).not.toContain('"slides"');
  });

  test('uses title and content labels as structure instead of visible prose', () => {
    const presentation = new PptxGenerator().normalizePresentationContent({
      content: [
        'Title: Active Artifact Fix',
        'Subtitle: PPTX recovery',
        'Content: Preserve binary downloads while converting source text into slide structure.',
        'Slide 2: Verification',
        '- Check ZIP magic',
        '- Inspect slide XML text',
      ].join('\n'),
    });

    const allText = JSON.stringify(presentation.slides);

    expect(presentation.title).toBe('Active Artifact Fix');
    expect(presentation.subtitle).toBe('PPTX recovery');
    expect(presentation.slides[0]).toMatchObject({
      layout: 'title',
      title: 'Active Artifact Fix',
      subtitle: 'PPTX recovery',
    });
    expect(presentation.slides[1].content).toContain('Preserve binary downloads');
    expect(presentation.slides[2]).toMatchObject({
      title: 'Verification',
      bullets: ['Check ZIP magic', 'Inspect slide XML text'],
    });
    expect(allText).not.toContain('Title:');
    expect(allText).not.toContain('Content:');
  });

  test('splits inline model-labeled presentation strings into multiple slides', () => {
    const presentation = new PptxGenerator().normalizePresentationContent({
      title: 'pptx-2026-06-18',
      content: [
        'Title: Monkeys Subtitle: Intelligence, Adaptation, and What They Reveal About Life on Earth',
        'Format: PPTX presentation draft Style: Launch Manifesto',
        'Slide 1: Cover Monkeys Intelligence in Motion',
        'Slide 2: Why Monkeys Matter Monkeys are social, adaptive primates that reveal how intelligence evolves.',
        'Slide 3: Key Adaptations - Tool use - Social learning - Flexible diets',
      ].join(' '),
    });

    const allText = JSON.stringify(presentation.slides);

    expect(presentation.title).toBe('Monkeys');
    expect(presentation.subtitle).toBe('Intelligence, Adaptation, and What They Reveal About Life on Earth');
    expect(presentation.slides.length).toBeGreaterThanOrEqual(4);
    expect(allText).toContain('Cover Monkeys Intelligence in Motion');
    expect(allText).toContain('Why Monkeys Matter Monkeys are social');
    expect(allText).toContain('Key Adaptations');
    expect(allText).not.toContain('Format:');
    expect(allText).not.toContain('Style:');
  });
});
