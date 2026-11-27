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

test('image rendering rejects oversized text before opening the background', async () => {
  const text = 'An ordinary diary sentence.\n'.repeat(320);
  await assert.rejects(
    textToImageBufferWithBackground(text, './img/missing-test-background.png'),
    { name: 'RangeError', message: 'Image text exceeds the rendering limit' },
  );
});

test('image rendering replaces an oversized grapheme and keeps adjacent text', async () => {
  const largeGrapheme = 'e' + '\u0301'.repeat(48);
  const [bounded, expected] = await Promise.all(
    [`日記: ${largeGrapheme} と名前\n\n2026/11/27`, '日記: \uFFFD と名前\n\n2026/11/27']
      .map(text => textToImageBufferWithBackground(text)),
  );
  assert.deepEqual(bounded, expected);
});
