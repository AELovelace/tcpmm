$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $env:LOCALAPPDATA 'tcpmm-dev'
$watchedFiles = @('index.html', 'package.json', 'tsconfig.json')

function Test-IgnoredPath([string]$relativePath) {
    return $relativePath -match '^(node_modules|dist|\.git|\.vscode)([\\/]|$)'
}

function Copy-ProjectFile([string]$sourcePath) {
    if (-not $sourcePath.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $relativePath = $sourcePath.Substring($projectRoot.Length).TrimStart('\', '/')
    if (-not $relativePath -or (Test-IgnoredPath $relativePath)) {
        return
    }

    $isSourceFile = $relativePath -match '^src[\\/]'
    if (-not $isSourceFile -and $relativePath -notin $watchedFiles) {
        return
    }

    $destinationPath = Join-Path $cacheRoot $relativePath
    if (Test-Path $sourcePath -PathType Container) {
        New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
        return
    }

    if (-not (Test-Path $sourcePath -PathType Leaf)) {
        Remove-Item $destinationPath -Force -ErrorAction SilentlyContinue
        return
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            Copy-Item $sourcePath $destinationPath -Force
            return
        }
        catch {
            if ($attempt -eq 4) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
foreach ($file in $watchedFiles) {
    Copy-ProjectFile (Join-Path $projectRoot $file)
}

$cachedSource = Join-Path $cacheRoot 'src'
if (Test-Path $cachedSource) {
    Remove-Item $cachedSource -Recurse -Force
}
Copy-Item (Join-Path $projectRoot 'src') $cacheRoot -Recurse -Force

$viteCommand = Join-Path $cacheRoot 'node_modules\.bin\vite.cmd'
if (-not (Test-Path $viteCommand)) {
    Write-Host 'Preparing the local Vite cache (first run only)...' -ForegroundColor Cyan
    Push-Location $cacheRoot
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Local dependency installation failed.' }
    }
    finally {
        Pop-Location
    }
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $projectRoot
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [IO.NotifyFilters]'FileName, DirectoryName, LastWrite'
$watcher.EnableRaisingEvents = $true

$subscriptions = @(
    Register-ObjectEvent $watcher Changed
    Register-ObjectEvent $watcher Created
    Register-ObjectEvent $watcher Deleted
    Register-ObjectEvent $watcher Renamed
)

Write-Host "Serving the mapped project through local cache: $cacheRoot" -ForegroundColor DarkGray
$viteProcess = $null
try {
    $viteProcess = Start-Process -FilePath $viteCommand -ArgumentList '--host', '127.0.0.1' -WorkingDirectory $cacheRoot -NoNewWindow -PassThru
    while (-not $viteProcess.HasExited) {
        $pendingEvent = Wait-Event -Timeout 1
        if ($null -eq $pendingEvent) { continue }

        $sourcePath = if ($pendingEvent.SourceEventArgs.PSObject.Properties.Name -contains 'NewFullPath') {
            $pendingEvent.SourceEventArgs.NewFullPath
        }
        else {
            $pendingEvent.SourceEventArgs.FullPath
        }
        Copy-ProjectFile $sourcePath
        Remove-Event -EventIdentifier $pendingEvent.EventIdentifier -ErrorAction SilentlyContinue
    }

    if ($viteProcess.ExitCode -ne 0) {
        exit $viteProcess.ExitCode
    }
}
finally {
    if ($null -ne $viteProcess -and -not $viteProcess.HasExited) {
        Stop-Process -Id $viteProcess.Id -Force -ErrorAction SilentlyContinue
    }
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    $subscriptions | ForEach-Object { Unregister-Event -SubscriptionId $_.SubscriptionId -ErrorAction SilentlyContinue }
}
