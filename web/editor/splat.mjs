import * as THREE from '../vendor/three.module.mjs';
import { DropInViewer, SceneFormat, SceneRevealMode } from '../vendor/gaussian-splats-3d.mjs';

const radians = THREE.MathUtils.degToRad;

export function decodeCameraToken(token) {
  if (!Array.isArray(token) || token.length !== 5 || !token.every(Number.isFinite)) {
    throw new Error('The reconstruction result lacks a valid 5-value camera token');
  }
  const direction = new THREE.Vector3(token[0], token[2], -token[1]);
  if (direction.lengthSq() < 1e-12 || token[4] <= 0) throw new Error('Reconstruction camera direction or field of view is invalid');
  direction.normalize();
  const orthographic = token[3] < 0.001;
  const radius = orthographic ? 1000 : 1 / token[3];
  return { direction, radius, fov: THREE.MathUtils.radToDeg(2 * Math.atan(token[4] / radius)), orthographic };
}

// 35 mm equivalent of the predicted field of view, taking the square prepared image as a 24 mm sensor.
export function nativeFocalLength(source) {
  return 12 / Math.tan(radians(decodeCameraToken(source.camera_token).fov) / 2);
}

function normalization(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2 || bounds.some(v => !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite))) {
    throw new Error('The reconstruction result lacks valid scene bounds');
  }
  const box = new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (box.isEmpty() || longest <= 0) throw new Error('Reconstruction scene bounds are empty');
  const scale = 20 / longest;
  const center = box.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z).multiplyScalar(scale);
  box.min.multiplyScalar(scale).add(offset);
  box.max.multiplyScalar(scale).add(offset);
  return { box, scale, offset };
}

// The predicted camera is approximate; this reverses the known preprocessing crop,
// not an assertion that the model recovered the physical camera of the photograph.
export function configureSplatCamera(camera, source, controls, width, height, matrixWorld = new THREE.Matrix4()) {
  if (!camera.isPerspectiveCamera) throw new Error('Gaussian shots require a perspective camera');
  const predicted = decodeCameraToken(source.camera_token);
  const normalized = normalization(source.bounds);
  const reference = source.reference;
  const crop = source.crop;
  if (!reference || !(reference.width > 0 && reference.height > 0) ||
      !Array.isArray(crop) || crop.length !== 4 || !crop.every(Number.isFinite) ||
      crop[2] <= crop[0] || crop[3] <= crop[1] || !(width > 0 && height > 0)) {
    throw new Error('The reconstruction result lacks source image size or crop parameters');
  }
  if (!Number.isFinite(controls.zoom) || controls.zoom <= 0) throw new Error('Framing zoom must be greater than zero');

  const azimuth = Math.atan2(predicted.direction.x, predicted.direction.z) + radians(controls.azimuth || 0);
  const elevation = THREE.MathUtils.clamp(Math.asin(predicted.direction.y) + radians(controls.elevation || 0), -Math.PI / 2 + 1e-5, Math.PI / 2 - 1e-5);
  const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const target = normalized.offset.clone().applyMatrix4(matrixWorld);
  // A different focal length is a dolly zoom: the camera distance scales with it, so the
  // subject keeps its size at the target while the perspective gets wider or flatter.
  const focal = controls.focal;
  if (focal != null && !(Number.isFinite(focal) && focal > 0)) throw new Error('Focal length must be greater than zero');
  const lens = focal == null || predicted.orthographic ? 1 : focal / nativeFocalLength(source);
  camera.position.copy(direction).multiplyScalar(predicted.radius * normalized.scale * lens).add(normalized.offset).applyMatrix4(matrixWorld);
  camera.up.set(0, 1, 0).transformDirection(matrixWorld);
  camera.lookAt(target);

  const backward = camera.position.clone().sub(target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, backward).normalize();
  const up = new THREE.Vector3().crossVectors(backward, right).normalize();
  const pan = right.multiplyScalar(-(controls.offsetX || 0)).addScaledVector(up, -(controls.offsetY || 0)).addScaledVector(backward, -(controls.offsetZ || 0));
  camera.position.add(pan);
  target.add(pan);

  const worldScale = new THREE.Vector3().setFromMatrixScale(matrixWorld).length() / Math.sqrt(3);
  const extent = normalized.box.getSize(new THREE.Vector3()).length() * worldScale;
  const distance = camera.position.distanceTo(target);
  camera.near = Math.max(0.01, distance - extent * 2);
  camera.far = Math.max(camera.near + 1, distance + extent * 2);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(radians(predicted.fov) / 2) / lens));
  camera.zoom = controls.zoom;
  camera.filmOffset = 0;

  // A square prepared image is the full sensor. Expand its off-axis viewport back
  // into the source image, containing that frame if the requested aspect changes.
  const aspect = width / height;
  const frameWidth = Math.max(reference.width, reference.height * aspect);
  const frameHeight = Math.max(reference.height, reference.width / aspect);
  const cropWidth = crop[2] - crop[0], cropHeight = crop[3] - crop[1];
  camera.setViewOffset(1, 1,
    (-(frameWidth - reference.width) / 2 - crop[0]) / cropWidth,
    (-(frameHeight - reference.height) / 2 - crop[1]) / cropHeight,
    frameWidth / cropWidth, frameHeight / cropHeight);
  camera.updateProjectionMatrix();
  // Tilt and roll turn the camera on the spot. They live in its aim and up vector, as for a GLB shot.
  if (controls.tilt || controls.roll) {
    const aim = target.clone();
    if (controls.tilt) {
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      aim.sub(camera.position).applyAxisAngle(side, radians(controls.tilt)).add(camera.position);
    }
    if (controls.roll) camera.up.applyAxisAngle(aim.clone().sub(camera.position).normalize(), radians(controls.roll));
    camera.lookAt(aim);
  }
  camera.updateMatrixWorld(true);
  return target;
}

