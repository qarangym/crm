import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addCalendarDays, addWorkingDays, daysLeft, dueDate, isWorkingDay, workingDaysBetween } from '../src/domain/calendar.ts';
import { validBin, validPhone, formatPhone, validText, validateRequest } from '../src/domain/validation.ts';
import { estimate, formatMoney, isFreeOfCharge } from '../src/domain/pricing.ts';
import type { RequestService, Tariff, WorkCalendar } from '../src/domain/types.ts';

const calendar: WorkCalendar = {
  // Праздники РК: 1–2 января, 8 марта, 21–23 марта 2027.
  holidays: ['2027-01-01', '2027-01-02', '2026-03-09', '2026-03-23'],
  workingDays: ['2026-03-14'],
};

test('календарь: выходные и праздники не считаются рабочими днями', () => {
  assert.equal(isWorkingDay('2026-09-19', calendar), false); // суббота
  assert.equal(isWorkingDay('2026-09-21', calendar), true);  // понедельник
  assert.equal(isWorkingDay('2026-03-09', calendar), false); // перенесённый праздник
  assert.equal(isWorkingDay('2026-03-14', calendar), true);  // суббота-перенос
});

test('срок 5 рабочих дней (п. 9) пропускает выходные', () => {
  // Понедельник 21.09.2026 + 5 рабочих дней = понедельник 28.09.2026
  assert.equal(addWorkingDays('2026-09-21', 5, calendar), '2026-09-28');
});

test('срок ПСД 30 рабочих дней (п. 33) не совпадает с 30 календарными', () => {
  const working = addWorkingDays('2026-09-21', 30, calendar);
  const calendarDays = addCalendarDays('2026-09-21', 30);
  assert.notEqual(working, calendarDays);
  assert.equal(working, '2026-11-02');
});

test('90 календарных дней на оборудование (п. 55) считаются календарными', () => {
  assert.equal(dueDate('2026-09-21', 90, 'calendar', calendar), '2026-12-20');
});

test('норматив «в день поступления» (п. 6) не сдвигает дату', () => {
  assert.equal(dueDate('2026-09-21', 0, 'same_day', calendar), '2026-09-21');
});

test('операционный день (п. 91) приравнен к одному рабочему дню', () => {
  assert.equal(dueDate('2026-09-25', 1, 'operational', calendar), '2026-09-28');
});

test('остаток срока отрицателен при просрочке', () => {
  assert.equal(daysLeft('2026-09-28', '2026-09-21', calendar), 5);
  assert.equal(daysLeft('2026-09-21', '2026-09-28', calendar), -5);
  assert.equal(daysLeft('2026-09-21', '2026-09-21', calendar), 0);
});

test('рабочих дней между датами: новогодние праздники исключаются', () => {
  assert.equal(workingDaysBetween('2026-12-31', '2027-01-05', calendar), 2, '1 и 2 января — праздники, 3 января — воскресенье');
});

test('осмысленность текста: прочерки, повторы и заглушки отклоняются (ТЗ №5)', () => {
  assert.equal(validText('Антенна базовой станции'), true);
  assert.equal(validText('---'), false);
  assert.equal(validText('ааааааа'), false);
  assert.equal(validText('тест'), false);
  assert.equal(validText('12345'), false);
  assert.equal(validText('ab'), false);
});

test('БИН проверяется по контрольному разряду, а не только по длине', () => {
  assert.equal(validBin('050140008215'), true);
  assert.equal(validBin('050140008216'), false, 'неверный контрольный разряд');
  assert.equal(validBin('111111111111'), false, 'одинаковые цифры');
  assert.equal(validBin('12345'), false);
});

test('телефон: формат РК, без однообразных последовательностей', () => {
  assert.equal(validPhone('+7 701 000-11-22'), true);
  assert.equal(validPhone('+7 700 000-00-00'), false);
  // «8» в начале — привычная запись; приводится к +7, как в маске ввода.
  assert.equal(validPhone('8 701 000 11 22'), true);
  assert.equal(validPhone('+7 912 345 67 89'), false, 'номер другой страны с кодом +7');
  assert.equal(validPhone('+7 701 000'), false, 'неполный');
});

test('телефон: единый вид «+7 XXX XXX XX XX»', () => {
  for (const input of ['87015551234', '+7 (701) 555-12-34', '7015551234', '+77015551234', '8 701 555 12 34']) {
    assert.equal(formatPhone(input), '+7 701 555 12 34', input);
  }
  assert.equal(formatPhone('12345'), '12345', 'нераспознанный номер не искажается');
});

const validForm = {
  company: 'ТОО «Спектр Телеком»',
  bin: '050140008215',
  contact: 'Оспанов Дархан Маратович',
  email: 'info@spektr.kz',
  phone: '+7 701 000-11-22',
  facilityId: 'f-1',
  services: [
    {
      service: 'ТУ',
      placement: 'ams',
      params: {
        scope: 'Размещение трёх антенных модулей на существующих конструкциях',
        equipment: 'Антенна панельная и радиомодуль',
        quantity: 3,
        power: 2.4,
        weight: 48,
        windage: 1.2,
        height: 35,
      },
    },
  ] as RequestService[],
};

