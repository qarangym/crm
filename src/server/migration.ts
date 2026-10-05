/**
 * Перенос действующих заявок ОР ПСД из Excel (CSV) на старте системы.
 *
 * До запуска заявки живут в письмах и таблицах. Чтобы доска в первый день показывала
 * настоящий портфель, ДИТ загружает таблицу: каждая строка — заявка на своём этапе,
 * с договорами и оплатой. Сначала предпросмотр с ошибками по строкам, затем запись
 * только корректных строк одной транзакцией. Повторная загрузка тех же заявок
 * отклоняется по номеру: перенесённое не дублируется.
 *
 * Перенос не подменяет процесс: документы, акты и служебные записки по перенесённой
 * заявке заводятся уже в системе, а переходы проверяются по Регламенту как обычно.
 */

import * as repo from '../db/repo.ts';
import * as contractsRepo from '../db/contracts.ts';
import { ensureExecutors, eligible, setResponsible } from '../db/executors.ts';
import { csvRecords } from '../domain/csv.ts';
import { today } from '../domain/calendar.ts';
import { validBin } from '../domain/validation.ts';
import type { Service } from '../domain/types.ts';
import { openStage } from '../process/engine.ts';
import { stage, currentStages } from '../process/stages.ts';
import type { StageCode } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

export const MAX_ROWS = 1000;

const COLUMNS = {
  number: ['номер', 'вх. номер', 'входящий номер', 'номер заявки', 'исх. номер'],
  date: ['дата', 'дата заявки', 'дата регистрации', 'дата поступления'],
  bin: ['бин', 'бин заказчика'],
  company: ['заказчик', 'организация', 'наименование заказчика'],
  facility: ['объект', 'инв. №', 'инвентарный номер', 'объект (инв. №)'],
  address: ['адрес', 'адрес объекта'],
  services: ['услуги', 'услуга', 'вид услуг'],
  stage: ['этап', 'текущий этап', 'статус'],
  enteredAt: ['дата этапа', 'дата входа в этап', 'с какого числа'],
  contracts: ['договор', 'договоры', 'номер договора'],
  amount: ['сумма', 'стоимость'],
  paidAt: ['дата оплаты', 'оплата', 'оплачено'],
  responsible: ['ответственный', 'исполнитель', 'ответственный (почта)'],
};

/** Названия этапов в таблицах ОР ПСД → код этапа. */
const STAGE_ALIASES: [string, StageCode][] = [
  ['регистрация', 'registered'], ['зарегистрирована', 'registered'], ['оценка тв', 'tv_review'],
  ['оценка технической возможности', 'tv_review'], ['кп', 'offer'], ['кп и договор', 'offer'], ['кп, договор, счет', 'offer'],
  ['договор', 'offer'], ['оплата', 'awaiting_payment'], ['ожидание оплаты', 'awaiting_payment'],
  ['ту', 'tu'], ['выдача ту', 'tu'], ['псд', 'psd'], ['разработка псд', 'psd'],
  ['подготовка смр', 'smr_prep'], ['оборудование', 'smr_prep'], ['смр', 'smr'], ['выполнение смр', 'smr'],
  ['авр', 'avr'], ['авр и эсф', 'avr'], ['приемка', 'closing'], ['приемка заказчиком', 'closing'],
];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function parseDate(value: string): string | null | 'invalid' {
  const text = value.trim();
  if (!text) return null;
  const dmy = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [y, m, d] = dmy ? [dmy[3], dmy[2], dmy[1]] : iso ? [iso[1], iso[2], iso[3]] : [];
  if (!y) return 'invalid';
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(date)) ? 'invalid' : date;
}

const SERVICES: Record<string, Service> = { 'ту': 'ТУ', 'псд': 'ПСД', 'смр': 'СМР' };

type Row = {
  line: number;
  errors: Record<string, string>;
  action: 'create' | 'skip';
  data?: {
    number: string; date: string; bin: string; company: string; facilityId: string | null; branchId: string | null;
    address: string; services: Service[]; stage: StageCode; enteredAt: string;
    contracts: { service: Service; number: string }[]; amount: number | null; paidAt: string | null; responsibleEmail: string;
  };
};

/** Порядок этапов: что уже пройдено, определяет, какие сведения заявки считаются подтверждёнными. */
const reached = (stageCode: StageCode, at: StageCode) => stage(stageCode).order >= stage(at).order;

