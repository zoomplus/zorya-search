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

В версии `v0.1.6` штатный `createCodeIndex` предоставляет необязательный `findCodeDuplicates({ root, paths?, language?, sourceKind?, matchMode?, minTokens?, minOccurrences?, limit?, maxOccurrencesPerGroup?, signal? })`; архив `v0.1.5` этой capability не содержит. Старые пользовательские реализации `CodeIndex` без этого метода остаются структурно совместимыми; runtime сообщает `CAPABILITY_DISABLED`, если адаптер не предоставляет capability. По умолчанию проверяются только индексированные implementation-файлы, минимум 12 токенов и два вхождения; ответ включает `supportedLanguages: ['JavaScript', 'TypeScript']` для фактически поддерживаемых JS/TS семейств. Режим `exact` сохраняет имена, `renamed` нормализует только локальные/параметрические символы, опознанные TypeScript checker. Ответ содержит snapshot identity, полный файл hash, символы и диапазоны функций, счётчики пропусков и признаки усечения; для каждой группы `occurrenceCount` показывает общее число совпадений даже при ограниченном списке `occurrences`. Это механические кандидаты по телам функций, не доказательство семантической эквивалентности, оценка экономии LOC или автоматическое объединение. Сверяйте весь диапазон через `readSource` перед использованием; capability не вызывает модели или провайдеры. Исторические квитанции не квалифицируют `v0.1.6`; актуальный статус выпуска и архива указан на [странице релиза `v0.1.6`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.6).

### Source candidate: статические символы и связи

Описанные ниже методы и `includeLogical` соответствуют source candidate `9adb123`. GitHub archive `v0.1.6` этих изменений не содержит; npm-пакет пока не опубликован. Этот раздел не объявляет новый релиз и не меняет контракт архива. Проверяйте capability по типам установленной версии: методы symbol metadata в `CodeIndex` необязательны, поэтому старые пользовательские adapters остаются совместимыми.

`indexRepository` штатного индекса уже публикует символы и статические связи вместе с текущим индексом. Отдельный `indexCodeSymbols({ root, signal? })` нужен для явного заполнения или обновления metadata у уже существующего актуального snapshot. Он требует текущий базовый индекс и те же root, конфигурацию исключений и лимиты; не заменяет embedding-профиль, chunks, векторы или существующие поисковые данные и не вызывает embedding/rerank-модели. Чтение metadata ничего не индексирует автоматически.

`findCodeSymbols({ root, query?, name?, path?, symbolId?, enclosing?, language?, sourceKind?, limit?, cursor?, signal? })` ищет объявления по подстроке имени или `qualifiedName`, пути и языку. `symbolId` принимает точный ID из 64 строчных hex-символов; поиск по нему не является подстрочным. `enclosing: { path, lineStart, lineEnd? }` выбирает символы, покрывающие весь диапазон в точном нормализованном пути файла: границы — положительные целые PostgreSQL integer, конец не может быть раньше начала. При сочетании с другими фильтрами поля пересекаются. Текущий extractor анализирует JavaScript/TypeScript; unsupported files видны в coverage. `query` имеет приоритет над `name`; без фильтра `sourceKind` включены все категории. Категории `implementation`, `tests`, `documentation` и `all` определяются эвристически по путям. По умолчанию возвращается до 20 символов, максимум — 100. `findCodeReferences({ root, symbolId, direction?, kind?, limit?, cursor?, signal? })` по умолчанию ищет входящие связи, до 50 за страницу (максимум 200); `kind` может быть `reference`, `call`, `construct` или `export`. `traceCodeCalls({ root, symbolId, direction?, maxDepth?, maxNodes?, maxEdges?, signal? })` обходит только статические `call` и `construct` связи: направление по умолчанию `outgoing`, глубина — 2 (допустимо 0–4), узлы — 64, рёбра — 128; верхние границы числа узлов и рёбер — 256 и 1024.

