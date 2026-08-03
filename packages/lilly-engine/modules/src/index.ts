import ts from 'typescript';

import {
  ANIMATION_CONTROLLER_SCHEMA,
  ASSET_METADATA_SCHEMA,
  GAME_MODULE_SCHEMA,
  MATERIAL_SCHEMA,
  MECHANIC_SCHEMA,
  MECHANIC_TEST_SCHEMA,
  PREFAB_SCHEMA,
  SOURCE_FILE_SCHEMA,
  TERRAIN_SCHEMA,
  detectSourceFileKind,
  normalizeSourceFile,
  normalizeSourcePath,
  validateAnimationControllerDefinition,
  validateAssetMetadataDefinition,
  validateMaterialDefinition,
  validatePrefabDefinition,
  validateTerrainDefinition,
  type LillyAnimationControllerDefinition,
  type LillyAssetMetadataDefinition,
  type LillyMaterialDefinition,
  type LillyPrefabDefinition,
  type LillySourceFile,
  type LillyTerrainDefinition,
} from '../../core/src';

export const MODULE_BUNDLE_SCHEMA = 'LillyModuleBundle/v1' as const;

export type LillyScriptCapability =
  | 'clock.read'
  | 'random.read'
  | 'input.read'
  | 'entity.query'
  | 'entity.read'
  | 'entity.write'
  | 'entity.spawn'
  | 'entity.destroy'
  | 'physics.force'
  | 'physics.impulse'
  | 'physics.raycast'
  | 'events.emit'
  | 'hud.write'
  | 'audio.play'
  | 'particles.emit'
  | 'save.read'
  | 'save.write';

export const SCRIPT_CAPABILITIES: readonly LillyScriptCapability[] = Object.freeze([
  'clock.read',
  'random.read',
  'input.read',
  'entity.query',
  'entity.read',
  'entity.write',
  'entity.spawn',
  'entity.destroy',
  'physics.force',
  'physics.impulse',
  'physics.raycast',
  'events.emit',
  'hud.write',
  'audio.play',
  'particles.emit',
  'save.read',
  'save.write',
]);

export interface LillyGameModuleManifest {
  schema: typeof GAME_MODULE_SCHEMA;
  id: string;
  name: string;
  version: string;
  description?: string;
  dependencies: string[];
  capabilities: LillyScriptCapability[];
  systems: string[];
  mechanics: string[];
  prefabs: string[];
  tests: string[];
  materials?: string[];
  assets?: string[];
  animations?: string[];
  terrains?: string[];
}

export interface LillyMechanicDefinition {
  schema: typeof MECHANIC_SCHEMA;
  id: string;
  moduleId: string;
  name: string;
  description?: string;
  systems: string[];
  inputs: string[];
  events: string[];
  components: Array<{
    id: string;
    fields: Array<{ name: string; type: 'boolean' | 'number' | 'string' | 'vector2' | 'vector3' | 'entity' | 'asset'; defaultValue?: unknown }>;
  }>;
}

export interface LillyMechanicTestDefinition {
  schema: typeof MECHANIC_TEST_SCHEMA;
  id: string;
  moduleId: string;
  name: string;
  seed?: number;
  steps: Array<{
    event: 'start' | 'fixed-update' | 'input' | 'event' | 'collision';
    delta?: number;
    input?: { buttons?: Record<string, boolean>; axes?: Record<string, { x: number; y: number }> };
    payload?: Record<string, unknown>;
    world?: Record<string, unknown>;
  }>;
  assertions: Array<{
    path: string;
    operator: 'equals' | 'not-equals' | 'truthy' | 'falsy' | 'gte' | 'lte' | 'includes' | 'length';
    value?: unknown;
  }>;
}

export interface ModuleDiagnostic {
  code: string;
  message: string;
  path: string;
  severity: 'error' | 'warning';
  line?: number;
  column?: number;
}

export interface CompiledSystem {
  moduleId: string;
  path: string;
  sourceHash: string;
  code: string;
}

export interface CompiledModule extends LillyGameModuleManifest {
  sourcePath: string;
  systems: string[];
  mechanics: string[];
  prefabs: string[];
  tests: string[];
  materials: string[];
  assets: string[];
  animations: string[];
  terrains: string[];
}

