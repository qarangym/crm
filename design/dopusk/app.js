/**
 * Портал допусков СУА — первый этап (docs/План_модуля_допусков.md).
 *
 * Отдельная ссылка `/dopusk/` в той же системе: вход, учётные записи,
 * оформление и клиент API — общие с рабочим местом ОР ПСД.
 *
 * Подрядчик: мастер заявки (Объект → Основание → Период → Бригада →
 * Транспорт → Проверка), «Мои заявки», работники, удостоверения, транспорт,
 * сохранённые бригады. Специалист СУА: очередь (срочные — сверху), карточка,
 * ручное подтверждение основания, одобрение с файлом допуска, отказ с причиной,
 * отчёт. Все проверки повторяются на сервере — интерфейс лишь подсказывает.
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
  check: (id) => api.call('POST', `/permits/requests/${id}/check`, {}),
  submit: (id, body) => api.call('POST', `/permits/requests/${id}/submit`, body),
  basisFile: (id, form) => api.call('POST', `/permits/requests/${id}/basis-file`, form),
  basisFileDelete: (id) => api.call('POST', `/permits/requests/${id}/basis-file/delete`, {}),
  confirmBasis: (id, body) => api.call('POST', `/permits/requests/${id}/confirm-basis`, body),
  approve: (id, form) => api.call('POST', `/permits/requests/${id}/approve`, form),
  reject: (id, body) => api.call('POST', `/permits/requests/${id}/reject`, body),
  basisOptions: (facilityId) => api.call('GET', '/permits/basis-options' + api.query({ facilityId })),
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
  saveSettings: (modes) => api.call('POST', '/permits/settings', { modes }),
  report: (params) => api.call('GET', '/permits/reports/requests' + api.query(params)),
  fileUrl: (fileId, requestId) => `${api.base}/permits/files/${fileId}` + api.query({ request: requestId, preview: 1 }),
  passUrl: (id) => `${api.base}/permits/requests/${id}/pass-file`,
  reportUrl: (params) => `${api.base}/permits/reports/requests` + api.query(params),
};

/* -------------------------------- состояние -------------------------------- */

const state = {
  me: null,
  meta: null,
  view: '',
  loading: true,
  error: null,
  list: [],
  workers: [],
  vehicles: [],
  crews: [],
  report: null,
  settings: null,
};
const can = (permission) => !!state.me?.permissions?.includes(permission);
const isContractor = () => can('permit.own') && !!state.me?.counterpartyId;
const isStaff = () => can('permit.view') || can('permit.review');

const MENU_CONTRACTOR = [
  ['new', 'Новая заявка', 'filePlus'], ['mine', 'Мои заявки', 'checks'], ['crews', 'Бригады и работники', 'users'],
];
const MENU_STAFF = [
  ['queue', 'Очередь на рассмотрение', 'clock'], ['all', 'Все заявки', 'list'], ['report', 'Отчёт', 'download'],
  ['settings', 'Проверка оснований', 'sliders'],
];
const TITLES = {
  new: ['Заявка на допуск', 'Допуск персонала и техники на объект · рассматривает Служба управления активами'],
  mine: ['Мои заявки', 'Статус заявок, причина отказа, файл допуска'],
  crews: ['Бригады и работники', 'Работники, удостоверения, транспорт и сохранённые бригады вашей организации'],
  queue: ['Очередь на рассмотрение', 'Срочные — сверху, затем по времени отправки'],
  all: ['Заявки на допуск', 'Все отправленные заявки с поиском'],
  report: ['Отчёт по заявкам на допуск', 'Итоги за период и выгрузка в XLSX или CSV'],
  settings: ['Проверка оснований', 'Режим проверки по каждому типу основания'],
};

function viewAllowed(key) {
  if (MENU_CONTRACTOR.some(([k]) => k === key)) return isContractor();
  if (key === 'queue') return can('permit.review');
  if (['all', 'report', 'settings'].includes(key)) return can('permit.view');
  return false;
}

/* ------------------------------- форматы ------------------------------- */

const STATUS_CHIP = { draft: 'n', pending_review: 'w', approved: 'g', rejected: 'r' };
const statusChip = (r) => `<span class="chip ${STATUS_CHIP[r.status] || 'n'}">${esc(r.statusName || r.status)}</span>`;
const urgentChip = (r) => (r.isUrgent ? '<span class="chip r">Срочно</span>' : '');
const dt = (v) => (v ? `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)} ${v.slice(11, 16)}` : '—');
const ts = (v) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const period = (r) => (r.periodStart ? `${dt(r.periodStart)} — ${dt(r.periodEnd)}` : '—');
const dmy = (v) => (v ? v.split('-').reverse().join('.') : '—');
const today = () => new Date().toISOString().slice(0, 10);
const daysTo = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86_400_000);

/** Проверка основания: одна отметка для очереди и карточки. */
function basisChip(r) {
  const c = r.basisCheck || {};
  if (r.status === 'draft') return '';
  if (c.ok) return '<span class="chip g">Подтверждено реестром</span>';
  if (r.basisConfirmedAt) return '<span class="chip g">Подтверждено вручную</span>';
  if (c.needsConfirmation) return '<span class="chip w">Нужна ручная проверка</span>';
  return '';
}

