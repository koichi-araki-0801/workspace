# apply.ps1 / rollback.ps1 の Pester 3/4 テスト。①の移行済みの dataRoot を一時フォルダに作り、
# 確認モード・適用・再実行・既知の形の未コミット変更の取り込み・追跡の解除・中止条件・点検の報告・
# rollback を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'apply.ps1'
$roll = Join-Path $here 'rollback.ps1'

# 実データへ触れないよう、置き場に効く環境変数と GIT_BIN を退避して空にし、APP_CONFIG を存在しない
# パスへ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
# $extraEnv のキーは $names のどれか(終わったら元へ戻す)。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$imagesDir, [hashtable]$extraEnv) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'IMAGES_DIR', 'GIT_BIN'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', (Join-Path $env:TEMP 'fund-img-no-appconfig.json'))
  if ($imagesDir) { [Environment]::SetEnvironmentVariable('IMAGES_DIR', $imagesDir) }
  if ($extraEnv) { foreach ($k in $extraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $extraEnv[$k]) } }
  try { & $file @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}

function New-Layout([switch]$WithAssets) {
  $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  foreach ($d in 'css', 'templates', 'filled') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '.a{}' -NoNewline
  if ($WithAssets) { New-Item -ItemType Directory -Force -Path (Join-Path $root 'assets\fonts') | Out-Null }
  [IO.File]::WriteAllText((Join-Path $root '.gitignore'),
    "/drafts/`n/reviews/`n/pending/`n/notes/`n/css/fonts/`n*.tmp-*`n", (New-Object Text.UTF8Encoding $false))
  git -C $root init -q
  git -C $root add -- .gitignore css
  git -C $root -c user.name=t -c user.email=t@t commit -q -m init
  return $root
}

function Get-IgnoreLines([string]$root) { @([IO.File]::ReadAllLines((Join-Path $root '.gitignore'))) }

function Get-Message([scriptblock]$action) {
  $msg = ''
  try { & $action | Out-Null } catch { $msg = $_.Exception.Message }
  return $msg
}

function Write-Utf8([string]$path, [string]$text, [switch]$Bom) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding ([bool]$Bom)))
}

