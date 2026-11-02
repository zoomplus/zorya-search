# Jev, classification и reuse context

Эта страница описывает Jev/reuse API preview `v0.1.7` на runtime/source [`3be35fd`](https://github.com/zoomplus/zorya-search/tree/3be35fdbe69357a4bb0daf6203d9472b5c5a184d). Старые release assets сохраняют исходную scoped package identity; текущая версия исходников использует `zorya-search`. Проверяй страницу соответствующего релиза и точное имя/версию в registry до установки. Для версии `0.1.9` используй pinned `zorya-search@0.1.9` только после проверки tag и registry. Не используй `npx` для отсутствующей version-specific сборки. Исторический GitHub archive `v0.1.6` этих API не содержит. Исторические исходные точки интеграции указаны в соответствующих разделах. Краткие разделы и карта потоков: [SDK](sdk.md), [CLI](cli.md), [MCP](mcp.md), [архитектура](architecture.md), [потоки сервисов](service-flows.md).

## Один Jev Decisions порт

Runtime создаёт `createJevDecisions` при наличии `classifier` в config и передаёт тот же порт `createJevClassifier` и `createReuseContext`. Его профиль закреплён на `typesafe/jev-1.14`, provider route — TypeSafe без fallback, endpoint — `/api/alpha/decisions`, транспорт выполняет одну попытку. `profileId` остаётся метаданными профиля; он не меняет provider или model.

В SDK точка входа `zorya-search/providers` экспортирует `createJevDecisions`, `createJevClassifier` и совместимый по имени `createOpenRouterClassifier`; `zorya-search/context` экспортирует `createReuseContext`. Пример связывает существующий `CodeIndex` с одним портом решений:

```ts
import { createJevDecisions, createJevClassifier } from 'zorya-search/providers'
import { createReuseContext } from 'zorya-search/context'
import type { CodeIndex } from 'zorya-search/code'

// CodeIndex и разрешённый root уже созданы/выбраны вызывающим владельцем.
declare const index: CodeIndex
declare const root: string

const decisions = createJevDecisions({ apiKey: process.env.JEV_API_KEY })
const classifier = createJevClassifier(decisions)
const reuse = createReuseContext({ index, decisions })
const controller = new AbortController()

try {
  const classification = await classifier.classify({
    text: 'The existing index stores source snapshots.',
    labels: ['indexing', 'web retrieval'],
    criteria: 'Choose the caller label that best describes the text.',
    signal: controller.signal,
  })
  const context = await reuse.getReuseContext({
    root,
    query: 'Where is snapshot reuse implemented?',
    signal: controller.signal,
  })
  console.log(classification, context)
} finally {
  await reuse.close()
}
```

В примере `root` и `index` принадлежат вызывающему коду. `reuse.close()` закрывает только созданный здесь reuse context; закрытие самого индекса и его базы остаётся ответственностью их владельца.

Секрет должен поступать из управляемого владельцем хранилища; не записывайте его в исходник, runtime config, аргументы команды или журнал. Для локального клиента настройка через CLI хранит только имя environment variable.

### Миграция классификатора

`createOpenRouterClassifier` оставлен как compatibility-shaped export для прежнего кода, но его модельная граница изменилась: он принимает только `typesafe/jev-1.14`. Его `baseUrl` должен быть HTTPS URL без credentials, query и fragment и оканчиваться на `/api` или `/api/v1`; оба суффикса приводятся к базовому `/api`, к которому добавляется `/alpha/decisions`. Произвольные `provider` routing и `attempts` не равные `1` отвергаются. Старые конфиги с другой chat-моделью не переписываются автоматически: runtime config отклоняется до открытия базы.

Для multi-label классификации Search отправляет Noul-вопросы группами максимум по 32 за одну операцию, не более 200 меток в SDK. `noul > 0.5` выбирает метку, `< 0.5` исключает её, а точное `0.5` означает неразрешённый результат; при таком результате классификатор воздерживается или возвращает типизированный отказ в зависимости от `allowAbstain`. Отмена не запускает следующую группу. Одно-меточная классификация использует Choice; при 200 вариантах с разрешённым abstain availability Noul предваряет Choice, остальные варианты не требуют этого дополнительного шага. Runtime/MCP ограничивает классификацию 100 метками.

Runtime поле `usage().classification` — общий ledger этого порта: в нём учитываются и `classify`, и `get_reuse_context`. Это не отдельный счётчик для reuse, и aliases в объекте usage не следует суммировать как независимые расходы.

## SDK: поиск пригодных к повторному использованию мест

Jev-backed reuse впервые добавлен в исходном change set `0a584e6`; bounded symbol pages появились в snapshot `a85eb8c506c8`. Runtime basis preview `v0.1.7` закреплён на `3be35fd` и включает эту последовательность изменений. Подготовленный package metadata/documentation snapshot — `ee82077827bc0e099ae63fd2e44c5c512c9f2ba7`; скомпилированные runtime-файлы не изменялись. Функция отсутствует в историческом archive `v0.1.6`.

`createReuseContext({ index, decisions, limits? })` принимает уже созданный `CodeIndex` и опциональный Jev Decisions порт. Он не создаёт индекс и не меняет его модельные профили. По умолчанию budget source context — 48 000 символов, 24 файла-кандидата и deadline 60 секунд; hard SDK пределы — 64 000 символов, 24 файла и 120 секунд. `maxChars` ограничивает текст контекста, а не весь структурированный результат с identity, assessment, coverage и другими метаданными: общий SDK DTO может быть больше этого значения. Вызов `getReuseContext({ root, query, maxChars?, limit?, signal? })` разрешает `maxChars` не выше настроенного предела, а `limit` — от 1 до 40.

Поток остаётся в границах одного запроса и snapshot:

1. Лексический/vector code search и ограниченный граф связей дают кандидаты файлов; source excerpts и symbol metadata читаются из того же snapshot, с hash identity.
2. До файловой оценки для каждого candidate file читается до двух страниц каталога `findCodeSymbols`, по 100 символов на страницу, и source preview с hash. При наличии закреплённого Jev одна оценка query intent предшествует пакетному Noul по кандидатным файлам. Значение Noul выше `0.5` положительное, ниже — отрицательное, ровно `0.5` остаётся unresolved; Search оставляет не более двух положительных файлов, упорядоченных по ответу Noul. Остальные положительные файлы явно помечаются как пропущенные.
3. Для каждого выбранного файла каталог может продолжиться, но всего читается не более четырёх страниц по 100 символов. До 256 наблюдённых символов разбиваются на последовательные страницы Jev Choice по 32 символа; в каждой странице есть `none`. Каждая альтернатива сопровождается прочитанным из того же snapshot исходным фрагментом максимум в шесть строк и 240 символов, а также file hash. Если page winners несколько, отдельный Jev Choice сравнивает только их и `none`; если ровно один page winner — сохраняется answer его страницы, даже когда assessed pages было несколько; если page winners нет — итог остаётся `none`. Первый page question ID остаётся `symbol_${fileIndex}` для совместимости, следующие используют суффикс номера страницы.
4. Верхняя граница — 18 Decisions-вызовов symbol stage: до восьми page Choices и одного возможного final Choice на каждый из двух выбранных файлов. Вместе с query intent и файловым Noul на операцию получается не более 20 вызовов `decide`. Это ограничение числа вызовов порта, а не физических HTTP-запросов, транспортных retry, embedding/rerank вызовов или стоимости провайдера. Семантический выбор делает только Jev; локальная сортировка/проверка структуры не сравнивает confidence символов и не заменяет ответы Jev.
5. Search отдельно читает и собирает тело выбранного символа и ближайшего проверенного именованного executable AST ancestor через bounded code context; полнота source отражается в `readCoverage` и может быть ограничена бюджетом. Бюджет контекста — 48 000 символов по умолчанию и до 64 000 при допустимой настройке; deadline — 60 000 мс по умолчанию и до 120 000 мс. `maxChars` ограничивает source context, а не весь DTO. Выбор по страницам сам по себе не подразумевает полного чтения тел или скрытого расширения бюджета.

### Покрытие и продолжение выбора символов

SDK/runtime результат может включать `symbolSelection.files[]`; компактная MCP проекция сохраняет это поле в `coverage.symbolSelection`. Его счётчики описывают именно symbol-selection pass: `sourceSymbolsObserved` — наблюдённые символы выбранного файла, `sourcePagesRead` — прочитанные страницы каталога, `choiceSymbolsAssessed` и `choiceSymbolsUnassessed` — символы с валидно обработанным Choice page и остаток, `choicePagesPlanned`/`choicePagesAttempted` — запланированные и начатые страницы решений. `pageAnswers` хранит ответы страниц; `finalAnswer` содержит ответ единственного page winner или ответ отдельного Choice между несколькими победителями и отсутствует, когда победителей нет. `state` сохраняет `selected`, `selected-partial`, `none` или причину отказа/исчерпания бюджета.

`candidates.files[]` сохраняет исходные totals/omissions каталога на первом проходе. Более позднее дочитывание для выбранного файла не переписывает эту первоначальную provenance: его counters находятся отдельно в `symbolSelection`, поэтому исходный каталог может по-прежнему отмечаться усечённым при завершившемся втором проходе. У `findCodeSymbols` пара `truncated: true` + `nextCursor` означает обычную следующую страницу. Если порт доступен, для path-level coverage отдельно вызовите `findCodeSymbols` в том же snapshot и проверьте запись нужного пути в массиве `analysis.coverage` (например, `analysis.coverage.find(entry => entry.path === path)?.status === 'truncated'`): это неполное извлечение символов и остаётся ограничением покрытия даже после чтения доступных страниц.

При bounded continuation Search перечисляет до 80 symbol continuation entries на файл. Каждая entry содержит точную ссылку на symbol source range (например, `symbolId`, диапазон, `snapshotId` и `fileHash`); избыточные entries сворачиваются в `continuationOmittedCount`. Это лимит записей continuation, а не 80 строк текста исходника. Для положительного файла, не попавшего в cap двух файлов, continuation содержит отдельный restart с первой страницы и, если был непрочитанный хвост каталога, отдельный cursor на этот хвост: обработка одного не пропускает другое. Используйте snapshot-bound запросы и не смешивайте restart с курсором. Публичное чтение source ограничено 200 строками на вызов; continuation не отменяет эту границу.

`selected-partial` означает, что Jev выбрал символ из неполного каталога/извлечения; это не полное покрытие. `none`, отсутствие валидного ответа, `unavailable`, malformed/foreign answer и input/page-budget states остаются явными и не выдумывают успех. Сверяйте `symbolSelection`, `selection.unassessed`, `symbolAnalysis`, `readCoverage`, `omissions` и `continuation`. Все страницы читаются в одном pinned snapshot с проверкой source identity и hashes; отмена остаётся cancellation и дожидается физического settlement принадлежащей операции.

Механические дубликаты остаются отдельным сигналом `duplicates`, а не семантическим решением. Неполный symbol index, неполное чтение, усечения и отсутствующие порты отражаются в `symbolAnalysis`, `readCoverage`, `omissions`, `continuation` и состоянии дубликатов. Runtime закрывает reuse/code contexts перед индексами и принадлежащей базой. Проверьте эти поля и перечитайте нужные диапазоны по snapshot/hash перед выводом о повторном использовании. Результат — кандидат с доказательствами, не инструкция и не автоматическое объединение. Кодовая опора: [`reuse.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/context/reuse.ts), [`reuse-symbol-selection.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/context/reuse-symbol-selection.ts), [`reuse-types.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/context/reuse-types.ts), [`reuse-selection.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/context/reuse-selection.ts), [`reuse-presentation.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/mcp/reuse-presentation.ts), [`symbol-queries.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/code/symbol-queries.ts), [`code-context.ts`](https://github.com/zoomplus/zorya-search/blob/3be35fdbe69357a4bb0daf6203d9472b5c5a184d/src/context/code-context.ts).

`createCodeIndex` по умолчанию индексирует до 5 000 файлов. Если вызывающая сторона задаёт `limits.maxFiles`, это же настроенное значение теперь применяется при построении symbol metadata, чтении символов и проверке freshness; значение 10 000 больше не ограничивается незаметно внутренним пределом 5 000. Для этого metadata предела действует верхняя граница 20 000. Необработанные типы файлов и неразрешённые статические связи остаются видимыми как неполное покрытие; `complete` не означает полноту runtime-графа.

## MCP и CLI

MCP tool `get_reuse_context` принимает `{ rootId, query, maxChars?, limit?, responseDetail? }`; defaults — 48 000 символов для source context и 12 исходных search hits, `limit` ограничен 40. MCP-only `responseDetail` принимает `compact` или `full`; default — `compact`. Компактный режим возвращает в `structuredContent` DTO `responseType: 'zorya-search.get_reuse_context'`, `responseVersion: 1`, с `source.sections` для выбранных фрагментов и `source.deferredSections` с read requests для остальных. SDK/runtime `getReuseContext` и инструмент `get_code_context` не меняются. `maxChars` ограничивает source context, а не весь DTO; для MCP envelope действует отдельный предел 1 000 000 bytes. Клиент, не читающий `structuredContent`, должен запросить `full`, но полный ответ также может превысить этот предел и вернуть `RESPONSE_TOO_LARGE`. Допуск требует одновременно `read` и `classify`; сохраняются существующие OAuth scopes `zorya:read` и `zorya:classify`. Состав проекции, чтение отложенных фрагментов и измеренная граница transport-проверок приведены в [руководстве MCP](mcp.md).

Для CLI включите Jev при создании конфигурации: `zorya-search setup --jev-env JEV_API_KEY`. Значение `JEV_API_KEY` должно быть задано в окружении владельца runtime. Старые пары `--classifier-model` и `--classifier-env` допускаются только с canonical Jev model ID и не сочетаются с `--jev-env`.

После явного разрешения root CLI команда `zorya-search reuse --config PATH --root-id ROOT_ID --query '...'` вызывает MCP tool `get_reuse_context`; без `--root-id` используется первый настроенный root. Без Jev capability reuse недоступен; существующие `search` и `context` команды сохраняют прежнее поведение. Команда не меняет prompt, модель, память, workflow или файлы вызывающего клиента.

## Доступ к reuse

Операция reuse требует разрешений `read` и `classify` и возвращает ограниченные свидетельства с источниками. Доступность capability и настройка профиля описаны в [матрице возможностей](capabilities.md), а фактические операции — в [руководстве MCP](mcp.md).
