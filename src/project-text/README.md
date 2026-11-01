# Project Text: docs, rules и skills

Отдельный namespace `zorya_project_text_*` индексирует документацию, rules и skills, не смешивая их с code index/knowledge storage. Capability существует только при явном `projectText` config; index использует borrowed database.

```mermaid
flowchart TD
 A["Runtime config"] --> B{"projectText включён явно?"}
 B -->|"нет"| C["Capability disabled; config не записывается автоматически"]
 B -->|"да"| D["createProjectTextIndex с borrowed DB"]
 D --> E["indexRepository: docs/rules/skills enumeration"]
 E --> F["Generation fence + Voyage document-role embeddings, если настроены"]
 F --> G["Bounded chunks и staging snapshot"]
 G --> H{"Generation current?"}
 H -->|"да"| I["Транзакционно опубликовать current snapshot"]
 H -->|"нет"| J["Отказ stale generation"]
 K["searchProjectText(query, kind)"] --> L["Schema + current identity"]
 L --> M["Lexical candidates"]
 L --> N{"Hybrid mode + compatible query profile?"}
 N -->|"yes"| O["Voyage query-role embedding → dense candidates"]
 N -->|"no / unavailable"| P["Lexical-only or degraded state"]
 M --> Q["Combine available candidates"]
 O --> Q
 P --> Q
 Q --> R{"Hybrid + rerank configured?"}
 R -->|"yes, incl. dense unavailable"| S["Rerank: reorder only"]
 R -->|"no"| T["Keep available order"]
 S --> U["Bounded hits + profile status"]
 T --> U
 U --> V["readProjectText: hash/snapshot check"]
 V --> W{"Текущий источник?"}
 W -->|"да"| X["Фрагмент с identity"]
 W -->|"нет"| Y["Stale refusal/error"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Нет `projectText` config | Capability не создаётся. | `runtime/config.ts`, `runtime/index.ts` |
| Нет embedding profile | Lexical доступен, dense не заявляется. | `ProjectTextOptions`, `indexStatus` |
| Hybrid при недоступном dense профиле | Rerank всё ещё может упорядочить lexical candidates; эта ветка отличается от code gate. | `searchProjectText`, rerank path |
| Поколение сменилось | Staging snapshot не публикуется. | `indexRepository` |
| HTTP provider failure | Ошибка операции остаётся ошибкой. | embedding/rerank ports |
| Source hash/snapshot устарел | Не выдавать старый текст как current. | `readProjectText` |

Необязательный конфигурационный preset `voyageai/voyage-4-large` (1024d) разделяет `document`-роль при индексации и `query`-роль при поиске; включение требует явного `projectText` config. Необязательный `voyageai/rerank-2.5-lite` только меняет порядок уже найденных кандидатов и не доказывает их корректность. Сам модуль не выводит query intent. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/project-text/index.ts), [`types.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/project-text/types.ts), [`schema.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/project-text/schema.ts). Эти исходники сами по себе не означают включение capability в публичный archive `v0.1.6`.
