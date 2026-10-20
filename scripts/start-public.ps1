$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    $portable = Join-Path $env:LOCALAPPDATA 'StockroomKids\node-v24.22.0-win-x64\node.exe'
    if (Test-Path $portable) { $node = $portable }
}
if (-not $node) {
    Write-Host 'Node.js не найден. Установите Node.js 24 или укажите путь к node.exe.' -ForegroundColor Red
    exit 1
}

if (-not $env:PORT) { $env:PORT = '3000' }
$portNumber = [int]$env:PORT

$listening = Get-NetTCPConnection -LocalPort $portNumber -State Listen -ErrorAction SilentlyContinue
$server = $null
if (-not $listening) {
    $env:HOST = '0.0.0.0'
    $server = Start-Process -FilePath $node -ArgumentList 'src/server.mjs' -WorkingDirectory $root -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\stockroom-server.log" -RedirectStandardError "$env:TEMP\stockroom-server.err.log"
    Start-Sleep -Seconds 3
}

Write-Host ''
Write-Host 'Stockroom Kids — публичный доступ' -ForegroundColor Cyan
Write-Host 'Через несколько секунд ниже появится строка:'
Write-Host '  Forwarding HTTP traffic from https://<адрес>.serveousercontent.com' -ForegroundColor Gray
Write-Host 'Именно эта ссылка открывает магазин с любого устройства в интернете.'
Write-Host ''
Write-Host 'Окно должно оставаться открытым: пока оно работает, приложение доступно извне.' -ForegroundColor Yellow
Write-Host 'Ссылка меняется при каждом запуске, компьютер и интернет должны быть включены.' -ForegroundColor Yellow
Write-Host ''

try {
    & ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -R 80:127.0.0.1:3000 serveo.net
} finally {
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
