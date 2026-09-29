import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csvRecords, detectDelimiter, parseCsv } from '../src/domain/csv.ts';
import { checkUser, parseRoles } from '../src/server/users.ts';
import type { Actor } from '../src/server/rbac.ts';

/* ------------------------------ разбор CSV ------------------------------ */

test('CSV из Excel: BOM, «;», кавычки и перевод строки внутри поля', () => {
  const text = '﻿ФИО;Почта;Должность\r\n"Иванов; И.И.";ivanov@qtr.kz;"Инженер ""1 категории"""\r\n\r\nПетров П.П.;petrov@qtr.kz;"Главный\nинженер"\r\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 3, 'пустые строки пропускаются');
  assert.deepEqual(rows[1], ['Иванов; И.И.', 'ivanov@qtr.kz', 'Инженер "1 категории"']);
  assert.equal(rows[2][2], 'Главный\nинженер');
});

test('разделитель определяется по заголовку', () => {
  assert.equal(detectDelimiter('email,фио,роли\na,b,c'), ',');
  assert.equal(detectDelimiter('email;фио;роли'), ';');
});

test('колонки сопоставляются по синонимам без учёта регистра', () => {
  const { records, missing } = csvRecords('Электронная почта;Ф.И.О.;Роль\nA@qtr.kz;Иванов И.И.;ОР ПСД', {
    email: ['email', 'электронная почта'], fullName: ['фио', 'ф.и.о.'], roles: ['роли', 'роль'], branch: ['филиал'],
  });
  assert.deepEqual(missing, ['branch']);
  assert.equal(records[0].email, 'A@qtr.kz');
  assert.equal(records[0].line, 2, 'номер строки файла — для сообщения об ошибке');
});

/* ------------------------- учётные записи и роли ------------------------- */

const admin: Actor = {
  id: 'a1', userId: 'u', email: 'admin@qtr.kz', fullName: 'Админ', roles: ['admin'],
  branchId: null, counterpartyId: null, isActive: true,
};

test('роли в кадровой выгрузке пишут словами — они распознаются', () => {
  assert.deepEqual(parseRoles('ОР ПСД, филиал / ДИТ'), ['orpsd', 'branch', 'admin']);
  assert.deepEqual(parseRoles('Расчёты с контрагентами'), ['accounting']);
  assert.deepEqual(parseRoles('кладовщик'), ['кладовщик'], 'неизвестная роль остаётся как есть и отклоняется проверкой');
});

test('проверка учётной записи едина для формы и импорта', () => {
  const ok = checkUser({ email: ' Ivanov@QTR.kz ', fullName: 'Иванов И.И.', roles: ['orpsd'] }, admin);
  assert.deepEqual(ok.fields, {});
  assert.equal(ok.user.email, 'ivanov@qtr.kz');

  const bad = checkUser({ email: 'нет', fullName: 'И', roles: ['кладовщик'] }, admin);
  assert.ok(bad.fields.email && bad.fields.fullName);
  assert.match(bad.fields.roles, /Неизвестные роли: кладовщик/);

  assert.ok(checkUser({ email: 'b@qtr.kz', fullName: 'Филиал', roles: ['branch'] }, admin).fields.branchId);
  assert.ok(checkUser({ email: 'c@x.kz', fullName: 'Заказчик', roles: ['customer'] }, admin).fields.counterpartyId);
  assert.ok(checkUser({ email: 'admin@qtr.kz', fullName: 'Админ', roles: ['orpsd'] }, admin).fields.roles,
    'администратор не снимает с себя права');
  assert.ok(checkUser({ email: 'admin@qtr.kz', fullName: 'Админ', roles: ['admin'], isActive: false }, admin).fields.isActive,
    'и не отключает себя');
});
