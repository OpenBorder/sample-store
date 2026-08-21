import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('the public drawer requests a quote only after an explicit final-total action', async () => {
  const [script, page] = await Promise.all([
    readFile(join(process.cwd(), 'public/checkout.js'), 'utf8'),
    readFile(join(process.cwd(), 'public/index.html'), 'utf8'),
  ]);

  assert.match(page, /id="review-total"[^>]*type="button"/);
  for (const id of ['email', 'name', 'line1', 'city', 'postal_code', 'country']) {
    assert.match(page, new RegExp(`id="${id}"[^>]*required`));
  }

  const quoteRequests = script.match(/fetch\('\/quote'/g) ?? [];
  assert.equal(quoteRequests.length, 1);
  assert.match(script, /\$\('review-total'\)\.addEventListener\('click', reviewOrderTotal\)/);
  assert.match(script, /if \(state\.quoteToken\) return;/);
  assert.match(script, /setQuoteAction\('Final total locked', true\)/);
  assert.doesNotMatch(script, /refreshQuote\(\)\.then/);

  const updateDrawer = script.match(/function updateDrawer\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const buyerChange = script.match(/function onBuyerDetailChange\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(updateDrawer, /refreshQuote/);
  assert.doesNotMatch(buyerChange, /refreshQuote/);
});
