'use strict';

// Fetches latest headlines for the ticker. NPR and NRK publish normal RSS;
// ESPN's RSS is defunct, so we use their JSON "now" headlines API instead.
// Results are cached in memory (all sources refreshed together) so client
// polling doesn't hammer the feeds; the per-source count is applied per request.
const Parser = require('rss-parser');

const UA = 'Mozilla/5.0 (compatible; daily-notes/1.0; +https://github.com/)';
const parser = new Parser({ timeout: 9000, headers: { 'User-Agent': UA } });

// Up to this many items are cached per source; the UI's count slices from these.
const MAX_PER_SOURCE = 20;
const TTL_MS = 5 * 60 * 1000; // refresh feeds at most every 5 min

const SOURCES = [
  { name: 'NPR', kind: 'rss', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'NRK', kind: 'rss', url: 'https://www.nrk.no/toppsaker.rss' },
  { name: 'ESPN', kind: 'espn', url: 'https://now.core.api.espn.com/v1/sports/news?limit=20' },
];

let cache = { at: 0, bySource: {} };

async function fetchRss(url) {
  const feed = await parser.parseURL(url);
  return (feed.items || [])
    .map((i) => ({ title: (i.title || '').trim(), link: i.link || '' }))
    .filter((i) => i.title);
}

async function fetchEspn(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.headlines || [])
    .map((h) => ({
      title: (h.headline || '').trim(),
      link: (h.links && h.links.web && h.links.web.href) || '',
    }))
    .filter((i) => i.title);
}

// Refresh every source. A source that fails keeps its previously cached items
// (graceful degradation) rather than vanishing from the ticker.
async function refresh() {
  const prev = cache.bySource || {};
  const bySource = {};
  await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const items = src.kind === 'espn' ? await fetchEspn(src.url) : await fetchRss(src.url);
        bySource[src.name] = items.slice(0, MAX_PER_SOURCE);
      } catch (e) {
        console.error(`[news] ${src.name} fetch failed: ${e.message}`);
        bySource[src.name] = prev[src.name] || [];
      }
    })
  );
  cache = { at: Date.now(), bySource };
}

// Return up to `perSource` headlines from each source, in SOURCES order.
// Refreshes the cache first if it's stale or empty.
async function getHeadlines(perSource) {
  const n = Math.max(1, Math.min(MAX_PER_SOURCE, parseInt(perSource, 10) || 3));
  if (!cache.at || Date.now() - cache.at > TTL_MS) await refresh();
  const items = [];
  for (const src of SOURCES) {
    for (const it of (cache.bySource[src.name] || []).slice(0, n)) {
      items.push({ source: src.name, title: it.title, link: it.link });
    }
  }
  return { items, fetchedAt: cache.at };
}

module.exports = { getHeadlines, sources: SOURCES.map((s) => s.name) };
