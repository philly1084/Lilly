'use strict';

const THREE = require('three');

const ASSET_RECIPE_SCHEMA = 'LillyModelRecipe/v1';
const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'icosahedron', 'mesh'];
function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 422, code: 'MODEL_RECIPE_INVALID' });
}
function vector(value, fallback, min, max) {
  const result = value === undefined ? fallback : value;
  if (!Array.isArray(result) || result.length !== 3 || result.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)) invalid(`Expected three numbers between ${min} and ${max}`);
  return result;
}

// Compile data only. Model output never becomes executable server code.
function compileModelRecipe(input) {
  if (input?.schema !== ASSET_RECIPE_SCHEMA || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) invalid('A model needs the LillyModelRecipe/v1 schema and a name of 1–100 characters');
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 64) invalid('A model must contain 1–64 named parts');
  const recipe = { schema: ASSET_RECIPE_SCHEMA, name: input.name.trim(), parts: [] };
  const geometries = [];
  const bounds = new THREE.Box3();
  let triangles = 0;
  try {
    for (const source of input.parts) {
      if (!source || !SHAPES.includes(source.shape)) invalid(`Supported shapes: ${SHAPES.join(', ')}`);
      if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 80) invalid('Each part needs a name of 1–80 characters');
      const part = {
        name: source.name.trim(), shape: source.shape,
        position: vector(source.position, [0, 0, 0], -50, 50),
        rotation: vector(source.rotation, [0, 0, 0], -360, 360),
        scale: vector(source.scale, [1, 1, 1], 0.01, 50),
        color: source.color || '#8ea7c4', roughness: source.roughness ?? 0.65, metalness: source.metalness ?? 0.05,
      };
      if (!/^#[a-f0-9]{6}$/i.test(part.color)) invalid('Part colors must use #RRGGBB');
      for (const key of ['roughness', 'metalness']) if (typeof part[key] !== 'number' || !Number.isFinite(part[key]) || part[key] < 0 || part[key] > 1) invalid(`${key} must be between 0 and 1`);
      let geometry;
      if (part.shape === 'mesh') {
        if (!Array.isArray(source.vertices) || source.vertices.length < 9 || source.vertices.length > 12000 || source.vertices.length % 3 || source.vertices.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 50)) invalid('Custom mesh vertices must be a flat xyz array with 3–4000 vertices, bounded to 50 meters');
        if (!Array.isArray(source.indices) || !source.indices.length || source.indices.length > 24000 || source.indices.length % 3 || source.indices.some((n) => !Number.isInteger(n) || n < 0 || n >= source.vertices.length / 3)) invalid('Custom mesh triangles require valid vertex indices');
        part.vertices = source.vertices;
        part.indices = source.indices;
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.vertices, 3));
        geometry.setIndex(part.indices);
        geometry.computeVertexNormals();
      } else {
        const factories = {
          box: () => new THREE.BoxGeometry(1, 1, 1),
          sphere: () => new THREE.SphereGeometry(0.5, 16, 12),
          cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
          cone: () => new THREE.ConeGeometry(0.5, 1, 16),
          torus: () => new THREE.TorusGeometry(0.4, 0.1, 8, 24),
          icosahedron: () => new THREE.IcosahedronGeometry(0.5, 1),
        };
        geometry = factories[part.shape]();
      }
      geometries.push(geometry);
      triangles += (geometry.index?.count || geometry.attributes.position.count) / 3;
      if (triangles > 50000) invalid('Model exceeds the 50,000 triangle budget');
      const rotation = new THREE.Euler(...part.rotation.map(THREE.MathUtils.degToRad));
      geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...part.position), new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(...part.scale)));
      geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox);
      recipe.parts.push(part);
    }
    const size = bounds.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) > 100 || Math.max(size.x, size.y, size.z) < 0.01) invalid('Model dimensions must fit within 100 meters');
    const center = bounds.getCenter(new THREE.Vector3());
    const gltf = { asset: { version: '2.0', generator: 'Lilly 3D Creator' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
    const chunks = [];
    let offset = 0;
    const accessor = (array, type, componentType, target, min, max) => {
      const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
      const view = gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }) - 1;
      chunks.push(bytes);
      offset += bytes.length;
      const padding = (4 - offset % 4) % 4;
      if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
      return gltf.accessors.push({ bufferView: view, componentType, count: array.length / (type === 'VEC3' ? 3 : 1), type, ...(min ? { min, max } : {}) }) - 1;
    };
    const materialIds = new Map();
    geometries.forEach((geometry, i) => {
      geometry.translate(-center.x, -bounds.min.y, -center.z);
      geometry.computeBoundingBox();
      const part = recipe.parts[i];
      const key = JSON.stringify([part.color, part.roughness, part.metalness]);
      if (!materialIds.has(key)) {
        materialIds.set(key, gltf.materials.length);
        gltf.materials.push({ name: part.color, pbrMetallicRoughness: { baseColorFactor: [...new THREE.Color(part.color).toArray(), 1], roughnessFactor: part.roughness, metallicFactor: part.metalness } });
      }
      const primitive = { attributes: {
        POSITION: accessor(geometry.attributes.position.array, 'VEC3', 5126, 34962, geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()),
        NORMAL: accessor(geometry.attributes.normal.array, 'VEC3', 5126, 34962),
      }, material: materialIds.get(key), mode: 4 };
      if (geometry.index) primitive.indices = accessor(new Uint32Array(geometry.index.array), 'SCALAR', 5125, 34963);
      gltf.meshes.push({ name: part.name, primitives: [primitive] });
      gltf.scenes[0].nodes.push(i);
      gltf.nodes.push({ name: part.name, mesh: i });
    });
    gltf.buffers.push({ byteLength: offset });
    const json = Buffer.from(JSON.stringify(gltf));
    const jsonPadded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
    json.copy(jsonPadded);
    const binary = Buffer.concat(chunks);
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + jsonPadded.length + binary.length, 8);
    header.writeUInt32LE(jsonPadded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
    const buffer = Buffer.concat([header, jsonPadded, binHeader, binary]);
    return { recipe, buffer, summary: { name: recipe.name, parts: recipe.parts.length, triangles, size: size.toArray(), sizeBytes: buffer.length, format: 'GLB', units: 'meters', pivot: 'ground-center' } };
  } finally { geometries.forEach((geometry) => geometry.dispose()); }
}

function modelRecipePrompt(prompt) {
  return `You are Lilly's 3D asset artist. Create an original, recognizable, carefully proportioned stylized 3D asset matching the request. Return JSON only: {"schema":"${ASSET_RECIPE_SCHEMA}","name":"Asset name","parts":[{"name":"descriptive part","shape":"box","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#aabbcc","roughness":0.65,"metalness":0.05}]}. Use 4–48 thoughtfully arranged parts, never a generic lone cube. Shape options: ${SHAPES.join(', ')}. Primitive dimensions are 1 meter, centered at origin; torus lies in XY. Rotations are XYZ degrees. Positive scales, Y up, meters. Keep the entire asset around 1–5 meters. Custom mesh parts additionally have flat xyz vertices and indexed triangle indices (counterclockwise winding); use these for distinctive silhouettes beyond primitives. Maximum 4000 vertices and 8000 triangles per custom part; entire asset <=50000 triangles. Use cohesive materials, intentional silhouette, secondary details, and no hidden overlapping filler. No textures, code, URLs, rigging, or invented animation. Ground-center pivot is set automatically. User request: ${JSON.stringify(prompt)}`;
}

module.exports = { ASSET_RECIPE_SCHEMA, compileModelRecipe, modelRecipePrompt };
