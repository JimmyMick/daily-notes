'use strict';

// Fetches latest headlines for the ticker from a configurable list of sources.
// Most sources are standard RSS/Atom feeds (handled generically by rss-parser);
// ESPN's RSS is defunct, so its JSON "now" headlines API is detected by URL and
// parsed specially. Each feed is cached on its own (keyed by URL) so adding or
// removing sources just works and client polling doesn't hammer the feeds.
const Parser = require('rss-parser');

const UA = 'Mozilla/5.0 (compatible; daily-notes/1.0; +https://github.com/)';
const parser = new Parser({ timeout: 9000, headers: { 'User-Agent': UA } });

const MAX_PER_SOURCE = 20; // cap cached items per feed; UI count slices from these
const TTL_MS = 5 * 60 * 1000; // refetch a given feed at most every 5 min
const MAX_SOURCES = 12; // bound the fan-out of a single /api/news call

// Seeds the source list on first run; fully editable in Settings afterward.
const DEFAULT_SOURCES = [
  { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'NRK', url: 'https://www.nrk.no/toppsaker.rss' },
  { name: 'ESPN', url: 'https://now.core.api.espn.com/v1/sports/news?limit=20' },
];

// ESPN's headlines come from a JSON API, not RSS — detect it by host.
function isEspnJson(url) {
  return /(^|\.)now\.core\.api\.espn\.com$/i.test(safeHost(url));
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}

async function fetchRss(url) {
  const feed = await parser.parseURL(url);
  const items = (feed.items || [])
    .map((i) => ({ title: (i.title || '').trim(), link: i.link || '' }))
    .filter((i) => i.title);
  return { items, feedTitle: (feed.title || '').trim() };
}

async function fetchEspnJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = (data.headlines || [])
    .map((h) => ({
      title: (h.headline || '').trim(),
      link: (h.links && h.links.web && h.links.web.href) || '',
    }))
    .filter((i) => i.title);
  return { items, feedTitle: 'ESPN' };
}

// Per-URL cache. A failed refresh keeps the last-good items so a flaky feed
// degrades gracefully instead of vanishing from the ticker.
const cache = new Map(); // url -> { at, items, name }

async function getForSource(src) {
  const cached = cache.get(src.url);
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  try {
    const { items, feedTitle } = isEspnJson(src.url) ? await fetchEspnJson(src.url) : await fetchRss(src.url);
    // Prefer the user-given name; else the feed's own title; else the hostname.
    const name = src.name || feedTitle || safeHost(src.url) || 'news';
    const entry = { at: Date.now(), items: items.slice(0, MAX_PER_SOURCE), name };
    cache.set(src.url, entry);
    return entry;
  } catch (e) {
    console.error(`[news] ${src.name || src.url} fetch failed: ${e.message}`);
    if (cached) return cached; // serve stale rather than dropping the source
    return { at: Date.now(), items: [], name: src.name || safeHost(src.url) || 'news' };
  }
}

// Return up to `perSource` headlines from each configured source, in order.
// `sources` is [{ name, url }]; falls back to the defaults if none given.
async function getHeadlines(perSource, sources) {
  const n = Math.max(1, Math.min(MAX_PER_SOURCE, parseInt(perSource, 10) || 3));
  const list = (Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES).slice(0, MAX_SOURCES);
  const entries = await Promise.all(list.map(getForSource));
  const items = [];
  for (const entry of entries) {
    for (const it of entry.items.slice(0, n)) {
      items.push({ source: entry.name, title: it.title, link: it.link });
    }
  }
  return { items, fetchedAt: Date.now() };
}

module.exports = { getHeadlines, DEFAULT_SOURCES, MAX_SOURCES };
