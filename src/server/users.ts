/**
 * Учётные записи и роли (План завершения, B1, B9; ТЗ раздел 4, №14).
 *
 * Роли назначает только ДИТ: Регламент закрепляет действия за
 * подразделениями, поэтому самопроизвольной выдачи прав быть не должно.
 * Ручное заведение и массовый импорт проверяются одними правилами; каждое
 * изменение пишется в журнал.
 */

import * as repo from '../db/repo.ts';
import { csvRecords } from '../domain/csv.ts';
import { EXTERNAL_ROLES, ROLE_NAME } from '../domain/types.ts';
import type { Role } from '../domain/types.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { Actor } from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { revokeSessions } from './login.ts';
import { notify } from './notify.ts';

export type UserDraft = {
  email?: string; fullName?: string; position?: string; department?: string;
  branchId?: string | null; counterpartyId?: string | null; roles?: string[]; isActive?: boolean; isHead?: boolean;
};

export type CheckedUser = {
  email: string; fullName: string; position: string; department: string;
  branchId: string | null; counterpartyId: string | null; roles: Role[]; isActive: boolean; isHead: boolean | null;
};

/** Проверка учётной записи — одна для формы и для импорта. */
export function checkUser(body: UserDraft, actor: Actor): { user: CheckedUser; fields: Record<string, string> } {
  const email = String(body.email ?? '').trim().toLowerCase();
  const fullName = String(body.fullName ?? '').trim();
  const unknown = (body.roles ?? []).filter((r) => !(r in ROLE_NAME));
  const roles = [...new Set((body.roles ?? []).filter((r) => r in ROLE_NAME))] as Role[];
  const fields: Record<string, string> = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Укажите корректный адрес почты';
  if (fullName.length < 3) fields.fullName = 'Укажите фамилию и инициалы';
  if (unknown.length) fields.roles = `Неизвестные роли: ${unknown.join(', ')}`;
  else if (!roles.length) fields.roles = 'Назначьте хотя бы одну роль';
  else if (roles.length > 1 && roles.some((r) => EXTERNAL_ROLES.includes(r))) {
    // Кабинеты не пересекаются: Заказчик ОР ПСД не подаёт заявку на допуск, подрядчик — заявку на услуги.
    fields.roles = 'Роль «Заказчик» или «Подрядчик» назначается отдельно, без других ролей. ' +
      'Заказчику ОР ПСД и подрядчику портала допусков нужны разные учётные записи';
  }
  if (roles.includes('branch') && !body.branchId) fields.branchId = 'Для роли «Филиал» укажите филиал';
  if (roles.includes('customer') && !body.counterpartyId) {
    fields.counterpartyId = 'Для роли «Заказчик» укажите организацию';
  }
  if (roles.includes('contractor') && !body.counterpartyId) {
    fields.counterpartyId = 'Для роли «Подрядчик» укажите организацию';
  }
  if (email === actor.email && !roles.includes('admin')) {
    // Иначе администратор может случайно лишить себя прав и закрыть вход всем.
    fields.roles = 'Нельзя снять с себя роль администратора';
  }
  if (email === actor.email && body.isActive === false) fields.isActive = 'Нельзя отключить собственную учётную запись';
  return {
    user: {
      email, fullName,
      position: String(body.position ?? '').trim().slice(0, 255),
      department: String(body.department ?? '').trim().slice(0, 128),
      branchId: body.branchId || null,
      counterpartyId: body.counterpartyId || null,
      isActive: body.isActive !== false,
      // Руководителем подразделения может быть только сотрудник Общества.
      isHead: typeof body.isHead === 'boolean' ? body.isHead && !roles.some((r) => EXTERNAL_ROLES.includes(r)) : null,
      roles,
    },
    fields,
  };
}

