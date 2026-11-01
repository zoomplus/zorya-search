# Runtime: конфигурация и владение операциями

Runtime валидирует config/request, выбирает включённые capabilities и владеет root, jobs, watchers и активными operations. SDK/CLI/MCP вызывают runtime; библиотека не управляет агентами клиента.

```mermaid
flowchart TD
 A["SDK / CLI / MCP request"] --> B["parseRuntimeConfig + strict request schema"]
 B --> C{"Root разрешён и capability включена?"}
 C -->|"нет"| D["Validation / permission / capability refusal"]
 C -->|"да"| E["Operation owner + AbortController"]
 E --> F{"Запрошенная операция"}
 F -->|"index"| G["Один job/root; per-root lock + checkpoints"]
 F -->|"read/search"| H["Code / project-text / web / classify / visual"]
 F -->|"status"| I["Bounded control pool → точный status DTO"]
 G --> J{"Generation всё ещё current?"}
 J -->|"да"| K["Publish current snapshot/job state"]
 J -->|"нет"| L["Cancel/stale; не публиковать"]
 H --> M["Typed bounded response или точная ошибка"]
 N["close/shutdown"] --> O["Stop admission; отменить owned jobs/watch/operations"]
 O --> P["Дождаться физического завершения и drain"]
 P --> Q["Закрыть owned resources; borrowed DB оставить владельцу"]
 R["CLI readiness: 15s текущий startup"] --> S["Основной текущий контракт"]
 subgraph diag["SEPARATE DIAGNOSTIC BRANCH — не текущий main"]
  T["Diagnostic readiness proposal"] -. "не main path" .-> U["Не описывает текущее startup behavior"]
 end
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Неизвестный root или strict schema invalid | Отказ до dispatch. | `requests.ts`, `openSearchRuntime` |
| `projectText` отсутствует | Capability отключена, config не меняется автоматически. | `config.ts`, `capabilities()` |
| Повторный index того же root | Переиспользование активного job; cancel требует точные `rootId`/`jobId`. | `startIndexing`, `cancelIndexing` |
| Generation устарел | Не публиковать старое состояние. | `indexRepository` |
| Shutdown | Сначала cancel и физический drain, затем owned DB close. | runtime close path |
| CLI startup readiness | Сейчас 15 секунд; отдельная diagnostic ветка не основной путь. | CLI startup caller |

Schemas: `runtime/requests.ts`; capabilities, provider profiles и secret references: `runtime/config.ts`. См. [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/runtime/index.ts), [`config.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/runtime/config.ts), [`requests.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/runtime/requests.ts).