export interface LillyModuleBundle {
  schema: typeof MODULE_BUNDLE_SCHEMA;
  sourceHash: string;
  loadOrder: string[];
  modules: CompiledModule[];
  systems: CompiledSystem[];
  mechanics: Array<LillyMechanicDefinition & { sourcePath: string }>;
  prefabs: Array<LillyPrefabDefinition & { sourcePath: string }>;
  tests: Array<LillyMechanicTestDefinition & { sourcePath: string }>;
  materials: Array<LillyMaterialDefinition & { sourcePath: string }>;
  assets: Array<LillyAssetMetadataDefinition & { sourcePath: string }>;
  animations: Array<LillyAnimationControllerDefinition & { sourcePath: string }>;
  terrains: Array<LillyTerrainDefinition & { sourcePath: string }>;
  diagnostics: ModuleDiagnostic[];
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const FORBIDDEN_IDENTIFIERS = new Set([
  'window',
  'document',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'navigator',
  'location',
  'parent',
  'top',
  'opener',
  'globalThis',
  'self',
  'postMessage',
  'importScripts',
  'eval',
  'Function',
  'Date',
  'performance',
  'crypto',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'WebAssembly',
  'Reflect',
  'Proxy',
]);
const FORBIDDEN_PROPERTIES = new Set(['constructor', '__proto__', 'prototype']);

function diagnostic(code: string, message: string, path: string, severity: ModuleDiagnostic['severity'] = 'error', position: Partial<Pick<ModuleDiagnostic, 'line' | 'column'>> = {}): ModuleDiagnostic {
  return { code, message, path, severity, ...position };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseJson<T>(file: LillySourceFile, expectedSchema: string, diagnostics: ModuleDiagnostic[]): T | null {
  try {
    const parsed = JSON.parse(file.content) as { schema?: string };
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== expectedSchema) {
      diagnostics.push(diagnostic('INVALID_FILE_SCHEMA', `${file.path} must use ${expectedSchema}`, file.path));
      return null;
    }
    return parsed as T;
  } catch (error) {
    diagnostics.push(diagnostic('INVALID_JSON', `${file.path}: ${(error as Error).message}`, file.path));
    return null;
  }
}

function resolveReference(manifestPath: string, reference: string): string {
  const raw = String(reference || '').trim();
  if (!raw.startsWith('./')) return normalizeSourcePath(raw);
  const parent = manifestPath.split('/').slice(0, -1);
  return normalizeSourcePath([...parent, ...raw.slice(2).split('/')].join('/'));
}

function sourcePosition(sourceFile: ts.SourceFile, node: ts.Node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: point.line + 1, column: point.character + 1 };
}

