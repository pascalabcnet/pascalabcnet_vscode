# Собирает bundle fullline/ для VSIX из репозитория плагина
# (pascalabcnet/pascalabcnet_full_line_completion): dll LSP-плагина копируется в
# каталог установки при включении ИИ-дополнения (см. src/fullline.ts), setup-тул
# запускается прямо из бандла. Запускать перед scripts/build-vsix.ps1.
#
# Репозиторий плагина ищется в таком порядке:
#   1) явный -PluginRepoRoot;
#   2) соседний каталог ..\..\pascalabcnet_full_line_completion (для разработки);
#   3) автоматический клон в .build\fullline-plugin на уровне -PluginRepoRef
#      (см. scripts/fullline-plugin.ref) — сборка VSIX не требует ручной
#      подготовки и работает у любого, у кого есть доступ к организации.
[CmdletBinding()]
param(
    [string]$PluginRepoRoot,
    [string]$PluginRepoRef,
    [string]$PluginRepoUrl = 'https://github.com/pascalabcnet/pascalabcnet_full_line_completion',
    [string]$Configuration = 'Release'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$bundleDir = Join-Path $repositoryRoot 'fullline'

$managedClone = $false
if ([string]::IsNullOrWhiteSpace($PluginRepoRoot)) {
    # $PSScriptRoot is not available inside param() default values.
    $siblingRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot '..\..\pascalabcnet_full_line_completion'))
    if (Test-Path -LiteralPath $siblingRoot -PathType Container) {
        $PluginRepoRoot = $siblingRoot
    } else {
        $PluginRepoRoot = Join-Path $repositoryRoot '.build\fullline-plugin'
    }
}
$PluginRepoRoot = [System.IO.Path]::GetFullPath($PluginRepoRoot)

# Managed clone: the script owns clone/checkout/submodule updates for the
# .build\fullline-plugin location (any other path is user-managed).
$managedClone = $PluginRepoRoot -eq
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot '.build\fullline-plugin'))

if ([string]::IsNullOrWhiteSpace($PluginRepoRef)) {
    $refFile = Join-Path $PSScriptRoot 'fullline-plugin.ref'
    $PluginRepoRef = if (Test-Path -LiteralPath $refFile -PathType Leaf) {
        (Get-Content -LiteralPath $refFile | Select-Object -First 1).Trim()
    } else {
        'master'
    }
    if ([string]::IsNullOrWhiteSpace($PluginRepoRef)) {
        $PluginRepoRef = 'master'
    }
}

if ($managedClone) {
    if (-not (Test-Path -LiteralPath (Join-Path $PluginRepoRoot '.git'))) {
        Write-Host "=== Cloning full line completion plugin repository ($PluginRepoRef) ==="
        & git clone $PluginRepoUrl $PluginRepoRoot
        if ($LASTEXITCODE -ne 0) {
            throw "git clone of $PluginRepoUrl failed with exit code $LASTEXITCODE."
        }
    }
    Push-Location $PluginRepoRoot
    try {
        & git fetch origin
        if ($LASTEXITCODE -ne 0) {
            throw "git fetch failed with exit code $LASTEXITCODE."
        }
        & git checkout $PluginRepoRef
        if ($LASTEXITCODE -ne 0) {
            throw "git checkout $PluginRepoRef failed with exit code $LASTEXITCODE."
        }
        # Сборка ссылается на контракты из сабмодуля pascalabcnet.
        & git submodule update --init
        if ($LASTEXITCODE -ne 0) {
            throw "git submodule update failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

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
