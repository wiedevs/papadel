// Pasted-text → player names. Deliberately a *text* parser: the prototype has
// no file upload, users copy rows out of Sheets/Excel and paste them in.

export const NAME_MAX = 24;

const HEADER_NAME = /^(name|nama|player|pemain)$/i;
const CANDIDATE_DELIMITERS = [',', ';', '\t'];

// RFC-4180-ish: quoted fields, "" escapes, newlines inside quotes, LF/CRLF/CR.
export function parseCsvRows(text, delimiter = ',') {
  const rows = [];
  if (typeof text !== 'string' || text === '') return rows;

  let row = [];
  let field = '';
  let quoted = false;
  let pending = false; // current row holds at least one character

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    pending = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      pending = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      pending = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      if (pending) endRow();
      continue;
    }
    field += ch;
    pending = true;
  }

  if (pending) endRow();
  return rows;
}

// Indonesian Excel/Sheets exports default to ';' and copy-paste is often
// tab-separated, so count the candidates outside quotes and take the winner.
export function sniffDelimiter(text) {
  if (typeof text !== 'string') return ',';
  const counts = new Map(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i += 1;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }
  let best = CANDIDATE_DELIMITERS[0];
  let bestCount = counts.get(best);
  for (const d of CANDIDATE_DELIMITERS.slice(1)) {
    if (counts.get(d) > bestCount) {
      best = d;
      bestCount = counts.get(d);
    }
  }
  return best;
}

// Which cells are names depends on the shape of the paste: one headerless line
// is a list of names, anything else is read as a single column.
export function pickNames(rows) {
  const cleaned = (Array.isArray(rows) ? rows : [])
    .map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell ?? '').trim()).filter((cell) => cell !== ''))
    .filter((row) => row.length > 0);
  if (cleaned.length === 0) return [];

  const hasHeader = HEADER_NAME.test(cleaned[0][0]);
  const body = hasHeader ? cleaned.slice(1) : cleaned;
  if (body.length === 0) return [];
  if (!hasHeader && body.length === 1) return [...body[0]];
  return body.map((row) => row[0]);
}

export function importNames(text, existing = []) {
  const taken = new Set(
    (Array.isArray(existing) ? existing : []).map((name) => String(name ?? '').trim().toLowerCase())
  );
  const names = [];
  const duplicates = [];
  const truncated = [];

  for (const raw of pickNames(parseCsvRows(text, sniffDelimiter(text)))) {
    // A pasted cell can carry tabs or line breaks (mixed delimiters, wrapped
    // cells); a player name never legitimately contains either.
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (taken.has(key)) {
      duplicates.push(name);
      continue;
    }
    taken.add(key);
    if (name.length > NAME_MAX) {
      names.push(name.slice(0, NAME_MAX));
      truncated.push(name);
      continue;
    }
    names.push(name);
  }

  return { names, duplicates, truncated };
}