export function registerMigrationRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  router.post('/api/v1/admin/import-requests', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ csv?: string; apply?: boolean }>();
    const csv = String(body.csv ?? '');
    if (!csv.trim()) throw ApiError.badRequest('Вставьте содержимое CSV-файла');

    const { records, missing } = csvRecords(csv, COLUMNS);
    const required = missing.filter((k) => ['number', 'date', 'bin', 'company', 'services', 'stage'].includes(k));
    if (required.length) {
      throw ApiError.badRequest('В файле нет обязательных колонок',
        Object.fromEntries(required.map((k) => [k, `Колонка «${COLUMNS[k as keyof typeof COLUMNS][0]}» не найдена`])));
    }
    if (records.length > MAX_ROWS) throw ApiError.badRequest(`Слишком много строк: ${records.length}. За один раз — не более ${MAX_ROWS}`);

    const facilities = await repo.listFacilities(db);
    const byInv = new Map(facilities.map((f) => [norm(String(f.inv_no)), f]));
    const byName = new Map(facilities.map((f) => [norm(f.name), f]));
    const knownNumbers = new Set((await db.query<{ n: string }>(
      `SELECT incoming_number AS n FROM requests WHERE incoming_number IS NOT NULL`)).map((r) => norm(r.n)));
    const knownContracts = new Set((await db.query<{ n: string }>('SELECT number AS n FROM contracts')).map((r) => norm(r.n)));
    const seen = new Set<string>();
    const seenContracts = new Set<string>();
    const stageByName = new Map(STAGE_ALIASES);
    for (const s of currentStages()) { stageByName.set(norm(s.name), s.code as StageCode); stageByName.set(norm(s.short), s.code as StageCode); }

    const rows: Row[] = [];
    for (const r of records) {
      const errors: Record<string, string> = {};
      const number = r.number.trim();
      if (!number) errors.number = 'Укажите номер заявки';
      else if (knownNumbers.has(norm(number))) errors.number = 'Заявка с таким номером уже есть в системе';
      else if (seen.has(norm(number))) errors.number = 'Номер повторяется в файле';
      seen.add(norm(number));

      const date = parseDate(r.date);
      if (!date || date === 'invalid') errors.date = 'Дата в формате ДД.ММ.ГГГГ';
      else if (date > today()) errors.date = 'Дата не может быть в будущем';
      const bin = r.bin.replace(/\s/g, '');
      if (!validBin(bin)) errors.bin = 'БИН: 12 цифр, проверьте контрольный разряд';
      if (r.company.trim().length < 3) errors.company = 'Укажите заказчика';

      const services = [...new Set(r.services.split(/[,;\/+]+/).map((s) => SERVICES[norm(s)]).filter(Boolean))] as Service[];
      if (!services.length) errors.services = 'Услуги: ТУ, ПСД, СМР через запятую';

      const stageCode = stageByName.get(norm(r.stage));
      if (!stageCode) errors.stage = `Этап «${r.stage}» не распознан: ${[...new Set(STAGE_ALIASES.map(([, c]) => stage(c).short))].join(', ')}`;
      else if (stage(stageCode).serviceScope && !services.includes(stage(stageCode).serviceScope as Service)) {
        errors.stage = `Этап «${stage(stageCode).name}» относится к услуге ${stage(stageCode).serviceScope}, а её в заявке нет`;
      }

      const entered = r.enteredAt.trim() ? parseDate(r.enteredAt) : date;
      if (!entered || entered === 'invalid') errors.enteredAt = 'Дата этапа в формате ДД.ММ.ГГГГ';
      else if (entered > today()) errors.enteredAt = 'Дата этапа не может быть в будущем';
      else if (date && date !== 'invalid' && entered < date) errors.enteredAt = 'Этап не может начаться раньше заявки';

      const facilityText = r.facility.trim();
      const facility = facilityText ? byInv.get(norm(facilityText)) ?? byName.get(norm(facilityText)) : null;
      if (facilityText && !facility) errors.facility = `Объект «${facilityText}» не найден в справочнике (по инв. № или названию)`;
      const facilityRequired = !!stageCode && stageCode !== 'registered';
      if (!facility && !r.address.trim() && !facilityText) errors.facility = 'Укажите объект (инв. №) или адрес';
      else if (!facility && facilityRequired) errors.facility = 'Для этапа после регистрации объект должен быть в справочнике';

      // Договоры: «ДП-1/26» — единственная услуга, «ТУ:ДП-1 | ПСД:ДП-2» — по услугам (« | », «;» занят разделителем CSV).
      const contracts: { service: Service; number: string }[] = [];
      const hasContractStage = !!stageCode && reached(stageCode, 'awaiting_payment');
      for (const part of r.contracts.split(/[|\n]+/).map((p) => p.trim()).filter(Boolean)) {
        const pair = /^([А-Яа-я]+)\s*[:=]\s*(.+)$/.exec(part);
        const service = pair ? SERVICES[norm(pair[1])] : services.length === 1 ? services[0] : undefined;
        const contractNumber = (pair ? pair[2] : part).trim();
        if (!service || !services.includes(service)) { errors.contracts = `Не понятно, к какой услуге относится договор «${part}» — укажите «ТУ:номер»`; continue; }
        if (knownContracts.has(norm(contractNumber)) || seenContracts.has(norm(contractNumber))) { errors.contracts = `Договор ${contractNumber} уже есть`; continue; }
        seenContracts.add(norm(contractNumber));
        contracts.push({ service, number: contractNumber });
      }
      if (hasContractStage && !errors.contracts) {
        // С этапа оплаты договор по каждой услуге, по которой идёт работа, должен существовать.
        const need = services.filter((s) => s !== 'СМР' || reached(stageCode!, 'smr_prep') || (stageCode === 'awaiting_payment' || stageCode === 'offer'));
        if (contracts.length < need.length && stageCode !== 'offer') errors.contracts = `Укажите договоры по всем услугам заявки (${services.join(', ')})`;
      }
      const amountText = r.amount.replace(/\s/g, '').replace(',', '.');
      const amount = amountText ? Number(amountText) : null;
      if (amountText && (!Number.isFinite(amount) || (amount ?? 0) < 0)) errors.amount = 'Сумма — число';
      const paidAt = r.paidAt.trim() ? parseDate(r.paidAt) : null;
      if (paidAt === 'invalid') errors.paidAt = 'Дата оплаты в формате ДД.ММ.ГГГГ';
      if (stageCode && reached(stageCode, 'tu') && !paidAt && contracts.length) errors.paidAt = 'С этапа выдачи ТУ работа идёт после оплаты — укажите дату оплаты';

      rows.push({
        line: r.line, errors, action: Object.keys(errors).length ? 'skip' : 'create',
        data: Object.keys(errors).length ? undefined : {
          number, date: date as string, bin, company: r.company.trim(), facilityId: facility?.id ?? null,
          branchId: facility?.branch_id ?? null, address: r.address.trim(), services, stage: stageCode!,
          enteredAt: entered as string, contracts, amount, paidAt: paidAt as string | null, responsibleEmail: r.responsible.trim().toLowerCase(),
        },
      });
    }

    const valid = rows.filter((r) => r.action === 'create');
    const summary = { total: rows.length, create: valid.length, skip: rows.length - valid.length };
    const shown = rows.map((r) => ({ line: r.line, action: r.action, errors: r.errors,
      request: r.data ? { number: r.data.number, company: r.data.company, stage: stage(r.data.stage).name, services: r.data.services } : null }));
    if (body.apply !== true) return { preview: true, summary, rows: shown };
    if (!valid.length) throw ApiError.badRequest('Нет строк без ошибок — исправьте файл');

    const cal = await repo.calendar(db);
    const created = await db.tx(async (t) => {
      const out: { number: string; system: string }[] = [];
      for (const row of valid) {
        const d = row.data!;
        const counterparty = await repo.resolveCounterparty(t, { bin: d.bin, company: d.company });
        // Срок этапа — от даты входа в него, указанной в таблице (не от даты оплаты договора).
        const snapshot = { id: 0, services: d.services, contracts: [], freeServices: [] } as never;
        const record = openStage(snapshot, d.stage, d.enteredAt, cal);
        const request = await repo.createRequest(t, {
          counterpartyId: counterparty.id, facilityId: d.facilityId, branchId: d.branchId,
          facilityAddress: d.facilityId ? null : d.address, createdBy: actor.id, stageCode: d.stage, freeOfCharge: false,
          totalAmount: d.amount,
          services: d.services.map((s) => ({ service: s, placement: 'ams', params: { imported: true }, amount: null })),
        }, record);
        // Реквизиты, которых createRequest не знает: регистрация, ТВ и смета — по достигнутому этапу.
        const past = (at: StageCode) => reached(d.stage, at);
        await t.query(
          `UPDATE requests SET incoming_number = $2, incoming_date = $3::date, registered_at = $3::date,
                  customer_status = $4, registration_confirmed_at = CASE WHEN $5 THEN $3::date END,
                  registration_confirmed_by = CASE WHEN $5 THEN $6::uuid END,
                  tv_status = CASE WHEN $7 THEN 'confirmed' ELSE tv_status END,
                  master_file_version = CASE WHEN $7 THEN 'перенос' ELSE master_file_version END,
                  estimate_approved = CASE WHEN $8 THEN true ELSE estimate_approved END
            WHERE id = $1`,
          [request.uuid, d.number, d.date, stage(d.stage).customerStatus, d.stage !== 'registered', actor.id,
           past('offer'), d.services.includes('СМР') && past('awaiting_payment')]);
        for (const c of d.contracts) {
          const contract = await contractsRepo.createContract(t, {
            number: c.number, requestId: request.uuid, counterpartyId: counterparty.id, service: c.service,
            subject: `Перенесено из таблицы ОР ПСД: ${c.service}`, amount: d.contracts.length === 1 ? d.amount : null,
            signedAt: d.date, invoiceAt: d.date, createdBy: actor.id,
          });
          if (d.paidAt) await contractsRepo.recordPayment(t, contract.id, d.paidAt);
        }
        // Исполнители: указанный ответственный ОР ПСД, иначе — подбор по нагрузке.
        await ensureExecutors(t, request.uuid);
        if (d.responsibleEmail) {
          const person = await t.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [d.responsibleEmail]);
          if (person && await eligible(t, person.id, 'orpsd', null)) await setResponsible(t, request.uuid, person.id);
        }
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Заявка перенесена из таблицы', entity: 'request', entityId: request.uuid,
          detail: `${d.number} → ${request.number}: ${d.company}, этап «${stage(d.stage).name}» с ${d.enteredAt}`,
        });
        out.push({ number: d.number, system: request.number ?? '' });
      }
      return out;
    });
    return { preview: false, summary, rows: shown, created };
  });
}