function compileSystem(file: LillySourceFile, moduleId: string): { compiled: CompiledSystem | null; diagnostics: ModuleDiagnostic[] } {
  const diagnostics: ModuleDiagnostic[] = [];
  const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const importRanges: Array<{ start: number; end: number }> = [];
  let defaultExportCount = 0;

  const inspect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      importRanges.push({ start: node.getFullStart(), end: node.end });
      const moduleName = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (moduleName !== '@lilly/engine-runtime') {
        diagnostics.push(diagnostic('IMPORT_NOT_ALLOWED', `Systems may only import types and defineSystem from @lilly/engine-runtime, not ${moduleName || 'a dynamic module'}`, file.path, 'error', sourcePosition(sourceFile, node)));
      }
      const clause = node.importClause;
      if (clause?.name || clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        diagnostics.push(diagnostic('IMPORT_SHAPE_NOT_ALLOWED', 'Use named imports from @lilly/engine-runtime', file.path, 'error', sourcePosition(sourceFile, node)));
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text || element.name.text;
          if (imported !== 'defineSystem' && !element.isTypeOnly && !clause.isTypeOnly) {
            diagnostics.push(diagnostic('IMPORT_SYMBOL_NOT_ALLOWED', `Runtime import ${imported} is not allowlisted`, file.path, 'error', sourcePosition(sourceFile, element)));
          }
        }
      }
    }
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals) diagnostics.push(diagnostic('EXPORT_NOT_ALLOWED', 'Use export default defineSystem(...)', file.path, 'error', sourcePosition(sourceFile, node)));
      else defaultExportCount += 1;
    } else if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node) || [];
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        diagnostics.push(diagnostic('NAMED_EXPORT_NOT_ALLOWED', 'Systems expose exactly one default defineSystem export', file.path, 'error', sourcePosition(sourceFile, node)));
      }
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        diagnostics.push(diagnostic('ASYNC_NOT_ALLOWED', 'System handlers are deterministic synchronous functions; use engine events and clocks instead of async work', file.path, 'error', sourcePosition(sourceFile, node)));
      }
    }
    if (ts.isAwaitExpression(node)) diagnostics.push(diagnostic('ASYNC_NOT_ALLOWED', 'await is not available in deterministic systems', file.path, 'error', sourcePosition(sourceFile, node)));
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) diagnostics.push(diagnostic('DYNAMIC_IMPORT_NOT_ALLOWED', 'Dynamic imports are not available in system sandboxes', file.path, 'error', sourcePosition(sourceFile, node)));
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      const isPropertyName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      const isObjectKey = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      if (!isPropertyName && !isObjectKey) diagnostics.push(diagnostic('GLOBAL_NOT_ALLOWED', `${node.text} is outside the Lilly capability API`, file.path, 'error', sourcePosition(sourceFile, node)));
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (FORBIDDEN_PROPERTIES.has(node.name.text)) diagnostics.push(diagnostic('PROTOTYPE_ACCESS_NOT_ALLOWED', `${node.name.text} access is unavailable in the sandbox`, file.path, 'error', sourcePosition(sourceFile, node)));
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Math' && node.name.text === 'random') {
        diagnostics.push(diagnostic('NONDETERMINISTIC_RANDOM', 'Use ctx.random() so seeded playtests and replays stay deterministic', file.path, 'error', sourcePosition(sourceFile, node)));
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && FORBIDDEN_PROPERTIES.has(node.argumentExpression.text)) {
      diagnostics.push(diagnostic('PROTOTYPE_ACCESS_NOT_ALLOWED', `${node.argumentExpression.text} access is unavailable in the sandbox`, file.path, 'error', sourcePosition(sourceFile, node)));
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && FORBIDDEN_PROPERTIES.has(node.propertyName.text)) {
      diagnostics.push(diagnostic('PROTOTYPE_ACCESS_NOT_ALLOWED', `${node.propertyName.text} extraction is unavailable in the sandbox`, file.path, 'error', sourcePosition(sourceFile, node)));
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  if (defaultExportCount !== 1) diagnostics.push(diagnostic('DEFAULT_SYSTEM_EXPORT_REQUIRED', 'A system file must export default defineSystem({...}) exactly once', file.path));
  if (!/\bdefineSystem\s*\(/.test(file.content)) diagnostics.push(diagnostic('DEFINE_SYSTEM_REQUIRED', 'A system file must register its lifecycle through defineSystem', file.path));
  if (diagnostics.some((entry) => entry.severity === 'error')) return { compiled: null, diagnostics };

  let transformed = file.content;
  for (const range of importRanges.sort((left, right) => right.start - left.start)) transformed = transformed.slice(0, range.start) + transformed.slice(range.end);
  transformed = transformed.replace(/\bexport\s+default\s+/, 'globalThis.__LILLY_SYSTEM_EXPORT__ = ');
  const transpiled = ts.transpileModule(transformed, {
    fileName: file.path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      strict: true,
      isolatedModules: true,
      removeComments: false,
      sourceMap: false,
    },
  });
  for (const entry of transpiled.diagnostics || []) {
    const point = entry.file && entry.start != null ? entry.file.getLineAndCharacterOfPosition(entry.start) : null;
    diagnostics.push(diagnostic(
      `TS${entry.code}`,
      ts.flattenDiagnosticMessageText(entry.messageText, '\n'),
      file.path,
      entry.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
      point ? { line: point.line + 1, column: point.character + 1 } : {},
    ));
  }
  if (diagnostics.some((entry) => entry.severity === 'error')) return { compiled: null, diagnostics };
  const code = `(() => {\n'use strict';\nconst defineSystem = globalThis.Lilly.defineSystem;\nglobalThis.__LILLY_SYSTEM_EXPORT__ = undefined;\n${transpiled.outputText}\nconst definition = globalThis.__LILLY_SYSTEM_EXPORT__;\nif (!definition || typeof definition !== 'object') throw new Error('System ${file.path} did not export a definition');\nglobalThis.Lilly.registerSystem({ moduleId: ${JSON.stringify(moduleId)}, path: ${JSON.stringify(file.path)}, definition });\ndelete globalThis.__LILLY_SYSTEM_EXPORT__;\n})();`;
  return { compiled: { moduleId, path: file.path, sourceHash: stableHash(file.content), code }, diagnostics };
}

