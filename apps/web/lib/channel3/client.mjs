import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export class Channel3Error extends Error {
  constructor(code, status = 500, message = '') {
    super(message || code);
    this.name = 'Channel3Error';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, maxLength = 255) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function extractDomain(urlOrDomain) {
  const input = safeString(urlOrDomain);
  if (!input) return 'unknown.example';
  try {
    const candidate = input.includes('://') ? input : `https://${input}`;
    const parsed = new URL(candidate);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return input.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

/**
 * Computes deterministic canonical evidence hash for a product offer.
 * Conforms to the sha256:<hex> standard used across mandates and receipts.
 */
export function computeProductEvidenceHash({
  source = 'channel3',
  sourceListingId = '',
  merchantDomain = '',
  merchantName = '',
  title = '',
  amountMinor = 0,
  currency = 'USD',
  url = '',
  observedAt = '',
}) {
  const payload = {
    amountMinor: Number(amountMinor),
    currency: String(currency || 'USD').toUpperCase(),
    merchantDomain: String(merchantDomain || '').toLowerCase(),
    merchantName: String(merchantName || '').trim(),
    observedAt: String(observedAt || ''),
    source: String(source || 'channel3'),
    sourceListingId: String(sourceListingId || ''),
    title: String(title || '').trim(),
    url: String(url || '').trim(),
  };
  const sortedKeys = Object.keys(payload).sort();
  const canonical = '{' + sortedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`).join(',') + '}';
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function normalizeProduct(raw, { source = 'channel3', isLive = true, observedAt = new Date().toISOString() } = {}) {
  if (!isRecord(raw)) throw new Channel3Error('invalid_product_record', 400);

  const title = safeString(raw.title || raw.name || 'Untitled product', 200);
  const description = safeString(raw.description || '', 1000);
  const brand = safeString(raw.brand || '', 100);

  let imageUrl = null;
  if (Array.isArray(raw.images) && raw.images.length) {
    const first = raw.images[0];
    imageUrl = typeof first === 'string' ? safeString(first, 1000) : safeString(first?.url, 1000);
  } else if (typeof raw.image === 'string') {
    imageUrl = safeString(raw.image, 1000);
  }

  // Extract offer / pricing details
  const offers = Array.isArray(raw.offers) ? raw.offers : [];
  const primaryOffer = offers[0] || (isRecord(raw.offer) ? raw.offer : {});

  const url = safeString(primaryOffer.url || primaryOffer.merchant_url || raw.url || raw.link || '', 1000);
  const merchantName = safeString(primaryOffer.merchant || primaryOffer.seller || raw.merchant || raw.seller || brand || 'Unknown seller', 120);
  const merchantDomain = extractDomain(primaryOffer.merchant_domain || url || merchantName);

  let amountMinor = 0;
  const rawPrice = primaryOffer.price !== undefined ? primaryOffer.price : raw.price;
  if (typeof rawPrice === 'number' && Number.isFinite(rawPrice)) {
    amountMinor = Math.round(rawPrice * 100);
  } else if (typeof rawPrice === 'string') {
    const cleanNum = parseFloat(rawPrice.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(cleanNum)) amountMinor = Math.round(cleanNum * 100);
  }

  const rawCurrency = safeString(primaryOffer.currency || raw.currency || 'USD', 3).toUpperCase();
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';

  let availability = 'unknown';
  const rawAvail = safeString(primaryOffer.availability || raw.availability || '').toLowerCase();
  if (rawAvail.includes('instock') || rawAvail.includes('in_stock') || rawAvail.includes('available')) {
    availability = 'in_stock';
  } else if (rawAvail.includes('out') || rawAvail.includes('unavailable')) {
    availability = 'out_of_stock';
  } else if (rawAvail.includes('limited') || rawAvail.includes('preorder')) {
    availability = 'limited';
  }

  const sourceListingId = safeString(String(raw.id || raw.listing_id || raw.sku || ''), 100);
  const evidenceHash = computeProductEvidenceHash({
    source,
    sourceListingId,
    merchantDomain,
    merchantName,
    title,
    amountMinor,
    currency,
    url,
    observedAt,
  });

  return {
    id: sourceListingId || `c3_${crypto.randomUUID().replaceAll('-', '')}`,
    title,
    description,
    brand,
    imageUrl,
    merchantName,
    merchantDomain,
    url,
    amountMinor,
    priceFormatted: `$${(amountMinor / 100).toFixed(2)} ${currency}`,
    currency,
    availability,
    source,
    isLive: Boolean(isLive),
    observedAt,
    evidenceHash,
  };
}

export const SAMPLE_CHANNEL3_PRODUCTS = Object.freeze([
  {
    id: 'c3_sample_ceramic_bundle',
    title: 'Ceramic Tabletop Bundle (4 Pieces)',
    description: 'Minimalist glazed ceramic bundle including pitcher, vase, and two matching saucers.',
    brand: 'Studio Kera',
    images: ['https://channel3.example/assets/ceramic-bundle.jpg'],
    price: 78.50,
    currency: 'USD',
    merchant: 'Studio Kera',
    merchant_domain: 'studiokera.example.com',
    url: 'https://studiokera.example.com/products/ceramic-tabletop-bundle',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_merino_sweater',
    title: 'Classic Merino Wool Crewneck Sweater',
    description: '100% extrafine merino wool sweater in charcoal gray. Breathable and temperature-regulating.',
    brand: 'Nordic Knitwear',
    images: ['https://channel3.example/assets/merino-crewneck.jpg'],
    price: 84.00,
    currency: 'USD',
    merchant: 'Nordic Knitwear',
    merchant_domain: 'nordicknitwear.example.com',
    url: 'https://nordicknitwear.example.com/merino-crewneck',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_ergonomic_desk_mat',
    title: 'Dual-Sided Vegan Leather Desk Mat',
    description: 'Water-resistant textured vegan leather desk pad with non-slip backing (36 x 17 inches).',
    brand: 'Form & Function',
    images: ['https://channel3.example/assets/desk-mat.jpg'],
    price: 38.00,
    currency: 'USD',
    merchant: 'Form & Function Workspace',
    merchant_domain: 'formworkspace.example.com',
    url: 'https://formworkspace.example.com/desk-mat',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_brass_ruler',
    title: 'Solid Brass Architect Ruler 30cm',
    description: 'Laser-etched metric and imperial solid brass drafting rule that patinas gracefully with use.',
    brand: 'Craft Draft',
    images: ['https://channel3.example/assets/brass-ruler.jpg'],
    price: 24.50,
    currency: 'USD',
    merchant: 'Craft Draft Goods',
    merchant_domain: 'craftdraft.example.com',
    url: 'https://craftdraft.example.com/brass-ruler',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_linen_journal',
    title: 'Hardcover Linen Grid Notebook (A5)',
    description: '160 pages of 120gsm acid-free fountain-pen friendly paper with ribbon marker and expandable pocket.',
    brand: 'Parchment & Co',
    images: ['https://channel3.example/assets/linen-notebook.jpg'],
    price: 22.00,
    currency: 'USD',
    merchant: 'Parchment & Co',
    merchant_domain: 'parchmentco.example.com',
    url: 'https://parchmentco.example.com/linen-notebook',
    availability: 'InStock',
  },
]);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254)
      || parts[0] === 0;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return true;
}

export function createChannel3Client({
  apiKey = process.env.CHANNEL3_API_KEY || '',
  baseUrl = 'https://api.trychannel3.com',
  fetchImpl = fetch,
  resolveHost = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';

  function isConfigured() {
    return Boolean(key);
  }

  async function searchProducts({ query, limit = 10, filters = {} } = {}) {
    const cleanQuery = safeString(query, 200);
    if (!cleanQuery) throw new Channel3Error('query_required', 400, 'Search query cannot be empty');

    const cleanLimit = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 10, 50));

    if (!isConfigured()) {
      throw new Channel3Error('channel3_not_configured', 503, 'Channel3 API key is not configured');
    }

    const targetUrl = new URL('/v1/search', baseUrl);
    if (targetUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(targetUrl.hostname)) {
      throw new Channel3Error('channel3_insecure_endpoint', 500, 'Channel3 endpoint must use HTTPS');
    }

    if (resolveHost && !['localhost', '127.0.0.1'].includes(targetUrl.hostname)) {
      try {
        const addresses = await resolveHost(targetUrl.hostname);
        if (!Array.isArray(addresses) || !addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
          throw new Channel3Error('channel3_destination_blocked', 403, 'Destination address blocked');
        }
      } catch (err) {
        if (err instanceof Channel3Error) throw err;
        throw new Channel3Error('channel3_dns_failure', 502, 'DNS resolution for Channel3 failed');
      }
    }

    const payload = {
      query: cleanQuery,
      limit: cleanLimit,
      ...(isRecord(filters) ? { filters } : {}),
    };

    let response;
    try {
      response = await fetchImpl(targetUrl.toString(), {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'content-type': 'application/json',
          'user-agent': 'Keus-Commerce-Agent/1.0',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Channel3Error('channel3_network_error', 502, `Failed to reach Channel3: ${err.message}`);
    }

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch {}
      throw new Channel3Error('channel3_upstream_error', response.status, `Channel3 returned HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Channel3Error('channel3_invalid_json', 502, 'Channel3 returned invalid JSON');
    }

    const rawList = Array.isArray(data?.products)
      ? data.products
      : (Array.isArray(data?.results) ? data.results : []);

    const observedAt = new Date().toISOString();
    const products = rawList.slice(0, cleanLimit).map((item) => normalizeProduct(item, {
      source: 'channel3',
      isLive: true,
      observedAt,
    }));

    return {
      query: cleanQuery,
      count: products.length,
      products,
      isLive: true,
      source: 'channel3',
    };
  }

  function searchSampleProducts({ query, limit = 10 } = {}) {
    const cleanQuery = safeString(query, 200).toLowerCase();
    const cleanLimit = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 10, 50));
    const observedAt = new Date().toISOString();

    const matched = cleanQuery
      ? SAMPLE_CHANNEL3_PRODUCTS.filter((item) => {
        const text = `${item.title} ${item.description} ${item.brand} ${item.merchant}`.toLowerCase();
        return cleanQuery.split(/\s+/).some((token) => token && text.includes(token));
      })
      : SAMPLE_CHANNEL3_PRODUCTS;

    const list = matched.length ? matched : SAMPLE_CHANNEL3_PRODUCTS;
    const products = list.slice(0, cleanLimit).map((item) => normalizeProduct(item, {
      source: 'channel3_sample',
      isLive: false,
      observedAt,
    }));

    return {
      query: safeString(query, 200),
      count: products.length,
      products,
      isLive: false,
      notice: 'sample_fixture',
      source: 'channel3_sample',
    };
  }

  return Object.freeze({
    isConfigured,
    searchProducts,
    searchSampleProducts,
  });
}
