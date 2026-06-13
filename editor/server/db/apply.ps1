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
#  管理ユーザー seed は事前に生成しておく(平文を SQL に残さないため):
#    corepack pnpm --filter server exec tsx scripts/hash-password.ts <id> <pw> <表示名> admin
# =============================================================================
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Database = 'usrap'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path  # server/db

function Invoke-SqlFile([System.IO.FileInfo]$file) {
  Write-Host "[apply] $($file.Directory.Name)/$($file.Name)"
  & sqlcmd -S $Server -d $Database -E -b -f 65001 -i $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $($file.Name)" }
}

foreach ($dir in @('ddl', 'sproc', 'seed')) {
  $p = Join-Path $root $dir
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Filter *.sql | Sort-Object Name | ForEach-Object { Invoke-SqlFile $_ }
  }
}
Write-Host "[apply] done. ($Server / $Database)"
