import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LillyAnimationControllerDefinition, LillyAssetMetadataDefinition, LillyComponent, LillyEntity, LillyMaterialDefinition, LillyProject, LillyScene, LillyTerrainDefinition, Vec3 } from '../../core/src';

type MeshData = {
  geometry?: string;
  assetId?: string;
  materialId?: string;
  material?: { color?: string; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number };
  castShadow?: boolean;
  receiveShadow?: boolean;
};

export interface LillyRendererOptions {
  canvas: HTMLCanvasElement;
  antialias?: boolean;
  experimentalWebGPU?: boolean;
  onRendererError?: (error: Error) => void;
}

function toVector3(value: unknown, fallback: Vec3): Vec3 {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<Vec3>;
  return {
    x: Number.isFinite(Number(candidate.x)) ? Number(candidate.x) : fallback.x,
    y: Number.isFinite(Number(candidate.y)) ? Number(candidate.y) : fallback.y,
    z: Number.isFinite(Number(candidate.z)) ? Number(candidate.z) : fallback.z,
  };
}

function component(entity: LillyEntity, type: string): LillyComponent | null {
  return entity.components.find((entry) => entry.type === type) || null;
}

function createGeometry(kind = 'box') {
  switch (kind) {
    case 'sphere': return new THREE.SphereGeometry(0.5, 32, 24);
    case 'capsule': return new THREE.CapsuleGeometry(0.45, 0.7, 8, 16);
    case 'plane': return new THREE.PlaneGeometry(1, 1);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
    case 'octahedron': return new THREE.OctahedronGeometry(0.7, 0);
    case 'torus': return new THREE.TorusGeometry(0.6, 0.16, 16, 48);
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

export class ThreeSceneAdapter {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly objects = new Map<string, THREE.Object3D>();
  readonly selection = new Set<string>();
  private project: LillyProject | null = null;
  private activeScene: LillyScene | null = null;
  private assetResolver: (assetId: string) => string | null = () => null;
  private gltfLoader = new GLTFLoader();
  private materials = new Map<string, LillyMaterialDefinition>();
  private assetMetadata = new Map<string, LillyAssetMetadataDefinition>();
  private animations = new Map<string, LillyAnimationControllerDefinition>();
  private terrains = new Map<string, LillyTerrainDefinition>();
  private mixers: THREE.AnimationMixer[] = [];

  constructor() {
    this.root.name = 'LillySceneRoot';
    this.scene.add(this.root);
  }

  setAssetResolver(resolver: (assetId: string) => string | null) { this.assetResolver = resolver; }

  async load(project: LillyProject, sceneId = project.entryScene) {
    this.clear();
    this.project = project;
    this.readWorldResources(project);
    this.activeScene = project.scenes.find((scene) => scene.id === sceneId) || null;
    if (!this.activeScene) throw new Error(`Scene ${sceneId} was not found`);
    this.scene.background = new THREE.Color(this.activeScene.environment.background || '#0b1118');
    if (this.activeScene.environment.fog) {
      const fog = this.activeScene.environment.fog;
      this.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
    }
    const ambient = new THREE.HemisphereLight('#d8ecff', '#17202b', this.activeScene.environment.ambientIntensity || 0.4);
    ambient.name = 'LillyEnvironmentLight';
    this.root.add(ambient);

    for (const entity of this.activeScene.entities) {
      if (!entity.enabled) continue;
      const object = await this.createObject(entity);
      object.userData.lillyEntityId = entity.id;
      object.name = entity.name;
      this.objects.set(entity.id, object);
    }
    for (const entity of this.activeScene.entities) {
      const object = this.objects.get(entity.id);
      if (!object) continue;
      const parent = entity.parentId ? this.objects.get(entity.parentId) : null;
      (parent || this.root).add(object);
    }
  }

  private async createObject(entity: LillyEntity): Promise<THREE.Object3D> {
    const meshComponent = component(entity, 'MeshRenderer');
    const terrainComponent = component(entity, 'Terrain');
    const lightComponent = component(entity, 'Light');
    const cameraComponent = component(entity, 'Camera');
    let object: THREE.Object3D = new THREE.Group();
    if (terrainComponent) object = this.createTerrain(terrainComponent.data);
    else if (meshComponent) object = await this.createMesh(meshComponent.data as MeshData, entity);
    else if (lightComponent) object = this.createLight(lightComponent.data);
    else if (cameraComponent) object = this.createCamera(cameraComponent.data);
    this.applyTransform(object, component(entity, 'Transform')?.data || {});
    object.visible = entity.enabled;
    return object;
  }

  private readWorldResources(project: LillyProject) {
    this.materials.clear();
    this.assetMetadata.clear();
    this.animations.clear();
    this.terrains.clear();
    for (const file of project.files || []) {
      if (!file.enabled || !['material', 'asset-metadata', 'animation-controller', 'terrain'].includes(file.kind)) continue;
      try {
        const value = JSON.parse(file.content);
        if (file.kind === 'material') this.materials.set(value.id, value);
        else if (file.kind === 'asset-metadata') this.assetMetadata.set(value.assetId, value);
        else if (file.kind === 'animation-controller') this.animations.set(value.id, value);
        else if (file.kind === 'terrain') this.terrains.set(value.id, value);
      } catch (_error) {
        // Source diagnostics own malformed authoring files; the renderer remains recoverable.
      }
    }
  }

  private createMaterial(data: MeshData = {}) {
    const authored = this.materials.get(String(data.materialId || '')) || {} as LillyMaterialDefinition;
    const inline = data.material || {};
    const values = { ...authored, ...inline };
    const common = {
      color: values.color || '#8ea7c4',
      transparent: values.transparent === true || Number(values.opacity ?? 1) < 1,
      opacity: Number(values.opacity ?? 1),
      side: values.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
      flatShading: values.flatShading === true,
      wireframe: values.wireframe === true,
    };
    if (values.shading === 'unlit') return new THREE.MeshBasicMaterial(common);
    const lit = { ...common, emissive: values.emissive || '#000000', emissiveIntensity: Number(values.emissiveIntensity ?? 0) };
    if (values.shading === 'toon') return new THREE.MeshToonMaterial(lit);
    if (values.shading === 'physical') return new THREE.MeshPhysicalMaterial({ ...lit, roughness: Number(values.roughness ?? 0.65), metalness: Number(values.metalness ?? 0.05), clearcoat: Number(values.clearcoat ?? 0), clearcoatRoughness: Number(values.clearcoatRoughness ?? 0) });
    return new THREE.MeshStandardMaterial({ ...lit, roughness: Number(values.roughness ?? 0.65), metalness: Number(values.metalness ?? 0.05) });
  }

  private createTerrain(data: Record<string, unknown>) {
    const definition = this.terrains.get(String(data.terrainId || ''));
    if (!definition) return new THREE.Group();
    const geometry = new THREE.PlaneGeometry(definition.size.x, definition.size.y, definition.resolution - 1, definition.resolution - 1);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    for (let index = 0; index < positions.count; index += 1) positions.setY(index, Number(definition.heights[index] || 0) * definition.heightScale);
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.createMaterial({ materialId: definition.materialId }));
    mesh.castShadow = data.castShadow === true;
    mesh.receiveShadow = data.receiveShadow !== false;
    return mesh;
  }

  private async createMesh(data: MeshData, entity: LillyEntity) {
    if (data.assetId) {
      const uri = this.assetResolver(data.assetId);
      if (uri) {
        const gltf = await this.gltfLoader.loadAsync(uri);
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = data.castShadow !== false;
            child.receiveShadow = data.receiveShadow !== false;
            if (data.materialId) child.material = this.createMaterial(data);
          }
        });
        const metadata = this.assetMetadata.get(data.assetId);
        const scale = toVector3(metadata?.scale, { x: 1, y: 1, z: 1 });
        const pivot = toVector3(metadata?.pivot, { x: 0, y: 0, z: 0 });
        gltf.scene.scale.set(scale.x, scale.y, scale.z);
        gltf.scene.position.set(-pivot.x, -pivot.y, -pivot.z);
        const animator = component(entity, 'Animator');
        const controller = this.animations.get(String(animator?.data.controllerId || ''));
        const state = controller?.states.find((entry) => entry.id === String(animator?.data.state || controller.defaultState));
        const clipName = String(animator?.data.clip || state?.clip || '');
        const clip = gltf.animations.find((entry) => entry.name === clipName) || gltf.animations[0];
        if (animator?.data.autoplay !== false && clip) {
          const mixer = new THREE.AnimationMixer(gltf.scene);
          const action = mixer.clipAction(clip);
          action.timeScale = Number(animator?.data.speed ?? state?.speed ?? 1);
          action.setLoop(state?.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity).play();
          this.mixers.push(mixer);
        }
        return gltf.scene;
      }
    }
    const mesh = new THREE.Mesh(createGeometry(data.geometry), this.createMaterial(data));
    mesh.castShadow = data.castShadow !== false;
    mesh.receiveShadow = data.receiveShadow !== false;
    return mesh;
  }

  private createLight(data: Record<string, unknown>) {
    const color = String(data.color || '#ffffff');
    const intensity = Number(data.intensity || 1);
    let light: THREE.Light;
    switch (data.kind) {
      case 'point': light = new THREE.PointLight(color, intensity, Number(data.range || 20)); break;
      case 'spot': light = new THREE.SpotLight(color, intensity, Number(data.range || 30), Number(data.angle || Math.PI / 5)); break;
      case 'hemisphere': light = new THREE.HemisphereLight(color, String(data.groundColor || '#202938'), intensity); break;
      default: light = new THREE.DirectionalLight(color, intensity);
    }
    light.castShadow = data.castShadow !== false;
    return light;
  }

  private createCamera(data: Record<string, unknown>) {
    if (data.projection === 'orthographic') return new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, Number(data.near || 0.1), Number(data.far || 1000));
    return new THREE.PerspectiveCamera(Number(data.fov || 60), 16 / 9, Number(data.near || 0.1), Number(data.far || 1000));
  }

  private applyTransform(object: THREE.Object3D, data: Record<string, unknown>) {
    const position = toVector3(data.position, { x: 0, y: 0, z: 0 });
    const rotation = toVector3(data.rotation, { x: 0, y: 0, z: 0 });
    const scale = toVector3(data.scale, { x: 1, y: 1, z: 1 });
    object.position.set(position.x, position.y, position.z);
    object.rotation.set(rotation.x, rotation.y, rotation.z);
    object.scale.set(scale.x, scale.y, scale.z);
  }

  syncTransform(entityId: string, transform: Record<string, unknown>) {
    const object = this.objects.get(entityId);
    if (object) this.applyTransform(object, transform);
  }

  update(deltaSeconds: number) { this.mixers.forEach((mixer) => mixer.update(Math.max(0, deltaSeconds))); }

  getPrimaryCamera(): THREE.Camera | null {
    if (!this.activeScene) return null;
    const entity = this.activeScene.entities.find((candidate) => component(candidate, 'Camera')?.data.primary === true)
      || this.activeScene.entities.find((candidate) => component(candidate, 'Camera'));
    return entity ? this.objects.get(entity.id) as THREE.Camera : null;
  }

  setSelection(entityIds: string[]) {
    this.selection.clear();
    entityIds.forEach((id) => this.selection.add(id));
    this.objects.forEach((object, id) => {
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshStandardMaterial)) return;
        child.material.emissive.set(this.selection.has(id) ? '#0ea5e9' : '#000000');
        child.material.emissiveIntensity = this.selection.has(id) ? 0.35 : 0;
      });
    });
  }

  clear() {
    while (this.root.children.length) {
      const object = this.root.children.pop();
      object?.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((material) => material.dispose());
        }
      });
    }
    this.objects.clear();
    this.mixers = [];
  }
}

export class LillyThreeRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly adapter = new ThreeSceneAdapter();
  readonly editorCamera = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 2000);
  private clock = new THREE.Clock();

  constructor(options: LillyRendererOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: options.antialias !== false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.editorCamera.position.set(8, 7, 11);
    this.editorCamera.lookAt(0, 0, 0);
    options.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      options.onRendererError?.(new Error('WebGL context was lost'));
    });
  }

  resize(width: number, height: number, pixelRatio = window.devicePixelRatio || 1) {
    const safeHeight = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(2, Math.max(1, pixelRatio)));
    this.renderer.setSize(width, safeHeight, false);
    this.editorCamera.aspect = width / safeHeight;
    this.editorCamera.updateProjectionMatrix();
  }

  render(gameView = false) {
    this.adapter.update(this.clock.getDelta());
    this.renderer.render(this.adapter.scene, (gameView && this.adapter.getPrimaryCamera()) || this.editorCamera);
  }

  dispose() { this.adapter.clear(); this.renderer.dispose(); }
}
