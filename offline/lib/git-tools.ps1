# 共通ライブラリ: 同梱 git ツール（PortableGit / TortoiseGit）の検証付き展開・導入。
# setup-offline.ps1 / setup-offline-local.ps1 から dot-source して使う。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。
#
# 同じ処理を両 setup へ写経すると「片方だけ直る」事故が起きる。
# 実行判断を伴う処理はこの 1 か所に集約し、両者が同じコードを通るようにする。

. (Join-Path $PSScriptRoot 'verify.ps1')

# ── 同梱 git ツールの展開・導入 ──
# git-tools/ は .gitignore 対象（＝`git status` にも diff にも現れない）で、そこから拾った
# バイナリを無検証で実行するのは「無レビューのコード実行」そのもの。台帳 manifest.txt の
# 正確なファイル名でエントリを選び、sha256 が一致した実体だけを実行する。
# 台帳が無い場合は**何も実行せずに戻る**（検証できないものは動かさない）。
# sha256 不一致は改ざんの兆候として throw し、呼び出し元（$ErrorActionPreference='Stop'）で
# セットアップ全体を止める。
function Install-GitTools {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [switch]$InstallTortoiseGit
  )
  $gitTools = Join-Path $RepoRoot 'git-tools'
  if (-not (Test-Path -LiteralPath $gitTools)) { return }

  Write-Host '[git] PortableGit / TortoiseGit を確認...'
  $manifestPath = Join-Path $gitTools 'manifest.txt'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Warning ('[git] git-tools\manifest.txt がありません。検証できないため PortableGit /' +
      ' TortoiseGit の展開・導入は行いません（git は各自で用意してください）。')
    return
  }
  $entries = Get-GitToolsManifestEntries -ManifestPath $manifestPath

  # ---- PortableGit（自己展開 EXE） ----
  $pgEntry = $entries | Where-Object { $_.Name -eq 'PortableGit' } | Select-Object -First 1
  $pgDir = Join-Path $gitTools 'portablegit'
  $gitExe = Join-Path $pgDir 'cmd\git.exe'
  if (-not $pgEntry) {
    Write-Warning '[git] manifest に PortableGit のエントリがありません。展開を行いません。'
  } elseif (-not (Test-Path -LiteralPath $gitExe)) {
    # 実行するのは「台帳のファイル名で選び、sha256 が一致した実体」だけ。
    $pgPath = Resolve-VerifiedManifestFile -Directory $gitTools -Entry $pgEntry
    Write-Host "[git] PortableGit を展開（sha256 照合済み）: $($pgEntry.FileName) -> portablegit\"
    & $pgPath "-o$pgDir" -y | Out-Null
  }

  if (Test-Path -LiteralPath $gitExe) {
    $cmdDir = Join-Path $pgDir 'cmd'
    # PATH へは**追記（append）**する。プロジェクト配下のディレクトリを PATH 先頭へ置くと
    # System32 より先に解決され、そこへ書ける者が `git` そのものを差し替えられる。
    # 追記なら既存の正規 git が優先され、無い環境でのみ同梱 git が使われる。
    if ($env:Path -notlike "*$cmdDir*") { $env:Path = "$env:Path;$cmdDir" }
    try {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if ($userPath -notlike "*$cmdDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$cmdDir", 'User')
        Write-Host "[git] ユーザー PATH へ追記: $cmdDir（新しい端末から有効）"
      }
      # editor サーバは GIT_BIN を最優先で使う（PATH 反映の遅延に依存しない）。
      # ここはリポジトリ配下の実行ファイルを指す永続設定なので、リポジトリを書き込み可能な
      # 共有領域へ置かないこと（置くと editor が実行する git を第三者が差し替えられる）。
      [Environment]::SetEnvironmentVariable('GIT_BIN', $gitExe, 'User')
      Write-Host "[git] GIT_BIN を設定: $gitExe"
    } catch {
      Write-Warning "[git] ユーザー環境変数の設定に失敗。手動で $cmdDir を PATH へ加えてください。"
    }
    Write-Host "[git] git 利用可能: $(& $gitExe --version)"
  } else {
    Write-Warning '[git] PortableGit の git.exe が見つかりません（展開に失敗した可能性）。'
  }

  # ---- TortoiseGit（MSI のサイレント昇格インストール） ----
  # `/qn` は UAC の同意画面すら出さずに管理者権限で MSI を走らせる。既定で黙って実行せず、
  # 明示 opt-in（-InstallTortoiseGit）の下でだけ行う。
  $tgEntry = $entries | Where-Object { $_.Name -eq 'TortoiseGit' } | Select-Object -First 1
  if (-not $tgEntry) { return }
  if (-not $InstallTortoiseGit) {
    Write-Host ("[git] TortoiseGit は導入しません（既定）。導入するには -InstallTortoiseGit を付けるか、" +
      "git-tools\$($tgEntry.FileName) を手動で実行してください。")
    return
  }
  $tgPath = Resolve-VerifiedManifestFile -Directory $gitTools -Entry $tgEntry
  Write-Host "[git] TortoiseGit を導入（sha256 照合済み・失敗しても続行）: $($tgEntry.FileName)"
  try {
    $proc = Start-Process msiexec.exe `
      -ArgumentList @('/i', "`"$tgPath`"", '/qn', '/norestart') -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      Write-Warning "[git] TortoiseGit の導入が未完了（ExitCode=$($proc.ExitCode)）。管理者権限で msi を実行してください。"
    } else {
      Write-Host '[git] TortoiseGit を導入しました。'
    }
  } catch {
    Write-Warning "[git] TortoiseGit の導入に失敗。手動で $($tgEntry.FileName) を実行してください。"
  }
}
