/**
 * Справочники (Проверка функционала: В3, С3, С8, раздел «Справочники без экранов»).
 *
 * Без экранов справочники правились только прямо в базе: куратор филиала для
 * эскалации (п. 100), производственный календарь (от него зависят все сроки в
 * рабочих днях), прейскурант (п. 18), объекты, реквизиты контрагентов. Здесь —
 * ведение этих справочников с проверкой данных и записью в журнал.
 *
 * Кто ведёт:
 *   филиалы, календарь, правила автоматизации — ДИТ;
 *   прейскурант — ДИТ и ОР ПСД (соответствие позиций сценариям — таблица ОР ПСД);
 *   объекты — ДИТ и служба технического учёта активов (п. 12);
 *   реквизиты контрагентов — ДИТ, ОР ПСД, документооборот.
 */

import * as repo from '../db/repo.ts';
import type { Db } from '../db/client.ts';
import { csvRecords } from '../domain/csv.ts';
import { validBin, validEmail, validText } from '../domain/validation.ts';
import { AUTOMATION_RULES } from '../process/rules.ts';
import { STAGES, setStageOverrides, stage, stageOverride } from '../process/stages.ts';
import type { StageCode } from '../process/stages.ts';
import type { SlaUnit } from '../domain/types.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { Actor, Permission } from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { isoDateOrNull } from './context.ts';

const CONTACTS = {
  director: { column: 'director_id', label: 'Директор филиала' },
  curator: { column: 'curator_id', label: 'Курирующий заместитель директора филиала' },
  engineer: { column: 'chief_engineer_id', label: 'Главный инженер области' },
  board: { column: 'board_curator_id', label: 'Курирующий член Правления' },
} as const;
type ContactKey = keyof typeof CONTACTS;
type Contact = { name?: string; email?: string } | null;

function requireAny(actor: Actor, ...permissions: Permission[]): void {
  if (!permissions.some((p) => rbac.can(actor, p))) throw ApiError.forbidden();
}

/**
 * Ответственное лицо филиала — учётная запись: на неё ссылаются эскалации
 * (п. 100). Если человек в системе не работает (например, член Правления),
 * заводится запись без ролей: войти с ней нельзя, но письма ей приходят.
 */
async function contactUser(db: Db, contact: Contact, label: string): Promise<string | null> {
  const email = String(contact?.email ?? '').trim().toLowerCase();
  if (!email) return null;
  const name = String(contact?.name ?? '').trim();
  const existing = await db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    if (name) await db.query(`UPDATE users SET full_name = $2 WHERE id = $1 AND full_name = email`, [existing.id, name]);
    return existing.id;
  }
  const created = await db.one<{ id: string }>(
    `INSERT INTO users (email, full_name, position, department, is_active)
     VALUES ($1, $2, $3, 'Ответственное лицо филиала', true) RETURNING id`,
    [email, name || email, label]);
  return created!.id;
}

function checkContact(key: ContactKey, contact: Contact, fields: Record<string, string>): void {
  if (!contact) return;
  const email = String(contact.email ?? '').trim();
  const name = String(contact.name ?? '').trim();
  if (!email && !name) return;
  if (!validEmail(email)) fields[`${key}.email`] = `${CONTACTS[key].label}: укажите рабочую почту`;
  if (name && !validText(name, 3)) fields[`${key}.name`] = `${CONTACTS[key].label}: укажите Ф.И.О.`;
}

type BranchInput = {
  id?: string; code?: string; name?: string; region?: string; serviceArea?: string; isActive?: boolean;
  contacts?: Partial<Record<ContactKey, Contact>>;
};

function checkBranch(body: BranchInput): Record<string, string> {
  const fields: Record<string, string> = {};
  const code = String(body.code ?? '').trim();
  if (!/^[A-Za-zА-Яа-я0-9_-]{2,32}$/.test(code)) fields.code = 'Код филиала: 2–32 символа, буквы и цифры';
  if (!validText(body.name, 3)) fields.name = 'Укажите наименование филиала';
  for (const key of Object.keys(CONTACTS) as ContactKey[]) checkContact(key, body.contacts?.[key] ?? null, fields);
  return fields;
}

