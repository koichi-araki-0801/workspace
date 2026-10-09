<#
.SYNOPSIS
  pie-chart の配布物(dist-exe)を配る前に検査する関所。
.DESCRIPTION
  次の 4 点を検査し、1 つでも満たさなければ非ゼロ終了する。

    1. dist-exe の中身が想定どおりであること。未署名なら pie-chart.exe / OFL-BIZUDPGothic.txt の
       2 点、署名ありなら加えて *.cer / SIGNING-INFO.txt の 4 点。それ以外のファイルもディレクトリも
       許さない。これは **sidecar が復活していないことの機械検査**である。exe の隣に fonts\ や
       node_modules\ が居ると、exe の外にある書き換え可能なファイルを実行時に読む経路が戻ってしまう。
    2. 署名の状態。pie-chart-codesign.cer があれば署名ありとみなし、Authenticode 署名が付いていて
       署名者の thumbprint が期待値と一致すること(自己署名では検査端末のストア次第で Status が
       Valid / UnknownError のどちらにもなるので、この 2 値のみを許す)。.cer が無ければ未署名と
       みなし、Status が NotSigned であること(壊れた署名 HashMismatch が残っていないこと)。
    3. exe が実際に描画でき、出力 SVG が開発版(tsx)の出力と byte 一致すること。
       フォントも harfbuzz wasm も exe に埋め込んでいるので、外部に何も置かない状態で
       同じバイト列が出るのが正しい状態である。フルフォントへ静かに落ちていれば
       ここで差分になる。
    4. pie-chart.exe db-check が成功し、実行ごとのフォルダ(%TEMP%\pie-chart-db\...)が残らないこと。
       DB 機能を外した exe(--no-db)を誤って配るのを防ぐ。
.PARAMETER DistDir
  検査する配布ディレクトリ。既定は本スクリプトの 1 つ上の dist-exe。
.PARAMETER Thumbprint
  期待する署名者 thumbprint。未指定なら scripts\signing.local.json または
  環境変数 PIECHART_SIGN_THUMBPRINT を見る。署名ありの配布物を検査するときだけ使う。
.PARAMETER Sample
  出力比較に使う組み込みサンプル名。既定 asset_gbca_pdf_like。
.PARAMETER SkipRender
  検査 3(描画の byte 比較)を飛ばす。開発版の実行環境が無い端末向け。
.NOTES
  日本語を含むため UTF-8 BOM 必須(cp932 環境での文字化け回避)。
  隠しファイルとリパースポイント(ジャンクション/シンボリックリンク)も検査対象に含めるため
  Get-ChildItem に -Force -Recurse を付けている。
#>
param(
  [string]$DistDir,
  [string]$Thumbprint,
  [string]$Sample = 'asset_gbca_pdf_like',
  [switch]$SkipRender
)
$ErrorActionPreference = 'Stop'
# exe は UTF-8 で書く。既定の cp932 で読むと db-check の「—」などが化け、出力の照合が外れる。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
if (-not $DistDir) { $DistDir = Join-Path $root 'dist-exe' }
if (-not (Test-Path -LiteralPath $DistDir)) {
  Write-Error "[verify-dist] 配布ディレクトリがありません: $DistDir"
  exit 1
}

$failed = 0
function Fail([string]$msg) {
  Write-Host "[verify-dist] NG: $msg"
  $script:failed = 1
}

# ── 1. 配布物の閉包検査(sidecar が復活していないこと) ──
$signed = Test-Path -LiteralPath (Join-Path $DistDir 'pie-chart-codesign.cer')
$allowed = @('pie-chart.exe', 'OFL-BIZUDPGothic.txt')
if ($signed) { $allowed += @('pie-chart-codesign.cer', 'SIGNING-INFO.txt') }
$entries = Get-ChildItem -LiteralPath $DistDir -Force -Recurse
foreach ($e in $entries) {
  if ($e.PSIsContainer) {
    Fail "配布物にディレクトリがあります: $($e.FullName)"
    continue
  }
  if ($allowed -notcontains $e.Name) {
    Fail "配布物に想定外のファイルがあります: $($e.FullName)"
  }
}
$exePath = Join-Path $DistDir 'pie-chart.exe'
if (-not (Test-Path -LiteralPath $exePath)) { Fail "pie-chart.exe がありません: $exePath" }
if ($failed -eq 0) { Write-Host '[verify-dist] OK: 配布物は想定どおり(sidecar 無し)' }

