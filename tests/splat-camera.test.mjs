import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { SplatScene, decodeCameraToken, configureSplatCamera, nativeFocalLength } from '../web/editor/splat.mjs';

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const vectorClose = (actual, expected) => actual.toArray().forEach((value, i) => close(value, expected[i]));
const controls = { azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
const source = {
  camera_token: [0.8, -0.6, 0.2, 0.5, 0.8],
  bounds: [[-0.5, 0, -0.5], [0.5, 1, 0.5]],
  reference: { width: 1000, height: 800 },
  crop: [100, 30, 740, 670],
};

test('5D decoding retains inverse-distance units and converts Z-up to Y-up', () => {
  const decoded = decodeCameraToken([2, -2, 1, 0.5, 0.8]);
  vectorClose(decoded.direction, [2 / 3, 1 / 3, 2 / 3]);
  close(decoded.radius, 2);
  close(decoded.fov, THREE.MathUtils.radToDeg(2 * Math.atan(0.4)));
  assert.equal(decoded.orthographic, false);
});

test('native export plus Rx(pi) equals raw [x,z,-y], including reference projection', () => {
  const rawCamera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(0.4)), 1, 0.01, 100);
  rawCamera.position.set(...source.camera_token.slice(0, 3)).normalize().multiplyScalar(2);
  rawCamera.up.set(0, 0, 1);
  rawCamera.lookAt(0, 0, 0);
  rawCamera.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera();
  configureSplatCamera(camera, source, controls, 1000, 800);
  for (const xyz of [[0, 0, 0], [0.1, -0.1, 0.2], [-0.2, 0.3, 0.1]]) {
    const raw = new THREE.Vector3(...xyz);
    const prepared = raw.clone().project(rawCamera);
    const native = new THREE.Vector3(raw.x, -raw.z, raw.y);
    native.applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    vectorClose(native, [raw.x, raw.z, -raw.y]);
    const projected = native.multiplyScalar(20).project(camera);
    const xOriginal = 100 + (prepared.x + 1) * 320;
    const yOriginal = 30 + (1 - prepared.y) * 320;
    close(projected.x, 2 * xOriginal / 1000 - 1);
    close(projected.y, 1 - 2 * yOriginal / 800);
  }
});

test('normalization, root rotation and scale move geometry and camera together', () => {
  const shifted = { ...source, bounds: [[-0.2, -0.4, -0.3], [0.8, 0.6, 0.7]] };
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(3, -2, 7),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(1.7, 1.7, 1.7));
  const base = new THREE.PerspectiveCamera(), moved = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(base, shifted, controls, 1000, 800);
  vectorClose(target, [-6, 8, -4]);
  const movedTarget = configureSplatCamera(moved, shifted, controls, 1000, 800, matrix);
  vectorClose(movedTarget, target.clone().applyMatrix4(matrix).toArray());
  const point = new THREE.Vector3(1, 10, 2);
  const a = point.clone().project(base), b = point.clone().applyMatrix4(matrix).project(moved);
  close(a.x, b.x); close(a.y, b.y);
});

test('nonmatching output aspect contains the original frame without stretching it', () => {
  const wide = new THREE.PerspectiveCamera(), portrait = new THREE.PerspectiveCamera();
  configureSplatCamera(wide, source, controls, 1000, 800);
  configureSplatCamera(portrait, source, controls, 800, 1000);
  for (const point of [new THREE.Vector3(), new THREE.Vector3(2, 3, 1)]) {
    const a = point.clone().project(wide), b = point.clone().project(portrait);
    close(b.x, a.x);
    close(b.y, a.y * 0.64);
  }
});

test('zoom remains centered on the subject crop, and pan moves in image axes', () => {
  const base = new THREE.PerspectiveCamera(), zoomed = new THREE.PerspectiveCamera();
  configureSplatCamera(base, source, controls, 1000, 800);
  configureSplatCamera(zoomed, source, { ...controls, zoom: 2 }, 1000, 800);
  const center = new THREE.Vector3().project(base);
  const point = new THREE.Vector3(2, 3, 1);
  const a = point.clone().project(base), b = point.clone().project(zoomed);
  close(b.x - center.x, (a.x - center.x) * 2);
  close(b.y - center.y, (a.y - center.y) * 2);
  const panned = new THREE.PerspectiveCamera();
  configureSplatCamera(panned, source, { ...controls, offsetX: 1, offsetY: 1 }, 1000, 800);
  const after = new THREE.Vector3().project(panned);
  assert.ok(after.x > center.x && after.y > center.y);
});

test('azimuth and elevation are relative to the predicted camera', () => {
  const camera = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(camera, source, { ...controls, azimuth: 45, elevation: 10 }, 1000, 800);
  const direction = camera.position.clone().sub(target).normalize();
  const initial = decodeCameraToken(source.camera_token).direction;
  close(Math.atan2(direction.x, direction.z) - Math.atan2(initial.x, initial.z), Math.PI / 4);
  close(Math.asin(direction.y) - Math.asin(initial.y), Math.PI / 18);
});

test('orthographic token uses the official distant perspective approximation without clipping', () => {
  const ortho = { ...source, camera_token: [0, -1, 0, 0, 0.7] };
  const camera = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(camera, ortho, controls, 1000, 800);
  close(camera.position.distanceTo(target), 20000);
  close(camera.fov, THREE.MathUtils.radToDeg(2 * Math.atan(0.7 / 1000)));
  for (const point of [new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10)]) {
    const depth = point.project(camera).z;
    assert.ok(depth > -1 && depth < 1);
  }
});

