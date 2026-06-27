'use strict';
/**
 * Zero-dependency RFC-4180 CSV parser.
 *
 * The dataset's `physical_description` field contains commas inside quoted
 * strings ("Man in saffron kurta, has rudraksha mala"), which breaks any
 * naive split(','). This handles quoted fields, escaped quotes ("") and
 * CRLF / LF line endings.
 *
 * Pure JS so the same loader runs in Node and in the browser (PouchDB).
 */

/** Parse a CSV string into an array of row objects keyed by the header row. */
function parseCSV(text) {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Skip fully blank trailing lines.
    if (row.length === 1 && row[0] === '') continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = row[c] !== undefined ? row[c] : '';
    }
    out.push(obj);
  }
  return out;
}

/** Parse into a 2-D array of raw string cells. */
function parseRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); field = ''; row = []; i++; continue; }
    field += ch; i++;
  }
  // Flush the final field/row (file may not end with newline).
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = { parseCSV, parseRows };
