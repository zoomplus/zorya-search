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

Планируемое автоматическое переиспользование существующего кода сейчас не подключено; пунктир показывает только proposed flow:

```mermaid
flowchart LR
 A["Caller request"] -.-> B["Code search / graph facts"]
 B -.-> C["Jev file/symbol Choices"]
 C -.-> D["Verify ranges + tests/contracts/duplicate evidence"]
 D -.-> E["Caller decides next action"]
```

Нынешние search/duplicate/symbol API существуют, но такого собранного контекста не создают. Caller сопоставляет typed choices с проверенными исходниками и решает, нужен ли код.

Действующие операции включают `indexRepository`, `searchCode`, `readSource`, `findCodeDuplicates`, `indexCodeSymbols`, `findCodeSymbols`, `findCodeReferences`, `traceCodeCalls`, `relatedCode`. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/index.ts), [`ranking.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/ranking.ts), [`duplicates.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/duplicates.ts), [`schema.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/code/schema.ts).
