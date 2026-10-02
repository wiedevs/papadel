// PaPadel authorization — pure role policy: no DOM, no storage, no engine state.
// Action names are `resource.verb` so each rule ports to a Supabase RLS policy
// of the same shape when the prototype is replaced by the real stack.
//
// Three roles, split along one line: writing a session in is everyone's job,
// destroying one is not. Supabase mirrors this exactly — INSERT/UPDATE are
// gated on public.is_admin(), DELETE on public.is_superadmin() (migration 0003).

export const ROLES = ['superadmin', 'admin', 'viewer'];

// Least privilege: a fresh browser reads until it is switched to admin.
export const DEFAULT_ROLE = 'viewer';

export const ACTIONS = {
  DATA_READ: 'data.read',
  SESSION_CREATE: 'session.create',
  SESSION_UPDATE: 'session.update',
  SESSION_DELETE: 'session.delete',
  ROUND_SCORE: 'round.score',
  ROUND_UPDATE: 'round.update',
  ROUND_DELETE: 'round.delete',
  PLAYER_CREATE: 'player.create',
  PLAYER_UPDATE: 'player.update',
  PLAYER_DELETE: 'player.delete',
  DATA_WIPE: 'data.wipe',
  USER_MANAGE: 'user.manage',
};

const ALL = ROLES;
const STAFF = [ROLES[0], ROLES[1]];
const SUPERADMIN = [ROLES[0]];

const POLICY = {
  [ACTIONS.DATA_READ]: ALL,
  [ACTIONS.SESSION_CREATE]: STAFF,
  [ACTIONS.SESSION_UPDATE]: STAFF,
  [ACTIONS.ROUND_SCORE]: STAFF,
  [ACTIONS.ROUND_UPDATE]: STAFF,
  [ACTIONS.PLAYER_CREATE]: STAFF,
  [ACTIONS.PLAYER_UPDATE]: STAFF,
  // Everything below destroys data or people, so it never reaches admin.
  [ACTIONS.SESSION_DELETE]: SUPERADMIN,
  [ACTIONS.ROUND_DELETE]: SUPERADMIN,
  [ACTIONS.PLAYER_DELETE]: SUPERADMIN,
  [ACTIONS.DATA_WIPE]: SUPERADMIN,
  [ACTIONS.USER_MANAGE]: SUPERADMIN,
};

// Unknown role or unknown action denies, so a new action added without a rule
// is unreadable-by-accident rather than writable-by-accident.
export function can(role, action) {
  const allowed = POLICY[action];
  if (!allowed || !ROLES.includes(role)) return false;
  return allowed.includes(role);
}

export function normalizeRole(raw) {
  return ROLES.includes(raw) ? raw : DEFAULT_ROLE;
}

export function isWriteAction(action) {
  return can(ROLES[1], action) && !can(ROLES[2], action);
}

// The actions Postgres refuses for this role but would allow for a superadmin.
// The UI uses this to explain a hidden control rather than silently dropping it.
export function isDestructiveAction(action) {
  return can(ROLES[0], action) && !can(ROLES[1], action);
}

export function writeActions() {
  return Object.values(ACTIONS).filter(isWriteAction);
}

// Each write affordance names the action it needs; an affordance absent from
// these tables touches no saved data, so it stays available to every role.
export const CLICK_ACTION = {
  start: ACTIONS.SESSION_CREATE,
  'remove-draft': ACTIONS.SESSION_CREATE,
  'end-session': ACTIONS.SESSION_UPDATE,
  'edit-meta': ACTIONS.SESSION_UPDATE,
  'save-score': ACTIONS.ROUND_UPDATE,
  'edit-score': ACTIONS.ROUND_UPDATE,
  'edit-teams': ACTIONS.ROUND_UPDATE,
  'rename-player': ACTIONS.PLAYER_UPDATE,
  'remove-player': ACTIONS.PLAYER_UPDATE,
  'remove-session-player': ACTIONS.PLAYER_DELETE,
  'delete-round': ACTIONS.ROUND_DELETE,
  'delete-session': ACTIONS.SESSION_DELETE,
  'discard-live': ACTIONS.SESSION_DELETE,
  'revoke-role': ACTIONS.USER_MANAGE,
};

export const SUBMIT_ACTION = {
  'f-add-draft': ACTIONS.SESSION_CREATE,
  'f-import-csv': ACTIONS.SESSION_CREATE,
  'f-add-live': ACTIONS.PLAYER_CREATE,
  'f-score': ACTIONS.ROUND_SCORE,
  'f-meta': ACTIONS.SESSION_UPDATE,
  'teams-edit': ACTIONS.ROUND_UPDATE,
  'player-edit': ACTIONS.PLAYER_UPDATE,
  'f-role': ACTIONS.USER_MANAGE,
};

export function actionForClick(uiAction) {
  return CLICK_ACTION[uiAction] ?? null;
}

export function actionForSubmit(form) {
  if (form.id && SUBMIT_ACTION[form.id]) return SUBMIT_ACTION[form.id];
  for (const cls of Object.keys(SUBMIT_ACTION)) {
    if (form.classList?.contains(cls)) return SUBMIT_ACTION[cls];
  }
  return null;
}

// --- Prototype passcode gate -------------------------------------------------
// This is a demo affordance, not a credential: the check runs in the visitor's
// own browser, so the code is readable in this file and the role can be set
// directly in localStorage. It exists to make the three roles feel real while
// the domain logic is being validated. Real sign-in belongs to Supabase Auth,
// where the role comes from a server-signed token and `can()` becomes RLS.
export const DEMO_ADMIN_PASSCODE = '2468';

export function verifyPasscode(input, expected = DEMO_ADMIN_PASSCODE) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  const got = input.trim();
  return got.length > 0 && got === expected.trim();
}