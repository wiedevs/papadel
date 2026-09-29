import {
  POINTS_TOTAL,
  DEFAULT_DURATION_MINUTES,
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
  playerNameMap,
  aggregateStats,
  finishSession,
  activePlayers,
  renameSession,
  setSessionDate,
  updateRoundTeams,
  deleteRound,
  renamePlayer,
  removePlayerFromSession,
  normalizeSession,
} from './engine.mjs';
import { t, getLang, setLang, dateLocale } from './i18n.mjs';
import { NAME_MAX, importNames } from './csv.mjs';
import {
  ACTIONS,
  DEFAULT_ROLE,
  ROLES,
  actionForClick,
  actionForSubmit,
  can,
  normalizeRole,
  verifyPasscode,
} from './authz.mjs';

const LS_CURRENT = 'papadel.current.v1';
const LS_HISTORY = 'papadel.history.v1';
const LS_THEME = 'papadel.theme.v1';
const LS_ROLE = 'papadel.role.v1';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');
const $langToggle = document.getElementById('lang-toggle');
const $themeToggle = document.getElementById('theme-toggle');
const $roleToggle = document.getElementById('role-toggle');
const $unlockDialog = document.getElementById('unlock-dialog');

const saved = loadSaved();
let current = saved.current;
let history = saved.history;
let theme = loadTheme();
let role = loadRole();
let view = current ? 'live' : 'setup';
let toastTimer = null;
let lbFilter = 'all';
let editingRoundId = null;
let editingTeamsRoundId = null;
let editingPlayerId = null;
let editingMeta = false;
let draftSeeded = false;
let csvBoxOpen = false;

const draft = {
  name: '',
  date: todayStr(),
  duration: DEFAULT_DURATION_MINUTES,
  gameMinutes: DEFAULT_GAME_MINUTES,
  names: [],
  fromRecent: false,
};

// Typed-but-unsubmitted form values, keyed per form, so a re-render (or a
// rejected value) never wipes what the admin was in the middle of entering.
const formDrafts = new Map();

const RECENT_SESSION_COUNT = 3;

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// Stored sessions survive browser restarts and app revisions, so each one is
// normalised on load and whatever can't be read back is dropped rather than
// crashing the render. The canonical result is written straight back.
function loadSaved() {
  const rawCurrent = parseJSON(LS_CURRENT, null);
  const rawHistory = parseJSON(LS_HISTORY, []);

  let dropped = 0;
  const history = [];
  if (Array.isArray(rawHistory)) {
    for (const raw of rawHistory) {
      const session = normalizeSession(raw);
      if (session) history.push(session);
      else dropped += 1;
    }
  } else {
    dropped += 1;
  }

  const stored = normalizeSession(rawCurrent);
  if (rawCurrent !== null && !stored) dropped += 1;
  // LS_CURRENT must hold a live session: a finished one left behind by an
  // interrupted save belongs in history, not on the live court.
  const current = stored?.status === 'live' ? stored : null;
  if (stored && current === null) history.push(stored);

  saveSessions(current, history);
  return { current, history, dropped };
}

function saveSessions(nextCurrent, nextHistory) {
  try {
    if (nextCurrent) localStorage.setItem(LS_CURRENT, JSON.stringify(nextCurrent));
    else localStorage.removeItem(LS_CURRENT);
    localStorage.setItem(LS_HISTORY, JSON.stringify(nextHistory));
  } catch {
    /* storage unavailable — the app still runs from memory */
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Safari private mode and full quotas throw on every write.
    flashMsg(t('toast.storageFull'));
  }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    flashMsg(t('toast.storageFull'));
  }
}

// The two places saved session data leaves the app. Every user-facing write
// routes through these, so a viewer is stopped here even if a call site forgets
// to check. The load-time normalisation write-back deliberately bypasses this.
function saveCurrent() {
  if (!can(role, ACTIONS.SESSION_UPDATE)) return;
  writeJSON(LS_CURRENT, current);
}

function saveHistory() {
  if (!can(role, ACTIONS.SESSION_UPDATE)) return;
  writeJSON(LS_HISTORY, history);
}

