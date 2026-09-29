// PaPadel rotation engine — pure logic, no DOM. Importable from both the
// browser UI and Node tests.

export const POINTS_TOTAL = 21;
export const COURT_PLAYERS = 4;
export const DEFAULT_DURATION_MINUTES = 120;
export const DEFAULT_GAME_MINUTES = 5;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Fairness dominates: a single extra game played outweighs any pairing
// preference. Pairing costs only decide between equally-fair options.
const FAIRNESS_WEIGHT = 1000;
const PARTNER_WEIGHT = 60;
const OPPONENT_WEIGHT = 15;
const MATCHUP_WEIGHT = 120;

let counter = 0;
function makeId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

// Local calendar date — toISOString() would roll over to tomorrow for anyone
// east of UTC during their evening practice.
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanName(name) {
  return String(name ?? '').trim();
}

export function createSession({
  name = '',
  date,
  durationMinutes = DEFAULT_DURATION_MINUTES,
  gameMinutes = DEFAULT_GAME_MINUTES,
  playerNames = [],
} = {}) {
  const session = {
    id: makeId('sess'),
    name: cleanName(name),
    date: date || today(),
    durationMinutes: clampInt(durationMinutes, 15, 600, DEFAULT_DURATION_MINUTES),
    gameMinutes: clampInt(gameMinutes, 5, 60, DEFAULT_GAME_MINUTES),
    status: 'live',
    players: [],
    rounds: [],
  };
  for (const name of playerNames) pushPlayer(session, name);
  rebuildSchedule(session);
  return session;
}

function pushPlayer(session, name) {
  const trimmed = cleanName(name);
  if (!trimmed) return { ok: false, error: 'ERR_NAME_REQUIRED' };
  const duplicate = session.players.some(
    (p) => p.active && p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (duplicate) return { ok: false, error: 'ERR_ALREADY_IN_SESSION', errorParams: { name: trimmed } };
  const player = { id: makeId('pl'), name: trimmed, active: true };
  session.players.push(player);
  return { ok: true, player };
}

export function addPlayer(session, name) {
  const res = pushPlayer(session, name);
  if (res.ok) rebuildSchedule(session);
  return res;
}

export function removePlayer(session, playerId) {
  const player = session.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, error: 'ERR_PLAYER_NOT_FOUND' };
  if (!player.active) return { ok: false, error: 'ERR_ALREADY_LEFT', errorParams: { name: player.name } };
  player.active = false;
  rebuildSchedule(session);
  return { ok: true, player };
}

export function activePlayers(session) {
  return session.players.filter((p) => p.active);
}

// Slot budget: how many rounds the session is meant to hold. `roundsPlanned`
// records explicit admin deletions, which have to stick even though the clock
// would otherwise allow more rounds.
export function totalRounds(session) {
  const fromTime = Math.max(0, Math.floor(session.durationMinutes / session.gameMinutes));
  const cap = Number.isFinite(session.roundsPlanned) ? Math.max(0, session.roundsPlanned) : fromTime;
  return Math.max(0, Math.min(fromTime, cap));
}

export function playedRounds(session) {
  return session.rounds.filter((r) => r.status === 'played');
}

export function currentRound(session) {
  return session.rounds.find((r) => r.status === 'scheduled') || null;
}

export function playerRounds(session, playerId) {
  return session.rounds.filter((r) => r.teams.a.includes(playerId) || r.teams.b.includes(playerId));
}

// Renumbers 1..n in place and re-derives the nominal clock times.
function renumberRounds(session) {
  session.rounds.forEach((round, i) => {
    const number = i + 1;
    round.number = number;
    round.startMinute = (number - 1) * session.gameMinutes;
    round.endMinute = number * session.gameMinutes;
  });
}

// ---------------------------------------------------------------------------
// Schedule generation
// ---------------------------------------------------------------------------

