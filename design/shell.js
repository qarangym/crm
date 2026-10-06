/**
 * Общие помощники интерфейса: иконки, экранирование, даты, диалог и сообщения.
 *
 * Подключаются и в рабочее место ОР ПСД (index.html), и в портал допусков
 * (dopusk/index.html): одна система — один вид. Определения — глобальные,
 * как и прежде, когда они жили в index.html.
 */

/* ------------------------------- иконки -------------------------------
   Штриховой набор 24×24, наследует цвет текста. Заменяет юникод-символы:
   они рисуются разными шрифтами и ломают единый вид интерфейса. */
const ICONS = {
  board:   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  funnel:  '<path d="M4 4h16l-6.5 8v6l-3 2v-8z"/>',
  list:    '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  tower:   '<path d="M12 9v12"/><path d="m7.5 21 4.5-12 4.5 12"/><path d="M8.6 5.6a5 5 0 0 1 6.8 0"/><path d="M6 2.8a9 9 0 0 1 12 0"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5"/><path d="M10 12.5h4"/>',
  filePlus:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11.5v6M9 14.5h6"/>',
  checks:  '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m3 6 1.4 1.4L7.2 4.6M3 12l1.4 1.4L7.2 10.6M3 18l1.4 1.4L7.2 16.6"/>',
  sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none"/><circle cx="7" cy="18" r="2.2" fill="currentColor" stroke="none"/>',
  clock:   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  download:'<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  plus:    '<path d="M12 5v14M5 12h14"/>',
  close:   '<path d="m6 6 12 12M18 6 6 18"/>',
  bell:    '<path d="M18 8.5a6 6 0 1 0-12 0c0 6.5-2.5 7.5-2.5 7.5h17S18 15 18 8.5"/><path d="M10.2 19.5a2 2 0 0 0 3.6 0"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  warn:    '<path d="M10.3 4.3 2.7 17.4a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 17h.01"/>',
  check:   '<path d="m4.5 12.5 5 5 10-11"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 5v6h-6"/>',
  users:   '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 13.6A5.5 5.5 0 0 1 20.5 19"/>',
  truck:   '<path d="M3 6h11v10H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  shield:  '<path d="M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  upload:  '<path d="M12 15.5v-11"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M4.5 19.5h15"/>',
  trash:   '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  copy:    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  eye:     '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12"/><circle cx="12" cy="12" r="2.8"/>',
  arrow:   '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
};
const icon = (name, size = 18) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true">${ICONS[name] || ''}</svg>`;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* Дата без года — только для текущего года: на рубеже лет «05 янв.» путается (Н5). */
const fmt = (d) => {
  if (!d) return '—';
  const date = new Date(String(d).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(date.getTime())) return '—';
  const sameYear = date.getUTCFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('ru-RU', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const fmtFull = (d) => d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('ru-RU') : '—';

/* ---------------------------------- вход --------------------------------- */

/** Нет сессии — на страницу входа с возвратом туда, где был пользователь. */
function toLogin() {
  location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
}

/** Выход: сессия закрывается на сервере, cookie стирается. */
async function logout() {
  try { await window.QTR_API.call('POST', '/auth/logout'); } catch { /* сессия уже закрыта */ }
  location.replace('/login.html');
}

/* -------------------------------- диалог -------------------------------- */

/**
 * Диалог с полями вместо window.prompt (К2): причина отказа, сумма возврата,
 * дата, текст поручения. Обязательные поля проверяются до отправки.
 * Возвращает объект значений или null, если пользователь отказался.
 */
function ask({ title, text = '', fields = [], ok = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'dlg';
    const input = (f) => {
      const id = 'dlg-' + f.key;
      const common = `id="${id}" ${f.required ? 'required' : ''}`;
      if (f.type === 'textarea') return `<textarea ${common} name="${esc(f.key)}" rows="${f.rows || 3}" placeholder="${esc(f.ph || '')}">${esc(f.value || '')}</textarea>`;
      if (f.type === 'select') return `<select ${common}>${(f.options || []).map((o) =>
        `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      return `<input ${common} name="${esc(f.key)}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.ph || '')}"
        autocomplete="off" ${f.max ? `max="${f.max}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''}>`;
    };
    const titleId = 'dlg-title-' + (++dialogSeq);
    // Форма: Enter в поле подтверждает, как кнопка.
    box.innerHTML = `<form class="dlg-box" role="dialog" aria-modal="true" aria-labelledby="${titleId}" novalidate>
      <header><h3 id="${titleId}">${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</header>
      <div class="body">${fields.map((f) => `<div class="field" data-key="${f.key}">
        <label for="dlg-${f.key}">${esc(f.label)}${f.required ? '' : ' <span class="ref">необязательно</span>'}</label>${input(f)}
        ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}<div class="err"></div></div>`).join('')}</div>
      <footer><button type="button" class="btn" data-act="cancel">Отмена</button>
        <button type="submit" class="btn ${danger ? '' : 'primary'}" data-act="ok" ${danger ? 'style="border-color:var(--bad);color:var(--bad)"' : ''}>${esc(ok)}</button></footer>
    </form>`;
    const release = holdModal(box);
    const close = (value) => { box.remove(); release(); resolve(value); };
    box.addEventListener('click', (ev) => {
      if (ev.target === box || ev.target.closest('[data-act="cancel"]')) close(null);
    });
    box.querySelector('form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const values = {};
      let bad = false;
      for (const f of fields) {
        const el = box.querySelector('#dlg-' + f.key);
        const value = el.value.trim();
        const wrap = box.querySelector(`[data-key="${f.key}"]`);
        const problem = f.required && !value ? 'Заполните поле'
          : f.minLength && value && value.length < f.minLength ? `Не менее ${f.minLength} символов` : '';
        wrap.classList.toggle('bad', !!problem);
        wrap.querySelector('.err').textContent = problem;
        if (problem) bad = true;
        values[f.key] = value;
      }
      if (!bad) close(values);
      else focusFirstError(box);
    });
    box.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(null); } });
    document.body.appendChild(box);
    box.querySelector('input,textarea,select')?.focus();
  });
}
let dialogSeq = 0;

