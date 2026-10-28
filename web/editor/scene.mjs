import * as THREE from '../vendor/three.module.mjs';
import { GLTFLoader } from '../vendor/GLTFLoader.mjs';
import { PoseViewerCore } from '../vendor/vnccs_pose_studio_core.mjs';
import { SplatScene } from './splat.mjs?v=20261004g7';
import { capturePNG } from './capture.mjs?v=20261004g7';

export const defaultScene = () => ({
  version: 1, width: 1024, height: 1024,
  source: { kind: 'empty' }, reference: null,
  camera: { azimuth: 35, elevation: 8, zoom: 1.3, offsetX: 0, offsetY: 0, offsetZ: 0 },
  shots: [], front: 0, scale: 1,
  background: '#69717b',
  conditioning: { model: 'anyangle', guide: 'coarse' },
});
export const assetURL = name => `/anyangle-studio-iv/assets/${encodeURIComponent(name)}`;
const radians = THREE.MathUtils.degToRad;
const degrees = THREE.MathUtils.radToDeg;
const clamp = THREE.MathUtils.clamp;
// 35 mm equivalent of the bundled viewer's fixed 30 degree shot, taking the frame height as a 24 mm sensor.
export const meshNativeFocalLength = 12 / Math.tan(radians(15));

// A different focal length is a dolly zoom around the shot target: the frame at the target keeps
// its size while the perspective gets wider or flatter. The camera never moves closer than
// minDistance, so a very short lens shows more of the scene instead of entering the asset.
// Returns how much the frame at the target grew because of that limit.
export function applyMeshLens(camera, target, focal, minDistance, clip) {
  if (focal != null && !(Number.isFinite(focal) && focal > 0)) throw new Error('Focal length must be greater than zero');
  const lens = focal == null ? 1 : focal / meshNativeFocalLength;
  const offset = camera.position.clone().sub(target);
  const distance = offset.length();
  const moved = lens < 1 ? Math.min(distance, Math.max(distance * lens, minDistance)) : distance * lens;
  camera.position.copy(target).addScaledVector(offset, moved / distance);
  if (lens !== 1) camera.fov = degrees(2 * Math.atan(Math.tan(radians(camera.fov) / 2) / lens));
  camera.near = clip.near * moved / distance;
  camera.far = clip.far * Math.max(1, moved / distance);
  camera.updateProjectionMatrix();
  return moved / distance / lens;
}

function disposeObject(root) {
  root.traverse(object => {
    object.geometry?.dispose();
    for (const material of [].concat(object.material || [])) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
  root.removeFromParent();
}

function worldBounds(root) {
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (object.isSkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); }
  });
  return new THREE.Box3().setFromObject(root);
}

// Tilting turns the camera up or down on the spot, so it aims above or below the shot target;
// rolling then turns it clockwise around its own viewing axis.
// Returns the point the camera now looks at, at the distance of the target.
export function aimCamera(camera, target, tilt, roll) {
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  const aim = target.clone();
  if (tilt) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    aim.sub(camera.position).applyAxisAngle(right, radians(tilt)).add(camera.position);
  }
  // Keeping the roll in the up vector lets the orbit controls preserve it.
  if (roll) camera.up.applyAxisAngle(aim.clone().sub(camera.position).normalize(), radians(roll));
  camera.lookAt(aim);
  return aim;
}

// The asset's outline in the frame: -1 and 1 are the frame edges, null if nothing is in front of the camera.
// Vertices are sampled so that large assets stay responsive; points behind the camera cannot be framed.
export function projectedBounds(root, camera, budget = 400000) {
  root.updateMatrixWorld(true);
  const view = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const meshes = [];
  let total = 0;
  root.traverse(object => {
    const position = object.geometry?.attributes?.position;
    if (position) { meshes.push([object, position]); total += position.count; }
  });
  const stride = Math.max(1, Math.ceil(total / budget));
  const matrix = new THREE.Matrix4();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [object, position] of meshes) {
    const e = matrix.multiplyMatrices(view, object.matrixWorld).elements;
    for (let i = 0; i < position.count; i += stride) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 0) continue;
      const px = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, py = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  return minX <= maxX ? { minX, maxX, minY, maxY } : null;
}

