/**
 * Портал допусков (docs/План_модуля_допусков.md; Инструкция о допуске сторонних
 * организаций на объекты АО «Казтелерадио»).
 *
 * Отдельная ссылка `/dopusk/` в той же системе: вход, учётные записи,
 * оформление и клиент API — общие с рабочим местом ОР ПСД.
 *
 * Подрядчик: мастер заявки (Цель и объект → Основание → Период → Бригада →
 * Транспорт → Запрос → Проверка), «Мои заявки», работники по Приложению 1,
 * удостоверения, паспорта и визы, транспорт, бригады; отзыв заявки, продление
 * допуска (п. 19), досылка запроса при аварии (п. 18).
 * СУА: очередь со сроком 14 рабочих дней (п. 14), карточка, ручное подтверждение
 * основания, отметка согласования филиала, выдача допуска, отказ, отзыв допуска,
 * оформление аварийного допуска; действующие допуски, договоры аренды, отчёт, настройки.
 * Филиал: согласование (пп. 8, 14, 18), проверка на объекте — инструктаж, СИЗ,
 * документы (пп. 21–23), завершение работ.
 * Все проверки повторяются на сервере — интерфейс лишь подсказывает.
 */

const A = window.QTR_ASSETS;
const api = window.QTR_API;

/* --------------------------------- API --------------------------------- */

const P = {
  meta: () => api.call('GET', '/permits/meta'),
  requests: (params) => api.call('GET', '/permits/requests' + api.query(params)),
  request: (id) => api.call('GET', `/permits/requests/${id}`),
  create: (body) => api.call('POST', '/permits/requests', body),
  update: (id, body) => api.call('PATCH', `/permits/requests/${id}`, body),
  remove: (id) => api.call('POST', `/permits/requests/${id}/delete`, {}),
  copy: (id) => api.call('POST', `/permits/requests/${id}/copy`, {}),
  extend: (id) => api.call('POST', `/permits/requests/${id}/extend`, {}),
  check: (id) => api.call('POST', `/permits/requests/${id}/check`, {}),
  submit: (id, body) => api.call('POST', `/permits/requests/${id}/submit`, body),
  withdraw: (id, body) => api.call('POST', `/permits/requests/${id}/withdraw`, body),
  basisFile: (id, form) => api.call('POST', `/permits/requests/${id}/basis-file`, form),
  basisFileDelete: (id) => api.call('POST', `/permits/requests/${id}/basis-file/delete`, {}),
  letterFile: (id, form) => api.call('POST', `/permits/requests/${id}/letter-file`, form),
  confirmBasis: (id, body) => api.call('POST', `/permits/requests/${id}/confirm-basis`, body),
  branchDecision: (id, body) => api.call('POST', `/permits/requests/${id}/branch-decision`, body),
  approve: (id, form) => api.call('POST', `/permits/requests/${id}/approve`, form),
  finalize: (id, form) => api.call('POST', `/permits/requests/${id}/finalize`, form),
  reject: (id, body) => api.call('POST', `/permits/requests/${id}/reject`, body),
  revoke: (id, body) => api.call('POST', `/permits/requests/${id}/revoke`, body),
  close: (id, body) => api.call('POST', `/permits/requests/${id}/close`, body),
  admit: (id, body) => api.call('POST', `/permits/requests/${id}/admissions`, body),
  left: (id, aid) => api.call('POST', `/permits/requests/${id}/admissions/${aid}/left`, {}),
  site: (params) => api.call('GET', '/permits/site' + api.query(params)),
  verify: (q) => api.call('GET', '/permits/verify' + api.query({ q })),
  basisOptions: (facilityId, ownerBin) => api.call('GET', '/permits/basis-options' + api.query({ facilityId, ownerBin })),
  workers: () => api.call('GET', '/permits/workers'),
  saveWorker: (body) => api.call('POST', '/permits/workers', body),
  deactivateWorker: (id) => api.call('POST', `/permits/workers/${id}/deactivate`, {}),
  workerDocument: (id, form) => api.call('POST', `/permits/workers/${id}/documents`, form),
  deleteWorkerDocument: (id, docId) => api.call('POST', `/permits/workers/${id}/documents/${docId}/delete`, {}),
  vehicles: () => api.call('GET', '/permits/vehicles'),
  saveVehicle: (body) => api.call('POST', '/permits/vehicles', body),
  deleteVehicle: (id) => api.call('POST', `/permits/vehicles/${id}/delete`, {}),
  crews: () => api.call('GET', '/permits/crews'),
  saveCrew: (body) => api.call('POST', '/permits/crews', body),
  deleteCrew: (id) => api.call('POST', `/permits/crews/${id}/delete`, {}),
  settings: () => api.call('GET', '/permits/settings'),
  saveSettings: (body) => api.call('POST', '/permits/settings', body),
  leases: (params) => api.call('GET', '/permits/leases' + api.query(params)),
  saveLease: (body) => api.call('POST', '/permits/leases', body),
  importLeases: (csv, apply) => api.call('POST', '/permits/leases/import', { csv, apply }),
  report: (params) => api.call('GET', '/permits/reports/requests' + api.query(params)),
  fileUrl: (fileId, requestId) => `${api.base}/permits/files/${fileId}` + api.query({ request: requestId, preview: 1 }),
  passUrl: (id) => `${api.base}/permits/requests/${id}/pass-file`,
  printUrl: (id, form) => `${api.base}/permits/requests/${id}/print/${form}`,
  reportUrl: (params) => `${api.base}/permits/reports/requests` + api.query(params),
};

/* -------------------------------- состояние -------------------------------- */

const state = {
  me: null, meta: null, view: '', loading: true, error: null,
  list: [], workers: [], vehicles: [], crews: [], report: null, settings: null, site: null, leases: [], verify: null,
};
const can = (permission) => !!state.me?.permissions?.includes(permission);
const isContractor = () => can('permit.own') && !!state.me?.counterpartyId;
const isCentral = () => can('permit.view') || can('permit.review');
const isAdmin = () => can('admin');
const isBranch = () => can('permit.branch') && !isAdmin();
const isStaff = () => !isContractor() && (isCentral() || can('permit.branch') || !!state.meta?.me?.pendingApprovals);

const MENU_CONTRACTOR = [
  ['new', 'Новая заявка', 'filePlus'], ['mine', 'Мои заявки', 'checks'], ['crews', 'Работники и бригады', 'users'],
];
const MENU_STAFF = [
  ['queue', 'Очередь на рассмотрение', 'clock'], ['approvals', 'Согласование филиала', 'shield'],
  ['site', 'Проверка на объекте', 'eye'], ['active', 'Действующие допуски', 'checks'], ['all', 'Все заявки', 'list'],
  ['leases', 'Договоры аренды', 'archive'], ['report', 'Отчёт', 'download'], ['settings', 'Настройки', 'sliders'],
];
const TITLES = {
  new: ['Заявка на допуск', 'Допуск персонала и техники на объект · Инструкция о допуске сторонних организаций'],
  mine: ['Мои заявки', 'Статус заявок, допуски, продление'],
  crews: ['Работники и бригады', 'Сведения по Приложению 1, удостоверения, транспорт и сохранённые бригады'],
  queue: ['Очередь на рассмотрение', 'Срочные — сверху; срок ответа — 14 рабочих дней (п. 14)'],
  approvals: ['Согласование филиала', 'АМС, изыскания, более 5 человек, аварийные работы, ночь и выходные (пп. 8, 14, 18)'],
  site: ['Проверка на объекте', 'Инструктаж, спецодежда, спецобувь, СИЗ и документы перед началом работ (пп. 21–23)'],
  active: ['Действующие допуски', 'Реестр допусков на дату'],
  all: ['Заявки на допуск', 'Все отправленные заявки с поиском'],
  leases: ['Договоры аренды', 'Основание допуска для ТО и ремонта; срок допуска не превышает срок договора (пп. 7, 13, 14)'],
  report: ['Отчёт по заявкам на допуск', 'Итоги за период и выгрузка в XLSX или CSV'],
  settings: ['Настройки портала допусков', 'Режим проверки оснований, сроки и пределы Инструкции'],
};

function viewAllowed(key) {
  if (MENU_CONTRACTOR.some(([k]) => k === key)) return isContractor();
  if (isContractor()) return false;
  switch (key) {
    case 'queue': return can('permit.review');
    case 'approvals': return can('permit.review') || can('permit.branch') || !!state.meta?.me?.pendingApprovals;
    case 'site': return can('permit.branch') || isAdmin();
    case 'active': case 'all': return isCentral() || can('permit.branch');
    case 'leases': case 'settings': return isCentral() || isAdmin();
    case 'report': return can('permit.view');
    default: return false;
  }
}

/* ------------------------------- форматы ------------------------------- */

const STATUS_CHIP = { draft: 'n', pending_review: 'w', approved: 'g', rejected: 'r', withdrawn: 'n', revoked: 'r', closed: 'n' };
const statusChip = (r) => `<span class="chip ${STATUS_CHIP[r.status] || 'n'}">${esc(r.provisional && r.status === 'approved' ? 'Аварийный допуск' : r.statusName || r.status)}</span>`;
const urgentChip = (r) => (r.workType === 'emergency' ? '<span class="chip r">Авария</span>' : r.isUrgent ? '<span class="chip r">Срочно</span>' : '');
const validityChip = (r) => ({ active: '<span class="chip g">действует</span>', upcoming: '<span class="chip b">ещё не начался</span>',
  expired: '<span class="chip n">срок истёк</span>' }[r.validity] || '');
const dt = (v) => (v ? `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)} ${v.slice(11, 16)}` : '—');
const ts = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const period = (r) => (r.periodStart ? `${dt(r.periodStart)} — ${dt(r.periodEnd)}` : '—');
const hours = (r) => `${r.workHoursFrom || '09:00'}–${r.workHoursTo || '18:00'}${r.weekendWork ? ', с выходными' : ''}`;
const dmy = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—');
const today = () => (state.meta?.now || new Date().toISOString()).slice(0, 10);
const daysTo = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86_400_000);
const country = (code) => state.meta?.countries?.[code] || code;

function dueChip(r) {
  if (r.status !== 'pending_review' || !r.reviewDueAt) return '';
  const left = daysTo(r.reviewDueAt);
  return `<span class="chip ${left < 0 ? 'r' : left <= 2 ? 'w' : 'n'}">${left < 0 ? 'просрочено' : 'до'} ${dmy(r.reviewDueAt)}</span>`;
}

function branchChip(r) {
  if (!r.branchApproval || r.branchApproval === 'not_required') return '';
  const kind = { pending: 'w', approved: 'g', rejected: 'r' }[r.branchApproval];
  return `<span class="chip ${kind}" title="${esc((r.branchReasons || []).map((x) => x.name).join('; '))}">филиал: ${esc(r.branchApprovalName)}</span>`;
}

/** Проверка основания: одна отметка для очереди и карточки. */
function basisChip(r) {
  const c = r.basisCheck || {};
  if (r.status === 'draft' || !r.basisType) return '';
  if (c.ok) return '<span class="chip g">подтверждено реестром</span>';
  if (r.basisConfirmedAt) return '<span class="chip g">подтверждено вручную</span>';
  if (c.needsConfirmation) return '<span class="chip w">нужна ручная проверка</span>';
  return '';
}

const DOC_KIND = { qualification: 'Удостоверение', passport: 'Паспорт', visa: 'Виза' };

/** Срок документа относительно даты начала работ (удостоверения) или окончания (паспорт, виза). */
function docChip(d, startDate, endDate) {
  const kind = d.kind || 'qualification';
  const ref = (kind === 'qualification' ? startDate : endDate || startDate) || today();
  if (d.validUntil < ref) return `<span class="chip r">до ${dmy(d.validUntil)} · ${kind === 'qualification' ? 'истекает до начала работ' : 'меньше срока работ'}</span>`;
  if (daysTo(d.validUntil) <= 30) return `<span class="chip w">до ${dmy(d.validUntil)}</span>`;
  return `<span class="chip g">до ${dmy(d.validUntil)}</span>`;
}

/** Чего не хватает в сведениях Приложения 1 — та же проверка, что на сервере. */
function appendixGaps(w) {
  const gaps = [];
  const resident = (w.citizenship || 'KZ') === 'KZ';
  if (!w.birth_date) gaps.push('дата рождения');
  if (!w.birth_place) gaps.push('место рождения');
  if (!w.id_doc_number) gaps.push(resident ? '№ удостоверения личности' : '№ паспорта');
  if (!w.id_doc_issued_at) gaps.push('дата выдачи');
  if (!w.id_doc_issued_by) gaps.push('кем выдан');
  if (!w.address) gaps.push('адрес');
  if (!resident && !w.documents.some((d) => d.kind === 'passport')) gaps.push('копия паспорта');
  if (!resident && !state.meta.cis.includes(w.citizenship) && !w.documents.some((d) => d.kind === 'visa')) gaps.push('копия визы');
  return gaps;
}

const emptyRow = (cols, text) =>
  `<tr><td colspan="${cols}" style="padding:22px;text-align:center;color:var(--muted-2)">${text}</td></tr>`;

/* ------------------------------- действия ------------------------------- */

async function act(button, fn, successText) {
  const label = button ? button.innerHTML : null;
  if (button) { button.disabled = true; button.innerHTML = 'Выполняется…'; }
  try {
    const result = await fn();
    if (successText) toast(successText, 'good');
    return result;
  } catch (error) {
    toast(describeError(error), 'bad');
    return null;
  } finally {
    if (button && button.isConnected) { button.disabled = false; button.innerHTML = label; }
  }
}

/**
 * Диалог с полями, включая файл, выбор и список отметок. Обязательные поля
 * проверяются до отправки. Возвращает значения или null.
 */
