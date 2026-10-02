import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ROLES,
  DEFAULT_ROLE,
  ACTIONS,
  CLICK_ACTION,
  SUBMIT_ACTION,
  can,
  normalizeRole,
  isWriteAction,
  isDestructiveAction,
  writeActions,
  actionForClick,
  actionForSubmit,
  verifyPasscode,
  DEMO_ADMIN_PASSCODE,
} from '../src/authz.mjs';

const ALL_ACTIONS = Object.values(ACTIONS);
const appSource = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');

test('a superadmin is allowed every action', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('superadmin', action), true, `superadmin denied ${action}`);
  }
});

// The split the three roles exist for: an admin runs the session, but deleting
// one — and managing who may delete — stays above that line.
test('an admin writes but never destroys or manages users', () => {
  const destructive = [
    ACTIONS.SESSION_DELETE,
    ACTIONS.ROUND_DELETE,
    ACTIONS.PLAYER_DELETE,
    ACTIONS.DATA_WIPE,
    ACTIONS.USER_MANAGE,
  ];
  for (const action of destructive) {
    assert.equal(can('admin', action), false, `admin was allowed ${action}`);
    assert.equal(isDestructiveAction(action), true, `${action} is not classified destructive`);
  }
  const writable = [
    ACTIONS.SESSION_CREATE,
    ACTIONS.SESSION_UPDATE,
    ACTIONS.ROUND_SCORE,
    ACTIONS.ROUND_UPDATE,
    ACTIONS.PLAYER_CREATE,
    ACTIONS.PLAYER_UPDATE,
  ];
  for (const action of writable) {
    assert.equal(can('admin', action), true, `admin denied ${action}`);
    assert.equal(isDestructiveAction(action), false, `${action} is wrongly destructive`);
  }
});

test('a viewer may only read', () => {
  assert.equal(can('viewer', ACTIONS.DATA_READ), true);
  for (const action of ALL_ACTIONS.filter((a) => a !== ACTIONS.DATA_READ)) {
    assert.equal(can('viewer', action), false, `viewer was allowed ${action}`);
  }
});

// The point of the feature: a viewer cannot write, so a single allowed write
// action would mean the role model leaked.
test('no write action is reachable by a viewer', () => {
  const writes = writeActions();
  assert.ok(writes.length >= 6, `expected the write inventory, got ${writes.length}`);
  for (const action of writes) {
    assert.equal(can('viewer', action), false);
    assert.equal(isWriteAction(action), true);
  }
});

test('an action with no rule denies instead of defaulting open', () => {
  assert.equal(can('superadmin', 'session.drop'), false);
  assert.equal(can('admin', 'session.drop'), false);
  assert.equal(can('viewer', 'session.drop'), false);
  assert.equal(writeActions().includes('session.drop'), false);
});

test('an unrecognised role never gains access', () => {
  for (const role of [null, undefined, '', 'ADMIN', 'root', 0, 1, ['admin'], { role: 'admin' }]) {
    for (const action of ALL_ACTIONS) {
      assert.equal(can(role, action), false, `${String(role)} was allowed ${action}`);
    }
  }
});

test('the default role is the least privileged one', () => {
  assert.equal(DEFAULT_ROLE, 'viewer');
  assert.equal(can(DEFAULT_ROLE, ACTIONS.DATA_READ), true);
  assert.equal(can(DEFAULT_ROLE, ACTIONS.SESSION_CREATE), false);
});

test('normalizeRole accepts only known roles and falls back to the default', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('viewer'), 'viewer');
  for (const junk of [null, undefined, '', 'Admin', 'ADMIN', 'editor', 42, {}]) {
    assert.equal(normalizeRole(junk), DEFAULT_ROLE, `${String(junk)} normalized open`);
  }
});

test('every UI affordance maps to a real action', () => {
  const known = new Set(ALL_ACTIONS);
  for (const [ui, action] of [...Object.entries(CLICK_ACTION), ...Object.entries(SUBMIT_ACTION)]) {
    assert.equal(known.has(action), true, `${ui} maps to unknown action ${action}`);
    // Either an ordinary write (admin reaches it) or a destructive one
    // (superadmin only) — both are writes, so both must be barred from viewer.
    assert.equal(
      isWriteAction(action) || isDestructiveAction(action),
      true,
      `${ui} maps ${action}, which is neither a write nor destructive`
    );
    assert.equal(can('viewer', action), false, `${ui} maps ${action}, which a viewer may do`);
  }
});

