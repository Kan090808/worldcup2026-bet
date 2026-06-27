#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const MATCH_SOURCE_URL = process.env.WC_SOURCE_URL || 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const OUT = path.join(process.cwd(), 'data', 'worldcup2026.json');
const KO_ROUNDS = new Set(['Round of 32', 'Round Of 32', 'Round of 16', 'Round Of 16', 'Quarter-final', 'Quarter Final', 'Semi-final', 'Semi Final', 'Match for third place', 'Final']);

const TEAM_ELO = {
  France: 2065, Brazil: 2045, Spain: 2035, Argentina: 2025, England: 1995,
  Portugal: 1975, Netherlands: 1955, Germany: 1935, Colombia: 1905, Croatia: 1890,
  Uruguay: 1885, Belgium: 1875, Switzerland: 1845, Morocco: 1840, USA: 1815,
  'United States': 1815, Mexico: 1805, Japan: 1790, Senegal: 1780, Norway: 1775,
  Ecuador: 1770, Austria: 1765, Sweden: 1760, 'Ivory Coast': 1740, Australia: 1715,
  Egypt: 1705, Iran: 1695, Algeria: 1685, Paraguay: 1680, Turkey: 1675,
  Ghana: 1660, Canada: 1655, 'South Korea': 1650, Scotland: 1645, Tunisia: 1635,
  'South Africa': 1605, Qatar: 1585, 'Saudi Arabia': 1580, Panama: 1565,
  'Bosnia and Herzegovina': 1560, 'Bosnia & Herzegovina': 1560, 'DR Congo': 1555,
  Uzbekistan: 1545, 'New Zealand': 1530, Iraq: 1515, Jordan: 1505, Haiti: 1485,
  'Cape Verde': 1480, 'Curaçao': 1465, Curacao: 1465, Czechia: 1640, 'Czech Republic': 1640
};
const DEFAULT_ELO = 1600;
const MODEL_VERSION = 'elo-poisson-margin-v1';
const H2H_MARGIN = 0.06;
const SPREAD_MARGIN = 0.055;
const CORRECT_SCORE_MARGIN = 0.12;

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
  const score = Array.isArray(ft) ? { home: Number(ft[0]), away: Number(ft[1]) } : m.score && Number.isFinite(m.score.home) && Number.isFinite(m.score.away) ? { home: Number(m.score.home), away: Number(m.score.away) } : null;
  const result = score ? (score.home > score.away ? 'home' : score.home < score.away ? 'away' : 'draw') : null;
  return {
    id: String(m.id || m.num || `${m.date}-${m.team1}-${m.team2}`),
    num: m.num || m.match_number || null,
    round: m.round || m.stage || '',
    date: m.date || '',
    time: m.time || '',
    kickoffUTC: m.kickoffUTC || parseUTC(m.date, m.time),
    team1: m.team1 || m.home_team || m.home || '',
    team2: m.team2 || m.away_team || m.away || '',
    venue: m.ground || m.venue || '',
    score,
    result,
    status: score ? 'finished' : 'scheduled',
    odds: null
  };
}

