# Локальный bridge рабочего пространства

> **Статус:** это описание source candidate `v0.1.11`. Кандидат не опубликован и не развёрнут. Публичный web-only target `https://startzorya.com/mcp/search` и частный workspace target `https://startzorya.com/mcp/search/workspace` — предполагаемые значения конфигурации, а не работающие адреса.

Bridge добавляет локальный stdio MCP-клиент к существующему Search через отдельный HTTPS endpoint владельца. Он сохраняет MCP-инструменты и их контракты Search; меняется транспорт и способ привязки проекта. Обычный ChatGPT не получает доступ к файлам компьютера и не получает копию частного проекта. Публичный web-only MCP target изолирован от частного workspace target.

## Границы доступа

- Локальный `zorya-search-bridge mcp` привязывается к фактическому `process.cwd()` процесса и per-call native conversation metadata. В проверенном Linux Codex CLI сценарии `-C /absolute/project/path` задавал каталог дочернего MCP процесса. В конфигурацию MCP не записывается `cwd`; `PWD`, `CODEX_THREAD_ID`, каталог установки и каталог сервера не используются как запасной root или conversation identity.
- Локальный процесс перечисляет допустимые исходники и отправляет изменившиеся байты только после явного `index_repository`, `start_indexing`, `index_code_symbols`, `index_project_text` или отдельной операции синхронизации. Синхронизация сама по себе не запускает индексирование, embedding, reranking или другой provider-вызов. После передачи bridge пересылает исходный вызов существующему Search runtime.
- Обычный ChatGPT не подключается к локальному bridge и не видит workspace-файлы. Если владелец отдельно настроит публичный endpoint, для него предполагается только keyless `web:{}` runtime profile и `web` grant: существующие публичные web-source инструменты, без `read`/`index` grants, project roots или данных проекта.
- Частный workspace endpoint предполагает отдельные client ID, machine credential и CIDR allowlist. Он не реализует login, signup, OAuth или регистрацию пользователя. Профили provider и их ключи остаются на стороне Search runtime и не копируются клиенту.

Внешние адреса выше требуют настройки владельцем TLS proxy и точного `resource`/Host. `serve` сам слушает только loopback; команда не создаёт публичный адрес, сертификат или proxy. Отдельный target не означает, что он развернут или доступен.

## Поток данных

1. MCP-хост запускает локальный `mcp` процесс с выбранным проектом в качестве текущего каталога. Для Codex CLI проверенный сценарий использовал `-C /absolute/project/path`; конфигурация не фиксирует путь.
2. Для каждого вызова adapter проверяет native conversation ID и canonical текущий каталог, затем формирует workspace identity из client ID и пути проекта. Ошибка или конфликт identity приводит к типизированному отказу.
3. `capabilities`, `list_roots`, web/classify/visual, status и cancel используют source-free вызовы. Они не сканируют и не передают файлы проекта.
4. Только перечисленные выше явные index-команды сканируют ограниченный workspace, передают изменившиеся файлы HTTPS chunks и подтверждают новый snapshot. Затем adapter вызывает исходный MCP tool с исходными аргументами. Передача байтов не выполняет индексирование автоматически.
5. Code/project-text reads, search и context не запускают синхронизацию. Они требуют локального снимка с совпадающим manifest; изменение или удаление исходника приводит к stale refusal вместо скрытого поиска по старому снимку.

Частное серверное хранилище разделяет данные по client/workspace identity и хранит центральную копию источника вместе с Search runtime data. Локальный bridge не открывает базу данных и не подключает provider. Возвращённые Search данные и исходный текст остаются недоверенными: вызывающий агент сам проверяет их и решает, как использовать.

Conversation identity также ограничивает контроль фоновых jobs. `index_status` и `cancel_indexing` не требуют повторной отправки файлов; отмена относится только к принадлежащему этому разговору job. Если канал обрывается до подтверждения результата, ответ явно сообщает `settlement: "unconfirmed"`; потерянное подтверждение commit дополнительно сообщает `publication: "unconfirmed"`. Это означает, что клиент не знает итог операции: флаг не подтверждает ни откат, ни физическое завершение удалённой работы.

