const { AIDocumentGenerator } = require('./ai-document-generator');

function buildResponse(text) {
  return {
    output: [{
      type: 'message',
      content: [{ text }],
    }],
  };
}

describe('AIDocumentGenerator', () => {
  test('extracts text from compatible Responses API envelopes', () => {
    const generator = new AIDocumentGenerator({});

    expect(generator.extractText({ outputText: 'Camel-case document text.' }))
      .toBe('Camel-case document text.');
    expect(generator.extractText({ output_text: 'Snake-case document text.' }))
      .toBe('Snake-case document text.');
    expect(generator.extractText({
      output: [{
        type: 'message',
        content: [
          { type: 'output_text', outputText: 'First section.' },
          { type: 'output_text', output_text: 'Second section.' },
        ],
      }],
    })).toBe('First section.Second section.');
    expect(generator.extractText({
      choices: [{
        message: {
          content: [
            { type: 'text', text: 'Chat section.' },
            { type: 'text', text: 'Next section.' },
          ],
        },
      }],
    })).toBe('Chat section.Next section.');
  });

  test('generates a document from top-level compatible output text', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => ({
        outputText: JSON.stringify({
          title: 'Provider Brief',
          sections: [{
            heading: 'Decision',
            content: 'Use the compatible response without losing the document.',
          }],
        }),
      })),
    });

    const result = await generator.generate('Create a provider brief', {
      qualityPass: false,
    });

    expect(result.title).toBe('Provider Brief');
    expect(result.sections[0].content).toContain('without losing the document');
  });

  test('extracts JSON payloads from prose-wrapped responses', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => buildResponse(
        'Here is the document JSON:\n{"title":"Weekly Brief","sections":[{"heading":"Overview","content":"Clear summary","level":1}]}',
      )),
    });

    const result = await generator.generate('Create a weekly brief', {
      documentType: 'report',
    });

    expect(result.title).toBe('Weekly Brief');
    expect(result.sections[0]).toEqual(expect.objectContaining({
      heading: 'Overview',
      content: 'Clear summary',
    }));
  });

  test('falls back to plain-text document structure when the model does not return JSON', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => buildResponse(
        'The source brief highlights three shifts: ticket volume is rising, overnight SLA misses are concentrated in one queue, and the backlog is now trending down.',
      )),
    });

    const result = await generator.generate('Create a dashboard-style HTML based on the weekly technology brief', {
      format: 'html',
      designPlan: {
        titleSuggestion: 'Weekly Technology Brief Dashboard',
        themeSuggestion: 'executive',
        outline: [{ heading: 'Operations Snapshot' }],
      },
    });

    expect(result.title).toBe('Weekly Technology Brief Dashboard');
    expect(result.theme).toBe('executive');
    expect(result.sections[0]).toEqual(expect.objectContaining({
      heading: 'Operations Snapshot',
      content: expect.stringContaining('The source brief highlights three shifts'),
    }));
    expect(result.metadata.parseRecovery).toBe('plain-text-fallback');
  });

  test('recovers visible document text when the model returns raw html instead of JSON', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => buildResponse(
        '<!doctype html><html><head><title>Cognac Launch Brief</title><style>body{color:white}</style></head><body><main><h1>Cognac Launch Brief</h1><p>Lead with cellar provenance, tasting notes, and buyer confidence.</p><script>window.x=1</script></main></body></html>',
      )),
    });

    const result = await generator.generate('Create a Cognac launch brief', {
      format: 'html',
      qualityPass: false,
    });

    expect(result.title).toBe('Cognac Launch Brief');
    expect(result.sections[0].heading).toBe('Cognac Launch Brief');
    expect(result.sections[0].content).toContain('Lead with cellar provenance');
    expect(result.sections[0].content).not.toContain('<!doctype');
    expect(result.sections[0].content).not.toContain('<main>');
    expect(result.sections[0].content).not.toContain('window.x');
    expect(result.metadata.parseRecovery).toBe('html-fallback');
  });

  test('document system prompt includes request-matched format guidance for html docs', () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(),
    });

    const prompt = generator.buildSystemPrompt({
      prompt: 'Create an HTML API documentation page with examples and troubleshooting notes',
      documentType: 'document',
      format: 'html',
    });

    expect(prompt).toContain('<document_formats>');
    expect(prompt).toContain('Selected document format: Reference / Documentation [reference-doc]');
    expect(prompt).toContain('Do not default to a generic numbered brief');
    expect(prompt).toContain('Use concrete, request-specific section headings');
  });

  test('document system prompt includes built-in quality and background guidance', () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(),
    });

    const prompt = generator.buildSystemPrompt({
      prompt: 'Create a designed PDF brief for a launch decision',
      documentType: 'executive-brief',
      format: 'pdf',
      designPlan: {
        selectedDesignOption: {
          id: 'briefing-grid',
          label: 'Briefing Grid',
        },
      },
    });

    expect(prompt).toContain('<quality_standard version="document-quality-2026-05-k26-creation-loop">');
    expect(prompt).toContain('Pass: Kimi K2.6-style creation loop with context, steps, critique, and proof');
    expect(prompt).toContain('<document_intake>');
    expect(prompt).toContain('brief_scan: extract known format, audience, purpose, source material, constraints, and acceptance checks');
    expect(prompt).toContain('checkpoint_or_default: ask one or two concise checkpoint questions only when missing context would materially change the output');
    expect(prompt).toContain('Never use missing context as a reason to produce boilerplate');
    expect(prompt).toContain('Build to the subject and user situation, not to a template slot');
    expect(prompt).toContain('<kimi_creation_loop>');
    expect(prompt).toContain('Intent and purpose lock');
    expect(prompt).toContain('<user_alignment_snapshot>');
    expect(prompt).toContain('metadata.userGoal, purposeLock, assumptions, openQuestions, acceptanceChecks, and verificationNotes');
    expect(prompt).toContain('"purposeLock": "One sentence naming the subject, audience, and outcome this document is built to support"');
    expect(prompt).toContain('<background_creation>');
    expect(prompt).toContain('Background Art Director');
    expect(prompt).toContain('<multi_agent_design_pass>');
    expect(prompt).toContain('Use high reasoning effort by default for document creation and quality review');
    expect(prompt).toContain('The user should not need to ask for better design prompts');
  });

  test('uses high reasoning effort by default for document generation and quality pass', async () => {
    const createResponse = jest.fn(async () => buildResponse(
      JSON.stringify({
        title: 'Launch Brief',
        sections: [
          { heading: 'Decision', content: 'Approve the launch once readiness gates pass.', level: 1 },
          { heading: 'Evidence', content: 'Support tickets and rollout checks are trending in the right direction.', level: 1 },
        ],
      }),
    ));
    const generator = new AIDocumentGenerator({ createResponse });

    await generator.generate('Create an executive launch brief', {
      documentType: 'executive-brief',
    });

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[0][0].reasoningEffort).toBe('high');
    expect(createResponse.mock.calls[1][0].reasoningEffort).toBe('high');
  });

  test('preserves explicit reasoning effort override for document generation', async () => {
    const createResponse = jest.fn(async () => buildResponse(
      JSON.stringify({
        title: 'Quick Brief',
        sections: [
          { heading: 'Summary', content: 'Short update.', level: 1 },
          { heading: 'Next Step', content: 'Review with the team.', level: 1 },
        ],
      }),
    ));
    const generator = new AIDocumentGenerator({ createResponse });

    await generator.generate('Create a quick brief', {
      reasoningEffort: 'medium',
      qualityReasoningEffort: 'low',
    });

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[0][0].reasoningEffort).toBe('medium');
    expect(createResponse.mock.calls[1][0].reasoningEffort).toBe('low');
  });

  test('applies the built-in document quality pass after generation', async () => {
    const createResponse = jest.fn()
      .mockResolvedValueOnce(buildResponse(JSON.stringify({
        title: 'Launch Brief',
        sections: [
          {
            heading: 'Decision',
            content: 'Approve the launch plan because the operating risks are manageable and the upside is clear.',
          },
          {
            heading: 'Evidence',
            content: 'Pipeline coverage is improving and support capacity is staffed for the first release wave.',
          },
        ],
      })))
      .mockResolvedValueOnce(buildResponse(JSON.stringify({
        title: 'Launch Brief',
        sections: [
          {
            heading: 'Approve the focused launch path',
            content: 'Approve the launch plan because the operating risks are manageable, the upside is clear, and owners are assigned.',
          },
          {
            heading: 'The evidence supports a controlled release',
            content: 'Pipeline coverage is improving and support capacity is staffed for the first release wave.',
          },
        ],
        metadata: {
          qualityNotes: ['Sharpened decision heading and evidence framing.'],
        },
      })));
    const generator = new AIDocumentGenerator({ createResponse });

    const result = await generator.generate('Create an executive launch brief', {
      documentType: 'executive-brief',
      format: 'html',
      retryOnScaffold: false,
    });

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1][0].input[1].content).toContain('<multi_agent_design_pass>');
    expect(result.sections[0].heading).toBe('Approve the focused launch path');
    expect(result.metadata.qualityPassApplied).toBe(true);
    expect(result.metadata.qualityStandard).toEqual(expect.objectContaining({
      version: 'document-quality-2026-05-k26-creation-loop',
      passName: 'Kimi K2.6-style creation loop with context, steps, critique, and proof',
      agentPasses: expect.arrayContaining(['background-art-director', 'accessibility-reviewer']),
      creationLoop: expect.arrayContaining(['intent-lock', 'critic-repair', 'handoff-proof']),
    }));
  });

  test('recovers JSON-like quality pass responses for HTML and CSS repair drafts', async () => {
    const createResponse = jest.fn()
      .mockResolvedValueOnce(buildResponse(JSON.stringify({
        title: 'Solar Literacy Draft',
        sections: [
          {
            heading: 'Repair the reading surface',
            content: 'The draft needs readable panels, explicit CSS color pairs, and responsive layout checks.',
          },
        ],
      })))
      .mockResolvedValueOnce(buildResponse([
        'Quality repair object:',
        '{',
        '  title: “Solar Literacy Repair: HTML Structure Fix with Visual Treatments”,',
        '  theme: "editorial",',
        '  sections: [',
        '    { heading: "CSS failures fixed", content: "Root-relative stylesheet links and weak contrast notes are repaired before preview.", level: 1, },',
        '  ],',
        '  metadata: { qualityNotes: ["Recovered JSON-like HTML/CSS quality response."], },',
        '}',
      ].join('\n')));
    const generator = new AIDocumentGenerator({ createResponse });

    const result = await generator.generate('Create an HTML solar literacy document and fix CSS failures', {
      documentType: 'document',
      format: 'html',
      retryOnScaffold: false,
    });

    expect(result.title).toBe('Solar Literacy Repair: HTML Structure Fix with Visual Treatments');
    expect(result.sections[0]).toEqual(expect.objectContaining({
      heading: 'CSS failures fixed',
      content: expect.stringContaining('Root-relative stylesheet links'),
    }));
    expect(result.metadata.qualityPassApplied).toBe(true);
    expect(result.metadata.qualityPassError).toBeUndefined();
  });

  test('scrubs tool diagnostics from visible document sections', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => buildResponse(JSON.stringify({
        title: 'Safety Brief',
        sections: [{
          heading: 'Research Notes',
          content: [
            'The web-fetch step failed with this exact error: Missing required parameter: url.',
            'USPA reports a long-term decline in fatality rates.',
          ].join('\n'),
          bullets: [
            'I used the verified web-search results instead.',
            'Use current SIM requirements as the source of truth.',
          ],
        }],
      }))),
    });

    const result = await generator.generate('Create a skydiving safety brief', {
      format: 'html',
    });

    expect(result.sections[0].content).not.toContain('web-fetch');
    expect(result.sections[0].content).not.toContain('Missing required parameter');
    expect(result.sections[0].content).toContain('USPA reports');
    expect(result.sections[0].bullets).toEqual([
      'Use current SIM requirements as the source of truth.',
    ]);
  });

  test('scrubs placeholder residue from visible document sections', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => buildResponse(JSON.stringify({
        title: 'Roadmap Brief',
        subtitle: 'TODO add executive subtitle',
        sections: [{
          heading: 'Execution Plan',
          content: [
            'This section should explain the rollout plan.',
            'Owners will sequence intake, build, pilot, and launch reviews across the release window.',
            '[Insert chart here]',
          ].join('\n'),
          bullets: [
            'Insert specific examples here',
            'Pilot owners confirm launch readiness by Friday.',
          ],
          callout: {
            title: 'TBD',
            body: 'Use the pilot result as the approval gate.',
          },
        }],
      }))),
    });

    const result = await generator.generate('Create a roadmap execution brief', {
      format: 'html',
      qualityPass: false,
    });

    expect(result.subtitle).toBe('');
    expect(result.sections[0].content).toBe(
      'Owners will sequence intake, build, pilot, and launch reviews across the release window.',
    );
    expect(result.sections[0].bullets).toEqual([
      'Pilot owners confirm launch readiness by Friday.',
    ]);
    expect(result.sections[0].callout).toEqual(expect.objectContaining({
      title: '',
      body: 'Use the pilot result as the approval gate.',
    }));
  });

  test('scrubs internal thought markup from visible document fields', async () => {
    const generator = new AIDocumentGenerator({
      createResponse: jest.fn(async () => buildResponse(JSON.stringify({
        title: '<analysis>Pick a title before writing.</analysis>Incident Readiness Brief',
        subtitle: '[reasoning]Private outline should not render.[/reasoning]Operations review',
        sections: [{
          heading: 'BEGIN REASONING\nUse a dramatic heading.\nEND REASONING\nReadiness Signals',
          content: [
            '<thinking>Compare three possible structures.</thinking>',
            'Pager coverage, rollback ownership, and customer messaging are ready for release review.',
            '<!-- analysis: keep this planning note private. -->',
          ].join('\n'),
          bullets: [
            '[thought]Mention internal debate.[/thought]Rollback owner confirmed.',
            '<reasoning>Private scoring.</reasoning>Support rotation staffed.',
          ],
          callout: {
            title: '<think>Private framing</think>Decision Gate',
            body: '<!-- reasoning: hidden note -->Proceed once the smoke test is green.',
          },
        }],
      }))),
    });

    const result = await generator.generate('Create an incident readiness brief', {
      format: 'html',
      qualityPass: false,
    });

    expect(result.title).toBe('Incident Readiness Brief');
    expect(result.subtitle).toBe('Operations review');
    expect(result.sections[0].heading).toBe('Readiness Signals');
    expect(result.sections[0].content).toBe(
      'Pager coverage, rollback ownership, and customer messaging are ready for release review.',
    );
    expect(result.sections[0].bullets).toEqual([
      'Rollback owner confirmed.',
      'Support rotation staffed.',
    ]);
    expect(result.sections[0].callout).toEqual(expect.objectContaining({
      title: 'Decision Gate',
      body: 'Proceed once the smoke test is green.',
    }));
  });

  test('presentation prompt includes template-gallery guidance and treats templates as examples', async () => {
    const createResponse = jest.fn(async () => buildResponse(
      JSON.stringify({
        title: 'Launch Story',
        theme: 'executive',
        slides: [
          { layout: 'title', title: 'Launch Story', subtitle: 'Q2' },
          { layout: 'content', title: 'Momentum', bullets: ['Pipeline is growing'] },
        ],
      }),
    ));
    const generator = new AIDocumentGenerator({ createResponse });

    await generator.generatePresentationContent('Build a launch deck', {
      documentType: 'presentation',
      slideCount: 2,
      designPlan: {
        recommendedTemplates: [
          {
            id: 'board-update-deck',
            name: 'Board Update Deck',
            description: 'Leadership-ready presentation template',
            useCases: ['board update'],
          },
        ],
      },
    });

    const prompt = createResponse.mock.calls[0][0].input[0].content;
    expect(prompt).toContain('<template_gallery>');
    expect(prompt).toContain('examples and building blocks, not hard rules');
    expect(prompt).toContain('Board Update Deck');
    expect(prompt).toContain('If the request would benefit from a hybrid structure, combine patterns from multiple templates');
  });

  test('preserves compatible object-shaped presentation bullets as visible text', async () => {
    const createResponse = jest.fn(async () => buildResponse(JSON.stringify({
      title: 'Launch Decision',
      slides: [{
        layout: 'content',
        title: 'Recommendation',
        bullets: [
          { text: 'Approve the pilot.' },
          { content: 'Measure conversion weekly.' },
          { label: 'Keep rollback ownership explicit.' },
          { unsupported: 'Do not stringify this object.' },
        ],
      }],
    })));
    const generator = new AIDocumentGenerator({ createResponse });

    const result = await generator.generatePresentationContent('Build a decision deck', {
      qualityPass: false,
    });

    expect(result.slides[0].bullets).toEqual([
      'Approve the pilot.',
      'Measure conversion weekly.',
      'Keep rollback ownership explicit.',
    ]);
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });

  test('scrubs placeholder and internal thought residue from presentation slides', async () => {
    const createResponse = jest.fn(async () => buildResponse(JSON.stringify({
      title: '<analysis>Private title draft.</analysis>Launch Readiness Deck',
      subtitle: 'TODO add subtitle',
      theme: 'executive',
      slides: [
        {
          layout: 'title',
          kicker: '[reasoning]Rank framing.[/reasoning]Decision ready',
          title: 'BEGIN REASONING\nTry a louder headline.\nEND REASONING\nLaunch Readiness',
          subtitle: 'This slide should explain the launch context.',
          bullets: [
            'Insert specific examples here',
            'Owners confirmed launch readiness by Friday.',
          ],
          stats: [
            { label: 'TBD', value: '98%', detail: 'Smoke pass rate' },
            { label: 'Pilot', value: '3', detail: '<thinking>hide</thinking>Teams staffed' },
          ],
          columns: [{
            heading: 'Placeholder',
            content: 'Support and rollout owners are assigned.',
            bullets: ['[Insert chart here]', 'Rollback owner confirmed.'],
          }],
          chart: {
            title: 'Readiness Trend',
            summary: '<reasoning>Private chart note.</reasoning>Checks improved across the week.',
            series: [
              { label: 'TODO', value: 1 },
              { label: 'Smoke checks', value: 98 },
            ],
          },
          imagePrompt: 'Add image here',
          imageAlt: '<think>image draft</think>Launch room dashboard',
          imageSource: '<!-- reasoning: source draft -->Internal readiness review',
        },
      ],
    })));
    const generator = new AIDocumentGenerator({ createResponse });

    const result = await generator.generatePresentationContent('Build a launch readiness deck', {
      qualityPass: false,
      includeImages: true,
    });

    expect(result.title).toBe('Launch Readiness Deck');
    expect(result.subtitle).toBe('');
    expect(result.slides[0]).toEqual(expect.objectContaining({
      kicker: 'Decision ready',
      title: 'Launch Readiness',
      subtitle: '',
      bullets: ['Owners confirmed launch readiness by Friday.'],
      imagePrompt: '',
      imageAlt: 'Launch room dashboard',
      imageSource: 'Internal readiness review',
      generateImage: false,
    }));
    expect(result.slides[0].stats).toEqual([
      { label: 'Pilot', value: '3', detail: 'Teams staffed' },
    ]);
    expect(result.slides[0].columns).toEqual([{
      heading: '',
      content: 'Support and rollout owners are assigned.',
      bullets: ['Rollback owner confirmed.'],
    }]);
    expect(result.slides[0].chart).toEqual(expect.objectContaining({
      title: 'Readiness Trend',
      summary: 'Checks improved across the week.',
      series: [{ label: 'Smoke checks', value: 98 }],
    }));
  });
});
