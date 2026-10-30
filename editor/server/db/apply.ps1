# =============================================================================
#  editor フェーズ2 — DB 適用スクリプト (Windows / sqlcmd)
#
#  ddl/ -> sproc/ -> seed/ の順に *.sql を番号/名前順で適用する。
#  Windows 統合認証(-E)、UTF-8 入力(-f 65001)、エラーで停止(-b)。
#  日本語識別子のため各 .sql は UTF-8 BOM 保存であること。
#
#  使い方:
#    powershell -ExecutionPolicy Bypass -File server\db\apply.ps1 -Server <host\instance>
#    (省略時 Database=usrap)
#
#  本番では -SkipSeed を付けて seed/ を流さない。seed は開発・検証用の値(共通サンプルの開発値・
#  検証用のパーツ・管理ユーザー)で、本番に入れると共通サンプルの行が開発値で埋まり、後で流す
#  migrate/ の登録が「登録済み」として飛ばしてしまう。
#
#  管理ユーザー seed は事前に生成しておく(平文を SQL に残さないため):
#    corepack pnpm --filter server exec tsx scripts/hash-password.ts <id> <pw> <表示名> admin
#  seed/管理ユーザー.sql はリポジトリに置かない(git は無視する)。以前はパスワードが admin の
#  ハッシュを追跡しており、生成せずに流すと既知のパスワードの管理者ができた。seed を流すときに
#  このファイルが無ければ、何も流す前に止める。
# =============================================================================
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Database = 'usrap',
  [switch]$SkipSeed
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path  # server/db

function Invoke-SqlFile([System.IO.FileInfo]$file) {
  Write-Host "[apply] $($file.Directory.Name)/$($file.Name)"
  & sqlcmd -S $Server -d $Database -E -b -f 65001 -i $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $($file.Name)" }
}

if (-not $SkipSeed -and -not (Test-Path -LiteralPath (Join-Path $root 'seed\管理ユーザー.sql'))) {
  throw '管理ユーザーの seed がありません。先に hash-password.ts で作ってください(手順は server\db\README.md)。seed を流さないなら -SkipSeed を付けてください。'
}

$dirs = if ($SkipSeed) { @('ddl', 'sproc') } else { @('ddl', 'sproc', 'seed') }
foreach ($dir in $dirs) {
  $p = Join-Path $root $dir
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Filter *.sql | Sort-Object Name | ForEach-Object { Invoke-SqlFile $_ }
  }
}
Write-Host "[apply] done. ($Server / $Database)"