/* --------------------------- сообщения и ошибки -------------------------- */

/** Показ ошибки API: нарушения Регламента выводятся со ссылками на пункты. */
function describeError(error) {
  if (!error) return '';
  if (error.failures?.length) {
    return error.failures.map((f) => `${f.message} (${f.regulationRef})`).join('; ');
  }
  if (error.fields) {
    return `${error.message}: ${Object.values(error.fields).join('; ')}`;
  }
  return error.message;
}

/* Сообщение внизу экрана. Область объявлений создаётся заранее и пустой — иначе экранный диктор
   пропускает первое сообщение. Пока указатель на сообщении, оно не исчезает. */
let toastTimer = null;
function toastBox() {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.className = 'toast';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-atomic', 'true');
    box.addEventListener('mouseenter', () => clearTimeout(toastTimer));
    box.addEventListener('mouseleave', () => {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { box.style.display = 'none'; }, 2500);
    });
    document.body.appendChild(box);
  }
  return box;
}
function toast(text, kind = 'info') {
  const box = toastBox();
  box.className = 'toast ' + kind;
  // Ошибку диктор объявляет сразу, остальное — закончив фразу.
  box.setAttribute('aria-live', kind === 'bad' ? 'assertive' : 'polite');
  box.innerHTML = `${icon(kind === 'bad' ? 'warn' : 'check', 16)}<span>${esc(text)}</span>`;
  box.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.style.display = 'none'; }, kind === 'bad' ? 7000 : 3500);
}


/* ------------------------------ колокольчик ------------------------------
   Уведомления в системе: копия каждого письма пользователю. Кнопка в шапке,
   число непрочитанных, список с переходом в карточку. Опрос раз в минуту. */

