import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Edges, GizmoHelper, GizmoViewport, Grid, Html, OrbitControls, PerspectiveCamera, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { LillyComponent, LillyEntity, LillyScene, Vec3 } from '../types';
import { currentScene, useStudioStore } from '../store';
import { Icon } from './Icon';

function component(entity: LillyEntity, type: string): LillyComponent | null {
  return entity.components.find((entry) => entry.type === type && entry.enabled !== false) || null;
}

function vector(value: unknown, fallback: Vec3): Vec3 {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<Vec3>;
  return { x: Number(candidate.x ?? fallback.x), y: Number(candidate.y ?? fallback.y), z: Number(candidate.z ?? fallback.z) };
}

function Geometry({ kind }: { kind: string }) {
  if (kind === 'sphere') return <sphereGeometry args={[0.5, 24, 18]}/>;
  if (kind === 'capsule') return <capsuleGeometry args={[0.45, 0.7, 8, 16]}/>;
  if (kind === 'cylinder') return <cylinderGeometry args={[0.5, 0.5, 1, 24]}/>;
  if (kind === 'octahedron') return <octahedronGeometry args={[0.7, 0]}/>;
  if (kind === 'torus') return <torusGeometry args={[0.6, 0.16, 16, 48]}/>;
  return <boxGeometry args={[1, 1, 1]}/>;
}

