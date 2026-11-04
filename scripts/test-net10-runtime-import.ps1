[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $repository ('.build\kit-import-tests\' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $testRoot 'source'
New-Item -ItemType Directory -Path $source -Force | Out-Null
$paths = @('Compiler.dll', 'CodeCompletion.dll', 'PascalABCNet.LanguageServices.dll', 'Lng/Eng/test.dat')
foreach ($entry in @('pabcnetc', 'pabcnetcclear', 'PABCCompilerController', 'PABCCompilerWorker', 'PascalABCNet.LanguageServer')) {
    foreach ($suffix in @('.dll', '.deps.json', '.runtimeconfig.json')) { $paths += $entry + $suffix }
}
$units = @('PABCSystem', 'PABCExtensions', '__RunMode', '__RedirectIOMode')
foreach ($unit in $units) { $paths += "Lib/$unit.pas" }
$files = foreach ($relative in $paths) {
    $file = Join-Path $source $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    [IO.File]::WriteAllText($file, "test fixture: $relative")
    [ordered]@{ path = $relative; sha256 = (Get-FileHash $file -Algorithm SHA256).Hash }
}
foreach ($unit in $units) { [IO.File]::WriteAllText((Join-Path $source "Lib/$unit.pcu"), "prepared PCU fixture: $unit") }
[IO.File]::WriteAllText((Join-Path $source 'unlisted.dll'), 'must never be imported')
$manifestPath = Join-Path $source 'net10-runtime.manifest.json'
[ordered]@{ configuration = 'Release'; files = @($files) } | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $manifestPath -Encoding UTF8
$hash = (Get-FileHash $manifestPath -Algorithm SHA256).Hash
function Must-Fail([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        return
    }
    throw "Expected rejection: $Pattern"
}
$destination = Join-Path $testRoot 'valid'
& (Join-Path $PSScriptRoot 'import-net10-runtime.ps1') -RuntimePath $source -Destination $destination -ManifestSha256 $hash
& (Join-Path $PSScriptRoot 'verify-net10-runtime.ps1') -RuntimePath $destination
if (Test-Path (Join-Path $destination 'unlisted.dll')) { throw 'Unlisted DLL was imported.' }
$prepared = Get-Content (Join-Path $destination 'net10-runtime.manifest.json') -Raw | ConvertFrom-Json
if (@($prepared.files | Where-Object path -like '*.pcu').Count -ne 4) { throw 'Prepared PCUs were not recorded.' }
Must-Fail { & (Join-Path $PSScriptRoot 'import-net10-runtime.ps1') -RuntimePath $source -Destination (Join-Path $testRoot 'wrong-pin') -ManifestSha256 ('0' * 64) } 'pinned SHA-256'
[IO.File]::WriteAllText((Join-Path $destination 'extra.dll'), 'unexpected file')
Must-Fail { & (Join-Path $PSScriptRoot 'verify-net10-runtime.ps1') -RuntimePath $destination } 'extra or missing'
[IO.File]::WriteAllText((Join-Path $source 'Compiler.dll'), 'changed after preparation')
Must-Fail { & (Join-Path $PSScriptRoot 'import-net10-runtime.ps1') -RuntimePath $source -Destination (Join-Path $testRoot 'tampered') } 'hash mismatch'
[IO.File]::WriteAllText((Join-Path $source 'Compiler.dll'), 'test fixture: Compiler.dll')
$files[0].path = '../escape.dll'
[ordered]@{ configuration = 'Release'; files = @($files) } | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $manifestPath -Encoding UTF8
Must-Fail { & (Join-Path $PSScriptRoot 'import-net10-runtime.ps1') -RuntimePath $source -Destination (Join-Path $testRoot 'escape') } 'Invalid or duplicate'
Write-Host 'PASS: manifest-only import, PCU hashing, pinning, extra-file rejection, tampering and traversal rejection.'
