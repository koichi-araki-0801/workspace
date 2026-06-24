# 共通ライブラリ: Python exe ビルド用の隔離 venv 準備。
# pdf-to-svg / graph-editor の scripts/build.ps1 から dot-source して使う
# (両者でほぼ同一だった venv 作成〜wheel install ロジックを 1 か所へ集約)。
# 日本語コメントを含むため UTF-8 BOM 必須(cp932 環境で文字化けさせない)。
#
# 単体起動しない dot-source 専用ライブラリのため `.bat` ランチャは併設しない
# (正典 `offline/lib/content-key.ps1` と同方針。`scripts/check-comments.mjs` の
# BAT_PAIRING_EXCEPTIONS に登録済み)。

# Python ランチャを解決する。`py -3`(Windows ランチャ)を優先し、無ければ `python`。
# 双方とも起動しなければ呼び出し側でビルドを中断させる(返り値 $null)。
# Exe と BaseArgs を分けて返すのは、`py -3` のように引数付きランチャを後段の
# `& $exe @baseArgs -m venv ...` で splat 展開して呼ぶため。
function Resolve-PythonLauncher {
  foreach ($cand in @(
      @{ Exe = 'py'; BaseArgs = @('-3') },
      @{ Exe = 'python'; BaseArgs = @() })) {
    try {
      & $cand.Exe @($cand.BaseArgs) --version *> $null
      if ($LASTEXITCODE -eq 0) { return $cand }
    }
    catch {
      # コマンド未検出(CommandNotFoundException)等は次の候補へフォールバックする。
    }
  }
  return $null
}

# ビルド専用の隔離 venv(.venv-build)を用意し、依存を install して venv の python.exe を返す。
#   $ProjectDir       … プロジェクトのルート(.venv-build と requirements の基準)。
#   $RequirementsPath … pip に渡す requirements.txt の絶対パス。
#   $WheelhouseDir    … オフライン wheel 置き場。存在すれば --no-index でここから install。
#   -Clean            … 既存 venv を作り直す(旧 build.bat の `clean` 引数に対応)。
#
# 端末のグローバル Python には無関係なライブラリが多数入っており、そのままビルドすると
# PyInstaller が拾って exe に余計な依存が混入する。専用 venv は既定でシステムの
# site-packages を参照しないため、必要な依存だけのクリーンな環境でビルドでき肥大化を防ぐ。
function Initialize-BuildVenv {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectDir,
    [Parameter(Mandatory = $true)][string]$RequirementsPath,
    [string]$WheelhouseDir,
    [switch]$Clean
  )

  $launcher = Resolve-PythonLauncher
  if ($null -eq $launcher) {
    throw 'Python が見つかりません。Python を導入し PATH を通して再実行してください。'
  }

  $venv = Join-Path $ProjectDir '.venv-build'
  $vpy = Join-Path $venv 'Scripts\python.exe'

  if ($Clean -and (Test-Path -LiteralPath $venv)) {
    Write-Host '[setup] ビルド venv を作り直します (clean)...'
    Remove-Item -Recurse -Force -LiteralPath $venv
  }

  # 既存 venv の健全性チェック。python.exe が無い/実際に起動しない場合は壊れているとみなす。
  # (存在チェックだけだと不完全/破損 venv の上に `python -m venv` を実行して失敗するため)
  $venvOk = $false
  if (Test-Path -LiteralPath $vpy) {
    & $vpy --version *> $null
    if ($LASTEXITCODE -eq 0) { $venvOk = $true }
  }
  if (-not $venvOk) {
    if (Test-Path -LiteralPath $venv) {
      Write-Host '[setup] 既存ビルド venv が不完全なため作り直します...'
      Remove-Item -Recurse -Force -LiteralPath $venv
    }
    Write-Host '[setup] 隔離ビルド venv (.venv-build) を作成中...'
    & $launcher.Exe @($launcher.BaseArgs) -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'ビルド venv の作成に失敗しました。' }
  }

  # 依存インストール(オフライン優先: 同梱 wheelhouse から毎回 install)。
  # wheelhouse があればネット不要でそこから入れる。無ければ通常 pip install へフォールバック。
  Write-Host '============================================'
  Write-Host ' [1/2] 依存ライブラリをインストール (隔離 venv 内)'
  Write-Host '============================================'
  # pip の標準出力は `Out-Host` で画面へ逃がす。素のままだと success ストリームに乗り、
  # 関数戻り値($vpy)へ連結されて呼び出し側の `& $vpy ...` が壊れる(pip 行をコマンド名と誤認)。
  if ($WheelhouseDir -and (Test-Path -LiteralPath $WheelhouseDir)) {
    Write-Host "[setup] オフライン wheelhouse から install: $WheelhouseDir"
    & $vpy -m pip install --no-index --find-links $WheelhouseDir -r $RequirementsPath | Out-Host
  }
  else {
    Write-Host '[setup] wheelhouse 無し。オンラインで install します...'
    & $vpy -m pip install -r $RequirementsPath | Out-Host
  }
  if ($LASTEXITCODE -ne 0) { throw '依存のインストールに失敗しました。' }

  return $vpy
}
