/**
 * Выгрузка конфигурации процесса для дизайн-прототипа.
 * Интерфейс рисуется по тем же данным, что проверены тестами, — этапы,
 * нормативы, ответственные стороны и ссылки на пункты Регламента не
 * дублируются вручную в разметке.
 *
 * Запуск: node --experimental-strip-types seed/emit-ui-config.ts > design/config.js
 */

import { STAGES } from '../src/process/stages.ts';
import { TRANSITIONS } from '../src/process/transitions.ts';
import { AUTOMATION_RULES } from '../src/process/rules.ts';
import { OWNER_PARTY_NAME, CUSTOMER_STATUS_NAME, SERVICE_NAME } from '../src/domain/types.ts';

const payload = {
  stages: STAGES.map((s) => ({
    code: s.code,
    order: s.order,
    name: s.name,
    short: s.short,
    slaValue: s.slaValue,
    slaUnit: s.slaUnit,
    slaText: s.slaText,
    ownerParty: s.ownerParty,
    ownerName: OWNER_PARTY_NAME[s.ownerParty],
    serviceScope: s.serviceScope ?? null,
    customerStatus: s.customerStatus,
    customerStatusName: CUSTOMER_STATUS_NAME[s.customerStatus],
    terminal: s.terminal,
    regulationRef: s.regulationRef,
    hint: s.hint,
  })),
  transitions: TRANSITIONS.map((t) => ({
    from: t.from,
    to: t.to,
    title: t.title,
    roles: t.roles,
    regulationRef: t.regulationRef,
  })),
  rules: AUTOMATION_RULES.map((r) => ({
    id: r.id,
    event: r.event,
    description: r.description,
    regulationRef: r.regulationRef,
    timerDays: r.timerDays ?? null,
    enabled: r.enabled,
  })),
  ownerParties: OWNER_PARTY_NAME,
  services: SERVICE_NAME,
};

console.log('/* Сгенерировано: node --experimental-strip-types seed/emit-ui-config.ts */');
console.log(`window.QTR_CONFIG = ${JSON.stringify(payload, null, 2)};`);