// How far the asset reaches from the frame center, in half-frame units (1 touches the frame edge).
export function projectedExtent(root, camera, budget) {
  const box = projectedBounds(root, camera, budget);
  return box ? Math.max(-box.minX, box.maxX, -box.minY, box.maxY) : 0;
}

export class StudioScene {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.mode = 'camera';
    this.restoring = true;
    this.viewer = new PoseViewerCore(canvas, {
      skinMode: 'naked', enableTextureSkinning: true,
      showSkeletonHelper: false, showCaptureFrame: false, useHandControlPopover: false,
      onPoseChange: () => { if (!this.restoring) callbacks.change(); },
      onError: error => callbacks.error(error),
    });
    // One editor history owns the camera, assets and shot library together.
    this.viewer.recordState = () => { if (!this.restoring) callbacks.begin(); };
    this.viewer.options.onInteractionEnd = () => { if (!this.restoring) callbacks.change(); };
    const requestRender = this.viewer.requestRender.bind(this.viewer);
    this.viewer.requestRender = () => { if (!this.capturing) requestRender(); };
  }

  async init(doc) {
    this.doc = doc;
    await this.viewer.init();
    if (!this.viewer.initialized) throw new Error('WebGL initialization failed; enable hardware acceleration in your browser');
    this.cameraClips = [this.viewer.camera, this.viewer.captureCamera].map(camera => ({ near: camera.near, far: camera.far }));
    this.viewer.setDirectionalSkydomeVisible(false);
    this.viewer.scene.background = new THREE.Color('#171f28');
    this.viewer.camera.fov = 38;
    this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.3 },
      { type: 'directional', color: '#ffffff', intensity: 1.7, x: 8, y: 20, z: 18 }]);
    this.grid = new THREE.GridHelper(100, 50, 0x425365, 0x28343f);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.32;
    this.viewer.scene.add(this.grid);
    const points = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.sin(i / 128 * Math.PI * 2) * 14, 0, Math.cos(i / 128 * Math.PI * 2) * 14));
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x24cce3, transparent: true, opacity: 0.72 }));
    this.viewer.scene.add(this.ring);
    this.shotHelper = new THREE.CameraHelper(this.viewer.captureCamera);
    this.shotHelper.material.color.set('#eba84b');
    this.viewer.scene.add(this.shotHelper);
    this.photoFrame = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xeba84b, depthTest: false }));
    this.photoFrame.renderOrder = 1000;
    this.viewer.scene.add(this.photoFrame);
    await this.restore(doc);
    this.bindCamera();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
    const animateSplat = () => {
      if (this.disposed) return;
      if (this.doc.source.kind === 'splat') this.viewer.requestRender();
      this.splatFrame = requestAnimationFrame(animateSplat);
    };
    animateSplat();
  }

  resize() {
    const { width, height } = this.canvas.parentElement.getBoundingClientRect();
    this.viewer.resize(Math.max(1, width), Math.max(1, height));
    if (this.mode === 'camera' && this.baseTarget) this.updateShot();
  }

  async restore(doc) {
    this.restoring = true;
    try {
      this.doc = doc;
      if (doc.source.kind !== 'splat') [this.viewer.camera, this.viewer.captureCamera].forEach((camera, i) => {
        camera.clearViewOffset(); camera.near = this.cameraClips[i].near; camera.far = this.cameraClips[i].far;
        camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
      });
      if (this.splat && doc.source.kind !== 'splat') { await this.splat.dispose(); this.splat = null; }
      if (this.glb && doc.source.kind !== 'glb') { disposeObject(this.glb); this.glb = null; this.glbName = null; }
      if (doc.source.kind === 'splat') {
        if (this.splat?.disposed || this.splat?.source?.name !== doc.source.name) {
          const loaded = new SplatScene(this.viewer);
          await loaded.load(doc.source);
          await this.splat?.dispose();
          this.splat = loaded;
          this.viewer.scene.add(this.splat.root);
        }
        this.splat.root.scale.setScalar(doc.scale);
        this.splat.root.rotation.y = radians(doc.front);
        this.splat.root.updateMatrixWorld(true);
        this.baseTarget = this.splat.target;
      } else if (doc.source.kind === 'glb') {
        if (this.glbName !== doc.source.name) {
          const response = await fetch(assetURL(doc.source.name));
          if (!response.ok) throw new Error('GLB asset is missing; please import it again');
          const manager = new THREE.LoadingManager();
          manager.setURLModifier(url => {
            if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('GLB must embed its textures; external URLs are not loaded');
            return url;
          });
          const gltf = await new GLTFLoader(manager).parseAsync(await response.arrayBuffer(), '');
          const imported = gltf.scene;
          const bounds = worldBounds(imported);
          if (bounds.isEmpty()) throw new Error('The GLB contains no renderable geometry');
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z);
          if (!Number.isFinite(longest) || longest <= 0) throw new Error('GLB geometry bounds are invalid');
          const scale = 20 / longest;
          const normalized = new THREE.Group();
          normalized.add(imported);
          normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
          normalized.scale.setScalar(scale);
          const group = new THREE.Group();
          group.add(normalized);
          if (this.glb) disposeObject(this.glb);
          this.glb = group;
          this.glbName = doc.source.name;
          this.viewer.scene.add(group);
        }
        this.glb.scale.setScalar(doc.scale);
        this.glb.rotation.y = radians(doc.front);
        this.baseTarget = worldBounds(this.glb).getCenter(new THREE.Vector3());
      } else {
        this.baseTarget = new THREE.Vector3(0, 10, 0);
      }
      this.viewer.setMannequinVisible(false);
      const bounds = doc.source.kind === 'splat' ? this.splat.bounds
        : doc.source.kind === 'empty' ? new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10))
        : worldBounds(this.glb);
      this.grid.position.y = bounds.min.y - 0.03;
      this.ring.position.copy(this.baseTarget);
      this.ring.visible = doc.source.kind !== 'splat' && doc.source.kind !== 'empty';
      this.setMode(this.mode);
      this.updateShot(true);
      await this.viewer.waitForCaptureReady();
    } finally { this.restoring = false; }
  }

  updateShot(snap = false) {
    const d = this.doc, c = d.camera;
    this.photoFrame.visible = d.source.kind === 'splat';
    if (d.source.kind === 'splat') {
      const v = this.viewer;
      const target = this.splat.configureCamera(v.captureCamera, d, d.width, d.height);
      v.captureFrame.visible = false;
      if (snap || this.mode === 'camera') {
        const aspect = v.camera.aspect;
        v.camera.copy(v.captureCamera);
        v.camera.aspect = aspect;
        const padding = 1.12;
        const sx = Math.min(1, (d.width / d.height) / aspect) / padding;
        const sy = Math.min(1, aspect / (d.width / d.height)) / padding;
        for (let column = 0; column < 4; column++) {
          v.camera.projectionMatrix.elements[column * 4] *= sx;
          v.camera.projectionMatrix.elements[column * 4 + 1] *= sy;
        }
        v.camera.projectionMatrixInverse.copy(v.camera.projectionMatrix).invert();
        const distance = v.camera.position.distanceTo(target);
        // A tilted camera aims beside the shot target.
        v.orbit.target.copy(v.captureCamera.getWorldDirection(new THREE.Vector3()).multiplyScalar(distance).add(v.captureCamera.position));
        const ndcZ = new THREE.Vector3(0, 0, -distance).applyMatrix4(v.captureCamera.projectionMatrix).z;
        this.photoFrame.geometry.dispose();
        this.photoFrame.geometry = new THREE.BufferGeometry().setFromPoints([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => new THREE.Vector3(x,y,ndcZ).unproject(v.captureCamera)));
      }
      this.shotHelper.update(); this.shotHelper.visible = this.mode === 'edit';
      v.requestRender(); return;
    }
    this.viewer.sceneCameraTarget = this.baseTarget.clone();
    this.viewer.sceneCameraTarget.z -= c.offsetZ || 0;
    this.viewer.updateCaptureCamera(d.width, d.height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
    this.viewer.captureFrame.visible = true;
    if (snap || this.mode === 'camera') {
      // Fit the complete output frame inside a differently-shaped editor viewport.
      const framing = 1.12 * Math.max(1, (d.width / d.height) / this.viewer.camera.aspect);
      this.viewer.camera.fov = degrees(2 * Math.atan(Math.tan(radians(15)) * framing));
      this.viewer.snapToCaptureCamera(d.width, d.height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
      this.viewer.captureFrame.visible = true;
      this.applyLens(this.viewer.camera, 0);
    }
    this.applyLens(this.viewer.captureCamera, 1);
    this.shotHelper.update();
    this.shotHelper.visible = this.mode === 'edit';
    this.viewer.requestRender();
  }

  // The bundled viewer only knows its fixed 30 degree shot; this adds the focal length to it.
  applyLens(camera, clip) {
    const c = this.doc.camera;
    const target = this.viewer.sceneCameraTarget.clone();
    target.x -= c.offsetX || 0; target.y -= c.offsetY || 0;
    let radius = 0;
    if (this.glb) {
      const bounds = worldBounds(this.glb);
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        radius = Math.max(radius, target.distanceTo(new THREE.Vector3(x, y, z)));
      }
    }
    const frame = applyMeshLens(camera, target, c.focal, radius * 1.05, this.cameraClips[clip]);
    const aim = aimCamera(camera, target, c.tilt, c.roll);
    if (camera === this.viewer.captureCamera) {
      // The viewer sized and placed the shot frame for its fixed, level lens, aimed at the target.
      const shotFrame = this.viewer.captureFrame;
      shotFrame.scale.x *= frame; shotFrame.scale.y *= frame;
      shotFrame.position.copy(aim); shotFrame.quaternion.copy(camera.quaternion);
    } else if (c.tilt || c.roll) { this.viewer.orbit.target.copy(aim); this.viewer.orbit.update(); }
  }

  setMode(mode) {
    if (this.doc.source.kind === 'splat' || this.doc.source.kind === 'empty') mode = 'camera';
    this.mode = mode;
    this.viewer.setIKMode(false);
    this.viewer.transform.detach();
    this.viewer.transform.visible = false;
    this.viewer.orbit.enabled = mode === 'edit';
    this.shotHelper.visible = mode === 'edit';
    // The free editing view is level even when the shot is rolled.
    if (mode === 'edit') this.viewer.camera.up.set(0, 1, 0);
    this.updateShot(mode === 'camera');
  }

  currentViewAsShot() {
    const v = this.viewer;
    const delta = v.camera.position.clone().sub(v.orbit.target);
    const distance = delta.length();
    this.doc.camera.azimuth = degrees(Math.atan2(delta.x, delta.z));
    this.doc.camera.elevation = degrees(Math.asin(delta.y / distance));
    this.doc.camera.zoom = v.camera.zoom * 45 / distance * Math.tan(radians(15)) / Math.tan(radians(v.camera.fov / 2));
    const target = this.baseTarget;
    this.doc.camera.offsetX = target.x - v.orbit.target.x;
    this.doc.camera.offsetY = target.y - v.orbit.target.y;
    this.doc.camera.offsetZ = target.z - v.orbit.target.z;
    this.doc.camera.tilt = 0; this.doc.camera.roll = 0;
    this.updateShot(true);
  }

  async capture(width = this.doc.width, height = this.doc.height) {
    if (this.doc.source.kind === 'empty') throw new Error('Reconstruct the subject from the source image or import a 3D scene first');
    await this.viewer.waitForCaptureReady();
    const v = this.viewer, c = this.doc.camera;
    const content = this.splat ? this.splat.root : this.glb;
    if (!content) throw new Error('The scene contains no renderable asset');
    const visibility = v.scene.children.map(object => [object, object.visible]);
    const background = v.scene.background;
    this.capturing = true;
    let restoreSplat = null;
    try {
      if (v._renderFrame) { cancelAnimationFrame(v._renderFrame); v._renderFrame = null; }
      if (this.splat) this.splat.configureCamera(v.captureCamera, this.doc, width, height);
      else { v.updateCaptureCamera(width, height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation); if (c.focal != null || c.tilt || c.roll) this.applyLens(v.captureCamera, 1); }
      // Pointer input may update the live cameras while sorting awaits a worker.
      const camera = v.captureCamera.clone();
      if (this.splat) {
        restoreSplat = this.splat.beginOffscreenCapture(width, height);
        await this.splat.prepareCapture(v.renderer, camera);
      }
      // Positive content selection excludes every editor overlay, even newly added helpers.
      for (const [object] of visibility) object.visible = object === content || !!object.isLight;
      v.scene.background = new THREE.Color(this.doc.background);
      // The bundled splat shader writes already encoded RGB, unlike Three's
      // standard mesh materials. Preserve those colors and its background.
      if (this.splat) v.scene.background.convertLinearToSRGB();
      v.scene.updateMatrixWorld(true);
      return capturePNG(v.renderer, v.scene, camera, width, height,
        this.splat ? THREE.NoColorSpace : THREE.SRGBColorSpace);
    } finally {
      for (const [object, visible] of visibility) object.visible = visible;
      v.scene.background = background;
      try { restoreSplat?.(); }
      finally { this.capturing = false; this.updateShot(); }
    }
  }

  fit(budget, snap = true) {
    if (this.doc.source.kind === 'splat') {
      this.doc.camera = { azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      this.updateShot(true); return;
    }
    if (this.doc.source.kind === 'empty') return;
    const c = this.doc.camera, camera = this.viewer.captureCamera;
    c.zoom = 1;
    const center = worldBounds(this.glb).getCenter(new THREE.Vector3());
    c.offsetX = this.baseTarget.x - center.x;
    c.offsetY = this.baseTarget.y - center.y;
    c.offsetZ = this.baseTarget.z - center.z;
    // The box corners can sit almost beside a close camera, so measure the asset itself.
    const outline = () => { this.updateShot(); camera.updateMatrixWorld(true); return projectedBounds(this.glb, camera, budget); };
    // Perspective and tilt move the outline off the box center; slide the shot until it is centered.
    for (let pass = 0; pass < 24; pass++) {
      const box = outline();
      if (!box || Math.max(Math.abs(box.minX + box.maxX), Math.abs(box.minY + box.maxY)) < 0.004) break;
      const half = camera.position.distanceTo(this.viewer.captureFrame.position) * Math.tan(radians(camera.fov) / 2);
      // Parts near a close camera move further than the target plane does, so approach in damped steps.
      const shift = new THREE.Vector3((box.minX + box.maxX) / 2 * half * camera.aspect, (box.minY + box.maxY) / 2 * half, 0)
        .applyQuaternion(camera.quaternion).multiplyScalar(0.5);
      c.offsetX -= shift.x; c.offsetY -= shift.y; c.offsetZ -= shift.z;
    }
    const box = outline();
    c.zoom = clamp(0.96 / Math.max(box ? Math.max(-box.minX, box.maxX, -box.minY, box.maxY) : 0, 0.01), 0.1, 8);
    this.updateShot(snap);
  }

  // Centers a reconstructed subject in the frame and fills it, keeping the viewing direction.
  // The frame of a reconstruction is off-axis, so position and zoom are approached together.
  fitSplat(snap = true) {
    const c = this.doc.camera, camera = this.viewer.captureCamera;
    Object.assign(c, { zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 });
    for (let pass = 0; pass < 24; pass++) {
      const target = this.splat.configureCamera(camera, this.doc, this.doc.width, this.doc.height);
      const box = this.splat.outline(camera);
      if (!box) break;
      const x = (box.minX + box.maxX) / 2, y = (box.minY + box.maxY) / 2, half = Math.max(box.maxX - box.minX, box.maxY - box.minY) / 2;
      if (Math.max(Math.abs(x), Math.abs(y)) < 0.004 && Math.abs(half - 0.96) < 0.004) break;
      const e = camera.projectionMatrix.elements, distance = camera.position.distanceTo(target);
      const shift = new THREE.Vector3(x * distance / e[0], y * distance / e[5], 0).applyQuaternion(camera.quaternion).multiplyScalar(0.5);
      // The framing offsets slide along the axes of the level, untilted camera.
      const backward = camera.position.clone().sub(target).normalize();
      const right = new THREE.Vector3(0, 1, 0).transformDirection(this.splat.root.matrixWorld).cross(backward).normalize();
      const up = new THREE.Vector3().crossVectors(backward, right);
      c.offsetX -= shift.dot(right); c.offsetY -= shift.dot(up); c.offsetZ -= shift.dot(backward);
      c.zoom = clamp(c.zoom * (0.96 / Math.max(half, 0.01)) ** 0.7, 0.1, 8);
    }
    this.updateShot(snap);
  }

  // Fills the frame with the loaded asset, whichever kind it is.
  frameAsset(budget, snap = true) {
    if (this.doc.source.kind === 'splat') this.fitSplat(snap);
    else this.fit(budget, snap);
  }

  // Aspect ratio of the asset's outline in the current shot, once it is centered.
  modelAspect(budget) {
    if (this.doc.source.kind === 'empty') return null;
    this.frameAsset(budget, false);
    const camera = this.viewer.captureCamera;
    camera.updateMatrixWorld(true);
    const box = this.doc.source.kind === 'splat' ? this.splat.outline(camera) : projectedBounds(this.glb, camera, budget);
    return box && box.maxY > box.minY ? (box.maxX - box.minX) * (this.doc.width / this.doc.height) / (box.maxY - box.minY) : null;
  }

  bindCamera() {
    const canvas = this.canvas;
    let drag = null;
    const end = () => { if (drag) { drag = null; this.callbacks.change(); } };
    canvas.addEventListener('pointerdown', event => {
      if (this.mode !== 'camera' || (event.button !== 0 && event.button !== 1)) return;
      event.stopImmediatePropagation(); event.preventDefault();
      this.callbacks.begin();
      drag = { x: event.clientX, y: event.clientY, camera: { ...this.doc.camera }, pan: event.button === 1 || event.shiftKey };
      canvas.setPointerCapture(event.pointerId);
    }, true);
    canvas.addEventListener('auxclick', event => { if (this.mode === 'camera' && event.button === 1) event.preventDefault(); });
    canvas.addEventListener('pointermove', event => {
      if (this.mode === 'camera') event.stopImmediatePropagation();
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (drag.pan) {
        this.doc.camera.offsetX = drag.camera.offsetX + dx * 0.025;
        this.doc.camera.offsetY = drag.camera.offsetY - dy * 0.025;
      } else {
        this.doc.camera.azimuth = ((drag.camera.azimuth - dx * 0.35 + 540) % 360) - 180;
        this.doc.camera.elevation = clamp(drag.camera.elevation + dy * 0.25, -89, 89);
      }
      this.updateShot(); this.callbacks.camera();
    }, true);
    canvas.addEventListener('pointerup', event => { if (drag) { event.stopImmediatePropagation(); end(); } }, true);
    canvas.addEventListener('pointercancel', end, true);
    canvas.addEventListener('wheel', event => {
      if (this.mode !== 'camera') return;
      event.stopImmediatePropagation(); event.preventDefault();
      this.callbacks.begin();
      this.doc.camera.zoom = clamp(this.doc.camera.zoom * Math.exp(-event.deltaY * 0.001), 0.1, 8);
      this.updateShot(); this.callbacks.change();
    }, { capture: true, passive: false });
    this.cancelDrag = () => {
      if (!drag) return false;
      this.doc.camera = drag.camera; drag = null;
      this.updateShot(); this.callbacks.change(); return true;
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.splatFrame);
    this.resizeObserver?.disconnect();
    this.splat?.dispose();
    this.viewer.dispose();
  }
}