# ── 2. 署名の検査 ──
if (Test-Path -LiteralPath $exePath) {
  $sig = Get-AuthenticodeSignature -FilePath $exePath
  if ($signed) {
    if (-not $Thumbprint) { $Thumbprint = $env:PIECHART_SIGN_THUMBPRINT }
    if (-not $Thumbprint) {
      $local = Join-Path $PSScriptRoot 'signing.local.json'
      if (Test-Path -LiteralPath $local) {
        $Thumbprint = (Get-Content -LiteralPath $local -Raw | ConvertFrom-Json).thumbprint
      }
    }
    $okStatuses = @('Valid', 'UnknownError')
    if ($okStatuses -notcontains $sig.Status.ToString()) {
      Fail "署名の状態が不正です: Status=$($sig.Status)"
    } elseif (-not $Thumbprint) {
      Fail '期待する thumbprint が不明です(scripts\signing.local.json か -Thumbprint で指定)'
    } else {
      $expected = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
      if ($sig.SignerCertificate.Thumbprint -ne $expected) {
        Fail "署名者が一致しません: $($sig.SignerCertificate.Thumbprint) != $expected"
      } else {
        Write-Host "[verify-dist] OK: 署名 $($sig.Status) / thumbprint $expected"
      }
    }
  } elseif ($sig.Status.ToString() -ne 'NotSigned') {
    Fail "未署名の配布物のはずが、署名の状態が NotSigned ではありません: Status=$($sig.Status)"
  } else {
    Write-Host '[verify-dist] OK: 未署名(NotSigned)'
  }
}

# ── 3. 出力の byte 一致(exe 単体で開発版と同じ SVG が出ること) ──
if (-not $SkipRender -and (Test-Path -LiteralPath $exePath)) {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("piechart-verify-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # exe は配布ディレクトリから切り離して実行する。fonts\ も node_modules\ も無い場所で
    # 同じ出力が出ることが「実行に要るものはすべて exe の中」の証明になる。
    $isolatedExe = Join-Path $tmp 'pie-chart.exe'
    Copy-Item -LiteralPath $exePath -Destination $isolatedExe
    $exeSvg = Join-Path $tmp 'exe.svg'
    $devSvg = Join-Path $tmp 'dev.svg'
    & $isolatedExe one --sample $Sample --output-file $exeSvg | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "exe の描画が失敗しました (exit $LASTEXITCODE)" }
    Push-Location $root
    try {
      pnpm exec tsx src/cli.ts one --sample $Sample --output-file $devSvg | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "開発版の描画が失敗しました (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    if ((Test-Path $exeSvg) -and (Test-Path $devSvg)) {
      $a = (Get-FileHash -LiteralPath $exeSvg -Algorithm SHA256).Hash
      $b = (Get-FileHash -LiteralPath $devSvg -Algorithm SHA256).Hash
      if ($a -ne $b) {
        Fail "exe と開発版の出力が一致しません ($a != $b)。フォント埋込が効いていない可能性。"
      } else {
        Write-Host "[verify-dist] OK: 出力 byte 一致 (sha256 $a)"
      }
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ── 4. DB ドライバを読み込めること(DB 機能を外した exe を配らない) ──
if (Test-Path -LiteralPath $exePath) {
  # 'Stop' のままだと、PowerShell 5.1 は native exe の stderr の行(警告など)を 2>&1 で
  # 受けた時点で終了エラーにする。ここだけ 'Continue' にして終了コードで判定する。
  $prevPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exePath db-check 2>&1 | Out-String
    $dbCheckExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPreference
  }
  if ($dbCheckExit -ne 0) {
    Fail "db-check が失敗しました (exit $dbCheckExit)`n$out"
  } else {
    $m = [regex]::Match($out, '\[db-check\] extract: OK — (.+)')
    if (-not $m.Success) {
      Fail "db-check の出力に実行ごとのフォルダがありません`n$out"
    } elseif (Test-Path -LiteralPath $m.Groups[1].Value.Trim()) {
      Fail "実行ごとのフォルダが残っています: $($m.Groups[1].Value.Trim())"
    } else {
      Write-Host '[verify-dist] OK: DB ドライバを読み込め、フォルダも残っていない'
    }
  }
}

if ($failed -ne 0) {
  Write-Host '[verify-dist] 検査に失敗しました。この配布物は配らないでください。'
  exit 1
}
Write-Host '[verify-dist] すべての検査に合格しました。'
