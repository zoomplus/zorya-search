# Начало работы с Zorya Search

Это краткое руководство описывает source candidate `v0.1.8` на source [`af0a1ed`](https://github.com/zoomplus/zorya-search/tree/af0a1ed6faa9dd912798d28af8401bd8026964c6). Он сохраняет ранее опубликованные возможности `v0.1.7` и добавляет opt-in выбор MCP stdio presentation. Перед установкой проверь [страницу релиза `v0.1.8`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.8) на наличие asset; npm version/tag сверяй отдельно в registry.

## 1. Установи пакет preview

Нужна Node.js `>=20.19.0`. Когда на странице релиза перечислен `zorya-search-0.1.8.tgz`, установи его в проект, который будет владеть Search:

```sh
npm install --save-exact https://github.com/zoomplus/zorya-search/releases/download/v0.1.8/zorya-search-0.1.8.tgz
npm ls @zorya/search --depth=0
```

Команда URL — рецепт для указанного asset, не подтверждение его наличия. Если используешь npm, сначала проверь, что registry показывает `0.1.8` с тегом `next`; тогда можно выполнить `npm install --save-exact @zorya/search@next`. Указывай `@zorya/search@0.1.8` только после проверки этой версии в registry. Не используй неприкреплённый `latest` или `npx` для получения отсутствующей версии. Установка GitHub archive не зависит от доступа к npm-аккаунту.

## 2. Создай runtime config

Для локального lexical поиска по коду и project-text выбери этот вариант первичного `setup`:

```sh
npm exec -- zorya-search setup --root .
npm exec -- zorya-search client-config
```

Новый `setup` без provider flags создаёт `projectText: {}`: лексический поиск по коду и проектному тексту остаётся локальным, без моделей и облачных запросов. `client-config` только печатает варианты и не регистрирует клиента.

### Необязательная облачная конфигурация

Если профиль уже имеет нужные environment variables для OpenRouter и Brave Search API, можно выбрать этот вариант `setup` вместо локального блока выше:

```sh
npm exec -- zorya-search setup --root . \
  --code-env OPENROUTER_API_KEY \
  --text-env OPENROUTER_API_KEY \
  --jev-env OPENROUTER_API_KEY \
  --web-env BRAVE_SEARCH_API_KEY
npm exec -- zorya-search client-config
```

Выбери только один из двух вариантов первичного `setup`: не запускай их последовательно для одного config. Эти флаги задают имена уже существующих переменных окружения, не значения ключей: code, text и Jev используют ссылку на OpenRouter transport, `web` отдельно использует Brave Search API. Они не являются прямыми Voyage или TypeSafe ключами. Если опустить только `--text-env`, проектный текст останется локальным лексическим поиском, но без text embedding; для полностью локальной конфигурации опусти все облачные флаги. TTY wizard не спрашивает о Jev, поэтому для этой опциональной capability укажи `--jev-env` явно. Не передавай секреты в argv или client JSON.

Параметры `setup` — выбор при первоначальном создании профиля, а не последовательные обновления. Если config уже существует, команда откажется его перезаписывать. Для правки существующего runtime JSON сначала останови службу и сохрани прежние `dataDir`, roots и прочие настройки. Передавай одинаковый `--config PATH` командам setup/client-config/index/service. Config и каталог данных размещай вне индексируемого корня.

## 3. Подключи клиента и проиндексируй root

Владелец отдельно регистрирует выбранный пример `client-config` в существующем клиенте и выдаёт необходимые grants. Затем запусти начальную индексацию явно:

```sh
npm exec -- zorya-search index
```

Индексация не меняет исходники. Watch работает только если владелец включил его в config. Не запускай второй процесс-владелец с тем же каталогом базы.

Для кода начни с `search_code` и проверь найденный диапазон через `read_source`; ограниченный `get_code_context` и duplicate candidates — отдельные запросы. Используй только API фактически установленной версии; подробности приведены в [матрице возможностей](capabilities.md), [SDK](sdk.md), [CLI](cli.md) и [MCP](mcp.md).

## Выбор представления ответа stdio

В candidate `v0.1.8` для локального MCP proxy можно явно выбрать `structured`; в нём только точный повтор JSON в текстовом `content` заменяется короткой ссылкой на сохранённый `structuredContent`. Значение по умолчанию — `legacy`. Используй поддерживаемые CLI entrypoints:

```sh
npm exec -- zorya-search mcp --result-presentation structured
npm exec -- zorya-search client-config --result-presentation structured
```

`client-config` лишь печатает профиль; регистрируй его в клиенте отдельно. Оставь `legacy`, если интеграция читает только text blocks или не проверена на этом формате. Нативный caller evidence есть только для Codex CLI 0.163.0 на Linux; не переноси его на hosted ChatGPT, Cursor или другие клиенты. Подробности и ограничения приведены в [гайде](mcp-result-presentation.md).

## Ранее опубликованные версии

Предыдущий релиз [`v0.1.7`](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.7) не включает структурированное stdio представление. Если используешь его, оставь привычное поведение `legacy`. Исторический [`v0.1.6` архив](https://github.com/zoomplus/zorya-search/releases/tag/v0.1.6) не включает более поздние возможности project-text, symbol/reference, multi-query web и source-read recovery; сверяй команды с документацией именно этой версии.

## Web и ограничения

Brave discovery требует `--web-env`; чтение известного публичного URL использует отдельный web reader и `web` grant, без ключа Brave. `additionalQueries` выбирает вызывающая сторона, Search не генерирует их. Code, text, web, classifier и visual profiles независимы.

Doctor показывает `providerProbed: false` и `providerProbe: 'not-run'`: это проверка конфигурации и локального владельца, не provider health. Удалённый MCP требует инфраструктуру владельца, HTTPS proxy и OAuth issuer; это не hosted-сервис Search. Подробности: [MCP](mcp.md), [project text и web discovery](project-text.md), [Jev](jev-classification.md) и [профили Voyage](voyage-profiles.md).
