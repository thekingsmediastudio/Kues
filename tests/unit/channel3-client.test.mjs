import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Channel3Error,
  computeProductEvidenceHash,
  createChannel3Client,
  normalizeProduct,
  SAMPLE_CHANNEL3_PRODUCTS,
} from '../../apps/web/lib/channel3/client.mjs';

test('Channel3 client configuration: checks API key honestly and reports configuration status', () => {
  const unconfigured = createChannel3Client({ apiKey: '' });
  assert.equal(unconfigured.isConfigured(), false);

  const configured = createChannel3Client({ apiKey: 'c3_live_test_key_123' });
  assert.equal(configured.isConfigured(), true);
});

test('computeProductEvidenceHash computes deterministic sha256 digests matching canonical payload', () => {
  const h1 = computeProductEvidenceHash({
    source: 'channel3',
    sourceListingId: 'item-101',
    merchantDomain: 'studiokera.example.com',
    merchantName: 'Studio Kera',
    title: 'Ceramic Vase',
    amountMinor: 4500,
    currency: 'USD',
    url: 'https://studiokera.example.com/vase',
    observedAt: '2026-10-29T12:00:00.000Z',
  });

  const h2 = computeProductEvidenceHash({
    observedAt: '2026-10-29T12:00:00.000Z',
    currency: 'usd',
    title: ' Ceramic Vase ',
    amountMinor: 4500,
    merchantName: 'Studio Kera',
    merchantDomain: 'STUDIOKERA.EXAMPLE.COM',
    sourceListingId: 'item-101',
    url: 'https://studiokera.example.com/vase',
    source: 'channel3',
  });

  assert.match(h1, /^sha256:[a-f0-9]{64}$/);
  assert.equal(h1, h2, 'Payload with different key order or whitespace/casing normalization yields identical hash');

  const differentPrice = computeProductEvidenceHash({
    source: 'channel3',
    sourceListingId: 'item-101',
    merchantDomain: 'studiokera.example.com',
    merchantName: 'Studio Kera',
    title: 'Ceramic Vase',
    amountMinor: 4600,
    currency: 'USD',
    url: 'https://studiokera.example.com/vase',
    observedAt: '2026-10-29T12:00:00.000Z',
  });
  assert.notEqual(h1, differentPrice, 'Different amount yields different evidence hash');
});

test('normalizeProduct extracts structured fields, minor-unit prices, and merchant domains', () => {
  const raw = {
    id: 'prod_999',
    title: '  Modern Desk Lamp  ',
    description: 'Adjustable LED task light.',
    brand: 'Lumina',
    images: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
    offers: [
      {
        merchant: 'Lumina Direct',
        merchant_url: 'https://shop.lumina.example/products/lamp-desk',
        price: 59.99,
        currency: 'USD',
        availability: 'InStock',
      },
    ],
  };

  const normalized = normalizeProduct(raw, {
    source: 'channel3',
    isLive: true,
    observedAt: '2026-10-29T14:30:00.000Z',
  });

  assert.equal(normalized.id, 'prod_999');
  assert.equal(normalized.title, 'Modern Desk Lamp');
  assert.equal(normalized.brand, 'Lumina');
  assert.equal(normalized.imageUrl, 'https://example.com/img1.jpg');
  assert.equal(normalized.merchantName, 'Lumina Direct');
  assert.equal(normalized.merchantDomain, 'shop.lumina.example');
  assert.equal(normalized.amountMinor, 5999);
  assert.equal(normalized.priceFormatted, '$59.99 USD');
  assert.equal(normalized.currency, 'USD');
  assert.equal(normalized.availability, 'in_stock');
  assert.equal(normalized.source, 'channel3');
  assert.equal(normalized.isLive, true);
  assert.match(normalized.evidenceHash, /^sha256:[a-f0-9]{64}$/);
});

