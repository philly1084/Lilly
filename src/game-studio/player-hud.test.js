'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

test('authored HUD reflects visible labels and live patches without repeating unchanged DOM writes', () => {
  const source = ts.createSourceFile('player-runtime.js', fs.readFileSync(path.join(__dirname, 'player-runtime.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['applyModuleActions', 'updateAuthoredHud']);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source)).join('\n');
  const anchor = (id, text, visible = true) => ({ id, enabled: true, components: [{ type: 'UIAnchor', data: { text, visible } }] });
  let text = '', writes = 0;
  const objective = { get textContent() { return text; }, set textContent(value) { text = value; writes++; } };
  const context = vm.createContext({
    project: { entryScene: 'main', scenes: [{ id: 'main', entities: [anchor('timer', '90'), anchor('result', 'YOU WIN', false)] }] },
    objective, runtimeProfile: 'module-driven', objectMap: new Map(),
    component: (entity, type) => entity.components.find(entry => entry.type === type), setStatus: () => {},
  });
  vm.runInContext(code + '\nupdateAuthoredHud();', context);
  expect(text).toBe('90');
  vm.runInContext("applyModuleActions([{type:'entity.patch',entityId:'timer',component:'UIAnchor',values:{text:'89'}},{type:'entity.patch',entityId:'result',component:'UIAnchor',values:{visible:true}}]);", context);
  expect(text).toBe('89 · YOU WIN');
  expect(writes).toBe(2);
  vm.runInContext('updateAuthoredHud();', context);
  expect(writes).toBe(2);
  vm.runInContext("applyModuleActions([{type:'hud.message',text:'Restarted'}]);", context);
  expect(text).toBe('Restarted');
});
