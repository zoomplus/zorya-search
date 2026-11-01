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

## Переиспользование кода — source candidate `0a584e6`

```mermaid
flowchart LR
 ra["Разрешённый root + запрос"] --> rb["Поиск кода и граф в закреплённом snapshot"]
 rb --> rc["Фрагменты исходников + метаданные символов + хеши"]
 rc --> rd{"Jev доступен?"}
 rd -->|"да"| re["Intent + Noul релевантность файлов + Choice символов"]
 rd -->|"нет / invalid"| rf["Явные unavailable / unassessed"]
 re --> rg["Ограниченный контекст + coverage / omissions"]
 rf --> rg
 rg --> rh["Клиент проверяет evidence и принимает решение"]
```

По умолчанию SDK ограничивает контекст 48 000 символами и 24 файлами-кандидатами; deadline операции — 60 секунд. Путь reuse использует тот же Jev port runtime, что и classification; его вызовы учитываются в общем ledger `usage().classification`. Он не меняет embedding/rerank профили, prompt, модель или workflow клиента. Source candidate и оставшиеся границы приёмки описаны в [руководстве Jev](../../docs/jev-classification.md).

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Code snapshot/source hash изменился | Старые ranges не возвращаются как current. | `createCodeContext`, `collectLogicalContext` |
| Jev в reuse недоступен или ответ некорректен | Без локальных семантических эвристик; выбор файлов остаётся `unassessed`/`unknown`. | `createReuseContext`, `reuse-selection.ts` |
| Покрытие чтения символов или исходников неполное | Ограниченные кандидаты сопровождаются явным состоянием, omissions и continuation. | `createReuseContext`, `reuse-types.ts` |
| Web часть упала, но страницы есть | Partial result и errors по этапам. | `createWebSearch` |
| Web embedding/rerank provider error | Ошибка сохраняется в `errors`, `partial=true`; lexical passages могут остаться в ответе, поэтому сбой не скрыт. | `web.ts` |
| Caller отменил shared read | Его ожидание отменяется отдельно; физический fetch не считается завершённым раньше settlement. | `BraveInFlightDocuments` |
| Additional query отсутствует | Search не придумывает его сам. | `snapshotAdditionalQueries` |

Web — публичный HTTP acquisition, не browser automation. Logical symbol/reference связи статические и не являются runtime call truth. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/index.ts), [`logical.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/logical.ts), [`web.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/web.ts), [`classify.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/classify.ts), [`lifecycle.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/lifecycle.ts).

Jev не расширяет `additionalQueries`, не выбирает embedding/rerank модель и не меняет workflow агента. Проверенные полные или частичные диапазоны, source identity, evidence и omissions передаются клиенту; он решает, что проверить или изменить. GitHub archive `v0.1.6` не содержит этот source candidate.
