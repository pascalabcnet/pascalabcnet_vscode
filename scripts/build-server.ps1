[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '..')
)
$toolingRoot = Join-Path $repositoryRoot 'externals\pascalabcnet-tooling'
$projectPath = Join-Path $toolingRoot `
    'PascalABCNet.LanguageServer\PascalABCNet.LanguageServer.csproj'
$nestedCompilerPath = Join-Path $toolingRoot `
    'pascalabcnet\PascalABCNET.sln'
$buildRoot = Join-Path $repositoryRoot '.build'
$nextServerRoot = Join-Path $buildRoot 'server-next'
$serverParent = Join-Path $repositoryRoot 'server'
$outputRoot = Join-Path $serverParent 'win-x64'
$runtimeLibRoot = Join-Path $repositoryRoot 'bin\net10\Lib'

function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $projectPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $nestedCompilerPath -PathType Leaf)) {
    Write-Host '=== Initializing tooling submodules ==='
    Push-Location $repositoryRoot
    try {
        & git submodule update --init --recursive
        Assert-LastExitCode 'Git submodule initialization'
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $projectPath -PathType Leaf)) {
    throw "Language server project was not found: $projectPath"
}

if (-not (Test-Path -LiteralPath $nestedCompilerPath -PathType Leaf)) {
    throw "Nested PascalABC.NET sources were not found: $nestedCompilerPath"
}

$systemUnitPath = Join-Path $runtimeLibRoot 'PABCSystem.pcu'
if (-not (Test-Path -LiteralPath $systemUnitPath -PathType Leaf)) {
    throw @"
The .NET 10 PascalABC.NET standard library was not found:
  $systemUnitPath

Run scripts\build-runtime.ps1 before publishing the language server.
"@
}

if (Test-Path -LiteralPath $nextServerRoot) {
    Remove-Item -LiteralPath $nextServerRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $nextServerRoot -Force | Out-Null

Write-Host '=== Publishing self-contained win-x64 language server ==='
& dotnet publish $projectPath `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $nextServerRoot `
    --nologo
Assert-LastExitCode 'Language server publish'

Write-Host '=== Copying PascalABC.NET standard library for language services ==='
Copy-Item -LiteralPath $runtimeLibRoot `
    -Destination (Join-Path $nextServerRoot 'Lib') `
    -Recurse `
    -Force

$requiredFiles = @(
    'PascalABCNet.LanguageServer.exe',
    'PascalABCNet.LanguageServer.dll',
    'PascalABCNet.LanguageServer.deps.json',
    'PascalABCNet.LanguageServer.runtimeconfig.json',
    'Lib\PABCSystem.pcu'
)
foreach ($fileName in $requiredFiles) {
    $filePath = Join-Path $nextServerRoot $fileName
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        throw "Published language server component was not found: $filePath"
    }
}

if (Test-Path -LiteralPath $outputRoot) {
    Remove-Item -LiteralPath $outputRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $serverParent -Force | Out-Null
Move-Item -LiteralPath $nextServerRoot -Destination $outputRoot

$serverExecutable = Join-Path $outputRoot 'PascalABCNet.LanguageServer.exe'
Write-Host "Language server published successfully: $serverExecutable"
