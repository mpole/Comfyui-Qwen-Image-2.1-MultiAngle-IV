import { StudioScene, defaultScene, assetURL, meshNativeFocalLength } from './scene.mjs?v=20261004g7';
import { reconstruct, bakeMesh, reconstructionConfig, selectedReconstructionModels, saveReconstructionModels } from './reconstruct.mjs?v=20261004g7';
import { nativeFocalLength, decodeCameraToken } from './splat.mjs?v=20261004g7';
import { guidePrompt } from './guides.mjs?v=20261004g7';
import { supportsCameraBatch, cameraBatchPlan, runCameraBatch } from './batch.mjs?v=20261004g7';

const $ = selector => document.querySelector(selector);
const clone = value => structuredClone(value);
const params = new URLSearchParams(location.search);
const embedded = params.has('session') && parent !== window;
const session = params.get('session');
let doc = defaultScene(), studio, revision = 0, busy = true, ready = false;
let undo = [], redo = [], previewTimer, previewRunning = false;
let selectedShot = null, snapshot = null;
let linkedReference = { connected: false };
let unwiredAnyAngle = false;
let pendingReference = null;
let overlayShown = false;
let previewVisible = false, previewRevision = -1;
let batchRunning = false, batchController = null, batchViews = [], batchId = null;
const batchReplies = new Map();
const controls = new Map();

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function error(error) { console.error(error); toast(error?.message || String(error)); }
function hasGuide() { return doc.source.kind !== 'empty'; }
function setBusy(value) {
  busy = value; $('#workspace').inert = value; $('#apply').disabled = value || !ready || !hasGuide()
    || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending));
  $('#undo').disabled = value || !undo.length; $('#redo').disabled = value || !redo.length;
  if (!value && pendingReference) queueMicrotask(readPendingReference);
}
async function run(task) {
  if (busy) return;
  setBusy(true);
  try {
    while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
    await task();
  } catch (e) { error(e); }
  finally { setBusy(false); await renderPreview(); }
}
function begin() {
  if (!ready || studio.restoring) return;
  const serialized = JSON.stringify(doc);
  if (JSON.stringify(undo.at(-1)) !== serialized) undo.push(clone(doc));
  if (undo.length > 40) undo.shift();
  redo = []; $('#undo').disabled = false; $('#redo').disabled = true;
}
// Shapes the frame like the asset's outline in the current shot, keeping its longer side, and fills it.
function frameToModel(budget) {
  const snap = studio.mode === 'camera';
  const aspect = studio.modelAspect(budget), long = Math.max(doc.width, doc.height), step = value => Math.max(64, Math.round(value / 32) * 32);
  if (!aspect) return;
  [doc.width, doc.height] = aspect >= 1 ? [long, step(long / aspect)] : [step(long * aspect), long];
  studio.frameAsset(budget, snap);
}
// Auto fit repeats that after every change, with a coarser sample so dragging stays smooth.
function autoFrame() { if (doc.autoFrame && doc.source.kind !== 'empty') frameToModel(100000); }
function changed() {
  if (!ready || studio.restoring) return;
  autoFrame();
  revision++; selectedShot = null;
  document.querySelectorAll('.shot-thumb.active').forEach(button => button.classList.remove('active'));
  $('#status').textContent = 'Draft changed · apply to update the node'; $('#status').dataset.state = 'dirty';
  refresh(); schedulePreview();
}
function schedulePreview() {
  clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 110);
}
function captureGuide(width = doc.width, height = doc.height) { return studio.capture(width, height); }
async function renderPreview() {
  if (!ready || !hasGuide() || busy) return;
  if (previewRunning) { schedulePreview(); return; }
  previewRunning = true;
  const version = revision;
  try {
    const scale = Math.min(1, 500 / Math.max(doc.width, doc.height));
    const png = await captureGuide(Math.round(doc.width * scale), Math.round(doc.height * scale));
    if (version === revision) {
      $('#guide').src = $('#stage-guide').src = png;
      previewRevision = version; refresh();
    }
  } catch (e) { $('#stage-guide-message').textContent = e.message || 'Preview failed, please try again'; error(e); }
  finally { previewRunning = false; }
}
function refresh() {
  if (studio && (doc.source.kind === 'splat' || doc.source.kind === 'empty') &&
      (studio.mode !== 'camera' || $('#edit-mode').classList.contains('active'))) setMode('camera');
  if (linkedReference.connected) doc.reference = linkedReference.asset || null;
  const base = doc.conditioning.model === 'base';
  const splat = doc.source.kind === 'splat', empty = doc.source.kind === 'empty';
  $('#stage').classList.toggle('previewing-guide', previewVisible);
  $('#stage-guide-view').hidden = !previewVisible;
  $('#stage-guide-detail').textContent = `Actual output · image_2 · ${doc.width} × ${doc.height}`;
  $('#stage-guide').hidden = !hasGuide() || previewRevision !== revision;
  $('#stage-guide-empty').hidden = hasGuide() && previewRevision === revision;
  $('#stage-guide-message').textContent = hasGuide() ? 'Rendering guide preview…' : 'Reconstruct the 3D subject from the source image first';
  $('#view-detail').textContent = previewVisible ? 'Coarse 3D render · actual output' : '3D workbench · adjust the camera';
  for (const [id, active] of [['view-output', previewVisible], ['view-scene', !previewVisible]]) {
    $(`#${id}`).classList.toggle('active', active); $(`#${id}`).setAttribute('aria-pressed', String(active));
  }
  $('#view-scene').disabled = empty;
  $('#stage-help').textContent = previewVisible ? 'Guide image for the current shot · switch to the 3D workbench to adjust the camera'
    : studio?.mode === 'edit' ? 'Right-drag to orbit · middle button to pan'
      : 'Drag to adjust the shot camera · middle button or Shift to pan · scroll to zoom';
  for (const control of controls.values()) control.refresh();
  $('#width').value = doc.width; $('#height').value = doc.height;
  $('#background').value = doc.background;
  const ratio = ['1:1', '16:9', '9:16', '4:3'].find(value => { const [w, h] = value.split(':').map(Number); return Math.abs(doc.width / doc.height - w / h) < 0.015; });
  $('#ratio').value = !empty && doc.autoFrame ? 'auto' : ratio || 'custom';
  $('#guide-size').textContent = `${doc.width} × ${doc.height}`;
  $('#front').disabled = $('#front-number').disabled = splat || empty;
  $('#scale').disabled = $('#scale-number').disabled = splat || empty;
  $('#front').closest('.control').hidden = splat || empty;
  $('#scale').closest('.control').hidden = splat || empty;
  for (const id of ['focal', 'roll']) $(`#${id}`).disabled = $(`#${id}-number`).disabled = empty;
  // A splat cannot be tilted or edited in the free view; its baked mesh can.
  $('#tilt').disabled = $('#tilt-number').disabled = empty || splat;
  $('#tilt').closest('.control').title = splat ? 'Bake GLB first' : '';
  $('#zoom').disabled = $('#zoom-number').disabled = !empty && !!doc.autoFrame;
  $('#zoom').closest('.control').title = !empty && doc.autoFrame ? 'Set by Auto fit' : '';
  $('#ratio-model').disabled = $('#ratio-auto').disabled = empty;
  $('#calibration-hint').textContent = splat
    ? 'The reconstructed subject is aligned with the predicted source camera and is static. Use the shot camera to adjust angle, zoom and framing.'
    : empty ? 'Connect a source image and reconstruct the subject, or import a GLB, then adjust the scene.'
      : 'GLB is Y-up by default. Rotate the asset to calibrate its front; asset scale is independent of camera zoom.';
  $('#bake-glb').disabled = !splat;
  $('#export-glb').disabled = doc.source.kind !== 'glb';
  $('#export-splat').disabled = !reconstructedSplat();
  $('#asset-label').textContent = empty ? 'Waiting for reconstruction' : doc.source.label || 'GLB scene';
  $('#source-badge').textContent = empty ? 'PHOTO → 3D' : splat ? 'TRIPOSPLAT · RECONSTRUCTED' : 'GLB · SCENE';
  $('#reference').hidden = !doc.reference; $('#reference-empty').hidden = !!doc.reference;
  if (doc.reference) $('#reference').src = assetURL(doc.reference.name);
  $('#reference-overlay-toggle').disabled = !doc.reference;
  $('#reference-overlay-toggle').classList.toggle('active', overlayShown && !!doc.reference);
  $('#reference-overlay').hidden = !overlayShown || !doc.reference;
  if (doc.reference) $('#reference-overlay').src = assetURL(doc.reference.name);
  $('#reference-button').disabled = $('#reference-drop').disabled = linkedReference.connected;
  $('#read-reference').hidden = !linkedReference.connected;
  $('#read-reference').disabled = !!linkedReference.pending;
  $('#reference-origin').textContent = linkedReference.connected ? linkedReference.message : 'Connect an IMAGE to the node input, or upload an image here.';
  $('#reconstruction-state').hidden = !doc.reference;
  $('#reconstruction-state').textContent = splat ? 'The reconstructed 3D subject keeps its pose and has no editable skeleton; drag the camera to change the view.' : 'Reconstruct the subject from the source image, then adjust the camera.';
  $('#reconstruct').disabled = !doc.reference;
  $('#reconstruct').textContent = splat ? 'Reload reconstructed 3D' : 'Reconstruct 3D from image';
  $('#empty-scene').hidden = !empty;
  $('#extract-coarse').disabled = !doc.reference || !!linkedReference.pending;
  $('#model-anyangle').classList.toggle('active', !base); $('#model-base').classList.toggle('active', base);
  $('#model-badge').textContent = base ? 'QWEN 2.1' : 'ANYANGLE';
  $('#prompt-preview').textContent = guidePrompt(doc.conditioning);
  $('#lora-hint').textContent = base ? 'LoRA strength output 0 → base model' : 'LoRA strength output 1 → AnyAngle';
  $('#protocol-hint').textContent = base && unwiredAnyAngle ? 'The AnyAngle LoRA strength in this workflow is still fixed. Connect the Studio strength output, or remove the LoRA loader.'
    : base ? 'The base model treats the guide as a second reference image; how closely it is followed needs testing.'
    : 'AnyAngle requires the coarse render of the current shot. Wire the LoRA strength output to the model loader.';
  $('#protocol-hint').classList.toggle('wiring-warning', base && unwiredAnyAngle);
  $('#guide').hidden = !hasGuide() || previewRevision !== revision;
  $('#guide-state').textContent = hasGuide() ? 'Grid and gizmos are not part of the coarse render.' : 'Load a 3D subject first.';
  $('#save-shot').disabled = $('#fit-frame').disabled = empty;
  $('#open-batch').disabled = !supportsCameraBatch(doc);
  $('#open-batch').title = supportsCameraBatch(doc) ? 'Batch render / generate by angle steps or saved shots' : 'Requires a 3D subject with a coarse render';
  $('#download-guide').disabled = !hasGuide();
  $('#apply').disabled = busy || !ready || !hasGuide() || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending));
  $('#edit-mode').disabled = splat || empty;
  $('#edit-mode').title = splat ? 'Bake GLB first' : empty ? 'Load a 3D subject first' : '';
  $('#mode-hint').hidden = !splat;
  $('#fit-frame').textContent = splat ? 'Back to source camera' : 'Fit to frame';
  $('[data-angle="0"]').textContent = splat ? 'Source camera' : 'Front';
}

