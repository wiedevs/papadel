import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POINTS_TOTAL,
  DEFAULT_GAME_MINUTES,
  createSession,
  addPlayer,
  removePlayer,
  submitScore,
  updateScore,
  currentRound,
  playedRounds,
  playerRounds,
  totalRounds,
  playerSessionStats,
  aggregateStats,
  activePlayers,
  renameSession,
  setSessionDate,
  updateRoundTeams,
  deleteRound,
  renamePlayer,
  removePlayerFromSession,
  rebuildSchedule,
  finishSession,
  normalizeSession,
} from '../src/engine.mjs';

const names = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

function playAll(session, scoreA = 14, scoreB = 7) {
  let round;
  while ((round = currentRound(session))) {
    const res = submitScore(session, round.id, scoreA, scoreB);
    assert.ok(res.ok, res.error);
  }
  return session;
}

function gamesOf(session) {
  return [...playerSessionStats(session).values()].map((s) => s.games);
}

test('session generates duration/gameMinutes rounds with valid teams', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  assert.equal(totalRounds(s), 10);
  assert.equal(s.rounds.length, 10);
  const ids = new Set(s.players.map((p) => p.id));
  for (const r of s.rounds) {
    assert.equal(r.teams.a.length, 2);
    assert.equal(r.teams.b.length, 2);
    const all = [...r.teams.a, ...r.teams.b];
    assert.equal(new Set(all).size, 4, 'teams must have 4 distinct players');
    for (const id of all) assert.ok(ids.has(id));
    assert.ok(!r.teams.a.some((id) => r.teams.b.includes(id)), 'teams must be disjoint');
  }
});

test('playtime is balanced (games differ by at most 1) for 5-9 players', () => {
  for (const n of [5, 6, 7, 8, 9]) {
    const s = createSession({ playerNames: names(n) });
    playAll(s);
    const games = gamesOf(s);
    assert.equal(games.length, n);
    assert.ok(Math.max(...games) - Math.min(...games) <= 1, `n=${n}: ${games}`);
    assert.equal(games.reduce((a, b) => a + b, 0), totalRounds(s) * 4);
  }
});

test('every match total equals 21 and total points = 21 x rounds', () => {
  const s = createSession({ playerNames: names(7) });
  let i = 0;
  let round;
  while ((round = currentRound(s))) {
    const a = [0, 5, 11, 21, 9, 17, 3, 13, 8, 20][i % 10];
    submitScore(s, round.id, a, POINTS_TOTAL - a);
    i++;
  }
  for (const r of playedRounds(s)) assert.equal(r.score.a + r.score.b, POINTS_TOTAL);
  // Americano: each player banks their team's points, so the individual
  // sum per round is 2 x 21 (both teams' points, each counted per member).
  const totalPts = [...playerSessionStats(s).values()].reduce((sum, x) => sum + x.points, 0);
  assert.equal(totalPts, 2 * POINTS_TOTAL * totalRounds(s));
});

test('4 players: first 3 rounds cover all 6 partner pairs (perfect Americano)', () => {
  const s = createSession({ playerNames: names(4) });
  const partnerPairs = new Set();
  for (const r of s.rounds.slice(0, 3)) {
    const key = (x, y) => [x, y].sort().join('|');
    partnerPairs.add(key(r.teams.a[0], r.teams.a[1]));
    partnerPairs.add(key(r.teams.b[0], r.teams.b[1]));
  }
  assert.equal(partnerPairs.size, 6);
});

test('4 players: first 3 rounds cover all 4 opponent-pair... opponents balanced', () => {
  const s = createSession({ playerNames: names(4) });
  const opp = new Set();
  for (const r of s.rounds.slice(0, 3)) {
    for (const a of r.teams.a) for (const b of r.teams.b) opp.add([a, b].sort().join('|'));
  }
  // In 3 rounds each player faces every other player exactly twice.
  assert.equal(opp.size, 6);
});

