export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_COLUMNS = 100;

export function safeCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value ?? '');
  return /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${safeCell(value).replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows) {
  const headers = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  }
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(',')),
  ].join('\r\n');
}

export function parseDelimited(text, delimiter, { maxRows = MAX_IMPORT_ROWS } = {}) {
  if (delimiter !== ',' && delimiter !== '\t') throw new Error('Unsupported delimiter.');
  const matrix = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  const finishRow = () => {
    row.push(cell);
    matrix.push(row);
    if (matrix.length > maxRows + 1) {
      throw new Error(`Imports are limited to ${maxRows} data rows.`);
    }
    row = [];
    cell = '';
    closedQuote = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        cell += ch;
      }
      continue;
    }

    if (closedQuote && ch !== delimiter && ch !== '\n' && ch !== '\r') {
      throw new Error('Unexpected text after a closing quote. Check the CSV formatting.');
    }
    if (ch === '"') {
      if (cell !== '') throw new Error('A quote inside an unquoted cell must be doubled.');
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      finishRow();
    } else {
      cell += ch;
    }
  }

  if (quoted) throw new Error('The file ends inside a quoted cell. Check the CSV formatting.');
  if (cell !== '' || row.length || closedQuote) finishRow();
  return matrix;
}
