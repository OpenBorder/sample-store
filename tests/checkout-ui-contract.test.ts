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

interface FakeResponse {
  json(): Promise<unknown>;
}

interface MountedPaymentOptions {
  onSuccess(input: { paymentMethodId: string }): Promise<void>;
}

interface CheckoutRequestBody {
  checkoutId?: string;
  currency?: string;
  amount?: number;
  address?: { country?: string };
}

function createCheckoutRuntime(
  source: string,
  fetch: (url: string, init?: { body?: string }) => Promise<FakeResponse>,
) {
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
  let mountedPayment: MountedPaymentOptions | undefined;
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
    fetch,
    Intl,
    location: { hash: '#/product/hoodie' },
    OB_CONFIG: {
      apiBaseUrl: 'https://mock.invalid',
      publishableKey: 'browser-contract-key',
      transactionsEnabled: true,
    },
    OpenBorder: () => ({
      mount: (_selector: string, options: MountedPaymentOptions) => {
        mountedPayment = options;
        return { unmount() {} };
      },
    }),
    window,
  });
  new Script(source).runInContext(context);
  return {
    element,
    mountedPayment: () => {
      assert.ok(mountedPayment);
      return mountedPayment;
    },
  };
}

async function openCompletedBuyerForm(element: (id: string) => FakeElement) {
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
}

