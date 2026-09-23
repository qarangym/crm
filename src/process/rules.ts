/**
 * Правила автоматизации: событие → действие системы → пункт Регламента.
 *
 * Каталог ниже — начальное наполнение таблицы `automation_rules`.
 * Администратор ДИТ может включить или выключить правило; выключенное
 * продолжает писаться в журнал, но не рассылает уведомления.
 *
 * Ссылка на пункт хранится вместе с правилом намеренно: при проверке нужно
 * показать, какой норме соответствует каждое автоматическое действие.
 */

export type RuleTrigger =
  | 'request_registered'
  | 'tv_data_missing'
  | 'tv_capacity_near_limit'
  | 'tv_confirmed'
  | 'contract_signed'
  | 'payment_pending'
  | 'payment_received'
  | 'psd_control_point'
  | 'psd_deadline_near'
  | 'equipment_due_soon'
  | 'transfer_act_approved'
  | 'stage_breached'
  | 'technical_avr_signed'
  | 'customer_refused_act'
  | 'avr_silence_expired'
  | 'contract_terminated'
  | 'tu_expiring'
  | 'psd_conditions_expiring'
  | 'mount_act_received'
  | 'monthly_branch_report'
  | 'annual_summary_report';

export type RuleAction =
  | 'assign_branch_and_curator'
  | 'create_memo'
  | 'flag_verification_calc'
  | 'create_offer_tasks'
  | 'request_invoice'
  | 'remind_customer'
  | 'start_service_timer'
  | 'create_control_point'
  | 'offer_extension'
  | 'send_claim'
  | 'start_smr_timer'
  | 'escalate'
  | 'notify_accounting'
  | 'create_legal_task'
  | 'close_as_accepted'
  | 'notify_expiry'
  | 'require_tv_recheck'
  | 'update_registry_task'
  | 'build_report';

export type AutomationRule = {
  id: number;
  trigger: RuleTrigger;
  event: string;
  action: RuleAction;
  description: string;
  regulationRef: string;
  enabled: boolean;
  /** Норматив, запускаемый правилом, в рабочих днях. */
  timerDays?: number;
};

