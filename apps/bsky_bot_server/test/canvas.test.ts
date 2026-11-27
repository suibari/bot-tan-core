import assert from 'node:assert/strict';
import test from 'node:test';
import { textToImageBufferWithBackground } from '../src/util/canvas.js';

test('diary images render accented and stylized display names with fallback fonts', async () => {
  const [accented, combining, plain, stylized, missing] = await Promise.all(
    ['é', 'e\u0301', 'e', '𝒜', '\u{10FFFF}'].map(text => textToImageBufferWithBackground(text)),
  );

  assert.ok(!accented.equals(missing), 'the accented letter should have a glyph');
  assert.ok(!accented.equals(plain), 'the accent should be visible');
  assert.deepEqual(combining, accented);
  assert.ok(!stylized.equals(missing), 'the stylized letter should have a glyph');
});
