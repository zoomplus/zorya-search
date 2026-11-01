# Справочник SDK

Базовые сигнатуры SDK в этом справочнике впервые сверены с `c112e179ead154c9f5fa50d242f0dd5c7426f823`; текущие exports сверены на интегрированном snapshot `34253f64e4918f17591816c81cc515fc9a313109` и установленном архиве. Перед использованием сравнивай exports с `package.json` своей версии: наличие SDK, daemon или CLI само по себе не подключает MCP-клиент или текущий чат. Состав слоёв описан в [архитектуре](architecture.md).

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

`createCodeContext` использует необязательную capability `CodeIndex.withReadSnapshot`, если её предоставляет штатный `createCodeIndex`. Scope принадлежит одному вызову контекста и его root. Он повторно использует загруженный корпус для нескольких запросов, проверяет свежесть исходников при чтении и перепроверяет identity перед возвратом. Строки scope освобождаются после завершения операции. Старые пользовательские реализации с `indexStatus`, `searchCode`, `readSource` и `relatedCode` остаются совместимы и работают без scope.

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

Интегрированный preset для кода использует `voyageai/voyage-code-4` размерности 1024 и отдельный reranker `voyageai/rerank-2.5-lite`. Это выбор владельца при настройке, а не обязательный профиль любого SDK-потребителя. При включении индексируемый код и запрос могут уйти в OpenRouter. В историческом smoke через установленный runtime два code embedding запроса и один code rerank проверили на десяти синтетических файлах; ожидаемый файл оказался первым. Вместе с visual вызовами в том smoke выполнено восемь успешных OpenRouter вызовов общей известной стоимостью $0.00011708. Это подтверждает только выбранный синтетический сценарий; широкое качество, задержки и стоимость на реальном репозитории не установлены. Подробности — в [руководстве профилей](voyage-profiles.md).

## Поиск в web и чтение источников

Web-поиск выполняет два независимых шага: `WebSource.discover(...)` находит кандидаты URL, а `WebSource.fetchDocument(...)` читает публичные страницы. С адаптером Brave поиск ссылок идёт через Brave Search API; сами страницы Search загружает непосредственно по URL. Для `discover` нужен ключ Brave, а `fetchDocument` и `readWebSource` читают уже известный публичный URL без него. См. [официальную документацию Brave Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search).