let bellTimer = null;
function mountBell(host) {
  if (!host) return;
  const api = window.QTR_API;
  host.innerHTML = `<button class="btn ghost bell" aria-label="Уведомления" title="Уведомления" aria-expanded="false"
      aria-controls="bellPanel">${icon('bell', 18)}<span class="bell-n" hidden></span></button>
    <div class="bell-panel" id="bellPanel" role="region" aria-label="Уведомления" hidden></div>`;
  const button = host.querySelector('.bell');
  const badge = host.querySelector('.bell-n');
  const panel = host.querySelector('.bell-panel');
  const show = (n) => {
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    button.setAttribute('aria-label', n ? `Уведомления: непрочитанных ${n}` : 'Уведомления');
  };
  const hide = () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const refresh = async () => { try { show((await api.call('GET', '/inbox/count')).unread); } catch { /* сеть */ } };
  const when = (v) => new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  async function open() {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    panel.innerHTML = '<div class="ref" style="padding:14px">Загрузка…</div>';
    try {
      const { items, unread } = await api.call('GET', '/inbox?limit=40');
      show(unread);
      panel.innerHTML = `<div class="bell-head"><b>Уведомления</b>
        ${unread ? '<button class="btn ghost sm" data-all>Прочитать все</button>' : ''}</div>
        ${items.length ? items.map((i) => `<a class="bell-item ${i.read_at ? '' : 'new'}" data-id="${i.id}" href="${esc(i.link || '#')}">
          <b>${esc(i.subject)}</b><span>${esc(String(i.body || '').split('\n')[0].slice(0, 160))}</span><time>${when(i.created_at)}</time></a>`).join('')
          : '<div class="ref" style="padding:14px">Уведомлений нет</div>'}`;
    } catch (error) {
      panel.innerHTML = `<div class="ref" style="padding:14px">${esc(describeError(error))}</div>`;
    }
  }
  button.addEventListener('click', (ev) => { ev.stopPropagation(); panel.hidden ? open() : hide(); });
  // Escape закрывает список и возвращает фокус на колокольчик.
  host.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || panel.hidden) return;
    ev.preventDefault();
    hide();
    button.focus();
  });
  panel.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (ev.target.closest('[data-all]')) {
      show((await api.call('POST', '/inbox/read', { all: true })).unread);
      return open();
    }
    const item = ev.target.closest('.bell-item');
    if (!item) return;
    if (item.getAttribute('href') === '#') ev.preventDefault();
    hide();
    // По ссылке переходит сам браузер; адрес («#ЗК-…», «#ЗД-…») открывает карточку в приложении (popstate).
    // Отметка «прочитано» — в фоне, чтобы не задерживать переход.
    api.call('POST', '/inbox/read', { ids: [Number(item.dataset.id)] }).then((r) => show(r.unread)).catch(() => {});
  });
  document.addEventListener('click', hide);
  refresh();
  clearInterval(bellTimer);
  bellTimer = setInterval(refresh, 60_000);
}

/* --------------------------- демонстрационный стенд ---------------------------
   Сервер с DEMO_MODE отвечает в /me признаком demo: полоса вверху страницы, чтобы
   стенд с вымышленными данными нельзя было спутать с рабочей системой. */

function mountDemoRibbon(me) {
  if (!me?.demo || document.querySelector('.demo-ribbon')) return;
  const ribbon = document.createElement('div');
  ribbon.className = 'demo-ribbon';
  ribbon.textContent = 'Демонстрационный стенд · данные вымышлены · код входа показывается на экране';
  document.body.prepend(ribbon);
}

/* ------------------------------ справка ------------------------------
   Что делать в системе — коротко, по роли (docs/Руководство_пользователя.md). Кнопка «Справка» в шапке;
   при первом входе на этом браузере те же шаги показываются приветствием. */

