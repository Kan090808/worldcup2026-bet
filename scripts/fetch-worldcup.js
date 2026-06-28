#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { fileURLToPath } = require('url');

const MATCH_SOURCE_URL = process.env.WC_SOURCE_URL || 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const PUBLIC_SOURCE_URL = process.env.WC_PUBLIC_SOURCE_URL || MATCH_SOURCE_URL;
const OUT = path.join(process.cwd(), 'data', 'worldcup2026.json');

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
const CHAMPION_MARGIN = 0.12;
const THIRD_PLACE_ASSIGNMENTS = {
  'B,D,E,F,I,J,K,L': { 74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 85: 'I', 87: 'L' }
};

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
    group: m.group || '',
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
  const value = String(name || '');
  return !value || /^TBD/i.test(value) || /^[WL]\d+/.test(value) || /^[1-3][A-L]$/.test(value) || value.includes('/');
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

function tableRows(matches) {
  const rows = new Map();
  const row = team => {
    if (!rows.has(team)) rows.set(team, { team, played: 0, points: 0, gd: 0, gf: 0 });
    return rows.get(team);
  };
  for (const m of matches) {
    if (!m.group || !m.score || isTbd(m.team1) || isTbd(m.team2)) continue;
    const a = row(m.team1);
    const b = row(m.team2);
    const hs = Number(m.score.home);
    const as = Number(m.score.away);
    a.played++;
    b.played++;
    a.gf += hs;
    b.gf += as;
    a.gd += hs - as;
    b.gd += as - hs;
    if (hs > as) a.points += 3;
    else if (hs < as) b.points += 3;
    else {
      a.points++;
      b.points++;
    }
  }
  return [...rows.values()].sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team));
}

function groupQualifiers(matches) {
  const byGroup = new Map();
  for (const m of matches) {
    if (!m.group) continue;
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group).push(m);
  }
  const topTwo = [];
  const thirds = [];
  for (const groupMatches of byGroup.values()) {
    const rows = tableRows(groupMatches);
    topTwo.push(...rows.slice(0, 2).map(r => r.team));
    if (rows[2]) thirds.push(rows[2]);
  }
  thirds.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team));
  return [...new Set([...topTwo, ...thirds.slice(0, 8).map(r => r.team)])];
}

function groupTables(matches) {
  const tables = {};
  for (const letter of 'ABCDEFGHIJKL') tables[letter] = tableRows(matches.filter(m => m.group === `Group ${letter}`));
  return tables;
}

function fillRoundOf32(matches) {
  const tables = groupTables(matches);
  const thirds = Object.entries(tables)
    .map(([group, rows]) => ({ group, ...rows[2] }))
    .filter(x => x.team)
    .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team))
    .slice(0, 8);
  const thirdGroups = thirds.map(x => x.group).sort().join(',');
  const thirdAssignments = THIRD_PLACE_ASSIGNMENTS[thirdGroups];
  if (!thirdAssignments) return;
  const thirdTeams = Object.fromEntries(thirds.map(x => [x.group, x.team]));
  const slotTeam = slot => {
    const m = String(slot).match(/^([12])([A-L])$/);
    if (m) return tables[m[2]]?.[Number(m[1]) - 1]?.team;
    return null;
  };
  for (const match of matches) {
    if (match.round !== 'Round of 32') continue;
    if (isTbd(match.team1)) match.team1 = slotTeam(match.team1) || match.team1;
    if (isTbd(match.team2)) match.team2 = slotTeam(match.team2) || thirdTeams[thirdAssignments[match.num]] || match.team2;
  }
}

function championOdds(matches) {
  const qualified = groupQualifiers(matches);
  const fallback = [...new Set(matches.flatMap(m => [m.team1, m.team2]).filter(t => !isTbd(t)))];
  let alive = new Set(qualified.length ? qualified : fallback);
  for (const m of matches) {
    if (!m.score || !m.round || m.group || isTbd(m.team1) || isTbd(m.team2)) continue;
    const hs = Number(m.score.home);
    const as = Number(m.score.away);
    if (hs === as) continue;
    alive.delete(hs > as ? m.team2 : m.team1);
  }
  const teams = [...alive];
  const weights = teams.map(team => ({ team, weight: Math.pow(10, ((TEAM_ELO[team] || DEFAULT_ELO) - DEFAULT_ELO) / 400) }));
  const total = weights.reduce((sum, x) => sum + x.weight, 0) || 1;
  return weights.map(x => {
    const probability = x.weight / total;
    return {
      team: x.team,
      price: decimalOdd(probability, CHAMPION_MARGIN),
      probability: Number(probability.toFixed(4)),
      bookmaker: 'Model'
    };
  }).sort((a, b) => a.price - b.price || a.team.localeCompare(b.team));
}

async function fetchMatches() {
  try {
    if (!/^https?:\/\//.test(MATCH_SOURCE_URL)) {
      const file = MATCH_SOURCE_URL.startsWith('file:') ? fileURLToPath(MATCH_SOURCE_URL) : MATCH_SOURCE_URL;
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { source: PUBLIC_SOURCE_URL, rawMatches: Array.isArray(source.matches) ? source.matches : [] };
    }
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
  const matches = normalized;
  if (!matches.length) throw new Error('Fetched JSON has no usable matches; keep existing data/worldcup2026.json unchanged.');
  fillRoundOf32(matches);
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
    championOdds: championOdds(matches),
    matches
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${matches.length} matches to ${OUT}`);
}

function selfCheck() {
  assert.ok(isTbd('1I'));
  assert.ok(isTbd('2K'));
  assert.ok(isTbd('3A/B/C/D/F'));
  assert.ok(isTbd('W74'));
  assert.ok(!isTbd('Canada'));
  assert.equal(normalizeMatch({ group: 'Group A' }).group, 'Group A');
  assert.ok(championOdds([
    normalizeMatch({ group: 'Group A', team1: 'Mexico', team2: 'Canada', score: { home: 1, away: 0 } }),
    normalizeMatch({ group: 'Group A', team1: 'South Africa', team2: 'Canada', score: { home: 1, away: 1 } })
  ]).some(x => x.team === 'Mexico'));
}

if (process.argv.includes('--check')) {
  selfCheck();
} else {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
