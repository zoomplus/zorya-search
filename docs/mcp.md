# MCP и удалённая служба

## Jev reuse context — текущие исходники

В текущих исходниках `get_reuse_context` требует разрешения `read` и `classify` одновременно и принимает `rootId`, `query`, необязательный `maxChars` до 48 000, `limit` до 40 и MCP-only `responseDetail: 'compact' | 'full'`. По умолчанию используется `compact`. `maxChars` ограничивает текст исходного контекста, а не весь структурированный DTO. Для сериализованного MCP-конверта действует отдельный предел 1 000 000 bytes; превышение возвращает `RESPONSE_TOO_LARGE`. Если защищённый сервер скрывает инструменты без нужных разрешений, `get_reuse_context` не объявляется, а capability `reuseContext` сообщает `false`; используются существующие OAuth scopes `zorya:read` и `zorya:classify`.

Для текущей реализации Zorya Search успешный `capabilities` вызов возвращает в `structuredContent.reuseContext` итоговое состояние capability с учётом разрешений `read` и `classify`: значение `true` уже подтверждает все три условия для этой MCP-сессии. Отдельно искать поля разрешений в `list_roots` или запрашивать отдельный список разрешений операций вне ответа сервера не нужно: `list_roots` возвращает разрешённые корни. Значение `false`, отсутствующее или неизвестное не подтверждает reuse; не индексируй автоматически и не обходи отказ. Если оба разрешения выданы, но функция reuse выключена, legacy `get_reuse_context` может оставаться в списке и возвращает typed `CAPABILITY_DISABLED`.

`compact` проецирует только выбранные разделы исходников, связанные с выбранными символами по совпадающим путям, хешам файлов и диапазонам. Остальные разделы переносятся в `source.deferredSections` со snapshot-bound запросами `readSourceRequests`; агент может запросить их через `read_source` по мере необходимости. Запросы сохраняют исходные `rootId` и `snapshotId` и делят диапазон на чтения максимум по 200 строк. `source.budget` сохраняет бюджет исходного code context, а `source.presentation` отдельно считает число и объём возвращённых и отложенных разделов. Это разные показатели. Исходные `selection` (включая оценки `unresolved`/`unassessed`), `intent` и `coverage.readCoverage` сохраняются; ограничения, omissions и totals для сокращённых списков остаются видимыми в coverage/counters. DTO компактного формата v1 возвращается в MCP `structuredContent`, а `content` содержит короткое сообщение. Клиент, который читает только `content`, должен запросить `responseDetail: 'full'`.

Continuation для положительного файла сверх cap начинается со строки 1 в исходном `snapshotId` и сохраняет hash прочитанного файла отдельно от глобального `identity.contentHash`. При известном в source preview `fileLineCount` запрос заканчивается на `min(fileLineCount, 200)`. Если legacy adapter не сообщил число строк, `readSourceRequest` намеренно опускает `lineEnd`; штатный `read_source` ограничивает чтение своим default до 200 строк. Явно заданный конец за EOF по-прежнему отклоняется. При смене snapshot или source чтение отказывает, а continuation не перепривязывается к новому содержимому.

Если явно заданный `read_source` диапазон недопустим — например, `lineStart` вне файла, `lineEnd` за EOF или span больше 1000 строк — штатный reader сохраняет `CODE_INDEX_LINE_RANGE_INVALID`. Только после currentness/cancellation fence он может приложить к typed error ограниченные метаданные фактического файла. Runtime валидирует DTO, а MCP проверяет указатель для уже разрешённых `rootId` и `path`; затем ошибка может содержать optional source-only подсказку `recovery` с `fileLineCount` и `readSourceRequest`. В этом запросе нет `lineEnd`, поэтому строгое следующее чтение ограничится default в 200 строк от предложенного `lineStart`. Это не автоматический retry и не подтверждение выполнения отвергнутого диапазона. Следующий read заново сверяет snapshot. Отказ в доступе, отмена, stale/changed source, некорректные метаданные и legacy adapters без metadata сохраняют прежний ответ ошибки без подсказки. Не меняются источник, права, индекс, prompt или workflow клиента.

