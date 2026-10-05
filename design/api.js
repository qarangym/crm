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
    /** Произвольный вызов: портал допусков строит свои методы поверх него. */
    call: (method, path, body) => request(method, path, body === undefined ? {} : { body }),
    query,
    base: BASE,

    health: () => request('GET', '/health'),
    config: () => request('GET', '/config'),
    me: () => request('GET', '/me'),

    facilities: () => request('GET', '/facilities'),
    /** Карточка объекта с ярусами и арендаторами — для оценки ТВ (п. 16.2). */
    facility: (id) => request('GET', `/facilities/${id}`),
    tariffs: () => request('GET', '/tariffs'),

    requests: (params) => request('GET', '/requests' + query(params)),
    request: (id) => request('GET', `/requests/${id}`),
    /** «Мои задачи» сотрудника и нагрузка команды (п. 102). */
    tasks: (user) => request('GET', '/tasks' + query({ user })),
    tasksCount: () => request('GET', '/tasks/count'),
    tasksLoad: () => request('GET', '/tasks/load'),
    /** Замещение на время отсутствия (src/server/people.ts). */
    absences: () => request('GET', '/absences'),
    saveAbsence: (body) => request('POST', '/absences', { body }),
    deleteAbsence: (id) => request('POST', `/absences/${id}/delete`, { body: {} }),
    colleagues: () => request('GET', '/colleagues'),
    /** Тексты писем в справочнике (src/server/templates.ts). */
    mailTemplates: () => request('GET', '/mail-templates'),
    saveMailTemplate: (key, body) => request('POST', `/mail-templates/${key}`, { body }),
    /** Ответственный ОР ПСД, исполнитель этапа и кому их можно передать (п. 102). */
    executors: (id) => request('GET', `/requests/${id}/executors`),
    setExecutor: (id, body) => request('POST', `/requests/${id}/executor`, { body }),
    createRequest: (body) => request('POST', '/requests', { body }),
    /** Входящий номер и дата регистрации делопроизводством (п. 6). */
    register: (id, body) => request('POST', `/requests/${id}/registration`, { body }),
    /** Переход по этапу — единственный способ сменить этап. */
    transition: (id, body) => request('POST', `/requests/${id}/transition`, { body }),
    /** Фиксация оценки ТВ с версией мастер-файла (п. 16.5). */
    setTv: (id, body) => request('POST', `/requests/${id}/tv`, { body }),
    /** Расчёт ТВ сервером по мастер-файлу; сохраняется с версией реестра (пп. 16.2, 16.5). */
    capacityCheck: (id, tierId) => request('POST', `/requests/${id}/capacity-check`, { body: { tierId } }),
    capacityChecks: (id) => request('GET', `/requests/${id}/capacity-checks`),
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
    /** Выгрузка найденных документов архива в CSV (С6). */
    documentsExportUrl: (params) => `${BASE}/documents/export` + query(params),
    /** Просмотр в браузере — для ролей без права скачивания (PDF и изображения). */
    previewUrl: (id, version) => `${BASE}/documents/${id}/file?preview=1${version ? `&version=${version}` : ''}`,

    users: (q) => request('GET', '/users' + query({ q })),
    saveUser: (body) => request('POST', '/users', { body }),
    disableUser: (id) => request('POST', `/users/${id}/disable`, { body: {} }),
    enableUser: (id) => request('POST', `/users/${id}/enable`, { body: {} }),
    /** Ссылка на первый пароль по почте (src/server/login.ts). */
    inviteUser: (id) => request('POST', `/users/${id}/invite`, { body: {} }),
    /** Импорт из кадровой выгрузки: apply=false — предпросмотр без записи. */
    importUsers: (csv, apply) => request('POST', '/users/import', { body: { csv, apply } }),
    /** Перенос действующих заявок из таблицы ОР ПСД (src/server/migration.ts). */
    importRequests: (csv, apply) => request('POST', '/admin/import-requests', { body: { csv, apply } }),
    branches: () => request('GET', '/branches'),
    counterparties: (q) => request('GET', '/counterparties' + query({ q })),
    audit: (params) => request('GET', '/audit' + query(params)),
    auditExportUrl: (params) => `${BASE}/audit/export` + query(params),

    /** Отчёты (ТЗ №15, пп. 105, 109); format=xlsx|csv — выгрузка файлом. */
    reportRequests: (params) => request('GET', '/reports/requests' + query(params)),
    reportBranch: (params) => request('GET', '/reports/branch-monthly' + query(params)),
    reportBranchStatus: (period) => request('GET', '/reports/branch-monthly/status' + query({ period })),
    submitBranchReport: (body) => request('POST', '/reports/branch-monthly/submit', { body }),
    reportAnnual: (year) => request('GET', '/reports/annual' + query({ year })),
    reportUrl: (kind, params) => `${BASE}/reports/${kind}` + query(params),

    /** Эскалации по п. 100 и очередь уведомлений. */
    escalations: () => request('GET', '/escalations'),
    notifications: (status) => request('GET', '/notifications' + query({ status })),
    retryNotification: (id) => request('POST', `/notifications/${id}/retry`, { body: {} }),

    /** Документы и приложения заявки (п. 7.6; К5, В1). */
    requestDocuments: (id) => request('GET', `/requests/${id}/documents`),
    requestFileUrl: (id, docId, version) =>
      `${BASE}/requests/${id}/documents/${docId}/file${version ? `?version=${version}` : ''}`,
    uploadAttachments: (id, form) => request('POST', `/requests/${id}/attachments`, { body: form }),
    deleteAttachment: (id, docId) => request('POST', `/requests/${id}/attachments/${docId}/delete`, { body: {} }),
    /** Объект по адресу из заявки (п. 16.1; С5). */
    setFacility: (id, facilityId, version) => request('POST', `/requests/${id}/facility`, { body: { facilityId, version } }),
    pendingCount: () => request('GET', '/documents/pending-count'),

    /** АВР по договору (В6), дополнительные соглашения (пп. 45, 64–65). */
    contractAvr: (contractId, body) => request('POST', `/contracts/${contractId}/avr`, { body }),
    addAmendment: (contractId, body) => request('POST', `/contracts/${contractId}/amendments`, { body }),

    /** Контрольные точки, приостановка срока (пп. 23, 34, 41, 57, 63, 67–69, 80). */
    checkpoints: (id) => request('GET', `/requests/${id}/checkpoints`),
    markCheckpoint: (id, body) => request('POST', `/requests/${id}/checkpoints`, { body }),
    unmarkCheckpoint: (id, code) => request('POST', `/requests/${id}/checkpoints/${code}/delete`, { body: {} }),
    pause: (id, reason) => request('POST', `/requests/${id}/pause`, { body: { reason } }),
    resume: (id) => request('POST', `/requests/${id}/resume`, { body: {} }),

    /** Поручения ОКО подразделениям (В5). */
    assignmentDepartments: () => request('GET', '/assignments/departments'),
    createAssignment: (id, body) => request('POST', `/requests/${id}/assignments`, { body }),

    /** Реестр АМС: версии, запросы изменений, расчёт по объекту (К3, В7, С7). */
    assessFacility: (id, body) => request('POST', `/facilities/${id}/assess`, { body }),
    registryVersions: () => request('GET', '/registry/versions'),
    publishRegistryVersion: (body) => request('POST', '/registry/versions', { body }),
    registryChanges: (open) => request('GET', '/registry/changes' + query({ open: open ? 1 : '' })),
    createRegistryChange: (body) => request('POST', '/registry/changes', { body }),
    resolveRegistryChange: (id, resolution) => request('POST', `/registry/changes/${id}/resolve`, { body: { resolution } }),

    /** Справочники (В3, С3, С9; календарь, объекты, контрагенты). */
    adminBranches: () => request('GET', '/admin/branches'),
    saveBranch: (body) => request('POST', '/admin/branches', { body }),
    importBranches: (csv, apply) => request('POST', '/admin/branches/import', { body: { csv, apply } }),
    adminTariffs: () => request('GET', '/admin/tariffs'),
    saveTariff: (body) => request('POST', '/admin/tariffs', { body }),
    adminCalendar: (year) => request('GET', '/admin/calendar' + query({ year })),
    saveCalendarDay: (body) => request('POST', '/admin/calendar', { body }),
    importCalendar: (csv, apply) => request('POST', '/admin/calendar/import', { body: { csv, apply } }),
    adminFacilities: () => request('GET', '/admin/facilities'),
    saveFacility: (body) => request('POST', '/admin/facilities', { body }),
    adminCounterparties: (params) => request('GET', '/admin/counterparties' + query(params)),
    saveCounterparty: (body) => request('POST', '/admin/counterparties', { body }),
    adminStages: () => request('GET', '/admin/stages'),
    saveStage: (code, body) => request('POST', `/admin/stages/${code}`, { body }),

    /** Правила автоматизации: включение и выключение (С8). */
    rules: () => request('GET', '/rules'),
    setRule: (id, enabled) => request('POST', `/rules/${id}`, { body: { enabled } }),
  };
})();
