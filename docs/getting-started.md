# Начало работы с Zorya Search

Публичный архив сейчас `v0.1.6`; кандидат `v0.1.7` на source commit [`3be35fd`](https://github.com/zoomplus/zorya-search/tree/3be35fdbe69357a4bb0daf6203d9472b5c5a184d) ещё не опубликован. Команды установки ниже ставят именно доступный архив `v0.1.6`; не ожидай в нём project-text, symbol/reference, multi-query web или typed source-read recovery из кандидата. Registry install и будущая release-ссылка `v0.1.7` не доступны.

## 1. Установи доступный архив

Нужна Node.js `>=20.19.0`. Устанавливай пакет в проект, который будет владеть Search:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.6/zorya-search-0.1.6.tgz
```

## 2. Создай runtime config для архива `v0.1.6`

Для локального lexical поиска и MCP:

```sh
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

`setup` создаёт конфигурацию один раз; `client-config` только печатает варианты. Он не регистрирует клиента. В архиве `v0.1.6` доступны, например, необязательный code profile и Brave discovery:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
```

Эта команда и короткая команда выше — варианты **первичного создания** профиля; выбери одну и не запускай их последовательно для одного config. `--code-env` задаёт имя переменной для OpenRouter, а `--web-env` — имя переменной Brave Search API. Используй уже имеющиеся ключи провайдеров; не помещай значения ключей в argv или client JSON. В `v0.1.6` нет `--text-env`, `--jev-env` или project-text capability.

Эти флаги предназначены для первичного создания профиля. `setup` не перезаписывает существующий config. Для существующего runtime JSON сохрани прежние `dataDir`, roots и остальные настройки; редактируй его явно после остановки службы. Передавай тот же `--config PATH` командам setup/client-config/index/service. Config и data directory должны быть вне индексируемого корня.

## 3. Подключи клиента и проиндексируй root

Владелец отдельно регистрирует подходящий пример `client-config` в существующем клиенте и выдаёт нужные grants. Затем запусти первичную индексацию явно:

```sh
npm exec -- zorya-search index
```

Индексация не меняет исходники. Watch работает только если владелец включил его в config. Не запускай второй процесс-владелец с тем же каталогом базы.

Для кода начни с `search_code` и проверь найденный диапазон через `read_source`; ограниченный `get_code_context` и duplicate candidates — отдельные запросы. В candidate `v0.1.7` доступны отдельный project-text индекс, exact symbol/reference/static call tools, `includeLogical`, reuse и caller-selected `additionalQueries`. Используй только API фактически установленной версии; подробности в [матрице возможностей](capabilities.md), [SDK](sdk.md), [CLI](cli.md) и [MCP](mcp.md).

## Локальная проверка кандидата

Для проверки `v0.1.7` сначала установи конкретный locally prepared candidate tarball или source checkout, полученный отдельно от владельца candidate. Публичной install-команды пока нет; не подменяй её URL будущего релиза. После установки сверяй package version, exports и фактическую MCP/SDK schema.

В candidate `v0.1.7` можно выбрать следующую команду **вместо** первичного setup для `v0.1.6` выше:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --text-env OPENROUTER_API_KEY \
  --jev-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
```

`--code-env`, `--text-env` и `--jev-env` здесь ссылаются на уже настроенную переменную OpenRouter: это не прямые Voyage или TypeSafe ключи. `--web-env` отдельно ссылается на переменную Brave Search API. Флаги сохраняют только имена переменных, а не их значения. TTY wizard не предлагает отдельную настройку Jev; чтобы включить Jev, укажи `--jev-env` явно. Для нового candidate config `setup` создаёт `projectText: {}` и включает lexical project-text даже без `--text-env`; этот default не относится к установленному `v0.1.6`. Выбери ровно один initial `setup`: эти команды не предназначены для последовательного запуска на одном config. `setup` откажется перезаписывать существующий файл; уже созданный runtime config меняй отдельно, сохраняя его текущие roots и `dataDir`.

## Web и ограничения

Brave discovery требует `--web-env`; чтение известного публичного URL использует отдельный web reader и `web` grant, не ключ Brave. Дополнительные запросы `additionalQueries` — список вызывающей стороны, Search не генерирует его. Code, text, web, classifier и visual profiles независимы.

Doctor показывает `providerProbed: false` и `providerProbe: 'not-run'`: это проверка конфигурации/локального владельца, не provider health. Удалённый MCP требует инфраструктуру владельца, HTTPS proxy и OAuth issuer; это не hosted-сервис Search. Для более подробных границ см. [MCP](mcp.md), [project text и web discovery](project-text.md), [Jev](jev-classification.md) и [профили Voyage](voyage-profiles.md).
