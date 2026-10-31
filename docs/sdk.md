# Справочник SDK

Подробные сигнатуры базового SDK в этом справочнике сверены с исходным baseline `c112e179ead154c9f5fa50d242f0dd5c7426f823`. MCP/runtime subpaths сверены отдельно с принятым snapshot `fa3185ce364abcc9df2a65775cd31f9566e0e8f5` и локальной установкой архива в отдельный проект. Всегда сравнивай exports с установленным `package.json`: наличие SDK, daemon или CLI не означает подключения к конкретному MCP-клиенту или текущему чату. Состав слоёв описан в [архитектуре](architecture.md).

## Точки входа

Импортируйте только нужную поверхность пакета:

| Путь | Назначение |
| --- | --- |
| `@zorya/search` | Core API, `openEmbeddedDatabase`, PostgreSQL adapters и shared-типы |
| `@zorya/search/code` | `createCodeIndex` и типы code index |
| `@zorya/search/context` | `createCodeContext` и его DTO |
| `@zorya/search/context/web` | `createWebSearch` и DTO web-контекста |
| `@zorya/search/context/classify` | `createClassificationTool` и его limits/profile |
| `@zorya/search/providers` | OpenRouter/OpenAI-compatible model adapters, Brave web source и classifier |
| `@zorya/search/visual` | opt-in `createVisualSearch` и visual DTO |
| `@zorya/search/runtime` | runtime factory и конфигурация разрешённых roots |
| `@zorya/search/mcp` | MCP server, tool contracts и stdio proxy |
| `@zorya/search/daemon` | локальный HTTP daemon, владеющий runtime и transport |

Корневой entry не импортирует runtime-модули этих специализированных поверхностей за потребителя. Текущий `package.json` задаёт ESM exports и требует Node.js `>=20.19.0`.

Для большинства библиотечных потребителей начни с `@zorya/search` и нужных subpaths. Для локального MCP сценария используй daemon, который единолично владеет каталогом embedded database, и `@zorya/search/mcp` как transport adapter. Не запускай второй владелец того же data directory. Настройка конкретного клиента и CLI описана отдельно в [руководстве MCP](mcp.md) и [руководстве CLI](cli.md).

## Индекс кода и контекст

### Владение базой и закрытие ресурсов

`openEmbeddedDatabase(dataDir)` создаёт и владеет локальной PGlite-базой с pgvector и эксклюзивной блокировкой каталога. `createCodeIndex({ database, ... })` получает заимствованный `QueryableDatabase`; `index.close()` завершает watcher и принадлежащие ему операции, но не закрывает базу. Перед `index.close()` закройте созданный `CodeContext` и при необходимости handle `watchRepository`; затем закройте сам индекс и только после него владеющую базу. Не удаляйте каталог базы для завершения обычного цикла.

```ts
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { openEmbeddedDatabase } from '@zorya/search'
import { createCodeIndex } from '@zorya/search/code'
import { createCodeContext, CodeContextError } from '@zorya/search/context'

const root = process.env.ZORYA_SEARCH_SOURCE_ROOT
const dataDir = process.env.ZORYA_SEARCH_DATA_DIR
if (!root || !dataDir || !isAbsolute(root) || !isAbsolute(dataDir)) {
  throw new Error('Задайте абсолютные ZORYA_SEARCH_SOURCE_ROOT и ZORYA_SEARCH_DATA_DIR')
}
// В SOURCE_ROOT должен находиться src/context/index.ts; каталог базы обязан быть вне него.
const relativeDataDir = relative(resolve(root), resolve(dataDir))
if (
  relativeDataDir === '' ||
  (relativeDataDir !== '..' &&
    !relativeDataDir.startsWith(`..${sep}`) &&
    !isAbsolute(relativeDataDir))
) {
  throw new Error('ZORYA_SEARCH_DATA_DIR должен находиться вне индексируемого дерева')
}
const database = await openEmbeddedDatabase(resolve(dataDir))
const index = createCodeIndex({
  database,
  // Эти лимиты относятся к указанному размеру дерева, а не являются глобальными defaults.
  limits: { maxChunks: 50_000, maxScanChunks: 50_000 },
})
const context = createCodeContext({ index })

try {
  const status = await index.indexRepository({ root })
  const hits = await index.searchCode({
    root,
    query: 'createCodeContext',
    mode: 'lexical',
    limit: 8,
  })
  const firstHit = hits.hits[0]
  const current = await index.indexStatus(root)
  if (firstHit && current.identity?.snapshotId !== firstHit.snapshotId) {
    throw new Error('Индекс изменился после поиска; повторите поиск перед чтением результата')
  }
  const excerpt = firstHit
    ? await index.readSource({
        root,
        path: firstHit.path,
        lineStart: firstHit.lineStart,
        lineEnd: firstHit.lineEnd,
        snapshotId: firstHit.snapshotId,
      })
    : undefined
  const related = firstHit
    ? await index.relatedCode({ root, path: firstHit.path, limit: 4 })
    : undefined
  const bundle = await context.getCodeContext({
    root,
    query: 'Как собирается контекст кода?',
    mustInclude: [{ path: 'src/context/index.ts', lineStart: 95, lineEnd: 110 }],
    maxChars: 12_000,
    includeRelated: false,
  })
  console.log(status.chunkCount, excerpt?.stale, related?.imports, bundle.sections.length)
} catch (error) {
  if (error instanceof CodeContextError && error.code === 'MANDATORY_BUDGET') {
    // Увеличьте maxChars этого запроса или сократите обязательные диапазоны.
  }
  throw error
} finally {
  await context.close()
  await index.close()
  await database.close()
}
```

