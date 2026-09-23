/* Сгенерировано: node --experimental-strip-types seed/emit-ui-config.ts */
window.QTR_CONFIG = {
  "stages": [
    {
      "code": "draft",
      "order": 1,
      "name": "Черновик заявки",
      "short": "Черновик",
      "slaValue": 0,
      "slaUnit": "none",
      "slaText": "—",
      "ownerParty": "customer",
      "ownerName": "Заказчик",
      "serviceScope": null,
      "customerStatus": "draft",
      "customerStatusName": "Черновик",
      "terminal": false,
      "regulationRef": "ТЗ №1",
      "hint": "Заказчик заполняет форму на портале. Заявка ещё не подана."
    },
    {
      "code": "registered",
      "order": 2,
      "name": "Зарегистрирована",
      "short": "Регистрация",
      "slaValue": 0,
      "slaUnit": "same_day",
      "slaText": "в день поступления",
      "ownerParty": "records",
      "ownerName": "Документооборот",
      "serviceScope": null,
      "customerStatus": "registered",
      "customerStatusName": "Зарегистрирована",
      "terminal": false,
      "regulationRef": "п. 6",
      "hint": "Регистрация в СП ЦА, ответственном за документооборот, и направление в ОР ПСД и филиал."
    },
    {
      "code": "tv_review",
      "order": 3,
      "name": "Оценка технической возможности",
      "short": "Оценка ТВ",
      "slaValue": 5,
      "slaUnit": "working",
      "slaText": "5 рабочих дней",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": null,
      "customerStatus": "review",
      "customerStatusName": "На проверке",
      "terminal": false,
      "regulationRef": "пп. 9, 16",
      "hint": "Проверка по мастер-файлу «Реестр АМС и загрузки»; результат фиксируется с версией реестра."
    },
    {
      "code": "offer",
      "order": 4,
      "name": "КП, договор, счёт",
      "short": "КП и договор",
      "slaValue": 1,
      "slaUnit": "operational",
      "slaText": "счёт — в день получения СЗ",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": null,
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 21, 32, 48, 84–85",
      "hint": "Коммерческое предложение по Прейскуранту суммой позиций, проект договора, счёт в 1С."
    },
    {
      "code": "awaiting_payment",
      "order": 5,
      "name": "Ожидание 100 % предоплаты",
      "short": "Оплата",
      "slaValue": 10,
      "slaUnit": "working",
      "slaText": "оферта 10 рабочих дней",
      "ownerParty": "customer",
      "ownerName": "Заказчик",
      "serviceScope": null,
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 86–88, табл. 1",
      "hint": "Ежедневный мониторинг поступления оплаты; по истечении оферты заявка закрывается."
    },
    {
      "code": "tu",
      "order": 6,
      "name": "Выдача технических условий",
      "short": "ТУ",
      "slaValue": 5,
      "slaUnit": "working",
      "slaText": "5 рабочих дней после полной оплаты",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": "ТУ",
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 22–24",
      "hint": "Разработка, согласование с филиалом, утверждение и направление ТУ Заявителю."
    },
    {
      "code": "psd",
      "order": 7,
      "name": "Разработка ПСД",
      "short": "ПСД",
      "slaValue": 30,
      "slaUnit": "working",
      "slaText": "30 рабочих дней, продление не более 15",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": "ПСД",
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 33–42",
      "hint": "Контрольные точки: исходные данные (3 р.д.), графическая часть, двухуровневая проверка СД, согласование с филиалом."
    },
    {
      "code": "smr_prep",
      "order": 8,
      "name": "Подготовка к СМР",
      "short": "Подготовка СМР",
      "slaValue": 90,
      "slaUnit": "calendar",
      "slaText": "до 90 календарных дней на оборудование",
      "ownerParty": "customer",
      "ownerName": "Заказчик",
      "serviceScope": "СМР",
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 55–60",
      "hint": "Заказчик передаёт оборудование по акту; филиал принимает; оформляется распоряжение на СМР."
    },
    {
      "code": "smr",
      "order": 9,
      "name": "Выполнение СМР",
      "short": "СМР",
      "slaValue": 15,
      "slaUnit": "working",
      "slaText": "15 рабочих дней",
      "ownerParty": "branch",
      "ownerName": "Филиал",
      "serviceScope": "СМР",
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "п. 59",
      "hint": "Работы выполняет филиал; по завершении оформляется технический АВР."
    },
    {
      "code": "avr",
      "order": 10,
      "name": "АВР и ЭСФ",
      "short": "АВР и ЭСФ",
      "slaValue": 1,
      "slaUnit": "operational",
      "slaText": "1 операционный день",
      "ownerParty": "accounting",
      "ownerName": "Расчёты с контрагентами",
      "serviceScope": null,
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 66, 70, 90–92",
      "hint": "Формирование акта по типовой форме № 2В и электронной счёт-фактуры, направление Заказчику."
    },
    {
      "code": "closing",
      "order": 11,
      "name": "Приёмка Заказчиком",
      "short": "Приёмка",
      "slaValue": 10,
      "slaUnit": "working",
      "slaText": "10 рабочих дней на замечания",
      "ownerParty": "customer",
      "ownerName": "Заказчик",
      "serviceScope": null,
      "customerStatus": "work",
      "customerStatusName": "В работе",
      "terminal": false,
      "regulationRef": "пп. 93–95",
      "hint": "Без подтверждения и мотивированных замечаний в срок работы считаются принятыми в полном объёме."
    },
    {
      "code": "closed_done",
      "order": 12,
      "name": "Исполнена",
      "short": "Исполнена",
      "slaValue": 0,
      "slaUnit": "none",
      "slaText": "—",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": null,
      "customerStatus": "done",
      "customerStatusName": "Выполнена",
      "terminal": true,
      "regulationRef": "п. 127",
      "hint": "Договор считается исполненным после подписания всех предусмотренных документов."
    },
    {
      "code": "closed_rejected",
      "order": 13,
      "name": "Отказано",
      "short": "Отказ",
      "slaValue": 2,
      "slaUnit": "working",
      "slaText": "ответ в 2 рабочих дня",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": null,
      "customerStatus": "rejected",
      "customerStatusName": "Отклонена",
      "terminal": true,
      "regulationRef": "п. 19, табл. 1",
      "hint": "Мотивированный письменный отказ; заявка закрывается и архивируется."
    },
    {
      "code": "closed_expired",
      "order": 14,
      "name": "Закрыта по истечении оферты",
      "short": "Оферта истекла",
      "slaValue": 0,
      "slaUnit": "none",
      "slaText": "—",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": null,
      "customerStatus": "rejected",
      "customerStatusName": "Отклонена",
      "terminal": true,
      "regulationRef": "табл. 1",
      "hint": "Оплата не поступила в течение 10 рабочих дней; заявка закрыта с письменным уведомлением."
    },
    {
      "code": "closed_cancelled",
      "order": 15,
      "name": "Расторгнута",
      "short": "Расторжение",
      "slaValue": 0,
      "slaUnit": "none",
      "slaText": "—",
      "ownerParty": "orpsd",
      "ownerName": "ОР ПСД",
      "serviceScope": null,
      "customerStatus": "rejected",
      "customerStatusName": "Отклонена",
      "terminal": true,
      "regulationRef": "пп. 96–97",
      "hint": "Соглашение о расторжении; при необходимости — заявка на возврат денежных средств."
    }
  ],
  "transitions": [
    {
      "from": "draft",
      "to": "registered",
      "title": "Подать заявку",
      "roles": [
        "customer",
        "records",
        "orpsd",
        "admin"
      ],
      "regulationRef": "п. 6"
    },
    {
      "from": "registered",
      "to": "tv_review",
      "title": "Направить на оценку ТВ",
      "roles": [
        "records",
        "orpsd",
        "admin"
      ],
      "regulationRef": "п. 6.1"
    },
    {
      "from": "registered",
      "to": "closed_rejected",
      "title": "Отклонить заявку",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "п. 19"
    },
    {
      "from": "tv_review",
      "to": "offer",
      "title": "ТВ подтверждена — сформировать КП",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 16.3, 16.5, 21"
    },
    {
      "from": "tv_review",
      "to": "closed_rejected",
      "title": "ТВ отсутствует — мотивированный отказ",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "табл. 1"
    },
    {
      "from": "offer",
      "to": "awaiting_payment",
      "title": "Договор и счёт направлены",
      "roles": [
        "orpsd",
        "accounting",
        "admin"
      ],
      "regulationRef": "пп. 84–85"
    },
    {
      "from": "offer",
      "to": "closed_cancelled",
      "title": "Расторжение / отзыв заявки",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 96–97"
    },
    {
      "from": "awaiting_payment",
      "to": "tu",
      "title": "Оплата получена — выдача ТУ",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 20, 24, 86"
    },
    {
      "from": "awaiting_payment",
      "to": "psd",
      "title": "Оплата получена — разработка ПСД",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 33, 86"
    },
    {
      "from": "awaiting_payment",
      "to": "smr_prep",
      "title": "Оплата получена — подготовка к СМР",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 49, 53, 54"
    },
    {
      "from": "awaiting_payment",
      "to": "closed_expired",
      "title": "Закрыть по истечении оферты",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "табл. 1"
    },
    {
      "from": "awaiting_payment",
      "to": "closed_cancelled",
      "title": "Расторжение и возврат",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 96–97"
    },
    {
      "from": "tu",
      "to": "psd",
      "title": "ТУ выданы — к разработке ПСД",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 24, 32"
    },
    {
      "from": "tu",
      "to": "smr_prep",
      "title": "ТУ выданы — к подготовке СМР",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 49, 53"
    },
    {
      "from": "tu",
      "to": "avr",
      "title": "ТУ выданы — к оформлению АВР",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 25, 90"
    },
    {
      "from": "psd",
      "to": "smr_prep",
      "title": "ПСД утверждена — к подготовке СМР",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 42, 49, 53"
    },
    {
      "from": "psd",
      "to": "avr",
      "title": "ПСД передана — к оформлению АВР",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 42–43, 90"
    },
    {
      "from": "smr_prep",
      "to": "smr",
      "title": "Оборудование принято — начать СМР",
      "roles": [
        "orpsd",
        "branch",
        "admin"
      ],
      "regulationRef": "пп. 58–60"
    },
    {
      "from": "smr_prep",
      "to": "closed_cancelled",
      "title": "Оборудование не предоставлено — расторжение",
      "roles": [
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 57, 96"
    },
    {
      "from": "smr",
      "to": "avr",
      "title": "Работы завершены — оформить АВР",
      "roles": [
        "orpsd",
        "branch",
        "admin"
      ],
      "regulationRef": "пп. 66, 70"
    },
    {
      "from": "avr",
      "to": "closing",
      "title": "АВР и ЭСФ направлены Заказчику",
      "roles": [
        "accounting",
        "orpsd",
        "admin"
      ],
      "regulationRef": "пп. 91–93"
    },
    {
      "from": "closing",
      "to": "closed_done",
      "title": "Работы приняты — закрыть заявку",
      "roles": [
        "orpsd",
        "accounting",
        "admin"
      ],
      "regulationRef": "пп. 94–95, 127"
    }
  ],
  "rules": [
    {
      "id": 1,
      "event": "Заявка зарегистрирована",
      "description": "Определить филиал и курирующего заместителя директора по объекту; направить заявку в ОР ПСД и филиал; запустить срок ответа 5 рабочих дней",
      "regulationRef": "пп. 6, 9, Приложение 7",
      "timerDays": 5,
      "enabled": true
    },
    {
      "id": 2,
      "event": "Недостаточно данных для оценки ТВ",
      "description": "Сформировать служебную записку в филиал с таймером 3 рабочих дня и напоминанием курирующему заместителю директора",
      "regulationRef": "п. 10",
      "timerDays": 3,
      "enabled": true
    },
    {
      "id": 3,
      "event": "Загрузка приближается к предельным значениям",
      "description": "Показать расчётную загрузку объекта и яруса, остаток ёмкости и мощности; запросить решение инженера о поверочном расчёте. Числовой порог Регламентом не установлен — система его не задаёт",
      "regulationRef": "п. 16.4, Приложение 8",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 4,
      "event": "Техническая возможность подтверждена",
      "description": "Сформировать КП по Прейскуранту суммой всех позиций заявки, проект договора и служебную записку на выставление счёта",
      "regulationRef": "пп. 21, 32, 48",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 5,
      "event": "Договор подписан",
      "description": "Направить СЗ в СП ЦА, ответственное за расчёты с контрагентами; счёт формируется в 1С в день получения СЗ и направляется Заказчику",
      "regulationRef": "пп. 84–85",
      "timerDays": 1,
      "enabled": true
    },
    {
      "id": 6,
      "event": "Оплата не поступила",
      "description": "Ежедневный мониторинг поступления оплаты; письмо-напоминание Заказчику; по истечении срока оферты (10 рабочих дней) — закрытие заявки с письменным уведомлением",
      "regulationRef": "п. 88, табл. 1",
      "timerDays": 10,
      "enabled": true
    },
    {
      "id": 7,
      "event": "Поступила 100 % предоплата",
      "description": "Запустить срок оказания услуги: ТУ — 5 рабочих дней, ПСД — 30 рабочих дней; направить СЗ в филиал о возможности приёма оборудования",
      "regulationRef": "пп. 24, 33, 54",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 8,
      "event": "Разработка ПСД, третий рабочий день",
      "description": "Контрольная точка «проверка полноты и корректности исходных данных»; при неполноте — запрос в филиал с уведомлением курирующего заместителя директора",
      "regulationRef": "п. 34.1",
      "timerDays": 3,
      "enabled": true
    },
    {
      "id": 9,
      "event": "До срока ПСД пять дней, объём не закрыт",
      "description": "Предложить продление не более чем на 15 рабочих дней с письменным уведомлением Заказчика",
      "regulationRef": "п. 33",
      "timerDays": 15,
      "enabled": true
    },
    {
      "id": 10,
      "event": "До истечения срока предоставления оборудования десять дней",
      "description": "Направить уведомление-напоминание Заказчику; при просрочке — претензия, далее приостановление и (или) расторжение договора",
      "regulationRef": "пп. 56–57",
      "timerDays": 10,
      "enabled": true
    },
    {
      "id": 11,
      "event": "Акт приёма-передачи оборудования завизирован",
      "description": "Запустить срок выполнения СМР 15 рабочих дней; поставить задачу на подготовку распоряжения",
      "regulationRef": "пп. 58–60",
      "timerDays": 15,
      "enabled": true
    },
    {
      "id": 12,
      "event": "Нарушен срок этапа",
      "description": "Эскалация 1-го уровня в день выявления — курирующему заместителю директора филиала с копией директору; при неустранении в течение 2 рабочих дней — 2-й уровень курирующему члену Правления",
      "regulationRef": "п. 100",
      "timerDays": 2,
      "enabled": true
    },
    {
      "id": 13,
      "event": "Технический акт выполненных работ подписан",
      "description": "Уведомить СП ЦА, ответственное за расчёты с контрагентами: АВР и электронная счёт-фактура оформляются не позднее 1 операционного дня",
      "regulationRef": "пп. 66, 90–91",
      "timerDays": 1,
      "enabled": true
    },
    {
      "id": 14,
      "event": "Заказчик отказался подписать технический АВР",
      "description": "Служебная записка филиала с причиной и подтверждающими документами; при разногласиях — претензионный порядок и СЗ в СП ЦА, ответственное за юридические вопросы",
      "regulationRef": "пп. 67–69, табл. 1",
      "timerDays": 3,
      "enabled": true
    },
    {
      "id": 15,
      "event": "АВР не подписан и замечания не поступили в течение 10 рабочих дней",
      "description": "Работы считаются принятыми в полном объёме без замечаний; дополнительное оформление и повторное подписание не требуются",
      "regulationRef": "пп. 94–95",
      "timerDays": 10,
      "enabled": true
    },
    {
      "id": 16,
      "event": "Поступило письмо о расторжении договора",
      "description": "Подготовка соглашения о расторжении; при необходимости — заявка на возврат денежных средств",
      "regulationRef": "пп. 96–97",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 17,
      "event": "Истекает срок действия технических условий",
      "description": "Уведомить ОР ПСД и Заказчика: срок действия ТУ не более 6 месяцев, продление допускается только по запросу до истечения срока",
      "regulationRef": "п. 31",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 18,
      "event": "Истекают три месяца с даты получения утверждённой ПСД",
      "description": "Условия установки оборудования перестают быть актуальными — требуется повторная оценка технической возможности и при необходимости актуализация проектных решений",
      "regulationRef": "п. 47",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 19,
      "event": "Получен технический акт монтажа или демонтажа",
      "description": "Задача СП ЦА, ответственному за технический учёт активов: внести изменения в реестр в течение 1 рабочего дня; при высвобождении ёмкости — уведомление коммерческому блоку",
      "regulationRef": "пп. 13–14",
      "timerDays": 1,
      "enabled": true
    },
    {
      "id": 20,
      "event": "Наступило 5-е число месяца",
      "description": "Подготовить отчёт филиала об исполненных и неисполненных договорах за прошедший месяц для подтверждения и направления в установленном порядке",
      "regulationRef": "п. 105",
      "timerDays": null,
      "enabled": true
    },
    {
      "id": 21,
      "event": "Наступило 1 марта",
      "description": "Сформировать сводный отчёт по производственным показателям филиалов за отчётный год по исполненным, принятым и оплаченным договорам",
      "regulationRef": "пп. 107, 109",
      "timerDays": null,
      "enabled": true
    }
  ],
  "ownerParties": {
    "records": "Документооборот",
    "orpsd": "ОР ПСД",
    "branch": "Филиал",
    "customer": "Заказчик",
    "accounting": "Расчёты с контрагентами",
    "assets": "Технический учёт активов"
  },
  "services": {
    "ТУ": "Технические условия",
    "ПСД": "Проектно-сметная документация",
    "СМР": "Строительно-монтажные работы"
  }
};
