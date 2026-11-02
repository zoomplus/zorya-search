# Runtime: конфигурация и владение операциями

Runtime валидирует config/request, выбирает включённые capabilities и владеет root, jobs, watchers и активными operations. SDK/CLI/MCP вызывают runtime; библиотека не управляет агентами клиента.

В candidate `v0.1.7` (source `3be35fd`) runtime при включённом Jev создаёт один Decisions port для classification и reuse. Этот candidate не входит в GitHub archive `v0.1.6`; npm package ещё не опубликован. Подробности — в [руководстве Jev](../../docs/jev-classification.md).

```mermaid
flowchart TD
 A["SDK / CLI / MCP request"] --> B["parseRuntimeConfig + strict request schema"]
 B --> C{"Root разрешён и capability включена?"}
 C -->|"нет"| D["Validation / permission / capability refusal"]
 C -->|"да"| E["Operation owner + AbortController"]
 E --> F{"Запрошенная операция"}
 F -->|"index"| G["Один job/root; per-root lock + checkpoints"]
 F -->|"read/search"| H["Code / project-text / web / visual"]
 F -->|"classify"| HJ["Shared Jev Decisions port"]
 F -->|"get_reuse_context"| HR["Code index + shared Jev Decisions port"]
 F -->|"status"| I["Bounded control pool → точный status DTO"]
 G --> J{"Generation всё ещё current?"}
 J -->|"да"| K["Publish current snapshot/job state"]
 J -->|"нет"| L["Cancel/stale; не публиковать"]
 H --> M["Typed bounded response или точная ошибка"]
 HJ --> HU["classification result + usage ledger"]
 HR --> HU
 N["close/shutdown"] --> O["Stop admission; отменить owned jobs/watch/operations"]
 O --> P["Дождаться физического завершения и drain"]
 P --> Q["Закрыть reuse/code contexts → индексы → принадлежащую DB"]
 HU -->|"same provider calls"| US["usage().classification; не отдельный reuse counter"]
 R["CLI service start"] --> S["ensureOwner: canonical owner dir, descriptor, config fingerprint и MCP auth"]
 S --> T{"Уже есть matching authenticated owner?"}
 T -->|"да"| U["Вернуть его owner record и token"]
 T -->|"нет"| V["startup lock + принадлежащие запуску token/control files + unique nonce"]
 V --> W["Spawn detached child с nonce в env и IPC каналом"]
 W --> X["child_bootstrap"]
 X --> Y["runtime_import"]
 Y --> Z["runtime_start → startSearchDaemon"]
 Z --> AA["daemon_ready"]
 AA --> AB["control_listen"]
 AB --> AC["descriptor_write: owner.json"]
 AC --> AD{"За 15s найден descriptor с matching PID/token/control file и bearer-auth MCP list_roots?"}
 AD -->|"да"| AE["parent_authenticated локально; disconnect IPC, unref child, handoff"]
 W --> AF["Spawn error / phase failure / child exit / 15s timeout"]
 X --> AF
 Y --> AF
 Z --> AF
 AA --> AF
 AB --> AF
 AC --> AF
 AD -->|"нет"| AF
 AF --> AG["Остановить child, физически дождаться close"]
 AG --> AH["Очистить только owned token/control/descriptor/socket files"]
 AH --> AI["Безопасный OWNER_START_FAILED / OWNER_NOT_READY"]
 AI --> AJ["phase + elapsedMs + allowlisted cause/exit/signal; без raw text, paths и secrets"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Неизвестный root или strict schema invalid | Отказ до dispatch. | `requests.ts`, `openSearchRuntime` |
| `projectText` отсутствует | Capability отключена, config не меняется автоматически. | `config.ts`, `capabilities()` |
| `get_reuse_context` без обоих grants | MCP скрывает tool и возвращает `reuseContext: false`; handler проверяет capability до чтения/provider. | `mcp/server.ts` |
| Jev classification или reuse | Оба используют один port; usage и provider profile не дублируются. | `runtime/index.ts`, `decisions.ts` |
| Повторный index того же root | Переиспользование активного job; cancel требует точные `rootId`/`jobId`. | `startIndexing`, `cancelIndexing` |
| Generation устарел | Не публиковать старое состояние. | `indexRepository` |
| Shutdown | Сначала cancel и физический drain, затем owned DB close. | runtime close path |
| CLI startup | `ensureOwner` аутентифицирует matching owner или ждёт nonce-связанный child startup до 15 секунд; только matching PID/credentials/control descriptor и bearer-auth MCP readiness дают handoff. | `ensureOwner`, `StartupDiagnostics` |
| CLI startup timeout/failure | Родитель останавливает и присоединяет физический child, удаляет только принадлежащие операции файлы и выдаёт safe prefix/phase/elapsed/cause metadata. Причина исходного intermittent `OWNER_NOT_READY` остаётся неизвестной. | `service.ts`, `startup-status.ts` |

Schemas: `runtime/requests.ts`; capabilities, provider profiles и secret references: `runtime/config.ts`. См. [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/runtime/index.ts), [`config.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/runtime/config.ts), [`requests.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/runtime/requests.ts), [`service.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/cli/service.ts) и [`startup-status.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/cli/startup-status.ts).


Диагностические фазы уточняют место отказа, но не означают, что причина intermittent `OWNER_NOT_READY` найдена или устранена. Readiness deadline остаётся 15 секунд; до bearer-auth проверки matching endpoint родитель не передаёт управление daemon. Ошибки показывают только префикс, фазу, время и allowlisted cause/exit/signal — не сырое исключение, пути или секреты.
