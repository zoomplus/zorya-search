# Установка локального Search для агента

Это руководство описывает установку `zorya-search-local` версии `0.1.11` для текущей папки проекта. Архив и checksum публикуются отдельными GitHub release assets; сначала проверь их доступность и совпадение digest. Если любой asset недоступен, остановись: это означает, что эту процедуру пока нельзя выполнить.

## Требования и загрузка

Нужны Node.js `>=20.19.0` и npm. Публичные адреса версии:

- [Архив `zorya-search-0.1.11.tgz`](https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/zorya-search-0.1.11.tgz)
- [SHA256SUMS](https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/SHA256SUMS)
- [Копия этого install guide](https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/install-local-agent.md)

GitHub-аккаунт для прямого скачивания не нужен, если assets доступны публично. Сверь опубликованный checksum до установки; при 404 или несовпадении SHA остановись и сообщи об этом. Устанавливай пакет в отдельный пользовательский npm prefix, а не в общий prefix. Registry/npx-вариант используй только после проверки, что `zorya-search@0.1.11` действительно опубликован.

### Linux и macOS

Выполняй оба блока в одном терминале, чтобы сохранить переменные. Скачай оба файла с указанной выше страницы и проверь единственную строку checksum:

```sh
PROJECT_DIR="$(pwd -P)"
DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zorya-search-0.1.11.XXXXXX")"
PACKAGE_TARBALL="$DOWNLOAD_DIR/zorya-search-0.1.11.tgz"
curl -fL 'https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/zorya-search-0.1.11.tgz' -o "$PACKAGE_TARBALL"
curl -fL 'https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/SHA256SUMS' -o "$DOWNLOAD_DIR/SHA256SUMS"
grep '  zorya-search-0.1.11.tgz$' "$DOWNLOAD_DIR/SHA256SUMS" | (cd "$DOWNLOAD_DIR" && shasum -a 256 -c -)
```

После успешной проверки установи пакет в отдельный prefix пользователя и проверь фактическую версию:

```sh
NPM_PREFIX="$HOME/.local/opt/zorya-search/0.1.11"
mkdir -p "$NPM_PREFIX"
npm install --prefix "$NPM_PREFIX" "$PACKAGE_TARBALL"
SEARCH_CLI="$NPM_PREFIX/node_modules/.bin/zorya-search-local"
"$SEARCH_CLI" --version
rm -- "$PACKAGE_TARBALL" "$DOWNLOAD_DIR/SHA256SUMS"
rmdir -- "$DOWNLOAD_DIR"
cd "$PROJECT_DIR"
```

В Linux вместо `shasum` можно использовать `sha256sum --check -` с той же checksum-строкой. На macOS можно сравнить результат `shasum -a 256 "$PACKAGE_TARBALL"` с опубликованным digest.

### Windows PowerShell

Выполняй блоки в одной PowerShell-сессии, чтобы сохранить переменные. Скачай asset по проверенной публичной ссылке и проверь его checksum:

```powershell
$ProjectDir = (Get-Location).Path
$DownloadDir = Join-Path $env:TEMP ('zorya-search-0.1.11-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $DownloadDir | Out-Null
$PackageTarball = Join-Path $DownloadDir 'zorya-search-0.1.11.tgz'
$ChecksumFile = Join-Path $DownloadDir 'SHA256SUMS'
$ReleaseBase = 'https://github.com/zoomplus/zorya-search/releases/download/v0.1.11'
Invoke-WebRequest "$ReleaseBase/zorya-search-0.1.11.tgz" -OutFile $PackageTarball
Invoke-WebRequest "$ReleaseBase/SHA256SUMS" -OutFile $ChecksumFile
$ExpectedSha256 = ((Get-Content -LiteralPath $ChecksumFile | Where-Object { $_ -match '  zorya-search-0\.1\.11\.tgz$' }) -split '\s+')[0]
if (-not $ExpectedSha256) { throw 'The release checksum entry is missing.' }
$ActualSha256 = (Get-FileHash -LiteralPath $PackageTarball -Algorithm SHA256).Hash
if ($ActualSha256 -ne $ExpectedSha256) { throw 'SHA-256 does not match the published release digest.' }
```

Установи его в отдельный пользовательский prefix в `%LOCALAPPDATA%`:

