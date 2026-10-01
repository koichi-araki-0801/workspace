# migrate.ps1 の Pester 3/4 テスト。旧構成の dataRoot を一時フォルダに作り、確認モード・適用・
# 再実行・競合・未コミット変更での中止を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'migrate.ps1'

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
      & $script -DataRoot $root -Port 1 | Out-Null
      Test-Path (Join-Path $root 'css\fonts') | Should Be $false
      (Get-Content -Raw (Join-Path $root 'css\510037.css')) | Should Match 'url\(\.\./fonts/a\.woff2\)'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '-Apply で移動・書き換え・コミットし、HTML は報告だけ' {
    $root = New-OldLayout
    try {
      $out = & $script -DataRoot $root -Apply -Port 1 *>&1 | Out-String
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
      & $script -DataRoot $root -Apply -Port 1 | Out-Null
      $head = git -C $root rev-parse HEAD
      & $script -DataRoot $root -Apply -Port 1 | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '移動先に別内容があれば競合で中止する' {
    $root = New-OldLayout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'css\fonts') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'OTHER' -NoNewline
      { & $script -DataRoot $root -Apply -Port 1 } | Should Throw
      Test-Path (Join-Path $root 'assets') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '未コミットの変更があれば中止する' {
    $root = New-OldLayout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      { & $script -DataRoot $root -Apply -Port 1 } | Should Throw
    } finally { Remove-Item -Recurse -Force $root }
  }
}
