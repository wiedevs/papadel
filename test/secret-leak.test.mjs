import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, exts) {
  return readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => join(dir, f));
}

const SERVED = [
  ...listFiles(ROOT, ['.html', '.md', '.sql']),
  ...listFiles(join(ROOT, 'src'), ['.mjs']),
  ...listFiles(join(ROOT, 'supabase', 'migrations'), ['.sql']),
];

// Anything that looks like a real signing token, regardless of how it got there.
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/;
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{8,}/;

test('served source contains no signing token or secret key', () => {
  for (const file of SERVED) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, JWT_LIKE, `${file} memuat token JWT`);
    assert.doesNotMatch(text, SECRET_KEY, `${file} memuat sb_secret_`);
  }
});

// The word "service_role" is allowed in prose that warns about it; a value
// assigned to it is not.
test('no credential assignment in served source', () => {
  const assign = /(service_role|secret_key|admin_password|access_token)\s*[:=]\s*['"`][^'"`]{6,}/i;
  for (const file of SERVED) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), assign, `${file} memberi nilai pada kredensial`);
  }
});

test('cloud config exposes only the publishable client key', () => {
  const src = readFileSync(join(ROOT, 'src', 'cloud-config.mjs'), 'utf8');
  const key = src.match(/SUPABASE_ANON_KEY = "([^"]*)"/)?.[1] ?? '';
  assert.match(key, /^sb_publishable_/, 'kunci klien harus tipe publishable');
  assert.match(src.match(/SUPABASE_URL = "([^"]*)"/)?.[1] ?? '', /^https:\/\/[a-z0-9]+\.supabase\.co$/);
});

test('env files that hold real credentials stay ignored', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const entry of ['.env', '.env.*', '!.env.example']) {
    assert.ok(gitignore.includes(entry), `.gitignore kehilangan ${entry}`);
  }
});