function loadTheme() {
  try {
    return localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function loadRole() {
  try {
    return normalizeRole(localStorage.getItem(LS_ROLE));
  } catch {
    return DEFAULT_ROLE;
  }
}

function setRole(next) {
  role = normalizeRole(next);
  try {
    localStorage.setItem(LS_ROLE, role);
  } catch {
    /* storage unavailable — the role still applies for this session */
  }
}

function setTheme(next) {
  theme = next === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem(LS_THEME, theme);
  } catch {
    /* storage unavailable — theme still applies for this session */
  }
}

const TOAST_MS = 5000;

function flashMsg(msg, type = 'error') {
  $toast.innerHTML = `<div class="toast ${type}">
    <span class="toast-msg">${esc(msg)}</span>
    <button class="toast-x" data-action="close-toast" title="${t('toast.dismiss')}" aria-label="${t('toast.dismiss')}">&times;</button>
  </div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(clearToast, TOAST_MS);
}

function clearToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  $toast.innerHTML = '';
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Engine failures travel as stable codes; translate them at display time.
function engineError(res) {
  return t(`engine.${res.error}`, res.errorParams || {});
}

function applyChrome() {
  document.title = t('app.title');
  document.documentElement?.setAttribute?.('lang', getLang());
  document.documentElement?.setAttribute?.('data-theme', theme);
  const clearBtn = document.getElementById('clear-all');
  if (clearBtn) {
    clearBtn.textContent = t('footer.clearAll');
    clearBtn.title = t('footer.clearAllTitle');
    clearBtn.hidden = !canWrite(ACTIONS.DATA_WIPE);
  }
}

// Authorization checks for the UI layer. `canWrite` drives what gets rendered,
// `guardWrite` is what the handlers call before touching the engine, so a
// control that was on screen when the role changed still cannot write. A null
// action means the affordance touches no saved data.
function canWrite(action) {
  return can(role, action);
}

function guardWrite(action) {
  if (action === null || canWrite(action)) return true;
  flashMsg(t('toast.forbidden'));
  render();
  return false;
}

function renderLangToggle() {
  if (!$langToggle) return;
  $langToggle.setAttribute?.('aria-label', t('lang.toggleLabel'));
  $langToggle.innerHTML = ['id', 'en']
    .map(
      (l) =>
        `<button class="lang-btn ${getLang() === l ? 'active' : ''}" data-lang="${l}" title="${t(`lang.${l}`)}">${l.toUpperCase()}</button>`
    )
    .join('');
}

const THEME_ICONS = {
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  light:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
};

function renderThemeToggle() {
  if (!$themeToggle) return;
  const next = theme === 'dark' ? 'light' : 'dark';
  $themeToggle.setAttribute?.('title', t(next === 'light' ? 'theme.toLight' : 'theme.toDark'));
  $themeToggle.setAttribute?.('aria-label', t(next === 'light' ? 'theme.toLight' : 'theme.toDark'));
  $themeToggle.innerHTML = THEME_ICONS[theme];
}

// Role switch: which authorization policy the whole UI renders against. A
// prototype affordance, not a security boundary — see src/authz.mjs.
function roleButton(r) {
  return `<button class="lang-btn ${role === r ? 'active' : ''}" data-role="${r}" title="${t(`role.${r}.title`)}">${t(`role.${r}`)}</button>`;
}

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

function renderRoleToggle() {
  if (!$roleToggle) return;
  $roleToggle.setAttribute?.('aria-label', t('role.toggleLabel'));
  // Admin is not a button a viewer can press — it has to be unlocked first.
  const unlock = `<button class="lang-btn" data-action="show-unlock" title="${t('role.unlock.title')}">${LOCK_ICON}${t('role.unlock')}</button>`;
  $roleToggle.innerHTML = role === 'admin' ? ROLES.map(roleButton).join('') : unlock + roleButton('viewer');
}

function unlockDialogHtml() {
  return `<form class="unlock-body" novalidate>
    <h2>${t('role.unlock.title')}</h2>
    <label class="field">${t('role.unlockLabel')}
      <input id="f-passcode" type="password" autocomplete="off" maxlength="12" required>
    </label>
    <p class="unlock-error" id="unlock-error" hidden></p>
    <div class="row end">
      <button class="btn" type="button" data-action="cancel-unlock">${t('role.unlockCancel')}</button>
      <button class="btn primary" type="submit">${t('role.unlockSubmit')}</button>
    </div>
    <p class="muted unlock-hint">${t('role.unlockHint')}</p>
  </form>`;
}

function openUnlockDialog() {
  if (!$unlockDialog) return;
  $unlockDialog.innerHTML = unlockDialogHtml();
  $unlockDialog.showModal();
  document.getElementById('f-passcode')?.focus();
}

function showUnlockError() {
  const box = document.getElementById('unlock-error');
  if (box) {
    box.textContent = t('toast.passcodeWrong');
    box.hidden = false;
  }
  const input = document.getElementById('f-passcode');
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.select();
    input.focus();
  }
}

function shortDate(date) {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' });
}

// Oldest first: the cumulative table renders one column per session, so the
// trend line has to read left-to-right as time moving forward.
function allSessions() {
  const withIndex = (current ? [...history, current] : history.slice()).map((session, i) => ({ session, i }));
  return withIndex
    .sort((x, y) =>
      x.session.date === y.session.date ? x.i - y.i : x.session.date < y.session.date ? -1 : 1
    )
    .map((e) => e.session);
}

// Newest first: date desc, later-added session wins a date tie.
function recentParticipants(limit = RECENT_SESSION_COUNT) {
  const ordered = allSessions()
    .map((session, i) => ({ session, i }))
    .sort((x, y) => (x.session.date === y.session.date ? y.i - x.i : x.session.date < y.session.date ? -1 : 1))
    .slice(0, limit);
  const seen = new Set();
  const names = [];
  for (const { session } of ordered) {
    for (const p of session.players) {
      const key = p.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(p.name);
    }
  }
  return names;
}

function seedDraftFromRecent() {
  if (draftSeeded || draft.names.length) return;
  draftSeeded = true;
  const names = recentParticipants();
  if (!names.length) return;
  draft.names = names;
  draft.fromRecent = true;
}

function findSession(id) {
  if (current && current.id === id) return current;
  return history.find((s) => s.id === id) || null;
}

function persist(session) {
  if (session.status === 'live') saveCurrent();
  else saveHistory();
}

function sessionTitle(session) {
  return session.name || session.date;
}

function sessionLabel(session) {
  return session.name ? `${session.name} · ${session.date}` : session.date;
}

function closeEditors() {
  editingRoundId = null;
  editingTeamsRoundId = null;
  editingPlayerId = null;
  editingMeta = false;
  formDrafts.clear();
}

function draftValue(key, field, fallback) {
  const fields = formDrafts.get(key);
  const value = fields ? fields[field] : undefined;
  return value === undefined ? fallback : value;
}

function clearDraft(key) {
  formDrafts.delete(key);
}

function selectedAttr(value, current) {
  return value === current ? ' selected' : '';
}

// --- Inline admin editors ----------------------------------------------------

function lockedTag(round) {
  return round.locked ? ` <span class="tag pin" title="${t('locked.title')}">${t('locked.tag')}</span>` : '';
}

function metaEditor(session) {
  const key = `meta:${session.id}`;
  return `<form id="f-meta" class="row editor" data-sid="${session.id}">
    <label class="field grow">${t('meta.name')}
      <input id="meta-name" data-draft="${key}" data-field="name" maxlength="40" placeholder="${t('meta.namePlaceholder')}"
        value="${esc(draftValue(key, 'name', session.name || ''))}">
    </label>
    <label class="field">${t('meta.date')}
      <input type="date" id="meta-date" data-draft="${key}" data-field="date"
        value="${esc(draftValue(key, 'date', session.date))}">
    </label>
    <button class="btn primary" type="submit">${t('ed.save')}</button>
    <button class="btn" type="button" data-action="cancel-meta">${t('ed.cancel')}</button>
  </form>`;
}

function roundTeamsEditor(session, round) {
  const key = `teams:${round.id}`;
  const options = (selectedId) =>
    activePlayers(session)
      .map((p) => `<option value="${p.id}"${selectedAttr(p.id, selectedId)}>${esc(p.name)}</option>`)
      .join('');
  const slot = (team, idx) => {
    const field = `${team}${idx}`;
    const selectedId = draftValue(key, field, round.teams[team][idx]);
    return `<select class="mini-select" data-draft="${key}" data-field="${field}">${options(selectedId)}</select>`;
  };
  return `<form class="teams-edit" data-sid="${session.id}" data-round="${round.id}">
    <strong>R${round.number}</strong>
    ${slot('a', 0)} ${slot('a', 1)} <span class="muted">${t('live.vs')}</span> ${slot('b', 0)} ${slot('b', 1)}
    <button class="btn-xs primary" type="submit">${t('ed.saveXs')}</button>
    <button class="btn-xs" type="button" data-action="cancel-teams">${t('ed.cancelXs')}</button>
  </form>`;
}

function playerActions(session, player, { allowLeave = false } = {}) {
  if (!canWrite(ACTIONS.PLAYER_UPDATE)) return '';
  if (editingPlayerId === player.id) {
    const key = `player:${player.id}`;
    return `<form class="row player-edit" data-sid="${session.id}" data-id="${player.id}">
      <input class="mini-input wide" data-draft="${key}" data-field="name" maxlength="24"
        value="${esc(draftValue(key, 'name', player.name))}">
      <button class="btn-xs primary" type="submit">${t('ed.saveXs')}</button>
      <button class="btn-xs" type="button" data-action="cancel-player">${t('ed.cancelXs')}</button>
    </form>`;
  }
  const buttons = [
    `<button class="btn-xs" data-action="rename-player" data-sid="${session.id}" data-id="${player.id}">${t('player.rename')}</button>`,
    allowLeave
      ? `<button class="btn-xs" data-action="remove-player" data-sid="${session.id}" data-id="${player.id}" title="${t('player.leftTitle')}">${t('player.left')}</button>`
      : '',
    canWrite(ACTIONS.PLAYER_DELETE)
      ? `<button class="btn-xs danger" data-action="remove-session-player" data-sid="${session.id}" data-id="${player.id}" title="${t('player.removeTitle')}">${t('player.remove')}</button>`
      : '',
  ];
  return buttons.filter(Boolean).join(' ');
}

// Points per player name for one session. Names are the only cross-session
// identity the prototype has, and a player who left and rejoined holds two
// roster rows, so every row's points have to fold into one number.
function sessionPointsByName(session) {
  const stats = playerSessionStats(session);
  const byName = new Map();
  for (const p of session.players) {
    const s = stats.get(p.id);
    if (!s) continue;
    const key = p.name.toLowerCase();
    byName.set(key, (byName.get(key) || 0) + s.points);
  }
  return byName;
}

function sparkline(values) {
  const w = 76;
  const h = 22;
  const pad = 4;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const xAt = (i) => (values.length > 1 ? pad + i * step : w / 2);
  const yAt = (v) => (values.length > 1 ? h - pad - ((v - min) / span) * (h - pad * 2) : h / 2);
  const pts = values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" title="${esc(values.join(' · '))}">
    ${values.length > 1 ? `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    <circle cx="${xAt(last).toFixed(1)}" cy="${yAt(values[last]).toFixed(1)}" r="2.6" fill="var(--accent)"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // A viewer has no setup form to land on, so the create-only view is swapped
  // for whatever is readable.
  if (view === 'setup' && !canWrite(ACTIONS.SESSION_CREATE)) view = current ? 'live' : 'leaderboard';
  renderNav();
  renderLangToggle();
  renderRoleToggle();
  renderThemeToggle();
  if (view === 'setup') {
    seedDraftFromRecent();
    $app.innerHTML = setupView();
  } else if (view === 'live') $app.innerHTML = liveView();
  else $app.innerHTML = leaderboardView();
}

function renderNav() {
  const items = [
    ['setup', t('nav.setup')],
    ['live', t('nav.live')],
    ['leaderboard', t('nav.leaderboard')],
  ].filter(([v]) => v !== 'setup' || canWrite(ACTIONS.SESSION_CREATE));
  $nav.innerHTML = items
    .map(
      ([v, label]) =>
        `<button class="navbtn ${view === v ? 'active' : ''}" data-action="nav" data-view="${v}" ${
          v === 'live' && !current ? 'disabled' : ''
        }>${label}</button>`
    )
    .join('');
}

// --- Setup view -------------------------------------------------------------

function setupView() {
  const duration = Number(draft.duration) || 0;
  const game = Number(draft.gameMinutes) || 0;
  const planned = game > 0 ? Math.floor(duration / game) : 0;
  const canStart = draft.names.length >= 4 && planned >= 1;

  return `
    <div class="banner">${t('setup.banner')}</div>
    <section class="card">
      <h2>${t('setup.title')}</h2>
      <div class="row">
        <label class="field grow">${t('setup.sessionName')} <span class="muted">${t('setup.optional')}</span>
          <input id="f-session-name" maxlength="40" placeholder="${t('setup.namePlaceholder')}" value="${esc(draft.name)}">
        </label>
      </div>
      <div class="grid3">
        <label class="field">${t('setup.date')}
          <input type="date" id="f-date" value="${esc(draft.date)}">
        </label>
        <label class="field">${t('setup.duration')}
          <input type="number" id="f-duration" min="15" max="600" step="5" value="${esc(draft.duration)}">
        </label>
        <label class="field">${t('setup.gameLength')}
          <input type="number" id="f-game" min="5" max="60" step="1" value="${esc(draft.gameMinutes)}">
        </label>
      </div>
      <p class="muted">${t('setup.planned', { rounds: planned, minutes: planned * game })}</p>
    </section>
    <section class="card">
      <h2>${t('setup.participants')} <span class="count">${draft.names.length}</span></h2>
      ${
        draft.fromRecent
          ? `<p class="muted">${t('setup.prefill', { count: RECENT_SESSION_COUNT })}</p>`
          : ''
      }
      <form id="f-add-draft" class="row">
        <input id="f-name" data-draft="add-draft" data-field="name" placeholder="${t('setup.playerName')}" autocomplete="off" maxlength="24"
          value="${esc(draftValue('add-draft', 'name', ''))}">
        <button class="btn" type="submit">${t('setup.add')}</button>
      </form>
      <details class="csv-box"${csvBoxOpen ? ' open' : ''}>
        <summary data-action="toggle-csv">${t('setup.csvToggle')}</summary>
        <form id="f-import-csv" class="csv-form">
          <textarea id="f-csv" class="csv-area" rows="4" spellcheck="false" data-draft="import-csv" data-field="text"
            placeholder="${t('setup.csvPlaceholder')}">${esc(draftValue('import-csv', 'text', ''))}</textarea>
          <div class="row">
            <button class="btn" type="submit">${t('setup.csvImport')}</button>
          </div>
          <p class="muted">${t('setup.csvHint')}</p>
        </form>
      </details>
      <div class="chips">
        ${draft.names
          .map(
            (n, i) =>
              `<span class="chip">${esc(n)}<button class="chip-x" data-action="remove-draft" data-index="${i}" title="${t('setup.remove')}" aria-label="${t('setup.remove')}">&times;</button></span>`
          )
          .join('')}
      </div>
      <div class="row end">
        <button class="btn primary" data-action="start" ${canStart ? '' : 'disabled'}>${t('setup.start')}</button>
      </div>
      ${draft.names.length < 4 ? `<p class="muted">${t('setup.needFour')}</p>` : ''}
    </section>`;
}

// --- Live view --------------------------------------------------------------

function liveView() {
  if (!current) {
    view = canWrite(ACTIONS.SESSION_CREATE) ? 'setup' : 'leaderboard';
    return view === 'setup' ? setupView() : leaderboardView();
  }
  const played = playedRounds(current);
  const total = totalRounds(current);
  const round = currentRound(current);
  const stats = playerSessionStats(current);
  const nameOf = playerNameMap(current);
  const maxGames = Math.max(1, ...[...stats.values()].map((s) => s.games));
  const progress = total ? Math.round((played.length / total) * 100) : 0;

  const teamNames = (ids) =>
    ids.map((id) => `<span class="pname">${esc(nameOf.get(id) || '?')}</span>`).join(' <span class="amp">&amp;</span> ');

  const canScore = canWrite(ACTIONS.ROUND_SCORE);

  const court = !round
    ? `<div class="card court">
         <h2>${t('live.allComplete', { total })}</h2>
         <p class="muted">${canScore ? t('live.endHint') : t('live.allCompleteReadonly')}</p>
         ${canScore ? `<button class="btn primary" data-action="end-session">${t('live.endSave')}</button>` : ''}
       </div>`
    : `<div class="card court">
         <div class="court-head">
           <h2>${t('live.round', { number: round.number })} <span class="muted">${t('live.ofTotal', { total })}</span></h2>
           <span class="pill">${t('live.minutesRange', { start: round.startMinute, end: round.endMinute })}</span>
         </div>
         <div class="teams">
           <div class="team">
             <div class="team-names">${teamNames(round.teams.a)}</div>
             <div class="team-label">${t('live.teamA')}</div>
           </div>
           <div class="vs">VS</div>
           <div class="team">
             <div class="team-names">${teamNames(round.teams.b)}</div>
             <div class="team-label">${t('live.teamB')}</div>
           </div>
         </div>
         ${
           canScore
             ? `<form id="f-score" class="row center" data-round="${round.id}">
           <input type="number" id="score-a" data-draft="score:${round.id}" data-field="a"
             min="0" max="${POINTS_TOTAL}" value="${esc(draftValue(`score:${round.id}`, 'a', ''))}" placeholder="0" required>
           <span class="dash">–</span>
           <input type="number" id="score-b" data-draft="score:${round.id}" data-field="b"
             min="0" max="${POINTS_TOTAL}" value="${esc(draftValue(`score:${round.id}`, 'b', ''))}" placeholder="${POINTS_TOTAL}" required>
           <button class="btn primary" type="submit">${t('live.submit', { total: POINTS_TOTAL })}</button>
         </form>
         <p class="muted center">${t('live.scoringHint')}</p>`
             : `<p class="muted center">${t('live.scoreReadonly', { total: POINTS_TOTAL })}</p>`
         }
       </div>`;

  const playersCard = `<div class="card">
    <h2>${t('live.players')} <span class="count">${t('live.activeCount', { count: activePlayers(current).length })}</span></h2>
    ${canWrite(ACTIONS.PLAYER_CREATE) ? `<form id="f-add-live" class="row">
      <input id="f-live-name" data-draft="add-live" data-field="name" placeholder="${t('live.joinPlaceholder')}"
        autocomplete="off" maxlength="24" value="${esc(draftValue('add-live', 'name', ''))}">
      <button class="btn" type="submit">${t('live.join')}</button>
    </form>` : ''}
    <div style="overflow-x:auto">
    <table class="tbl">
      <thead>
        <tr><th>${t('lb.thPlayer')}</th><th>${t('live.thNow')}</th><th>${t('live.thGames')}</th><th>${t('live.thPts')}</th><th>${t('live.thWL')}</th><th>${t('live.thEstMin')}</th><th>${t('live.thPlaytime')}</th><th></th></tr>
      </thead>
      <tbody>
        ${current.players
          .map((p) => {
            const s = stats.get(p.id) || { games: 0, points: 0, wins: 0, losses: 0 };
            const now = !p.active
              ? `<span class="tag left">${t('live.tagLeft')}</span>`
              : !round
                ? '—'
                : round.teams.a.includes(p.id) || round.teams.b.includes(p.id)
                  ? `<span class="tag play">${t('live.tagPlaying')}</span>`
                  : `<span class="tag wait">${t('live.tagWaiting')}</span>`;
            const pct = Math.round((s.games / maxGames) * 100);
            return `<tr${p.active ? '' : ' class="gone"'}>
              <td>${esc(p.name)}</td>
              <td>${now}</td>
              <td>${s.games}</td>
              <td><strong>${s.points}</strong></td>
              <td>${s.wins}–${s.losses}</td>
              <td>${s.games * current.gameMinutes}</td>
              <td><div class="bar" title="${t('live.gamesTooltip', { count: s.games })}"><div class="bar-fill" style="width:${pct}%"></div></div></td>
              <td class="actions-col">${playerActions(current, p, { allowLeave: p.active })}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
    </div>
  </div>`;

  const upcomingList = current.rounds.filter((r) => r.status === 'scheduled');
  const upcomingCard = `<div class="card">
    <h2>${t('live.upNext')} <span class="count">${t('live.rebalanced')}</span></h2>
    ${
      upcomingList.length
        ? `<ol class="upcoming">
            ${upcomingList
              .slice(0, 6)
              .map((r) =>
                editingTeamsRoundId === r.id
                  ? `<li>${roundTeamsEditor(current, r)}</li>`
                  : `<li><strong>R${r.number}</strong>${lockedTag(r)} · ${teamNames(r.teams.a)} ${t('live.vs')} ${teamNames(r.teams.b)}${
                      r.bye.length
                        ? ` · <span class="muted">${t('live.waiting', { names: r.bye.map((id) => esc(nameOf.get(id) || '?')).join(', ') })}</span>`
                        : ''
                    }
                    ${
                      canWrite(ACTIONS.ROUND_UPDATE)
                        ? `<button class="btn-xs" data-action="edit-teams" data-sid="${current.id}" data-round="${r.id}">${t('live.edit')}</button>`
                        : ''
                    }
                    ${
                      canWrite(ACTIONS.ROUND_DELETE)
                        ? `<button class="btn-xs danger" data-action="delete-round" data-sid="${current.id}" data-round="${r.id}">${t('live.delete')}</button>`
                        : ''
                    }</li>`
              )
              .join('')}
          </ol>
          ${upcomingList.length > 6 ? `<p class="muted">${t('live.moreRounds', { count: upcomingList.length - 6 })}</p>` : ''}`
        : `<p class="muted">${t('live.noRoundsLeft')}</p>`
    }
  </div>`;

  return `
    <section class="card">
      <div class="row between">
        <div>
          <h2 class="inline">${esc(sessionTitle(current))}</h2>
          ${current.name ? `<span class="muted"> · ${esc(current.date)}</span>` : ''}
          <span class="muted"> · ${current.durationMinutes} ${t('unit.min')} · ${current.gameMinutes} ${t('unit.minPerGame')} · ${activePlayers(current).length} ${t('unit.players')}</span>
        </div>
        <div class="row">
          ${
            canWrite(ACTIONS.SESSION_UPDATE)
              ? `<button class="btn" data-action="edit-meta" data-sid="${current.id}">${t('live.editDetails')}</button>
          <button class="btn danger" data-action="end-session">${t('live.endSession')}</button>`
              : `<span class="pill readonly">${t('role.viewer.badge')}</span>`
          }
        </div>
      </div>
      ${editingMeta ? metaEditor(current) : ''}
    </section>
    <div class="progress"><div class="progress-fill" style="width:${progress}%"></div></div>
    <p class="muted">${t('live.progress', { played: played.length, total })}</p>
    ${court}
    <div class="cols">
      <div>${playersCard}</div>
      <div>${upcomingCard}</div>
    </div>`;
}

// --- Leaderboard & history view ----------------------------------------------

function leaderboardView() {
  const sessions = allSessions();
  const agg = aggregateStats(sessions);
  const selected = lbFilter === 'all' ? null : findSession(lbFilter);
  if (lbFilter !== 'all' && !selected) lbFilter = 'all';

  return `
    <section class="card">
      <div class="row between">
        <h2 class="inline">${t('lb.title')}</h2>
        <label class="field inline-field">${t('lb.sessionFilter')}
          <select id="f-session-filter">
            <option value="all" ${lbFilter === 'all' ? 'selected' : ''}>${t('lb.allSessions')}</option>
            ${sessions
              .map(
                (s) =>
                  `<option value="${s.id}" ${lbFilter === s.id ? 'selected' : ''}>${esc(sessionLabel(s))}${
                    s.status === 'live' ? ` ${t('lb.live')}` : ''
                  }</option>`
              )
              .join('')}
          </select>
        </label>
      </div>
      ${selected ? sessionDetail(selected) : cumulativeTable(agg, sessions)}
    </section>
    ${
      sessions.length
        ? `<section class="card">
            <h2>${t('lb.history')}</h2>
            <ul class="sess-list">
              ${sessions
                .slice()
                .reverse()
                .map(
                  (s) =>
                    `<li><button class="link-btn" data-action="open-session" data-sid="${s.id}">${esc(sessionLabel(s))}${
                      s.status === 'live' ? ` ${t('lb.live')}` : ''
                    }</button> · ${t('lb.roundsPlayers', { played: playedRounds(s).length, total: totalRounds(s), count: s.players.length })}</li>`
                )
                .join('')}
            </ul>
          </section>`
        : ''
    }`;
}

function cumulativeTable(agg, sessions) {
  if (!agg.length) {
    return `<p class="muted">${t('lb.empty')}</p>`;
  }
  const perSession = sessions.map(sessionPointsByName);
  return `<div style="overflow-x:auto">
    <table class="tbl">
      <thead>
        <tr>
          <th>${t('lb.thRank')}</th><th>${t('lb.thPlayer')}</th><th>${t('lb.thSessions')}</th><th>${t('lb.thGames')}</th><th>${t('lb.thWins')}</th><th>${t('lb.thLosses')}</th>
          <th>${t('lb.thTotalPts')}</th><th>${t('lb.thAvg')}</th><th>${t('lb.thTrend')}</th>
          ${sessions
            .map(
              (s) =>
                `<th class="th-link" data-action="open-session" data-sid="${s.id}" title="${t(
                  s.status === 'live' ? 'lb.openLiveTitle' : 'lb.openSessionTitle'
                )}">${esc(shortDate(s.date))}${s.status === 'live' ? `<span class="live-tag">${t('lb.liveTag')}</span>` : ''}${
                  s.name ? `<span class="th-name">${esc(s.name)}</span>` : ''
                }</th>`
            )
            .join('')}
        </tr>
      </thead>
      <tbody>
        ${agg
          .map((a, i) => {
            const key = a.name.toLowerCase();
            const values = perSession.map((map) => (map.has(key) ? map.get(key) : null)).filter((v) => v !== null);
            return `<tr>
              <td>${i + 1}</td>
              <td><strong>${esc(a.name)}</strong></td>
              <td>${a.sessions}</td>
              <td>${a.games}</td>
              <td>${a.wins}</td>
              <td>${a.losses}</td>
              <td><strong>${a.points}</strong></td>
              <td>${a.avgPerSession}</td>
              <td>${sparkline(values)}</td>
              ${perSession.map((map) => { const v = map.get(key); return `<td>${v === undefined ? '–' : v}</td>`; }).join('')}
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function sessionDetail(session) {
  const stats = playerSessionStats(session);
  const nameOf = playerNameMap(session);
  const played = playedRounds(session);
  const isLive = session.status === 'live';
  const teamNames = (ids) => ids.map((id) => esc(nameOf.get(id) || '?')).join(' & ');

  const ranking = session.players
    .map((p) => ({ p, s: stats.get(p.id) || { games: 0, points: 0, wins: 0, losses: 0 } }))
    .sort((x, y) => y.s.points - x.s.points || y.s.wins - x.s.wins || x.p.name.localeCompare(y.p.name));

  const matchRows = session.rounds
    .map((r) => {
      if (editingTeamsRoundId === r.id) {
        return `<tr><td colspan="5">${roundTeamsEditor(session, r)}</td></tr>`;
      }
      const editing = editingRoundId === r.id;
      let scoreCell = '<span class="muted">–</span>';
      if (r.status === 'played') {
        scoreCell = editing
          ? `<span class="edit-wrap">
              <input type="number" class="mini-input" id="edit-a" data-draft="score:${r.id}" data-field="a"
                min="0" max="${POINTS_TOTAL}" value="${esc(draftValue(`score:${r.id}`, 'a', r.score.a))}">
              <span class="dash">–</span>
              <input type="number" class="mini-input" id="edit-b" data-draft="score:${r.id}" data-field="b"
                min="0" max="${POINTS_TOTAL}" value="${esc(draftValue(`score:${r.id}`, 'b', r.score.b))}">
            </span>`
          : `<strong>${r.score.a}</strong> <span class="dash">–</span> <strong>${r.score.b}</strong>`;
      }
      const canUpdateRound = canWrite(ACTIONS.ROUND_UPDATE);
      const canDeleteRound = canWrite(ACTIONS.ROUND_DELETE);
      const actions = editing
        ? `<button class="btn-xs primary" data-action="save-score" data-round="${r.id}" data-sid="${session.id}">${t('ed.saveXs')}</button>
           <button class="btn-xs" data-action="cancel-edit">${t('ed.cancelXs')}</button>`
        : `${
            r.status === 'played'
              ? canUpdateRound
                ? `<button class="btn-xs" data-action="edit-score" data-round="${r.id}">${t('detail.editScore')}</button> `
                : ''
              : canUpdateRound
                ? `<button class="btn-xs" data-action="edit-teams" data-sid="${session.id}" data-round="${r.id}">${t('detail.lineup')}</button> `
                : ''
          }${
            canDeleteRound
              ? `<button class="btn-xs danger" data-action="delete-round" data-sid="${session.id}" data-round="${r.id}">${t('live.delete')}</button>`
              : ''
          }`;
      return `<tr>
        <td>R${r.number}${lockedTag(r)}</td>
        <td>${teamNames(r.teams.a)}</td>
        <td class="score-col">${scoreCell}</td>
        <td>${teamNames(r.teams.b)}</td>
        <td class="actions-col">${actions}</td>
      </tr>`;
    })
    .join('');

  return `
    <div class="row between detail-head">
      <div>
        <h3 class="inline">${esc(sessionTitle(session))}</h3>
        <span class="tag ${isLive ? 'play' : 'wait'}">${isLive ? t('detail.live') : t('detail.finished')}</span>
        <div class="muted">${session.name ? `${esc(session.date)} · ` : ''}${t('detail.meta', {
          minutes: session.durationMinutes,
          game: session.gameMinutes,
          count: session.players.length,
          played: played.length,
          total: totalRounds(session),
        })}</div>
      </div>
      <div class="row">
        ${
          canWrite(ACTIONS.SESSION_UPDATE)
            ? `<button class="btn" data-action="edit-meta" data-sid="${session.id}">${t('live.editDetails')}</button>`
            : ''
        }
        ${
          canWrite(ACTIONS.SESSION_DELETE)
            ? isLive
              ? `<button class="btn danger" data-action="discard-live">${t('detail.discard')}</button>`
              : `<button class="btn danger" data-action="delete-session" data-sid="${session.id}">${t('detail.delete')}</button>`
            : `<span class="pill readonly">${t('role.viewer.badge')}</span>`
        }
      </div>
    </div>
    ${editingMeta ? metaEditor(session) : ''}
    <h3>${t('detail.ranking')} ${
      canWrite(ACTIONS.PLAYER_UPDATE) ? `<span class="count">${t('detail.rankingHint')}</span>` : ''
    }</h3>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr><th>${t('lb.thRank')}</th><th>${t('lb.thPlayer')}</th><th>${t('live.thGames')}</th><th>${t('live.thPts')}</th><th>${t('live.thWL')}</th><th>${t('live.thEstMin')}</th><th></th></tr></thead>
        <tbody>
          ${ranking
            .map(
              ({ p, s }, i) => `<tr>
                <td>${i + 1}</td>
                <td>${esc(p.name)}${p.active ? '' : ` <span class="muted">${t('detail.left')}</span>`}</td>
                <td>${s.games}</td>
                <td><strong>${s.points}</strong></td>
                <td>${s.wins}–${s.losses}</td>
                <td>${s.games * session.gameMinutes}</td>
                <td class="actions-col">${playerActions(session, p)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <h3>${t('detail.matches')} ${
      canWrite(ACTIONS.ROUND_UPDATE) ? `<span class="count">${t('detail.matchesHint')}</span>` : ''
    }</h3>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr><th>${t('detail.thRound')}</th><th>${t('detail.thTeamA')}</th><th>${t('detail.thScore')}</th><th>${t('detail.thTeamB')}</th><th></th></tr></thead>
        <tbody>${matchRows}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// The setup inputs are bound to `change`, which a browser only fires once the
// field commits — so read the live values straight from the DOM at Start.
function syncDraftFromForm() {
  const value = (id) => document.getElementById(id)?.value;
  const name = value('f-session-name');
  if (name !== undefined) draft.name = name;
  const date = value('f-date');
  if (date) draft.date = date;
  for (const [id, field] of [['f-duration', 'duration'], ['f-game', 'gameMinutes']]) {
    const raw = value(id);
    if (raw !== undefined && raw !== '') draft[field] = raw;
  }
}

function startSession() {
  syncDraftFromForm();
  const planned = Math.floor(Number(draft.duration) / Number(draft.gameMinutes));
  if (draft.names.length < 4 || !(planned >= 1)) {
    flashMsg(t('toast.cannotStart'));
    render();
    return;
  }
  if (current) {
    const played = playedRounds(current).length;
    if (!confirm(t('confirm.discardLiveStart', { played }))) return;
    removeKey(LS_CURRENT);
    current = null;
  }
  current = createSession({
    name: draft.name,
    date: draft.date,
    durationMinutes: draft.duration,
    gameMinutes: draft.gameMinutes,
    playerNames: draft.names,
  });
  if (current.rounds.length === 0) {
    current = null;
    flashMsg(t('toast.noRounds'));
    render();
    return;
  }
  closeEditors();
  draft.date = todayStr();
  draft.name = '';
  // Re-derive the next roster from the last 3 sessions instead of keeping a
  // copy of this one — so admin deletions can never leave stale chips behind.
  draft.names = [];
  draft.fromRecent = false;
  draftSeeded = false;
  saveCurrent();
  view = 'live';
  render();
}

function endSessionFlow() {
  if (!current) return;
  const played = playedRounds(current).length;
  if (!confirm(t('confirm.endSession', { played }))) return;
  finishSession(current);
  history.push(current);
  saveHistory();
  current = null;
  removeKey(LS_CURRENT);
  closeEditors();
  view = 'leaderboard';
  render();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$nav.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="nav"]');
  if (!el || el.disabled) return;
  view = el.dataset.view;
  closeEditors();
  render();
});

$langToggle?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lang]');
  if (!btn) return;
  setLang(btn.dataset.lang);
  applyChrome();
  renderLangToggle();
  renderThemeToggle();
  render();
});

$themeToggle?.addEventListener('click', () => {
  setTheme(theme === 'dark' ? 'light' : 'dark');
  applyChrome();
  renderThemeToggle();
});

$roleToggle?.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="show-unlock"]')) {
    openUnlockDialog();
    return;
  }
  const btn = e.target.closest('[data-role]');
  if (!btn || btn.dataset.role === role) return;
  setRole(btn.dataset.role);
  // Close any open editor so a demoted role can't keep writing through a
  // form that was on screen while it was still an admin.
  closeEditors();
  clearToast();
  applyChrome();
  render();
});

$unlockDialog?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!verifyPasscode(document.getElementById('f-passcode')?.value)) {
    showUnlockError();
    return;
  }
  $unlockDialog.close();
  setRole('admin');
  closeEditors();
  clearToast();
  applyChrome();
  render();
  flashMsg(t('toast.unlocked'), 'ok');
});

$unlockDialog?.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="cancel-unlock"]')) $unlockDialog.close();
});

$app.addEventListener('click', (e) => {
  const dateInput = e.target.closest('input[type="date"]');
  if (dateInput && !dateInput.readOnly) {
    try { dateInput.showPicker(); } catch { /* older browsers: icon still works */ }
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  const required = actionForClick(d.action);
  if (!guardWrite(required)) return;
  const session = d.sid ? findSession(d.sid) : current;
  if (d.sid && !session) return; // rendered from a session that no longer exists
  if (d.action === 'remove-draft') {
    draft.names.splice(Number(d.index), 1);
    render();
  } else if (d.action === 'toggle-csv') {
    e.preventDefault();
    csvBoxOpen = !csvBoxOpen;
    render();
  } else if (d.action === 'start') {
    startSession();
  } else if (d.action === 'remove-player') {
    const name = session?.players.find((p) => p.id === d.id)?.name;
    if (confirm(t('confirm.markLeft', { name }))) {
      const res = removePlayer(session, d.id);
      if (!res.ok) flashMsg(engineError(res));
      persist(session);
      render();
    }
  } else if (d.action === 'remove-session-player') {
    const player = session?.players.find((p) => p.id === d.id);
    const rounds = playerRounds(session, d.id);
    const played = rounds.filter((r) => r.status === 'played').length;
    const warning = rounds.length
      ? t('confirm.removePlayerWarn', { count: rounds.length, played })
      : t('confirm.removePlayerNoRounds');
    if (player && confirm(t('confirm.removePlayer', { name: player.name, warning }))) {
      const res = removePlayerFromSession(session, d.id);
      if (!res.ok) flashMsg(engineError(res));
      else flashMsg(t('toast.playerErased', { name: player.name }), 'ok');
      persist(session);
      render();
    }
  } else if (d.action === 'rename-player') {
    editingPlayerId = d.id;
    render();
  } else if (d.action === 'cancel-player') {
    clearDraft(`player:${d.id}`);
    editingPlayerId = null;
    render();
  } else if (d.action === 'end-session') {
    endSessionFlow();
  } else if (d.action === 'open-session') {
    lbFilter = d.sid;
    closeEditors();
    render();
  } else if (d.action === 'edit-score') {
    editingRoundId = d.round;
    editingTeamsRoundId = null;
    render();
  } else if (d.action === 'cancel-edit') {
    clearDraft(`score:${d.round}`);
    editingRoundId = null;
    render();
  } else if (d.action === 'save-score') {
    const target = findSession(d.sid);
    if (target) {
      const res = updateScore(
        target,
        d.round,
        document.getElementById('edit-a').value,
        document.getElementById('edit-b').value
      );
      if (!res.ok) {
        flashMsg(engineError(res));
        render();
        return;
      }
      flashMsg(t('toast.scoreUpdated'), 'ok');
      clearDraft(`score:${d.round}`);
      persist(target);
    }
    editingRoundId = null;
    render();
  } else if (d.action === 'edit-teams') {
    editingTeamsRoundId = d.round;
    editingRoundId = null;
    render();
  } else if (d.action === 'cancel-teams') {
    clearDraft(`teams:${d.round}`);
    editingTeamsRoundId = null;
    render();
  } else if (d.action === 'delete-round') {
    const round = session?.rounds.find((r) => r.id === d.round);
    if (!round) return;
    const warning =
      round.status === 'played'
        ? t('confirm.deletePlayedRound', { number: round.number, a: round.score.a, b: round.score.b })
        : t('confirm.deleteScheduledRound', { number: round.number });
    if (confirm(warning)) {
      const res = deleteRound(session, d.round);
      if (!res.ok) flashMsg(engineError(res));
      else flashMsg(t('toast.roundDeleted', { number: round.number }), 'ok');
      persist(session);
    }
    closeEditors();
    render();
  } else if (d.action === 'edit-meta') {
    editingMeta = true;
    render();
  } else if (d.action === 'cancel-meta') {
    clearDraft(`meta:${session.id}`);
    editingMeta = false;
    render();
  } else if (d.action === 'delete-session') {
    const target = findSession(d.sid);
    if (target && confirm(t('confirm.deleteSession', { label: sessionLabel(target) }))) {
      history = history.filter((s) => s.id !== d.sid);
      saveHistory();
      lbFilter = 'all';
      closeEditors();
      flashMsg(t('toast.sessionDeleted'), 'ok');
    }
    render();
  } else if (d.action === 'discard-live') {
    if (current && confirm(t('confirm.discardLive'))) {
      current = null;
      removeKey(LS_CURRENT);
      lbFilter = 'all';
      view = 'setup';
      closeEditors();
    }
    render();
  }
});

$app.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.draft) return;
  let fields = formDrafts.get(el.dataset.draft);
  if (!fields) {
    fields = {};
    formDrafts.set(el.dataset.draft, fields);
  }
  fields[el.dataset.field] = el.value;
});

$app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const required = actionForSubmit(form);
  if (!guardWrite(required)) return;
  if (form.id === 'f-add-draft') {
    const input = document.getElementById('f-name');
    const name = input.value.trim();
    if (!name) {
      flashMsg(t('toast.nameFirst'));
      render();
      return;
    }
    if (draft.names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      flashMsg(t('toast.alreadyAdded'));
      render();
      return;
    }
    draft.names.push(name);
    clearDraft('add-draft');
    render();
    document.getElementById('f-name')?.focus();
  } else if (form.id === 'f-import-csv') {
    const res = importNames(document.getElementById('f-csv').value, draft.names);
    draft.names.push(...res.names);
    const notes = [];
    if (res.names.length) notes.push(t('toast.csvImported', { count: res.names.length }));
    if (res.duplicates.length) notes.push(t('toast.csvDuplicates', { count: res.duplicates.length }));
    if (res.truncated.length) notes.push(t('toast.csvTruncated', { count: res.truncated.length, max: NAME_MAX }));
    // Keep the paste visible when nothing landed, so the admin can see what was rejected.
    if (notes.length && res.names.length) clearDraft('import-csv');
    csvBoxOpen = !res.names.length;
    flashMsg(notes.length ? notes.join(' ') : t('toast.csvEmpty'), res.names.length ? 'ok' : 'error');
    render();
  } else if (form.id === 'f-add-live') {
    const res = addPlayer(current, document.getElementById('f-live-name').value);
    if (!res.ok) flashMsg(engineError(res));
    else {
      flashMsg(t('toast.playerJoined', { name: res.player.name }), 'ok');
      clearDraft('add-live');
    }
    saveCurrent();
    render();
  } else if (form.id === 'f-score') {
    const roundId = form.dataset.round;
    const res = submitScore(
      current,
      roundId,
      document.getElementById('score-a').value,
      document.getElementById('score-b').value
    );
    if (!res.ok) {
      flashMsg(engineError(res));
    } else {
      clearDraft(`score:${roundId}`);
      flashMsg(
        t('toast.roundScored', { number: res.round.number, a: res.round.score.a, b: res.round.score.b }),
        'ok'
      );
    }
    saveCurrent();
    render();
  } else if (form.id === 'f-meta') {
    const session = findSession(form.dataset.sid);
    if (!session) return;
    const dateRes = setSessionDate(session, document.getElementById('meta-date').value);
    if (!dateRes.ok) {
      flashMsg(engineError(dateRes));
      render();
      return;
    }
    renameSession(session, document.getElementById('meta-name').value);
    persist(session);
    editingMeta = false;
    clearDraft(`meta:${session.id}`);
    flashMsg(t('toast.metaSaved'), 'ok');
    render();
  } else if (form.classList.contains('teams-edit')) {
    const session = findSession(form.dataset.sid);
    const val = (field) => form.querySelector(`[data-field="${field}"]`).value;
    const res = updateRoundTeams(
      session,
      form.dataset.round,
      [val('a0'), val('a1')],
      [val('b0'), val('b1')]
    );
    if (!res.ok) {
      flashMsg(engineError(res));
      render();
      return;
    }
    persist(session);
    editingTeamsRoundId = null;
    clearDraft(`teams:${form.dataset.round}`);
    flashMsg(t('toast.lineupPinned'), 'ok');
    render();
  } else if (form.classList.contains('player-edit')) {
    const session = findSession(form.dataset.sid);
    const res = renamePlayer(session, form.dataset.id, form.querySelector('[data-field="name"]').value);
    if (!res.ok) {
      flashMsg(engineError(res));
      render();
      return;
    }
    persist(session);
    editingPlayerId = null;
    clearDraft(`player:${form.dataset.id}`);
    flashMsg(t('toast.playerRenamed'), 'ok');
    render();
  }
});

$app.addEventListener('change', (e) => {
  if (e.target.id === 'f-date') draft.date = e.target.value;
  else if (e.target.id === 'f-duration') draft.duration = e.target.value;
  else if (e.target.id === 'f-game') draft.gameMinutes = e.target.value;
  else if (e.target.id === 'f-session-name') draft.name = e.target.value;
  else if (e.target.id === 'f-session-filter') {
    lbFilter = e.target.value;
    closeEditors();
  } else return;
  render();
});

$toast.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="close-toast"]')) clearToast();
});

document.getElementById('clear-all').addEventListener('click', () => {
  if (!guardWrite(ACTIONS.DATA_WIPE)) return;
  if (!confirm(t('confirm.clearAll'))) return;
  removeKey(LS_CURRENT);
  removeKey(LS_HISTORY);
  current = null;
  history = [];
  // The prefill chips are derived from saved sessions, so they go too.
  draft.names = [];
  draft.fromRecent = false;
  draftSeeded = false;
  lbFilter = 'all';
  view = 'setup';
  render();
});

// Hook for automated smoke tests; no UI impact.
window.$papadel = {
  get state() {
    return { current, history, view, role };
  },
  get startup() {
    return { dropped: saved.dropped };
  },
  get role() {
    return role;
  },
  setRole(next) {
    setRole(next);
    closeEditors();
    applyChrome();
    render();
    return role;
  },
  draft,
};

applyChrome();
render();
if (saved.dropped) flashMsg(t('toast.dataRepaired', { count: saved.dropped }));