Лексический поиск страниц работает без модели. Текстовая web-модель и переранжирование включаются отдельно: code preset не становится web-профилем, а visual-профиль не применяется к странице. Отдельную OpenRouter-модель для web указывает владелец через setup CLI; подробности — в [руководстве CLI](cli.md#web-поиск-через-brave). Для собственного OpenAI-compatible endpoint задаются HTTPS URL и ID профиля. Модель и размерность должны соответствовать настройке владельца; Search не выбирает их за вызывающую сторону.

Пример SDK для поиска руководства по алхимии в The Witcher 3 с датами discovery:

```ts
import { createBraveWebSource } from '@zorya/search/providers'
import { createWebSearch } from '@zorya/search/context/web'

const web = createBraveWebSource({ apiKeyEnv: 'BRAVE_SEARCH_API_KEY' })
const search = createWebSearch({ web }) // лексический поиск без embedding и переранжирования
try {
  const result = await search.searchWeb({
    query: 'The Witcher 3 alchemy ingredients guide',
    dateRange: { from: '2024-01-01', through: '2025-12-31' },
    limit: 5,
  })
  // Вызывающая сторона проверяет passages и errors и решает, что читать дальше.
  console.log(result.passages, result.errors, result.partial)
} finally {
  await search.close()
}
```

`dateRange` необязателен. `from` и `through` должны быть реальными календарными датами `YYYY-MM-DD`; `from` не может быть позже `through`. Период передаётся Brave как фильтр обнаружения ссылок, он не подтверждает дату публикации текста и не гарантирует полноту выдачи.

`searchWeb({ query, limit?, maxChars?, dateRange?, signal? })` возвращает отрывки страниц с canonical URL, content hash, ranking и временными полями. `publishedAt` берётся из даты публикации, явно найденной в документе; `sourceUpdatedAt` — из метаданных даты изменения либо, если их нет, из `Last-Modified`. `fetchedAt` — время, когда Search прочитал документ. Это разные сведения: время чтения не заменяет дату страницы. Ошибки этапов discovery, document, embed и rerank перечислены в `errors`; `partial` сообщает, что не все этапы завершились успешно.

`readWebSource({ url, maxChars?, signal? })` читает один указанный URL и сообщает `truncated`. При owner JSON с `"web": {}` его можно использовать для чтения известной страницы без ключа Brave; runtime и MCP caller всё равно должны разрешать web-операцию. Brave reader разбирает HTML/XHTML, текст, Markdown, JSON, XML, RSS/Atom и PDF с текстовым слоем. Для PDF текст извлекается без OCR; Search не запускает JavaScript и не управляет полноценным браузером. Содержимое ограничено размером ответа и runtime budgets. Превышение лимита страницы может вернуть `DOCUMENT_TOO_LARGE` и сделать результат частичным. В извлечённом тексте сохраняются пробелы и отступы внутри кодовых блоков.

Перед каждым чтением проверяется публичный HTTP(S) URL и адрес разрешённого DNS; соединение закрепляется за проверенным адресом. Каждый redirect проверяется заново, доступ к локальным и приватным адресам блокируется. Ограниченные `ETag`/`Last-Modified` validators применяются только для того же canonical URL. Если сервер отвечает `304 Not Modified`, Search сохраняет ранее разобранное тело и обновляет `fetchedAt`; даты `publishedAt` и `sourceUpdatedAt` остаются метаданными источника. Это ограниченный локальный кэш страниц, а не durable корпус. Семантика ответа описана в [RFC 9110 §15.4.5](https://www.rfc-editor.org/rfc/rfc9110.html#name-304-not-modified).

Web-поиск и чтение источника ничего не записывают в knowledge DB автоматически. Подключение `SearchService` к storage и выполнение reindex — отдельный core workflow; результаты web retrieval лишь возвращаются вызывающей стороне. Непроверенные страницы и snippets остаются недоверенными данными, а вызывающая сторона сама выбирает источники и решает, применять ли найденные сведения.

## Классификация по критериям вызывающей стороны

`createClassificationTool({ classifier, limits? })` принимает `Classifier` и возвращает `profile`, `classify(...)` и `close()`. Запрос содержит `text`, разрешённые `labels`, обязательные правила `criteria`, optional `examples`, `allowMultiple`, `allowAbstain` и `signal`. `criteria` задаёт вызывающая сторона; адаптер применяет эти правила только к классификации переданного текста. DTO строго валидируется: итоговые labels должны принадлежать предложенному набору; результат может воздержаться, confidence может отсутствовать, а evidence и uncertainty возвращаются вызывающей стороне. При adapter `createOpenRouterClassifier({ baseUrl, model, apiKeyEnv })` текст отправляется провайдеру только при фактическом `classify`. Текст и примеры являются данными: они не переопределяют инструкции вызывающей стороны, а результат не гарантированно истинен.

## Визуальный поиск

`createVisualSearch({ enabled?, embedding?, profile?, limits? })` выключен по умолчанию; выключенный экземпляр отвечает `VisualSearchError('DISABLED')`. Включённый экземпляр хранит только временные references, добавленные вызовом `upsert`. Каждый reference требует ID, заданный вызывающей стороной, и SHA-256 исходного текста или изображения, плюс опциональные `screen`, `state`, `breakpoint`. На один reference и на один запрос подаётся ровно один текст **или** image bytes с MIME type; пакет сам не получает скриншот и не определяет, когда его сделать.

Без embedding metadata-only text поиск сравнивает текстовое поле `reference.text`; `screen`, `state` и `breakpoint` можно использовать как точные filters. Запрос картинкой завершается `IMAGE_QUERY_UNSUPPORTED`. Для image query нужен включённый подходящий embedding порт и явно совпадающий профиль. Результат включает score и uncertainty: даже векторная близость не является pixel comparison или подтверждением качества. Хранилище эфемерно; `close()` отменяет принадлежащие операции и очищает его. Не сохраняйте references между процессами как будто они составляют durable визуальный индекс.

Visual профиль Mechanism отделён от кода и использует `voyageai/voyage-multimodal-3.5` размерности 1024. Его настраивает владелец независимо; он не меняет кодовые embeddings и остаётся выключенным, пока его отдельно не включили. Visual поиск принимает только материалы, которые клиент сам выбрал и передал; Search не получает снимки экрана и не скачивает изображения по URL. В ограниченном smoke на одном сгенерированном 96×96 изображении модель вернула ожидаемый единственный candidate. Это не оценка распознавания или качества на реальных изображениях. Дополнительные ограничения SDK и MCP описаны в [руководстве профилей](voyage-profiles.md).

## Что считать результатом

Search возвращает кандидатов вместе с источником, границами и происхождением, где оно доступно. Score, confidence, semantic similarity, код или web-текст не подтверждают верность решения и не разрешают действие. Вызывающая сторона решает, что передать своей модели, какие источники проверять и нужно ли менять собственное состояние. Поисковый текст не исполняется, а SDK не создаёт сессии агентов, не управляет памятью и не меняет prompt.

## Исторические проверки baseline main — 2026-11-01

Сигнатуры SDK и `package.json` были сверены на тогдашнем baseline. На исходном main source package gates прошли 206/206 тестов, hosted CI run 41263778259 завершил 8/8 jobs, установленный Codex CLI и второй MCP SDK-клиент прошли 11/11 проверок, а Assistant live MCP acceptance включала два запроса к действующему индексу. Эти записи относятся только к указанным версиям и сценариям; они не квалифицируют последующие Brave изменения или актуальный пользовательский хост. Шестипарный пилот завершился native inconclusive результатом F без победителя. npm-пакет на ту дату не был опубликован, текущий ChatGPT MCP не был настроен, полная приёмка оставалась незавершённой.
