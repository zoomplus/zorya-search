# Core: поиск и извлечение

Core связывает collection, модели embeddings/rerank и knowledge repository. Клиент получает ограниченные passages с происхождением и признаками частичности; итоговое решение остаётся у вызывающей стороны.

```mermaid
flowchart TD
 A["SearchRequest"] --> B["executeSearch: отмена и buildSearchQuery"]
 B --> C["Embed query → repository.retrieve cache candidates"]
 C --> D["rankPassages → cache rerank"]
 D --> E{"Ranked cache passages exist?"}
 E -->|"нет: score 0"| H["collectSources: query + caller-selected additionalQueries"]
 E -->|"да"| F["Injected SearchModels judgeCache score"]
 F --> G{"Validate finite score 0..1"}
 G -->|"invalid"| X["Schema error"]
 G -->|"valid: compare threshold default 0.9"| I{"score ≥ threshold?"}
 I -->|"yes"| J["recordQuery → cached database result"]
 I -->|"no"| H
 H --> K{"Документы получены?"}
 K -->|"нет"| L{"Есть ranked cache?"}
 L -->|"да"| M["Частичный database ответ + collection errors"]
 L -->|"нет"| N["Пустой web result: partial/errors"]
 K -->|"да"| O["chunkDocuments → embedChunks"]
 O --> P["Embed/store document chunks"]
 P --> Q["retrieve → rankPassages / rerank"]
 Q --> R["recordQuery → bounded SearchResult"]
 S["HTTP model/repository error или AbortSignal"] --> T["Явная ошибка/отмена; не скрывать как lexical fallback"]
 C --> T
 O --> T
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| `judgeCache` сообщает finite score ≥ порога (default 0.9) | Возвращаются database passages без нового collection. Модель порта задаёт владелец; Core не закрепляет Jev. | `executeSearch`, `evaluateSearchCache`, `SearchModels` |
| Невалидный score | Schema error; это не ветка cache miss. | `evaluateSearchCache` |
| Collection неполная или бюджет истёк | `partial` и этапные `errors` сохраняются; при пустой collection возможен лишь ранжированный cache. | `collectSources`, `cachePartialFallback` |
| HTTP embedding/rerank завершился ошибкой | Ошибка проходит выше; автоматической lexical подмены нет. | `embedChunks`, `rankPassages` |

Файлы: [`search.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/search.ts), [`indexing.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/indexing.ts), [`retrieval.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/retrieval.ts), [`reindex.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/reindex.ts). Storage сохраняет данные; providers исполняют настроенные порты. Ничто из результата не применяется к исходникам автоматически.
