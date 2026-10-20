$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

$pngPath = Join-Path $root 'mobile\android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png'
$icoPath = Join-Path $assets 'stockroom.ico'

$png = [System.IO.File]::ReadAllBytes($pngPath)
$bitmap = [System.Drawing.Image]::FromFile($pngPath)
$width = $bitmap.Width
$height = $bitmap.Height
$bitmap.Dispose()

$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]($(if ($width -ge 256) { 0 } else { $width })))
$writer.Write([Byte]($(if ($height -ge 256) { 0 } else { $height })))
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$png.Length)
$writer.Write([UInt32]22)
$writer.Write($png)
$writer.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $stream.ToArray())
$writer.Close()
Write-Host "Иконка: $icoPath"

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

$start = $shell.CreateShortcut((Join-Path $desktop 'Запустить Stockroom Kids.lnk'))
$start.TargetPath = (Join-Path $root 'start-public.cmd')
$start.WorkingDirectory = $root
$start.IconLocation = "$icoPath,0"
$start.Description = 'Запуск Stockroom Kids: сервер и публичная ссылка'
$start.WindowStyle = 1
$start.Save()

$stop = $shell.CreateShortcut((Join-Path $desktop 'Остановить Stockroom Kids.lnk'))
$stop.TargetPath = (Join-Path $root 'stop-server.cmd')
$stop.WorkingDirectory = $root
$stop.IconLocation = "$icoPath,0"
$stop.Description = 'Остановка сервера и публичного туннеля Stockroom Kids'
$stop.WindowStyle = 1
$stop.Save()

Write-Host 'Ярлыки созданы:'
Write-Host "  $desktop\Запустить Stockroom Kids.lnk"
Write-Host "  $desktop\Остановить Stockroom Kids.lnk"
