# Zorya Search

`@zorya/search` — SDK и MCP-сервис поиска по разрешённым репозиториям и внешним источникам. Его вызывает существующее приложение или агент, который сам выбирает, когда искать и как проверить результат. Search возвращает источники и кандидаты; он не меняет код, prompt, модель, память или настройки клиента.

## Релиз и установка

Требуется Node.js `>=20.19.0`. Установите закреплённый архив из GitHub `v0.1.3` как точную зависимость проекта, чтобы он сохранялся в `package.json` и lockfile, затем создайте конфигурацию для текущего корня:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.3/zorya-search-0.1.3.tgz
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

Команда `client-config` только печатает варианты конфигурации: регистрацию MCP в Codex или другом клиенте нужно выполнить отдельно. После подключения клиенту отдельно выдаются нужные разрешения; индексацию также запускают явно командой `npm exec -- zorya-search index`. Разрешение использовать модели и передача им кода включаются отдельно. Эта инструкция сохраняет архив из GitHub конкретной версии как зависимость проекта; npm registry вариант `client-config` применим только после публикации соответствующей версии в npm.

Драйверы локальной и PostgreSQL базы входят в обычные зависимости, поэтому остаются доступны после `npm install`, `npm ci` и `npm ci --omit=optional`. PDF-парсер остаётся необязательным. Импорт SDK не загружает движок базы: storage-модули импортируются только при создании соответствующего хранилища.

Исторический [GitHub prerelease `v0.1.0`](https://github.com/zoomplus/zorya-search/releases/download/v0.1.0/zorya-search-0.1.0.tgz) предназначался для локального MCP с owner bearer и не включал готовую OAuth policy/CLI службу. `serve-remote` впервые появился в `v0.1.1`; детали версии и соответствующие ограниченные проверки описаны в [руководстве удалённого MCP](docs/mcp.md). Установка пакета не подключает Search к чату автоматически.

По умолчанию поиск лексический и не обращается к моделям. Для code-профиля задайте ключ OpenRouter в окружении процесса владельца; для Brave — `BRAVE_SEARCH_API_KEY`:

```sh
npm exec -- zorya-search setup --root . --code-env OPENROUTER_API_KEY --web-env BRAVE_SEARCH_API_KEY
```

Передавайте имена переменных, а не значения ключей. Настройка поискового профиля и подключение MCP-клиента — отдельные действия. См. [CLI](docs/cli.md), [MCP и удалённая служба](docs/mcp.md), [подключение клиентских агентов](docs/agent-clients.md) и [архитектуру](docs/architecture.md).

Лексический поиск не требует сетевого ключа. Для кода preset использует `voyageai/voyage-code-4` и `voyageai/rerank-2.5-lite`; поиск ссылок Brave не требует текстовой модели. Visual-поиск выключен по умолчанию и работает только с переданными клиентом references. Он не делает desktop capture.

## Удалённый MCP для чата и Codex

Версия `v0.1.1` добавляет `serve-remote`: daemon остаётся привязан к loopback, а владелец публикует `/mcp` через собственный TLS reverse proxy. Для авторизации владелец настраивает внешний OIDC-совместимый провайдер входа, который выдаёт подписанные JWT access tokens. Пакет не содержит IdP и не размещает службу. Подробная инструкция и конфигурации находятся в [руководстве удалённого MCP](docs/mcp.md).

После запуска hosted MCP подключается отдельно в интерфейсе нужного клиента. Для ChatGPT нужны доступная извне HTTPS-служба, её OAuth-настройка и разрешённый redirect URI, который показывает сама настройка ChatGPT; локальная проверка Codex не доказывает подключение к hosted ChatGPT. Официальные инструкции: [авторизация MCP](https://developers.openai.com/plugins/build/auth) и [подключение собственного MCP-сервера](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Руководства

- [Архитектура и границы продукта](docs/architecture.md)
- [SDK и exports](docs/sdk.md)
- [MCP, локальный daemon и удалённая OAuth-служба](docs/mcp.md)
- [CLI и локальная настройка](docs/cli.md)
- [Профили Voyage для code и visual](docs/voyage-profiles.md)
- [Навыки поиска по коду](skills/code-retrieval/SKILL.md) и [по web-источникам](skills/web-source-retrieval/SKILL.md)
- [Инструкции клиентским агентам](docs/agent-clients.md)

## Статус проверок

`v0.1.0` прошёл проверки, перечисленные в [журнале prerelease](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.0); они относятся только к этому неизменяемому архиву.

Для `v0.1.1` независимая TLS-проверка OAuth прошла с изолированным тестовым issuer, двумя сетевыми namespace, CLI из архива разработки и настоящим Codex CLI. Проверялись metadata discovery, PKCE, отказ для неверной подписи/issuer/audience/subject/scope/срока, ограничения root и чтение по TLS. Проверка не использовала публичный интернет или настоящий ChatGPT. Подключение из hosted ChatGPT, внешний IdP и пользовательский production deployment не квалифицированы.

MIT License. См. [LICENSE](LICENSE).
