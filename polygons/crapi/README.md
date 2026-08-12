# crAPI как полигон: воспроизводимый прогон

Разведка и её выводы — [docs/polygons/crapi.md](../../docs/polygons/crapi.md).
Здесь только то, чем прогон повторяется. crAPI (OWASP) в репозиторий не
вкладывается: это внешний проект под своей лицензией. Берётся у первоисточника.

## Что понадобится извне

Из репозитория `OWASP/crAPI` (ветка `develop`):

- `deploy/docker/docker-compose.yml`, `deploy/docker/.env`, `deploy/docker/keys/jwks.json`;
- `openapi-spec/crapi-openapi-spec.json` — источник эндпоинтов для `--spec`.

## Поднять стенд

Порты crAPI и так привязаны к `127.0.0.1` (`LISTEN_IP` в `.env`) — наружу ничего
выставлять не нужно. Веб-контейнер (nginx) на старте резолвит апстрим чат-бота и
без него падает; сам чат-бот к области проверки не относится (тяжёлый образ,
внешний LLM), поэтому он не поднимается, а имя апстрима даётся заглушкой. Рядом
с `docker-compose.yml` кладётся `docker-compose.override.yml`:

```yaml
services:
  crapi-web:
    extra_hosts:
      - "crapi-chatbot:127.0.0.1"
```

```
docker compose up -d crapi-web
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/health   # ждём 200
```

## Токены

`barbican` токены не добывает: логин у crAPI только `POST`, а безопасный режим
шлёт лишь `GET`/`HEAD`. Оператор логинится сам и кладёт токены в окружение.
Пароли предзаведённых пользователей crAPI — `<локальная-часть>!123`
(`adam007!123`, `pogba006!123`, `Admin!123`).

```
login() { curl -s -X POST http://127.0.0.1:8888/identity/api/auth/login \
  -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])'; }

export CRAPI_TOKEN_ADAM=$(login adam007@example.com  'adam007!123')
export CRAPI_TOKEN_POGBA=$(login pogba006@example.com 'pogba006!123')
export CRAPI_TOKEN_ADMIN=$(login admin@example.com    'Admin!123')
```

## Прогон

```
node dist/cli.js run \
  --config polygons/crapi/barbican.run.yaml \
  --spec  /путь/к/crapi-openapi-spec.json \
  --report /tmp/crapi.report.json \
  --rps 20 --concurrency 4
```

Ожидаемо: 16 эскалаций (все шесть классов, видимых по статусу), `probe-error` 4
(`receive_report` без параметра), **находок проверок 0**. Оракул снимается `curl`-ом
независимо от инструмента — см. основной разбор.

## Про сигналы над телом (ADR-0011)

`bodySignals.tenantScoped` помечает три списочные ручки, обязанные различаться
между пользователями: `get_vehicles`, `get_orders`, `get_dashboard`. crAPI
фильтрует их по владельцу верно — дайджесты у разных пользователей расходятся, и
проверка `identical-response-across-tenants` молчит. Это правильный ноль: того
дефекта, который она ищет, в crAPI нет. Публичные `get_recent_posts`/`get_products`
и BFLA `get_workshop_users_all` в `tenantScoped` не внесены намеренно — их
одинаковый для всех ответ законен, и пометка дала бы ложные срабатывания.

## Убрать за собой

```
docker compose down -v
```