test('mid-session join recalculates remaining schedule', () => {
  const s = createSession({ playerNames: names(4), durationMinutes: 120, gameMinutes: 12 });
  for (let i = 0; i < 3; i++) {
    const r = currentRound(s);
    submitScore(s, r.id, 11, 10);
  }
  assert.equal(s.rounds.filter((r) => r.status === 'scheduled').length, 7);

  const j1 = addPlayer(s, 'New1');
  const j2 = addPlayer(s, 'New2');
  assert.ok(j1.ok && j2.ok);
  assert.equal(activePlayers(s).length, 6);
  assert.equal(s.rounds.filter((r) => r.status === 'scheduled').length, 7);

  playAll(s);
  const stats = playerSessionStats(s);
  const byName = new Map(s.players.map((p) => [p.id, p.name]));
  const newcomerGames = [...stats.entries()]
    .filter(([id]) => ['New1', 'New2'].includes(byName.get(id)))
    .map(([, v]) => v.games);
  assert.ok(newcomerGames.every((g) => g >= 6), `newcomers should play ~all remaining: ${newcomerGames}`);
  const games = gamesOf(s);
  assert.ok(Math.max(...games) - Math.min(...games) <= 2, `overall balance: ${games}`);
});

test('mid-session join with little time left: newcomer plays every remaining round', () => {
  const s = createSession({ playerNames: names(6), durationMinutes: 120, gameMinutes: 12 });
  for (let i = 0; i < 8; i++) submitScore(s, currentRound(s).id, 11, 10);
  addPlayer(s, 'Late');
  const remaining = s.rounds.filter((r) => r.status === 'scheduled');
  assert.equal(remaining.length, 2);
  for (const r of remaining) {
    const all = [...r.teams.a, ...r.teams.b];
    assert.ok(all.includes(s.players.find((p) => p.name === 'Late').id));
  }
});

test('mid-session leave: remaining players stay balanced with rotating byes', () => {
  const s = createSession({ playerNames: names(8) });
  submitScore(s, currentRound(s).id, 11, 10);
  submitScore(s, currentRound(s).id, 11, 10);

  const leavers = activePlayers(s).slice(0, 3);
  for (const p of leavers) removePlayer(s, p.id);
  assert.equal(activePlayers(s).length, 5);

  const upcoming = s.rounds.filter((r) => r.status === 'scheduled');
  assert.ok(upcoming.length > 0);
  for (const r of upcoming) {
    assert.equal(r.bye.length, 1, 'with 5 players exactly one bye per round');
    const all = [...r.teams.a, ...r.teams.b, ...r.bye];
    assert.ok(!all.some((id) => leavers.some((p) => p.id === id)), 'leavers must be gone');
  }

  playAll(s);
  // Leavers keep their historical games (they left early — that cannot be
  // rebalanced), so fairness is checked among players who stayed active.
  const activeIds = new Set(activePlayers(s).map((p) => p.id));
  const games = [...playerSessionStats(s).entries()]
    .filter(([id]) => activeIds.has(id))
    .map(([, v]) => v.games);
  assert.ok(Math.max(...games) - Math.min(...games) <= 1, `balance after leave: ${games}`);
});

test('dropping below 4 players stops scheduling', () => {
  const s = createSession({ playerNames: names(5) });
  submitScore(s, currentRound(s).id, 11, 10);
  const active = activePlayers(s);
  removePlayer(s, active[0].id);
  removePlayer(s, active[1].id);
  assert.equal(activePlayers(s).length, 3);
  assert.equal(currentRound(s), null);
  assert.equal(s.rounds.filter((r) => r.status === 'scheduled').length, 0);
});

test('score validation: only sums of 21 accepted, current round only', () => {
  const s = createSession({ playerNames: names(4) });
  const r1 = currentRound(s);
  assert.ok(!submitScore(s, r1.id, 10, 10).ok);
  assert.ok(!submitScore(s, r1.id, 22, -1).ok);
  assert.ok(!submitScore(s, r1.id, 10.5, 10.5).ok);
  assert.ok(!submitScore(s, r1.id, 'x', 5).ok);
  assert.ok(submitScore(s, r1.id, 0, 21).ok);
  assert.ok(!submitScore(s, r1.id, 5, 16).ok, 'already-played round cannot be rescored');
  const r2 = currentRound(s);
  assert.ok(submitScore(s, r2.id, 21, 0).ok);
});

