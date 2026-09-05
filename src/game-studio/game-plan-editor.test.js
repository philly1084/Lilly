'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');
const file = path.resolve(__dirname, '../../frontend/game-studio/src/components/GamePlanEditor.tsx');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = module.paths;
loaded._compile(compiled, file);
const { readGamePlan, GamePlanEditor } = loaded.exports;
const plan = { schema: 'LillyGamePlan/v1', foundation: 'authored', name: 'Relay', fantasy: 'Explore', artDirection: 'Stone', coreLoop: ['Find', 'Collect'], winCondition: 'Reach the gate', loseCondition: 'Timeout', controls: ['WASD'], acceptance: ['Win'], deferred: [], levelPrompt: 'Level', scenePrompt: 'Court', environmentPrompt: null, gameplayPrompt: 'Rules', assets: [{ id: 'relay', name: 'Relay stone', prompt: 'Blue stone', placement: 'landmark', targetEntityId: 'relay-entity' }] };
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  return [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
}
test('editing asset briefs retains stable task and scene targets through the advanced format', () => {
  let edited;
  const tree = GamePlanEditor({ plan, disabled: false, onChange: value => { edited = value; } });
  const appearance = nodes(tree).find(node => node.type === 'textarea' && node.props.value === 'Blue stone');
  appearance.props.onChange({ target: { value: 'Faceted violet crystal' } });
  const saved = readGamePlan(JSON.stringify(edited));
  expect(saved.assets[0]).toEqual({ ...plan.assets[0], prompt: 'Faceted violet crystal' });
  expect(saved.scenePrompt).toBe('Court');
  expect(saved.foundation).toBe('authored');
});
test('line editing keeps unfinished lines while preserving the remaining plan', () => {
  let edited;
  const tree = GamePlanEditor({ plan, disabled: false, onChange: value => { edited = value; } });
  nodes(tree).find(node => node.type === 'textarea' && node.props.value === 'WASD').props.onChange({ target: { value: 'Arrows\n' } });
  expect(edited.controls).toEqual(['Arrows', '']);
  expect(edited.assets).toEqual(plan.assets);
});
test.each(['{', 'null', '[]', JSON.stringify({ ...plan, assets: [null] }), JSON.stringify({ ...plan, coreLoop: 4 })])('malformed advanced designs are recoverable: %s', text => {
  expect(readGamePlan(text)).toBeNull();
});
