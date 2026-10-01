# apply.ps1 / rollback.ps1 の Pester 3/4 テスト。①の移行済みの dataRoot を一時フォルダに作り、
# 確認モード・適用・再実行・.gitignore だけの未コミット・中止条件・点検の報告・rollback を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'apply.ps1'
$roll = Join-Path $here 'rollback.ps1'

# 実データへ触れないよう、置き場に効く環境変数を退避して空にし、APP_CONFIG を存在しない
# パスへ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$imagesDir) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'IMAGES_DIR'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', (Join-Path $env:TEMP 'fund-img-no-appconfig.json'))
  if ($imagesDir) { [Environment]::SetEnvironmentVariable('IMAGES_DIR', $imagesDir) }
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
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } } | Should Throw
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
}
