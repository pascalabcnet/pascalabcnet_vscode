# Собирает bundle fullline/ для VSIX из сборки репозитория плагина
# (pascalabcnet_full_line_completion): dll LSP-плагина копируется в каталог
# установки при включении ИИ-дополнения (см. src/fullline.ts), setup-тул
# запускается прямо из бандла. Запускать перед scripts/build-vsix.ps1.
[CmdletBinding()]
param(
    [string]$PluginRepoRoot,
    [string]$Configuration = 'Release'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PluginRepoRoot)) {
    # $PSScriptRoot is not available inside param() default values.
    $PluginRepoRoot = Join-Path $PSScriptRoot '..\..\pascalabcnet_full_line_completion'
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bundleDir = Join-Path $repositoryRoot 'fullline'

$pluginProject = Join-Path $PluginRepoRoot 'src\FullLineCompletionLspPlugin\FullLineCompletionLspPlugin.csproj'
$setupProject = Join-Path $PluginRepoRoot 'src\FullLineCompletionSetup\FullLineCompletionSetup.csproj'
foreach ($project in @($pluginProject, $setupProject)) {
    if (-not (Test-Path -LiteralPath $project -PathType Leaf)) {
        throw "Plugin repo project was not found: $project (pass -PluginRepoRoot)"
    }
}

Write-Host '=== Building full line completion plugin and setup ==='
& dotnet build $pluginProject -c $Configuration --nologo -v minimal
if ($LASTEXITCODE -ne 0) {
    throw "Plugin build failed with exit code $LASTEXITCODE."
}
& dotnet build $setupProject -c $Configuration --nologo -v minimal
if ($LASTEXITCODE -ne 0) {
    throw "Setup build failed with exit code $LASTEXITCODE."
}

$pluginBin = Join-Path $PluginRepoRoot "src\FullLineCompletionLspPlugin\bin\$Configuration\net10.0"
$setupBin = Join-Path $PluginRepoRoot "src\FullLineCompletionSetup\bin\$Configuration\net10.0"

if (Test-Path -LiteralPath $bundleDir) {
    Remove-Item -LiteralPath $bundleDir -Recurse -Force
}
New-Item -ItemType Directory -Path $bundleDir | Out-Null

# Only the plugin assembly is deployed: contract assemblies bind to the
# language server's own copies at runtime (host-first resolution).
Copy-Item -LiteralPath (Join-Path $pluginBin 'FullLineCompletionLspPlugin.dll') -Destination $bundleDir
Copy-Item -LiteralPath (Join-Path $pluginBin 'FullLineCompletionLspPlugin.pdb') -Destination $bundleDir -ErrorAction SilentlyContinue

# The setup tool is a framework-dependent console app: the dll needs its
# runtimeconfig (and deps) to run via `dotnet FullLineCompletionSetup.dll`.
foreach ($file in @(
        'FullLineCompletionSetup.dll',
        'FullLineCompletionSetup.runtimeconfig.json',
        'FullLineCompletionSetup.deps.json',
        'FullLineCompletionSetup.pdb')) {
    $source = Join-Path $setupBin $file
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $bundleDir
    } elseif ($file -notlike '*.pdb') {
        throw "Expected setup output was not found: $source"
    }
}

Write-Host "Full line completion bundle staged in $bundleDir"
Get-ChildItem -LiteralPath $bundleDir | ForEach-Object { Write-Host "  $($_.Name)" }
