# Внутренние карты потоков сервисов

Карты показывают текущие границы между вызывающим клиентом, runtime, provider-портами и storage, включая важные ветви ошибок. Они описывают кодовые потоки, а не качество результатов, deployment или включение capability в конкретный архив.

| Слой | Карта | Поток |
| --- | --- | --- |
| Core | [Поиск, cache и collection](../src/core/README.md) | `executeSearch` связывает cache, web, embedding и repository. |
| Storage | [Владение и repository](../src/storage/README.md) | Owned embedded DB и заимствованные adapters. |
| Code | [Индекс, retrieval и freshness](../src/code/README.md) | Snapshot chunks, BM25/dense, RRF, rerank, source verification. |
| Project Text | [Docs, rules, skills](../src/project-text/README.md) | Отдельный namespace и explicit capability/profile. |
| Providers | [Models, Brave и Jev Decisions](../src/providers/README.md) | В source candidate `0a584e6` classification закреплён на Jev Decisions; runtime разделяет этот port с reuse context. |
| Context | [Code/web/reuse context](../src/context/README.md) | Чтение snapshot, запросы клиента, Jev-оценка файлов и symbols, совместные чтения и явное partial coverage. |
| Runtime | [Config, roots, lifecycle](../src/runtime/README.md) | Strict schema, capabilities, jobs и graceful drain. |
| MCP | [Tools и grants](../src/mcp/README.md) | Existing client → grant → schema → runtime. |
| Daemon | [HTTP transport](../src/daemon/README.md) | Access, request ownership, cancellation и drain. |
| Visual | [Opt-in references](../src/visual/README.md) | Только caller-provided data и отдельный profile. |

## Профили embeddings и rerank

Следующие имена — необязательные конфигурационные presets/examples. Они не выбираются автоматически как package defaults; capabilities включаются конфигурацией владельца.

| Путь | Необязательный профиль | Вход/результат |
| --- | --- | --- |
| Code | `voyageai/voyage-code-4` (1024d) | Embeddings добавляют dense-кандидатов к lexical; текущий legacy code profile не задаёт Voyage `input_type`. Query-role изменение остаётся экспериментом. |
| Project text | `voyageai/voyage-4-large` (1024d) | `document` при индексации и `query` при поиске; отдельный namespace и явное включение `projectText`. |
| Rerank | `voyageai/rerank-2.5-lite` | Необязательная перестановка полученных кандидатов в поддерживаемых путях; ранжирование не устанавливает истинность или корректность источника. |
| Visual | `voyageai/voyage-multimodal-3.5` (1024d) | Отдельный opt-in профиль для переданных клиентом references/images. |

Настройки клиента и различие пространств описаны в [профилях Voyage](voyage-profiles.md); конкретные потоки приведены в [Code](../src/code/README.md), [Project Text](../src/project-text/README.md) и [Visual](../src/visual/README.md).

## Легенда и границы

Статус схем:

| Обозначение | Смысл |
| --- | --- |
| `SOURCE CANDIDATE 0a584e6` | Проверяемый source-кандидат: Jev Decisions, classification и reuse integration. Доступный GitHub archive — `v0.1.6`, этот код его не содержит; npm-пакет не опубликован и полная приёмка не завершена. |
| `planned` / пунктир | Предлагаемая будущая связь без доступного интегрированного API. |

- Сплошные стрелки внутри рамки описывают статус этой рамки, включая отказные и error paths; пунктирные стрелки зарезервированы для явно обозначенных planned-схем.
- Диаграммы используют реальные функции/типы, а не предполагают отдельные службы.
- В code/core provider HTTP failure остаётся ошибкой; web-context может вернуть lexical passages как partial result, сохранив embedding/rerank stage error. Отсутствие/несовместимость профиля — отдельная ветка.
- Excerpts, scores и classification — недоверенные evidence. Вызывающий агент проверяет источник и сам принимает решение; автоматического изменения кода нет.
- Web — публичный HTTP acquisition, не browser automation; дополнительные запросы выбирает вызывающая сторона.
- Source candidate `0a584e6` подключает Jev к runtime classification и opt-in reuse context. Code index embeddings и reranking остаются отдельным необязательным путём; Jev не выбирает embedding/rerank профиль и не создаёт запросы для клиента. Смотрите [руководство Jev](jev-classification.md), [Providers](../src/providers/README.md), [Context](../src/context/README.md) и [Code](../src/code/README.md).
- Новые source capabilities отсутствуют в доступном GitHub archive `v0.1.6`; npm-пакет не опубликован.

При изменении поведения, контракта, ownership или error branch обновляйте соответствующую диаграмму и таблицу решений. Не копируйте сюда устаревающие status tables: эта страница только маршрутизирует к модульным картам.
