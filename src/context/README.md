# Context: bounded code и web context

Context валидирует явный запрос и объединяет доступные материалы в ограниченный ответ. Источники, excerpts и classification — недоверенные evidence; вызывающий агент проверяет их и принимает решение.

## Code context — source candidate

```mermaid
flowchart TD
 ca["CodeContextRequest"] --> cb["validateRequest + lifecycle"]
 cb --> cc["Прочитать snapshot одного root"]
 cc --> cd["Search, logical symbols и references"]
 cd --> ce["Объединить ограниченные ranges"]
 ce --> cf["Прочитать source + проверить identity/hash"]
 cf --> cg{"Snapshot/source актуален?"}
 cg -->|"да"| ch["Bounded CodeContextResult"]
 cg -->|"нет"| ci["Отказ по stale/currentness"]
```

## Web context — source candidate

Caller задаёт запросы; web-поиск не придумывает дополнительные темы.

```mermaid
flowchart TD
 wa["Запрос + выбранные caller-ом additionalQueries"] --> wb["Brave discovery: упорядоченные URL"]
 wb --> wc["Дедупликация canonical URL + общие in-flight reads"]
 wc --> wd["Разобранные страницы/cache → passages"]
 wd --> we["Лексические кандидаты"]
 wd --> wf{"Настроен models.embed и passages имеют chunks?"}
 wf -->|"да"| wg["Одним вызовом embed query и chunks"]
 wg --> wha["Dense-кандидаты"]
 wf -->|"нет"| wh["Без dense ranks"]
 we --> wi["RRF по лексическим и доступным dense ranks"]
 wha --> wi
 wh --> wi
 wi --> wj{"Настроен rerank?"}
 wj -->|"да"| wk["Выполнить rerank"]
 wk --> wka["Изменить только порядок кандидатов"]
 wj -->|"нет"| wl["Сохранить текущий порядок"]
 wka --> wm["Ограниченный результат + дата источника"]
 wl --> wm
 wg -->|"ошибка embedding"| wn["Оставить лексические кандидаты + stage error; продолжить fusion"]
 wn --> wi
 wk -->|"ошибка rerank"| wo["Сохранить прежний порядок + stage error"]
 wo --> wm
 wb -->|"частичный сбой discovery/read"| wp["Частичный результат + ошибки этапов"]
 wc -->|"отмена / read ещё идёт"| wq["Отменить ожидание caller-а; дождаться shared read"]
```

Профиль embedding проверяется при создании контекста. Если заданы `models.embed` и passages с chunks, один вызов получает query и chunks. При ошибке embedding lexical candidates сохраняются, stage error фиксируется и обработка продолжает fusion. При ошибке rerank сохраняются прежний порядок и stage error.

## Classification — shared Jev port

```mermaid
flowchart TD
 xa["Runtime config: ссылка на Jev env"] --> xb["Один порт createJevDecisions"]
 xc["classify"] --> xb
 xd["get_reuse_context"] --> xb
 xb --> xe{"Validated Jev result?"}
 xe -->|"да: classify"| xf["ClassificationResult → caller"]
 xe -->|"да: reuse"| xg["Noul files + Choice symbols → caller"]
 xe -->|"timeout / invalid / cancel"| xh["Типизированный отказ / unknown"]
 xb --> xi["Общий ledger usage().classification"]
```

## Переиспользование кода — исходное включение `0a584e6`, постраничный выбор `a85eb8c506c8`

```mermaid
flowchart TD
 ra["Запрос + один разрешённый root"] --> rb["Code search и граф в закреплённом snapshot"]
 rb --> rc["На каждый candidate file: до 2 страниц findCodeSymbols × 100 + source preview/hash"]
 rc --> rd{"Закреплённый Jev доступен?"}
 rd -->|"нет / invalid"| ru["Явные unavailable / unassessed; без локального выбора"]
 rd -->|"да"| re["Query intent; затем пакет Noul по candidate files"]
 re --> rf["Положительные Noul > 0.5 сортируются по ответу; верхние 2 файла"]
 rf --> rg["На каждый выбранный файл: дочитать до 4 страниц символов × 100 всего"]
 rg --> rh["Последовательно до 8 Choice страниц × 32 символа + none"]
 rh --> ri{"Есть page winners?"}
 ri -->|"несколько"| rj["Ещё один Jev Choice сравнивает только page winners + none"]
 ri -->|"один победитель или none"| rk["Сохранить page answer единственного победителя либо явный none"]
 rj --> rl["Выбранный символ либо явный none"]
 rk --> rl
 rl --> rm["Отдельно собрать source ranges выбранного символа под budget/deadline; readCoverage может быть partial"]
 ru --> rn["Coverage, omissions и continuation"]
 rm --> rn
 rn --> ro["Вызывающая сторона сверяет evidence и принимает решение"]
```

