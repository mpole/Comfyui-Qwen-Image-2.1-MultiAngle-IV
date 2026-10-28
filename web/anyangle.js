import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import { referencePlan, executeReference } from './reference.mjs?v=20261004g7';
import { promptForSnapshot } from './batch-queue.mjs?v=20261004g7';

let graphRevision = 0;
let closeActive = null;
const extensionURL = new URL('./editor/index.html', import.meta.url);

function openEditor(node, widget) {
  closeActive?.();
  const session = crypto.randomUUID(), graph = app.graph, revision = graphRevision, initial = widget.value;
  const dialog = document.createElement('dialog');
  Object.assign(dialog.style, { width: 'min(1600px, 97vw)', height: '94vh', maxWidth: 'none', maxHeight: 'none', padding: '0', border: '1px solid #3a5265', borderRadius: '12px', background: '#101920', overflow: 'hidden' });
  const frame = document.createElement('iframe');
  const url = new URL(extensionURL); url.searchParams.set('session', session);
  frame.src = url; frame.title = 'AnyAngle Studio · 3D camera editor';
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  dialog.append(frame); document.body.append(dialog);
  let active = true;
  let reference = { connected: false }, referenceSignature = null, readingReference = false;
  let batchGraph = null;
  const batchRequests = new Map();
  const unwiredAnyAngleLoader = () => {
    const strength = node.outputs?.find(output => output.name === 'anyangle_lora_strength');
    return graph._nodes.some(candidate => {
      if (!['LoraLoaderModelOnly', 'AnyAngleOptionalLoRAIV'].includes(candidate.type)
          || !candidate.outputs?.some(output => output.name === 'MODEL' && output.links?.length)) return false;
      const filename = candidate.widgets?.find(item => item.name === 'lora_name')?.value;
      if (!/anyangle/i.test(String(filename || ''))) return false;
      const input = candidate.inputs?.find(item => item.name === 'strength_model');
      return !input?.link || !strength?.links?.includes(input.link);
    });
  };
  const send = (type, payload = {}) => { if (valid()) frame.contentWindow.postMessage({ type, session, ...payload }, location.origin); };
  const getPlan = async () => {
    const { output } = await app.graphToPrompt();
    const plan = referencePlan(output, node.id);
    if (!plan && node.inputs?.find(input => input.name === 'reference_image')?.link != null) throw new Error('Could not resolve the source image connection; check whether the upstream node is bypassed');
    return plan;
  };
  const readReference = async (execute = false) => {
    if (readingReference) return;
    readingReference = true;
    const previous = reference, previousSignature = referenceSignature;
    const connected = node.inputs?.find(input => input.name === 'reference_image')?.link != null;
    let sameSignature = false;
    reference = { connected, pending: true, ...(connected && previous.asset ? { asset: previous.asset } : {}) };
    try {
      const plan = await getPlan();
      sameSignature = !!plan && plan.signature === previousSignature;
      referenceSignature = plan?.signature || null;
      if (!plan) reference = { connected: false };
      else if (plan.filename || execute) {
        if (!sameSignature) reference = { connected: true, pending: true };
        send('anyangle-reference', { reference: { ...reference, message: plan.filename ? 'Reading connected source image…' : 'Running the upstream nodes of the source image…' } });
        // Use ComfyUI's decoder for direct images too: JPEG decoding can differ
        // from browser/Pillow import even when the filename ends in .png.
        const asset = await executeReference(plan, valid);
        if (!valid()) return;
        if ((await getPlan())?.signature !== plan.signature) throw new Error('Upstream changed; please read the image again');
        reference = { connected: true, asset, message: 'From IMAGE connection · using the first image' };
      } else reference = { connected: true, message: 'Click "Read upstream image" to run the nodes needed to obtain the source image' };
    } catch (error) {
      reference = { connected, ...(sameSignature && previous.asset ? { asset: previous.asset } : {}),
        pending: false, error: error.message, message: error.message };
    }
    finally { readingReference = false; }
  };
  const close = () => { if (!active) return; active = false; window.removeEventListener('message', receive); dialog.remove(); if (closeActive === close) closeActive = null; };
  const valid = () => active && app.graph === graph && graphRevision === revision && graph.getNodeById(node.id) === node && widget.value === initial;
  const validateSnapshot = async token => {
    if (token?.version !== 1 || !/^[a-f0-9]{64}$/.test(token.id)) throw new Error('Invalid scene snapshot');
    if (((await getPlan())?.signature || null) !== referenceSignature) throw new Error('Upstream changed; reopen the workbench to read the source image');
    const response = await fetch(`/anyangle-studio-iv/snapshots/${token.id}`);
    if (!response.ok) throw new Error('Could not verify the saved scene; please apply again');
    const saved = await response.json(), scene = saved.scene, settings = scene.conditioning || {};
    if (settings.model === 'base' && unwiredAnyAngleLoader())
      throw new Error('The AnyAngle LoRA strength in this workflow is still fixed. Connect the Studio anyangle_lora_strength output, or remove that loader.');
    if (reference.connected && scene.reference?.name !== reference.asset?.name) throw new Error('The source image changed; read it again and reconstruct the subject');
    if (!valid()) throw new Error('The workflow changed; please reopen the workbench');
  };
  const receive = async event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.session !== session) return;
    if (!valid()) { close(); return; }
    if (event.data.type === 'anyangle-ready') {
      let snapshot = null; try { snapshot = initial ? JSON.parse(initial) : null; } catch { /* New editor can replace a damaged widget. */ }
      await readReference();
      send('anyangle-load', { snapshot, reference, unwiredAnyAngle: unwiredAnyAngleLoader() });
    } else if (event.data.type === 'anyangle-read-reference') {
      await readReference(true); send('anyangle-reference', { reference });
    } else if (event.data.type === 'anyangle-close') close();
    else if (event.data.type === 'anyangle-batch-request') {
      const requestId = event.data.requestId;
      if (typeof requestId !== 'string' || requestId.length > 100) return;
      if (!batchRequests.has(requestId)) batchRequests.set(requestId, (async () => {
        if (event.data.action === 'prepare') {
          batchGraph = await app.graphToPrompt();
          if (!batchGraph.output[String(node.id)] || !node.outputs?.find(output => output.name === 'guide_image_2')?.links?.length)
            throw new Error('Connect the Studio guide_image_2 output into the current generation workflow');
          return {};
        }
        if (event.data.action !== 'queue' || !batchGraph) throw new Error('Prepare the batch workflow first');
        await validateSnapshot(event.data.snapshot);
        const result = await api.queuePrompt(0, promptForSnapshot(batchGraph, node.id, event.data.snapshot));
        if (!result.prompt_id) throw new Error('Submission returned no job id; check the ComfyUI queue');
        return { prompt_id: result.prompt_id };
      })());
      try { send('anyangle-batch-reply', { requestId, result: await batchRequests.get(requestId) }); }
      catch (error) { send('anyangle-batch-reply', { requestId, error: error.message }); }
    }
    else if (event.data.type === 'anyangle-apply') {
      const token = event.data.snapshot;
      if (token?.version !== 1 || !/^[a-f0-9]{64}$/.test(token.id) || !Number.isInteger(event.data.revision)) return;
      try {
        await validateSnapshot(token);
        if (!valid()) return;
        widget.value = JSON.stringify(token); widget.callback?.(widget.value);
        app.graph.setDirtyCanvas(true, true); close();
      } catch (error) { send('anyangle-apply-error', { message: error.message }); }
    }
  };
  window.addEventListener('message', receive);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  closeActive = close; dialog.showModal();
}