/** Роль по коду либо по названию: в кадровой выгрузке роли пишут словами. */
const ROLE_ALIASES: Record<string, Role> = (() => {
  const map: Record<string, Role> = {};
  const add = (alias: string, role: Role) => { map[alias.toLowerCase().replace(/ё/g, 'е').trim()] = role; };
  for (const [code, name] of Object.entries(ROLE_NAME) as [Role, string][]) {
    add(code, code);
    add(name, code);
  }
  const extra: [string, Role][] = [
    ['дит', 'admin'], ['администратор', 'admin'], ['ор псд', 'orpsd'], ['филиал', 'branch'],
    ['око', 'oko'], ['документооборот', 'records'], ['канцелярия', 'records'], ['заказчик', 'customer'],
    ['суа', 'assets'], ['техучет', 'assets'], ['технический учет активов', 'assets'],
    ['бухгалтерия', 'accounting'], ['расчеты с контрагентами', 'accounting'], ['руководство', 'management'],
    ['подрядчик', 'contractor'], ['допуски', 'permits'], ['суа допуски', 'permits'],
  ];
  for (const [alias, role] of extra) add(alias, role);
  return map;
})();

export function parseRoles(text: string): string[] {
  return text.split(/[,/|]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => ROLE_ALIASES[s.toLowerCase().replace(/ё/g, 'е')] ?? s);
}

/** Колонки кадровой выгрузки: заголовки сопоставляются по синонимам. */
const IMPORT_COLUMNS = {
  email: ['email', 'e-mail', 'почта', 'электронная почта', 'адрес почты'],
  fullName: ['фио', 'ф.и.о.', 'сотрудник', 'full_name', 'fullname', 'имя'],
  position: ['должность', 'position'],
  department: ['подразделение', 'отдел', 'department'],
  roles: ['роли', 'роль', 'roles', 'role'],
  branch: ['филиал', 'branch', 'код филиала'],
  bin: ['бин', 'бин организации', 'bin'],
};

export const MAX_IMPORT_ROWS = 2000;

