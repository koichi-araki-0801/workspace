# Pester テスト: offline 配布物の検証ライブラリ（verify.ps1）。
# 実行: pwsh/PowerShell から `Invoke-Pester offline/lib/verify.Tests.ps1`（`pnpm run ci:offline` 経由でも走る）。
# 日本語コメントを含むため UTF-8 BOM 必須（cp932 環境で文字化けさせない）。

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path (Join-Path $here '..') '..')).ProviderPath
. (Join-Path $here 'content-key.ps1')
. (Join-Path $here 'verify.ps1')

Describe 'Test-OfflineRequirementLine' {
  Context '受け入れる形（名前 + 省略可能なバージョン指定子）' {
    It 'ベアな名前を通す' { Test-OfflineRequirementLine -Line 'markdown-it-py' | Should Be $true }
    It 'バージョン指定子付きを通す' { Test-OfflineRequirementLine -Line 'PyYAML==6.0.1' | Should Be $true }
    It '空行・コメントを通す' {
      Test-OfflineRequirementLine -Line '' | Should Be $true
      Test-OfflineRequirementLine -Line '  # comment' | Should Be $true
    }
  }
  Context 'pip がアーカイブと見なす綴りを拒否する（tar 系の別綴りまで網羅）' {
    It '基本の列挙（whl/zip/tar/tgz/tbz2/txz/egg/gz/bz2/xz）を拒否' {
      foreach ($ext in @('whl', 'zip', 'tar', 'tgz', 'tbz2', 'txz', 'egg', 'gz', 'bz2', 'xz')) {
        Test-OfflineRequirementLine -Line "payload.$ext" | Should Be $false
      }
    }
    It 'tar 系の別綴り tbz/tlz/tar.lz/tar.lzma を拒否' {
      Test-OfflineRequirementLine -Line 'payload.tbz' | Should Be $false
      Test-OfflineRequirementLine -Line 'payload.tlz' | Should Be $false
      Test-OfflineRequirementLine -Line 'payload.tar.lz' | Should Be $false
      Test-OfflineRequirementLine -Line 'payload.tar.lzma' | Should Be $false
    }
    It 'パス区切りを含むローカルパス参照を拒否（拡張子網羅と二重の防御）' {
      Test-OfflineRequirementLine -Line './downloads/numpy-1.9.2-cp34-none-win32.whl' | Should Be $false
      Test-OfflineRequirementLine -Line 'sub\dir\pkg' | Should Be $false
    }
    It 'ドットを含む正規パッケージ名は通す（index/wheelhouse 解決のみで解決先を動かせない）' {
      Test-OfflineRequirementLine -Line 'zope.interface' | Should Be $true
      Test-OfflineRequirementLine -Line 'ruamel.yaml==0.18.6' | Should Be $true
    }
    It 'URL 参照・オプション行を拒否' {
      Test-OfflineRequirementLine -Line 'pkg @ https://evil/pkg.tar.gz' | Should Be $false
      Test-OfflineRequirementLine -Line '--find-links https://evil/' | Should Be $false
      Test-OfflineRequirementLine -Line '-e .' | Should Be $false
    }
  }
}

