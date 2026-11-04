[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimePath,
    [string]$VsixPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($RuntimePath).TrimEnd('\', '/')
$manifestPath = Join-Path $root 'net10-runtime.manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expected = @{}
foreach ($file in $manifest.files) {
    $relative = $file.path.Replace('\', '/')
    if ($relative -match '(^|/)\.\.?(/|$)|:|//|^/|/$' -or
        $expected.ContainsKey($relative) -or $relative -eq 'net10-runtime.manifest.json') {
        throw "Invalid packaged runtime manifest path: $relative"
    }
    $expected[$relative] = $file.sha256
}
$expected['net10-runtime.manifest.json'] = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
if (-not $VsixPath) {
    $actual = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)
    if ($actual.Count -ne $expected.Count) { throw 'Runtime contains extra or missing files.' }
    foreach ($file in $actual) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        if (-not $expected.ContainsKey($relative) -or
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $expected[$relative]) {
            throw "Unexpected or changed runtime file: $relative"
        }
    }
}
else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($VsixPath))
    try {
        $seen = @{}
        foreach ($entry in $archive.Entries) {
            if (-not $entry.FullName.StartsWith('extension/bin/net10/') -or $entry.FullName.EndsWith('/')) { continue }
            $relative = $entry.FullName.Substring('extension/bin/net10/'.Length)
            if (-not $expected.ContainsKey($relative) -or $seen.ContainsKey($relative)) {
                throw "Unexpected or duplicate VSIX runtime file: $relative"
            }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
            finally { $stream.Dispose(); $sha.Dispose() }
            if ($hash -ne $expected[$relative]) { throw "VSIX runtime hash mismatch: $relative" }
            $seen[$relative] = $true
        }
        if ($seen.Count -ne $expected.Count) { throw 'VSIX is missing runtime files.' }
    }
    finally { $archive.Dispose() }
}
Write-Host "Verified unified .NET 10 runtime: $($expected.Count) files, exact file set and SHA-256 hashes."