test('individual points accumulate team points per game', () => {
  const s = createSession({ playerNames: names(4) });
  const r1 = currentRound(s);
  submitScore(s, r1.id, 15, 6);
  let stats = playerSessionStats(s);
  const nameOf = new Map(s.players.map((p) => [p.id, p.name]));
  const teamA = r1.teams.a.map((id) => nameOf.get(id));
  for (const [id, v] of stats) {
    assert.equal(v.points, teamA.includes(nameOf.get(id)) ? 15 : 6);
  }
  const r2 = currentRound(s);
  submitScore(s, r2.id, 9, 12);
  stats = playerSessionStats(s);
  const totalPts = [...stats.values()].reduce((sum, x) => sum + x.points, 0);
  assert.equal(totalPts, 2 * 21 * 2);
});

test('aggregateStats accumulates across sessions by player name', () => {
  const s1 = createSession({ playerNames: ['Ana', 'Budi', 'Citra', 'Dodi'] });
  playAll(s1, 11, 10);
  s1.status = 'finished';

  const s2 = createSession({ playerNames: ['Ana', 'Budi', 'Eka', 'Fajar'] });
  playAll(s2, 12, 9);
  s2.status = 'finished';

  const expectedPoints = (session, playerName) => {
    const id = session.players.find((p) => p.name === playerName).id;
    let pts = 0;
    for (const r of playedRounds(session)) {
      if (r.teams.a.includes(id)) pts += r.score.a;
      else pts += r.score.b;
    }
    return pts;
  };

  const agg = aggregateStats([s1, s2]);
  const byName = new Map(agg.map((a) => [a.name, a]));
  assert.equal(agg[0].name, 'Ana');
  assert.equal(byName.get('Ana').sessions, 2);
  // 4-player sessions: everyone plays every round.
  assert.equal(byName.get('Ana').games, totalRounds(s1) + totalRounds(s2));
  assert.equal(byName.get('Ana').points, expectedPoints(s1, 'Ana') + expectedPoints(s2, 'Ana'));
  assert.equal(byName.get('Citra').sessions, 1);
  assert.equal(byName.get('Eka').games, totalRounds(s2));
  assert.equal(byName.get('Eka').points, expectedPoints(s2, 'Eka'));
});

test('updateScore: editing a played round recalculates points and W-L', () => {
  const s = createSession({ playerNames: ['Ana', 'Budi', 'Citra', 'Dodi'] });
  const r1 = currentRound(s);
  submitScore(s, r1.id, 15, 6);
  const teamA = [...r1.teams.a];
  const teamB = [...r1.teams.b];

  assert.ok(updateScore(s, r1.id, 6, 15).ok);
  const stats = playerSessionStats(s);
  for (const id of teamA) {
    assert.equal(stats.get(id).points, 6);
    assert.equal(stats.get(id).wins, 0);
    assert.equal(stats.get(id).losses, 1);
  }
  for (const id of teamB) {
    assert.equal(stats.get(id).points, 15);
    assert.equal(stats.get(id).wins, 1);
    assert.equal(stats.get(id).losses, 0);
  }
});

test('updateScore: editing a past session score recalculates cumulative aggregates', () => {
  const s = createSession({ playerNames: ['Ana', 'Budi', 'Citra', 'Dodi'] });
  playAll(s, 11, 10);
  s.status = 'finished';
  const anaId = s.players.find((p) => p.name === 'Ana').id;
  const before = aggregateStats([s]).find((a) => a.name === 'Ana').points;

  const r1 = s.rounds[0];
  const old = { ...r1.score };
  assert.ok(updateScore(s, r1.id, 0, 21).ok);
  const delta = r1.teams.a.includes(anaId) ? 0 - old.a : 21 - old.b;

  const after = aggregateStats([s]).find((a) => a.name === 'Ana').points;
  assert.equal(after, before + delta);
});