// Outline of projected points in the frame (-1 and 1 are its edges), leaving out the outermost
// fraction on each side so that a few stray gaussians do not decide the framing.
export function trimmedBounds(points, matrix, trim = 0.005) {
  const e = matrix.elements, xs = [], ys = [];
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0) continue;
    xs.push((e[0] * x + e[4] * y + e[8] * z + e[12]) / w); ys.push((e[1] * x + e[5] * y + e[9] * z + e[13]) / w);
  }
  if (!xs.length) return null;
  const sorted = [xs, ys].map(values => Float64Array.from(values).sort());
  const low = Math.floor(trim * (xs.length - 1)), high = xs.length - 1 - low;
  return { minX: sorted[0][low], maxX: sorted[0][high], minY: sorted[1][low], maxY: sorted[1][high] };
}

export class SplatScene {
  constructor(viewerCore) {
    this.core = viewerCore;
    this.root = new THREE.Group();
    this.root.name = 'AnyAngleSplat';
    this._bounds = new THREE.Box3();
    this._target = new THREE.Vector3();
    this.dropIn = null;
    this.source = null;
    this.disposed = false;
  }

  get bounds() {
    this.root.updateWorldMatrix(true, false);
    return this._bounds.clone().applyMatrix4(this.root.matrixWorld);
  }

  get target() {
    this.root.updateWorldMatrix(true, false);
    return this._target.clone().applyMatrix4(this.root.matrixWorld);
  }

