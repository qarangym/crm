/**
 * Генерация SQL с конфигурацией процесса из кода.
 *
 * Определения этапов, переходов и правил живут в `src/process` как источник
 * истины и покрыты тестами. Этот скрипт переносит их в таблицы конфигурации,
 * чтобы код и база не разъезжались.
 *
 * Запуск: npm run seed:sql > src/db/002_config.sql
 */

import { STAGES } from '../src/process/stages.ts';
import { TRANSITIONS } from '../src/process/transitions.ts';
import { AUTOMATION_RULES } from '../src/process/rules.ts';

const q = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'NULL' : `'${value.replace(/'/g, "''")}'`;

const lines: string[] = [];

lines.push('-- Конфигурация процесса. Файл сгенерирован: npm run seed:sql');
lines.push('-- Источник истины — src/process/{stages,transitions,rules}.ts (покрыты тестами).');
lines.push('-- Править вручную не нужно: изменения вносятся в код либо администратором в интерфейсе.');
lines.push('');
lines.push('BEGIN;');
lines.push('');

lines.push('-- Этапы обработки заявки. Норматив и ответственная сторона — из Регламента.');
lines.push(
  'INSERT INTO stage_definitions (code, sort_order, name, short_name, sla_value, sla_unit, sla_text, owner_party, service_scope, customer_status, is_terminal, regulation_ref, hint) VALUES',
);
lines.push(
  STAGES.map(
    (s) =>
      `  (${q(s.code)}, ${s.order}, ${q(s.name)}, ${q(s.short)}, ${s.slaValue}, ${q(s.slaUnit)}, ${q(s.slaText)}, ` +
      `${q(s.ownerParty)}, ${q(s.serviceScope ?? null)}, ${q(s.customerStatus)}, ${s.terminal}, ${q(s.regulationRef)}, ${q(s.hint)})`,
  ).join(',\n'),
);
lines.push('ON CONFLICT (code) DO UPDATE SET');
lines.push('  sort_order = excluded.sort_order, name = excluded.name, short_name = excluded.short_name,');
lines.push('  sla_value = excluded.sla_value, sla_unit = excluded.sla_unit, sla_text = excluded.sla_text,');
lines.push('  owner_party = excluded.owner_party, service_scope = excluded.service_scope,');
lines.push('  customer_status = excluded.customer_status, is_terminal = excluded.is_terminal,');
lines.push('  regulation_ref = excluded.regulation_ref, hint = excluded.hint;');
lines.push('');

lines.push('-- Допустимые переходы. Условия проверяются движком по ключу guard_key.');
lines.push('INSERT INTO stage_transitions (from_code, to_code, title, guard_key, roles, regulation_ref) VALUES');
lines.push(
  TRANSITIONS.map((t) => {
    const guardKey = `${t.from}__${t.to}`;
    const roles = `ARRAY[${t.roles.map((r) => q(r)).join(', ')}]::varchar(24)[]`;
    return `  (${q(t.from)}, ${q(t.to)}, ${q(t.title)}, ${q(guardKey)}, ${roles}, ${q(t.regulationRef)})`;
  }).join(',\n'),
);
lines.push('ON CONFLICT (from_code, to_code) DO UPDATE SET');
lines.push('  title = excluded.title, guard_key = excluded.guard_key,');
lines.push('  roles = excluded.roles, regulation_ref = excluded.regulation_ref;');
lines.push('');

lines.push('-- Правила автоматизации. Каждое несёт ссылку на пункт Регламента.');
lines.push('INSERT INTO automation_rules (id, trigger_key, event_title, action_key, description, regulation_ref, timer_days, enabled) VALUES');
lines.push(
  AUTOMATION_RULES.map(
    (r) =>
      `  (${r.id}, ${q(r.trigger)}, ${q(r.event)}, ${q(r.action)}, ${q(r.description)}, ` +
      `${q(r.regulationRef)}, ${r.timerDays ?? 'NULL'}, ${r.enabled})`,
  ).join(',\n'),
);
lines.push('ON CONFLICT (id) DO UPDATE SET');
lines.push('  trigger_key = excluded.trigger_key, event_title = excluded.event_title,');
lines.push('  action_key = excluded.action_key, description = excluded.description,');
lines.push('  regulation_ref = excluded.regulation_ref, timer_days = excluded.timer_days;');
lines.push('');