Каждый ответ содержит source identity и профиль анализа: версию extractor и TypeScript, hash compiler options, профиль библиотек и лимиты анализа. `analysis.state` различает `indexed`, `not_indexed`, `partial` и `unavailable`; отсутствие базового или актуального source index по-прежнему является типизированной ошибкой. `partial` и счётчики покрытия показывают parse errors, неподдержанные и усечённые файлы. Список `coverage` ограничен 50 файлами; на файл возвращается до пяти diagnostics длиной до 512 символов. `coverageTotalFiles`, `coverageOmittedFiles` и `coverageCounts` дают сводные числа. `unresolvedReferenceCount` считает рёбра с `targetKind: 'unresolved'`; `unresolvedCallCount` — их подмножество для `call` и `construct`. `targetKind: 'external'` обозначает отдельный внешний target, а не ещё одно unresolved-ребро. Состояние `indexed`/`complete` означает, что обработана объявленная поддерживаемая область анализа, но не доказывает полноту динамических привязок или runtime-поведения.

У `findCodeSymbols` и `findCodeReferences` `truncated`/`nextCursor` относятся к ограниченной странице результата. `analysis.truncation` и coverage относятся к самим пределам извлечения; большое количество страниц не отменяет отсутствующие, неподдержанные или усечённые файлы.

Символы и рёбра относятся к исходному пути и диапазону, хранят file hash и полную identity snapshot. `targetKind` различает конкретную цель, contract, внешнюю и unresolved цель. Динамический dispatch, dependency injection и runtime bindings могут остаться неразрешёнными; не выводите из отсутствия ребра, что вызова нет. Cursor привязан к snapshot, профилю анализа и фильтрам запроса; не переносите его на другой snapshot, профиль или набор фильтров. Перед использованием диапазона перечитайте текущий текст через `readSource` с identity snapshot и самостоятельно решите, соответствует ли он задаче.

Ниже показан read-only lookup для уже существующего current base index. Функция получает настроенный владельцем `CodeIndex` и не создаёт его с новыми exclusions, limits или embedding profile. Передайте действующий экземпляр и разрешённый root из вызывающей стороны; владелец закрывает индекс и принадлежащую ему database после завершения всех операций. Для нового или изменившегося дерева сначала используйте `indexRepository`; этот read helper не запускает индексацию или metadata refresh.

```ts
import type { CodeIndex } from '@zorya/search/code'

async function lookupSymbol(index: CodeIndex, root: string, name: string) {
  const base = await index.indexStatus(root)
  if (!base.identity) throw new Error('Нет текущего индекса исходников')

  const findSymbols = index.findCodeSymbols?.bind(index)
  if (!findSymbols) return { state: 'unsupported' as const }

  const result = await findSymbols({ root, name, limit: 20 })
  const symbol = result.analysis.state === 'not_indexed' ? undefined : result.symbols[0]
  const lineEnd = symbol ? Math.min(symbol.location.lineEnd, symbol.location.lineStart + 199) : undefined
  const source = symbol && lineEnd !== undefined
    ? await index.readSource({
        root,
        path: symbol.location.path,
        lineStart: symbol.location.lineStart,
        lineEnd,
        snapshotId: result.analysis.identity.snapshotId,
      })
    : undefined
  const sourceCoversSymbol = symbol && source ? source.lineEnd >= symbol.location.lineEnd : false
  return { analysis: result.analysis, symbol, source, sourceCoversSymbol }
}
```

При `analysis.state === 'not_indexed'` helper возвращает это состояние без скрытого backfill; вызывающая сторона может отдельно решить, нужен ли ей явный `indexCodeSymbols`. `source` ограничен первыми 200 строками объявления, а `sourceCoversSymbol` показывает, покрывает ли excerpt весь symbol range. Если он неполный, не считай его полным телом: запрашивающая сторона может выбрать `getCodeContext({ includeLogical: true })` и использовать snapshot-bound continuation из omission, если budget оставил пропуск.