// Guards the fail-closed contract: a write button added to the UI without a
// policy entry would otherwise be silently treated as a read.
test('every action rendered in the UI is either a mapped write or a declared read', () => {
  const READ_ONLY_UI = new Set([
    'nav',
    'open-session',
    'cancel-edit',
    'cancel-meta',
    'cancel-player',
    'cancel-teams',
    'cancel-unlock',
    'close-toast',
    'show-unlock',
    'toggle-csv',
    // Signing out changes who the browser may act as; it never touches a row.
    'sign-out',
    // Same for these: they ask Auth for a session or a reset mail. The board
    // stays untouched until Postgres accepts a write under public.is_admin().
    'oauth-google',
    'show-recover',
    'back-to-signin',
    'send-recover',
    // Same again: replacing your own password rewrites no board row, and
    // GoTrue answers only for whoever the bearer token already names.
    'show-change-password',
  ]);
  const rendered = new Set([...appSource.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(rendered.size >= 22, `expected the UI action inventory, got ${rendered.size}`);

  for (const ui of rendered) {
    if (READ_ONLY_UI.has(ui)) {
      assert.equal(CLICK_ACTION[ui], undefined, `${ui} is declared read-only but mapped as a write`);
      continue;
    }
    assert.notEqual(CLICK_ACTION[ui], undefined, `${ui} writes data but has no authorization rule`);
  }

  for (const ui of Object.keys(CLICK_ACTION)) {
    assert.equal(rendered.has(ui), true, `${ui} is mapped but no longer rendered`);
  }
});

test('submit forms wired in the UI all have a rule', () => {
  for (const key of Object.keys(SUBMIT_ACTION)) {
    const present =
      appSource.includes(`id="${key}"`) ||
      appSource.includes(`classList.contains('${key}')`) ||
      appSource.includes(`form.id === '${key}'`);
    assert.equal(present, true, `${key} is mapped but no longer submitted`);
  }
});

test('actionForClick and actionForSubmit resolve writes and pass reads through as null', () => {
  const form = (id, classes = []) => ({ id, classList: { contains: (c) => classes.includes(c) } });

  assert.equal(actionForClick('start'), ACTIONS.SESSION_CREATE);
  assert.equal(actionForClick('delete-round'), ACTIONS.ROUND_DELETE);
  assert.equal(actionForClick('nav'), null);
  assert.equal(actionForClick('session.create'), null, 'an action name is not a UI affordance');

  assert.equal(actionForSubmit(form('f-score')), ACTIONS.ROUND_SCORE);
  assert.equal(actionForSubmit(form('player-edit', ['player-edit'])), ACTIONS.PLAYER_UPDATE);
  assert.equal(actionForSubmit(form('teams-edit', ['teams-edit'])), ACTIONS.ROUND_UPDATE);
  assert.equal(actionForSubmit(form('f-session-filter')), null);
});

// Order matters: superadmin first, because the UI and the tests read ROLES[0]
// as the most privileged role.
test('ROLES lists exactly the three roles the policy distinguishes', () => {
  assert.deepEqual(ROLES, ['superadmin', 'admin', 'viewer']);
});

test('normalizeRole knows the new role', () => {
  assert.equal(normalizeRole('superadmin'), 'superadmin');
});

// --- Prototype passcode gate -------------------------------------------------

test('the passcode gate accepts only the exact code', () => {
  assert.equal(typeof DEMO_ADMIN_PASSCODE, 'string');
  assert.ok(DEMO_ADMIN_PASSCODE.length >= 4, 'a 1-2 char demo code is untestable noise');
  assert.equal(verifyPasscode(DEMO_ADMIN_PASSCODE), true);
  assert.equal(verifyPasscode(`${DEMO_ADMIN_PASSCODE} `), true, 'typed trailing space should still pass');
  assert.equal(verifyPasscode(`  ${DEMO_ADMIN_PASSCODE}`), true);
  for (const wrong of ['0000', '1234', `${DEMO_ADMIN_PASSCODE}x`, `x${DEMO_ADMIN_PASSCODE}`]) {
    assert.equal(verifyPasscode(wrong), false, `${wrong} unlocked admin`);
  }
});

// An empty field must never be treated as a match, and a caller that reads a
// missing input gets undefined rather than a crash or a pass.
test('an empty or non-string passcode never unlocks', () => {
  for (const junk of ['', '   ', null, undefined, 0, 2468, NaN, [], ['2468'], {}, true]) {
    assert.equal(verifyPasscode(junk), false, `${String(junk)} unlocked admin`);
  }
});

test('the gate compares exactly, without case folding or coercion', () => {
  assert.equal(verifyPasscode('Admin', 'admin'), false);
  assert.equal(verifyPasscode('admin', 'admin'), true);
  assert.equal(verifyPasscode(' admin ', 'admin'), true, 'both sides are trimmed');
  assert.equal(verifyPasscode('admin', 'admin x'), false);
});

// Passing the gate changes which role you claim; it is not itself authority.
test('unlocking grants no authority on its own', () => {
  assert.equal(verifyPasscode(DEMO_ADMIN_PASSCODE), true);
  for (const action of writeActions()) {
    assert.equal(can('viewer', action), false, `${action} reachable without taking the role`);
  }
});

// app.mjs keeps its session list in a module-level `history`, which shadows the
// window object of the same name. A bare replaceState() throws at runtime — and
// threw away the redirect that hands back a login token. Only the members the
// History API has and an array does not are checked.
test('the browser history API is never reached through the shadowed global', () => {
  const bare = appSource.match(/(?<!window\.)\bhistory\.(replaceState|pushState|back|forward|go)\b/g);
  assert.equal(bare, null, `gunakan window.history, ketemu: ${bare && bare.join(', ')}`);
});