Пример использует только лексический поиск и не вызывает модели. Он показывает API базового SDK; для другой версии сверяй доступные методы с экспортами установленного пакета.

### Методы `CodeIndex`

- `indexRepository({ root, signal? })` индексирует разрешённое дерево и возвращает `CodeIndexStatus`. Идентичность результата включает `repoId`, `worktreeId`, `snapshotId` и `contentHash`.
- `indexStatus(root, signal?)` возвращает текущий статус или пустую identity, если usable snapshot отсутствует. `denseAvailable` и `denseDisabledReason` показывают состояние vector-пути.
- `searchCode({ root, query, paths?, language?, limit?, mode?, signal? })` возвращает `{ hits, identity, degraded, degradedReason }`. Каждый hit несёт путь, строки, `snapshotId`, хеш chunk и сведения lexical/dense/rerank ранжирования. По умолчанию limit `10`; без моделей режим по умолчанию lexical. Явный `mode: 'lexical'` не вызывает embedding/rerank.
- `readSource({ root, path, lineStart?, lineEnd?, snapshotId?, signal? })` читает текущий файл внутри root и сверяет его с актуальным snapshot. Несовпадение явно переданного `snapshotId` даёт `CODE_INDEX_SNAPSHOT_MISMATCH`; если изменившийся файл или snapshot обнаружен во время чтения, метод бросает `CodeIndexError` с кодом `CODE_INDEX_SOURCE_CHANGED` или `CODE_INDEX_SOURCE_CHANGED_DURING_READ`. Успешный результат имеет `stale: false`, а не `stale: true`. Без диапазона читается до 200 строк от `lineStart` (по умолчанию `1`); верхний предел одного запроса — 1000 строк. Результат содержит полный файловый `contentHash` для проверенного текущего файла и `snapshotId`. Это не тот же хеш, что `CodeHit.contentHash`, относящийся к chunk.
- `relatedCode({ root, path, symbol?, limit?, signal? })` возвращает разрешённые `imports`, `importedBy`, похожие lexical hits и identity. Эти связи не являются полным графом для всех языков.
- `watchRepository(root, { signal?, intervalMs?, onError? }?)` возвращает handle с `close()`. По умолчанию сверяет дерево раз в 5000 ms; разрешённый интервал 250–60000 ms.
- `close()` закрывает watchers, отменяет и дожидается операций самого индекса. Заимствованную database он не закрывает.

`createCodeContext({ index, limits? })` создаёт адаптер над уже открытым индексом. Его метод:

```ts
import type { CodeContextRequest, CodeContextResult } from '@zorya/search/context'

type GetCodeContext = (input: CodeContextRequest) => Promise<CodeContextResult>
```

Вызов берёт identity актуального индекса, выполняет query и optional feature queries, читает кандидатов в пределах символьного бюджета и возвращает секции с происхождением рангов, файловыми и chunk hashes, `degraded` и списком пропусков. `includeRelated` по умолчанию `false`. Поля запроса определены в `CodeContextRequest`: `root`, `query`, `featureQueries`, `mustInclude`, `includeRelated`, `maxChars`, `limit`, `signal`. Пути в `mustInclude` задаёт вызывающая сторона. Запись только `{ path }` означает ограниченный excerpt, а не полный файл: при пустых границах `readSource` начинает с первой строки и читает не более 200 строк; секция возвращает фактические `lineStart`/`lineEnd`. Поле `truncated` отражает срез необязательных candidate sections, если адаптер ограничил их через `maxRangeLines`. Обязательный `mustInclude` диапазон длиннее этого лимита завершается ошибкой `LIMIT`, а отсутствие границ оставляет `truncated: false` даже при скрытых последующих строках файла. Для получения определённого участка укажите обе границы; не считайте path-only секцию полным содержимым файла. При нехватке символьного бюджета обязательный диапазон не замалчивается: `CodeContextError('MANDATORY_BUDGET')` сообщает о нехватке `maxChars`. `getCodeContext` сам не добавляет результат в prompt.