test('updateScore: rejects scheduled rounds and invalid sums', () => {
  const s = createSession({ playerNames: names(4) });
  const r1 = currentRound(s);
  assert.ok(!updateScore(s, r1.id, 11, 10).ok, 'scheduled round cannot be edited');
  submitScore(s, r1.id, 10, 11);
  assert.ok(!updateScore(s, r1.id, 10, 10).ok);
  assert.ok(!updateScore(s, r1.id, -1, 22).ok);
  assert.ok(!updateScore(s, r1.id, 10.5, 10.5).ok);
  assert.ok(updateScore(s, r1.id, 21, 0).ok);
  assert.equal(r1.score.a, 21);
  assert.equal(r1.score.b, 0);
});

test('updateScore: correcting a score leaves the remaining schedule untouched', () => {
  const s = createSession({ playerNames: names(6) });
  submitScore(s, currentRound(s).id, 11, 10);
  const tailBefore = s.rounds
    .filter((r) => r.status === 'scheduled')
    .map((r) => JSON.stringify({ n: r.number, teams: r.teams }));

  assert.ok(updateScore(s, s.rounds[0].id, 2, 19).ok);

  const tailAfter = s.rounds
    .filter((r) => r.status === 'scheduled')
    .map((r) => JSON.stringify({ n: r.number, teams: r.teams }));
  assert.deepEqual(tailAfter, tailBefore);
});

// ---------------------------------------------------------------------------
// Admin edits
// ---------------------------------------------------------------------------

function teamIdsOf(session, roundId) {
  const round = session.rounds.find((r) => r.id === roundId);
  return [...round.teams.a, ...round.teams.b];
}