app.registerExtension({
  name: 'IV.AnyAngleStudio',
  afterConfigureGraph() {
    graphRevision++; closeActive?.();
    for (const node of app.graph._nodes) {
      if (node.comfyClass === 'AnyAngleStudioIV') {
        if (!node.inputs?.some(input => input.name === 'reference_image')) node.addInput('reference_image', 'IMAGE');
        // The upstream node had a structure_image input for pose/depth/canny guides.
        const structureSlot = node.findInputSlot('structure_image');
        if (structureSlot >= 0) node.removeInput(structureSlot);
        if (!node.outputs?.some(output => output.name === 'anyangle_lora_strength')) node.addOutput('anyangle_lora_strength', 'FLOAT');
      }
    }
  },
  async beforeRegisterNodeDef(nodeType, data) {
    if (data.name !== 'AnyAngleStudioIV') return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      const widget = this.widgets.find(w => w.name === 'snapshot');
      widget.type = 'converted-widget'; widget.computeSize = () => [0, -4];
      if (widget.inputEl) widget.inputEl.style.display = 'none';
      this.addWidget('button', 'Open AnyAngle Studio', null, () => openEditor(this, widget));
      this.color = '#173847'; this.bgcolor = '#111e28'; this.size = [345, 130];
      const removed = this.onRemoved;
      this.onRemoved = function () { closeActive?.(); removed?.apply(this, arguments); };
    };
  },
});
