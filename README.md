# Zorya Search

`@zorya/search` — SDK и MCP-сервис поиска по разрешённым репозиториям и внешним источникам. Его вызывает существующее приложение или агент, который сам выбирает, когда искать и как проверить результат. Search возвращает источники и кандидаты; он не меняет код, prompt, модель, память или настройки клиента.

## Релиз и установка

Требуется Node.js `>=20.19.0`. Установите `v0.1.1` в проект без глобальной установки:

```sh
npm install --no-save --no-package-lock https://github.com/zoomplus/zorya-search/releases/download/v0.1.1/zorya-search-0.1.1.tgz
npm exec -- zorya-search setup --root .
npm exec -- zorya-search index
npm exec -- zorya-search search --query "где обрабатывается запрос"
npm exec -- zorya-search client-config
```

`v0.1.0` доступен как [неизменяемый GitHub prerelease](https://github.com/zoomplus/zorya-search/releases/download/v0.1.0/zorya-search-0.1.0.tgz) для локального MCP с owner bearer; SDK этой версии также принимал переданный приложением `authorize` callback, но не включал готовую OAuth policy/CLI службу. `serve-remote` и новые provider-поля ошибок входят в `v0.1.1`. Пакет распространяется через GitHub archives с точным номером версии; установка не подключает Search к текущему чату автоматически.

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