const HELP = {
  orpsd: {
    customer: ['Заказчик', [
      '«Новая заявка»: выберите услуги — ТУ, ПСД, СМР, можно вместе, — объект и параметры оборудования. Форма покажет только нужные поля и ориентировочную стоимость.',
      'На последнем шаге проверьте заявку и подайте. Номер присваивается сразу, подтверждение придёт на почту.',
      '«Мои заявки» — статус и что происходит сейчас. Вернули с замечаниями — откройте заявку → «Исправить заявку»: номер и история сохранятся.',
      'Договоры, счета и акты — в карточке заявки. Замечания к АВР — в течение 10 рабочих дней, иначе акт считается принятым.']],
    records: ['Канцелярия', [
      '«Мои задачи» — новые заявки ждут подтверждения регистрации: номер и дата уже присвоены, проверьте и нажмите «Подтвердить регистрацию».',
      'Заявка пришла на бумаге или почтой — «Внести заявку» от имени Заказчика, со сканом письма.',
      'Для дела — «Карточка заявки» в карточке: печатная форма.']],
    orpsd: ['ОР ПСД', [
      'Начинайте день с «Моих задач»: всё, что на вас, просроченное сверху.',
      'В карточке заявки вверху — чего не хватает для перехода и пункт Регламента; внизу — «Следующий шаг».',
      'Оценка ТВ: «Рассчитать по реестру» → результат и решение о поверочном расчёте → «Зафиксировать оценку».',
      'Нужны данные филиала — «Служебные записки в филиал» в карточке: ответ за 3 рабочих дня.',
      '«Доска заявок» — все заявки по этапам; отбор «Без исполнителя» должен быть пустым.']],
    branch: ['Филиал', [
      '«Мои задачи» — служебные записки ОР ПСД (ответ за 3 рабочих дня) и этапы СМР на ваших объектах.',
      'Акт приёма-передачи и технический АВР — «Архив актов» → загрузка с реквизитами.',
      'Допуски сторонних организаций на ваши объекты — «Портал допусков» в меню: согласование и проверка на объекте.']],
    accounting: ['Расчёты с контрагентами', [
      '«Мои задачи» — заявки, где нужен счёт, отметка оплаты, АВР или ЭСФ.',
      'В карточке заявки — договоры по каждой услуге: отметка оплаты с фактической датой, загрузка АВР.']],
    oko: ['ОКО', [
      '«Мои задачи» — исполненные поручения, которые осталось закрыть.',
      '«Поручения» — все поручения с исполнителями и сроками, выгрузка CSV.',
      '«Отчёты», «Узкие места», «Журнал» — контроль сроков и действий.']],
    management: ['Руководство', [
      '«Доска заявок» и «Узкие места» — где заявки стоят дольше норматива.',
      '«Нагрузка команды» — кто чем занят; «Отчёты» — с выгрузкой в Excel.']],
    assets: ['Технический учёт', [
      '«Мои задачи» — запросы на изменение реестра АМС, срок — 1 рабочий день.',
      '«Реестр АМС и ТВ» — версии мастер-файла, по которым ОР ПСД оценивает техническую возможность.']],
    permits: ['СУА', ['Основная работа — «Портал допусков» в меню. Здесь — архив актов для просмотра и поиска.']],
    auditor: ['Аудитор', ['«Журнал» — все действия пользователей с отбором и выгрузкой; записи журнала изменить нельзя.']],
    admin: ['ДИТ', [
      '«Пользователи» — заведение, импорт, «Пригласить». Новые регистрации организаций ждут проверки — они же в «Моих задачах».',
      '«Справочники» — филиалы и ответственные лица, объекты, календарь, прейскурант, тексты писем.',
      '«Эскалации и уведомления» — доставка писем; «Журнал» — все действия.']],
  },
  permits: {
    contractor: ['Сторонняя организация', [
      'Сначала «Работники и бригады»: работники по Приложению 1 с удостоверениями и сроками, транспорт. Это делается один раз.',
      '«Новая заявка»: цель работ → объект → основание (договор аренды или ТУ) → период → бригада.',
      '«Сформировать запрос» — распечатайте запрос с Приложением 1, подпишите, заверьте печатью и приложите скан.',
      'Ответ — не позднее 14 рабочих дней. Допуск с кодом — в «Моих заявках»: код предъявляется на объекте.',
      'Авария — цель «Аварийно-восстановительные работы»: запрос можно приложить позже, в течение 2 дней.']],
    permits: ['СУА', [
      '«Очередь на рассмотрение» — срочные и аварийные сверху, срок ответа — 14 рабочих дней.',
      'В карточке — проверка основания, бригада со сканами, подписанный запрос → «Выдать допуск» или «Отклонить» с причиной.',
      'Руководство филиала не работает в системе — отметьте согласование, полученное устно или письмом.',
      '«Договоры аренды» — реестр и загрузка таблицы; «Отчёт» — с выгрузкой в Excel.']],
    branch: ['Филиал', [
      '«Согласование филиала» — заявки на ваши объекты, где Инструкция требует согласования руководства.',
      '«Проверка на объекте» — удобно с телефона: код допуска, ИИН или фамилия; инструктаж, спецодежда, обувь, СИЗ → «Допустить».',
      'Работы закончены — «Закрыть допуск».']],
    oko: ['ОКО', ['«Действующие допуски», «Все заявки» и «Отчёт» — только просмотр.']],
    management: ['Руководство', ['«Действующие допуски», «Все заявки» и «Отчёт» — только просмотр.']],
    admin: ['ДИТ', ['«Настройки» — режим проверки оснований, сроки и пределы Инструкции, безвизовые сроки СНГ.']],
  },
};

