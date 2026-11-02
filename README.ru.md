# Zorya Search

**Локальный поиск по коду и тексту проекта для существующих SDK- и MCP-клиентов; embeddings, статические сведения о символах и web discovery включаются отдельно.**

**[Read in English](README.md)**

[![CI](https://github.com/zoomplus/zorya-search/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zoomplus/zorya-search/actions/workflows/ci.yml)
[![Лицензия MIT](https://img.shields.io/github/license/zoomplus/zorya-search)](LICENSE)
[![Node.js >=20.19](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933?logo=node.js&logoColor=white)](package.json)

Zorya Search помогает существующему приложению или агенту искать в разрешённом репозитории, читать актуальный исходник за найденным результатом и собирать ограниченные связанные данные. Подключите SDK из Node.js-приложения или предоставьте те же операции через MCP. Search возвращает кандидатов с identity источника и известными ограничениями; вызывающая сторона решает, когда искать, чему доверять и что делать дальше. Пакет не создаёт агентов, не редактирует файлы и не исправляет проект автоматически.

## Возможности

| Задача | Возможность |
| --- | --- |
| Найти и проверить код | По умолчанию лексический поиск; embeddings включаются отдельно; чтение исходника и контекст привязаны к repository, worktree и snapshot. |
| Изучить структуру | Точный поиск символов, статические references и call trace, кандидаты дубликатов и opt-in logical context. Статические данные не доказывают runtime-поведение. |
| Найти правила проекта | Отдельный opt-in индекс документации, правил и skills. Он не смешивает пространство индекса кода и knowledge storage. |
| Найти внешние источники | Caller-selected запросы Brave и ограниченное чтение страниц, если владелец настроил provider. Search не формирует дополнительные запросы. |
| Подключить клиента | Node.js SDK, локальный stdio/loopback MCP или удалённый MCP владельца с отдельно настроенным OAuth. |

Кодовый путь по умолчанию лексический. Необязательные профили: `voyageai/voyage-code-4` (1024 измерения) и `voyageai/rerank-2.5-lite` для кода, `voyageai/voyage-4-large` с разными ролями document/query для project text и независимый visual-профиль `voyageai/voyage-multimodal-3.5`. Это конфигурационные варианты, а не defaults. Rerank только переставляет кандидатов. Classification и reuse context используют закреплённую модель Jev `typesafe/jev-1.14`; неподдерживаемая модель classifier отклоняется, а не подменяется молча.

## Доступность релиза

Текущий source candidate — **`v0.1.10`** (`zorya-search`). Он добавляет доверенные подсказки MCP о доступности capability и команду `configure` с явным согласием владельца для семи независимых ролей. Агент может предложить настройку только нужной, ещё не настроенной capability; Search не включает её сам и не заменяет вызывающего агента. Чтение публичного URL и лексический project-text поиск не требуют ключа. Brave discovery использует ключ Brave Search; профили моделей Voyage и Jev — ключ OpenRouter. После изменения профиля переподключите MCP и обновите список tools и capabilities. Configure не проверяет провайдера; рестарт уже работающего watch-владельца может продолжить его существующую политику индексации. См. руководства [MCP](docs/mcp.md), [CLI](docs/cli.md) и [клиентских агентов](docs/agent-clients.md).

Примеры установки версии условны: сначала проверьте, что registry и release page содержат точную версию `zorya-search@0.1.10` и tag `v0.1.10`. Требуется Node.js `>=20.19.0`; см. краткие руководства [на русском](docs/getting-started.md) и [на английском](docs/getting-started.en.md).

После проверки в обоих источниках установите точную версию и создайте профиль:

```sh
npm install --save-exact zorya-search@0.1.10
npx --yes zorya-search@0.1.10 setup --root .
npx --yes zorya-search@0.1.10 client-config
```

`client-config` печатает инструкции для регистрации MCP, но не устанавливает и не регистрирует сервер в клиенте. Владелец отдельно выбирает команду и выдаёт разрешения. Индексация запускается явно, если владелец не включил watch.
## Пример SDK

Пример ниже в англоязычном [README](README.md#sdk-example) использует лексические SDK API, сохранённые в candidate `v0.1.10`, для проверки исходника и кандидатов дубликатов. Используйте импорты `zorya-search` и его subpaths. Базу следует держать вне индексируемого репозитория. Лексический поиск не вызывает embedding provider.

## Документация

- [Начало работы на русском](docs/getting-started.md) · [на английском](docs/getting-started.en.md)
- [Возможности и границы релиза](docs/capabilities.md)
- [SDK](docs/sdk.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md)
- [Текст проекта и web discovery](docs/project-text.md)
- [Инструкции для клиентских агентов](docs/agent-clients.md)
- [Архитектура](docs/architecture.md) · [Потоки сервисов](docs/service-flows.md)
- [Jev classification и reuse](docs/jev-classification.md) · [Профили Voyage](docs/voyage-profiles.md)
- [Представление результата MCP и нативные доказательства](docs/mcp-result-presentation.md)
- [Сравнение MCP и границы доказательств](docs/mcp-comparison.md)
- [История изменений](CHANGELOG.md) · [Навык поиска кода](skills/code-retrieval/SKILL.md) · [Навык web-поиска](skills/web-source-retrieval/SKILL.md)

**Статус:** проверки пакета и исходников не доказывают общее качество конечных ответов, поддержку hosted-клиентов, интеграцию Windows/игры/устройств, работу с live provider или полную приёмку программы. Четыре прогона представления stdio ограничены транспортом и сохранением source в Codex CLI 0.163.0; они не доказывают качество ответов или экономию на оплате. Отрицательное контролируемое сравнение качества MCP и его ограничения приведены в [отчёте сравнения](docs/mcp-comparison.md). Для многих задач достаточно обычного поиска и чтения файлов.

Лицензия MIT. См. [LICENSE](LICENSE).
