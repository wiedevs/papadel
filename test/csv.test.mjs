import test from 'node:test';
import assert from 'node:assert/strict';
import { importNames, parseCsvRows, pickNames, sniffDelimiter, NAME_MAX } from '../src/csv.mjs';

test('parses plain comma rows', () => {
  assert.deepEqual(parseCsvRows('Ayu,Budi\nCitra,Devi'), [['Ayu', 'Budi'], ['Citra', 'Devi']]);
});

test('handles CRLF and lone CR', () => {
  assert.deepEqual(parseCsvRows('a,b\r\nc\rd'), [['a', 'b'], ['c'], ['d']]);
});

test('no phantom trailing row for a trailing newline', () => {
  assert.deepEqual(parseCsvRows('a,b\n'), [['a', 'b']]);
  assert.deepEqual(parseCsvRows('a\n\n\nb'), [['a'], ['b']]);
});

test('quoted fields keep delimiters and newlines', () => {
  assert.deepEqual(parseCsvRows('"Ayu, the first",Budi'), [['Ayu, the first', 'Budi']]);
  assert.deepEqual(parseCsvRows('"a\nb",c'), [['a\nb', 'c']]);
});

test('double quotes unescape inside a quoted field', () => {
  assert.deepEqual(parseCsvRows('"say ""hi""",x'), [['say "hi"', 'x']]);
});

test('unterminated quote still yields the parsed rows', () => {
  assert.deepEqual(parseCsvRows('a,"b'), [['a', 'b']]);
});

test('empty or non-string input parses to nothing', () => {
  assert.deepEqual(parseCsvRows(''), []);
  assert.deepEqual(parseCsvRows(null), []);
  assert.deepEqual(pickNames(undefined), []);
});

test('sniffs semicolon and tab delimiters', () => {
  assert.equal(sniffDelimiter('Ayu;Budi;Citra'), ';');
  assert.equal(sniffDelimiter('Ayu\tBudi'), '\t');
  assert.equal(sniffDelimiter('Ayu,Budi'), ',');
  assert.equal(sniffDelimiter('Ayu'), ',');
  assert.equal(sniffDelimiter('"a,b,c";x;y'), ';');
  assert.deepEqual(parseCsvRows('Ayu;Budi', ';'), [['Ayu', 'Budi']]);
});

test('single line: every cell becomes a name', () => {
  assert.deepEqual(pickNames([['Ayu', 'Budi', 'Citra']]), ['Ayu', 'Budi', 'Citra']);
});

test('multiple rows: first column only, extra columns ignored', () => {
  assert.deepEqual(pickNames([['Ayu', 'a@x'], ['Budi', 'b@x']]), ['Ayu', 'Budi']);
});

test('header row is dropped', () => {
  assert.deepEqual(pickNames([['name', 'email'], ['Ayu', 'a@x']]), ['Ayu']);
  assert.deepEqual(pickNames([['name', 'email'], ['Ayu', 'a@x'], ['Budi', 'b@x']]), ['Ayu', 'Budi']);
  assert.deepEqual(pickNames([['Nama'], ['Pemain']]), ['Pemain']);
  assert.deepEqual(pickNames([['name']]), []);
});

test('header forces the column rule even for one data row', () => {
  assert.deepEqual(pickNames([['player', 'rating'], ['Ayu', '4']]), ['Ayu']);
});

test('blank rows and cells are skipped', () => {
  assert.deepEqual(pickNames([[], ['  Ayu ', '', 'Budi'], []]), ['Ayu', 'Budi']);
});

test('importNames trims, dedupes within the batch and against existing players', () => {
  const r = importNames('Ayu\nayu \nBudi\nAYU', ['Ayu']);
  assert.deepEqual(r.names, ['Budi']);
  assert.deepEqual(r.duplicates, ['Ayu', 'ayu', 'AYU']);
  assert.deepEqual(r.truncated, []);
});

test('importNames collapses stray whitespace inside a name', () => {
  assert.deepEqual(importNames('"a\nb"', []).names, ['a b']);
  // a tab-separated row pasted into a semicolon block: the block shape wins,
  // so the tab survives inside one cell and is collapsed to a space.
  assert.deepEqual(importNames('nama;hp\nSari\t0813', []).names, ['Sari 0813']);
  assert.deepEqual(importNames('Sari\t0813\nAyu\nBudi', []).names, ['Sari', 'Ayu', 'Budi']);
});

test('importNames keeps a batch self-consistent', () => {
  const r = importNames('Ayu, Budi, Citra', ['budi']);
  assert.deepEqual(r.names, ['Ayu', 'Citra']);
  assert.deepEqual(r.duplicates, ['Budi']);
});

test('importNames truncates to the UI limit and reports it', () => {
  const long = 'Budiartopratamaswijakusumah';
  assert.ok(long.length > NAME_MAX);
  const r = importNames(long, []);
  assert.deepEqual(r.names, [long.slice(0, NAME_MAX)]);
  assert.equal(r.names[0].length, NAME_MAX);
  assert.deepEqual(r.truncated, [long]);
});

test('importNames on junk input returns an empty result', () => {
  assert.deepEqual(importNames('   \n\n , , ', []), { names: [], duplicates: [], truncated: [] });
  assert.deepEqual(importNames(null, []), { names: [], duplicates: [], truncated: [] });
});

test('importNames handles a realistic sheet paste', () => {
  const text = 'nama;hp\r\nAyu;0812\r\n"Bagas, Jr.";\r\n\r\nCitra;0813\r\nayu;0814';
  const r = importNames(text, ['Ayu']);
  assert.deepEqual(r.names, ['Bagas, Jr.', 'Citra']);
  assert.deepEqual(r.duplicates, ['Ayu', 'ayu']);
  assert.deepEqual(r.truncated, []);
});
