# Core: поиск и извлечение

Core связывает collection, модели embeddings/rerank и knowledge repository. Клиент получает ограниченные passages с происхождением и признаками частичности; итоговое решение остаётся у вызывающей стороны.

```mermaid
flowchart TD
 A["SearchRequest"] --> B["executeSearch: отмена и buildSearchQuery"]
 B --> C["Embed query → repository.retrieve"]
 C --> D["rankPassages: rerank cache"]
 D --> E{"Cache score достиг порога?"}
 E -->|"да"| F["recordQuery → database result"]
 E -->|"нет"| G["collectSources: запрос и выбранные клиентом additionalQueries"]
 G --> H{"Документы получены?"}
 H -->|"нет"| I{"Есть ранжированный cache?"}
 I -->|"да"| J["Частичный database ответ + collection errors"]
 I -->|"нет"| K["Пустой web result: partial/errors"]
 H -->|"да"| L["chunkDocuments → embedChunks, batches of 32"]
 L --> M["Сохранить документы и chunks"]
 M --> N["retrieve → rankPassages / rerank"]
 N --> O["recordQuery → bounded SearchResult"]
 P["HTTP model/repository error или AbortSignal"] --> Q["Явная ошибка/отмена; не скрывать как lexical fallback"]
 C --> Q
 L --> Q
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Cache score ≥ порога | Возвращаются database passages без нового collection. | `executeSearch`, `evaluateSearchCache` |
| Collection неполная или бюджет истёк | `partial` и этапные `errors` сохраняются; при пустой collection возможен лишь ранжированный cache. | `collectSources`, `cachePartialFallback` |
| HTTP embedding/rerank завершился ошибкой | Ошибка проходит выше; автоматической lexical подмены нет. | `embedChunks`, `rankPassages` |

Файлы: [`search.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/search.ts), [`indexing.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/indexing.ts), [`retrieval.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/retrieval.ts), [`reindex.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/core/reindex.ts). Storage сохраняет данные; providers исполняют настроенные порты. Ничто из результата не применяется к исходникам автоматически.
