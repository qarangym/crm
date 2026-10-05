/**
 * Реестр договоров аренды (Инструкция о допуске, пп. 7, 13, 14).
 *
 * Договор аренды — основание допуска для технического обслуживания и ремонта
 * оборудования, и срок допуска не может его превышать. Реестр ведёт СУА:
 * загрузка из таблицы (предпросмотр с ошибками по строкам), ручной ввод и
 * пополнение при ручном подтверждении основания по скану договора. Пока договор
 * в реестре не найден, заявка идёт по скану и подтверждается специалистом СУА.
 */

import * as repo from '../../db/repo.ts';
import { csvRecords } from '../../domain/csv.ts';
import { validBin } from '../../domain/validation.ts';
import { ApiError } from '../../server/errors.ts';
import type { Router } from '../../server/http.ts';
import * as rbac from '../../server/rbac.ts';
import type { Actor } from '../../server/rbac.ts';
import type { RouteDeps } from '../../server/context.ts';
import * as data from '../db/permits.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = 'пп. 7, 13, 14 Инструкции';

/** Дата: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ (как в Excel). */
export function parseDate(value: unknown): string | null {
  const s = String(value ?? '').trim();
  let iso = s;
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (ru) iso = `${ru[3]}-${ru[2].padStart(2, '0')}-${ru[1].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso))) return null;
  return iso;
}

const COLUMNS = {
  number: ['номер', 'номер договора', '№ договора', 'договор', 'number'],
  date: ['дата', 'дата договора', 'date'],
  bin: ['бин', 'бин арендатора', 'bin'],
  company: ['арендатор', 'организация', 'контрагент', 'наименование'],
  facilities: ['объекты', 'объект', 'инв. №', 'инвентарный номер', 'facilities'],
  validFrom: ['начало', 'действует с', 'дата начала'],
  validUntil: ['окончание', 'действует до', 'срок действия', 'дата окончания'],
  status: ['статус', 'status'],
};

export function registerLeaseRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  const canView = (a: Actor) => rbac.can(a, 'permit.view') || rbac.can(a, 'admin');
  const canEdit = (a: Actor) => rbac.can(a, 'permit.review') || rbac.can(a, 'admin');

  router.get('/api/v1/permits/leases', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!canView(actor)) throw ApiError.forbidden();
    const expiring = Number(ctx.query.get('expiring'));
    return {
      leases: await data.listLeases(db, {
        q: ctx.query.get('q') || null,
        expiringDays: Number.isInteger(expiring) && expiring > 0 ? expiring : null,
      }),
    };
  });

  type LeaseBody = {
    id?: string; number?: string; contractDate?: string; bin?: string; company?: string; validFrom?: string;
    validUntil?: string; status?: string; note?: string; facilityIds?: string[];
  };

  router.post('/api/v1/permits/leases', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    if (!canEdit(actor)) throw ApiError.forbidden();
    const body = await ctx.body<LeaseBody>();
    const fields: Record<string, string> = {};
    const number = String(body.number ?? '').trim().slice(0, 128);
    const bin = String(body.bin ?? '').trim();
    const validUntil = parseDate(body.validUntil);
    if (!number) fields.number = 'Укажите номер договора';
    if (!validBin(bin)) fields.bin = 'БИН арендатора: 12 цифр, проверьте контрольный разряд';
    if (!validUntil) fields.validUntil = 'Укажите срок действия договора';
    const contractDate = body.contractDate ? parseDate(body.contractDate) : null;
    const validFrom = body.validFrom ? parseDate(body.validFrom) : null;
    if (validFrom && validUntil && validUntil < validFrom) fields.validUntil = 'Окончание раньше начала';
    const counterparty = validBin(bin) ? await data.counterpartyByBin(db, bin) : null;
    if (validBin(bin) && !counterparty && String(body.company ?? '').trim().length < 3) {
      fields.company = 'Организации с таким БИН нет в справочнике — укажите наименование';
    }
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте договор аренды', fields);
    const cp = counterparty?.id ?? (await repo.resolveCounterparty(db, { bin, company: String(body.company) })).id;
    const id = await db.tx(async (t) => {
      const saved = await data.saveLease(t, {
        id: body.id && UUID.test(body.id) ? body.id : null, number, contractDate, counterpartyId: cp, validFrom,
        validUntil: validUntil!, status: body.status === 'terminated' ? 'terminated' : 'active',
        note: String(body.note ?? '').trim().slice(0, 2000),
        facilityIds: (body.facilityIds ?? []).filter((x) => UUID.test(x)), source: 'manual',
      }, actor.id);
      if (!saved) throw ApiError.notFound('Договор не найден');
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.id ? 'Изменён договор аренды' : 'Договор аренды внесён в реестр',
        entity: 'lease_contract', entityId: saved, detail: `${number} · БИН ${bin} · до ${validUntil}`, regulationRef: REF,
      });
      return saved;
    });
    return { lease: (await data.listLeases(db, {})).find((l) => l.id === id) };
  });

  /** Загрузка реестра из таблицы СУА: предпросмотр (`apply: false`) и запись строк без ошибок. */
  router.post('/api/v1/permits/leases/import', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    if (!canEdit(actor)) throw ApiError.forbidden();
    const body = await ctx.body<{ csv?: string; apply?: boolean }>();
    const csv = String(body.csv ?? '');
    if (!csv.trim()) throw ApiError.badRequest('Файл пуст');
    const { records, missing } = csvRecords(csv, COLUMNS);
    const required = (['number', 'bin', 'validUntil'] as const).filter((k) => missing.includes(k));
    if (required.length) {
      throw ApiError.badRequest(`Нет обязательных колонок: ${required.map((k) => COLUMNS[k][0]).join(', ')}`);
    }
    if (records.length > 5000) throw ApiError.badRequest('Не более 5000 строк за раз');
    const facilities = new Map((await db.query<{ id: string; inv_no: string }>(`SELECT id, inv_no FROM facilities`))
      .map((f) => [f.inv_no.toLowerCase(), f.id]));
    const rows = [];
    for (const rec of records) {
      const errors: Record<string, string> = {};
      const bin = rec.bin.replace(/\s/g, '');
      const validUntil = parseDate(rec.validUntil);
      if (!rec.number) errors.number = 'нет номера договора';
      if (!validBin(bin)) errors.bin = 'БИН с ошибкой';
      if (!validUntil) errors.validUntil = 'нет срока действия (ДД.ММ.ГГГГ)';
      const facilityIds: string[] = [];
      for (const inv of (rec.facilities ?? '').split(/[|,;]/).map((s) => s.trim()).filter(Boolean)) {
        const id = facilities.get(inv.toLowerCase());
        if (id) facilityIds.push(id); else errors.facilities = `объект «${inv}» не найден в справочнике`;
      }
      const known = validBin(bin) ? await data.counterpartyByBin(db, bin) : null;
      if (validBin(bin) && !known && (rec.company ?? '').trim().length < 3) errors.company = 'организации нет в справочнике — укажите наименование';
      rows.push({
        line: rec.line, errors, action: Object.keys(errors).length ? 'skip' : 'save',
        lease: { number: rec.number, bin, company: known?.name_full ?? rec.company ?? '', validUntil, facilities: facilityIds.length },
        input: { rec, bin, validUntil, facilityIds, known },
      });
    }
    if (body.apply) {
      await db.tx(async (t) => {
        for (const row of rows.filter((r) => r.action === 'save')) {
          const { rec, bin, validUntil, facilityIds, known } = row.input;
          const cp = known?.id ?? (await repo.resolveCounterparty(t, { bin, company: rec.company ?? '' })).id;
          await data.saveLease(t, {
            number: rec.number, contractDate: parseDate(rec.date), counterpartyId: cp, validFrom: parseDate(rec.validFrom),
            validUntil: validUntil!, status: /растор|terminated/i.test(rec.status ?? '') ? 'terminated' : 'active', note: '',
            facilityIds, source: 'import',
          }, actor.id);
        }
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Загрузка реестра договоров аренды', entity: 'lease_contract', entityId: 'import',
          detail: `строк ${rows.length}, записано ${rows.filter((r) => r.action === 'save').length}`, regulationRef: REF,
        });
      });
    }
    return {
      preview: !body.apply,
      summary: { total: rows.length, save: rows.filter((r) => r.action === 'save').length, skip: rows.filter((r) => r.action === 'skip').length },
      rows: rows.map(({ input: _input, ...r }) => r),
    };
  });
}
