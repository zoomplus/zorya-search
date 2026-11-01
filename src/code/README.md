# Code: индекс и структурный анализ

`createCodeIndex` связывает code chunks со snapshot repository/worktree. Индексация использует bounded enumeration, AST-aware chunking, checkpoints и staging; current snapshot меняется только при совпадении поколения.

```mermaid
flowchart TD
 A["Корень + IndexOptions"] --> B["Identity, fingerprint, лимиты и exclusions"]
 B --> C["Безопасное перечисление и чтение файлов"]
 C --> D["AST-aware chunks"]
 D --> E{"Совпали hash, chunker и embedding profile?"}
 E -->|"да"| F["Переиспользовать durable chunks"]
 E -->|"нет"| G["Создать lexical chunks и допустимые embeddings"]
 F --> H["Resume checkpoints → staging snapshot"]
 G --> H
 H --> I{"Generation и source ещё current?"}
 I -->|"да"| J["Атомарно опубликовать current snapshot"]
 I -->|"нет"| K["Stale generation: не публиковать"]
 L["searchCode(query, caller filters)"] --> M{"Lexical mode или dense usable?"}
 M -->|"lexical / missing or incompatible profile"| N["No dense ranks; hybrid may report degradedReason"]
 M -->|"hybrid + compatible profile"| O["Embed query separately → dense candidates"]
 M --> P["BM25 lexical candidates (always)"]
 N --> R["RRF: lexical ranks + available dense ranks"]
 P --> R
 O --> R
 R --> S{"Hybrid + rerank configured + matching profile + no degradation?"}
 S -->|"yes"| T["Rerank changes ordering only"]
 S -->|"no"| U["Keep lexical or fused order"]
 O -->|"embedding HTTP failure"| X["Propagate operation error; no silent lexical fallback"]
 T -->|"rerank HTTP failure"| X
 T --> V["CodeHit candidates"]
 U --> V
 V --> W["readSource: verify snapshot + content hash"]
 W --> AA{"Source current?"}
 AA -->|"yes"| AB["Bounded source ranges"]
 AA -->|"no"| AC["Stale/currentness refusal"]
 AD["duplicates / symbols / references"] --> AE["AST and static links with explicit coverage"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Нет current snapshot | `indexStatus` возвращает пустую identity; search/read отказывают как stale, а не выдают пустой успешный ответ. | `current`, `indexStatus`, `searchCode` |
| Lexical mode или отсутствующий/несовместимый профиль | BM25 доступен; dense обходится, hybrid сообщает `degradedReason`; Code rerank требует hybrid, matching profile и отсутствия degradation. | `searchCode`, `denseReason`, `statusFrom`, `ranking.ts` |
| HTTP embedding/rerank failure | Операция завершается ошибкой, без auto lexical fallback. | providers ports |
| Generation/source изменились | Не публиковать или не выдавать старые данные как current. | `indexRepository`, `readSource` |
| Symbol/reference найден | Статический AST/path resolution, не доказательство runtime-вызова. | `symbol-*`, `dependency-graph.ts` |
| Duplicate совпал | Возвращаются bounded groups и coverage/truncation counts. | `findDuplicateBodies` |

Профиль `voyageai/voyage-code-4` 1024d — необязательный конфигурационный preset; его выбор требует явного runtime config. Текущий legacy code profile не задаёт Voyage `input_type`; query-role change остаётся экспериментом. Необязательный `voyageai/rerank-2.5-lite` получает fusion-кандидатов и только меняет их порядок; место в списке не подтверждает истинность или корректность кандидата. AST chunks, symbols, references и duplicate groups — структурные/текстовые evidence, не вывод Jev.

В source candidate `0a584e6` необязательный `createReuseContext` связывает существующий индекс кода с Jev. Схема показывает границы этой опции:

```mermaid
flowchart LR
 A["Запрос клиента + разрешённый root"] --> B["Поиск кода / факты графа в одном snapshot"]
 B --> C["Фрагменты с хешами + факты о символах"]
 C --> D{"Общий Jev port доступен?"}
 D -->|"да"| E["Noul оценка файлов + native Choice символов"]
 D -->|"нет / invalid"| F["unassessed / unavailable"]
 E --> G["Ограниченные кандидаты + omissions / coverage"]
 F --> G
 G --> H["Клиент проверяет исходники/тесты/контракты и принимает решение"]
```

Reuse не индексирует проект заново, не меняет embedding/rerank профиль и не редактирует код. По умолчанию он выбирает не более 24 файлов-кандидатов, ограничивает текст контекста 48 000 символами и операцию 60 секундами; неполное покрытие и omissions входят в ответ. Общий источник сведений об API и миграции — [руководство Jev](../../docs/jev-classification.md). Эта функция доступна только в исходниках: archive `v0.1.6` её не содержит.

Symbol metadata учитывает настроенное `maxFiles` code index при построении, чтении и проверке актуальности. Значение по умолчанию остаётся 5 000, а заданный предел до 20 000 не подменяется скрытой границей 5 000 при обработке symbols. Неподдерживаемые типы файлов и неразрешённые статические связи остаются в partial coverage; `complete` не означает полноту runtime-графа.

Embeddings и reranking — самостоятельные необязательные retrieval-порты. Jev оценивает смысл запроса и кандидатов только в путях reuse/classification; он не выбирает retrieval profile и не доказывает истинность или безопасность найденного кода.

Действующие операции включают `indexRepository`, `searchCode`, `readSource`, `findCodeDuplicates`, `indexCodeSymbols`, `findCodeSymbols`, `findCodeReferences`, `traceCodeCalls`, `relatedCode`. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/index.ts), [`ranking.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/ranking.ts), [`duplicates.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/duplicates.ts), [`schema.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/schema.ts).
