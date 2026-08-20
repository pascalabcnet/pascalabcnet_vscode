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
$modernRuntimeRoot = Join-Path $repositoryRoot 'bin\net10'
$runtimeLibRoot = Join-Path $modernRuntimeRoot 'Lib'
$legacyOutputRoot = Join-Path $repositoryRoot 'server\win-x64'

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

Write-Host '=== Publishing portable framework-dependent language server ==='
& dotnet publish $projectPath `
    --configuration Release `
    --self-contained false `
    --disable-build-servers `
    -m:1 `
    -p:UseAppHost=false `
    -p:BuildInParallel=false `
    -p:SatelliteResourceLanguages=ru `
    --output $nextServerRoot `
    --nologo
Assert-LastExitCode 'Language server publish'

Write-Host '=== Reusing PascalABC.NET standard library from bin\net10 ==='
$publishedLibRoot = Join-Path $nextServerRoot 'Lib'
if (Test-Path -LiteralPath $publishedLibRoot) {
    Remove-Item -LiteralPath $publishedLibRoot -Recurse -Force
}
Get-ChildItem -LiteralPath $nextServerRoot -File -Recurse `
    -Filter '*.pdb' | Remove-Item -Force

$requiredFiles = @(
    'PascalABCNet.LanguageServer.dll',
    'PascalABCNet.LanguageServer.deps.json',
    'PascalABCNet.LanguageServer.runtimeconfig.json'
)
foreach ($fileName in $requiredFiles) {
    $filePath = Join-Path $nextServerRoot $fileName
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        throw "Published language server component was not found: $filePath"
    }
}

Write-Host '=== Merging language server into the shared .NET 10 runtime ==='
Get-ChildItem -LiteralPath $modernRuntimeRoot -File -Recurse `
    -Filter '*.pdb' | Remove-Item -Force
Get-ChildItem -LiteralPath $modernRuntimeRoot -File `
    -Filter 'PascalABCNet.LanguageServer.*' | Remove-Item -Force

foreach ($sourceFile in Get-ChildItem -LiteralPath $nextServerRoot -File -Recurse) {
    $relativePath = $sourceFile.FullName.Substring($nextServerRoot.Length + 1)
    $destinationPath = Join-Path $modernRuntimeRoot $relativePath

    if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName `
            -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destinationPath `
            -Algorithm SHA256).Hash

        if ($sourceHash -ne $destinationHash) {
            throw @"
The language server and compiler runtime contain different versions of:
  $relativePath

Run scripts\build-runtime.ps1 and then scripts\build-server.ps1 using the
same PascalABC.NET tooling revision.
"@
        }

        continue
    }

    $destinationDirectory = Split-Path -Parent $destinationPath
    New-Item -ItemType Directory -Path $destinationDirectory `
        -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile.FullName `
        -Destination $destinationPath
}

foreach ($fileName in $requiredFiles) {
    $filePath = Join-Path $modernRuntimeRoot $fileName
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        throw "Installed language server component was not found: $filePath"
    }
}

if (Test-Path -LiteralPath $legacyOutputRoot) {
    Remove-Item -LiteralPath $legacyOutputRoot -Recurse -Force
}

$serverAssembly = Join-Path $modernRuntimeRoot `
    'PascalABCNet.LanguageServer.dll'
Write-Host "Language server published successfully: dotnet $serverAssembly"
