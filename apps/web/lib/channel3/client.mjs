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

function formatDomainToName(domain) {
  if (!domain || domain === 'unknown.example') return '';
  const base = domain.replace(/^www\./, '').split('.')[0];
  if (!base) return '';
  return base.charAt(0).toUpperCase() + base.slice(1);
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
  const brand = safeString(
    (typeof raw.brand === 'object' && raw.brand ? (raw.brand.name || raw.brand.title || '') : raw.brand) || '',
    100
  );

  let imageUrl = null;
  if (Array.isArray(raw.images) && raw.images.length) {
    const first = raw.images[0];
    imageUrl = typeof first === 'string'
      ? safeString(first, 1000)
      : safeString(first?.url || first?.src || first?.link || '', 1000);
  } else if (typeof raw.image === 'string') {
    imageUrl = safeString(raw.image, 1000);
  } else if (typeof raw.image === 'object' && raw.image) {
    imageUrl = safeString(raw.image.url || raw.image.src || '', 1000);
  }

  // Extract offer / pricing details
  const offers = Array.isArray(raw.offers) ? raw.offers : [];
  const primaryOffer = offers[0] || (isRecord(raw.offer) ? raw.offer : {});

  if (!imageUrl && (primaryOffer.image || primaryOffer.imageUrl)) {
    imageUrl = safeString(primaryOffer.image || primaryOffer.imageUrl, 1000);
  }

  const url = safeString(
    primaryOffer.url
    || primaryOffer.merchant_url
    || primaryOffer.link
    || raw.url
    || raw.link
    || '',
    1000
  );

  const rawMerchant = primaryOffer.merchant_name
    || (typeof primaryOffer.merchant === 'object' ? primaryOffer.merchant?.name : primaryOffer.merchant)
    || primaryOffer.seller_name
    || (typeof primaryOffer.seller === 'object' ? primaryOffer.seller?.name : primaryOffer.seller)
    || primaryOffer.retailer_name
    || (typeof primaryOffer.retailer === 'object' ? primaryOffer.retailer?.name : primaryOffer.retailer)
    || primaryOffer.store_name
    || (typeof primaryOffer.store === 'object' ? primaryOffer.store?.name : primaryOffer.store)
    || raw.merchant_name
    || (typeof raw.merchant === 'object' ? raw.merchant?.name : raw.merchant)
    || raw.seller_name
    || (typeof raw.seller === 'object' ? raw.seller?.name : raw.seller)
    || raw.retailer_name
    || (typeof raw.retailer === 'object' ? raw.retailer?.name : raw.retailer)
    || raw.store_name
    || (typeof raw.store === 'object' ? raw.store?.name : raw.store)
    || '';

  const merchantDomain = extractDomain(
    primaryOffer.merchant_domain
    || primaryOffer.domain
    || raw.merchant_domain
    || raw.domain
    || url
    || (typeof rawMerchant === 'string' && rawMerchant.includes('.') ? rawMerchant : '')
  );

  const domainName = formatDomainToName(merchantDomain);
  const merchantName = safeString(
    (typeof rawMerchant === 'string' && rawMerchant.trim() && !/^unknown(\s*seller)?$/i.test(rawMerchant.trim()))
      ? rawMerchant.trim()
      : (brand || domainName || 'Verified Merchant'),
    120
  );

  let amountMinor = 0;
  const priceCandidates = [
    primaryOffer.price,
    primaryOffer.price?.price,
    primaryOffer.price?.amount,
    primaryOffer.price?.value,
    primaryOffer.amount,
    primaryOffer.price_amount,
    raw.price,
    raw.price?.price,
    raw.price?.amount,
    raw.price?.value,
    raw.min_price,
    raw.max_price,
    raw.low_price,
  ];

  for (const c of priceCandidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      amountMinor = Math.round(c * 100);
      break;
    }
    if (typeof c === 'string' && c.trim()) {
      const cleanNum = parseFloat(c.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(cleanNum) && cleanNum > 0) {
        amountMinor = Math.round(cleanNum * 100);
        break;
      }
    }
  }
  if (!amountMinor) {
    if (typeof primaryOffer.price_cents === 'number' && primaryOffer.price_cents > 0) amountMinor = Math.round(primaryOffer.price_cents);
    else if (typeof primaryOffer.amount_minor === 'number' && primaryOffer.amount_minor > 0) amountMinor = Math.round(primaryOffer.amount_minor);
    else if (typeof raw.price_cents === 'number' && raw.price_cents > 0) amountMinor = Math.round(raw.price_cents);
    else if (typeof raw.amount_minor === 'number' && raw.amount_minor > 0) amountMinor = Math.round(raw.amount_minor);
  }

  const currencyInput = (
    primaryOffer.currency
    || primaryOffer.priceCurrency
    || primaryOffer.price?.currency
    || primaryOffer.price?.priceCurrency
    || raw.currency
    || raw.priceCurrency
    || ''
  );
  const rawCurrency = safeString(currencyInput, 20).toUpperCase();
  const currencyVerified = /^[A-Z]{3}$/.test(rawCurrency);
  const currency = currencyVerified ? rawCurrency : 'USD';

  let availability = 'unknown';
  const rawAvail = safeString(primaryOffer.availability || raw.availability || '').toLowerCase();
  if (rawAvail.includes('out') || rawAvail.includes('unavailable') || rawAvail.includes('sold') || /\bnot[ _-]+(?:available|in[ _-]+stock)\b|\bno[ _-]+stock\b/.test(rawAvail)) {
    availability = 'out_of_stock';
  } else if (rawAvail.includes('limited') || rawAvail.includes('preorder') || rawAvail.includes('pre-order')) {
    availability = 'limited';
  } else if (rawAvail.includes('instock') || rawAvail.includes('in_stock') || rawAvail.includes('in stock') || rawAvail.includes('available')) {
    availability = 'in_stock';
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
    sku: safeString(primaryOffer.sku || raw.sku || '', 100),
    imageUrl,
    merchantName,
    merchantDomain,
    url,
    amountMinor,
    priceFormatted: amountMinor > 0 ? `$${(amountMinor / 100).toFixed(2)} ${currency}` : 'Price on request',
    currency,
    currencyVerified,
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
  {
    id: 'c3_sample_stoneware_dripper',
    title: 'Stoneware Pour-Over Dripper & Mug Set',
    description: 'Handcrafted speckle stoneware single-cup slow dripper with ergonomic 12oz matching artisan mug.',
    brand: 'Studio Kera',
    images: ['https://channel3.example/assets/ceramic-dripper.jpg'],
    price: 46.00,
    currency: 'USD',
    merchant: 'Studio Kera',
    merchant_domain: 'studiokera.example.com',
    url: 'https://studiokera.example.com/products/stoneware-dripper-mug',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_mechanical_pencil',
    title: 'Precision Mechanical Drafting Pencil 0.5mm',
    description: 'Solid brass core drafting pencil with knurled non-slip metal grip and balanced center of gravity.',
    brand: 'Craft Draft',
    images: ['https://channel3.example/assets/drafting-pencil.jpg'],
    price: 32.00,
    currency: 'USD',
    merchant: 'Craft Draft Goods',
    merchant_domain: 'craftdraft.example.com',
    url: 'https://craftdraft.example.com/drafting-pencil',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_oak_organizer',
    title: 'Solid White Oak Desktop Organizer Tray',
    description: 'Sustainably sourced white oak desk tray sculpted with compartments for stationery and EDC essentials.',
    brand: 'Form & Function',
    images: ['https://channel3.example/assets/oak-organizer.jpg'],
    price: 54.00,
    currency: 'USD',
    merchant: 'Form & Function Workspace',
    merchant_domain: 'formworkspace.example.com',
    url: 'https://formworkspace.example.com/oak-tray',
    availability: 'InStock',
  },
  {
    id: 'c3_sample_wool_beanie',
    title: 'Ribbed British Lambswool Knit Beanie',
    description: '100% soft spun British lambswool knit beanie with deep fold-over cuff for breathable thermal comfort.',
    brand: 'Nordic Knitwear',
    images: ['https://channel3.example/assets/wool-beanie.jpg'],
    price: 36.00,
    currency: 'USD',
    merchant: 'Nordic Knitwear',
    merchant_domain: 'nordicknitwear.example.com',
    url: 'https://nordicknitwear.example.com/wool-beanie',
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

    const channel3Filters = {};
    if (isRecord(filters)) {
      const priceFilter = {};
      if (Number.isFinite(filters.min_price)) priceFilter.min_price = filters.min_price;
      if (Number.isFinite(filters.max_price)) priceFilter.max_price = filters.max_price;
      if (isRecord(filters.price)) {
        if (Number.isFinite(filters.price.min_price)) priceFilter.min_price = filters.price.min_price;
        if (Number.isFinite(filters.price.max_price)) priceFilter.max_price = filters.price.max_price;
      }
      if (Object.keys(priceFilter).length > 0) {
        channel3Filters.price = priceFilter;
      }

      if (Array.isArray(filters.availability)) {
        channel3Filters.availability = filters.availability;
      } else if (filters.availability === 'in_stock') {
        channel3Filters.availability = ['InStock', 'LimitedAvailability'];
      }

      if (filters.category && typeof filters.category === 'string') {
        channel3Filters.category = filters.category;
      }
      if (filters.gender && typeof filters.gender === 'string') {
        channel3Filters.gender = filters.gender;
      }
      if (Array.isArray(filters.brand_ids)) {
        channel3Filters.brand_ids = filters.brand_ids;
      }
    }

    const payload = {
      query: cleanQuery,
      limit: cleanLimit,
      ...(Object.keys(channel3Filters).length > 0 ? { filters: channel3Filters } : {}),
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
    let products = rawList.slice(0, cleanLimit).map((item) => normalizeProduct(item, {
      source: 'channel3',
      isLive: true,
      observedAt,
    }));

    if (isRecord(filters)) {
      if (filters.merchant_domain) {
        const domainTerm = String(filters.merchant_domain).toLowerCase();
        const filtered = products.filter((item) => String(item.merchantDomain || '').toLowerCase().includes(domainTerm));
        if (filtered.length > 0) products = filtered;
      }
      if (filters.sort_by === 'price_asc') {
        products.sort((a, b) => (a.amountMinor || 0) - (b.amountMinor || 0));
      } else if (filters.sort_by === 'price_desc') {
        products.sort((a, b) => (b.amountMinor || 0) - (a.amountMinor || 0));
      }
    }

    return {
      query: cleanQuery,
      count: products.length,
      products,
      isLive: true,
      source: 'channel3',
    };
  }

  function searchSampleProducts({ query, limit = 10, filters = {} } = {}) {
    const cleanQuery = safeString(query, 200).toLowerCase();
    const cleanLimit = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 10, 50));
    const observedAt = new Date().toISOString();

    let list = cleanQuery
      ? SAMPLE_CHANNEL3_PRODUCTS.filter((item) => {
        const text = `${item.title} ${item.description} ${item.brand} ${item.merchant}`.toLowerCase();
        return cleanQuery.split(/\s+/).some((token) => token && text.includes(token));
      })
      : [...SAMPLE_CHANNEL3_PRODUCTS];

    if (isRecord(filters)) {
      if (Number.isFinite(filters.min_price)) {
        list = list.filter((item) => (item.price || 0) >= filters.min_price);
      }
      if (Number.isFinite(filters.max_price)) {
        list = list.filter((item) => (item.price || 0) <= filters.max_price);
      }
      if (filters.availability === 'in_stock') {
        list = list.filter((item) => String(item.availability || '').toLowerCase().includes('instock'));
      }
      if (filters.merchant_domain) {
        const domainTerm = String(filters.merchant_domain).toLowerCase();
        list = list.filter((item) => String(item.merchant_domain || '').toLowerCase().includes(domainTerm));
      }
      if (filters.sort_by === 'price_asc') {
        list.sort((a, b) => (a.price || 0) - (b.price || 0));
      } else if (filters.sort_by === 'price_desc') {
        list.sort((a, b) => (b.price || 0) - (a.price || 0));
      }
    }

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
      filters: isRecord(filters) ? filters : {},
    };
  }

  return Object.freeze({
    isConfigured,
    searchProducts,
    searchSampleProducts,
  });
}
