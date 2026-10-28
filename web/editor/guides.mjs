export const PROMPTS = {
  anyangle: 'Change the camera angle from <image2> to <image1>.',
  coarse: 'Use <image1> as the identity, clothing and style reference. Recreate the same subject at the camera angle and composition shown by <image2>.',
};

export function guidePrompt(conditioning) {
  return conditioning?.model === 'base' ? PROMPTS.coarse : PROMPTS.anyangle;
}
