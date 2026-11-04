[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimePath,
    [Parameter(Mandatory)][string]$Destination,
    [string]$ManifestSha256 = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($RuntimePath).TrimEnd('\', '/')
$target = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
if ($target -eq $source -or $target.StartsWith($source + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)) { throw 'Import destination must be outside the source kit.' }
if (Test-Path -LiteralPath $target) {
    if (@(Get-ChildItem -LiteralPath $target -Force).Count) { throw "Import destination must be empty: $target" }
}
$manifestPath = Join-Path $source 'net10-runtime.manifest.json'
$sourceHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
if ($ManifestSha256 -and $sourceHash -ne $ManifestSha256) { throw 'The source runtime manifest does not match the pinned SHA-256.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$files = New-Object 'System.Collections.Generic.List[object]'
$listed = @{}
function Add-KitFile([string]$RelativePath, [string]$ExpectedHash) {
    $relative = $RelativePath.Replace('\', '/')
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|/)\.\.?(/|$)|:|//|^/|/$' -or
        $relative -eq 'net10-runtime.manifest.json' -or $listed.ContainsKey($relative)) {
        throw "Invalid or duplicate runtime path: $RelativePath"
    }
    if ([IO.Path]::GetExtension($relative) -in @('.pdb', '.tmp', '.log', '.bak')) {
        throw "Development artifact declared in runtime manifest: $relative"
    }
    $inputPath = [IO.Path]::GetFullPath((Join-Path $source $relative))
    if (-not $inputPath.StartsWith($source + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes source kit: $relative" }
    # Do not import files through symlinks or junctions, including parent directories.
    for ($entry = Get-Item -LiteralPath $inputPath -Force; $entry.FullName -ne $source; $entry = $entry.Parent) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked runtime path: $relative" }
        if ($entry -is [IO.FileInfo]) { $entry = $entry.Directory; if ($entry.FullName -eq $source) { break } }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked runtime directory: $relative" }
    }
    $actual = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash
    if ($ExpectedHash -and $actual -ne $ExpectedHash) { throw "Runtime hash mismatch: $relative" }
    $listed[$relative] = $true
    $files.Add([ordered]@{ path = $relative; sha256 = $actual })
}
foreach ($file in $manifest.files) {
    if ($file.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw "Invalid source hash: $($file.path)" }
    Add-KitFile $file.path $file.sha256
}
foreach ($name in @('pabcnetc', 'pabcnetcclear', 'PABCCompilerController', 'PABCCompilerWorker', 'PascalABCNet.LanguageServer')) {
    foreach ($suffix in @('.dll', '.deps.json', '.runtimeconfig.json')) {
        if (-not $listed.ContainsKey($name + $suffix)) { throw "Runtime entry missing from manifest: $name$suffix" }
    }
}
foreach ($name in @('Compiler.dll', 'CodeCompletion.dll', 'PascalABCNet.LanguageServices.dll')) {
    if (-not $listed.ContainsKey($name)) { throw "Shared runtime library missing: $name" }
}
if (-not (@($listed.Keys | Where-Object { $_ -like 'Lng/*' }).Count)) { throw 'Runtime language resources are missing.' }
if (-not ($listed.ContainsKey('Lib/PABCSystem.pas') -or $listed.ContainsKey('LibSource/PABCSystem.pas'))) {
    throw 'Runtime standard library sources are missing.'
}
# Upstream exports prepared PCUs separately. Only caches corresponding to
# manifest-listed standard sources are accepted; unrelated files are ignored.
foreach ($file in @($manifest.files)) {
    $relative = $file.path.Replace('\', '/')
    if ($relative -match '^(Lib|LibSource)/(.+)\.pas$') {
        $pcu = 'Lib/' + $Matches[2] + '.pcu'
        if (-not $listed.ContainsKey($pcu) -and (Test-Path -LiteralPath (Join-Path $source $pcu) -PathType Leaf)) {
            if ((Get-Item -LiteralPath (Join-Path $source $pcu)).Length -eq 0) { throw "Empty standard PCU: $pcu" }
            Add-KitFile $pcu ''
        }
    }
}
foreach ($name in @('PABCSystem', 'PABCExtensions', '__RunMode', '__RedirectIOMode')) {
    if (-not $listed.ContainsKey("Lib/$name.pcu")) { throw "Prepared standard PCU missing: $name" }
}
foreach ($file in $files) {
    $inputPath = Join-Path $source $file.path
    $outputPath = Join-Path $target $file.path
    New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null
    Copy-Item -LiteralPath $inputPath -Destination $outputPath
    if ((Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash -ne $file.sha256) {
        throw "Runtime changed while copying: $($file.path)"
    }
}
[ordered]@{
    configuration = $manifest.configuration
    sourceManifestSha256 = $sourceHash
    files = @($files.ToArray())
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $target 'net10-runtime.manifest.json') -Encoding UTF8
Write-Host "Imported unified .NET 10 kit: $($files.Count) files; source manifest SHA-256 $sourceHash"
