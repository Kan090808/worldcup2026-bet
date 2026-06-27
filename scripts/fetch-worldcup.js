#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SOURCE_URL = process.env.WC_SOURCE_URL || 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const OUT = path.join(process.cwd(), 'data', 'worldcup2026.json');
const KO_ROUNDS = new Set(['Round of 32', 'Round of 16', 'Quarter-final', 'Semi-final', 'Match for third place', 'Final']);

function parseUTC(date, time) {
  if (!date || !time) return null;
  const m = String(time).match(/(\d{1,2}):(\d{2})\s+UTC([+-]\d{1,2})/i);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const offset = Number(m[3]);
  const utc = new Date(`${date}T00:00:00Z`).getTime() + (hh * 60 + mm) * 60_000 - offset * 3_600_000;
  return new Date(utc).toISOString();
}

function normalizeMatch(m) {
  const ft = m.score && m.score.ft;
  const score = Array.isArray(ft) ? { home: Number(ft[0]), away: Number(ft[1]) } : null;
  const result = score ? (score.home > score.away ? 'home' : score.home < score.away ? 'away' : 'draw') : null;
  return {
    id: String(m.num || `${m.date}-${m.team1}-${m.team2}`),
    num: m.num || null,
    round: m.round || '',
    date: m.date || '',
    time: m.time || '',
    kickoffUTC: parseUTC(m.date, m.time),
    team1: m.team1 || '',
    team2: m.team2 || '',
    venue: m.ground || '',
    score,
    result,
    status: score ? 'finished' : 'scheduled'
  };
}

async function main() {
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'worldcup2026-bet-fetcher' } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

  const source = await res.json();
  const rawMatches = Array.isArray(source.matches) ? source.matches : [];
  const matches = rawMatches.filter(m => KO_ROUNDS.has(m.round)).map(normalizeMatch);

  const payload = {
    sourceUrl: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    matchCount: matches.length,
    matches
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${matches.length} matches to ${OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
