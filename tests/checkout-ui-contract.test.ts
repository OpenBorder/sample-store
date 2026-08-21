import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';

type Listener = (event: { target: FakeElement }) => unknown;

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string) { this.values.add(value); }
  remove(value: string) { this.values.delete(value); }
  contains(value: string) { return this.values.has(value); }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  children: FakeElement[] = [];
  className = '';
  disabled = false;
  hidden = false;
  innerHTML = '';
  textContent = '';
  value = '';

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  appendChild(child: FakeElement) { this.children.push(child); }
  checkValidity() { return this.value.length > 0; }
  focus() {}
  reportValidity() {}
  replaceChildren(...children: FakeElement[]) { this.children = children; }
  setAttribute() {}

  async dispatch(type: string, force = false) {
    if (this.disabled && !force) return;
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ target: this });
    }
  }
}

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
  assert.match(script, /if \(state\.quoteAttempted \|\| state\.quoteToken\) return;/);
  assert.match(script, /setQuoteAction\('Final total locked', true\)/);
  assert.doesNotMatch(script, /refreshQuote\(\)\.then/);

  const updateDrawer = script.match(/function updateDrawer\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const buyerChange = script.match(/function onBuyerDetailChange\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(updateDrawer, /refreshQuote/);
  assert.doesNotMatch(buyerChange, /refreshQuote/);
});

test('an in-flight quote locks all controls and rejects a stale response after a forced edit', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    let current = elements.get(id);
    if (!current) {
      current = new FakeElement();
      if (id === 'country') current.value = 'US';
      if (['nav-ccy', 'pdp-ccy', 'drawer-ccy'].includes(id)) current.value = 'USD';
      elements.set(id, current);
    }
    return current;
  };

  let checkoutCounter = 0;
  let quoteCalls = 0;
  let resolveQuote!: (response: { json(): Promise<unknown> }) => void;
  const quoteResponse = new Promise<{ json(): Promise<unknown> }>((resolve) => {
    resolveQuote = resolve;
  });
  const document = {
    addEventListener() {},
    createElement: () => new FakeElement(),
    getElementById: element,
    querySelectorAll: () => [] as FakeElement[],
  };
  const window = { addEventListener() {}, scrollTo() {} };
  const context = createContext({
    console,
    crypto: { randomUUID: () => `checkout-${++checkoutCounter}` },
    document,
    fetch: async () => {
      quoteCalls += 1;
      return quoteResponse;
    },
    Intl,
    location: { hash: '#/product/hoodie' },
    OB_CONFIG: {
      apiBaseUrl: 'https://mock.invalid',
      publishableKey: 'browser-contract-key',
      transactionsEnabled: true,
    },
    OpenBorder: () => ({
      mount: () => ({ unmount() {} }),
    }),
    window,
  });
  new Script(source).runInContext(context);

  await element('pdp-add').dispatch('click');
  for (const [id, value] of Object.entries({
    email: 'buyer@example.invalid',
    name: 'Browser Contract',
    line1: '1 Test Street',
    city: 'Test City',
    postal_code: '94105',
  })) {
    element(id).value = value;
  }

  const review = element('review-total').dispatch('click');
  await Promise.resolve();
  assert.equal(quoteCalls, 1);
  for (const id of [
    'email',
    'name',
    'line1',
    'city',
    'postal_code',
    'country',
    'nav-ccy',
    'pdp-ccy',
    'drawer-ccy',
  ]) {
    assert.equal(element(id).disabled, true, `${id} must lock before provider quote I/O`);
  }

  element('country').value = 'CA';
  await element('country').dispatch('change', true);
  resolveQuote({
    json: async () => ({
      ok: true,
      domestic: false,
      quoteToken: 'stale.browser-contract',
      amount_breakdown: {
        subtotal: 4200,
        shipping: 0,
        tax: 840,
        duty: 210,
        total: 5250,
        currency: 'USD',
      },
    }),
  });
  await review;

  assert.equal(element('review-total').textContent, 'Quote invalidated — close and restart');
  assert.equal(element('review-total').disabled, true);
  await element('review-total').dispatch('click', true);
  assert.equal(quoteCalls, 1, 'the invalidated drawer must never issue a second quote');
});
