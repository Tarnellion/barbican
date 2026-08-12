# Модели мультитенантности и контроля доступа

Обзор публичных источников: как устроены контуры изоляции в мультитенантных
платформах, какие модели контроля доступа за этим стоят и что из этого вообще
поддаётся проверке чёрным ящиком по HTTP.

**Правила этого документа.** Каждое утверждение — со ссылкой на публичный источник.
Утверждения без ссылки помечены явно как **[не подтверждено]** и являются выводом
автора, а не цитатой. Внутренние источники работодателя не использовались.

**Оговорка о доступности текстов.** Тексты ISO/IEC 27001:2022, ISO/IEC 27002:2022,
COSO Internal Control — Integrated Framework и AICPA Trust Services Criteria платные
либо спрятаны за формой скачивания. Там, где первоисточник прочитать не удалось,
это сказано в месте цитирования и указан вторичный источник.

---

## 1. Модели тенантности: silo, bridge, pool

### 1.1 Определения AWS

AWS Well-Architected SaaS Lens делит архитектуры на три категории —
[silo, pool и bridge](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html):

- **silo** — «архитектура, где тенантам выделены отдельные ресурсы»: отдельный стек
  инфраструктуры или отдельная БД на тенанта. Существенная оговорка AWS: даже при
  выделенных ресурсах silo «по-прежнему опирается на общий опыт идентификации,
  онбординга и эксплуатации» — иначе это не SaaS, а managed service.
- **pool** — тенанты делят ресурсы. Это «более классическое понимание
  мультитенантности».
- **bridge** — смешанный режим: часть системы silo, часть pool. AWS прямо связывает
  выбор с профилем: регуляторный профиль данных сервиса и его подверженность
  noisy neighbor толкают к silo, а гибкость и стоимость — к pool.

Ключевое для инструмента проверки — что AWS говорит про
[pool-изоляцию](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/pool-isolation.html):

> «We can't lean on the typical networking and IAM constructs to create boundaries
> between tenants.»

и там же — что общая инфраструктура «увеличивает шанс cross-tenant доступа», а не
уменьшает требования к изоляции. В списке минусов pool перечислены noisy neighbor,
учёт потребления на тенанта, blast radius и «compliance pushback».

### 1.2 Изоляция — это не аутентификация и не авторизация

Самое важное утверждение во всём разделе, из
[AWS SaaS Architecture Fundamentals](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html):

> «These constructs provide security, but not isolation. In fact, a user could be
> authenticated and authorized, and still access the resources of another tenant.
> Nothing about authentication and authorization will necessarily block this access.»

Там же: «tenant isolation focuses exclusively on using tenant context to limit access
to resources». То есть изоляция — отдельная ось, ортогональная роли. Двумерная матрица
«роль × эндпоинт» её структурно не покрывает; это и есть обоснование третьего измерения
в [ADR-0010](../adr/0010-resources-and-tenancy.md).

Как контекст тенанта попадает в запрос —
[AWS, «Identity and isolation»](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/identity-and-isolation.html):
при аутентификации система возвращает tenant context, привязку пользователя к тенанту
плюс политики, и этот контекст течёт через все взаимодействия. Скоуп может быть
привязан к сервису при развёртывании либо получен в рантайме.

### 1.3 Те же три модели у Microsoft

[Azure Architecture Center, «Tenancy models»](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models)
называет их иначе, но делит так же: automated single-tenant deployments, fully
multitenant deployments, vertically partitioned, horizontally partitioned. Изоляция
там подана как континуум, а не бинарный признак («instead of viewing isolation as a
discrete property, consider it a spectrum»).

Формулировка, прямо описывающая поверхность утечки в pool:

> «When multiple tenants share a single deployment (a set of infrastructure), you
> typically rely on your application code and a tenant identifier that's in a database
> to keep each tenant's data separate.»

То есть в pool граница держится на коде приложения и колонке-дискриминаторе — на том,
что ломается тихо.

[Раздел про хранение данных](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data)
добавляет два практически важных пункта:

- Таблица на тенанта объявлена антипаттерном; рекомендация — «a single set of
  multitenant tables with a tenant identifier column» либо отдельные БД на тенанта.
- Про row-level security: «you need to ensure that the user's identity and tenant
  identity are propagated through the application and into the data store with each
  query. This approach can be complex to design, implement, test, and maintain. Many
  multitenant solutions don't use row-level security because of those complexities.»

И прямое требование проверять изоляцию эмпирически (там же, «Test your isolation
model»): «be sure to test your solution to verify that one tenant's data isn't
accidentally leaked to another».

### 1.4 То же самое у Google

