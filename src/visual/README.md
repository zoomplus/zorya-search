# Visual: отдельный opt-in retrieval

Visual включается отдельно и получает только явно переданные caller text/image references. При `enabled: true` он может работать metadata-only без embeddings; если embedding provider настроен, для него требуется совпадающий явный visual profile. Search не захватывает рабочий стол, не собирает кадры и не выносит judgement о корректности UI.

```mermaid
flowchart TD
 A["Caller query + supplied reference/image bytes"] --> B{"Visual capability enabled?"}
 B -->|"нет"| C["Disabled capability / VisualSearchError"]
 B -->|"да"| D["Validate schema, MIME, bytes/text limits и filters"]
 D --> E{"Вход допустим?"}
 E -->|"нет"| F["Validation error"]
 E -->|"да"| G["Проверить content hash и скопировать supplied bytes"]
 G --> H{"Embedding provider настроен?"}
 H -->|"нет"| I["Metadata-only lexical retrieval; explicit profile не нужен"]
 H -->|"да"| J{"Есть matching explicit visual profile?"}
 J -->|"нет"| K["Profile configuration error"]
 J -->|"да"| L["Optional multimodal embedding в visual-only space"]
 I --> M["Lexical metadata score"]
 L --> N["Profile/hash/filter compatible references"]
 N --> O["Lexical score + optional cosine similarity"]
 M --> P["Bounded results с reference metadata"]
 O --> P
 P --> Q["Caller интерпретирует similarity"]
 R["Отмена / превышен лимит / ошибка provider"] --> S["Передать отмену или ошибку caller; новых данных не собирать"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Visual disabled | Capability отклоняет поиск. При `enabled: true` без embedding provider доступен metadata-only lexical режим. | `createVisualSearch` |
| Embedding provider настроен без matching explicit profile | Конфигурация отклоняется. | `createVisualSearch` |
| Неверный MIME/hash или превышен лимит | Input отклоняется. | `snapshotImage`, `verifyContentHash` |
| Profile несовместим | Не участвует в dense сравнении. | `profileId`, search path |
| Provider error | Ошибка, не уверенность о содержимом. | embedding port |

Visual space отделён от code/project-text. Источник: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/visual/index.ts).