function dialog({ title, text = '', fields = [], ok = 'Сохранить', wide = false }) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'dlg';
    const input = (f) => {
      const id = 'pd-' + f.key;
      if (f.type === 'textarea') return `<textarea id="${id}" rows="${f.rows || 3}" placeholder="${esc(f.ph || '')}">${esc(f.value || '')}</textarea>`;
      if (f.type === 'file') return `<input id="${id}" type="file" accept="${f.accept || '.pdf,.png,.jpg,.jpeg'}">`;
      if (f.type === 'select') {
        return `<select id="${id}">${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      }
      if (f.type === 'checks') {
        return `<div class="pick-list" id="${id}" style="max-height:260px">${(f.options || []).map((o) => `<label>
          <input type="checkbox" value="${esc(o.value)}" ${(f.value || []).includes(o.value) ? 'checked' : ''}>
          <span>${esc(o.label)}${o.sub ? `<span class="sub">${o.sub}</span>` : ''}</span></label>`).join('')
          || '<div class="ref" style="padding:12px">Список пуст</div>'}</div>`;
      }
      if (f.type === 'checkbox') return `<label class="consent"><input id="${id}" type="checkbox" ${f.value ? 'checked' : ''}><span>${f.text || ''}</span></label>`;
      return `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.ph || '')}"
        ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>`;
    };
    box.innerHTML = `<div class="dlg-box" role="dialog" aria-modal="true" ${wide ? 'style="width:min(760px,96vw)"' : ''}>
      <header><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</header>
      <div class="body ${wide ? 'form-grid' : ''}">${fields.map((f) => `<div class="field ${f.span ? 'span2' : ''}" data-key="${f.key}" ${f.hidden ? 'hidden' : ''}>
        ${f.type === 'checkbox' ? '' : `<label>${esc(f.label)}${f.required ? '' : ' <span class="ref">необязательно</span>'}</label>`}${input(f)}
        ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}<div class="err"></div></div>`).join('')}</div>
      <footer><button class="btn" data-act="cancel">Отмена</button>
        <button class="btn primary" data-act="ok">${esc(ok)}</button></footer>
    </div>`;
    const close = (value) => { box.remove(); resolve(value); };
    const read = () => {
      const values = {};
      for (const f of fields) {
        const el = box.querySelector('#pd-' + f.key);
        if (f.type === 'file') values[f.key] = el.files[0] || null;
        else if (f.type === 'checks') values[f.key] = [...el.querySelectorAll('input:checked')].map((x) => x.value);
        else if (f.type === 'checkbox') values[f.key] = el.checked;
        else values[f.key] = el.value.trim();
      }
      return values;
    };
    box.addEventListener('change', () => {
      const values = read();
      for (const f of fields) {
        if (f.showIf) box.querySelector(`[data-key="${f.key}"]`).hidden = !f.showIf(values);
      }
    });
    box.addEventListener('click', (ev) => {
      const action = ev.target.closest('[data-act]')?.dataset.act;
      if (ev.target === box || action === 'cancel') close(null);
      if (action !== 'ok') return;
      const values = read();
      let bad = false;
      for (const f of fields) {
        if (f.showIf && !f.showIf(values)) continue;
        const value = values[f.key];
        const empty = value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
        const required = typeof f.required === 'function' ? f.required(values) : f.required;
        const problem = required && empty ? 'Заполните поле' : (f.check && !empty ? f.check(value, values) : '');
        const wrap = box.querySelector(`[data-key="${f.key}"]`);
        wrap.classList.toggle('bad', !!problem);
        wrap.querySelector('.err').textContent = problem || '';
        if (problem) bad = true;
      }
      if (!bad) close(values);
    });
    box.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(null); });
    document.body.appendChild(box);
    box.dispatchEvent(new Event('change'));
    box.querySelector('input:not([type=checkbox]),textarea,select')?.focus();
  });
}

/* -------------------------------- загрузка -------------------------------- */

async function boot() {
  document.getElementById('brandMark').src = A.mark;
  try {
    state.me = await api.me();
    mountDemoRibbon(state.me);
  } catch (error) {
    if (error.status === 401) return toLogin();
    return renderDenied(error.status === 0
      ? 'Сервер недоступен. Проверьте соединение и обновите страницу.'
      : error.message);
  }
  if (!(state.me.modules || []).includes('permits')) {
    return renderDenied('Портал допусков вашей учётной записи не назначен. Роли назначает ДИТ: «Подрядчик» — ' +
      'представителю сторонней организации, «СУА · допуски» — специалисту Службы управления активами, «Филиал» — ' +
      'сотрудникам филиала.');
  }
  try {
    state.meta = await P.meta();
  } catch (error) {
    return renderDenied(describeError(error));
  }
  mountBell(document.getElementById('bellHost'));
  const first = [...MENU_CONTRACTOR, ...MENU_STAFF].map(([k]) => k).find(viewAllowed);
  // Филиал без заявок на согласование начинает с проверки на объекте — это его ежедневная работа (пп. 20–23).
  const start = isContractor() ? 'mine' : state.meta.me.pendingApprovals ? 'approvals'
    : isBranch() && viewAllowed('site') ? 'site' : first;
  await go(start);
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

function openFromHash() {
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (/^ЗД-\d{4}-\d{4}$/.test(fromHash)) openCard(fromHash);
}

function renderDenied(message) {
  document.getElementById('nav').innerHTML = '';
  document.getElementById('title').textContent = 'Нет доступа';
  document.getElementById('view').innerHTML = `
    <section class="panel" style="max-width:640px;margin:40px auto">
      <div class="panel-body" style="text-align:center;padding:36px">
        <div style="width:52px;height:52px;border-radius:50%;background:#FBEAEB;color:var(--bad);
          display:grid;place-items:center;margin:0 auto 16px">${icon('warn', 26)}</div>
        <h2 style="font-size:19px">Доступ к порталу допусков не предоставлен</h2>
        <p style="color:var(--muted);margin:10px 0 0">${esc(message)}</p>
        <button class="btn primary" style="margin-top:18px" onclick="location.reload()">${icon('refresh', 15)} Проверить снова</button>
      </div>
    </section>`;
}

async function load(view) {
  if (view === 'mine') state.list = (await P.requests({ mine: 1 })).requests;
  if (view === 'queue') state.list = (await P.requests({ queue: 1 })).requests;
  if (view === 'approvals') state.list = (await P.requests({ scope: 'approvals' })).requests;
  if (view === 'active') state.list = (await P.requests({ scope: 'active', ...clean(activeFilter) })).requests;
  if (view === 'all') state.list = (await P.requests(clean(allFilter))).requests;
  if (view === 'site') state.site = await P.site(clean(siteFilter));
  if (view === 'crews' || view === 'new') await loadOrganization();
  if (view === 'report') state.report = await P.report(clean(reportFilter));
  if (view === 'settings') state.settings = await P.settings();
  if (view === 'leases') state.leases = (await P.leases(clean(leaseFilter))).leases;
}

async function loadOrganization() {
  const [w, v, c] = await Promise.all([P.workers(), P.vehicles(), P.crews()]);
  state.workers = w.workers;
  state.vehicles = v.vehicles;
  state.crews = c.crews;
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false));

async function go(view) {
  if (!viewAllowed(view)) return;
  state.view = view;
  window.scrollTo(0, 0);
  document.querySelector('.side')?.classList.remove('open');
  if (view === 'new' && !wiz) wiz = newWizard();
  state.loading = true;
  render();
  try { await load(view); state.error = null; }
  catch (error) { state.error = describeError(error); }
  finally { state.loading = false; }
  render();
}

async function reload() {
  try { await load(state.view); state.error = null; } catch (error) { state.error = describeError(error); }
  render();
}

/* -------------------------------- отрисовка -------------------------------- */

const UNIT_NAME = {
  permits: 'Служба управления активами', branch: 'Филиал', admin: 'ДИТ', oko: 'Организационно-контрольный отдел',
  management: 'Руководство', orpsd: 'ОР ПСД', auditor: 'Служба безопасности',
};

function renderNav() {
  const count = { approvals: state.meta?.me?.pendingApprovals || 0 };
  const item = ([k, label, i]) => `<button class="${state.view === k ? 'on' : ''}" onclick="${k === 'new' ? 'startWizard()' : `go('${k}')`}">${icon(i)}<span>${label}</span>${count[k] ? `<span class="badge">${count[k]}</span>` : ''}</button>`;
  document.getElementById('nav').innerHTML = [...MENU_CONTRACTOR, ...MENU_STAFF].filter(([k]) => viewAllowed(k)).map(item).join('');
  const orpsd = (state.me.modules || []).includes('orpsd');
  document.getElementById('otherLabel').style.display = orpsd ? '' : 'none';
  document.getElementById('navOther').innerHTML = orpsd
    ? `<button onclick="location.href='/'">${icon('archive')}<span>Заявки ОР ПСД и архив актов</span></button>` : '';
  const org = state.meta?.counterparty;
  const unit = ['permits', 'branch', 'admin', 'oko', 'management', 'orpsd', 'auditor'].find((r) => (state.me.roles || []).includes(r));
  document.getElementById('who').innerHTML = `<b>${esc(state.me.fullName)}</b>${esc(org ? org.name_full : UNIT_NAME[unit] || '')}
    <br><a href="#" onclick="event.preventDefault();logout()" class="ref">Выйти</a>`;
  const newBtn = document.getElementById('newBtn');
  newBtn.style.display = isContractor() && state.view !== 'new' ? '' : 'none';
  newBtn.innerHTML = `${icon('plus', 16)}<span>Новая заявка</span>`;
}

function render() {
  renderNav();
  const [title, subtitle] = TITLES[state.view] || ['Портал допусков', ''];
  document.getElementById('title').textContent = title;
  document.getElementById('subtitle').textContent = subtitle;
  const view = document.getElementById('view');
  if (state.loading && state.view !== 'new') {
    view.innerHTML = '<div style="display:flex;gap:10px;align-items:center;color:var(--muted)"><span class="spinner"></span>Загрузка…</div>';
    return;
  }
  const error = state.error ? `<div class="blocked" style="margin-bottom:14px">${esc(state.error)}</div>` : '';
  const screens = { new: renderWizard, mine: renderMine, crews: renderCrews, queue: renderQueue, all: renderAll,
    approvals: renderApprovals, active: renderActive, site: renderSite, leases: renderLeases, report: renderReport,
    settings: renderSettings };
  view.innerHTML = error + (screens[state.view] ? screens[state.view]() : '');
}

/* ------------------------------- мои заявки ------------------------------- */

function renderMine() {
  const org = state.meta.counterparty;
  const blocked = org?.status === 'blocked'
    ? '<div class="blocked" style="margin-bottom:14px">Организация заблокирована: подача заявок на допуск недоступна. Обратитесь в СУА.</div>' : '';
  return `${blocked}
  <section class="portal-intro">
    <img src="${A.logo}" alt="">
    <div><h2>Допуск персонала и техники на объекты</h2>
      <p>Заявка — официальный запрос организации (п. 13 Инструкции): цель работ, объект, основание (договор аренды, для
      монтажа — ТУ), период, работники по Приложению 1 и транспорт, скан подписанного запроса. Ответ — не позднее
      14 рабочих дней; при аварии допуск даётся в день обращения по согласованию с руководителем филиала (п. 18).</p></div>
    <div class="portal-steps">
      <div><span>01</span><div><b>Работники</b><small>Приложение 1 и удостоверения — один раз</small></div></div>
      <div><span>02</span><div><b>Заявка</b><small>цель, объект, основание, период</small></div></div>
      <div><span>03</span><div><b>Допуск</b><small>код и печатная форма</small></div></div>
    </div>
  </section>
  <section class="panel"><div class="panel-body scroll-x" style="padding:0 6px">
    <table class="stack-sm"><thead><tr><th>Заявка</th><th>Цель и объект</th><th>Период работ</th><th>Бригада</th><th>Статус</th><th></th></tr></thead><tbody>
    ${state.list.length ? state.list.map((r) => `<tr style="cursor:pointer" onclick="openCard('${r.id}')">
      <td><b>${esc(r.number)}</b> ${urgentChip(r)}<br><span class="ref">${r.submittedAt ? 'отправлена ' + ts(r.submittedAt) : 'черновик от ' + ts(r.createdAt)}</span>
        ${r.extendsNumber ? `<br><span class="ref">продление ${esc(r.extendsNumber)}</span>` : ''}</td>
      <td>${esc(r.workTypeName || '—')}${r.onAms ? ' · АМС' : ''}<br><span class="ref">${esc(r.facilityName || '—')} · ${esc(r.branchName || '')}</span></td>
      <td>${period(r)}<br><span class="ref">${hours(r)}</span></td>
      <td>${r.workersCount} чел.${r.vehiclesCount ? ` · ${r.vehiclesCount} авто` : ''}</td>
      <td>${statusChip(r)} ${validityChip(r)}${['rejected', 'revoked'].includes(r.status) ? `<br><span class="ref">${esc((r.rejectionReason || r.revokeReason || '').slice(0, 80))}</span>` : ''}
        ${r.provisional ? '<br><span class="chip w">досылка запроса — 2 дня</span>' : ''}</td>
      <td><div class="row-actions">${['approved', 'closed'].includes(r.status)
        ? `<a class="btn sm primary" target="_blank" rel="noopener" href="${P.printUrl(r.id, 'permit')}" onclick="event.stopPropagation()">${icon('download', 14)}Допуск</a>` : ''}
        ${r.status === 'draft' ? `<button class="btn sm" onclick="event.stopPropagation();continueDraft('${r.id}')">Продолжить</button>` : ''}</div></td>
    </tr>`).join('') : emptyRow(6, 'Заявок пока нет. Начните с раздела «Работники и бригады», затем подайте заявку.')}
    </tbody></table></div></section>`;
}

/* ------------------------ бригады, работники, транспорт ------------------------ */

function renderCrews() {
  const workers = state.workers;
  const crewRows = state.crews.map((c) => {
    const names = c.worker_ids.map((id) => workers.find((w) => w.id === id)?.full_name).filter(Boolean);
    const cars = c.vehicle_ids.map((id) => state.vehicles.find((v) => v.id === id)?.plate).filter(Boolean);
    const expired = c.worker_ids.filter((id) => (workers.find((w) => w.id === id)?.documents || []).some((d) => d.validUntil < today()));
    return `<tr><td><b>${esc(c.name)}</b>${expired.length ? ` <span class="chip r">просрочено: ${expired.length}</span>` : ''}
        ${c.worker_ids.length > state.meta.rules.maxCrew ? ` <span class="chip w">более ${state.meta.rules.maxCrew} чел. — согласование филиала</span>` : ''}</td>
      <td>${esc(names.join(', ') || '—')}</td><td>${esc(cars.join(', ') || '—')}</td>
      <td><div class="row-actions"><button class="btn ghost sm" onclick="editCrew('${c.id}')">Изменить</button>
        <button class="btn ghost sm" onclick="removeCrew(this,'${c.id}')">Удалить</button></div></td></tr>`;
  }).join('');
  return `
  <section class="panel" style="margin-bottom:16px">
    <div class="panel-head">${icon('users')}<div><h2>Работники</h2>
      <p>Сведения по Приложению 1 Инструкции и квалификационные документы; иностранцам — копии паспорта и визы (п. 16)</p></div>
      <button class="btn primary sm" style="margin-left:auto" onclick="editWorker(null)">${icon('plus', 15)}Работник</button></div>
    <div class="panel-body scroll-x" style="padding:0 6px"><table class="stack-sm">
      <thead><tr><th>Работник</th><th>Приложение 1</th><th>Документы</th><th></th></tr></thead><tbody>
      ${workers.length ? workers.map((w) => {
        const gaps = appendixGaps(w);
        return `<tr>
        <td><b>${esc(w.full_name)}</b>${w.full_name_latin ? `<br><span class="ref">${esc(w.full_name_latin)}</span>` : ''}
          <br><span class="ref">${w.iin ? 'ИИН ' + esc(w.iin) : esc(country(w.citizenship))}${w.position ? ' · ' + esc(w.position) : ''}${w.employer ? ' · ' + esc(w.employer) : ''}</span></td>
        <td>${gaps.length ? `<span class="chip r">не хватает: ${esc(gaps.join(', '))}</span>` : '<span class="chip g">заполнено</span>'}</td>
        <td><div class="docs">${w.documents.length ? w.documents.map((d) => `<span>${d.kind && d.kind !== 'qualification' ? `<b>${DOC_KIND[d.kind]}</b> ` : ''}${esc(d.title)}${d.number ? ' № ' + esc(d.number) : ''}
          ${docChip(d)}
          ${d.fileId ? `<a class="ref" href="${P.fileUrl(d.fileId)}" target="_blank" rel="noopener">скан</a>` : ''}
          <button class="btn ghost sm" onclick="editDocument('${w.id}','${d.id}')">Обновить</button>
          <button class="btn ghost sm" onclick="removeDocument(this,'${w.id}','${d.id}')" aria-label="Удалить">${icon('trash', 13)}</button></span>`).join('')
          : '<span class="chip r">нет удостоверений</span>'}</div></td>
        <td><div class="row-actions">
          <button class="btn sm" onclick="editDocument('${w.id}',null)">${icon('plus', 13)}Документ</button>
          <button class="btn ghost sm" onclick="editWorker('${w.id}')">Изменить</button>
          <button class="btn ghost sm" onclick="removeWorker(this,'${w.id}')">Исключить</button></div></td>
      </tr>`;
      }).join('') : emptyRow(4, 'Добавьте работников, которых направляете на объекты')}
      </tbody></table></div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-head">${icon('users')}<div><h2>Сохранённые бригады</h2>
        <p>В заявке бригада подставляется одним нажатием</p></div>
        <button class="btn primary sm" style="margin-left:auto" onclick="editCrew(null)">${icon('plus', 15)}Бригада</button></div>
      <div class="panel-body scroll-x" style="padding:0 6px"><table class="stack-sm">
        <thead><tr><th>Бригада</th><th>Работники</th><th>Транспорт</th><th></th></tr></thead>
        <tbody>${crewRows || emptyRow(4, 'Сохранённых бригад нет')}</tbody></table></div>
    </section>
    <section class="panel">
      <div class="panel-head">${icon('truck')}<div><h2>Транспорт</h2><p>Если нужен заезд на объект</p></div>
        <button class="btn primary sm" style="margin-left:auto" onclick="editVehicle(null)">${icon('plus', 15)}Транспорт</button></div>
      <div class="panel-body scroll-x" style="padding:0 6px"><table class="stack-sm">
        <thead><tr><th>Госномер</th><th>Марка</th><th>Водитель</th><th></th></tr></thead><tbody>
        ${state.vehicles.length ? state.vehicles.map((v) => `<tr><td><b>${esc(v.plate)}</b></td><td>${esc(v.model || '—')}</td>
          <td>${esc(v.driver_name || '—')}</td><td><div class="row-actions">
          <button class="btn ghost sm" onclick="editVehicle('${v.id}')">Изменить</button>
          <button class="btn ghost sm" onclick="removeVehicle(this,'${v.id}')">Исключить</button></div></td></tr>`).join('')
          : emptyRow(4, 'Транспорт не добавлен')}
        </tbody></table></div>
    </section>
  </div>
  <div class="note" style="margin-top:14px">Сведения о работниках — персональные данные. Их видят ваша организация, Служба
    управления активами при рассмотрении заявки и ответственное лицо филиала на объекте; каждое открытие скана фиксируется в журнале.</div>`;
}

const COUNTRY_OPTIONS = () => Object.entries(state.meta.countries).map(([value, label]) => ({ value, label }));

/** Работник по Приложению 1. При создании сразу просим первое удостоверение — без него в заявку не добавить. */
async function editWorker(id) {
  const w = id ? state.workers.find((x) => x.id === id) : null;
  const foreign = (v) => v.citizenship && v.citizenship !== 'KZ';
  const values = await dialog({
    title: w ? 'Сведения о работнике' : 'Новый работник', wide: true,
    text: 'Сведения по форме Приложения 1 Инструкции о допуске. Полностью заполненные сведения нужны для отправки заявки.',
    fields: [
      { key: 'fullName', label: 'Фамилия, имя, отчество', required: true, value: w?.full_name, span: true,
        check: (v) => (v.split(/\s+/).length < 2 ? 'Укажите фамилию и имя полностью' : '') },
      { key: 'citizenship', label: 'Гражданство', type: 'select', required: true, value: w?.citizenship || 'KZ', options: COUNTRY_OPTIONS() },
      { key: 'iin', label: 'ИИН', value: w?.iin, maxlength: 12, inputmode: 'numeric', required: (v) => !foreign(v),
        check: (v) => (/^\d{12}$/.test(v) ? '' : '12 цифр'), hint: 'Для иностранцев — если есть' },
      { key: 'fullNameLatin', label: 'ФИО латиницей, как в паспорте', value: w?.full_name_latin, required: foreign, showIf: foreign, span: true },
      { key: 'birthDate', label: 'Дата рождения', type: 'date', value: w?.birth_date },
      { key: 'birthPlace', label: 'Место рождения', value: w?.birth_place },
      { key: 'idDocNumber', label: '№ удостоверения личности / паспорта', value: w?.id_doc_number, required: foreign },
      { key: 'idDocIssuedAt', label: 'Дата выдачи', type: 'date', value: w?.id_doc_issued_at },
      { key: 'idDocIssuedBy', label: 'Кем выдан', value: w?.id_doc_issued_by, span: true, ph: 'Например: МВД РК' },
      { key: 'address', label: 'Адрес местожительства', value: w?.address, span: true },
      { key: 'position', label: 'Должность', value: w?.position },
      { key: 'employer', label: 'Место работы', value: w?.employer, hint: 'Если работник подрядной организации — её наименование' },
    ],
  });
  if (!values) return;
  const saved = await act(null, () => P.saveWorker({ id: w?.id, ...values }), 'Работник сохранён');
  if (!saved) return;
  await loadOrganization();
  render();
  if (!w) {
    await editDocument(saved.worker.id, null, 'qualification', true);
    if (values.citizenship !== 'KZ') await editDocument(saved.worker.id, null, 'passport', true);
  }
}

async function editDocument(workerId, docId, kind = null, first = false) {
  const w = state.workers.find((x) => x.id === workerId);
  const d = docId ? w?.documents.find((x) => x.id === docId) : null;
  const foreign = w && w.citizenship !== 'KZ';
  const kinds = [{ value: 'qualification', label: 'Удостоверение о квалификации' },
    ...(foreign ? [{ value: 'passport', label: 'Копия паспорта' }, { value: 'visa', label: 'Копия визы' }] : [])];
  const values = await dialog({
    title: d ? 'Обновить документ' : 'Документ работника',
    text: first ? `${esc(w?.full_name || '')}: ${kind === 'passport' ? 'иностранцу нужна копия паспорта (п. 16)' : 'без удостоверения работника нельзя включить в заявку'}.`
      : d ? 'Укажите новый срок действия и приложите скан нового документа.' : '',
    fields: [
      { key: 'kind', label: 'Вид', type: 'select', required: true, value: d?.kind || kind || 'qualification', options: kinds },
      { key: 'title', label: 'Наименование документа', value: d?.title, required: (v) => v.kind === 'qualification',
        ph: 'Например: удостоверение о допуске к работам на высоте', showIf: (v) => v.kind === 'qualification' },
      { key: 'number', label: 'Номер', value: d?.number },
      { key: 'validUntil', label: 'Действует до', type: 'date', required: true, value: d?.validUntil },
      { key: 'file', label: d ? 'Новый скан' : 'Скан документа', type: 'file', required: !d, hint: 'PDF, PNG или JPG, до 20 МБ' },
    ],
  });
  if (!values) return;
  const form = new FormData();
  form.set('kind', values.kind);
  form.set('title', values.kind === 'qualification' ? values.title : DOC_KIND[values.kind]);
  form.set('number', values.number);
  form.set('validUntil', values.validUntil);
  if (d) form.set('documentId', d.id);
  if (values.file) form.set('file', values.file, values.file.name);
  const ok = await act(null, () => P.workerDocument(workerId, form), d ? 'Документ обновлён' : 'Документ добавлен');
  if (!ok) return;
  await loadOrganization();
  if (state.view === 'new' && wiz?.card && wiz.step === STEPS.length - 1) await refreshCheck();
  render();
}

async function removeDocument(button, workerId, docId) {
  if (!confirm('Удалить документ?')) return;
  if (await act(button, () => P.deleteWorkerDocument(workerId, docId), 'Документ удалён')) { await loadOrganization(); render(); }
}

async function removeWorker(button, id) {
  if (!confirm('Исключить работника из списка организации? Отправленные заявки не изменятся.')) return;
  if (await act(button, () => P.deactivateWorker(id), 'Работник исключён')) { await loadOrganization(); render(); }
}

async function editVehicle(id) {
  const v = id ? state.vehicles.find((x) => x.id === id) : null;
  const values = await dialog({
    title: v ? 'Транспорт' : 'Новый транспорт',
    fields: [
      { key: 'plate', label: 'Госномер', required: true, value: v?.plate, ph: '123ABC02' },
      { key: 'model', label: 'Марка', value: v?.model },
      { key: 'driverName', label: 'ФИО водителя', value: v?.driver_name },
    ],
  });
  if (!values) return;
  if (await act(null, () => P.saveVehicle({ id: v?.id, ...values }), 'Транспорт сохранён')) {
    await loadOrganization(); render();
  }
}

async function removeVehicle(button, id) {
  if (!confirm('Исключить транспорт из списка организации?')) return;
  if (await act(button, () => P.deleteVehicle(id), 'Транспорт исключён')) { await loadOrganization(); render(); }
}

async function editCrew(id) {
  const c = id ? state.crews.find((x) => x.id === id) : null;
  const values = await dialog({
    title: c ? 'Бригада' : 'Новая бригада',
    fields: [
      { key: 'name', label: 'Название', required: true, value: c?.name, ph: 'Например: бригада обслуживания № 1' },
      { key: 'workerIds', label: 'Работники', type: 'checks', required: true, value: c?.worker_ids || [],
        options: state.workers.map((w) => ({ value: w.id, label: w.full_name, sub: esc(w.position || '') })) },
      { key: 'vehicleIds', label: 'Транспорт', type: 'checks', value: c?.vehicle_ids || [],
        options: state.vehicles.map((v) => ({ value: v.id, label: v.plate, sub: esc(v.model || '') })) },
    ],
  });
  if (!values) return;
  if (await act(null, () => P.saveCrew({ id: c?.id, ...values }), 'Бригада сохранена')) { await loadOrganization(); render(); }
}

async function removeCrew(button, id) {
  if (!confirm('Удалить сохранённую бригаду? Работники останутся в списке.')) return;
  if (await act(button, () => P.deleteCrew(id), 'Бригада удалена')) { await loadOrganization(); render(); }
}

/* --------------------------------- мастер --------------------------------- */

const STEPS = ['Цель и объект', 'Основание', 'Период', 'Бригада', 'Транспорт', 'Запрос', 'Проверка'];
let wiz = null;

const newWizard = () => ({
  step: 0, card: null, options: null, check: null, consent: false, facilityQuery: '', ownerMode: false,
  form: { workType: '', onAms: false, ownerBin: '', ownerName: '', facilityId: '', basisType: '', basisRefId: '', basisNumber: '',
    basisDate: '', basisValidUntil: '', periodStart: '', periodEnd: '', workHoursFrom: '09:00', workHoursTo: '18:00',
    weekendWork: false, description: '', isUrgent: false, crewId: '', workerIds: [], vehicleIds: [],
    letterNumber: '', letterDate: '', signatoryName: '', signatoryPosition: '' },
});

function startWizard() { wiz = newWizard(); go('new'); }

function fillWizard(card) {
  const r = card.request;
  wiz.card = card;
  Object.assign(wiz.form, {
    workType: r.workType || '', onAms: !!r.onAms, ownerBin: r.ownerBin || '', ownerName: r.ownerName || '',
    facilityId: r.facilityId || '', basisType: r.basisType || '', basisRefId: r.basisRefId || '', basisNumber: r.basisNumber || '',
    basisDate: r.basisDate || '', basisValidUntil: r.basisValidUntil || '', periodStart: r.periodStart || '', periodEnd: r.periodEnd || '',
    workHoursFrom: r.workHoursFrom || '09:00', workHoursTo: r.workHoursTo || '18:00', weekendWork: !!r.weekendWork,
    description: r.description || '', isUrgent: !!r.isUrgent, crewId: r.crewId || '',
    workerIds: card.workers.map((w) => w.workerId), vehicleIds: card.vehicles.map((v) => v.vehicleId),
    letterNumber: r.letterNumber || '', letterDate: r.letterDate || '', signatoryName: r.signatoryName || '',
    signatoryPosition: r.signatoryPosition || '',
  });
  wiz.ownerMode = !!r.ownerBin;
}

async function continueDraft(id) {
  const card = await act(null, () => P.request(id));
  if (!card) return;
  closeSheet();
  wiz = newWizard();
  fillWizard(card);
  if (card.request.facilityId) wiz.options = await P.basisOptions(card.request.facilityId, wiz.form.ownerBin).catch(() => null);
  go('new');
}

function renderWizard() {
  return `<div class="steps">${STEPS.map((s, i) => `<div class="${i === wiz.step ? 'cur' : i < wiz.step ? 'passed' : ''}">
    <span class="n">${i < wiz.step ? '✓' : i + 1}</span>${s}</div>`).join('')}</div>
    <div class="wizard"><div id="wizPanel">${wizardStep()}</div>${wizardAside()}</div>`;
}

function renderWizardPanel() {
  const panel = document.getElementById('wizPanel');
  if (panel) panel.innerHTML = wizardStep();
}

function wizardAside() {
  const f = wiz.form;
  const facility = state.meta.facilities.find((x) => x.id === f.facilityId);
  const route = wiz.check?.route || wiz.card?.route;
  return `<aside class="panel price"><div class="panel-body">
    <h3 style="font-size:14px;margin-bottom:10px">Заявка ${wiz.card ? esc(wiz.card.request.number) : ''}</h3>
    <div class="line"><span>Цель</span><b>${esc(state.meta.workTypes[f.workType] || '—')}</b></div>
    <div class="line"><span>Объект<small>${esc(facility?.branch_name || '')}</small></span><b>${esc(facility?.name || '—')}</b></div>
    <div class="line"><span>Основание</span><b>${f.basisNumber ? esc(f.basisNumber) : '—'}</b></div>
    <div class="line"><span>Период</span><b>${f.periodStart ? dt(f.periodStart) : '—'}</b></div>
    <div class="line"><span>Бригада</span><b>${f.workerIds.length} чел.</b></div>
    <div class="line"><span>Транспорт</span><b>${f.vehicleIds.length}</b></div>
    ${route?.branchReasons?.length ? `<div class="note" style="margin-top:10px">Нужно согласование руководства филиала:
      ${route.branchReasons.map((x) => esc(x.name)).join('; ')}</div>` : ''}
    <div class="disclaimer">${wiz.card ? 'Черновик сохраняется при переходе между шагами.' : 'Черновик сохранится после первого шага.'}
      Ответ СУА — не позднее 14 рабочих дней; решение придёт на почту и в уведомления.</div>
  </div></aside>`;
}

function wizardNav({ next = 'Далее', nextDisabled = false } = {}) {
  return `<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
    ${wiz.step > 0 ? `<button class="btn" onclick="wizardBack()">Назад</button>` : ''}
    ${wiz.step < STEPS.length - 1 ? `<button class="btn primary" onclick="wizardNext(this)" ${nextDisabled ? 'disabled' : ''}>${next}</button>` : ''}
    ${wiz.card ? `<button class="btn ghost" style="margin-left:auto" onclick="saveAndLeave(this)">Сохранить черновик и выйти</button>` : ''}
  </div>`;
}

const WORK_HINT = {
  maintenance: 'Основание — договор аренды (п. 7). На АМС — по согласованию с руководителем филиала (п. 8).',
  emergency: 'Допуск в день обращения по согласованию с руководителем филиала, в том числе ночью и в выходные; оформленный запрос — в течение 2 календарных дней (п. 18).',
  replacement: 'Замена ранее установленного оборудования на аналогичное по характеристикам, без протяжки кабелей. Основание — договор аренды (п. 7).',
  installation: 'В помещениях, на крышах и территории объекта. Основание — ТУ с номером и датой (пп. 9, 13). На АМС монтаж выполняют работники Общества (п. 11).',
  supervision: 'Контроль монтажа/демонтажа вашего оборудования, выполняемого работниками Общества, — в том числе на АМС (п. 12).',
  survey: 'Обследование объекта для разработки документации. По согласованию с руководством филиала (п. 14).',
};

function wizardStep() {
  const f = wiz.form;
  const step = wiz.step;
  const m = state.meta;
  if (step === 0) {
    const q = wiz.facilityQuery.toLowerCase();
    const list = m.facilities.filter((x) => !q || `${x.name} ${x.inv_no} ${x.address} ${x.branch_name}`.toLowerCase().includes(q));
    return `<section class="panel"><div class="panel-body">
      <div class="field"><label>Цель и характер работ (п. 13)</label></div>
      <div class="basis-pick">${Object.entries(m.workTypes).map(([k, name]) => `<label class="${f.workType === k ? 'on' : ''}">
        <input type="radio" name="wzWork" value="${k}" ${f.workType === k ? 'checked' : ''} onchange="pickWorkType('${k}')">
        <span><b>${esc(name)}</b><small>${esc(WORK_HINT[k])}</small></span></label>`).join('')}</div>
      <label class="consent" style="margin-top:12px"><input type="checkbox" ${f.onAms ? 'checked' : ''} onchange="wiz.form.onAms=this.checked;renderWizardPanel()">
        <span><b>Работы на антенно-мачтовом сооружении (АМС)</b><br>ТО и ремонт на АМС — по согласованию с руководителем филиала (п. 8);
        монтаж и демонтаж на АМС выполняют только работники Общества (п. 11).</span></label>
      ${f.onAms && ['installation', 'replacement'].includes(f.workType) ? '<div class="blocked" style="margin-top:10px">Монтаж и демонтаж на АМС выполняют работники Общества (п. 11). Выберите цель «Контроль монтажа/демонтажа, выполняемого работниками Общества» (п. 12).</div>' : ''}
      <div class="field" style="margin-top:16px"><label>Объект Общества</label>
        <input type="search" placeholder="Название, инвентарный номер, адрес, филиал" value="${esc(wiz.facilityQuery)}"
          oninput="wiz.facilityQuery=this.value;renderWizardPanel();const i=document.querySelector('#wizPanel input[type=search]');i.focus();i.setSelectionRange(i.value.length,i.value.length)"></div>
      <div class="pick-list" style="margin-top:10px;max-height:300px">${list.slice(0, 200).map((x) => `<label>
        <input type="radio" name="wzFacility" value="${x.id}" ${f.facilityId === x.id ? 'checked' : ''} onchange="pickFacility('${x.id}')">
        <span><b>${esc(x.name)}</b><span class="sub">инв. № ${esc(x.inv_no)} · ${esc(x.address || 'адрес не указан')} · ${esc(x.branch_name)}</span></span>
      </label>`).join('') || '<div class="ref" style="padding:12px">Ничего не найдено</div>'}</div>
      <label class="consent" style="margin-top:14px"><input type="checkbox" ${wiz.ownerMode ? 'checked' : ''} onchange="wiz.ownerMode=this.checked;if(!this.checked){wiz.form.ownerBin='';wiz.form.ownerName=''};renderWizardPanel()">
        <span><b>Мы — подрядная организация арендатора</b><br>Запрос направляет арендатор — владелец оборудования (п. 13). Укажите его:
        основание (договор аренды, ТУ) проверяется по арендатору.</span></label>
      ${wiz.ownerMode ? `<div class="form-grid" style="margin-top:10px">
        <div class="field"><label>БИН арендатора</label><input maxlength="12" inputmode="numeric" value="${esc(f.ownerBin)}" oninput="wiz.form.ownerBin=this.value.replace(/\\D/g,'')"></div>
        <div class="field"><label>Наименование арендатора</label><input value="${esc(f.ownerName)}" oninput="wiz.form.ownerName=this.value"></div></div>` : ''}
      ${wizardNav({ nextDisabled: !f.facilityId || !f.workType })}
    </div></section>`;
  }
  if (step === 1) {
    const allowed = m.allowedBasis[f.workType] || [];
    const optional = f.workType === 'survey';
    const hints = { lease: 'Из реестра СУА; если нет — номер, срок и скан', tu: 'Номер и дата ТУ (п. 13)',
      smr_contract: 'Договор на СМР с Обществом', transfer_act: 'Акт по этому объекту', order: 'Распоряжение на выполнение монтажных работ' };
    const options = (wiz.options && f.basisType && wiz.options[f.basisType]) || [];
    const verdict = wiz.card?.basis;
    const needScan = f.basisType === 'lease' && verdict && !verdict.ok && !f.basisRefId || f.basisType === 'transfer_act' && verdict?.needsScan;
    const scan = wiz.card?.request.basisFileId;
    return `<section class="panel"><div class="panel-body">
      ${optional ? '<div class="note" style="margin-bottom:12px">Для проектно-изыскательских работ основание необязательно: допуск согласует руководство филиала (п. 14). Если у вас есть ТУ или договор аренды по объекту — укажите.</div>' : ''}
      <div class="basis-pick">${allowed.map((k) => `<label class="${f.basisType === k ? 'on' : ''}">
        <input type="radio" name="wzBasis" value="${k}" ${f.basisType === k ? 'checked' : ''} onchange="pickBasisType('${k}')">
        <span><b>${esc(m.basisTypes[k])}</b><small>${hints[k]}</small></span></label>`).join('')}
        ${optional ? `<label class="${!f.basisType ? 'on' : ''}"><input type="radio" name="wzBasis" ${!f.basisType ? 'checked' : ''} onchange="pickBasisType('')">
          <span><b>Без основания</b><small>Только согласование филиала</small></span></label>` : ''}</div>
      ${f.basisType && f.basisType !== 'order' ? `<div class="field" style="margin-top:14px"><label>${esc(m.basisTypes[f.basisType])} — из реестра системы</label>
        <select onchange="pickBasisRef(this.value)"><option value="">${options.length ? '— выберите —' : 'в системе не найдено'}</option>
        ${options.map((o) => `<option value="${o.id}" ${f.basisRefId === o.id ? 'selected' : ''}>№ ${esc(o.number)}${o.doc_date ? ' от ' + dmy(o.doc_date) : ''}${o.valid_until ? ', до ' + dmy(o.valid_until) : ''}${o.approved === false ? ' · не действует' : ''}${o.facility_name ? ' · ' + esc(o.facility_name) : ''}</option>`).join('')}
        </select><div class="hint">Нет в списке? Укажите номер вручную — заявка уйдёт с отметкой для ручной проверки СУА.</div></div>` : ''}
      ${f.basisType ? `<div class="form-grid" style="margin-top:12px">
        <div class="field"><label>Номер основания</label>
          <input value="${esc(f.basisNumber)}" ${f.basisRefId ? 'readonly' : ''} oninput="wiz.form.basisNumber=this.value;wiz.form.basisRefId=''"></div>
        <div class="field"><label>Дата ${f.basisType === 'tu' ? '(обязательна для ТУ)' : '<span class="ref">необязательно</span>'}</label>
          <input type="date" value="${esc(f.basisDate)}" onchange="wiz.form.basisDate=this.value"></div>
        ${f.basisType === 'lease' && !f.basisRefId ? `<div class="field"><label>Договор аренды действует до</label>
          <input type="date" value="${esc(f.basisValidUntil)}" onchange="wiz.form.basisValidUntil=this.value">
          <div class="hint">Срок допуска не может превышать срок договора аренды (пп. 13, 14).</div></div>` : ''}
      </div>` : ''}
      ${needScan || scan ? `<div class="field" style="margin-top:12px"><label>Скан основания ${needScan ? '' : '<span class="ref">необязательно</span>'}</label>
        ${scan ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="chip g">${icon('check', 13)}${esc(wiz.card.request.basisFileName)}</span>
          <button class="btn ghost sm" onclick="removeBasisScan(this)">Удалить</button></div>`
          : `<input type="file" accept=".pdf,.png,.jpg,.jpeg" onchange="uploadBasisScan(this)">`}
        <div class="hint">Договора нет в реестре СУА — нужен скан; специалист СУА подтвердит основание и внесёт договор в реестр.</div></div>` : ''}
      ${verdict && f.basisType ? verdictBox(verdict) : ''}
      ${f.basisType ? `<div style="margin-top:12px"><button class="btn sm" onclick="checkBasis(this)">${icon('refresh', 14)}Проверить основание</button></div>` : ''}
      ${wizardNav({ nextDisabled: !optional && (!f.basisType || !f.basisNumber.trim()) })}
    </div></section>`;
  }
  if (step === 2) {
    const min = m.now;
    const emergency = f.workType === 'emergency';
    const route = wiz.card?.route;
    const routeProblems = route ? Object.values(route.fields || {}) : [];
    return `<section class="panel"><div class="panel-body"><div class="form-grid">
      <div class="field"><label>Начало работ</label><input type="datetime-local" value="${esc(f.periodStart)}" min="${min}"
        onchange="wiz.form.periodStart=this.value"></div>
      <div class="field"><label>Окончание работ</label><input type="datetime-local" value="${esc(f.periodEnd)}" min="${min}"
        onchange="wiz.form.periodEnd=this.value"></div>
      <div class="field"><label>Работы ежедневно с</label><input type="time" value="${esc(f.workHoursFrom)}" onchange="wiz.form.workHoursFrom=this.value"></div>
      <div class="field"><label>до</label><input type="time" value="${esc(f.workHoursTo)}" onchange="wiz.form.workHoursTo=this.value"></div>
      <label class="consent span2"><input type="checkbox" ${f.weekendWork ? 'checked' : ''} onchange="wiz.form.weekendWork=this.checked">
        <span><b>Работы в выходные и праздничные дни</b><br>${emergency
          ? 'Для аварийных работ допускается по согласованию с руководством филиала.'
          : 'Ночью (с ' + m.rules.nightFrom + ' до ' + m.rules.nightTo + ') и в выходные допуск только для аварийно-восстановительных работ (п. 14).'}</span></label>
      <div class="field span2"><label>Описание работ <span class="ref">необязательно</span></label>
        <textarea oninput="wiz.form.description=this.value" placeholder="Например: замена приёмопередатчика в аппаратной">${esc(f.description)}</textarea></div>
    </div>
    ${routeProblems.length ? `<div class="blocked" style="margin-top:10px">${routeProblems.map(esc).join('<br>')}</div>` : ''}
    <div class="hint" style="margin-top:8px">Время — местное время объекта. Срок допуска не превышает срок договора аренды. На дату начала
      проверяются удостоверения, на дату окончания — паспорта и визы иностранцев.</div>
    ${wizardNav()}</div></section>`;
  }
  if (step === 3) {
    const start = f.periodStart ? f.periodStart.slice(0, 10) : null;
    const end = f.periodEnd ? f.periodEnd.slice(0, 10) : null;
    const expired = (w) => w.documents.some((d) => (d.kind || 'qualification') === 'qualification' && d.validUntil < (start || today()));
    const total = f.workerIds.length;
    return `<section class="panel"><div class="panel-body">
      ${state.crews.length ? `<div class="filters"><select id="wzCrew"><option value="">Сохранённая бригада…</option>
        ${state.crews.map((c) => `<option value="${c.id}" ${f.crewId === c.id ? 'selected' : ''}>${esc(c.name)} · ${c.worker_ids.length} чел.</option>`).join('')}</select>
        <button class="btn sm" onclick="loadCrew()">${icon('users', 14)}Загрузить сохранённую бригаду</button></div>` : ''}
      ${total > m.rules.maxCrew ? `<div class="note" style="margin-bottom:10px">Более ${m.rules.maxCrew} человек одновременно — допуск по предварительному согласованию с руководством филиала (п. 14).</div>` : ''}
      <div class="pick-list">${state.workers.map((w) => {
        const noDocs = !w.documents.some((d) => (d.kind || 'qualification') === 'qualification');
        const bad = expired(w) || noDocs;
        const gaps = appendixGaps(w);
        const on = f.workerIds.includes(w.id);
        return `<label class="${bad && !on ? 'off' : ''}">
          <input type="checkbox" ${on ? 'checked' : ''} ${bad && !on ? 'disabled' : ''} onchange="toggleWorker('${w.id}', this.checked)">
          <span style="flex:1"><b>${esc(w.full_name)}</b><span class="sub">${w.iin ? 'ИИН ' + esc(w.iin) : esc(country(w.citizenship))}${w.position ? ' · ' + esc(w.position) : ''}</span>
          <span class="docs" style="margin-top:4px">${w.documents.length ? w.documents.map((d) => `<span>${d.kind && d.kind !== 'qualification' ? DOC_KIND[d.kind] + ': ' : ''}${esc(d.title)} ${docChip(d, start, end)}</span>`).join('')
            : '<span class="chip r">нет удостоверений</span>'}
            ${gaps.length ? `<span><span class="chip w">Приложение 1: ${esc(gaps.join(', '))}</span></span>` : ''}</span></span>
          ${bad ? `<button class="btn sm" onclick="event.preventDefault();editDocument('${w.id}', ${w.documents[0] ? `'${w.documents[0].id}'` : 'null'})">Обновить</button>` : ''}
          ${gaps.length ? `<button class="btn sm" onclick="event.preventDefault();editWorker('${w.id}')">Заполнить</button>` : ''}
        </label>`;
      }).join('') || '<div class="ref" style="padding:12px">Работников пока нет — добавьте первого.</div>'}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" onclick="editWorker(null)">${icon('plus', 14)}Новый работник</button>
        <span class="ref" style="align-self:center">Работника с удостоверением, истекающим до начала работ, добавить нельзя: обновите документ.</span></div>
      ${wizardNav({ nextDisabled: !f.workerIds.length })}
    </div></section>`;
  }
  if (step === 4) {
    return `<section class="panel"><div class="panel-body">
      <div class="pick-list">${state.vehicles.map((v) => `<label>
        <input type="checkbox" ${f.vehicleIds.includes(v.id) ? 'checked' : ''} onchange="toggleVehicle('${v.id}', this.checked)">
        <span><b>${esc(v.plate)}</b><span class="sub">${esc(v.model || 'марка не указана')}${v.driver_name ? ' · водитель ' + esc(v.driver_name) : ''}</span></span>
      </label>`).join('') || '<div class="ref" style="padding:12px">Транспорт не добавлен. Шаг необязательный — если заезд на объект не нужен, нажмите «Далее».</div>'}</div>
      <div style="margin-top:10px"><button class="btn sm" onclick="editVehicle(null)">${icon('plus', 14)}Транспорт</button></div>
      ${wizardNav()}
    </div></section>`;
  }
  if (step === 5) {
    const r = wiz.card?.request;
    const emergency = f.workType === 'emergency';
    return `<section class="panel"><div class="panel-body">
      <div class="note" style="margin-bottom:12px">Официальный запрос организации подписывает должностное лицо, обладающее полномочиями;
        список работников по Приложению 1 подписывается и заверяется печатью (п. 13). Система формирует запрос по данным
        заявки — распечатайте, подпишите, заверьте и приложите скан.${emergency ? ' <b>При аварии</b> запрос можно приложить после допуска — в течение 2 календарных дней (п. 18).' : ''}</div>
      <div class="form-grid">
        <div class="field"><label>Подписал (Ф.И.О.)</label><input value="${esc(f.signatoryName)}" oninput="wiz.form.signatoryName=this.value"></div>
        <div class="field"><label>Должность</label><input value="${esc(f.signatoryPosition)}" oninput="wiz.form.signatoryPosition=this.value"></div>
        <div class="field"><label>Исходящий номер запроса</label><input value="${esc(f.letterNumber)}" oninput="wiz.form.letterNumber=this.value"></div>
        <div class="field"><label>Дата запроса</label><input type="date" value="${esc(f.letterDate)}" onchange="wiz.form.letterDate=this.value"></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;align-items:center">
        <button class="btn" onclick="printLetter(this)">${icon('download', 15)}Сформировать запрос с Приложением 1</button>
        ${r?.letterFileId ? `<span class="chip g">${icon('check', 13)}${esc(r.letterFileName)}</span>` : ''}
        <label class="btn">${icon('upload', 15)}${r?.letterFileId ? 'Заменить скан' : 'Приложить подписанный скан'}
          <input type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onchange="uploadLetter(this)"></label>
      </div>
      ${wizardNav()}
    </div></section>`;
  }
  return reviewStep();
}