test('normalizeProduct safely handles object brands, nested price shapes, and derives merchant from domain when unknown', () => {
  const rawWithNestedPrice = {
    id: 'prod_nested_123',
    title: 'Precision Ergonomic Keyboard',
    brand: { name: 'Keychron' },
    images: [{ url: 'https://example.com/keyboard.jpg' }],
    offers: [
      {
        merchant_domain: 'keychron.example.com',
        price: { price: 189.5, currency: 'USD' },
        availability: 'InStock',
        url: 'https://keychron.example.com/keyboard',
      },
    ],
  };

  const normalizedNested = normalizeProduct(rawWithNestedPrice);
  assert.equal(normalizedNested.brand, 'Keychron');
  assert.equal(normalizedNested.merchantName, 'Keychron');
  assert.equal(normalizedNested.merchantDomain, 'keychron.example.com');
  assert.equal(normalizedNested.amountMinor, 18950);
  assert.equal(normalizedNested.priceFormatted, '$189.50 USD');

  const rawZeroPrice = {
    id: 'prod_zero_123',
    title: 'Custom Enterprise Suite',
    merchant_domain: 'acme-corp.example.com',
  };

  const normalizedZero = normalizeProduct(rawZeroPrice);
  assert.equal(normalizedZero.amountMinor, 0);
  assert.equal(normalizedZero.priceFormatted, 'Price on request');
  assert.notEqual(normalizedZero.merchantName, 'Unknown seller');
  assert.equal(normalizedZero.merchantDomain, 'acme-corp.example.com');
});

test('searchProducts fails honestly when unconfigured or given an empty query', async () => {
  const unconfigured = createChannel3Client({ apiKey: '' });
  await assert.rejects(
    async () => unconfigured.searchProducts({ query: 'ceramic pitcher' }),
    (err) => {
      assert(err instanceof Channel3Error);
      assert.equal(err.code, 'channel3_not_configured');
      assert.equal(err.status, 503);
      return true;
    }
  );

  const configured = createChannel3Client({ apiKey: 'key_123' });
  await assert.rejects(
    async () => configured.searchProducts({ query: '   ' }),
    (err) => {
      assert(err instanceof Channel3Error);
      assert.equal(err.code, 'query_required');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('searchProducts blocks private/loopback destination IPs and requires HTTPS', async () => {
  const privateClient = createChannel3Client({
    apiKey: 'key_123',
    baseUrl: 'https://api.trychannel3.com',
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
  });

  await assert.rejects(
    async () => privateClient.searchProducts({ query: 'watch' }),
    (err) => {
      assert(err instanceof Channel3Error);
      assert.equal(err.code, 'channel3_destination_blocked');
      assert.equal(err.status, 403);
      return true;
    }
  );

  const insecureClient = createChannel3Client({
    apiKey: 'key_123',
    baseUrl: 'http://api.trychannel3.com',
  });

  await assert.rejects(
    async () => insecureClient.searchProducts({ query: 'watch' }),
    (err) => {
      assert(err instanceof Channel3Error);
      assert.equal(err.code, 'channel3_insecure_endpoint');
      assert.equal(err.status, 500);
      return true;
    }
  );
});

test('searchProducts executes POST request with server-only key and normalizes live results', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedBody = null;

  const mockFetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          query: 'wool sweater',
          products: [
            {
              id: 'c3_wool_01',
              title: 'Fine Merino Crewneck',
              brand: 'Knit & Co',
              offers: [
                {
                  price: 88.0,
                  currency: 'USD',
                  merchant: 'Knit & Co',
                  merchant_domain: 'knitandco.example.com',
                  url: 'https://knitandco.example.com/crewneck',
                  availability: 'in_stock',
                },
              ],
            },
          ],
        };
      },
    };
  };

  const client = createChannel3Client({
    apiKey: 'sk_channel3_secret_value',
    baseUrl: 'https://api.trychannel3.com',
    fetchImpl: mockFetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  const result = await client.searchProducts({ query: 'wool sweater', limit: 5 });

  assert.equal(capturedUrl, 'https://api.trychannel3.com/v1/search');
  assert.equal(capturedHeaders['x-api-key'], 'sk_channel3_secret_value');
  assert.equal(capturedHeaders['content-type'], 'application/json');
  assert.equal(capturedBody.query, 'wool sweater');
  assert.equal(capturedBody.limit, 5);

  assert.equal(result.query, 'wool sweater');
  assert.equal(result.isLive, true);
  assert.equal(result.source, 'channel3');
  assert.equal(result.count, 1);
  assert.equal(result.products[0].id, 'c3_wool_01');
  assert.equal(result.products[0].title, 'Fine Merino Crewneck');
  assert.equal(result.products[0].amountMinor, 8800);
  assert.equal(result.products[0].isLive, true);
  assert.match(result.products[0].evidenceHash, /^sha256:[a-f0-9]{64}$/);
});

test('searchProducts nests price filters under filters.price and formats availability as an array for Channel3 API', async () => {
  let capturedBody;
  const mockFetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { query: 'running shoes', products: [] };
      },
    };
  };

  const client = createChannel3Client({
    apiKey: 'sk_test_key',
    baseUrl: 'https://api.trychannel3.com',
    fetchImpl: mockFetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  await client.searchProducts({
    query: 'running shoes',
    limit: 10,
    filters: {
      min_price: 50,
      max_price: 150,
      availability: 'in_stock',
    },
  });

  assert.deepEqual(capturedBody.filters, {
    price: { min_price: 50, max_price: 150 },
    availability: ['InStock', 'LimitedAvailability'],
  });
  assert.equal(capturedBody.filters.max_price, undefined, 'max_price must NOT be at top level of filters');
});

