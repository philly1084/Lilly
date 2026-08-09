/**
 * GraphDiagramTool - reusable graph and diagram utility for agents and documents.
 */

const { ToolBase } = require('../../ToolBase');
const { artifactService } = require('../../../../artifacts/artifact-service');
const { createUniqueFilename, escapeHtml, escapeXml, slugifyFilename } = require('../../../../utils/text');

const DEFAULT_OUTPUT_FORMATS = ['native', 'mermaid', 'svg', 'html'];
const GRAPH_TYPES = new Set([
  'flowchart',
  'network',
  'tree',
  'mindmap',
  'architecture',
  'sequence',
  'timeline',
  'er',
  'class',
  'state',
  'bar',
  'line',
  'scatter',
]);

function normalizeId(value = '', fallback = 'node') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeLabel(value = '', fallback = '') {
  return String(value || fallback || '').trim();
}

function uniq(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function compareModelVersion(model = '', floor = 5.5) {
  const normalized = String(model || '').toLowerCase();
  const match = normalized.match(/gpt[-_ ]?(\d+(?:\.\d+)?)/i);
  if (!match) {
    return false;
  }
  return Number(match[1]) >= floor;
}

function isSvgCapableModel(context = {}, params = {}) {
  return compareModelVersion(params.model || context.model || '', 5.5);
}

function normalizeOutputFormats(value = [], context = {}, params = {}) {
  const requested = asArray(value).map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
  const formats = requested.length > 0 ? requested : DEFAULT_OUTPUT_FORMATS;
  if (isSvgCapableModel(context, params) && !formats.includes('svg')) {
    formats.push('svg');
  }
  return uniq(formats);
}

function normalizeDocumentTarget(value = '') {
  const target = String(value || '').trim().toLowerCase();
  if (['markdown', 'html', 'slides', 'pdf'].includes(target)) {
    return target;
  }
  return 'markdown';
}

function normalizeVisualizationText(value = '', maxLength = 1200) {
  return String(value || '').trim().slice(0, maxLength);
}

function buildVisualizationMetadata(graph = {}) {
  const metadata = graph.metadata && typeof graph.metadata === 'object' ? graph.metadata : {};
  const insightTitle = normalizeVisualizationText(
    graph.insightTitle || metadata.insightTitle || metadata.claim || graph.title,
    240,
  );
  const summary = normalizeVisualizationText(
    graph.summary || metadata.summary || metadata.takeaway || '',
  );
  const altText = normalizeVisualizationText(
    graph.altText
      || metadata.altText
      || (
        graph.series?.length
          ? `${graph.type} chart titled "${graph.title}" with ${graph.series.length} data points.${summary ? ` ${summary}` : ''}`
          : `${graph.type} diagram titled "${graph.title}" with ${graph.nodes?.length || 0} nodes and ${graph.edges?.length || 0} relationships.${summary ? ` ${summary}` : ''}`
      ),
  );

  return {
    kind: 'data-visualization',
    title: graph.title,
    insightTitle,
    chartType: graph.type,
    summary,
    altText,
    sourceLabel: normalizeVisualizationText(
      graph.sourceLabel || metadata.sourceLabel || metadata.source || '',
      300,
    ),
    sourceUrl: normalizeVisualizationText(
      graph.sourceUrl || metadata.sourceUrl || '',
      1000,
    ),
    caveat: normalizeVisualizationText(
      graph.caveat || metadata.caveat || metadata.note || '',
    ),
  };
}

function toHtmlFigureEmbed(image = {}, graph = {}) {
  const title = escapeXml(graph.title || image.title || graph.id || 'Diagram');
  const src = escapeXml(image.url || '');
  const alt = escapeXml(image.title || graph.title || graph.id || 'Diagram');
  const caption = escapeXml(`${graph.type || 'diagram'} · ${graph.id || ''}`.replace(/\s*·\s*$/, ''));
  return `<figure>
  <img src="${src}" alt="${alt}" />
  <figcaption>${title}${caption ? ` (${caption})` : ''}</figcaption>
</figure>`;
}

function toMarkdownEmbed(image = {}, graph = {}) {
  const title = graph.title || image.title || graph.id || 'Diagram';
  const alt = image.title || title;
  const meta = `${graph.type || 'diagram'}${graph.id ? ` · ${graph.id}` : ''}`;
  return `![${alt}](${image.url})\n\n*${title}${meta ? ` (${meta})` : ''}*`;
}

function toSlidesEmbed(image = {}, graph = {}) {
  const title = graph.title || image.title || graph.id || 'Diagram';
  return `![${title}](${image.url})\n<!-- slide: ${graph.id || title} -->`;
}

function inferNodesFromEdges(edges = []) {
  const nodesById = new Map();
  edges.forEach((edge) => {
    const from = normalizeId(edge.from || edge.source || edge.start || '');
    const to = normalizeId(edge.to || edge.target || edge.end || '');
    if (from && !nodesById.has(from)) {
      nodesById.set(from, { id: from, label: edge.fromLabel || from });
    }
    if (to && !nodesById.has(to)) {
      nodesById.set(to, { id: to, label: edge.toLabel || to });
    }
  });
  return Array.from(nodesById.values());
}

function normalizeNode(node = {}, index = 0) {
  const rawId = node.id || node.key || node.name || node.label || `node-${index + 1}`;
  const id = normalizeId(rawId, `node_${index + 1}`);
  return {
    id,
    label: normalizeLabel(node.label || node.name || rawId, id),
    type: String(node.type || node.kind || '').trim().toLowerCase() || 'node',
    group: normalizeLabel(node.group || node.cluster || ''),
    description: normalizeLabel(node.description || node.summary || ''),
    value: node.value,
    metadata: node.metadata && typeof node.metadata === 'object' ? node.metadata : {},
  };
}

function normalizeEdge(edge = {}, index = 0) {
  const from = normalizeId(edge.from || edge.source || edge.start || '');
  const to = normalizeId(edge.to || edge.target || edge.end || '');
  return {
    id: normalizeId(edge.id || `${from || 'edge'}-${to || index + 1}`, `edge_${index + 1}`),
    from,
    to,
    label: normalizeLabel(edge.label || edge.message || edge.relationship || ''),
    type: String(edge.type || edge.kind || '').trim().toLowerCase() || 'link',
    direction: String(edge.direction || '').trim().toLowerCase() || 'directed',
    weight: Number.isFinite(Number(edge.weight)) ? Number(edge.weight) : null,
    metadata: edge.metadata && typeof edge.metadata === 'object' ? edge.metadata : {},
  };
}

function normalizeSeries(data = [], series = []) {
  const source = asArray(series).length > 0 ? series : asArray(data);
  return source
    .map((point, index) => {
      if (Array.isArray(point)) {
        return {
          label: normalizeLabel(point[0], `Point ${index + 1}`),
          value: Number(point[1]) || 0,
        };
      }
      if (point && typeof point === 'object') {
        return {
          label: normalizeLabel(point.label || point.name || point.x, `Point ${index + 1}`),
          value: Number(point.value ?? point.y ?? point.count ?? point.total) || 0,
          group: normalizeLabel(point.group || point.series || ''),
        };
      }
      return {
        label: `Point ${index + 1}`,
        value: Number(point) || 0,
      };
    })
    .filter((point) => point.label);
}

function normalizeGraphSpec(input = {}, index = 0) {
  const parsedSource = parseMaybeJson(input.source || input.graph || '');
  const spec = parsedSource && typeof parsedSource === 'object' && !Array.isArray(parsedSource)
    ? { ...parsedSource, ...input }
    : { ...input };
  const type = String(spec.type || spec.diagramType || spec.kind || 'flowchart').trim().toLowerCase();
  const graphType = GRAPH_TYPES.has(type) ? type : 'flowchart';
  const edges = asArray(spec.edges || spec.links || spec.relationships).map(normalizeEdge).filter((edge) => edge.from && edge.to);
  const explicitNodes = asArray(spec.nodes || spec.entities || spec.components).map(normalizeNode);
  const inferredNodes = explicitNodes.length > 0 ? [] : inferNodesFromEdges(edges);
  const nodesById = new Map();
  [...explicitNodes, ...inferredNodes].forEach((node, nodeIndex) => {
    const normalized = normalizeNode(node, nodeIndex);
    nodesById.set(normalized.id, normalized);
  });
  edges.forEach((edge) => {
    if (edge.from && !nodesById.has(edge.from)) nodesById.set(edge.from, normalizeNode({ id: edge.from }, nodesById.size));
    if (edge.to && !nodesById.has(edge.to)) nodesById.set(edge.to, normalizeNode({ id: edge.to }, nodesById.size));
  });

  const series = normalizeSeries(spec.data, spec.series);
  const metadata = spec.metadata && typeof spec.metadata === 'object' ? spec.metadata : {};
  return {
    id: normalizeId(spec.id || spec.name || spec.title || `graph-${index + 1}`, `graph_${index + 1}`),
    title: normalizeLabel(spec.title || spec.name || `Graph ${index + 1}`),
    type: graphType,
    direction: String(spec.direction || spec.layout || 'TD').trim().toUpperCase(),
    nodes: Array.from(nodesById.values()),
    edges,
    groups: asArray(spec.groups || spec.clusters).map((group, groupIndex) => ({
      id: normalizeId(group.id || group.name || group.label || `group-${groupIndex + 1}`, `group_${groupIndex + 1}`),
      label: normalizeLabel(group.label || group.name || `Group ${groupIndex + 1}`),
      nodeIds: asArray(group.nodeIds || group.nodes).map((entry) => normalizeId(entry)),
    })),
    series,
    source: typeof spec.source === 'string' ? spec.source : '',
    insightTitle: normalizeVisualizationText(spec.insightTitle || spec.claim || metadata.insightTitle || metadata.claim || ''),
    summary: normalizeVisualizationText(spec.summary || spec.takeaway || metadata.summary || metadata.takeaway || ''),
    altText: normalizeVisualizationText(spec.altText || metadata.altText || ''),
    sourceLabel: normalizeVisualizationText(spec.sourceLabel || metadata.sourceLabel || metadata.source || '', 300),
    sourceUrl: normalizeVisualizationText(spec.sourceUrl || metadata.sourceUrl || '', 1000),
    caveat: normalizeVisualizationText(spec.caveat || spec.note || metadata.caveat || metadata.note || ''),
    metadata,
  };
}

function mermaidEscape(value = '') {
  return String(value || '').replace(/"/g, '#quot;');
}

function buildMermaid(graph) {
  if (graph.source && /^(?:flowchart|graph|sequenceDiagram|classDiagram|erDiagram|stateDiagram|timeline|mindmap)\b/i.test(graph.source.trim())) {
    return graph.source.trim();
  }

  if (graph.type === 'sequence') {
    const participants = uniq([
      ...graph.nodes.map((node) => node.id),
      ...graph.edges.flatMap((edge) => [edge.from, edge.to]),
    ]);
    return [
      'sequenceDiagram',
      ...participants.map((id) => {
        const node = graph.nodes.find((entry) => entry.id === id);
        return `  participant ${id} as ${mermaidEscape(node?.label || id)}`;
      }),
      ...graph.edges.map((edge) => `  ${edge.from}->>${edge.to}: ${mermaidEscape(edge.label || edge.type)}`),
    ].join('\n');
  }

  if (graph.type === 'timeline') {
    return [
      'timeline',
      `  title ${mermaidEscape(graph.title)}`,
      ...graph.series.map((point) => `  ${mermaidEscape(point.label)} : ${mermaidEscape(String(point.value))}`),
    ].join('\n');
  }

  if (['bar', 'line', 'scatter'].includes(graph.type)) {
    return [
      'xychart-beta',
      `  title "${mermaidEscape(graph.title)}"`,
      `  x-axis [${graph.series.map((point) => `"${mermaidEscape(point.label)}"`).join(', ')}]`,
      `  y-axis "Value" 0 --> ${Math.max(...graph.series.map((point) => point.value), 1)}`,
      `  ${graph.type === 'bar' ? 'bar' : 'line'} [${graph.series.map((point) => point.value).join(', ')}]`,
    ].join('\n');
  }

  const direction = ['TB', 'TD', 'BT', 'LR', 'RL'].includes(graph.direction) ? graph.direction : 'TD';
  const lines = [`flowchart ${direction}`];
  graph.nodes.forEach((node) => {
    const shape = node.type === 'database' ? `[(${mermaidEscape(node.label)})]`
      : node.type === 'decision' ? `{${mermaidEscape(node.label)}}`
        : `[${mermaidEscape(node.label)}]`;
    lines.push(`  ${node.id}${shape}`);
  });
  graph.edges.forEach((edge) => {
    const connector = edge.direction === 'undirected' ? '---' : '-->';
    const label = edge.label ? `|${mermaidEscape(edge.label)}|` : '';
    lines.push(`  ${edge.from} ${connector}${label} ${edge.to}`);
  });
  return lines.join('\n');
}

function buildDot(graph) {
  const lines = ['digraph G {', '  graph [rankdir=TB];', '  node [shape=box, style="rounded,filled", fillcolor="#f8fafc", color="#94a3b8"];'];
  graph.nodes.forEach((node) => {
    lines.push(`  "${node.id}" [label="${String(node.label).replace(/"/g, '\\"')}"];`);
  });
  graph.edges.forEach((edge) => {
    lines.push(`  "${edge.from}" -> "${edge.to}"${edge.label ? ` [label="${String(edge.label).replace(/"/g, '\\"')}"]` : ''};`);
  });
  lines.push('}');
  return lines.join('\n');
}

function computeGraphLayout(graph, width, height) {
  const nodes = graph.nodes;
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  graph.edges.forEach((edge) => indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1));
  const levelById = new Map();
  const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0);
  queue.forEach((node) => levelById.set(node.id, 0));

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    const currentLevel = levelById.get(node.id) || 0;
    graph.edges.filter((edge) => edge.from === node.id).forEach((edge) => {
      const next = nodes.find((entry) => entry.id === edge.to);
      if (!next) return;
      const nextLevel = Math.max(levelById.get(next.id) || 0, currentLevel + 1);
      levelById.set(next.id, nextLevel);
      if (!queue.includes(next)) queue.push(next);
    });
  }

  nodes.forEach((node, index) => {
    if (!levelById.has(node.id)) {
      levelById.set(node.id, index % Math.max(1, Math.ceil(Math.sqrt(nodes.length))));
    }
  });

  const levels = new Map();
  nodes.forEach((node) => {
    const level = levelById.get(node.id) || 0;
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(node);
  });

  const maxLevel = Math.max(...Array.from(levels.keys()), 0);
  const layout = new Map();
  Array.from(levels.entries()).forEach(([level, levelNodes]) => {
    const x = 96 + (level * ((width - 192) / Math.max(1, maxLevel)));
    const gap = (height - 160) / Math.max(1, levelNodes.length);
    levelNodes.forEach((node, index) => {
      layout.set(node.id, {
        x,
        y: 96 + gap * (index + 0.5),
      });
    });
  });

  return layout;
}

