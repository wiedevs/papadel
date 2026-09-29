import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, DEFAULT_LANG } from '../src/i18n.mjs';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n.mjs'), 'utf8');

function keyList(dict) {
  const block = SRC.match(new RegExp(`const ${dict} = \\{([\\s\\S]*?)\\n\\};`))?.[1];
  assert.ok(block, `kamus ${dict} tidak ditemukan`);
  return [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
}

const ID = keyList('id');
const EN = keyList('en');

test('Kedua kamus punya kunci yang sama, di urutan yang sama', () => {
  assert.deepEqual(EN, ID, 'kunci id dan en harus baris per baris seimbang');
});

test('tidak ada kunci ganda di kamus mana pun', () => {
  for (const [name, keys] of [['id', ID], ['en', EN]]) {
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, [], `${name} punya kunci ganda: ${[...new Set(dupes)]}`);
  }
});

test('setiap kunci yang dipakai app.mjs benar-benar ada', () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app.mjs'), 'utf8');
  const used = [...app.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter(
    (k) => !ID.includes(k) && !(EN.includes(k)) && !SRC.includes(`'${k}'`)
  );
  assert.deepEqual(missing, [], `kunci tanpa terjemahan: ${missing.join(', ')}`);
});

test('bahasa default memberi teks, bukan kunci mentah', () => {
  const block = SRC.match(/const id = \{([\s\S]*?)\n\};/)[1];
  const values = new Map(
    [...block.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)].map((m) => [m[1], m[2]])
  );
  assert.ok(values.size >= ID.length - 1, 'parser kamus kehilangan terlalu banyak entri');
  for (const [key, value] of values) {
    // Placeholder tiap teks berbeda, jadi param dibuat dari teks itu sendiri.
    const params = Object.fromEntries(
      [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => [m[1], 'X'])
    );
    const out = t(key, params);
    assert.notEqual(out, key, `${key} jatuh ke kunci mentah`);
    assert.doesNotMatch(out, /\{[a-zA-Z]+\}/, `${key} menyisakan placeholder tak terpakai`);
  }
  assert.equal(DEFAULT_LANG, 'id');
});
