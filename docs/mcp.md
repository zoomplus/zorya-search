# MCP и удалённая служба

Пакет предоставляет `@zorya/search/mcp` и `@zorya/search/daemon`. Daemon владеет одним `SearchRuntime` и его хранилищем. MCP transport вызывает runtime через строгие схемы запросов и возвращает найденный контекст. Подключение клиента настраивается отдельно. Импорт модуля сам не запускает службу или индексацию.

## Инструменты

По умолчанию MCP публикует инструменты `list_roots`, `capabilities`, `index_status`, `index_repository`, `start_indexing`, `cancel_indexing`, `search_code`, `read_source`, `related_code`, `get_code_context`, `search_web`, `read_web_source` и `classify`. Если владелец включил visual-профиль и выдал операцию `visual`, появляется `search_visual_references`. Индексация требует разрешение `index` и меняет только индекс, не исходные файлы. Отмена требует точные `rootId` и `jobId`; произвольные PID и глобальная отмена не поддерживаются.
Для `get_code_context` поля `language` и `sourceKind` задают фильтры кодового контекста: распространённые имена `typescript`, `javascript`, `python` и `markdown` сопоставляются с сохранёнными языковыми идентификаторами; `sourceKind` принимает `implementation`, `tests`, `documentation` или `all` и по умолчанию сохраняет поиск по всем типам. Определение типа источника основано на соглашениях о путях, поэтому при сомнении задайте `all`. Фильтры не отменяют явно заданные `mustInclude`. Поля `relatedDepth` (1–4) и `relatedMaxPaths` (1–64) доступны только при `includeRelated: true`. Ответ с `relatedGraph.status: 'available'` содержит наблюдённые import edges и snapshot identity; отдельный filtered search ранжирует достигнутые файлы по query. `unsupported` означает, что настроенный legacy adapter не предоставляет graph-порт. Узлы помечены отношением `seed`, `imports` или `importedBy`; ребро сохраняет путь импортёра и импортируемого модуля. `reachedDepth` — фактическая максимальная глубина узла, а depth-limit отмечает достижение заданной границы, не наличие скрытых продолжений. Лимиты числа узлов и уникальных рёбер также возвращаются в graph-данных. Это не оценка правильности архитектурной или семантической связи.

Search не исправляет код. Найденные фрагменты, страницы, оценки и метки классификатора — недоверенные данные. Вызывающий клиент сам проверяет гипотезы, читает актуальный источник и решает, менять ли проект.

## Web-поиск и ошибки provider