В ответах bridge добавляет provenance только в `_meta["zorya-search/bridge"]`. Для project calls `analytical_snapshot` содержит серверные `generation`/`manifestHash` и `scope`; adapter отдельно указывает `origin: "bound_current_workspace"`, `localVerification: "manifest_matched"` и `localManifestHash` после локальной проверки исходников. Локальный hash подтверждает совпадение проверенной текущей копии; серверные `generation` и hash идентифицируют центральный analytical snapshot. MCP request `rootId: "workspace"` — фиксированный логический root, а поле результата `identity.root` содержит абсолютный путь центрального server mirror. Ни одно из этих значений не является локальным путём компьютера. Source-free вызовы помечаются `localVerification: "not_performed"`. При несовпадении верните stale refusal и обновите данные только отдельной явной index-командой; read/search сам не запускает sync.

Обычные MCP tool results сохраняют исходные `structuredContent`, `content` (в том числе image blocks), `isError` и recovery fields. Protocol errors, нормализованные локальным MCP SDK, возвращаются как `isError: true` с сохранёнными numeric code/message/data в JSON-тексте и `structuredContent`; bridge provenance остаётся в зарезервированном `_meta`.

## Установка и клиентская конфигурация

Требуется Node.js `>=20.19.0`. Команды относятся к source candidate и пока не устанавливаются из опубликованного npm-релиза. До публикации запускайте собранный entry-файл. После фактической публикации версии `0.1.11` и её проверки в registry установите её и зарегистрируйте stdio MCP:

```sh
npm install -g zorya-search@0.1.11
zorya-search-bridge client-config --config /absolute/path/outside-project/client.json
codex mcp add zorya-search-bridge -- zorya-search-bridge mcp --config /absolute/path/outside-project/client.json
codex mcp list
```

Если установка выполняется до доступности версии в registry, не используйте эту команду как подтверждение публикации: можно запустить собранный `entry.js` через `node /absolute/path/to/zorya-search/dist/bridge/entry.js ...`. `--config PATH` обязателен для `mcp`, `client-config` и `serve`. `client-config` проверяет конфигурацию и печатает generic MCP JSON, Codex TOML и descriptors для registry `npx --yes --package zorya-search@<package-version> zorya-search-bridge mcp --config PATH` и абсолютного Node.js entry текущей установки. Для Codex TOML скопируйте `codexToml` или `codexInstalledToml` в `~/.codex/config.toml`; при env credential используйте сгенерированный TOML, который передаёт только имя переменной через `env_vars`. Descriptor включает `startup_timeout_sec = 30` и `tool_timeout_sec = 900`, но не добавляет `cwd`, настройки модели, sandbox/approval или автоматическое разрешение. Не передавайте секрет через `codex mcp add --env`: используйте private credential file или выводимый TOML с именем env-переменной.

Пример client config; замените endpoint, UUID и локальные пути значениями вашей установки:

```json
{
  "schemaVersion": 1,
  "endpoint": "https://search.example.invalid/mcp/search/workspace",
  "clientId": "<stable-client-uuid>",
  "stateDir": "/absolute/path/outside-project/zorya-bridge-state",
  "credential": { "kind": "file", "path": "/absolute/private/path/bridge-token" },
  "allowedDocumentPaths": [".cursor/rules/search-scope.mdc"],
  "excludedPaths": ["artifacts/**", "coverage/**"]
}
```

Создайте случайный `clientId` один раз для каждого устройства и сохраните его стабильным; для генерации UUID используйте `node -e 'console.log(require("node:crypto").randomUUID())'`. Не копируйте один UUID в несколько клиентов. `stateDir` обязателен, должен быть абсолютным и находиться вне выбранного workspace. Credential задаётся только именем environment variable или путём к отдельному приватному credential file; в конфигурацию и MCP descriptor не помещайте secret value. Файлы credential должны быть regular files, без symlink; на POSIX ожидается режим без group/other доступа. Это не encryption.

Для создания одноразового bearer-файла без вывода содержимого запустите следующий Node.js фрагмент с новым абсолютным путём. Укажите этот путь в клиенте через `credential: { "kind": "file", "path": "..." }`. Фрагмент пишет credential с режимом `0600` и печатает только SHA-256 digest для server config:

```sh
node --input-type=module -e 'import { randomBytes, createHash } from "node:crypto"; import { writeFileSync } from "node:fs"; const token = randomBytes(32).toString("base64url"); writeFileSync(process.argv[1], token, { flag: "wx", mode: 0o600 }); console.log(createHash("sha256").update(token).digest("hex"));' /absolute/private/path/bridge-token
```