function pairKey(x, y) {
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function fourKey(ids) {
  return [...ids].sort().join('|');
}

function buildCounters(played) {
  const games = new Map();
  const partner = new Map();
  const opponent = new Map();
  const matchup = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const round of played) {
    applyMatchToCounters(round.teams, { games, partner, opponent, matchup });
  }
  return { games, partner, opponent, matchup };
}

function applyMatchToCounters(teams, counters) {
  const { a: [a1, a2], b: [b1, b2] } = teams;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const id of [a1, a2, b1, b2]) bump(counters.games, id);
  bump(counters.partner, pairKey(a1, a2));
  bump(counters.partner, pairKey(b1, b2));
  bump(counters.opponent, pairKey(a1, b1));
  bump(counters.opponent, pairKey(a1, b2));
  bump(counters.opponent, pairKey(a2, b1));
  bump(counters.opponent, pairKey(a2, b2));
  bump(counters.matchup, fourKey([a1, a2, b1, b2]));
}

function matchCost(teams, c) {
  const [a1, a2] = teams.a;
  const [b1, b2] = teams.b;
  const get = (map, key) => map.get(key) || 0;
  let cost = FAIRNESS_WEIGHT * (get(c.games, a1) + get(c.games, a2) + get(c.games, b1) + get(c.games, b2));
  cost += PARTNER_WEIGHT * (get(c.partner, pairKey(a1, a2)) + get(c.partner, pairKey(b1, b2)));
  cost += OPPONENT_WEIGHT * (
    get(c.opponent, pairKey(a1, b1)) + get(c.opponent, pairKey(a1, b2)) +
    get(c.opponent, pairKey(a2, b1)) + get(c.opponent, pairKey(a2, b2))
  );
  cost += MATCHUP_WEIGHT * get(c.matchup, fourKey([a1, a2, b1, b2]));
  return cost;
}

// Greedy per-round selection: enumerate every possible match (4 players +
// team split) among active players and keep the lowest-cost one. Player
// counts stay small (<= ~16), so brute force is cheap and always optimal
// for the fairness term.
function pickBestMatch(players, counters) {
  const n = players.length;
  if (n < COURT_PLAYERS) return null;
  const splits = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];
  let best = null;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const four = [players[i], players[j], players[k], players[l]];
          for (const [sa, sb] of splits) {
            const teams = { a: [four[sa[0]].id, four[sa[1]].id], b: [four[sb[0]].id, four[sb[1]].id] };
            const cost = matchCost(teams, counters);
            if (best === null || cost < best.cost) best = { cost, teams };
          }
        }
      }
    }
  }
  return best;
}

// Rounds the scheduler must not touch: everything already played, plus every
// future round an admin hand-edited ("locked"). A locked line-up only survives
// while all four of its players are still in the session.
function fixedRounds(session, activeIds) {
  return session.rounds.filter((r) => {
    if (r.status === 'played') return true;
    if (r.locked !== true) return false;
    return [...r.teams.a, ...r.teams.b].every((id) => activeIds.has(id));
  });
}