test('the public drawer requests a quote only after an explicit final-total action', async () => {
  const [script, page, manifestSource] = await Promise.all([
    readFile(join(process.cwd(), 'public/checkout.js'), 'utf8'),
    readFile(join(process.cwd(), 'public/index.html'), 'utf8'),
    readFile(join(process.cwd(), 'package.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource) as { dependencies: Record<string, string> };

  assert.match(page, /id="review-total"[^>]*type="button"/);
  assert.match(page, /Charge currency/);
  assert.match(page, /Ship-to destination/);
  assert.match(page, /does not determine duties or taxes/);
  assert.match(page, /determines duties and taxes/);
  assert.match(
    page,
    new RegExp(
      `unpkg\\.com/@open-border/js@${manifest.dependencies['@open-border/node'].replaceAll('.', '\\.')}"`,
    ),
  );
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

test('Germany ship-to destination and USD charge currency stay separate in quote and charge requests', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  const quoteBodies: CheckoutRequestBody[] = [];
  const chargeBodies: CheckoutRequestBody[] = [];
  const runtime = createCheckoutRuntime(source, async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as CheckoutRequestBody;
    if (url === '/quote') {
      quoteBodies.push(body);
      return {
        json: async () => ({
          ok: true,
          domestic: false,
          quoteToken: 'germany-usd.browser-contract',
          amount_breakdown: {
            subtotal: 4200,
            shipping: 0,
            tax: 798,
            duty: 210,
            total: 5208,
            currency: 'USD',
          },
        }),
      };
    }
    assert.equal(url, '/charge');
    chargeBodies.push(body);
    return { json: async () => ({ ok: true, status: 'payment_submitted' }) };
  });

  await openCompletedBuyerForm(runtime.element);
  runtime.element('country').value = 'DE';
  await runtime.element('country').dispatch('change');
  await runtime.element('review-total').dispatch('click');
  await runtime.mountedPayment().onSuccess({ paymentMethodId: 'pm_germany_usd_contract' });

  assert.equal(quoteBodies.length, 1);
  assert.equal(quoteBodies[0]?.checkoutId, 'checkout-3');
  assert.equal(quoteBodies[0]?.currency, 'USD');
  assert.equal(quoteBodies[0]?.amount, 4200);
  assert.equal(quoteBodies[0]?.address?.country, 'DE');
  assert.equal(
    runtime.element('totals-note').textContent,
    'Duties & taxes quoted for ship-to destination Germany; charged in USD.',
  );
  assert.equal(chargeBodies.length, 1);
  assert.equal(chargeBodies[0]?.checkoutId, quoteBodies[0]?.checkoutId);
  assert.equal(chargeBodies[0]?.currency, 'USD');
  assert.equal(chargeBodies[0]?.amount, 4200);
  assert.equal(chargeBodies[0]?.address?.country, 'DE');
});

test('an in-flight quote locks all controls and rejects a stale response after a forced edit', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  let quoteCalls = 0;
  let resolveQuote!: (response: { json(): Promise<unknown> }) => void;
  const quoteResponse = new Promise<{ json(): Promise<unknown> }>((resolve) => {
    resolveQuote = resolve;
  });
  const runtime = createCheckoutRuntime(
    source,
    async () => {
      quoteCalls += 1;
      return quoteResponse;
    },
  );
  const { element } = runtime;
  await openCompletedBuyerForm(element);

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

test('an outcome-unknown charge keeps the original payment method for an exact retry', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  const chargeBodies: Array<Record<string, unknown>> = [];
  const runtime = createCheckoutRuntime(source, async (url, init) => {
    if (url === '/quote') {
      return {
        json: async () => ({
          ok: true,
          domestic: false,
          quoteToken: 'retry.browser-contract',
          amount_breakdown: {
            subtotal: 4200,
            shipping: 0,
            tax: 840,
            duty: 210,
            total: 5250,
            currency: 'USD',
          },
        }),
      };
    }
    assert.equal(url, '/charge');
    chargeBodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return {
      json: async () => chargeBodies.length === 1
        ? {
            ok: false,
            code: 'payment_status_unknown',
            outcomeUnknown: true,
          }
        : { ok: true, status: 'payment_submitted' },
    };
  });

  await openCompletedBuyerForm(runtime.element);
  await runtime.element('review-total').dispatch('click');
  const payment = runtime.mountedPayment();
  await assert.rejects(
    payment.onSuccess({ paymentMethodId: 'pm_original_browser_contract' }),
    /payment_status_unknown/,
  );
  await payment.onSuccess({ paymentMethodId: 'pm_changed_browser_contract' });

  assert.equal(chargeBodies.length, 2);
  assert.equal(chargeBodies[0]?.paymentMethodId, 'pm_original_browser_contract');
  assert.equal(chargeBodies[1]?.paymentMethodId, 'pm_original_browser_contract');
  assert.equal(runtime.element('review-total').textContent, 'Order submitted');
  assert.equal(runtime.element('review-total').disabled, true);
});

test('a transient retry preflight keeps the original ambiguous payment method', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  const chargeBodies: Array<Record<string, unknown>> = [];
  const runtime = createCheckoutRuntime(source, async (url, init) => {
    if (url === '/quote') {
      return {
        json: async () => ({
          ok: true,
          domestic: false,
          quoteToken: 'retry-preflight.browser-contract',
          amount_breakdown: {
            subtotal: 4200,
            shipping: 0,
            tax: 840,
            duty: 210,
            total: 5250,
            currency: 'USD',
          },
        }),
      };
    }
    assert.equal(url, '/charge');
    chargeBodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return {
      json: async () => {
        if (chargeBodies.length === 1) {
          return {
            ok: false,
            code: 'payment_status_unknown',
            outcomeUnknown: true,
          };
        }
        if (chargeBodies.length === 2) {
          return {
            ok: false,
            code: 'demo_not_ready',
            message: 'The durable checkout store is temporarily unavailable.',
          };
        }
        return { ok: true, status: 'payment_submitted' };
      },
    };
  });

  await openCompletedBuyerForm(runtime.element);
  await runtime.element('review-total').dispatch('click');
  const payment = runtime.mountedPayment();
  await assert.rejects(
    payment.onSuccess({ paymentMethodId: 'pm_original_browser_contract' }),
    /payment_status_unknown/,
  );
  await assert.rejects(
    payment.onSuccess({ paymentMethodId: 'pm_changed_after_preflight' }),
    /payment_status_unknown/,
  );
  await payment.onSuccess({ paymentMethodId: 'pm_changed_after_recovery' });

  assert.equal(chargeBodies.length, 3);
  assert.equal(chargeBodies[0]?.paymentMethodId, 'pm_original_browser_contract');
  assert.equal(chargeBodies[1]?.paymentMethodId, 'pm_original_browser_contract');
  assert.equal(chargeBodies[2]?.paymentMethodId, 'pm_original_browser_contract');
});

test('a terminal decline locks the closed checkout and requires a new session', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  const runtime = createCheckoutRuntime(source, async (url) => {
    if (url === '/quote') {
      return {
        json: async () => ({
          ok: true,
          domestic: false,
          quoteToken: 'declined.browser-contract',
          amount_breakdown: {
            subtotal: 4200,
            shipping: 0,
            tax: 840,
            duty: 210,
            total: 5250,
            currency: 'USD',
          },
        }),
      };
    }
    assert.equal(url, '/charge');
    return {
      json: async () => ({
        ok: false,
        code: 'payment_declined',
        checkoutClosed: true,
        message: 'The test payment was declined. Close this checkout and start a new one.',
      }),
    };
  });

  await openCompletedBuyerForm(runtime.element);
  await runtime.element('review-total').dispatch('click');
  await assert.rejects(
    runtime.mountedPayment().onSuccess({ paymentMethodId: 'pm_declined_browser_contract' }),
    /checkout_closed/,
  );

  assert.equal(runtime.element('review-total').textContent, 'Checkout closed — close and restart');
  assert.equal(runtime.element('review-total').disabled, true);
  assert.equal(runtime.element('email').disabled, true);
});

test('a retry-required state write keeps the original payment method until closure', async () => {
  const source = await readFile(join(process.cwd(), 'public/checkout.js'), 'utf8');
  const chargeBodies: Array<Record<string, unknown>> = [];
  const runtime = createCheckoutRuntime(source, async (url, init) => {
    if (url === '/quote') {
      return {
        json: async () => ({
          ok: true,
          domestic: false,
          quoteToken: 'state-retry.browser-contract',
          amount_breakdown: {
            subtotal: 4200,
            shipping: 0,
            tax: 840,
            duty: 210,
            total: 5250,
            currency: 'USD',
          },
        }),
      };
    }
    assert.equal(url, '/charge');
    chargeBodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return {
      json: async () => chargeBodies.length === 1
        ? {
            ok: false,
            code: 'checkout_state_retry_required',
            retrySameCheckout: true,
          }
        : {
            ok: false,
            code: 'payment_declined',
            checkoutClosed: true,
            message: 'The test payment was declined. Close this checkout and start a new one.',
          },
    };
  });

  await openCompletedBuyerForm(runtime.element);
  await runtime.element('review-total').dispatch('click');
  const payment = runtime.mountedPayment();
  await assert.rejects(
    payment.onSuccess({ paymentMethodId: 'pm_original_state_retry' }),
    /checkout_retry_required/,
  );
  await assert.rejects(
    payment.onSuccess({ paymentMethodId: 'pm_changed_state_retry' }),
    /checkout_closed/,
  );

  assert.equal(chargeBodies.length, 2);
  assert.equal(chargeBodies[0]?.paymentMethodId, 'pm_original_state_retry');
  assert.equal(chargeBodies[1]?.paymentMethodId, 'pm_original_state_retry');
  assert.equal(runtime.element('review-total').textContent, 'Checkout closed — close and restart');
});