function buildChartSvg(graph, options) {
  const width = Number(options.width) || 960;
  const height = Number(options.height) || 540;
  const padding = { left: 80, right: 42, top: 76, bottom: 86 };
  const series = graph.series.length > 0 ? graph.series : [{ label: 'Value', value: 1 }];
  const maxValue = Math.max(...series.map((point) => point.value), 1);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const barWidth = Math.max(18, plotWidth / series.length * 0.55);
  const points = series.map((point, index) => {
    const x = padding.left + ((index + 0.5) * plotWidth / series.length);
    const y = padding.top + plotHeight - ((point.value / maxValue) * plotHeight);
    return { ...point, x, y };
  });

  const marks = graph.type === 'bar'
    ? points.map((point) => {
      const barHeight = padding.top + plotHeight - point.y;
      return `<rect x="${point.x - barWidth / 2}" y="${point.y}" width="${barWidth}" height="${barHeight}" rx="8" fill="#2563eb" opacity="0.88" />`;
    }).join('\n')
    : `<polyline points="${points.map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="6" fill="#0f766e" />`).join('\n')}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${graph.id}-title ${graph.id}-desc">
  <title id="${graph.id}-title">${escapeXml(graph.title)}</title>
  <desc id="${graph.id}-desc">${escapeXml(graph.type)} chart generated from ${series.length} data points.</desc>
  <rect width="${width}" height="${height}" rx="24" fill="#f8fafc" />
  <text x="${padding.left}" y="42" fill="#0f172a" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(graph.title)}</text>
  <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#94a3b8" />
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#94a3b8" />
  ${marks}
  ${points.map((point) => `<text x="${point.x}" y="${padding.top + plotHeight + 30}" text-anchor="middle" fill="#475569" font-family="Segoe UI, Arial, sans-serif" font-size="13">${escapeXml(point.label).slice(0, 18)}</text>
  <text x="${point.x}" y="${point.y - 12}" text-anchor="middle" fill="#0f172a" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700">${escapeXml(String(point.value))}</text>`).join('\n')}