test('session defaults: 5-minute games, 2-hour duration, optional name', () => {
  assert.equal(DEFAULT_GAME_MINUTES, 5);
  const s = createSession({ playerNames: names(4) });
  assert.equal(s.gameMinutes, 5);
  assert.equal(s.durationMinutes, 120);
  assert.equal(totalRounds(s), 24);
  assert.equal(s.rounds.length, 24);
  assert.equal(s.name, '');
  assert.equal(typeof s.date, 'string');
  assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('renameSession stores a trimmed label, including on a finished session', () => {
  const s = createSession({ name: '  Friday Regular Practice ', playerNames: names(4) });
  assert.equal(s.name, 'Friday Regular Practice');
  s.status = 'finished';
  assert.ok(renameSession(s, ' Sunday Social ').ok);
  assert.equal(s.name, 'Sunday Social');
  assert.ok(renameSession(s, '').ok);
  assert.equal(s.name, '');
});

test('setSessionDate accepts real dates and rejects malformed ones', () => {
  const s = createSession({ date: '2026-09-01', playerNames: names(4) });
  assert.ok(setSessionDate(s, '2026-09-23').ok);
  assert.equal(s.date, '2026-09-23');
  assert.ok(!setSessionDate(s, '2026-02-30').ok, 'February 30 does not exist');
  assert.ok(!setSessionDate(s, '2026-13-01').ok);
  assert.ok(!setSessionDate(s, '23/09/2026').ok);
  assert.ok(!setSessionDate(s, '').ok);
  assert.equal(s.date, '2026-09-23', 'a rejected date leaves the old one in place');
});

test('updateRoundTeams locks a hand-picked line-up into its slot', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  const target = s.rounds[4];
  assert.equal(target.number, 5);
  const picked = s.players.slice(0, 4).map((p) => p.id);
  const lineup = [picked[0], picked[3], picked[1], picked[2]];

  assert.ok(updateRoundTeams(s, target.id, [picked[0], picked[3]], [picked[1], picked[2]]).ok);
  assert.equal(target.locked, true);
  assert.deepEqual(teamIdsOf(s, target.id), lineup);
  assert.equal(target.bye.length, 4, 'bye list follows the new line-up');

  // Scoring and joining in later rounds must not move or rewrite it.
  submitScore(s, currentRound(s).id, 11, 10);
  addPlayer(s, 'Late');
  const after = s.rounds.find((r) => r.id === target.id);
  assert.ok(after, 'locked round survives a rebuild');
  assert.equal(after.number, 5, 'locked round keeps its slot number');
  assert.deepEqual(teamIdsOf(s, target.id), lineup);
  assert.equal(s.rounds.length, 10, 'schedule stays the same length');
  assert.deepEqual(
    s.rounds.map((r) => r.number),
    Array.from({ length: 10 }, (_, i) => i + 1),
    'numbering stays dense'
  );
});

test('updateRoundTeams validates the line-up and refuses played rounds', () => {
  const s = createSession({ playerNames: names(6) });
  const round = currentRound(s);
  const [p1, p2, p3, p4, p5] = s.players.map((p) => p.id);

  assert.ok(!updateRoundTeams(s, round.id, [p1, p2], [p2, p3]).ok, 'same player on both teams');
  assert.ok(!updateRoundTeams(s, round.id, [p1, p1], [p2, p3]).ok, 'duplicate inside a team');
  assert.ok(!updateRoundTeams(s, round.id, [p1, p2], [p3]).ok, 'team too small');
  assert.ok(!updateRoundTeams(s, round.id, [p1, p2], [p3, 'nope']).ok, 'unknown player');
  assert.ok(!updateRoundTeams(s, 'no-such-round', [p1, p2], [p3, p4]).ok);
  assert.ok(!round.locked, 'a rejected edit must not lock the round');

  assert.ok(updateRoundTeams(s, round.id, [p1, p2], [p3, p5]).ok);
  submitScore(s, round.id, 11, 10);
  assert.ok(!updateRoundTeams(s, round.id, [p1, p2], [p3, p4]).ok, 'played round line-up is frozen');
});

test('a locked round is released when one of its players leaves', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  const target = s.rounds[3];
  const picked = s.players.slice(0, 4).map((p) => p.id);
  assert.ok(updateRoundTeams(s, target.id, [picked[0], picked[1]], [picked[2], picked[3]]).ok);

  assert.ok(removePlayer(s, picked[0]).ok);
  assert.ok(!s.rounds.some((r) => r.id === target.id), 'the stale line-up is dropped, not replayed');
  const scheduled = s.rounds.filter((r) => r.status === 'scheduled');
  assert.equal(scheduled.length, 10, 'the freed slot is regenerated');
  for (const r of scheduled) {
    assert.ok(!teamIdsOf(s, r.id).includes(picked[0]), 'a departed player is never scheduled again');
  }
});

test('deleteRound: a played round disappears for good and stats recalculate', () => {
  const s = createSession({ playerNames: ['Ana', 'Budi', 'Citra', 'Dodi'], durationMinutes: 120, gameMinutes: 12 });
  submitScore(s, currentRound(s).id, 15, 6);
  submitScore(s, currentRound(s).id, 12, 9);
  const ana = s.players[0].id;
  const pointsBefore = playerSessionStats(s).get(ana).points;
  const victim = s.rounds[0];
  const lostPoints = victim.teams.a.includes(ana) ? victim.score.a : victim.score.b;

  const res = deleteRound(s, victim.id);
  assert.ok(res.ok);
  assert.deepEqual(res.droppedScore, { a: 15, b: 6 });
  assert.equal(playedRounds(s).length, 1);
  assert.equal(totalRounds(s), 9, 'the slot budget shrinks with the deletion');
  assert.equal(playerSessionStats(s).get(ana).points, pointsBefore - lostPoints);
  assert.deepEqual(
    s.rounds.map((r) => r.number),
    Array.from({ length: 9 }, (_, i) => i + 1),
    'numbering stays dense'
  );
});

test('deleteRound: the deleted round is never regenerated', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  submitScore(s, currentRound(s).id, 11, 10);
  const target = s.rounds[4];
  assert.ok(deleteRound(s, target.id).ok);
  assert.equal(s.rounds.length, 9);

  // Keep playing and joining: the schedule must stay 9 rounds long.
  submitScore(s, currentRound(s).id, 11, 10);
  addPlayer(s, 'Late');
  assert.equal(s.rounds.length, 9);
  assert.ok(!s.rounds.some((r) => r.id === target.id));
  playAll(s);
  assert.equal(playedRounds(s).length, 9);
});