test('searchProducts propagates upstream HTTP errors honestly without credential leakage', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return 'Unauthorized: invalid api key provided';
    },
  });

  const client = createChannel3Client({
    apiKey: 'secret_key_to_never_leak',
    baseUrl: 'https://api.trychannel3.com',
    fetchImpl: mockFetch,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
  });

  await assert.rejects(
    async () => client.searchProducts({ query: 'shoes' }),
    (err) => {
      assert(err instanceof Channel3Error);
      assert.equal(err.code, 'channel3_upstream_error');
      assert.equal(err.status, 401);
      assert.equal(err.message.includes('secret_key_to_never_leak'), false);
      return true;
    }
  );
});

test('searchSampleProducts returns distinct fixtures with isLive: false and valid evidence hashes', () => {
  const client = createChannel3Client({ apiKey: '' });
  const result = client.searchSampleProducts({ query: 'ceramic' });

  assert.equal(result.isLive, false);
  assert.equal(result.notice, 'sample_fixture');
  assert.equal(result.source, 'channel3_sample');
  assert.ok(result.products.length > 0);

  const first = result.products[0];
  assert.equal(first.isLive, false);
  assert.equal(first.source, 'channel3_sample');
  assert.equal(first.merchantName, 'Studio Kera');
  assert.equal(first.amountMinor, 7850);
  assert.match(first.evidenceHash, /^sha256:[a-f0-9]{64}$/);
});

test('searchSampleProducts filters by maxPrice and sorts by price ascending and descending', () => {
  const client = createChannel3Client({ apiKey: '' });

  // 1. Filter by max_price: 30
  const under30 = client.searchSampleProducts({
    query: '',
    filters: { max_price: 30 },
  });
  assert.ok(under30.products.length > 0);
  for (const prod of under30.products) {
    assert.ok(prod.amountMinor <= 3000, `Expected price minor <= 3000, got ${prod.amountMinor}`);
  }

  // 2. Sort by price ascending
  const sortedAsc = client.searchSampleProducts({
    query: '',
    filters: { sort_by: 'price_asc' },
  });
  assert.ok(sortedAsc.products.length >= 2);
  for (let i = 1; i < sortedAsc.products.length; i++) {
    assert.ok(
      sortedAsc.products[i].amountMinor >= sortedAsc.products[i - 1].amountMinor,
      `Expected ${sortedAsc.products[i].amountMinor} >= ${sortedAsc.products[i - 1].amountMinor}`
    );
  }

  // 3. Sort by price descending
  const sortedDesc = client.searchSampleProducts({
    query: '',
    filters: { sort_by: 'price_desc' },
  });
  assert.ok(sortedDesc.products.length >= 2);
  for (let i = 1; i < sortedDesc.products.length; i++) {
    assert.ok(
      sortedDesc.products[i].amountMinor <= sortedDesc.products[i - 1].amountMinor,
      `Expected ${sortedDesc.products[i].amountMinor} <= ${sortedDesc.products[i - 1].amountMinor}`
    );
  }

  // 4. Filter by availability: in_stock
  const inStock = client.searchSampleProducts({
    query: '',
    filters: { availability: 'in_stock' },
  });
  assert.ok(inStock.products.length > 0);
  for (const prod of inStock.products) {
    assert.equal(prod.availability, 'in_stock');
  }
});
