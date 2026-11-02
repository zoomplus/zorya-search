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

### Один запрос для установки и проверки

Можно дать агенту один запрос на установку и проверку. Адреса ниже закреплены за версией; агент должен сначала скачать checksum-файл и подтвердить доступность обоих assets:

> Установи `zorya-search-local` версии `0.1.11` из публичного архива https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/zorya-search-0.1.11.tgz. Сначала загрузи SHA256SUMS с https://github.com/zoomplus/zorya-search/releases/download/v0.1.11/SHA256SUMS, проверь доступность обоих файлов и SHA-256 архива; при 404 или несовпадении остановись. Установи архив в отдельный пользовательский npm prefix без общей global-установки. Выбери приватный config path вне workspace (например, `~/.config/zorya-search/local.json` на POSIX или `%APPDATA%\Zorya\Search\local.json` в PowerShell); если такой config уже есть, сначала проверь, что он принадлежит этому устройству и безопасен для повторного использования, иначе создай новый через `zorya-search-local setup`. Запусти `client-config`, сохрани копию активного Codex config.toml и добавь только `[mcp_servers.zorya-search-local]`, сохранив остальные записи и настройки. Не меняй model, approval, sandbox, provider profile или реальные файлы проекта. Перезапусти Codex из текущей папки, вызови `doctor` и `codex mcp list`, затем проверь реальный Search MCP через `capabilities`, `search_code` и `read_source`: сообщи относительный source path, snapshot/workspace identity и SHA-256 прочитанного файла, не цитируя содержимое. Создай две временные Git fixture-папки вне проекта с одинаковым `src/same.ts`; закоммить начальное состояние, измени tracked файл без commit, добавь untracked файл и удали другой tracked файл. Проверь поиск/чтение в обеих папках через `-C`, сравни каждый результат с заранее известным локальным hash и проверь отсутствие межпапочного смешения. Затем внеси ещё одну незакоммиченную правку и подтверди обновление snapshot без ручного index-вызова. Удали только созданные для проверки fixture-файлы и принадлежащие тесту owner-процессы после подтверждённой остановки. Верни версию, реальные MCP результаты и hashes, workspace identities и точные конфигурационные файлы, которые изменил.

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
