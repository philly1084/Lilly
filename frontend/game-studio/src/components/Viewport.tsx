import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Edges, GizmoHelper, GizmoViewport, Grid, Html, OrbitControls, PerspectiveCamera, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { GameplaySimulation, scheduleGameplaySteps, type GameplayState } from '../../../../packages/lilly-engine/gameplay/src';
import { useWorkspacePreviewAccess } from '../preview-access';
import type { LillyComponent, LillyEntity, LillyProject, LillyScene, Vec3 } from '../types';
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

type CollisionBox = { entityId: string; gateId: string | null; minX: number; maxX: number; minZ: number; maxZ: number };
type CollisionWorld = { walkable: CollisionBox[]; obstacles: CollisionBox[]; center: Vec3; span: number };

function collisionWorld(scene: LillyScene): CollisionWorld {
  const walkable: CollisionBox[] = [];
  const obstacles: CollisionBox[] = [];
  scene.entities.forEach((entity) => {
    const collider = component(entity, 'Collider');
    const transform = component(entity, 'Transform');
    if (!collider || !transform) return;
    const position = vector(transform.data.position, { x: 0, y: 0, z: 0 });
    const scale = vector(transform.data.scale, { x: 1, y: 1, z: 1 });
    const size = vector(collider.data.size, scale);
    const box = {
      entityId: entity.id,
      gateId: entity.tags.includes('encounter-gate') ? entity.id : null,
      minX: position.x - size.x / 2,
      maxX: position.x + size.x / 2,
      minZ: position.z - size.z / 2,
      maxZ: position.z + size.z / 2,
    };
    if (entity.tags.includes('ground')) walkable.push(box);
    if (collider.data.sensor !== true && (entity.tags.includes('wall') || entity.tags.includes('obstacle'))) obstacles.push(box);
  });
  const boxes = walkable.length ? walkable : [{ entityId: 'fallback', gateId: null, minX: -9, maxX: 9, minZ: -9, maxZ: 9 }];
  const minX = Math.min(...boxes.map((box) => box.minX));
  const maxX = Math.max(...boxes.map((box) => box.maxX));
  const minZ = Math.min(...boxes.map((box) => box.minZ));
  const maxZ = Math.max(...boxes.map((box) => box.maxZ));
  return {
    walkable: boxes,
    obstacles,
    center: { x: (minX + maxX) / 2, y: 0, z: (minZ + maxZ) / 2 },
    span: Math.max(18, maxX - minX, maxZ - minZ),
  };
}

function canStand(world: CollisionWorld, x: number, z: number, gates: Record<string, boolean>, radius = 0.44, ignoredEntityId = '') {
  const onGround = world.walkable.some((box) => x >= box.minX - 0.18 && x <= box.maxX + 0.18 && z >= box.minZ - 0.18 && z <= box.maxZ + 0.18);
  const blocked = world.obstacles.some((box) => {
    if (box.entityId === ignoredEntityId || (box.gateId && !gates[box.gateId])) return false;
    return x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ;
  });
  return onGround && !blocked;
}

function Geometry({ kind }: { kind: string }) {
  if (kind === 'sphere') return <sphereGeometry args={[0.5, 24, 18]}/>;
  if (kind === 'capsule') return <capsuleGeometry args={[0.45, 0.7, 8, 16]}/>;
  if (kind === 'cylinder') return <cylinderGeometry args={[0.5, 0.5, 1, 24]}/>;
  if (kind === 'octahedron') return <octahedronGeometry args={[0.7, 0]}/>;
  if (kind === 'torus') return <torusGeometry args={[0.6, 0.16, 16, 48]}/>;
  return <boxGeometry args={[1, 1, 1]}/>;
}

type RuntimeObjects = React.MutableRefObject<Map<string, THREE.Group>>;

