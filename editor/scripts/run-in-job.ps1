<#
.SYNOPSIS
    渡されたコマンドを起動し、本ラッパ(holder)が死んだら別プロセスの watchdog が対象の
    プロセスツリーごと確実に終了させる。editor の `start.bat` が dev/prod 起動に用いる。

.DESCRIPTION
    なぜ必要か: コンソール窓を X ボタンで閉じると子プロセスへ signal が飛ばず、
    `node`/`vite`/`tsx`/fork した PDF worker daemon、さらに worker が起こす headless chromium まで
    孤児化して生き続ける(`buildWorkerServer.ts` の tree-kill は worker recycle 時の孫始末用で、
    launcher 自体の異常終了は救えない)。

    仕組み(watchdog 方式):
      1. 対象コマンドを `cmd /c` で同一コンソールに起動する(Ctrl+C と標準出力が素通り)。
      2. *別コンソール*(`-WindowStyle Hidden`)に watchdog を 1 つ起こす。watchdog は本 holder の
         PID を `Wait-Process` で見張り、holder がどんな理由で死んでも(X 閉じ/強制終了/正常終了)
         対象ツリーを `taskkill /T /F` で一掃して自身も終わる。watchdog は別コンソールなので、
         editor 窓を X で閉じても道連れにならず、後始末を完遂できる。
      3. holder 側も通常終了/Ctrl+C は try/finally で即 tree-kill する(速い経路)。watchdog は
         finally が走らない強制終了(X 閉じ)を取りこぼさないための保険。

    Job Object(KILL_ON_JOB_CLOSE)は採用しない: Windows Terminal 配下では起動プロセスが既に
    親 job に属し、入れ子 job では KILL_ON_JOB_CLOSE が発火しない(実機検証で確認)。親 job からの
    breakaway + `CREATE_SUSPENDED` 起動は P/Invoke が脆く保守性が悪い。watchdog 方式は job の
    入れ子事情に依存せず、`taskkill /T`(=子孫まで)で確実に効く。

    補完関係: 次回起動時/通常終了の取りこぼしは `start.bat` の `:portcheck` / `:cleanup`
    (同じく taskkill /T の tree-kill)も担う。多層で「プロセスが生き続ける」を塞ぐ。

.PARAMETER Command
    実行するコマンドとその引数(残余引数として受ける)。例: `pnpm run dev`。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File run-in-job.ps1 pnpm run dev

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File run-in-job.ps1 pnpm --filter server run start
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Command
)

if (-not $Command -or $Command.Count -eq 0) {
    Write-Error '[run-in-job] 実行コマンドが指定されていません。'
    exit 2
}

# 対象を同一コンソールへ起動(Ctrl+C と標準出力が素通りする)。`cmd /c` を根に据えると、
# その PID へ `taskkill /T` する一手で配下(`pnpm`->`node`->`fork`->`chromium`)を一掃できる。
# `Start-Process -PassThru` は終了コードを保持しない(`.ExitCode` が空)ため、ハンドルを保つ
# `[System.Diagnostics.Process]::Start` を使う。`UseShellExecute=$false` で親コンソールと
# 標準入出力を継承する(別窓を開かない)。
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:ComSpec
$psi.Arguments = '/c ' + ($Command -join ' ')
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$childPid = $proc.Id

# watchdog: 本 holder($PID)の死を `Wait-Process` で見張り、死んだら対象ツリーを tree-kill する。
# PID を文字列へ埋め込み、-EncodedCommand(UTF-16LE base64)で渡して引用符問題を避ける。別コンソール
# (Hidden)で動かすので editor 窓を X で閉じても生き残り、孤児化前にツリーを刈り取る。
$watchCmd = "try { Wait-Process -Id $PID -ErrorAction SilentlyContinue } catch {}; " +
            "Start-Process taskkill -ArgumentList '/PID', '$childPid', '/T', '/F' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue"
$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($watchCmd))
Start-Process -FilePath 'powershell' `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded `
    -WindowStyle Hidden | Out-Null

try {
    $proc.WaitForExit()
} finally {
    # 通常終了/Ctrl+C の速い後始末。X 閉じで finally が走らない場合は上記 watchdog が拾う。
    Start-Process taskkill -ArgumentList '/PID', "$childPid", '/T', '/F' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
}
# `exit` を try の外へ置く: try 内 `exit` は finally 実行後に終了コードが 0 へ落ちる癖があるため、
# WaitForExit で得た子の終了コードを finally(後始末)の後に確定させる。
exit $proc.ExitCode
