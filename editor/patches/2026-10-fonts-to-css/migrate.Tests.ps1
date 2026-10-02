# migrate.ps1 の Pester 3/4 テスト。旧構成の dataRoot を一時フォルダに作り、確認モード・適用・
# 再実行・競合・未コミット変更での中止を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'migrate.ps1'

# 実データへ触れないよう、置き場に効く環境変数と GIT_BIN を退避して空にし、APP_CONFIG を一時ファイル
# (既定は存在しないパス)へ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
# $extraEnv のキーは $names のどれか(終わったら元へ戻す)。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$appConfig, [hashtable]$extraEnv) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'TEMPLATES_DIR', 'FILLED_DIR', 'CSS_DIR', 'JS_DIR', 'IMAGES_DIR',
    'ASSETS_DIR', 'DRAFTS_DIR', 'PENDING_DIR', 'REVIEWS_DIR', 'SYNC_DIR', 'GIT_BIN'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  if (-not $appConfig) { $appConfig = Join-Path $env:TEMP 'fonts-mig-no-appconfig.json' }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', $appConfig)
  if ($extraEnv) { foreach ($k in $extraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $extraEnv[$k]) } }
  try { & $file @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}

function New-OldLayout {
  $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  foreach ($d in 'assets\fonts', 'assets\js', 'css', 'drafts', 'reviews\r1', 'templates', 'filled') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $root 'assets\fonts\a.woff2') -Value 'FONT' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'assets\js\w.js') -Value 'w()' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -NoNewline `
    -Value '@font-face{src:url(../fonts/a.woff2)} .x{background:url(../../fonts/no.png)}'
  Set-Content -LiteralPath (Join-Path $root 'drafts\T1.css') -Value '.d{src:url("../fonts/a.woff2")}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'reviews\r1\body.css') -Value '.r{src:url(../fonts/a.woff2)}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<style>@font-face{src:url(fonts/a.woff2)}</style>' -NoNewline
  [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/drafts/`n/reviews/`n", (New-Object Text.UTF8Encoding $false))
  git -C $root init -q
  # 実環境と同じく、追跡するのは確定領域だけ(assets・drafts・reviews は追跡しない)。
  git -C $root add -- .gitignore css templates filled
  git -C $root -c user.name=t -c user.email=t@t commit -q -m init
  return $root
}

function Get-Message([scriptblock]$action) {
  $msg = ''
  try { & $action | Out-Null } catch { $msg = $_.Exception.Message }
  return $msg
}

function Write-Utf8([string]$path, [string]$text, [switch]$Bom) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding ([bool]$Bom)))
}

$cssRewritten = '@font-face{src:url(fonts/a.woff2)} .x{background:url(../../fonts/no.png)}'

# editor のフォルダの中の判定を、実リポジトリの editor を汚さずに確かめるための写し。
# 戻り値はワークスペースに当たるフォルダ(<戻り値>\editor が editor のフォルダ)。
function New-FakeEditor {
  $ws = Join-Path $env:TEMP ('fonts-mig-ws-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $patchDir = Join-Path $ws 'editor\patches\2026-10-fonts-to-css'
  New-Item -ItemType Directory -Force -Path $patchDir, (Join-Path $ws 'editor\data\templates') | Out-Null
  Copy-Item -LiteralPath (Join-Path $here 'migrate.ps1'), (Join-Path $here 'rollback.ps1') -Destination $patchDir
  return $ws
}

function New-TempConfig([object]$value) {
  $cfg = Join-Path $env:TEMP ('fonts-mig-cfg-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
  [IO.File]::WriteAllText($cfg, ($value | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  return $cfg
}

Describe 'migrate.ps1' {
  It '確認モードでは何も変えない' {
    $root = New-OldLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Port = 1 } | Out-Null
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '-Apply で移動・書き換え・コミットし、HTML は報告だけ' {
    $root = New-OldLayout
    try {
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } *>&1 | Out-String
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      (Get-ChildItem $root -Directory -Filter 'assets.migrated-*').Count | Should Be 1
      $css = Get-Content -Raw (Join-Path $root 'css\510037.css')
      $css | Should Match 'url\(fonts/a\.woff2\)'
      $css | Should Match 'url\(\.\./\.\./fonts/no\.png\)'
      (Get-Content -Raw (Join-Path $root 'drafts\T1.css')) | Should Match 'url\("fonts/a\.woff2"\)'
      (Get-Content -Raw (Join-Path $root 'reviews\r1\body.css')) | Should Match 'url\(fonts/a\.woff2\)'
      (Get-Content -Raw (Join-Path $root 'templates\T1.html')) | Should Match 'url\(fonts/a\.woff2\)'
      $out | Should Match 'templates\\T1\.html'
      (Get-Content (Join-Path $root '.gitignore')) -contains '/css/fonts/' | Should Be $true
      # 件名の日本語は PowerShell 5.1 が git の出力を OEM コードページで読むため化ける。
      # 照合は ASCII の目印と作者名で行う。
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
      (git -C $root status --porcelain -- .gitignore css templates filled sync) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '再実行しても何も変えない' {
    $root = New-OldLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '移動先に別内容があれば競合で中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'OTHER' -NoNewline
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } } | Should Throw
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback を繰り返しても移行を再適用しない' {
    $root = New-OldLayout
    try {
      $roll = Join-Path $here 'rollback.ps1'
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
      # 利用者が assets を退避名へ戻した状況を作り、2 回目の rollback が revert を重ねないことを見る。
      $stamp = Get-Date -Format 'yyyyMMdd'
      Rename-Item -LiteralPath (Join-Path $root 'assets') -NewName "assets.migrated-$stamp"
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は移行後に置かれたファイルを消さず、同一内容のものだけ消す' {
    $root = New-OldLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\new.woff2') -Value 'NEW' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'js\extra.js') -Value 'x()' -NoNewline
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } | Out-Null
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $false
      Test-Path (Join-Path $root 'js\w.js') | Should Be $false
      Test-Path (Join-Path $root 'css\fonts\new.woff2') | Should Be $true
      Test-Path (Join-Path $root 'js\extra.js') | Should Be $true
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'git が失敗したら stderr の原因を例外に含める' {
    $root = New-OldLayout
    try {
      Set-Content -LiteralPath (Join-Path $root '.git\index.lock') -Value '' -NoNewline
      $msg = ''
      try { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null } catch { $msg = $_.Exception.Message }
      $msg | Should Match 'index\.lock'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'appconfig の pendingDir・draftsDir を読み、その中の CSS を書き換える' {
    $root = New-OldLayout
    $other = Join-Path $env:TEMP ('fonts-mig-ext-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $cfg = Join-Path $env:TEMP ('fonts-mig-cfg-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $other 'pend'), (Join-Path $other 'dr') | Out-Null
      Set-Content -LiteralPath (Join-Path $other 'pend\P1.css') -Value '.p{src:url(../fonts/a.woff2)}' -NoNewline
      Set-Content -LiteralPath (Join-Path $other 'dr\D2.css') -Value '.p{src:url(../fonts/a.woff2)}' -NoNewline
      $json = @{ paths = @{ pendingDir = (Join-Path $other 'pend'); draftsDir = (Join-Path $other 'dr') } } | ConvertTo-Json
      [IO.File]::WriteAllText($cfg, $json, (New-Object Text.UTF8Encoding $false))
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg *>&1 | Out-String
      (Get-Content -Raw (Join-Path $other 'pend\P1.css')) | Should Match 'url\(fonts/a\.woff2\)'
      (Get-Content -Raw (Join-Path $other 'dr\D2.css')) | Should Match 'url\(fonts/a\.woff2\)'
      $out | Should Match 'appconfig の paths\.pendingDir'
      # 既定の drafts\T1.css は draftsDir を別に向けたので対象外のまま。
      (Get-Content -Raw (Join-Path $root 'drafts\T1.css')) | Should Match 'url\("\.\./fonts/a\.woff2"\)'
    } finally {
      Remove-Item -Recurse -Force $root, $other
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }

  It 'rollback で作業コピー(drafts・reviews)の CSS が移行前へ戻る' {
    $root = New-OldLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (Get-Content -Raw (Join-Path $root 'drafts\T1.css')) | Should Match 'url\("fonts/a\.woff2"\)'
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } | Out-Null
      (Get-Content -Raw (Join-Path $root 'drafts\T1.css')) | Should Match 'url\("\.\./fonts/a\.woff2"\)'
      (Get-Content -Raw (Join-Path $root 'reviews\r1\body.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'appconfig の paths.assetsDir を paths.jsDir=<dataRoot>\js へ書き換え、バックアップを残す' {
    $root = New-OldLayout
    $cfg = Join-Path $env:TEMP ('fonts-mig-cfg-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
    try {
      $json = @{ paths = @{ assetsDir = (Join-Path $root 'assets') } } | ConvertTo-Json
      [IO.File]::WriteAllText($cfg, $json, (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      $after = Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json
      $after.paths.PSObject.Properties['assetsDir'] | Should BeNullOrEmpty
      $after.paths.jsDir | Should Be (Join-Path $root 'js')
      @(Get-ChildItem (Split-Path $cfg) -Filter ((Split-Path $cfg -Leaf) + '.bak-*')).Count | Should Be 1
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'css\fonts に未追跡のフォントが先に置かれていても -Apply が進む' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'FONT' -NoNewline
      (Get-Content (Join-Path $root '.gitignore')) -contains '/css/fonts/' | Should Be $false
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(fonts/a\.woff2\)'
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'PATH に git が無くても GIT_BIN の git で流せる' {
    $root = New-OldLayout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }

  It '-DataRoot に相対パスを渡しても、今の場所を基準に解決して流せる' {
    $root = New-OldLayout
    Push-Location (Split-Path -Parent $root)
    try {
      Invoke-Patch $script @{ DataRoot = (Split-Path -Leaf $root); Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
    } finally {
      Pop-Location
      Remove-Item -Recurse -Force $root
    }
  }

  It '履歴(HEAD)の無い data リポジトリでは init-data-repo.bat を案内して中止する' {
    $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css'), (Join-Path $root 'templates') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '.a{}' -NoNewline
      git -C $root init -q
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '履歴'
      $msg | Should Match 'init-data-repo\.bat'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'HEAD の確認で git が 1 以外で失敗したら(dubious ownership 等)、履歴が無いとは言わずに原因を出し、何も書かない' {
    $root = New-OldLayout
    $fake = Join-Path $env:TEMP ('fonts-mig-fakegit-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cmd')
    try {
      [IO.File]::WriteAllText($fake, "@echo fatal: detected dubious ownership in repository 1>&2`r`n@exit /b 128`r`n")
      $ignoreBefore = [IO.File]::ReadAllText((Join-Path $root '.gitignore'))
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $null @{ GIT_BIN = $fake } }
      $msg | Should Match 'dubious ownership'
      $msg | Should Not Match 'init-data-repo'
      [IO.File]::ReadAllText((Join-Path $root '.gitignore')) | Should Be $ignoreBefore
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $fake
    }
  }

  It 'templates も css も無ければ取り違えとして警告し、何も変えずに終了コード 2 で終わる' {
    $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
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
      Test-Path (Join-Path $root '.gitignore') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: CSS の ../fonts/ → fonts/ の書き換えだけの未コミット変更は取り込んで同じコミットに含める' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') $cssRewritten
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
      (git -C $root status --porcelain -- .gitignore css templates filled sync) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: BOM 付きで書き直しただけの CSS も、BOM を除いて比べて取り込む' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') $cssRewritten -Bom
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: 書き換えに加えて末尾に改行を 1 つ足しただけの CSS も取り込む' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') ($cssRewritten + "`r`n")
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains 'css/510037.css' | Should Be $true
      (git -C $root status --porcelain -- css) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: .gitignore に末尾の空白付きで /css/fonts/ を足していても、取り込んだうえで重ねて追記しない' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/ `n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')) | ForEach-Object { $_.Trim() })
      @($lines | Where-Object { $_ -eq '/css/fonts/' }).Count | Should Be 1
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: BOM 付き CRLF の * text=lf を * text eol=lf にしただけの .gitattributes は取り込む' {
    $root = New-OldLayout
    try {
      $attr = Join-Path $root '.gitattributes'
      $bytes = [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n"))
      [IO.File]::WriteAllBytes($attr, $bytes)
      git -C $root add -- .gitattributes
      git -C $root -c user.name=t -c user.email=t@t commit -q -m attr
      Write-Utf8 $attr "* text eol=lf`n"
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) -contains '.gitattributes' | Should Be $true
      (git -C $root status --porcelain -- .gitattributes) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既知の形: .gitignore に必須行(/css/fonts/・/images/)を足しただけなら取り込む' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/`n/images/`n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')))
      $lines -contains '/images/' | Should Be $true
      @($lines | Where-Object { $_ -eq '/css/fonts/' }).Count | Should Be 1
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '空のフォルダの新規作成は差分にならず、そのまま進む' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'templates\new'), (Join-Path $root 'sync') | Out-Null
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: CSS に書き換え以外の差分があれば「手作業の変更」として一覧を出し、何も変えない' {
    $root = New-OldLayout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match 'css/510037\.css'
      $msg | Should Not Match '途中で止まった'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: .gitignore に必須でない行(/other/)も足されていれば中止する' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/`n/other/`n", (New-Object Text.UTF8Encoding $false))
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '\.gitignore'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 取り込める変更と取り込めない変更が混ざっていれば、何も変えずに中止する' {
    $root = New-OldLayout
    try {
      Write-Utf8 (Join-Path $root 'css\510037.css') $cssRewritten
      Add-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value 'x'
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match 'templates/T1\.html'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 前回のパッチが途中で止まった形跡(移行コミットの無い assets.migrated-*)があれば、その旨を案内する' {
    $root = New-OldLayout
    try {
      $stamp = Get-Date -Format 'yyyyMMdd'
      Rename-Item -LiteralPath (Join-Path $root 'assets') -NewName "assets.migrated-$stamp"
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '途中で止まった'
      $msg | Should Match 'assets\.migrated-'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡されているフォント・画像・js は確認モードで一覧に出し、-Apply で追跡だけ外す(ファイルは残す)' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts'), (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- assets css/fonts images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'assets/fonts/a\.woff2'
      $out | Should Match 'css/fonts/b\.woff2'
      $out | Should Match 'images/510037_logo\.svg'
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- css/fonts images js assets).Count | Should Be 0
      Test-Path (Join-Path $root 'css\fonts\b.woff2') | Should Be $true
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'images\510037_logo.svg') | Should Be $true
      ((git -C $root show --name-status --format= HEAD) -join "`n") | Should Match 'D\s+assets/fonts/a\.woff2'
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: 点検範囲の外でステージ済みの変更があれば、確認モードでも -Apply でも中止し、何も変えない' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'fonts'), (Join-Path $root 'misc') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'fonts\x.woff2') -Value 'X' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'misc\hand.txt') -Value 'h' -NoNewline
      git -C $root add -- fonts/x.woff2 misc/hand.txt
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match 'fonts/x\.woff2'
      $msg | Should Match 'misc/hand\.txt'
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match 'misc/hand\.txt'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '中止: .gitignore に先頭の空白付きの "  /css/fonts/" を足しただけでは取り込まない(git はその行で無視しない)' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "  /css/fonts/`n", (New-Object Text.UTF8Encoding $false))
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '手作業の変更が残っています'
      $msg | Should Match '\.gitignore'
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '確定済みの .gitignore にあるのが先頭の空白付きの "  /css/fonts/" なら、/css/fonts/ を追記してフォントをコミットに入れない' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "  /css/fonts/`n", (New-Object Text.UTF8Encoding $false))
      git -C $root add -- .gitignore
      git -C $root -c user.name=t -c user.email=t@t commit -q -m ignore
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')) | Where-Object { $_ -ceq '/css/fonts/' }).Count | Should Be 1
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      @(git -C $root ls-files -- css/fonts).Count | Should Be 0
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '手で変更してステージした追跡済みのフォントも、-Apply で追跡だけ外し、作業ツリーのファイルは残す' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B' -NoNewline
      git -C $root add -f -- css/fonts
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      # index を HEAD とも作業ツリーとも違う状態にする(git rm --cached が -f なしでは拒む形)。
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B2' -NoNewline
      git -C $root add -f -- css/fonts/b.woff2
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B3' -NoNewline
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- css/fonts).Count | Should Be 0
      (Get-Content -Raw (Join-Path $root 'css\fonts\b.woff2')) | Should Be 'B3'
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '確定済みの .gitignore にあるのが末尾にタブ付きの "/css/fonts/<TAB>" なら、/css/fonts/ を追記してフォントをコミットに入れない' {
    $root = New-OldLayout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/css/fonts/`t`n", (New-Object Text.UTF8Encoding $false))
      git -C $root add -- .gitignore
      git -C $root -c user.name=t -c user.email=t@t commit -q -m ignore
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')) | Where-Object { $_ -ceq '/css/fonts/' }).Count | Should Be 1
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      @(git -C $root ls-files -- css/fonts).Count | Should Be 0
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '旧例の appconfig(editor の中の置き場・旧い生成器・python.bin)を片付け、置き場は dataRoot 配下で解決する' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    $cfg = Join-Path $ws 'editor\appconfig.json'
    try {
      $original = '{"port":24680,"paths":{"templatesDir":"data/templates","cssDir":"data/css","pendingDir":"data/pending","tmpDir":".tmp","logDir":"logs","webDist":"web/dist"},"python":{"bin":"python","script":"server/scripts/generate_template.py","timeoutMs":30000}}'
      [IO.File]::WriteAllText($cfg, $original, (New-Object Text.UTF8Encoding $false))
      $dry = Invoke-Patch $fake @{ DataRoot = $root; Port = 1 } $cfg *>&1 | Out-String
      $dry | Should Match '旧構成の置き場の設定を外す'
      $dry | Should Match 'paths\.templatesDir'
      $dry | Should Match 'paths\.cssDir'
      $dry | Should Match 'paths\.pendingDir'
      $dry | Should Not Match 'paths\.tmpDir'
      $dry | Should Match 'python\.bin を外します'
      $dry | Should Match 'python\.script を外します'
      $dry | Should Match 'PY_GENERATE_SCRIPT'
      $dry | Should Match 'editor のフォルダに data が残っています'
      $dry | Should Match ([regex]::Escape("cssDir   : $(Join-Path $root 'css')"))
      [IO.File]::ReadAllText($cfg) | Should Be $original
      Invoke-Patch $fake @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      $after = Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json
      @($after.paths.PSObject.Properties.Name) -join ',' | Should Be 'tmpDir,logDir,webDist'
      @($after.python.PSObject.Properties.Name) -join ',' | Should Be 'timeoutMs'
      $after.port | Should Be 24680
      [IO.File]::ReadAllText("$cfg.bak-$(Get-Date -Format 'yyyyMMdd')") | Should Be $original
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(fonts/a\.woff2\)'
      Test-Path (Join-Path $ws 'editor\data\templates') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  $pyCases = @(
    @{ Name = '(python, 無し)'; Python = @{ bin = 'python' }; Left = @() },
    @{ Name = '(py, -3.13)'; Python = @{ bin = 'py'; args = @('-3.13') }; Left = @() },
    @{ Name = '(python, -3.13)'; Python = @{ bin = 'python'; args = @('-3.13') }; Left = @() },
    @{ Name = '(bin 無指定, -3.13)'; Python = @{ args = @('-3.13') }; Left = @() },
    @{ Name = '(絶対パス, 無し)'; Python = @{ bin = 'C:\Python313\python.exe' }; Left = @('bin') },
    @{ Name = '(py, 無し)'; Python = @{ bin = 'py' }; Left = @('bin') },
    @{ Name = '(python, -X utf8)'; Python = @{ bin = 'python'; args = @('-X', 'utf8') }; Left = @('bin', 'args') }
  )
  foreach ($c in $pyCases) {
    It "python.bin / python.args $($c.Name) は $(if ($c.Left.Count -eq 0) { '外す' } else { '残して報告する' })" {
      $root = New-OldLayout
      # 偽の生成器の指定は全件で外れるので、appconfig は必ず書き戻される(配列の書き戻しも確かめられる)。
      $py = @{ timeoutMs = 30000; script = 'server/scripts/fake_generate_template.py' } + $c.Python
      $cfg = New-TempConfig @{ python = $py }
      try {
        $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg *>&1 | Out-String
        $raw = [IO.File]::ReadAllText($cfg)
        $after = $raw | ConvertFrom-Json
        foreach ($k in 'bin', 'args') {
          [bool]$after.python.PSObject.Properties[$k] | Should Be ($c.Left -contains $k)
        }
        $after.python.PSObject.Properties['script'] | Should BeNullOrEmpty
        $raw | Should Not Match '"Count"'
        if ($c.Left.Count -gt 0) { $out | Should Match '【報告】python\.bin=' }
        if ($c.Left -contains 'args') { @($after.python.args) -join ' ' | Should Be '-X utf8' }
      } finally {
        Remove-Item -Recurse -Force $root
        Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
      }
    }
  }

  It 'python.script が共有フォルダの生成器を指していれば触らない(書き戻しもバックアップも作らない)' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ script = '\\fileserver\share\gen\generate_template.py' } }
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      (Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json).python.script | Should Be '\\fileserver\share\gen\generate_template.py'
      @(Get-ChildItem (Split-Path $cfg) -Filter ((Split-Path $cfg -Leaf) + '.bak-*')).Count | Should Be 0
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }

  It 'paths.dataRoot が editor の中を指していれば外す(空になった paths も外す)' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    $cfg = Join-Path $ws 'editor\appconfig.json'
    try {
      [IO.File]::WriteAllText($cfg, '{"paths":{"dataRoot":"data"}}', (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $fake @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      (Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json).PSObject.Properties['paths'] | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  It '環境変数が editor の中を指していれば報告だけする(appconfig は変えない)' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    $cfg = Join-Path $ws 'editor\appconfig.json'
    try {
      $original = '{"port":24680,"paths":{"tmpDir":".tmp"}}'
      [IO.File]::WriteAllText($cfg, $original, (New-Object Text.UTF8Encoding $false))
      $out = Invoke-Patch $fake @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg @{ TEMPLATES_DIR = (Join-Path $ws 'editor\data\templates') } *>&1 | Out-String
      $out | Should Match '環境変数 TEMPLATES_DIR が editor のフォルダの中を指しています'
      [IO.File]::ReadAllText($cfg) | Should Be $original
      @(Get-ChildItem (Split-Path $cfg) -Filter 'appconfig.json.bak-*').Count | Should Be 0
      (git -C $root log -1 --format='%s') | Should Match '\[fonts-to-css\]'
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  It 'ASSETS_DIR が editor の中を指していれば、その場所を改名することを報告に書く' {
    $root = New-OldLayout
    $ws = New-FakeEditor
    $fake = Join-Path $ws 'editor\patches\2026-10-fonts-to-css\migrate.ps1'
    $inside = Join-Path $ws 'editor\data\assets'
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $inside 'fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $inside 'fonts\a.woff2') -Value 'FONT' -NoNewline
      # 長い 1 行を Out-String がコンソール幅で折り返さないよう、幅を広げて受ける。
      $out = Invoke-Patch $fake @{ DataRoot = $root; Port = 1 } $null @{ ASSETS_DIR = $inside } *>&1 | Out-String -Width 4096
      $out | Should Match '環境変数 ASSETS_DIR が editor のフォルダの中を指しています[^\r\n]*assets\.migrated-\d{8} へ改名します'
      Test-Path (Join-Path $inside 'fonts\a.woff2') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root, $ws }
  }

  It 'appconfig の置き場の値がパスとして読めなければ、キーの名前を出して中止する' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ paths = @{ cssDir = 'a|b' } }
    try {
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Port = 1 } $cfg }
      $msg | Should Match 'paths\.cssDir'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }

  It '最上位が配列のメモは、壊れたファイル 1 件として報告する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'notes') | Out-Null
      Write-Utf8 (Join-Path $root 'notes\T2.json') '[{"content":"x"},{"content":"y"}]'
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'T2\.json[^\r\n]*最上位がオブジェクトではありません'
      $out | Should Not Match 'T2\.json[^\r\n]*配列でない値'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '同じ日に流し直しても、最初のバックアップは上書きせず別名で残す' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      $first = [IO.File]::ReadAllText($cfg)
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      [IO.File]::WriteAllText($cfg, '{"python":{"bin":"py","args":["-3.13"]}}', (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd'
      [IO.File]::ReadAllText("$cfg.bak-$stamp") | Should Be $first
      [IO.File]::ReadAllText("$cfg.bak-$stamp-2") | Should Match '"py"'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It '中身の違う同名ファイルは最初の 1 件で止めず、全件を並べてから中止する(確認モードでも)' {
    $root = New-OldLayout
    try {
      Set-Content -LiteralPath (Join-Path $root 'assets\fonts\b.woff2') -Value 'B' -NoNewline
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'X' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'Y' -NoNewline
      $head = git -C $root rev-parse HEAD
      foreach ($p in @(@{ DataRoot = $root; Port = 1 }, @{ DataRoot = $root; Apply = $true; Port = 1 })) {
        $msg = Get-Message { Invoke-Patch $script $p }
        $msg | Should Match '2 件'
        $msg | Should Match 'a\.woff2'
        $msg | Should Match 'b\.woff2'
      }
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '配信されない場所のフォントと assets* を報告する(assets.migrated-* は報告しない)' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'fonts'), (Join-Path $root 'assets_old'), (Join-Path $root 'assets.migrated-20000101') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'fonts\x.woff2') -Value 'X' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'css\y.ttf') -Value 'Y' -NoNewline
      git -C $root add -- css/y.ttf
      git -C $root -c user.name=t -c user.email=t@t commit -q -m ttf
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match ([regex]::Escape((Join-Path $root 'fonts')))
      $out | Should Match 'css\\y\.ttf'
      $out | Should Match 'assets_old'
      $out | Should Not Match 'assets\.migrated-20000101[^\r\n]*配信されません'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'フォントも js も無い assets も改名して残し、フォントと js 以外のものを報告する' {
    $root = New-OldLayout
    try {
      Remove-Item -Recurse -Force (Join-Path $root 'assets\fonts'), (Join-Path $root 'assets\js')
      Set-Content -LiteralPath (Join-Path $root 'assets\readme.txt') -Value 'r' -NoNewline
      $out = Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } *>&1 | Out-String
      $out | Should Match 'readme\.txt'
      $stamp = Get-Date -Format 'yyyyMMdd'
      Test-Path (Join-Path $root 'assets') | Should Be $false
      Test-Path (Join-Path $root "assets.migrated-$stamp\readme.txt") | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '同じ日の assets.migrated-<日付> が既にあれば、改名せずに中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root ("assets.migrated-" + (Get-Date -Format 'yyyyMMdd'))) | Out-Null
      $msg = Get-Message { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } }
      $msg | Should Match '同じ日の退避'
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '旧い形式のデータ(配列でないメモ・held の申請・filled の無いこと)を報告する' {
    $root = New-OldLayout
    try {
      Remove-Item -Recurse -Force (Join-Path $root 'filled')
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'notes') | Out-Null
      Write-Utf8 (Join-Path $root 'notes\T1.json') '{"k":{"content":"x"},"k2":[]}'
      Write-Utf8 (Join-Path $root 'reviews\r1\meta.json') '{"status":"held"}'
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match 'T1\.json[^\r\n]*配列でない値 1 件'
      $out | Should Match 'meta\.json[^\r\n]*held'
      $out | Should Match 'filled フォルダがありません'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は assets.migrated-* が無い環境(appconfig の片付けだけが動いた)でも止まらず、revert と appconfig の復元を行う' {
    $root = Join-Path $env:TEMP ('fonts-mig-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      foreach ($d in 'css\fonts', 'templates') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'FONT' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '@font-face{src:url(../fonts/a.woff2)}' -NoNewline
      [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/css/fonts/`n", (New-Object Text.UTF8Encoding $false))
      git -C $root init -q
      git -C $root add -- .gitignore css
      git -C $root -c user.name=t -c user.email=t@t commit -q -m init
      $original = [IO.File]::ReadAllText($cfg)
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(fonts/a\.woff2\)'
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
      [IO.File]::ReadAllText($cfg) | Should Be $original
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'rollback は移行後に assets.migrated-* を手で消していても、revert と appconfig の復元を行う' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      $original = [IO.File]::ReadAllText($cfg)
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      Get-ChildItem $root -Directory -Filter 'assets.migrated-*' | Remove-Item -Recurse -Force
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
      [IO.File]::ReadAllText($cfg) | Should Be $original
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'rollback は戻す日付の候補が複数あれば -Date を求め、-Date を付ければ戻す' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      Copy-Item -LiteralPath $cfg -Destination "$cfg.bak-20000101"
      $msg = Get-Message { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root } $cfg }
      $msg | Should Match '-Date'
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true; Date = (Get-Date -Format 'yyyyMMdd') } $cfg | Out-Null
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It '追跡されたフォント・js・画像を -Apply で外したあとでも、rollback -Apply が通り、追跡と assets が戻る' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts'), (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\b.woff2') -Value 'B' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- assets css/fonts images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } | Out-Null
      $tracked = (@(git -C $root ls-files -- assets css/fonts images) | Sort-Object) -join ','
      $tracked | Should Be 'assets/fonts/a.woff2,assets/js/w.js,css/fonts/b.woff2,images/510037_logo.svg'
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'assets\js\w.js') | Should Be $true
      @(Get-ChildItem $root -Directory -Filter 'assets.migrated-*').Count | Should Be 0
      @(Get-ChildItem $root -Directory -Force -Filter '.rollback-tmp-*').Count | Should Be 0
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $false
      Test-Path (Join-Path $root 'js\w.js') | Should Be $false
      Test-Path (Join-Path $root 'css\fonts\b.woff2') | Should Be $true
      (git -C $root status --porcelain -- assets css images) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '追跡を外した後に中身を変えたファイルは、rollback で退避を残して報告する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg>new</svg>' -NoNewline
      $out = Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } *>&1 | Out-String
      $stamp = Get-Date -Format 'yyyyMMdd'
      Get-Content -Raw (Join-Path $root ".rollback-tmp-$stamp\images\510037_logo.svg") | Should Be '<svg>new</svg>'
      Get-Content -Raw (Join-Path $root 'images\510037_logo.svg') | Should Be '<svg/>'
      $out | Should Match '退避に残しました'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は同じ日の退避に同じパスのファイルが既にあれば、何も変えずに中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      git -C $root add -f -- images
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd'
      $old = Join-Path $root ".rollback-tmp-$stamp\images\510037_logo.svg"
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $old) | Out-Null
      Set-Content -LiteralPath $old -Value 'OLD' -NoNewline
      $head = git -C $root rev-parse HEAD
      $msg = Get-Message { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } }
      $msg | Should Match '同じ日の退避'
      Get-Content -Raw $old | Should Be 'OLD'
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root "assets.migrated-$stamp") | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback の 2 回目(移行コミットが revert 済み)は、appconfig と作業コピーを戻さない' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ python = @{ bin = 'python' } }
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } $cfg | Out-Null
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      [IO.File]::WriteAllText($cfg, '{"port":1}', (New-Object Text.UTF8Encoding $false))
      Set-Content -LiteralPath (Join-Path $root 'drafts\T1.css') -Value 'edited' -NoNewline
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $cfg | Out-Null
      [IO.File]::ReadAllText($cfg) | Should Be '{"port":1}'
      Get-Content -Raw (Join-Path $root 'drafts\T1.css') | Should Be 'edited'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg, "$cfg.bak-*"
    }
  }

  It 'rollback も -DataRoot の相対パスを今の場所を基準に解決する' {
    $root = New-OldLayout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Push-Location (Split-Path -Parent $root)
      try { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = (Split-Path -Leaf $root); Apply = $true } | Out-Null }
      finally { Pop-Location }
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback は revert で追跡に戻った css\fonts・js のファイルを、assets と同じ内容でも消さない' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts'), (Join-Path $root 'js') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'FONT' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
      git -C $root add -f -- css/fonts js
      git -C $root -c user.name=t -c user.email=t@t commit -q -m tracked
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      @(git -C $root ls-files -- css/fonts js).Count | Should Be 0
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } | Out-Null
      Test-Path (Join-Path $root 'css\fonts\a.woff2') | Should Be $true
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
      (git -C $root status --porcelain -- css js) | Should BeNullOrEmpty
      Test-Path (Join-Path $root 'assets\fonts\a.woff2') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'rollback も appconfig の置き場の値がパスとして読めなければ、キーの名前を出して中止する' {
    $root = New-OldLayout
    $cfg = New-TempConfig @{ paths = @{ cssDir = 'a|b' } }
    try {
      $msg = Get-Message { Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root } $cfg }
      $msg | Should Match 'paths\.cssDir'
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force -ErrorAction SilentlyContinue $cfg
    }
  }

  It 'rollback も PATH に git が無ければ GIT_BIN の git を使う' {
    $root = New-OldLayout
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Patch (Join-Path $here 'rollback.ps1') @{ DataRoot = $root; Apply = $true } $null @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }
}