Лимиты code index по умолчанию включают `maxChunks: 10_000` и `maxScanChunks: 10_000`. Проверка Assistant на baseline обработала 1758 файлов и 24 863 chunks с `maxChunks: 50_000` и `maxScanChunks: 50_000`. При необходимости такого масштаба передавайте эти лимиты явно: результат одного рабочего дерева не устанавливает безопасные глобальные значения для иных потребителей или репозиториев.

## Исключения и границы индексирования

`CodeIndexOptions.exclude?: string[]` добавляет правила к встроенным исключениям файлов блокировки. Встроенная политика также запрещает обход `.git`, `node_modules`, `build`, `dist`, `coverage`, `.cache`, `.next`, `vendor`, `.idea`, `.vscode`, файлов `.env*` и имён, похожих на секреты или ключи. Это защита известных типов путей и имён. Папка не исключается лишь потому, что её имя содержит `generated`. Фильтр по расширению ограничивает индексирование текстовыми типами текущей реализации. Вызывающая сторона может добавить собственные маски исключения; они дополняют встроенные правила.

Фильтры и граница realpath ограничивают случайный доступ, но не гарантируют обнаружение всех секретов в остальных текстовых исходниках. До подключения облачных моделей вызывающая сторона отвечает за осознанный выбор передаваемого кода и конфигурации provider.

Идентичность snapshot зависит от дерева, worktree, профиля и конфигурации chunking/exclusions. Изменившийся источник нужно переиндексировать. Индексированный chunk content hash и хеш полного файла у `readSource` относятся к разным данным; сверяйте `snapshotId` и учитывайте, что при обнаружении изменения `readSource` завершится ошибкой. Не трактуйте прежний hit как актуальный после изменения checkout.

### Embeddings и rerank для кода

Lexical индекс не требует provider и работает офлайн. Dense-векторный путь задаётся совместными `models` и `profile`: профиль включает provider, space, model, dimensions, `inputType: 'text'` и текущий `chunkerVersion`. Вызов `searchCode({ mode: 'hybrid' })` без настроенных `models` явно деградирует к lexical; при несовпадении профиля или snapshot текущего индекса он также возвращает lexical результат с причиной деградации. Передача `models` без валидного `profile` завершается ошибкой при создании индекса; передача одного `profile` без `models` тоже недопустима. Не повторно используйте векторы с несовпадающим профилем/snapshot. Ошибка самого вызова embedding/rerank пробрасывается и не превращается автоматически в lexical fallback.

`createCodeIndex` ожидает `models.embed({ texts, signal })` и optional `models.rerank({ query, documents, signal })`. Provider adapter из `@zorya/search/providers` имеет собственный `profile`; для code profile нужны те же provider/space/model/dimensions, `inputType: 'text'` и текущий `chunkerVersion: CODE_CHUNKER_VERSION` из `@zorya/search/code`. Например, создайте provider методом `createOpenRouterEmbedding({ baseUrl, model, dimensions, apiKeyEnv })`, явно передайте его method как `models.embed`, а конфигурацию профиля согласуйте с provider profile и chunker version. Такой вызов может отправить chunks выбранному провайдеру; пример здесь описан, но в рамках подготовки документации не выполнялся.

В read-only сверке конфигурации Mechanism от 2026-10-31 зафиксирован code embedding preset `voyageai/voyage-code-4` размерности 1024 и отдельный reranker `voyageai/rerank-2.5-lite`. Эти значения не являются универсальными defaults Search. Текущий интеграционный preset и переменную окружения смотри в [профильном руководстве](voyage-profiles.md), после проверки по установленной версии. Установка preset может передавать индексируемый код и запросы OpenRouter. В сверке каталога и исходников внешних inference вызовов не было; live доступность, качество и стоимость не подтверждены.

## Поиск в web и чтение источников

`createWebSearch({ web, models?, limits? })` принимает `WebSource` с методами `discover(query, target, signal)` и `fetchDocument(url, signal)`. `searchWeb({ query, limit?, maxChars?, signal? })` возвращает excerpts, canonical URL, дату чтения, content hash, профили и режим ranking. Ошибки отдельных discovery/document/embed/rerank этапов находятся в `errors`; `partial` показывает неполный результат. `readWebSource({ url, maxChars?, signal? })` читает один указанный URL с ограничением длины и сообщает `truncated`.

