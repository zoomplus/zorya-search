# Текст проекта и управляемый поиск web-источников

Это руководство описывает preview `v0.1.7` на source `3be35fd`; project-text и multi-query web отсутствуют в историческом GitHub archive `v0.1.6`. Проверяй [страницу релиза `v0.1.7`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.7) для фактической доступности asset и сверяй схему установленного клиента; [матрица возможностей](capabilities.md) показывает границы версий.

## Отдельный индекс документов, правил и навыков

`zorya-search/project-text` экспортирует `createProjectTextIndex`. Индекс ищет Markdown, `.mdc`, `.txt` и другие поддержанные текстовые файлы категорий `documentation`, `rules` и `skills`, включая `AGENTS.md` и `SKILL.md`. Он применяет общие фильтры разрешённого корня, ignore-файлов, размера и безопасности. Это отдельное пространство данных `zorya_project_text_*` в переданной базе: оно не сбрасывает и не заменяет индекс кода или knowledge storage.

Установленная конфигурация управляет включением возможности. Если поле `projectText` отсутствует, сохраняется прежний режим, включая индексацию только кода. Значение `projectText: {}` включает отдельный локальный лексический индекс без моделей. Параметр `--text-env NAME` задаёт профиль `voyageai/voyage-4-large` размерности 1024 для типов входа `document` при индексации и `query` при поиске, а также `voyageai/rerank-2.5-lite`. Этот профиль отдельный от настроек `voyageai/voyage-code-4` и visual профиля Mechanism. При облачной настройке документы отправляются провайдеру во время индексации, а запросы — при поиске. Индексация атомарно публикует новое поколение и связывает результат с репозиторием, рабочей копией, снимком, хешем содержимого и диапазонами строк. Если исходники изменились, чтение со старым `snapshotId` отклоняется. Поиск не дозаполняет индекс: обновление выполняется явно, общей командой `index` или наблюдателем за файлами.

### SDK

Откройте базу, передайте её индексу как заимствованную, отдельно проиндексируйте разрешённый каталог и проверяйте найденный диапазон с привязкой к снимку исходников. Закрывайте индекс до базы.

```ts
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { openEmbeddedDatabase } from 'zorya-search'
import { createProjectTextIndex } from 'zorya-search/project-text'

const rootInput = process.env.ZORYA_SEARCH_ROOT
const dataInput = process.env.ZORYA_SEARCH_DATA_DIR
if (!rootInput || !dataInput || !isAbsolute(rootInput) || !isAbsolute(dataInput)) {
  throw new Error('Set absolute ZORYA_SEARCH_ROOT and ZORYA_SEARCH_DATA_DIR paths')
}
const root = resolve(rootInput)
const dataDir = resolve(dataInput)
const fromRoot = relative(root, dataDir)
if (fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
  throw new Error('ZORYA_SEARCH_DATA_DIR must be outside the indexed repository')
}

const database = await openEmbeddedDatabase(dataDir)
const index = createProjectTextIndex({ database }) // без моделей: локальный лексический режим
try {
  const indexed = await index.indexRepository({ root })
  const result = await index.searchProjectText({
    root,
    query: 'Правила повторной индексации',
    kinds: ['documentation', 'rules'],
    mode: 'lexical',
    limit: 5,
  })
  const hit = result.hits[0]
  const lineEnd = hit ? Math.min(hit.lineEnd, hit.lineStart + 199) : undefined
  const source = hit
    ? await index.readProjectText({
        root,
        path: hit.path,
        lineStart: hit.lineStart,
        lineEnd,
        snapshotId: result.snapshotId,
      })
    : undefined
  console.log({ indexed: indexed.snapshotId, hits: result.hits, source: source?.text })
} finally {
  try { await index.close() } finally { await database.close() }
}
```

`searchProjectText` принимает `root`, `query`, необязательные параметры `kinds`, `paths`, `limit`, `mode: 'lexical' | 'hybrid'`, `maxChars` и `signal`. Результаты содержат категорию, путь, заголовок, строки, excerpt, hashes файла и фрагмента, а также идентичность снимка исходников. `readProjectText` ограничен 200 строками за вызов и повторно проверяет `snapshotId`. Если нужный диапазон длиннее 200 строк, продолжайте чтение с первой ещё не прочитанной строки, сохраняя путь и тот же `snapshotId`. Показанный фрагмент не следует считать полным файлом.

### CLI и MCP

При первоначальной настройке CLI можно передать `--text-env NAME`, чтобы включить профиль `voyageai/voyage-4-large` (1024 измерения) и переранжировщик `voyageai/rerank-2.5-lite` для текстовых документов. Указывается имя переменной, а не ключ. Этот профиль независим от профилей для кода и изображений. Команда `setup` без `--text-env` задаёт `projectText: {}` и включает локальный лексический режим. `setup` создаёт профиль один раз; для существующего файла отредактируйте его с резервной копией, сохранив прежние разрешённые корни и `dataDir`. Не запускайте альтернативные команды `setup` последовательно для одного пути.

