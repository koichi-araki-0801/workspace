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

Describe 'Verification receipt（検証済みフラグ）' {
  BeforeEach {
    $script:dir = Join-Path $TestDrive ('recv-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:dir -Force | Out-Null
    $script:sha = ('a' * 64)
  }

  It 'receipt が無いディレクトリは検証済みでない' {
    Test-VerificationReceipt -Directory $script:dir -ExpectedBundleSha256 $script:sha | Should Be $false
  }

  It 'New で書いた receipt は同じ sha256 で検証済みになる' {
    New-VerificationReceipt -Directory $script:dir -BundleSha256 $script:sha
    Test-VerificationReceipt -Directory $script:dir -ExpectedBundleSha256 $script:sha | Should Be $true
  }

  It '記録した sha256 と異なる期待値では検証済みにならない（別リリースの資材を弾く）' {
    New-VerificationReceipt -Directory $script:dir -BundleSha256 $script:sha
    Test-VerificationReceipt -Directory $script:dir -ExpectedBundleSha256 ('b' * 64) | Should Be $false
  }

  It '大文字小文字は無視して比較する' {
    New-VerificationReceipt -Directory $script:dir -BundleSha256 ($script:sha.ToUpper())
    Test-VerificationReceipt -Directory $script:dir -ExpectedBundleSha256 $script:sha | Should Be $true
  }

  It 'Remove すると再び検証済みでなくなる（DangerouslySkip の次回再検証強制）' {
    New-VerificationReceipt -Directory $script:dir -BundleSha256 $script:sha
    Remove-VerificationReceipt -Directory $script:dir
    Test-VerificationReceipt -Directory $script:dir -ExpectedBundleSha256 $script:sha | Should Be $false
  }

  It 'Remove は receipt が無くても失敗しない' {
    { Remove-VerificationReceipt -Directory $script:dir } | Should Not Throw
  }

  It '中身が壊れた receipt は検証済みでない（fail closed）' {
    $path = Join-Path $script:dir '.offline-verify-receipt'
    Set-Content -LiteralPath $path -Value 'garbage-without-sha' -Encoding UTF8
    Test-VerificationReceipt -Directory $script:dir -ExpectedBundleSha256 $script:sha | Should Be $false
  }
}