  async load(source) {
    if (this.disposed || this.dropIn) throw new Error('Create a separate scene for a new reconstruction asset');
    decodeCameraToken(source.camera_token);
    const normalized = normalization(source.bounds);
    this.source = source;
    this._bounds.copy(normalized.box);
    this._target.copy(normalized.offset);
    const dropIn = new DropInViewer({
      sharedMemoryForWorkers: false, gpuAcceleratedSort: false, integerBasedSort: false,
      sphericalHarmonicsDegree: 0, sceneRevealMode: SceneRevealMode.Instant,
      dynamicScene: false,
    });
    this.dropIn = dropIn;
    this.root.add(dropIn);
    const viewer = dropIn.viewer;
    // 0.4.7's tree culling ignores off-axis projection. Keep all nodes available
    // for the uncropped reference frame; sorting still runs in its local worker.
    const gather = viewer.gatherSceneNodesForSort.bind(viewer);
    viewer.gatherSceneNodesForSort = () => gather(true);
    try {
      viewer.updateForDropInMode(this.core.renderer, this.core.camera);
      await dropIn.addSplatScene(`/anyangle-studio-iv/assets/${encodeURIComponent(source.name)}`, {
        format: SceneFormat.Ply, showLoadingUI: false, progressiveLoad: false,
        rotation: [1, 0, 0, 0], scale: [normalized.scale, normalized.scale, normalized.scale],
        position: normalized.offset.toArray(),
      });
      if (this.disposed) throw new Error('Reconstruction scene was closed');
      this.root.updateMatrixWorld(true);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  // A sample of the visible gaussians' centers in the splat mesh's own space, for framing.
  centers(budget = 20000) {
    const mesh = this.dropIn?.viewer.splatMesh;
    if (!mesh) return null;
    if (this._centers) return this._centers;
    const points = [];
    try {
      const count = mesh.getSplatCount(), stride = Math.max(1, Math.ceil(count / budget));
      const center = new THREE.Vector3(), color = new THREE.Vector4();
      for (let i = 0; i < count; i += stride) {
        mesh.getSplatColor(i, color);
        if (color.w < 26) continue;
        mesh.getSplatCenter(i, center, true);
        points.push(center.x, center.y, center.z);
      }
    } catch { points.length = 0; }
    if (points.length) return (this._centers = { points, mesh });
    // Without readable gaussians the corners of the stored bounds still frame the subject.
    const { min, max } = this.bounds;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) points.push(x, y, z);
    return (this._centers = { points, mesh: null });
  }

  // The subject's outline in the camera's frame; null if nothing is in front of it.
  outline(camera) {
    const sample = this.centers();
    if (!sample) return null;
    const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (sample.mesh) { sample.mesh.updateWorldMatrix(true, false); matrix.multiply(sample.mesh.matrixWorld); }
    return trimmedBounds(sample.points, matrix);
  }

  configureCamera(camera, doc, width, height) {
    this.root.updateWorldMatrix(true, false);
    return configureSplatCamera(camera, this.source, doc.camera, width, height, this.root.matrixWorld);
  }

  async prepareCapture(renderer, camera) {
    if (this.disposed || !this.dropIn?.viewer.splatRenderReady) throw new Error('Gaussian scene is not ready yet');
    const viewer = this.dropIn.viewer;
    await viewer.sortPromise;
    this.root.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    viewer.updateForDropInMode(renderer, camera);
    // runSplatSort resolves after dispatch, while sortPromise resolves on sortDone.
    // Drain any partial sorts left by the interactive camera before the full sort.
    for (let i = 0; i < 5; i++) {
      await viewer.runSplatSort(true, true);
      await viewer.sortPromise;
      if (this.disposed) throw new Error('Gaussian scene was closed');
      if (viewer.lastSplatSortCount === viewer.splatRenderCount) {
        viewer.updateSplatMesh();
        return;
      }
    }
    throw new Error('Gaussian sorting has not finished; please retry the export');
  }

  beginOffscreenCapture(width, height) {
    const viewer = this.dropIn.viewer;
    const dimensions = viewer.getRenderDimensions;
    const pixelRatio = viewer.devicePixelRatio;
    const meshPixelRatio = viewer.splatMesh.devicePixelRatio;
    viewer.getRenderDimensions = out => { out.set(width, height); };
    viewer.devicePixelRatio = 1;
    viewer.splatMesh.devicePixelRatio = 1;
    return () => {
      viewer.getRenderDimensions = dimensions;
      viewer.devicePixelRatio = pixelRatio;
      viewer.splatMesh.devicePixelRatio = meshPixelRatio;
      viewer.updateForDropInMode(this.core.renderer, this.core.camera);
      viewer.updateSplatMesh();
    };
  }

  async dispose() {
    if (this.disposed) return this.disposePromise;
    this.disposed = true;
    this.root.removeFromParent();
    const dropIn = this.dropIn;
    this.disposePromise = (async () => {
      if (!dropIn) return;
      try { await dropIn.dispose(); }
      finally {
        // DropInViewer.dispose releases its viewer, but not this callback mesh.
        dropIn.callbackMesh.geometry.dispose();
        dropIn.callbackMesh.material.dispose();
        this.root.clear();
        this.dropIn = null;
      }
    })();
    return this.disposePromise;
  }
}