function New-TempConfig([object]$value) {
  $cfg = Join-Path $env:TEMP ('fund-img-cfg-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
  [IO.File]::WriteAllText($cfg, ($value | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  return $cfg
}

# 追跡された js を持つ dataRoot(画像の置き場パッチが追跡を外す対象)。
function New-TrackedJsLayout {
  $root = New-Layout
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'js') | Out-Null
  Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
  git -C $root add -f -- js
  git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
  return $root
}

Describe 'apply.ps1' {
  It '確認モードでは何も変えない' {
    $root = New-Layout
    try {
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $script @{ DataRoot = $root; Port = 1 } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
      Test-Path (Join-Path $root 'images') | Should Be $false
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '-Apply で .gitignore に /images/ を足し、images を作り、system 名義で 1 コミットする' {
    $root = New-Layout
    try {
      $before = @(git -C $root rev-list HEAD).Count
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $true
      Test-Path (Join-Path $root 'images') | Should Be $true
      @(git -C $root rev-list HEAD).Count | Should Be ($before + 1)
      # 件名の日本語は PowerShell 5.1 が git の出力を OEM コードページで読むため化ける。
      # 照合は ASCII の目印と作者名で行う。
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      (git -C $root status --porcelain -- .gitignore css templates filled sync) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '再実行しても何も変えない' {
    $root = New-Layout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '.gitignore に /images/ だけが未コミットで足されていれば進み、その差分をコミットする' {
    $root = New-Layout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/`n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) | Should Be '.gitignore'
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '.gitignore に /images/ 以外の行も足されていれば中止する' {
    $root = New-Layout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/`n/other/`n", (New-Object Text.UTF8Encoding $false))
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } } | Should Throw
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'それ以外の未コミット変更があれば中止する' {
    $root = New-Layout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match 'css/510037\.css'
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '①の移行前(assets が残っている)なら①のパッチを案内して中止する' {
    $root = New-Layout -WithAssets
    try {
      $msg = ''
      try { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null } catch { $msg = $_.Exception.Message }
      $msg | Should Match '2026-10-fonts-to-css'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'imagesDir が確定領域の内側なら中止する' {
    $root = New-Layout
    try {
      $head = git -C $root rev-parse HEAD
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } (Join-Path $root 'css\images') } | Should Throw
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既に置かれた画像を点検して報告する(書き換えない)' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images\sub') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\sub\510037_a.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_anim.gif') -Value 'GIF' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\logo.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match '\[subfolder\][^\r\n]*510037_a\.svg'
      $out | Should Match '\[extension\][^\r\n]*510037_anim\.gif'
      $out | Should Match '\[naming\][^\r\n]*logo\.svg'
      $out | Should Not Match '\[naming\][^\r\n]*510037_logo\.svg'
      Test-Path (Join-Path $root 'images\sub\510037_a.svg') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'git が失敗したら stderr の原因を例外に含める' {
    $root = New-Layout
    try {
      Set-Content -LiteralPath (Join-Path $root '.git\index.lock') -Value '' -NoNewline
      $msg = ''
      try { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null } catch { $msg = $_.Exception.Message }
      $msg | Should Match 'index\.lock'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'PATH に git が無くても GIT_BIN の git で流せる' {
    $root = New-Layout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }

  It '.git の無い dataRoot では init-data-repo.bat を案内して中止し、何も作らない' {
    $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css'), (Join-Path $root 'templates') | Out-Null
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match 'git リポジトリではありません'
      $msg | Should Match 'init-data-repo\.bat'
      Test-Path (Join-Path $root '.git') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴(HEAD)の無い data リポジトリでは init-data-repo.bat を案内して中止する' {
    $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css'), (Join-Path $root 'templates') | Out-Null
      git -C $root init -q
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '履歴'
      $msg | Should Match 'init-data-repo\.bat'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'HEAD の確認で git が 1 以外で失敗したら(dubious ownership 等)、履歴が無いとは言わずに原因を出し、何も書かない' {
    $root = New-Layout
    $fake = Join-Path $env:TEMP ('fund-img-fakegit-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cmd')
    try {
      [IO.File]::WriteAllText($fake, "@echo fatal: detected dubious ownership in repository 1>&2`r`n@exit /b 128`r`n")
      $ignoreBefore = [IO.File]::ReadAllText((Join-Path $root '.gitignore'))
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $null @{ GIT_BIN = $fake } }
      $msg | Should Match 'dubious ownership'
      $msg | Should Not Match 'init-data-repo'
      [IO.File]::ReadAllText((Join-Path $root '.gitignore')) | Should Be $ignoreBefore
      Test-Path (Join-Path $root 'images') | Should Be $false
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $fake
    }
  }

  It 'templates も css も無ければ取り違えとして警告し、何も変えずに終了コード 2 で終わる' {
    $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'notes') | Out-Null
      git -C $root init -q
      git -C $root -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
      $head = git -C $root rev-parse HEAD
      $global:LASTEXITCODE = 0
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } *>&1 | Out-String
      $LASTEXITCODE | Should Be 2
      $out | Should Match 'templates も css もありません'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'images') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: CSS の書き換えに加えて末尾に改行を 1 つ足しただけなら取り込む' {
    $root = New-Layout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') '@font-face{src:url(../fonts/a.woff2)}'
      git -C $root add -- css
      git -C $root -c user.name=t -c user.email=t@t commit -q -m legacy
      Write-Utf8 (Join-Path $root 'css\510037.css') "@font-face{src:url(fonts/a.woff2)}`n"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
      (git -C $root status --porcelain -- css) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形(.gitignore の /images/・CSS の ../fonts/ の書き換え・BOM 付き .gitattributes の置き換え)はまとめて取り込む' {
    $root = New-Layout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') '@font-face{src:url(../fonts/a.woff2)}'
      $attr = Join-Path $root '.gitattributes'
      [IO.File]::WriteAllBytes($attr, [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n")))
      git -C $root add -- css .gitattributes
      git -C $root -c user.name=t -c user.email=t@t commit -q -m legacy
      Write-Utf8 (Join-Path $root 'css\510037.css') '@font-face{src:url(fonts/a.woff2)}' -Bom
      Write-Utf8 $attr "* text eol=lf`n"
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/`n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $names = @(git -C $root show --name-only --format= HEAD)
      $names -contains '.gitignore' | Should Be $true
      $names -contains '.gitattributes' | Should Be $true
      $names -contains 'css/510037.css' | Should Be $true
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root status --porcelain -- .gitignore .gitattributes css) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: .gitignore に末尾の空白付きで /images/ を足していても、取り込んだうえで重ねて追記しない' {
    $root = New-Layout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/ `n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(Get-IgnoreLines $root | Where-Object { $_.Trim() -eq '/images/' }).Count | Should Be 1
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: .gitignore に先頭の空白付きの "  /images/" を足しただけでは取り込まない(git はその行で無視しない)' {
    $root = New-Layout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "  /images/`n", (New-Object Text.UTF8Encoding $false))
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match '\.gitignore'
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '確定済みの .gitignore にあるのが先頭の空白付きの "  /images/" や末尾にタブ付きの "/images/<TAB>" なら、/images/ を追記する' {
    foreach ($line in "  /images/", "/images/`t") {
      $root = New-Layout
      try {
        [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "$line`n", (New-Object Text.UTF8Encoding $false))
        git -C $root add -- .gitignore
        git -C $root -c user.name=t -c user.email=t@t commit -q -m ignore
        Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
        @(Get-IgnoreLines $root | Where-Object { $_ -ceq '/images/' }).Count | Should Be 1
        (git -C $root log -1 --format='%an') | Should Be 'system'
      } finally { Remove-Item -Recurse -Force $root }
    }
  }

  It '中止: 前回のパッチが途中で止まった形跡(REVERT_HEAD)があれば、その旨を案内する' {
    $root = New-Layout
    try {
      Set-Content -LiteralPath (Join-Path $root '.git\REVERT_HEAD') -Value (git -C $root rev-parse HEAD)
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '途中で止まった'
      $msg | Should Match 'REVERT_HEAD'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 点検範囲の外でステージ済みの変更があれば、確認モードでも -Apply でも中止し、何も変えない' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'misc') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'misc\hand.txt') -Value 'h' -NoNewline
      git -C $root add -- misc/hand.txt
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match 'misc/hand\.txt'
      # checkout -- だけでは新しく足してステージしたファイルが index に残るので、外し方も案内する。
      $msg | Should Match 'restore --staged'
      $msg | Should Match 'checkout -- に渡すと'
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match 'misc/hand\.txt'
      git -C $root rev-parse HEAD | Should Be $head
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
      Test-Path (Join-Path $root 'images') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡されている画像・js は確認モードで一覧に出し、-Apply で追跡だけ外す(ファイルは残す)' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images'), (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- images js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'images/510037_logo\.svg'
      $out | Should Match 'js/w\.js'
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- css/fonts images js assets).Count | Should Be 0
      Test-Path (Join-Path $root 'images\510037_logo.svg') | Should Be $true
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      ((git -C $root show --name-status --format= HEAD) -join "`n") | Should Match 'D\s+images/510037_logo\.svg'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '手で変更してステージした追跡済みの画像も、-Apply で追跡だけ外し、作業ツリーのファイルは残す' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      # index を HEAD とも作業ツリーとも違う状態にする(git rm --cached が -f なしでは拒む形)。
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg>2</svg>' -NoNewline
      git -C $root add -f -- images/510037_logo.svg
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg>3</svg>' -NoNewline
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- images).Count | Should Be 0
      (Get-Content -Raw (Join-Path $root 'images\510037_logo.svg')) | Should Be '<svg>3</svg>'
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'appconfig の置き場の値がパスとして読めなければ、キーの名前を出して中止する' {
    $root = New-Layout
    $cfg = New-TempConfig @{ paths = @{ imagesDir = 'a|b' } }
    try {
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Port = 1 } $null @{ APP_CONFIG = $cfg } }
      $msg | Should Match 'paths\.imagesDir'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }

  It '-DataRoot に 8.3 形式の短い名前を渡しても、長い名前に揃えて点検・適用・rollback する' {
    $root = New-Layout
    try {
      $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath
      if ($short -eq $root) { Set-TestInconclusive 'このボリュームでは 8.3 形式の短い名前が無効なため飛ばします。' }
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      $out = Invoke-Patch $script @{ DataRoot = $short; Port = 1 } *>&1 | Out-String
      $out | Should Not Match '\[subfolder\]'
      $out | Should Match ([regex]::Escape("dataRoot : $root "))
      Invoke-Patch $script @{ DataRoot = $short; Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      $out = Invoke-Patch $roll @{ DataRoot = $short; Apply = $true } *>&1 | Out-String
      $out | Should Match ([regex]::Escape("dataRoot: $root") + '\r?\n')
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }
}

Describe 'rollback.ps1' {
  It '2 回流しても revert の revert にならず、images の中身は残る' {
    $root = New-Layout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
      Test-Path (Join-Path $root 'images\510037_logo.svg') | Should Be $true
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '確認モードでは何も変えない' {
    $root = New-Layout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $roll @{ DataRoot = $root } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡された画像・js を -Apply で外したあとでも、rollback -Apply が通り、追跡が戻る' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images'), (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- images js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      ((@(git -C $root ls-files -- images js) | Sort-Object) -join ',') | Should Be 'images/510037_logo.svg,js/w.js'
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      @(Get-ChildItem $root -Directory -Force -Filter '.rollback-tmp-*').Count | Should Be 0
      (git -C $root status --porcelain -- images js) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡を外した後に中身を変えた js は、rollback で退避を残して報告する' {
    $root = New-TrackedJsLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'changed()' -NoNewline
      $out = Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } *>&1 | Out-String
      $stamp = Get-Date -Format 'yyyyMMdd'
      Get-Content -Raw (Join-Path $root ".rollback-tmp-$stamp\js\w.js") | Should Be 'changed()'
      Get-Content -Raw (Join-Path $root 'js\w.js') | Should Be 'w()'
      $out | Should Match '退避に残しました'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は同じ日の退避に同じパスのファイルが既にあれば、何も変えずに中止する' {
    $root = New-TrackedJsLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $old = Join-Path $root (".rollback-tmp-" + (Get-Date -Format 'yyyyMMdd') + '\js\w.js')
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $old) | Out-Null
      Set-Content -LiteralPath $old -Value 'OLD' -NoNewline
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } }
      $msg | Should Match '同じ日の退避'
      Get-Content -Raw $old | Should Be 'OLD'
      Get-Content -Raw (Join-Path $root 'js\w.js') | Should Be 'w()'
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は git revert が競合したら revert --abort で戻し、退避したファイルも元へ戻して中止する' {
    $root = New-TrackedJsLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      # 移行コミットが足した /images/ の行を後のコミットで書き換え、revert が .gitignore で競合する形にする。
      $ignore = Join-Path $root '.gitignore'
      [IO.File]::WriteAllText($ignore, ([IO.File]::ReadAllText($ignore) -replace '/images/', '/images-x/'), (New-Object Text.UTF8Encoding $false))
      git -C $root add -- .gitignore
      git -C $root -c user.name=t -c user.email=t@t commit -q -m edit
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'mine()' -NoNewline
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } }
      $msg | Should Match 'revert'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root '.git\REVERT_HEAD') | Should Be $false
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
      Get-Content -Raw (Join-Path $root 'js\w.js') | Should Be 'mine()'
      @(Get-ChildItem $root -Directory -Force -Filter '.rollback-tmp-*').Count | Should Be 0
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'apply と rollback は -DataRoot の相対パスを今の場所を基準に解決する' {
    $root = New-Layout
    Push-Location (Split-Path -Parent $root)
    try {
      Invoke-Patch $script @{ DataRoot = (Split-Path -Leaf $root); Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      Invoke-Patch $roll @{ DataRoot = (Split-Path -Leaf $root); Apply = $true } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally {
      Pop-Location
      Remove-Item -Recurse -Force $root
    }
  }

  It 'PATH に git が無くても GIT_BIN の git で戻せる' {
    $root = New-Layout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }

  It 'rollback も appconfig の置き場の値がパスとして読めなければ、キーの名前を出して中止する' {
    $root = New-Layout
    $cfg = New-TempConfig @{ paths = @{ imagesDir = 'a|b' } }
    try {
      $msg = Get-Message { Invoke-Patch $roll @{ DataRoot = $root } $null @{ APP_CONFIG = $cfg } }
      $msg | Should Match 'paths\.imagesDir'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }
}

# Mock は Describe の終わりまで残るので、ユーザー環境変数の差し替えが他のテストへ及ばないよう分ける。
Describe 'apply.ps1 の appconfig の paths.dataRoot' {
  It 'editor のフォルダの中を指す paths.dataRoot は使わずに次の候補(既定)へ移り、その旨を案内する' {
    # 既定の場所が本物の dataRoot にならないよう、apply.ps1 を一時の偽の editor 構成へ複製して流す
    # (既定は <偽のワークスペースの親>\editor-data になり、そこへ一時の dataRoot を用意する)。
    $x = Join-Path $env:TEMP ('fund-img-ws-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $fakePatch = Join-Path $x 'workspace\editor\patches\2026-10-fund-images'
    New-Item -ItemType Directory -Force -Path $fakePatch | Out-Null
    Copy-Item -LiteralPath $script -Destination $fakePatch
    $fakeScript = Join-Path $fakePatch 'apply.ps1'
    $cfg = Join-Path $x 'appconfig.json'
    # ユーザー環境変数 DATA_ROOT(この端末では本物の dataRoot)を読ませず、appconfig まで進ませる。
    Mock Get-ItemProperty { $null } -ParameterFilter { $LiteralPath -eq 'HKCU:\Environment' }
    $layout = New-Layout
    try {
      $default = Join-Path $x 'editor-data'
      Move-Item -LiteralPath $layout -Destination $default
      Write-Utf8 $cfg (@{ paths = @{ dataRoot = 'data' } } | ConvertTo-Json)
      $out = Invoke-Patch $fakeScript @{ Port = 1 } $null @{ APP_CONFIG = $cfg } *>&1 | Out-String
      Assert-MockCalled Get-ItemProperty -Scope It
      $out | Should Match 'paths\.dataRoot\(data\)は editor のフォルダの中を指すため使いません'
      $out | Should Match ([regex]::Escape("dataRoot : $default (既定)"))
      $out | Should Match '確認モードのため何も変えていません'
    } finally {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $x, $layout
    }
  }
}
