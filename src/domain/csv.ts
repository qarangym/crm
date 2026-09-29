/**
 * Разбор CSV для импорта справочников.
 *
 * Выгрузки из кадровой системы и Excel приходят с разделителем «;» или «,»,
 * часто с BOM и переводами строк Windows. Поля в кавычках могут содержать
 * разделитель и перевод строки; удвоенная кавычка — сама кавычка.
 */

/** Разделитель определяется по первой строке: чего в ней больше — «;» или «,». */
export function detectDelimiter(text: string): ';' | ',' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  return count(';') >= count(',') ? ';' : ',';
}

export function parseCsv(input: string, delimiter?: ';' | ','): string[][] {
  const text = input.replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((v) => v.trim()));
}

/**
 * Строки CSV как записи по заголовку. Заголовки сопоставляются без учёта
 * регистра и лишних пробелов через словарь синонимов: `{ email: ['email', 'почта'] }`.
 */
export function csvRecords<K extends string>(
  input: string,
  columns: Record<K, string[]>,
): { records: (Record<K, string> & { line: number })[]; missing: K[] } {
  const rows = parseCsv(input);
  if (!rows.length) return { records: [], missing: Object.keys(columns) as K[] };
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/ё/g, 'е').trim();
  const header = rows[0].map(norm);
  const index = {} as Record<K, number>;
  const missing: K[] = [];
  for (const key of Object.keys(columns) as K[]) {
    const at = header.findIndex((h) => columns[key].some((alias) => norm(alias) === h));
    if (at < 0) missing.push(key);
    index[key] = at;
  }
  const records = rows.slice(1).map((r, i) => {
    const rec = { line: i + 2 } as Record<K, string> & { line: number };
    for (const key of Object.keys(columns) as K[]) {
      (rec as Record<string, unknown>)[key] = index[key] >= 0 ? (r[index[key]] ?? '') : '';
    }
    return rec;
  });
  return { records, missing };
}
