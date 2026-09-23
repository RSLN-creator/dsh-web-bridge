# restart-web.ps1 — 安全重启本机 dsh web（3080）：杀掉监听 3080 的 node 进程，
# 用**同一条命令行**以 Start-Process 脱离启动，并把输出写进日志。
# 为什么不用市场那个自重启端点：它靠 spawn 脱离 + 原进程退出，本机 cmd 包装层下
# 端口会有一段时间无人接管；这里的顺序是「先杀、再起」，且启动命令逐字可见。
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:USERPROFILE '.dsh\web-restart-0198.log'
$err = Join-Path $env:USERPROFILE '.dsh\web-restart-0198-err.log'
$bin = 'C:\Users\rsyhn\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'

"=== restart requested at $(Get-Date -Format o) ===" | Out-File -FilePath $log -Encoding utf8
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) {
  $pid3080 = $c.OwningProcess
  "killing pid $pid3080 (listener on 3080)" | Out-File -FilePath $log -Append -Encoding utf8
  try { Stop-Process -Id $pid3080 -Force -ErrorAction Stop } catch { "kill failed: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8 }
}
Start-Sleep -Seconds 3
# 确认端口空出来；没空就再等（旧进程退出需要一点时间）
for ($i = 0; $i -lt 10; $i++) {
  $still = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  if (-not $still) { break }
  Start-Sleep -Seconds 2
}
"starting: node $bin web --host 127.0.0.1 --port 3080 --no-open" | Out-File -FilePath $log -Append -Encoding utf8
Start-Process -FilePath 'node' -ArgumentList @($bin, 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open') `
  -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden
Start-Sleep -Seconds 12
$up = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if ($up) {
  "OK: 3080 listening, pid $($up[0].OwningProcess) at $(Get-Date -Format o)" | Out-File -FilePath $log -Append -Encoding utf8
} else {
  "FAIL: 3080 not listening after restart — check $err" | Out-File -FilePath $log -Append -Encoding utf8
}