function makeControl(container, { id, label, min, max, step = 1, unit = '', log = false, read, write, commit }) {
  const wrap = document.createElement('div'); wrap.className = 'control';
  const top = document.createElement('div'); top.className = 'control-top';
  const title = document.createElement('label'); title.textContent = label; title.htmlFor = `${id}-number`;
  const value = document.createElement('div'); value.className = 'control-value';
  const number = document.createElement('input'); Object.assign(number, { id: `${id}-number`, type: 'number', min, max, step });
  const suffix = document.createElement('span'); suffix.textContent = unit; value.append(number, suffix); top.append(title, value);
  const range = document.createElement('input');
  // A logarithmic slider keeps the short end of a wide range usable; the number field stays linear.
  Object.assign(range, log ? { id, type: 'range', min: Math.log(min), max: Math.log(max), step: 'any' } : { id, type: 'range', min, max, step }); range.setAttribute('aria-label', label);
  const endpoints = document.createElement('div'); endpoints.className = 'control-range-labels';
  for (const text of [`${min}${unit}`, `${max}${unit}`]) { const span = document.createElement('span'); span.textContent = text; endpoints.append(span); }
  wrap.append(top, range, endpoints); $(container).append(wrap);
  let gesture = false;
  const start = () => { if (!gesture) { begin(); gesture = true; } };
  const update = raw => {
    const input = Number(raw); if (!Number.isFinite(input)) return;
    write(Math.min(max, Math.max(min, input))); changed();
  };
  range.oninput = () => { start(); update(log ? Math.round(Math.exp(range.value) / step) * step : range.value); };
  range.onchange = () => { gesture = false; if (commit) run(async () => { await commit(); changed(); }); };
  number.oninput = () => { if (number.value === '' || !Number.isFinite(number.valueAsNumber)) return; start(); update(number.value); };
  number.onblur = () => {
    const edited = gesture; gesture = false;
    if (edited && commit) run(async () => { await commit(); changed(); });
    control.refresh();
  };
  const control = { refresh() { const v = Number(read()); range.value = log ? Math.log(v) : v; if (document.activeElement !== number) number.value = Number(v.toFixed(step < 1 ? 2 : 1)); } };
  controls.set(id, control); control.refresh();
}

