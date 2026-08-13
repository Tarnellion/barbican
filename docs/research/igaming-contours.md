# Контуры доступа в мультибрендовых iGaming-платформах

- **Статус:** исследование по публичным источникам, не решение
- **Дата:** 2026-08-12

## Зачем

У `barbican` одна ось тенанта: `Account.tenantId`, `Resource.tenantId` и трёхзначное
отношение `own | same-tenant | foreign-tenant` (ADR-0010). Модель принималась без
привязки к конкретной предметной области. Этот документ проверяет, сколько контуров
изоляции в мультибрендовом iGaming на самом деле и что из них в одну ось не влезает.

Практический выход — раздел [«Что из этого проверяемо по HTTP-ответам»](#что-из-этого-проверяемо-по-http-ответам):
какие описанные дефекты инструмент в принципе способен увидеть, а какие нет и почему.

## Об источниках

Использованы только публичные материалы. Они трёх разных сортов, и смешивать их
нельзя:

1. **Регуляторные документы и стандарты** (MGA, UKGC, GLI, N.J.A.C., GDPR) — говорят,
   что *обязано* быть. Самый твёрдый сорт.
2. **Публичная техническая документация интеграций** (Hub88, Praxis, Sumsub,
   TheAffiliatePlatform) — говорит, как устроен *интерфейс между контурами*. Твёрдо
   описывает формат и обязанности сторон; ничего не говорит о том, как это
   реализовано у конкретного оператора.
3. **Маркетинговые материалы вендоров платформ** — годятся только как свидетельство
   о том, что продаётся под словом «мультитенантность». Помечены явно.

Где утверждение не подтверждается источником, оно помечено как наблюдение общего
характера. Внутренние источники работодателя не использовались — ни как источник
фактов, ни как источник примеров.

---

## 1. Контуры

### 1.1 Что подтверждается регулированием

Регулятор режет отрасль не по тому же шву, что архитектор. Ключевое разделение —
между тем, кто **держит лицензию и отвечает перед игроком**, и тем, кто **поставляет
софт**.

Мальта выдаёт два разных типа авторизации: B2C и B2B. B2B — это «critical gaming
supply», лицензия на поставку и управление софтом, «to generate, capture, control or
otherwise process any essential regulatory record»
([MGA, B2B licences](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/)).
То есть платформа (PAM, back office) и поставщик игр лицензируются отдельно от
оператора, который принимает ставки от игрока.

Британия описывает мультибрендовость прямо и называет её white label: лицензиат
предоставляет гемблинг под брендом третьей стороны, и «responsibility for compliance
will always sit with the licence holder»
([UKGC, Compliance and enforcement report 2019–20, White label partnerships](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)).
Из того же документа — перечень того, что у лицензиатов ломалось: передача
ответственности партнёрам без надзора, отсутствие «live access to customer records»,
неспособность отслеживать поведение игрока across all partners и обнаруживать
«multiple accounts across all white label domains». Регулятор требует «a holistic
view of customer activity» вместо подомённого.

Это важнее, чем кажется: **владелец бренда в UK-модели вообще не лицензирован**, у него
нет собственного регуляторного статуса, и весь его доступ к данным игрока — это
делегирование от лицензиата.

GLI-19, стандарт на interactive gaming systems, замечает мультибрендовость только
в одном месте — при тестировании: «where testing is requested for a "white-label"
version of the system, a specific configuration will be tested and reported»
([GLI-19 v3.0, §1.5.2](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)).
Требований к изоляции *между брендами* в стандарте нет: он весь про один экземпляр
системы. Это первый разрыв между отраслевым стандартом и реальной архитектурой.

### 1.2 Разбивка контуров и что в ней уточняется

| Контур | Кто это | Подтверждение |
|---|---|---|
| Поставщик платформы (PAM) | держатель счетов игроков, кошелёк, back office | [MGA B2B](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/), [GLI-19 §2.5](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf) |
| Агрегатор игр / поставщик контента | вызывает кошелёк оператора, не хранит счёт | [Hub88 Wallet API](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api) |
| Платёжный шлюз | шлёт нотификации о пополнении/выводе | [Praxis Cashier, notification](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification) |
| KYC-провайдер | хранит документы, шлёт вебхуки о статусе | [Sumsub, Webhook manager](https://docs.sumsub.com/docs/webhook-manager) |
| Лицензиат (оператор) | отвечает за всё вышеперечисленное перед регулятором | [UKGC white label](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships) |
| Бренд / skin / white label partner | торговая марка и домен, регуляторного статуса может не иметь | там же |
| Аффилиат | приводит трафик, видит отчёт по «своим» игрокам | [TheAffiliatePlatform, Affiliate Account](https://help.theaffiliateplatform.com/affiliate-platform/affiliate-account) |
| Игрок | свой счёт, своя история | [GLI-19 §2.5.2, §A.3](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf) |

Уточнения к исходной разбивке:

**«Платформа/софт-провайдер» — это два разных контура, а не один.** PAM держит счета,
балансы и PII; агрегатор игр не держит ничего, он вызывает чужой кошелёк. У них
противоположное направление вызова и, следовательно, противоположная модель доверия
(см. §3.2). Объединять их в один контур — значит потерять именно ту границу, через
которую идут деньги.

**Агрегатор и платёжный шлюз в один контур тоже не складываются.** Агрегатор — консьюмер
API оператора (`POST /transaction/bet` реализует оператор), платёжный шлюз —
наоборот, отправитель нотификаций в сторону оператора. Общее у них только то, что оба
приходят снаружи без пользовательской сессии.

**«Холдинг/группа брендов» — не регуляторная сущность.** Лицензия выдаётся юрлицу;
группа может держать несколько лицензий, и регулятор их не сливает. Показательно
дело William Hill (2023): рекордный пакет в £19,2 млн разложен по трём лицензиатам
группы отдельно — WHG (International) £12,5 млн, Mr Green £3,7 млн, William Hill
Organization £3 млн
([UKGC](https://www.gamblingcommission.gov.uk/news/article/william-hill-group-businesses-to-pay-record-gbp19-2m-for-failures)).
Групповой контур существует в отчётности и в BI, но не как субъект права. Любой
доступ группы к данным игроков конкретного лицензиата — это передача данных между
контроллерами, а не «просмотр своего» (см. §4).

**Чего в разбивке нет, а в источниках есть:**

- **Юрисдикционный контур.** Одна и та же марка под разными лицензиями — это разные
  контуры с несовместимыми требованиями. Нью-Джерси: «all servers utilized for
  internet gaming … shall be located in Atlantic City», в restricted area
  ([N.J.A.C. 13:69O-1.2](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-2),
  [текст главы 69O](https://www.nj.gov/oag/ge/docs/Regulations/CHAPTER69O.pdf)).
  Мальта требует критические компоненты в Мальте/ЕЭЗ либо в юрисдикции, признанной
  Authority, плюс живую реплику регуляторных данных в Мальте
  ([MGA, Technical Infrastructure](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)).
  Это ось изоляции, ортогональная бренду: два бренда одной юрисдикции могут делить
  инфраструктуру, один бренд в двух юрисдикциях — нет.
- **Регулятор как контур доступа.** MGA требует «immediate and unhindered access» к
  реплике для инспекций, физически и электронно (там же). У регулятора есть свой
  уровень доступа к продуктивным данным — это не абстракция, а учётная запись.
- **Агентские сети.** Многоуровневые деревья агент → субагент → игрок с комиссиями по
  уровням — стандартный продукт у вендоров платформ
  ([PartnerMatrix, Agent Management System](https://partnermatrix.com/agent-system/),
  вендорский материал). Это контур с рекурсивной вложенностью, которого нет ни у
  брендов, ни у аффилиатов.
- **Curaçao: домен как объект регулирования.** После LOK домены управляются через
  портал CGA или через его API, а печать и сертификат привязаны к конкретному
  авторизованному домену, с публичной проверкой вида `https://cert.cga.cw/certificate?id=DOMAIN_TOKEN`
  ([CGA License Management Portal](https://portal.gamingcontrolcuracao.org/)).
  Отображение «бренд → лицензия» здесь публично по замыслу — это, кстати, готовый
  внешний источник для оракула, независимый от проверяемой системы.

### 1.3 Терминология

«Skin», «brand», «white label» и «turnkey» в отраслевых текстах взаимозаменяемы и
означают разное по существу: у white label лицензия остаётся у провайдера, у turnkey
оператор получает свою (различие описано в вендорских обзорах, напр.
[SOFTSWISS](https://www.softswiss.com/knowledge-base/what-is-white-label-solution/),
маркетинговый материал). Для модели доступа существенно одно: **совпадает ли граница
бренда с границей лицензии**. Если нет — граница данных проходит по лицензиату, а
бренд остаётся лишь ярлыком в запросе.

Слово «оператор» перегружено: у регулятора это лицензиат, в интеграционных API это
сторона, реализующая кошелёк (`operator_id` у Hub88 — идентификатор интеграции,
а не юрлица). Это не педантизм: если `operator_id` выдаётся на бренд, а лицензия одна
на все бренды, то у двух «операторов» в терминах агрегатора один владелец данных —
и наоборот.

---

## 2. Изоляция между брендами

### 2.1 Модели

Отраслевой словарь здесь не гемблинговый, а общий SaaS-овый: silo (стек на тенанта),
pool (общие ресурсы, изоляция политиками), bridge (смесь). Существенны две вещи,
сформулированные в AWS SaaS-документации точнее, чем в любом гемблинговом стандарте:

> Authentication and authorization are not equal to isolation … a user could be
> authenticated and authorized, and still access the resources of another tenant.

> Isolation enforcement should not be left to service developers — … it's unrealistic
> to expect that they will never unintentionally cross a tenant boundary.

([AWS, The isolation mindset](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-isolation-mindset.html),
[AWS, Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)).

Это ровно тот тезис, ради которого существует `barbican`: RBAC и изоляция — разные
свойства, и матрица «роль × эндпоинт» без третьего измерения проверяет только первое.

Гемблинговое регулирование к теме подходит лишь с одной стороны — инфраструктурной.
MGA: архитектура считается удовлетворяющей принципам, «when the critical components
are hosted on a private cloud environment which is not shared with other tenants on
the same cloud»; virtual private cloud допускается по результатам оценки рисков.
В приложении к тому же документу перечислены риски, среди которых прямым текстом
«isolation failure» и «malicious activities by other tenant(s) of the cloud»
([MGA, Technical Infrastructure](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)).
Критическими компонентами MGA называет, среди прочего, player database servers,
financial database servers и gaming database servers — то есть именно те хранилища,
где живёт межбрендовая граница.

Обратите внимание на асимметрию: регулятор нормирует изоляцию **платформы от чужих
арендаторов облака** и молчит про изоляцию **бренда от бренда внутри платформы**.
Второе — целиком на совести оператора и его поставщика.

### 2.2 Как это выглядит в запросе

Публично документированы три способа идентификации бренда, и все три встречаются
в интеграционных API:

- **Явный идентификатор в теле или параметрах.** `operator_id` у агрегатора игр
  ([Hub88](https://docs.hub88.io/developer-docs/operator-api-reference/getting-started));
  `merchant_id` («Merchant API client account identifier») плюс `application_key`
  («Identifier of your application (website)») у платёжного шлюза
  ([Praxis](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification)).
  Показательно, что у Praxis идентификатор **сайта** отделён от идентификатора
  мерчанта: бренд там первоклассная сущность, отдельная от юрлица.
- **Домен/поддомен.** У Curaçao домен — регулируемая сущность, привязанная к
  сертификату ([CGA portal](https://portal.gamingcontrolcuracao.org/)); у UKGC
  надзор явно требует не ограничиваться подомённым взглядом
  ([white label partnerships](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)).
  Значит, домен маршрутизирует и одновременно несёт смысл контура.
- **Наследование от учётной записи.** Игрок принадлежит бренду по факту регистрации;
  GLI-19 требует «A player shall only be permitted to have one active player account
  at a time unless specifically authorized by the regulatory body»
  ([GLI-19 v3.0, §2.5.2](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)),
  но это про один экземпляр системы: в мультибрендовой платформе один человек
  штатно имеет по счёту на бренд.

Отсюда типовой дефект, вытекающий из конструкции: **бренд берётся из запроса, а
не из учётных данных.** Если `brand_id` — параметр, то надёжность изоляции равна
надёжности проверки «этот `brand_id` тот же, что у токена», выполняемой в каждом
обработчике. Это ровно тот случай, о котором AWS пишет «should not be left to service
developers». Прямого публичного разбора такого дефекта именно в iGaming я не нашёл
(см. §5), поэтому здесь это следствие из общих источников, а не документированный
инцидент.

### 2.3 Где ломается: свидетельства

Публичное свидетельство того, что pool-модель применяется к брендам, есть, и
неприятное: в январе 2019 исследователь Justin Paine обнаружил открытый ElasticSearch
примерно со 108 млн записей о ставках, депозитах и выводах, с именами, адресами и
телефонами; среди доменов в данных — `kahunacasino.com`, `azur-casino.com`,
`easybet.com`, `viproomcasino.net`, принадлежавшие одной группе
([Security Affairs](https://securityaffairs.com/80173/data-breach/online-casinos-data-leak.html);
первоисточник — заметка Catalin Cimpanu в ZDNet). Несколько брендов, один индекс,
одна дырка. Само по себе это не дефект контроля доступа в API, но это прямое
доказательство того, что данные брендов лежат вместе, — а значит, единственное, что
их разделяет, это код.

Второй, более редкий класс: **изоляция там, где её быть не должно**. В 2017 UKGC
оштрафовала 888 на £7,8 млн; в формулировке комиссии — «over 7,000 customers who had
chosen to self-exclude from their casino/poker/sport platform were still able to
access their accounts on their bingo platform», из-за технической неисправности,
не замеченной 13 месяцев
([UKGC](https://www.gamblingcommission.gov.uk/news/article/gambling-firm-888-to-pay-over-gbp7-8million-for-failing-vulnerable-customers)).
Продуктовые силосы не обменивались состоянием самоисключения.

Это делает предметную область принципиально сложнее обычного SaaS: **граница
ограничена с обеих сторон**. PII и коммерческие данные не должны течь между брендами;
статус самоисключения, лимиты и признаки множественных аккаунтов — обязаны. LCCP
требует от лицензиата процедур самоисключения и удаления из маркетинговых баз,
используемых «by the company or group»
([LCCP 3.5.3](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-3-remote-sr-code)),
а сверх того существует межоператорское самоисключение GAMSTOP
([LCCP 3.5.5](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-5-remote-multi-operator-sr-code)).

Проектная ошибка здесь возможна в обе стороны, и вторая наказывается штрафом так же,
как первая.

---

## 3. Специфика домена

### 3.1 Аффилиатские кабинеты

Аффилиат — внешнее лицо с доступом к отчётам о **чужих** игроках, приведённых им.
Модель вознаграждения (CPA, RevShare, гибрид) определяет, какие поля ему нужны:
RevShare требует показывать NGR и, значит, проигрыши игрока.

Что кабинет реально показывает — видно из публичной документации. Отчёт по
регистрациям в TheAffiliatePlatform содержит «External user ID, TAP user ID +
Registration Date + Brand + Username (if sent to TAP by the platform) + Affiliate»,
и прямо сказано: «The fields available to the affiliate in the registration report
are controlled by the "additional permissions" list in the Affiliate Account»
([TAP, Reporting interfaces / BI](https://help.theaffiliateplatform.com/reporting/reporting-interfaces-bi.md),
[TAP, Affiliate Account](https://help.theaffiliateplatform.com/affiliate-platform/affiliate-account)).
Аналогично у Affilka: аффилиат видит только те поля, фильтры и группировки, которые
ему открыли настройками видимости отчётов
([Affilka, Features](https://affilka.com/features/), вендорский материал).

Три следствия, каждое — потенциальный дефект:

1. **Видимость полей — это флаги, а не роль.** Набор колонок определяется списком
   разрешений на конкретном аффилиатском аккаунте. Это буквально authorization на
   уровне свойства объекта, то есть
   [API3:2023 Broken Object Property Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/)
   по конструкции. Ошибка в одном флаге не меняет статус ответа — она добавляет
   колонку.
2. **`Brand` присутствует в отчёте аффилиата.** Аффилиат обычно работает с несколькими
   брендами одной программы, и граница «его бренды» проходит внутри отчётной ручки,
   а не по URL.
3. **`Username` попадает наружу, если платформа его отдала.** Формулировка «if sent
   to TAP by the platform» означает, что объём PII у аффилиата определяется настройкой
   выгрузки на стороне оператора. GLI-19 на этот счёт категоричен: «Unauthorized
   third-party service providers shall be prevented from viewing or altering PII and
   other sensitive information», а при передаче PII третьим лицам требуются формальные
   data processing agreements
   ([GLI-19 v3.0, §B.5.3](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)).

Чего аффилиат не должен видеть — из источников прямо не следует построчно; общая
рамка это GDPR (минимизация) и §B.5.3 GLI-19. Утверждение «аффилиату не положены
паспортные данные, платёжные реквизиты и переписка с поддержкой» — наблюдение общего
характера, отдельным документом не подтверждено.

### 3.2 Провайдеры игр и seamless wallet

Направление вызова здесь обратное привычному, и это меняет всё. При seamless-модели
**оператор реализует эндпоинты, а агрегатор их вызывает**: `/user/info`,
`/user/balance`, `/transaction/bet`, `/transaction/win`, `/transaction/rollback`
([Hub88, Wallet API](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api)).

Как это аутентифицируется: «RSA-SHA256 is used to sign the request body using the
private key. The signature is validated using the public key associated with the
provided `operator_id`», подпись передаётся в `X-Hub88-Signature` и проверяется по
сырому телу, без десериализации
([Hub88](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api)).

Три особенности, критичные для модели доступа:

- **Пользовательской сессии нет.** В запросе есть `user` («The unique User ID in the
  Operator's system») и `token` («The game session token that was passed within
  `/game/url` endpoint response»). То есть игрок идентифицируется идентификатором из
  системы оператора, а его право на действие — токеном игровой сессии, который
  оператор сам же и выдал. Документация явно вменяет оператору проверку валидности
  токена и идемпотентности по `transaction_uuid`.
- **Связка «токен ↔ игрок ↔ бренд» — обязанность оператора, и она не выражена в
  протоколе.** Если оператор списывает по `user` из тела, не сверяя его с владельцем
  `token`, получается BOLA с последствиями в деньгах. Это следует из структуры API;
  публично задокументированного случая такой ошибки я не нашёл.
- **Отказ дорого стоит.** При отсутствии 200 в течение таймаута транзакция считается
  неуспешной и генерируется rollback (там же). Ошибка авторизации, отвечающая
  неправильным кодом, превращается в финансовое расхождение, а не в 403 в логе.

Второй режим — transfer wallet, когда баланс переносится к провайдеру и обратно
([Hub88, TransferWallet API](https://docs.hub88.io/developer-docs/operator-api-reference/transferwallet-api)):
контур тот же, но состояние временно живёт на чужой стороне.

### 3.3 Платёжные колбэки

Устроены так же — входящий вызов без сессии, доверие на подписи. У Praxis
нотификация несёт `merchant_id`, `application_key`, `pin` («Unique customer id in your
system»), `trace_id`, `transaction_id`, `order_id`, статус и подпись; мерчанту
предписано сверять подпись, дождаться финального статуса, проверять `charge_amount`
и `charge_currency` (а не запрошенную сумму), сопоставлять `order_id` со своей
записью и учитывать окно валидности
([Praxis, notification](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification);
актуальная документация переехала на [docs.praxis.tech](https://docs.praxis.tech/)).

Здесь важно, что **бренд идентифицируется полем в подписанном теле**. Значит,
изоляция между брендами на этом контуре держится на том, что ключ подписи привязан
к мерчанту и что обработчик не берёт `application_key` как есть.

### 3.4 KYC-провайдеры

Тот же паттерн, максимальная чувствительность данных. Sumsub подписывает вебхуки
HMAC с секретом на вебхук; алгоритм передаётся в `X-Payload-Digest-Alg` (по умолчанию
`HMAC_SHA256_HEX`), а получатель сверяет `x-payload-digest` с посчитанным дайджестом
([Sumsub, Webhook manager](https://docs.sumsub.com/docs/webhook-manager)).

Особенность контура: документы игрока физически хранятся у процессора, а у оператора
остаётся статус и идентификатор заявителя. Это хорошо для изоляции (PII не
размазывается по брендам) и плохо для аудита: доступ сотрудников бренда к документам
идёт через консоль провайдера, то есть **за пределами** матрицы доступа платформы —
и, соответственно, за пределами любой проверки, которая ходит по API оператора.

### 3.5 Общее у трёх контуров

Провайдер игр, платёжный шлюз и KYC приходят снаружи, без пользователя, POST-ом,
с подписью, и их вызовы меняют состояние. Это отдельный класс поверхности, к которому
модель «аккаунт с ролью и тенантом» неприменима в принципе: там нет аккаунта, есть
ключ. Для инструмента, работающего от имени аккаунтов и по умолчанию только GET/HEAD,
этот класс лежит вне области — и должен там оставаться (см. §6).

---

## 4. Регуляторика и доступ к PII между уровнями

### 4.1 Требования, которые подтверждаются

- **Мальта.** Критические компоненты — RNG, jackpot, player/financial/gaming database
  servers — размещаются в Мальте, ЕЭЗ или признанной третьей юрисдикции; уровень
  информационной безопасности — ISO/IEC 27001, для платёжных данных PCI DSS Level 1;
  требуется живая реплика регуляторных данных в Мальте с процедурой немедленного
  доступа инспекторов. «Player Data» определяется предельно широко: «Any data which
  contributes or may contribute to the identification of a player»
  ([MGA, Technical Infrastructure](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)).
- **Британия.** Требования безопасности RTS — подмножество Annex A ISO/IEC 27001:2022,
  и перечень контролей назван поимённо: 5.15 Access control, 5.16 Identity management,
  5.17 Authentication information, 5.18 Access rights, 8.2 Privileged access rights,
  8.15 Logging, 8.22 Segregation of networks, 8.24 Use of cryptography
  ([UKGC, RTS section 4](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/4-remote-gambling-and-software-technical-standards-rts-security-requirements)).
  Это, пожалуй, самая полезная зацепка для будущего модуля 2: перечень пунктов, на
  которые можно отображать проверки.
- **GLI-19.** Логический контроль доступа (§B.2.3), политика доступа с принципом
  наименьших привилегий и формальной регистрацией/дерегистрацией пользователей
  (§C.2.3), запрет изменения учётных данных без supervised access controls
  с логированием прежнего и нового значения (§B.3.2), запрет неавторизованным
  третьим лицам видеть или менять PII (§B.5.3), обязательная регистрация значимых
  событий по счёту игрока — корректировки баланса, «changes made to PII and other
  sensitive information recorded in a player account», деактивация счёта (§2.8.8).
  Отдельным приложением идёт
  операционный аудит поставщиков услуг
  ([GLI-19 v3.0](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)).
- **Нью-Джерси.** Серверы в Атлантик-Сити, в restricted area
  ([N.J.A.C. 13:69O-1.2](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-2)).

### 4.2 Чего в источниках нет

**Я не нашёл гемблингового регулятора, который бы прямо предписывал: «холдинг видит
агрегат, но не PII конкретного бренда».** Формулировка правдоподобна и, вероятно,
описывает распространённую практику, но подтверждения регуляторным документом у меня
нет. Ограничение приходит с другой стороны — из защиты данных:

- У группы компаний нет привилегии доступа. GDPR лишь признаёт, что контроллеры
  внутри группы «may have a legitimate interest in transmitting personal data within
  the group of undertakings for internal administrative purposes»
  ([Recital 48](https://gdpr-info.eu/recitals/no-48/)) — это основание, которое нужно
  обосновывать и балансировать, а не разрешение по умолчанию.
- Насколько это не формальность, видно по проекту межоператорского обмена данными
  о вреде (single customer view / GamProtect): участники выбирали правовое основание
  «законный интерес» и проходили отдельное согласование с ICO, прежде чем начать
  обмен ([iGaming Business](https://igamingbusiness.com/sustainable-gambling/ico-greenlights-financial-data-sharing-with-operators/),
  [NEXT.io](https://next.io/news/technology/ico-approves-data-sharing-for-gambling/) —
  отраслевая пресса, не первоисточник). Если сквозной обмен требует такой процедуры
  между операторами, то и внутри группы он не бесплатен.
- Что регулятор данных наказывает за нецелевые потоки, показывает выговор ICO в адрес
  Sky Betting and Gaming (сентябрь 2024): рекламные cookie ставились до получения
  согласия, и персональные данные уходили третьим лицам без законного основания
  ([ICO](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2024/09/action-taken-against-sky-betting-and-gaming-for-using-cookies-without-consent/)).

**Итого расстановка сил:** UKGC требует от лицензиата сквозного взгляда на игрока по
всем его white label доменам; защита данных требует не расширять этот взгляд за
пределы лицензиата без основания. Проектная граница проходит между **лицензиатом**
и **группой**, а не между брендами. Разбивка, где холдинг стоит уровнем выше
оператора и «видит агрегат», — разумная реализация этого, но не требование
регулятора.

---

## 5. Публичные классы уязвимостей и инциденты

### 5.1 Классы

Специализированной таксономии для iGaming нет; всё описываемое — это
[OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
в конкретных декорациях:

| Класс | Как выглядит в мультибрендовой платформе |
|---|---|
| [API1:2023 BOLA](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) | подмена `brand_id`/`operator_id`/`player_id` в пути или query отчётной ручки |
| [API3:2023 BOPLA](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/) | лишние колонки в аффилиатском отчёте; PII в выгрузке, где нужны только суммы |
| [API5:2023 BFLA](https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/) | аффилиатский аккаунт достаёт до административной ручки бренда |

BOLA в формулировке OWASP описывает ровно интересующий случай: доступ к самой ручке
у пользователя есть по замыслу, а нарушение происходит на уровне объекта —
манипуляцией идентификатором.

### 5.2 Инциденты, подтверждённые публично

- **Группа брендов, один открытый индекс (январь 2019).** ~108 млн записей о ставках
  и транзакциях с ФИО, адресами и телефонами; в данных фигурируют домены нескольких
  казино одной группы
  ([Security Affairs](https://securityaffairs.com/80173/data-breach/online-casinos-data-leak.html)).
- **Бэкенд мобильного приложения казино без пароля (февраль 2024).** База с именами,
  телефонами, адресами электронной почты и домашними адресами клиентов была доступна
  из интернета без аутентификации
  ([TechCrunch](https://techcrunch.com/2024/02/09/winstar-hotel-casino-app-exposed-customer-personal-data/)).
- **Компрометация поставщика платформы (март 2020).** Ransomware у SBTech: компания
  «immediately shut down its data centers», сервисы её клиентов-операторов были
  прерваны; в рамках сделки с DEAC был создан эскроу на $30 млн под последствия
  ([BleepingComputer, по документу SEC](https://www.bleepingcomputer.com/news/security/draftkings-discloses-sbtech-ransomware-attack-in-sec-filing/)).
  Это не дефект контроля доступа, но точная иллюстрация радиуса поражения контура
  платформы: один инцидент — недоступность у всех брендов сразу.
- **Инцидент у B2B-поставщика (август 2025).** Bragg Gaming Group сообщила о вторжении
  во внутренние ИТ-системы, заявив, что игровые сервисы не пострадали и PII, по данным
  ранней экспертизы, не затронуты
  ([The Register](https://www.theregister.com/2025/08/19/bragg_attack/)).
- **Изоляция вместо связности (август 2017).** 888: самоисключение не распространилось
  с casino/poker/sport на bingo, 7 000+ игроков сохранили доступ, штраф £7,8 млн
  ([UKGC](https://www.gamblingcommission.gov.uk/news/article/gambling-firm-888-to-pay-over-gbp7-8million-for-failing-vulnerable-customers)).
- **Надзорные находки по white label (2019–20).** Отсутствие живого доступа к записям
  клиентов и неспособность обнаруживать множественные аккаунты по всем white label
  доменам — публично зафиксированный дефект именно межбрендовой видимости
  ([UKGC](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)).

### 5.3 Чего найти не удалось

Честный отрицательный результат, потому что он определяет доверие к остальному:

- **Публичного разбора BOLA по `brand_id` в iGaming-платформе — нет.** Ни в
  disclosed-отчётах HackerOne, ни в CVE, ни в исследовательских публикациях по этим
  запросам ничего не нашлось. Класс реален (OWASP), домен уязвим по конструкции
  (§2.2), но конкретного публичного случая у меня нет.
- **Публично задокументированной эскалации «аффилиат → оператор» — нет.** Ни одного
  случая. Уязвимости в аффилиатских продуктах общего назначения (не iGaming) в CVE
  есть — например, обход аутентификации с захватом учётной записи и повышением прав
  в WordPress-плагине аффилиатской программы
  ([CVE-2024-9289](https://wpscan.com/vulnerability/20327eff-4132-4159-a96b-a2edab0f3776/)) —
  но переносить это на iGaming-кабинеты как факт нельзя.
- **Утечек через отчётные ручки как классифицированного инцидента — не нашёл.**
  Известные утечки в отрасли — это открытые хранилища, а не сломанная авторизация
  в API. Возможно, дело в наблюдаемости: открытый ElasticSearch находит сканер, а
  BOLA в приватном кабинете — только тот, у кого есть учётная запись.

---

## Что из этого проверяемо по HTTP-ответам

Здесь и далее «инструмент» — `barbican` в его нынешней модели: аккаунты с ролью и
тенантом, ресурсы с объявленным владельцем и тенантом (ADR-0010), наблюдение =
статус + отфильтрованные заголовки + необратимые скаляры над телом (`digest`,
`count`, `present` — ADR-0011), по умолчанию только GET и HEAD.

### Видно

| Дефект | Чем виден |
|---|---|
| Кабинет бренда A читает объект бренда B по идентификатору в пути или query | статус: `foreign-tenant` + `allowed` вместо `denied`; классический BOLA |
| Аффилиатский аккаунт достаёт до административной ручки бренда (BFLA) | статус: правило политики `roles: [affiliate] → denied`, наблюдён 200 |
| Отчётная ручка доступна без аутентификации | статус: анонимный аккаунт (`tokenEnv` необязателен, ADR-0010) |
| Списочная ручка не фильтрует по бренду | `digest`: у двух аккаунтов разных тенантов совпал дайджест 200-го ответа на ручке из `responseMustDifferByTenant` — проверка `identical-response-across-tenants` |
| Списочная ручка фильтрует не полностью | `count`: число элементов по объявленному пути одинаково у аккаунтов разных тенантов или заведомо больше ожидаемого |
| Ручка, которой не должно быть в этом контуре вовсе | статус: 200 вместо 404/403 |

Существенно, что четвёртая и пятая строки — единственный способ увидеть самый частый
дефект изоляции. Корректная и дефектная реализации списка отвечают одинаковым 200,
и без сигналов над телом разницы не существует (ADR-0011).

### Не видно, и почему

1. **Контуры провайдера игр, платёжного шлюза и KYC — целиком.** Это POST-и, входящие
   снаружи, аутентифицированные подписью, а не сессией, и меняющие баланс. Три
   инварианта сразу против: safe-by-default (только GET/HEAD), отсутствие понятия
   «ключ подписи» в модели аккаунта и запрет на действия с необратимыми последствиями.
   Проверить, что оператор сверяет `user` с владельцем `token`, инструмент не может
   и не должен: единственный способ это проверить — провести списание.
2. **Правильность агрегата.** «Холдинг видит агрегат по бренду A вместо своего» —
   200 и число в обоих случаях. `count` не спасает: агрегация схлопывает строки,
   и число элементов не меняется. Принципиально невидимый класс.
3. **Атрибуция утечки.** `digest` отвечает «одинаковые ли байты», а не «чьи данные
   внутри». Инструмент способен утверждать «два тенанта увидели одно и то же»; вывод
   «бренд A увидел игроков бренда B» делает человек.
4. **Поле внутри элемента списка.** `present` разрешает путь только через объекты:
   `resolvePath` возвращает `undefined`, как только встречает массив
   (`src/adapters/signals.ts`). Значит «в аффилиатском отчёте появилась колонка
   `email`» — а это ровно §3.1 и API3:2023 — сейчас не проверяется. Видно только
   поле на верхнем уровне объекта ответа. Это ограничение реализации, не инварианта:
   индексный сегмент пути расширения `SignalValue` не требует.
5. **Пройденная ячейка почти ничего не доказывает.** 403 не отличает «отказано,
   потому что чужой тенант» от «отказано, потому что роль не та» и от «такого объекта
   нет». Формулировка для отчёта — «нарушений на объявленных объектах не обнаружено»,
   а не «изоляция работает». Для будущего evidence-pack это разница между
   свидетельством и его имитацией.
6. **Всё, что про состояние во времени.** Распространение самоисключения между
   брендами (§2.3), дедупликация аккаунтов по доменам, ретеншен — это не доступ,
   а поведение системы после записи. Вне области инструмента по определению.
7. **Доступ, идущий мимо API оператора.** Консоль KYC-провайдера, портал платёжного
   шлюза, BI поверх реплики, доступ инспектора MGA к реплицированным данным. Матрица
   доступа платформы про них ничего не знает.

### Что предметная область говорит о модели инструмента

Три расхождения, зафиксированных как наблюдения, — без предложения менять код.

**Контуры вложены, а ось тенанта одна.** `relationOf` сравнивает `tenantId` аккаунта
и ресурса (`src/core/types.ts`), давая три значения. Реальная иерархия — группа →
лицензиат → бренд → аффилиат → игрок, и роль «чужого» зависит от того, на каком
уровне смотреть. Два аффилиата одного бренда — это `same-tenant`, а значит,
`identical-response-across-tenants` на них не сработает, хотя утечка между аффилиатами
не менее серьёзна, чем между брендами. Объявить аффилиата отдельным тенантом можно,
но тогда пара «оператор бренда ↔ его аффилиат» станет `foreign-tenant`, что неверно:
оператору его аффилиат положен. Одной осью предметная область не выражается —
по крайней мере, без соглашения о том, какой именно контур считается тенантом
в конкретном прогоне. Такое соглашение стоит записать явно, хотя бы в примерах.

**Бренд часто определяется хостом, а цель одна.** В конфигурации один `target.baseUrl`
и один список `allowedHosts` (ADR-0008, там же в последствиях: «пересмотреть, если
появится потребность в нескольких целях в одном прогоне»). Между тем бренд по
поддомену — типовой случай (§2.2), и самый интересный запрос — «токен бренда A,
Host бренда B» — сейчас невыразим. Это, вероятно, самый дешёвый способ приблизить
инструмент к предметной области: хост как часть описания ресурса, а не только цели.

**Отображение на пункты стандартов уже есть куда делать.** `CheckRegistry` требует
у проверки маппинг на пункты внешних стандартов, и подходящий перечень найден:
RTS section 4 называет контроли ISO/IEC 27001:2022 поимённо (5.15, 5.16, 5.17, 5.18,
8.2, 8.15), а GLI-19 даёт §B.2.3, §C.2.3, §B.3.2, §B.5.3. Для модуля 2 это готовые
якоря, не требующие покупки стандарта.

---

## Источники

Регуляторы и стандарты:

- [MGA — Technical Infrastructure hosting Gaming and Control Systems (Remote Gaming)](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)
- [MGA — B2B licences: game providers and back office](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/)
- [UKGC — RTS section 4, security requirements](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/4-remote-gambling-and-software-technical-standards-rts-security-requirements)
- [UKGC — White label partnerships (compliance and enforcement report 2019–20)](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)
- [UKGC — LCCP 3.5.3 (remote self-exclusion)](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-3-remote-sr-code), [LCCP 3.5.5 (multi-operator)](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-5-remote-multi-operator-sr-code)
- [GLI-19 v3.0 — Standards for Interactive Gaming Systems](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)
- [N.J.A.C. 13:69O-1.2](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-2), [NJ DGE, Chapter 69O](https://www.nj.gov/oag/ge/docs/Regulations/CHAPTER69O.pdf)
- [Curaçao Gaming Authority — License Management Portal](https://portal.gamingcontrolcuracao.org/)
- [GDPR Recital 48](https://gdpr-info.eu/recitals/no-48/)
- [ICO — action against Sky Betting and Gaming (2024)](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2024/09/action-taken-against-sky-betting-and-gaming-for-using-cookies-without-consent/)

Техническая документация интеграций:

- [Hub88 — Wallet API](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api), [Getting started](https://docs.hub88.io/developer-docs/operator-api-reference/getting-started), [TransferWallet API](https://docs.hub88.io/developer-docs/operator-api-reference/transferwallet-api)
- [Praxis Cashier — payment notification](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification), [актуальная документация](https://docs.praxis.tech/)
- [Sumsub — Webhook manager](https://docs.sumsub.com/docs/webhook-manager)
- [TheAffiliatePlatform — Reporting interfaces / BI](https://help.theaffiliateplatform.com/reporting/reporting-interfaces-bi.md), [Affiliate Account](https://help.theaffiliateplatform.com/affiliate-platform/affiliate-account)

Модели изоляции:

- [AWS — SaaS Tenant Isolation Strategies: the isolation mindset](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-isolation-mindset.html)
- [AWS — SaaS Architecture Fundamentals: tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)
- [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)

Инциденты:

- [Security Affairs — утечка данных группы онлайн-казино (2019)](https://securityaffairs.com/80173/data-breach/online-casinos-data-leak.html)
- [TechCrunch — открытая база приложения казино (2024)](https://techcrunch.com/2024/02/09/winstar-hotel-casino-app-exposed-customer-personal-data/)
- [BleepingComputer — ransomware у SBTech по данным SEC-документа (2020)](https://www.bleepingcomputer.com/news/security/draftkings-discloses-sbtech-ransomware-attack-in-sec-filing/)
- [The Register — инцидент у Bragg Gaming Group (2025)](https://www.theregister.com/2025/08/19/bragg_attack/)
- [UKGC — штраф 888 (2017)](https://www.gamblingcommission.gov.uk/news/article/gambling-firm-888-to-pay-over-gbp7-8million-for-failing-vulnerable-customers), [штраф группе William Hill (2023)](https://www.gamblingcommission.gov.uk/news/article/william-hill-group-businesses-to-pay-record-gbp19-2m-for-failures)

Вендорские материалы (маркетинг, не источник фактов о конкретных реализациях):

- [SOFTSWISS — what is a white label solution](https://www.softswiss.com/knowledge-base/what-is-white-label-solution/)
- [PartnerMatrix — agent management system](https://partnermatrix.com/agent-system/)
- [Affilka — features](https://affilka.com/features/)
