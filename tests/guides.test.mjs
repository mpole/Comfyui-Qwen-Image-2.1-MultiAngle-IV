import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guidePrompt, PROMPTS } from '../web/editor/guides.mjs';

test('the base model changes the edit instruction without changing image roles', () => {
  assert.equal(guidePrompt({ model: 'anyangle', guide: 'coarse' }), PROMPTS.anyangle);
  const prompt = guidePrompt({ model: 'base', guide: 'coarse' });
  assert.match(prompt, /<image1>/);
  assert.match(prompt, /<image2>/);
  assert.notEqual(prompt, PROMPTS.anyangle);
});
