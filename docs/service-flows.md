# Внутренние карты потоков сервисов

Карты показывают текущие границы между вызывающим клиентом, runtime, provider-портами и storage, включая важные ветви ошибок. Они описывают кодовые потоки, а не качество результатов, deployment или включение capability в конкретный архив.

| Слой | Карта | Поток |
| --- | --- | --- |
| Core | [Поиск, cache и collection](../src/core/README.md) | `executeSearch` связывает cache, web, embedding и repository. |
| Storage | [Владение и repository](../src/storage/README.md) | Owned embedded DB и заимствованные adapters. |
| Code | [Индекс, retrieval и freshness](../src/code/README.md) | Snapshot chunks, BM25/dense, RRF, rerank, source verification. |
| Project Text | [Docs, rules, skills](../src/project-text/README.md) | Отдельный namespace и explicit capability/profile. |
| Providers | [Models, Brave и Jev prototype](../src/providers/README.md) | Текущий OpenRouter classifier; Jev ветка только planned/experimental. |
| Context | [Code/web context](../src/context/README.md) | Snapshot reads, client queries, shared reads, partial errors. |
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

- Сплошные стрелки показывают текущий код, включая отказные и error paths. Пунктирные стрелки используются только внутри явно подписанных planned/experimental схем; они не merged и не production capability.
- Диаграммы используют реальные функции/типы, а не предполагают отдельные службы.
- В code/core provider HTTP failure остаётся ошибкой; web-context может вернуть lexical passages как partial result, сохранив embedding/rerank stage error. Отсутствие/несовместимость профиля — отдельная ветка.
- Excerpts, scores и classification — недоверенные evidence. Вызывающий агент проверяет источник и сам принимает решение; автоматического изменения кода нет.
- Web — публичный HTTP acquisition, не browser automation; дополнительные запросы выбирает вызывающая сторона.
- Jev Decision API и assembled reuse-context не являются текущим production flow. Смотрите [Providers](../src/providers/README.md) и [Code](../src/code/README.md).
- Новые source capabilities могут отсутствовать в опубликованном npm archive `v0.1.6`; package inclusion проверяется отдельно.

При изменении поведения, контракта, ownership или error branch обновляйте соответствующую диаграмму и таблицу решений. Не копируйте сюда устаревающие status tables: эта страница только маршрутизирует к модульным картам.