export function registerUserRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  router.get('/api/v1/users', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    return { users: await repo.listUsers(db, ctx.query.get('q') ?? undefined) };
  });

  /** Справочники для формы: филиалы и организации-Заказчики. */
  router.get('/api/v1/branches', async (ctx) => {
    const actor = await deps.actor(ctx);
    // Перечень филиалов нужен любому сотруднику (техучёт привязывает объект к филиалу); внешним — нет.
    if (rbac.isExternal(actor)) throw ApiError.forbidden();
    return { branches: await db.query(`SELECT id, code, name, region FROM branches WHERE is_active ORDER BY name`) };
  });

  router.get('/api/v1/counterparties', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const q = String(ctx.query.get('q') ?? '').trim();
    return {
      counterparties: await db.query(
        `SELECT id, bin, name_full, status FROM counterparties
          WHERE $1 = '' OR bin LIKE $1 || '%' OR name_full ILIKE '%' || $1 || '%'
          ORDER BY name_full LIMIT 200`, [q]),
    };
  });

  router.post('/api/v1/users', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const { user, fields } = checkUser(await ctx.body<UserDraft>(), actor);
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные сотрудника', fields);

    const saved = await repo.upsertUser(db, user);
    // Отключённая учётная запись теряет все открытые сеансы сразу.
    if (!user.isActive) await revokeSessions(db, saved.id);
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Назначены права пользователю', entity: 'user',
      entityId: saved.id, detail: `${user.email}: ${user.roles.map((r) => ROLE_NAME[r]).join(', ')}`,
    });
    return { user: saved };
  });

  router.post('/api/v1/users/:id/disable', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    if (ctx.params.id === actor.id) throw ApiError.badRequest('Нельзя отключить собственную учётную запись');

    const ok = await repo.setUserActive(db, ctx.params.id, false);
    if (!ok) throw ApiError.notFound('Пользователь не найден');
    const closed = await revokeSessions(db, ctx.params.id);
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Учётная запись отключена', entity: 'user',
      entityId: ctx.params.id, detail: `закрыто сеансов: ${closed}`,
    });
    return { ok: true };
  });

  router.post('/api/v1/users/:id/enable', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const ok = await repo.setUserActive(db, ctx.params.id, true);
    if (!ok) throw ApiError.notFound('Пользователь не найден');
    // Самостоятельная регистрация представителя известной организации подтверждена ДИТ.
    const approved = await db.one<{ email: string }>(
      `UPDATE users SET registration_pending = false WHERE id = $1 AND registration_pending RETURNING email`, [ctx.params.id]);
    if (approved) {
      await notify(db, [approved.email], {
        eventKey: 'registration_approved', subject: 'Доступ к системе открыт',
        body: 'Ваша регистрация в системе заявок АО «Казтелерадио» подтверждена. Войдите с почтой и паролем, указанными при регистрации.',
        payload: { userId: ctx.params.id },
      });
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: approved ? 'Регистрация подтверждена, учётная запись включена' : 'Учётная запись включена',
      entity: 'user', entityId: ctx.params.id, detail: approved?.email ?? '',
    });
    return { ok: true };
  });

  /**
   * Массовый импорт из кадровой выгрузки (CSV). Сначала — предпросмотр
   * (`apply: false`): каждая строка проверяется так же, как ручная форма.
   * Применение записывает только корректные строки, в одной транзакции.
   */
  router.post('/api/v1/users/import', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ csv?: string; apply?: boolean }>();
    const csv = String(body.csv ?? '');
    if (!csv.trim()) throw ApiError.badRequest('Вставьте содержимое CSV-файла');

    const { records, missing } = csvRecords(csv, IMPORT_COLUMNS);
    const required = missing.filter((k) => ['email', 'fullName', 'roles'].includes(k));
    if (required.length) {
      throw ApiError.badRequest('В файле нет обязательных колонок',
        Object.fromEntries(required.map((k) => [k, `Колонка «${IMPORT_COLUMNS[k as keyof typeof IMPORT_COLUMNS][0]}» не найдена`])));
    }
    if (records.length > MAX_IMPORT_ROWS) {
      throw ApiError.badRequest(`Слишком много строк: ${records.length}. За один раз — не более ${MAX_IMPORT_ROWS}`);
    }

    const branches = await db.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM branches`);
    const byBranch = new Map<string, string>();
    for (const b of branches) {
      byBranch.set(b.code.toLowerCase(), b.id);
      byBranch.set(b.name.toLowerCase(), b.id);
    }
    const bins = [...new Set(records.map((r) => r.bin).filter(Boolean))];
    const cps = bins.length
      ? await db.query<{ id: string; bin: string }>(`SELECT id, bin FROM counterparties WHERE bin = ANY($1::text[])`, [bins])
      : [];
    const byBin = new Map(cps.map((c) => [c.bin, c.id]));
    const existing = new Set((await db.query<{ email: string }>(`SELECT email FROM users`)).map((u) => u.email));

    const seen = new Set<string>();
    const rows = records.map((r) => {
      const branchId = r.branch ? byBranch.get(r.branch.toLowerCase()) ?? null : null;
      const counterpartyId = r.bin ? byBin.get(r.bin) ?? null : null;
      const { user, fields } = checkUser({
        email: r.email, fullName: r.fullName, position: r.position, department: r.department,
        roles: parseRoles(r.roles), branchId, counterpartyId,
      }, actor);
      if (r.branch && !branchId) fields.branchId = `Филиал «${r.branch}» не найден в справочнике`;
      if (r.bin && !counterpartyId) fields.counterpartyId = `Организация с БИН ${r.bin} не найдена`;
      if (user.email && seen.has(user.email)) fields.email = 'Адрес повторяется в файле';
      seen.add(user.email);
      return {
        line: r.line, user, errors: fields,
        action: Object.keys(fields).length ? 'skip' : existing.has(user.email) ? 'update' : 'create',
      };
    });

    const valid = rows.filter((r) => r.action !== 'skip');
    const summary = {
      total: rows.length, create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length, skip: rows.length - valid.length,
    };
    if (body.apply !== true) return { preview: true, summary, rows };

    await db.tx(async (t) => {
      for (const r of valid) await repo.upsertUser(t, r.user);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Импорт учётных записей', entity: 'user', entityId: 'import',
        detail: `создано ${summary.create}, обновлено ${summary.update}, пропущено с ошибками ${summary.skip}`,
      });
    });
    return { preview: false, summary, rows };
  });
}