/** Срок удостоверения относительно даты начала работ (или сегодня). */
function docChip(d, startDate) {
  const ref = startDate || today();
  if (d.validUntil < ref) return `<span class="chip r">до ${dmy(d.validUntil)} · истекает до начала работ</span>`;
  if (daysTo(d.validUntil) <= 30) return `<span class="chip w">до ${dmy(d.validUntil)}</span>`;
  return `<span class="chip g">до ${dmy(d.validUntil)}</span>`;
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
 * Диалог с полями, включая файл и список отметок. Обязательные поля
 * проверяются до отправки. Возвращает значения или null.
 */
function dialog({ title, text = '', fields = [], ok = 'Сохранить' }) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'dlg';
    const input = (f) => {
      const id = 'pd-' + f.key;
      if (f.type === 'textarea') return `<textarea id="${id}" rows="${f.rows || 3}">${esc(f.value || '')}</textarea>`;
      if (f.type === 'file') return `<input id="${id}" type="file" accept=".pdf,.png,.jpg,.jpeg">`;
      if (f.type === 'checks') {
        return `<div class="pick-list" id="${id}" style="max-height:260px">${(f.options || []).map((o) => `<label>
          <input type="checkbox" value="${esc(o.value)}" ${(f.value || []).includes(o.value) ? 'checked' : ''}>
          <span>${esc(o.label)}${o.sub ? `<span class="sub">${o.sub}</span>` : ''}</span></label>`).join('')
          || '<div class="ref" style="padding:12px">Список пуст</div>'}</div>`;
      }
      return `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.ph || '')}"
        ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>`;
    };
    box.innerHTML = `<div class="dlg-box" role="dialog" aria-modal="true">
      <header><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</header>
      <div class="body">${fields.map((f) => `<div class="field" data-key="${f.key}">
        <label>${esc(f.label)}${f.required ? '' : ' <span class="ref">необязательно</span>'}</label>${input(f)}
        ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}<div class="err"></div></div>`).join('')}</div>
      <footer><button class="btn" data-act="cancel">Отмена</button>
        <button class="btn primary" data-act="ok">${esc(ok)}</button></footer>
    </div>`;
    const close = (value) => { box.remove(); resolve(value); };
    box.addEventListener('click', (ev) => {
      const action = ev.target.closest('[data-act]')?.dataset.act;
      if (ev.target === box || action === 'cancel') close(null);
      if (action !== 'ok') return;
      const values = {};
      let bad = false;
      for (const f of fields) {
        const el = box.querySelector('#pd-' + f.key);
        let value;
        if (f.type === 'file') value = el.files[0] || null;
        else if (f.type === 'checks') value = [...el.querySelectorAll('input:checked')].map((x) => x.value);
        else value = el.value.trim();
        const empty = value === null || value === '' || (Array.isArray(value) && !value.length);
        const problem = f.required && empty ? 'Заполните поле' : (f.check && !empty ? f.check(value) : '');
        const wrap = box.querySelector(`[data-key="${f.key}"]`);
        wrap.classList.toggle('bad', !!problem);
        wrap.querySelector('.err').textContent = problem || '';
        if (problem) bad = true;
        values[f.key] = value;
      }
      if (!bad) close(values);
    });
    box.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(null); });
    document.body.appendChild(box);
    box.querySelector('input,textarea,select')?.focus();
  });
}

/** Ошибки сервера по полям — в диалог повтора не выносим, показываем текстом. */
const fieldsText = (error) => (error?.fields ? Object.values(error.fields).join('; ') : '');

/* -------------------------------- загрузка -------------------------------- */

