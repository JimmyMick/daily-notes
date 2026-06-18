'use strict';

// Latest sports scores for the second ticker line, from ESPN's public
// scoreboard JSON API (same family as the ESPN news endpoint). We pull a fixed
// set of major leagues, keep games that are live or final, plus today's
// upcoming games, and order live first. Cached briefly so the faster score
// polling doesn't hammer the API. Leagues are defined here in code (the API is
// ESPN-specific JSON, not a generic feed).
const UA = 'Mozilla/5.0 (compatible; daily-notes/1.0; +https://github.com/)';
const TTL_MS = 60 * 1000; // scores change fast — refresh at most once a minute
const MAX_GAMES = 20; // bound the ticker width

const LEAGUES = [
  { name: 'NFL', path: 'football/nfl' },
  { name: 'MLB', path: 'baseball/mlb' },
  { name: 'NBA', path: 'basketball/nba' },
  { name: 'NHL', path: 'hockey/nhl' },
  { name: 'WC', path: 'soccer/fifa.world' },
];

const STATE_RANK = { in: 0, post: 1, pre: 2 }; // live, then final, then upcoming

let cache = { at: 0, games: [] };

function isToday(iso) {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// Turn one ESPN event into a ticker game, or null to skip it.
function toGame(league, ev) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp || !comp.competitors || comp.competitors.length < 2) return null;
  const cs = comp.competitors;
  const away = cs.find((x) => x.homeAway === 'away') || cs[0];
  const home = cs.find((x) => x.homeAway === 'home') || cs[1];
  const aa = (away.team && away.team.abbreviation) || '?';
  const ha = (home.team && home.team.abbreviation) || '?';
  const state = (ev.status && ev.status.type && ev.status.type.state) || 'pre';
  let detail = (ev.status && ev.status.type && ev.status.type.shortDetail) || '';

  let text;
  if (state === 'pre') {
    if (!isToday(ev.date)) return null; // drop far-off / offseason placeholders
    detail = detail.split(' - ').pop(); // "9/9 - 8:20 PM EDT" -> "8:20 PM EDT"
    text = `${aa} @ ${ha}${detail ? ' · ' + detail : ''}`;
  } else {
    text = `${aa} ${away.score}–${home.score} ${ha}${detail ? ' · ' + detail : ''}`;
  }
  const link = (Array.isArray(ev.links) && ev.links.find((l) => l.href) || {}).href || '';
  return { league: league.name, text, link, state, live: state === 'in', rank: STATE_RANK[state] ?? 3 };
}

async function fetchLeague(league) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.events || []).map((ev) => toGame(league, ev)).filter(Boolean);
}

async function refresh() {
  const prev = cache.games;
  const settled = await Promise.allSettled(LEAGUES.map(fetchLeague));
  let games = [];
  let anyOk = false;
  settled.forEach((r) => {
    if (r.status === 'fulfilled') { anyOk = true; games = games.concat(r.value); }
    else console.error(`[scores] league fetch failed: ${r.reason && r.reason.message}`);
  });
  // If every league failed, keep the last-good list rather than blanking.
  if (!anyOk && prev.length) return;
  games.sort((a, b) => a.rank - b.rank);
  cache = { at: Date.now(), games: games.slice(0, MAX_GAMES) };
}

async function getScores() {
  if (!cache.at || Date.now() - cache.at > TTL_MS) await refresh();
  return { games: cache.games, fetchedAt: cache.at };
}

module.exports = { getScores, LEAGUES };
