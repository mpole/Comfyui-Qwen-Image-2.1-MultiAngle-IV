// Work from ComfyUI's executable graph so reroutes and bypassed nodes resolve normally.
export function referencePlan(output, nodeId, inputName = 'reference_image') {
  const link = output[String(nodeId)]?.inputs?.[inputName];
  if (!link) return null;
  const upstream = {};
  function visit(id) {
    id = String(id);
    if (upstream[id]) return;
    const node = output[id];
    if (!node) throw new Error('The upstream node of the source image cannot be executed; check the connections');
    upstream[id] = node;
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]) && output[value[0]]) visit(value[0]);
    }
  }
  visit(link[0]);
  const source = output[link[0]];
  const filename = source.class_type === 'LoadImage' && link[1] === 0 && typeof source.inputs.image === 'string' ? source.inputs.image : null;
  return { link, upstream, filename, signature: JSON.stringify({ link, upstream }) };
}

export function imageViewURL(filename, type = 'input', subfolder = '') {
  const annotated = filename.match(/ \[(input|output|temp)\]$/);
  if (annotated) { type = annotated[1]; filename = filename.slice(0, -annotated[0].length); }
  return '/view?' + new URLSearchParams({ filename, type, subfolder });
}

export async function importReference(url) {
  if (typeof url !== 'string') throw new Error('Invalid source image URL');
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || target.pathname !== '/view' || target.username || target.password)
    throw new Error('Source images must be served by this ComfyUI instance');
  const image = await fetch(target.href, { cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  if (!image.ok) throw new Error('Could not read the connected source image; check the upstream file');
  const form = new FormData(); form.append('file', await image.blob(), 'reference.png');
  const response = await fetch('/anyangle-studio-iv/assets', { method: 'POST', body: form });
  const asset = await response.json();
  if (!response.ok) throw new Error(asset.error || 'Source image import failed');
  return asset;
}

export async function executeReference(plan, isActive) {
  const previewId = 'anyangle_reference_' + crypto.randomUUID();
  const prompt = { ...plan.upstream, [previewId]: { class_type: 'PreviewImage', inputs: { images: plan.link } } };
  const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
  const queued = await response.json();
  if (!response.ok) throw new Error(queued.error?.message || 'Upstream image execution failed; check the upstream nodes');
  let polls = 0;
  while (isActive()) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(`/history/${encodeURIComponent(queued.prompt_id)}`);
    if (!response.ok) throw new Error('Could not read the upstream result; please read again');
    const item = (await response.json())[queued.prompt_id];
    if (!item) {
      if (++polls % 5 === 0) {
        const queueResponse = await fetch('/queue');
        if (!queueResponse.ok) throw new Error('Could not read the execution queue; please read again');
        const queue = await queueResponse.json();
        if (![...queue.queue_running, ...queue.queue_pending].some(entry => entry[1] === queued.prompt_id)) {
          // A completed job may have moved into history between these requests.
          const final = await fetch(`/history/${encodeURIComponent(queued.prompt_id)}`);
          if (!(await final.json())[queued.prompt_id]) throw new Error('The upstream job was removed from the queue; please read again');
        }
      }
      continue;
    }
    if (item.status?.status_str === 'error') {
      const detail = item.status.messages?.find(([type]) => type === 'execution_error')?.[1];
      throw new Error(detail?.exception_message || 'Upstream execution failed or was cancelled');
    }
    const image = item.outputs?.[previewId]?.images?.[0];
    if (image) return importReference(imageViewURL(image.filename, image.type, image.subfolder));
    throw new Error('Upstream produced no usable image');
  }
  return null;
}
