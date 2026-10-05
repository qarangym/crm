/**
 * Демонстрационный сценарий: заявки ОР ПСД и заявки на допуск в разных состояниях,
 * чтобы показать систему подразделениям на живых примерах.
 *
 * Все действия выполняются через API приложения — тем же путём, что и кнопки
 * интерфейса: номера, сроки, исполнители, письма и журнал получаются настоящими.
 * Организации и люди вымышлены; почтовые адреса — на несуществующих доменах.
 *
 * Запуск на ПУСТОЙ базе после миграций и справочников:
 *   npm run migrate && npm run seed:demo && npm run seed:scenario
 * Переменные: DATABASE_URL, STORAGE_ROOT (как у сервера — файлы должны лечь туда же),
 * DEMO_PASSWORD — общий пароль демонстрационных учётных записей (по умолчанию demo-stand-2026).
 * Стенд затем запускается с DEMO_MODE=true: код входа показывается на экране.
 *
 * На рабочем контуре не запускать.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, databaseUrl, type Db } from './client.ts';
import { FileStore } from '../storage/files.ts';
import { createApp } from '../server/app.ts';
import { identityId, type AuthConfig } from '../server/auth.ts';
import { hashPassword, passwordProblem } from '../server/passwords.ts';
import { runAvrSilence } from '../process/scheduler.ts';
import { validIin } from '../permits/domain/request.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PASSWORD = process.env.DEMO_PASSWORD || 'demo-stand-2026';
const STORAGE = process.env.STORAGE_ROOT ?? resolve(here, '..', '..', 'storage');
const SECRET = randomBytes(32).toString('hex');
const ISSUER = 'https://scenario.demo';

/* ------------------------------- даты (Алматы) ------------------------------- */