function verdictBox(v) {
  const kind = v.ok ? 'g' : v.blocking ? 'r' : 'w';
  const title = v.ok ? 'Основание подтверждено' : v.blocking ? 'Заявку с таким основанием отправить нельзя' : 'Основание проверит специалист СУА';
  return `<div class="verdict ${kind}"><b>${title}</b>${esc(v.message)}</div>`;
}

function reviewStep() {
  const c = wiz.card;
  const r = c.request;
  const check = wiz.check || { fields: {}, issues: [], basis: c.basis, route: c.route };
  const problems = Object.entries(check.fields || {}).filter(([k]) => k !== 'consent');
  const start = r.periodStart ? r.periodStart.slice(0, 10) : null;
  const end = r.periodEnd ? r.periodEnd.slice(0, 10) : null;
  const route = check.route || {};
  return `<section class="panel"><div class="panel-body">
    <div class="review-grid">
      <b>Организация</b><span>${esc(r.counterpartyName)} · БИН ${esc(r.counterpartyBin)}${r.ownerBin ? `<br><span class="ref">подрядчик арендатора ${esc(r.ownerName)} (БИН ${esc(r.ownerBin)})</span>` : ''}</span>
      <b>Цель работ</b><span>${esc(r.workTypeName || '—')}${r.onAms ? ' · на АМС' : ''}${r.description ? `<br><span class="ref">${esc(r.description)}</span>` : ''}</span>
      <b>Объект</b><span>${esc(r.facilityName || '—')}<br><span class="ref">${esc(r.facilityAddress || '')} · ${esc(r.branchName || '')}</span></span>
      <b>Основание</b><span>${r.basisType ? `${esc(r.basisTypeName)} № ${esc(r.basisNumber || '—')}${r.basisDate ? ' от ' + dmy(r.basisDate) : ''}${r.basisValidUntil ? ', до ' + dmy(r.basisValidUntil) : ''}` : 'не требуется'}${r.basisFileName ? `<br><span class="ref">скан: ${esc(r.basisFileName)}</span>` : ''}</span>
      <b>Период работ</b><span>${period(r)}<br><span class="ref">ежедневно ${hours(r)}</span></span>
      <b>Бригада</b><span>${c.workers.map((w) => `${esc(w.fullName)} <span class="ref">${esc(w.citizenshipName || '')}</span><br><span class="docs">${w.documents.map((d) => `<span>${d.kind !== 'qualification' ? DOC_KIND[d.kind] + ': ' : ''}${esc(d.title)} ${docChip(d, start, end)}
        ${d.validUntil < (start || today()) ? `<button class="btn ghost sm" onclick="editDocument('${w.workerId}','${d.id}')">Обновить</button>` : ''}</span>`).join('')}</span>`).join('<br>') || '—'}</span>
      <b>Транспорт</b><span>${c.vehicles.map((v) => `${esc(v.plate)} ${esc(v.model)}`).join('<br>') || '—'}</span>
      <b>Запрос</b><span>${r.letterNumber ? `исх. № ${esc(r.letterNumber)} от ${dmy(r.letterDate)}` : '—'} · ${esc(r.signatoryName || '')}${r.letterFileName ? `<br><span class="ref">скан: ${esc(r.letterFileName)}</span>` : ''}</span>
    </div>
    ${check.basis && r.basisType ? `<div style="margin-top:14px">${verdictBox(check.basis)}</div>` : ''}
    ${route.branchReasons?.length ? `<div class="note" style="margin-top:12px"><b>Потребуется согласование руководства филиала:</b>
      ${route.branchReasons.map((x) => esc(x.name)).join('; ')}.${route.emergency ? ' При аварии допуск предоставляется в день обращения после согласования.' : ''}</div>` : ''}
    ${problems.length ? `<div class="blocked" style="margin-top:12px"><b>Исправьте перед отправкой:</b><br>${problems.map(([, msg]) => esc(msg)).join('<br>')}</div>` : ''}
    ${r.workType !== 'emergency' ? `<label class="consent" style="margin-top:14px"><input type="checkbox" ${r.isUrgent ? 'checked' : ''} onchange="setUrgent(this.checked)">
      <span><b>Срочно</b><br>Заявка поднимется в начало очереди СУА; порядок рассмотрения тот же.</span></label>` : ''}
    <label class="consent" style="margin-top:10px"><input type="checkbox" ${wiz.consent ? 'checked' : ''}
      onchange="wiz.consent=this.checked;document.getElementById('sendBtn').disabled=!this.checked">
      <span>Работники, включённые в заявку, дали согласие на обработку их персональных данных (сведения Приложения 1, ИИН,
      сведения удостоверений, копии паспортов и виз) для оформления допуска на объект.</span></label>
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      <button class="btn" onclick="wizardBack()">Назад</button>
      <button class="btn primary" id="sendBtn" onclick="submitWizard(this)" ${wiz.consent ? '' : 'disabled'}>${icon('arrow', 15)}Отправить на рассмотрение</button>
      <button class="btn ghost" style="margin-left:auto" onclick="saveAndLeave(this)">Сохранить черновик и выйти</button>
    </div>
  </div></section>`;
}