function EntityMesh({ entity, runtimeObjects, snap }: { entity: LillyEntity; runtimeObjects: RuntimeObjects; snap: boolean }) {
  const selected = useStudioStore((state) => state.selectedEntityId === entity.id);
  const transformMode = useStudioStore((state) => state.transformMode);
  const playState = useStudioStore((state) => state.playState);
  const selectEntity = useStudioStore((state) => state.selectEntity);
  const setComponent = useStudioStore((state) => state.setComponent);
  const group = useRef<THREE.Group>(null);
  const transform = component(entity, 'Transform');
  const mesh = component(entity, 'MeshRenderer');
  const light = component(entity, 'Light');
  const position = vector(transform?.data.position, { x: 0, y: 0, z: 0 });
  const rotation = vector(transform?.data.rotation, { x: 0, y: 0, z: 0 });
  const scale = vector(transform?.data.scale, { x: 1, y: 1, z: 1 });
  const isPickup = entity.tags.includes('pickup');
  const isEnemy = entity.tags.includes('enemy');
  const isGate = entity.tags.includes('encounter-gate');
  const isCheckpoint = entity.tags.includes('checkpoint');

  useEffect(() => {
    if (!group.current) return undefined;
    runtimeObjects.current.set(entity.id, group.current);
    return () => { runtimeObjects.current.delete(entity.id); };
  }, [entity.id, runtimeObjects]);

  useEffect(() => {
    if (playState !== 'editing' || !group.current) return;
    group.current.position.set(position.x, position.y, position.z);
    group.current.rotation.set(rotation.x, rotation.y, rotation.z);
    group.current.scale.set(scale.x, scale.y, scale.z);
    group.current.visible = entity.enabled;
    group.current.userData.phase = 'idle';
  }, [entity.enabled, playState, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, scale.x, scale.y, scale.z]);

  useFrame((state, delta) => {
    if (!group.current) return;
    if (isPickup) group.current.rotation.y += delta * 0.8;
    if (isEnemy && playState !== 'editing' && group.current.visible) {
      group.current.rotation.y += delta * (group.current.userData.phase === 'windup' ? 7 : 1.2);
      const pulse = group.current.userData.phase === 'windup' ? 1.12 + Math.sin(state.clock.elapsedTime * 18) * 0.07 : 1;
      group.current.scale.set(scale.x * pulse, scale.y * pulse, scale.z * pulse);
    }
    if (isGate && playState !== 'editing' && group.current.visible) {
      group.current.scale.y = scale.y * (1 + Math.sin(state.clock.elapsedTime * 7 + entity.id.length) * 0.025);
    }
    if (isCheckpoint && playState !== 'editing') {
      group.current.rotation.y += delta * (group.current.userData.checkpointActive ? 1.4 : 0.35);
    }
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

  const roleGlow = isPickup || isEnemy || isGate || isCheckpoint || entity.tags.includes('goal');
  const object = <group
    ref={group}
    position={[position.x, position.y, position.z]}
    rotation={[rotation.x, rotation.y, rotation.z]}
    scale={[scale.x, scale.y, scale.z]}
    visible={entity.enabled}
    onClick={(event) => { event.stopPropagation(); if (playState === 'editing') selectEntity(entity.id); }}
    userData={{ entityId: entity.id, phase: 'idle', checkpointActive: false }}
  >
    {mesh && <mesh castShadow={mesh.data.castShadow !== false} receiveShadow={mesh.data.receiveShadow !== false}>
      <Geometry kind={String(mesh.data.geometry || 'box')}/>
      <meshStandardMaterial
        color={String((mesh.data.material as Record<string, unknown>)?.color || '#8ea7c4')}
        roughness={Number((mesh.data.material as Record<string, unknown>)?.roughness ?? 0.65)}
        metalness={Number((mesh.data.material as Record<string, unknown>)?.metalness ?? 0.05)}
        emissive={selected ? '#0ea5e9' : String((mesh.data.material as Record<string, unknown>)?.emissive || (roleGlow ? (mesh.data.material as Record<string, unknown>)?.color || '#4c1d95' : '#000000'))}
        emissiveIntensity={selected ? 0.45 : Number((mesh.data.material as Record<string, unknown>)?.emissiveIntensity || (roleGlow ? 0.35 : 0))}
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

function PlayCameraRig({ runtimeObjects, playerId }: { runtimeObjects: RuntimeObjects; playerId: string }) {
  const playState = useStudioStore((state) => state.playState);
  const { camera } = useThree();
  useFrame((_state, delta) => {
    if (playState === 'editing') return;
    const playerObject = runtimeObjects.current.get(playerId);
    if (!playerObject) return;
    const target = new THREE.Vector3(playerObject.position.x + 6.5, playerObject.position.y + 6, playerObject.position.z + 8.5);
    camera.position.lerp(target, 1 - Math.pow(0.001, delta));
    camera.lookAt(playerObject.position.x, playerObject.position.y + 0.7, playerObject.position.z);
  });
  return null;
}

function GameplayBridge({ project, scene, world, runtimeObjects, touchKeys, touchAttack, onState }: {
  project: LillyProject;
  scene: LillyScene;
  world: CollisionWorld;
  runtimeObjects: RuntimeObjects;
  touchKeys: Set<string>;
  touchAttack: boolean;
  onState: (state: GameplayState) => void;
}) {
  const playState = useStudioStore((state) => state.playState);
  const stepToken = useStudioStore((state) => state.stepToken);
  const simulation = useMemo(() => new GameplaySimulation(project), [project.id, project.revision]);
  const latest = useRef(simulation.getState());
  const keys = useRef(new Set<string>());
  const attackHeld = useRef(false);
  const attackQueued = useRef(false);
  const accumulator = useRef(0);
  const lastStep = useRef(stepToken);
  const previousPlayState = useRef(playState);
  const updateCounter = useRef(0);
  const playerEntity = scene.entities.find((entity) => entity.tags.includes('player')) || null;
  const fixedStep = 1 / Math.max(1, Math.min(240, Number(project.settings.fixedStepHz || 60)));

  const syncObjects = (state: GameplayState) => {
    latest.current = state;
    state.enemies.forEach((enemy) => {
      const object = runtimeObjects.current.get(enemy.id);
      if (!object) return;
      object.visible = enemy.health > 0;
      object.position.set(enemy.position.x, enemy.position.y, enemy.position.z);
      object.userData.phase = enemy.phase;
    });
    Object.entries(state.gates).forEach(([id, closed]) => {
      const object = runtimeObjects.current.get(id);
      if (object) object.visible = closed;
    });
    state.encounters.forEach((encounter) => {
      const checkpoint = runtimeObjects.current.get(encounter.checkpointId);
      if (checkpoint) checkpoint.userData.checkpointActive = state.checkpoint.id === encounter.checkpointId;
    });
  };

  useEffect(() => {
    const down = (event: KeyboardEvent) => keys.current.add(event.code);
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    const release = () => {
      keys.current.clear();
      attackHeld.current = false;
      attackQueued.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
    };
  }, []);

  useEffect(() => {
    const enteringPlay = previousPlayState.current === 'editing' && playState !== 'editing';
    if (playState === 'editing' || enteringPlay) {
      const resetState = simulation.reset();
      syncObjects(resetState);
      onState(resetState);
      attackHeld.current = false;
      attackQueued.current = false;
    }
    accumulator.current = 0;
    previousPlayState.current = playState;
  }, [playState, simulation]);

  useFrame((_frameState, frameDelta) => {
    if (!playerEntity || playState === 'editing') return;
    const shouldStep = playState === 'playing' || stepToken !== lastStep.current;
    if (!shouldStep) return;
    if (playState === 'paused') lastStep.current = stepToken;
    const playerObject = runtimeObjects.current.get(playerEntity.id);
    if (!playerObject) return;
    const binding = project.inputMap.find((entry) => entry.action === 'Move');
    const [forward = 'KeyW', backward = 'KeyS', left = 'KeyA', right = 'KeyD'] = binding?.keys || [];
    const pressed = (code: string) => keys.current.has(code) || touchKeys.has(code);
    const direction = new THREE.Vector3(Number(pressed(right)) - Number(pressed(left)), 0, Number(pressed(backward)) - Number(pressed(forward)));
    if (direction.lengthSq() > 0) direction.normalize();
    const attackKeys = project.inputMap.find((entry) => entry.action === 'Attack')?.keys || ['Space', 'Enter'];
    const attacking = touchAttack || attackKeys.some((code) => keys.current.has(code));
    if (attacking && !attackHeld.current) attackQueued.current = true;
    attackHeld.current = attacking;
    const schedule = playState === 'playing'
      ? scheduleGameplaySteps(accumulator.current, frameDelta, fixedStep)
      : { accumulatorSeconds: 0, steps: 1, droppedTime: false };
    accumulator.current = schedule.accumulatorSeconds;
    let state = latest.current;
    for (let stepIndex = 0; stepIndex < schedule.steps; stepIndex += 1) {
      if (direction.lengthSq() > 0) {
        const distance = fixedStep * 6;
        const nextX = playerObject.position.x + direction.x * distance;
        if (canStand(world, nextX, playerObject.position.z, state.gates)) playerObject.position.x = nextX;
        const nextZ = playerObject.position.z + direction.z * distance;
        if (canStand(world, playerObject.position.x, nextZ, state.gates)) playerObject.position.z = nextZ;
        playerObject.rotation.y = Math.atan2(direction.x, direction.z);
      }
      state = simulation.step(fixedStep, {
        playerPosition: { x: playerObject.position.x, y: playerObject.position.y, z: playerObject.position.z },
        attackPressed: attackQueued.current,
        canOccupy: (position, enemyId) => canStand(world, position.x, position.z, state.gates, 0.4, enemyId),
      });
      attackQueued.current = false;
      latest.current = state;
      simulation.drainEvents().forEach((event) => {
        if (event.type === 'player-respawned') playerObject.position.set(event.position.x, event.position.y, event.position.z);
        if (event.type === 'player-attacked') playerObject.userData.attackPulse = 0.14;
      });
    }
    if (!schedule.steps) return;
    syncObjects(state);
    updateCounter.current += schedule.steps;
    if (updateCounter.current % 5 < schedule.steps || playState === 'paused') onState(state);
  });
  return null;
}

function EditorScene({ project, scene, snap, lighting, touchKeys, touchAttack, onGameplayState }: {
  project: LillyProject;
  scene: LillyScene;
  snap: boolean;
  lighting: string;
  touchKeys: Set<string>;
  touchAttack: boolean;
  onGameplayState: (state: GameplayState) => void;
}) {
  const playState = useStudioStore((state) => state.playState);
  const selectEntity = useStudioStore((state) => state.selectEntity);
  const playerEntity = scene.entities.find((entity) => entity.tags.includes('player'));
  const runtimeObjects = useRef(new Map<string, THREE.Group>());
  const world = useMemo(() => collisionWorld(scene), [scene]);
  const cameraDistance = Math.max(14, Math.min(58, world.span * 0.9));
  return <>
    <color attach="background" args={[lighting === 'unlit' ? '#0d1117' : scene.environment.background || '#081018']}/>
    {lighting === 'studio' && <><hemisphereLight args={['#d8ecff', '#111923', 1.3]}/><directionalLight position={[8, 12, 6]} intensity={2.2} castShadow/></>}
    {lighting === 'unlit' && <ambientLight intensity={2}/>}
    {lighting === 'scene' && <hemisphereLight args={['#d8ecff', '#17202b', Number(scene.environment.ambientIntensity || 0.5)]}/>}
    <PerspectiveCamera makeDefault position={[world.center.x + cameraDistance * 0.72, cameraDistance * 0.58, world.center.z + cameraDistance]} fov={52}/>
    {scene.entities.map((entity) => <EntityMesh key={entity.id} entity={entity} runtimeObjects={runtimeObjects} snap={snap}/>) }
    <GameplayBridge project={project} scene={scene} world={world} runtimeObjects={runtimeObjects} touchKeys={touchKeys} touchAttack={touchAttack} onState={onGameplayState}/>
    <Grid position={[world.center.x, 0.01, world.center.z]} args={[Math.max(40, world.span * 1.5), Math.max(40, world.span * 1.5)]} cellSize={0.5} cellThickness={0.5} cellColor="#23394a" sectionSize={5} sectionThickness={1} sectionColor="#3b6078" fadeDistance={Math.max(55, world.span * 1.3)} fadeStrength={1.5}/>
    <OrbitControls makeDefault enabled={playState === 'editing'} target={[world.center.x, 0.8, world.center.z]} minDistance={2} maxDistance={Math.max(70, world.span * 2)} maxPolarAngle={Math.PI * 0.49}/>
    {playerEntity && <PlayCameraRig runtimeObjects={runtimeObjects} playerId={playerEntity.id}/>}
    {playState === 'editing' && <GizmoHelper alignment="bottom-right" margin={[68, 58]}><GizmoViewport axisColors={['#f87171', '#6ee7b7', '#60a5fa']} labelColor="#dce8f2"/></GizmoHelper>}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[world.center.x, -0.02, world.center.z]} onClick={() => selectEntity(null)}><planeGeometry args={[Math.max(200, world.span * 2), Math.max(200, world.span * 2)]}/><meshBasicMaterial transparent opacity={0}/></mesh>
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

function ExactPlayPreview({ previewUrl, projectId, playState, stepToken }: { previewUrl: string; projectId: string; playState: 'playing' | 'paused'; stepToken: number }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastStep = useRef(stepToken);
  const previewAccess = useWorkspacePreviewAccess(previewUrl);
  const send = (type: 'play' | 'pause' | 'step') => frameRef.current?.contentWindow?.postMessage({
    schema: 'LillyEditorPlayerControl/v1',
    type,
    projectId,
  }, '*');
  const sendPlayState = () => send(playState === 'playing' ? 'play' : 'pause');
  useEffect(() => { sendPlayState(); }, [playState, previewAccess.url]);
  useEffect(() => {
    if (stepToken === lastStep.current) return;
    lastStep.current = stepToken;
    send('step');
  }, [stepToken, previewAccess.url]);
  if (previewAccess.status !== 'ready') return <div className="exact-play-preview preview-access-state" role="status">
    {previewAccess.status === 'error' ? <><strong>Player access blocked</strong><span>{previewAccess.error}</span></> : <><span className="spinner-small"/><span>Signing the isolated player…</span></>}
  </div>;
  return <div className="exact-play-preview">
    <iframe
      ref={frameRef}
      src={previewAccess.url}
      title="Exact sandboxed editor Play preview"
      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
      onLoad={() => {
        sendPlayState();
        frameRef.current?.contentWindow?.focus();
      }}
    />
  </div>;
}

export function Viewport() {
  const current = useStudioStore((state) => state.current);
  const playState = useStudioStore((state) => state.playState);
  const stepToken = useStudioStore((state) => state.stepToken);
  const editorPreview = useStudioStore((state) => state.editorPreview);
  const previewStatus = useStudioStore((state) => state.previewStatus);
  const [snap, setSnap] = useState(true);
  const [lighting, setLighting] = useState('scene');
  const [rendererReady, setRendererReady] = useState(false);
  const [touchKeys, setTouchKeys] = useState<Set<string>>(() => new Set());
  const [touchAttack, setTouchAttack] = useState(false);
  const [gameplayState, setGameplayState] = useState<GameplayState | null>(null);
  const scene = useMemo(() => currentScene(current), [current]);
  const design = current?.project.generatedLevels?.find((level) => level.sceneId === current.project.entryScene) || null;
  const recipe = design ? current?.project.levelRecipes?.find((levelRecipe) => levelRecipe.id === design.recipeId) || null : null;
  const setTouchCode = (code: string, pressed: boolean) => setTouchKeys((currentKeys) => {
    const next = new Set(currentKeys);
    if (pressed) next.add(code); else next.delete(code);
    return next;
  });
  useEffect(() => {
    if (playState !== 'playing') {
      setTouchKeys(new Set());
      setTouchAttack(false);
    }
  }, [playState]);
  useEffect(() => {
    const releaseTouchInput = () => {
      setTouchKeys(new Set());
      setTouchAttack(false);
    };
    window.addEventListener('blur', releaseTouchInput);
    return () => window.removeEventListener('blur', releaseTouchInput);
  }, []);
  if (!scene || !current) return <main className="viewport-panel"><div className="viewport-empty"><Icon name="cube" size={34}/><strong>No entry scene</strong><span>Create or select a scene to start authoring.</span></div></main>;
  const cleared = gameplayState?.encounters.filter((entry) => entry.cleared).length || 0;
  const encounters = gameplayState?.encounters.length || design?.metrics.encounterCount || 0;
  const enemies = gameplayState?.enemies.filter((entry) => entry.health > 0).length ?? design?.metrics.enemyCount ?? 0;
  const objectiveText = recipe?.objective === 'reach-exit'
    ? 'Reach the exit beacon'
    : recipe?.objective === 'secure-and-exit'
      ? `${cleared}/${encounters} encounters secured · ${enemies} guardians remain`
      : `Collect ${design?.metrics.pickupCount || 0} cores, then reach the exit`;
  return <main className={`viewport-panel mode-${playState}`}>
    <div className="viewport-toolbar">
      <div className="viewport-mode"><button type="button" className={playState === 'editing' ? 'active' : ''}>Perspective</button><button type="button" className={playState !== 'editing' ? 'active' : ''}>Game</button></div>
      <div className="viewport-tools"><label>Lighting<select value={lighting} onChange={(event) => setLighting(event.target.value)}><option value="scene">Scene</option><option value="studio">Studio</option><option value="unlit">Unlit</option></select></label><button type="button" className={snap ? 'active' : ''} onClick={() => setSnap((value) => !value)}>Snap <kbd>0.5</kbd></button></div>
    </div>
    {playState === 'editing' ? <>
      {!rendererReady && <div className="viewport-loading"><span className="spinner-small"/><span>Starting WebGL2 renderer…</span></div>}
      <ViewportErrorBoundary>
        <Canvas shadows dpr={[1, 2]} gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }} onCreated={({ gl }) => { gl.outputColorSpace = THREE.SRGBColorSpace; gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.04; setRendererReady(true); }}>
          <Suspense fallback={null}><EditorScene project={current.project} scene={scene} snap={snap} lighting={lighting} touchKeys={touchKeys} touchAttack={touchAttack} onGameplayState={setGameplayState}/></Suspense>
        </Canvas>
      </ViewportErrorBoundary>
    </> : previewStatus === 'ready' && editorPreview ? <ExactPlayPreview previewUrl={editorPreview.previewUrl} projectId={current.project.id} playState={playState} stepToken={stepToken}/> : <div className={`viewport-loading preview-${previewStatus}`}><span className="spinner-small"/><span>{previewStatus === 'error' ? 'Exact Play preview blocked — open Console for diagnostics' : 'Compiling modules and preparing exact Play preview…'}</span></div>}
    {playState !== 'editing' && <div className="play-hud"><div><span>Exact Play · sandboxed modules</span><strong>{previewStatus === 'preparing' ? 'Compiling project and mechanic specs' : playState === 'playing' ? 'Simulation running' : 'Paused — step to advance'}</strong></div><div className="play-objective"><small>{recipe?.name || 'Project objective'}</small><span>{objectiveText}</span></div></div>}
    {false && playState === 'playing' && <>
      <div className="editor-touch-controls" aria-label="Touch movement controls">
        {[
          ['KeyW', '↑', 'up'],
          ['KeyA', '←', 'left'],
          ['KeyS', '↓', 'down'],
          ['KeyD', '→', 'right'],
        ].map(([code, label, direction]) => <button
          key={code}
          type="button"
          className={`touch-${direction}`}
          data-pressed={touchKeys.has(code)}
          aria-label={`Move ${direction}`}
          onPointerDown={(event) => {
            event.preventDefault();
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_error) { /* Pointer capture is optional. */ }
            setTouchCode(code, true);
          }}
          onPointerUp={() => setTouchCode(code, false)}
          onPointerCancel={() => setTouchCode(code, false)}
          onLostPointerCapture={() => setTouchCode(code, false)}
        >{label}</button>)}
      </div>
      <button
        className="editor-touch-action"
        type="button"
        data-pressed={touchAttack}
        aria-label="Attack"
        onPointerDown={(event) => {
          event.preventDefault();
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_error) { /* Pointer capture is optional. */ }
          setTouchAttack(true);
        }}
        onPointerUp={() => setTouchAttack(false)}
        onPointerCancel={() => setTouchAttack(false)}
        onLostPointerCapture={() => setTouchAttack(false)}
      >Strike</button>
    </>}
    <div className="viewport-status"><span><i className="axis x"/>X</span><span><i className="axis y"/>Y</span><span><i className="axis z"/>Z</span><span className="viewport-stat">{playState === 'editing' ? 'WebGL2 · Lilly scene renderer' : 'Exact player · opaque module sandbox · fixed step'}</span></div>
  </main>;
}
