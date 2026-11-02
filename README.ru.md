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

Публичный архив GitHub по-прежнему **`v0.1.6`**. Состояние этого репозитория — **кандидат релиза `v0.1.7`** на исходном коммите [`3be35fd`](https://github.com/zoomplus/zorya-search/tree/3be35fdbe69357a4bb0daf6203d9472b5c5a184d); он ещё не опубликован в GitHub Releases или npm. Кандидат включает отдельный project-text индекс, точные инструменты символов/references/статических вызовов, opt-in logical context и Jev-backed reuse, caller-selected web discovery по нескольким запросам и типизированное восстановление запроса чтения исходника. Описание кандидата не означает, что будущая ссылка или версия registry уже доступны.

Для доступного архива нужна Node.js `>=20.19.0`:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.6/zorya-search-0.1.6.tgz
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

`client-config` только печатает примеры; владелец отдельно регистрирует один из них в выбранном клиенте и выдаёт разрешения. Индексация запускается явно, если владелец не включил watch. См. [краткое руководство на русском](docs/getting-started.md), [английское руководство](docs/getting-started.en.md) и [матрицу возможностей](docs/capabilities.md).

## Пример SDK

Пример ниже в англоязычном [README](README.md#sdk-example) использует публичный SDK `v0.1.6`: локальный лексический поиск, проверку исходника и кандидатов дубликатов. Базу следует держать вне индексируемого репозитория. Лексический поиск не вызывает embedding provider.

## Документация

- [Начало работы на русском](docs/getting-started.md) · [на английском](docs/getting-started.en.md)
- [Возможности и границы релиза](docs/capabilities.md)
- [SDK](docs/sdk.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md)
- [Текст проекта и web discovery](docs/project-text.md)
- [Инструкции для клиентских агентов](docs/agent-clients.md)
- [Архитектура](docs/architecture.md) · [Потоки сервисов](docs/service-flows.md)
- [Jev classification и reuse](docs/jev-classification.md) · [Профили Voyage](docs/voyage-profiles.md)
- [Сравнение MCP и границы доказательств](docs/mcp-comparison.md)
- [История изменений](CHANGELOG.md) · [Навык поиска кода](skills/code-retrieval/SKILL.md) · [Навык web-поиска](skills/web-source-retrieval/SKILL.md)

**Статус:** проверки пакета и исходников не доказывают общее качество конечных ответов, поддержку hosted-клиентов, интеграцию Windows/игры/устройств, работу с live provider или полную приёмку программы. Контролируемое сравнение качества MCP показало отрицательный результат; его область и ограничения приведены в [отчёте сравнения](docs/mcp-comparison.md). Для многих задач достаточно обычного поиска и чтения файлов.

Лицензия MIT. См. [LICENSE](LICENSE).
