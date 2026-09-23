import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { toIsoDate, toIsoTimestamp } from '../src/domain/dates.ts';
import { FileStore, actFingerprint, checkFile } from '../src/storage/files.ts';

/* ------------------------------- даты ------------------------------- */

test('дата из PostgreSQL не сдвигается на сутки в поясе UTC+6', () => {
  // Драйвер pg отдаёт DATE как локальную полночь. Приведение через toISOString()
  // в Алматы дало бы предыдущий день и сместило бы все сроки Регламента.
  const localMidnight = new Date(2026, 8, 23, 0, 0, 0); // 23 сентября 2026, местное время
  assert.equal(toIsoDate(localMidnight), '2026-09-23');
  assert.notEqual(toIsoDate(localMidnight), localMidnight.toISOString().slice(0, 10) === '2026-09-23'
    ? 'невозможно' : localMidnight.toISOString().slice(0, 10));
});

test('дата в конце месяца не уезжает в предыдущий месяц', () => {
  assert.equal(toIsoDate(new Date(2027, 0, 1, 0, 0, 0)), '2027-01-01');
  assert.equal(toIsoDate(new Date(2026, 11, 31, 0, 0, 0)), '2026-12-31');
});

test('строковая дата и пустые значения обрабатываются', () => {
  assert.equal(toIsoDate('2026-09-23'), '2026-09-23');
  assert.equal(toIsoDate('2026-09-23T10:00:00Z'), '2026-09-23');
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(undefined), null);
  assert.equal(toIsoDate(''), null);
});

test('метка времени сохраняет момент, а не только дату', () => {
  const at = new Date('2026-09-23T05:30:00.000Z');
  assert.equal(toIsoTimestamp(at), '2026-09-23T05:30:00.000Z');
  assert.equal(toIsoTimestamp(null), null);
});

/* ------------------------------ файлы ------------------------------ */

const pdf = Buffer.from('%PDF-1.4\nсодержимое\n%%EOF');

test('принимаются только разрешённые типы файлов', () => {
  assert.deepEqual(checkFile('akt.pdf', pdf), { ext: 'pdf', mime: 'application/pdf' });
  assert.throws(() => checkFile('script.exe', Buffer.from([0x4d, 0x5a])), /Допустимы файлы/);
  assert.throws(() => checkFile('archive.tar.gz', Buffer.from('x')), /Допустимы файлы/);
});

test('подделка расширения выявляется по сигнатуре', () => {
  assert.throws(() => checkFile('akt.pdf', Buffer.from('это не PDF')), /не соответствует расширению/);
  assert.throws(() => checkFile('photo.png', pdf), /не соответствует расширению/);
});

test('пустой и слишком большой файл отклоняются', () => {
  assert.throws(() => checkFile('akt.pdf', Buffer.alloc(0)), /пуст/);
  const huge = Buffer.concat([pdf, Buffer.alloc(21 * 1024 * 1024)]);
  assert.throws(() => checkFile('akt.pdf', huge), /Максимальный размер/);
});

test('файл сохраняется и читается без искажения, хэш совпадает', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qtr-store-'));
  try {
    const store = new FileStore(root);
    const saved = await store.put('doc-1', 'акт приёма.pdf', pdf);

    assert.equal(saved.size, pdf.length);
    assert.equal(saved.sha256, createHash('sha256').update(pdf).digest('hex'));
    assert.equal(saved.mime, 'application/pdf');
    assert.match(saved.key, /^documents\/doc-1\/[0-9a-f-]+\.pdf$/);

    const { stream } = await store.read(saved.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), pdf);
    assert.equal(await store.verify(saved.key, saved.sha256), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('выход за пределы каталога хранилища блокируется', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qtr-store-'));
  try {
    const store = new FileStore(root);
    await assert.rejects(() => store.read('../../etc/passwd'), /Некорректный ключ|выходит за пределы/);
    await assert.rejects(() => store.read('documents/../../secret'), /Некорректный ключ|выходит за пределы/);
    await assert.rejects(() => store.read('C:\\Windows\\win.ini'), /Некорректный ключ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('удаление несуществующего файла не приводит к ошибке', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qtr-store-'));
  try {
    const store = new FileStore(root);
    // Ключи всегда генерируются из UUID, поэтому проверяем корректный по форме ключ.
    await store.remove('documents/doc-1/00000000-0000-0000-0000-000000000000.pdf');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ключ с посторонними символами отклоняется', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qtr-store-'));
  try {
    const store = new FileStore(root);
    // Ключ формируется системой; всё, что не похоже на сгенерированный путь, — подмена.
    await assert.rejects(() => store.read('documents/нет/файла.pdf'), /Некорректный ключ/);
    await assert.rejects(() => store.read('documents/a b/c.pdf'), /Некорректный ключ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('отпечаток акта не зависит от регистра и пробелов (архив №11)', () => {
  const a = actFingerprint({
    kind: 'Акт приема-передачи', number: 'АПП-026', facilityId: 'f1',
    ownerId: 'c1', contractor: 'АО «Казтелерадио»', docDate: '2026-09-20',
  });
  const b = actFingerprint({
    kind: 'акт приема-передачи', number: ' АПП-026 ', facilityId: 'f1',
    ownerId: 'c1', contractor: 'АО «КАЗТЕЛЕРАДИО»', docDate: '2026-09-20',
  });
  assert.equal(a, b);

  const other = actFingerprint({
    kind: 'Акт приема-передачи', number: 'АПП-027', facilityId: 'f1',
    ownerId: 'c1', contractor: 'АО «Казтелерадио»', docDate: '2026-09-20',
  });
  assert.notEqual(a, other);
});