const almatyNow = () => new Date(Date.now() + 5 * 3_600_000);
const day = (offset: number) => new Date(almatyNow().getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, time: string) => `${day(offset)}T${time}`;
/** n-й рабочий день от сегодня (суббота и воскресенье пропускаются): обычные работы в выходные запрещены (п. 14). */
function workday(n: number): string {
  const d = almatyNow();
  for (let left = n; left > 0;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
const atw = (n: number, time: string) => `${workday(n)}T${time}`;

/* ------------------------------ учётные записи ------------------------------ */

type Person = {
  key: string; email: string; fullName: string; position: string; department: string; phone: string;
  roles: string[]; branch?: string; org?: string; isHead?: boolean; title: string;
};

const STAFF = 'demo.qtr.kz';
const PEOPLE: Person[] = [
  { key: 'admin', email: `dit@${STAFF}`, fullName: 'Сейткали Данияр Маратович', position: 'Главный администратор', department: 'ДИТ', phone: '+77012000101', roles: ['admin'], title: 'ДИТ · администратор' },
  { key: 'records', email: `kanc@${STAFF}`, fullName: 'Ахметова Гульнара Сериковна', position: 'Специалист канцелярии', department: 'Канцелярия', phone: '+77012000102', roles: ['records'], title: 'Канцелярия' },
  { key: 'orpsdHead', email: `orpsd.head@${STAFF}`, fullName: 'Жунусов Ерлан Болатович', position: 'Начальник отдела', department: 'ОР ПСД', phone: '+77012000103', roles: ['orpsd'], isHead: true, title: 'ОР ПСД · начальник' },
  { key: 'orpsd', email: `orpsd@${STAFF}`, fullName: 'Ким Анна Владимировна', position: 'Главный специалист', department: 'ОР ПСД', phone: '+77012000104', roles: ['orpsd'], title: 'ОР ПСД · специалист' },
  { key: 'orpsd2', email: `orpsd2@${STAFF}`, fullName: 'Байжанов Нурлан Ерикович', position: 'Ведущий инженер-сметчик', department: 'ОР ПСД', phone: '+77012000105', roles: ['orpsd'], title: 'ОР ПСД · сметчик' },
  { key: 'assets', email: `tehuchet@${STAFF}`, fullName: 'Омарова Динара Каиржановна', position: 'Специалист технического учёта', department: 'Технический учёт активов', phone: '+77012000106', roles: ['assets'], title: 'Технический учёт' },
  { key: 'suaHead', email: `sua.head@${STAFF}`, fullName: 'Тлеубердиев Арман Нурланович', position: 'Начальник службы', department: 'СУА', phone: '+77012000107', roles: ['permits'], isHead: true, title: 'СУА · начальник' },
  { key: 'sua', email: `sua@${STAFF}`, fullName: 'Сарсенова Айгерим Талгатовна', position: 'Главный специалист', department: 'СУА', phone: '+77012000108', roles: ['permits'], title: 'СУА · допуски' },
  { key: 'accounting', email: `buh@${STAFF}`, fullName: 'Петренко Ольга Николаевна', position: 'Бухгалтер по расчётам с контрагентами', department: 'Бухгалтерия', phone: '+77012000109', roles: ['accounting'], title: 'Расчёты с контрагентами' },
  { key: 'oko', email: `oko@${STAFF}`, fullName: 'Искакова Мадина Ерлановна', position: 'Специалист ОКО', department: 'ОКО', phone: '+77012000110', roles: ['oko'], title: 'ОКО' },
  { key: 'management', email: `board@${STAFF}`, fullName: 'Нургалиев Бауыржан Сапарович', position: 'Член Правления', department: 'Правление', phone: '+77012000111', roles: ['management'], title: 'Руководство' },
  { key: 'auditor', email: `sb@${STAFF}`, fullName: 'Сулейменов Тимур Аскарович', position: 'Специалист СБ', department: 'Служба безопасности', phone: '+77012000112', roles: ['auditor'], title: 'СБ · аудитор (журнал)' },
  // Карагандинский филиал: руководство и ответственное лицо по допускам (п. 20 Инструкции).
  { key: 'karDirector', email: `kar.director@${STAFF}`, fullName: 'Абенов Серик Жумабекович', position: 'Директор филиала', department: 'Карагандинский филиал', phone: '+77012000201', roles: ['branch'], branch: 'KAR', isHead: true, title: 'Филиал Караганда · директор' },
  { key: 'karCurator', email: `kar.deputy@${STAFF}`, fullName: 'Ли Виктор Сергеевич', position: 'Заместитель директора', department: 'Карагандинский филиал', phone: '+77012000202', roles: ['branch'], branch: 'KAR', title: 'Филиал Караганда · заместитель' },
  { key: 'karEngineer', email: `kar.engineer@${STAFF}`, fullName: 'Касымов Ержан Муратович', position: 'Главный инженер', department: 'Карагандинский филиал', phone: '+77012000203', roles: ['branch'], branch: 'KAR', title: 'Филиал Караганда · главный инженер' },
  { key: 'karSite', email: `kar.trv@${STAFF}`, fullName: 'Мухамедьяров Азамат Русланович', position: 'Инженер по эксплуатации сети ТРВ', department: 'Карагандинский филиал', phone: '+77012000204', roles: ['branch'], branch: 'KAR', title: 'Филиал Караганда · на объекте' },
  { key: 'pavDirector', email: `pav.director@${STAFF}`, fullName: 'Шевченко Андрей Петрович', position: 'Директор филиала', department: 'Павлодарский филиал', phone: '+77012000301', roles: ['branch'], branch: 'PAV', isHead: true, title: 'Филиал Павлодар · директор' },
  { key: 'pavSite', email: `pav.trv@${STAFF}`, fullName: 'Жакупов Ренат Ерланович', position: 'Инженер по эксплуатации сети ТРВ', department: 'Павлодарский филиал', phone: '+77012000302', roles: ['branch'], branch: 'PAV', title: 'Филиал Павлодар · на объекте' },
  // Внешние: кабинеты Заказчика и подрядчика не пересекаются — у одной организации разные учётные записи.
  { key: 'customer', email: 'd.ospanov@spektr.demo', fullName: 'Оспанов Дархан Маратович', position: 'Руководитель развития сети', department: '', phone: '+77012000401', roles: ['customer'], org: '501400004114', title: 'Заказчик · ТОО «Спектр Телеком»' },
  { key: 'customer2', email: 's.alibekova@alatau.demo', fullName: 'Алибекова Сауле Каримовна', position: 'Технический директор', department: '', phone: '+77012000402', roles: ['customer'], org: '501400006399', title: 'Заказчик · ТОО «Алатау Медиа»' },
  { key: 'contractor', email: 'service@spektr.demo', fullName: 'Серикбаев Нурлан Абаевич', position: 'Начальник технической службы', department: '', phone: '+77012000403', roles: ['contractor'], org: '501400004114', title: 'Допуски · ТОО «Спектр Телеком»' },
  { key: 'contractor2', email: 'work@kaspiy.demo', fullName: 'Гусейнов Руслан Алиевич', position: 'Прораб', department: '', phone: '+77012000404', roles: ['contractor'], org: '501400007436', title: 'Допуски · ТОО «Каспий Сигнал» (подрядчик арендатора)' },
];

/* ------------------------------ вызовы API ------------------------------ */

let base = '';
const email = (key: string) => PEOPLE.find((p) => p.key === key)!.email;
const headers = (key: string): Record<string, string> => ({
  'x-qtr-proxy-key': SECRET, 'x-qtr-user-id': 'scenario-' + email(key), 'x-qtr-user-email': email(key), 'x-qtr-user-name': email(key),
});

async function call(key: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...headers(key) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`${method} ${path} от ${email(key)}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function upload(key: string, path: string, fields: Record<string, string>, file?: { name: string; text: string }): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('file', new Blob([pdf(file.text)]), file.name);
  const res = await fetch(base + path, { method: 'POST', headers: headers(key), body: form });
  const data = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`POST ${path} от ${email(key)}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** Минимальный корректный PDF: на стенде файл открывается как документ с одной строкой. */
function pdf(text: string): Buffer {
  const content = `BT /F1 14 Tf 60 760 Td (${text.replace(/[()\\]/g, '').replace(/[^\x20-\x7e]/g, '?')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makeIin(birth: string, seed: number): string {
  // ИИН: ГГММДД + век и пол + 4 цифры + контрольный разряд (тот же алгоритм, что у БИН).
  for (let s = seed; ; s++) {
    const head = birth.slice(2, 4) + birth.slice(5, 7) + birth.slice(8, 10) + '3' + String(1000 + (s % 9000)).slice(-4);
    for (let d = 0; d < 10; d++) if (validIin(head + d)) return head + d;
  }
}

/* --------------------------------- сценарий --------------------------------- */

const ids: Record<string, string> = {};
const log = (text: string) => console.log('  · ' + text);

async function createPeople(db: Db) {
  const orgs = new Map((await db.query<{ id: string; bin: string }>(`SELECT id, bin FROM counterparties`)).map((r) => [r.bin, r.id]));
  const branches = new Map((await db.query<{ id: string; code: string }>(`SELECT id, code FROM branches`)).map((r) => [r.code, r.id]));
  for (const p of PEOPLE) {
    const problem = passwordProblem(PASSWORD, p.email);
    if (problem) throw new Error(`DEMO_PASSWORD не подходит для ${p.email}: ${problem}`);
    const org = p.org ? orgs.get(p.org) : null;
    if (p.org && !org) throw new Error(`Нет организации с БИН ${p.org}: выполните npm run seed:demo`);
    const row = await db.one<{ id: string }>(
      `INSERT INTO users (email, full_name, position, department, phone, branch_id, counterparty_id, is_head,
                          password_hash, password_changed_at, email_verified_at, personal_data_consent_at, oidc_subject)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now(), CASE WHEN $10 THEN now() END, $11) RETURNING id`,
      [p.email, p.fullName, p.position, p.department, p.phone, p.branch ? branches.get(p.branch) : null, org ?? null,
       !!p.isHead, await hashPassword(PASSWORD), !!p.org, identityId(ISSUER, 'scenario-' + p.email)]);
    for (const role of p.roles) await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,$2)`, [row!.id, role]);
    ids[p.key] = row!.id;
  }
  // Руководство и ответственные лица филиалов: адресаты эскалаций (п. 100) и согласований допусков (пп. 8, 14, 20).
  await db.query(
    `UPDATE branches SET director_id = $1, curator_id = $2, chief_engineer_id = $3, site_officer_id = $4, board_curator_id = $5
      WHERE code = 'KAR'`, [ids.karDirector, ids.karCurator, ids.karEngineer, ids.karSite, ids.management]);
  await db.query(`UPDATE branches SET director_id = $1, site_officer_id = $2, board_curator_id = $3 WHERE code = 'PAV'`,
    [ids.pavDirector, ids.pavSite, ids.management]);
  await db.query(
    `INSERT INTO settings (key, value, description) VALUES ('demo.accounts', $1::jsonb, 'Учётные записи демонстрационного стенда (seed-scenario)')
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(PEOPLE.map((p) => ({ email: p.email, title: p.title })))]);
  log(`учётных записей: ${PEOPLE.length}; руководство Карагандинского и Павлодарского филиалов назначено`);
}

/* ------------------------------- заявки ОР ПСД ------------------------------- */

type Ctx = { facility: Record<string, string>; org: Record<string, string>; tariff: Record<string, string>; version: string };

function application(ctx: Ctx, opts: { customer: 'customer' | 'customer2'; facility: string; services: ('ТУ' | 'ПСД' | 'СМР')[]; scope?: string }) {
  const applicant = opts.customer === 'customer'
    ? { company: 'ТОО «Спектр Телеком»', bin: '501400004114', contact: 'Оспанов Дархан Маратович', email: 'd.ospanov@spektr.demo', phone: '+7 701 200-04-01' }
    : { company: 'ТОО «Алатау Медиа»', bin: '501400006399', contact: 'Алибекова Сауле Каримовна', email: 's.alibekova@alatau.demo', phone: '+7 701 200-04-02' };
  const params = {
    scope: opts.scope ?? 'Размещение трёх антенных модулей LTE на существующих конструкциях',
    equipment: 'Антенна панельная 1,4 м и радиомодуль RRU', quantity: 3, power: 2.4, weight: 48, windage: 1.2, height: 35,
  };
  return {
    facilityId: ctx.facility[opts.facility],
    applicant,
    services: opts.services.map((service) => service === 'ТУ'
      ? { service, placement: 'ams', tariffId: ctx.tariff['ТУ'], tariffQuantity: 1, params }
      : service === 'ПСД'
        ? { service, placement: 'ams', tariffId: ctx.tariff['ПСД'], tariffQuantity: 1, params: { ...params, designTask: 'Разработать РП по разделам РТ, АС и ЭС' } }
        : { service, placement: 'ams', params: { ...params, scope: 'Монтаж оборудования по разработанному рабочему проекту' } }),
  };
}

const go = (key: string, id: string, to: string, extra: Record<string, unknown> = {}) =>
  call(key, 'POST', `/api/v1/requests/${id}/transition`, { to, ...extra });

async function submitRequest(ctx: Ctx, opts: Parameters<typeof application>[1]): Promise<{ id: string; number: string }> {
  const res = await call(opts.customer, 'POST', '/api/v1/requests', application(ctx, opts));
  return { id: res.request.uuid, number: res.request.number };
}

/** Канцелярия подтверждает регистрацию; ОР ПСД оценивает ТВ по версии мастер-файла и готовит КП. */
async function toOffer(ctx: Ctx, id: string) {
  await go('records', id, 'tv_review');
  await call('orpsd', 'POST', `/api/v1/requests/${id}/tv`, {
    status: 'confirmed', masterFileVersion: ctx.version, verificationCalc: 'not_required',
    note: 'Свободная несущая способность яруса 35 м достаточна',
  });
  await go('orpsd', id, 'offer');
}

const signContract = async (id: string, service: string, number: string, daysAgo = 4) =>
  (await call('orpsd', 'POST', `/api/v1/requests/${id}/contracts`, {
    service, number, amount: service === 'ТУ' ? 420000 : service === 'ПСД' ? 980000 : 3_650_000, signedAt: day(-daysAgo), invoiceAt: day(-daysAgo),
  })).contract;
const pay = (contractId: string, offset = 0) => call('accounting', 'POST', `/api/v1/contracts/${contractId}/payment`, { paidAt: day(offset) });

async function uploadAct(ctx: Ctx, key: string, requestId: string, kind: string, number: string, extra: Record<string, string> = {}) {
  const doc = await upload(key, '/api/v1/documents', {
    kind, number, facilityId: ctx.facility['1187'], ownerId: ctx.org['501400004114'], contractor: extra.contractor ?? 'АО «Казтелерадио»',
    docDate: day(0), requestId, ...extra,
  }, { name: `${number}.pdf`, text: `${kind} ${number}` });
  return doc.document;
}

/** ТУ + ПСД + СМР до этапа СМР в филиале: оба цикла договоров, проверка сметы, акт приёма-передачи. */
async function throughToSmr(ctx: Ctx, r: { id: string; number: string }, n: number) {
  await toOffer(ctx, r.id);
  const tu = await signContract(r.id, 'ТУ', `ДП-${n}1/26`, 30);
  const psd = await signContract(r.id, 'ПСД', `ДП-${n}2/26`, 30);
  await go('accounting', r.id, 'awaiting_payment');
  await pay(tu.id, -25);
  await pay(psd.id, -25);
  await go('orpsd', r.id, 'tu');
  await go('orpsd', r.id, 'psd');
  // Смета — двухуровневая проверка разными специалистами (пп. 40–41).
  await call('orpsd', 'POST', `/api/v1/requests/${r.id}/checkpoints`, { code: 'psd_estimate_check1', note: 'Объёмы сверены с РП' });
  await call('orpsd2', 'POST', `/api/v1/requests/${r.id}/checkpoints`, { code: 'psd_estimate_check2', note: 'Расценки проверены' });
  await call('orpsd', 'POST', `/api/v1/requests/${r.id}/flags`, { estimateApproved: true });
  await go('orpsd', r.id, 'offer');
  const smr = await signContract(r.id, 'СМР', `ДП-${n}3/26`, 10);
  await go('orpsd', r.id, 'awaiting_payment');
  await pay(smr.id, -7);
  await go('orpsd', r.id, 'smr_prep');
  const act = await uploadAct(ctx, 'karEngineer', r.id, 'Акт приема-передачи', `АПП-${n}`, { contractor: 'ТОО «Спектр Телеком»' });
  await call('orpsd', 'POST', `/api/v1/documents/${act.id}/approve`);
  await call('orpsd', 'POST', `/api/v1/requests/${r.id}/flags`, { orderNumber: `Р-${n}` });
  await go('karEngineer', r.id, 'smr');
}

async function orpsdScenario(db: Db, ctx: Ctx) {
  // 1. Исполненная заявка: полный путь Регламента до закрытия по приёмке.
  const done = await submitRequest(ctx, { customer: 'customer', facility: '1187', services: ['ТУ', 'ПСД', 'СМР'] });
  await throughToSmr(ctx, done, 41);
  const tavr = await uploadAct(ctx, 'karEngineer', done.id, 'Технический АВР', 'ТАВР-41', { contractor: 'Карагандинский филиал' });
  await call('orpsd', 'POST', `/api/v1/documents/${tavr.id}/approve`);
  await go('karEngineer', done.id, 'avr');
  const avr = await uploadAct(ctx, 'orpsd', done.id, 'АВР', 'АВР-41', { formCode: '2В' });
  await call('orpsd', 'POST', `/api/v1/documents/${avr.id}/approve`);
  await call('accounting', 'POST', `/api/v1/requests/${done.id}/flags`, { avrSentAt: day(-20) });
  await go('accounting', done.id, 'closing');
  await runAvrSilence(db);
  log(`${done.number}: ТУ + ПСД + СМР — исполнена, АВР принят по молчанию (п. 94)`);

  // 2. СМР в работе у филиала.
  const smr = await submitRequest(ctx, { customer: 'customer', facility: '1187', services: ['ТУ', 'ПСД', 'СМР'],
    scope: 'Размещение радиорелейной антенны 0,6 м на ярусе 48 м' });
  await throughToSmr(ctx, smr, 42);
  log(`${smr.number}: СМР — в работе у Карагандинского филиала`);

  // 3. ТУ выдаются: оплачено, идёт срок этапа. По этой заявке выпущены ТУ — основание допуска на монтаж.
  const tu = await submitRequest(ctx, { customer: 'customer', facility: '1233', services: ['ТУ'],
    scope: 'Размещение шкафа оборудования в аппаратной и прокладка кабеля' });
  await toOffer(ctx, tu.id);
  const tuContract = await signContract(tu.id, 'ТУ', 'ДП-431/26');
  await go('accounting', tu.id, 'awaiting_payment');
  await pay(tuContract.id);
  await go('orpsd', tu.id, 'tu');
  const issued = await upload('orpsd', '/api/v1/documents', {
    kind: 'ТУ', number: 'ТУ-2026-431', facilityId: ctx.facility['1233'], ownerId: ctx.org['501400004114'],
    contractor: 'АО «Казтелерадио»', docDate: day(-1), requestId: tu.id,
  }, { name: 'TU-2026-431.pdf', text: 'TU-2026-431' });
  await call('orpsd2', 'POST', `/api/v1/documents/${issued.document.id}/approve`).catch(() => {});
  log(`${tu.number}: ТУ — оплачено, этап выдачи ТУ; ТУ-2026-431 в архиве`);

  // 4. Ожидание оплаты: договоры подписаны, счёт выставлен.
  const payment = await submitRequest(ctx, { customer: 'customer', facility: '1710', services: ['ТУ', 'ПСД'] });
  await toOffer(ctx, payment.id);
  await signContract(payment.id, 'ТУ', 'ДП-441/26', 3);
  await signContract(payment.id, 'ПСД', 'ДП-442/26', 3);
  await go('accounting', payment.id, 'awaiting_payment');
  log(`${payment.number}: ТУ + ПСД — договоры подписаны, ждём оплату (оферта 10 р.д.)`);

  // 5. Оценка ТВ: служебная записка в филиал ждёт ответа (п. 10, 3 р.д.).
  const tv = await submitRequest(ctx, { customer: 'customer', facility: '1187', services: ['ТУ'],
    scope: 'Подключение электроснабжения 5 кВт для нового шкафа' });
  await go('records', tv.id, 'tv_review');
  await call('orpsd', 'POST', `/api/v1/requests/${tv.id}/memos`, {
    subject: 'Свободная мощность ввода', body: 'Подтвердите свободную мощность ввода 0,4 кВ и наличие места в щите для автомата 25 А',
  });
  log(`${tv.number}: оценка ТВ — служебная записка главному инженеру филиала`);

  // 6. Требуются уточнения: замечания Заказчику (ТЗ №11).
  const remarks = await submitRequest(ctx, { customer: 'customer2', facility: '1233', services: ['ТУ', 'ПСД'],
    scope: 'Размещение двух FM-антенн' });
  await go('records', remarks.id, 'tv_review');
  await call('orpsd', 'POST', `/api/v1/requests/${remarks.id}/remarks`, { remarks: [
    { field: 'Масса оборудования', text: 'Приложите паспорт антенны с массой и парусностью' },
    { field: 'Высота подвеса', text: 'Уточните высоту подвеса: 35 м занят, свободны 44 и 54 м' },
  ] });
  log(`${remarks.number}: возвращена Заказчику с двумя замечаниями`);

  // 7. Только что подана: ждёт подтверждения регистрации канцелярией.
  const fresh = await submitRequest(ctx, { customer: 'customer2', facility: '1187', services: ['ТУ'] });
  log(`${fresh.number}: подана, канцелярия подтверждает регистрацию`);

  // 8. Черновик Заказчика.
  await call('customer', 'POST', '/api/v1/requests', { ...application(ctx, { customer: 'customer', facility: '1560', services: ['ТУ'] }), draft: true });
  log('черновик Заказчика');
}

/* ------------------------------- портал допусков ------------------------------- */

const letter = (n: string) => ({ letterNumber: n, letterDate: day(-1), signatoryName: 'Ахметов Б.К.', signatoryPosition: 'Генеральный директор' });

async function addWorker(key: string, p: { fullName: string; birth: string; seed: number; position: string; cert: string; certUntil: number }, extra: Record<string, unknown> = {}) {
  const iin = extra.citizenship ? undefined : makeIin(p.birth, p.seed);
  const w = await call(key, 'POST', '/api/v1/permits/workers', {
    fullName: p.fullName, iin, birthDate: p.birth, birthPlace: 'г. Караганда', idDocNumber: '0' + String(40000000 + p.seed * 7919).slice(-8),
    idDocIssuedAt: '2021-04-12', idDocIssuedBy: 'МВД РК', address: 'г. Караганда, пр. Бухар-Жырау, ' + (10 + p.seed),
    position: p.position, ...extra,
  });
  await upload(key, `/api/v1/permits/workers/${w.worker.id}/documents`, { title: p.cert, number: 'У-' + (1000 + p.seed), validUntil: day(p.certUntil) },
    { name: 'udostoverenie.pdf', text: p.cert });
  return w.worker;
}

async function draftPermit(key: string, body: Record<string, unknown>) {
  return call(key, 'POST', '/api/v1/permits/requests', body);
}
async function attachLetter(key: string, card: any) {
  return upload(key, `/api/v1/permits/requests/${card.request.id}/letter-file`, {}, { name: 'zapros-prilozhenie-1.pdf', text: 'Zapros i Prilozhenie 1' });
}
const submitPermit = (key: string, card: any) =>
  call(key, 'POST', `/api/v1/permits/requests/${card.request.id}/submit`, { version: card.request.version, consent: true });
const permitCard = (id: string) => call('sua', 'GET', `/api/v1/permits/requests/${id}`);

async function permitScenario(ctx: Ctx) {
  // Реестр договоров аренды ведёт СУА: загрузка таблицы.
  const csv = 'Номер;Дата;БИН;Арендатор;Объекты;Начало;Окончание\n' +
    `А-2024-118;01.03.2024;501400004114;;1187|1233;01.03.2024;31.12.2027\n` +
    `А-2025-042;15.01.2025;501400004114;;1710;15.01.2025;${day(75).split('-').reverse().join('.')}\n` +
    `А-2023-077;10.06.2023;501400006399;;402|1233;10.06.2023;30.06.2027\n`;
  await call('sua', 'POST', '/api/v1/permits/leases/import', { csv, apply: true });
  log('реестр договоров аренды: 3 договора');

  const w1 = await addWorker('contractor', { fullName: 'Ибраев Аскар Нурланович', birth: '1986-03-14', seed: 11, position: 'Инженер-монтажник', cert: 'Допуск к работам на высоте', certUntil: 240 });
  const w2 = await addWorker('contractor', { fullName: 'Ткаченко Игорь Васильевич', birth: '1979-11-02', seed: 23, position: 'Монтажник связи', cert: 'Допуск к работам на высоте', certUntil: 180 });
  const w3 = await addWorker('contractor', { fullName: 'Нурпеисов Ержан Кайратович', birth: '1991-07-21', seed: 37, position: 'Электромонтёр', cert: 'Электробезопасность, IV группа', certUntil: 12 });
  const w4 = await addWorker('contractor', { fullName: 'Смирнов Алексей Игоревич', birth: '1988-05-09', seed: 41, position: 'Инженер по наладке', cert: 'Допуск к работам на высоте', certUntil: 300 },
    { citizenship: 'RU', fullNameLatin: 'Smirnov Aleksei', idDocNumber: '754812390', idDocIssuedBy: 'МВД России', birthPlace: 'г. Омск', address: 'г. Омск, ул. Ленина, 5' });
  await upload('contractor', `/api/v1/permits/workers/${w4.id}/documents`, { kind: 'passport', validUntil: day(1500) }, { name: 'passport.pdf', text: 'Passport' });
  const car = (await call('contractor', 'POST', '/api/v1/permits/vehicles', { plate: '125 ABK 09', model: 'Toyota Hilux', driverName: 'Ибраев А.Н.' })).vehicle;
  await call('contractor', 'POST', '/api/v1/permits/vehicles', { plate: '318 KTR 09', model: 'ГАЗель NEXT', driverName: 'Ткаченко И.В.' });
  await call('contractor', 'POST', '/api/v1/permits/crews', { name: 'Бригада ТО — Караганда', workerIds: [w1.id, w2.id, w3.id], vehicleIds: [car.id] });
  const k1 = await addWorker('contractor2', { fullName: 'Алиев Тимур Рашидович', birth: '1990-01-30', seed: 53, position: 'Монтажник', cert: 'Допуск к работам на высоте', certUntil: 200 });
  const k2 = await addWorker('contractor2', { fullName: 'Ким Денис Олегович', birth: '1993-09-17', seed: 67, position: 'Электромонтёр', cert: 'Электробезопасность, III группа', certUntil: 150 });
  log('работники по Приложению 1: 6 (один — гражданин России), транспорт, сохранённая бригада');

  const leases = async (key: string, facility: string, ownerBin?: string) =>
    (await call(key, 'GET', `/api/v1/permits/basis-options?facilityId=${ctx.facility[facility]}${ownerBin ? `&ownerBin=${ownerBin}` : ''}`)).lease as any[];
  const lease1187 = (await leases('contractor', '1187')).find((l) => l.number === 'А-2024-118');
  const lease1233 = (await leases('contractor', '1233')).find((l) => l.number === 'А-2024-118');
  const lease1710 = (await leases('contractor', '1710')).find((l) => l.number === 'А-2025-042');

  // 1. Действующий допуск: ТО на АМС — согласован директором филиала, выдан СУА; сегодня на объекте.
  let c = await draftPermit('contractor', {
    ...letter('СТ-15/311'), workType: 'maintenance', onAms: true, facilityId: ctx.facility['1187'], basisType: 'lease', basisRefId: lease1187.id,
    periodStart: at(0, '08:00'), periodEnd: at(5, '18:00'), workHoursFrom: '08:00', workHoursTo: '18:00',
    workerIds: [w1.id, w2.id], vehicleIds: [car.id], description: 'Плановое ТО антенно-фидерного тракта LTE на ярусе 58 м',
  });
  c = await submitPermit('contractor', await attachLetter('contractor', c));
  await call('karDirector', 'POST', `/api/v1/permits/requests/${c.request.id}/branch-decision`, { version: c.request.version, approved: true, note: 'Согласовано, работы — в светлое время' });
  let s = await permitCard(c.request.id);
  const active = await call('sua', 'POST', `/api/v1/permits/requests/${c.request.id}/approve`, { version: s.request.version });
  for (const w of [w1, w2]) {
    await call('karSite', 'POST', `/api/v1/permits/requests/${c.request.id}/admissions`, {
      workDate: day(0), workerId: w.id, briefingDone: true, briefingRecord: '214', clothingOk: true, footwearOk: true, ppeOk: true, documentsOk: true });
  }
  await call('karSite', 'POST', `/api/v1/permits/requests/${c.request.id}/admissions`, { workDate: day(0), vehicleId: car.id });
  log(`${active.request.number}: действующий допуск (код ${active.request.permitCode}), двое допущены сегодня`);

  // 2. Завершённый допуск: работы выполнены, ответственное лицо закрыло допуск. Затем «Продлить» — черновик.
  c = await draftPermit('contractor', {
    ...letter('СТ-15/298'), workType: 'maintenance', facilityId: ctx.facility['1233'], basisType: 'lease', basisRefId: lease1233.id,
    periodStart: at(0, '08:00'), periodEnd: at(1, '18:00'), workerIds: [w1.id, w2.id], description: 'Замена блока питания в аппаратной',
  });
  c = await submitPermit('contractor', await attachLetter('contractor', c));
  s = await permitCard(c.request.id);
  const closed = await call('sua', 'POST', `/api/v1/permits/requests/${c.request.id}/approve`, { version: s.request.version });
  const adm = await call('karSite', 'POST', `/api/v1/permits/requests/${c.request.id}/admissions`, {
    workDate: day(0), workerId: w1.id, briefingDone: true, briefingRecord: '209', clothingOk: true, footwearOk: true, ppeOk: true, documentsOk: true });
  await call('karSite', 'POST', `/api/v1/permits/requests/${c.request.id}/admissions`, {
    workDate: day(0), workerId: w2.id, admitted: false, refusalReason: 'Нет защитной каски', briefingDone: true, briefingRecord: '210',
    clothingOk: true, footwearOk: true, ppeOk: false, documentsOk: true });
  await call('karSite', 'POST', `/api/v1/permits/requests/${c.request.id}/admissions/${adm.admissions.find((a: any) => a.worker_id === w1.id).id}/left`);
  s = await permitCard(c.request.id);
  await call('karSite', 'POST', `/api/v1/permits/requests/${c.request.id}/close`, { version: s.request.version, note: 'Работы выполнены, замечаний нет' });
  await call('contractor', 'POST', `/api/v1/permits/requests/${c.request.id}/extend`);
  log(`${closed.request.number}: допуск закрыт после работ; Ткаченко не допущен без каски; черновик продления`);

  // 3. На рассмотрении СУА: монтаж в аппаратной по ТУ, в бригаде — гражданин России (п. 16).
  const tuOpt = (await call('contractor', 'GET', `/api/v1/permits/basis-options?facilityId=${ctx.facility['1233']}`)).tu as any[];
  const tuDoc = tuOpt.find((t) => t.number === 'ТУ-2026-431');
  c = await draftPermit('contractor', {
    ...letter('СТ-15/320'), workType: 'installation', facilityId: ctx.facility['1233'], basisType: 'tu',
    ...(tuDoc ? { basisRefId: tuDoc.id } : { basisNumber: 'ТУ-2026-431' }),
    periodStart: atw(7, '09:00'), periodEnd: atw(11, '18:00'), workerIds: [w1.id, w4.id], vehicleIds: [car.id],
    description: 'Монтаж шкафа оборудования и прокладка кабеля по ТУ-2026-431',
  });
  c = await submitPermit('contractor', await attachLetter('contractor', c));
  log(`${c.request.number}: монтаж по ТУ — на рассмотрении СУА (срок 14 р.д.)`);

  // 4. Ждёт согласования директора Павлодарского филиала: ТО на АМС (п. 8).
  c = await draftPermit('contractor', {
    ...letter('СТ-15/322'), workType: 'maintenance', onAms: true, facilityId: ctx.facility['1710'], basisType: 'lease', basisRefId: lease1710.id,
    periodStart: atw(4, '09:00'), periodEnd: atw(6, '18:00'), workerIds: [w1.id, w2.id], description: 'Юстировка антенн на ярусе 64 м',
  });
  c = await submitPermit('contractor', await attachLetter('contractor', c));
  log(`${c.request.number}: ТО на АМС Экибастуз — ждёт согласования директора филиала`);

  // 5. Отказ СУА с причиной.
  c = await draftPermit('contractor', {
    ...letter('СТ-15/305'), workType: 'maintenance', facilityId: ctx.facility['1233'], basisType: 'lease', basisRefId: lease1233.id,
    periodStart: atw(2, '09:00'), periodEnd: atw(3, '18:00'), workerIds: [w2.id],
  });
  c = await submitPermit('contractor', await attachLetter('contractor', c));
  s = await permitCard(c.request.id);
  await call('sua', 'POST', `/api/v1/permits/requests/${c.request.id}/reject`, {
    version: s.request.version, reason: 'На объекте в эти дни плановый ППР передатчиков. Подайте заявку на период после ' + day(10).split('-').reverse().join('.'),
  });
  log(`${c.request.number}: отклонена с причиной`);

  // 6. Авария ночью (п. 18): подрядчик арендатора, устное согласование директора — допуск выдан, запрос — досылается.
  c = await draftPermit('contractor2', {
    workType: 'emergency', facilityId: ctx.facility['1233'], ownerBin: '501400006399', basisType: 'lease', basisNumber: 'А-2023-077',
    workHoursFrom: '20:00', workHoursTo: '04:00', weekendWork: true, periodStart: at(0, '20:00'), periodEnd: at(2, '04:00'),
    workerIds: [k1.id, k2.id], description: 'Авария: отказ передатчика FM 104,2 МГц, замена усилителя',
  });
  c = await submitPermit('contractor2', c);
  s = await permitCard(c.request.id);
  const emergency = await call('sua', 'POST', `/api/v1/permits/requests/${c.request.id}/branch-decision`, {
    version: s.request.version, approved: true, channel: 'oral', note: 'Директор филиала Абенов С.Ж., по телефону',
  });
  log(`${emergency.request.number}: аварийный допуск выдан по устному согласованию, ждём оформленный запрос (2 дня)`);

  // 7. Договора аренды нет в реестре: скан и срок договора, СУА подтвердит вручную.
  c = await draftPermit('contractor2', {
    ...letter('КС-08/114'), workType: 'maintenance', facilityId: ctx.facility['1233'], ownerBin: '501400006399', basisType: 'lease',
    basisNumber: 'А-2026-031', basisValidUntil: day(200), periodStart: atw(4, '09:00'), periodEnd: atw(5, '18:00'), workerIds: [k1.id],
    description: 'Профилактика оборудования ТВ-передатчика',
  });
  await upload('contractor2', `/api/v1/permits/requests/${c.request.id}/basis-file`, {}, { name: 'dogovor-arendy.pdf', text: 'Dogovor arendy A-2026-031' });
  c = await submitPermit('contractor2', await attachLetter('contractor2', await call('contractor2', 'GET', `/api/v1/permits/requests/${c.request.id}`)));
  log(`${c.request.number}: договор аренды не в реестре — СУА сверяет скан`);

  // 8. Черновик подрядчика.
  await draftPermit('contractor', { workType: 'replacement', facilityId: ctx.facility['1187'], basisType: 'lease', basisRefId: lease1187.id, workerIds: [w3.id] });
  log('черновик заявки на допуск');
}

/* ------------------------------------ запуск ------------------------------------ */

const db = createDb(databaseUrl());
let server: ReturnType<typeof createServer> | null = null;
try {
  const busy = await db.one<{ requests: number; permits: number }>(
    `SELECT (SELECT count(*) FROM requests)::int AS requests, (SELECT count(*) FROM access_requests)::int AS permits`);
  if (busy!.requests || busy!.permits) {
    throw new Error('В базе уже есть заявки. Сценарий запускается только на пустой базе: создайте новую базу, ' +
      'выполните npm run migrate и npm run seed:demo.');
  }
  const facilities = await db.query<{ id: string; inv_no: string }>(`SELECT id, inv_no FROM facilities`);
  if (facilities.length < 5) throw new Error('Справочники не заполнены: выполните npm run seed:demo');
  const clash = await db.one<{ email: string }>(`SELECT email FROM users WHERE email = ANY($1::text[])`, [PEOPLE.map((p) => p.email)]);
  if (clash) throw new Error(`Учётная запись ${clash.email} уже есть: сценарий запускается на пустой базе`);

  console.log('Демонстрационный сценарий');
  await createPeople(db);

  const auth: AuthConfig = { enabled: true, proxySecret: SECRET, issuer: ISSUER, devIdentity: null };
  const handle = createApp({ db, auth, trustProxy: true, rateLimit: { max: 1_000_000 }, store: new FileStore(STORAGE) });
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const version = day(-3);
  await call('assets', 'POST', '/api/v1/registry/versions', { version, note: 'Сверка мастер-файла после монтажа на РТС-12' });
  const ctx: Ctx = {
    facility: Object.fromEntries(facilities.map((f) => [f.inv_no, f.id])),
    org: Object.fromEntries((await db.query<{ id: string; bin: string }>(`SELECT id, bin FROM counterparties`)).map((r) => [r.bin, r.id])),
    tariff: {
      'ТУ': (await db.one<{ id: string }>(`SELECT id FROM tariffs WHERE service = 'ТУ' AND placement = 'ams' ORDER BY amount DESC LIMIT 1`))!.id,
      'ПСД': (await db.one<{ id: string }>(`SELECT id FROM tariffs WHERE service = 'ПСД' ORDER BY amount DESC LIMIT 1`))!.id,
    },
    version,
  };
  log(`версия мастер-файла ${version} опубликована техучётом`);

  console.log('Заявки ОР ПСД:');
  await orpsdScenario(db, ctx);
  console.log('Портал допусков:');
  await permitScenario(ctx);

  // Вход на стенде — по паролю и коду; привязка к служебному субъекту сценария снимается.
  await db.query(`UPDATE users SET oidc_subject = NULL WHERE email = ANY($1::text[])`, [PEOPLE.map((p) => p.email)]);

  console.log(`\nГотово. Пароль всех учётных записей: ${PASSWORD}`);
  console.log('Запустите стенд с DEMO_MODE=true и DEMO_PASSWORD — страница входа покажет учётные записи и код входа.\n');
  for (const p of PEOPLE) console.log(`  ${p.email.padEnd(28)} ${p.title}`);
} catch (error) {
  console.error('\nОшибка сценария:', (error as Error).message);
  process.exitCode = 1;
} finally {
  if (server) await new Promise<void>((ok) => server!.close(() => ok()));
  await db.close();
}
