'use strict';

const { compileModelRecipe } = require('./asset-creator');
const recipe = { schema: 'LillyModelRecipe/v1', name: 'Copper robot', parts: [
  { name: 'Body', shape: 'box', position: [0, 1, 0], scale: [1, 1.5, 0.6], color: '#228899' },
  { name: 'Eye', shape: 'sphere', position: [0, 1.4, 0.4], scale: [0.4, 0.4, 0.2], color: '#ffaa44' },
] };

test('exports aligned glTF 2 binary geometry with named nodes, materials, grounded pivot and bounded accessors', () => {
  const { buffer, summary } = compileModelRecipe(recipe);
  expect(buffer.readUInt32LE(0)).toBe(0x46546c67);
  expect(buffer.readUInt32LE(4)).toBe(2);
  expect(buffer.readUInt32LE(8)).toBe(buffer.length);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString());
  expect(gltf.nodes.map((node) => node.name)).toEqual(['Body', 'Eye']);
  expect(gltf.materials).toHaveLength(2);
  expect(gltf.buffers[0].byteLength).toBe(buffer.length - 28 - jsonLength);
  for (const view of gltf.bufferViews) {
    expect(view.byteOffset % 4).toBe(0);
    expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(gltf.buffers[0].byteLength);
  }
  const positions = gltf.meshes.map((mesh) => gltf.accessors[mesh.primitives[0].attributes.POSITION]);
  expect(Math.min(...positions.map((entry) => entry.min[1]))).toBeCloseTo(0);
  expect(summary.triangles).toBeGreaterThan(12);
  expect(compileModelRecipe(recipe).buffer.equals(buffer)).toBe(true);
});

test('supports authored mesh vertices rather than only preset shapes', () => {
  const result = compileModelRecipe({ ...recipe, parts: [{ name: 'Wing', shape: 'mesh', vertices: [0, 0, 0, 2, 0, 0, 1, 1, 0], indices: [0, 1, 2] }] });
  expect(result.summary.triangles).toBe(1);
});

test.each([
  { ...recipe, parts: Array(65).fill(recipe.parts[0]) },
  { ...recipe, parts: [{ ...recipe.parts[0], scale: [1, -1, 1] }] },
  { ...recipe, parts: [{ ...recipe.parts[0], position: [NaN, 0, 0] }] },
  { ...recipe, parts: [{ ...recipe.parts[0], shape: 'script' }] },
  { ...recipe, parts: [{ name: 'Invalid', shape: 'mesh', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 4] }] },
])('rejects unsafe or invalid recipes', (input) => {
  expect(() => compileModelRecipe(input)).toThrow();
});

module.exports = { recipe };