</svg>`;
}

function buildGraphSvg(graph, options = {}) {
  if (['bar', 'line', 'scatter', 'timeline'].includes(graph.type) && graph.series.length > 0) {
    return buildChartSvg(graph, options);
  }

  const width = Number(options.width) || 1120;
  const height = Number(options.height) || Math.max(560, graph.nodes.length * 92);
  if (graph.nodes.length === 0 && graph.edges.length === 0 && graph.source) {
    const sourceLines = String(graph.source || '').split('\n').slice(0, 18);
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${graph.id}-title ${graph.id}-desc">
  <title id="${graph.id}-title">${escapeXml(graph.title)}</title>
  <desc id="${graph.id}-desc">Source-backed diagram preview. Use Mermaid or native graph data for full rendering.</desc>
  <rect width="${width}" height="${height}" rx="24" fill="#f8fafc" />
  <rect x="42" y="86" width="${width - 84}" height="${height - 130}" rx="16" fill="#111827" />
  <text x="42" y="48" fill="#0f172a" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="800">${escapeXml(graph.title)}</text>
  <text x="64" y="124" fill="#93c5fd" font-family="Consolas, monospace" font-size="15">Diagram source preview</text>
  ${sourceLines.map((line, index) => `<text x="64" y="${158 + (index * 22)}" fill="#e5e7eb" font-family="Consolas, monospace" font-size="14">${escapeXml(line).slice(0, 120)}</text>`).join('\n')}
</svg>`;
  }

  const layout = computeGraphLayout(graph, width, height);
  const nodeWidth = 174;
  const nodeHeight = 58;

  const edgeMarkup = graph.edges.map((edge) => {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) return '';
    const startX = from.x + nodeWidth / 2;
    const startY = from.y;
    const endX = to.x - nodeWidth / 2;
    const endY = to.y;
    const midX = (startX + endX) / 2;
    const label = edge.label ? `<text x="${midX}" y="${(startY + endY) / 2 - 8}" text-anchor="middle" fill="#475569" font-family="Segoe UI, Arial, sans-serif" font-size="12">${escapeXml(edge.label)}</text>` : '';
    return `<path d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" fill="none" stroke="#64748b" stroke-width="2.4" marker-end="url(#arrow)" />
${label}`;
  }).join('\n');

  const nodeMarkup = graph.nodes.map((node) => {
    const point = layout.get(node.id) || { x: 100, y: 100 };
    const fill = node.type === 'database' ? '#ecfeff' : node.type === 'decision' ? '#fff7ed' : '#ffffff';
    return `<g transform="translate(${point.x - nodeWidth / 2}, ${point.y - nodeHeight / 2})">
  <rect width="${nodeWidth}" height="${nodeHeight}" rx="12" fill="${fill}" stroke="#94a3b8" stroke-width="1.5" />
  <text x="${nodeWidth / 2}" y="25" text-anchor="middle" fill="#0f172a" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700">${escapeXml(node.label).slice(0, 28)}</text>
  ${node.type && node.type !== 'node' ? `<text x="${nodeWidth / 2}" y="43" text-anchor="middle" fill="#64748b" font-family="Segoe UI, Arial, sans-serif" font-size="11">${escapeXml(node.type)}</text>` : ''}
</g>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${graph.id}-title ${graph.id}-desc">
  <title id="${graph.id}-title">${escapeXml(graph.title)}</title>
  <desc id="${graph.id}-desc">${escapeXml(graph.type)} diagram with ${graph.nodes.length} nodes and ${graph.edges.length} edges.</desc>
  <defs>
    <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
      <path d="M 0 0 L 12 6 L 0 12 z" fill="#64748b" />
    </marker>
  </defs>
  <rect width="${width}" height="${height}" rx="24" fill="#f8fafc" />
  <text x="42" y="48" fill="#0f172a" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="800">${escapeXml(graph.title)}</text>
  <text x="42" y="75" fill="#64748b" font-family="Segoe UI, Arial, sans-serif" font-size="14">${escapeXml(`${graph.type} diagram - native SVG`)}</text>
  ${edgeMarkup}
  ${nodeMarkup}
</svg>`;
}

function buildHtml(graph, svg, mermaid, dot) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeXml(graph.title)}</title>
<style>
body { margin: 0; background: #eef2f7; color: #0f172a; font-family: "Segoe UI", Arial, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 28px; }
figure { margin: 0; background: #fff; border: 1px solid #d8e0ea; border-radius: 14px; padding: 18px; }
svg { width: 100%; height: auto; display: block; }
details { margin-top: 18px; background: #fff; border: 1px solid #d8e0ea; border-radius: 10px; padding: 14px; }
pre { overflow: auto; background: #111827; color: #e5e7eb; border-radius: 8px; padding: 12px; }
</style>
</head>
<body>
<main>
<figure>${svg.replace(/^<\?xml[^>]*>\s*/i, '')}</figure>
<details><summary>Native graph JSON</summary><pre>${escapeHtml(JSON.stringify(graph, null, 2))}</pre></details>
<details><summary>Mermaid</summary><pre>${escapeHtml(mermaid)}</pre></details>
<details><summary>DOT</summary><pre>${escapeHtml(dot)}</pre></details>
</main>
</body>
</html>`;
}

class GraphDiagramTool extends ToolBase {
  constructor() {
    super({
      id: 'graph-diagram',
      name: 'Graph and Diagram Utility',
      description: 'Generate reusable graph/diagram assets in native JSON, Mermaid, DOT, SVG, HTML, and persisted image artifacts. Supports batch graph generation for document workflows.',
      category: 'design',
      version: '1.0.0',
      backend: {
        sideEffects: ['write'],
        sandbox: { filesystem: 'artifact' },
        timeout: 60000,
      },
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'object', description: 'Single graph spec with nodes/edges, data series, or source.' },
          graphs: { type: 'array', description: 'Batch of graph specs to process together.' },
          title: { type: 'string' },
          type: { type: 'string', enum: Array.from(GRAPH_TYPES) },
          nodes: { type: 'array' },
          edges: { type: 'array' },
          data: { type: 'array' },
          series: { type: 'array' },
          source: { type: 'string', description: 'Native JSON, Mermaid, or descriptive source.' },
          insightTitle: { type: 'string', description: 'Claim-style title shown on visualization cards.' },
          summary: { type: 'string', description: 'Immediate takeaway kept visible without hover.' },
          altText: { type: 'string', description: 'Text alternative for the rendered chart or diagram.' },
          sourceLabel: { type: 'string', description: 'Human-readable source or method note.' },
          sourceUrl: { type: 'string', description: 'Optional HTTP(S) source URL.' },
          caveat: { type: 'string', description: 'Uncertainty, missingness, or interpretation caveat.' },
          outputFormats: {
            type: 'array',
            items: { type: 'string', enum: ['native', 'json', 'mermaid', 'dot', 'svg', 'html'] },
            description: 'Formats to return. GPT-5.5+ callers default toward SVG-rich output.',
          },
          renderMode: {
            type: 'string',
            enum: ['native', 'svg', 'html', 'artifact', 'sandbox-project'],
            default: 'artifact',
          },
          documentTarget: {
            type: 'string',
            enum: ['markdown', 'html', 'slides', 'pdf'],
            default: 'markdown',
            description: 'Target document type for embed snippet generation.',
          },
          persistArtifacts: { type: 'boolean', default: true },
          width: { type: 'integer', default: 1120 },
          height: { type: 'integer' },
          model: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          graphs: { type: 'array' },
          artifacts: { type: 'array' },
          images: { type: 'array' },
          markdownImages: { type: 'array' },
          embedSnippets: { type: 'array' },
          svgPreferred: { type: 'boolean' },
          usage: { type: 'object' },
        },
      },
    });
  }

  async handler(params = {}, context = {}, tracker) {
    const graphInputs = asArray(params.graphs).length > 0
      ? params.graphs
      : [params.graph && typeof params.graph === 'object' ? params.graph : params];
    const outputFormats = normalizeOutputFormats(params.outputFormats, context, params);
    const svgPreferred = isSvgCapableModel(context, params);
    const documentTarget = normalizeDocumentTarget(params.documentTarget);
    const renderMode = String(params.renderMode || 'artifact').trim().toLowerCase();
    const persistArtifacts = params.persistArtifacts !== false && Boolean(context.sessionId);
    const graphResults = [];
    const artifacts = [];
    const images = [];
    const markdownImages = [];
    const embedSnippets = [];

    for (let index = 0; index < graphInputs.length; index += 1) {
      const graph = normalizeGraphSpec(graphInputs[index], index);
      if (graph.nodes.length === 0 && graph.edges.length === 0 && graph.series.length === 0 && !graph.source) {
        throw new Error(`Graph ${index + 1} needs nodes/edges, data series, or diagram source.`);
      }

      const mermaid = buildMermaid(graph);
      const dot = buildDot(graph);
      const svg = buildGraphSvg(graph, {
        width: params.width,
        height: params.height,
      });
      const html = buildHtml(graph, svg, mermaid, dot);
      const result = {
        id: graph.id,
        title: graph.title,
        type: graph.type,
        native: graph,
        formats: {},
        counts: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          dataPoints: graph.series.length,
        },
      };

      if (outputFormats.includes('native') || outputFormats.includes('json')) result.formats.native = graph;
      if (outputFormats.includes('mermaid')) result.formats.mermaid = mermaid;
      if (outputFormats.includes('dot')) result.formats.dot = dot;
      if (outputFormats.includes('svg')) result.formats.svg = svg;
      if (outputFormats.includes('html')) result.formats.html = html;

      if (persistArtifacts && ['svg', 'artifact', 'sandbox-project'].includes(renderMode)) {
        const imageArtifact = await this.persistArtifact({
          sessionId: context.sessionId,
          mode: context.clientSurface || context.taskType || 'chat',
          graph,
          content: svg,
          extension: 'svg',
          mimeType: 'image/svg+xml',
          filename: createUniqueFilename(graph.title, '.svg', 'diagram'),
          previewHtml: html,
        });
        if (imageArtifact) {
          artifacts.push(imageArtifact);
          images.push({
            graphId: graph.id,
            title: graph.title,
            url: imageArtifact.downloadUrl,
            previewUrl: imageArtifact.previewUrl,
            mimeType: imageArtifact.mimeType,
            artifactId: imageArtifact.id,
          });
          markdownImages.push(`![${graph.title}](${imageArtifact.downloadUrl})`);
          const imageDescriptor = images[images.length - 1];
          const embed = documentTarget === 'html' || documentTarget === 'pdf'
            ? toHtmlFigureEmbed(imageDescriptor, graph)
            : documentTarget === 'slides'
              ? toSlidesEmbed(imageDescriptor, graph)
              : toMarkdownEmbed(imageDescriptor, graph);
          embedSnippets.push({
            graphId: graph.id,
            title: graph.title,
            target: documentTarget,
            snippet: embed,
            url: imageArtifact.downloadUrl,
          });
          result.artifact = imageArtifact;
          result.image = imageDescriptor;
          imageDescriptor.visualization = buildVisualizationMetadata(graph);
        }
      }

      if (persistArtifacts && renderMode === 'html') {
        const htmlArtifact = await this.persistArtifact({
          sessionId: context.sessionId,
          mode: context.clientSurface || context.taskType || 'chat',
          graph,
          content: html,
          extension: 'html',
          mimeType: 'text/html',
          filename: createUniqueFilename(graph.title, '.html', 'diagram'),
          previewHtml: html,
        });
        if (htmlArtifact) {
          artifacts.push(htmlArtifact);
          result.htmlArtifact = htmlArtifact;
        }
      }

      graphResults.push(result);
    }

    if (renderMode === 'sandbox-project' && context.toolManager?.executeTool && graphResults.length > 0) {
      const files = graphResults.map((result, index) => ({
        path: index === 0 ? 'index.html' : `${slugifyFilename(result.title || result.id) || result.id}.html`,
        language: 'html',
        purpose: `Preview for ${result.title}`,
        content: result.formats.html || buildHtml(result.native, result.formats.svg || buildGraphSvg(result.native), result.formats.mermaid || buildMermaid(result.native), result.formats.dot || buildDot(result.native)),
      }));
      const sandboxResult = await context.toolManager.executeTool('code-sandbox', {
        mode: 'project',
        language: 'html',
        projectName: params.title || graphResults[0].title || 'graph-diagrams',
        entry: 'index.html',
        files,
      }, context);
      if (sandboxResult?.success) {
        artifacts.push(...asArray(sandboxResult.data?.artifacts));
      }
    }

    tracker.recordExecution('graph-diagram render', {
      graphCount: graphResults.length,
      outputFormats,
      renderMode,
      persistedArtifacts: artifacts.length,
      svgPreferred,
    });

    return {
      graphCount: graphResults.length,
      graphs: graphResults,
      artifacts,
      images,
      markdownImages,
      embedSnippets,
      svgPreferred,
      usage: {
        bestForDocuments: images.length > 0
          ? 'Use embedSnippets[] for target-aware copy/paste embeds, or images[].url/markdownImages[] for direct linking.'
          : 'Use formats.svg as an image payload, or run with a sessionId and persistArtifacts=true to create reusable image artifacts.',
        nativeGraph: 'Use graphs[].native when another agent or tool can consume structured nodes, edges, groups, and data series directly.',
        svgModelHint: svgPreferred
          ? 'GPT-5.5+ model detected; SVG output is preferred for high-fidelity custom diagrams.'
          : 'For GPT-5.5+ callers, request SVG directly for richer custom diagram assets.',
      },
    };
  }

  async persistArtifact({ sessionId, mode, graph, content, extension, mimeType, filename, previewHtml }) {
    const stored = await artifactService.createStoredArtifact({
      sessionId,
      direction: 'generated',
      sourceMode: mode,
      filename,
      extension,
      mimeType,
      buffer: Buffer.from(content, 'utf8'),
      extractedText: graph.title,
      previewHtml,
      metadata: {
        createdByAgentTool: true,
        toolId: this.id,
        graphId: graph.id,
        graphType: graph.type,
        nativeGraph: graph,
        visualization: buildVisualizationMetadata(graph),
      },
      vectorize: false,
    });
    return artifactService.serializeArtifact(stored);
  }
}

module.exports = {
  GraphDiagramTool,
  isSvgCapableModel,
};
