# Storage: базы и repository

`openEmbeddedDatabase` владеет созданным engine и exclusive lock каталога. `createCodeIndex` и project-text index получают заимствованный `QueryableDatabase`; закрытие этих индексов не закрывает БД. Все три семейства используют ресурс базы владельца, но сохраняют свои таблицы, namespaces и retrieval paths.

```mermaid
flowchart TD
 A["Клиент выбирает embedded dataDir либо PostgreSQL"] --> B{"openEmbeddedDatabase?"}
 B -->|"да"| C["Проверить каталог и owner lock"]
 C --> D["Создать/открыть engine и миграции"]
 B -->|"нет"| E["Переданный QueryableDatabase / pool"]
 D --> F["Storage adapters на принадлежащей/заимствованной БД"]
 E --> F
 F --> G["Code namespace: отдельные таблицы и code retrieval"]
 F --> H["Project-text namespace: отдельные таблицы и text retrieval"]
 F --> I["KnowledgeRepository → knowledge_chunks"]
 G --> G1["Code map: lexical BM25 + optional dense"]
 H --> H1["Project-text map: lexical + optional dense"]
 I --> J["validateAndEnable: build HNSW → benchmark exact и ANN"]
 J --> K{"Profile валиден; dimensions ≤4000; corpus ≥10000; queries 50..200?"}
 K -->|"нет"| L["Ошибка profile/measurement; операция завершается ошибкой"]
 K -->|"да"| M{"recallAt40 ≥ 0.95 AND annP50 < exactP50 AND annP95 ≤ exactP95?"}
 M -->|"да"| N["Записать ann_enabled=true"]
 M -->|"нет"| O["Записать ann_enabled=false; exact path остаётся"]
 P["CodeIndex.close()"] --> Q["Закрыть индекс, не borrowed DB"]
 R["OwnedDatabase.close()"] --> S["Закрыть owned engine и снять lock"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Каталог занят другим embedded owner | Открытие отклоняется, lock не перехватывается. | `openEmbeddedDatabase` |
| Закрывается `CodeIndex` или project-text index | Закрывается индекс и его работа; borrowed database остаётся владельцу. | `createCodeIndex`, `createProjectTextIndex`, `close` |
| Профиль или benchmark input не проходит schema/measurement gates | Ошибка вместо статуса, будто ANN прошёл квалификацию. Нужны dimensions ≤4000, corpus ≥10000 и 50–200 query vectors. | `SearchAnnIndex.build`, `SearchAnnIndex.benchmark` |
| Все пороги проходят | Сохранить `ann_enabled=true` для соответствующего knowledge profile. | `SearchAnnIndex.validateAndEnable` |
| Измерения валидны, но хотя бы один порог не пройден | Сохранить `ann_enabled=false`; использовать exact retrieval. | `SearchAnnIndex.validateAndEnable`, `PostgresKnowledgeRepository` |
| SQL/migration/connection failure | Ошибка передаётся выше. | `PostgresKnowledgeRepository`, migrations |

`SearchAnnIndex` квалифицирует ANN только на `knowledge_chunks`; code и project-text используют свои namespaces и retrieval пути. Принимается только измерение, где одновременно `recallAt40 ≥ 0.95`, `annP50 < exactP50` и `annP95 ≤ exactP95`. Это переключатель способа получения knowledge candidates, не оценка истинности или качества найденного текста.

При shutdown сначала отменяется и присоединяется принадлежащая работа, затем владелец закрывает свой ресурс. См. [`embedded.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/storage/embedded.ts), [`repository.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/storage/postgres-repository/repository.ts), [`ann-index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/storage/ann-index.ts).