test('deleteRound: works on a finished session and compacts the numbering', () => {
  const s = createSession({ playerNames: names(6), durationMinutes: 120, gameMinutes: 12 });
  playAll(s, 11, 10);
  s.status = 'finished';
  assert.ok(deleteRound(s, s.rounds[2].id).ok);
  assert.equal(s.rounds.length, 9);
  assert.equal(playedRounds(s).length, 9);
  assert.deepEqual(s.rounds.map((r) => r.number), Array.from({ length: 9 }, (_, i) => i + 1));
  assert.equal(totalRounds(s), 9);
});

test('renamePlayer updates stats keys and blocks duplicate active names', () => {
  const s = createSession({ playerNames: ['Ana', 'Budi', 'Citra', 'Dodi'] });
  playAll(s, 15, 6);
  const ana = s.players.find((p) => p.name === 'Ana').id;
  const points = playerSessionStats(s).get(ana).points;

  assert.ok(renamePlayer(s, ana, '  Ana Maria ').ok);
  assert.equal(s.players.find((p) => p.id === ana).name, 'Ana Maria');
  assert.equal(playerSessionStats(s).get(ana).points, points, 'stats follow the player id');

  s.status = 'finished';
  const agg = aggregateStats([s]);
  assert.ok(agg.some((a) => a.name === 'Ana Maria'));
  assert.ok(!agg.some((a) => a.name === 'Ana'));

  assert.ok(!renamePlayer(s, ana, 'budi').ok, 'duplicate name rejected');
  assert.ok(!renamePlayer(s, ana, '   ').ok, 'empty name rejected');
  assert.equal(s.players.find((p) => p.id === ana).name, 'Ana Maria');
});

test('removePlayerFromSession drops the player and every round they were in', () => {
  const s = createSession({ playerNames: names(6), durationMinutes: 120, gameMinutes: 12 });
  for (let i = 0; i < 5; i++) submitScore(s, currentRound(s).id, 11, 10);
  const target = activePlayers(s).find((p) => playerRounds(s, p.id).length > 0);
  const expected = playerRounds(s, target.id).length;

  const res = removePlayerFromSession(s, target.id);
  assert.ok(res.ok);
  assert.equal(res.droppedRounds, expected);
  assert.ok(res.droppedPlayed > 0, 'rounds they played are dropped too');
  assert.equal(s.players.filter((p) => p.id === target.id).length, 0);
  for (const r of s.rounds) assert.ok(!teamIdsOf(s, r.id).includes(target.id));
  assert.ok(!playerSessionStats(s).has(target.id));
  assert.equal(totalRounds(s), 10, 'the session keeps its length for the players who stayed');
  assert.equal(s.rounds.length, 10);
});

test('removePlayerFromSession on a finished session lets the rounds stay deleted', () => {
  const s = createSession({ playerNames: ['Ana', 'Budi', 'Citra', 'Dodi'], durationMinutes: 120, gameMinutes: 12 });
  playAll(s, 11, 10);
  s.status = 'finished';
  const ana = s.players.find((p) => p.name === 'Ana').id;

  const res = removePlayerFromSession(s, ana);
  assert.ok(res.ok);
  assert.equal(res.droppedRounds, 10);
  assert.equal(s.rounds.length, 0, 'four players left, nothing to schedule');
  assert.equal(totalRounds(s), 10, 'the time budget is untouched');
  assert.ok(!aggregateStats([s]).some((a) => a.name === 'Ana'));
});

test('roundsPlanned caps the schedule independently of the clock', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  assert.equal(totalRounds(s), 10);
  s.roundsPlanned = 4;
  assert.equal(totalRounds(s), 4);
  s.roundsPlanned = 99;
  assert.equal(totalRounds(s), 10, 'the clock still caps the plan');
});

