[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $repositoryRoot 'bin\net10'
# The server is part of the imported kit. Never publish another copy over it.
& (Join-Path $PSScriptRoot 'verify-net10-runtime.ps1') -RuntimePath $runtime
foreach ($suffix in @('.dll', '.deps.json', '.runtimeconfig.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime ('PascalABCNet.LanguageServer' + $suffix)) -PathType Leaf)) {
        throw 'Import a complete unified kit with scripts\build-runtime.ps1 -Net10RuntimePath <directory> first.'
    }
}
Write-Host 'Language server is supplied by the unified PascalABC.NET kit; no separate Tooling build is needed.'