for (const [key, label, min, max, step, unit] of [
  ['azimuth', 'Azimuth', -180, 180, 0.1, '°'], ['elevation', 'Elevation', -89, 89, 0.1, '°'],
  ['tilt', 'Tilt', -60, 60, 0.1, '°'], ['roll', 'Roll', -180, 180, 0.1, '°'], ['zoom', 'Framing zoom', 0.1, 8, 0.01, '×'],
]) makeControl('#camera-sliders', { id: key, label, min, max, step, unit,
  read: () => doc.camera[key] ?? 0, write: value => { doc.camera[key] = value; studio.updateShot(); } });
// Unset means the focal length predicted by the reconstruction, or the viewer's own for a GLB.
makeControl('#camera-sliders', { id: 'focal', label: 'Focal length (35 mm equiv.)', min: 8, max: 400, step: 1, unit: ' mm', log: true,
  read: () => doc.camera.focal ?? (doc.source.kind === 'splat' ? nativeFocalLength(doc.source) : meshNativeFocalLength),
  write: value => { doc.camera.focal = value; studio.updateShot(); } });
for (const [key, label, min, max, step, unit] of [['front', 'GLB front calibration', -180, 180, 1, '°'], ['scale', 'Asset scale', 0.25, 3, 0.01, '×']]) {
  makeControl('#scene-sliders', { id: key, label, min, max, step, unit, read: () => doc[key], write: value => { doc[key] = value; }, commit: () => studio.restore(doc) });
}
for (const [key, label] of [['offsetX', 'Horizontal framing offset'], ['offsetY', 'Vertical framing offset']]) {
  makeControl('#scene-sliders', { id: key, label, min: -20, max: 20, step: 0.01,
    read: () => doc.camera[key], write: value => { doc.camera[key] = value; studio.updateShot(); } });
}


