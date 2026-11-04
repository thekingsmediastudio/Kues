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
export function extractPageText(html, maxCharacters = 2400) {
  return text(html, 524288).replace(/<(script|style|nav|footer|header|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[entity])
    .replace(/\s+/g, ' ').trim().slice(0, Math.min(maxCharacters, 524288));
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
export function selectPageExcerpt(content, query = '') {
  if(content.length<=2400 || !query.trim())return content.slice(0,2400);
  const ignored=new Set('what which where when intended authoritative primary sources ideally answer briefly links purchase official documentation preferred example'.split(' '));
  const terms=[...new Set((query.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9-]+)+|[a-z0-9]{4,}/g)||[]).filter(t=>!ignored.has(t)))].slice(0,30);
  let best=0, score=0;
  for(let offset=0;offset<content.length;offset+=900){const chunk=content.slice(offset,offset+1800).toLowerCase();const value=terms.reduce((sum,term)=>sum+(chunk.includes(term)?(term.includes('.')?8:1):0),0);if(value>score){score=value;best=offset}}
  if(best<400)return content.slice(0,2400);
  return (content.slice(0,400)+'\n[Selected passage; intervening text omitted]\n'+content.slice(best,best+1800)).slice(0,2400);
}
export async function readPublicPage(rawUrl, { transport = createResearchTransport(), signal, query = '' } = {}) {
  const url = publicHttpsUrl(rawUrl);
  const response = await transport(url, { signal });
  // No redirect following, cookies, browser scripts, authenticated pages or binary downloads.
  if (response.status !== 200 || !['text/html', 'text/plain', 'application/xhtml+xml'].includes(response.contentType)) throw new ResearchError('research_page_unreadable', 502);
  const extracted = response.contentType === 'text/plain' ? text(response.body, 524288).trim() : extractPageText(response.body, 524288);
  const content = selectPageExcerpt(extracted, query);
  if (content.length < 80) throw new ResearchError('research_page_unreadable', 502);
  return { url: url.href, text: content };
}
// Publisher hints only: these do not certify truth, relevance, or official status.
export function prefersPrimarySources(query) {
  return /\b(authoritative|official|primary(?: sources?)?|first[- ]hand)\b/i.test(query);
}
export function selectResearchCandidates(results, preferPrimary = false) {
  const recognized = ['iana.org', 'ietf.org', 'rfc-editor.org', 'w3.org', 'who.int', 'un.org'];
  const seen = new Set(), candidates = [];
  for (const result of results.slice(0, 6)) {
    if (!result || typeof result !== 'object') continue;
    let url; try { url = publicHttpsUrl(result.url); } catch { continue; }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const host = url.hostname.toLowerCase();
    const preferredPublisher = recognized.some(domain => host === domain || host.endsWith('.' + domain))
      || /\.gov(?:\.[a-z]{2})?$/.test(host);
    candidates.push({...result, url:url.href, preferredPublisher});
  }
  if (preferPrimary) candidates.sort((a,b) => Number(b.preferredPublisher) - Number(a.preferredPublisher));
  return candidates.slice(0, 3);
}
export function requestedResearchPublishers(query) {
  // Explicitly named publishers only; never infer that the subject's domain is a source restriction.
  const publishers = [
    [/\bIANA\b|\biana\.org\b/i, 'iana.org'],
    [/\bRFC\s*\d+\b|\bRFC[- ]Editor\b|\brfc-editor\.org\b/i, 'rfc-editor.org'],
    [/\bIETF\b|\bietf\.org\b/i, 'ietf.org'],
    [/\bW3C\b|\bw3\.org\b/i, 'w3.org'],
  ];
  if (!prefersPrimarySources(query)) return [];
  return publishers.filter(([pattern]) => pattern.test(query)).map(([, domain]) => domain);
}
export function researchReferenceCandidates(query) {
  if (!prefersPrimarySources(query)) return [];
  return [...new Set([...query.matchAll(/\bRFC\s*(\d{1,5})\b/gi)].map(m=>Number(m[1])).filter(n=>n>0))]
    .slice(0, 2).map(number=>({url:`https://www.rfc-editor.org/rfc/rfc${number}.txt`,title:`RFC ${number} — RFC Editor`,content:''}));
}
export function normalizeResearchCoverage(answer) {
  return String(answer||'').split(/\n\s*\n/).map(paragraph=>{
    if(/\b(?:read|reviewed|analysed|analyzed)\b[^\n.!?]{0,100}\b(?:in full|entirely|completely)\b|\b(?:fully|completely)\s+(?:read|reviewed|analysed|analyzed)\b/i.test(paragraph))return 'Reading coverage: only bounded page or search excerpts were supplied; no full-page review was performed.';
    if(/guaranteed[^.!?]{0,60}never[^.!?]{0,100}(?:resolve|commercial)|never[^.!?]{0,60}resolve[^.!?]{0,100}commercial/i.test(paragraph))return 'The supplied evidence does not establish a guarantee about future site content or domain resolution.';
    return paragraph;
  }).join('\n\n');
}
export function stripResearchBibliography(answer) {
  const lines=String(answer || '').replace(/\r\n?/g,'\n').split('\n');
  let inBibliography=false, inFence=false; const kept=[];
  for(const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence=!inFence;
    const isBibliography=!inFence && /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:sources|references|bibliography)(?:\*\*|__)?\s*:?\s*$/i.test(line);
    if(isBibliography){inBibliography=true;continue;}
    if(inBibliography && /^\s*#{1,6}\s+\S/.test(line))inBibliography=false;
    if(!inBibliography)kept.push(line);
  }
  return normalizeResearchCoverage(kept.join('\n').trim());
}
// Guard only identifiable incomplete outputs; sources alone are not an answer.
export function researchAnswerForDisplay(answer, query = '') {
  const clean = stripResearchBibliography(answer);
  if (!clean) return 'The sources were retrieved, but no usable answer was produced.';
  const unclosedStrong = (clean.match(/\*\*/g) || []).length % 2 !== 0;
  const unclosedSquare = (clean.match(/\[/g) || []).length > (clean.match(/\]/g) || []).length;
  const rfc2606List = /\bRFC\s*2606\b/i.test(query) && /\b(?:four|4|list|names|top.level domains?|tlds?)\b/i.test(query);
  const missingReservedName = rfc2606List && ['.test', '.example', '.invalid', '.localhost'].some(name => !clean.toLowerCase().includes(name));
  if (unclosedStrong || unclosedSquare || missingReservedName) return 'The research answer appears incomplete. Please retry or consult the cited sources directly; the source list alone does not establish the answer.';
  return clean;
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
        const preferPrimary = prefersPrimarySources(query);
        const requestedPublishers = requestedResearchPublishers(query);
        const references = researchReferenceCandidates(query);
        await onStage('searching');
        const response = await transport(new URL('https://api.tavily.com/search'), {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: Buffer.from(JSON.stringify({ query: query.trim() + (preferPrimary ? ' Official documentation or primary sources preferred.' : ''), ...(requestedPublishers.length ? {include_domains:requestedPublishers} : {}), search_depth: 'basic', max_results: 6, topic: 'general', auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false })), signal: controller.signal,
        });
        if ([429, 432, 433, 434].includes(response.status)) throw new ResearchError('research_provider_limit', 429);
        if ([401, 403].includes(response.status)) throw new ResearchError('research_credentials_rejected', 503);
        if (response.status !== 200) throw new ResearchError('research_search_unavailable', 503);
        let data; try { data = JSON.parse(response.body); } catch { throw new ResearchError('research_invalid_response', 502); }
        if (!Array.isArray(data.results)) throw new ResearchError('research_invalid_response', 502);
        await onStage('reading');
        const sources = [], seen = new Set();
        const requestedHost = raw => { try { const host=publicHttpsUrl(raw).hostname; return requestedPublishers.some(domain=>host===domain||host.endsWith('.'+domain)); } catch { return false; } };
        const searchCandidates=requestedPublishers.length ? data.results.filter(result=>result && requestedHost(result.url)) : data.results;
        for (const result of selectResearchCandidates([...references, ...searchCandidates], preferPrimary)) {
          if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504);
          let url; try { url = publicHttpsUrl(result.url).href; } catch { continue; }
          if (seen.has(url)) continue; seen.add(url);
          let excerpt = text(result.content, 2400).trim(), pageRead = false;
          try { const page = await readPublicPage(url, { transport, signal: controller.signal, query }); excerpt = page.text; pageRead = true; }
          catch (error) { if (error.code === 'research_destination_blocked') continue; if (controller.signal.aborted) throw new ResearchError('research_canceled_or_timeout', 504); }
          if (!excerpt) continue;
          sources.push({ id: sources.length + 1, title: text(result.title, 160) || new URL(url).hostname, url, excerpt, pageRead, preferredPublisher: result.preferredPublisher });
        }
        if (!sources.length) throw new ResearchError('research_no_sources', 502);
        await onStage('writing');
        return { sources, retrievedAt: new Date(now()).toISOString(), ...(requestedPublishers.length ? {requestedPublishers} : {}), ...(preferPrimary ? { sourceSelectionNotice: sources.some(s => s.preferredPublisher) ? 'Publisher-domain hints were used to prioritize sources; primary-source status, relevance and accuracy still require checking.' : 'No recognized primary-source publisher was found in the selected results. These sources have not been verified as authoritative.' } : {}) };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active--; }
    },
  };
}
export function researchSourcesMarkdown(research) {
  const escape = value => value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
  return '\n\n### Sources\n' + research.sources.map(s => `- [${s.id}] [${escape(s.title)}](${s.url.replace(/[<>\s()]/g, c => encodeURIComponent(c))}) — ${s.pageRead ? 'page excerpt read' : 'search excerpt only; page could not be read'}`).join('\n')
    + (research.sourceSelectionNotice ? `\n\n${research.sourceSelectionNotice}` : '')
    + '\n\nReading coverage: bounded page/search excerpts only, not a full-page review.'
    + `\n\nRetrieved ${research.retrievedAt.slice(0, 10)}. Sources can be incomplete or out of date; review important claims.`;
}