Не открывайте, не печатайте и не передавайте raw credential в prompt, аргументах MCP или логе. На Windows установите эквивалентный ACL только для нужного пользователя; POSIX `mode` сам по себе не задаёт Windows permissions.

Без `allowedDocumentPaths` документы не передаются. Для документации, `.md`, `.mdx`, `.mdc` и разрешённых `.cursor/rules` путей задайте явный список; исходники кода остаются отдельными от project-text индекса. `excludedPaths` — дополнительные механические исключения, максимум 128 значений. Не добавляйте в allowlist секреты или настройки credentials. Известные secret patterns блокируются отдельно, но эта проверка не является полной гарантией обнаружения всех секретов.

## Серверная конфигурация

`zorya-search-bridge serve --config PATH` принимает отдельный `BridgeServerConfig`, а не конфигурацию legacy CLI и не файл для `zorya-search configure`. Этот режим всегда требует отдельную machine credential и client policy; наличие `web` grant не превращает его в анонимный публичный сервер. Храните `dataDir` и server config вне передаваемых проектов. Укажите loopback `bindHost`, HTTPS `resource`, разрешённые origins, clients, grants, CIDR и при необходимости `runtimeTemplate` профили Search. Например:

```json
{
  "schemaVersion": 1,
  "resource": "https://search.example.invalid/mcp/search/workspace",
  "bindHost": "127.0.0.1",
  "port": 0,
  "dataDir": "/srv/private/zorya-search-bridge",
  "trustedProxyCidrs": [],
  "allowedOrigins": ["https://client.example.invalid"],
  "clients": [{
    "clientId": "<same-stable-client-uuid>",
    "tokenSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "clientCidrs": ["203.0.113.17/32"],
    "grants": ["read", "index"],
    "allowedDocumentPaths": [".cursor/rules/search-scope.mdc"],
    "excludedPaths": ["artifacts/**"]
  }]
}
```

Пример содержит фиктивные адреса и digest; замените их точными значениями конфигурации. Укажите сгенерированный выше SHA-256 digest; raw credential хранится только у клиента в private file или environment. `clientCidrs` ограничивает сетевых клиентов; если перед сервером стоит proxy, добавляйте в `trustedProxyCidrs` только адреса proxy под вашим контролем. Не используйте широкие CIDR. `grants` выбирайте минимально нужными: только `web` для web-only режима; для workspace нужны отдельные `read` и/или `index` grants.

`serve` запускает loopback HTTP server и печатает JSON ready event с фактическими `host`, `port` и `resource`. `port: 0` выбирает временный локальный порт; внешний proxy должен быть настроен отдельно и направлять запросы к фактическому listener. Команда не публикует сервер в интернет. Для предполагаемого анонимного публичного web-only target используйте отдельную команду `zorya-search serve-remote-ip --config /absolute/path/runtime.json --policy /absolute/path/ip-policy.json` и выдайте только `operations: ["web"]`; runtime всё равно требует внутренний пустой root, не связанный с проектными данными. Не используйте bridge `serve` для публичного anonymous target.

## Ограничения передачи и проверенные границы

Максимум одной передачи: 5 000 файлов, 1 000 000 байт на файл, 50 000 000 байт суммарно, 128 000 байт на chunk и до 5 391 chunks. Превышение лимитов или изменение исходников приводит к отказу; partial corpus не выдаётся как актуальный snapshot. Сам отзыв прежнего document allowlist не удаляет уже опубликованные server-side данные, и сохранённое состояние восстанавливается после перезапуска; текущие source-consuming calls для отозванных путей откажут. При следующей явной синхронизации опубликованное дерево может быть заменено актуальным разрешённым набором; это не обещание хранить историю snapshots. Центральный source mirror и база Search — данные сервера; bridge только читает текущую рабочую копию и не редактирует файлы проекта.

Нативная проверка охватывала только Linux `codex-cli 0.163.0`: в двух изолированных запусках `-C` задавал различные cwd дочернему MCP процессу, а per-call native thread metadata приходила в настоящем `tools/call`. `roots/list` в проверенном клиенте не поддерживался. Это не подтверждает Codex Desktop, другие версии, Windows/macOS или поведение реального spawned subagent. Локальная компонентная фикстура связала MCP adapter, HTTP client, реальный HTTP server и PGlite; она не проверяла TLS proxy, production service или удалённый пользовательский deployment.
