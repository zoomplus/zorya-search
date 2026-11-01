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
 L["searchCode(query, filters)"] --> M["Current identity / profile / dense availability"]
 M --> N["Lexical BM25"]
 M --> O["Optional code embedding → dense candidates"]
 N --> P["RRF → optional rerank"]
 O --> P
 P --> Q["CodeHit candidates"]
 Q --> R["readSource: проверить snapshot и content hash"]
 R --> S{"Источник актуален?"}
 S -->|"да"| T["Bounded source ranges"]
 S -->|"нет"| U["Stale/currentness refusal"]
 V["duplicates / symbols / references"] --> W["AST и статические связи с явным покрытием"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Нет current snapshot | `indexStatus` возвращает пустую identity; search/read отказывают как stale, а не выдают пустой успешный ответ. | `current`, `indexStatus`, `searchCode` |
| Явный lexical или отсутствующий/несовместимый профиль | Dense обходится; hybrid сообщает `degradedReason`. | `searchCode`, `denseReason`, `statusFrom` |
| HTTP embedding/rerank failure | Операция завершается ошибкой, без auto lexical fallback. | providers ports |
| Generation/source изменились | Не публиковать или не выдавать старые данные как current. | `indexRepository`, `readSource` |
| Symbol/reference найден | Статический AST/path resolution, не доказательство runtime-вызова. | `symbol-*`, `dependency-graph.ts` |
| Duplicate совпал | Возвращаются bounded groups и coverage/truncation counts. | `findDuplicateBodies` |

Профиль `voyageai/voyage-code-4` 1024d — необязательный конфигурационный preset; его выбор требует явного runtime config. Текущий legacy code profile не задаёт Voyage `input_type`; query-role change остаётся экспериментом. Необязательный `voyageai/rerank-2.5-lite` получает fusion-кандидатов и только меняет их порядок; место в списке не подтверждает истинность или корректность кандидата. Retrieval объединяет BM25 и optional dense ранги через RRF, затем может rerank. Предложенный reuse-context, который собирает существующие реализации, extension candidates, structural duplicate evidence и contracts/tests перед добавлением похожего кода, — **planned**. Нынешние search/duplicate/symbol API существуют, но такого автоматически собранного контекста не создают.

Действующие операции включают `indexRepository`, `searchCode`, `readSource`, `findCodeDuplicates`, `indexCodeSymbols`, `findCodeSymbols`, `findCodeReferences`, `traceCodeCalls`, `relatedCode`. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/index.ts), [`ranking.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/ranking.ts), [`duplicates.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/duplicates.ts), [`schema.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/schema.ts).