function setMode(mode) {
  studio.setMode(mode);
  mode = studio.mode;
  $('#camera-mode').classList.toggle('active', mode === 'camera'); $('#edit-mode').classList.toggle('active', mode === 'edit');
  $('#camera-mode').setAttribute('aria-pressed', String(mode === 'camera')); $('#edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  $('#use-view').hidden = mode !== 'edit';
  $('#stage-help').textContent = mode === 'camera' ? 'Drag to adjust the shot camera · middle button or Shift to pan · scroll to zoom'
    : 'Right-drag to orbit · middle button to pan · the current view can be set as the shot camera';
}
$('#view-output').onclick = () => { previewVisible = true; refresh(); schedulePreview(); };
$('#view-scene').onclick = () => { previewVisible = false; setMode(studio.mode); refresh(); };
$('#camera-mode').onclick = () => setMode('camera'); $('#edit-mode').onclick = () => setMode('edit');
$('#use-view').onclick = () => { begin(); studio.currentViewAsShot(); setMode('camera'); changed(); };
$('#fit-frame').onclick = () => { begin(); studio.fit(); changed(); };
document.querySelectorAll('[data-angle]').forEach(button => { button.onclick = () => { begin(); Object.assign(doc.camera, { azimuth: Number(button.dataset.angle), elevation: 0, tilt: 0, roll: 0, zoom: 1, focal: 35 }); studio.updateShot(); changed(); }; });
$('#reset-camera').onclick = () => { begin(); doc.camera = doc.source.kind === 'splat' ? referenceCamera() : defaultScene().camera; studio.updateShot(true); changed(); };
function dimensions(width, height) { begin(); doc.width = Math.round(Math.max(64, Math.min(4096, width))); doc.height = Math.round(Math.max(64, Math.min(4096, height))); studio.updateShot(); changed(); }
$('#width').oninput = event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value <= 4096) dimensions(value, doc.height); };
$('#height').oninput = event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value <= 4096) dimensions(doc.width, value); };
$('#ratio').onchange = event => {
  if (event.target.value === 'auto') { begin(); doc.autoFrame = true; changed(); return; }
  if (doc.autoFrame) { begin(); doc.autoFrame = false; }
  if (event.target.value === 'custom') { changed(); return; }
  if (event.target.value === 'model') { begin(); frameToModel(); changed(); return; }
  const [a, b] = event.target.value.split(':').map(Number); const long = Math.max(doc.width, doc.height);
  dimensions(a >= b ? long : Math.round(long * a / b / 32) * 32, a >= b ? Math.round(long * b / a / 32) * 32 : long);
};
$('#background').onchange = event => { begin(); doc.background = event.target.value; changed(); };
$('#model-anyangle').onclick = () => { if (doc.conditioning.model === 'anyangle') return; begin(); doc.conditioning.model = 'anyangle'; changed(); };
$('#model-base').onclick = () => { if (doc.conditioning.model === 'base') return; begin(); doc.conditioning.model = 'base'; changed(); };
$('#reference-overlay-toggle').onclick = () => { overlayShown = !overlayShown; refresh(); };
async function undoRedo(source, target) {
  if (!source.length) return;
  target.push(clone(doc)); doc = source.pop();
  if (linkedReference.connected) doc.reference = linkedReference.asset || null;
  if (reconstructedSplat() && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
  await studio.restore(doc); changed(); renderShots(); refresh();
}
$('#undo').onclick = () => run(() => undoRedo(undo, redo)); $('#redo').onclick = () => run(() => undoRedo(redo, undo));
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select') || busy) return;
  if (event.key === 'Escape' && studio.cancelDrag()) { event.preventDefault(); return; }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? $('#redo') : $('#undo')).click(); }
    if (event.key.toLowerCase() === 'y') { event.preventDefault(); $('#redo').click(); }
  }
});