test('корректная заявка проходит проверку', () => {
  assert.deepEqual(validateRequest(validForm), {});
});

test('черновик допускает неполные реквизиты (ТЗ №10)', () => {
  const draft = { company: 'ТОО «Спектр Телеком»', services: validForm.services };
  assert.deepEqual(validateRequest(draft, true), {});
});

test('неполная заявка не проходит: указываются конкретные поля (ТЗ №4)', () => {
  const errors = validateRequest({ ...validForm, facilityId: undefined, email: 'не-почта' });
  assert.ok(errors.facilityId);
  assert.ok(errors.email);
});

test('буквы в числовом поле отклоняются (ТЗ №5)', () => {
  const broken = structuredClone(validForm);
  broken.services[0].params.weight = 'много';
  const errors = validateRequest(broken);
  assert.ok(errors['services.0.weight']);
});

test('СМР без основания не принимается (п. 53)', () => {
  const smr = structuredClone(validForm);
  smr.services[0].service = 'СМР';
  const errors = validateRequest(smr);
  assert.ok(errors['services.0.basisReference']);
});

test('СМР вместе с ПСД в одной заявке не требует отдельного основания (пп. 49, 53)', () => {
  const both = structuredClone(validForm);
  const psd = structuredClone(both.services[0]);
  psd.service = 'ПСД';
  psd.params.designTask = 'Установка антенн на ярусе 45 м, разделы РТ, АС, ЭС';
  const smr = structuredClone(both.services[0]);
  smr.service = 'СМР';
  both.services = [psd, smr];
  const errors = validateRequest(both);
  assert.equal(errors['services.1.basisReference'], undefined);
});

test('присоединение к сети оформляется только как ТУ (п. 20, Приложение 1)', () => {
  const net = structuredClone(validForm);
  net.services[0].placement = 'network';
  net.services[0].service = 'ПСД';
  net.services[0].params = {
    scope: 'Присоединение технических средств телеканала',
    channel: 'Первый канал',
    signalType: 'SDI',
    deliveryPoint: 'РТС Кок-Тобе, аппаратная',
    bitrate: 100,
  };
  const errors = validateRequest(net);
  assert.ok(errors['services.0.placement']);
});

test('одна услуга дважды в заявке не допускается', () => {
  const twice = structuredClone(validForm);
  twice.services.push(structuredClone(validForm.services[0]));
  const errors = validateRequest(twice);
  assert.ok(errors.services);
});

const tariffs: Tariff[] = [
  { id: 't-tu', service: 'ТУ', name: 'Выдача ТУ на размещение', unit: 'услуга', amount: 420_000, source: 'Прейскурант, п. 3.1', effectiveFrom: '2026-01-01' },
  { id: 't-psd', service: 'ПСД', name: 'Разработка РП', unit: 'проект', amount: 980_000, source: 'Прейскурант, п. 4.2', effectiveFrom: '2026-01-01' },
];

test('стоимость заявки — сумма всех позиций (п. 21)', () => {
  const services: RequestService[] = [
    { service: 'ТУ', placement: 'ams', params: {}, tariffId: 't-tu', tariffQuantity: 2 },
    { service: 'ПСД', placement: 'ams', params: {}, tariffId: 't-psd', tariffQuantity: 1 },
  ];
  const result = estimate(services, tariffs, '2026-09-21');
  assert.equal(result.total, 420_000 * 2 + 980_000);
  assert.equal(result.hasUndetermined, false);
  assert.match(result.disclaimer, /коммерческим предложением и офертой/);
});

test('ТУ на присоединение к сети телерадиовещания безвозмездны (п. 20)', () => {
  const item: RequestService = { service: 'ТУ', placement: 'network', params: {} };
  assert.equal(isFreeOfCharge(item), true);
  const result = estimate([item], tariffs, '2026-09-21');
  assert.equal(result.total, 0);
  assert.match(result.lines[0].source, /п\. 20/);
  assert.equal(formatMoney(0), 'Безвозмездно');
});

test('стоимость СМР на этапе заявки не определяется (п. 49)', () => {
  const services: RequestService[] = [
    { service: 'ТУ', placement: 'ams', params: {}, tariffId: 't-tu', tariffQuantity: 1 },
    { service: 'СМР', placement: 'ams', params: {}, basisReference: 'ПСД-2026-11' },
  ];
  const result = estimate(services, tariffs, '2026-09-21');
  assert.equal(result.total, 420_000);
  assert.equal(result.hasUndetermined, true);
  assert.equal(result.lines[1].amount, null);
  assert.match(result.lines[1].source, /п\. 49/);
});

test('позиция прейскуранта вне срока действия отклоняется (п. 18)', () => {
  const expired: Tariff[] = [{ ...tariffs[0], effectiveTo: '2026-06-30' }];
  assert.throws(
    () => estimate([{ service: 'ТУ', placement: 'ams', params: {}, tariffId: 't-tu', tariffQuantity: 1 }], expired, '2026-09-21'),
    /недоступна/,
  );
});