Describe 'Get-OfflineRequirementsFiles' {
  It 'リポジトリ追跡中の全 requirements.txt を含む（git ls-files との突き合わせ）' {
    $expected = @(& git -C $repoRoot ls-files -- '*requirements.txt') |
      ForEach-Object { Join-Path $repoRoot ($_ -replace '/', '\') } |
      Sort-Object
    $actual = @(Get-OfflineRequirementsFiles -RepoRoot $repoRoot) | Sort-Object
    ($actual -join "`n") | Should Be ($expected -join "`n")
  }

  It '走査結果の各ファイルが Test-OfflineRequirementsFile を通る' {
    foreach ($f in (Get-OfflineRequirementsFiles -RepoRoot $repoRoot)) {
      (Test-OfflineRequirementsFile -Path $f).Count | Should Be 0
    }
  }

  It 'git 経路とファイルシステム経路が同じ結果になる（フォールバックの正しさの担保）' {
    $viaGit = @(Get-OfflineRequirementsFilesViaGit -RepoRoot $repoRoot) | Sort-Object
    $viaFileSystem = @(Get-OfflineRequirementsFilesViaFileSystem -RepoRoot $repoRoot) | Sort-Object
    ($viaFileSystem -join "`n") | Should Be ($viaGit -join "`n")
  }

  # ファイルシステム経路の Filter を完全名一致へ戻す退行の再発防止。完全名一致だと
  # dev-requirements.txt を数えず、配布先(zip 展開・.git 無し)の setup で key が乖離する。
  It 'ファイルシステム経路が dev-requirements.txt を数える（除外ディレクトリは数えない）' {
    $dir = Join-Path $TestDrive ('req-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $dir 'node_modules') -Force | Out-Null
    Set-Content -Path (Join-Path $dir 'requirements.txt') -Value 'pkg==1.0' -Encoding utf8
    Set-Content -Path (Join-Path $dir 'dev-requirements.txt') -Value 'pytest==9.1.1' -Encoding utf8
    Set-Content -Path (Join-Path $dir 'node_modules\requirements.txt') -Value 'pkg==1.0' -Encoding utf8
    $found = @(Get-OfflineRequirementsFilesViaFileSystem -RepoRoot $dir) | Sort-Object
    $found.Count | Should Be 2
    ($found | Split-Path -Leaf | Sort-Object) -join "`n" | Should Be "dev-requirements.txt`nrequirements.txt"
  }

  # 配布先が置かれうる 2 条件。他のケースはすべて RepoRoot = リポジトリのルートで実行しており、
  # 「git 経路とファイルシステム経路が呼び分けられる条件」そのものを再現していなかった。
  # 判定は `$null -eq` で行う（`Should BeNullOrEmpty` は空配列と null を区別できず、
  # フォールバックが働かない退行をそのまま通してしまう）。
  It 'git 管理外の RepoRoot では null を返す（stderr で呼び出し元を止めない）' {
    $dir = Join-Path $TestDrive ('nogit-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Set-Content -Path (Join-Path $dir 'requirements.txt') -Value 'pkg==1.0' -Encoding utf8
    # setup スクリプトと同じ条件。native コマンドの stderr は Stop のもとで
    # NativeCommandError になり、呼び出し元ごと停止する。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Stop'
    try { $result = Get-OfflineRequirementsFilesViaGit -RepoRoot $dir }
    finally { $ErrorActionPreference = $prev }
    ($null -eq $result) | Should Be $true
  }

  It '別リポジトリ配下の RepoRoot では null を返す（ls-files が exit 0 / 0 件でも空配列にしない）' {
    $outer = Join-Path $TestDrive ('outer-' + [guid]::NewGuid().ToString('N'))
    $inner = Join-Path $outer 'inner'
    New-Item -ItemType Directory -Path $inner -Force | Out-Null
    & git -C $outer init --quiet 2>$null | Out-Null
    Set-Content -Path (Join-Path $inner 'requirements.txt') -Value 'pkg==1.0' -Encoding utf8
    $result = Get-OfflineRequirementsFilesViaGit -RepoRoot $inner
    ($null -eq $result) | Should Be $true
  }

  # 期待値は「変数で受ける」経路から採る。`, @(...)` の外側 1 段は代入でのみ剥がれるため、
  # 関数呼び出しを直接 `@(...)` で包むと常に 1 になり、pipe 経由の潰れを検出できない。
  It 'pipe 経由でも 1 パス = 1 要素で流れる（git 経路）' {
    $expected = Get-OfflineRequirementsFilesViaGit -RepoRoot $repoRoot
    @($expected).Count | Should BeGreaterThan 0
    $piped = @(Get-OfflineRequirementsFiles -RepoRoot $repoRoot | Where-Object { $_ -is [string] })
    $piped.Count | Should Be @($expected).Count
  }

  It 'pipe 経由でも 1 パス = 1 要素で流れる（git 失敗時のファイルシステム経路）' {
    Mock Get-OfflineRequirementsFilesViaGit { $null }
    $expected = Get-OfflineRequirementsFilesViaFileSystem -RepoRoot $repoRoot
    @($expected).Count | Should BeGreaterThan 0
    $piped = @(Get-OfflineRequirementsFiles -RepoRoot $repoRoot | Where-Object { $_ -is [string] })
    $piped.Count | Should Be @($expected).Count
  }
}

Describe 'Assert-FileSha256（期待値との突き合わせ）' {
  BeforeEach {
    $script:file = Join-Path $TestDrive ('sha-' + [guid]::NewGuid().ToString('N') + '.bin')
    Set-Content -LiteralPath $script:file -Value 'bundle payload' -Encoding Ascii
    $script:hash = (Get-FileHash -LiteralPath $script:file -Algorithm SHA256).Hash
  }

  It '期待値と一致すれば通す' {
    { Assert-FileSha256 -File $script:file -ExpectedSha256 $script:hash -Label 'bundle' } | Should Not Throw
  }

  It '期待値の大文字小文字は問わない（pin は小文字、Get-FileHash は大文字を返す）' {
    { Assert-FileSha256 -File $script:file -ExpectedSha256 ($script:hash.ToLower()) -Label 'bundle' } | Should Not Throw
  }

  It '中身が 1 バイトでも変われば停止する（fail closed）' {
    Add-Content -LiteralPath $script:file -Value 'x'
    { Assert-FileSha256 -File $script:file -ExpectedSha256 $script:hash -Label 'bundle' } | Should Throw
  }

  It '別リリースの期待値では停止する' {
    { Assert-FileSha256 -File $script:file -ExpectedSha256 ('a' * 64) -Label 'bundle' } | Should Throw
  }
}