Если metadata capability отсутствует, используйте доступные `searchCode`/`readSource` или сообщите вызывающей стороне, что локальный adapter не поддерживает эту функцию. Не подменяйте отсутствие порта пустым полным результатом.

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
- В source candidate методы `indexCodeSymbols`, `findCodeSymbols`, `findCodeReferences` и `traceCodeCalls` являются необязательными портами; подробности, profile/cursor provenance и лимиты приведены в разделе выше. Типы `CodeSymbol`, `CodeSymbolReference`, `CodeSymbolAnalysisStatus` и result DTO экспортируются из `@zorya/search/code` этого candidate.
- `indexStatus(root, signal?)` возвращает текущий статус или пустую identity, если usable snapshot отсутствует. `denseAvailable` и `denseDisabledReason` показывают состояние vector-пути.
- `searchCode({ root, query, paths?, language?, sourceKind?, limit?, mode?, signal? })` возвращает `{ hits, identity, degraded, degradedReason }`. `language` принимает точный сохранённый идентификатор расширения либо распространённое имя (`typescript`, `javascript`, `python`, `markdown`); имя сопоставляется с сохранёнными вариантами расширений и не меняет `CodeHit.language`. `sourceKind` — `implementation`, `tests`, `documentation` или `all`; пропуск сохраняет полный прежний поиск. Классификация основана на соглашениях о путях: тестовые каталоги и `.test`/`.spec` файлы относятся к тестам, документационные каталоги и текстовые форматы — к документации, остальные индексированные файлы — к реализации. При необходимости ищите во всех категориях. Каждый hit несёт путь, строки, `snapshotId`, хеш chunk и сведения lexical/dense/rerank ранжирования. По умолчанию limit `10`; без моделей режим по умолчанию lexical. Явный `mode: 'lexical'` не вызывает embedding/rerank.

Если после обрезки пробелов запрос состоит ровно из одного JS/TS идентификатора, совпадающие AST-символы объявлений ставятся перед остальными найденными фрагментами. Такое совпадение учитывает разделённые на части объявления и перегрузки, сохраняет фильтры пути и языка и не убирает найденные вызовы и упоминания, которые помещаются в `limit`. В гибридном режиме объявления сохраняют обычные lexical/dense оценки; если фрагмента не было среди кандидатов reranker, у него остаётся `rerankRank: null`. Для текстовых и частичных запросов исходный порядок поиска не меняется.
- `readSource({ root, path, lineStart?, lineEnd?, snapshotId?, signal? })` читает текущий файл внутри root и сверяет его с актуальным snapshot. Несовпадение явно переданного `snapshotId` даёт `CODE_INDEX_SNAPSHOT_MISMATCH`; если изменившийся файл или snapshot обнаружен во время чтения, метод бросает `CodeIndexError` с кодом `CODE_INDEX_SOURCE_CHANGED` или `CODE_INDEX_SOURCE_CHANGED_DURING_READ`. Успешный результат имеет `stale: false`, а не `stale: true`. Без диапазона читается до 200 строк от `lineStart` (по умолчанию `1`); верхний предел одного запроса — 1000 строк. Результат содержит полный файловый `contentHash` для проверенного текущего файла и `snapshotId`. Штатный reader также возвращает `fileLineCount` — общее число строк по тому же правилу разбиения; поле опционально, поэтому старые adapters могут его не предоставлять. Это не тот же хеш, что `CodeHit.contentHash`, относящийся к chunk.
- `relatedCode({ root, path, symbol?, limit?, signal? })` возвращает разрешённые `imports`, `importedBy`, похожие lexical hits и identity. Эти связи не являются полным графом для всех языков.
- `watchRepository(root, { signal?, intervalMs?, onError? }?)` возвращает handle с `close()`. По умолчанию сверяет дерево раз в 5000 ms; разрешённый интервал 250–60000 ms.
- `close()` закрывает watchers, отменяет и дожидается операций самого индекса. Заимствованную database он не закрывает.

`createCodeContext({ index, limits? })` создаёт адаптер над уже открытым индексом. Его метод:

```ts
import type { CodeContextRequest, CodeContextResult } from '@zorya/search/context'

type GetCodeContext = (input: CodeContextRequest) => Promise<CodeContextResult>
```

Вызов берёт identity актуального индекса, выполняет query и optional feature queries, читает кандидатов в пределах символьного бюджета и возвращает секции с происхождением рангов, файловыми и chunk hashes, `degraded` и списком пропусков. `includeRelated` по умолчанию `false`. Необязательные `language` и `sourceKind` применяются к основному, дополнительным и related поискам. Классификация по пути является эвристикой. Явный `mustInclude` остаётся диапазоном, прямо выбранным вызывающей стороной, и не отбрасывается фильтрами. При `includeRelated: true` штатный code index обходит импортные связи до двух уровней и использует достигнутые файлы как фильтр одного дополнительного поиска по исходному query. `relatedDepth` (1–4) и `relatedMaxPaths` (1–64, по умолчанию 24) ограничивают обход и допустимы только вместе с opt-in. Ответ `relatedGraph` содержит snapshot identity, seed/node/edge provenance и признаки достижения лимитов. Узел указывает `relation: seed | imports | importedBy`; ребро сохраняет реальное направление `from` → `to` и отношение к текущему обходу. `reachedDepth` — максимальная глубина полученного узла, а `limits.depth` означает, что эта глубина достигла запрошенной границы; это не утверждение о наличии более дальних узлов. Import edge показывает только связь в исходном коде, а relevance ранжируется отдельным поиском. Legacy `CodeIndex` adapters без graph-порта сохраняют прежний related lookup и возвращают `relatedGraph.status: 'unsupported'`.

