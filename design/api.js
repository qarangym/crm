/**
 * Клиент API.
 *
 * Единственное место, где интерфейс обращается к серверу. Здесь же разбор
 * ошибок: сервер возвращает машинный код и — при нарушении Регламента —
 * перечень невыполненных условий со ссылками на пункты, который нужно показать
 * пользователю дословно.
 */
(function () {
  const BASE = '/api/v1';

  /** Ошибка API: несёт код состояния, машинный код и подробности. */
  class ApiError extends Error {
    constructor(message, status, code, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      /** Ошибки по полям формы — для подсветки. */
      this.fields = details?.fields ?? null;
      /** Невыполненные условия Регламента со ссылками на пункты. */
      this.failures = details?.failures ?? null;
    }
    /** Заявку правит кто-то ещё — нужно перечитать карточку. */
    get isConflict() { return this.status === 409; }
    get isForbidden() { return this.status === 403; }
    get isUnauthorized() { return this.status === 401; }
  }

  async function request(method, path, options = {}) {
    const init = { method, headers: {}, credentials: 'same-origin' };

    if (options.body instanceof FormData) {
      // Content-Type проставит браузер вместе с границей multipart.
      init.body = options.body;
    } else if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await fetch(BASE + path, init);
    } catch (cause) {
      // Сеть недоступна — отличаем от ответа сервера с ошибкой.
      throw new ApiError('Сервер недоступен. Проверьте соединение.', 0, 'network_error');
    }

    if (res.status === 204) return null;

    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      throw new ApiError(
        payload?.error || `Ошибка ${res.status}`,
        res.status,
        payload?.code || 'unknown',
        payload,
      );
    }
    return payload;
  }

  const query = (params = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  window.QTR_API = {
    ApiError,

    health: () => request('GET', '/health'),
    config: () => request('GET', '/config'),
    me: () => request('GET', '/me'),

    facilities: () => request('GET', '/facilities'),
    /** Карточка объекта с ярусами и арендаторами — для оценки ТВ (п. 16.2). */
    facility: (id) => request('GET', `/facilities/${id}`),
    tariffs: () => request('GET', '/tariffs'),

    requests: (params) => request('GET', '/requests' + query(params)),
    request: (id) => request('GET', `/requests/${id}`),
    createRequest: (body) => request('POST', '/requests', { body }),
    /** Входящий номер и дата регистрации делопроизводством (п. 6). */
    register: (id, body) => request('POST', `/requests/${id}/registration`, { body }),
    /** Переход по этапу — единственный способ сменить этап. */
    transition: (id, body) => request('POST', `/requests/${id}/transition`, { body }),
    /** Фиксация оценки ТВ с версией мастер-файла (п. 16.5). */
    setTv: (id, body) => request('POST', `/requests/${id}/tv`, { body }),
    /** Возврат на доработку с перечнем замечаний (ТЗ №11). */
    addRemarks: (id, remarks) => request('POST', `/requests/${id}/remarks`, { body: { remarks } }),
    /** Исправление заявки по замечаниям и повторная отправка (ТЗ №11). */
    amendRequest: (id, body) => request('PATCH', `/requests/${id}`, { body }),
    resubmit: (id) => request('POST', `/requests/${id}/resubmit`, { body: {} }),
    resolveRemark: (id, remarkId, note) =>
      request('POST', `/requests/${id}/remarks/${remarkId}/resolve`, { body: { note } }),

    /** Договор на услугу заявки (пп. 21, 32, 48) и оплата по нему (пп. 86, 88). */
    addContract: (id, body) => request('POST', `/requests/${id}/contracts`, { body }),
    payContract: (contractId, paidAt) => request('POST', `/contracts/${contractId}/payment`, { body: { paidAt } }),
    terminateContract: (contractId, body) => request('POST', `/contracts/${contractId}/terminate`, { body }),
    /** Смета, распоряжение, передача результата, АВР и приёмка (пп. 41, 60, 24, 91, 94). */
    setFlags: (id, body) => request('POST', `/requests/${id}/flags`, { body }),
    /** Продление срока этапа с основанием (пп. 33, 45). */
    extendStage: (id, body) => request('POST', `/requests/${id}/extension`, { body }),

    /** Поручения по зарегистрированным заявкам (ТЗ №7, №8). */
    assignments: (params) => request('GET', '/assignments' + query(params)),
    acceptAssignment: (id) => request('POST', `/assignments/${id}/accept`, { body: {} }),
    closeAssignment: (id, body) => request('POST', `/assignments/${id}/close`, { body }),
    assignmentsExportUrl: () => `${BASE}/assignments/export`,

    /** Служебные записки в филиал (п. 10). */
    memos: (params) => request('GET', '/memos' + query(params)),
    createMemo: (id, body) => request('POST', `/requests/${id}/memos`, { body }),
    answerMemo: (memoId, answer) => request('POST', `/memos/${memoId}/answer`, { body: { answer } }),

    board: () => request('GET', '/board'),
    metrics: () => request('GET', '/metrics'),

    documents: (params) => request('GET', '/documents' + query(params)),
    document: (id) => request('GET', `/documents/${id}`),
    uploadDocument: (form) => request('POST', '/documents', { body: form }),
    replaceFile: (id, form) => request('POST', `/documents/${id}/versions`, { body: form }),
    approveDocument: (id) => request('POST', `/documents/${id}/approve`, { body: {} }),
    deleteDocument: (id) => request('POST', `/documents/${id}/delete`, { body: {} }),
    /** Ссылка на файл: скачивание идёт обычным переходом, чтобы работал диалог сохранения. */
    fileUrl: (id, version) => `${BASE}/documents/${id}/file${version ? `?version=${version}` : ''}`,

    users: (q) => request('GET', '/users' + query({ q })),
    saveUser: (body) => request('POST', '/users', { body }),
    disableUser: (id) => request('POST', `/users/${id}/disable`, { body: {} }),
    audit: (params) => request('GET', '/audit' + query(params)),
  };
})();
