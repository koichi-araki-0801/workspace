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

Describe 'Assert-FileSha256（pin との突き合わせ）' {
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

Describe 'Test-PinnedCommitId' {
  It '40 桁 16 進の完全 SHA-1 を受け付ける' {
    Test-PinnedCommitId (('0123456789abcdef' * 3).Substring(0, 40)) | Should Be $true
  }

  It '短縮 id を拒否する（内容を一意に同定しない）' {
    Test-PinnedCommitId '0123456' | Should Be $false
  }

  It 'ローリングタグ名を拒否する（タグは publish のたびに指す先が動く）' {
    Test-PinnedCommitId 'offline-bundle-v1' | Should Be $false
  }

  It '41 桁以上・空文字を拒否する' {
    Test-PinnedCommitId ('a' * 41) | Should Be $false
    Test-PinnedCommitId '' | Should Be $false
  }

  It '大文字 16 進を拒否する（pin の正典は Get-OfflinePin が書く小文字）' {
    Test-PinnedCommitId ('A' * 40) | Should Be $false
    Test-PinnedCommitId ((('0123456789abcdef' * 3).Substring(0, 39)) + 'F') | Should Be $false
  }
}

Describe 'Get-OfflinePin（手渡しで運ばれる期待値の読み取り）' {
  BeforeEach {
    $script:pinPath = Join-Path $TestDrive ('pin-' + [guid]::NewGuid().ToString('N') + '.txt')
    $script:commit = ('0123456789abcdef' * 3).Substring(0, 40)
    $script:zipSha = ('a' * 64)
    $script:bundleSha = ('b' * 64)
    $script:validLines = @(
      '# publish が書き出す期待値（コメント行と空行は無視される）',
      '',
      "source-commit $script:commit",
      "source-zip-sha256 $script:zipSha",
      "bundle-sha256 $script:bundleSha")
  }

  It '3 キーが揃っていれば読み取れる' {
    Set-Content -LiteralPath $script:pinPath -Value $script:validLines -Encoding UTF8
    $pin = Get-OfflinePin -Path $script:pinPath
    $pin.SourceCommit | Should Be $script:commit
    $pin.SourceZipSha256 | Should Be $script:zipSha
    $pin.BundleSha256 | Should Be $script:bundleSha
  }

  It 'pin ファイルが無ければ停止する（配信元と独立した根拠が消えるため）' {
    { Get-OfflinePin -Path (Join-Path $TestDrive 'no-such-pin.txt') } | Should Throw
  }

  It 'キーが 1 つでも欠ければ停止する' {
    Set-Content -LiteralPath $script:pinPath -Value $script:validLines[0..3] -Encoding UTF8
    { Get-OfflinePin -Path $script:pinPath } | Should Throw
  }

  It 'source-commit をタグ名へ書き換えられたら停止する（pin の改ざん）' {
    $lines = $script:validLines
    $lines[2] = 'source-commit offline-bundle-v1'
    Set-Content -LiteralPath $script:pinPath -Value $lines -Encoding UTF8
    { Get-OfflinePin -Path $script:pinPath } | Should Throw
  }

  It 'sha256 の桁が欠けていたら停止する（fail closed）' {
    $lines = $script:validLines
    $lines[4] = 'bundle-sha256 ' + ('b' * 63)
    Set-Content -LiteralPath $script:pinPath -Value $lines -Encoding UTF8
    { Get-OfflinePin -Path $script:pinPath } | Should Throw
  }
}

Describe '分離署名の検証（Test-DetachedSignature / Assert-BundleSignature）' {
  # 3072bit の鍵生成は 1 回だけにする（It ごとに作ると実行時間が跳ねる）。テスト用の鍵は
  # `New-OfflineSigningKeyPair` が返す XML そのもので、配布運用の公開鍵ファイルと同じ形。
  $keys = New-OfflineSigningKeyPair
  $otherKeys = New-OfflineSigningKeyPair
  $signedFile = Join-Path $TestDrive 'bundle.zip'
  Set-Content -LiteralPath $signedFile -Value 'bundle payload' -Encoding Ascii
  $signature = New-DetachedSignatureBase64 -File $signedFile -PrivateKeyXml $keys.PrivateXml

  It '対応する公開鍵で検証が通る' {
    Test-DetachedSignature -File $signedFile -SignatureBase64 $signature -PublicKeyXml $keys.PublicXml |
      Should Be $true
  }

  It '別の鍵ペアの公開鍵では通らない（署名鍵の同一性を見ている）' {
    Test-DetachedSignature -File $signedFile -SignatureBase64 $signature -PublicKeyXml $otherKeys.PublicXml |
      Should Be $false
  }

  It '署名後にファイルが変わったら通らない' {
    $tampered = Join-Path $TestDrive 'tampered.zip'
    Set-Content -LiteralPath $tampered -Value 'bundle payload!' -Encoding Ascii
    Test-DetachedSignature -File $tampered -SignatureBase64 $signature -PublicKeyXml $keys.PublicXml |
      Should Be $false
  }

  It '署名・公開鍵の形式不正は例外でなく検証失敗へ倒す（fail closed）' {
    Test-DetachedSignature -File $signedFile -SignatureBase64 'not-base64!!' -PublicKeyXml $keys.PublicXml |
      Should Be $false
    Test-DetachedSignature -File $signedFile -SignatureBase64 $signature -PublicKeyXml '<not-a-key/>' |
      Should Be $false
  }

  Context 'Assert-BundleSignature（呼び出し側にスキップを書かせない入口）' {
    BeforeEach {
      $script:dir = Join-Path $TestDrive ('sig-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $script:dir -Force | Out-Null
      $script:pubPath = Join-Path $script:dir 'public.xml'
      $script:sigPath = Join-Path $script:dir 'bundle.zip.sig'
      Set-Content -LiteralPath $script:pubPath -Value $keys.PublicXml -Encoding UTF8
      Set-Content -LiteralPath $script:sigPath -Value $signature -Encoding UTF8
    }

    It '正しい組み合わせなら通す' {
      { Assert-BundleSignature -File $signedFile -SignaturePath $script:sigPath -PublicKeyPath $script:pubPath } |
        Should Not Throw
    }

    It '公開鍵が無ければ停止する（「鍵が無ければスキップ」を許さない）' {
      Remove-Item -LiteralPath $script:pubPath -Force
      { Assert-BundleSignature -File $signedFile -SignaturePath $script:sigPath -PublicKeyPath $script:pubPath } |
        Should Throw
    }

    It '.sig が無ければ停止する（署名の無い重量物は受け入れない）' {
      Remove-Item -LiteralPath $script:sigPath -Force
      { Assert-BundleSignature -File $signedFile -SignaturePath $script:sigPath -PublicKeyPath $script:pubPath } |
        Should Throw
    }

    It '別の鍵で署名されていたら停止する（すり替えの検知）' {
      $otherSig = New-DetachedSignatureBase64 -File $signedFile -PrivateKeyXml $otherKeys.PrivateXml
      Set-Content -LiteralPath $script:sigPath -Value $otherSig -Encoding UTF8
      { Assert-BundleSignature -File $signedFile -SignaturePath $script:sigPath -PublicKeyPath $script:pubPath } |
        Should Throw
    }
  }
}
