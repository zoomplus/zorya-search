# CLI Zorya Search

CLI предоставляет команды для локальной настройки, индексации и поиска, а также MCP stdio-вход к общему локальному владельцу базы. Пакет устанавливает исполняемую команду `zorya-search`; после сборки она находится в `dist/cli/entry.js`. Source candidate `v0.1.10` добавляет инкрементальную команду `configure` для существующего профиля и поле `mcpReconnectRequired` в её receipt; structured MCP presentation остаётся opt-in, `legacy` — default. Наличие точных GitHub tag и npm version нужно проверить отдельно перед установкой. Предыдущий Jev/reuse интерфейс описан в [руководстве Jev](jev-classification.md).

## Быстрый старт

Для Node.js `>=20.19.0` проверьте наличие точных GitHub tag `v0.1.10` и npm версии `zorya-search@0.1.10`. До подтверждения обеих публикаций эти команды остаются примерами, не заявлением о доступности. Затем устанавливайте точную версию и сверяйте package identity и schema. Команды настройки не устанавливают MCP в чат или редактор и не запускают индексацию:

```sh
npm install --save-exact zorya-search@0.1.10
npm ls zorya-search --depth=0
npx --yes zorya-search@0.1.10 setup --root .
npx --yes zorya-search@0.1.10 client-config
```

`client-config` печатает готовые варианты, включая `installedCodex`; владелец отдельно регистрирует нужный вариант в существующем клиенте. После регистрации отдельно выдаются разрешения, запускается `index`, а доступ к моделям включается только при отдельной настройке профиля и ключа. Установка в workspace не использует глобальную команду и не меняет конфигурацию клиента.

Чтобы включить opt-in сжатую подачу точного повторённого JSON для локального stdio, используй `mcp --result-presentation structured` либо сгенерируй соответствующий профиль через `client-config --result-presentation structured`. Без флага остаётся `legacy`. Режим действует только на `mcp`/`client-config`; детали, ограничения и usage измерений приведены в [руководстве result presentation](mcp-result-presentation.md).

## Индекс документации, правил и навыков — preview `v0.1.7`

