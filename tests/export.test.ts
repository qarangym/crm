import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';

import { csvCell, toCsv, toXlsx } from '../src/server/export.ts';

/** Разбор ZIP по центральному каталогу — проверка, что архив читается как настоящий. */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'есть запись конца каталога');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(local + 26);
    const data = inflateRawSync(buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size));
    assert.equal(crc32(data) >>> 0, crc, `контрольная сумма ${name}`);
    out.set(name, data.toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
}

test('XLSX — корректный ZIP с нужными частями и данными', () => {
  const buf = toXlsx([{
    name: 'Заявки [2026]', header: ['Номер', 'Сумма', 'Примечание'],
    rows: [['ЗК-2026-0001', 1400000, 'A & B <тест>'], ['ЗК-2026-0002', null, '']],
  }]);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const files = unzip(buf);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files.has(part), part);
  }
  const sheet = files.get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /<c r="B2"><v>1400000<\/v><\/c>/, 'число — числом, чтобы работали формулы');
  assert.match(sheet, /A &amp; B &lt;тест&gt;/, 'спецсимволы экранированы');
  assert.match(files.get('xl/workbook.xml')!, /name="Заявки  2026 "/, 'недопустимые в имени листа символы заменены');
});

test('CSV — BOM, «;», экранирование кавычек и формул', () => {
  const text = toCsv({ name: 'x', header: ['а', 'б'], rows: [['=СУММ(1)', 'он сказал "да"'], [5, null]] }).toString('utf8');
  assert.ok(text.startsWith('﻿"а";"б"'));
  assert.ok(text.includes(`"'=СУММ(1)";"он сказал ""да"""`));
  assert.equal(csvCell(-5), '"-5"', 'отрицательное число не считается формулой');
});
