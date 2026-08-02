import RAPIER from '@dimforge/rapier3d-compat';
import type { LillyEntity, LillyScene, Vec3 } from '../../core/src';

function component(entity: LillyEntity, type: string) {
  return entity.components.find((entry) => entry.type === type) || null;
}

function vector(value: unknown, fallback: Vec3): Vec3 {
  if (!value || typeof value !== 'object') return fallback;
  const input = value as Partial<Vec3>;
  return { x: Number(input.x ?? fallback.x), y: Number(input.y ?? fallback.y), z: Number(input.z ?? fallback.z) };
}

export interface PhysicsEvent {
  type: 'collision-start' | 'collision-end' | 'trigger-start' | 'trigger-end';
  entityA: string;
  entityB: string;
}

export class RapierPhysicsAdapter {
  readonly world: RAPIER.World;
  private bodies = new Map<string, RAPIER.RigidBody>();
  private colliderEntities = new Map<number, string>();
  private colliderSensors = new Map<number, boolean>();
  private eventQueue = new RAPIER.EventQueue(true);

  private constructor(gravity: Vec3) {
    this.world = new RAPIER.World(gravity);
  }

  static async create(gravity: Vec3 = { x: 0, y: -9.81, z: 0 }) {
    await RAPIER.init();
    return new RapierPhysicsAdapter(gravity);
  }

  loadScene(scene: LillyScene) {
    this.bodies.clear();
    this.colliderEntities.clear();
    this.colliderSensors.clear();
    scene.entities.forEach((entity) => this.addEntity(entity));
  }

  addEntity(entity: LillyEntity) {
    const transform = component(entity, 'Transform')?.data || {};
    const position = vector(transform.position, { x: 0, y: 0, z: 0 });
    const rigidBodyComponent = component(entity, 'RigidBody');
    const rigidBody = rigidBodyComponent?.data || { bodyType: 'fixed' };
    const collider = component(entity, 'Collider')?.data || null;
    if (!collider && !rigidBody) return null;
    let descriptor: RAPIER.RigidBodyDesc;
    switch (rigidBody.bodyType) {
      case 'kinematic-position': descriptor = RAPIER.RigidBodyDesc.kinematicPositionBased(); break;
      case 'kinematic-velocity': descriptor = RAPIER.RigidBodyDesc.kinematicVelocityBased(); break;
      case 'fixed': descriptor = RAPIER.RigidBodyDesc.fixed(); break;
      default: descriptor = RAPIER.RigidBodyDesc.dynamic(); break;
    }
    descriptor.setTranslation(position.x, position.y, position.z);
    descriptor.setLinearDamping(Number(rigidBody.linearDamping || 0));
    descriptor.setAngularDamping(Number(rigidBody.angularDamping || 0));
    if (rigidBody.lockRotations === true) descriptor.lockRotations();
    const body = this.world.createRigidBody(descriptor);
    this.bodies.set(entity.id, body);
    if (collider) {
      const size = vector(collider.size, { x: 1, y: 1, z: 1 });
      let colliderDescriptor: RAPIER.ColliderDesc;
      switch (collider.shape) {
        case 'sphere': colliderDescriptor = RAPIER.ColliderDesc.ball(size.x / 2); break;
        case 'capsule': colliderDescriptor = RAPIER.ColliderDesc.capsule(Math.max(0.01, size.y / 2 - size.x / 2), size.x / 2); break;
        case 'cylinder': colliderDescriptor = RAPIER.ColliderDesc.cylinder(size.y / 2, size.x / 2); break;
        default: colliderDescriptor = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2); break;
      }
      colliderDescriptor.setSensor(collider.sensor === true);
      colliderDescriptor.setFriction(Number(collider.friction ?? 0.7));
      colliderDescriptor.setRestitution(Number(collider.restitution ?? 0.1));
      colliderDescriptor.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const createdCollider = this.world.createCollider(colliderDescriptor, body);
      this.colliderEntities.set(createdCollider.handle, entity.id);
      this.colliderSensors.set(createdCollider.handle, collider.sensor === true);
    }
    return body;
  }

  step(fixedDeltaSeconds: number): PhysicsEvent[] {
    this.world.timestep = fixedDeltaSeconds;
    this.world.step(this.eventQueue);
    const events: PhysicsEvent[] = [];
    this.eventQueue.drainCollisionEvents((handleA, handleB, started) => {
      const entityA = this.colliderEntities.get(handleA);
      const entityB = this.colliderEntities.get(handleB);
      if (entityA && entityB) {
        const trigger = this.colliderSensors.get(handleA) === true || this.colliderSensors.get(handleB) === true;
        events.push({ type: trigger ? (started ? 'trigger-start' : 'trigger-end') : (started ? 'collision-start' : 'collision-end'), entityA, entityB });
      }
    });
    return events;
  }

  getTransform(entityId: string) {
    const body = this.bodies.get(entityId);
    if (!body) return null;
    const translation = body.translation();
    const rotation = body.rotation();
    return { position: { x: translation.x, y: translation.y, z: translation.z }, rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w } };
  }

  applyForce(entityId: string, force: Vec3) { this.bodies.get(entityId)?.addForce(force, true); }
  applyImpulse(entityId: string, impulse: Vec3) { this.bodies.get(entityId)?.applyImpulse(impulse, true); }

  raycast(origin: Vec3, direction: Vec3, maxDistance = 100) {
    const hit = this.world.castRay(new RAPIER.Ray(origin, direction), maxDistance, true);
    if (!hit) return null;
    return { entityId: this.colliderEntities.get(hit.collider.handle) || null, timeOfImpact: hit.timeOfImpact };
  }

  dispose() { this.world.free(); this.bodies.clear(); this.colliderEntities.clear(); this.colliderSensors.clear(); }
}
