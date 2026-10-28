export function reconstructionGraph(reference, models, seed = 46) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  return {
    '1': node('LoadImage', { image: `anyangle_studio_iv/${reference.name}` }),
    '2': node('LoadBackgroundRemovalModel', { bg_removal_name: models.background_removal }),
    '3': node('RemoveBackground', { bg_removal_model: ['2', 0], image: ['1', 0] }),
    '4': node('TripoSplatPreprocessImage', { image: ['1', 0], mask: ['3', 0], erode_radius: 1, size: 1024 }),
    '5': node('CLIPVisionLoader', { clip_name: models.clip_vision }),
    '6': node('VAELoader', { vae_name: models.vae_encoder }),
    '7': node('TripoSplatConditioning', { clip_vision: ['5', 0], vae: ['6', 0], image: ['4', 0] }),
    '8': node('UNETLoader', { unet_name: models.diffusion_models, weight_dtype: 'default' }),
    '9': node('KSampler', { model: ['8', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2],
      seed, steps: 20, cfg: 3, sampler_name: 'dpmpp_2m', scheduler: 'simple', denoise: 1 }),
    '10': node('VAELoader', { vae_name: models.vae_decoder }),
    '11': node('VAEDecodeTripoSplat', { samples: ['9', 0], vae: ['10', 0], num_gaussians: 262144, seed }),
    '12': node('AnyAngleReconstructionOutputIV', { splat: ['11', 0], samples: ['9', 0], reference: ['1', 0], prepared: ['4', 0], mask: ['3', 0] }),
  };
}

const MODEL_SELECTION_KEY = 'anyangle-iv-reconstruction.models.v1';

export function selectedReconstructionModels() {
  try {
    const selected = JSON.parse(localStorage.getItem(MODEL_SELECTION_KEY));
    if (selected && typeof selected === 'object' && !Array.isArray(selected)) return selected;
  } catch { /* Use automatic discovery if browser preferences are unavailable. */ }
  return {};
}

export async function reconstructionConfig(selections = selectedReconstructionModels()) {
  const query = new URLSearchParams(selections).toString();
  const response = await fetch('/anyangle-studio-iv/reconstruction-config' + (query ? `?${query}` : ''));
  const config = await response.json();
  if (!response.ok) throw new Error(config.error || 'Could not check the local reconstruction models; make sure the ComfyUI server is running');
  return config;
}

export async function saveReconstructionModels(selections) {
  const config = await reconstructionConfig(selections);
  localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify(selections));
  return config;
}

export async function reconstruct(reference, onProgress, retryStaleJob = true) {
  const selections = selectedReconstructionModels();
  const suffix = Object.keys(selections).length ? ':' + JSON.stringify(Object.fromEntries(Object.entries(selections).sort())) : '';
  const key = `anyangle-iv-reconstruction:${reference.name}${suffix}`;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* Ignore an incomplete browser save. */ }
  if (cached?.source?.reference?.name === reference.name) {
    const existing = await fetch(`/anyangle-studio-iv/assets/${encodeURIComponent(cached.source.name)}`, { method: 'HEAD' });
    if (existing.ok) return cached.source;
    localStorage.removeItem(key); cached = null;
  }
  const config = await reconstructionConfig(selections);
  if (!config.available) {
    const hint = Object.keys(config.ambiguous || {}).length ? 'Multiple files with the same name were found; choose manually under "Reconstruction models" on the left.'
      : 'Select compatible weights under "Reconstruction models" on the left, or run install_reconstruction.py in the node folder.';
    throw new Error(`Local reconstruction models missing or not selected: ${config.missing.join(', ')}. ${hint}`);
  }
  let job = typeof cached === 'string' ? cached : cached?.job;
  if (!job) {
    const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: reconstructionGraph(reference, config.models), client_id: crypto.randomUUID() }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || JSON.stringify(result.node_errors) || 'Failed to submit the reconstruction job');
    job = result.prompt_id; localStorage.setItem(key, JSON.stringify({ job }));
  }
  const started = Date.now();
  for (;;) {
    const historyResponse = await fetch(`/history/${encodeURIComponent(job)}`);
    if (!historyResponse.ok) throw new Error('Could not read the reconstruction result; check the ComfyUI server');
    const item = (await historyResponse.json())[job];
    const result = item?.outputs?.['12']?.anyangle_reconstruction?.[0];
    if (result) {
      localStorage.setItem(key, JSON.stringify({ source: result.source }));
      return result.source;
    }
    if (item?.status?.status_str === 'error') {
      localStorage.removeItem(key);
      const detail = item.status.messages?.find(([type]) => type === 'execution_error')?.[1];
      throw new Error(detail?.exception_message || 'TripoSplat reconstruction failed');
    }
    const queueResponse = await fetch('/queue');
    if (!queueResponse.ok) throw new Error('Could not read the reconstruction queue; check the ComfyUI server');
    const queue = await queueResponse.json();
    const running = queue.queue_running.some(entry => entry[1] === job);
    const pending = queue.queue_pending.some(entry => entry[1] === job);
    if (!running && !pending && !item && Date.now() - started > 5000) {
      localStorage.removeItem(key);
      if (retryStaleJob) return reconstruct(reference, onProgress, false);
      throw new Error('The reconstruction job was removed; please reconstruct again');
    }
    onProgress(running ? `Reconstructing subject from the source image · ${Math.round((Date.now() - started) / 1000)} s` : 'Reconstruction job queued');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

// Extracts a mesh from a reconstructed splat on request. Free view editing and tilt need a mesh,
// but a GLB is several times larger than its splat, so it is not made for every reconstruction.
export async function bakeMesh(source, onProgress) {
  const key = `anyangle-iv-mesh:${source.name}`;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* Ignore an incomplete browser save. */ }
  if (cached?.name) {
    const existing = await fetch(`/anyangle-studio-iv/assets/${encodeURIComponent(cached.name)}`, { method: 'HEAD' });
    if (existing.ok) return cached;
    localStorage.removeItem(key);
  }
  const graph = { '1': { class_type: 'AnyAngleBakeMeshIV', inputs: { splat: source.name, resolution: 384, kernel: 5, level: 0.6, color_sharpen: 2 } } };
  const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID() }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || JSON.stringify(result.node_errors) || 'Failed to submit the GLB bake job');
  const job = result.prompt_id, started = Date.now();
  for (;;) {
    const historyResponse = await fetch(`/history/${encodeURIComponent(job)}`);
    if (!historyResponse.ok) throw new Error('Could not read the bake result; check the ComfyUI server');
    const item = (await historyResponse.json())[job];
    const mesh = item?.outputs?.['1']?.anyangle_mesh?.[0];
    if (mesh) { localStorage.setItem(key, JSON.stringify(mesh)); return mesh; }
    if (item?.status?.status_str === 'error') {
      const detail = item.status.messages?.find(([type]) => type === 'execution_error')?.[1];
      throw new Error(detail?.exception_message || 'Baking the GLB failed');
    }
    const queueResponse = await fetch('/queue');
    if (!queueResponse.ok) throw new Error('Could not read the bake queue; check the ComfyUI server');
    const queue = await queueResponse.json();
    const running = queue.queue_running.some(entry => entry[1] === job);
    if (!running && !queue.queue_pending.some(entry => entry[1] === job) && !item && Date.now() - started > 5000)
      throw new Error('The bake job was removed; please bake again');
    onProgress(running ? `Baking GLB from the reconstruction \u00b7 ${Math.round((Date.now() - started) / 1000)} s` : 'Bake job queued');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