function typeCheckSystems(files: LillySourceFile[]): ModuleDiagnostic[] {
  const diagnostics: ModuleDiagnostic[] = [];
  const root = '/lilly-project';
  const declarationPath = `${root}/lilly-engine-runtime.d.ts`;
  const virtualFiles = new Map<string, string>([[declarationPath, LILLY_RUNTIME_TYPE_DECLARATIONS]]);
  for (const file of files.filter((entry) => entry.kind === 'system')) virtualFiles.set(`${root}/${file.path}`, file.content);
  if (virtualFiles.size === 1) return diagnostics;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => virtualFiles.has(fileName.replace(/\\/g, '/')) || defaultHost.fileExists(fileName),
    readFile: (fileName) => virtualFiles.get(fileName.replace(/\\/g, '/')) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const normalized = fileName.replace(/\\/g, '/');
      const source = virtualFiles.get(normalized);
      return source == null
        ? defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, source, languageVersion, true, fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.Unknown);
    },
    getCurrentDirectory: () => root,
  };
  const program = ts.createProgram({ rootNames: [...virtualFiles.keys()], options, host });
  for (const entry of ts.getPreEmitDiagnostics(program)) {
    const normalized = entry.file?.fileName.replace(/\\/g, '/') || '';
    if (!normalized.startsWith(`${root}/`) || normalized === declarationPath) continue;
    const sourcePath = normalized.slice(root.length + 1);
    const point = entry.file && entry.start != null ? entry.file.getLineAndCharacterOfPosition(entry.start) : null;
    diagnostics.push(diagnostic(
      `TS${entry.code}`,
      ts.flattenDiagnosticMessageText(entry.messageText, '\n'),
      sourcePath,
      entry.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
      point ? { line: point.line + 1, column: point.character + 1 } : {},
    ));
  }
  return diagnostics;
}

function validateManifest(value: LillyGameModuleManifest, path: string, diagnostics: ModuleDiagnostic[]) {
  if (!IDENTIFIER_PATTERN.test(String(value.id || ''))) diagnostics.push(diagnostic('INVALID_MODULE_ID', 'Module ids use lowercase letters, numbers, dots, and hyphens', path));
  if (!String(value.name || '').trim()) diagnostics.push(diagnostic('MODULE_NAME_REQUIRED', 'Module name is required', path));
  if (!VERSION_PATTERN.test(String(value.version || ''))) diagnostics.push(diagnostic('INVALID_MODULE_VERSION', 'Module version must use semantic versioning such as 1.0.0', path));
  for (const key of ['dependencies', 'capabilities', 'systems', 'mechanics', 'prefabs', 'tests'] as const) {
    if (!Array.isArray(value[key])) diagnostics.push(diagnostic('INVALID_MODULE_FIELD', `${key} must be an array`, path));
  }
  for (const key of ['materials', 'assets', 'animations', 'terrains'] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) diagnostics.push(diagnostic('INVALID_MODULE_FIELD', `${key} must be an array when provided`, path));
  }
  for (const capability of Array.isArray(value.capabilities) ? value.capabilities : []) {
    if (!SCRIPT_CAPABILITIES.includes(capability)) diagnostics.push(diagnostic('UNKNOWN_CAPABILITY', `Unknown capability ${capability}`, path));
  }
}

function validateMechanic(value: LillyMechanicDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  if (!IDENTIFIER_PATTERN.test(String(value.id || ''))) diagnostics.push(diagnostic('INVALID_MECHANIC_ID', 'Mechanic id is invalid', path));
  if (!IDENTIFIER_PATTERN.test(String(value.moduleId || ''))) diagnostics.push(diagnostic('MECHANIC_MODULE_REQUIRED', 'Mechanic moduleId is invalid', path));
  for (const key of ['systems', 'inputs', 'events', 'components'] as const) if (!Array.isArray(value[key])) diagnostics.push(diagnostic('INVALID_MECHANIC_FIELD', `${key} must be an array`, path));
  const componentIds = new Set<string>();
  for (const component of Array.isArray(value.components) ? value.components : []) {
    if (!IDENTIFIER_PATTERN.test(String(component.id || '')) || componentIds.has(component.id)) diagnostics.push(diagnostic('INVALID_MECHANIC_COMPONENT', `Component schema ${component.id || '<missing>'} is invalid or duplicated`, path));
    componentIds.add(component.id);
    if (!Array.isArray(component.fields)) diagnostics.push(diagnostic('INVALID_MECHANIC_COMPONENT_FIELDS', `Component schema ${component.id} requires fields`, path));
  }
}

