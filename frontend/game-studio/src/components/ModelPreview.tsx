import { Component, Suspense, useMemo, type ReactNode } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { Bounds, OrbitControls } from '@react-three/drei';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">3D preview could not load. Retry generation before applying.</p> : this.props.children; }
}
function Model({ url }: { url: string }) {
  const gltf = useLoader(GLTFLoader, url);
  const model = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  return <Bounds fit clip observe margin={1.3}><primitive object={model}/></Bounds>;
}
export function ModelPreview({ url }: { url: string }) {
  return <div className="model-preview" aria-label="Interactive 3D model preview. Drag to rotate, scroll to zoom.">
    <PreviewBoundary key={url}><Canvas camera={{ position: [4, 3, 5], fov: 40 }} dpr={[1, 1.5]}>
      <color attach="background" args={['#121c2a']}/><ambientLight intensity={1.8}/>
      <directionalLight position={[4, 8, 5]} intensity={3}/><directionalLight position={[-4, 2, -3]} intensity={1.2}/>
      <Suspense fallback={null}><Model url={url}/></Suspense><OrbitControls makeDefault/>
    </Canvas></PreviewBoundary>
  </div>;
}