async function upload(file) {
  const form = new FormData(); form.append('file', file);
  const response = await fetch('/anyangle-studio-iv/assets', { method: 'POST', body: form });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Import failed'); return result;
}
$('#reference-button').onclick = $('#reference-drop').onclick = () => $('#reference-file').click();
$('#read-reference').onclick = () => {
  linkedReference = { ...linkedReference, connected: true, pending: true, message: 'Reading upstream image…' };
  refresh(); send('anyangle-read-reference');
};
$('#reference-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const asset = await upload(file);
  begin(); doc.reference = asset;
  if (reconstructedSplat()) doc.source = { kind: 'empty' };
  await studio.restore(doc); changed();
  if (doc.source.kind === 'empty') await reconstructPhoto();
});
const referenceCamera = () => ({ azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 });
const reconstructionModelLabels = {
  background_removal: 'Background removal · BiRefNet', clip_vision: 'Image encoder · DINOv3', diffusion_models: '3D reconstruction · TripoSplat',
  vae_encoder: 'Image VAE · Flux2', vae_decoder: '3D decoder · TripoSplat VAE',
};
function showModelStatus(config) {
  $('#reconstruction-model-state').textContent = config.available ? '5 models ready · the next reconstruction uses the current selection'
    : `Still need to select or provide: ${config.missing.join(', ')}`;
}
async function loadReconstructionModels() {
  $('#reconstruction-model-state').textContent = 'Reading local model list…';
  $('#reconstruction-model-save').disabled = true;
  try {
    const config = await reconstructionConfig({});
    if (!config.choices) throw new Error('Restart ComfyUI to enable model selection');
    const selected = selectedReconstructionModels(), fields = $('#reconstruction-model-fields');
    fields.replaceChildren();
    for (const [role, title] of Object.entries(reconstructionModelLabels)) {
      const label = document.createElement('label'), select = document.createElement('select');
      label.textContent = title; select.dataset.role = role; select.setAttribute('aria-label', title);
      const automatic = document.createElement('option'); automatic.value = '';
      automatic.textContent = 'Auto-detect · ' + (config.ambiguous[role] ? 'duplicate filenames, please choose'
        : config.choices[role].includes(config.models[role]) ? config.models[role] : 'not found');
      select.append(automatic);
      for (const name of config.choices[role]) {
        const option = document.createElement('option'); option.value = option.textContent = name; select.append(option);
      }
      if (selected[role] && !config.choices[role].includes(selected[role])) {
        const missing = document.createElement('option'); missing.value = selected[role];
        missing.textContent = `File moved · ${selected[role]}`; missing.disabled = true; select.append(missing);
      }
      select.value = selected[role] || ''; label.append(select); fields.append(label);
    }
    $('#reconstruction-model-save').disabled = false;
    const chosen = await reconstructionConfig(selected);
    showModelStatus(chosen);
  } catch (e) { $('#reconstruction-model-state').textContent = e.message; throw e; }
}
$('#reconstruction-model-panel').ontoggle = () => {
  if ($('#reconstruction-model-panel').open && ready) run(loadReconstructionModels);
};
$('#reconstruction-model-refresh').onclick = () => run(loadReconstructionModels);
$('#reconstruction-model-save').onclick = () => run(async () => {
  const selections = {};
  for (const select of $('#reconstruction-model-fields').querySelectorAll('select'))
    if (select.value) selections[select.dataset.role] = select.value;
  const config = await saveReconstructionModels(selections);
  showModelStatus(config); toast('Model selection saved · click "Reconstruct 3D from image" to use it');
});
async function reconstructPhoto() {
  if (!doc.reference) return;
  clearTimeout(previewTimer);
  while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
  const reference = clone(doc.reference);
  const previous = clone(doc);
  $('#loading').hidden = false;
  $('#loading-text').textContent = 'Preparing reconstruction from the source image';
  $('#loading-detail').textContent = 'Local TripoSplat · background removal → 3D reconstruction → align source camera';
  try {
    const source = await reconstruct(reference, text => { $('#loading-text').textContent = text; });
    if (doc.reference?.name !== reference.name) throw new Error('The source image changed; please reconstruct again');
    begin();
    if (doc.source.name !== source.name) doc.shots = [];
    doc.source = source; doc.front = 0; doc.scale = 1; doc.camera = referenceCamera();
    const outputScale = Math.min(1, 1536 / Math.max(reference.width, reference.height));
    doc.width = Math.max(64, Math.round(reference.width * outputScale));
    doc.height = Math.max(64, Math.round(reference.height * outputScale));
    $('#loading-text').textContent = 'Loading 3D subject and source camera';
    await studio.restore(doc);
    doc.conditioning.guide = 'coarse';
    previewVisible = false; studio.setMode('camera');
    changed(); renderShots();
    $('#status').textContent = '3D reconstruction loaded · drag to adjust the camera, then apply';
  } catch (e) {
    doc = previous;
    await studio.restore(doc);
    $('#status').textContent = 'Reconstruction did not finish · you can retry'; throw e;
  } finally { $('#loading').hidden = true; refresh(); schedulePreview(); }
}
$('#reconstruct').onclick = () => run(reconstructPhoto);
$('#extract-coarse').onclick = () => run(reconstructPhoto);
$('#import-glb').onclick = () => $('#glb-file').click();
// The gaussian splat a reconstructed scene came from, whether it is shown itself or as its mesh.
function reconstructedSplat() { return doc.source.kind === 'splat' ? doc.source.name : doc.source.splat || null; }
// Replaces the reconstructed splat by a mesh of it, which can be tilted and edited in the free view.
async function bakeGlb() {
  const source = doc.source;
  if (source.kind !== 'splat') return;
  clearTimeout(previewTimer);
  while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
  const previous = clone(doc);
  $('#loading').hidden = false;
  $('#loading-text').textContent = 'Baking GLB from the reconstruction';
  $('#loading-detail').textContent = 'Local mesh extraction · the splat stays available for export';
  try {
    const mesh = await bakeMesh(source, text => { $('#loading-text').textContent = text; });
    if (doc.source.name !== source.name) throw new Error('The scene changed; please bake again');
    begin();
    // Turn the mesh so that the front view is the source photo's, and keep looking from where the shot was.
    const view = decodeCameraToken(source.camera_token).direction, degrees = radians => radians * 180 / Math.PI;
    const shot = doc.camera;
    doc.source = { ...mesh, kind: 'glb', label: 'TripoSplat · baked mesh', splat: source.name, reference: source.reference };
    doc.front = -degrees(Math.atan2(view.x, view.z)); doc.scale = 1; doc.shots = [];
    doc.camera = { ...defaultScene().camera, azimuth: shot.azimuth, roll: shot.roll || 0,
      elevation: Math.min(89, Math.max(-89, degrees(Math.asin(view.y)) + shot.elevation)),
      focal: Math.min(400, Math.max(8, Math.round(shot.focal ?? nativeFocalLength(source)))) };
    $('#loading-text').textContent = 'Loading baked GLB';
    await studio.restore(doc);
    previewVisible = false; studio.setMode('camera'); studio.fit();
    changed(); renderShots();
    $('#status').textContent = 'GLB baked · tilt and Edit scene are available';
  } catch (e) {
    doc = previous;
    await studio.restore(doc);
    $('#status').textContent = 'GLB bake did not finish · you can retry'; throw e;
  } finally { $('#loading').hidden = true; refresh(); schedulePreview(); }
}
$('#bake-glb').onclick = () => run(bakeGlb);
$('#export-glb').onclick = () => download(assetURL(doc.source.name), 'anyangle-subject.glb');
$('#export-splat').onclick = () => download(assetURL(reconstructedSplat()), 'anyangle-subject.ply');
$('#glb-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const asset = await upload(file); begin();
  const previous = clone(doc); doc.source = { kind: 'glb', ...asset }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
  try { await studio.restore(doc); studio.fit(); } catch (e) { doc = previous; await studio.restore(doc); throw e; }
  changed(); toast('GLB loaded. Adjust front and scale under "Scene & framing".');
});