function validatePrefab(value: LillyPrefabDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  if (!IDENTIFIER_PATTERN.test(String(value.id || ''))) diagnostics.push(diagnostic('INVALID_PREFAB_ID', 'Prefab id is invalid', path));
  if (!IDENTIFIER_PATTERN.test(String(value.moduleId || ''))) diagnostics.push(diagnostic('PREFAB_MODULE_REQUIRED', 'Prefab moduleId is invalid', path));
  if (!String(value.name || '').trim()) diagnostics.push(diagnostic('PREFAB_NAME_REQUIRED', 'Prefab name is required', path));
  validatePrefabDefinition(value).forEach((issue) => diagnostics.push(diagnostic(issue.code, issue.message, `${path}:${issue.path}`, issue.severity)));
}

function appendResourceIssues(issues: ReturnType<typeof validateMaterialDefinition>, path: string, diagnostics: ModuleDiagnostic[]) {
  issues.forEach((issue) => diagnostics.push(diagnostic(issue.code, issue.message, `${path}:${issue.path}`, issue.severity)));
}

function validateMaterial(value: LillyMaterialDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  appendResourceIssues(validateMaterialDefinition(value), path, diagnostics);
}

function validateAssetMetadata(value: LillyAssetMetadataDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  appendResourceIssues(validateAssetMetadataDefinition(value), path, diagnostics);
}

function validateAnimation(value: LillyAnimationControllerDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  appendResourceIssues(validateAnimationControllerDefinition(value), path, diagnostics);
}

function validateTerrain(value: LillyTerrainDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  appendResourceIssues(validateTerrainDefinition(value), path, diagnostics);
}

function validateTest(value: LillyMechanicTestDefinition, path: string, diagnostics: ModuleDiagnostic[]) {
  if (!IDENTIFIER_PATTERN.test(String(value.id || ''))) diagnostics.push(diagnostic('INVALID_TEST_ID', 'Mechanic test id is invalid', path));
  if (!Array.isArray(value.steps) || value.steps.length === 0) diagnostics.push(diagnostic('TEST_STEPS_REQUIRED', 'Mechanic tests require at least one event step', path));
  if (!Array.isArray(value.assertions) || value.assertions.length === 0) diagnostics.push(diagnostic('TEST_ASSERTIONS_REQUIRED', 'Mechanic tests require at least one assertion', path));
}

function topologicalOrder(modules: CompiledModule[], diagnostics: ModuleDiagnostic[]): string[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (module: CompiledModule, chain: string[]) => {
    if (visited.has(module.id)) return;
    if (visiting.has(module.id)) {
      diagnostics.push(diagnostic('MODULE_DEPENDENCY_CYCLE', `Module dependency cycle: ${[...chain, module.id].join(' -> ')}`, module.sourcePath));
      return;
    }
    visiting.add(module.id);
    for (const dependencyId of module.dependencies || []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) diagnostics.push(diagnostic('MODULE_DEPENDENCY_MISSING', `Module ${module.id} requires missing module ${dependencyId}`, module.sourcePath));
      else visit(dependency, [...chain, module.id]);
    }
    visiting.delete(module.id);
    visited.add(module.id);
    order.push(module.id);
  };
  modules.forEach((module) => visit(module, []));
  return order;
}