async function saveBranch(t: Db, body: BranchInput): Promise<string> {
  const ids: Record<string, string | null> = {};
  for (const [key, def] of Object.entries(CONTACTS) as [ContactKey, (typeof CONTACTS)[ContactKey]][]) {
    // Не переданный контакт не трогаем; пустой — снимаем назначение.
    if (body.contacts && key in body.contacts) ids[def.column] = await contactUser(t, body.contacts[key] ?? null, def.label);
  }
  const existing = body.id
    ? await t.one<{ id: string }>('SELECT id FROM branches WHERE id = $1', [body.id])
    : await t.one<{ id: string }>('SELECT id FROM branches WHERE code = $1', [String(body.code).trim()]);
  const values = {
    code: String(body.code).trim(), name: String(body.name).trim(), region: String(body.region ?? '').trim(),
    service_area: String(body.serviceArea ?? '').trim(), is_active: body.isActive !== false, ...ids,
  };
  const keys = Object.keys(values);
  const params = Object.values(values);
  if (existing) {
    await t.query(`UPDATE branches SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [existing.id, ...params] as never);
    return existing.id;
  }
  const row = await t.one<{ id: string }>(
    `INSERT INTO branches (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    params as never);
  return row!.id;
}

const BRANCH_COLUMNS = {
  code: ['код', 'код филиала', 'code'],
  name: ['филиал', 'наименование', 'наименование филиала', 'name'],
  region: ['регион', 'область', 'region'],
  serviceArea: ['зона обслуживания', 'зона', 'районы', 'service_area'],
  directorName: ['директор', 'директор филиала', 'фио директора'],
  directorEmail: ['почта директора', 'email директора'],
  curatorName: ['курирующий заместитель', 'заместитель директора', 'куратор', 'фио куратора'],
  curatorEmail: ['почта куратора', 'почта заместителя', 'email куратора'],
  engineerName: ['главный инженер', 'главный инженер области'],
  engineerEmail: ['почта главного инженера', 'email главного инженера'],
  boardName: ['член правления', 'курирующий член правления'],
  boardEmail: ['почта члена правления', 'email члена правления'],
};

/** Нормативы, изменённые ДИТ (С9): загружаются при запуске и после изменения. */
export async function loadStageOverrides(db: Db): Promise<void> {
  const rows = await db.query<{ stage_code: StageCode; sla_value: number; sla_unit: SlaUnit; sla_text: string }>(
    'SELECT stage_code, sla_value, sla_unit, sla_text FROM stage_sla_overrides');
  setStageOverrides(rows.map((r) => ({
    stageCode: r.stage_code, override: { slaValue: r.sla_value, slaUnit: r.sla_unit, slaText: r.sla_text },
  })));
}

export function registerDirectoryRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /* ------------------------- нормативы этапов (С9) ------------------------- */

  router.get('/api/v1/admin/stages', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const log = await db.query<{ stage_code: string; reason: string; updated_at: string; author: string | null }>(
      `SELECT o.stage_code, o.reason, o.updated_at, u.full_name AS author
         FROM stage_sla_overrides o LEFT JOIN users u ON u.id = o.updated_by`);
    return {
      stages: STAGES.map((s) => {
        const current = stage(s.code);
        const note = log.find((l) => l.stage_code === s.code);
        return {
          code: s.code, name: s.name, regulationRef: s.regulationRef, terminal: s.terminal,
          regulation: { slaValue: s.slaValue, slaUnit: s.slaUnit, slaText: s.slaText },
          current: { slaValue: current.slaValue, slaUnit: current.slaUnit, slaText: current.slaText },
          overridden: !!stageOverride(s.code), reason: note?.reason ?? null, updatedAt: note?.updated_at ?? null,
          updatedBy: note?.author ?? null,
        };
      }),
    };
  });

  router.post('/api/v1/admin/stages/:code', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const code = ctx.params.code as StageCode;
    const def = STAGES.find((s) => s.code === code);
    if (!def || def.terminal) throw ApiError.notFound('Этап не найден');
    const body = await ctx.body<{ slaValue?: number; slaUnit?: SlaUnit; slaText?: string; reason?: string; reset?: boolean }>();
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 5) throw ApiError.badRequest('Укажите основание: пункт новой редакции Регламента, приказ', { reason: 'Основание обязательно' });

    await db.tx(async (t) => {
      if (body.reset) {
        await t.query('DELETE FROM stage_sla_overrides WHERE stage_code = $1', [code]);
      } else {
        const value = Number(body.slaValue);
        const unit = body.slaUnit as SlaUnit;
        const fields: Record<string, string> = {};
        if (!Number.isInteger(value) || value < 0 || value > 365) fields.slaValue = 'Целое число от 0 до 365';
        if (!['working', 'calendar', 'operational', 'same_day', 'none'].includes(unit)) fields.slaUnit = 'Единица срока';
        if (!validText(body.slaText, 2)) fields.slaText = 'Как показывать норматив';
        if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте норматив', fields);
        await t.query(
          `INSERT INTO stage_sla_overrides (stage_code, sla_value, sla_unit, sla_text, reason, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (stage_code) DO UPDATE SET sla_value = excluded.sla_value, sla_unit = excluded.sla_unit,
             sla_text = excluded.sla_text, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now()`,
          [code, value, unit, String(body.slaText).trim(), reason, actor.id]);
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.reset ? 'Норматив этапа возвращён к Регламенту' : 'Изменён норматив этапа',
        entity: 'stage', entityId: code,
        detail: `${def.name}: ${body.reset ? def.slaText : `${body.slaValue} (${body.slaUnit}) «${body.slaText}»`}. Основание: ${reason}`,
        regulationRef: def.regulationRef,
      });
    });
    await loadStageOverrides(db);
    return { stage: stage(code) };
  });

  /* ----------------------------- филиалы (В3) ----------------------------- */

  router.get('/api/v1/admin/branches', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const person = (alias: string, column: string) =>
      `(SELECT json_build_object('id', u.id, 'name', u.full_name, 'email', u.email, 'active', u.is_active)
          FROM users u WHERE u.id = b.${column}) AS ${alias}`;
    return {
      branches: await db.query(
        `SELECT b.id, b.code, b.name, b.region, b.service_area, b.is_active,
                ${person('director', 'director_id')}, ${person('curator', 'curator_id')},
                ${person('engineer', 'chief_engineer_id')}, ${person('board', 'board_curator_id')},
                (SELECT count(*)::int FROM facilities f WHERE f.branch_id = b.id AND f.is_active) AS facilities,
                (SELECT count(*)::int FROM requests r WHERE r.branch_id = b.id AND r.closed_at IS NULL) AS open_requests
           FROM branches b ORDER BY b.name`),
    };
  });

  router.post('/api/v1/admin/branches', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<BranchInput>();
    const fields = checkBranch(body);
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные филиала', fields);
    const id = await db.tx(async (t) => {
      const saved = await saveBranch(t, body);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.id ? 'Изменён справочник филиала' : 'Добавлен филиал',
        entity: 'branch', entityId: saved,
        detail: `${body.code} ${body.name}; ответственные: ` +
          (Object.keys(CONTACTS) as ContactKey[]).map((k) => `${CONTACTS[k].label} — ${body.contacts?.[k]?.email || 'не назначен'}`).join('; '),
        regulationRef: 'Приложение 7, п. 100',
      });
      return saved;
    });
    return { id };
  });

  /** Импорт таблицы Приложения 7: сначала предпросмотр, затем запись корректных строк. */
  router.post('/api/v1/admin/branches/import', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ csv?: string; apply?: boolean }>();
    const { records, missing } = csvRecords(String(body.csv ?? ''), BRANCH_COLUMNS);
    if (missing.includes('name') && missing.includes('code')) {
      throw ApiError.badRequest('В файле нет колонок «Код» или «Филиал»');
    }
    const known = await db.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM branches');
    const rows = records.map((r) => {
      const match = known.find((b) => (r.code && b.code.toLowerCase() === r.code.toLowerCase()) ||
        (r.name && b.name.toLowerCase() === r.name.toLowerCase()));
      const input: BranchInput = {
        id: match?.id, code: r.code || match?.code, name: r.name || match?.name, region: r.region,
        serviceArea: r.serviceArea,
        contacts: {
          director: { name: r.directorName, email: r.directorEmail },
          curator: { name: r.curatorName, email: r.curatorEmail },
          engineer: { name: r.engineerName, email: r.engineerEmail },
          board: { name: r.boardName, email: r.boardEmail },
        },
      };
      const errors = checkBranch(input);
      return { line: r.line, branch: input, errors, action: Object.keys(errors).length ? 'skip' : match ? 'update' : 'create' };
    });
    const summary = {
      total: rows.length, create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length, skip: rows.filter((r) => r.action === 'skip').length,
    };
    if (body.apply !== true) return { preview: true, summary, rows };
    await db.tx(async (t) => {
      for (const r of rows) if (r.action !== 'skip') await saveBranch(t, r.branch);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Импорт справочника филиалов', entity: 'branch', entityId: 'import',
        detail: `создано ${summary.create}, обновлено ${summary.update}, пропущено ${summary.skip}`,
        regulationRef: 'Приложение 7',
      });
    });
    return { preview: false, summary, rows };
  });

  /* ---------------------------- прейскурант (С3) ---------------------------- */

  router.get('/api/v1/admin/tariffs', async (ctx) => {
    const actor = await deps.actor(ctx);
    requireAny(actor, 'admin', 'request.tv');
    return {
      tariffs: await db.query(
        `SELECT id, service, name, unit, amount, source, placement, is_default,
                effective_from::text AS effective_from, effective_to::text AS effective_to,
                (effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)) AS active,
                (SELECT count(*)::int FROM request_services s WHERE s.tariff_id = t.id) AS used
           FROM tariffs t ORDER BY service, placement NULLS LAST, effective_from DESC, name`),
    };
  });

  router.post('/api/v1/admin/tariffs', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    requireAny(actor, 'admin', 'request.tv');
    const body = await ctx.body<{
      id?: string; service?: string; name?: string; unit?: string; amount?: number | string; source?: string;
      effectiveFrom?: string; effectiveTo?: string | null; placement?: string | null; isDefault?: boolean;
    }>();
    const fields: Record<string, string> = {};
    const service = String(body.service ?? '');
    const amount = Number(String(body.amount ?? '').replace(/\s/g, '').replace(',', '.'));
    const from = isoDateOrNull(body.effectiveFrom);
    const to = isoDateOrNull(body.effectiveTo);
    const placement = body.placement || null;
    if (!['ТУ', 'ПСД'].includes(service)) fields.service = 'Прейскурант ведётся для ТУ и ПСД; СМР — по смете (п. 49)';
    if (!validText(body.name, 5)) fields.name = 'Укажите наименование позиции';
    if (!validText(body.unit, 2)) fields.unit = 'Укажите единицу';
    if (!Number.isFinite(amount) || amount < 0) fields.amount = 'Стоимость — неотрицательное число';
    if (!validText(body.source, 3)) fields.source = 'Укажите пункт Прейскуранта (п. 18)';
    if (!from || from === 'invalid') fields.effectiveFrom = 'Дата начала действия';
    if (to === 'invalid') fields.effectiveTo = 'Дата в формате ГГГГ-ММ-ДД';
    else if (to && from && from !== 'invalid' && to < from) fields.effectiveTo = 'Окончание раньше начала';
    if (placement && !['ams', 'room', 'network', 'cable', 'power'].includes(placement)) fields.placement = 'Неизвестный сценарий';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте позицию прейскуранта', fields);

    const id = await db.tx(async (t) => {
      // Одна позиция «по умолчанию» на услугу и сценарий: её подставляет форма заявки.
      if (body.isDefault) {
        await t.query(`UPDATE tariffs SET is_default = false WHERE service = $1 AND placement IS NOT DISTINCT FROM $2 AND id IS DISTINCT FROM $3::uuid`,
          [service, placement, body.id ?? null]);
      }
      const values = [service, String(body.name).trim(), String(body.unit).trim(), amount, String(body.source).trim(),
        from, to, placement, body.isDefault === true];
      let saved: string;
      if (body.id) {
        const row = await t.one<{ id: string }>(
          `UPDATE tariffs SET service = $2, name = $3, unit = $4, amount = $5, source = $6, effective_from = $7,
                  effective_to = $8, placement = $9, is_default = $10 WHERE id = $1 RETURNING id`, [body.id, ...values] as never);
        if (!row) throw ApiError.notFound('Позиция не найдена');
        saved = row.id;
      } else {
        const row = await t.one<{ id: string }>(
          `INSERT INTO tariffs (service, name, unit, amount, source, effective_from, effective_to, placement, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, values as never);
        saved = row!.id;
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.id ? 'Изменена позиция прейскуранта' : 'Добавлена позиция прейскуранта',
        entity: 'tariff', entityId: saved, detail: `${service}: ${body.name} — ${amount} ₸ с ${from}${to ? ` по ${to}` : ''}`,
        regulationRef: 'п. 18',
      });
      return saved;
    });
    return { id };
  });

  /* -------------------------- производственный календарь -------------------------- */

  router.get('/api/v1/admin/calendar', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const year = Number(ctx.query.get('year')) || new Date().getFullYear();
    const [days, years] = await Promise.all([
      db.query(`SELECT day::text AS day, kind, source FROM calendar_days
                 WHERE day >= make_date($1, 1, 1) AND day < make_date($1 + 1, 1, 1) ORDER BY day`, [year]),
      db.query<{ year: number; holidays: number; working: number }>(
        `SELECT extract(year FROM day)::int AS year,
                count(*) FILTER (WHERE kind = 'holiday')::int AS holidays,
                count(*) FILTER (WHERE kind = 'working')::int AS working
           FROM calendar_days GROUP BY 1 ORDER BY 1`),
    ]);
    // Предупреждение: на следующий год календарь не заполнен — сроки посчитаются без праздников.
    const next = new Date().getFullYear() + 1;
    return { year, days, years, missingNextYear: !years.some((y) => y.year === next) };
  });

  router.post('/api/v1/admin/calendar', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ day?: string; kind?: 'holiday' | 'working' | null; source?: string }>();
    const day = isoDateOrNull(body.day);
    if (!day || day === 'invalid') throw ApiError.badRequest('Укажите дату', { day: 'Дата в формате ГГГГ-ММ-ДД' });
    if (body.kind && !['holiday', 'working'].includes(body.kind)) throw ApiError.badRequest('Вид дня: праздник или рабочий');
    if (body.kind && !validText(body.source, 3)) {
      throw ApiError.badRequest('Укажите основание', { source: 'Постановление Правительства, закон о праздниках' });
    }
    await db.tx(async (t) => {
      if (body.kind) {
        await t.query(
          `INSERT INTO calendar_days (day, kind, source) VALUES ($1,$2,$3)
           ON CONFLICT (day) DO UPDATE SET kind = excluded.kind, source = excluded.source`, [day, body.kind, String(body.source).trim()]);
      } else {
        await t.query('DELETE FROM calendar_days WHERE day = $1', [day]);
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Изменён производственный календарь', entity: 'calendar', entityId: day,
        detail: body.kind ? `${day}: ${body.kind === 'holiday' ? 'нерабочий' : 'рабочий'} — ${body.source}` : `${day}: отметка снята`,
      });
    });
    return { ok: true };
  });

  /** Импорт календаря на год: «Дата; Вид; Основание». */
  router.post('/api/v1/admin/calendar/import', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ csv?: string; apply?: boolean }>();
    const { records, missing } = csvRecords(String(body.csv ?? ''), {
      day: ['дата', 'день', 'date'], kind: ['вид', 'тип', 'kind'], source: ['основание', 'источник', 'source'],
    });
    if (missing.includes('day') || missing.includes('kind')) throw ApiError.badRequest('Нужны колонки «Дата» и «Вид»');
    const rows = records.map((r) => {
      const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(r.day);
      const day = ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : r.day;
      const kindText = r.kind.toLowerCase();
      const kind = /празд|выход|нерабоч|holiday/.test(kindText) ? 'holiday' : /рабоч|перенос|working/.test(kindText) ? 'working' : null;
      const errors: Record<string, string> = {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) errors.day = 'Дата: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД';
      if (!kind) errors.kind = 'Вид: «праздник» или «рабочий»';
      return { line: r.line, day, kind, source: r.source || 'Импорт производственного календаря', errors };
    });
    const valid = rows.filter((r) => !Object.keys(r.errors).length);
    if (body.apply !== true) return { preview: true, rows, summary: { total: rows.length, valid: valid.length } };
    await db.tx(async (t) => {
      for (const r of valid) {
        await t.query(
          `INSERT INTO calendar_days (day, kind, source) VALUES ($1,$2,$3)
           ON CONFLICT (day) DO UPDATE SET kind = excluded.kind, source = excluded.source`, [r.day, r.kind, r.source]);
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Импорт производственного календаря', entity: 'calendar', entityId: 'import',
        detail: `записано дней: ${valid.length}, с ошибками: ${rows.length - valid.length}`,
      });
    });
    return { preview: false, rows, summary: { total: rows.length, valid: valid.length } };
  });

  /* ------------------------------ объекты ------------------------------ */

  router.get('/api/v1/admin/facilities', async (ctx) => {
    const actor = await deps.actor(ctx);
    requireAny(actor, 'admin', 'registry.edit');
    return {
      facilities: await db.query(
        `SELECT f.id, f.inv_no, f.name, f.kind, f.branch_id, b.name AS branch_name, f.address, f.height_m,
                f.structure, f.latitude, f.longitude, f.is_active,
                c.passport_load_kg, c.power_input_kw, c.free_area_m2, c.wind_zone, c.surveyed_at::text AS surveyed_at,
                (SELECT count(*)::int FROM facility_tiers t WHERE t.facility_id = f.id) AS tiers
           FROM facilities f JOIN branches b ON b.id = f.branch_id
           LEFT JOIN facility_capacity c ON c.facility_id = f.id
          ORDER BY b.name, f.name`),
    };
  });

  router.post('/api/v1/admin/facilities', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    requireAny(actor, 'admin', 'registry.edit');
    const body = await ctx.body<{
      id?: string; invNo?: string; name?: string; kind?: string; branchId?: string; address?: string;
      heightM?: number | string | null; isActive?: boolean;
      capacity?: { passportLoadKg?: number | string | null; powerInputKw?: number | string | null; freeAreaM2?: number | string | null; windZone?: string | null };
    }>();
    const fields: Record<string, string> = {};
    const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(String(v).replace(',', '.')));
    const height = num(body.heightM);
    if (!/^[A-Za-zА-Яа-я0-9./_-]{1,64}$/.test(String(body.invNo ?? '').trim())) fields.invNo = 'Инвентарный номер';
    if (!validText(body.name, 3)) fields.name = 'Наименование объекта';
    if (!['ams', 'rts', 'mast', 'tower', 'room', 'other'].includes(String(body.kind))) fields.kind = 'Тип объекта';
    if (!body.branchId) fields.branchId = 'Филиал';
    if (height !== null && (!Number.isFinite(height) || height < 0 || height > 1000)) fields.heightM = 'Высота, м: от 0 до 1000';
    const cap = body.capacity ?? null;
    // Несущая способность и мощность — поля мастер-файла: правит только техучёт (п. 12).
    if (cap && !rbac.can(actor, 'registry.edit')) throw ApiError.forbidden('Сведения мастер-файла вносит служба технического учёта активов (п. 12)');
    for (const [key, value] of Object.entries(cap ?? {})) {
      if (key === 'windZone') continue;
      const n = num(value);
      if (n !== null && (!Number.isFinite(n) || n < 0)) fields[`capacity.${key}`] = 'Неотрицательное число';
    }
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные объекта', fields);

    const id = await db.tx(async (t) => {
      const values = [String(body.invNo).trim(), String(body.name).trim(), body.kind, body.branchId,
        String(body.address ?? '').trim(), height, body.isActive !== false];
      let saved: string;
      if (body.id) {
        const row = await t.one<{ id: string }>(
          `UPDATE facilities SET inv_no = $2, name = $3, kind = $4, branch_id = $5, address = $6, height_m = $7, is_active = $8
            WHERE id = $1 RETURNING id`, [body.id, ...values] as never);
        if (!row) throw ApiError.notFound('Объект не найден');
        saved = row.id;
      } else {
        if (await t.one('SELECT 1 FROM facilities WHERE inv_no = $1', [values[0]])) {
          throw ApiError.conflict(`Объект с инв. № ${values[0]} уже есть`);
        }
        const row = await t.one<{ id: string }>(
          `INSERT INTO facilities (inv_no, name, kind, branch_id, address, height_m, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, values as never);
        saved = row!.id;
      }
      if (cap) {
        await t.query(
          `INSERT INTO facility_capacity (facility_id, passport_load_kg, power_input_kw, free_area_m2, wind_zone, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (facility_id) DO UPDATE SET passport_load_kg = excluded.passport_load_kg,
             power_input_kw = excluded.power_input_kw, free_area_m2 = excluded.free_area_m2,
             wind_zone = excluded.wind_zone, updated_by = excluded.updated_by, updated_at = now()`,
          [saved, num(cap.passportLoadKg), num(cap.powerInputKw), num(cap.freeAreaM2), cap.windZone || null, actor.id]);
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.id ? 'Изменён объект' : 'Добавлен объект', entity: 'facility', entityId: saved,
        detail: `инв. № ${values[0]} ${values[1]}${cap ? ' · сведения мастер-файла обновлены' : ''}`,
        regulationRef: cap ? 'пп. 12–14' : null,
      });
      return saved;
    });
    return { id };
  });

  /* ------------------------------ контрагенты ------------------------------ */

  router.get('/api/v1/admin/counterparties', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'counterparty.verify');
    const q = String(ctx.query.get('q') ?? '').trim();
    const status = ctx.query.get('status') || null;
    return {
      counterparties: await db.query(
        `SELECT c.id, c.bin, c.name_full, c.name_short, c.legal_address, c.actual_address, c.contact_person,
                c.phone, c.email, c.status, c.verified_at, v.full_name AS verified_by_name, c.created_at,
                (SELECT count(*)::int FROM requests r WHERE r.counterparty_id = c.id) AS requests,
                (SELECT count(*)::int FROM users u WHERE u.counterparty_id = c.id AND u.is_active) AS users
           FROM counterparties c LEFT JOIN users v ON v.id = c.verified_by
          WHERE ($1 = '' OR c.bin LIKE $1 || '%' OR c.name_full ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR c.status = $2)
          ORDER BY (c.status = 'pending') DESC, c.name_full LIMIT 300`, [q, status]),
    };
  });

  router.post('/api/v1/admin/counterparties', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'counterparty.verify');
    const body = await ctx.body<{
      id?: string; bin?: string; nameFull?: string; nameShort?: string; legalAddress?: string; actualAddress?: string;
      contactPerson?: string; phone?: string; email?: string; status?: 'pending' | 'active' | 'blocked';
    }>();
    const fields: Record<string, string> = {};
    if (!body.id && !validBin(body.bin)) fields.bin = 'БИН: 12 цифр, проверьте контрольный разряд';
    if (!validText(body.nameFull, 3)) fields.nameFull = 'Полное наименование';
    if (body.email && !validEmail(body.email)) fields.email = 'Адрес почты';
    if (body.status && !['pending', 'active', 'blocked'].includes(body.status)) fields.status = 'Статус';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте реквизиты контрагента', fields);

    const values = [String(body.nameFull).trim(), String(body.nameShort ?? '').trim(), String(body.legalAddress ?? '').trim(),
      String(body.actualAddress ?? '').trim(), String(body.contactPerson ?? '').trim(), String(body.phone ?? '').trim(),
      String(body.email ?? '').trim().toLowerCase(), body.status ?? 'pending'];
    const id = await db.tx(async (t) => {
      let saved: string;
      const verify = body.status === 'active';
      if (body.id) {
        const before = await t.one<{ status: string }>('SELECT status FROM counterparties WHERE id = $1', [body.id]);
        if (!before) throw ApiError.notFound('Контрагент не найден');
        await t.query(
          `UPDATE counterparties SET name_full = $2, name_short = $3, legal_address = $4, actual_address = $5,
                  contact_person = $6, phone = $7, email = $8, status = $9,
                  verified_by = CASE WHEN $10 AND status <> 'active' THEN $11::uuid ELSE verified_by END,
                  verified_at = CASE WHEN $10 AND status <> 'active' THEN now() ELSE verified_at END
            WHERE id = $1`, [body.id, ...values, verify, actor.id] as never);
        saved = body.id;
      } else {
        if (await t.one('SELECT 1 FROM counterparties WHERE bin = $1', [body.bin])) {
          throw ApiError.conflict(`Контрагент с БИН ${body.bin} уже есть в справочнике`);
        }
        const row = await t.one<{ id: string }>(
          `INSERT INTO counterparties (bin, name_full, name_short, legal_address, actual_address, contact_person, phone, email, status,
                                       verified_by, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN $11::uuid END, CASE WHEN $10 THEN now() END) RETURNING id`,
          [String(body.bin).trim(), ...values, verify, actor.id] as never);
        saved = row!.id;
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor),
        action: verify ? 'Реквизиты контрагента проверены' : body.id ? 'Изменены реквизиты контрагента' : 'Добавлен контрагент',
        entity: 'counterparty', entityId: saved, detail: `${values[0]} · статус ${values[7]}`,
      });
      return saved;
    });
    return { id };
  });

  /* ------------------------ правила автоматизации (С8) ------------------------ */

  /**
   * Правила — данные: ДИТ включает и выключает их без пересборки. Выключенное
   * правило действие не отменяет (переход, закрытие по сроку выполняются по
   * Регламенту), но писем не рассылает.
   */
  router.get('/api/v1/rules', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (rbac.isExternal(actor)) throw ApiError.forbidden();
    const rows = await db.query<{ id: number; enabled: boolean; updated_at: string; updated_by_name: string | null }>(
      `SELECT r.id, r.enabled, r.updated_at, u.full_name AS updated_by_name
         FROM automation_rules r LEFT JOIN users u ON u.id = r.updated_by`);
    const state = new Map(rows.map((r) => [r.id, r]));
    return {
      rules: AUTOMATION_RULES.map((rule) => ({
        ...rule,
        enabled: state.get(rule.id)?.enabled ?? rule.enabled,
        updatedAt: state.get(rule.id)?.updated_by_name ? state.get(rule.id)?.updated_at : null,
        updatedBy: state.get(rule.id)?.updated_by_name ?? null,
      })),
    };
  });

  router.post('/api/v1/rules/:id', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const id = Number(ctx.params.id);
    const rule = AUTOMATION_RULES.find((r) => r.id === id);
    if (!rule) throw ApiError.notFound('Правило не найдено');
    const body = await ctx.body<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('Укажите, включить или выключить правило');
    await db.tx(async (t) => {
      await t.query(`UPDATE automation_rules SET enabled = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
        [id, body.enabled, actor.id]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.enabled ? 'Правило автоматизации включено' : 'Правило автоматизации выключено',
        entity: 'rule', entityId: String(id), detail: `${rule.id}. ${rule.event}`, regulationRef: rule.regulationRef,
      });
    });
    return { ok: true };
  });
}
