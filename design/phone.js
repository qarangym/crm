/**
 * Телефон РК: маска «+7 XXX XXX XX XX» при вводе и проверка номера.
 *
 * Поле всегда начинается с «+7 », цифры раскладываются по группам по мере
 * ввода. Вставка «8 701 …», «+7701…», «87011234567» приводится к тому же виду.
 * Принимаются только номера Казахстана: после +7 идёт 7 (мобильные 7XX и
 * городские 7XXX). Та же проверка — на сервере (src/domain/validation.ts).
 *
 * Подключение: <script src="phone.js"></script>, затем QTR_PHONE.attach(input)
 * либо обработчики onInput/onKeydown/onFocus/onBlur прямо в разметке.
 */
(function () {
  const PREFIX = '+7 ';

  /** Десять цифр номера без кода страны. */
  function digitsOf(value) {
    let text = String(value ?? '').trim();
    if (text.startsWith('+7')) text = text.slice(2);
    let d = text.replace(/\D/g, '');
    // Вставлен полный номер: «8 701 …» или «7 701 …».
    if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = d.slice(1);
    // Привычная «восьмёрка» в начале: номера РК после +7 с 8 не начинаются.
    if (d[0] === '8') d = d.slice(1);
    return d.slice(0, 10);
  }

  /** «7011234567» → «+7 701 123 45 67»; незаконченный номер — по мере ввода. */
  function format(value) {
    const d = digitsOf(value);
    if (!d) return '';
    const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
    return PREFIX + parts.join(' ');
  }

  /** Пустая строка — номер верный, иначе — что не так. */
  function problem(value) {
    const d = digitsOf(value);
    if (!d) return 'Укажите телефон';
    if (d.length < 10) return 'Номер неполный: +7 XXX XXX XX XX';
    if (d[0] !== '7') return 'Номер Казахстана начинается с +7 7…';
    if (/(\d)\1{7}/.test('7' + d)) return 'Проверьте номер';
    return '';
  }

  function onInput(el) {
    const next = format(el.value) || PREFIX;
    if (el.value !== next) el.value = next;
    el.setSelectionRange(el.value.length, el.value.length);
  }

  /** Стирание: удаляется цифра, а не пробел-разделитель; «+7 » не стирается. */
  function onKeydown(event) {
    const el = event.target;
    if (event.key !== 'Backspace' || el.selectionStart !== el.selectionEnd || el.selectionEnd !== el.value.length) return;
    event.preventDefault();
    const d = digitsOf(el.value).slice(0, -1);
    el.value = format(d) || PREFIX;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onFocus(el) {
    if (!el.value) el.value = PREFIX;
    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
  }

  function onBlur(el) {
    if (!digitsOf(el.value)) el.value = '';
  }

  function attach(el) {
    el.type = 'tel';
    el.inputMode = 'tel';
    el.autocomplete = 'tel';
    el.maxLength = 16;
    el.placeholder = '+7 7XX XXX XX XX';
    if (el.value) el.value = format(el.value);
    el.addEventListener('input', () => onInput(el));
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('focus', () => onFocus(el));
    el.addEventListener('blur', () => onBlur(el));
  }

  window.QTR_PHONE = { attach, format, problem, digitsOf, onInput, onKeydown, onFocus, onBlur };
})();