`full` возвращает прежнюю полную форму результата этого MCP tool без компактной проекции; на ответ по-прежнему действует общий предел конверта в 1 000 000 bytes. Параметр не входит в `SearchRuntime.getReuseContext` или SDK `getReuseContext` и не меняет `get_code_context`. Эти изменения доступны только в исходниках; опубликованный GitHub archive `v0.1.6` их не содержит, npm-пакет не опубликован. Детали использования приведены в [руководстве Jev](jev-classification.md).

Пакет предоставляет `@zorya/search/mcp` и `@zorya/search/daemon`. Daemon владеет одним `SearchRuntime` и его хранилищем. MCP transport вызывает runtime через строгие схемы запросов и возвращает найденный контекст. Подключение клиента настраивается отдельно. Импорт модуля сам не запускает службу или индексацию.

### Server instructions при подключении

В source candidate MCP `initialize` получает короткие server instructions о поиске кода и project-text. Это подсказка о code retrieval для вопросов и изменений существующего кода и о project-text для поиска по руководствам, правилам и навыкам. Эти разделы относятся только к своим задачам и не ограничивают остальные роли Search. Текст строится по зарегистрированным инструментам с учётом grants и известных серверу capabilities. HTTP server знает capability и может предложить `get_reuse_context` как возможную первую точку только при включённом reuse и обоих grants; выключенная capability не меняет legacy-регистрацию и даёт typed failure, а guidance предлагает доступные `search_code`/`get_code_context`. В stdio proxy initialize-time capability неизвестна и имя tool само по себе недостаточно: клиент должен явно вызвать доступный `capabilities` и в ответе именно этого Zorya Search server проверить `structuredContent.reuseContext === true`. Этот ответ уже учитывает выданные разрешения; их не нужно искать в `list_roots` или отдельном внешнем списке. Если `capabilities` недоступен либо значение не true, считай reuse неподтверждённым. Proxy не запрашивает capabilities автоматически на initialize. Проверка source identity и coverage упоминается при наличии `read_source`; project-text — только если его capability и grant `read` доступны.

Остальные зарегистрированные роли описываются независимо: `search_web` требует настроенный `webDiscovery` и разрешение `web`, `read_web_source` — `webRead` и разрешение `web`, `classify` — `classification` и разрешение `classify`, а `search_visual_references` — `visual` и разрешение `visual`. Один tool name не доказывает настройку provider/capability. В stdio guidance предлагает проверить соответствующее поле `capabilities` и разрешение до явного вызова, не делая этот вызов при initialize. Visual сравнивает только references, переданные вызывающим клиентом; он не снимает экран и не получает изображения по URL.

`initialize` передаёт только метаданные и не запускает поиск, индексацию или модель. Instructions не являются классификатором или обязательным порядком действий, не управляют планом, prompt, моделью, памятью и настройками клиента и не расширяют root и разрешения операций. HTTP сервер генерирует их локально. Stdio proxy использует собственную доверенную подсказку и локальные whitelisted tool names; он не пересылает upstream instructions или описания. Сверяйте фактический список инструментов и scopes подключённого клиента. Эти исходные изменения не входят в опубликованный archive `v0.1.6` и сами по себе не подтверждают работу установленного Windows клиента или hosted deployment.

## Инструменты