test('invalid camera and crop metadata fail instead of claiming calibration', () => {
  for (const token of [[0, 0, 0, 1, 1], [1, 0, 0, 1, -1], [NaN, 0, 0, 1, 1], [1, 2]]) {
    assert.throws(() => decodeCameraToken(token));
  }
  assert.throws(() => configureSplatCamera(new THREE.PerspectiveCamera(), { ...source, crop: [1, 2, 1, 4] }, controls, 100, 100));
});

test('capture waits for old and newly dispatched sort completion, including partial queues', async () => {
  const scene = new SplatScene({});
  const events = [];
  let releaseOld;
  const viewer = {
    splatRenderReady: true, splatRenderCount: 100, lastSplatSortCount: 0,
    sortPromise: new Promise(resolve => { releaseOld = resolve; }),
    updateForDropInMode() { events.push('bind'); },
    async runSplatSort(force, all) {
      assert.equal(force, true); assert.equal(all, true);
      events.push('dispatch');
      this.sortPromise = new Promise(resolve => setImmediate(() => {
        this.lastSplatSortCount += 50; events.push('done'); resolve();
      }));
    },
    updateSplatMesh() { events.push('uniforms'); },
  };
  scene.dropIn = { viewer };
  const preparing = scene.prepareCapture({}, new THREE.PerspectiveCamera());
  await Promise.resolve();
  assert.deepEqual(events, []);
  releaseOld();
  await preparing;
  assert.deepEqual(events, ['bind', 'dispatch', 'done', 'dispatch', 'done', 'uniforms']);
});

test('bounds and original-origin target follow the scene root transform', () => {
  const scene = new SplatScene({});
  scene._bounds.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10));
  scene._target.set(2, 6, 0);
  scene.root.position.set(5, 0, 0); scene.root.scale.setScalar(2);
  vectorClose(scene.bounds.min, [-15, 0, -20]);
  vectorClose(scene.target, [9, 12, 0]);
});

test('focal length is a dolly zoom: framing at the target is kept while perspective changes', () => {
  const native = nativeFocalLength(source);
  close(native, 12 / 0.4);
  const base = new THREE.PerspectiveCamera(), same = new THREE.PerspectiveCamera(), tele = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(base, source, controls, 1000, 800);
  configureSplatCamera(same, source, { ...controls, focal: native }, 1000, 800);
  vectorClose(same.position, base.position.toArray()); close(same.fov, base.fov);
  configureSplatCamera(tele, source, { ...controls, focal: native * 4 }, 1000, 800);
  close(tele.position.distanceTo(target), base.position.distanceTo(target) * 4, 1e-6);
  assert.ok(tele.fov < base.fov);
  // Points in the plane through the target keep their place in the frame...
  const right = new THREE.Vector3().setFromMatrixColumn(base.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(base.matrixWorld, 1);
  const inPlane = target.clone().addScaledVector(right, 3).addScaledVector(up, -2);
  const a = inPlane.clone().project(base), b = inPlane.clone().project(tele);
  close(a.x, b.x, 1e-6); close(a.y, b.y, 1e-6);
  // ...while a point nearer the camera shifts less with the longer lens.
  const forward = base.position.clone().sub(target).normalize();
  const near = inPlane.clone().addScaledVector(forward, 5);
  assert.ok(Math.abs(near.clone().project(tele).x - b.x) < Math.abs(near.clone().project(base).x - a.x));
  assert.throws(() => configureSplatCamera(tele, source, { ...controls, focal: 0 }, 1000, 800), /Focal length/);
});

test('the subject outline ignores stray gaussians and points behind the camera', async () => {
  const { trimmedBounds } = await import('../web/editor/splat.mjs');
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const points = [];
  for (let i = 0; i < 1000; i++) points.push(-1 + 2 * i / 999, -2 + 4 * i / 999, 0);
  const clean = trimmedBounds(points, matrix);
  // Two far-out floaters and a point behind the camera must not move the outline.
  const noisy = trimmedBounds([...points, 40, 40, 0, -40, -40, 0, 0, 0, 50], matrix);
  for (const key of ['minX', 'maxX', 'minY', 'maxY']) assert.ok(Math.abs(noisy[key] - clean[key]) < 0.02, key);
  assert.ok(clean.maxX > 0.25 && clean.maxX < 0.3 && Math.abs(clean.maxY / clean.maxX - 2) < 0.01);
  assert.ok(Math.abs(clean.minX + clean.maxX) < 1e-9);
  // A handful of points, such as the corners of the stored bounds, are used as they are.
  const corners = trimmedBounds([-1, -2, 0, 1, 2, 0], matrix);
  assert.ok(corners.maxX > clean.maxX && corners.minY < clean.minY);
  assert.equal(trimmedBounds([0, 0, 50], matrix), null);
});

test('tilt and roll turn the reconstruction camera on the spot', () => {
  const level = new THREE.PerspectiveCamera(), turned = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(level, source, controls, 1000, 800);
  const same = configureSplatCamera(turned, source, { ...controls, tilt: 15, roll: 25 }, 1000, 800);
  vectorClose(turned.position, level.position.toArray());
  vectorClose(same, target.toArray());
  const forward = turned.getWorldDirection(new THREE.Vector3());
  const toTarget = target.clone().sub(turned.position).normalize();
  close(THREE.MathUtils.radToDeg(forward.angleTo(toTarget)), 15, 1e-6);
  assert.ok(forward.y > toTarget.y);
  // Roll is clockwise: the camera's right-hand side dips below the level camera's.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(turned.quaternion);
  assert.ok(right.y < new THREE.Vector3(1, 0, 0).applyQuaternion(level.quaternion).y - 0.3);
  // Setting both back gives the level camera again.
  configureSplatCamera(turned, source, { ...controls, tilt: 0, roll: 0 }, 1000, 800);
  assert.ok(turned.quaternion.angleTo(level.quaternion) < 1e-9);
});