Источником можно сделать `createBraveWebSource({ apiKeyEnv: 'BRAVE_SEARCH_API_KEY' })`; облачный поиск требует ключа во время вызова. Embedding и rerank для web настраиваются отдельно и опционально; lexical web-поиск может использовать только `web`. Например, adapters создаются через `createOpenRouterEmbedding({ baseUrl, model, dimensions, apiKeyEnv })` и `createOpenRouterReranker({ baseUrl, model, apiKeyEnv })`. Значения здесь являются именами переменных/параметров, а не ключами; конфигурационные фабрики в этом документальном примере не исполняются.

Web-поиск и чтение источника ничего не записывают в knowledge DB автоматически. Подключение `SearchService` к storage и выполнение reindex — отдельный core workflow; результаты web retrieval здесь лишь возвращаются вызывающей стороне. Непроверенные страницы и snippets остаются данными.

## Классификация по критериям вызывающей стороны

`createClassificationTool({ classifier, limits? })` принимает `Classifier` и возвращает `profile`, `classify(...)` и `close()`. Запрос содержит `text`, разрешённые `labels`, обязательные правила `criteria`, optional `examples`, `allowMultiple`, `allowAbstain` и `signal`. `criteria` задаёт вызывающая сторона; адаптер применяет эти правила только к классификации переданного текста. DTO строго валидируется: итоговые labels должны принадлежать предложенному набору; результат может воздержаться, confidence может отсутствовать, а evidence и uncertainty возвращаются вызывающей стороне. При adapter `createOpenRouterClassifier({ baseUrl, model, apiKeyEnv })` текст отправляется провайдеру только при фактическом `classify`. Текст и примеры являются данными: они не переопределяют инструкции вызывающей стороны, а результат не гарантированно истинен.

## Визуальный поиск

`createVisualSearch({ enabled?, embedding?, profile?, limits? })` выключен по умолчанию; выключенный экземпляр отвечает `VisualSearchError('DISABLED')`. Включённый экземпляр хранит только временные references, добавленные вызовом `upsert`. Каждый reference требует ID, заданный вызывающей стороной, и SHA-256 исходного текста или изображения, плюс опциональные `screen`, `state`, `breakpoint`. На один reference и на один запрос подаётся ровно один текст **или** image bytes с MIME type; пакет сам не получает скриншот и не определяет, когда его сделать.

Без embedding metadata-only text поиск сравнивает текстовое поле `reference.text`; `screen`, `state` и `breakpoint` можно использовать как точные filters. Запрос картинкой завершается `IMAGE_QUERY_UNSUPPORTED`. Для image query нужен включённый подходящий embedding порт и явно совпадающий профиль. Результат включает score и uncertainty: даже векторная близость не является pixel comparison или подтверждением качества. Хранилище эфемерно; `close()` отменяет принадлежащие операции и очищает его. Не сохраняйте references между процессами как будто они составляют durable визуальный индекс.

Visual профиль Mechanism отделён от кода и использует `voyageai/voyage-multimodal-3.5` размерности 1024. Его настраивает владелец независимо; он не меняет code embeddings и остаётся выключенным, пока его отдельно не включили. Visual дополнение может искать только среди references, которые клиент сам выбрал и передал; Search не получает desktop capture и не скачивает изображения по URL. Модельный каталог и committed client configuration были сверены без provider inference. Подробные ограничения интеграции и MCP tool смотрите в [профильном руководстве](voyage-profiles.md).

## Что считать результатом

Search возвращает кандидатов вместе с источником, границами и происхождением, где оно доступно. Score, confidence, semantic similarity, код или web-текст не подтверждают верность решения и не разрешают действие. Вызывающая сторона решает, что передать своей модели, какие источники проверять и нужно ли менять собственное состояние. Поисковый текст не исполняется, а SDK не создаёт сессии агентов, не управляет памятью и не меняет prompt.

Описание базовых SDK сигнатур привязано к указанному baseline; runtime/MCP exports проверены на `fa3185c` и при локальной установке архива в отдельный проект. Руководства CLI и профилей относятся к своим интерфейсам и не подтверждают доступность функции в любом установленном пакете. Локальный `npm pack` не означает публикацию. MCP archive smoke и локальные проверки инструментов не означают подключения к текущему чату, живых вызовов моделей или готового Assistant адаптера.