В текущих исходниках `search_web` принимает необязательный параметр `additionalQueries` — формулировки, выбранные вызывающим клиентом. Этот параметр и инструменты project-text ниже ещё не входят в публичный архив `v0.1.6`. Один инструмент `search_web` остаётся прежним; Search не генерирует запросы. Ответ с несколькими запросами описан в [общем руководстве](project-text.md#несколько-запросов-web-discovery).

При включённой возможности MCP регистрирует `project_text_status`, `index_project_text`, `search_project_text` и `read_project_text`. Индекс требует право `index`; остальные операции требуют `read`. Конфигурация без `projectText` не включает эти инструменты. См. [параметры и примеры](project-text.md#cli-и-mcp).

`find_code_duplicates` — read-only поиск механических кандидатов по телам функций в индексированных файлах разрешённого root. Инструмент добавлен в `v0.1.6`; архив `v0.1.5` этой capability не содержит. Схема ограничивает пути, язык, категории, пороги и число результатов; по умолчанию рассматриваются только implementation-файлы. Поле `supportedLanguages` перечисляет JS/TS семейства, поддерживаемые этой версией. Ответ содержит snapshot и file hash, символы, диапазоны, пропуски и признаки усечения. Режимы exact и renamed различаются нормализацией локальных идентификаторов. Совпадение не доказывает семантическую эквивалентность и не запускает исправления. Исторические квитанции не квалифицируют `v0.1.6`; актуальный статус выпуска и архива указан на [странице релиза `v0.1.6`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.6).

GitHub archive `v0.1.6` по умолчанию содержит инструменты `list_roots`, `capabilities`, `index_status`, `index_repository`, `start_indexing`, `cancel_indexing`, `search_code`, `find_code_duplicates`, `read_source`, `related_code`, `get_code_context`, `search_web`, `read_web_source` и `classify`. npm-пакет пока не опубликован. Если владелец включил visual-профиль и выдал операцию `visual`, появляется `search_visual_references`. Индексация требует разрешение `index` и меняет только индекс, не исходные файлы. Отмена требует точные `rootId` и `jobId`; произвольные PID и глобальная отмена не поддерживаются.

### Source candidate: статические символы и вызовы

Ниже описаны дополнительные инструменты source candidate `9adb123`. GitHub archive `v0.1.6` их не содержит: этот раздел не меняет контракт архива и не означает выпуск новой версии. Перед вызовом сверяйте фактический локальный tool list и schema.

| Инструмент | Разрешение | Назначение и ограничения |
| --- | --- | --- |
| `index_code_symbols` | `index` | Явно обновить статические metadata для уже существующего текущего source snapshot. Не меняет векторы, embedding-профиль или исходные файлы; не вызывает модели. |
| `find_code_symbols` | `read` | Найти объявления по `query`/`name`, точному `symbolId`, enclosing file range, пути, языку и `sourceKind`; по умолчанию до 20 результатов, максимум 100. |
| `find_code_references` | `read` | Найти входящие или исходящие ссылки на symbol ID; виды: `reference`, `call`, `construct`, `export`. По умолчанию входящее направление, limit 50, максимум 200. |
| `trace_code_calls` | `read` | Обойти статические вызовы и конструирования; направления `incoming`, `outgoing`, `both`, глубина 0–4 (по умолчанию 2), 64 узла и 128 рёбер по умолчанию; максимумы: 256 узлов и 1024 ребра. |

У всех запросов строгая схема с `rootId`; root дополнительно ограничен grant клиента. Для поиска символов `query`/`name` ограничены 256 символами, `path` — 1024, `language` — 64; `sourceKind` принимает `implementation`, `tests`, `documentation` или `all`, без фильтра охватываются все категории. `symbolId` требует ровно 64 lowercase hexadecimal символа и означает exact ID lookup. Необязательный `enclosing` — строгий объект `{ path, lineStart, lineEnd? }`; путь — относительный файл, границы — положительные целые до 2147483647, конец не раньше начала. Он выбирает символы, покрывающие весь указанный range в точном пути; остальные фильтры с ним пересекаются. Курсор не длиннее 4096 символов. Схемы отклоняют незнакомые поля и значения за пределами лимитов.

Полный `index_repository` уже строит metadata для текущего snapshot. Вызывайте `index_code_symbols` отдельно только когда нужно явно заполнить metadata у подходящего уже существующего индекса; для этого требуются актуальный base index и та же конфигурация root, исключений и лимитов. Этот refresh сохраняет vector profile и существующие chunks, не вызывает embedding/rerank и не заменяет source snapshot. Три инструмента чтения никогда не backfill-ят индекс: отсутствие базового или устаревший source index возвращается как типизированная ошибка; отсутствие symbol metadata — как `not_indexed`, неполный разбор — `partial`, несовместимый profile — `unavailable`.

Ответы несут snapshot identity и provenance профиля анализа. Coverage включает агрегированные числа всех файлов и ограниченный пример деталей: максимум 50 файлов и пять diagnostics до 512 символов на файл. Смотрите `coverageTotalFiles`, `coverageOmittedFiles`, `coverageCounts`, `truncation`, а также счётчики `unresolvedReferenceCount` и `unresolvedCallCount`: второй считает неразрешённые `call`/`construct` и входит в первый. `targetKind: 'external'` отдельно обозначает внешнюю цель; `targetKind: 'unresolved'` — связь без разрешённой конкретной цели. `truncated` и `nextCursor` относятся к странице ответа; `analysis.truncation` — к пределам полного извлечения и не исчезает при чтении следующих страниц. Вызов, который компилятор не может однозначно связать, остаётся неизвестной/внешней статической связью: граф не выводит dependency injection, runtime dispatch и реальные runtime bindings. `complete` означает завершение заявленной области статического анализа, а не доказательство полного runtime-графа. Cursor привязан к snapshot, analysis profile и фильтрам; при смене этих параметров начните новый запрос.

Для подбора инструмента обычно достаточно `search_code` и `read_source`, если вопрос касается текста, поведения фрагмента или нужен текущий range. `find_code_symbols` удобен, когда известно имя объявления; `find_code_references` — когда нужны конкретные наблюдённые callers, references или exports; `trace_code_calls` — для ограниченного обхода call/construct связей. `find_code_duplicates` остаётся отдельным способом обнаружить механически похожие тела функций. Учитывайте покрытие и unknown edges, затем перепроверьте подходящий путь, snapshot и file hash через чтение исходника. Эти инструменты возвращают проверяемые кандидаты; они не выбирают изменения и не редактируют код.

Для `get_code_context` поля `language` и `sourceKind` задают фильтры кодового контекста: распространённые имена `typescript`, `javascript`, `python` и `markdown` сопоставляются с сохранёнными языковыми идентификаторами; `sourceKind` принимает `implementation`, `tests`, `documentation` или `all` и по умолчанию сохраняет поиск по всем типам. Определение типа источника основано на соглашениях о путях, поэтому при сомнении задайте `all`. Фильтры не отменяют явно заданные `mustInclude`. Поля `relatedDepth` (1–4) и `relatedMaxPaths` (1–64) доступны только при `includeRelated: true`. Ответ с `relatedGraph.status: 'available'` содержит наблюдённые import edges и snapshot identity; отдельный filtered search ранжирует достигнутые файлы по query. `unsupported` означает, что настроенный legacy adapter не предоставляет graph-порт. Узлы помечены отношением `seed`, `imports` или `importedBy`; ребро сохраняет путь импортёра и импортируемого модуля. `reachedDepth` — фактическая максимальная глубина узла, а depth-limit отмечает достижение заданной границы, не наличие скрытых продолжений. Лимиты числа узлов и уникальных рёбер также возвращаются в graph-данных. Это не оценка правильности архитектурной или семантической связи.

В source candidate `includeLogical: true` независимо добавляет в `get_code_context` поле `logicalContext`; по умолчанию оно отсутствует, а прежняя выдача не меняется. Это не отдельный инструмент MCP и не новое разрешение: используется `read` у `get_code_context`. Логический статический контекст использует результаты текущего поиска, проверяет точное AST-имя или qualified name и может добавить подтверждённый contract, прямые и до второго outgoing callees, входящих callers и test owners с доказанными ссылками. Seed имеет depth 0, прямые связи — 1, второй outgoing hop — 2. `includeRelated` отдельно включает import graph и похожие кандидаты; обе опции можно выбирать независимо. `language` и `sourceKind` фильтруют блоки logical context, но `mustInclude` по-прежнему читается первым и фильтрам не подчиняется.

`logicalContext` возвращает `state` (`available`, `partial`, `not_indexed`, `unavailable`, `unsupported`), `coverage` анализа символов, blocks с role/range/`complete`, omissions и caps. Полная analysis не означает, что конкретный блок целиком включён; `block.complete` описывает покрытие этого блока. Даже вместе эти данные не обещают dynamic dispatch, dependency injection или runtime calls; `runtimeCallCoverage` остаётся `not_claimed`. Ведущие комментарии или пустые строки могут расширить producer chunk за пределы объявления; только единственное точное AST-совпадение с подходящим диапазоном подтверждает функцию/метод. При неразрешимом или неоднозначном имени возвращается неполный `source_fallback` либо omission, а не заявляется целый символ. Небольшой файл включается целиком только при точном числе строк и полном чтении.

JSON сохраняет SDK-поля без преобразования: `logicalContext` содержит `state`, `profileId`, `analysisComplete`, `coverage`, `blocks`, `omissions`, `omissionsOmitted`, `omissionsTruncated`, `limits`, `relationCoverage`, `runtimeCallCoverage`. Каждый block имеет `symbolId`, `name`, `kind`, `role`, `source`, `complete`, `includedRanges`, `relationFrom`, `relationKind`, `depth`, `wholeFile`; omission — `symbolId`, `role`, `range`, `reason`, `continuation`. Range — только `{ path, lineStart, lineEnd }`, continuation добавляет `snapshotId`. `read_source` принимает эти четыре continuation-поля напрямую.

Логические секции используют общий `maxChars` с остальным контекстом (бюджет по умолчанию и предел MCP schema — 24 000) и ограничены 200 строками на секцию/чтение. Ограничения на один запрос: 8 seeds, 24 blocks, 50 проверенных references на seed, 120 source reads и 80 сохранённых omissions. Ответ сообщает об усечении через `limits`, `omissionsOmitted` и `omissionsTruncated`; проверьте state/coverage, прежде чем делать вывод о полноте. Continuation передаётся в обычный `read_source` вместе с прежним `rootId` как `{ path, lineStart, lineEnd, snapshotId }`; reader сверит текущий source и отклонит несовпавший snapshot. Не переназначайте старый snapshot и не запускайте индексирование автоматически. Встроенный клиент проверяет snapshot в общей read scope и полную source identity перед возвратом.

`read_source` у штатного source candidate также возвращает необязательный `fileLineCount`. Этот count позволяет отличить весь небольшой файл от одного диапазона; старый пользовательский adapter вправе не предоставлять поле. Если его нет, не делайте вывод о полном покрытии файла. Ни `find_code_symbols`, ни logical read не выполняют скрытый backfill.

У `read_source` `lineStart` по умолчанию равен 1, а пропущенный `lineEnd` означает не более 200 строк от начала чтения. Явный конец должен находиться в текущем файле, а span не может превышать 1000 строк. Source-read recovery сохраняет snapshot identity и grants; он не подменяет source hash проверку и не раскрывает текст или путь за пределами уже разрешённого запроса.

Search не исправляет код. Найденные фрагменты, страницы, оценки и метки классификатора — недоверенные данные. Вызывающий клиент сам проверяет гипотезы, читает актуальный источник и решает, менять ли проект.

## Web-поиск и ошибки provider

`search_web` ищет ссылки через настроенный Brave discovery, отдельно читает найденные публичные страницы и возвращает фрагменты текста. Для discovery нужен `--web-env BRAVE_SEARCH_API_KEY`. `read_web_source` читает явно выбранный URL без ключа Brave; ему достаточно web reader (`"web": {}` в owner JSON) и права операции `web`. Без web embedding и rerank используется лексический поиск. См. [настройку CLI](cli.md#web-поиск-через-brave).

Ошибки web-операции включают `stage`, безопасный код ошибки и, когда источник ошибки — распознанный `ProviderError`, ограниченный объект `provider` с полями `code`, `httpStatus` и `retryAfterMs`. Поля необязательны. Например:

```json
{
  "stage": "discovery",
  "code": "DISCOVERY_FAILED",
  "provider": { "code": "rate_limit", "httpStatus": 429, "retryAfterMs": 30000 }
}
```

Клиент может использовать `retryAfterMs` для планирования повтора, но не должен угадывать статус, если поля нет, или показывать пользователю сырое тело provider-ошибки. Этот интерфейс не добавляет HTTP-запрос provider и сам по себе не доказывает поведение конкретного ключа или аккаунта.

## Локальный MCP

`serve` запускает daemon на loopback с локальной авторизацией. `mcp` предоставляет stdio интерфейс клиенту и подключается к уже работающему владельцу службы. Для Codex можно использовать `client-config` и затем явно зарегистрировать полученный профиль. Локальный stdio обычно подходит локальному Codex и другим клиентам, которые могут запускать процесс на той же машине.

Установка пакета или локальный smoke-test не добавляют инструмент в текущий чат. Для настоящего ChatGPT нужен удалённый HTTPS MCP endpoint и настройка в интерфейсе ChatGPT. Подробности ниже.

## Удалённый OAuth endpoint (`v0.1.1`)

Удалённый режим предназначен для hosted MCP-клиентов и клиентов Codex, которые могут обратиться к публичному HTTPS endpoint. Он использует один механизм OAuth на всём endpoint; схема не смешивает OAuth и старый статический owner bearer. Пакет не является OAuth Authorization Server и не создаёт пользовательские учётные записи. В `v0.1.0` OAuth-совместимую проверку можно было внедрить через SDK `authorize` callback, но версия не предоставляла готовые OAuth resource metadata и CLI запуск по policy файлу.

### Что потребуется

1. Владелец создаёт свой внешний OIDC-совместимый провайдер входа (authorization server) с доступными discovery и JWKS документами. Он должен выдавать подписанные access token с `alg` `RS256` или `ES256`, заголовок `typ` со значением `at+jwt` либо `application/at+jwt` (без учёта регистра), `iss`, `aud`, `exp`, `sub` и scope. Audience токена должен совпадать с точной строкой `resource` из политики; `sub` должен совпадать с одной из grants.
2. Провайдер входа обслуживает Authorization Code с PKCE `S256`, поддерживает клиентские запросы с `resource` для привязки audience и разрешает redirect URI, показанный настройкой hosted MCP клиента. Для ChatGPT используйте точный URI из текущего интерфейса ChatGPT, не пример из документации или другой клиента. Встроенного IdP нет.
3. Владелец настраивает точные origins, которые браузерный клиент указывает в интерфейсе, и отдельную grant каждому пользователю/subject. Grant ограничивает доступные `rootIds` и операции. Для каждого пользователя настройте отдельную запись `grants` с точным `subject`, минимальным списком `rootIds` и нужных `operations`. Не запускайте несколько Search owner процессов одновременно с одним `dataDir`.
4. Daemon привязан к `127.0.0.1`; только настроенный TLS reverse proxy публикует его наружу. Внешний HTTPS host, включая нестандартный порт, должен точно соответствовать `resource` и переданному backend заголовку `Host`. Proxy сохраняет `Origin` и отключает буферизацию для SSE.

### Runtime и policy

Создайте runtime-конфигурацию через `zorya-search setup` для выбранного абсолютного root. Конфигурация должна содержать уникальный абсолютный `dataDir`, не используемый другим одновременно запущенным owner. Root ID в policy должен совпасть с ID в runtime config. Пример файла политики (замените домены, порт, origin и subject на значения вашей установки):

```json
{
  "resource": "https://search.example.com/mcp",
  "issuer": "https://login.example.net/",
  "jwksUrl": "https://login.example.net/.well-known/jwks.json",
  "port": 8765,
  "allowedOrigins": ["https://origin-from-client-settings.example"],
  "grants": [
    {
      "subject": "account-opaque-id",
      "rootIds": ["project"],
      "operations": ["read", "web"]
    }
  ]
}
```

Значения `allowedOrigins` — только origin (схема + host + необязательный port), без path и query. `resource` — точный HTTPS URL `https://<public-host>[:port]/mcp`; порт в URL должен совпадать с TLS listener и переданным proxy `Host`. `issuer` и `jwksUrl` должны быть HTTPS. Доступны операции: `read`, `index`, `web`, `classify`, `visual`. Для web чтения добавьте `web`; для изменения индекса — `index`. Source candidate `get_reuse_context` требует одновременно `read` и `classify`, а OAuth scopes остаются `zorya:read` и `zorya:classify`. Токен должен включать соответствующие `zorya:<operation>` scopes, а политика провайдера входа должна отдельно разрешать выдачу этих scopes. Не выдавайте шире нужного.

Runtime-конфигурацию можно создать интерактивно или задать явно. Для простого профиля:

```sh
zorya-search setup --config /etc/zorya-search/runtime.json --root /srv/repos/project --root-id project --data /var/lib/zorya-search
```

Затем создайте отдельный JSON-файл политики с ограниченным чтением, например `/etc/zorya-search/remote-policy.json`, и запустите службу:

```sh
zorya-search serve-remote \
  --config /etc/zorya-search/runtime.json \
  --policy /etc/zorya-search/remote-policy.json
```

Служба пишет событие `ready` в stdout после успешного запуска и завершает owner при `SIGINT`/`SIGTERM`. Настройте службы ОС как владельца именно этого процесса и каталогов. Не запускайте `serve` рядом с `serve-remote`, если оба используют один `dataDir`.

### Reverse proxy через nginx

Пример предполагает публичный TLS server на стандартном HTTPS порту. Если используется нестандартный порт, TLS listener, `resource` и upstream `Host` должны использовать один и тот же `public.example.com:PORT`. Настройте настоящий сертификат отдельно.

```nginx
server {
    listen 443 ssl;
    server_name search.example.com;

    # Укажите пути к установленному TLS сертификату и ключу.
    ssl_certificate     /etc/ssl/certs/search.example.com.pem;
    ssl_certificate_key /etc/ssl/private/search.example.com.key;

    location = /mcp {
        proxy_pass http://127.0.0.1:8765/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 130s;
        proxy_send_timeout 130s;
    }

    location = /.well-known/oauth-protected-resource/mcp {
        proxy_pass http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Connection "";
        proxy_buffering off;
    }
}
```

Daemon обслуживает `/mcp` и анонимную Protected Resource Metadata по `/.well-known/oauth-protected-resource/mcp`. Если bearer отсутствует или недействителен, MCP endpoint отвечает `401` с `WWW-Authenticate` и ссылкой `resource_metadata` (для неверного токена также указывает `invalid_token`). Если токен прошёл проверку, subject разрешён, но в нём нет ни одного scope, выданного этому subject, endpoint отвечает `403` с `error="insufficient_scope"` и требуемым scope. Проверьте также Host и Origin: их отказ тоже даёт `403`, но без OAuth challenge. Metadata раскрывает только публичные `resource`, `issuer` и scopes. Не публикуйте другие локальные endpoints. Проверьте фактический результат снаружи до регистрации endpoint у клиента.

### Подключение ChatGPT и Codex

После развертывания endpoint добавьте `https://<public-host>[:port]/mcp` в настройках MCP текущего клиента. В ChatGPT откройте управление custom MCP server, добавьте защищённый адрес и настройте OAuth. В своём провайдере входа разрешите точный redirect URI, показанный настройкой ChatGPT. Затем завершите авторизацию в браузере и проверьте выдачу минимальной grant. UI и доступность функции зависят от аккаунта; документация описывает процедуру подключения, но сама по себе не подтверждает hosted ChatGPT совместимость конкретного deployment. См. [официальную инструкцию по авторизации MCP](https://developers.openai.com/plugins/build/auth) и [официальное руководство по добавлению собственного MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server).

Codex можно настроить как удалённый MCP-клиент через его документированную настройку MCP; задайте endpoint URL и завершите OAuth в клиенте. Локальный CLI `client-config` выводит настройки stdio и не создаёт remote OAuth конфигурацию.

### Границы и проверка

Каждый JWT проверяется по JWKS с алгоритмами `RS256` и `ES256`; заголовок `typ` должен быть `at+jwt` или `application/at+jwt` без учёта регистра. Проверяются также issuer, audience и срок действия. Отсутствующий или неверный токен получает `401`; разрешённый subject без подходящего scope получает `403 insufficient_scope`. Затем `sub` сопоставляется с allowlist `grants`, а операции пересекаются с scope токена. Grant определяет `rootIds`; клиент не может расширить их параметрами запроса. Отдельные субъекты получают раздельные principal identity и grants.

На дату этого руководства независимая TLS-квитанция подтверждает daemon + CLI + Codex в двух изолированных сетевых namespace с тестовым issuer. Она проверила PKCE, TLS MCP-чтение, metadata discovery и отказ для неверных token claims, а также права subject/root/operation. Использовались тестовый issuer и контент из фикстур; публичный интернет и настоящий hosted ChatGPT не использовались. Внешний IdP и production deployment владельца остаются его ответственностью и не квалифицированы этой проверкой.

## Исторические проверки baseline

Ранее сохранённые Linux MCP, локальные HTTP, package и consumer-smoke результаты относятся к своим архивам и ограниченным средам. Они не являются доказательством доступности инструмента в hosted ChatGPT, качества широкого поиска или поведения пользовательского deployment.