У каждого Choice page только исходные code excerpts из того же snapshot: не более шести строк и 240 символов на символ. На одну операцию допускается не более 18 symbol-stage Decisions-вызовов и не более 20 вместе с query intent и файловым Noul; это граница вызовов port `decide`, а не физических HTTP-запросов, транспортных retry, embedding/rerank вызовов или стоимости провайдера. Локального сравнения confidence для выбора символа нет: страницы и их победителей оценивает Jev, а итоговый Choice вызывается только при нескольких page winners. `none`, неполный ответ, ошибка или исчерпание бюджета остаются явными состояниями, не подтверждённым выбором.

Чтение тела выбранного символа и ближайшего проверенного именованного executable ancestor собирается отдельно через bounded code context; результат полноты source обозначается в `readCoverage` и может быть ограничен бюджетом. Бюджет source context — 48 000 символов по умолчанию и до 64 000 по настроенному hard limit; deadline — 60 секунд по умолчанию и до 120 000 миллисекунд по hard limit. Выбор symbol pages сам по себе не выдаёт полные тела и не расширяет эти лимиты. Путь reuse использует тот же Jev port runtime, что и classification; его вызовы учитываются в общем ledger `usage().classification`. Он не меняет embedding/rerank профили, prompt, модель или workflow клиента. Source candidate и оставшиеся границы приёмки описаны в [руководстве Jev](../../docs/jev-classification.md).

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Code snapshot/source hash изменился | Старые ranges не возвращаются как current. | `createCodeContext`, `collectLogicalContext` |
| Jev в reuse недоступен или ответ некорректен | Без локальных семантических эвристик; выбор файлов остаётся `unassessed`/`unknown`. | `createReuseContext`, `reuse-selection.ts` |
| Каталог символов продолжается или анализатор пометил путь `truncated` | Отдельно проверяйте cursor, summary `symbolAnalysis.truncation`/`coverageCounts`, а если path-level детализация доступна — совпадающую запись в массиве `findCodeSymbols.analysis.coverage`; `truncated` с `nextCursor` означает следующую страницу. | `createReuseContext`, `reuse-symbol-selection.ts` |
| Choice символов неполный или недоступен | `symbolSelection.files[]`, `selection.unassessed`, `omissions` и `continuation` сохраняют счётчики, состояние и следующий ограниченный шаг; `none` не становится выбранным символом. | `reuse-symbol-selection.ts`, `reuse-types.ts` |
| Покрытие чтения символов или исходников неполное | Ограниченные кандидаты сопровождаются явным состоянием, omissions и continuation. | `createReuseContext`, `reuse-types.ts` |
| Web часть упала, но страницы есть | Partial result и errors по этапам. | `createWebSearch` |
| Web embedding/rerank provider error | Ошибка сохраняется в `errors`, `partial=true`; lexical passages могут остаться в ответе, поэтому сбой не скрыт. | `web.ts` |
| Caller отменил shared read | Его ожидание отменяется отдельно; физический fetch не считается завершённым раньше settlement. | `BraveInFlightDocuments` |
| Additional query отсутствует | Search не придумывает его сам. | `snapshotAdditionalQueries` |

Web — публичный HTTP acquisition, не browser automation. Logical symbol/reference связи статические и не являются runtime call truth. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/index.ts), [`logical.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/logical.ts), [`web.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/web.ts), [`classify.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/classify.ts), [`lifecycle.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/lifecycle.ts).

Кодовая опора reuse: [`reuse.ts` — orchestration и лимиты](reuse.ts#L13), [`reuse-symbol-selection.ts` — страницы и Jev Choice](reuse-symbol-selection.ts#L10), [`reuse-types.ts` — coverage DTO](reuse-types.ts#L53), [`reuse-selection.ts` — проверки ответов](reuse-selection.ts#L5), [`reuse-presentation.ts` — компактная MCP projection](../mcp/reuse-presentation.ts#L1), [`symbol-queries.ts` — пагинация каталога](../code/symbol-queries.ts#L92) и [`code-context.ts` — ограниченная сборка context](code-context.ts#L21).

Jev не расширяет `additionalQueries`, не выбирает embedding/rerank модель и не меняет workflow агента. Проверенные полные или частичные диапазоны, source identity, evidence и omissions передаются клиенту; он решает, что проверить или изменить. GitHub archive `v0.1.6` не содержит этот source candidate.
