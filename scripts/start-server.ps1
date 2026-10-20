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

$env:HOST = '0.0.0.0'
if (-not $env:PORT) { $env:PORT = '3000' }

$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)

Write-Host ''
Write-Host 'Stockroom Kids' -ForegroundColor Cyan
Write-Host "На этом компьютере: http://127.0.0.1:$env:PORT"
foreach ($ip in $addresses) {
    Write-Host "Для телефона в Wi-Fi: http://${ip}:$env:PORT"
}
Write-Host 'Остановить сервер: Ctrl+C'
Write-Host ''

Set-Location $root
& $node 'src/server.mjs'
