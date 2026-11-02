# Возможности и границы версий

Матрица сохраняет исторические поверхности `v0.1.6`–`v0.1.9`, описывает опубликованный prerelease `v0.1.10` и отдельно отмечает source candidate `v0.1.11`. На дату публикации 2026-11-02 npm dist-tag `next` указывал на `0.1.10`, а `latest` оставался на `0.1.9`; опубликованный prerelease доступен [на GitHub](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.10). Для candidate проверьте страницу релиза и registry.

## Возможности

Search предоставляет инструменты существующей вызывающей стороне. Он не запускает собственных PM/Dev/QA-агентов, не меняет модель, prompt, память или workflow клиента, не исполняет найденные инструкции и не редактирует source.

| Capability | Исторический архив `v0.1.6` | Историческая публикация `v0.1.7` | Опубликованный prerelease `v0.1.10` |
| --- | --- | --- | --- |
| Кодовый поиск, чтение актуальных source ranges, ограниченный контекст | Да | Да | Да |
| Кандидаты дубликатов по точным и переименованным телам | Да | Да; это существующая возможность, не новинка кандидата | Да |
| Точный поиск символов, статические references, ограниченный call/construct trace | Нет | Да | Да |
| Необязательный `includeLogical` для доказанных статических связей | Нет | Да, выключен по умолчанию | Да |
| Отдельный project-text index для `documentation`, `rules`, `skills` | Нет | Да, только при явном `projectText` config | Да |
| Brave web discovery и чтение публичных страниц | Да | Да | Да |
| Несколько discovery queries от вызывающей стороны | Нет | Да, до семи дополнительных запросов; Search их не формирует | Да |
| Jev-backed classification и reuse context | Частично: существующая классификация | Да, shared Jev Decisions port; reuse opt-in | Да |
| Bounded source-read recovery для неверного EOF range | Нет | Да, подсказка следующего identity-bound запроса | Да |
| SDK, CLI и локальный/remote MCP | Да | Да; регистрация и remote hosting остаются действиями владельца | То же; плюс opt-in CLI stdio result presentation |
| Structured presentation для локального MCP stdio | Нет | Нет | Да через `mcp`/`client-config --result-presentation structured`; default `legacy` |
| Typed availability/grant states, trusted task-specific guidance и consent-based incremental setup для семи ролей | Нет | Нет | Да; setup локальный для owner, требует reconnect после изменения профиля |
| IP/CIDR allowlist для удалённого MCP с явными Host/Origin и principal/root/operation grants | Нет | Нет | Нет | Source candidate `v0.1.11`: CLI `serve-remote-ip`; loopback daemon, optional trusted-proxy `X-Real-IP`; не комбинируется с bearer/OAuth |

Для подтверждённой публикации устанавливайте `zorya-search@0.1.10` явно; команда приведена в [README](../README.md#release-availability). Candidate `v0.1.11` не становится доступной по одному этому описанию. См. [changelog](../CHANGELOG.md) и [исторический guide presentation](mcp-result-presentation.md).

## Поиск по коду и структурные данные

Кодовый поиск по умолчанию лексический. Embeddings и reranking требуют явной конфигурации. Текущая поверхность включает точные symbol/reference queries и ограниченную трассировку статических `call`/`construct` связей. Они не индексируют или не чинят отсутствующие symbol metadata при чтении; отдельный backfill — явная операция с `index` grant. Статический анализ не гарантирует dynamic dispatch, dependency injection, framework wiring или полноту runtime-вызовов. `complete` ограничен объявленной поддерживаемой областью анализа.

Duplicate groups — эвристические кандидаты на точные или переименованные тела. Они есть в архиве `v0.1.6`; наличие кандидата не доказывает поведенческую эквивалентность.

`includeLogical` включается только caller-ом, независимо от `includeRelated`. Caps, omissions и continuation остаются в ответе. Для preview API и ограничения recovery см. [SDK](sdk.md), [MCP](mcp.md) и [гид по Jev/reuse](jev-classification.md).

## Отдельный project-text индекс

В `v0.1.10` Search может индексировать поддержанные документы, правила и skills в пространстве `zorya_project_text_*`, отдельно от code index и knowledge storage. Возможность включается явным `projectText` config. Новый setup может создать `projectText: {}` для lexical support, даже если текстовая embedding-модель не настроена; существующий config не включается и не переписывается автоматически. Результаты привязаны к snapshot; чтение не индексирует.

## Web, классификация и visual

Brave discovery, page reading, Jev classification и отдельный visual поиск — независимые возможности. Discovery использует ключ Brave; чтение известного публичного URL требует настроенного web reader и grant `web`, но не ключ Brave. `additionalQueries` задаёт только вызывающий клиент. Visual поиск принимает переданные клиентом references; Search не захватывает desktop и не загружает изображения по URL.

Jev classifier закреплён на `typesafe/jev-1.14` через TypeSafe. Другие classifier model IDs отклоняются, а не silently заменяются. Reuse требует opt-in capability и grants `read` плюс `classify`. Оно возвращает bounded evidence, а не workflow или решение о правках.

## Модели и ошибки

Необязательные presets: code `voyageai/voyage-code-4` (1024d), rerank `voyageai/rerank-2.5-lite`; project text `voyageai/voyage-4-large` (1024d) с document/query roles; visual `voyageai/voyage-multimodal-3.5` (1024d). Профили раздельны. Code query-role эксперимент не принят: текущий code profile не задаёт Voyage `input_type`. Reranker получает исходный chunk text без formatter. Оба решения нельзя описывать как принятые улучшения.

Lexical mode не вызывает embedding/rerank. Hybrid может перейти к lexical при отсутствии или несовместимости профиля с явной деградацией; ошибка самого provider вызова не является успешным lexical ответом. Doctor сообщает `providerProbed: false` и `providerProbe: 'not-run'`; это не проверка готовности провайдера.

## Установка и доказательства

Функции SDK, CLI, MCP, локальной службы и удалённого endpoint используют общие контракты, но включаются и настраиваются отдельно. См. [архитектуру](architecture.md), [CLI](cli.md) и [руководство MCP](mcp.md) для путей вызова и настройки.