[Google Cloud, multi-tenancy в Spanner](https://docs.cloud.google.com/spanner/docs/implement-multi-tenancy)
даёт более дробную шкалу — четыре паттерна: instance, database, table, row.
Крайние точки описаны так:

| Паттерн | Изоляция по формулировке Google |
|---|---|
| instance | «Greatest level of data isolation», хранение физически разделено |
| database | «Complete logical isolation on the database level» |
| table | «Moderate level of data isolation», данные могут лежать в одном файле |
| row | «Lowest level of data isolation», «No tenant level security» |

Формулировка «no tenant level security» для row-паттерна — это ровно то, что делает
проверку снаружи единственным доступным способом убедиться в изоляции: на уровне
хранилища гарантии нет вообще, вся она в коде запроса.

### 1.5 Как модель меняет поверхность утечки

**[не подтверждено — вывод автора]** Сводя вышеперечисленное:

| Модель | Где живёт граница | Как выглядит дефект | Видно ли по статусу |
|---|---|---|---|
| silo | сеть, IAM, отдельная БД | ошибка маршрутизации тенанта: запрос ушёл не в тот стек | да, обычно 200 на чужом контуре с чужими данными |
| bridge | смещается в общий слой | утечка ровно в тех сервисах, что в pool | зависит от сервиса |
| pool | предикат в запросе к БД | пропущенный фильтр по дискриминатору | **нет**: 200 в обоих случаях |

Последняя строка — причина существования скалярных сигналов над телом ответа
([ADR-0011](../adr/0011-response-body-signals.md)): отсутствующий фильтр по тенанту на
списочном эндпоинте не меняет код ответа, и никакой статус его не различит.

---

## 2. Иерархия контуров в B2B2C

Заявленная в задаче цепочка «платформа → партнёр → организация-клиент →
подразделение → конечный пользователь» в реальных API почти нигде не выражена
пятью уровнями. Выражены два-три, а остальное — вложенность внутри одного уровня.

### 2.1 Stripe Connect: контур в заголовке

Платформа обращается к API от имени подключённого аккаунта, подставляя
[заголовок `Stripe-Account`](https://docs.stripe.com/connect/authentication) с
идентификатором вида `acct_…` и **свой собственный** секретный ключ. Тот же эффект
подразумевается, если идентификатор аккаунта присутствует в URL.

Это форма, максимально удобная для внешней проверки: контур — один скаляр в заголовке,
учётные данные при этом не меняются. Подстановка чужого `acct_…` при своём ключе —
прямой тест на изоляцию.

[Типы подключённых аккаунтов](https://docs.stripe.com/connect/accounts) (Standard,
Express, Custom — Stripe помечает их как устаревшие в пользу controller properties)
различаются, в частности, доступом владельца к дашборду (полный / Express / никакого)
и тем, на кого падает ответственность за мошенничество и chargeback: на подключённый
аккаунт при direct charges, на платформу при destination charges. То есть глубина
видимости платформы в дела подключённого аккаунта — параметр конфигурации, а не
константа продукта.

### 2.2 AWS Organizations: потолок, а не грант

[Service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
ведут себя принципиально иначе:

> «SCPs do not grant permissions to the IAM users and IAM roles in your organization.
> No permissions are granted by an SCP. An SCP defines a permission guardrail, or sets
> limits, on the actions that the IAM users and IAM roles in your organization can
> perform.»

Наследование: «Any account has only those permissions permitted by *every* parent above
it». И отдельная асимметрия: SCP не действуют на management account.

Для внешней проверки это важно тем, что **отказ, полученный снаружи, не позволяет
установить его причину**: 403 из-за identity-политики, из-за SCP-потолка или из-за
permissions boundary выглядят одинаково. AWS сам указывает, что при наличии boundary и
SCP «the boundary, the SCP, and the identity-based policy must all allow the action».

### 2.3 Auth0 Organizations: контур в токене

[Auth0 Organizations](https://auth0.com/docs/manage-users/organizations/organizations-overview)
моделируют B2B-клиентов внутри одного тенанта Auth0; пользователь может состоять в
нескольких организациях, роли назначаются в пределах организации.

[Работа с токенами](https://auth0.com/docs/manage-users/organizations/using-tokens):
в ID- и access-токен попадает claim `org_id` (опционально ещё `org_name`), и требование
к API сформулировано прямо: «Your API servers must also segment access to data and
resources based on the `org_id`».

Тут контур зашит в подписанный токен, то есть снаружи не подменяется. Проверка
изоляции требует **двух комплектов учётных данных**, а не подстановки идентификатора.

### 2.4 Okta: контур как отдельный org

[Okta, multi-tenant solutions](https://developer.okta.com/docs/concepts/multi-tenancy/)
перечисляет четыре конфигурации: один org с Universal Directory и группами как
абстракцией тенанта; отдельные org на тенанта (hub-and-spoke); гибрид; один org без
Universal Directory. Мотивы для разделения org — резидентность данных, делегированное
администрирование и брендирование.

### 2.5 Salesforce: контур неявный, из владения записью

Salesforce — пример, где горизонтальной границы «тенант» в API нет вовсе, а есть
владение записями.
[Модель шаринга](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_bulk_sharing_understanding.htm):
администратор задаёт organization-wide default, а дальше доступ **добавляется** через
владение записью, иерархию ролей, sharing rules и ручной шаринг. Владелец получает Full
Access. Доступ по иерархии ролей «выводится в рантайме», а не хранится записями;
основная же часть шаринга «maintained in a related sharing object, similar to an access
control list (ACL)». При нескольких грантах применяется самый разрешающий.

Это фактически ReBAC (см. §4) и снаружи проверяется только перечислением пар
«аккаунт × запись».

### 2.6 Atlassian: организация как верхний контейнер

[Cloud Admin Vocabulary](https://developer.atlassian.com/cloud/admin/cloud-admin-vocabulary/):
организация — «the highest level of hierarchy and container for Atlassian sites and
products»; managed account — аккаунт с адресом из верифицированного домена. Управление
идёт через
[Organizations REST API](https://developer.atlassian.com/cloud/admin/organization/rest/).

### 2.7 Что общего в форме API-доступа

**[не подтверждено — обобщение автора по §2.1–2.6]** Контур переносится ровно четырьмя
способами, и от способа зависит, как его вообще можно проверить:

| Способ | Пример | Подменяется снаружи? | Что нужно для теста изоляции |
|---|---|---|---|
| Заголовок запроса | `Stripe-Account` | да | один аккаунт + чужой идентификатор |
| Путь/query | `/organizations/{id}/…` | да | один аккаунт + чужой идентификатор |
| Claim в подписанном токене | Auth0 `org_id` | нет | два комплекта учётных данных |
| Отдельный хост / IdP | Okta org-per-tenant | нет | два комплекта + два адреса |
| Неявно, из владения записью | Salesforce | — | перечисление пар «аккаунт × ресурс» |

Первые два случая проверяются в один аккаунт, остальные — только парой аккаунтов.
Модель ресурсов в [ADR-0010](../adr/0010-resources-and-tenancy.md) (`own`,
`same-tenant`, `foreign-tenant`) покрывает оба режима, потому что отношение считается
между аккаунтом и объявленным ресурсом, а не между аккаунтом и строкой URL.

---

## 3. Финтех: где именно проходит граница

### 3.1 BaaS и программные менеджеры

Регуляторная рамка — совместное руководство трёх ведомств
([Interagency Guidance on Third-Party Relationships: Risk Management](https://www.federalreserve.gov/supervisionreg/srletters/sr2304.htm),
июнь 2023; та же публикация как
[OCC Bulletin 2023-17](https://www.occ.gov/news-issuances/bulletins/2023/bulletin-2023-17.html)
и [FDIC FIL-29-2024](https://www.fdic.gov/news/financial-institution-letters/2023/fil23029.html)):
привлечение третьих лиц «does not diminish or remove a banking organization's
responsibility to perform all activities in a safe and sound manner».

Где проходит граница данных — виднее всего в
[предложении FDIC о требованиях к custodial deposit accounts with transactional
features](https://www.federalregister.gov/documents/2024/10/02/2024-22565/recordkeeping-for-custodial-accounts)
(RIN 3064-AG07,
[изложение FDIC](https://www.fdic.gov/news/financial-institution-letters/2024/requirements-custodial-deposit-accounts-transactional)):
финтех-компании «maintained the ledgers of their customers, including the deposit
amounts attributed to each individual customer», а банк держит омнибусный счёт.
Предлагаемое требование — банк должен вести записи, идентифицирующие бенефициарных
владельцев и остаток, приходящийся на каждого, со сверкой не реже чем на конец
операционного дня.

**[не подтверждено — вывод автора]** Отсюда следует форма контуров в BaaS-API:
банк → программа (program manager) → конечный клиент. Утечка «между программами» —
полный аналог cross-tenant: два разных финтеха на одном банковском API. Разделение
`same-tenant` и `foreign-tenant` тут не декоративное: у оператора программы обычно
законный доступ ко всем клиентам своей программы и никакого — к чужой.

### 3.2 PSP, payment facilitator, sub-merchant

[Visa Payment Facilitator and Marketplace Risk Guide](https://usa.visa.com/content/dam/VCOM/regional/na/us/partner-with-us/documents/visa-payment-facilitator-and-marketplace-risk-guide.pdf)
(апрель 2021, Visa Public) даёт роли явно:

- **acquirer** — клиент Visa, лицензированный предоставлять услуги приёма карт;
- **third party agent** — сущность, оказывающая платёжные услуги от имени клиента Visa,
  включая тех, кто «store, process, or transmit Visa transaction data»;
- **payment facilitator** (PayFac, merchant aggregator) — агент, который контрактуется с
  эквайером и, в свою очередь, заключает договоры со **sponsored merchants**;
- **marketplace** — агент, сводящий покупателей и retailers на одной площадке; именно
  маркетплейс, а не retailer, является «the merchant of record».

Денежный поток задаёт и поток данных: «An acquirer will deposit settlement funds
directly to the payment facilitator. The payment facilitator subsequently settles those
funds to its sponsored merchants». Ответственность — на эквайере: он «responsible for
all acts, omissions, and other adverse conditions caused by the payment facilitator and
its sponsored merchants».

**[не подтверждено — вывод автора]** Кто чьи транзакции видит: PayFac видит транзакции
всех своих sponsored merchants (иначе не смог бы их сеттлить); sponsored merchant не
должен видеть ничьи, кроме своих; эквайер видит агрегат по агенту. Граница, которую
имеет смысл проверять снаружи, — именно «sponsored merchant → чужой sponsored
merchant», и это pool-граница внутри одного PayFac.

Про PCI-периметр: PCI SSC отмечает, что вынос обработки наружу «does not remove the
merchant's responsibility to ensure account data is properly protected by the third
party» и требует письменных соглашений и ежегодного мониторинга статуса провайдера
([PCI SSC FAQ](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/)).

### 3.3 Реселлеры

Публичного нормативного описания реселлерских контуров, сопоставимого по качеству с
Visa-руководством, найти не удалось. Ближайшая проверяемая аналогия — модель платформы
и подключённых аккаунтов Stripe (§2.1), где глубина видимости платформы задаётся
конфигурацией аккаунта. **[не подтверждено]**

---

## 4. Модели контроля доступа и их внешняя проверяемость

### 4.1 Определения

**RBAC.** [NIST SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)
описывает RBAC как модель с предопределёнными ролями, несущими набор привилегий;
в момент запроса механизм «evaluates the role assigned to the subject requesting access
and the set of operations this role is authorized to perform on the object».

**ABAC.** Там же — определение: авторизация «determined by evaluating attributes
associated with the subject, object, requested operations, and, in some cases,
environment conditions against policy, rules, or relationships». И принципиальное
замечание: «ACLs and RBAC are in some ways special cases of ABAC in terms of the
attributes used. ACLs work on the attribute of "identity". RBAC works on the attribute
of "role". The key difference with ABAC is the concept of policies that express a
complex Boolean rule set that can evaluate many different attributes.»

Мотив перехода к ABAC у NIST — «role explosion»: попытка выразить многофакторные решения
в ролях «would require the creation of numerous roles that are ad hoc and limited in
membership».

**ReBAC.** Родословная — [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
(USENIX ATC '19): единая модель данных и язык конфигурации, отношения хранятся кортежами,
согласованность обеспечивается «zookies». Реализации:
[OpenFGA](https://openfga.dev/docs/authorization-concepts) и
[SpiceDB](https://authzed.com/docs/spicedb/concepts/schema), где схема задаёт типы
объектов, отношения между ними и вычисляемые из отношений permissions (объединение,
пересечение, исключение, стрелка).

OpenFGA формулирует различие компактно: ReBAC делает доступ условным относительно
отношений между пользователями и объектами и между объектами — «a user can view a
document if they have access to its parent folder»; RBAC же «fits flat, single-tenant
access models but breaks down with hierarchy, sharing, or multi-tenancy».

**PBAC.** Там же: политики вынесены из кода приложения наружу, и «most ABAC
implementations are also PBAC».

### 4.2 Что принципиально отличает ABAC и ReBAC от RBAC с точки зрения проверки

Различие не в выразительности, а в том, **от чего зависит решение** и, следовательно,
**воспроизводим ли эксперимент**.

**RBAC — функция от (субъект, роль, операция).** Область определения конечна и целиком
перечислима снаружи: аккаунтов столько-то, эндпоинтов столько-то. Повтор запроса даёт
тот же ответ. Матрица «роль × эндпоинт» — не эвристика, а полный перебор.

**ReBAC — функция от графа отношений.** Граф — это состояние проверяемой системы,
снаружи он не виден. Но у него есть свойство, спасающее проверяемость: он меняется
только явными действиями и между запросами стабилен. Значит ReBAC **проверяем при
условии, что набор отношений зафиксирован и объявлен**: «объект 1001 принадлежит
игроку A, 2002 — тенанту B». Ровно этот приём и выбран в
[ADR-0010](../adr/0010-resources-and-tenancy.md) — отношения объявляет человек, а не
выуживает инструмент. Цена — инструмент проверяет только объявленные рёбра графа.

**ABAC — функция от атрибутов, включая атрибуты окружения.** Вот это ломает
воспроизводимость по-настоящему. OWASP ASVS перечисляет такие атрибуты явно:
«time of day, user location, IP address, or device»
([ASVS 5.0, 8.1.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md)).
OpenFGA описывает механику подачи этих значений:
[contextual tuples и conditions](https://openfga.dev/docs/best-practices/modeling-abac)
— значения контекста «provide the context values at request time», источники — «the
current time, client IP address, or the user's current session context».

Следствие: **один и тот же HTTP-запрос с одним и тем же токеном может законно давать
разные ответы в разное время и с разных адресов.** Наблюдение «получил 200» перестаёт
быть утверждением о политике и становится утверждением о конкретном прогоне.

Самое сильное подтверждение непроверяемости ABAC — у самого NIST, раздел 3.1.2.3
«Need to Review Privilege and Monitor Authorizations»
([SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)):

> «there are some requirements to know what access each individual has before the
> requests are made. This is sometimes referred to as "before the fact audit". <…>
> An ABAC system may not lend itself well to conducting these audits efficiently. <…>
> Evaluating the set of subjects that have access to a given object requires a
> significant data retrieval and computation effort — possibly requiring every object
> owner to run a simulation of the access control request for every known subject in
> the enterprise.»

Инструмент вроде barbican делает ровно эту симуляцию, только эмпирически и снаружи.
NIST называет её дорогой изнутри системы; снаружи она дороже ещё на стоимость сети и
ограничена троттлингом.

### 4.3 Точка принятия решения как отдельная поверхность утечки

Отдельный сюжет, который стоит зафиксировать: PDP сам может течь между тенантами.
[AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/devops-isolation-privacy.html)
рекомендует не хранить данные ролевых сопоставлений внутри OPA и предупреждает, что в
модели одного общего multi-tenant policy store в Amazon Verified Permissions
«role mapping data should not reside within Verified Permissions to maintain tenant
isolation». Снаружи этот класс дефектов не виден вовсе — он не про ответ на запрос
данных, а про содержимое движка политик.

---

## 5. Segregation of Duties

### 5.1 Как это сформулировано в стандартах

**NIST SP 800-53 Rev. 5, AC-5 «Separation of Duties»** — управляющее воздействие
состоит из двух частей: «Identify and document [Assignment: organization-defined duties
of individuals]» и «Define system access authorizations to support separation of
duties». В обсуждении: разделение обязанностей адресует «the potential for abuse of
authorized privileges» и снижает риск злонамеренных действий **без сговора**; примеры —
разделение функций и запрет на то, чтобы администрирующий доступ персонал администрировал
ещё и аудит. Реализуется через AC-2, AC-3, IA-2/IA-4/IA-12.
([публикация](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final); текст сверен по
[зеркалу каталога](https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-5/), поскольку
машиночитаемый каталог NIST отдаётся только в PDF/OSCAL.)

**NIST SP 800-53 Rev. 5, AC-3(2) «Dual Authorization»** — прямая нормативная форма
принципа четырёх глаз: «Enforce dual authorization for [Assignment:
organization-defined privileged commands and/or other actions]», и в обсуждении
явно: «Dual authorization, also known as two-person control, reduces risk related to
insider threats»
([зеркало](https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-3/ac-3-2/)).

**PCI DSS v4.0.** Текст требований сверен по публичному
[SAQ D for Merchants v4.0](https://listings.pcisecuritystandards.org/documents/PCI-DSS-v4-0-SAQ-D-Merchant.pdf)
(апрель 2022), который воспроизводит формулировки требований дословно:

- **6.5.4** — «Roles and functions are separated between production and pre-production
  environments to provide accountability such that only reviewed and approved changes
  are deployed.» В applicability notes допускается замена процедурными контролями при
  малом штате — например, отдельные учётные записи под разные роли одного человека.
- **7.2.1** — определён access control model, включающий «the least privileges required
  (for example, user, administrator) to perform a job function».
- **7.2.2** — доступ назначается «based on: job classification and function; least
  privileges necessary to perform job responsibilities».
- **7.2.3** — «Required privileges are approved by authorized personnel.»
- **7.2.4** — пересмотр всех учётных записей и привилегий, включая учётные записи
  третьих сторон, не реже чем раз в шесть месяцев.

**ISO/IEC 27001:2022, Annex A 5.3 «Segregation of duties»** — контроль требует
разделять конфликтующие обязанности; там, где это невозможно (малые организации),
компенсируется мониторингом активности, журналами аудита и надзором руководства. Текст
самого стандарта платный; изложение взято из вторичного источника
([ISMS.online, разбор Annex A 5.3](https://www.isms.online/iso-27001/annex-a-2022/5-3-segregation-of-duties-2022/)).
**[первоисточник не проверен]**

**COSO.** Первоисточник платный. Публично доступный документ с той же структурой из
17 принципов — [GAO Green Book, GAO-14-704G](https://www.gao.gov/assets/gao-14-704g.pdf),
где Segregation of Duties — атрибут Принципа 10 «Design Control Activities»:

> «Management divides or segregates key duties and responsibilities among different
> people to reduce the risk of error, misuse, or fraud. This includes separating the
> responsibilities for authorizing transactions, processing and recording them,
> reviewing the transactions, and handling any related assets so that no one individual
> controls all key aspects of a transaction or event.» (рис. 6, с. 47)

Параграфы 10.12–10.14 добавляют: несовместимые обязанности разделяются, а где это
непрактично — проектируются альтернативные контроли; SoD адресует риск management
override, но «cannot absolutely prevent it because of the risk of collusion».
Соответствие Green Book именно COSO-редакции 2013 года по первоисточнику не сверялось.
**[не подтверждено]**

**SOC 2.** В AICPA Trust Services Criteria критерий CC5.1 соответствует принципу COSO 10
и несёт point of focus о разделении несовместимых обязанностей: management «segregates
incompatible duties, and where such segregation is not practical, management selects and
develops alternative control activities». Официальный PDF отдаётся только через форму
скачивания на aicpa-cima.com
([страница ресурса](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022)),
формулировка взята из вторичных источников. **[первоисточник не проверен]**

### 5.2 Как SoD выражается в API

Три ходовых названия одного и того же — maker-checker, two-person rule, принцип четырёх
глаз. Нормативная формулировка — AC-3(2) выше. Публичного стандарта, описывающего
**API-форму** этого паттерна (имена ресурсов, переходы состояний, коды ответов), найти
не удалось: находится только отраслевая публицистика. **[не подтверждено]**

**[вывод автора]** Наблюдаемая форма, тем не менее, одна и та же: действие расщепляется
на создание запроса и его утверждение, между ними объект живёт в состоянии `pending`, и
инвариант звучит как «утверждающий не равен создавшему».

### 5.3 Проверяемо ли SoD снаружи

Проверяемо, но при трёх условиях сразу, и все три конфликтуют с текущими инвариантами
инструмента:

1. **Нужны небезопасные методы.** Создание запроса и попытка его утвердить — это POST
   или PUT. По умолчанию выполняются только GET и HEAD (`SAFE_METHODS`), то есть SoD
   вне области без явного `--unsafe-methods`.
2. **Нужны два аккаунта и порядок между ними.** Проверка — не одна ячейка матрицы, а
   упорядоченная пара обращений: A создал, A пытается утвердить (ожидается отказ),
   B утверждает (ожидается успех). Матрица «аккаунт × эндпоинт × ресурс» такой порядок
   не выражает.
3. **Прогон меняет состояние проверяемой системы.** После теста в системе остаётся
   утверждённый или отклонённый объект. Это уже не разведка, а вмешательство.

Что проверяемо **без** нарушения инвариантов: только чтение — видит ли аккаунт очередь
запросов на утверждение, которая ему не положена. Это обычный BFLA, а не SoD.

---

## 6. Идентификаторы для маппинга находок

### 6.1 OWASP API Security Top 10 2023

[Полный список издания 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).
Релевантны три пункта:

| Идентификатор | Название | CWE по тексту OWASP |
|---|---|---|
| **API1:2023** | [Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) | CWE-285, CWE-639 |
| **API3:2023** | [Broken Object Property Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/) | CWE-213, CWE-915 |
| **API5:2023** | [Broken Function Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/) | CWE-285 |

Две формулировки OWASP имеют прямое отношение к устройству проверок:

- API1: «Attackers can exploit API endpoints that are vulnerable to broken object-level
  authorization by manipulating the ID of an object that is sent within the request.»
- API5: диагностические вопросы сформулированы как тесты — «Can a regular user access
  administrative endpoints?», «Can a user perform sensitive actions … by simply changing
  the HTTP method (e.g. from `GET` to `DELETE`)?», «Can a user from group X access a
  function that should be exposed only to users from group Y, by simply guessing the
  endpoint URL and parameters (e.g. `/api/v1/users/export_all`)?» И предупреждение:
  «Don't assume that an API endpoint is regular or administrative only based on the URL
  path.»

### 6.2 OWASP ASVS 5.0, раздел V8 Authorization

[Глава V8](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md).
Существенные для мультитенантности пункты:

| Пункт | Уровень | Требование (сокращённо) |
|---|---|---|
| 8.1.1 | L1 | документация определяет правила function-level и data-specific доступа |
| 8.1.3 | L3 | документированы атрибуты окружения и контекста, влияющие на решения |
| 8.2.1 | L1 | function-level доступ ограничен явными разрешениями |
| 8.2.2 | L1 | data-specific доступ ограничен явными разрешениями — против IDOR/BOLA |
| 8.2.3 | L2 | field-level доступ ограничен явными разрешениями — против BOPLA |
| 8.3.1 | L1 | правила применяются на доверенном серверном слое |
| 8.3.3 | L3 | доступ основан на правах исходного субъекта, а не посредника, действующего от его имени |
| **8.4.1** | **L2** | **«multi-tenant applications use cross-tenant controls to ensure consumer operations will never affect tenants with which they do not have permissions to interact»** |

8.4.1 — единственное известное требование в ASVS, формулирующее ровно то, что проверяет
инструмент. 8.1.1 стоит отметить отдельно: ASVS требует, чтобы правила были
**задокументированы** — это независимое подтверждение подхода
[ADR-0006](../adr/0006-expected-access-declaration.md), где ожидаемый доступ объявляет
человек.

8.3.3 важно для B2B2C: платформа, действующая от имени подключённого аккаунта (§2.1),
не должна расширять его права своими.

### 6.3 CWE

| CWE | Название | Уровень абстракции | Формулировка MITRE |
|---|---|---|---|
| [284](https://cwe.mitre.org/data/definitions/284.html) | Improper Access Control | Pillar | «does not restrict or incorrectly restricts access to a resource from an unauthorized actor» |
| [285](https://cwe.mitre.org/data/definitions/285.html) | Improper Authorization | Class | «does not perform or incorrectly performs an authorization check» |
| [862](https://cwe.mitre.org/data/definitions/862.html) | Missing Authorization | Class | «does not perform an authorization check» |
| [863](https://cwe.mitre.org/data/definitions/863.html) | Incorrect Authorization | Class | «performs an authorization check …, but it does not correctly perform the check» |
| [639](https://cwe.mitre.org/data/definitions/639.html) | Authorization Bypass Through User-Controlled Key | Base | «does not prevent one user from gaining access to another user's data or record by modifying the key value identifying the data» |

Иерархия: 284 → 285 → {862, 863}; 639 — дочерний к 863.

**[вывод автора]** Практическое следствие для маппинга: снаружи различить 862 и 863
невозможно. «Проверки нет» и «проверка есть, но неверна» дают идентичный ответ. Честный
маппинг для находки, полученной по одному коду ответа, — 285 (класс) либо 639 там, где
дефект воспроизведён именно подстановкой чужого идентификатора в параметр.

---

## 7. Что проверяемо чёрным ящиком по HTTP

Раздел отвечает на вопрос честно, то есть в обе стороны.

### 7.1 Сводка по моделям

| Модель / граница | Видно снаружи | По какому наблюдению | Что снаружи не видно принципиально |
|---|---|---|---|
| **RBAC**, роль × эндпоинт | да, полностью | код ответа: 2xx против 401/403 | какая именно роль/право сработали; имя права |
| **Иерархия контуров**, идентификатор в заголовке или пути | да | подстановка чужого идентификатора при своих учётных данных | принадлежит ли идентификатор существующему контуру |
| **Иерархия контуров**, идентификатор в подписанном токене | да, при двух комплектах учётных данных | сравнение ответов двух аккаунтов на один ресурс | содержимое claim'ов чужого токена |
| **BOLA / IDOR**, объект по идентификатору | да, если владелец объекта объявлен | 200 там, где объявлен отказ | объекты, о которых человек не заявил |
| **BFLA**, административная функция | да | 200 на административном адресе от неадминистративного аккаунта | является ли адрес административным (OWASP прямо предостерегает от вывода по пути URL) |
| **pool-дискриминатор**, пропущенный фильтр на списке | частично | **только** через скаляр над телом: размер выборки или необратимый дайджест; кода ответа не хватает — 200 в обоих случаях | сами утёкшие данные, их принадлежность, объём утечки в записях |
| **ReBAC** | да, в пределах объявленного графа | перебор пар «аккаунт × ресурс» | форма схемы, вычисляемые permissions, рёбра графа, которые человек не объявил |
| **ABAC** | нет, в общем случае | — | атрибуты окружения (время, IP, устройство, признаки сессии), которые подаются в PDP в момент запроса; результат невоспроизводим |
| **PBAC / потолок сверху** (SCP и аналоги) | нет | — | причина отказа: identity-политика, guardrail родителя или boundary дают один и тот же 403 |
| **BOPLA**, поля объекта | нет | — | какие поля отданы и какие приняты на запись; для этого нужно читать тело |
| **SoD / maker-checker** | нет в безопасном режиме | требует POST/PUT, пары аккаунтов и порядка обращений; меняет состояние системы | всё, кроме чтения очереди на утверждение (а это уже BFLA) |
| **Изоляция внутри PDP** (общий policy store) | нет | — | утечка ролевых сопоставлений между тенантами внутри движка политик |

### 7.2 Четыре честные оговорки

**Отказ не объясняет себя.** Все причины отказа выглядят как один код. Различить
«роль не та», «тенант чужой», «запрещено политикой родителя», «условие по времени не
выполнено» снаружи нельзя. Инструмент может утверждать только «доступ есть» или
«доступа нет», но не «почему».

**404 вместо 403 — рекомендуемая практика и одновременно слепое пятно.** Сокрытие
самого факта существования объекта делает неотличимыми «объекта нет» и «объект есть, но
не ваш». Наблюдение 404 на чужом ресурсе **не** является доказательством изоляции.
**[вывод автора]**

**Отсутствие находки не есть свидетельство изоляции.** Проверяется только то, что
объявлено: объявленные ресурсы, объявленные аккаунты, объявленные отношения
([ADR-0010](../adr/0010-resources-and-tenancy.md)). Это осознанное сужение, а не
временное ограничение. Утверждение отчёта — «на объявленном наборе расхождений нет»,
и оно не масштабируется до «утечек нет».

**Единичный прогон — утверждение о прогоне, а не о политике.** Для RBAC и ReBAC разница
несущественна: решение стабильно между запросами. Для ABAC она принципиальна, поскольку
контекст подаётся в момент запроса
([OpenFGA](https://openfga.dev/docs/best-practices/modeling-abac),
[ASVS 8.1.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md)),
и повторный прогон в другое время законно даст другой результат. Отчёт по системе с
ABAC обязан фиксировать время прогона и не выдавать наблюдение за утверждение о
политике.

### 7.3 Итог для инструмента

Внешняя проверка полностью покрывает RBAC и границы контуров, покрывает ReBAC в объёме
объявленного человеком графа, покрывает pool-изоляцию только через необратимые скаляры
над телом и не покрывает ABAC, PBAC-потолки, BOPLA и SoD.

Это не дефект метода. NIST в SP 800-162 описывает «before the fact audit» — вопрос
«кто к чему имеет доступ до того, как запрос сделан» — как то, что плохо даётся ABAC
даже изнутри системы, с полным доступом к атрибутам и политикам. Снаружи задача не
становится легче; она становится честнее в том смысле, что проверяется поведение, а не
намерение, заявленное конфигурацией.

---

## Источники

**Модели тенантности:**
[AWS SaaS Lens: Silo, Pool, and Bridge Models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html) ·
[AWS SaaS Lens: Tenant isolation](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-isolation.html) ·
[AWS: SaaS Tenant Isolation Strategies — Pool isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/pool-isolation.html) ·
[AWS: Identity and isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/identity-and-isolation.html) ·
[AWS SaaS Architecture Fundamentals: Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html) ·
[AWS Prescriptive Guidance: tenant isolation and privacy of data](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/devops-isolation-privacy.html) ·
[Azure: Tenancy models](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models) ·
[Azure: Storage and data approaches](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data) ·
[Google Cloud: multi-tenancy в Spanner](https://docs.cloud.google.com/spanner/docs/implement-multi-tenancy)

**Иерархия контуров:**
[Stripe Connect: authentication](https://docs.stripe.com/connect/authentication) ·
[Stripe Connect: account types](https://docs.stripe.com/connect/accounts) ·
[AWS Organizations: SCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html) ·
[Auth0 Organizations](https://auth0.com/docs/manage-users/organizations/organizations-overview) ·
[Auth0: tokens and organizations](https://auth0.com/docs/manage-users/organizations/using-tokens) ·
[Okta: multi-tenant solutions](https://developer.okta.com/docs/concepts/multi-tenancy/) ·
[Salesforce: understanding sharing](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_bulk_sharing_understanding.htm) ·
[Atlassian Cloud Admin Vocabulary](https://developer.atlassian.com/cloud/admin/cloud-admin-vocabulary/)

**Финтех:**
[Fed SR 23-4 / Interagency Guidance on Third-Party Relationships](https://www.federalreserve.gov/supervisionreg/srletters/sr2304.htm) ·
[OCC Bulletin 2023-17](https://www.occ.gov/news-issuances/bulletins/2023/bulletin-2023-17.html) ·
[FDIC: Recordkeeping for Custodial Accounts (NPR, RIN 3064-AG07)](https://www.federalregister.gov/documents/2024/10/02/2024-22565/recordkeeping-for-custodial-accounts) ·
[Visa Payment Facilitator and Marketplace Risk Guide (2021)](https://usa.visa.com/content/dam/VCOM/regional/na/us/partner-with-us/documents/visa-payment-facilitator-and-marketplace-risk-guide.pdf) ·
[PCI SSC FAQ: аутсорсинг обработки](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/)

**Модели доступа:**
[NIST SP 800-162 (ABAC)](https://csrc.nist.gov/pubs/sp/800/162/upd2/final) ·
[Zanzibar, USENIX ATC '19](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) ·
[OpenFGA: authorization concepts](https://openfga.dev/docs/authorization-concepts) ·
[OpenFGA: modeling ABAC](https://openfga.dev/docs/best-practices/modeling-abac) ·
[SpiceDB: schema](https://authzed.com/docs/spicedb/concepts/schema)

**Segregation of Duties:**
[NIST SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) ·
[PCI DSS v4.0 SAQ D for Merchants](https://listings.pcisecuritystandards.org/documents/PCI-DSS-v4-0-SAQ-D-Merchant.pdf) ·
[GAO Green Book (GAO-14-704G)](https://www.gao.gov/assets/gao-14-704g.pdf) ·
[AICPA Trust Services Criteria (страница ресурса)](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022) ·
[ISO/IEC 27001:2022 Annex A 5.3 — вторичный источник](https://www.isms.online/iso-27001/annex-a-2022/5-3-segregation-of-duties-2022/)

**Стандарты для маппинга:**
[OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) ·
[OWASP ASVS 5.0, V8 Authorization](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md) ·
[CWE-284](https://cwe.mitre.org/data/definitions/284.html) ·
[CWE-285](https://cwe.mitre.org/data/definitions/285.html) ·
[CWE-639](https://cwe.mitre.org/data/definitions/639.html) ·
[CWE-862](https://cwe.mitre.org/data/definitions/862.html) ·
[CWE-863](https://cwe.mitre.org/data/definitions/863.html)

Все источники прочитаны 2026-08-12.