test('finished sessions never gain rounds on a later rebuild', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  for (let i = 0; i < 3; i++) submitScore(s, currentRound(s).id, 11, 10);
  const before = s.rounds.length;
  s.status = 'finished';

  s.rounds = s.rounds.filter((r) => r.status === 'played');
  rebuildSchedule(s);
  assert.deepEqual(s.rounds.map((r) => r.number), [1, 2, 3], 'kept rounds are renumbered, not extended');
  assert.equal(s.rounds.length, 3);
  assert.ok(before > 3);
});

test('rotation stays fair for 4-16 players and only reuses a group of four when it must', () => {
  for (const n of [4, 5, 6, 7, 8, 9, 11, 13, 16]) {
    const s = createSession({ playerNames: names(n) });
    const games = n === 4 ? totalRounds(s) : null;
    const seen = new Map();
    for (const r of s.rounds) {
      const key = [...r.teams.a, ...r.teams.b].sort().join('|');
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const p of s.players) {
      const played = playerRounds(s, p.id).length;
      if (n === 4) assert.equal(played, games, `n=4 everyone plays every round`);
      else assert.ok(
        Math.abs(played - (totalRounds(s) * 4) / n) <= 1,
        `n=${n}: ${p.name} played ${played} of a ${((totalRounds(s) * 4) / n).toFixed(1)} fair share`
      );
    }

    const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
    const met = new Set();
    for (const r of s.rounds) {
      const four = [...r.teams.a, ...r.teams.b];
      for (let x = 0; x < four.length; x++) {
        for (let y = x + 1; y < four.length; y++) met.add(pairKey(four[x], four[y]));
      }
    }
    if (n <= 9) {
      assert.equal(met.size, (n * (n - 1)) / 2, `n=${n}: every pair of players must have met`);
    }

    // Pigeonhole floor: with fewer distinct groups of four than rounds, some
    // group has to sit back down. At 7 players there are 35 groups for 24
    // rounds, yet keeping everyone within one game of an equal share costs a
    // single repeat — fairness outranks variety, and one group pays for it.
    const groupsOfFour = (n * (n - 1) * (n - 2) * (n - 3)) / 24;
    const floor = Math.max(0, totalRounds(s) - groupsOfFour);
    const repeats = [...seen.values()].filter((v) => v > 1).length;
    assert.ok(
      repeats <= floor + (n === 7 ? 1 : 0),
      `n=${n}: ${repeats} repeated groups, pigeonhole floor ${floor}`
    );
  }
});

test('normalizeSession rebuilds a live session whose stored rounds are corrupt', () => {
  const s = createSession({ playerNames: names(8), durationMinutes: 120, gameMinutes: 12 });
  submitScore(s, currentRound(s).id, 11, 10);
  submitScore(s, currentRound(s).id, 15, 6);
  const stored = JSON.parse(JSON.stringify(s));
  stored.rounds[3].teams.a = ['ghost', 'pl_1'];
  stored.rounds[4].teams.b = ['pl_1'];
  stored.rounds.push({ id: 'bad', status: 'scheduled', teams: { a: [1, 2], b: [3, 4] } });

  const back = normalizeSession(stored);
  assert.ok(back);
  assert.equal(back.rounds.length, totalRounds(back), 'the deleted slots are rescheduled');
  assert.deepEqual(
    playedRounds(back).map((r) => [r.teams.a.length, r.teams.b.length, r.score.a + r.score.b]),
    [[2, 2, POINTS_TOTAL], [2, 2, POINTS_TOTAL]]
  );
  for (const r of back.rounds) {
    for (const id of [...r.teams.a, ...r.teams.b]) {
      assert.ok(back.players.some((p) => p.id === id), `round ${r.number} only references live ids`);
    }
  }
});

test('normalizeSession rejects junk instead of returning a half-session', () => {
  assert.equal(normalizeSession(null), null);
  assert.equal(normalizeSession('nope'), null);
  assert.equal(normalizeSession({ players: 'oops', rounds: [] }), null, 'players must be a list');
  assert.equal(normalizeSession({ players: [{ id: 'a', name: '  ' }], rounds: [] }), null, 'nameless player');
  const oneBad = normalizeSession({
    players: [
      { id: 'a', name: 'Ann' },
      { id: 'b', name: 'Bob' },
      { id: 'b', name: 'Dupe' },
      null,
    ],
    rounds: [],
  });
  assert.deepEqual(oneBad.players.map((p) => p.name), ['Ann', 'Bob']);
});