// Regenerates the regenerable part of the schedule, seeded with the history of
// played rounds. Called on session creation, after every scored round (rolling
// rotation), and on every join/leave/edit. Played and locked rounds keep their
// slot number, so a hand-arranged line-up stays exactly where the admin put it
// and generated rounds fill the slots left vacant around them.
export function rebuildSchedule(session) {
  if (session.status === 'finished') {
    renumberRounds(session);
    return session;
  }

  const players = activePlayers(session);
  const activeIds = new Set(players.map((p) => p.id));
  const fixed = fixedRounds(session, activeIds).sort((a, b) => a.number - b.number);
  const total = Math.max(fixed.length, totalRounds(session));

  const slotOf = new Map();
  const taken = new Set();
  for (const round of fixed) {
    const n = round.number;
    if (Number.isInteger(n) && n >= 1 && n <= total && !taken.has(n)) {
      taken.add(n);
      slotOf.set(round.id, n);
    }
  }
  let cursor = 1;
  for (const round of fixed) {
    if (slotOf.has(round.id)) continue;
    while (taken.has(cursor)) cursor += 1;
    taken.add(cursor);
    slotOf.set(round.id, cursor);
  }

  session.rounds = fixed;
  for (const round of fixed) {
    if (round.status === 'played') continue;
    const playing = new Set([...round.teams.a, ...round.teams.b]);
    round.bye = players.filter((p) => !playing.has(p.id)).map((p) => p.id);
  }

  const counters = buildCounters(fixed);
  for (let number = 1; number <= total; number++) {
    if (taken.has(number)) continue;
    const best = pickBestMatch(players, counters);
    if (!best) break;
    applyMatchToCounters(best.teams, counters);

    const playing = new Set([...best.teams.a, ...best.teams.b]);
    const round = {
      id: makeId('rnd'),
      number,
      status: 'scheduled',
      teams: best.teams,
      bye: players.filter((p) => !playing.has(p.id)).map((p) => p.id),
      startMinute: (number - 1) * session.gameMinutes,
      endMinute: number * session.gameMinutes,
      score: null,
    };
    slotOf.set(round.id, number);
    session.rounds.push(round);
  }

  for (const round of session.rounds) round.number = slotOf.get(round.id) ?? round.number;
  session.rounds.sort((a, b) => a.number - b.number);
  renumberRounds(session);
  return session;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function parseScore(scoreA, scoreB) {
  const a = Number(scoreA);
  const b = Number(scoreB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    return { ok: false, error: 'ERR_SCORES_WHOLE' };
  }
  if (a + b !== POINTS_TOTAL) {
    return { ok: false, error: 'ERR_SCORE_SUM', errorParams: { total: POINTS_TOTAL, got: a + b } };
  }
  return { ok: true, a, b };
}

export function submitScore(session, roundId, scoreA, scoreB) {
  const round = session.rounds.find((r) => r.id === roundId);
  if (!round) return { ok: false, error: 'ERR_ROUND_NOT_FOUND' };
  const next = currentRound(session);
  if (!next || next.id !== roundId) {
    return { ok: false, error: 'ERR_ONLY_CURRENT_ROUND' };
  }
  const parsed = parseScore(scoreA, scoreB);
  if (!parsed.ok) return parsed;
  round.score = { a: parsed.a, b: parsed.b };
  round.status = 'played';
  rebuildSchedule(session);
  return { ok: true, round };
}

// Admin correction of an already-played round. No schedule rebuild: pairings
// are generated from participation history only, never from scores, so a
// corrected score can never invalidate later pairings.
export function updateScore(session, roundId, scoreA, scoreB) {
  const round = session.rounds.find((r) => r.id === roundId);
  if (!round) return { ok: false, error: 'ERR_ROUND_NOT_FOUND' };
  if (round.status !== 'played') {
    return { ok: false, error: 'ERR_ONLY_PLAYED_EDITABLE' };
  }
  const parsed = parseScore(scoreA, scoreB);
  if (!parsed.ok) return parsed;
  round.score = { a: parsed.a, b: parsed.b };
  return { ok: true, round };
}

export function finishSession(session) {
  session.status = 'finished';
  return session;
}

// ---------------------------------------------------------------------------
// Admin edits
//
// The admin owns the data: any session, round, score or player can be changed
// or removed. Everything derived (aggregates, stats, remaining schedule) is
// recomputed from the current state, so no staleness is possible.
// ---------------------------------------------------------------------------

export function renameSession(session, name) {
  session.name = cleanName(name);
  return { ok: true, session };
}

export function setSessionDate(session, date) {
  const value = String(date ?? '').trim();
  if (!DATE_PATTERN.test(value)) return { ok: false, error: 'ERR_DATE_FORMAT' };
  const [year, month, day] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, error: 'ERR_DATE_INVALID' };
  }
  session.date = value;
  return { ok: true, session };
}