function helpSections(me, module) {
  const book = HELP[module] || {};
  return Object.keys(book).filter((role) => (me?.roles || []).includes(role)).map((role) => book[role]);
}

function showHelp(me, module, welcome = false) {
  const sections = helpSections(me, module);
  if (!sections.length) return;
  const box = document.createElement('div');
  box.className = 'dlg';
  const name = String(me.fullName || '').split(' ')[1] || me.fullName || '';
  box.innerHTML = `<div class="dlg-box help-box" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <header><h3 id="helpTitle">${welcome ? `Добро пожаловать${name ? ', ' + esc(name) : ''}!` : 'Справка'}</h3>
      <p>${welcome ? 'Коротко — с чего начать. Эти подсказки всегда под кнопкой «Справка» в шапке.' : 'Что делать в системе — по вашей роли.'}</p></header>
    <div class="body">${sections.map(([title, steps]) => `<section><h4>${esc(title)}</h4>
      <ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>`).join('')}</div>
    <footer><button class="btn primary" data-act="ok">Понятно</button></footer></div>`;
  const release = holdModal(box);
  const close = () => { box.remove(); release(); };
  box.addEventListener('click', (ev) => { if (ev.target === box || ev.target.closest('[data-act]')) close(); });
  box.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
  document.body.appendChild(box);
  box.querySelector('[data-act]').focus();
}

/** Кнопка «Справка» в шапке и приветствие при первом входе на этом браузере. */
function mountHelp(host, me, module) {
  if (!host || !helpSections(me, module).length) return;
  host.innerHTML = '<button class="btn ghost" type="button">Справка</button>';
  host.querySelector('button').addEventListener('click', () => showHelp(me, module));
  const key = `qtr.welcome.${module}.${me.id}`;
  let seen = true;
  try { seen = !!localStorage.getItem(key); localStorage.setItem(key, '1'); } catch { /* хранилище недоступно — без приветствия */ }
  if (!seen) showHelp(me, module, true);
}

/* ------------------------------ модальные окна ------------------------------
   Пока открыт диалог или карточка, остальная страница «инертна»: Tab не уходит за окно,
   экранный диктор не читает фон. После закрытия фокус возвращается туда, откуда открыли. */

function holdModal(el) {
  const opener = document.activeElement;
  // Сообщения (toast) не глушим: они должны звучать и поверх окна.
  const muted = [...document.body.children].filter((x) => x !== el && !x.inert && x.tagName !== 'SCRIPT' && x.id !== 'toast');
  muted.forEach((x) => { x.inert = true; });
  return () => {
    muted.forEach((x) => { x.inert = false; });
    if (opener && opener !== document.body && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
  };
}

/** Фокус на первое поле с ошибкой — после неудачной проверки формы. */
function focusFirstError(root = document) {
  // Сначала само поле; если в блоке с ошибкой поля нет (список отметок), — весь блок.
  const bad = root.querySelector('.field.bad input:not([type=hidden]), .field.bad select, .field.bad textarea')
    || root.querySelector('.field.bad, .blocked');
  if (!bad) return;
  if (!bad.matches('input,select,textarea')) bad.setAttribute('tabindex', '-1');
  bad.focus();
}

/**
 * Боковая карточка (#sheet) — модальное окно: имя из заголовка, фокус внутрь при открытии
 * и обратно при закрытии. Карточку открывают из многих мест добавлением класса «on»,
 * поэтому за открытием следим здесь, а не в каждом из них.
 */
function watchSheet() {
  const sheet = document.getElementById('sheet');
  const panel = document.getElementById('sheetPanel');
  if (!sheet || !panel) return;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.tabIndex = -1;
  let release = null;
  new MutationObserver(() => {
    const open = sheet.classList.contains('on');
    if (open && !release) {
      release = holdModal(sheet);
      panel.scrollTop = 0;
      panel.focus({ preventScroll: true });
    } else if (!open && release) {
      release();
      release = null;
    }
  }).observe(sheet, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => {
    const heading = panel.querySelector('h2');
    if (heading) {
      heading.id ||= 'sheetTitle';
      panel.setAttribute('aria-labelledby', heading.id);
    }
    // Содержимое перерисовано вместе с полем в фокусе — фокус остаётся в карточке, а не уходит на страницу.
    if (release && (document.activeElement === document.body || !document.activeElement)) panel.focus({ preventScroll: true });
  }).observe(panel, { childList: true });
}

/* Escape: сначала закрывается верхнее — меню на телефоне, затем карточка. Диалоги и колокольчик
   закрываются своими обработчиками и отменяют событие. */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || ev.defaultPrevented || document.querySelector('.dlg')) return;
  const side = document.querySelector('.side.open');
  if (side) {
    side.classList.remove('open');
    document.querySelector('.menu-toggle')?.focus();
    return;
  }
  if (document.getElementById('sheet')?.classList.contains('on') && typeof closeSheet === 'function') {
    ev.preventDefault();
    closeSheet();
  }
});