function pickWorkType(type) {
  wiz.form.workType = type;
  const allowed = state.meta.allowedBasis[type] || [];
  if (!allowed.includes(wiz.form.basisType)) {
    wiz.form.basisType = type === 'survey' ? '' : allowed[0] || '';
    wiz.form.basisRefId = '';
    wiz.form.basisNumber = '';
  }
  if (type === 'emergency') wiz.form.isUrgent = true;
  renderWizardPanel();
  render();
}

async function pickFacility(id) {
  wiz.form.facilityId = id;
  wiz.options = await P.basisOptions(id, wiz.form.ownerBin).catch(() => null);
  render();
}

function pickBasisType(type) {
  wiz.form.basisType = type;
  wiz.form.basisRefId = '';
  wiz.form.basisNumber = '';
  if (wiz.card) wiz.card.basis = null;
  renderWizardPanel();
}

function pickBasisRef(id) {
  const option = (wiz.options?.[wiz.form.basisType] || []).find((o) => o.id === id);
  wiz.form.basisRefId = option ? id : '';
  wiz.form.basisNumber = option ? option.number : '';
  if (option?.doc_date) wiz.form.basisDate = option.doc_date;
  if (option?.valid_until) wiz.form.basisValidUntil = option.valid_until;
  render();
}

function toggleWorker(id, on) {
  const ids = wiz.form.workerIds.filter((x) => x !== id);
  wiz.form.workerIds = on ? [...ids, id] : ids;
  wiz.form.crewId = '';
  render();
}

