# init-data-repo.ps1 の Pester 3/4 テスト。手で作り直した dataRoot(assets・js・images・notes・
# css\fonts が残っている)を一時フォルダに作り、初回コミットが確定領域だけになること、
# HEAD の無い .git へ初回コミットを足すこと、履歴があれば git に触らないこと、GIT_BIN を使うことを
# 確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'init-data-repo.ps1'

# 実データへ触れないよう DATA_ROOT と GIT_BIN を退避して空にし、-DataRoot は呼び出し側が必ず渡す。
# $extraEnv のキーは $names のどれか(終わったら元へ戻す)。
function Invoke-Init([hashtable]$params, [hashtable]$extraEnv) {
  $names = 'DATA_ROOT', 'GIT_BIN'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  if ($extraEnv) { foreach ($k in $extraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $extraEnv[$k]) } }
  try { & $script @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}

function New-Root { Join-Path $env:TEMP ('init-data-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }

function New-HandMadeContent([string]$root) {
  foreach ($d in 'templates', 'css\fonts', 'assets\fonts', 'js', 'images', 'notes') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<p>t</p>' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '.a{}' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'css\fonts\a.woff2') -Value 'FONT' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'assets\fonts\b.woff2') -Value 'OLD' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'js\w.js') -Value 'w()' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'notes\T1.json') -Value '{}' -NoNewline
}

function Get-Tracked([string]$root) { (@(git -C $root ls-files) | Sort-Object) -join ',' }

$expectedTracked = '.gitattributes,.gitignore,css/510037.css,templates/T1.html'

Describe 'init-data-repo.ps1' {
  It '新規の dataRoot では置き場をすべて作り、確定領域だけを初回コミットに入れる' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      Invoke-Init @{ DataRoot = $root } | Out-Null
      foreach ($d in 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes', 'js', 'images') {
        Test-Path (Join-Path $root $d) | Should Be $true
      }
      Get-Tracked $root | Should Be $expectedTracked
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (Get-Content (Join-Path $root '.gitattributes')) -contains '* text eol=lf' | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '.git はあるが履歴(HEAD)が無ければ、確定領域だけで初回コミットを作る' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      Get-Tracked $root | Should Be $expectedTracked
      @(git -C $root rev-list HEAD).Count | Should Be 1
      (git -C $root log -1 --format='%an') | Should Be 'system'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴の無いリポジトリの index に確定領域の外が載っていても、初回コミットは確定領域だけになり作業ツリーは残る' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      git -C $root init -q
      git -C $root add -A 2>$null
      Invoke-Init @{ DataRoot = $root } | Out-Null
      Get-Tracked $root | Should Be $expectedTracked
      foreach ($f in 'assets\fonts\b.woff2', 'js\w.js', 'css\fonts\a.woff2', 'images\510037_logo.svg', 'notes\T1.json') {
        Test-Path (Join-Path $root $f) | Should Be $true
      }
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既存の .gitignore ごと手で git add -A 済みの履歴の無いリポジトリでも、確定領域だけで初回コミットを作る' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/local-only/`n", (New-Object Text.UTF8Encoding $false))
      git -C $root init -q
      git -C $root add -A 2>$null
      Invoke-Init @{ DataRoot = $root } | Out-Null
      Get-Tracked $root | Should Be $expectedTracked
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')))
      $lines -contains '/local-only/' | Should Be $true
      $lines -contains '/css/fonts/' | Should Be $true
      ((git -C $root show HEAD:.gitignore) -join '|') | Should Be ($lines -join '|')
      foreach ($f in 'assets\fonts\b.woff2', 'js\w.js', 'css\fonts\a.woff2', 'images\510037_logo.svg', 'notes\T1.json') {
        Test-Path (Join-Path $root $f) | Should Be $true
      }
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'git add -A のあとテンプレを手で変えた履歴の無いリポジトリでも、作業ツリーの内容で初回コミットを作る' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      git -C $root init -q
      git -C $root add -A 2>$null
      Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<p>changed</p>' -NoNewline
      Invoke-Init @{ DataRoot = $root } | Out-Null
      Get-Tracked $root | Should Be $expectedTracked
      (git -C $root show HEAD:templates/T1.html) | Should Be '<p>changed</p>'
      Test-Path (Join-Path $root 'js\w.js') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'git が HEAD の確認で失敗したら(dubious ownership 等)、.gitignore と .gitattributes を書かずに止まる' {
    $root = New-Root
    $fake = Join-Path $env:TEMP ('init-data-fakegit-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cmd')
    try {
      New-HandMadeContent $root
      New-Item -ItemType Directory -Force -Path (Join-Path $root '.git') | Out-Null
      [IO.File]::WriteAllText($fake, "@echo fatal: detected dubious ownership in repository 1>&2`r`n@exit /b 128`r`n")
      $thrown = $null
      try { Invoke-Init @{ DataRoot = $root } @{ GIT_BIN = $fake } | Out-Null } catch { $thrown = $_.Exception.Message }
      $thrown | Should Match 'dubious ownership'
      Test-Path (Join-Path $root '.gitignore') | Should Be $false
      Test-Path (Join-Path $root '.gitattributes') | Should Be $false
    } finally {
      Remove-Item -Recurse -Force $root
      Remove-Item -Force $fake -ErrorAction SilentlyContinue
    }
  }

  It '既存の CRLF の .gitignore は、重複を除いて LF・BOM 無しで書き直す' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/local-only/`r`n/notes/`r`n/local-only/`r`n", (New-Object Text.UTF8Encoding $true))
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      $bytes = [IO.File]::ReadAllBytes((Join-Path $root '.gitignore'))
      @($bytes | Where-Object { $_ -eq 13 }).Count | Should Be 0
      ($bytes[0..2] -join ',') | Should Not Be '239,187,191'
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')))
      $lines -join '|' | Should Be '/local-only/|/notes/|/drafts/|/reviews/|/pending/|/css/fonts/|/images/|*.tmp-*'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴の無いリポジトリの既存の .gitignore は消さず、足りない必須行だけを足す' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      [IO.File]::WriteAllText((Join-Path $root '.gitignore'), "/local-only/`n/notes/`n", (New-Object Text.UTF8Encoding $false))
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      $lines = @([IO.File]::ReadAllLines((Join-Path $root '.gitignore')))
      $lines -contains '/local-only/' | Should Be $true
      $lines -contains '/css/fonts/' | Should Be $true
      $lines -contains '/images/' | Should Be $true
      @($lines | Where-Object { $_ -eq '/notes/' }).Count | Should Be 1
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴の無いリポジトリの BOM 付き * text=lf は、* text eol=lf に揃えて初回コミットに入れる(他の行は残す)' {
    $root = New-Root
    try {
      New-HandMadeContent $root
      $bytes = [byte[]](@(0xEF, 0xBB, 0xBF) + [Text.Encoding]::ASCII.GetBytes("* text=lf`r`n*.png binary`r`n"))
      [IO.File]::WriteAllBytes((Join-Path $root '.gitattributes'), $bytes)
      git -C $root init -q
      Invoke-Init @{ DataRoot = $root } | Out-Null
      ((git -C $root show HEAD:.gitattributes) -join '|') | Should Be '* text eol=lf|*.png binary'
      (Get-Content -Encoding Byte -TotalCount 3 (Join-Path $root '.gitattributes')) -join ',' | Should Not Be '239,187,191'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '履歴があれば git に触らず、足りないフォルダだけを作る' {
    $root = New-Root
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'templates') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<p>t</p>' -NoNewline
      git -C $root init -q
      git -C $root add -- templates
      git -C $root -c user.name=t -c user.email=t@t commit -q -m init
      $head = git -C $root rev-parse HEAD
      Invoke-Init @{ DataRoot = $root } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root 'images') | Should Be $true
      Test-Path (Join-Path $root '.gitignore') | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'PATH に git が無くても GIT_BIN の git で初期化できる' {
    $root = New-Root
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      New-HandMadeContent $root
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Init @{ DataRoot = $root } @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      @(git -C $root rev-list HEAD).Count | Should Be 1
      Get-Tracked $root | Should Be $expectedTracked
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }

  It 'PATH に git が無くても、履歴のあるリポジトリは GIT_BIN の git で確かめて触らない' {
    $root = New-Root
    $gitPath = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    $savedPath = $env:PATH
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'templates') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'templates\T1.html') -Value '<p>t</p>' -NoNewline
      git -C $root init -q
      git -C $root add -- templates
      git -C $root -c user.name=t -c user.email=t@t commit -q -m init
      $head = git -C $root rev-parse HEAD
      $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
      Invoke-Init @{ DataRoot = $root } @{ GIT_BIN = $gitPath } | Out-Null
      $env:PATH = $savedPath
      git -C $root rev-parse HEAD | Should Be $head
      Test-Path (Join-Path $root '.gitignore') | Should Be $false
    } finally {
      $env:PATH = $savedPath
      Remove-Item -Recurse -Force $root
    }
  }
}
