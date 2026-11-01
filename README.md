# Zorya Search

`@zorya/search` — SDK и MCP-сервис поиска по разрешённым репозиториям и внешним источникам. Его вызывает существующее приложение или агент, который сам выбирает, когда искать и как проверить результат. Search возвращает источники и кандидаты; он не меняет код, prompt, модель, память или настройки клиента.

## Быстрый старт

Требуется Node.js `>=20.19.0`.

Релиз `v0.1.0` доступен как GitHub prerelease и пока не опубликован в npm registry. Установите точный архив локально в проект без глобальной установки. Команды подходят для POSIX shell и PowerShell:

```sh
npm install --no-save --no-package-lock https://github.com/zoomplus/zorya-search/releases/download/v0.1.0/zorya-search-0.1.0.tgz
npm exec -- zorya-search setup --root .
npm exec -- zorya-search index
npm exec -- zorya-search search --query "где обрабатывается запрос"
npm exec -- zorya-search client-config
```

По умолчанию поиск лексический и не обращается к моделям. Для кода задайте ключ OpenRouter в окружении процесса владельца и включите профиль Voyage. Чтобы искать ссылки через Brave, аналогично задайте `BRAVE_SEARCH_API_KEY`. В настройке передавайте имена переменных, не их значения:

```sh
npm exec -- zorya-search setup --root . --code-env OPENROUTER_API_KEY --web-env BRAVE_SEARCH_API_KEY
```

`index` строит индекс текущего разрешённого корня, `search` ищет по коду, а `client-config` выводит параметры подключения MCP. Добавьте их в выбранный клиент и зарегистрируйте там инструменты. Установка не подключает Search к текущему чату автоматически. Для кода preset использует `voyageai/voyage-code-4` и `voyageai/rerank-2.5-lite`; поиск ссылок Brave не требует текстовой модели. Не передавайте ключ в аргументах команды, URL, prompt или журнале. [Пошаговая настройка CLI](https://github.com/zoomplus/zorya-search/blob/51f6bde764e54e9a8f3d9b89bb51b773ef226e11/docs/cli.md) · [подключение MCP-клиента](https://github.com/zoomplus/zorya-search/blob/51f6bde764e54e9a8f3d9b89bb51b773ef226e11/docs/mcp.md)

Для работы с исходниками пакета клонируйте репозиторий, выполните `pnpm install --frozen-lockfile`, затем `pnpm build`. Пример SDK с `mode: 'lexical'` и перечень доступных входов находятся в [справочнике SDK](https://github.com/zoomplus/zorya-search/blob/51f6bde764e54e9a8f3d9b89bb51b773ef226e11/docs/sdk.md). Лексический поиск не требует сетевого ключа.

Для MCP используйте отдельное руководство по [локальной службе и MCP-клиентам](https://github.com/zoomplus/zorya-search/blob/51f6bde764e54e9a8f3d9b89bb51b773ef226e11/docs/mcp.md). Сначала выберите репозитории, которые владелец сервиса разрешил индексировать. Подключение выполняется явно в настройках выбранного клиента. Установка пакета не подключает инструмент к текущему чату. Локальный SDK/MCP runtime и настроенный клиент — отдельные компоненты.

Dense code retrieval, rerank, web retrieval и visual retrieval настраиваются независимо. Без embedding профиля оставайтесь в lexical режиме. Для отправки кода, текста или изображения внешнему provider требуется осознанная настройка соответствующего клиента; ключи храните в защищённом окружении, не в аргументах процесса, URL, prompt или логах. Visual поиск выключен по умолчанию и работает только с переданными клиентом references. Он не делает desktop capture.

## Руководства

- [Архитектура и границы продукта](docs/architecture.md)
- [SDK и exports](docs/sdk.md)
- [MCP, локальный daemon и подключение клиента](docs/mcp.md)
- [CLI и локальная настройка](docs/cli.md)
- [Профили Voyage для code и visual](docs/voyage-profiles.md)
- [Навыки поиска по коду](skills/code-retrieval/SKILL.md) и [по web-источникам](skills/web-source-retrieval/SKILL.md)
- [Инструкции клиентским агентам](docs/agent-clients.md)

Ограничения текущих проверок перечислены ниже и в соответствующих руководствах этого пакета.

## Проверки текущего prerelease — 2026-11-01

Исходник релиза закреплён на [`51f6bde`](https://github.com/zoomplus/zorya-search/tree/51f6bde764e54e9a8f3d9b89bb51b773ef226e11). Полный набор Node 24 прошёл **221/221** тестов с PostgreSQL и изолированным PGlite. Hosted CI прошёл **8/8** jobs, включая Node 24 на Windows и Linux, PostgreSQL на Linux и обе проверки установленного пакета. Установка публичного GitHub-архива и проверки CLI/SDK прошли; подробности — в [workflow для этого commit](https://github.com/zoomplus/zorya-search/actions/runs/41272633879) и [странице релиза](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.0). Архив ещё не опубликован в npm registry.

В одном локальном HTTP MCP сценарии прошли 9 проверок discovery, чтения и контролируемых провайдеров; отдельно проверены чтение двух известных страниц без ключа Brave и **11/11** проверок установленного CLI с настоящим Codex и вторым MCP-клиентом. Живой поиск ссылок Brave не выполнялся. Это ограниченные проверки кандидата, а не оценка широкой релевантности или гарантия задержки. Шестипарный пилот на более раннем архиве завершился inconclusive для пары F без общего победителя. Windows-машина пользователя, Witcher, игра и микрофон не квалифицированы; полная приёмка остаётся незавершённой. Подробности — в [архитектурном обзоре](https://github.com/zoomplus/zorya-search/blob/51f6bde764e54e9a8f3d9b89bb51b773ef226e11/docs/architecture.md).

MIT License. См. [LICENSE](LICENSE).
