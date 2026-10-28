import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { applyMeshLens, meshNativeFocalLength, projectedBounds, projectedExtent, aimCamera } from '../web/editor/scene.mjs';

const clip = { near: 0.1, far: 500 };
const target = new THREE.Vector3(1, 10, -2);
function shot(focal, minDistance = 0) {
  const camera = new THREE.PerspectiveCamera(30, 1.25, clip.near, clip.far);
  camera.position.copy(target).add(new THREE.Vector3(20, 10, 39).setLength(45));
  camera.lookAt(target);
  camera.frame = applyMeshLens(camera, target, focal, minDistance, clip);
  camera.updateMatrixWorld(true);
  return camera;
}

test('GLB focal length is a dolly zoom: framing at the target is kept while perspective changes', () => {
  const base = shot(undefined), same = shot(meshNativeFocalLength), tele = shot(meshNativeFocalLength * 4), wide = shot(meshNativeFocalLength / 2);
  assert.equal(base.fov, 30);
  assert.ok(Math.abs(same.fov - 30) < 1e-9);
  assert.ok(Math.abs(base.position.distanceTo(target) - 45) < 1e-9);
  assert.ok(Math.abs(tele.position.distanceTo(target) - 180) < 1e-9);
  assert.ok(Math.abs(wide.position.distanceTo(target) - 22.5) < 1e-9);
  assert.ok(wide.fov > base.fov && base.fov > tele.fov);

  // A point in the target plane lands on the same pixel with every lens...
  const right = new THREE.Vector3().setFromMatrixColumn(base.matrixWorld, 0);
  const inPlane = target.clone().addScaledVector(right, 6);
  const a = inPlane.clone().project(base).x;
  for (const camera of [tele, wide]) assert.ok(Math.abs(inPlane.clone().project(camera).x - a) < 1e-6);
  // ...while a point nearer the camera grows with the short lens and shrinks with the long one.
  const forward = base.position.clone().sub(target).normalize();
  const near = inPlane.clone().addScaledVector(forward, 5);
  assert.ok(near.clone().project(wide).x > near.clone().project(base).x);
  assert.ok(near.clone().project(tele).x < near.clone().project(base).x);
  assert.ok(tele.far > 180 + 45 && wide.near < clip.near);
});

test('a short GLB lens stops outside the asset instead of entering it', () => {
  const wide = shot(8, 17);
  assert.ok(Math.abs(wide.position.distanceTo(target) - 17) < 1e-9);
  assert.ok(wide.fov > 110);
  // The frame at the target grows by the same factor as the visible height there.
  const visible = 2 * 17 * Math.tan(THREE.MathUtils.degToRad(wide.fov) / 2);
  assert.ok(Math.abs(wide.frame - visible / (2 * 45 * Math.tan(THREE.MathUtils.degToRad(15)))) < 1e-9);
  assert.ok(Math.abs(shot(200, 17).frame - 1) < 1e-9 && Math.abs(shot(30).frame - 1) < 1e-9);
  // A long lens and an asset larger than the native distance are never pulled closer.
  assert.ok(Math.abs(shot(200, 17).position.distanceTo(target) - 45 * 200 / meshNativeFocalLength) < 1e-9);
  assert.ok(Math.abs(shot(20, 60).position.distanceTo(target) - 45) < 1e-9);
  assert.throws(() => shot(0), /Focal length/);
});

test('fit to frame measures the asset itself, for every lens', () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(8, 48, 32));
  mesh.position.copy(target); root.add(mesh);
  for (const focal of [undefined, 12, 35, 200]) {
    const camera = shot(focal, 8 * 1.05);
    const extent = projectedExtent(root, camera);
    assert.ok(extent > 0.05 && Number.isFinite(extent));
    camera.zoom = 0.96 / extent; camera.updateProjectionMatrix();
    // After the fit the silhouette just stays inside the frame.
    const fitted = projectedExtent(root, camera);
    assert.ok(Math.abs(fitted - 0.96) < 1e-6, `${focal}: ${fitted}`);
  }
  // Sampling a dense asset still finds its outline closely.
  const camera = shot(35, 8 * 1.05);
  assert.ok(Math.abs(projectedExtent(root, camera, 200) / projectedExtent(root, camera) - 1) < 0.1);
});

test('tilt turns the camera on the spot and reports where it now aims', () => {
  const camera = shot(35);
  const position = camera.position.clone(), distance = position.distanceTo(target);
  assert.ok(aimCamera(camera, target, 0).equals(target));
  const aim = aimCamera(camera, target, 20);
  camera.updateMatrixWorld(true);
  assert.ok(camera.position.equals(position));
  assert.ok(Math.abs(aim.distanceTo(position) - distance) < 1e-9);
  // Looking up puts the aim point above the target and the target below the frame center.
  assert.ok(aim.y > target.y);
  assert.ok(Math.abs(aim.clone().project(camera).y) < 1e-9);
  const seen = target.clone().project(camera);
  assert.ok(seen.y < 0 && Math.abs(seen.x) < 1e-9);
  const angle = aim.clone().sub(position).angleTo(target.clone().sub(position));
  assert.ok(Math.abs(THREE.MathUtils.radToDeg(angle) - 20) < 1e-6);
  assert.ok(aimCamera(camera, target, -20).y < target.y);
});

test('the outline of an off-center asset gives its bounds and aspect', () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 12, 0.01));
  mesh.position.copy(target).add(new THREE.Vector3(0, 3, 0)); root.add(mesh);
  const camera = new THREE.PerspectiveCamera(30, 1.25, 0.1, 500);
  camera.position.copy(target).add(new THREE.Vector3(0, 0, 45));
  camera.lookAt(target); camera.updateMatrixWorld(true);
  const box = projectedBounds(root, camera);
  assert.ok(Math.abs(box.minX + box.maxX) < 1e-9 && box.minY + box.maxY > 0.1);
  assert.ok(Math.abs((box.maxX - box.minX) * camera.aspect / (box.maxY - box.minY) - 4 / 12) < 1e-3);
  assert.equal(projectedExtent(root, camera), Math.max(-box.minX, box.maxX, -box.minY, box.maxY));
  camera.position.set(0, 10, -500); camera.lookAt(0, 10, -900); camera.updateMatrixWorld(true);
  assert.equal(projectedBounds(root, camera), null);
});

test('roll turns the camera clockwise around its viewing axis without moving its aim', () => {
  const camera = shot(35);
  const position = camera.position.clone();
  const aim = aimCamera(camera, target, 10, 30);
  camera.updateMatrixWorld(true);
  assert.ok(camera.position.equals(position));
  assert.ok(Math.hypot(aim.clone().project(camera).x, aim.clone().project(camera).y) < 1e-9);
  // A point straight above the aim appears turned 30 degrees counter-clockwise in the picture.
  const level = shot(35); aimCamera(level, target, 10, 0); level.updateMatrixWorld(true);
  const above = aim.clone().addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(level.quaternion), 3);
  const seen = above.clone().project(camera);
  const turned = THREE.MathUtils.radToDeg(Math.atan2(-seen.x * camera.aspect, seen.y));
  assert.ok(Math.abs(turned - 30) < 1e-6, String(turned));
  // The roll is undone again, and the picture is level, once it is set back to zero.
  aimCamera(camera, target, 10, 0); camera.updateMatrixWorld(true);
  assert.ok(Math.abs(above.clone().project(camera).x) < 1e-9);
});