/**
 * Производственный календарь РК.
 * Праздничные дни установлены законодательством; переносы выходных ежегодно
 * определяются постановлением Правительства, а Курбан-айт — по лунному календарю.
 * Поэтому здесь только фиксированные даты: остальное вносит администратор ДИТ.
 */
const FIXED_HOLIDAYS: [month: number, day: number, title: string][] = [
  [1, 1, 'Новый год'],
  [1, 2, 'Новый год'],
  [1, 7, 'Рождество'],
  [3, 8, 'Международный женский день'],
  [3, 21, 'Наурыз мейрамы'],
  [3, 22, 'Наурыз мейрамы'],
  [3, 23, 'Наурыз мейрамы'],
  [5, 1, 'Праздник единства народа Казахстана'],
  [5, 7, 'День защитника Отечества'],
  [5, 9, 'День Победы'],
  [7, 6, 'День столицы'],
  [8, 30, 'День Конституции'],
  [10, 25, 'День Республики'],
  [12, 16, 'День Независимости'],
];

const calendarRows: string[] = [];
for (const year of [2026, 2027]) {
  for (const [month, day, title] of FIXED_HOLIDAYS) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    calendarRows.push(`  (${q(iso)}, 'holiday', ${q(title)})`);
  }
}

lines.push('-- Производственный календарь: фиксированные праздничные дни РК.');
lines.push('-- Переносы выходных и Курбан-айт вносит администратор ДИТ ежегодно.');
lines.push('INSERT INTO calendar_days (day, kind, source) VALUES');
lines.push(calendarRows.join(',\n'));
lines.push('ON CONFLICT (day) DO UPDATE SET kind = excluded.kind, source = excluded.source;');
lines.push('');

lines.push('-- Настройки, вынесенные из кода.');
lines.push('INSERT INTO settings (key, value, description, regulation_ref) VALUES');
lines.push(
  [
    `  ('capacity_warning_threshold', 'null'::jsonb, 'Порог «приближения к предельным значениям» для поверочного расчёта. Регламентом не установлен, в Приложении 8 помечен [ЗАПОЛНИТЬ] — система собственного значения не задаёт, решение принимает инженер ОР ПСД.', 'п. 16.4')`,
    `  ('psd_max_extension_days', '15'::jsonb, 'Максимальное продление разработки ПСД в рабочих днях.', 'п. 33')`,
    `  ('offer_validity_days', '10'::jsonb, 'Срок оферты в рабочих днях: по истечении заявка закрывается.', 'табл. 1')`,
    `  ('avr_silence_days', '10'::jsonb, 'Молчание Заказчика по АВР, после которого работы считаются принятыми.', 'п. 94')`,
    `  ('equipment_delivery_days', '90'::jsonb, 'Предоставление оборудования Заказчиком, календарные дни.', 'п. 55')`,
    `  ('equipment_reminder_days', '10'::jsonb, 'За сколько календарных дней направляется напоминание Заказчику.', 'п. 56')`,
    `  ('memo_answer_days', '3'::jsonb, 'Срок ответа филиала на служебную записку, рабочие дни.', 'п. 10')`,
    `  ('escalation_level2_days', '2'::jsonb, 'Через сколько рабочих дней после нарушения срока поднимается второй уровень эскалации.', 'п. 100')`,
    `  ('act_default_form', '"2В"'::jsonb, 'Форма акта выполненных работ по умолчанию.', 'п. 70')`,
    `  ('registry_mode', '"derived_copy"'::jsonb, 'Режим ведения реестра АМС: leading_resource — система признана единым сетевым ресурсом ЦА; derived_copy — мастер-файл остаётся ведущим.', 'пп. 12, 15')`,
  ].join(',\n'),
);
lines.push('ON CONFLICT (key) DO UPDATE SET');
lines.push('  value = excluded.value, description = excluded.description, regulation_ref = excluded.regulation_ref;');
lines.push('');
lines.push('COMMIT;');

console.log(lines.join('\n'));
