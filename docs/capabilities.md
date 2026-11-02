# Возможности и границы версий

Этот документ различает публичный архив `v0.1.6` и исходный кандидат `v0.1.7` на commit [`3be35fd`](https://github.com/zoomplus/zorya-search/tree/3be35fdbe69357a4bb0daf6203d9472b5c5a184d). Публичного архива или npm-пакета `0.1.7` пока нет. Для candidate возможностей нужен именно соответствующий source build; проверь фактическую схему установленного клиента.

## Возможности

Search предоставляет инструменты существующей вызывающей стороне. Он не запускает собственных PM/Dev/QA-агентов, не меняет модель, prompt, память или workflow клиента, не исполняет найденные инструкции и не редактирует source.

| Capability | Доступный архив `v0.1.6` | Candidate `v0.1.7` |
| --- | --- | --- |
| Кодовый поиск, чтение актуальных source ranges, ограниченный контекст | Да | Да |
| Кандидаты дубликатов по точным и переименованным телам | Да | Да; это существующая возможность, не новинка кандидата |
| Точный поиск символов, статические references, ограниченный call/construct trace | Нет | Да |
| Необязательный `includeLogical` для доказанных статических связей | Нет | Да, выключен по умолчанию |
| Отдельный project-text index для `documentation`, `rules`, `skills` | Нет | Да, только при явном `projectText` config |
| Brave web discovery и чтение публичных страниц | Да | Да |
| Несколько discovery queries от вызывающей стороны | Нет | Да, до семи дополнительный запросов; Search их не формирует |
| Jev-backed classification и reuse context | Частично: существующая классификация | Да, shared Jev Decisions port; reuse opt-in |
| Bounded source-read recovery для неверного EOF range | Нет | Да, подсказка следующего identity-bound запроса |
| SDK, CLI и локальный/remote MCP | Да | Да; регистрация и remote hosting остаются действиями владельца |

Кандидат доступен для локальной проверки из закреплённого source/tarball. Будущие release URL и registry install не опубликованы. См. [README](../README.md#release-availability) и [changelog](../CHANGELOG.md).

## Поиск по коду и структурные данные

Кодовый поиск по умолчанию лексический. Embeddings и reranking требуют явной конфигурации. Candidate добавляет точные symbol/reference queries и ограниченную трассировку статических `call`/`construct` связей. Они не индексируют или не чинят отсутствующие symbol metadata при чтении; отдельный backfill — явная операция с `index` grant. Статический анализ не гарантирует dynamic dispatch, dependency injection, framework wiring или полноту runtime-вызовов. `complete` ограничен объявленной поддерживаемой областью анализа.

Duplicate groups — эвристические кандидаты на точные или переименованные тела. Они есть в архиве `v0.1.6`; наличие кандидата не доказывает поведенческую эквивалентность.

`includeLogical` включается только caller-ом, независимо от `includeRelated`. Caps, omissions и continuation остаются в ответе. Для candidate API и ограничения recovery см. [SDK](sdk.md), [MCP](mcp.md) и [гид по Jev/reuse](jev-classification.md).

## Отдельный project-text индекс

Candidate может индексировать поддержанные документы, правила и skills в пространстве `zorya_project_text_*`, отдельно от code index и knowledge storage. Возможность включается явным `projectText` config. Новый setup может создать `projectText: {}` для lexical support, даже если текстовая embedding-модель не настроена; существующий config не включается и не переписывается автоматически. Результаты привязаны к snapshot; чтение не индексирует.

## Web, классификация и visual

Brave discovery, page reading, Jev classification и отдельный visual поиск — независимые возможности. Discovery использует ключ Brave; чтение известного публичного URL требует настроенного web reader и grant `web`, но не ключ Brave. `additionalQueries` задаёт только вызывающий клиент. Visual поиск принимает переданные клиентом references; Search не захватывает desktop и не загружает изображения по URL.

Jev classifier закреплён на `typesafe/jev-1.14` через TypeSafe. Другие classifier model IDs отклоняются, а не silently заменяются. Reuse требует opt-in capability и grants `read` плюс `classify`. Оно возвращает bounded evidence, а не workflow или решение о правках.

## Модели и ошибки

Необязательные presets: code `voyageai/voyage-code-4` (1024d), rerank `voyageai/rerank-2.5-lite`; project text `voyageai/voyage-4-large` (1024d) с document/query roles; visual `voyageai/voyage-multimodal-3.5` (1024d). Профили раздельны. Code query-role эксперимент не принят: текущий code profile не задаёт Voyage `input_type`. Reranker получает исходный chunk text без formatter. Оба решения нельзя описывать как принятые улучшения.

Lexical mode не вызывает embedding/rerank. Hybrid может перейти к lexical при отсутствии или несовместимости профиля с явной деградацией; ошибка самого provider вызова не является успешным lexical ответом. Doctor сообщает `providerProbed: false` и `providerProbe: 'not-run'`; это не проверка готовности провайдера.

## Установка и доказательства

Устанавливаемый GitHub archive: `v0.1.6`. npm registry package и tag/release `v0.1.7` пока отсутствуют. Source checks, CI, fixtures, SDK/MCP tests, provider credentials, установленный клиент, Windows package и реальные устройства — разные уровни доказательств. Отрицательное сравнение MCP и его исходные ограничения зафиксированы в [mcp-comparison.md](mcp-comparison.md). Ни одно из этих локальных source-доказательств не устанавливает end-answer superiority или full-plan acceptance.
