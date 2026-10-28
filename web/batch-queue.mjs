export function promptForSnapshot(compiled, nodeId, snapshot) {
  if (snapshot?.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.id)) throw new Error('Invalid batch scene snapshot');
  const prompt = structuredClone(compiled), id = String(nodeId);
  if (prompt.output[id]?.class_type !== 'AnyAngleStudioIV') throw new Error('The Studio node is not part of the executable workflow');
  const value = JSON.stringify(snapshot);
  prompt.output[id].inputs.snapshot = value;
  const node = prompt.workflow.nodes.find(node => String(node.id) === id);
  if (!node) throw new Error('The workflow has no Studio node; please reopen the workbench');
  node.widgets_values[0] = value;
  return prompt;
}
