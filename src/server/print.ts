/**
 * Печатные формы ОР ПСД (А4): документ печатается из карточки без повторного
 * ввода того, что уже есть в системе.
 *
 *  - карточка заявки с регистрационным номером — для канцелярии и дела (п. 6);
 *  - проект технических условий по Приложениям 1–5 Регламента (пп. 22–26):
 *    сведения заявки и объекта подставлены, требования и мероприятия инженер
 *    дописывает на странице перед печатью;
 *  - технический акт выполненных работ филиала по Приложению 6 (п. 66).
 */

import * as repo from '../db/repo.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { dmy, html, localStamp, printPage, sendHtml } from './printing.ts';

const PLACEMENT_NAME: Record<string, string> = {
  ams: 'размещение оборудования на АМС', room: 'размещение оборудования в помещении', network: 'присоединение к сети телерадиовещания',
  cable: 'прокладка кабеля', power: 'подключение электроснабжения',
};

/** Приложение Регламента по сценарию размещения: 1 — канал, 2/3 — кабель, 4 — электроснабжение, 5 — размещение. */
export function tuForm(placement: string, requested: number | null): number {
  if (requested && requested >= 1 && requested <= 5) return requested;
  return ({ network: 1, cable: 2, power: 4, ams: 5, room: 5 } as Record<string, number>)[placement] ?? 5;
}

const POWER_ROWS = [
  'Точка подключения (места подключения к существующей сети (сущ. шкаф, опора, КТП и т. д.))',
  'Соответствие мощности (наличие свободной мощности для подключения оборудования Заказчика либо проведение необходимых мероприятий по усилению сети)',
  'Проектирование заземления (обязательное выполнение контура заземления с измерением сопротивления и оформлением протоколов)',
  'Учет электроэнергии (установка прибора учета, согласованного с энергоснабжающей организацией, с предоставлением паспорта счетчика)',
  'Исполнительная документация (подготовка полного пакета ИТД (протоколы замеров, акты, схемы, приказы и т. д.))',
  'Раздел балансовой принадлежности (оформление акта разграничения ответственности между АО «Казтелерадио» и Заказчиком)',
  'Соответствие нормативам (выполнение всех работ по ПУЭ, СНиП, ГОСТ и другим действующим требованиям)',
  'Согласование с энергоснабжающей организацией (подтверждение технических условий)',
  'Дополнительно',
];
const PLACEMENT_ROWS = [
  'Место размещения', 'Условия установки', 'Подключение к электросети',
  'Проектирование заземления (обязательное выполнение контура заземления с измерением сопротивления и оформлением протоколов)',
  'Учет электроэнергии (установка прибора учета, согласованного с энергоснабжающей организацией, с предоставлением паспорта счетчика)',
  'Кабельные подключения',
  'Раздел балансовой принадлежности (оформление акта разграничения ответственности между АО «Казтелерадио» и Заказчиком)',
  'Соответствие нормативам (выполнение всех работ по ПУЭ, СНиП, ГОСТ и другим действующим требованиям)',
  'Согласование', 'Дополнительно',
];

