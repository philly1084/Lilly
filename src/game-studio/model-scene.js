'use strict';

// Assemble validated Lilly GLBs into an instanced scene, sharing mesh buffers.
function assembleModelScene(models, instances, name) {
  const gltf = { asset: { version: '2.0', generator: 'Lilly Environment Creator' }, scene: 0, scenes: [{ name, nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  const roots = new Map();
  let byteLength = 0;
  for (const { id, buffer } of models) {
    const jsonLength = buffer.readUInt32LE(12);
    const source = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
    const binary = buffer.subarray(28 + jsonLength);
    const viewOffset = gltf.bufferViews.length;
    const accessorOffset = gltf.accessors.length;
    const materialOffset = gltf.materials.length;
    const meshOffset = gltf.meshes.length;
    gltf.bufferViews.push(...source.bufferViews.map(view => ({ ...view, buffer: 0, byteOffset: byteLength + (view.byteOffset || 0) })));
    gltf.accessors.push(...source.accessors.map(accessor => ({ ...accessor, bufferView: accessor.bufferView + viewOffset })));
    gltf.materials.push(...source.materials);
    gltf.meshes.push(...source.meshes.map(mesh => ({ ...mesh, primitives: mesh.primitives.map(primitive => ({ ...primitive, ...(primitive.indices !== undefined ? { indices: primitive.indices + accessorOffset } : {}), material: primitive.material + materialOffset, attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([key, index]) => [key, index + accessorOffset])) })) })));
    roots.set(id, source.nodes.map(node => ({ ...node, mesh: node.mesh + meshOffset })));
    chunks.push(binary);
    byteLength += binary.length;
  }
  for (const instance of instances) {
    const nodes = roots.get(instance.modelId);
    if (!nodes) throw new Error(`Unknown scenery model ${instance.modelId}`);
    const parent = gltf.nodes.length;
    const angle = Number(instance.yaw || 0) * Math.PI / 360;
    gltf.nodes.push({ name: instance.name || instance.modelId, translation: instance.position, rotation: [0, Math.sin(angle), 0, Math.cos(angle)], scale: [instance.scale || 1, instance.scale || 1, instance.scale || 1], children: nodes.map((_node, index) => parent + index + 1) }, ...nodes);
    gltf.scenes[0].nodes.push(parent);
  }
  gltf.buffers.push({ byteLength });
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const output = Buffer.alloc(28 + jsonLength + byteLength, 0x20);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  output.writeUInt32LE(byteLength, 20 + jsonLength);
  output.writeUInt32LE(0x004e4942, 24 + jsonLength);
  Buffer.concat(chunks).copy(output, 28 + jsonLength);
  return output;
}

module.exports = { assembleModelScene };
