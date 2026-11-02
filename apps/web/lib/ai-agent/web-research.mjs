import dns from 'node:dns/promises';
import net from 'node:net';
import { resolvePublicAddresses, requestHttpsStream } from '../api-hub/service.mjs';
import { assertAgentToolAccess } from './agent-settings.mjs';
export const RESEARCH_CONSENT = 'web-research-v1';
export class ResearchError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function publicHttpsUrl(value) {
  let url; try { url = new URL(value); } catch { throw new ResearchError('research_url_invalid'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.href.length > 1800
    || net.isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new ResearchError('research_destination_blocked', 403);
  url.hash = ''; return url;
}
const text = (value, max) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
export function extractPageText(html) {
  return text(html, 524288).replace(/<(script|style|nav|footer|header|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[entity])
    .replace(/\s+/g, ' ').trim().slice(0, 2400);
}
export function createResearchTransport({ resolveHost = host => dns.lookup(host, { all: true, verbatim: true }), requestImpl = requestHttpsStream } = {}) {
  return async (url, { method = 'GET', body, headers = {}, signal } = {}) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    if (signal?.aborted) abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15000); let response;
    try {
      if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504);
      const addresses = await Promise.race([
        resolvePublicAddresses(url.hostname, resolveHost),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new ResearchError('research_canceled_or_timeout', 504)), { once: true })),
      ]);
      if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504);
      response = await requestImpl({ url, method, body, headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'KeusResearch/1.0', ...headers }, addresses, signal: controller.signal, maxResponseBytes: 524288 });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 524288) throw new ResearchError('research_page_too_large', 502); chunks.push(chunk); }
      return { status: response.status, contentType: response.contentType, body: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
      if (error.code === 'connector_destination_blocked') throw new ResearchError('research_destination_blocked', 403);
      if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504);
      if (error instanceof ResearchError) throw error;
      throw new ResearchError('research_network_unavailable', 502);
    } finally { response?.cancel?.(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}
export async function readPublicPage(rawUrl, { transport = createResearchTransport(), signal } = {}) {
  const url = publicHttpsUrl(rawUrl);
  const response = await transport(url, { signal });
  // No redirect following, cookies, browser scripts, authenticated pages or binary downloads.
  if (response.status !== 200 || !['text/html', 'text/plain', 'application/xhtml+xml'].includes(response.contentType)) throw new ResearchError('research_page_unreadable', 502);
  const content = response.contentType === 'text/plain' ? text(response.body, 2400).trim() : extractPageText(response.body);
  if (content.length < 80) throw new ResearchError('research_page_unreadable', 502);
  return { url: url.href, text: content };
}
export function createWebResearch({ enabled = false, apiKey = '', transport = createResearchTransport(), now = Date.now } = {}) {
  const windows = new Map(); let active = 0;
  const configured = enabled === true && Boolean(apiKey.trim());
  const readiness = { web_search: { ready: configured }, read_webpage: { ready: configured } };
  return { configured, readiness,
    async run({ agent, query, userId, signal, onStage = async () => {} }) {
      if (!configured) throw new ResearchError('research_not_configured', 503);
      try { assertAgentToolAccess(agent, 'web_search', readiness); assertAgentToolAccess(agent, 'read_webpage', readiness); }
      catch { throw new ResearchError('research_permission_required', 403); }
      if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new ResearchError('research_query_invalid');
      if (!userId) throw new ResearchError('research_authentication_required', 401);
      const time = now(); for (const [id, item] of windows) if (time - item.start >= 3600000) windows.delete(id);
      const bucket = windows.get(userId) || { start: time, count: 0 };
      if (bucket.count >= 10 || active >= 2) throw new ResearchError('research_rate_limited', 429);
      bucket.count++; windows.set(userId, bucket); active++;
      const controller = new AbortController(); const abort = () => controller.abort();
      if (signal?.aborted) abort(); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 45000);
      try {
        if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504);
        await onStage('searching');
        const response = await transport(new URL('https://api.tavily.com/search'), {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: Buffer.from(JSON.stringify({ query: query.trim(), search_depth: 'basic', max_results: 3, topic: 'general', auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false })), signal: controller.signal,
        });
        if ([429, 432, 433, 434].includes(response.status)) throw new ResearchError('research_provider_limit', 429);
        if ([401, 403].includes(response.status)) throw new ResearchError('research_credentials_rejected', 503);
        if (response.status !== 200) throw new ResearchError('research_search_unavailable', 503);
        let data; try { data = JSON.parse(response.body); } catch { throw new ResearchError('research_invalid_response', 502); }
        if (!Array.isArray(data.results)) throw new ResearchError('research_invalid_response', 502);
        await onStage('reading');
        const sources = [], seen = new Set();
        for (const result of data.results.slice(0, 3)) {
          if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504);
          let url; try { url = publicHttpsUrl(result.url).href; } catch { continue; }
          if (seen.has(url)) continue; seen.add(url);
          let excerpt = text(result.content, 2400).trim(), pageRead = false;
          try { const page = await readPublicPage(url, { transport, signal: controller.signal }); excerpt = page.text; pageRead = true; }
          catch (error) { if (error.code === 'research_destination_blocked') continue; if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504); }
          if (!excerpt) continue;
          sources.push({ id: sources.length + 1, title: text(result.title, 160) || new URL(url).hostname, url, excerpt, pageRead });
        }
        if (!sources.length) throw new ResearchError('research_no_sources', 502);
        await onStage('writing');
        return { sources, retrievedAt: new Date(now()).toISOString() };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active--; }
    },
  };
}
export function researchSourcesMarkdown(research) {
  const escape = value => value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
  return '\n\n### Sources\n' + research.sources.map(s => `- [${s.id}] [${escape(s.title)}](${s.url.replace(/[<>\s()]/g, c => encodeURIComponent(c))}) — ${s.pageRead ? 'page excerpt read' : 'search excerpt only; page could not be read'}`).join('\n')
    + `\n\nRetrieved ${research.retrievedAt.slice(0, 10)}. Sources can be incomplete or out of date; review important claims.`;
}