export function compileModuleBundle(sourceFiles: LillySourceFile[]): LillyModuleBundle {
  const diagnostics: ModuleDiagnostic[] = [];
  const normalizedFiles: LillySourceFile[] = [];
  const seenPaths = new Set<string>();
  for (const rawFile of Array.isArray(sourceFiles) ? sourceFiles : []) {
    try {
      const file = normalizeSourceFile(rawFile);
      if (rawFile.schema !== SOURCE_FILE_SCHEMA) diagnostics.push(diagnostic('INVALID_SOURCE_FILE_SCHEMA', `${file.path} must use ${SOURCE_FILE_SCHEMA}`, file.path));
      if (rawFile.kind !== detectSourceFileKind(file.path)) diagnostics.push(diagnostic('SOURCE_FILE_KIND_MISMATCH', `${file.path} has the wrong file kind`, file.path));
      if (seenPaths.has(file.path)) diagnostics.push(diagnostic('DUPLICATE_SOURCE_PATH', `Duplicate source path ${file.path}`, file.path));
      seenPaths.add(file.path);
      if (file.enabled) normalizedFiles.push(file);
    } catch (error) {
      diagnostics.push(diagnostic(String((error as { code?: string }).code || 'INVALID_SOURCE_FILE'), (error as Error).message, String(rawFile?.path || 'files')));
    }
  }
  const files = new Map(normalizedFiles.map((file) => [file.path, file]));
  diagnostics.push(...typeCheckSystems(normalizedFiles));
  const rawModules: Array<{ manifest: LillyGameModuleManifest; sourcePath: string }> = [];
  for (const file of normalizedFiles.filter((entry) => entry.kind === 'module-manifest')) {
    const manifest = parseJson<LillyGameModuleManifest>(file, GAME_MODULE_SCHEMA, diagnostics);
    if (!manifest) continue;
    validateManifest(manifest, file.path, diagnostics);
    rawModules.push({ manifest, sourcePath: file.path });
  }
  const moduleIds = new Set<string>();
  const modules: CompiledModule[] = rawModules.map(({ manifest, sourcePath }) => {
    if (moduleIds.has(manifest.id)) diagnostics.push(diagnostic('DUPLICATE_MODULE_ID', `Duplicate module id ${manifest.id}`, sourcePath));
    moduleIds.add(manifest.id);
    const resolveAll = (values: unknown) => Array.isArray(values)
      ? values.map((entry) => {
        try { return resolveReference(sourcePath, String(entry)); }
        catch (error) { diagnostics.push(diagnostic('INVALID_MODULE_REFERENCE', (error as Error).message, sourcePath)); return String(entry); }
      })
      : [];
    return {
      ...manifest,
      dependencies: Array.isArray(manifest.dependencies) ? [...manifest.dependencies] : [],
      capabilities: Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : [],
      systems: resolveAll(manifest.systems),
      mechanics: resolveAll(manifest.mechanics),
      prefabs: resolveAll(manifest.prefabs),
      tests: resolveAll(manifest.tests),
      materials: resolveAll(manifest.materials),
      assets: resolveAll(manifest.assets),
      animations: resolveAll(manifest.animations),
      terrains: resolveAll(manifest.terrains),
      sourcePath,
    };
  });
  const loadOrder = topologicalOrder(modules, diagnostics);
  const systems: CompiledSystem[] = [];
  const mechanics: Array<LillyMechanicDefinition & { sourcePath: string }> = [];
  const prefabs: Array<LillyPrefabDefinition & { sourcePath: string }> = [];
  const tests: Array<LillyMechanicTestDefinition & { sourcePath: string }> = [];
  const materials: Array<LillyMaterialDefinition & { sourcePath: string }> = [];
  const assets: Array<LillyAssetMetadataDefinition & { sourcePath: string }> = [];
  const animations: Array<LillyAnimationControllerDefinition & { sourcePath: string }> = [];
  const terrains: Array<LillyTerrainDefinition & { sourcePath: string }> = [];
  const referenced = new Set<string>(modules.flatMap((module) => [
    ...module.systems,
    ...module.mechanics,
    ...module.prefabs,
    ...module.tests,
    ...module.materials,
    ...module.assets,
    ...module.animations,
    ...module.terrains,
  ]));

  for (const module of modules) {
    for (const [field, paths, expectedKind] of [
      ['systems', module.systems, 'system'],
      ['mechanics', module.mechanics, 'mechanic'],
      ['prefabs', module.prefabs, 'prefab'],
      ['tests', module.tests, 'test'],
      ['materials', module.materials, 'material'],
      ['assets', module.assets, 'asset-metadata'],
      ['animations', module.animations, 'animation-controller'],
      ['terrains', module.terrains, 'terrain'],
    ] as const) {
      for (const filePath of paths) {
        const file = files.get(filePath);
        if (!file) diagnostics.push(diagnostic('MODULE_FILE_MISSING', `Module ${module.id} ${field} reference ${filePath} does not exist`, module.sourcePath));
        else if (file.kind !== expectedKind) diagnostics.push(diagnostic('MODULE_FILE_KIND_MISMATCH', `${filePath} must be a ${expectedKind} file`, module.sourcePath));
      }
    }
    for (const filePath of module.systems) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'system') continue;
      const result = compileSystem(file, module.id);
      diagnostics.push(...result.diagnostics);
      if (result.compiled) systems.push(result.compiled);
    }
    for (const filePath of module.mechanics) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'mechanic') continue;
      const value = parseJson<LillyMechanicDefinition>(file, MECHANIC_SCHEMA, diagnostics);
      if (!value) continue;
      validateMechanic(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('MECHANIC_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      const resolvedSystems = (value.systems || []).map((entry) => resolveReference(file.path, entry));
      resolvedSystems.forEach((entry) => { if (!module.systems.includes(entry)) diagnostics.push(diagnostic('MECHANIC_SYSTEM_NOT_EXPORTED', `Mechanic ${value.id} references ${entry}, which module ${module.id} does not export`, file.path)); });
      mechanics.push({ ...value, systems: resolvedSystems, sourcePath: file.path });
    }
    for (const filePath of module.prefabs) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'prefab') continue;
      const value = parseJson<LillyPrefabDefinition>(file, PREFAB_SCHEMA, diagnostics);
      if (!value) continue;
      validatePrefab(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('PREFAB_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      prefabs.push({ ...value, sourcePath: file.path });
    }
    for (const filePath of module.tests) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'test') continue;
      const value = parseJson<LillyMechanicTestDefinition>(file, MECHANIC_TEST_SCHEMA, diagnostics);
      if (!value) continue;
      validateTest(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('TEST_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      tests.push({ ...value, sourcePath: file.path });
    }
    for (const filePath of module.materials) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'material') continue;
      const value = parseJson<LillyMaterialDefinition>(file, MATERIAL_SCHEMA, diagnostics);
      if (!value) continue;
      validateMaterial(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('MATERIAL_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      materials.push({ ...value, sourcePath: file.path });
    }
    for (const filePath of module.assets) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'asset-metadata') continue;
      const value = parseJson<LillyAssetMetadataDefinition>(file, ASSET_METADATA_SCHEMA, diagnostics);
      if (!value) continue;
      validateAssetMetadata(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('ASSET_METADATA_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      assets.push({ ...value, sourcePath: file.path });
    }
    for (const filePath of module.animations) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'animation-controller') continue;
      const value = parseJson<LillyAnimationControllerDefinition>(file, ANIMATION_CONTROLLER_SCHEMA, diagnostics);
      if (!value) continue;
      validateAnimation(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('ANIMATION_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      animations.push({ ...value, sourcePath: file.path });
    }
    for (const filePath of module.terrains) {
      const file = files.get(filePath);
      if (!file || file.kind !== 'terrain') continue;
      const value = parseJson<LillyTerrainDefinition>(file, TERRAIN_SCHEMA, diagnostics);
      if (!value) continue;
      validateTerrain(value, file.path, diagnostics);
      if (value.moduleId !== module.id) diagnostics.push(diagnostic('TERRAIN_MODULE_MISMATCH', `${file.path} belongs to ${value.moduleId}, expected ${module.id}`, file.path));
      terrains.push({ ...value, sourcePath: file.path });
    }
  }
  for (const file of normalizedFiles) {
    if (['system', 'mechanic', 'prefab', 'test', 'material', 'asset-metadata', 'animation-controller', 'terrain'].includes(file.kind) && !referenced.has(file.path)) diagnostics.push(diagnostic('ORPHAN_SOURCE_FILE', `${file.path} is not exported by a module manifest`, file.path, 'warning'));
  }
  const ensureUniqueResources = <T extends { id: string; sourcePath: string }>(kind: string, values: T[]) => {
    const seen = new Set<string>();
    values.forEach((value) => {
      if (seen.has(value.id)) diagnostics.push(diagnostic(`DUPLICATE_${kind}_ID`, `Duplicate ${kind.toLowerCase()} id ${value.id}`, value.sourcePath));
      seen.add(value.id);
    });
  };
  ensureUniqueResources('MATERIAL', materials);
  ensureUniqueResources('ASSET_METADATA', assets);
  ensureUniqueResources('ANIMATION_CONTROLLER', animations);
  ensureUniqueResources('TERRAIN', terrains);
  const materialIds = new Set(materials.map((value) => value.id));
  const animationIds = new Set(animations.map((value) => value.id));
  const terrainIds = new Set(terrains.map((value) => value.id));
  terrains.forEach((terrain) => {
    if (terrain.materialId && !materialIds.has(terrain.materialId)) diagnostics.push(diagnostic('TERRAIN_MATERIAL_MISSING', `Terrain ${terrain.id} references missing material ${terrain.materialId}`, terrain.sourcePath));
  });
  prefabs.forEach((prefab) => prefab.entities.forEach((entity) => entity.components.forEach((entry) => {
    if (entry.type === 'MeshRenderer' && entry.data.materialId && !materialIds.has(String(entry.data.materialId))) diagnostics.push(diagnostic('PREFAB_MATERIAL_MISSING', `Prefab ${prefab.id} references missing material ${entry.data.materialId}`, prefab.sourcePath));
    if (entry.type === 'Animator' && entry.data.controllerId && !animationIds.has(String(entry.data.controllerId))) diagnostics.push(diagnostic('PREFAB_ANIMATION_MISSING', `Prefab ${prefab.id} references missing animation controller ${entry.data.controllerId}`, prefab.sourcePath));
    if (entry.type === 'Terrain' && entry.data.terrainId && !terrainIds.has(String(entry.data.terrainId))) diagnostics.push(diagnostic('PREFAB_TERRAIN_MISSING', `Prefab ${prefab.id} references missing terrain ${entry.data.terrainId}`, prefab.sourcePath));
  })));
  const loadIndex = new Map(loadOrder.map((moduleId, index) => [moduleId, index]));
  const byModuleOrder = <T extends { moduleId: string; sourcePath?: string; path?: string }>(left: T, right: T) => (
    (loadIndex.get(left.moduleId) ?? Number.MAX_SAFE_INTEGER) - (loadIndex.get(right.moduleId) ?? Number.MAX_SAFE_INTEGER)
    || String(left.path || left.sourcePath || '').localeCompare(String(right.path || right.sourcePath || ''))
  );
  modules.sort((left, right) => (loadIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (loadIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  systems.sort(byModuleOrder);
  mechanics.sort(byModuleOrder);
  prefabs.sort(byModuleOrder);
  tests.sort(byModuleOrder);
  materials.sort(byModuleOrder);
  assets.sort(byModuleOrder);
  animations.sort(byModuleOrder);
  terrains.sort(byModuleOrder);
  const sourceHash = stableHash(normalizedFiles.map((file) => `${file.path}\0${file.content}`).sort().join('\0'));
  return { schema: MODULE_BUNDLE_SCHEMA, sourceHash, loadOrder, modules, systems, mechanics, prefabs, tests, materials, assets, animations, terrains, diagnostics };
}

export function assertModuleBundleValid(bundle: LillyModuleBundle): LillyModuleBundle {
  const errors = bundle.diagnostics.filter((entry) => entry.severity === 'error');
  if (errors.length) throw Object.assign(new Error(errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ')), { code: 'MODULE_COMPILE_FAILED', diagnostics: errors });
  return bundle;
}

export const LILLY_RUNTIME_TYPE_DECLARATIONS = `
declare module '@lilly/engine-runtime' {
  export type LillyVector2 = { x: number; y: number };
  export type LillyVector3 = { x: number; y: number; z: number };
  export type LillyCollisionEvent = {
    readonly type: 'collision' | 'trigger';
    readonly phase: 'start' | 'end';
    readonly entityA: string;
    readonly entityB: string;
    readonly tagsA: readonly string[];
    readonly tagsB: readonly string[];
    readonly positionA?: LillyVector3;
    readonly positionB?: LillyVector3;
  };
  export type LillySystemContext<State extends Record<string, unknown> = Record<string, unknown>> = {
    readonly delta: number;
    readonly frame: number;
    readonly elapsed: number;
    readonly state: State;
    readonly world: { readonly playerId: string; readonly entities: ReadonlyArray<{ id: string; tags: string[]; components?: unknown[] }> };
    readonly input: { button(action: string): boolean; axis2d(action: string): LillyVector2 };
    random(): number;
    entities: { query(tag: string): string[]; read(entityId: string): unknown; patch(entityId: string, component: string, values: Record<string, unknown>): void; spawn(prefabId: string, options?: Record<string, unknown>): void; destroy(entityId: string): void };
    physics: { force(entityId: string, value: LillyVector3): void; impulse(entityId: string, value: LillyVector3): void; raycast(origin: LillyVector3, direction: LillyVector3, maxDistance: number): void };
    events: { emit(name: string, payload?: Record<string, unknown>): void };
    hud: { message(text: string, options?: Record<string, unknown>): void };
    audio: { play(assetId: string, options?: Record<string, unknown>): void };
    particles: { emit(effectId: string, entityId?: string): void };
    save: { get(key: string): unknown; set(key: string, value: unknown): void };
  };
  export type LillySystemDefinition<State extends Record<string, unknown> = Record<string, unknown>> = {
    id: string;
    state?: State;
    onStart?(ctx: LillySystemContext<State>): void;
    onFixedUpdate?(ctx: LillySystemContext<State>): void;
    onInput?(ctx: LillySystemContext<State>): void;
    onEvent?(ctx: LillySystemContext<State> & { event: { name: string; payload?: Record<string, unknown> } }): void;
    onCollision?(ctx: LillySystemContext<State> & { collision: LillyCollisionEvent }): void;
  };
  export function defineSystem<State extends Record<string, unknown>>(definition: LillySystemDefinition<State>): LillySystemDefinition<State>;
}
`;