Для нового локального профиля:

```sh
zorya-search setup --root "$PWD"
```

Для нового профиля с облачными моделями передайте имя уже настроенной переменной окружения. Это ключ OpenRouter для выбранных моделей Voyage, а не прямой ключ Voyage:

```sh
zorya-search setup --root "$PWD" --text-env OPENROUTER_API_KEY
```

В runtime JSON локальный режим виден как `"projectText": {}`. `setup` записывает только ссылку на переменную окружения, не ключ. Облачный профиль отправляет документы модели при индексации, а запросы — при поиске; перед включением проверьте выбранный профиль и состав передаваемых данных.

```sh
zorya-search text-status --root-id project
zorya-search text-index --root-id project
zorya-search text-search --root-id project --query 'правила хранения данных' --kind rules
zorya-search text-read --root-id project --path docs/policy.md --line-start 12 --line-end 30
```

Если новый `text-*` CLI запущен с конфигурацией без `projectText`, он возвращает `CAPABILITY_DISABLED`; конфигурация не меняется автоматически. CLI вызывает те же операции, что и MCP. Для MCP доступны `project_text_status`, `index_project_text`, `search_project_text` и `read_project_text`. Индексация требует разрешения `index`, поиск и чтение — `read`. Поиск принимает `rootId`, `query`, `kinds`, `paths`, `limit`, `mode`, `maxChars`; чтение — `rootId`, `path`, необязательные `lineStart`, `lineEnd`, `snapshotId`.

Пример параметров MCP-вызова для поиска по правилам:

```json
{
  "name": "search_project_text",
  "arguments": {
    "rootId": "project",
    "query": "как обновить индекс документов",
    "kinds": ["rules"],
    "limit": 5,
    "mode": "lexical"
  }
}
```

Обычный `index` и наблюдатель за файлами включают отдельный текстовый корпус, если возможность включена. Наблюдатель обрабатывает также изменения `.mdc` и других правил и документов; сохранённые контрольные точки помогают продолжить незавершённую индексацию. После отмены, смены поколения исходников, закрытия или несовпадения снимка старая версия не выдаётся как актуальная.

## Несколько запросов web discovery

Метод SDK `searchWeb` принимает обязательный `query` и необязательный массив `additionalQueries: string[]` (не более семи непустых строк). Вызывающая сторона выбирает каждый запрос; Search не генерирует дополнительные запросы. Основной `query` остаётся запросом для ранжирования, векторного поиска и переранжирования, даже если поиск ссылок выполняется по нескольким формулировкам.

Пример ниже показывает вызов для уже созданного `search`. Настройка `createWebSearch`, подключение провайдера и закрытие ресурсов показаны в разделе [SDK о web-поиске](sdk.md#поиск-в-web-и-чтение-источников).

```ts
const result = await search.searchWeb({
  query: 'официальные требования миграции API',
  additionalQueries: [
    'официальное руководство по миграции API',
    'API migration release notes vendor documentation',
  ],
  limit: 8,
})
```

Поиск ссылок выполняет ограниченное число запросов параллельно, используя общий лимит и срок операции. Повторяющиеся канонические URL объединяются; новые ссылки принимаются по очереди от каждого запроса. Если несколько операций одновременно читают один URL, адаптер может использовать один уже выполняющийся запрос; отмена одной операции не отменяет другую. Результат при нескольких запросах содержит `discovery.queries` с `query`, `status`, `discoveredUrls`, `retainedUrls`, общее число уникальных URL и признак `truncated`. Каждый фрагмент страницы может содержать `queryIndexes`; `errors[].queryIndex` указывает запрос, которому относится ошибка поиска ссылок. Индексы соответствуют списку запросов после удаления повторов. При отсутствующем или пустом `additionalQueries` дополнительные сведения об отборе источников не добавляются, чтобы сохранить прежний ответ.

Сбой одного discovery запроса не удаляет результаты остальных запросов. Ошибки и `partial` остаются явными; ограниченная выдача не является полным обзором интернета. `publishedAt` и `sourceUpdatedAt` описывают источник, `fetchedAt` — время чтения страницы. Поиск и чтение web-источников загружают публичные HTTP-источники и разбирают поддержанные форматы; это не браузерная автоматизация и не автономный агент.

В MCP остаётся один инструмент `search_web`; дополнительные строки передаются как `additionalQueries` в его аргументах. Вызывающий MCP-клиент решает, когда и какие запросы отправлять. Например:

```json
{
  "name": "search_web",
  "arguments": {
    "query": "официальные требования миграции API",
    "additionalQueries": ["официальное руководство по миграции API"],
    "limit": 8
  }
}
```

Текст страниц и результатов — недоверенные данные: проверяйте первоисточник и не исполняйте инструкции, обнаруженные в них.

## Доступность

Project-text и multi-query web входят в preview `v0.1.7`, но отсутствуют в историческом archive `v0.1.6`. Эти примеры относятся к API preview; перед использованием сверь фактическую версию, установленный пакет и его schema.