function askName(title, initial) {
  $('#name-title').textContent = title; $('#name-input').value = initial;
  $('#name-dialog').showModal(); $('#name-input').select();
  return new Promise(resolve => { $('#name-dialog').addEventListener('close', () => resolve($('#name-dialog').returnValue === 'ok' ? $('#name-input').value.trim() : null), { once: true }); });
}
function iconButton(icon, label) { const button = document.createElement('button'); button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label); const image = document.createElement('img'); image.src = `../icons/${icon}.svg`; image.alt = ''; button.append(image); return button; }
function renderShots() {
  $('#shots').replaceChildren(); $('#shot-count').textContent = String(doc.shots.length);
  if (!doc.shots.length) { const note = document.createElement('p'); note.className = 'empty-note'; note.textContent = 'Keep the camera angles you like here. Switching between saved shots only changes the camera.'; $('#shots').append(note); }
  for (const shot of doc.shots) {
    const item = document.createElement('div'); item.className = 'shot';
    const thumb = document.createElement('button'); thumb.className = 'shot-thumb'; thumb.classList.toggle('active', selectedShot === shot.id); thumb.title = `Apply shot ${shot.name}`;
    const image = document.createElement('img'); image.src = shot.thumbnail; image.alt = shot.name; thumb.append(image);
    thumb.onclick = () => { begin(); doc.camera = clone(shot.camera); doc.width = shot.width; doc.height = shot.height; studio.updateShot(); changed(); selectedShot = shot.id; renderShots(); };
    const caption = document.createElement('div'); caption.className = 'shot-caption';
    const rename = document.createElement('button'); rename.className = 'rename'; rename.textContent = shot.name; rename.title = 'Rename shot';
    rename.onclick = async () => { const name = await askName('Rename shot', shot.name); if (name) { begin(); shot.name = name; changed(); renderShots(); } };
    const remove = iconButton('trash', `Delete shot ${shot.name}`); remove.onclick = () => { begin(); doc.shots = doc.shots.filter(s => s.id !== shot.id); changed(); renderShots(); };
    caption.append(rename, remove); item.append(thumb, caption); $('#shots').append(item);
  }
}
$('#save-shot').onclick = async () => {
  const name = await askName('Save current shot', `Shot ${doc.shots.length + 1}`); if (!name) return;
  run(async () => { begin(); const scale = 230 / Math.max(doc.width, doc.height); const thumbnail = await studio.capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
    const shot = { id: crypto.randomUUID(), name, camera: clone(doc.camera), width: doc.width, height: doc.height, thumbnail };
    doc.shots.push(shot); changed(); selectedShot = shot.id; renderShots();
  });
};

function download(data, name) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('#download-guide').onclick = () => run(async () => {
  const png = await captureGuide();
  const blob = await (await fetch(png)).blob();
  const asset = await upload(new File([blob], 'anyangle-guide.png', { type: 'image/png' }));
  download(assetURL(asset.name), 'coarse-guide.png');
  toast('Guide PNG exported');
});

