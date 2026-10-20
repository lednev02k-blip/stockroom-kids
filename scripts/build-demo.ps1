$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$www = Join-Path $root 'mobile-demo\www'

if (Test-Path $www) { Remove-Item $www -Recurse -Force }
New-Item -ItemType Directory -Force -Path $www | Out-Null

Copy-Item (Join-Path $root 'public\styles.css') $www
Copy-Item (Join-Path $root 'public\js') (Join-Path $www 'js') -Recurse
Copy-Item (Join-Path $root 'demo\demo.js') $www

$html = Get-Content -Raw (Join-Path $root 'public\index.html')
$html = $html.Replace('<link rel="stylesheet" href="/styles.css">', '<link rel="stylesheet" href="styles.css">')
$html = $html.Replace('<title>Stockroom Kids — учёт магазина</title>', '<title>Stockroom Kids — демо</title>')
$html = $html.Replace(
    '<script type="module" src="/js/app.js"></script>',
    "<script src=""demo.js""></script>`n  <script type=""module"" src=""js/app.js""></script>"
)
$html = $html.Replace('</head>', "<style>[data-export],a[href^=""/api/export""]{display:none!important}</style>`n</head>")

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $www 'index.html'), $html, $utf8)

Write-Host "Демо-интерфейс собран: $www"
Get-ChildItem $www | Select-Object Name
