/**
 * Тексты писем в справочнике (А5): ОР ПСД и СУА правят тему и текст писем сами,
 * без разработчика. Шаблон оборачивает стандартный текст системы:
 *
 *   {{тема}}   — стандартная тема письма;
 *   {{текст}}  — стандартный текст письма (сведения заявки, сроки, пункты);
 *   {{номер}}  — номер заявки, если он есть в письме; прочие поля письма — по имени.
 *
 * Выключенный шаблон не меняет письма. Каждое изменение — в журнале.
 */

import type { Db } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

/** Виды писем системы — для справочника; новые ключи без названия показываются как есть. */
export const EVENT_NAMES: Record<string, string> = {
  request_submitted: 'Заявка подана (Заказчику)', request_registered_branch: 'Заявка направлена в филиал (п. 6)',
  request_returned: 'Заявка возвращена на доработку', request_resubmitted: 'Заявка исправлена Заказчиком',
  offer_sent: 'Коммерческое предложение и договор', offer_expired: 'Оферта истекла', payment_reminder: 'Напоминание об оплате (п. 88)',
  payment_received: 'Оплата поступила', invoice_requested: 'Запрос счёта', tu_sent_branch: 'ТУ — в филиал',
  smr_paid_branch: 'Оплата СМР — служебная записка в филиал (п. 54)', smr_paused: 'СМР приостановлены',
  smr_claim: 'Претензия по оборудованию (пп. 56–57)', equipment_reminder: 'Напоминание о предоставлении оборудования (п. 55)',
  avr_sent: 'АВР направлен Заказчику', avr_accepted_by_silence: 'АВР принят по молчанию (п. 94)',
  avr_formation_overdue: 'Просрочено оформление АВР и ЭСФ (п. 91)', tavr_refused: 'Отказ от подписания технического АВР',
  technical_avr_approved: 'Технический АВР подписан', transfer_act_approved: 'Акт приёма-передачи завизирован',
  act_awaiting_approval: 'Документ ждёт визы', document_expiring: 'Истекает срок действия документа (пп. 31, 47)',
  psd_control_point: 'Контрольная точка ПСД (п. 34.1)', psd_deadline_near: 'Предложение продлить ПСД (п. 33)',
  psd_conditions_expired: 'Условия ПСД устарели (п. 47)', refund_requested: 'Возврат средств',
  memo_sent: 'Служебная записка в филиал (п. 10)', memo_answered: 'Ответ филиала на служебную записку',
  assignment_created: 'Поручение', assignment_created_oko: 'Поручение — копия ОКО', executor_assigned: 'Назначен исполнитель',
  executor_missing: 'Некого назначить исполнителем', escalation_level_1: 'Эскалация 1-го уровня (п. 100)',
  escalation_level_1_copy: 'Эскалация 1-го уровня — копия', escalation_level_2: 'Эскалация 2-го уровня (п. 100)',
  branch_report_due: 'Отчёт филиала за месяц (п. 105)', annual_report_due: 'Сводный отчёт за год (пп. 107, 109)',
  registry_change_requested: 'Запрос изменения реестра АМС', registry_change_resolved: 'Реестр АМС изменён',
  registration_pending: 'Регистрация ждёт подтверждения ДИТ', registration_approved: 'Регистрация подтверждена',
  access_request_submitted: 'Допуски: новая заявка — СУА', access_branch_approval: 'Допуски: согласование филиала (пп. 8, 14, 18)',
  access_branch_decided: 'Допуски: решение филиала', access_request_approved: 'Допуски: допуск выдан — организации',
  access_request_approved_branch: 'Допуски: копия ответа филиалу (п. 15)', access_emergency_finalized: 'Допуски: аварийный допуск оформлен (п. 18)',
  access_request_rejected: 'Допуски: заявка отклонена', access_request_withdrawn: 'Допуски: заявка отозвана организацией',
  access_permit_revoked: 'Допуски: допуск отозван', access_permit_closed: 'Допуски: работы завершены',
  access_review_overdue: 'Допуски: просрочено рассмотрение (п. 14)', access_branch_overdue: 'Допуски: не согласовано филиалом в срок',
  access_followup_overdue: 'Допуски: аварийный допуск не оформлен (п. 18)', access_permit_ending: 'Допуски: допуск заканчивается (п. 19)',
  worker_document_expiring: 'Допуски: истекает документ работника', lease_expiring: 'Допуски: истекает договор аренды',
};