function send(type, payload = {}) { parent.postMessage({ type, session, ...payload }, location.origin); }
function batchRequest(action, payload = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { batchReplies.delete(requestId); reject(new Error('Batch submission was not confirmed; check the ComfyUI queue. This shot will not be resubmitted automatically')); }, 60000);
    batchReplies.set(requestId, { resolve, reject, timer });
    send('anyangle-batch-request', { requestId, action, ...payload });
  });
}
function batchSettings() {
  return { mode: $('#batch-mode').value, start: Number($('#batch-start').value),
    end: Number($('#batch-end').value), step: Number($('#batch-step').value) };
}
function updateBatchPlan() {
  $('#batch-range').hidden = $('#batch-mode').value === 'saved';
  try {
    const plan = cameraBatchPlan(doc, batchSettings());
    $('#batch-count').textContent = `${plan.count} shots · ${$('#batch-mode').value === 'saved' ? 'using saved cameras and sizes' : 'keeping current elevation and framing'} · reusing workflow sampler settings`;
    $('#batch-guides').disabled = false; $('#batch-final').disabled = !embedded;
  } catch (e) {
    $('#batch-count').textContent = e.message; $('#batch-guides').disabled = $('#batch-final').disabled = true;
  }
}
$('#open-batch').onclick = () => { updateBatchPlan(); $('#batch-dialog').showModal(); };
for (const id of ['batch-mode', 'batch-start', 'batch-end', 'batch-step']) $(`#${id}`).oninput = updateBatchPlan;
$('#batch-close').onclick = () => { if (batchRunning) batchController.abort(); else $('#batch-dialog').close(); };
$('#batch-dialog').addEventListener('cancel', event => { if (batchRunning) { event.preventDefault(); batchController.abort(); } });
$('#batch-stop').onclick = () => batchController?.abort();
$('#batch-zip').onclick = () => { if (batchId) download(`/anyangle-studio-iv/batch-guides/${batchId}`, 'anyangle-guides.zip'); };
$('#batch-manifest').onclick = () => download(new Blob([JSON.stringify({ version: 1, kind: 'anyangle-batch', views: batchViews }, null, 2)],
  { type: 'application/json' }), 'anyangle-batch.json');
