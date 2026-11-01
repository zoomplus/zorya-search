# Context: bounded code и web context

Context валидирует явный запрос и объединяет доступные материалы в ограниченный ответ. Источники, excerpts и classification — недоверенные evidence; вызывающий агент проверяет их и принимает решение.

## Code context — CURRENT MAIN

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

## Web context — CURRENT MAIN

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

## Classification — CURRENT MAIN

```mermaid
flowchart TD
 xa["Критерии/evidence от клиента"] --> xb["createClassificationTool → настроенный classifier"]
 xb --> xc{"Структурированный ответ валиден?"}
 xc -->|"да"| xd["Вернуть classification caller-у"]
 xc -->|"нет / ошибка provider"| xe["Типизированная ошибка операции"]
```

## Переиспользование кода — PLANNED, не интегрировано

```mermaid
flowchart LR
 ra["Факты из search/graph"] -.-> rb["Jev Choice по файлам/символам"]
 rb -.-> rc["Проверить ranges + tests/contracts/duplicate evidence"]
 rc -.-> rd["Caller решает дальнейшее действие"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Code snapshot/source hash изменился | Старые ranges не возвращаются как current. | `createCodeContext`, `collectLogicalContext` |
| Web часть упала, но страницы есть | Partial result и errors по этапам. | `createWebSearch` |
| Web embedding/rerank provider error | Ошибка сохраняется в `errors`, `partial=true`; lexical passages могут остаться в ответе, поэтому сбой не скрыт. | `web.ts` |
| Caller отменил shared read | Его ожидание отменяется отдельно; физический fetch не считается завершённым раньше settlement. | `BraveInFlightDocuments` |
| Additional query отсутствует | Search не придумывает его сам. | `snapshotAdditionalQueries` |

Web — публичный HTTP acquisition, не browser automation. Logical symbol/reference связи статические и не являются runtime call truth. Исходники: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/index.ts), [`logical.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/logical.ts), [`web.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/web.ts), [`classify.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/classify.ts), [`lifecycle.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/context/lifecycle.ts).

Пунктирная схема — планируемое соединение, не интегрированный API. Текущий classifier вызывается только отдельной явной операцией; Jev не расширяет `additionalQueries`, не выбирает источники и не запускает поиск сам. Проверенные full/partial ranges и evidence передаются caller-у, который решает, какое изменение нужно.