Команды `text-status`, `text-index`, `text-search` и `text-read`, а также `setup --text-env NAME`, описаны в [руководстве по тексту проекта](project-text.md#cli-и-mcp). Их нет в историческом архиве `v0.1.6`; перед использованием сверяй фактическую версию установленной команды. `--text-env` включает отдельный Voyage preset для project text; без него `projectText: {}` использует локальный lexical поиск. У нового `setup` этот локальный capability включён по умолчанию. Для существующей конфигурации команды требуют явного `projectText`; отсутствие настройки даёт `CAPABILITY_DISABLED` и не переписывает файл.

`setup` создаёт файл конфигурации один раз и завершится `CONFIG_ALREADY_EXISTS`, если путь уже занят. Команды `setup` ниже показывают **альтернативные варианты первоначальной настройки**, а не последовательные обновления одной конфигурации. Выполните только одну подходящую команду для нового профиля. Для добавления поддерживаемой capability в существующий профиль используйте `configure --config PATH --capability ENUM`. Для остальных ручных изменений остановите владельца (`zorya-search service --stop --config PATH`), сохраните копию и отредактируйте текущий файл явно; не создавайте второй профиль через новый путь, если хотели изменить существующий. После ручной правки перезапустите того же владельца и передавайте прежний `--config PATH` последующим командам.

Пакеты локального PGlite и PostgreSQL-драйвер `pg` являются обычными зависимостями, поэтому их не удаляет следующий `npm install` или `npm ci --omit=optional`. PDF-парсер остаётся необязательным; код SDK загружает драйвер базы только при открытии выбранного хранилища.

Если для нового профиля нужен большой workspace, выберите эту команду **вместо** короткой `setup` выше: задайте явные пределы и исключите большие evidence-деревья до индексации. Например, Assistant workspace с 24 863 chunks на принятом snapshot:

```sh
npm exec -- zorya-search setup --root "$PWD" --exclude 'docs/evidence/**' \
  --max-files 20000 --max-chunks 50000 --max-scan-chunks 50000 --watch
```

Числа отражают профиль этой интеграции, а не универсальные рекомендуемые пределы. Для нескольких репозиториев используйте `root-add --root-id ID --root PATH`; укажите `--watch` для автоматической сверки каждого добавляемого корня. Корень выбирается явно и остаётся внутри allowlist конфигурации.

По умолчанию используется lexical-поиск без сетевых вызовов. `--code-env NAME` включает принятый preset для кода: `voyageai/voyage-code-4` размерности 1024 и `voyageai/rerank-2.5-lite`, который rerank-ит до 30 результатов и возвращает до 8. Конфигурация хранит только `mechanism.code.secret: { kind: "env", name: "NAME" }`; модель выбирается через общий `MECHANISM_RETRIEVAL_PRESETS` runtime preset. `--embedding-env NAME` оставлен как совместимый alias для code preset, если `--code-env` не указан. Код и поисковые запросы отправляются провайдеру для включённых операций embeddings/reranking.

### Web-поиск через Brave

`--web-env BRAVE_SEARCH_API_KEY` настраивает ключ Brave Search API только для поиска ссылок. Search отдельно загружает найденные публичные страницы, чтобы извлечь текст; для чтения страницы ключ Brave не используется. Простой поиск по страницам не требует embedding-профиля: без отдельной текстовой модели поиск использует лексическое ранжирование.

Текущие исходники SDK и `search_web` также принимают выбранные вызывающей стороной `additionalQueries`; текущий архив `v0.1.6` этого аргумента не поддерживает. Поля discovery summary и правила объединения описаны в [руководстве по web discovery](project-text.md#несколько-запросов-web-discovery).

Частоту запросов discovery владелец может задать в `web.discovery.limits.maxRequestsPerSecond`: значение от 1 до 100, по умолчанию 1 запрос в секунду для discovery-провайдера в этом runtime. Brave может дополнительно ограничивать запросы согласно объявленной квоте и возвращать заголовки ограничений частоты; см. [официальное описание ограничений Brave](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting). Настройка runtime не задаёт общий лимит для нескольких процессов.

```sh
npm exec -- zorya-search setup --root "$PWD" \
  --code-env VOYAGE_CODE_KEY \
  --web-env BRAVE_SEARCH_API_KEY
```

Это самостоятельный вариант первого `setup`, если нужен code preset и Brave discovery; он не предназначен для запуска после короткого setup или большого-workspace setup. Для уже созданного профиля сначала остановите службу и меняйте текущий runtime JSON явно.

Кодовый профиль Voyage и поиск ссылок независимы. Если добавить текстовую модель web embedding, укажите собственные модель и размерность, поддерживаемые выбранной OpenRouter-моделью. Для примера ниже предварительно задайте `WEB_TEXT_MODEL` и `WEB_TEXT_DIMENSIONS` из конфигурации своего аккаунта; Search не выбирает модель автоматически:

```sh
: "${WEB_TEXT_MODEL:?Укажите OpenRouter-модель для текста страниц}"
: "${WEB_TEXT_DIMENSIONS:?Укажите её размерность}"
npm exec -- zorya-search setup --root "$PWD" \
  --code-env VOYAGE_CODE_KEY \
  --web-env BRAVE_SEARCH_API_KEY \
  --web-embedding-model "$WEB_TEXT_MODEL" \
  --web-embedding-dimensions "$WEB_TEXT_DIMENSIONS" \
  --web-embedding-env OPENROUTER_API_KEY
```

Этот пример тоже заменяет первоначальный `setup` выше: он создаёт один новый профиль с выбранными code, web и web-embedding настройками. Не выполняйте его для уже созданной конфигурации.

Команды задают имена секретных env-переменных, а не их значения. Эти значения должны быть доступны процессу владельца; не передавайте ключи в argv. Текстовая web-модель применяется только к web-поиску и не заменяет кодовый профиль Voyage или отдельный visual profile. Для собственного OpenAI-compatible сервера вместе задайте `--web-embedding-endpoint HTTPS_URL` и `--web-embedding-profile PROFILE_ID`; неполная пара отклоняется. Переранжирование web-результатов независимо от web embedding и задаётся через `--web-reranker-model MODEL --web-reranker-env NAME`.

Если нужно прочитать только заранее известный URL, поиск ссылок и ключ Brave не нужны. В owner JSON достаточно включить web reader (`"web": {}`); MCP-клиенту всё равно нужна операция `web`. `--web-env` нужен для `search_web`, которое находит ссылки через Brave.

Watch включается только явным `--watch`; `--watch-interval-ms N` задаёт интервал 250–60000 ms и требует этот флаг. Служба начинает принимать клиентов после проверки конфигурации и хранилища: начальная индексация watch-корней выполняется как runtime-owned фоновая задача. Статус и поиск доступны во время работы; пока нет готового snapshot, ответы не изображают индекс как пустой успешный результат. После первого прохода watcher сверяет изменения, в том числе внесённые во время начальной индексации. При включённом облачном профиле фрагменты могут отправляться выбранному embedding-провайдеру. TTY-мастер отдельно спрашивает, включать ли автоматическую переиндексацию.

Владелец службы начинает отвечать до завершения стартовой индексации watch-корней. `index --background` возвращает admission с `jobId`; обычный `index` ждёт этот job, печатает его состояние, номер попытки и фактические checkpoint/chunk counts в stderr и возвращает финальный статус. Polling ограничен настроенным `indexing.jobTimeoutMs` плюс небольшой сетевой запас; каждый запрос статуса привязан к точному `jobId`, поэтому новая задача того же корня не подменит наблюдаемую. При Ctrl-C/TERM CLI отменяет только job, который он сам создал; если admission переиспользовал уже существующий job, он оставляет его владельцу.

Настройка `indexing` необязательна: `maxConcurrentRoots` по умолчанию 1 (диапазон 1–4), `maxAttempts` — 12 (1–32), `jobTimeoutMs` — 900000 (1000–3600000 ms), `retryDelayMs` — 300 (100–5000 ms). Обычный `limits.timeoutMs` задаёт верхнюю границу одной индексной попытки, максимум 120000 ms. Истёкшая попытка повторяется только после роста durable checkpoint count; для watch-корня допускается ограниченная повторная сверка, если изменились исходники. Timeout без нового checkpoint, ошибки auth/quota/malformed и остальные постоянные ошибки завершают job. Watcher временно приостанавливает периодические попытки после постоянной ошибки или трёх последовательных ошибок сверки; файловое событие или явный успешный job позволяет продолжить. `index_status` показывает и job, и последний опубликованный snapshot; job registry находится в памяти процесса, а новая admission после аварийного завершения продолжает от durable checkpoint базы.

Визуальный preset независим и включается только явным `--visual-env NAME`: `voyageai/voyage-multimodal-3.5`, 1024 dimensions, top 5. Он сохраняется в `mechanism.visual.secret` и не влияет на кодовый профиль; TTY-мастер также предлагает visual-only режим. Для кода top-level OpenAI-compatible embedding доступен как явно заданный custom profile: `--custom-embedding-endpoint HTTPS_URL --custom-embedding-profile ID --custom-embedding-model MODEL --custom-embedding-dimensions N --custom-embedding-env NAME`. Он конфликтует с code preset, чтобы не смешивать embedding spaces. Web-профиль настраивается отдельно, как описано выше.

Jev classification и reuse включаются при создании профиля через `--jev-env NAME`; runtime использует только `typesafe/jev-1.14`. Совместимые `--classifier-model MODEL --classifier-env NAME` принимают только этот model ID и несовместимы с `--jev-env`. Search хранит имя environment variable, не значение ключа. В preview CLI для reuse уже разрешённого root принимает `reuse --config PATH --root-id ID --query TEXT`; вызов и limits описаны в [руководстве Jev](jev-classification.md). Эта команда отсутствует в archive `v0.1.6`.

Пути конфигурации и данных по умолчанию находятся в пользовательских каталогах ОС и вне индексируемого корня. Для явного профиля службы задайте `--config PATH`, `--root PATH` и при необходимости `--data PATH`. Перед записью конфигурация проверяется общей строгой runtime-схемой; CLI не поддерживает отдельную схему credentials. Если конфигурация уже существует, setup завершится явной ошибкой и не заменит её; выберите новый путь либо отредактируйте профиль отдельно. Повторная установка пакета не удаляет индекс.

## Команды

Команда `configure` входит в source candidate `v0.1.10`; проверьте установленную версию перед использованием.

- `setup` — создать конфигурацию; `--code-env NAME` задаёт code preset, `--visual-env NAME` отдельно включает visual profile, `--web-env NAME` включает Brave discovery. По умолчанию поиск по страницам lexical. Web text embedding включается отдельно через `--web-embedding-model`, `--web-embedding-dimensions` и `--web-embedding-env`; для своего HTTPS endpoint дополнительно нужна парная опция `--web-embedding-profile`. `--embedding-env NAME` — совместимый alias для code preset. `--watch [--watch-interval-ms N]` включает автоматическую повторную сверку.
- `doctor` — сообщить, существует ли конфигурация и отвечает ли подтверждённый локальный владелец. Проверка не вызывает внешние модели; поля провайдера остаются `not-run`.
- `index [--background]` — начать или переиспользовать runtime job первого настроенного корня. По умолчанию команда ждёт финальный статус; `--background` сразу возвращает admission и `jobId`.
- `search --query TEXT [--mode lexical|hybrid]` — выполнить поиск через MCP операцию Search.
- `context --query TEXT` — запросить ограниченный контекст через ту же операцию Search.
- `reuse --config PATH --root-id ID --query TEXT` — в preview вызвать `get_reuse_context`; требуется Jev capability и grant `read` плюс `classify`. Не входит в archive `v0.1.6`.
- `root-add --root-id ID --root PATH [--watch] [--watch-interval-ms N]` — добавить корень. Watch вступает в силу при следующем запуске службы; конфигурация не перезаписывается при активном владельце.
- `serve` — запустить локальную службу на loopback в foreground. При ручном запуске CLI сам создаёт приватные owner и control секреты; внутренние параметры секретных файлов используются только launcher-ом. На Node 24 для этого ограниченного workaround можно запустить entry как `node --wasm-wrapper-tiering-budget=1000000000 <entry> serve --config <path>`; обычная команда `zorya-search serve` сохраняет стандартные настройки Node. Команды, автоматически создающие владельца службы, применяют флаг к собственному Node 24 daemon.
- `mcp [--result-presentation legacy|structured]` — предоставить MCP stdio и подключиться к общей локальной службе. `legacy` — default; `structured` заменяет только точный дубликат JSON text из `content` короткой подсказкой. Данные протокола идут только в stdout; диагностика — в stderr.
- `client-config [--result-presentation legacy|structured]` — вывести готовые варианты JSON `command`/`args`; заданный structured режим включается в напечатанные stdio-команды: `installed` запускает текущий установленный package entry через абсолютные `process.execPath` и путь entry и пригоден из другого cwd; `installedCodex` печатает соответствующую команду `codex mcp add`. Варианты `registry` и `registryCodex` адресуют одноимённую версию из npm и работают только после публикации этой версии в npm; используйте `installed` для установленного GitHub archive. Команда только показывает конфигурацию, не регистрирует MCP и не меняет профиль клиента.
- `service` — показать статус; `service --stop` отправляет отдельный случайный секрет по owner-specific локальному IPC каналу после проверки текущего daemon токена. PID из редактируемого descriptor не используется для остановки процесса.
- `configure --config PATH --capability ENUM` — инкрементально дополняет существующую конфигурацию одной capability. Enum: `project-text`, `web-read`, `web-discovery`, `visual`, `code-embeddings`, `project-text-embeddings`, `jev-classification`. Сохраняются текущие roots, `dataDir`, watch-параметры и прочие профили. `project-text` включает только локальный lexical поиск docs/rules/skills без ключа и embedding-модели; `web-read` тоже не требует ключа Brave. Discovery настраивает Brave. `visual` использует отдельный `voyage-multimodal-3.5`, код — `voyage-code-4`, семантический project-text — `voyage-4-large` + `rerank-2.5-lite`, классификация — только `typesafe/jev-1.14`. Профили остаются независимыми.

Для help и version не читаются конфигурация, секреты или база. Диагностика возвращает структурированные значения; `doctor` различает установленный CLI, валидную конфигурацию, подтверждённый локальный сервис и фактическую проверку провайдера.

## Секреты и границы безопасности

Не передавайте секреты аргументами командной строки. `configure` в локальном TTY вводит новый ключ скрыто и сохраняет его в `secrets.json` по file reference; либо можно передать только имя environment variable через `--secret-env NAME`. Явное `--reuse-secret-ref FIELD` выбирает уже имеющуюся ссылку в config. На POSIX приватные файлы создаются с mode `0600`; encryption не заявляется. На Windows защита зависит от ACL пользовательского каталога ОС, chmod не является доказательством ACL. Configure валидирует config/секрет до записи, атомарно заменяет файлы, не удаляет существующие secret keys и отказывает при symlink/unsafe mode. Отказ, некорректный input и отсутствие TTY оставляют config и secret files без изменений.

CLI не проверяет provider key сетевым вызовом и не подтверждает provider health. После изменения профиля результат сообщает `mcpReconnectRequired: true`; создайте новое MCP-соединение и заново запросите MCP `tools/list` method и `capabilities`. При неизменной конфигурации поле равно `false`. Configure сообщает `providerProbed: false` и не запускает ручной индекс; перезапуск watch-enabled владельца может возобновить его уже настроенную политику сверки и индексации. Профиль embedding, несовпадающий с существующим snapshot, может потребовать отдельный owner-approved reindex. Если изменение embedding profile затрагивает watch-enabled roots, до записи требуется явное разрешение на возможные индексирование и provider calls. При изменении другой capability конфигурация не включает или не меняет watch, но рестарт уже работавшего watch-enabled owner может возобновить его reconcile/index job; результат явно указывает эту возможность. Команда останавливает только проверенного текущего owner через его authenticated control channel и присоединяется к остановке; затем запускает тот же config owner. При ошибке restart она возвращает configured state отдельно от `ownerRestarted`.

Каталог владельца и БД должны располагаться вне индексируемых корней. Не копируйте их в проект. Сохраняйте резервную копию конфигурации и отдельную резервную копию каталога данных; восстановление выполняйте при остановленной службе, проверяя соответствие профиля/корня. CLI не очищает старые индексы и не удаляет неизвестные lock-файлы.

`mcp` подключает существующий локальный MCP-клиент к владельцу службы. `serve-remote --config PATH --policy PATH` (`v0.1.1`) запускает OAuth-защищённый MCP endpoint на loopback; внешний TLS proxy должен опубликовать его по policy resource URL. См. [полную настройку remote OAuth](mcp.md#удалённый-oauth-endpoint-v011). Она требует внешнего OIDC-совместимого провайдера входа, подписывающего JWT access tokens, и не является встроенной ChatGPT авторизацией.


## Удалённая OAuth-служба (`v0.1.1`)

Сначала создайте runtime-конфигурацию и отдельную JSON-политику. Задайте в ней публичный HTTPS `resource` с путём `/mcp`, адрес провайдера входа `issuer` и `jwksUrl`, порт loopback, точные origins браузерного клиента и grants по `subject`, `rootIds` и операциям. Затем запустите владельца:

```sh
zorya-search serve-remote \
  --config /etc/zorya-search/runtime.json \
  --policy /etc/zorya-search/remote-policy.json
```

Команда оставляет daemon на `127.0.0.1`; публикацию HTTPS выполняет настроенный владельцем reverse proxy. Не используйте `serve` и `serve-remote` одновременно с одним каталогом данных. Требования к issuer, JWT claims, PKCE `S256`, scopes и proxy приведены в [руководстве MCP](mcp.md#удалённый-oauth-endpoint-v011).

`v0.1.0` prerelease не содержит `serve-remote`; исторический локальный MCP с owner bearer описан в [архиве `v0.1.0`](https://github.com/zoomplus/zorya-search/releases/download/v0.1.0/zorya-search-0.1.0.tgz). Для актуальных команд используйте установленную [version-specific версию из README](../README.md); описание OAuth-архитектуры ниже относится к функции, впервые добавленной в `v0.1.1`.