// Hand-edited line-up for an unplayed round. The round is flagged `locked` so
// the mid-session rebalancer keeps it exactly where it is.
export function updateRoundTeams(session, roundId, teamAIds, teamBIds) {
  const round = session.rounds.find((r) => r.id === roundId);
  if (!round) return { ok: false, error: 'ERR_ROUND_NOT_FOUND' };
  if (round.status === 'played') {
    return { ok: false, error: 'ERR_PLAYED_LINEUP_LOCKED' };
  }
  const a = [...new Set(teamAIds)];
  const b = [...new Set(teamBIds)];
  if (a.length !== 2 || b.length !== 2) return { ok: false, error: 'ERR_TEAM_TWO_PLAYERS' };
  if (a.some((id) => b.includes(id))) return { ok: false, error: 'ERR_SAME_TEAM' };
  const activeIds = new Set(activePlayers(session).map((p) => p.id));
  if ([...a, ...b].some((id) => !activeIds.has(id))) {
    return { ok: false, error: 'ERR_INACTIVE_PLAYERS' };
  }
  round.teams = { a, b };
  round.locked = true;
  rebuildSchedule(session);
  return { ok: true, round };
}

// Removes a round for good. The deletion also lowers the slot budget, so the
// next rebuild cannot simply regenerate the round that was just deleted.
export function deleteRound(session, roundId) {
  const index = session.rounds.findIndex((r) => r.id === roundId);
  if (index === -1) return { ok: false, error: 'ERR_ROUND_NOT_FOUND' };
  const [round] = session.rounds.splice(index, 1);

  const fromTime = Math.max(0, Math.floor(session.durationMinutes / session.gameMinutes));
  const cap = Number.isFinite(session.roundsPlanned) ? Math.max(0, session.roundsPlanned) : fromTime;
  session.roundsPlanned = Math.max(0, Math.min(fromTime, cap) - 1);

  rebuildSchedule(session);
  return { ok: true, round, droppedScore: round.status === 'played' ? round.score : null };
}

export function renamePlayer(session, playerId, name) {
  const player = session.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, error: 'ERR_PLAYER_NOT_FOUND' };
  const trimmed = cleanName(name);
  if (!trimmed) return { ok: false, error: 'ERR_NAME_REQUIRED' };
  const duplicate = session.players.some(
    (p) => p.id !== playerId && p.active === player.active && p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (duplicate) return { ok: false, error: 'ERR_ALREADY_IN_SESSION', errorParams: { name: trimmed } };
  player.name = trimmed;
  return { ok: true, player };
}

// Hard delete: drops the player and every round they appeared in (played ones
// included, so their points disappear from the leaderboards too).
export function removePlayerFromSession(session, playerId) {
  const index = session.players.findIndex((p) => p.id === playerId);
  if (index === -1) return { ok: false, error: 'ERR_PLAYER_NOT_FOUND' };
  const dropped = playerRounds(session, playerId);
  const [player] = session.players.splice(index, 1);
  session.rounds = session.rounds.filter((r) => !dropped.includes(r));
  rebuildSchedule(session);
  return {
    ok: true,
    player,
    droppedRounds: dropped.length,
    droppedPlayed: dropped.filter((r) => r.status === 'played').length,
  };
}

// ---------------------------------------------------------------------------
// Persistence boundary
// ---------------------------------------------------------------------------

