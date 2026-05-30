const {
  buildSandboxBrowserLibraryInstructions,
  getSandboxBrowserLibraryCatalog,
  normalizeAssetPath,
  normalizeLibraryId,
  resolveSandboxBrowserLibraryAsset,
} = require('./sandbox-browser-libraries');

describe('sandbox browser library catalog', () => {
  test('includes graph, chart, animation, simulation, and 3D libraries', () => {
    const ids = getSandboxBrowserLibraryCatalog().map((library) => library.id);

    expect(ids).toEqual(expect.arrayContaining([
      'chartjs',
      'd3',
      'three',
      'mermaid',
      'cytoscape',
      'plotly',
      'echarts',
      'vis-network',
      'gsap',
      'matter',
      'p5',
      'rough',
      'force-graph',
      'force-graph-3d',
      'highlightjs',
      'marked',
      'codemirror',
      'pdfjs',
      'mammoth',
      'docx',
    ]));
  });

  test('emits agent guidance with sandbox routes and Three.js import-map setup', () => {
    const guidance = buildSandboxBrowserLibraryInstructions();

    expect(guidance).toContain('/api/sandbox-libraries/chartjs/chart.umd.js');
    expect(guidance).toContain('/api/sandbox-libraries/three/three.module.js');
    expect(guidance).toContain('three/addons/');
    expect(guidance).toContain('CodeMirror');
    expect(guidance).toContain('highlight.js');
    expect(guidance).toContain('PDF.js');
    expect(guidance).toContain('https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js');
  });

  test('normalizes aliases and rejects unsafe asset paths', () => {
    expect(normalizeLibraryId('Chart.js')).toBe('chartjs');
    expect(normalizeLibraryId('threejs')).toBe('three');
    expect(normalizeAssetPath('../package.json')).toBe('');
    expect(resolveSandboxBrowserLibraryAsset('three', '../package.json')).toBeNull();
  });
});
