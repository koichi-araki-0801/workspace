# apply.ps1 の Pester 3/4 テスト。apply.ps1 を一時フォルダへ写し、空の ddl・sproc と、管理ユーザーの
# seed がある・無い seed フォルダを置いて実行する。sqlcmd はテストの中の関数で影にし、DB へは
# つながない。流したファイルは $global:applied に積む(sqlcmd の関数と It の中の両方から見える置き場)。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'apply.ps1'

function sqlcmd {
  $i = [array]::IndexOf($args, '-i')
  $global:applied += , (Split-Path -Leaf $args[$i + 1])
  $global:LASTEXITCODE = 0
}

function New-DbRoot([bool]$withAdminSeed) {
  $root = Join-Path $env:TEMP ('apply-db-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  foreach ($d in 'ddl', 'sproc', 'seed') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
  Copy-Item -LiteralPath $source -Destination (Join-Path $root 'apply.ps1')
  Set-Content -LiteralPath (Join-Path $root 'ddl\01_t.sql') -Value 'SELECT 1' -NoNewline
  Set-Content -LiteralPath (Join-Path $root 'seed\パーツカタログ.sql') -Value 'SELECT 1' -NoNewline
  if ($withAdminSeed) {
    Set-Content -LiteralPath (Join-Path $root 'seed\管理ユーザー.sql') -Value 'SELECT 1' -NoNewline
  }
  $root
}

Describe 'apply.ps1 の管理ユーザー seed の検査' {
  It 'seed を流すのに管理ユーザー.sql が無ければ、何も流さずに止まる' {
    $root = New-DbRoot $false
    try {
      $global:applied = @()
      { & (Join-Path $root 'apply.ps1') -Server 'dummy' } | Should Throw '管理ユーザーの seed がありません'
      $global:applied.Count | Should Be 0
    } finally { Remove-Item -LiteralPath $root -Recurse -Force }
  }

  It '-SkipSeed なら管理ユーザー.sql が無くても ddl・sproc を流す' {
    $root = New-DbRoot $false
    try {
      $global:applied = @()
      & (Join-Path $root 'apply.ps1') -Server 'dummy' -SkipSeed | Out-Null
      ($global:applied -join ',') | Should Be '01_t.sql'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force }
  }

  It '管理ユーザー.sql があれば seed まで流す' {
    $root = New-DbRoot $true
    try {
      $global:applied = @()
      & (Join-Path $root 'apply.ps1') -Server 'dummy' | Out-Null
      ($global:applied -join ',') | Should Be '01_t.sql,パーツカタログ.sql,管理ユーザー.sql'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force }
  }
}