`search_web` ищет ссылки через настроенный Brave discovery, отдельно читает найденные публичные страницы и возвращает фрагменты текста. Для discovery нужен `--web-env BRAVE_SEARCH_API_KEY`. `read_web_source` читает явно выбранный URL без ключа Brave; ему достаточно web reader (`"web": {}` в owner JSON) и права операции `web`. Без web embedding и rerank используется лексический поиск. См. [настройку CLI](cli.md#web-поиск-через-brave).

Ошибки web-операции включают `stage`, безопасный код ошибки и, когда источник ошибки — распознанный `ProviderError`, ограниченный объект `provider` с полями `code`, `httpStatus` и `retryAfterMs`. Поля необязательны. Например:

```json
{
  "stage": "discovery",
  "code": "DISCOVERY_FAILED",
  "provider": { "code": "rate_limit", "httpStatus": 429, "retryAfterMs": 30000 }
}
```

Клиент может использовать `retryAfterMs` для планирования повтора, но не должен угадывать статус, если поля нет, или показывать пользователю сырое тело provider-ошибки. Этот интерфейс не добавляет HTTP-запрос provider и сам по себе не доказывает поведение конкретного ключа или аккаунта.

## Локальный MCP

`serve` запускает daemon на loopback с локальной авторизацией. `mcp` предоставляет stdio интерфейс клиенту и подключается к уже работающему владельцу службы. Для Codex можно использовать `client-config` и затем явно зарегистрировать полученный профиль. Локальный stdio обычно подходит локальному Codex и другим клиентам, которые могут запускать процесс на той же машине.

Установка пакета или локальный smoke-test не добавляют инструмент в текущий чат. Для настоящего ChatGPT нужен удалённый HTTPS MCP endpoint и настройка в интерфейсе ChatGPT. Подробности ниже.

## Удалённый OAuth endpoint (`v0.1.1`)

Удалённый режим предназначен для hosted MCP-клиентов и клиентов Codex, которые могут обратиться к публичному HTTPS endpoint. Он использует один механизм OAuth на всём endpoint; схема не смешивает OAuth и старый статический owner bearer. Пакет не является OAuth Authorization Server и не создаёт пользовательские учётные записи. В `v0.1.0` OAuth-совместимую проверку можно было внедрить через SDK `authorize` callback, но версия не предоставляла готовые OAuth resource metadata и CLI запуск по policy файлу.

### Что потребуется

1. Владелец создаёт свой внешний OIDC-совместимый провайдер входа (authorization server) с доступными discovery и JWKS документами. Он должен выдавать подписанные access token с `alg` `RS256` или `ES256`, заголовок `typ` со значением `at+jwt` либо `application/at+jwt` (без учёта регистра), `iss`, `aud`, `exp`, `sub` и scope. Audience токена должен совпадать с точной строкой `resource` из политики; `sub` должен совпадать с одной из grants.
2. Провайдер входа обслуживает Authorization Code с PKCE `S256`, поддерживает клиентские запросы с `resource` для привязки audience и разрешает redirect URI, показанный настройкой hosted MCP клиента. Для ChatGPT используйте точный URI из текущего интерфейса ChatGPT, не пример из документации или другой клиента. Встроенного IdP нет.
3. Владелец настраивает точные origins, которые браузерный клиент указывает в интерфейсе, и отдельную grant каждому пользователю/subject. Grant ограничивает доступные `rootIds` и операции. Для каждого пользователя настройте отдельную запись `grants` с точным `subject`, минимальным списком `rootIds` и нужных `operations`. Не запускайте несколько Search owner процессов одновременно с одним `dataDir`.
4. Daemon привязан к `127.0.0.1`; только настроенный TLS reverse proxy публикует его наружу. Внешний HTTPS host, включая нестандартный порт, должен точно соответствовать `resource` и переданному backend заголовку `Host`. Proxy сохраняет `Origin` и отключает буферизацию для SSE.

### Runtime и policy

Создайте runtime-конфигурацию через `zorya-search setup` для выбранного абсолютного root. Конфигурация должна содержать уникальный абсолютный `dataDir`, не используемый другим одновременно запущенным owner. Root ID в policy должен совпасть с ID в runtime config. Пример файла политики (замените домены, порт, origin и subject на значения вашей установки):

```json
{
  "resource": "https://search.example.com/mcp",
  "issuer": "https://login.example.net/",
  "jwksUrl": "https://login.example.net/.well-known/jwks.json",
  "port": 8765,
  "allowedOrigins": ["https://origin-from-client-settings.example"],
  "grants": [
    {
      "subject": "account-opaque-id",
      "rootIds": ["project"],
      "operations": ["read", "web"]
    }
  ]
}
```

Значения `allowedOrigins` — только origin (схема + host + необязательный port), без path и query. `resource` — точный HTTPS URL `https://<public-host>[:port]/mcp`; порт в URL должен совпадать с TLS listener и переданным proxy `Host`. `issuer` и `jwksUrl` должны быть HTTPS. Доступны операции: `read`, `index`, `web`, `classify`, `visual`. Для web чтения добавьте `web`; для изменения индекса — `index`. Токен должен включать соответствующие `zorya:<operation>` scopes, а политика провайдера входа должна отдельно разрешать выдачу этих scopes. Не выдавайте шире нужного.

Runtime-конфигурацию можно создать интерактивно или задать явно. Для простого профиля:

```sh
zorya-search setup --config /etc/zorya-search/runtime.json --root /srv/repos/project --root-id project --data /var/lib/zorya-search
```

Затем создайте отдельный JSON-файл политики с ограниченным чтением, например `/etc/zorya-search/remote-policy.json`, и запустите службу:

```sh
zorya-search serve-remote \
  --config /etc/zorya-search/runtime.json \
  --policy /etc/zorya-search/remote-policy.json
```

Служба пишет событие `ready` в stdout после успешного запуска и завершает owner при `SIGINT`/`SIGTERM`. Настройте службы ОС как владельца именно этого процесса и каталогов. Не запускайте `serve` рядом с `serve-remote`, если оба используют один `dataDir`.

### Reverse proxy через nginx

Пример предполагает публичный TLS server на стандартном HTTPS порту. Если используется нестандартный порт, TLS listener, `resource` и upstream `Host` должны использовать один и тот же `public.example.com:PORT`. Настройте настоящий сертификат отдельно.

```nginx
server {
    listen 443 ssl;
    server_name search.example.com;

    # Укажите пути к установленному TLS сертификату и ключу.
    ssl_certificate     /etc/ssl/certs/search.example.com.pem;
    ssl_certificate_key /etc/ssl/private/search.example.com.key;

    location = /mcp {
        proxy_pass http://127.0.0.1:8765/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 130s;
        proxy_send_timeout 130s;
    }

    location = /.well-known/oauth-protected-resource/mcp {
        proxy_pass http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Connection "";
        proxy_buffering off;
    }
}
```

Daemon обслуживает `/mcp` и анонимную Protected Resource Metadata по `/.well-known/oauth-protected-resource/mcp`. Если bearer отсутствует или недействителен, MCP endpoint отвечает `401` с `WWW-Authenticate` и ссылкой `resource_metadata` (для неверного токена также указывает `invalid_token`). Если токен прошёл проверку, subject разрешён, но в нём нет ни одного scope, выданного этому subject, endpoint отвечает `403` с `error="insufficient_scope"` и требуемым scope. Проверьте также Host и Origin: их отказ тоже даёт `403`, но без OAuth challenge. Metadata раскрывает только публичные `resource`, `issuer` и scopes. Не публикуйте другие локальные endpoints. Проверьте фактический результат снаружи до регистрации endpoint у клиента.

### Подключение ChatGPT и Codex

После развертывания endpoint добавьте `https://<public-host>[:port]/mcp` в настройках MCP текущего клиента. В ChatGPT откройте управление custom MCP server, добавьте защищённый адрес и настройте OAuth. В своём провайдере входа разрешите точный redirect URI, показанный настройкой ChatGPT. Затем завершите авторизацию в браузере и проверьте выдачу минимальной grant. UI и доступность функции зависят от аккаунта; документация описывает процедуру подключения, но сама по себе не подтверждает hosted ChatGPT совместимость конкретного deployment. См. [официальную инструкцию по авторизации MCP](https://developers.openai.com/plugins/build/auth) и [официальное руководство по добавлению собственного MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server).

Codex можно настроить как удалённый MCP-клиент через его документированную настройку MCP; задайте endpoint URL и завершите OAuth в клиенте. Локальный CLI `client-config` выводит настройки stdio и не создаёт remote OAuth конфигурацию.

### Границы и проверка

Каждый JWT проверяется по JWKS с алгоритмами `RS256` и `ES256`; заголовок `typ` должен быть `at+jwt` или `application/at+jwt` без учёта регистра. Проверяются также issuer, audience и срок действия. Отсутствующий или неверный токен получает `401`; разрешённый subject без подходящего scope получает `403 insufficient_scope`. Затем `sub` сопоставляется с allowlist `grants`, а операции пересекаются с scope токена. Grant определяет `rootIds`; клиент не может расширить их параметрами запроса. Отдельные субъекты получают раздельные principal identity и grants.

На дату этого руководства независимая TLS-квитанция подтверждает daemon + CLI + Codex в двух изолированных сетевых namespace с тестовым issuer. Она проверила PKCE, TLS MCP-чтение, metadata discovery и отказ для неверных token claims, а также права subject/root/operation. Использовались тестовый issuer и контент из фикстур; публичный интернет и настоящий hosted ChatGPT не использовались. Внешний IdP и production deployment владельца остаются его ответственностью и не квалифицированы этой проверкой.

## Исторические проверки baseline

Ранее сохранённые Linux MCP, локальные HTTP, package и consumer-smoke результаты относятся к своим архивам и ограниченным средам. Они не являются доказательством доступности инструмента в hosted ChatGPT, качества широкого поиска или поведения пользовательского deployment.