/* ---------------------------- ссылки и строки ----------------------------
   Карточка заявки, задача, строка реестра — настоящие ссылки на адрес в приложении:
   доходят с клавиатуры, Ctrl+щелчок и колесо мыши открывают новую вкладку.
   Обычный щелчок выполняет действие на месте, без перезагрузки. */

/** Щелчок без клавиш-модификаторов — действие внутри приложения. */
const plainClick = (ev) => ev.button === 0 && !(ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey);

/** Ссылка с действием: адрес для новой вкладки, `action` — код для обычного щелчка. */
const appLink = (href, action, inner, attrs = '') =>
  `<a href="${esc(href)}" ${attrs} onclick="if(plainClick(event)){event.preventDefault();${esc(action)}}">${inner}</a>`;

/* Строка .row-link откликается на щелчок целиком, но действие у неё одно — .row-main в первой ячейке.
   Щелчок по своим ссылкам и кнопкам строки и выделение текста мышью строку не открывают. */
document.addEventListener('click', (ev) => {
  const row = ev.target.closest('.row-link');
  if (!row || ev.target.closest('a,button,input,select,textarea,label')) return;
  if (String(window.getSelection?.() || '')) return;
  row.querySelector('.row-main')?.click();
});

/* ------------------------------- поля форм -------------------------------
   Подпись связывается с полем (щелчок по подписи ставит курсор, диктор читает её), ошибка
   и подсказка — с полем через aria-describedby, поле с ошибкой помечено aria-invalid.
   Разметку рисуют десятки шаблонов, поэтому связи проставляются после каждой отрисовки. */

let fieldSeq = 0;
const CONTROL = 'input:not([type=hidden]),select,textarea';
function linkFields() {
  for (const label of document.querySelectorAll('label:not([for])')) {
    if (label.querySelector(CONTROL) || !label.parentElement) continue;
    const control = [...label.parentElement.querySelectorAll(CONTROL)].find((c) =>
      label.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING && !c.closest('label'));
    if (!control) continue;
    control.id ||= 'fld-' + (++fieldSeq);
    label.htmlFor = control.id;
  }
  for (const field of document.querySelectorAll('.field')) {
    const control = field.querySelector(CONTROL);
    if (!control) continue;
    const bad = field.classList.contains('bad');
    const notes = [...field.querySelectorAll(':scope > .hint, :scope > .err')].filter((n) => n.classList.contains('hint') || bad);
    notes.forEach((n) => { n.id ||= 'fld-note-' + (++fieldSeq); });
    const ids = notes.map((n) => n.id).join(' ');
    if (ids) control.setAttribute('aria-describedby', ids); else control.removeAttribute('aria-describedby');
    if (bad) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
  }
}
let fieldsQueued = false;
function watchFields() {
  new MutationObserver(() => {
    if (fieldsQueued) return;
    fieldsQueued = true;
    queueMicrotask(() => { fieldsQueued = false; linkFields(); });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  linkFields();
}

if (document.body) {
  toastBox();
  watchSheet();
  watchFields();
}

