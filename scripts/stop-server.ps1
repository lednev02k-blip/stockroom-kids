$ErrorActionPreference = 'SilentlyContinue'

$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$stopped = @()

$pids = Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
    $process = Get-Process -Id $processId
    if ($process -and $process.ProcessName -eq 'node') {
        Stop-Process -Id $process.Id -Force
        $stopped += "сервер (PID $($process.Id))"
    }
}

$tunnels = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" |
    Where-Object { $_.CommandLine -match 'serveo\.net' }
foreach ($tunnel in $tunnels) {
    Stop-Process -Id $tunnel.ProcessId -Force
    $stopped += "туннель (PID $($tunnel.ProcessId))"
}

$launcherProcesses = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -match 'start-public\.ps1' }
foreach ($launcher in $launcherProcesses) {
    Stop-Process -Id $launcher.ProcessId -Force
    $stopped += "окно запуска (PID $($launcher.ProcessId))"
}

Write-Host ''
if ($stopped.Count -gt 0) {
    Write-Host 'Stockroom Kids остановлен' -ForegroundColor Green
    foreach ($item in $stopped) { Write-Host "  - $item" }
    Write-Host ''
    Write-Host 'Публичная ссылка больше не работает. Запуск — ярлык «Запустить Stockroom Kids».' -ForegroundColor Gray
} else {
    Write-Host 'Stockroom Kids уже остановлен: сервер на порту ' -NoNewline
    Write-Host "$port" -NoNewline
    Write-Host ' не запущен.'
}

Start-Sleep -Seconds 3
