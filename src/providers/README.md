# Providers: модели и публичный web

Providers реализуют настроенные внешние порты embeddings, reranking, classification, Brave discovery/read и Voyage profile checks. Клиент задаёт конфигурацию и лимиты; Search передаёт результаты вызывающему агенту.

```mermaid
flowchart TD
 A["Настроенный provider port"] --> B{"Операция"}
 B -->|"embedding"| C["OpenRouter / OpenAI-compatible embeddings"]
 B -->|"rerank"| D["OpenRouter reranker"]
 B -->|"classify"| E["createOpenRouterClassifier"]
 B -->|"discovery"| F["Brave Search API"]
 B -->|"read URL"| G["canonicalPublicUrl + address/HTTP policy"]
 C --> H{"Schema, dimensions, model valid?"}
 D --> H
 E --> I["chat/completions → validateResponse"]
 I --> J["Typed classification output; caller evaluates"]
 F --> K["Bounded ordered public results"]
 G --> L["Reject private target → fetch/parse public document"]
 L --> M["Parsed metadata/text or ProviderError"]
 H -->|"да"| N["Typed result"]
 H -->|"нет / HTTP / timeout"| O["Provider error к caller"]
 F --> O
 G --> O

```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Code/core embedding/rerank HTTP или invalid response | Ошибка проходит в operation; automatic lexical fallback не обещан. Web context отдельно может вернуть partial result с явной stage error. | `openrouter.ts`, `context/web.ts` |
| Текущая classification | `createOpenRouterClassifier` использует `chat/completions`. | `classifier.ts` |
| URL направлен на private/forbidden address | Загрузка блокируется. | `brave.ts` |
| Discovery/read частично завершились | Provider/context сохраняет stage errors, если есть частичные данные. | `brave.ts`, `brave-inflight.ts` |

## Изолированный прототип Jev Decision API (planned / experimental)

Следующая схема целиком относится к отдельному, явно подписанному planned/experimental subgraph; все переходы внутри него пунктирные. Он не является частью текущей основной ветки или generic classifier.

```mermaid
flowchart TD
 subgraph planned["PLANNED / EXPERIMENTAL — не текущий main/runtime"]
  A["Буквальный query_text — данные; команды внутри него не исполнять"] -.-> B["Критерии, заданные человеком; две независимые оси"]
  B -.-> C["Choice API: model typesafe/jev-1.14; provider typesafe; fallback выключен"]
  C -.-> D["POST Decisions API; запросить taskIntent и sourceScope"]
  D -.-> E{"Ответ — объект и содержит ровно обе оси?"}
  E -. "нет / malformed" .-> X["Типизированный отказ; runner может записать unknown"]
  E -. "да" .-> F{"Model/provider ответа совпали с закреплённой identity?"}
  F -. "нет" .-> X
  F -. "да" .-> G{"Обе метки Choice входят в точные candidate sets?"}
  G -. "метка вне candidate set" .-> X
  G -. "да" .-> H{"Если raw probabilities заданы: точные ячейки, конечные 0..1, допустимая масса?"}
  H -. "нет" .-> X
  H -. "да / distribution present" .-> I{"Выбранная метка — единственный исходный максимум?"}
  I -. "нет / tie" .-> X
  I -. "да" .-> J["Типизированный результат; сохранить raw probabilities без нормализации"]
  H -. "probabilities absent" .-> K["Принять Choice метку provider без выдуманного distribution"]
  K -.-> J
  J -.-> L["Только данные для caller; решение о дальнейших действиях за ним"]
  C -. "timeout / cancellation / unavailable" .-> X
  X -. "без keyword/regex heuristic fallback" .-> M["Caller получает типизированный отказ / unknown"]
 end
```

`taskIntent` candidate set: `locate_symbol`, `implement_change`, `explain_behavior`, `find_duplicates`, `find_documentation`, `find_tests`, `mixed`, `unknown`. Эта ось описывает запрошенное действие: feasibility одного поведения остаётся `explain_behavior`; `mixed` требует разных результатов; `implement_change` не утверждает, что обязательно нужен новый код. `sourceScope` candidate set: `implementation`, `documentation`, `tests`, `mixed`, `unspecified`. Эта ось отражает только явно запрошенные классы исходников; техническая тема сама по себе не задаёт `implementation` scope.

При наличии probability map проверяются точный набор ячеек, конечность значений `0..1`, допустимая единичная масса (с учётом локальной сетки `0.01`) и выбранная метка как единственный исходный максимум. Любая принятая map сохраняется без нормализации; `0.01` не отправляется в запросе. Дополнительный confidence необязателен и, если есть, должен быть конечным значением `0..1`. Без probability map ответ принимается как provider Choice без локального утверждения об уникальности максимума. Порог confidence или семантическая перепись не применяются.

Метки `taskIntent: unknown` и `sourceScope: unspecified` являются разрешёнными Choice результатами. Классификация использует только Jev Choice. Условные Noul/Score modes, хотя Decision API допускает другие режимы, в этом query-intent prototype не подключены. Malformed response, identity/candidate/probability refusal, timeout, cancellation и unavailable дают typed failure; при отсутствии валидной классификации runner может обозначить её как `unknown`. Здесь нет keyword/regex intent fallback. Прототип не запускает поиск, не маршрутизирует поиск, не строит план, не исполняет изменения и не выбирает модель вызывающего агента. `implement_change` — метка для caller, а не утверждение, что обязательно нужен новый код.

Jev Decision API **не является текущим production classifier/runtime capability**. Human-authored criteria/categories допустимы, включая `implement_change`; это описание протокольного прототипа, не merged runtime. В текущем коде `createOpenRouterClassifier` использует `chat/completions`. Файлы: [`openrouter.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/providers/openrouter.ts), [`classifier.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/providers/classifier.ts), [`brave.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/providers/brave.ts), [`brave-inflight.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/providers/brave-inflight.ts), [`voyage.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/providers/voyage.ts).