function toggleVehicle(id, on) {
  const ids = wiz.form.vehicleIds.filter((x) => x !== id);
  wiz.form.vehicleIds = on ? [...ids, id] : ids;
  render();
}

/** «Загрузить сохранённую бригаду»: работники и транспорт одним действием; просроченные подсвечиваются. */
function loadCrew() {
  const crew = state.crews.find((c) => c.id === document.getElementById('wzCrew').value);
  if (!crew) return toast('Выберите бригаду', 'bad');
  wiz.form.crewId = crew.id;
  wiz.form.workerIds = [...crew.worker_ids];
  wiz.form.vehicleIds = [...crew.vehicle_ids];
  render();
  toast(`Бригада «${crew.name}» загружена`, 'good');
}

function draftBody() {
  const f = wiz.form;
  return {
    workType: f.workType || null, onAms: !!f.onAms, workHoursFrom: f.workHoursFrom, workHoursTo: f.workHoursTo,
    weekendWork: !!f.weekendWork, ownerBin: wiz.ownerMode ? f.ownerBin : '', ownerName: wiz.ownerMode ? f.ownerName : '',
    facilityId: f.facilityId || null, basisType: f.basisType || null, basisNumber: f.basisNumber,
    basisRefId: f.basisRefId || null, basisDate: f.basisDate || null, basisValidUntil: f.basisValidUntil || null,
    letterNumber: f.letterNumber, letterDate: f.letterDate || null, signatoryName: f.signatoryName,
    signatoryPosition: f.signatoryPosition, description: f.description, periodStart: f.periodStart || null,
    periodEnd: f.periodEnd || null, isUrgent: !!f.isUrgent, crewId: f.crewId || null,
    workerIds: f.workerIds, vehicleIds: f.vehicleIds,
  };
}

/** Сохранение черновика: создание либо правка с проверкой версии. */
async function saveDraft() {
  try {
    wiz.card = wiz.card
      ? await P.update(wiz.card.request.id, { ...draftBody(), version: wiz.card.request.version })
      : await P.create(draftBody());
  } catch (error) {
    if (error.isConflict && wiz.card) wiz.card = await P.request(wiz.card.request.id);
    throw error;
  }
  wiz.form.basisNumber = wiz.card.request.basisNumber;
  wiz.form.basisRefId = wiz.card.request.basisRefId || '';
  return wiz.card;
}

function stepProblem() {
  const f = wiz.form;
  if (wiz.step === 0 && !f.workType) return 'Выберите цель работ';
  if (wiz.step === 0 && !f.facilityId) return 'Выберите объект';
  if (wiz.step === 0 && wiz.ownerMode && !/^\d{12}$/.test(f.ownerBin)) return 'Укажите БИН арендатора — 12 цифр';
  if (wiz.step === 1 && f.workType !== 'survey' && (!f.basisType || !f.basisNumber.trim())) return 'Укажите основание и его номер';
  if (wiz.step === 2) {
    if (!f.periodStart || !f.periodEnd) return 'Укажите начало и окончание работ';
    if (f.periodEnd <= f.periodStart) return 'Окончание работ должно быть позже начала';
  }
  if (wiz.step === 3 && !f.workerIds.length) return 'Выберите работников';
  return '';
}

async function refreshCheck() {
  wiz.card = await P.request(wiz.card.request.id).catch(() => wiz.card);
  wiz.check = await P.check(wiz.card.request.id).catch(() => wiz.check);
}

async function wizardNext(button) {
  const problem = stepProblem();
  if (problem) return toast(problem, 'bad');
  const saved = await act(button, saveDraft);
  if (!saved) return;
  if (wiz.step === 1 && wiz.card.basis?.blocking && wiz.form.basisType && !wiz.card.basis.needsScan) {
    render();
    return toast(wiz.card.basis.message, 'bad');
  }
  if (wiz.step === 2 && wiz.card.route && Object.keys(wiz.card.route.fields || {}).length) {
    render();
    return toast(Object.values(wiz.card.route.fields)[0], 'bad');
  }
  wiz.step += 1;
  if (wiz.step === STEPS.length - 1) wiz.check = await P.check(wiz.card.request.id).catch(() => null);
  render();
  window.scrollTo(0, 0);
}

function wizardBack() { wiz.step = Math.max(0, wiz.step - 1); render(); }

async function checkBasis(button) {
  if (!wiz.form.basisNumber.trim()) return toast('Укажите номер основания', 'bad');
  if (await act(button, saveDraft)) render();
}

async function uploadBasisScan(input) {
  const file = input.files[0];
  if (!file) return;
  if (!await act(null, saveDraft)) return;
  const form = new FormData();
  form.set('file', file, file.name);
  const card = await act(null, () => P.basisFile(wiz.card.request.id, form), 'Скан приложен');
  if (card) wiz.card = card;
  renderWizardPanel();
}

async function removeBasisScan(button) {
  const card = await act(button, () => P.basisFileDelete(wiz.card.request.id), 'Скан удалён');
  if (card) { wiz.card = card; renderWizardPanel(); }
}

async function printLetter(button) {
  if (!await act(button, saveDraft)) return;
  window.open(P.printUrl(wiz.card.request.id, 'letter'), '_blank', 'noopener');
}

async function uploadLetter(input) {
  const file = input.files[0];
  if (!file) return;
  if (!await act(null, saveDraft)) return;
  const form = new FormData();
  form.set('file', file, file.name);
  const card = await act(null, () => P.letterFile(wiz.card.request.id, form), 'Скан запроса приложен');
  if (card) wiz.card = card;
  render();
}

async function setUrgent(on) {
  wiz.form.isUrgent = on;
  await act(null, saveDraft);
}

async function saveAndLeave(button) {
  if (!await act(button, saveDraft, 'Черновик сохранён')) return;
  wiz = null;
  go('mine');
}

async function submitWizard(button) {
  if (!await act(button, saveDraft)) return;
  const card = await act(button, () => P.submit(wiz.card.request.id, { version: wiz.card.request.version, consent: wiz.consent }),
    'Заявка отправлена на рассмотрение');
  if (!card) {
    wiz.check = await P.check(wiz.card.request.id).catch(() => wiz.check);
    return render();
  }
  wiz = null;
  await go('mine');
  showCard(card);
}

/* ------------------------------- списки СУА ------------------------------- */