```powershell
$NpmPrefix = Join-Path $env:LOCALAPPDATA 'Zorya\Search\npm\0.1.11'
New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
npm install --prefix $NpmPrefix $PackageTarball
$SearchCli = Join-Path $NpmPrefix 'node_modules\.bin\zorya-search-local.cmd'
& $SearchCli --version
Remove-Item -LiteralPath $PackageTarball, $ChecksumFile -Force
Remove-Item -LiteralPath $DownloadDir -Force
Set-Location -LiteralPath $ProjectDir
```

Сравни версию с тем же asset, который ты проверил. Не включай `%LOCALAPPDATA%` в config path: state directory по умолчанию уже находится там. ACL пользовательского каталога должна ограничивать доступ к приватным данным.

## Создание config

Запусти `setup` из папки проекта. Config должен быть вне проекта и `stateDir`; не клади его внутрь пользовательского каталога Search state.

Linux/macOS:

```sh
CONFIG="$HOME/.config/zorya-search/local.json"
"$SEARCH_CLI" setup --config "$CONFIG"
"$SEARCH_CLI" client-config --config "$CONFIG"
```

Windows PowerShell:

```powershell
$ConfigPath = Join-Path $env:APPDATA 'Zorya\Search\local.json'
& $SearchCli setup --config $ConfigPath
& $SearchCli client-config --config $ConfigPath
```

`setup` создаёт новый config и отказывается перезаписывать существующий. В нём только schema version, случайный `clientId` и абсолютный `stateDir`; путь проекта, static `cwd` и ключи моделей туда не записываются. На POSIX config создаётся с mode `0600`; на Windows доступ зависит от ACL каталога пользователя. Config и state directory должны быть отдельными и не пересекаться с workspace.

## Регистрация в Codex

