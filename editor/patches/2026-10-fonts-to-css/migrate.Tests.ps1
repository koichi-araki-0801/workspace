# migrate.ps1 の Pester 3/4 テスト。旧構成の dataRoot を一時フォルダに作り、確認モード・適用・
# 再実行・競合・未コミット変更での中止を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'migrate.ps1'

# 実データへ触れないよう、置き場に効く環境変数を退避して空にし、APP_CONFIG を一時ファイル(既定は
# 存在しないパス)へ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$appConfig) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'CSS_DIR', 'ASSETS_DIR', 'DRAFTS_DIR', 'PENDING_DIR', 'REVIEWS_DIR'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  if (-not $appConfig) { $appConfig = Join-Path $env:TEMP 'fonts-mig-no-appconfig.json' }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', $appConfig)
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

  It '未コミットの変更があれば中止する' {
    $root = New-OldLayout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } } | Should Throw
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

  It '未コミット変更で中止するときは途中停止の可能性を案内する' {
    $root = New-OldLayout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $msg = ''
      try { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null } catch { $msg = $_.Exception.Message }
      $msg | Should Match '前回の移行が途中で止まった'
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
}