export const AUTOMATION_RULES: readonly AutomationRule[] = [
  {
    id: 1,
    trigger: 'request_registered',
    event: 'Заявка зарегистрирована',
    action: 'assign_branch_and_curator',
    description: 'Определить филиал и курирующего заместителя директора по объекту; направить заявку в ОР ПСД и филиал; запустить срок ответа 5 рабочих дней',
    regulationRef: 'пп. 6, 9, Приложение 7',
    enabled: true,
    timerDays: 5,
  },
  {
    id: 2,
    trigger: 'tv_data_missing',
    event: 'Недостаточно данных для оценки ТВ',
    action: 'create_memo',
    description: 'Сформировать служебную записку в филиал с таймером 3 рабочих дня и напоминанием курирующему заместителю директора',
    regulationRef: 'п. 10',
    enabled: true,
    timerDays: 3,
  },
  {
    id: 3,
    trigger: 'tv_capacity_near_limit',
    event: 'Загрузка приближается к предельным значениям',
    action: 'flag_verification_calc',
    description: 'Показать расчётную загрузку объекта и яруса, остаток ёмкости и мощности; запросить решение инженера о поверочном расчёте. Числовой порог Регламентом не установлен — система его не задаёт',
    regulationRef: 'п. 16.4, Приложение 8',
    enabled: true,
  },
  {
    id: 4,
    trigger: 'tv_confirmed',
    event: 'Техническая возможность подтверждена',
    action: 'create_offer_tasks',
    description: 'Сформировать КП по Прейскуранту суммой всех позиций заявки, проект договора и служебную записку на выставление счёта',
    regulationRef: 'пп. 21, 32, 48',
    enabled: true,
  },
  {
    id: 5,
    trigger: 'contract_signed',
    event: 'Договор подписан',
    action: 'request_invoice',
    description: 'Направить СЗ в СП ЦА, ответственное за расчёты с контрагентами; счёт формируется в 1С в день получения СЗ и направляется Заказчику',
    regulationRef: 'пп. 84–85',
    enabled: true,
    timerDays: 1,
  },
  {
    id: 6,
    trigger: 'payment_pending',
    event: 'Оплата не поступила',
    action: 'remind_customer',
    description: 'Ежедневный мониторинг поступления оплаты; письмо-напоминание Заказчику; по истечении срока оферты (10 рабочих дней) — закрытие заявки с письменным уведомлением',
    regulationRef: 'п. 88, табл. 1',
    enabled: true,
    timerDays: 10,
  },
  {
    id: 7,
    trigger: 'payment_received',
    event: 'Поступила 100 % предоплата',
    action: 'start_service_timer',
    description: 'Запустить срок оказания услуги: ТУ — 5 рабочих дней, ПСД — 30 рабочих дней; направить СЗ в филиал о возможности приёма оборудования',
    regulationRef: 'пп. 24, 33, 54',
    enabled: true,
  },
  {
    id: 8,
    trigger: 'psd_control_point',
    event: 'Разработка ПСД, третий рабочий день',
    action: 'create_control_point',
    description: 'Контрольная точка «проверка полноты и корректности исходных данных»; при неполноте — запрос в филиал с уведомлением курирующего заместителя директора',
    regulationRef: 'п. 34.1',
    enabled: true,
    timerDays: 3,
  },
  {
    id: 9,
    trigger: 'psd_deadline_near',
    event: 'До срока ПСД пять дней, объём не закрыт',
    action: 'offer_extension',
    description: 'Предложить продление не более чем на 15 рабочих дней с письменным уведомлением Заказчика',
    regulationRef: 'п. 33',
    enabled: true,
    timerDays: 15,
  },
  {
    id: 10,
    trigger: 'equipment_due_soon',
    event: 'До истечения срока предоставления оборудования десять дней',
    action: 'remind_customer',
    description: 'Направить уведомление-напоминание Заказчику; при просрочке — претензия, далее приостановление и (или) расторжение договора',
    regulationRef: 'пп. 56–57',
    enabled: true,
    timerDays: 10,
  },
  {
    id: 11,
    trigger: 'transfer_act_approved',
    event: 'Акт приёма-передачи оборудования завизирован',
    action: 'start_smr_timer',
    description: 'Запустить срок выполнения СМР 15 рабочих дней; поставить задачу на подготовку распоряжения',
    regulationRef: 'пп. 58–60',
    enabled: true,
    timerDays: 15,
  },
  {
    id: 12,
    trigger: 'stage_breached',
    event: 'Нарушен срок этапа',
    action: 'escalate',
    description: 'Эскалация 1-го уровня в день выявления — курирующему заместителю директора филиала с копией директору; при неустранении в течение 2 рабочих дней — 2-й уровень курирующему члену Правления',
    regulationRef: 'п. 100',
    enabled: true,
    timerDays: 2,
  },
  {
    id: 13,
    trigger: 'technical_avr_signed',
    event: 'Технический акт выполненных работ подписан',
    action: 'notify_accounting',
    description: 'Уведомить СП ЦА, ответственное за расчёты с контрагентами: АВР и электронная счёт-фактура оформляются не позднее 1 операционного дня',
    regulationRef: 'пп. 66, 90–91',
    enabled: true,
    timerDays: 1,
  },
  {
    id: 14,
    trigger: 'customer_refused_act',
    event: 'Заказчик отказался подписать технический АВР',
    action: 'create_legal_task',
    description: 'Служебная записка филиала с причиной и подтверждающими документами; при разногласиях — претензионный порядок и СЗ в СП ЦА, ответственное за юридические вопросы',
    regulationRef: 'пп. 67–69, табл. 1',
    enabled: true,
    timerDays: 3,
  },
  {
    id: 15,
    trigger: 'avr_silence_expired',
    event: 'АВР не подписан и замечания не поступили в течение 10 рабочих дней',
    action: 'close_as_accepted',
    description: 'Работы считаются принятыми в полном объёме без замечаний; дополнительное оформление и повторное подписание не требуются',
    regulationRef: 'пп. 94–95',
    enabled: true,
    timerDays: 10,
  },
  {
    id: 16,
    trigger: 'contract_terminated',
    event: 'Поступило письмо о расторжении договора',
    action: 'create_legal_task',
    description: 'Подготовка соглашения о расторжении; при необходимости — заявка на возврат денежных средств',
    regulationRef: 'пп. 96–97',
    enabled: true,
  },
  {
    id: 17,
    trigger: 'tu_expiring',
    event: 'Истекает срок действия технических условий',
    action: 'notify_expiry',
    description: 'Уведомить ОР ПСД и Заказчика: срок действия ТУ не более 6 месяцев, продление допускается только по запросу до истечения срока',
    regulationRef: 'п. 31',
    enabled: true,
  },
  {
    id: 18,
    trigger: 'psd_conditions_expiring',
    event: 'Истекают три месяца с даты получения утверждённой ПСД',
    action: 'require_tv_recheck',
    description: 'Условия установки оборудования перестают быть актуальными — требуется повторная оценка технической возможности и при необходимости актуализация проектных решений',
    regulationRef: 'п. 47',
    enabled: true,
  },
  {
    id: 19,
    trigger: 'mount_act_received',
    event: 'Получен технический акт монтажа или демонтажа',
    action: 'update_registry_task',
    description: 'Задача СП ЦА, ответственному за технический учёт активов: внести изменения в реестр в течение 1 рабочего дня; при высвобождении ёмкости — уведомление коммерческому блоку',
    regulationRef: 'пп. 13–14',
    enabled: true,
    timerDays: 1,
  },
  {
    id: 20,
    trigger: 'monthly_branch_report',
    event: 'Наступило 5-е число месяца',
    action: 'build_report',
    description: 'Подготовить отчёт филиала об исполненных и неисполненных договорах за прошедший месяц для подтверждения и направления в установленном порядке',
    regulationRef: 'п. 105',
    enabled: true,
  },
  {
    id: 21,
    trigger: 'annual_summary_report',
    event: 'Наступило 1 марта',
    action: 'build_report',
    description: 'Сформировать сводный отчёт по производственным показателям филиалов за отчётный год по исполненным, принятым и оплаченным договорам',
    regulationRef: 'пп. 107, 109',
    enabled: true,
  },
];

export const ruleById = (id: number): AutomationRule | undefined => AUTOMATION_RULES.find((r) => r.id === id);

export const rulesFor = (trigger: RuleTrigger): AutomationRule[] =>
  AUTOMATION_RULES.filter((r) => r.trigger === trigger && r.enabled);