function isTbd(name) {
  return !name || /^TBD/i.test(name) || /^[WL]\d+/.test(name) || String(name).includes('/');
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function factorial(n) {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

function poisson(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function decimalOdd(probability, margin) {
  if (!Number.isFinite(probability) || probability <= 0) return null;
  return Number(clamp(1 / (probability * (1 + margin)), 1.03, 99).toFixed(2));
}

function expectedGoals(team1, team2) {
  const elo1 = TEAM_ELO[team1] || DEFAULT_ELO;
  const elo2 = TEAM_ELO[team2] || DEFAULT_ELO;
  const diff = clamp(elo1 - elo2, -450, 450);
  const ratioHome = Math.pow(10, diff / 900);
  const ratioAway = Math.pow(10, -diff / 900);
  const rawHome = 1.28 * ratioHome;
  const rawAway = 1.28 * ratioAway;
  const targetTotal = clamp(2.45 + ((elo1 + elo2 - 3400) / 1000) * 0.18, 2.25, 2.85);
  const scale = targetTotal / (rawHome + rawAway);
  return { elo1, elo2, mu1: clamp(rawHome * scale, 0.35, 3.7), mu2: clamp(rawAway * scale, 0.35, 3.7) };
}

function scoreMatrix(mu1, mu2, maxGoals = 8) {
  const rows = [];
  let mass = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisson(h, mu1) * poisson(a, mu2);
      mass += p;
      rows.push({ h, a, p });
    }
  }
  return rows.map(r => ({ ...r, p: r.p / mass }));
}

function modelOdds(match) {
  if (isTbd(match.team1) || isTbd(match.team2)) return null;
  const { elo1, elo2, mu1, mu2 } = expectedGoals(match.team1, match.team2);
  const matrix = scoreMatrix(mu1, mu2, 8);
  const pHome = matrix.filter(s => s.h > s.a).reduce((sum, s) => sum + s.p, 0);
  const pDraw = matrix.filter(s => s.h === s.a).reduce((sum, s) => sum + s.p, 0);
  const pAway = matrix.filter(s => s.h < s.a).reduce((sum, s) => sum + s.p, 0);

  const h2h = [
    { key: 'home', label: `${match.team1} 勝`, price: decimalOdd(pHome, H2H_MARGIN), probability: Number(pHome.toFixed(4)), bookmaker: 'Model' },
    { key: 'draw', label: '和局', price: decimalOdd(pDraw, H2H_MARGIN), probability: Number(pDraw.toFixed(4)), bookmaker: 'Model' },
    { key: 'away', label: `${match.team2} 勝`, price: decimalOdd(pAway, H2H_MARGIN), probability: Number(pAway.toFixed(4)), bookmaker: 'Model' }
  ];

  const diff = mu1 - mu2;
  const homeLine = diff >= 0.95 ? -1.5 : diff >= 0 ? -0.5 : diff <= -0.95 ? 1.5 : 0.5;
  const awayLine = -homeLine;
  const pHomeCover = matrix.filter(s => s.h + homeLine > s.a).reduce((sum, s) => sum + s.p, 0);
  const pAwayCover = matrix.filter(s => s.a + awayLine > s.h).reduce((sum, s) => sum + s.p, 0);
  const spreads = [
    { key: 'home', label: `${match.team1} ${homeLine > 0 ? '+' : ''}${homeLine}`, point: homeLine, price: decimalOdd(pHomeCover, SPREAD_MARGIN), probability: Number(pHomeCover.toFixed(4)), bookmaker: 'Model' },
    { key: 'away', label: `${match.team2} ${awayLine > 0 ? '+' : ''}${awayLine}`, point: awayLine, price: decimalOdd(pAwayCover, SPREAD_MARGIN), probability: Number(pAwayCover.toFixed(4)), bookmaker: 'Model' }
  ];

  const correct_score = matrix.filter(s => s.h <= 5 && s.a <= 5).sort((x, y) => y.p - x.p).slice(0, 16).map(s => ({
    key: `${s.h}-${s.a}`,
    score: `${s.h}-${s.a}`,
    label: `${s.h}-${s.a}`,
    homeScore: s.h,
    awayScore: s.a,
    price: decimalOdd(s.p, CORRECT_SCORE_MARGIN),
    probability: Number(s.p.toFixed(4)),
    bookmaker: 'Model'
  }));

  return {
    source: 'Model: Elo + Poisson + margin',
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    inputs: { homeElo: elo1, awayElo: elo2, expectedGoalsHome: Number(mu1.toFixed(3)), expectedGoalsAway: Number(mu2.toFixed(3)), margins: { h2h: H2H_MARGIN, spreads: SPREAD_MARGIN, correct_score: CORRECT_SCORE_MARGIN } },
    h2h,
    spreads,
    correct_score
  };
}

async function fetchMatches() {
  try {
    const res = await fetch(MATCH_SOURCE_URL, { headers: { 'user-agent': 'worldcup2026-bet-fetcher' } });
    if (!res.ok) throw new Error(`Match fetch failed: ${res.status} ${res.statusText}`);
    const source = await res.json();
    const rawMatches = Array.isArray(source.matches) ? source.matches : [];
    return { source: MATCH_SOURCE_URL, rawMatches };
  } catch (error) {
    if (fs.existsSync(OUT)) {
      const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (Array.isArray(existing.matches) && existing.matches.length) {
        console.warn(`Remote fetch failed, reusing existing matches: ${error.message}`);
        return { source: `${MATCH_SOURCE_URL} (reuse-existing-after-fetch-error)`, rawMatches: existing.matches };
      }
    }
    throw error;
  }
}

async function main() {
  const { source, rawMatches } = await fetchMatches();
  const normalized = rawMatches.map(normalizeMatch);
  const knockout = normalized.filter(m => KO_ROUNDS.has(m.round));
  const matches = knockout.length ? knockout : normalized;
  if (!matches.length) throw new Error('Fetched JSON has no usable matches; keep existing data/worldcup2026.json unchanged.');
  for (const match of matches) match.odds = modelOdds(match);
  const payload = {
    sourceUrl: source,
    oddsSource: 'model',
    oddsModel: {
      version: MODEL_VERSION,
      basis: ['Elo-like team rating', 'Poisson score distribution', 'bookmaker-style margin'],
      note: 'Virtual model odds only. These are not bookmaker odds.'
    },
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