async function boot() {
  document.getElementById('brandMark').src = A.mark;
  try {
    state.me = await api.me();
  } catch (error) {
    return renderDenied(error.status === 0
      ? 'Сервер недоступен. Проверьте соединение и обновите страницу.'
      : error.message);
  }
  if (!(state.me.modules || []).includes('permits')) {
    return renderDenied('Портал допусков вашей учётной записи не назначен. Роли назначает ДИТ: «Подрядчик» — ' +
      'представителю сторонней организации, «СУА · допуски» — специалисту Службы управления активами.');
  }
  try {
    state.meta = await P.meta();
  } catch (error) {
    return renderDenied(describeError(error));
  }
  const first = [...MENU_CONTRACTOR, ...MENU_STAFF].map(([k]) => k).find(viewAllowed);
  const fromHash = decodeURIComponent(location.hash.slice(1));
  await go(isContractor() ? 'mine' : first);
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
  if (view === 'all') state.list = (await P.requests(clean(allFilter))).requests;
  if (view === 'crews' || view === 'new') await loadOrganization();
  if (view === 'report') state.report = await P.report(clean(reportFilter));
  if (view === 'settings') state.settings = await P.settings();
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

function renderNav() {
  const item = ([k, label, i]) => `<button class="${state.view === k ? 'on' : ''}" onclick="${k === 'new' ? 'startWizard()' : `go('${k}')`}">${icon(i)}<span>${label}</span></button>`;
  document.getElementById('nav').innerHTML = [...MENU_CONTRACTOR, ...MENU_STAFF].filter(([k]) => viewAllowed(k)).map(item).join('');
  const orpsd = (state.me.modules || []).includes('orpsd');
  document.getElementById('otherLabel').style.display = orpsd ? '' : 'none';
  document.getElementById('navOther').innerHTML = orpsd
    ? `<button onclick="location.href='/'">${icon('archive')}<span>Заявки ОР ПСД и архив актов</span></button>` : '';
  const org = state.meta?.counterparty;
  document.getElementById('who').innerHTML = `<b>${esc(state.me.fullName)}</b>${esc(org ? org.name_full : 'Служба управления активами')}`;
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
    report: renderReport, settings: renderSettings };
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
      <p>Подайте заявку: объект, основание (договор, ТУ или акт приёма-передачи), период работ, бригада с
      удостоверениями и транспорт. Заявку рассматривает Служба управления активами; одобренный допуск скачивается
      здесь же и предъявляется на объекте.</p></div>
    <div class="portal-steps">
      <div><span>01</span><div><b>Бригада</b><small>работники и удостоверения — один раз</small></div></div>
      <div><span>02</span><div><b>Заявка</b><small>объект, основание, период</small></div></div>
      <div><span>03</span><div><b>Допуск</b><small>файл в «Моих заявках»</small></div></div>
    </div>
  </section>
  <section class="panel"><div class="panel-body" style="padding:0 6px">
    <table><thead><tr><th>Заявка</th><th>Объект</th><th>Период работ</th><th>Бригада</th><th>Статус</th><th></th></tr></thead><tbody>
    ${state.list.length ? state.list.map((r) => `<tr style="cursor:pointer" onclick="openCard('${r.id}')">
      <td><b>${esc(r.number)}</b> ${urgentChip(r)}<br><span class="ref">${r.submittedAt ? 'отправлена ' + ts(r.submittedAt) : 'черновик от ' + ts(r.createdAt)}</span></td>
      <td>${esc(r.facilityName || '—')}<br><span class="ref">${esc(r.branchName || '')}</span></td>
      <td>${period(r)}</td>
      <td>${r.workersCount} чел.${r.vehiclesCount ? ` · ${r.vehiclesCount} авто` : ''}</td>
      <td>${statusChip(r)}${r.status === 'rejected' ? `<br><span class="ref">${esc((r.rejectionReason || '').slice(0, 80))}</span>` : ''}</td>
      <td><div class="row-actions">${r.status === 'approved'
        ? `<a class="btn sm primary" href="${P.passUrl(r.id)}" onclick="event.stopPropagation()">${icon('download', 14)}Допуск</a>` : ''}
        ${r.status === 'draft' ? `<button class="btn sm" onclick="event.stopPropagation();continueDraft('${r.id}')">Продолжить</button>` : ''}</div></td>
    </tr>`).join('') : emptyRow(6, 'Заявок пока нет. Начните с раздела «Бригады и работники», затем подайте заявку.')}
    </tbody></table></div></section>`;
}

/* ------------------------ бригады, работники, транспорт ------------------------ */

function renderCrews() {
  const workers = state.workers;
  const crewRows = state.crews.map((c) => {
    const names = c.worker_ids.map((id) => workers.find((w) => w.id === id)?.full_name).filter(Boolean);
    const cars = c.vehicle_ids.map((id) => state.vehicles.find((v) => v.id === id)?.plate).filter(Boolean);
    const expired = c.worker_ids.filter((id) => (workers.find((w) => w.id === id)?.documents || []).some((d) => d.validUntil < today()));
    return `<tr><td><b>${esc(c.name)}</b>${expired.length ? ` <span class="chip r">просрочено: ${expired.length}</span>` : ''}</td>
      <td>${esc(names.join(', ') || '—')}</td><td>${esc(cars.join(', ') || '—')}</td>
      <td><div class="row-actions"><button class="btn ghost sm" onclick="editCrew('${c.id}')">Изменить</button>
        <button class="btn ghost sm" onclick="removeCrew(this,'${c.id}')">Удалить</button></div></td></tr>`;
  }).join('');
  return `
  <section class="panel" style="margin-bottom:16px">
    <div class="panel-head">${icon('users')}<div><h2>Работники</h2>
      <p>ФИО, ИИН, должность и квалификационные документы: скан и срок действия обязательны</p></div>
      <button class="btn primary sm" style="margin-left:auto" onclick="editWorker(null)">${icon('plus', 15)}Работник</button></div>
    <div class="panel-body" style="padding:0 6px"><table>
      <thead><tr><th>Работник</th><th>Удостоверения</th><th></th></tr></thead><tbody>
      ${workers.length ? workers.map((w) => `<tr>
        <td><b>${esc(w.full_name)}</b><br><span class="ref">ИИН ${esc(w.iin)}${w.position ? ' · ' + esc(w.position) : ''}</span></td>
        <td><div class="docs">${w.documents.length ? w.documents.map((d) => `<span>${esc(d.title)}${d.number ? ' № ' + esc(d.number) : ''}
          ${docChip(d)}
          ${d.fileId ? `<a class="ref" href="${P.fileUrl(d.fileId)}" target="_blank" rel="noopener">скан</a>` : ''}
          <button class="btn ghost sm" onclick="editDocument('${w.id}','${d.id}')">Обновить</button>
          <button class="btn ghost sm" onclick="removeDocument(this,'${w.id}','${d.id}')">${icon('trash', 13)}</button></span>`).join('')
          : '<span class="chip r">нет удостоверений</span>'}</div></td>
        <td><div class="row-actions">
          <button class="btn sm" onclick="editDocument('${w.id}',null)">${icon('plus', 13)}Удостоверение</button>
          <button class="btn ghost sm" onclick="editWorker('${w.id}')">Изменить</button>
          <button class="btn ghost sm" onclick="removeWorker(this,'${w.id}')">Исключить</button></div></td>
      </tr>`).join('') : emptyRow(3, 'Добавьте работников, которых направляете на объекты')}
      </tbody></table></div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-head">${icon('users')}<div><h2>Сохранённые бригады</h2>
        <p>В заявке бригада подставляется одним нажатием</p></div>
        <button class="btn primary sm" style="margin-left:auto" onclick="editCrew(null)">${icon('plus', 15)}Бригада</button></div>
      <div class="panel-body" style="padding:0 6px"><table>
        <thead><tr><th>Бригада</th><th>Работники</th><th>Транспорт</th><th></th></tr></thead>
        <tbody>${crewRows || emptyRow(4, 'Сохранённых бригад нет')}</tbody></table></div>
    </section>
    <section class="panel">
      <div class="panel-head">${icon('truck')}<div><h2>Транспорт</h2><p>Если нужен заезд на объект</p></div>
        <button class="btn primary sm" style="margin-left:auto" onclick="editVehicle(null)">${icon('plus', 15)}Транспорт</button></div>
      <div class="panel-body" style="padding:0 6px"><table>
        <thead><tr><th>Госномер</th><th>Марка</th><th>Водитель</th><th></th></tr></thead><tbody>
        ${state.vehicles.length ? state.vehicles.map((v) => `<tr><td><b>${esc(v.plate)}</b></td><td>${esc(v.model || '—')}</td>
          <td>${esc(v.driver_name || '—')}</td><td><div class="row-actions">
          <button class="btn ghost sm" onclick="editVehicle('${v.id}')">Изменить</button>
          <button class="btn ghost sm" onclick="removeVehicle(this,'${v.id}')">Исключить</button></div></td></tr>`).join('')
          : emptyRow(4, 'Транспорт не добавлен')}
        </tbody></table></div>
    </section>
  </div>
  <div class="note" style="margin-top:14px">Сведения о работниках — персональные данные. Их видят только ваша организация и
    Служба управления активами при рассмотрении заявки; каждое открытие скана фиксируется в журнале.</div>`;
}

/** Работник: при создании сразу просим первое удостоверение — без него в заявку не добавить. */
async function editWorker(id) {
  const w = id ? state.workers.find((x) => x.id === id) : null;
  const values = await dialog({
    title: w ? 'Сведения о работнике' : 'Новый работник',
    fields: [
      { key: 'fullName', label: 'Фамилия, имя, отчество', required: true, value: w?.full_name,
        check: (v) => (v.split(/\s+/).length < 2 ? 'Укажите фамилию и имя полностью' : '') },
      { key: 'iin', label: 'ИИН', required: true, value: w?.iin, maxlength: 12, inputmode: 'numeric',
        check: (v) => (/^\d{12}$/.test(v) ? '' : '12 цифр') },
      { key: 'position', label: 'Должность', value: w?.position },
    ],
  });
  if (!values) return;
  const saved = await act(null, () => P.saveWorker({ id: w?.id, ...values }), 'Работник сохранён');
  if (!saved) return;
  await loadOrganization();
  render();
  if (!w) await editDocument(saved.worker.id, null, true);
}

async function editDocument(workerId, docId, first = false) {
  const w = state.workers.find((x) => x.id === workerId);
  const d = docId ? w?.documents.find((x) => x.id === docId) : null;
  const values = await dialog({
    title: d ? 'Обновить удостоверение' : 'Квалификационный документ',
    text: first ? `${esc(w?.full_name || '')}: без удостоверения работника нельзя включить в заявку.`
      : d ? 'Укажите новый срок действия и приложите скан нового документа.' : '',
    fields: [
      { key: 'title', label: 'Наименование документа', required: true, value: d?.title,
        ph: 'Например: удостоверение о допуске к работам на высоте' },
      { key: 'number', label: 'Номер', value: d?.number },
      { key: 'validUntil', label: 'Действует до', type: 'date', required: true, value: d?.validUntil },
      { key: 'file', label: d ? 'Новый скан' : 'Скан документа', type: 'file', required: !d, hint: 'PDF, PNG или JPG, до 20 МБ' },
    ],
  });
  if (!values) return;
  const form = new FormData();
  form.set('title', values.title);
  form.set('number', values.number);
  form.set('validUntil', values.validUntil);
  if (d) form.set('documentId', d.id);
  if (values.file) form.set('file', values.file, values.file.name);
  const ok = await act(null, () => P.workerDocument(workerId, form), d ? 'Удостоверение обновлено' : 'Удостоверение добавлено');
  if (!ok) return;
  await loadOrganization();
  // На шаге «Проверка» замечания по бригаде пересчитываются сразу.
  if (state.view === 'new' && wiz?.card && wiz.step === STEPS.length - 1) {
    wiz.card = await P.request(wiz.card.request.id).catch(() => wiz.card);
    wiz.check = await P.check(wiz.card.request.id).catch(() => wiz.check);
  }
  render();
}

async function removeDocument(button, workerId, docId) {
  if (!confirm('Удалить удостоверение?')) return;
  if (await act(button, () => P.deleteWorkerDocument(workerId, docId), 'Удостоверение удалено')) { await loadOrganization(); render(); }
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
    await loadOrganization(); render(); if (state.view === 'new') renderWizardPanel();
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
      { key: 'name', label: 'Название', required: true, value: c?.name, ph: 'Например: монтажная бригада № 1' },
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

const STEPS = ['Объект', 'Основание', 'Период', 'Бригада', 'Транспорт', 'Проверка'];
let wiz = null;

const newWizard = () => ({
  step: 0, card: null, options: null, check: null, consent: false, facilityQuery: '',
  form: { facilityId: '', basisType: '', basisRefId: '', basisNumber: '', periodStart: '', periodEnd: '', description: '',
    isUrgent: false, crewId: '', workerIds: [], vehicleIds: [] },
});

function startWizard() { wiz = newWizard(); go('new'); }

async function continueDraft(id) {
  const card = await act(null, () => P.request(id));
  if (!card) return;
  closeSheet();
  wiz = newWizard();
  wiz.card = card;
  const r = card.request;
  Object.assign(wiz.form, {
    facilityId: r.facilityId || '', basisType: r.basisType || '', basisRefId: r.basisRefId || '', basisNumber: r.basisNumber,
    periodStart: r.periodStart || '', periodEnd: r.periodEnd || '', description: r.description, isUrgent: r.isUrgent,
    crewId: r.crewId || '', workerIds: card.workers.map((w) => w.workerId), vehicleIds: card.vehicles.map((v) => v.vehicleId),
  });
  if (r.facilityId) wiz.options = await P.basisOptions(r.facilityId).catch(() => null);
  go('new');
}

function renderWizard() {
  return `<div class="steps">${STEPS.map((s, i) => `<div class="${i === wiz.step ? 'cur' : i < wiz.step ? 'passed' : ''}">
    <span class="n">${i < wiz.step ? '✓' : i + 1}</span>${s}</div>`).join('')}</div>
    <div class="wizard"><div id="wizPanel">${wizardStep()}</div>${wizardAside()}</div>`;
}

/** Перерисовка шага без повторной загрузки экрана. */
function renderWizardPanel() {
  const panel = document.getElementById('wizPanel');
  if (panel) panel.innerHTML = wizardStep();
}

function wizardAside() {
  const f = wiz.form;
  const facility = state.meta.facilities.find((x) => x.id === f.facilityId);
  return `<aside class="panel price"><div class="panel-body">
    <h3 style="font-size:14px;margin-bottom:10px">Заявка ${wiz.card ? esc(wiz.card.request.number) : ''}</h3>
    <div class="line"><span>Объект<small>${esc(facility?.branch_name || '')}</small></span><b>${esc(facility?.name || '—')}</b></div>
    <div class="line"><span>Основание</span><b>${f.basisNumber ? esc(f.basisNumber) : '—'}</b></div>
    <div class="line"><span>Период</span><b>${f.periodStart ? dt(f.periodStart) : '—'}</b></div>
    <div class="line"><span>Бригада</span><b>${f.workerIds.length} чел.</b></div>
    <div class="line"><span>Транспорт</span><b>${f.vehicleIds.length}</b></div>
    <div class="disclaimer">${wiz.card ? 'Черновик сохраняется при переходе между шагами.' : 'Черновик сохранится после первого шага.'}
      Заявку рассматривает специалист СУА; решение придёт на почту.</div>
  </div></aside>`;
}

function wizardNav({ next = 'Далее', nextDisabled = false } = {}) {
  return `<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
    ${wiz.step > 0 ? `<button class="btn" onclick="wizardBack()">Назад</button>` : ''}
    ${wiz.step < STEPS.length - 1 ? `<button class="btn primary" onclick="wizardNext(this)" ${nextDisabled ? 'disabled' : ''}>${next}</button>` : ''}
    ${wiz.card ? `<button class="btn ghost" style="margin-left:auto" onclick="saveAndLeave(this)">Сохранить черновик и выйти</button>` : ''}
  </div>`;
}

function wizardStep() {
  const f = wiz.form;
  const step = wiz.step;
  if (step === 0) {
    const q = wiz.facilityQuery.toLowerCase();
    const list = state.meta.facilities.filter((x) => !q || `${x.name} ${x.inv_no} ${x.address} ${x.branch_name}`.toLowerCase().includes(q));
    return `<section class="panel"><div class="panel-body">
      <div class="field"><label>Объект Общества</label>
        <input type="search" placeholder="Название, инвентарный номер, адрес, филиал" value="${esc(wiz.facilityQuery)}"
          oninput="wiz.facilityQuery=this.value;renderWizardPanel();const i=document.querySelector('#wizPanel input');i.focus();i.setSelectionRange(i.value.length,i.value.length)"></div>
      <div class="pick-list" style="margin-top:10px">${list.slice(0, 200).map((x) => `<label>
        <input type="radio" name="wzFacility" value="${x.id}" ${f.facilityId === x.id ? 'checked' : ''} onchange="pickFacility('${x.id}')">
        <span><b>${esc(x.name)}</b><span class="sub">инв. № ${esc(x.inv_no)} · ${esc(x.address || 'адрес не указан')} · ${esc(x.branch_name)}</span></span>
      </label>`).join('') || '<div class="ref" style="padding:12px">Ничего не найдено</div>'}</div>
      <div class="hint" style="margin-top:8px">Филиал определяется по объекту автоматически.</div>
      ${wizardNav({ nextDisabled: !f.facilityId })}
    </div></section>`;
  }
  if (step === 1) {
    const types = state.meta.basisTypes;
    const hints = { lease: 'Номер договора и скан — СУА подтвердит вручную', tu: 'Выданные вашей организации',
      smr_contract: 'Договор на СМР с Обществом', transfer_act: 'Акт по этому объекту в архиве актов' };
    const options = (wiz.options && f.basisType && wiz.options[f.basisType]) || [];
    const verdict = wiz.card?.basis;
    const needScan = f.basisType === 'lease' || (f.basisType === 'transfer_act' && verdict && verdict.needsScan);
    const scan = wiz.card?.request.basisFileId;
    return `<section class="panel"><div class="panel-body">
      <div class="basis-pick">${Object.entries(types).map(([k, name]) => `<label class="${f.basisType === k ? 'on' : ''}">
        <input type="radio" name="wzBasis" value="${k}" ${f.basisType === k ? 'checked' : ''} onchange="pickBasisType('${k}')">
        <span><b>${esc(name)}</b><small>${hints[k]}</small></span></label>`).join('')}</div>
      ${f.basisType && f.basisType !== 'lease' ? `<div class="field" style="margin-top:14px"><label>${esc(types[f.basisType])} вашей организации</label>
        <select onchange="pickBasisRef(this.value)"><option value="">${options.length ? '— выберите —' : 'в системе не найдено'}</option>
        ${options.map((o) => `<option value="${o.id}" ${f.basisRefId === o.id ? 'selected' : ''}>№ ${esc(o.number)}${o.doc_date ? ' от ' + dmy(o.doc_date) : ''}${o.valid_until ? ', до ' + dmy(o.valid_until) : ''}${o.approved === false ? ' · не завизированы' : ''}${o.facility_name ? ' · ' + esc(o.facility_name) : ''}</option>`).join('')}
        </select><div class="hint">Нет в списке? Укажите номер вручную — заявка уйдёт с отметкой для ручной проверки СУА.</div></div>` : ''}
      ${f.basisType ? `<div class="field" style="margin-top:12px"><label>Номер основания</label>
        <input value="${esc(f.basisNumber)}" ${f.basisRefId ? 'readonly' : ''} oninput="wiz.form.basisNumber=this.value;wiz.form.basisRefId=''"
          placeholder="${f.basisType === 'lease' ? 'Номер договора аренды' : 'Если нет в списке'}"></div>` : ''}
      ${needScan || scan ? `<div class="field" style="margin-top:12px"><label>Скан основания ${needScan ? '' : '<span class="ref">необязательно</span>'}</label>
        ${scan ? `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="chip g">${icon('check', 13)}${esc(wiz.card.request.basisFileName)}</span>
          <button class="btn ghost sm" onclick="removeBasisScan(this)">Удалить</button></div>`
          : `<input type="file" accept=".pdf,.png,.jpg,.jpeg" onchange="uploadBasisScan(this)">`}
        <div class="hint">${f.basisType === 'lease' ? 'Договоров аренды в системе нет — нужен скан договора.' : 'Временное основание: акта в архиве нет.'}</div></div>` : ''}
      ${verdict && f.basisType ? verdictBox(verdict) : ''}
      <div style="margin-top:12px"><button class="btn sm" onclick="checkBasis(this)" ${f.basisType ? '' : 'disabled'}>${icon('refresh', 14)}Проверить основание</button></div>
      ${wizardNav({ nextDisabled: !f.basisType || !f.basisNumber.trim() })}
    </div></section>`;
  }
  if (step === 2) {
    const min = state.meta.now;
    return `<section class="panel"><div class="panel-body"><div class="form-grid">
      <div class="field"><label>Начало работ</label><input type="datetime-local" value="${esc(f.periodStart)}" min="${min}"
        onchange="wiz.form.periodStart=this.value"></div>
      <div class="field"><label>Окончание работ</label><input type="datetime-local" value="${esc(f.periodEnd)}" min="${min}"
        onchange="wiz.form.periodEnd=this.value"></div>
      <div class="field span2"><label>Цель и описание работ <span class="ref">необязательно</span></label>
        <textarea oninput="wiz.form.description=this.value" placeholder="Например: монтаж антенны на отметке 45 м">${esc(f.description)}</textarea></div>
    </div>
    <div class="hint" style="margin-top:8px">Время — местное время объекта. На дату начала работ проверяются удостоверения бригады.</div>
    ${wizardNav()}</div></section>`;
  }
  if (step === 3) {
    const start = f.periodStart ? f.periodStart.slice(0, 10) : null;
    const expired = (w) => w.documents.some((d) => d.validUntil < (start || today()));
    return `<section class="panel"><div class="panel-body">
      ${state.crews.length ? `<div class="filters"><select id="wzCrew"><option value="">Сохранённая бригада…</option>
        ${state.crews.map((c) => `<option value="${c.id}" ${f.crewId === c.id ? 'selected' : ''}>${esc(c.name)} · ${c.worker_ids.length} чел.</option>`).join('')}</select>
        <button class="btn sm" onclick="loadCrew()">${icon('users', 14)}Загрузить сохранённую бригаду</button></div>` : ''}
      <div class="pick-list">${state.workers.map((w) => {
        const bad = expired(w) || !w.documents.length;
        const on = f.workerIds.includes(w.id);
        return `<label class="${bad && !on ? 'off' : ''}">
          <input type="checkbox" ${on ? 'checked' : ''} ${bad && !on ? 'disabled' : ''} onchange="toggleWorker('${w.id}', this.checked)">
          <span style="flex:1"><b>${esc(w.full_name)}</b><span class="sub">ИИН ${esc(w.iin)}${w.position ? ' · ' + esc(w.position) : ''}</span>
          <span class="docs" style="margin-top:4px">${w.documents.length ? w.documents.map((d) => `<span>${esc(d.title)} ${docChip(d, start)}</span>`).join('')
            : '<span class="chip r">нет удостоверений</span>'}</span></span>
          ${bad ? `<button class="btn sm" onclick="event.preventDefault();editDocument('${w.id}', ${w.documents[0] ? `'${w.documents[0].id}'` : 'null'})">Обновить</button>` : ''}
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
  const check = wiz.check || { fields: {}, issues: [], basis: c.basis };
  const problems = Object.entries(check.fields || {}).filter(([k]) => k !== 'consent');
  const start = r.periodStart ? r.periodStart.slice(0, 10) : null;
  return `<section class="panel"><div class="panel-body">
    <div class="review-grid">
      <b>Организация</b><span>${esc(r.counterpartyName)} · БИН ${esc(r.counterpartyBin)}</span>
      <b>Объект</b><span>${esc(r.facilityName || '—')}<br><span class="ref">${esc(r.facilityAddress || '')} · ${esc(r.branchName || '')}</span></span>
      <b>Основание</b><span>${esc(r.basisTypeName || '—')} № ${esc(r.basisNumber || '—')}${r.basisFileName ? `<br><span class="ref">скан: ${esc(r.basisFileName)}</span>` : ''}</span>
      <b>Период работ</b><span>${period(r)}</span>
      ${r.description ? `<b>Цель работ</b><span>${esc(r.description)}</span>` : ''}
      <b>Бригада</b><span>${c.workers.map((w) => `${esc(w.fullName)}<br><span class="docs">${w.documents.map((d) => `<span>${esc(d.title)} ${docChip(d, start)}
        ${d.validUntil < (start || today()) ? `<button class="btn ghost sm" onclick="editDocument('${w.workerId}','${d.id}')">Обновить</button>` : ''}</span>`).join('')}</span>`).join('<br>') || '—'}</span>
      <b>Транспорт</b><span>${c.vehicles.map((v) => `${esc(v.plate)} ${esc(v.model)}`).join('<br>') || '—'}</span>
    </div>
    <div style="margin-top:14px">${verdictBox(check.basis || c.basis)}</div>
    ${problems.length ? `<div class="blocked" style="margin-top:12px"><b>Исправьте перед отправкой:</b><br>${problems.map(([, m]) => esc(m)).join('<br>')}</div>` : ''}
    <label class="consent" style="margin-top:14px"><input type="checkbox" ${r.isUrgent ? 'checked' : ''} onchange="setUrgent(this.checked)">
      <span><b>Срочно</b><br>Заявка поднимется в начало очереди СУА; порядок рассмотрения тот же.</span></label>
    <label class="consent" style="margin-top:10px"><input type="checkbox" ${wiz.consent ? 'checked' : ''}
      onchange="wiz.consent=this.checked;document.getElementById('sendBtn').disabled=!this.checked">
      <span>Работники, включённые в заявку, дали согласие на обработку их персональных данных (ФИО, ИИН, сведения
      удостоверений) для оформления допуска на объект.</span></label>
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      <button class="btn" onclick="wizardBack()">Назад</button>
      <button class="btn primary" id="sendBtn" onclick="submitWizard(this)" ${wiz.consent ? '' : 'disabled'}>${icon('arrow', 15)}Отправить на рассмотрение</button>
      <button class="btn ghost" style="margin-left:auto" onclick="saveAndLeave(this)">Сохранить черновик и выйти</button>
    </div>
  </div></section>`;
}

async function pickFacility(id) {
  wiz.form.facilityId = id;
  wiz.options = await P.basisOptions(id).catch(() => null);
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
    facilityId: f.facilityId || null, basisType: f.basisType || null, basisNumber: f.basisNumber,
    basisRefId: f.basisRefId || null, description: f.description, periodStart: f.periodStart || null,
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
  if (wiz.step === 0 && !f.facilityId) return 'Выберите объект';
  if (wiz.step === 1 && (!f.basisType || !f.basisNumber.trim())) return 'Укажите тип и номер основания';
  if (wiz.step === 2) {
    if (!f.periodStart || !f.periodEnd) return 'Укажите начало и окончание работ';
    if (f.periodEnd <= f.periodStart) return 'Окончание работ должно быть позже начала';
  }
  if (wiz.step === 3 && !f.workerIds.length) return 'Выберите работников';
  return '';
}

async function wizardNext(button) {
  const problem = stepProblem();
  if (problem) return toast(problem, 'bad');
  const saved = await act(button, saveDraft);
  if (!saved) return;
  if (wiz.step === 1 && wiz.card.basis?.blocking && wiz.card.basis.code !== 'no_registry' && !wiz.card.basis.needsScan) {
    render();
    return toast(wiz.card.basis.message, 'bad');
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

/* ------------------------------- очередь СУА ------------------------------- */

function requestTable(rows, emptyText) {
  return `<section class="panel"><div class="panel-body" style="padding:0 6px"><table>
    <thead><tr><th>Заявка</th><th>Организация</th><th>Объект</th><th>Период работ</th><th>Основание</th><th>Бригада</th><th>Статус</th></tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr style="cursor:pointer" onclick="openCard('${r.id}')">
      <td><b>${esc(r.number)}</b> ${urgentChip(r)}<br><span class="ref">${ts(r.submittedAt)}</span></td>
      <td>${esc(r.counterpartyName)}<br><span class="ref">БИН ${esc(r.counterpartyBin)}</span></td>
      <td>${esc(r.facilityName || '—')}<br><span class="ref">${esc(r.branchName || '')}</span></td>
      <td>${period(r)}</td>
      <td>${esc(r.basisTypeName || '')} № ${esc(r.basisNumber)}<br>${basisChip(r)}</td>
      <td>${r.workersCount} чел.${r.vehiclesCount ? `<br><span class="ref">${r.vehiclesCount} авто</span>` : ''}</td>
      <td>${statusChip(r)}</td></tr>`).join('') : emptyRow(7, emptyText)}
    </tbody></table></div></section>`;
}

function renderQueue() {
  const urgent = state.list.filter((r) => r.isUrgent).length;
  return `<div class="kpis">
    <div class="kpi"><div class="big">${state.list.length}</div><span>на рассмотрении</span></div>
    <div class="kpi"><div class="big">${urgent}</div><span>срочных</span></div>
    <div class="kpi"><div class="big">${state.list.filter((r) => r.basisCheck?.needsConfirmation && !r.basisConfirmedAt).length}</div><span>основание нужно проверить вручную</span></div>
  </div>${requestTable(state.list, 'Очередь пуста')}`;
}

const allFilter = { status: '', q: '', branchId: '', urgent: false };
function setAll(key, value) { allFilter[key] = value; reload(); }

function renderAll() {
  const statuses = Object.entries(state.meta.statuses).filter(([k]) => k !== 'draft');
  return `<div class="filters">
    <input type="search" placeholder="Номер, организация, БИН, объект, основание" value="${esc(allFilter.q)}" style="min-width:280px"
      onkeydown="if(event.key==='Enter')setAll('q',this.value)" onchange="setAll('q',this.value)">
    <select onchange="setAll('status',this.value)"><option value="">Все статусы</option>
      ${statuses.map(([k, n]) => `<option value="${k}" ${allFilter.status === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <select onchange="setAll('branchId',this.value)"><option value="">Все филиалы</option>
      ${state.meta.branches.map((b) => `<option value="${b.id}" ${allFilter.branchId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <label class="ref" style="display:flex;gap:6px;align-items:center"><input type="checkbox" ${allFilter.urgent ? 'checked' : ''}
      onchange="setAll('urgent', this.checked ? 1 : false)"> только срочные</label>
    <span class="ref">Найдено: ${state.list.length}</span>
  </div>${requestTable(state.list, 'Заявок не найдено')}`;
}

/* --------------------------------- карточка --------------------------------- */

let sheetCard = null;

async function openCard(id) {
  const card = await act(null, () => P.request(id));
  if (card) showCard(card);
}

function closeSheet() { document.getElementById('sheet').classList.remove('on'); sheetCard = null; }

function showCard(card) {
  sheetCard = card;
  document.getElementById('sheet').classList.add('on');
  renderSheet();
}

function renderSheet() {
  const c = sheetCard;
  const r = c.request;
  const a = c.actions;
  const staff = isStaff();
  const start = r.periodStart ? r.periodStart.slice(0, 10) : null;
  const scanLink = (fileId, label) => (a.openScans && fileId
    ? `<a class="ref" href="${P.fileUrl(fileId, staff ? r.id : undefined)}" target="_blank" rel="noopener">${esc(label || 'скан')}</a>` : '');
  const basis = c.basis || {};

  const decision = r.status === 'approved'
    ? `<section class="verdict g" style="margin:0"><b>Заявка одобрена ${ts(r.reviewedAt)}</b>
        Допуск предъявляется на объекте; проверка на въезде — в действующем порядке.
        <div style="margin-top:10px"><a class="btn primary sm" href="${P.passUrl(r.id)}">${icon('download', 14)}Скачать допуск${r.passFileName ? ` · ${esc(r.passFileName)}` : ''}</a></div></section>`
    : r.status === 'rejected'
      ? `<section class="verdict r" style="margin:0"><b>Заявка отклонена ${ts(r.reviewedAt)}</b>Причина: ${esc(r.rejectionReason)}</section>`
      : '';

  const review = (a.confirmBasis || a.approve || a.reject) ? `<section class="panel"><div class="panel-head">${icon('shield')}<div><h2>Решение</h2>
      <p>Рассматривает специалист СУА единолично; решение окончательное</p></div></div><div class="panel-body decision">
      ${a.confirmBasis ? `<div class="gate"><h4>Основание не подтверждено реестром системы</h4>
        <div class="ref" style="margin-bottom:8px">${esc(basis.message || '')}. Проверьте основание по документам и отметьте, чем оно подтверждено.</div>
        <textarea id="cfNote" placeholder="Например: сверено с договором аренды № … от …" oninput="document.getElementById('cfBtn').disabled=this.value.trim().length<3"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" id="cfBtn" disabled onclick="confirmBasis(this)">${icon('check', 14)}Основание подтверждено</button></div></div>` : ''}
      ${a.approve ? `<div class="gate"><h4>Одобрить</h4>
        <div class="ref" style="margin-bottom:8px">Прикрепите готовый файл допуска, оформленный и подписанный по действующему порядку.</div>
        <div class="row"><input type="file" id="passFile" accept=".pdf,.png,.jpg,.jpeg,.docx" onchange="document.getElementById('apBtn').disabled=!this.files.length">
          <button class="btn primary" id="apBtn" disabled onclick="approveRequest(this)">${icon('check', 14)}Одобрить</button></div></div>`
        : (r.status === 'pending_review' && a.reject ? '<div class="note">Одобрить можно после подтверждения основания.</div>' : '')}
      ${a.reject ? `<div class="gate"><h4>Отклонить</h4>
        <textarea id="rjReason" placeholder="Причина отказа — её увидит организация" oninput="document.getElementById('rjBtn').disabled=!this.value.trim()"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" id="rjBtn" disabled style="border-color:var(--bad);color:var(--bad)" onclick="rejectRequest(this)">Отклонить</button></div></div>` : ''}
    </div></section>` : '';

  const history = staff
    ? (c.history || []).map((e) => `<div class="e"><time>${ts(e.occurred_at)}</time><span><b>${esc(e.action)}</b>
        ${e.result === 'denied' ? '<span class="chip r">отказ</span>' : ''}<br><span class="ref">${esc(e.actor_name || '')}${e.detail ? ' · ' + esc(e.detail) : ''}</span></span></div>`).join('')
    : (c.history || []).map((e) => `<div class="e"><time>${ts(e.at)}</time><span>${esc(e.text)}</span></div>`).join('');

  document.getElementById('sheetPanel').innerHTML = `
  <div class="sheet-head"><div class="row">
    <div><div class="ref">Заявка на допуск</div><h2>${esc(r.number)}</h2></div>
    <div style="display:flex;gap:6px;align-items:center;margin-left:8px">${statusChip(r)} ${urgentChip(r)}</div>
    <button class="btn ghost" style="margin-left:auto" onclick="closeSheet()" aria-label="Закрыть">${icon('close', 16)}</button>
  </div></div>
  <div class="sheet-body">
    ${decision}
    ${review}
    ${a.edit || a.delete || a.copy ? `<div class="row-actions" style="justify-content:flex-start">
      ${a.edit ? `<button class="btn primary sm" onclick="continueDraft('${r.id}')">Продолжить заполнение</button>` : ''}
      ${a.delete ? `<button class="btn ghost sm" onclick="deleteDraft(this)">${icon('trash', 14)}Удалить черновик</button>` : ''}
      ${a.copy ? `<button class="btn sm" onclick="copyRequest(this)">${icon('copy', 14)}Подать повторно</button>` : ''}</div>` : ''}
    <section class="panel"><div class="panel-body"><div class="kv">
      <b>Организация</b><span>${esc(r.counterpartyName)} · БИН ${esc(r.counterpartyBin)}</span>
      <b>Объект</b><span>${esc(r.facilityName || '—')}<br><span class="ref">инв. № ${esc(r.facilityInvNo || '—')} · ${esc(r.facilityAddress || '')} · ${esc(r.branchName || '')}</span></span>
      <b>Период работ</b><span>${period(r)}</span>
      ${r.description ? `<b>Цель работ</b><span>${esc(r.description)}</span>` : ''}
      <b>Основание</b><span>${esc(r.basisTypeName || '—')} № ${esc(r.basisNumber || '—')} ${basisChip(r)}
        ${r.basisFileId ? `<br>${scanLink(r.basisFileId, 'скан основания: ' + (r.basisFileName || ''))}` : ''}
        ${basis.message ? `<br><span class="ref">${esc(basis.message)}</span>` : ''}
        ${r.basisConfirmedAt && staff ? `<br><span class="ref">подтверждено вручную ${ts(r.basisConfirmedAt)} · ${esc(r.basisConfirmedBy || '')}: ${esc(r.basisConfirmNote || '')}</span>` : ''}</span>
      <b>Отправлена</b><span>${ts(r.submittedAt)}${staff && r.createdBy ? ` · ${esc(r.createdBy)}` : ''}</span>
      ${r.reviewedAt && staff ? `<b>Рассмотрел</b><span>${esc(r.reviewedBy || '')} · ${ts(r.reviewedAt)}</span>` : ''}
    </div></div></section>
    <section class="panel"><div class="panel-head">${icon('users')}<div><h2>Бригада · ${c.workers.length} чел.</h2>
      <p>Удостоверения на дату начала работ${r.status === 'draft' ? '' : ' — на момент отправки заявки'}</p></div></div>
      <div class="panel-body" style="padding:0 6px"><table><thead><tr><th>Работник</th><th>Удостоверения</th></tr></thead><tbody>
      ${c.workers.map((w) => `<tr><td><b>${esc(w.fullName)}</b><br><span class="ref">ИИН ${esc(w.iin)}${w.position ? ' · ' + esc(w.position) : ''}</span></td>
        <td><div class="docs">${w.documents.map((d) => `<span>${esc(d.title)}${d.number ? ' № ' + esc(d.number) : ''} ${docChip(d, start)} ${scanLink(d.fileId)}</span>`).join('')}</div></td></tr>`).join('')
        || emptyRow(2, 'Бригада не указана')}
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
  await reload();
}

async function confirmBasis(button) {
  const r = sheetCard.request;
  const note = document.getElementById('cfNote').value.trim();
  const card = await act(button, () => P.confirmBasis(r.id, { version: r.version, note }));
  await afterDecision(card, 'Основание подтверждено');
}

async function approveRequest(button) {
  const r = sheetCard.request;
  const file = document.getElementById('passFile').files[0];
  if (!file) return toast('Прикрепите файл допуска', 'bad');
  const form = new FormData();
  form.set('version', String(r.version));
  form.set('file', file, file.name);
  const card = await act(button, () => P.approve(r.id, form));
  await afterDecision(card, 'Заявка одобрена, файл допуска доступен организации');
}

async function rejectRequest(button) {
  const r = sheetCard.request;
  const reason = document.getElementById('rjReason').value.trim();
  if (!reason) return toast('Укажите причину отказа', 'bad');
  const card = await act(button, () => P.reject(r.id, { version: r.version, reason }));
  await afterDecision(card, 'Заявка отклонена');
}

async function deleteDraft(button) {
  if (!confirm('Удалить черновик?')) return;
  if (await act(button, () => P.remove(sheetCard.request.id), 'Черновик удалён')) { closeSheet(); await reload(); }
}

async function copyRequest(button) {
  const card = await act(button, () => P.copy(sheetCard.request.id), 'Создан черновик по этой заявке');
  if (card) continueDraft(card.request.id);
}

/* ---------------------------------- отчёт ---------------------------------- */

const reportFilter = { dateFrom: '', dateTo: '', branchId: '', facilityId: '', status: '', urgent: false };
function setReport(key, value) { reportFilter[key] = value; }

function renderReport() {
  const r = state.report || { rows: [], summary: {} };
  const s = r.summary;
  const statuses = Object.entries(state.meta.statuses).filter(([k]) => k !== 'draft');
  return `<div class="filters">
    <label class="ref">с <input type="date" value="${reportFilter.dateFrom}" onchange="setReport('dateFrom',this.value)"></label>
    <label class="ref">по <input type="date" value="${reportFilter.dateTo}" onchange="setReport('dateTo',this.value)"></label>
    <select onchange="setReport('branchId',this.value)"><option value="">Все филиалы</option>
      ${state.meta.branches.map((b) => `<option value="${b.id}" ${reportFilter.branchId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <select onchange="setReport('facilityId',this.value)"><option value="">Все объекты</option>
      ${state.meta.facilities.map((f) => `<option value="${f.id}" ${reportFilter.facilityId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
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
    <div class="kpi"><div class="big">${s.approved ?? 0}</div><span>одобрено</span></div>
    <div class="kpi"><div class="big">${s.rejected ?? 0}</div><span>отклонено</span></div>
    <div class="kpi"><div class="big">${s.pending ?? 0}</div><span>на рассмотрении</span></div>
    <div class="kpi"><div class="big">${s.avgDecisionHours ?? '—'}<small>ч</small></div><span>среднее время до решения · медиана ${s.medianDecisionHours ?? '—'} ч</span></div>
    <div class="kpi"><div class="big">${s.manualBasis ?? 0}</div><span>основание подтверждено вручную · срочных ${s.urgent ?? 0}</span></div>
  </div>
  ${(s.rejectionReasons || []).length ? `<section class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Причины отказов</h2></div>
    <div class="panel-body" style="padding:0 6px"><table><tbody>${s.rejectionReasons.map((x) => `<tr><td>${esc(x.reason)}</td><td class="num">${x.count}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
  ${requestTable(r.rows, 'За период заявок нет')}`;
}

/* ------------------------------ режим проверки ------------------------------ */

function renderSettings() {
  const s = state.settings;
  const admin = can('admin');
  return `<section class="panel"><div class="panel-head">${icon('sliders')}<div><h2>Режим проверки оснований</h2>
    <p>Мягкий — не найдено или истекло: предупреждение и ручное подтверждение СУА. Строгий — заявку отправить нельзя.</p></div></div>
    <div class="panel-body" style="padding:0 6px"><table><thead><tr><th>Тип основания</th><th>Где ищется</th><th>Режим</th></tr></thead><tbody>
    ${Object.entries(s.basisTypes).map(([k, name]) => {
      const registry = s.registryBacked.includes(k);
      const where = { tu: 'ТУ в архиве модуля ОР ПСД', smr_contract: 'договоры модуля ОР ПСД', transfer_act: 'архив актов', lease: 'реестра нет — по скану' }[k];
      return `<tr><td><b>${esc(name)}</b></td><td>${where}</td><td>${admin && registry
        ? `<select data-mode="${k}"><option value="soft" ${s.modes[k] === 'soft' ? 'selected' : ''}>мягкий</option>
            <option value="strict" ${s.modes[k] === 'strict' ? 'selected' : ''}>строгий</option></select>`
        : `<span class="chip ${s.modes[k] === 'strict' ? 'r' : 'w'}">${s.modes[k] === 'strict' ? 'строгий' : 'мягкий'}</span>`}</td></tr>`;
    }).join('')}
    </tbody></table></div></section>
    ${admin ? `<div style="margin-top:12px"><button class="btn primary" onclick="saveModes(this)">Сохранить</button></div>` : ''}
    <div class="note" style="margin-top:14px">По умолчанию действует мягкий режим: ТУ и договоры, выданные до запуска системы, в ней не учтены,
      и строгая проверка отклоняла бы законные заявки. Строгий режим включает ДИТ, когда СУА и ОР ПСД сочтут данные полными.
      Для договоров аренды реестра в системе нет — только ручное подтверждение по скану.</div>`;
}

async function saveModes(button) {
  const modes = Object.fromEntries([...document.querySelectorAll('[data-mode]')].map((el) => [el.dataset.mode, el.value]));
  if (await act(button, () => P.saveSettings(modes), 'Режим проверки сохранён')) await reload();
}

boot();
