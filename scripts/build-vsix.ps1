[CmdletBinding()]
param(
    [string]$PascalABCPath = "${env:ProgramFiles(x86)}\PascalABC.NET"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '..')
)
$runtimeScript = Join-Path $PSScriptRoot 'build-runtime.ps1'
$packageJsonPath = Join-Path $repositoryRoot 'package.json'

function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $runtimeScript -PathType Leaf)) {
    throw "Runtime build script was not found: $runtimeScript"
}

if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    throw "package.json was not found: $packageJsonPath"
}

$package = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace([string]$package.name) -or
    [string]::IsNullOrWhiteSpace([string]$package.version)) {
    throw 'package.json must contain non-empty name and version fields.'
}

$vsixName = "$($package.name)-$($package.version).vsix"
$vsixPath = Join-Path $repositoryRoot $vsixName

Push-Location $repositoryRoot
try {
    Write-Host '=== Preparing PascalABC.NET runtime ==='
    & $runtimeScript -PascalABCPath $PascalABCPath
    Assert-LastExitCode 'Runtime build'

    Write-Host '=== Restoring Node.js dependencies ==='
    & npm.cmd ci
    Assert-LastExitCode 'npm ci'

    Write-Host '=== Compiling TypeScript ==='
    & npm.cmd run compile
    Assert-LastExitCode 'TypeScript compilation'

    Write-Host "=== Packaging $vsixName ==="
    & npx.cmd --yes '@vscode/vsce' package --out $vsixPath
    Assert-LastExitCode 'VSIX packaging'
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $vsixPath -PathType Leaf)) {
    throw "VSIX packaging completed without producing: $vsixPath"
}

$vsixFile = Get-Item -LiteralPath $vsixPath
$sizeMB = [Math]::Round($vsixFile.Length / 1MB, 2)

Write-Host "VSIX built successfully: $($vsixFile.FullName) ($sizeMB MB)"