async function startCameraBatch(queueFinal) {
  clearTimeout(previewTimer);
  const plan = cameraBatchPlan(doc, batchSettings()), original = doc;
  batchRunning = true; batchController = new AbortController(); batchViews = []; batchId = null;
  $('#batch-options').inert = true; $('#batch-stop').disabled = false; $('#batch-close').textContent = 'Stop remaining shots';
  $('#batch-zip').disabled = $('#batch-manifest').disabled = true;
  $('#batch-state').textContent = queueFinal ? 'Preparing the current generation workflow…' : 'Preparing batch coarse guides…';
  try {
    if (queueFinal) await batchRequest('prepare');
    const result = await runCameraBatch(plan, {
      signal: batchController.signal,
      capture: async scene => { doc = scene; studio.doc = doc; studio.updateShot(); return captureGuide(); },
      save: async (scene, png) => {
        const response = await fetch('/anyangle-studio-iv/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene, png }) });
        const saved = await response.json(); if (!response.ok) throw new Error(saved.error || 'Failed to save batch guide'); return saved;
      },
      queue: queueFinal ? async snapshot => (await batchRequest('queue', { snapshot })).prompt_id : null,
      onProgress: ({ index, total, label, phase }) => {
        $('#batch-state').textContent = phase === 'capture' ? `Rendering ${index + 1} / ${total} · ${label}`
          : `${phase === 'queued' ? 'Queued' : 'Saved'} ${index} / ${total} · ${label}`;
      },
    });
    batchViews = result.views;
    const queued = batchViews.filter(view => view.prompt_id).length;
    $('#batch-state').textContent = `${result.error ? 'Submission aborted' : result.stopped ? 'Remaining shots stopped' : 'Batch ready'} · ${batchViews.length} coarse guides${queueFinal ? ` · ${queued} generation jobs queued` : ''}`;
    if (result.error) error(result.error);
    if (batchViews.length) {
      $('#batch-manifest').disabled = false;
      const response = await fetch('/anyangle-studio-iv/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views: batchViews }) });
      const saved = await response.json(); if (!response.ok) throw new Error(saved.error || 'Failed to save batch manifest');
      batchId = saved.id; $('#batch-zip').disabled = false;
    }
  } catch (e) { $('#batch-state').textContent = e.message; throw e; }
  finally {
    doc = original; studio.doc = doc; studio.updateShot();
    batchRunning = false; $('#batch-options').inert = false; $('#batch-stop').disabled = true;
    $('#batch-close').textContent = 'Close'; refresh(); updateBatchPlan();
  }
}
$('#batch-guides').onclick = () => run(() => startCameraBatch(false));
$('#batch-final').onclick = () => run(() => startCameraBatch(true));
$('#cancel').onclick = () => { if (embedded) send('anyangle-close'); else location.reload(); };
$('#apply').onclick = () => run(async () => {
  clearTimeout(previewTimer);
  const frozen = clone(doc), appliedRevision = revision;
  const png = await captureGuide();
  const response = await fetch('/anyangle-studio-iv/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: frozen, png }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Save failed');
  if (revision !== appliedRevision) throw new Error('The scene changed while saving; please apply again');
  snapshot = result;
  if (embedded) send('anyangle-apply', { snapshot: result, revision: appliedRevision });
  else { const url = new URL(location.href); url.searchParams.set('snapshot', result.id); history.replaceState(null, '', url); toast('Snapshot saved; it can be loaded in the ComfyUI node'); }
  $('#status').textContent = embedded ? 'Snapshot saved · applying to node' : 'Scene snapshot saved'; $('#status').dataset.state = embedded ? 'dirty' : 'saved';
});

async function start(token, reference = { connected: false }, needsWiring = false) {
  try {
    if (token?.id) {
      const response = await fetch(`/anyangle-studio-iv/snapshots/${encodeURIComponent(token.id)}`);
      const saved = await response.json().catch(() => ({}));
      if (response.ok) { doc = saved.scene; snapshot = token; }
      else if (response.status === 404) toast('The last applied scene is not on this machine; starting with an empty scene · reconstruct the subject or import a GLB, then apply');
      else throw new Error(saved.error || `Failed to read snapshot (HTTP ${response.status})`);
    }
    doc.conditioning = { ...defaultScene().conditioning, ...doc.conditioning };
    // Snapshots from the upstream node may use a pose/depth/canny guide or the mannequin; fall back to the coarse 3D guide.
    if (doc.conditioning.guide !== 'coarse') Object.assign(doc.conditioning, { guide: 'coarse', map: null, mapKind: null, mapOrigin: null });
    if (doc.source.kind === 'human') doc.source = { kind: 'empty' };
    // Splats and meshes live in ComfyUI's temp folder, which is cleared when ComfyUI restarts.
    let splatCamera = null;
    if (doc.source.name && !(await fetch(`/anyangle-studio-iv/assets/${encodeURIComponent(doc.source.name)}`, { method: 'HEAD' })).ok) {
      if (doc.source.kind === 'splat') splatCamera = { camera: doc.camera, width: doc.width, height: doc.height, shots: doc.shots, source: doc.source.name };
      const baked = doc.source.kind === 'glb' && doc.source.splat;
      doc.source = { kind: 'empty' };
      toast(baked ? 'The 3D data of this scene was cleared when ComfyUI restarted · it is reconstructed again; bake the GLB once more if you need it'
        : 'The 3D data of this scene was cleared when ComfyUI restarted · reconstruct the subject or import the GLB again');
    }
    linkedReference = reference;
    unwiredAnyAngle = needsWiring;
    const referenceChanged = reference.connected && !!reference.asset && reference.asset.name !== doc.reference?.name;
    if (reference.connected) doc.reference = reference.asset || null;
    if (reconstructedSplat() && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
    studio = new StudioScene($('#viewport'), { begin, change: changed, camera: () => { autoFrame(); revision++; refresh(); schedulePreview(); $('#status').textContent = 'Camera draft · not applied yet'; $('#status').dataset.state = 'dirty'; }, error });
    await studio.init(doc);
    selectedShot = doc.shots.find(shot => shot.width === doc.width && shot.height === doc.height
      && Object.keys(doc.camera).every(key => Number(shot.camera[key] || 0) === Number(doc.camera[key] || 0)))?.id || null;
    ready = true; $('#loading').hidden = true; refresh(); renderShots();
    $('#status').textContent = snapshot ? 'Loaded the last applied scene' : 'Connect or upload a source image to reconstruct the 3D subject';
    $('#status').dataset.state = snapshot ? 'saved' : 'dirty';
    if (referenceChanged) { $('#status').textContent = 'Connected source image updated · apply to save it to the scene'; $('#status').dataset.state = 'dirty'; }
    setBusy(false); await renderPreview();
    if (doc.reference && doc.source.kind === 'empty') await run(reconstructPhoto);
    // The same photo gives the same reconstruction, so the applied shot fits it again.
    if (splatCamera && doc.source.name === splatCamera.source) {
      Object.assign(doc, { camera: splatCamera.camera, width: splatCamera.width, height: splatCamera.height, shots: splatCamera.shots });
      studio.updateShot(true); refresh(); renderShots(); schedulePreview();
    }
  } catch (e) { $('#loading-text').textContent = e.message || String(e); error(e); }
}
function readPendingReference() {
  if (busy || !pendingReference) return;
  const reference = pendingReference; pendingReference = null;
  run(async () => {
    const sameAsset = !!reference.asset && reference.asset.name === doc.reference?.name;
    linkedReference = reference;
    if (reference.error) toast(reference.error);
    if (sameAsset) { refresh(); return; }
    begin(); doc.reference = reference.asset || null;
    if (reconstructedSplat()) doc.source = { kind: 'empty' };
    await studio.restore(doc); changed();
    if (doc.reference && doc.source.kind === 'empty') await reconstructPhoto();
  });
}
if (embedded) {
  let started = false;
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.session !== session) return;
    if (event.data.type === 'anyangle-load' && !started) {
      started = true; start(event.data.snapshot, event.data.reference, event.data.unwiredAnyAngle);
    } else if (event.data.type === 'anyangle-reference' && ready) {
      pendingReference = event.data.reference; readPendingReference();
    } else if (event.data.type === 'anyangle-batch-reply') {
      const pending = batchReplies.get(event.data.requestId);
      if (pending) {
        clearTimeout(pending.timer); batchReplies.delete(event.data.requestId);
        if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
      }
    } else if (event.data.type === 'anyangle-apply-error') {
      $('#status').textContent = 'Not applied to the node yet'; $('#status').dataset.state = 'dirty'; toast(event.data.message);
    }
  });
  send('anyangle-ready');
} else {
  $('#apply').lastChild.textContent = 'Save scene'; $('#cancel').textContent = 'Reload';
  start(params.has('snapshot') ? { version: 1, id: params.get('snapshot') } : null);
}
window.addEventListener('pagehide', () => {
  batchController?.abort();
  for (const pending of batchReplies.values()) { clearTimeout(pending.timer); pending.reject(new Error('Workbench closed')); }
  batchReplies.clear(); clearTimeout(previewTimer); studio?.dispose();
});