`client-config` только печатает варианты и не меняет Codex config. Выбери `codexInstalledToml`: он запускает текущий Node.js и абсолютный entry из установленного package prefix, поэтому не зависит от npm registry при каждом старте клиента. Перенеси из вывода только блок `[mcp_servers.zorya-search-local]` в активный `config.toml`. Стандартный user config находится в `~/.codex/config.toml`; если твоя установка Codex использует другой путь, редактируй фактически активный файл. Codex CLI и IDE используют общую конфигурацию [по документации OpenAI](https://developers.openai.com/learn/docs-mcp).

Перед правкой сохрани копию config.toml. Добавь только напечатанную секцию; если `[mcp_servers.zorya-search-local]` уже есть, замени только её. Сохрани все остальные MCP записи, defaults и пользовательские настройки. Не копируй весь вывод JSON и не заменяй весь TOML файл. Если версия проверенного пакета также опубликована в npm, `codexToml` — альтернативный npm-backed вариант; `generic` предназначен для совместимого JSON MCP config.

Напечатанный Codex TOML содержит `startup_timeout_sec = 30` и `tool_timeout_sec = 900`. В нём нет статического `cwd`, root path, модели, approval или sandbox policy. После сохранения перезапусти Codex и выполни `codex mcp list`, затем вызови Doctor из нужного workspace.

## Сделать Search доступным для обычных задач Codex

Регистрация MCP означает, что сервер подключён; она не устанавливает навык и сама по себе не доказывает, что Codex использовал Search в задаче. Чтобы навык находился между задачами, установи его в пользовательский каталог Codex и начни новую сессию. Поддерживаемый каталог skills — `$HOME/.agents/skills/<skill-name>/SKILL.md` (в Windows PowerShell: `$HOME/.agents/skills/<skill-name>/SKILL.md`); см. [документацию Codex Skills](https://learn.chatgpt.com/docs/build-skills). Не перезаписывай существующий каталог или файл: проверь его содержимое и выбери другой каталог либо сохрани ручное слияние.

Новый `skills/zorya-search-local/SKILL.md` в исходном дереве проекта задаёт эту инструкцию для локального workspace MCP. Он является добавлением исходников и не входит в опубликованный архив `zorya-search@0.1.11` и его release assets. Не пытайся получить его по несуществующему URL внутри старого релиза и не считай старый архив обновлённым. Если у тебя есть проверенное исходное дерево, скопируй только этот файл в `$HOME/.agents/skills/zorya-search-local/SKILL.md`, предварительно проверив, что целевого файла ещё нет. Пока файла нет в доступном исходном дереве, можно применить временное правило для текущей задачи: «Для относящихся к существующему коду задач используй подключённый и разрешённый локальный Zorya Search для навигации и чтения источника; проверь фактические capability, root и snapshot. Сверь найденный исходник обычными инструментами. Подключение Search не меняет мою роль, модель, план или workflow и не редактирует файлы; если Search недоступен, сообщи точную причину и продолжай доступными средствами. Не запускай несвязанный поиск или фоновую индексацию».

Навык может быть выбран автоматически системой skills или явно вызван пользователем, если текущая сессия его не обнаружила. После установки начни новую задачу/сессию и проверь обычным запросом на кодовую задачу. Слова «Search», названия MCP tools или отдельная просьба вызвать MCP в проверочном запросе делают результат непригодным для проверки естественного выбора навыка. Убедись по доступным журналам/результатам вызова, что реальный Search tool был вызван и вернул актуальный source identity; заявления агента или наличие записи в конфигурации сами по себе не подтверждают использование. Если журналов нет, пометь использование как неподтверждённое.

Если владелец хочет обязательное постоянное поведение для проекта, одной автоматической доступности skill недостаточно. Добавь приведённое в [руководстве клиентским агентам](agent-clients.md#skills-для-локального-клиента) узкое правило в существующий проектный `AGENTS.md`: сначала прочитай текущий файл и вложенные инструкции, сохрани копию вне проекта, затем добавь только этот текст, сохранив всё остальное и эффективный порядок правил. Для правила во всех проектах Codex используй только пользовательский scope в фактически разрешённом `CODEX_HOME`: проверь `AGENTS.override.md` и, если она отсутствует, `AGENTS.md`, сохрани резервную копию вне проекта и проверь весь effective instruction chain до и после изменения. Не переписывай целиком ни пользовательские, ни проектные инструкции и не меняй настройки Codex.

### Один запрос для установки и проверки

Можно дать агенту один запрос на установку и проверку. Адреса ниже закреплены за версией; агент должен сначала скачать checksum-файл и подтвердить доступность обоих assets:

> Установи `zorya-search-local` версии `0.1.11` из публичного архива https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/zorya-search-0.1.11.tgz. Сначала загрузи SHA256SUMS с https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/SHA256SUMS, проверь доступность обоих файлов и SHA-256 архива; при 404 или несовпадении остановись. Установи архив в отдельный пользовательский npm prefix без общей global-установки. Выбери приватный config path вне workspace (например, `~/.config/zorya-search/local.json` на POSIX или `%APPDATA%\Zorya\Search\local.json` в PowerShell); если такой config уже есть, проверь его владельца и безопасное повторное использование, иначе создай новый через `zorya-search-local setup`. Запусти `client-config`, сохрани копию активного Codex `config.toml` и добавь только `[mcp_servers.zorya-search-local]`, сохранив остальные записи и настройки. Не меняй модель, approval, sandbox, provider profile или реальные файлы проекта. Перезапусти Codex из текущей папки и проверь `doctor` и `codex mcp list`. Если в доступном проверенном исходном дереве есть `skills/zorya-search-local/SKILL.md`, установи только его в `$HOME/.agents/skills/zorya-search-local/SKILL.md`, не перезаписывая существующий skill. Этот skill является новым исходным дополнением и не входит в архив v0.1.11. Если исходный файл недоступен, примени временное правило из раздела «Сделать Search доступным для обычных задач Codex» и сообщи это ограничение. Установи постоянное правило для всех проектов Codex: разреши фактический `CODEX_HOME` (не предполагай его путь), прочитай действующий `AGENTS.override.md`, если он есть, иначе `AGENTS.md`, и проверь применяемые более конкретные инструкции. Перед правкой создай копию выбранного файла вне workspace; добавь в него только точный ограниченный caller rule из руководства клиентским агентам, сохрани все существующие байты и порядок инструкций, затем проверь effective instruction chain в новой независимой сессии. Не меняй модель, settings или другие файлы инструкций. Если текущая среда не позволяет безопасно выполнить это, остановись и укажи причину, не выдавая правило за установленное. Создай две временные Git-папки вне проекта с одинаковым путём `src/same.ts`, но разным содержимым, и несколькими уникальными безопасными строками для каждой папки. В каждой папке закоммить начальное состояние, затем измени tracked `src/same.ts` без commit, добавь untracked `src/untracked.ts` и удали другой tracked файл `src/deleted.ts`. Проведи все изменения до нового независимого Codex-сеанса и не включай в запрос тестовой задачи названия Search, MCP, tools или skills. В первой папке задай ровно такую обычную задачу чтения/ревью: «Объясни функцию `sameWorkspaceMarker` из `src/same.ts` и константу `untrackedMarker` из `src/untracked.ts`. Отдельно проверь, существует ли сейчас `src/deleted.ts`, и что можно заключить о его содержимом. Ничего не меняй». Повтори тот же запрос для второй папки через `codex -C <second-folder>`. Сверь фактические tool journals/results, source paths и snapshot/workspace identities, полный hash каждого прочитанного файла с локально вычисленным hash; подтверди, что новые tracked/untracked данные найдены и между workspace нет смешения. После первого успешного A-запроса сохрани его актуальные snapshot/path, затем внеси ещё одну незакоммиченную правку в tracked `src/same.ts` папки A с новым уникальным marker и повтори тот же естественный запрос. Убедись по следующему Search source query и `read_source`, что marker найден с новым snapshot и hash без ручного index-вызова. После этого вызови `read_source` с прежним snapshot и тем же путём; зафиксируй точный typed stale refusal, не повторяй старый pointer и не считай отказ успешным чтением. Проверь удалённый `src/deleted.ts` с текущим snapshot и сохрани точную typed ошибку отсутствующего source. Для отдельной проверки постоянного caller-rule создай новую временную папку с кодом и до новой сессии добавь в её `AGENTS.md` ровно ограниченное правило из руководства клиентским агентам. Задай естественную короткую задачу исправить известную ошибку в существующем исходнике, разреши менять только эту временную папку и убедись по журналам, что исполнитель сначала искал и читал код, а файл изменил только в ответ на задачу. Проведи также отдельную задачу на несвязанную арифметику; Search не должен вызываться для неё. Удали только принадлежащие этой проверке fixtures и owner-процессы после подтверждённой остановки. Разрешены только описанные временные test fixtures; не меняй реальные исходники проекта, модель, approval, sandbox, provider profile или остальные конфигурации. По фактическим журналам/результатам сообщи версию, ОС и клиента, состояния установки/активации/использования навыка, source paths, identities, hashes, конфигурационные файлы и точную причину fallback, если Search не сработал. Не считай самоотчёт агента или запись о подключении доказательством вызова инструмента.

## Проверка двух папок и незакоммиченных правок

После регистрации проведи отдельную проверку на двух разных локальных папках с безопасными тестовыми строками:

1. Открой первую папку как workspace Codex. Запроси поиск уникального текста из тестового файла и проверь source path и snapshot identity.
2. Выполни запрос для второй папки, например через Codex `-C <second-folder>`, даже если процесс был запущен из первой. Убедись, что результат относится только ко второй папке и её workspace identity.
3. Измени тестовую строку в первой папке без commit и повтори source query. Проверка свежести должна находить новое содержимое без ручного `index`, не меняя исходный файл.
4. Повтори запрос для второй папки и проверь, что результат не переключился на первую. Запиши фактические CLI version, клиент и ОС; fixture не заменяет нативную приёмку.

Это процедура проверки, а не утверждение, что конкретный установщик или клиент уже прошёл её.

## Диагностика и очистка

Запусти `doctor` из нужного workspace. Он показывает `workspacePath`, `workspaceId`, `stateDir`, состояние владельца, `sourceIndexing: "explicit-on-source-query"` и `providerDefaults: "none"`. Отчёт не содержит bearer; Doctor не открывает базу и не вызывает провайдеры.

Чтобы остановить владельца, запусти `stop` из той же папки и с тем же config:

```sh
"$SEARCH_CLI" stop --config "$CONFIG"
```

В PowerShell выполни `& $SearchCli stop --config $ConfigPath`. Для отключения MCP отдельно удали только `zorya-search-local` способом, который поддерживает клиент. Не удаляй каталог состояния, пока не решил потерять все индексы в нём и не проверил, что путь принадлежит только Search. Удаление config не останавливает процесс: сначала используй `stop`.

## Проверка готовности

Перед установкой проверь, что оба versioned GitHub assets доступны, а SHA-256 архива совпадает с единственной записью в `SHA256SUMS`. Этот документ задаёт процедуру, но сам по себе не подтверждает, что конкретная ОС, версия Codex или hosted клиент уже прошли нативную проверку.
