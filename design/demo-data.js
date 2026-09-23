/* Демонстрационные данные для дизайн-прототипа. Организации и объекты вымышлены. */
(function () {
  const iso = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  const BRANCHES = [
    'Алматинский филиал', 'Акмолинский филиал', 'Карагандинский филиал',
    'Павлодарский филиал', 'Восточно-Казахстанский филиал', 'Мангистауский филиал',
  ];

  const PEOPLE = {
    AA: { n: 'Начальник ОР ПСД', r: 'ОР ПСД' },
    MS: { n: 'Инженер ОР ПСД', r: 'ОР ПСД' },
    ET: { n: 'Инженер-проектировщик', r: 'ОР ПСД' },
    DA: { n: 'Специалист делопроизводства', r: 'Документооборот' },
    KB: { n: 'Бухгалтер по расчётам', r: 'Расчёты с контрагентами' },
    NR: { n: 'Специалист техучёта', r: 'Технический учёт активов' },
    SK: { n: 'Зам. директора филиала', r: 'Филиал' },
  };

  // [номер, заказчик, объект, филиал, услуги, этап, ответственный, смещение срока]
  const SEED = [
    ['ЗК-2026-0141', 'ТОО «Спектр Телеком»', 'РТС Кок-Тобе', 0, ['ТУ'], 'registered', 'DA', 0],
    ['ЗК-2026-0140', 'АО «Транстелеком»', 'АМС Кокшетау РТС-3', 1, ['ТУ', 'ПСД'], 'tv_review', 'ET', 3],
    ['ЗК-2026-0139', 'ТОО «Алатау Медиа»', 'АМС Темиртау РТС-7', 2, ['ТУ'], 'tv_review', 'MS', -1],
    ['ЗК-2026-0138', 'ТОО «Каспий Сигнал»', 'АМС Экибастуз РТС-2', 3, ['ТУ', 'ПСД', 'СМР'], 'tv_review', 'MS', -3],
    ['ЗК-2026-0137', 'АО «Казтелеком Юг»', 'АМС Семей РТС-1', 4, ['ТУ', 'ПСД'], 'offer', 'ET', 1],
    ['ЗК-2026-0136', 'ТОО «ЭнергоСвязь»', 'РТС Балхаш', 2, ['ТУ'], 'awaiting_payment', 'MS', 6],
    ['ЗК-2026-0135', 'ТОО «Северный эфир»', 'АМС Атырау РТС-4', 5, ['ТУ', 'СМР'], 'awaiting_payment', 'ET', -4],
    ['ЗК-2026-0134', 'ТОО «Горизонт Связь»', 'АМС Степногорск', 1, ['ТУ'], 'tu', 'MS', 2],
    ['ЗК-2026-0133', 'ТОО «Спектр Телеком»', 'АМС Караганда РТС-12', 2, ['ТУ', 'ПСД', 'СМР'], 'psd', 'MS', 11],
    ['ЗК-2026-0132', 'АО «Транстелеком»', 'АМС Талдыкорган РТС-5', 0, ['ПСД'], 'psd', 'ET', -2],
    ['ЗК-2026-0131', 'ТОО «Каспий Сигнал»', 'АМС Павлодар РТС-1', 3, ['СМР'], 'smr_prep', 'ET', 41],
    ['ЗК-2026-0129', 'ТОО «Алатау Медиа»', 'АМС Усть-Каменогорск РТС-2', 4, ['ТУ', 'СМР'], 'smr', 'SK', 4],
    ['ЗК-2026-0127', 'ТОО «Северный эфир»', 'АМС Сарань РТС-9', 2, ['СМР'], 'avr', 'KB', 0],
    ['ЗК-2026-0124', 'АО «Казтелеком Юг»', 'АМС Кокшетау РТС-3', 1, ['ТУ', 'СМР'], 'closing', 'MS', 5],
    ['ЗК-2026-0121', 'ТОО «ЭнергоСвязь»', 'РТС Кок-Тобе', 0, ['ТУ'], 'closing', 'ET', -1],
  ];

  const PRICE = { 'ТУ': 420000, 'ПСД': 980000 };

  /* БИН с корректным контрольным разрядом: демо-данные должны проходить
     ту же проверку, что и боевые (src/domain/validation.ts). */
  function makeBin(seq) {
    const base = String(50140000000 + seq * 137).padStart(11, '0').slice(0, 11);
    const w1 = [1,2,3,4,5,6,7,8,9,10,11], w2 = [3,4,5,6,7,8,9,10,11,1,2];
    const d = base.split('').map(Number);
    const sum = w => w.reduce((a, k, i) => a + k * d[i], 0);
    let c = sum(w1) % 11;
    if (c === 10) c = sum(w2) % 11;
    return c === 10 ? makeBin(seq + 1) : base + c;
  }

  const requests = SEED.map(([number, customer, object, branchIdx, services, stageCode, owner, dueOffset], i) => {
    const amount = services.reduce((sum, s) => sum + (PRICE[s] || 0), 0);
    const paidStages = ['tu', 'psd', 'smr_prep', 'smr', 'avr', 'closing'];
    return {
      number,
      customer,
      bin: makeBin(i + 3),
      object,
      branch: BRANCHES[branchIdx],
      services,
      stageCode,
      owner,
      dueAt: iso(dueOffset),
      amount: services.includes('СМР') ? null : amount,
      createdAt: iso(-20 - i),
      incomingNumber: stageCode === 'draft' ? null : `вх-${1200 + i}`,
      incomingDate: stageCode === 'draft' ? null : iso(-20 - i),
      tvStatus: ['registered', 'tv_review'].includes(stageCode) ? 'pending' : 'confirmed',
      masterFileVersion: ['registered', 'tv_review'].includes(stageCode) ? null : '2026-09-01',
      verificationCalc: stageCode === 'tv_review' && i % 3 === 0 ? 'required' : 'not_required',
      contractNumber: ['registered', 'tv_review'].includes(stageCode) ? null : `ДП-${100 + i}/26`,
      paidAt: paidStages.includes(stageCode) ? iso(-10) : null,
      estimateApproved: ['smr_prep', 'smr', 'avr', 'closing'].includes(stageCode),
      orderNumber: ['smr', 'avr', 'closing'].includes(stageCode) ? `Р-${70 + i}` : null,
      transferAct: ['smr', 'avr', 'closing'].includes(stageCode) ? iso(-12) : null,
      avrApproved: ['closing'].includes(stageCode),
      openRemarks: i === 2 ? 2 : 0,
      escalationLevel: dueOffset <= -3 ? 2 : dueOffset < 0 ? 1 : 0,
    };
  });

  /* Завершённые прохождения этапов — основа показателей узких мест. */
  const history = [];
  const PROFILE = {
    registered: [0, 1], tv_review: [3, 14], offer: [1, 4], awaiting_payment: [2, 16],
    tu: [3, 9], psd: [22, 41], smr_prep: [20, 70], smr: [9, 22], avr: [1, 3], closing: [4, 12],
  };
  let seedRandom = 42;
  const rnd = () => (seedRandom = (seedRandom * 1103515245 + 12345) % 2147483648) / 2147483648;

  Object.entries(PROFILE).forEach(([code, [min, max]]) => {
    for (let i = 0; i < 18; i++) {
      const spent = Math.round(min + rnd() * (max - min));
      history.push({ stageCode: code, spent });
    }
  });

  /* Прейскурант: позиции ТУ и ПСД. СМР — только по утверждённой смете (п. 49). */
  const TARIFFS = [
    { id: 't-tu-ams', service: 'ТУ', name: 'ТУ на размещение оборудования на АМС', unit: 'услуга', amount: 420000, source: 'Прейскурант, п. 3.1' },
    { id: 't-tu-room', service: 'ТУ', name: 'ТУ на размещение в помещении', unit: 'услуга', amount: 310000, source: 'Прейскурант, п. 3.2' },
    { id: 't-tu-cable', service: 'ТУ', name: 'ТУ на прокладку кабеля', unit: 'трасса', amount: 265000, source: 'Прейскурант, п. 3.4' },
    { id: 't-tu-power', service: 'ТУ', name: 'ТУ на подключение электроснабжения', unit: 'точка', amount: 380000, source: 'Прейскурант, п. 3.5' },
    { id: 't-psd-rp', service: 'ПСД', name: 'Разработка рабочего проекта (одностадийный РП)', unit: 'проект', amount: 980000, source: 'Прейскурант, п. 4.2' },
    { id: 't-psd-sd', service: 'ПСД', name: 'Сметная документация к РП', unit: 'комплект', amount: 210000, source: 'Прейскурант, п. 4.3' },
  ];

  /* Мастер-файл «Реестр АМС и загрузки». Структура — Приложение 8 Регламента.
     Часть паспортных значений в Приложении помечена [ЗАПОЛНИТЬ] — здесь это null. */
  const FACILITIES = [
    { inv: 1187, name: 'АМС Караганда РТС-12', branch: BRANCHES[2], kind: 'башня', height: 72,
      passportLoad: 9500, load: 5740, powerInput: 15, powerUsed: 8.5, version: '2026-09-01', checkedAt: iso(-60),
      tiers: [{ h: 66, cap: 2800, load: 1800 }, { h: 58, cap: 3200, load: 2340 }, { h: 48, cap: 3500, load: 1600 }],
      tenants: [
        { c: 'ТОО «Спектр Телеком»', eq: '4 RRU + 3 антенны', kg: 1240, m2: 2.1, kw: 3.2, tu: 'ТУ-2025-014' },
        { c: 'ТОО «Алатау Медиа»', eq: '3 антенны панельные', kg: 820, m2: 1.6, kw: 1.8, tu: 'ТУ-2024-089' },
      ] },
    { inv: 1233, name: 'АМС Темиртау РТС-7', branch: BRANCHES[2], kind: 'мачта', height: 60,
      passportLoad: 6200, load: 5810, powerInput: 10, powerUsed: 9.1, version: '2026-09-01', checkedAt: iso(-120),
      tiers: [{ h: 54, cap: 2600, load: 2600 }, { h: 44, cap: 3600, load: 3210 }],
      tenants: [{ c: 'ТОО «Горизонт Связь»', eq: '6 антенн', kg: 2100, m2: 3.4, kw: 4.1, tu: 'ТУ-2023-102' }] },
    { inv: 1710, name: 'АМС Экибастуз РТС-2', branch: BRANCHES[3], kind: 'башня', height: 80,
      passportLoad: 11000, load: 4300, powerInput: 20, powerUsed: 6.4, version: '2026-09-01', checkedAt: iso(-30),
      tiers: [{ h: 74, cap: 3000, load: 1200 }, { h: 64, cap: 4000, load: 1900 }, { h: 52, cap: 4000, load: 1200 }],
      tenants: [{ c: 'ТОО «Каспий Сигнал»', eq: '3 антенны', kg: 900, m2: 1.7, kw: 2.2, tu: 'ТУ-2025-003' }] },
    { inv: 402, name: 'РТС Кок-Тобе', branch: BRANCHES[0], kind: 'телебашня', height: 372,
      passportLoad: null, load: 47800, powerInput: 120, powerUsed: 96, version: '2026-09-01', checkedAt: iso(-45),
      tiers: [{ h: 300, cap: 15000, load: 12000 }, { h: 250, cap: 20000, load: 16800 }, { h: 200, cap: null, load: 19000 }],
      tenants: [{ c: 'ТОО «Спектр Телеком»', eq: '12 антенн', kg: 4200, m2: 6.5, kw: 11, tu: 'ТУ-2024-002' }] },
  ];

  window.QTR_DEMO = { requests, history, people: PEOPLE, branches: BRANCHES, tariffs: TARIFFS, facilities: FACILITIES };
})();