`includeLogical: true` независимо добавляет `logicalContext`; без этого opt-in поле не возвращается и прежний режим не меняется. Используются seeds текущего поиска и точные символы AST: подтверждённые контракты, прямые callees, не более двух outgoing call hops, входящие callers и тестовые owners, для которых есть статические связи. Это ограниченный статический контекст. `includeRelated` отдельно управляет import graph и похожими кандидатами; можно включить любое поле, оба или ни одного. `language` и `sourceKind` также фильтруют logical blocks; эвристические source filters не отменяют явный `mustInclude`, который читается первым.

`logicalContext.state` принимает `available`, `partial`, `not_indexed`, `unavailable` или `unsupported`. `analysisComplete` описывает symbol-analysis snapshot целиком; `block.complete` — покрытие диапазона конкретного блока. Эти признаки не доказывают полноту dynamic dispatch, dependency injection или runtime bindings; `runtimeCallCoverage` всегда `not_claimed`. Роли: `seed_definition`, `contract`, `callee`, `caller`, `test`, `source_fallback`. Seed имеет depth 0, прямое отношение — 1, второй outgoing hop — 2. Если chunk начинается с leading trivia, точная chunk attribution по имени или qualified name может подтвердить функцию/метод, даже если enclosing-range захватывает соседний текст. Неоднозначное имя, отсутствие надёжного enclosing символа или unknown edge остаются явным неполным fallback, а не подтверждённым целым блоком. Небольшой файл включается целиком только при известном `fileLineCount` и полном покрытии.

Секции и чтения логического контекста ограничены 200 строками. Они делят общий `maxChars` с остальными секциями запроса: бюджет по умолчанию — 24 000 символов; в SDK `CodeContextLimits.maxChars` можно явно увеличить до 100 000. Схема MCP сохраняет собственный предел 24 000. В пределах одной операции действуют caps: 8 seeds, 24 блока, 50 references на seed, 120 source reads и 80 записей omission; `limits`, `omissionsOmitted` и `omissionsTruncated` показывают усечение. Поэтому `partial` и отсутствие кандидата не доказывают отсутствие реализации. Continuation omission содержит `path`, `lineStart`, `lineEnd`, `snapshotId`; передайте его в `readSource` вместе с прежними `root` и `snapshotId`. Чтение должно отказать при несовпадении или устаревании источника; не назначайте старый snapshot заново и не запускайте backfill при чтении. Логический поиск идёт в пределах одной snapshot scope, а перед возвратом сверяется полная identity источника.

Типы `LogicalContextResult`, `LogicalContextBlock`, `LogicalContextOmission`, `LogicalRange` и `LogicalContinuation` экспортируются из `@zorya/search/context`. DTO сохраняет точные поля: result — `state`, `profileId`, `analysisComplete`, `coverage`, `blocks`, `omissions`, `omissionsOmitted`, `omissionsTruncated`, `limits`, `relationCoverage`, `runtimeCallCoverage`; coverage — `totalFiles`, `omittedFiles`, `counts` (`parsed`, `parseError`, `unsupported`, `truncated`, `error`), `unresolvedReferences`, `unresolvedCalls`, `truncation` (`symbols`, `references`, `files`). Block — `symbolId`, `name`, `kind`, `role`, `source`, `complete`, `includedRanges`, `relationFrom`, `relationKind`, `depth`, `wholeFile`. Omission — `symbolId`, `role`, `range`, `reason`, `continuation`; reason принимает `no_enclosing_symbol`, `source_filter`, `budget`, `read_limit`, `block_limit`, `symbol_limit`, `reference_limit`, `external`, `unresolved`, `ambiguous`, `missing_target`. `LogicalRange` имеет только `path`, `lineStart`, `lineEnd`; `LogicalContinuation` добавляет `snapshotId`. `relationCoverage` — `static_and_bounded`, `no_proven_relation` или `unavailable`; `runtimeCallCoverage` — только `not_claimed`. `relationKind` — `seed`, `reference`, `call`, `construct`, `test_reference` или `test_call`. `limits` возвращает `maxSeeds`, `seedsInspected`, `seedsTruncated`, `maxReferencesPerSeed`, `referencesInspected`, `maxBlocks`, `blocksSelected`, `maxSourceReads`, `sourceReads`, `maxRangeLines`, `referencesTruncated`, `symbolsTruncated`, `blocksTruncated`, `readsTruncated`.