test('normalizeSession keeps a played round only if its score still adds up', () => {
  const base = createSession({ playerNames: names(4), durationMinutes: 20, gameMinutes: 5 });
  submitScore(base, currentRound(base).id, 11, 10);
  const good = JSON.parse(JSON.stringify(base));
  assert.deepEqual(normalizeSession(good).rounds[0].score, { a: 11, b: 10 });

  const brokenScore = JSON.parse(JSON.stringify(base));
  brokenScore.rounds[0].score = { a: 3, b: 3 };
  const healed = normalizeSession(brokenScore);
  assert.equal(playedRounds(healed).length, 0, 'an impossible score cannot stay played');
  assert.equal(healed.rounds.length, totalRounds(healed));
});

test('normalizeSession relocates a finished session and clamps out-of-range config', () => {
  const s = createSession({ playerNames: names(4) });
  finishSession(s);
  const stored = JSON.parse(JSON.stringify(s));
  stored.durationMinutes = 9999;
  stored.gameMinutes = 0;
  stored.date = 'not-a-date';
  const back = normalizeSession(stored);
  assert.equal(back.status, 'finished');
  assert.equal(back.durationMinutes, 600);
  assert.equal(back.gameMinutes, 5);
  assert.match(back.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(back.rounds.length, s.rounds.length, 'a finished schedule is never extended');
});

test('normalizeSession preserves an admin round-count cap', () => {
  const s = createSession({ playerNames: names(6), durationMinutes: 120, gameMinutes: 5 });
  deleteRound(s, s.rounds.at(-1).id);
  const before = totalRounds(s);
  const back = normalizeSession(JSON.parse(JSON.stringify(s)));
  assert.equal(totalRounds(back), before);
  assert.equal(back.rounds.length, before);
});

test('normalizeSession treats an unknown status as frozen history, never a second live session', () => {
  const s = createSession({ playerNames: names(6), durationMinutes: 120, gameMinutes: 12 });
  const statusless = JSON.parse(JSON.stringify(s));
  delete statusless.status;
  const back = normalizeSession(statusless);
  assert.equal(back.status, 'finished');
  assert.equal(back.rounds.length, s.rounds.length, 'the stored schedule is kept as it stands');
  rebuildSchedule(back);
  assert.equal(back.rounds.length, s.rounds.length, 'and is never topped up into a live rotation');
});

test('a player who leaves and rejoins still counts as one session entry', () => {
  const s = createSession({ playerNames: names(5), durationMinutes: 60, gameMinutes: 10 });
  submitScore(s, currentRound(s).id, 11, 10);
  submitScore(s, currentRound(s).id, 11, 10);
  const quitter = s.players.find((p) => p.name === 'P5');
  removePlayer(s, quitter.id);
  addPlayer(s, 'P5');
  let round;
  while ((round = currentRound(s))) submitScore(s, round.id, 11, 10);

  assert.equal(s.players.filter((p) => p.name === 'P5').length, 2, 'two roster rows, one human');
  const rows = aggregateStats([s]);
  assert.equal(rows.length, 5, 'still five distinct players');
  const p5 = rows.find((r) => r.name === 'P5');
  assert.equal(p5.sessions, 1, 'one session, not one per roster row');
  assert.equal(p5.avgPerSession, p5.points, 'the average divides by sessions actually played');
  const stats = playerSessionStats(s);
  assert.equal(
    p5.games,
    s.players.filter((p) => p.name === 'P5').reduce((n, p) => n + (stats.get(p.id)?.games || 0), 0),
    'games from both roster rows are pooled'
  );
  assert.equal(rows.reduce((sum, r) => sum + r.games, 0), totalRounds(s) * 4);
});