// localStorage outlives app versions and is user-editable, so every load runs
// through here: anything unreadable is dropped rather than crashing the UI.
function asTeamIds(value, ids) {
  if (!Array.isArray(value) || value.length !== COURT_PLAYERS / 2) return null;
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !ids.has(v) || out.includes(v)) return null;
    out.push(v);
  }
  return out;
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const ids = new Set();
  const players = [];
  for (const p of Array.isArray(raw.players) ? raw.players : []) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || ids.has(p.id)) continue;
    const name = cleanName(p.name);
    if (!name) continue;
    ids.add(p.id);
    players.push({ id: p.id, name, active: p.active !== false });
  }
  if (!players.length) return null;

  const rounds = [];
  for (const r of Array.isArray(raw.rounds) ? raw.rounds : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue;
    const a = asTeamIds(r.teams?.a, ids);
    const b = asTeamIds(r.teams?.b, ids);
    if (!a || !b || a.some((id) => b.includes(id))) continue;
    const round = {
      id: r.id,
      number: clampInt(r.number, 1, Number.MAX_SAFE_INTEGER, rounds.length + 1),
      status: 'scheduled',
      teams: { a, b },
      bye: [],
      score: null,
    };
    if (r.status === 'played') {
      const parsed = parseScore(r.score?.a, r.score?.b);
      if (!parsed.ok) continue; // a played round without a score is just a hole
      round.status = 'played';
      round.score = { a: parsed.a, b: parsed.b };
    } else if (r.locked === true) {
      round.locked = true;
    }
    rounds.push(round);
  }

  const date = String(raw.date ?? '');
  const session = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('sess'),
    name: cleanName(raw.name),
    date: DATE_PATTERN.test(date) ? date : today(),
    durationMinutes: clampInt(raw.durationMinutes, 15, 600, DEFAULT_DURATION_MINUTES),
    gameMinutes: clampInt(raw.gameMinutes, 5, 60, DEFAULT_GAME_MINUTES),
    // Only an explicit "live" earns the rolling-rotation treatment; anything
    // else is frozen history, so a status lost in an old save can't turn a
    // past session into a second live one.
    status: raw.status === 'live' ? 'live' : 'finished',
    players,
    rounds,
  };
  if (Number.isFinite(raw.roundsPlanned)) {
    session.roundsPlanned = Math.max(0, Math.round(raw.roundsPlanned));
  }
  // Only a saved live session keeps a schedule to run. A finished one is
  // frozen history — and a stored tail of unplayed rounds would otherwise
  // resurrect it as a second live session.
  if (raw.status === 'live') rebuildSchedule(session);
  else renumberRounds(session);
  return session;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function bumpPlayer(stats, playerId, forPoints, againstPoints) {
  const s = stats.get(playerId) || { games: 0, points: 0, wins: 0, losses: 0 };
  s.games += 1;
  s.points += forPoints;
  if (forPoints > againstPoints) s.wins += 1;
  else if (forPoints < againstPoints) s.losses += 1;
  stats.set(playerId, s);
}

// Returns Map<playerId, {games, points, wins, losses}> for played rounds only.
export function playerSessionStats(session) {
  const stats = new Map();
  for (const round of playedRounds(session)) {
    const { a, b } = round.score;
    for (const id of round.teams.a) bumpPlayer(stats, id, a, b);
    for (const id of round.teams.b) bumpPlayer(stats, id, b, a);
  }
  return stats;
}

export function playerNameMap(session) {
  return new Map(session.players.map((p) => [p.id, p.name]));
}

// Aggregates any sessions given, live ones included. The prototype has no
// cross-session player identity, so players are matched by name. A player who
// left and rejoined holds two roster rows in one session, so each session
// counts once per name no matter how many rows carry it.
export function aggregateStats(sessions) {
  const byName = new Map();
  for (const session of sessions) {
    const nameOf = playerNameMap(session);
    const perSession = new Map();
    for (const [playerId, s] of playerSessionStats(session)) {
      const name = nameOf.get(playerId) || 'Unknown';
      const key = name.toLowerCase();
      const found = perSession.get(key) || { name, games: 0, points: 0, wins: 0, losses: 0 };
      found.games += s.games;
      found.points += s.points;
      found.wins += s.wins;
      found.losses += s.losses;
      perSession.set(key, found);
    }
    for (const [key, s] of perSession) {
      const agg = byName.get(key) || { name: s.name, sessions: 0, games: 0, points: 0, wins: 0, losses: 0 };
      agg.sessions += 1;
      agg.games += s.games;
      agg.points += s.points;
      agg.wins += s.wins;
      agg.losses += s.losses;
      byName.set(key, agg);
    }
  }
  return [...byName.values()]
    .map((a) => ({
      ...a,
      avgPerSession: a.sessions ? Math.round((a.points / a.sessions) * 10) / 10 : 0,
    }))
    .sort((x, y) => y.points - x.points || y.wins - x.wins || x.name.localeCompare(y.name));
}
