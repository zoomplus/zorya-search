# Jev, classification и reuse context

Эта страница описывает source candidate `0a584e64c10d1a9d46b18d1e199979f2787f647d`. Функции ниже доступны в этом кандидате; GitHub archive `v0.1.6` их не содержит, а пакет `@zorya/search` пока не опубликован в npm. Не используйте команды `npx` как способ получить эти изменения: для эксперимента нужен checkout этого source candidate. Краткие разделы и карта потоков: [SDK](sdk.md), [CLI](cli.md), [MCP](mcp.md), [архитектура](architecture.md), [потоки сервисов](service-flows.md).

## Один Jev Decisions порт

Runtime создаёт `createJevDecisions` при наличии `classifier` в config и передаёт тот же порт `createJevClassifier` и `createReuseContext`. Его профиль закреплён на `typesafe/jev-1.14`, provider route — TypeSafe без fallback, endpoint — `/api/alpha/decisions`, транспорт выполняет одну попытку. `profileId` остаётся метаданными профиля; он не меняет provider или model.

В SDK точка входа `@zorya/search/providers` экспортирует `createJevDecisions`, `createJevClassifier` и совместимый по имени `createOpenRouterClassifier`; `@zorya/search/context` экспортирует `createReuseContext`. Пример связывает существующий `CodeIndex` с одним портом решений:

```ts
import { createJevDecisions, createJevClassifier } from '@zorya/search/providers'
import { createReuseContext } from '@zorya/search/context'
import type { CodeIndex } from '@zorya/search/code'

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

Runtime поле `usage().classification` — общий ledger этого порта: в нём учитываются и `classify`, и `get_reuse_context`. Это не отдельный счётчик для reuse, и aliases в объекте usage не следует суммировать как независимые расходы. Сравнение полной стоимости также должно отдельно учитывать вызовы и токены исходного agent-а, стоимость подготовки индекса и её амортизацию. Меньший внутренний расход Search сам по себе не доказывает экономию всего workflow.

## SDK: поиск пригодных к повторному использованию мест

`createReuseContext({ index, decisions, limits? })` принимает уже созданный `CodeIndex` и опциональный Jev Decisions порт. Он не создаёт индекс и не меняет его модельные профили. По умолчанию budget source context — 48 000 символов, 24 файла-кандидата и deadline 60 секунд; hard SDK пределы — 64 000 символов, 24 файла и 120 секунд. `maxChars` ограничивает текст контекста, а не весь структурированный результат с identity, assessment, coverage и другими метаданными: общий SDK DTO может быть больше этого значения. Вызов `getReuseContext({ root, query, maxChars?, limit?, signal? })` разрешает `maxChars` не выше настроенного предела, а `limit` — от 1 до 40.

Поток остаётся в границах одного запроса и snapshot:

1. Лексический/vector code search и ограниченный граф связей дают кандидаты файлов; source excerpts и symbol metadata читаются из того же snapshot, с hash identity.
2. При наличии закреплённого Jev Search сначала оценивает смысл запроса, затем независимо оценивает релевантность файлов через Noul и выбор символов через native Choice из фактически переданного source evidence. Для Noul значение выше `0.5` означает положительную оценку, ниже — отрицательную, ровно `0.5` оставляет результат unresolved; tied/invalid Choice или malformed ответы не превращаются в локальную догадку. Вся семантическая оценка — максимум четыре Decisions-вызова, включая query intent.
3. Search возвращает ограниченный code context, до двух выбранных файлов и символов, file assessments, coverage, omissions и continuation. В body-контексте используются исходные тела и ближайший проверенный именованный executable AST ancestor. Если Jev недоступен, ответ сохраняет `unavailable`, `unassessed` или typed error; локальные regex/keywords не подменяют вердикт.

Механические дубликаты остаются отдельным сигналом `duplicates`, а не семантическим решением. Неполный symbol index, неполное чтение, усечения и отсутствующие порты отражаются в `symbolAnalysis`, `readCoverage`, `omissions`, `continuation` и состоянии дубликатов. Отмена операции дожидается физического завершения принадлежащих ей работ; runtime закрывает reuse/code contexts перед индексами и принадлежащей базой. Проверьте эти поля и перечитайте нужные диапазоны по snapshot/hash перед выводом о повторном использовании. Результат — кандидат с доказательствами, не инструкция и не автоматическое объединение.

`createCodeIndex` по умолчанию индексирует до 5 000 файлов. Если вызывающая сторона задаёт `limits.maxFiles`, это же настроенное значение теперь применяется при построении symbol metadata, чтении символов и проверке freshness; значение 10 000 больше не ограничивается незаметно внутренним пределом 5 000. Для этого metadata предела действует верхняя граница 20 000. Необработанные типы файлов и неразрешённые статические связи остаются видимыми как неполное покрытие; `complete` не означает полноту runtime-графа.

## MCP и CLI

MCP tool `get_reuse_context` принимает `{ rootId, query, maxChars?, limit? }`; по умолчанию source context ограничен 48 000 символами и 12 исходными search hits, `limit` ограничен 40. Это не общий лимит размера всего ответа: serialized MCP envelope содержит и `structuredContent`, и текстовую копию результата. Для envelope действует отдельный предел 1 000 000 bytes; превышение возвращает `RESPONSE_TOO_LARGE`. Допуск требует одновременно `read` и `classify`. При отсутствии любого из разрешений сервер скрывает новый tool при фильтрации инструментов, а capability `reuseContext` сообщает `false`; обработчик проверяет доступ до runtime, чтения source и provider-вызова. Используются уже существующие OAuth scopes `zorya:read` и `zorya:classify`, новых scopes нет. Локальный trusted stdio proxy регистрирует тот же контракт.

Для CLI включите Jev при создании конфигурации: `zorya-search setup --jev-env JEV_API_KEY`. Значение `JEV_API_KEY` должно быть задано в окружении владельца runtime. Старые пары `--classifier-model` и `--classifier-env` допускаются только с canonical Jev model ID и не сочетаются с `--jev-env`.

После явного разрешения root CLI команда `zorya-search reuse --config PATH --root-id ROOT_ID --query '...'` вызывает MCP tool `get_reuse_context`; без `--root-id` используется первый настроенный root. Без Jev capability reuse недоступен; существующие `search` и `context` команды сохраняют прежнее поведение. Команда не меняет prompt, модель, память, workflow или файлы вызывающего клиента.

## Что подтверждено и что открыто

Для этого source candidate отдельно проверены локальные HTTP/stdio контракты и OAuth-граница; также есть ограниченное live openDEV свидетельство на конкретных запросах и хешированных строках исходника. Эти результаты относятся к указанным тестовым условиям. Они не доказывают превосходство над агентом без Search, универсальное качество на произвольных задачах, выпуск npm, готовность hosted клиента или полную приёмку программы.

Восемь запечатанных hard cases (четыре Mechanism и четыре Assistant) не открывались. Парное сравнение с вызывающим агентом по качеству и общим токенам ещё не выполнено; подготовка текстовых корпусов не является итоговым индексом или quality acceptance. npm-пакет, hosted-клиенты, пользовательский Assistant/Windows host, устройства и остальные пункты полной цели остаются вне завершённой приёмки; `fullPlanAcceptance=false`.