type Template = { subject: string; body: string; enabled: boolean };

/** Подстановка: {{ключ}} — значение, неизвестный ключ остаётся пустым. */
export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Тема и текст письма с учётом шаблона из справочника. */
export async function applyTemplate(
  db: Db, eventKey: string, subject: string, body: string, payload: Record<string, unknown> = {},
): Promise<{ subject: string; body: string }> {
  const t = await db.one<Template>(`SELECT subject, body, enabled FROM mail_templates WHERE event_key = $1`, [eventKey]);
  if (!t || !t.enabled) return { subject, body };
  const number = /\b(З[КД]-\d{4}-\d{4})\b/.exec(`${subject} ${body}`)?.[1] ?? '';
  const vars: Record<string, unknown> = { ...payload, тема: subject, текст: body, subject, body, номер: number };
  return {
    subject: render(t.subject, vars).trim().slice(0, 255) || subject,
    body: render(t.body, vars).trim() || body,
  };
}

export function registerTemplateRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;
  const canEdit = (a: rbac.Actor) => a.roles.some((r) => ['admin', 'orpsd', 'permits'].includes(r)) && !rbac.isExternal(a);

  router.get('/api/v1/mail-templates', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!canEdit(actor)) throw ApiError.forbidden();
    const [templates, seen] = await Promise.all([
      db.query<Record<string, any>>(
        `SELECT t.event_key, t.subject, t.body, t.enabled, t.updated_at, u.full_name AS updated_by
           FROM mail_templates t LEFT JOIN users u ON u.id = t.updated_by`),
      db.query<{ event_key: string; subject: string; body: string }>(
        `SELECT DISTINCT ON (event_key) event_key, subject, payload->>'body' AS body FROM notifications
          WHERE channel = 'email' ORDER BY event_key, created_at DESC`),
    ]);
    const keys = [...new Set([...Object.keys(EVENT_NAMES), ...seen.map((s) => s.event_key)])];
    return {
      events: keys.map((key) => {
        const t = templates.find((x) => x.event_key === key);
        const sample = seen.find((x) => x.event_key === key);
        return {
          key, name: EVENT_NAMES[key] ?? key, template: t ?? null,
          sample: sample ? { subject: sample.subject, body: (sample.body ?? '').slice(0, 4000) } : null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    };
  });

  router.post('/api/v1/mail-templates/:key', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    if (!canEdit(actor)) throw ApiError.forbidden();
    const key = ctx.params.key;
    if (!/^[a-z0-9_]{3,64}$/.test(key)) throw ApiError.badRequest('Неизвестный вид письма');
    const body = await ctx.body<{ subject?: string; body?: string; enabled?: boolean; reset?: boolean }>();
    if (body.reset) {
      await db.query(`DELETE FROM mail_templates WHERE event_key = $1`, [key]);
    } else {
      const subject = String(body.subject ?? '').trim().slice(0, 255);
      const text = String(body.body ?? '').trim().slice(0, 20000);
      const fields: Record<string, string> = {};
      if (!subject) fields.subject = 'Укажите тему; стандартная — {{тема}}';
      if (!text) fields.body = 'Укажите текст; стандартный — {{текст}}';
      if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте шаблон', fields);
      await db.query(
        `INSERT INTO mail_templates (event_key, subject, body, enabled, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (event_key) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, enabled = EXCLUDED.enabled,
           updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, subject, text, body.enabled !== false, actor.id]);
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: body.reset ? 'Восстановлен стандартный текст письма' : 'Изменён текст письма',
      entity: 'mail_template', entityId: key, detail: EVENT_NAMES[key] ?? key,
    });
    return { ok: true };
  });
}