function EntityMesh({ entity, scene, runtimePlayer, snap }: { entity: LillyEntity; scene: LillyScene; runtimePlayer: React.MutableRefObject<THREE.Vector3>; snap: boolean }) {
  const selected = useStudioStore((state) => state.selectedEntityId === entity.id);
  const transformMode = useStudioStore((state) => state.transformMode);
  const playState = useStudioStore((state) => state.playState);
  const stepToken = useStudioStore((state) => state.stepToken);
  const selectEntity = useStudioStore((state) => state.selectEntity);
  const setComponent = useStudioStore((state) => state.setComponent);
  const group = useRef<THREE.Group>(null);
  const keys = useRef(new Set<string>());
  const lastStep = useRef(stepToken);
  const transform = component(entity, 'Transform');
  const mesh = component(entity, 'MeshRenderer');
  const light = component(entity, 'Light');
  const position = vector(transform?.data.position, { x: 0, y: 0, z: 0 });
  const rotation = vector(transform?.data.rotation, { x: 0, y: 0, z: 0 });
  const scale = vector(transform?.data.scale, { x: 1, y: 1, z: 1 });
  const isPlayer = entity.tags.includes('player');
  const isPickup = entity.tags.includes('pickup');

  useEffect(() => {
    if (!isPlayer) return;
    const down = (event: KeyboardEvent) => keys.current.add(event.code);
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [isPlayer]);

  useFrame((state, delta) => {
    if (!group.current) return;
    if (isPickup) group.current.rotation.y += delta * 0.8;
    if (!isPlayer || playState === 'editing') return;
    if (playState === 'playing') {
      const x = Number(keys.current.has('KeyD')) - Number(keys.current.has('KeyA'));
      const z = Number(keys.current.has('KeyS')) - Number(keys.current.has('KeyW'));
      const direction = new THREE.Vector3(x, 0, z);
      if (direction.lengthSq() > 0) {
        direction.normalize();
        group.current.position.addScaledVector(direction, delta * 6);
        group.current.rotation.y = Math.atan2(direction.x, direction.z);
      }
    } else if (stepToken !== lastStep.current) {
      group.current.position.x += 0.1;
      lastStep.current = stepToken;
    }
    group.current.position.x = THREE.MathUtils.clamp(group.current.position.x, -8.2, 8.2);
    group.current.position.z = THREE.MathUtils.clamp(group.current.position.z, -8.2, 8.2);
    runtimePlayer.current.copy(group.current.position);
    if (state.clock.elapsedTime < 0.2) runtimePlayer.current.copy(group.current.position);
  });

  const commitTransform = () => {
    if (!group.current || !transform) return;
    const object = group.current;
    setComponent(entity.id, {
      ...transform,
      data: {
        ...transform.data,
        position: { x: object.position.x, y: object.position.y, z: object.position.z },
        rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
        scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
      },
    });
  };

  const object = <group
    ref={group}
    position={[position.x, position.y, position.z]}
    rotation={[rotation.x, rotation.y, rotation.z]}
    scale={[scale.x, scale.y, scale.z]}
    visible={entity.enabled}
    onClick={(event) => { event.stopPropagation(); if (playState === 'editing') selectEntity(entity.id); }}
    userData={{ entityId: entity.id }}
  >
    {mesh && <mesh castShadow={mesh.data.castShadow !== false} receiveShadow={mesh.data.receiveShadow !== false}>
      <Geometry kind={String(mesh.data.geometry || 'box')}/>
      <meshStandardMaterial
        color={String((mesh.data.material as Record<string, unknown>)?.color || '#8ea7c4')}
        roughness={Number((mesh.data.material as Record<string, unknown>)?.roughness ?? 0.65)}
        metalness={Number((mesh.data.material as Record<string, unknown>)?.metalness ?? 0.05)}
        emissive={selected ? '#0ea5e9' : String((mesh.data.material as Record<string, unknown>)?.emissive || (isPickup ? '#4c1d95' : '#000000'))}
        emissiveIntensity={selected ? 0.45 : Number((mesh.data.material as Record<string, unknown>)?.emissiveIntensity || (isPickup ? 0.35 : 0))}
      />
      {selected && <Edges color="#7dd3fc" threshold={15}/>}
    </mesh>}
    {light?.data.kind === 'point' && <pointLight color={String(light.data.color || '#fff')} intensity={Number(light.data.intensity || 1)} distance={Number(light.data.range || 20)} castShadow={light.data.castShadow !== false}/>}
    {light && light.data.kind !== 'point' && <directionalLight color={String(light.data.color || '#fff')} intensity={Number(light.data.intensity || 1)} castShadow={light.data.castShadow !== false}/>}
    {!mesh && !light && entity.components.some((entry) => entry.type === 'Camera') && <mesh><coneGeometry args={[0.28, 0.7, 4]}/><meshBasicMaterial color={selected ? '#7dd3fc' : '#526476'} wireframe/></mesh>}
    {selected && playState === 'editing' && <Html position={[0, Math.max(1, scale.y), 0]} center className="selection-label"><span>{entity.name}</span><small>{entity.id}</small></Html>}
  </group>;

  if (selected && playState === 'editing' && !entity.locked && transform) {
    return <TransformControls mode={transformMode} translationSnap={snap ? 0.5 : null} rotationSnap={snap ? Math.PI / 12 : null} scaleSnap={snap ? 0.1 : null} onMouseUp={commitTransform}>{object}</TransformControls>;
  }
  return object;
}

function PlayCameraRig({ player }: { player: React.MutableRefObject<THREE.Vector3> }) {
  const playState = useStudioStore((state) => state.playState);
  const { camera } = useThree();
  useFrame((_state, delta) => {
    if (playState === 'editing') return;
    const target = new THREE.Vector3(player.current.x + 6.5, player.current.y + 6, player.current.z + 8.5);
    camera.position.lerp(target, 1 - Math.pow(0.001, delta));
    camera.lookAt(player.current.x, player.current.y + 0.7, player.current.z);
  });
  return null;
}

function EditorScene({ scene, snap, lighting }: { scene: LillyScene; snap: boolean; lighting: string }) {
  const playState = useStudioStore((state) => state.playState);
  const selectEntity = useStudioStore((state) => state.selectEntity);
  const playerEntity = scene.entities.find((entity) => entity.tags.includes('player'));
  const playerPosition = vector(component(playerEntity || scene.entities[0], 'Transform')?.data.position, { x: 0, y: 0.65, z: 5 });
  const runtimePlayer = useRef(new THREE.Vector3(playerPosition.x, playerPosition.y, playerPosition.z));
  return <>
    <color attach="background" args={[lighting === 'unlit' ? '#0d1117' : scene.environment.background || '#081018']}/>
    {lighting === 'studio' && <><hemisphereLight args={['#d8ecff', '#111923', 1.3]}/><directionalLight position={[8, 12, 6]} intensity={2.2} castShadow/></>}
    {lighting === 'unlit' && <ambientLight intensity={2}/>}
    {lighting === 'scene' && <hemisphereLight args={['#d8ecff', '#17202b', Number(scene.environment.ambientIntensity || 0.5)]}/>}
    <PerspectiveCamera makeDefault position={[9, 7.5, 12]} fov={52}/>
    {scene.entities.map((entity) => <EntityMesh key={entity.id} entity={entity} scene={scene} runtimePlayer={runtimePlayer} snap={snap}/>)}
    <Grid position={[0, 0.01, 0]} args={[40, 40]} cellSize={0.5} cellThickness={0.5} cellColor="#23394a" sectionSize={5} sectionThickness={1} sectionColor="#3b6078" fadeDistance={55} fadeStrength={1.5} infiniteGrid/>
    <OrbitControls makeDefault enabled={playState === 'editing'} target={[0, 0.8, 0]} minDistance={2} maxDistance={70} maxPolarAngle={Math.PI * 0.49}/>
    <PlayCameraRig player={runtimePlayer}/>
    {playState === 'editing' && <GizmoHelper alignment="bottom-right" margin={[68, 58]}><GizmoViewport axisColors={['#f87171', '#6ee7b7', '#60a5fa']} labelColor="#dce8f2"/></GizmoHelper>}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} onClick={() => selectEntity(null)}><planeGeometry args={[200, 200]}/><meshBasicMaterial transparent opacity={0}/></mesh>
  </>;
}

class ViewportErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <div className="viewport-error"><span>Renderer unavailable</span><strong>{this.state.error.message}</strong><p>Check WebGL2 support or open Build Output for diagnostics.</p></div>;
    return this.props.children;
  }
}

export function Viewport() {
  const current = useStudioStore((state) => state.current);
  const playState = useStudioStore((state) => state.playState);
  const [snap, setSnap] = useState(true);
  const [lighting, setLighting] = useState('scene');
  const [rendererReady, setRendererReady] = useState(false);
  const scene = useMemo(() => currentScene(current), [current]);
  if (!scene) return <main className="viewport-panel"><div className="viewport-empty"><Icon name="cube" size={34}/><strong>No entry scene</strong><span>Create or select a scene to start authoring.</span></div></main>;
  return <main className={`viewport-panel mode-${playState}`}>
    <div className="viewport-toolbar">
      <div className="viewport-mode"><button type="button" className={playState === 'editing' ? 'active' : ''}>Perspective</button><button type="button" className={playState !== 'editing' ? 'active' : ''}>Game</button></div>
      <div className="viewport-tools"><label>Lighting<select value={lighting} onChange={(event) => setLighting(event.target.value)}><option value="scene">Scene</option><option value="studio">Studio</option><option value="unlit">Unlit</option></select></label><button type="button" className={snap ? 'active' : ''} onClick={() => setSnap((value) => !value)}>Snap <kbd>0.5</kbd></button></div>
    </div>
    {!rendererReady && <div className="viewport-loading"><span className="spinner-small"/><span>Starting WebGL2 renderer…</span></div>}
    <ViewportErrorBoundary>
      <Canvas shadows dpr={[1, 2]} gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }} onCreated={({ gl }) => { gl.outputColorSpace = THREE.SRGBColorSpace; gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.04; setRendererReady(true); }}>
        <Suspense fallback={null}><EditorScene scene={scene} snap={snap} lighting={lighting}/></Suspense>
      </Canvas>
    </ViewportErrorBoundary>
    {playState !== 'editing' && <div className="play-hud"><div><span>Play mode</span><strong>{playState === 'playing' ? 'Simulation running' : 'Paused — step to advance'}</strong></div><div className="play-objective"><small>Blueprint objective</small><span>Collect 3 energy shards</span></div></div>}
    <div className="viewport-status"><span><i className="axis x"/>X</span><span><i className="axis y"/>Y</span><span><i className="axis z"/>Z</span><span className="viewport-stat">WebGL2 · 60 Hz fixed step</span></div>
  </main>;
}