Поля запроса определены в `CodeContextRequest`: `root`, `query`, `featureQueries`, `mustInclude`, `includeRelated`, `includeLogical`, `relatedDepth`, `relatedMaxPaths`, `language`, `sourceKind`, `maxChars`, `limit`, `signal`. Пути в `mustInclude` задаёт вызывающая сторона. Запись только `{ path }` означает ограниченный excerpt, а не полный файл: при пустых границах `readSource` начинает с первой строки и читает не более 200 строк; секция возвращает фактические `lineStart`/`lineEnd`. Поле `truncated` отражает срез необязательных candidate sections, если адаптер ограничил их через `maxRangeLines`. Обязательный `mustInclude` диапазон длиннее этого лимита завершается ошибкой `LIMIT`, а отсутствие границ оставляет `truncated: false` даже при скрытых последующих строках файла. Для получения определённого участка укажите обе границы; не считайте path-only секцию полным содержимым файла. При нехватке символьного бюджета обязательный диапазон не замалчивается: `CodeContextError('MANDATORY_BUDGET')` сообщает о нехватке `maxChars`. `getCodeContext` сам не добавляет результат в prompt.

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

Для одного вызова поиска типизированный `ProviderError` с кодом `auth`, `quota` или `rate_limit` завершает оставшиеся варианты discovery и возвращается как `DISCOVERY_AUTH`, `DISCOVERY_QUOTA` или `DISCOVERY_RATE_LIMIT`. Это ограничение действует только внутри текущей операции: следующий вызов начинает обычный поиск. Уже найденные документы и частичный результат кэша сохраняются; пустой успешный ответ, временная ошибка провайдера и обычная ошибка продолжают обработку по прежним правилам. Ошибки чтения документа относятся к другому этапу и не останавливают discovery. Совпадение имени, текста или полей произвольной ошибки не включает это поведение — нужен экземпляр класса `ProviderError`, экспортируемого SDK.

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

По умолчанию каждый экземпляр `createBraveWebSource` ограничивает частоту запросов независимо. Если приложение владеет несколькими экземплярами в одном процессе Node или его worker threads, оно может явно создать `const quota = createBraveQuotaState()` и передать один и тот же буфер как `sharedQuota` каждому источнику. Владелец передаёт SharedArrayBuffer в каждый worker thread через поддерживаемый Node механизм, например `workerData`; Search не создаёт глобальное состояние и не объединяет разные ключи автоматически. Участникам следует задавать одинаковый `limits.maxRequestsPerSecond`; если настройки различаются, действует более строгий общий интервал. Состояние также передаёт между участниками обнаруженные серверные cooldown и лимиты. Оно предназначено только для сотрудничающих потоков одного процесса: это не межпроцессный или распределённый лимитер. Владелец отвечает за то, какие экземпляры получают буфер; он не содержит ключей Brave.

```ts
// В главном потоке:
import { Worker } from 'node:worker_threads'
import { createBraveQuotaState } from '@zorya/search/providers'

const quota = createBraveQuotaState()
new Worker(new URL('./search-worker.js', import.meta.url), { workerData: { quota } })

// В search-worker.js:
import { workerData } from 'node:worker_threads'
import { createBraveWebSource } from '@zorya/search/providers'

const web = createBraveWebSource({
  apiKeyEnv: 'BRAVE_SEARCH_API_KEY',
  limits: { maxRequestsPerSecond: 2 },
  sharedQuota: workerData.quota,
})
```

`sharedQuota` принимает только буфер, созданный `createBraveQuotaState()` текущей совместимой версией SDK; размер, метаданные и версия проверяются при создании источника. Не редактируйте его содержимое вручную. Обычные экземпляры без этого параметра сохраняют отдельные квоты и не делят cooldown.

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