function requestTable(rows, emptyText) {
  const staff = !isContractor();
  return `<section class="panel"><div class="panel-body scroll-x" style="padding:0 6px"><table>
    <thead><tr><th>Заявка</th><th>Организация</th><th>Цель и объект</th><th>Период работ</th><th>Основание</th><th>Бригада</th><th>Статус</th>${staff ? '<th>Рассматривает</th>' : ''}</tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr style="cursor:pointer" onclick="openCard('${r.id}')">
      <td><b>${esc(r.number)}</b> ${urgentChip(r)}<br><span class="ref">${ts(r.submittedAt)}</span></td>
      <td>${esc(r.counterpartyName)}<br><span class="ref">БИН ${esc(r.counterpartyBin)}</span></td>
      <td>${esc(r.workTypeName || '—')}${r.onAms ? ' · АМС' : ''}<br><span class="ref">${esc(r.facilityName || '—')} · ${esc(r.branchName || '')}</span></td>
      <td>${period(r)}<br><span class="ref">${hours(r)}</span></td>
      <td>${r.basisType ? `${esc(r.basisTypeName || '')} № ${esc(r.basisNumber)}` : '<span class="ref">не требуется</span>'}<br>${basisChip(r)}</td>
      <td>${r.workersCount} чел.${r.vehiclesCount ? `<br><span class="ref">${r.vehiclesCount} авто</span>` : ''}</td>
      <td>${statusChip(r)} ${validityChip(r)}<br>${dueChip(r)} ${branchChip(r)}</td>
      ${staff ? `<td>${r.assigneeName ? esc(r.assigneeName) : r.status === 'pending_review' ? '<span class="chip r">нет исполнителя</span>' : '<span class="ref">—</span>'}
        ${r.branchApproval === 'pending' && r.branchApproverName ? `<br><span class="ref">филиал: ${esc(r.branchApproverName)}</span>` : ''}</td>` : ''}</tr>`).join('') : emptyRow(staff ? 8 : 7, emptyText)}
    </tbody></table></div></section>`;
}

function renderQueue() {
  const urgent = state.list.filter((r) => r.isUrgent).length;
  const overdue = state.list.filter((r) => r.reviewDueAt && daysTo(r.reviewDueAt) < 0).length;
  return `<div class="kpis">
    <div class="kpi"><div class="big">${state.list.length}</div><span>на рассмотрении</span></div>
    <div class="kpi"><div class="big">${urgent}</div><span>срочных и аварийных</span></div>
    <div class="kpi"><div class="big" ${overdue ? 'style="color:var(--bad)"' : ''}>${overdue}</div><span>просрочено (14 рабочих дней)</span></div>
    <div class="kpi"><div class="big">${state.list.filter((r) => r.branchApproval === 'pending').length}</div><span>ждут согласования филиала</span></div>
    <div class="kpi"><div class="big">${state.list.filter((r) => r.basisCheck?.needsConfirmation && !r.basisConfirmedAt).length}</div><span>основание проверить вручную</span></div>
  </div>${requestTable(state.list, 'Очередь пуста')}`;
}

function renderApprovals() {
  return `<div class="note" style="margin-bottom:14px">Инструкция требует согласования руководства филиала: ТО и ремонт на АМС (п. 8),
    проектно-изыскательские работы и более 5 человек одновременно (п. 14), аварийные работы (п. 18), работы ночью и в выходные (п. 14).
    Откройте заявку и примите решение. Специалист СУА отмечает решение, полученное устно или письмом.</div>
    ${requestTable(state.list, 'Заявок на согласовании нет')}`;
}

const allFilter = { status: '', q: '', branchId: '', workType: '', urgent: false };
function setAll(key, value) { allFilter[key] = value; reload(); }

function workTypeSelect(current, onchange) {
  return `<select onchange="${onchange}"><option value="">Все цели работ</option>
    ${Object.entries(state.meta.workTypes).map(([k, n]) => `<option value="${k}" ${current === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
}

function branchSelect(current, onchange) {
  if (!isCentral() && !isAdmin()) return '';
  return `<select onchange="${onchange}"><option value="">Все филиалы</option>
    ${state.meta.branches.map((b) => `<option value="${b.id}" ${current === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`;
}

function renderAll() {
  const statuses = Object.entries(state.meta.statuses).filter(([k]) => k !== 'draft');
  return `<div class="filters">
    <input type="search" placeholder="Номер, организация, БИН, объект, основание, код, работник" value="${esc(allFilter.q)}" style="min-width:300px"
      onkeydown="if(event.key==='Enter')setAll('q',this.value)" onchange="setAll('q',this.value)">
    <select onchange="setAll('status',this.value)"><option value="">Все статусы</option>
      ${statuses.map(([k, n]) => `<option value="${k}" ${allFilter.status === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    ${workTypeSelect(allFilter.workType, "setAll('workType',this.value)")}
    ${branchSelect(allFilter.branchId, "setAll('branchId',this.value)")}
    <label class="ref" style="display:flex;gap:6px;align-items:center"><input type="checkbox" ${allFilter.urgent ? 'checked' : ''}
      onchange="setAll('urgent', this.checked ? 1 : false)"> только срочные</label>
    <span class="ref">Найдено: ${state.list.length}</span>
  </div>${requestTable(state.list, 'Заявок не найдено')}`;
}

const activeFilter = { date: '', branchId: '' };
function setActive(key, value) { activeFilter[key] = value; reload(); }

function renderActive() {
  return `<div class="filters">
    <label class="ref">на дату <input type="date" value="${esc(activeFilter.date || today())}" onchange="setActive('date',this.value)"></label>
    ${branchSelect(activeFilter.branchId, "setActive('branchId',this.value)")}
    <span class="ref">Действующих допусков: ${state.list.length}</span>
  </div>
  <section class="panel"><div class="panel-body scroll-x" style="padding:0 6px"><table>
    <thead><tr><th>Допуск</th><th>Организация</th><th>Объект</th><th>Срок и время</th><th>Цель</th><th>Людей</th><th>Ответственный на объекте</th></tr></thead><tbody>
    ${state.list.length ? state.list.map((r) => `<tr style="cursor:pointer" onclick="openCard('${r.id}')">
      <td><b>${esc(r.number)}</b> ${urgentChip(r)}<br><span class="ref">код ${esc(r.permitCode || '—')}</span></td>
      <td>${esc(r.counterpartyName)}</td>
      <td>${esc(r.facilityName || '—')}<br><span class="ref">${esc(r.branchName || '')}</span></td>
      <td>${period(r)}<br><span class="ref">${hours(r)}</span></td>
      <td>${esc(r.workTypeName || '')}${r.onAms ? ' · АМС' : ''}</td>
      <td>${r.workersCount}${r.vehiclesCount ? ` · ${r.vehiclesCount} авто` : ''}</td>
      <td>${esc(r.siteOfficerName || '—')}</td></tr>`).join('') : emptyRow(7, 'На эту дату действующих допусков нет')}
    </tbody></table></div></section>`;
}

/* ---------------------------- проверка на объекте ---------------------------- */

const siteFilter = { date: '', branchId: '' };
function setSite(key, value) { siteFilter[key] = value; reload(); }

function renderSite() {
  const s = state.site || { requests: [], date: today() };
  const v = state.verify;
  return `<section class="panel" style="margin-bottom:16px"><div class="panel-body">
    <div class="filters" style="margin:0">
      <input id="verifyQ" type="search" placeholder="Код допуска, ИИН или фамилия работника" style="min-width:300px"
        onkeydown="if(event.key==='Enter')verifyPermit(this.value)">
      <button class="btn primary sm" onclick="verifyPermit(document.getElementById('verifyQ').value)">${icon('search', 15)}Проверить</button>
      <span class="ref">Проверка по электронному допуску: действует ли допуск, кто в нём и на какой объект.</span>
    </div>
    ${v ? `<div style="margin-top:12px">${v.results.length ? v.results.map((r) => `<div class="verdict ${r.status === 'approved' && r.validity === 'active' ? 'g' : 'r'}" style="cursor:pointer" onclick="openCard('${r.id}')">
      <b>${esc(r.number)} · код ${esc(r.permitCode || '—')} · ${esc(r.statusName)}${r.validity ? ' · ' + ({ active: 'действует сейчас', upcoming: 'ещё не начался', expired: 'срок истёк' }[r.validity]) : ''}</b>
      ${esc(r.counterpartyName)} · ${esc(r.facilityName || '')} · ${period(r)}, ${hours(r)}${r.matchedWorkers?.length ? `<br>Работник: ${esc(r.matchedWorkers.join(', '))}` : ''}</div>`).join('')
      : '<div class="verdict r"><b>Допуск не найден</b>Без действующего допуска на объект не пропускать.</div>'}</div>` : ''}
  </div></section>
  <div class="filters">
    <label class="ref">дата работ <input type="date" value="${esc(siteFilter.date || s.date)}" onchange="setSite('date',this.value)"></label>
    ${branchSelect(siteFilter.branchId, "setSite('branchId',this.value)")}
    <span class="ref">Допусков на дату: ${s.requests.length}</span>
  </div>
  <section class="panel"><div class="panel-body scroll-x" style="padding:0 6px"><table>
    <thead><tr><th>Допуск</th><th>Организация</th><th>Объект</th><th>Время</th><th>Людей</th><th>Отметки за день</th><th>Ответственный</th></tr></thead><tbody>
    ${s.requests.length ? s.requests.map((r) => `<tr style="cursor:pointer" onclick="openCard('${r.id}')">
      <td><b>${esc(r.number)}</b> ${urgentChip(r)}<br><span class="ref">код ${esc(r.permitCode || '—')}</span></td>
      <td>${esc(r.counterpartyName)}</td><td>${esc(r.facilityName || '—')}</td><td>${hours(r)}</td>
      <td>${r.workersCount}${r.vehiclesCount ? ` · ${r.vehiclesCount} авто` : ''}</td>
      <td>${r.today.admitted ? `<span class="chip g">допущено ${r.today.admitted}</span>` : ''} ${r.today.refused ? `<span class="chip r">не допущено ${r.today.refused}</span>` : ''}
        ${r.today.on_site ? `<span class="chip b">на объекте ${r.today.on_site}</span>` : ''}${!r.today.admitted && !r.today.refused ? '<span class="ref">нет отметок</span>' : ''}</td>
      <td>${esc(r.siteOfficerName || '—')}</td></tr>`).join('') : emptyRow(7, 'На эту дату действующих допусков на объекты нет')}
    </tbody></table></div></section>`;
}

async function verifyPermit(q) {
  if (String(q).trim().length < 3) return toast('Введите код, ИИН или фамилию — не меньше 3 символов', 'bad');
  const res = await act(null, () => P.verify(q.trim()));
  if (res) { state.verify = res; render(); }
}

/* --------------------------------- карточка --------------------------------- */

let sheetCard = null;

async function openCard(id) {
  const card = await act(null, () => P.request(id));
  if (card) showCard(card);
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('on');
  sheetCard = null;
  if (location.hash) history.replaceState(null, '', location.pathname);
}

function showCard(card) {
  sheetCard = card;
  document.getElementById('sheet').classList.add('on');
  renderSheet();
}

function decisionBanner(c) {
  const r = c.request;
  const a = c.actions;
  if (['approved', 'closed'].includes(r.status)) {
    return `<section class="verdict ${r.provisional ? 'w' : 'g'}" style="margin:0">
      <b>${r.provisional ? 'Аварийный допуск предоставлен' : r.status === 'closed' ? 'Работы завершены, допуск закрыт' : 'Допуск выдан'} ${ts(r.permitIssuedAt)}</b>
      Код для проверки на объекте: <b style="font-family:monospace;font-size:16px;letter-spacing:2px">${esc(r.permitCode || '')}</b> ${validityChip(r)}
      ${r.provisional ? `<br>Оформленный запрос и письменное разрешение — до ${ts(r.followupDueAt)} (п. 18).` : ''}
      ${r.closedAt ? `<br>Закрыт ${ts(r.closedAt)}${r.closedBy ? ' · ' + esc(r.closedBy) : ''}${r.closeNote ? ': ' + esc(r.closeNote) : ''}` : ''}
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        ${a.printPermit ? `<a class="btn primary sm" target="_blank" rel="noopener" href="${P.printUrl(r.id, 'permit')}">${icon('download', 14)}Допуск (печать / PDF)</a>` : ''}
        ${a.downloadPass ? `<a class="btn sm" href="${P.passUrl(r.id)}">${icon('download', 14)}Подписанный ответ СУА${r.passFileName ? ' · ' + esc(r.passFileName) : ''}</a>` : ''}
      </div></section>`;
  }
  if (r.status === 'rejected') return `<section class="verdict r" style="margin:0"><b>Заявка отклонена ${ts(r.reviewedAt)}</b>Причина: ${esc(r.rejectionReason)}</section>`;
  if (r.status === 'withdrawn') return `<section class="verdict r" style="margin:0"><b>Заявка отозвана организацией</b>${esc(r.rejectionReason || '')}</section>`;
  if (r.status === 'revoked') return `<section class="verdict r" style="margin:0"><b>Допуск отозван ${ts(r.revokedAt)}</b>Причина: ${esc(r.revokeReason)}</section>`;
  if (r.status === 'pending_review') {
    return `<section class="verdict w" style="margin:0"><b>На рассмотрении в СУА — ответ до ${dmy(r.reviewDueAt)}</b>
      ${r.branchApproval === 'pending' ? `Ждёт согласования руководства филиала${r.branchApproverName ? ` (${esc(r.branchApproverName)})` : ''}: ${(r.branchReasons || []).map((x) => esc(x.name)).join('; ')}.` : ''}
      ${r.branchApproval === 'approved' ? 'Руководство филиала согласовало.' : ''}</section>`;
  }
  return '';
}

function reviewPanel(c) {
  const r = c.request;
  const a = c.actions;
  const basis = c.basis || {};
  const parts = [];
  if (a.branchDecide) {
    parts.push(`<div class="gate"><h4>Согласование руководства филиала</h4>
      <div class="ref" style="margin-bottom:8px">${(r.branchReasons || []).map((x) => esc(x.name)).join('; ')}.
        ${r.workType === 'emergency' ? 'Аварийные работы: после согласования допуск предоставляется сразу (п. 18).' : ''}</div>
      <textarea id="brNote" placeholder="Комментарий; при отказе — причина"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary" onclick="branchDecide(this,true,'system')">${icon('check', 14)}Согласовать</button>
        <button class="btn" style="border-color:var(--bad);color:var(--bad)" onclick="branchDecide(this,false,'system')">Не согласовать</button></div></div>`);
  } else if (a.recordBranch) {
    parts.push(`<div class="gate"><h4>Согласование руководства филиала ${r.branchDueAt ? `— до ${dmy(r.branchDueAt)}` : ''}</h4>
      <div class="ref" style="margin-bottom:8px">${(r.branchReasons || []).map((x) => esc(x.name)).join('; ')}. Согласует: ${esc(r.branchApproverName || 'не назначен')}.
        Если руководство согласовало устно (при аварии — п. 18) или письмом, отметьте, кто и когда.</div>
      <div class="row"><select id="brChannel"><option value="oral">устно</option><option value="letter">письмом</option></select></div>
      <textarea id="brNote" style="margin-top:8px" placeholder="Например: директор филиала Иванов И.И., по телефону 01.10 в 10:20"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="branchDecide(this,true)">${icon('check', 14)}Отметить согласование</button>
        <button class="btn ghost" onclick="branchDecide(this,false)">Отметить отказ филиала</button></div></div>`);
  }
  if (a.confirmBasis) {
    parts.push(`<div class="gate"><h4>Основание не подтверждено реестром системы</h4>
      <div class="ref" style="margin-bottom:8px">${esc(basis.message || '')}. Проверьте основание по документам и отметьте, чем оно подтверждено.</div>
      ${r.basisType === 'lease' ? `<div class="row"><label class="ref">Договор аренды действует до <input type="date" id="cfUntil" value="${esc(r.basisValidUntil || '')}"></label>
        <label class="ref"><input type="checkbox" id="cfAdd" checked> внести в реестр договоров аренды</label></div>` : ''}
      <textarea id="cfNote" style="margin-top:8px" placeholder="Например: сверено с договором аренды № … от …" oninput="document.getElementById('cfBtn').disabled=this.value.trim().length<3"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="cfBtn" disabled onclick="confirmBasis(this)">${icon('check', 14)}Основание подтверждено</button></div></div>`);
  }
  if (a.approve) {
    parts.push(`<div class="gate"><h4>Выдать допуск</h4>
      <div class="ref" style="margin-bottom:8px">Система сформирует электронный допуск с кодом проверки, направит ответ заявителю и копию — в филиал (п. 15).
        Подписанный ответ можно приложить файлом.</div>
      <div class="row"><input type="file" id="passFile" accept=".pdf,.png,.jpg,.jpeg">
        <button class="btn primary" id="apBtn" onclick="approveRequest(this)">${icon('check', 14)}Выдать допуск</button></div></div>`);
  } else if (r.status === 'pending_review' && a.reject) {
    parts.push(`<div class="note">Выдать допуск можно после ${r.branchApproval === 'pending' ? 'согласования руководства филиала' : ''}${r.branchApproval === 'pending' && a.confirmBasis ? ' и ' : ''}${a.confirmBasis ? 'подтверждения основания' : ''}.</div>`);
  }
  if (a.reject) {
    parts.push(`<div class="gate"><h4>Отклонить</h4>
      <textarea id="rjReason" placeholder="Причина отказа — её увидит организация (п. 17)" oninput="document.getElementById('rjBtn').disabled=!this.value.trim()"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="rjBtn" disabled style="border-color:var(--bad);color:var(--bad)" onclick="rejectRequest(this)">Отклонить</button></div></div>`);
  }
  if (a.finalize) {
    parts.push(`<div class="gate"><h4>Оформить аварийный допуск (п. 18)</h4>
      <div class="ref" style="margin-bottom:8px">${r.letterFileId ? `Оформленный запрос получен: ${esc(r.letterFileName || '')}.` : 'Организация ещё не приложила оформленный запрос.'}
        Направьте письменное разрешение — можно приложить подписанный файл.</div>
      <div class="row"><input type="file" id="finFile" accept=".pdf,.png,.jpg,.jpeg">
        <button class="btn primary" ${r.letterFileId ? '' : 'disabled'} onclick="finalizeEmergency(this)">${icon('check', 14)}Письменное разрешение направлено</button></div></div>`);
  }
  if (a.revoke) {
    parts.push(`<div class="gate"><h4>Отозвать допуск</h4>
      <textarea id="rvReason" placeholder="Причина: нарушение требований охраны труда, расторжение договора аренды…"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost" style="color:var(--bad)" onclick="revokePermit(this)">Отозвать допуск</button></div></div>`);
  }
  if (!parts.length) return '';
  return `<section class="panel"><div class="panel-head">${icon('shield')}<div><h2>Решение</h2>
    <p>Срок ответа — 14 рабочих дней (п. 14); несоблюдение требований — основание для отказа (п. 17)</p></div></div>
    <div class="panel-body decision">${parts.join('')}</div></section>`;
}

/** Отметки ответственного лица на объекте: инструктаж, СИЗ, документы, убытие (пп. 21–23). */
function sitePanel(c) {
  const r = c.request;
  const a = c.actions;
  if (!a.siteCheck && !(c.admissions || []).length) return '';
  const date = sheetSiteDate || today();
  const marks = (c.admissions || []).filter((x) => x.work_date === date);
  const markOf = (field, id) => marks.find((x) => x[field] === id);
  const workerRow = (w) => {
    const m = markOf('worker_id', w.workerId);
    if (m) {
      return `<tr><td><b>${esc(w.fullName)}</b></td><td colspan="2">${m.admitted
        ? `<span class="chip g">допущен ${new Date(m.arrived_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
           <span class="ref">инструктаж, запись № ${esc(m.briefing_record)} · СИЗ проверены · ${esc(m.checked_by_name)}</span>
           ${m.left_at ? `<span class="chip n">убыл ${new Date(m.left_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>`
             : a.siteCheck ? `<button class="btn ghost sm" onclick="markLeft(this,'${m.id}')">Убыл с объекта</button>` : ''}`
        : `<span class="chip r">не допущен</span> <span class="ref">${esc(m.refusal_reason || '')}</span>`}</td></tr>`;
    }
    if (!a.siteCheck) return `<tr><td>${esc(w.fullName)}</td><td colspan="2"><span class="ref">отметок нет</span></td></tr>`;
    const id = w.workerId;
    return `<tr data-w="${id}"><td><b>${esc(w.fullName)}</b><br><span class="ref">${w.iin ? 'ИИН ' + esc(w.iin) : esc(w.citizenshipName)} · ${esc(w.position || '')}</span></td>
      <td><div class="site-checks">
        <label><input type="checkbox" data-k="briefingDone"> инструктаж, запись № <input data-k="briefingRecord" style="width:80px"></label>
        <label><input type="checkbox" data-k="clothingOk"> спецодежда</label>
        <label><input type="checkbox" data-k="footwearOk"> спецобувь</label>
        <label><input type="checkbox" data-k="ppeOk"> СИЗ</label>
        <label><input type="checkbox" data-k="documentsOk"> удостоверения сверены</label></div></td>
      <td><div class="row-actions"><button class="btn primary sm" onclick="admitWorker(this,'${id}',true)">Допустить</button>
        <button class="btn ghost sm" onclick="admitWorker(this,'${id}',false)">Не допустить</button></div></td></tr>`;
  };
  const vehicleRow = (v) => {
    const m = markOf('vehicle_id', v.vehicleId);
    return `<tr><td><b>${esc(v.plate)}</b> <span class="ref">${esc(v.model || '')}</span></td><td colspan="2">${m
      ? (m.admitted ? '<span class="chip g">въезд разрешён</span>' : `<span class="chip r">не допущен</span> ${esc(m.refusal_reason || '')}`)
      : a.siteCheck ? `<button class="btn sm" onclick="admitVehicle(this,'${v.vehicleId}')">Разрешить въезд</button>` : '<span class="ref">отметок нет</span>'}</td></tr>`;
  };
  return `<section class="panel"><div class="panel-head">${icon('eye')}<div><h2>Проверка на объекте</h2>
      <p>Инструктаж с записью в журнале, спецодежда, спецобувь, СИЗ. Без СИЗ работы запрещены (п. 22)</p></div>
      <label class="ref" style="margin-left:auto">дата <input type="date" value="${esc(date)}" min="${esc((r.periodStart || '').slice(0, 10))}"
        max="${esc((r.periodEnd || '').slice(0, 10))}" onchange="sheetSiteDate=this.value;renderSheet()"></label></div>
    <div class="panel-body scroll-x" style="padding:0 6px"><table><tbody>
      ${c.workers.map(workerRow).join('')}${c.vehicles.map(vehicleRow).join('')}
    </tbody></table></div>
    ${a.close ? `<div class="panel-body"><div class="gate"><h4>Работы завершены</h4>
      <textarea id="clNote" placeholder="Замечания по выполнению работ, если есть"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" onclick="closePermit(this)">${icon('check', 14)}Закрыть допуск</button></div></div></div>` : ''}
  </section>`;
}

let sheetSiteDate = null;

function renderSheet() {
  const c = sheetCard;
  const r = c.request;
  const a = c.actions;
  const staff = !isContractor();
  const start = r.periodStart ? r.periodStart.slice(0, 10) : null;
  const end = r.periodEnd ? r.periodEnd.slice(0, 10) : null;
  const scanLink = (fileId, label) => (a.openScans && fileId
    ? `<a class="ref" href="${P.fileUrl(fileId, staff ? r.id : undefined)}" target="_blank" rel="noopener">${esc(label || 'скан')}</a>` : '');
  const basis = c.basis || {};

  const history = staff
    ? (c.history || []).map((e) => `<div class="e"><time>${ts(e.occurred_at)}</time><span><b>${esc(e.action)}</b>
        ${e.result === 'denied' ? '<span class="chip r">отказ</span>' : ''}<br><span class="ref">${esc(e.actor_name || '')}${e.detail ? ' · ' + esc(e.detail) : ''}</span></span></div>`).join('')
    : (c.history || []).map((e) => `<div class="e"><time>${ts(e.at)}</time><span>${esc(e.text)}</span></div>`).join('');

  const contractorActions = [
    a.edit ? `<button class="btn primary sm" onclick="continueDraft('${r.id}')">Продолжить заполнение</button>` : '',
    a.delete ? `<button class="btn ghost sm" onclick="deleteDraft(this)">${icon('trash', 14)}Удалить черновик</button>` : '',
    a.extend ? `<button class="btn primary sm" onclick="extendPermit(this)">${icon('refresh', 14)}Продлить допуск</button>` : '',
    a.copy ? `<button class="btn sm" onclick="copyRequest(this)">${icon('copy', 14)}Подать повторно</button>` : '',
    a.withdraw ? `<button class="btn ghost sm" onclick="withdrawRequest(this)">Отозвать заявку</button>` : '',
    a.printLetter && r.status !== 'draft' ? `<a class="btn ghost sm" target="_blank" rel="noopener" href="${P.printUrl(r.id, 'letter')}">Запрос и Приложение 1</a>` : '',
  ].filter(Boolean).join('');

  document.getElementById('sheetPanel').innerHTML = `
  <div class="sheet-head"><div class="row">
    <div><div class="ref">Заявка на допуск</div><h2>${esc(r.number)}</h2></div>
    <div style="display:flex;gap:6px;align-items:center;margin-left:8px;flex-wrap:wrap">${statusChip(r)} ${urgentChip(r)} ${branchChip(r)}</div>
    <button class="btn ghost" style="margin-left:auto" onclick="closeSheet()" aria-label="Закрыть">${icon('close', 16)}</button>
  </div></div>
  <div class="sheet-body">
    ${decisionBanner(c)}
    ${a.uploadLetter && r.status === 'approved' ? `<section class="gate"><h4>Приложите оформленный запрос (п. 18)</h4>
      <div class="ref" style="margin-bottom:8px">Аварийный допуск предоставлен по устному согласованию. Подписанный запрос со списком
        работников по Приложению 1 — до ${ts(r.followupDueAt)}.</div>
      <div class="row"><a class="btn sm" target="_blank" rel="noopener" href="${P.printUrl(r.id, 'letter')}">Сформировать запрос</a>
        <label class="btn sm primary">${icon('upload', 14)}Приложить скан<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg" onchange="uploadLetterLater(this)"></label>
        ${r.letterFileName ? `<span class="chip g">${esc(r.letterFileName)}</span>` : ''}</div></section>` : ''}
    ${reviewPanel(c)}
    ${contractorActions ? `<div class="row-actions" style="justify-content:flex-start">${contractorActions}</div>` : ''}
    ${sitePanel(c)}
    <section class="panel"><div class="panel-body"><div class="kv">
      <b>Организация</b><span>${esc(r.counterpartyName)} · БИН ${esc(r.counterpartyBin)}${r.ownerBin ? `<br><span class="ref">подрядчик арендатора ${esc(r.ownerName)} (БИН ${esc(r.ownerBin)})</span>` : ''}</span>
      <b>Цель работ</b><span>${esc(r.workTypeName || '—')}${r.onAms ? ' · <b>на АМС</b>' : ''}${r.description ? `<br><span class="ref">${esc(r.description)}</span>` : ''}</span>
      <b>Объект</b><span>${esc(r.facilityName || '—')}<br><span class="ref">инв. № ${esc(r.facilityInvNo || '—')} · ${esc(r.facilityAddress || '')} · ${esc(r.branchName || '')}</span></span>
      <b>Период работ</b><span>${period(r)}<br><span class="ref">ежедневно ${hours(r)}</span></span>
      <b>Основание</b><span>${r.basisType ? `${esc(r.basisTypeName)} № ${esc(r.basisNumber)}${r.basisDate ? ' от ' + dmy(r.basisDate) : ''}${r.basisValidUntil ? ', до ' + dmy(r.basisValidUntil) : ''} ${basisChip(r)}` : 'не требуется (п. 14)'}
        ${r.basisFileId ? `<br>${scanLink(r.basisFileId, 'скан основания: ' + (r.basisFileName || ''))}` : ''}
        ${basis.message && r.basisType ? `<br><span class="ref">${esc(basis.message)}</span>` : ''}
        ${r.basisConfirmedAt && staff ? `<br><span class="ref">подтверждено вручную ${ts(r.basisConfirmedAt)} · ${esc(r.basisConfirmedBy || '')}: ${esc(r.basisConfirmNote || '')}</span>` : ''}</span>
      <b>Запрос</b><span>${r.letterNumber ? `исх. № ${esc(r.letterNumber)} от ${dmy(r.letterDate)}` : '—'}${r.signatoryName ? ` · ${esc(r.signatoryName)}, ${esc(r.signatoryPosition)}` : ''}
        ${r.letterFileId ? `<br>${scanLink(r.letterFileId, 'скан запроса: ' + (r.letterFileName || ''))}` : ''}</span>
      ${r.branchApproval !== 'not_required' ? `<b>Согласование филиала</b><span>${esc(r.branchApprovalName)} · ${(r.branchReasons || []).map((x) => esc(x.name)).join('; ')}
        ${staff && r.branchApproverName ? `<br><span class="ref">согласует ${esc(r.branchApproverName)}${r.branchDueAt ? ', до ' + dmy(r.branchDueAt) : ''}</span>` : ''}
        ${r.branchDecidedAt ? `<br><span class="ref">${ts(r.branchDecidedAt)}${r.branchDecidedBy ? ' · ' + esc(r.branchDecidedBy) : ''}${r.branchChannel && r.branchChannel !== 'system' ? ` (${r.branchChannel === 'oral' ? 'устно' : 'письмом'})` : ''}${r.branchNote ? ': ' + esc(r.branchNote) : ''}</span>` : ''}</span>` : ''}
      <b>Отправлена</b><span>${ts(r.submittedAt)}${staff && r.createdBy ? ` · ${esc(r.createdBy)}` : ''}${r.reviewDueAt ? ` · ответ до ${dmy(r.reviewDueAt)}` : ''}</span>
      ${staff && r.assigneeName ? `<b>Рассматривает</b><span>${esc(r.assigneeName)}</span>` : ''}
      ${r.reviewedAt && staff ? `<b>Решение СУА</b><span>${esc(r.reviewedBy || '')} · ${ts(r.reviewedAt)}</span>` : ''}
      ${r.siteOfficerName ? `<b>На объекте</b><span>${esc(r.siteOfficerName)}</span>` : ''}
      ${r.extendsNumber ? `<b>Продление</b><span>допуска ${esc(r.extendsNumber)} (п. 19)</span>` : ''}
    </div></div></section>
    <section class="panel"><div class="panel-head">${icon('users')}<div><h2>Работники · ${c.workers.length} чел.</h2>
      <p>Сведения по Приложению 1 и документы${r.status === 'draft' ? '' : ' — на момент отправки заявки'}</p></div></div>
      <div class="panel-body scroll-x" style="padding:0 6px"><table><thead><tr><th>Работник</th><th>Приложение 1</th><th>Документы</th></tr></thead><tbody>
      ${c.workers.map((w) => `<tr><td><b>${esc(w.fullName)}</b>${w.personal?.fullNameLatin ? `<br><span class="ref">${esc(w.personal.fullNameLatin)}</span>` : ''}
          <br><span class="ref">${w.iin ? 'ИИН ' + esc(w.iin) + ' · ' : ''}${esc(w.citizenshipName || '')}${w.position ? ' · ' + esc(w.position) : ''}</span></td>
        <td class="ref">${w.personal ? `${dmy(w.personal.birthDate)}, ${esc(w.personal.birthPlace)}<br>${esc(w.personal.idDocNumber)}, ${dmy(w.personal.idDocIssuedAt)}, ${esc(w.personal.idDocIssuedBy)}<br>${esc(w.personal.address)}${w.employer ? '<br>' + esc(w.employer) : ''}` : '—'}</td>
        <td><div class="docs">${w.documents.map((d) => `<span>${d.kind !== 'qualification' ? DOC_KIND[d.kind] + ': ' : ''}${esc(d.title)}${d.number ? ' № ' + esc(d.number) : ''} ${docChip(d, start, end)} ${scanLink(d.fileId)}</span>`).join('')}</div></td></tr>`).join('')
        || emptyRow(3, 'Бригада не указана')}
      </tbody></table></div></section>
    ${c.vehicles.length ? `<section class="panel"><div class="panel-head">${icon('truck')}<h2>Транспорт</h2></div>
      <div class="panel-body" style="padding:0 6px"><table><thead><tr><th>Госномер</th><th>Марка</th><th>Водитель</th></tr></thead><tbody>
      ${c.vehicles.map((v) => `<tr><td><b>${esc(v.plate)}</b></td><td>${esc(v.model || '—')}</td><td>${esc(v.driverName || '—')}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}
    ${c.issues?.length && r.status === 'draft' ? `<div class="blocked">${c.issues.map((i) => esc(i.message)).join('<br>')}</div>` : ''}
    <section class="panel"><div class="panel-head">${icon('clock')}<h2>История</h2></div>
      <div class="panel-body"><div class="hist">${history || '<span class="ref">Пусто</span>'}</div></div></section>
  </div>`;
}

async function afterDecision(card, text) {
  if (!card) return;
  toast(text, 'good');
  showCard(card);
  state.meta = await P.meta().catch(() => state.meta);
  await reload();
}

async function confirmBasis(button) {
  const r = sheetCard.request;
  const note = document.getElementById('cfNote').value.trim();
  const until = document.getElementById('cfUntil')?.value || undefined;
  const add = document.getElementById('cfAdd') ? document.getElementById('cfAdd').checked : undefined;
  const card = await act(button, () => P.confirmBasis(r.id, { version: r.version, note, validUntil: until, addToRegistry: add }));
  await afterDecision(card, 'Основание подтверждено');
}

async function branchDecide(button, approved, channel) {
  const r = sheetCard.request;
  const note = document.getElementById('brNote').value.trim();
  const ch = channel || document.getElementById('brChannel')?.value || 'oral';
  if (!approved && !note) return toast('Укажите причину', 'bad');
  const card = await act(button, () => P.branchDecision(r.id, { version: r.version, approved, note, channel: ch }));
  await afterDecision(card, approved ? 'Согласование отмечено' : 'Отказ филиала отмечен — заявка отклонена');
}

async function approveRequest(button) {
  const r = sheetCard.request;
  const file = document.getElementById('passFile').files[0];
  const form = new FormData();
  form.set('version', String(r.version));
  if (file) form.set('file', file, file.name);
  const card = await act(button, () => P.approve(r.id, form));
  await afterDecision(card, 'Допуск выдан: организация и филиал уведомлены');
}

async function finalizeEmergency(button) {
  const r = sheetCard.request;
  const file = document.getElementById('finFile').files[0];
  const form = new FormData();
  form.set('version', String(r.version));
  if (file) form.set('file', file, file.name);
  const card = await act(button, () => P.finalize(r.id, form));
  await afterDecision(card, 'Аварийный допуск оформлен');
}

async function rejectRequest(button) {
  const r = sheetCard.request;
  const reason = document.getElementById('rjReason').value.trim();
  if (!reason) return toast('Укажите причину отказа', 'bad');
  const card = await act(button, () => P.reject(r.id, { version: r.version, reason }));
  await afterDecision(card, 'Заявка отклонена');
}

async function revokePermit(button) {
  const r = sheetCard.request;
  const reason = document.getElementById('rvReason').value.trim();
  if (reason.length < 3) return toast('Укажите причину отзыва', 'bad');
  if (!confirm('Отозвать допуск? Организация и филиал получат уведомление.')) return;
  const card = await act(button, () => P.revoke(r.id, { version: r.version, reason }));
  await afterDecision(card, 'Допуск отозван');
}

async function closePermit(button) {
  const r = sheetCard.request;
  const note = document.getElementById('clNote').value.trim();
  if (!confirm('Закрыть допуск: работы завершены?')) return;
  const card = await act(button, () => P.close(r.id, { version: r.version, note }));
  await afterDecision(card, 'Допуск закрыт');
}

async function admitWorker(button, workerId, admitted) {
  const row = button.closest('tr');
  const get = (k) => row.querySelector(`[data-k="${k}"]`);
  const body = {
    workDate: sheetSiteDate || today(), workerId, admitted,
    briefingDone: get('briefingDone').checked, briefingRecord: get('briefingRecord').value.trim(),
    clothingOk: get('clothingOk').checked, footwearOk: get('footwearOk').checked, ppeOk: get('ppeOk').checked,
    documentsOk: get('documentsOk').checked,
  };
  if (!admitted) {
    const v = await dialog({ title: 'Работник не допущен', fields: [{ key: 'reason', label: 'Причина', type: 'textarea', required: true,
      value: !body.ppeOk || !body.clothingOk || !body.footwearOk ? 'Не укомплектован спецодеждой, обувью или СИЗ (п. 22)' : '' }], ok: 'Сохранить' });
    if (!v) return;
    body.refusalReason = v.reason;
  }
  const res = await act(button, () => P.admit(sheetCard.request.id, body), admitted ? 'Работник допущен' : 'Отметка сохранена');
  if (res) { sheetCard.admissions = res.admissions; renderSheet(); }
}

async function admitVehicle(button, vehicleId) {
  const res = await act(button, () => P.admit(sheetCard.request.id, { workDate: sheetSiteDate || today(), vehicleId, admitted: true }), 'Въезд разрешён');
  if (res) { sheetCard.admissions = res.admissions; renderSheet(); }
}

async function markLeft(button, admissionId) {
  const res = await act(button, () => P.left(sheetCard.request.id, admissionId), 'Убытие отмечено');
  if (res) { sheetCard.admissions = res.admissions; renderSheet(); }
}

async function deleteDraft(button) {
  if (!confirm('Удалить черновик?')) return;
  if (await act(button, () => P.remove(sheetCard.request.id), 'Черновик удалён')) { closeSheet(); await reload(); }
}

async function copyRequest(button) {
  const card = await act(button, () => P.copy(sheetCard.request.id), 'Создан черновик по этой заявке');
  if (card) continueDraft(card.request.id);
}

async function extendPermit(button) {
  const card = await act(button, () => P.extend(sheetCard.request.id), 'Создан запрос на продление: укажите новый период и приложите подписанный запрос');
  if (card) continueDraft(card.request.id);
}

async function withdrawRequest(button) {
  const v = await dialog({ title: 'Отозвать заявку', text: 'Заявка будет снята с рассмотрения.', ok: 'Отозвать',
    fields: [{ key: 'reason', label: 'Причина', type: 'textarea' }] });
  if (!v) return;
  const card = await act(button, () => P.withdraw(sheetCard.request.id, { version: sheetCard.request.version, reason: v.reason }), 'Заявка отозвана');
  if (card) { showCard(card); await reload(); }
}

async function uploadLetterLater(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.set('file', file, file.name);
  const card = await act(null, () => P.letterFile(sheetCard.request.id, form), 'Оформленный запрос приложен');
  if (card) showCard(card);
}

/* ------------------------------ договоры аренды ------------------------------ */

const leaseFilter = { q: '', expiring: '' };
function setLease(key, value) { leaseFilter[key] = value; reload(); }
let leaseImport = null;

function renderLeases() {
  const editable = can('permit.review') || isAdmin();
  const res = leaseImport?.result;
  return `<div class="filters">
    <input type="search" placeholder="Номер договора, арендатор, БИН" value="${esc(leaseFilter.q)}" style="min-width:260px"
      onkeydown="if(event.key==='Enter')setLease('q',this.value)" onchange="setLease('q',this.value)">
    <label class="ref" style="display:flex;gap:6px;align-items:center"><input type="checkbox" ${leaseFilter.expiring ? 'checked' : ''}
      onchange="setLease('expiring', this.checked ? 30 : '')"> истекают в ближайшие 30 дней</label>
    <span class="ref">Договоров: ${state.leases.length}</span>
    ${editable ? `<button class="btn primary sm" style="margin-left:auto" onclick="editLease(null)">${icon('plus', 15)}Договор</button>
      <label class="btn sm">${icon('upload', 15)}Загрузить из таблицы<input type="file" hidden accept=".csv,text/csv" onchange="readLeaseImport(this)"></label>` : ''}
  </div>
  ${res ? `<section class="panel" style="margin-bottom:16px">
    <div class="panel-head"><div><h2>${res.preview ? 'Предпросмотр загрузки' : 'Загрузка выполнена'}</h2>
      <p>Строк: ${res.summary.total} · будет записано: ${res.summary.save} · с ошибками: ${res.summary.skip}</p></div>
      ${res.preview && res.summary.save ? `<button class="btn primary sm" style="margin-left:auto" onclick="applyLeaseImport(this)">Записать: ${res.summary.save}</button>` : ''}
      <button class="btn ghost sm" ${res.preview && res.summary.save ? '' : 'style="margin-left:auto"'} onclick="leaseImport=null;render()">Закрыть</button></div>
    <div class="panel-body scroll-x" style="padding:0 6px"><table><thead><tr><th>Строка</th><th>Договор</th><th>Результат</th></tr></thead><tbody>
    ${res.rows.map((x) => `<tr><td>${x.line}</td><td>${esc(x.lease.number)} · ${esc(x.lease.company)} (${esc(x.lease.bin)}), до ${dmy(x.lease.validUntil)}</td>
      <td>${x.action === 'save' ? '<span class="chip g">запись</span>' : '<span class="chip r">пропуск</span>'}
        ${Object.values(x.errors).map((m) => `<br><span class="ref" style="color:var(--bad)">${esc(m)}</span>`).join('')}</td></tr>`).join('')}
    </tbody></table></div></section>` : ''}
  <section class="panel"><div class="panel-body scroll-x" style="padding:0 6px"><table>
    <thead><tr><th>Договор</th><th>Арендатор</th><th>Объекты</th><th>Срок действия</th><th>Источник</th>${editable ? '<th></th>' : ''}</tr></thead><tbody>
    ${state.leases.length ? state.leases.map((l) => `<tr>
      <td><b>№ ${esc(l.number)}</b>${l.contract_date ? `<br><span class="ref">от ${dmy(l.contract_date)}</span>` : ''}</td>
      <td>${esc(l.counterparty_name)}<br><span class="ref">БИН ${esc(l.counterparty_bin)}</span></td>
      <td>${esc(l.facility_names || 'все объекты организации')}</td>
      <td>${l.valid_from ? dmy(l.valid_from) + ' — ' : 'до '}${dmy(l.valid_until)}
        ${l.status === 'terminated' ? '<span class="chip r">расторгнут</span>' : daysTo(l.valid_until) < 0 ? '<span class="chip r">истёк</span>' : daysTo(l.valid_until) <= 30 ? '<span class="chip w">истекает</span>' : ''}</td>
      <td class="ref">${{ manual: 'внесён вручную', import: 'загрузка', confirmation: 'подтверждён по заявке' }[l.source] || l.source}</td>
      ${editable ? `<td><button class="btn ghost sm" onclick="editLease('${l.id}')">Изменить</button></td>` : ''}</tr>`).join('')
      : emptyRow(6, 'Реестр пуст. Загрузите таблицу договоров аренды (колонки: Номер; Дата; БИН; Арендатор; Объекты — инв. № через «|»; Начало; Окончание; Статус) или внесите договор вручную.')}
    </tbody></table></div></section>`;
}

async function editLease(id) {
  const l = id ? state.leases.find((x) => x.id === id) : null;
  const values = await dialog({
    title: l ? 'Договор аренды' : 'Новый договор аренды', wide: true,
    fields: [
      { key: 'number', label: 'Номер договора', required: true, value: l?.number },
      { key: 'contractDate', label: 'Дата договора', type: 'date', value: l?.contract_date },
      { key: 'bin', label: 'БИН арендатора', required: true, value: l?.counterparty_bin, maxlength: 12, inputmode: 'numeric' },
      { key: 'company', label: 'Наименование арендатора', value: l?.counterparty_name, hint: 'Нужно, если организации нет в справочнике' },
      { key: 'validFrom', label: 'Действует с', type: 'date', value: l?.valid_from },
      { key: 'validUntil', label: 'Действует до', type: 'date', required: true, value: l?.valid_until },
      { key: 'status', label: 'Статус', type: 'select', value: l?.status || 'active', options: [{ value: 'active', label: 'действует' }, { value: 'terminated', label: 'расторгнут' }] },
      { key: 'facilityIds', label: 'Объекты (не выбраны — все объекты арендатора)', type: 'checks', value: l?.facility_ids || [], span: true,
        options: state.meta.facilities.map((f) => ({ value: f.id, label: f.name, sub: esc(`инв. № ${f.inv_no} · ${f.branch_name}`) })) },
      { key: 'note', label: 'Примечание', type: 'textarea', value: l?.note, span: true },
    ],
  });
  if (!values) return;
  if (await act(null, () => P.saveLease({ id: l?.id, ...values }), 'Договор сохранён')) await reload();
}

async function readLeaseImport(input) {
  const file = input.files[0];
  if (!file) return;
  const csv = await file.text();
  const result = await act(null, () => P.importLeases(csv, false));
  if (result) { leaseImport = { csv, result }; render(); }
}

async function applyLeaseImport(button) {
  const result = await act(button, () => P.importLeases(leaseImport.csv, true), 'Реестр договоров аренды загружен');
  if (result) { leaseImport.result = result; await reload(); }
}

/* ---------------------------------- отчёт ---------------------------------- */

const reportFilter = { dateFrom: '', dateTo: '', branchId: '', facilityId: '', status: '', workType: '', urgent: false };
function setReport(key, value) { reportFilter[key] = value; }

function renderReport() {
  const r = state.report || { rows: [], summary: {} };
  const s = r.summary;
  const statuses = Object.entries(state.meta.statuses).filter(([k]) => k !== 'draft');
  return `<div class="filters">
    <label class="ref">с <input type="date" value="${reportFilter.dateFrom}" onchange="setReport('dateFrom',this.value)"></label>
    <label class="ref">по <input type="date" value="${reportFilter.dateTo}" onchange="setReport('dateTo',this.value)"></label>
    ${branchSelect(reportFilter.branchId, "setReport('branchId',this.value)")}
    <select onchange="setReport('facilityId',this.value)"><option value="">Все объекты</option>
      ${state.meta.facilities.map((f) => `<option value="${f.id}" ${reportFilter.facilityId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
    ${workTypeSelect(reportFilter.workType, "setReport('workType',this.value)")}
    <select onchange="setReport('status',this.value)"><option value="">Все статусы</option>
      ${statuses.map(([k, n]) => `<option value="${k}" ${reportFilter.status === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <label class="ref" style="display:flex;gap:6px;align-items:center"><input type="checkbox" ${reportFilter.urgent ? 'checked' : ''}
      onchange="setReport('urgent', this.checked ? 1 : false)"> срочные</label>
    <button class="btn primary sm" onclick="reload()">${icon('refresh', 14)}Сформировать</button>
    <a class="btn sm" href="${P.reportUrl({ ...clean(reportFilter), format: 'xlsx' })}">${icon('download', 14)}XLSX</a>
    <a class="btn sm" href="${P.reportUrl({ ...clean(reportFilter), format: 'csv' })}">CSV</a>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="big">${s.total ?? 0}</div><span>заявок за период</span></div>
    <div class="kpi"><div class="big">${s.approved ?? 0}</div><span>допусков выдано</span></div>
    <div class="kpi"><div class="big">${s.rejected ?? 0}</div><span>отклонено · отозвано организацией ${s.withdrawn ?? 0}</span></div>
    <div class="kpi"><div class="big">${s.pending ?? 0}</div><span>на рассмотрении · просрочено ${s.overdue ?? 0}</span></div>
    <div class="kpi"><div class="big">${s.avgDecisionHours ?? '—'}<small>ч</small></div><span>среднее время до решения · медиана ${s.medianDecisionHours ?? '—'} ч</span></div>
    <div class="kpi"><div class="big">${s.branchApproval ?? 0}</div><span>с согласованием филиала · аварийных ${s.emergency ?? 0}</span></div>
    <div class="kpi"><div class="big">${s.manualBasis ?? 0}</div><span>основание подтверждено вручную · допусков отозвано ${s.revoked ?? 0}</span></div>
  </div>
  ${(s.rejectionReasons || []).length ? `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Причины отказов</h2></div>
    <div class="panel-body" style="padding:0 6px"><table><tbody>${s.rejectionReasons.map((x) => `<tr><td>${esc(x.reason)}</td><td class="num">${x.count}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
  ${requestTable(r.rows, 'За период заявок нет')}`;
}

/* -------------------------------- настройки -------------------------------- */

function renderSettings() {
  const s = state.settings;
  const admin = isAdmin();
  const rules = s.rules;
  const ruleField = (key, label, type = 'number') => `<div class="field"><label>${label}</label>
    <input data-rule="${key}" type="${type}" value="${esc(rules[key])}" ${admin ? '' : 'disabled'}></div>`;
  return `<section class="panel" style="margin-bottom:16px"><div class="panel-head">${icon('sliders')}<div><h2>Режим проверки оснований</h2>
    <p>Мягкий — не найдено или истекло: предупреждение и ручное подтверждение СУА. Строгий — заявку отправить нельзя.</p></div></div>
    <div class="panel-body scroll-x" style="padding:0 6px"><table><thead><tr><th>Тип основания</th><th>Где ищется</th><th>Режим</th></tr></thead><tbody>
    ${Object.entries(s.basisTypes).map(([k, name]) => {
      const where = { tu: 'ТУ в архиве модуля ОР ПСД', smr_contract: 'договоры модуля ОР ПСД', transfer_act: 'архив актов',
        lease: 'реестр договоров аренды СУА', order: 'распоряжения в архиве актов' }[k];
      return `<tr><td><b>${esc(name)}</b></td><td>${where}</td><td>${admin
        ? `<select data-mode="${k}"><option value="soft" ${s.modes[k] === 'soft' ? 'selected' : ''}>мягкий</option>
            <option value="strict" ${s.modes[k] === 'strict' ? 'selected' : ''}>строгий</option></select>`
        : `<span class="chip ${s.modes[k] === 'strict' ? 'r' : 'w'}">${s.modes[k] === 'strict' ? 'строгий' : 'мягкий'}</span>`}</td></tr>`;
    }).join('')}
    </tbody></table></div></section>
  <section class="panel" style="margin-bottom:16px"><div class="panel-head">${icon('clock')}<div><h2>Сроки и пределы Инструкции</h2>
    <p>Значения по Инструкции о допуске; меняются, только если изменится сама Инструкция</p></div></div>
    <div class="panel-body"><div class="form-grid">
      ${ruleField('reviewDays', 'Срок ответа СУА, рабочих дней (п. 14)')}
      ${ruleField('branchDays', 'Срок согласования филиалом, рабочих дней')}
      ${ruleField('maxCrew', 'Человек одновременно без согласования филиала (п. 14)')}
      ${ruleField('followupDays', 'Аварийный допуск: досылка запроса, календарных дней (п. 18)')}
      ${ruleField('nightFrom', 'Ночное время с', 'time')}
      ${ruleField('nightTo', 'Ночное время до', 'time')}
    </div></div></section>
  <section class="panel"><div class="panel-head">${icon('users')}<div><h2>Безвизовое пребывание граждан СНГ, дней (п. 16)</h2>
    <p>Срок пребывания на объектах для граждан СНГ определяется сроком безвизового пребывания в Республике Казахстан. Сверьте с действующими соглашениями.</p></div></div>
    <div class="panel-body"><div class="form-grid">
      ${Object.entries(s.cisDays).map(([code, days]) => `<div class="field"><label>${esc(s.countries[code] || code)}</label>
        <input data-cis="${code}" type="number" min="1" max="365" value="${days}" ${admin ? '' : 'disabled'}></div>`).join('')}
    </div></div></section>
  ${admin ? `<div style="margin-top:12px"><button class="btn primary" onclick="saveSettings(this)">Сохранить настройки</button></div>` : ''}
  <div class="note" style="margin-top:14px">По умолчанию действует мягкий режим: ТУ и договоры, выданные до запуска системы, в ней могли не
    учитываться. Строгий режим включает ДИТ, когда СУА сочтёт реестры полными. Все изменения пишутся в журнал.</div>`;
}

async function saveSettings(button) {
  const modes = Object.fromEntries([...document.querySelectorAll('[data-mode]')].map((el) => [el.dataset.mode, el.value]));
  const rules = Object.fromEntries([...document.querySelectorAll('[data-rule]')].map((el) =>
    [el.dataset.rule, el.type === 'number' ? Number(el.value) : el.value]));
  const cisDays = Object.fromEntries([...document.querySelectorAll('[data-cis]')].map((el) => [el.dataset.cis, Number(el.value)]));
  if (await act(button, () => P.saveSettings({ modes, rules, cisDays }), 'Настройки сохранены')) {
    state.meta = await P.meta();
    await reload();
  }
}

boot();
