# Профили Voyage для Zorya Search

`@zorya/search/providers` экспортирует замороженный `MECHANISM_RETRIEVAL_PRESETS`. Он описывает два независимых пространства векторов, сверенных с конфигурацией retrieval в Mechanism:

| Профиль | Модель | Размерность | Кандидаты | Результаты по умолчанию |
| --- | --- | ---: | ---: | ---: |
| code | `voyageai/voyage-code-4` | 1024 | 30 до rerank | 8 после `voyageai/rerank-2.5-lite` |
| visual | `voyageai/voyage-multimodal-3.5` | 1024 | временная коллекция ссылок | 5 |

Одинаковая размерность не объединяет индексы: provider, модель, профиль, задача embedding и пространство входят в идентичность профиля. Старые записи другого профиля не становятся совместимыми автоматически. Для перехода существующего code index на профиль Voyage нужно явно переиндексировать настроенный корень; прежние данные и настройки клиента Search не удаляет.

## Runtime config

Профили включаются независимо. В `secrets.json` хранятся только значения секретов, а конфигурация содержит ссылку:

```json
{
  "version": 1,
  "dataDir": "/var/lib/zorya-search",
  "roots": [{ "id": "repo", "path": "/work/project" }],
  "mechanism": {
    "code": { "secret": { "kind": "env", "name": "OPENROUTER_API_KEY" } },
    "visual": { "secret": { "kind": "env", "name": "OPENROUTER_API_KEY" } }
  }
}
```

Настройка `mechanism` должна включать `code`, `visual` или оба. Для каждого задаётся обычная runtime `SecretReference` и необязательные общие HTTP limits. Кодовый профиль не принимает дополнительный embedding рядом с `mechanism.code`: такое сочетание отклоняется как неоднозначное. Legacy `reranker` остаётся отдельным профилем web-поиска и не переопределяет кодовый Voyage reranker. Код и visual требуют только явно включённой своей модальности; невыбранный профиль не отправляет запросов.

```ts
import { openSearchRuntime } from '@zorya/search/runtime'

const runtime = await openSearchRuntime({
  config: {
    version: 1,
    dataDir: '/var/lib/zorya-search',
    roots: [{ id: 'repo', path: '/work/project' }],
    mechanism: { code: { secret: { kind: 'env', name: 'OPENROUTER_API_KEY' } } },
  },
})
try {
  await runtime.indexRepository({ rootId: 'repo' })
  const result = await runtime.searchCode({ rootId: 'repo', query: 'request cancellation' })
  // Voyage profile: максимум 8 результатов по умолчанию; limit можно задать явно.
  console.log(result.hits)
} finally {
  await runtime.close()
}
```

Code поиск сохраняет lexical+dense reciprocal-rank fusion. В Voyage режиме он отправляет до 30 fusion-кандидатов в `rerank-2.5-lite`, передавая `top_n` равный запрошенному пределу (8 по умолчанию, максимум 30 кандидатов). Затем возвращается не больше запрошенного `limit`. Это не чистый cosine top-k. Сбой embedding или rerank остаётся ошибкой операции, а явный lexical режим обходит внешние модели.

## Visual SDK и MCP

Visual использует `createVisualSearch` с Voyage multimodal adapter. Для одного SDK вызова можно подать ссылки и текст запроса; индекс существует в памяти конкретной операции и закрывается по её завершении. При прямом SDK использовании вызывающая сторона создаёт `createVisualSearch` и передаёт `runtime.profiles().visual` вместе с embedding port только из своего доверенного кода. MCP предоставляет то же ограниченное поведение через отдельный tool:

`search_visual_references({ references, queryText | queryImage, limit? })`

- `references`: 1–12 элементов с `id`, SHA-256 `contentHash`, ровно одним из `text` или `image` и необязательными `screen`, `state`, `breakpoint`.
- `image` и `queryImage`: `{ mimeType, dataBase64 }`; допускаются только PNG, JPEG, WebP и GIF. Каждый decoded image ограничен 2 MB, общий объём запроса — 8 MB.
- Запрос должен содержать ровно один `queryText` или `queryImage`; `limit` от 1 до 5, по умолчанию 5.
- Выход содержит упорядоченные ссылки, их метаданные, оценки и идентификатор visual-профиля. Векторные данные и исходные байты не возвращаются.

MCP tool появляется только когда владелец включил `mechanism.visual` и access grant отдельно содержит операцию `visual`. Без неё сервер сохраняет исходные 11 инструментов. MCP-клиент не может передавать URL, filesystem path, разрешённые roots, модель или секрет; Search не захватывает экран и не загружает изображения из сети.

SDK использует тот же контракт, но владелец сам создаёт короткоживущий visual index:

```ts
import { createVisualSearch } from '@zorya/search/visual'
import { createOpenRouterMultimodalEmbedding, MECHANISM_RETRIEVAL_PRESETS } from '@zorya/search/providers'

// bytes и hash получены и проверены вызывающим владельцем; image URL не принимается.
const visualProvider = createOpenRouterMultimodalEmbedding({
  baseUrl: 'https://openrouter.ai/api/v1',
  model: MECHANISM_RETRIEVAL_PRESETS.visual.model,
  dimensions: MECHANISM_RETRIEVAL_PRESETS.visual.dimensions,
  apiKey: process.env.OPENROUTER_API_KEY!,
})
const visual = createVisualSearch({ enabled: true, embedding: visualProvider, profile: visualProvider.profile })
try {
  await visual.upsert({ reference: { id, contentHash, screen: 'settings' }, image: { bytes, mimeType: 'image/png' } })
  const matches = await visual.search({ text: 'save button', filters: { screen: 'settings' }, limit: 5 })
} finally {
  await visual.close()
}
```

Provider usage учитывает реальные HTTP-попытки отдельно для code embedding, code rerank, visual embedding и legacy/web providers. Секреты не включаются в profiles, usage или результаты. Unit fixtures подтверждают построение wire payload и обработку ответов; сами по себе они не подтверждают живую доступность OpenRouter или качество моделей.
