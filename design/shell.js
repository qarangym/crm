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
      if (f.type === 'textarea') return `<textarea ${common} rows="${f.rows || 3}" placeholder="${esc(f.ph || '')}">${esc(f.value || '')}</textarea>`;
      if (f.type === 'select') return `<select ${common}>${(f.options || []).map((o) =>
        `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      return `<input ${common} type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.ph || '')}"
        ${f.max ? `max="${f.max}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''}>`;
    };
    box.innerHTML = `<div class="dlg-box" role="dialog" aria-modal="true">
      <header><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</header>
      <div class="body">${fields.map((f) => `<div class="field" data-key="${f.key}">
        <label>${esc(f.label)}${f.required ? '' : ' <span class="ref">необязательно</span>'}</label>${input(f)}
        ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}<div class="err"></div></div>`).join('')}</div>
      <footer><button class="btn" data-act="cancel">Отмена</button>
        <button class="btn ${danger ? '' : 'primary'}" data-act="ok" ${danger ? 'style="border-color:var(--bad);color:var(--bad)"' : ''}>${esc(ok)}</button></footer>
    </div>`;
    const close = (value) => { box.remove(); resolve(value); };
    box.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (ev.target === box || act === 'cancel') close(null);
      if (act !== 'ok') return;
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
    });
    box.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(null); });
    document.body.appendChild(box);
    box.querySelector('input,textarea,select')?.focus();
  });
}

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

let toastTimer = null;
function toast(text, kind = 'info') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.className = 'toast ' + kind;
  box.innerHTML = `${icon(kind === 'bad' ? 'warn' : 'check', 16)}<span>${esc(text)}</span>`;
  box.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.style.display = 'none'; }, kind === 'bad' ? 7000 : 3500);
}

