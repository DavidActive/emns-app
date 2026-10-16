// Pure helpers for roster import: CSV parsing, header mapping, phone normalization.
// Plain ESM JavaScript so it can be unit-tested with node:test and imported by the React app.

/** Parse CSV text (RFC 4180 style: quoted fields, escaped quotes, CRLF or LF) into an array of string arrays. */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEADER_ALIASES = {
  employee_id: ['employee_id', 'employee id', 'emp id', 'empid', 'employee number', 'employee no', 'edipi', 'badge', 'badge id', 'staff id'],
  full_name: ['full_name', 'full name', 'name', 'employee name', 'person'],
  first_name: ['first_name', 'first name', 'first', 'given name'],
  last_name: ['last_name', 'last name', 'last', 'surname', 'family name'],
  mobile_phone: ['mobile_phone', 'mobile phone', 'mobile', 'cell', 'cell phone', 'phone', 'phone number', 'mobile number', 'cell number'],
  email: ['email', 'e-mail', 'email address', 'work email'],
  groups: ['groups', 'group', 'teams', 'team', 'departments', 'department', 'unit', 'building'],
};

function norm(h) {
  return String(h ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Map a CSV header row to canonical fields. Returns { columns: {field: index}, unmapped: [header...] }. */
export function mapHeaders(headerRow) {
  const columns = {};
  const unmapped = [];
  headerRow.forEach((h, idx) => {
    const key = norm(h);
    let hit = null;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => norm(a) === key)) { hit = field; break; }
    }
    if (hit && columns[hit] === undefined) columns[hit] = idx; else if (String(h).trim() !== '') unmapped.push(String(h));
  });
  return { columns, unmapped };
}

/** Normalize a phone number to E.164. US/Canada 10 or 11-digit numbers get +1. Returns null if it cannot be made valid. */
export function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/(ext\.?|x)\s*\d+$/i, '').trim();
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  let out;
  if (hasPlus) out = '+' + digits;
  else if (digits.length === 10) out = '+1' + digits;
  else if (digits.length === 11 && digits.startsWith('1')) out = '+' + digits;
  else return null;
  return /^\+[1-9][0-9]{7,14}$/.test(out) ? out : null;
}

/**
 * Turn CSV text into import rows for the database function.
 * Returns { rows, errors, unmapped, missingRequired }. Rows with a phone that cannot be normalized
 * keep the raw value so the server reports them as invalid in the preview.
 */
export function buildImportRows(csvText) {
  const table = parseCsv(csvText);
  if (table.length === 0) return { rows: [], errors: ['The file is empty.'], unmapped: [], missingRequired: [] };
  const { columns, unmapped } = mapHeaders(table[0]);
  const missingRequired = [];
  const hasName = columns.full_name !== undefined || (columns.first_name !== undefined && columns.last_name !== undefined);
  if (!hasName) missingRequired.push('name (full_name, or first_name and last_name)');
  if (columns.mobile_phone === undefined) missingRequired.push('mobile_phone');
  if (missingRequired.length) return { rows: [], errors: [], unmapped, missingRequired };

  const get = (r, f) => (columns[f] === undefined ? '' : String(r[columns[f]] ?? '').trim());
  const rows = table.slice(1).map((r) => {
    const full = get(r, 'full_name') || [get(r, 'first_name'), get(r, 'last_name')].filter(Boolean).join(' ');
    const rawPhone = get(r, 'mobile_phone');
    return {
      employee_id: get(r, 'employee_id'),
      full_name: full,
      mobile_phone: normalizePhone(rawPhone) ?? rawPhone,
      email: get(r, 'email'),
      groups: get(r, 'groups').split(/[;|]/).map((g) => g.trim()).filter(Boolean).join(';'),
    };
  });
  return { rows, errors: [], unmapped, missingRequired: [] };
}

export const CSV_TEMPLATE =
  'employee_id,full_name,mobile_phone,email,groups\n' +
  'E1001,Jane Example,+15555550101,jane.example@example.com,Building A;Night Shift\n' +
  'E1002,John Sample,(555) 555-0102,,Building B\n';