export function registerPrintRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  async function load(ctx: Parameters<RouteDeps['actor']>[0], staffOnly: boolean) {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.view');
    if (staffOnly && rbac.isExternal(actor)) throw ApiError.forbidden('Форма готовится сотрудниками Общества');
    const request = await deps.loadVisible(actor, ctx.params.id);
    const [services, cp, facility] = await Promise.all([
      repo.listRequestServices(db, request.uuid) as Promise<Record<string, any>[]>,
      db.one<Record<string, any>>(`SELECT bin, name_full, legal_address, actual_address, contact_person, phone, email FROM counterparties WHERE id = $1`,
        [request.counterpartyId]),
      request.facilityId ? db.one<Record<string, any>>(
        `SELECT f.inv_no, f.name, f.address, f.kind, f.height_m, b.name AS branch_name FROM facilities f
           JOIN branches b ON b.id = f.branch_id WHERE f.id = $1`, [request.facilityId]) : null,
    ]);
    return { actor, request, services, cp: cp ?? {}, facility };
  }

  async function logPrint(ctx: Parameters<RouteDeps['actor']>[0], actor: rbac.Actor, requestId: string, what: string, ref: string) {
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: `Печать: ${what}`, entity: 'request', entityId: requestId, detail: what, regulationRef: ref,
    });
  }

  /** Карточка заявки с регистрационными реквизитами — для канцелярии и дела (п. 6). */
  router.get('/api/v1/requests/:id/print/card', async (ctx) => {
    const { actor, request: r, services, cp, facility } = await load(ctx, false);
    const body = `<p class="r">АО «Казтелерадио»</p>
<h1>Заявка № ${html(r.number)}</h1>
<p class="c">Вх. № ${html(r.incomingNumber ?? '______')} от ${dmy(r.incomingDate)}${r.registrationConfirmedAt ? ` · регистрация подтверждена ${localStamp(r.registrationConfirmedAt)}${r.registrationConfirmedBy ? ', ' + html(r.registrationConfirmedBy) : ''}` : ' · регистрация не подтверждена канцелярией'}</p>
<table><tbody>
<tr><th style="width:30%">Заявитель</th><td>${html(cp.name_full)}, БИН ${html(cp.bin)}<br>${html(cp.legal_address || cp.actual_address || '')}</td></tr>
<tr><th>Контактное лицо</th><td>${html(cp.contact_person)} · ${html(cp.phone)} · ${html(cp.email)}</td></tr>
<tr><th>Объект</th><td>${facility ? `${html(facility.name)}, инв. № ${html(facility.inv_no)}, ${html(facility.address)}` : html(r.facilityAddress ?? '')}</td></tr>
<tr><th>Филиал</th><td>${html(r.branchName ?? '')}</td></tr>
<tr><th>Дата подачи</th><td>${localStamp(r.createdAt)}</td></tr>
<tr><th>Ответственный ОР ПСД</th><td>${html(r.responsibleName ?? '')}</td></tr>
</tbody></table>
<h2>Запрошенные услуги</h2>
<table><thead><tr><th>Услуга</th><th>Сценарий</th><th>Состав и объём работ, параметры</th></tr></thead><tbody>
${services.map((s) => `<tr><td>${html(s.service)}</td><td>${html(PLACEMENT_NAME[s.placement] ?? s.placement)}</td>
<td>${html(s.params?.scope ?? '')}${paramsLine(s.params)}</td></tr>`).join('')}
</tbody></table>
<div class="sign"><div>Принял (канцелярия)<div class="line"></div></div><div>Дата, подпись<div class="line"></div></div></div>`;
    await logPrint(ctx, actor, r.uuid, 'карточка заявки', 'п. 6');
    return sendHtml(ctx, printPage(`Заявка ${r.number}`, body));
  });

  /** Проект ТУ по Приложениям 1–5 Регламента (пп. 22–26). */
  router.get('/api/v1/requests/:id/print/tu', async (ctx) => {
    const { actor, request: r, services, cp, facility } = await load(ctx, true);
    rbac.require(actor, 'request.edit');
    const tu = services.find((s) => s.service === 'ТУ') ?? services[0];
    if (!tu) throw ApiError.notFound('В заявке нет услуг');
    const form = tuForm(tu.placement, Number(ctx.query.get('form')) || null);
    const p = tu.params ?? {};
    const object = facility ? `${facility.name}, инв. № ${facility.inv_no}` : r.facilityAddress ?? '';
    const head = `<table><tbody>
<tr><th style="width:30%">Наименование работ</th><td class="edit">${html(p.scope ?? PLACEMENT_NAME[tu.placement] ?? '')}</td></tr>
<tr><th>Заказчик</th><td>${html(cp.name_full)}, БИН ${html(cp.bin)}</td></tr>
<tr><th>Основание</th><td class="edit">Заявка № ${html(r.number)}, вх. № ${html(r.incomingNumber ?? '')} от ${dmy(r.incomingDate)}</td></tr>
<tr><th>Филиал</th><td>${html(r.branchName ?? facility?.branch_name ?? '')}</td></tr>
<tr><th>Объект, адрес</th><td>${html(object)}; ${html(facility?.address ?? r.facilityAddress ?? '')}</td></tr>
${form !== 3 && form !== 1 ? '<tr><th>Проект</th><td class="edit">требуется / не требуется</td></tr>' : ''}
</tbody></table>`;
    const sign = `<div class="sign"><div>Представитель филиала<div class="line"></div></div><div>Ф.И.О., подпись, дата<div class="line"></div></div></div>
<p class="muted">Срок действия ТУ — не более 6 месяцев (п. 31 Регламента). Проект сформирован системой по данным заявки ${html(r.number)}.</p>`;
    let body = '';
    if (form === 1) {
      body = `<h1>ТЕХНИЧЕСКИЕ УСЛОВИЯ<br>Национального оператора телерадиовещания АО «Казтелерадио»<br>на присоединение технических средств теле-, радиоканала</h1>
<table><tbody>
<tr><th style="width:38%">Заказчик (телерадиокомпания)</th><td>${html(cp.name_full)}, БИН ${html(cp.bin)}</td></tr>
<tr><th>Наименование телерадиоканала</th><td class="edit">${html(p.channel ?? '')}</td></tr>
<tr><th>Наименование объекта — РТС, РТСМ, ЗС, ТЦ</th><td>${html(object)}</td></tr>
<tr><th>Почтовый адрес объекта</th><td>${html(facility?.address ?? r.facilityAddress ?? '')}</td></tr>
<tr><th>Информационная скорость</th><td class="edit">${p.bitrate ? html(p.bitrate) + ' Мбит/с' : ''}</td></tr>
<tr><th>Точка доведения сигнала теле-, радиоканала</th><td class="edit">${html(p.deliveryPoint ?? '')}</td></tr>
<tr><th>Тип сигнала</th><td class="edit">${html(p.signalType ?? '')}</td></tr>
<tr><th>Срок действия</th><td class="edit">6 месяцев</td></tr>
<tr><th>Дополнительно</th><td class="edit"></td></tr>
</tbody></table>${sign}`;
    } else if (form === 2 || form === 3) {
      const where = form === 2 ? 'по территории' : 'в помещении';
      body = `<h1>Технические условия № ТУ-<span class="edit">___</span> на прокладку кабеля ${where} на объекте АО «Казтелерадио»</h1>${head}
<table><thead><tr><th rowspan="2">№</th><th rowspan="2">Марка, сечение</th><th colspan="2">Трасса (маршрут, протяжённость)</th>
<th colspan="2">Способ прокладки, м</th><th rowspan="2">Крепление, шт.</th><th rowspan="2">Примечание</th></tr>
<tr><th>начало</th><th>конец</th><th>открытая</th><th>скрытая</th></tr></thead><tbody>
<tr><td class="c">1</td><td class="edit"></td><td class="edit">${html(p.route ?? '')}</td><td class="edit"></td><td class="edit">${p.length ? html(p.length) : ''}</td><td class="edit"></td><td class="edit"></td><td class="edit"></td></tr>
<tr><td class="c">2</td><td class="edit"></td><td class="edit"></td><td class="edit"></td><td class="edit"></td><td class="edit"></td><td class="edit"></td><td class="edit"></td></tr>
</tbody></table>
<p class="muted">Общая трасса может быть разбита на отдельные участки в зависимости от условий и удобства проведения монтажных работ.
В примечании указать проектируемые конструкции (при необходимости).</p>${sign}`;
    } else {
      const rows = form === 4 ? POWER_ROWS : PLACEMENT_ROWS;
      const hint: Record<number, string> = form === 4
        ? { 1: p.power ? `Потребляемая мощность оборудования: ${p.power} кВт` : '' }
        : { 0: `${p.equipment ?? ''}${p.quantity ? `, ${p.quantity} шт.` : ''}${p.height ? `, высота ${p.height} м` : ''}${p.area ? `, ${p.area} м²` : ''}`,
          2: p.power ? `${p.power} кВт` : '' };
      body = `<h1>Технические условия № ТУ-<span class="edit">___</span> на ${form === 4 ? 'подключение электроснабжения оборудования от сетей' : 'размещение оборудования на объекте'} АО «Казтелерадио»</h1>${head}
<table><thead><tr><th style="width:5%">№</th><th style="width:47%">Требования</th><th>Мероприятия</th></tr></thead><tbody>
${rows.map((row, i) => `<tr><td class="c">${i + 1}</td><td>${html(row)}</td><td class="edit">${html(hint[i] ?? '')}</td></tr>`).join('')}
</tbody></table>${sign}`;
    }
    await logPrint(ctx, actor, r.uuid, `проект ТУ по Приложению ${form}`, 'пп. 22–26, Прил. 1–5');
    return sendHtml(ctx, printPage(`ТУ · ${r.number}`, body));
  });

  /** Технический АВР филиала по Приложению 6 (п. 66). */
  router.get('/api/v1/requests/:id/print/avr', async (ctx) => {
    const { actor, request: r, services, cp, facility } = await load(ctx, true);
    const smr = services.find((s) => s.service === 'СМР');
    const contract = await db.one<{ number: string; signed_at: string | null }>(
      `SELECT number, signed_at::text FROM contracts WHERE request_id = $1 AND (service = 'СМР' OR service IS NULL)
        AND status <> 'terminated' ORDER BY created_at DESC LIMIT 1`, [r.uuid]);
    const body = `<div class="r">УТВЕРЖДАЮ<br><span class="edit">Директор</span> ${html(r.branchName ?? '')}<br>________________ <span class="edit">Ф.И.О.</span><br>«___» __________ 20__ г.</div>
<h1>АКТ выполненных работ</h1>
<p class="c">на основании: <span class="edit">${contract ? `договора № ${html(contract.number)}${contract.signed_at ? ' от ' + dmy(contract.signed_at) : ''}` : `заявки № ${html(r.number)}`}</span></p>
<p><span class="edit">${html(facility?.address ?? r.facilityAddress ?? 'населённый пункт')}</span> · «___» __________ 20__ г.</p>
<p>Мы, нижеподписавшиеся: <span class="edit">__________________ (фамилия, инициалы, должность)</span>, <span class="edit">__________________</span>,
<span class="edit">__________________</span>, составили настоящий акт о нижеследующем:</p>
<p>1. Объект: ${html(facility ? `${facility.name}, инв. № ${facility.inv_no}` : '')}. Заказчик: ${html(cp.name_full)}, БИН ${html(cp.bin)}.</p>
<p>2. Выполнены следующие работы:</p>
<table><thead><tr><th>№</th><th>Наименование работ</th><th>Кол-во</th><th>Ед. изм.</th></tr></thead><tbody>
<tr><td class="c">1</td><td class="edit">${html(smr?.params?.scope ?? '')}</td><td class="edit">${html(smr?.params?.quantity ?? '')}</td><td class="edit">${smr?.params?.quantity ? 'шт.' : ''}</td></tr>
<tr><td class="c">2</td><td class="edit"></td><td class="edit"></td><td class="edit"></td></tr>
</tbody></table>
<p>3. При выполнении работ отсутствуют (или допущены) отклонения от проектов/договоров/распоряжения: <span class="edit">отсутствуют</span></p>
<div class="sign"><div>Представитель филиала<div class="line"></div></div><div>Представитель филиала<div class="line"></div></div><div>Представитель Заказчика<div class="line"></div></div></div>`;
    await logPrint(ctx, actor, r.uuid, 'технический АВР', 'п. 66, Прил. 6');
    return sendHtml(ctx, printPage(`АВР · ${r.number}`, body));
  });
}

function paramsLine(p: Record<string, unknown> | null): string {
  if (!p) return '';
  const labels: Record<string, string> = {
    equipment: 'оборудование', quantity: 'кол-во, шт.', power: 'мощность, кВт', weight: 'масса, кг', windage: 'парусность, м²',
    height: 'высота, м', area: 'площадь, м²', length: 'длина, м', route: 'маршрут', channel: 'канал', signalType: 'тип сигнала',
    deliveryPoint: 'точка доведения', bitrate: 'скорость, Мбит/с', designTask: 'задание на проектирование',
  };
  const parts = Object.entries(labels).filter(([k]) => p[k] !== undefined && p[k] !== null && p[k] !== '')
    .map(([k, label]) => `${label}: ${html(p[k])}`);
  return parts.length ? `<br><span class="muted">${parts.join('; ')}</span>` : '';
}
