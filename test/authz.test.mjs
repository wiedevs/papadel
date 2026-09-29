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
  writeActions,
  actionForClick,
  actionForSubmit,
  verifyPasscode,
  DEMO_ADMIN_PASSCODE,
} from '../src/authz.mjs';

const ALL_ACTIONS = Object.values(ACTIONS);
const appSource = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');

test('admin is allowed every action', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(can('admin', action), true, `admin denied ${action}`);
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
  assert.ok(writes.length >= 9, `expected the write inventory, got ${writes.length}`);
  for (const action of writes) {
    assert.equal(can('viewer', action), false);
    assert.equal(isWriteAction(action), true);
  }
});

test('an action with no rule denies instead of defaulting open', () => {
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
    assert.equal(isWriteAction(action), true, `${ui} maps ${action}, which is not a write`);
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

test('ROLES lists exactly the two roles the policy distinguishes', () => {
  assert.deepEqual(ROLES, ['admin', 'viewer']);
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
